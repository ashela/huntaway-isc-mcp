// leak-gate: fixtures
import { describe, expect, it } from "vitest";
import { buildDataFlow, dataFlowBlock, gather, resolveTransform, summarise, type Reader } from "../src/server/dataflow.js";

/** A small tenant: an authoritative HR source feeding one profile, an AD target
 *  with a CREATE policy, sync and correlation, and a transform chain. */
function fakeTenant(): Reader & { calls: string[] } {
  const calls: string[] = [];
  const routes: Record<string, unknown> = {
    "/v2025/sources?limit=250&offset=0": [
      { id: "hr1", name: "HR", type: "DelimitedFile", authoritative: true, features: [] },
      { id: "ad1", name: "Active Directory", type: "Active Directory - Direct", authoritative: false, features: ["PROVISIONING", "SYNC_PROVISIONING"] },
    ],
    "/v3/identity-profiles": [
      {
        id: "p1", name: "Employees", priority: 10, authoritativeSource: { id: "hr1", name: "HR" },
        identityAttributeConfig: {
          attributeTransforms: [
            { identityAttributeName: "firstname", transformDefinition: { type: "accountAttribute", attributes: { sourceName: "HR", attributeName: "FIRST_NAME" } } },
            { identityAttributeName: "email", transformDefinition: { type: "reference", attributes: { id: "Email Builder" } } },
            { identityAttributeName: "department", transformDefinition: { type: "reference", attributes: { id: "Does Not Exist" } } },
          ],
        },
      },
    ],
    "/v3/transforms": [
      {
        id: "t1", name: "Email Builder", type: "firstValid",
        attributes: { values: [{ type: "accountAttribute", attributes: { sourceName: "HR", attributeName: "EMAIL" } }, { type: "static", attributes: { value: "none@example.test" } }] },
      },
    ],
    "/v2025/identity-attributes": [{ name: "firstname" }, { name: "email" }, { name: "department" }, { name: "uid" }],
    "/v3/sources/hr1/schemas": [{ name: "account", attributes: [{ name: "FIRST_NAME" }, { name: "EMAIL" }] }],
    "/v3/sources/hr1/provisioning-policies": [],
    "/beta/sources/hr1/attribute-sync-config": { attributes: [] },
    "/beta/sources/hr1/correlation-config": { attributeAssignments: [] },
    "/v3/sources/ad1/schemas": [{ name: "account", attributes: [{ name: "sAMAccountName" }, { name: "mail" }] }],
    "/v3/sources/ad1/provisioning-policies": [
      {
        usageType: "CREATE",
        fields: [
          { name: "sAMAccountName", isRequired: true, type: "string", transform: { type: "identityAttribute", attributes: { name: "uid" } } },
          { name: "mail", transform: { type: "identityAttribute", attributes: { name: "mailbox" } } },
        ],
      },
    ],
    "/beta/sources/ad1/attribute-sync-config": { attributes: [{ name: "email", target: "mail", enabled: true }, { name: "firstname", target: "givenName", enabled: false }] },
    "/beta/sources/ad1/correlation-config": { attributeAssignments: [{ property: "uid", value: "sAMAccountName", operation: "EQ", order: 1 }] },
  };
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path in routes) return { status: 200, body: routes[path] as never };
      return { status: 404, body: {} };
    },
  };
}

describe("isc_dataflow", () => {
  it("dereferences transform chains to the account attributes they read", () => {
    const byName = new Map([["Email Builder", { type: "firstValid", attributes: { values: [{ type: "accountAttribute", attributes: { sourceName: "HR", attributeName: "EMAIL" } }, { type: "static", attributes: { value: "x" } }] } }]]);
    const r = resolveTransform({ type: "reference", attributes: { id: "Email Builder" } }, byName);
    expect(r.reads).toEqual([{ sourceName: "HR", attributeName: "EMAIL" }]);
    expect(r.constants).toEqual(["x"]);
    expect(r.chain).toBe("Email Builder [firstValid > accountAttribute | static]");
    expect(resolveTransform({ type: "reference", attributes: { id: "nope" } }, byName).missing).toEqual(["nope"]);
    // A self-reference ends at the depth cap instead of recursing forever.
    const loop = new Map([["Loop", { type: "reference", attributes: { id: "Loop" } }]]);
    expect(resolveTransform({ type: "reference", attributes: { id: "Loop" } }, loop).chain).toMatch(/^Loop \[/);
  });

  it("builds lanes, systems, flows, lineage rows and issues from a tenant", async () => {
    const tenant = fakeTenant();
    const g = await gather(tenant);
    const model = buildDataFlow(g, "Test");
    expect(model.lanes.map((l) => l.id)).toEqual(["auth", "isc", "target"]);
    const sys = Object.fromEntries(model.systems.map((s) => [s.id, s]));
    expect(sys["src:hr1"].lane).toBe("auth");
    expect(sys["src:ad1"].lane).toBe("target");
    expect(sys["src:ad1"].description).toContain("provisioning");
    expect(sys["profile:p1"].description).toContain("3 attribute mappings");

    const mechanisms = model.flows.map((f) => `${f.from}>${f.to}:${f.mechanism}`);
    expect(mechanisms).toContain("src:hr1>profile:p1:Account aggregation");
    expect(mechanisms).toContain("identity>src:ad1:Provisioning: CREATE policy");
    expect(mechanisms).toContain("identity>src:ad1:Attribute sync");
    expect(mechanisms).toContain("src:ad1>identity:Account aggregation and correlation");
    expect(model.flows.map((f) => f.id)).toEqual(model.flows.map((_, i) => `F${i + 1}`));

    const byGroup = (g: string) => model.mappings.filter((m) => m.group === g);
    const prof = byGroup("Identity attributes: Employees");
    expect(prof.map((m) => [m.sourceSystem, m.sourceField, m.targetField])).toEqual([
      ["HR", "FIRST_NAME", "firstname"],
      ["HR", "EMAIL", "email"],
      ["", "", "department"],
    ]);
    expect(prof[1].transform).toBe("Email Builder [firstValid > accountAttribute | static]");
    expect(prof[2].issues).toHaveLength(1);

    const create = byGroup("Provisioning: Active Directory");
    expect(create.map((m) => [m.sourceField, m.targetField, m.operation])).toEqual([["uid", "sAMAccountName", "C (required)"], ["mailbox", "mail", "C"]]);
    expect(create[1].issues).toHaveLength(1);

    const sync = byGroup("Attribute sync: Active Directory");
    expect(sync.map((m) => m.state)).toEqual(["in-use", "not-in-use"]);
    expect(byGroup("Correlation: Active Directory")[0]).toMatchObject({ sourceField: "sAMAccountName", targetField: "uid", operation: "K1" });

    const texts = model.issues.map((i) => `${i.severity}: ${i.issue}`);
    expect(texts).toContainEqual(expect.stringMatching(/^high: Mapping of department .* "Does Not Exist"/));
    expect(texts).toContainEqual(expect.stringMatching(/^medium: CREATE policy field mail .* mailbox/));
    expect(model.issues.every((i, n) => i.id === `I${n + 1}`)).toBe(true);

    const block = dataFlowBlock(model);
    expect(block.kind).toBe("huntaway.dataflow");
    expect(summarise(model).mappings).toBe(model.mappings.length);
  });

  it("reports what it could not read instead of failing", async () => {
    const tenant = fakeTenant();
    const base = tenant.get.bind(tenant);
    tenant.get = async (path) => (path.includes("attribute-sync-config") ? { status: 403, body: {} } : base(path));
    const model = buildDataFlow(await gather(tenant), "T");
    expect(model.issues.some((i) => /Could not read .*attribute-sync-config.*403/.test(i.issue))).toBe(true);
    expect(model.mappings.some((m) => m.group.startsWith("Attribute sync"))).toBe(false);
  });
});
