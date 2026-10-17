// leak-gate: fixtures
import { describe, expect, it } from "vitest";
import { parseStepCap, parseTenantsEnv } from "../src/shared/config.js";
import { clip, leakedAttributes, matchByName, q, rows } from "../src/server/util.js";
import { analyseWorkflow } from "../src/server/diagnostics.js";
import { diffObjects, flatten, makeNormaliser, recipients } from "../src/server/compare.js";

describe("tenant configuration", () => {
  it("parses the environment, normalising hosts and dropping bad entries", () => {
    const tenants = parseTenantsEnv(JSON.stringify([
      { key: "Dev", label: "Build", baseUrl: "acme-dev.api.example.test/", clientId: "id", clientSecret: "s", isDefault: true, maskTokens: ["DEV", ""] },
      { key: "bad key", baseUrl: "https://x.example.test" },
      { key: "dev", baseUrl: "https://dup.example.test" },
      { key: "prod", label: "", baseUrl: "https://acme.api.example.test" },
    ]));
    expect(tenants.map((t) => t.key)).toEqual(["dev", "prod"]);
    expect(tenants[0]).toMatchObject({ baseUrl: "https://acme-dev.api.example.test", isDefault: true, maskTokens: ["DEV"] });
    expect(tenants[1]).toMatchObject({ label: "prod", clientId: "", clientSecret: "" });
    expect(parseTenantsEnv(undefined)).toEqual([]);
    expect(parseTenantsEnv("not json")).toEqual([]);
  });

  it("reads the step cap with a sane default", () => {
    expect(parseStepCap("100")).toBe(100);
    expect(parseStepCap("0")).toBe(50);
    expect(parseStepCap(undefined)).toBe(50);
  });
});

describe("helpers", () => {
  it("clips long responses and says so", () => {
    const big = { rows: "x".repeat(500) };
    const out = clip(big, 100) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out._shown_chars).toBe(100);
    expect(clip({ a: 1 }, 100)).toEqual({ a: 1 });
  });

  it("builds query strings and reads listing envelopes", () => {
    expect(q("/v2025/search", { limit: 5, filters: undefined })).toBe("/v2025/search?limit=5");
    expect(q("/x?a=1", { b: "two" })).toBe("/x?a=1&b=two");
    expect(rows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(rows({ results: [{ id: 2 }], count: 1 })).toEqual([{ id: 2 }]);
    expect(rows({ items: [] })).toEqual([]);
    expect(rows({ nothing: true })).toBeNull();
  });

  it("flags unresolved templates and JSONPaths", () => {
    expect(leakedAttributes({ a: "{{ identity.name }}", b: "$.x", c: "fine", d: 3 })).toEqual({ a: "{{ identity.name }}", b: "$.x" });
  });

  it("matches by exact name, then substring, and reports ambiguity", () => {
    const items = [{ name: "Joiner" }, { name: "Joiner Notice" }, { name: "Leaver" }];
    expect(matchByName(items, "joiner", "workflow").match?.name).toBe("Joiner");
    expect(matchByName(items, "notice", "workflow").match?.name).toBe("Joiner Notice");
    expect(matchByName(items, "er", "workflow").candidates).toHaveLength(3);
    expect(matchByName(items, "zzz", "workflow").error).toMatch(/no workflow matched/);
  });
});

describe("workflow diagnostics", () => {
  const workflow = {
    id: "w",
    name: "Onboard",
    enabled: true,
    trigger: { type: "EVENT" },
    definition: {
      start: "a",
      steps: {
        a: { actionId: "sp:http", attributes: { param_oauth: { refID: "bound" } }, nextStep: "b" },
        b: { actionId: "sp:choice", choiceList: [{ nextStep: "c" }], defaultStep: "d" },
        c: { actionId: "sp:http", attributes: {} },
        d: { actionId: "sp:interactive-form", attributes: { formDefinitionId: "f1" } },
        orphan: { actionId: "sp:http", attributes: { param_oauth: { refID: "x" } } },
      },
    },
  };

  it("counts steps, finds unbound http steps and unreachable ones", () => {
    const d = analyseWorkflow(workflow, 50);
    expect(d.step_count).toBe(5);
    expect(d.over_cap).toBe(false);
    expect(d.http_steps).toEqual([{ step: "a", bound: true }, { step: "c", bound: false }, { step: "orphan", bound: true }]);
    expect(d.unbound_http_steps).toEqual(["c"]);
    expect(d.unreachable_steps).toEqual(["orphan"]);
    expect(d.trigger).toBe("EVENT");
    expect(d.WARNING).toMatch(/Unbound http step/);
    expect(d.WARNING).not.toMatch(/ONE-WAY/);
  });

  it("warns about the one-way door when an enabled workflow is over the cap", () => {
    const d = analyseWorkflow(workflow, 3);
    expect(d.over_cap).toBe(true);
    expect(d.safe_to_disable).toBe(false);
    expect(d.WARNING).toMatch(/ONE-WAY DOOR/);
  });
});

describe("tenant comparison", () => {
  const norm = makeNormaliser(["DEV", "dev-tenant", "UAT"]);

  it("masks ids, emails and environment tokens, longest token first", () => {
    expect(norm.text("send to a.person@example.test from DEV_Mailer on dev-tenant at 123e4567-e89b-12d3-a456-426614174000")).toBe(
      "send to <EMAIL> from <ENV>_Mailer on <ENV> at <ID>",
    );
    expect(norm.text("%2212345678901234567890123456789012%22")).toBe('"<ID>"');
    expect(norm.text("DEVELOP stays, DEV goes, devops stays")).toBe("DEVELOP stays, <ENV> goes, devops stays");
  });

  it("pairs by name with the environment prefix stripped", () => {
    expect(norm.key("DEV ServiceNow Sync")).toBe("ServiceNow Sync");
    expect(norm.key("UAT ServiceNow Sync")).toBe("ServiceNow Sync");
    expect(norm.key("Plain")).toBe("Plain");
  });

  it("drops noise keys at every level and keys variables by name", () => {
    const value = norm.value({ id: "1", nested: { modified: "t", keep: "DEV_x" }, variables: [{ name: "b", value: 2 }, { name: "a", value: 1 }] }) as Record<string, unknown>;
    expect(value).toEqual({ nested: { keep: "<ENV>_x" }, variables: { b: { name: "b", value: 2 }, a: { name: "a", value: 1 } } });
  });

  it("diffs only what survives masking", () => {
    const a = { enabled: true, owner: { id: "x" }, steps: { s1: { url: "https://dev-tenant.example.test/a" } } };
    const b = { enabled: false, owner: { id: "y" }, steps: { s1: { url: "https://uat-tenant.example.test/a" } } };
    const n = makeNormaliser(["dev-tenant", "uat-tenant"]);
    expect(diffObjects(a, b, n)).toEqual([{ path: "/enabled", a: true, b: false }]);
    expect(flatten({ empty: {}, list: [] })).toEqual([["/empty", {}], ["/list", []]]);
  });

  it("collects recipient leaves apart from the logic diff", () => {
    expect(recipients({ attributes: { recipientEmailList: "ops@example.test", "recipientEmailList.$": "$.x", subject: "hi" } })).toEqual({
      "/attributes/recipientEmailList": "ops@example.test",
      "/attributes/recipientEmailList.$": "$.x",
    });
  });
});
