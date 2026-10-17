// isc_dataflow: the tenant's source-to-target map, derived from what the
// tenant actually holds and emitted in the Huntaway "DFD and Source to
// Target mapping" model (kind huntaway.dataflow), so the document can be
// opened and edited in Huntaway rather than drawn by hand.
//
// The physical view: every source in a lane (authoritative or target), the
// identity profiles and the identity attribute set in the ISC lane, and a
// numbered flow for each aggregation, attribute mapping, provisioning policy,
// attribute sync and correlation that exists. The lineage: one row per
// attribute mapping, with the transform chain described and dereferenced to
// the account attributes it reads; one row per CREATE policy field, per
// synced attribute and per correlation assignment. Issues are the things the
// tenant cannot satisfy: a transform a mapping references that does not
// exist, an identity attribute a policy or sync names that no profile
// produces, a profile that maps nothing.

import { asList, asRecord, type Json } from "./util.js";

export const DATA_FLOW_KIND = "huntaway.dataflow";

export type DataFlowState = "in-use" | "not-in-use" | "reference";
export type Severity = "extremely-high" | "high" | "medium" | "low";

export interface DataFlowLane { id: string; label: string }
export interface DataFlowSystem { id: string; label: string; lane: string; state: DataFlowState; description: string }
export interface DataFlowFlow { id: string; from: string; to: string; mechanism: string; when: string; state: DataFlowState }
export interface DataFlowMapping {
  group: string;
  sourceSystem: string;
  sourceField: string;
  viaSystem: string;
  via: string;
  transform: string;
  targetSystem: string;
  targetField: string;
  operation: string;
  issues: string[];
  notes: string;
  state: DataFlowState;
}
export interface DataFlowIssue { id: string; severity: Severity; status: string; origin: string; issue: string; systems: string[] }
export interface DataFlowModel {
  title: string;
  lanes: DataFlowLane[];
  systems: DataFlowSystem[];
  flows: DataFlowFlow[];
  mappings: DataFlowMapping[];
  issues: DataFlowIssue[];
}
export interface DataFlowBlock { kind: typeof DATA_FLOW_KIND; version: 1; view: "dfd"; model: DataFlowModel }

/** What the builder reads. isc.call behind a narrower face so a test can fake a tenant. */
export interface Reader {
  get(path: string): Promise<{ status: number; body: Json }>;
}

export interface Gathered {
  sources: Record<string, unknown>[];
  schemas: Map<string, Record<string, unknown>[]>;
  profiles: Record<string, unknown>[];
  transforms: Record<string, unknown>[];
  identityAttributes: Record<string, unknown>[];
  policies: Map<string, Record<string, unknown>[]>;
  sync: Map<string, Record<string, unknown>[]>;
  correlation: Map<string, Record<string, unknown>[]>;
  /** Reads that failed, by path, so the model says what it could not see. */
  unread: Record<string, number>;
}

const PAGE = 250;

async function listAll(reader: Reader, path: string, paged: boolean, unread: Record<string, number>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const p = paged ? `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE}&offset=${offset}` : path;
    const { status, body } = await reader.get(p);
    if (status < 200 || status >= 300) {
      unread[path] = status;
      return out;
    }
    const page = asList(body);
    out.push(...page);
    if (!paged || page.length < PAGE) return out;
  }
}

async function sub(reader: Reader, path: string, unread: Record<string, number>): Promise<Record<string, unknown>[]> {
  const { status, body } = await reader.get(path);
  if (status < 200 || status >= 300) {
    unread[path] = status;
    return [];
  }
  return asList(body);
}

/** Every read the model needs. Sources are read in full; per-source reads
 *  run a few at a time so a large tenant does not fan out hundreds of calls. */
export async function gather(reader: Reader): Promise<Gathered> {
  const unread: Record<string, number> = {};
  const [sources, profiles, transforms, identityAttributes] = await Promise.all([
    listAll(reader, "/v2025/sources", true, unread),
    listAll(reader, "/v3/identity-profiles", false, unread),
    listAll(reader, "/v3/transforms", false, unread),
    listAll(reader, "/v2025/identity-attributes", false, unread),
  ]);
  const schemas = new Map<string, Record<string, unknown>[]>();
  const policies = new Map<string, Record<string, unknown>[]>();
  const sync = new Map<string, Record<string, unknown>[]>();
  const correlation = new Map<string, Record<string, unknown>[]>();
  const queue = [...sources];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const id = String(s.id);
      const [sch, pol, syn, cor] = await Promise.all([
        sub(reader, `/v3/sources/${id}/schemas`, unread),
        sub(reader, `/v3/sources/${id}/provisioning-policies`, unread),
        reader.get(`/beta/sources/${id}/attribute-sync-config`).then(({ status, body }) => {
          if (status < 200 || status >= 300) {
            unread[`/beta/sources/${id}/attribute-sync-config`] = status;
            return [];
          }
          return asList(asRecord(body).attributes);
        }),
        reader.get(`/beta/sources/${id}/correlation-config`).then(({ status, body }) => {
          if (status < 200 || status >= 300) {
            unread[`/beta/sources/${id}/correlation-config`] = status;
            return [];
          }
          return asList(asRecord(body).attributeAssignments);
        }),
      ]);
      schemas.set(id, sch);
      policies.set(id, pol);
      sync.set(id, syn);
      correlation.set(id, cor);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { sources, schemas, profiles, transforms, identityAttributes, policies, sync, correlation, unread };
}

interface Resolved {
  /** Account attributes the chain reads, as source/attribute pairs. */
  reads: { sourceName: string; attributeName: string }[];
  /** Identity attributes the chain reads. */
  identity: string[];
  /** The chain, e.g. "firstValid > accountAttribute". */
  chain: string;
  /** Names of referenced transforms that do not exist. */
  missing: string[];
  /** Static or lookup values that end the chain. */
  constants: string[];
}

/** Walks a transform definition, following `reference` nodes into the
 *  tenant's transforms, and reports what it reads and how. Depth-capped so
 *  a cyclic reference cannot run away. */
export function resolveTransform(def: unknown, byName: Map<string, Record<string, unknown>>, depth = 0): Resolved {
  const out: Resolved = { reads: [], identity: [], chain: "", missing: [], constants: [] };
  const d = asRecord(def);
  const type = typeof d.type === "string" ? d.type : "";
  const attrs = asRecord(d.attributes);
  if (!type || depth > 12) return out;
  const merge = (r: Resolved) => {
    out.reads.push(...r.reads);
    out.identity.push(...r.identity);
    out.missing.push(...r.missing);
    out.constants.push(...r.constants);
    return r.chain;
  };
  switch (type) {
    case "accountAttribute":
      out.reads.push({ sourceName: String(attrs.sourceName ?? ""), attributeName: String(attrs.attributeName ?? "") });
      out.chain = "accountAttribute";
      return out;
    case "identityAttribute":
      out.identity.push(String(attrs.name ?? ""));
      out.chain = `identityAttribute(${String(attrs.name ?? "")})`;
      return out;
    case "static":
      out.constants.push(String(attrs.value ?? ""));
      out.chain = "static";
      return out;
    case "reference": {
      const name = String(attrs.id ?? "");
      const target = byName.get(name);
      if (!target) {
        out.missing.push(name);
        out.chain = `reference(${name}: MISSING)`;
        return out;
      }
      const inner = merge(resolveTransform({ type: target.type, attributes: target.attributes }, byName, depth + 1));
      out.chain = `${name} [${inner}]`;
      return out;
    }
    default: {
      // Anything else nests its inputs somewhere in attributes: input, values,
      // the two conditional branches, a table of cases. Walk every object
      // that carries a type.
      const parts: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) {
          v.forEach(walk);
        } else if (v && typeof v === "object") {
          const r = v as Record<string, unknown>;
          if (typeof r.type === "string" && "attributes" in r) parts.push(merge(resolveTransform(r, byName, depth + 1)));
          else Object.values(r).forEach(walk);
        }
      };
      walk(attrs);
      if (type === "lookup" && attrs.table) out.constants.push("lookup table");
      out.chain = parts.length ? `${type} > ${parts.join(" | ")}` : type;
      return out;
    }
  }
}

const sourceSystemId = (id: string) => `src:${id}`;
const profileSystemId = (id: string) => `profile:${id}`;
const IDENTITY = "identity";

/** The model, from what gather() read. Pure, so the test drives it with a fake tenant. */
export function buildDataFlow(g: Gathered, title: string): DataFlowModel {
  const lanes: DataFlowLane[] = [
    { id: "auth", label: "Authoritative sources" },
    { id: "isc", label: "Identity Security Cloud" },
    { id: "target", label: "Target systems" },
  ];
  const systems: DataFlowSystem[] = [];
  const flows: DataFlowFlow[] = [];
  const mappings: DataFlowMapping[] = [];
  const issues: DataFlowIssue[] = [];
  let flowN = 0;
  let issueN = 0;
  const flow = (from: string, to: string, mechanism: string, when: string, state: DataFlowState = "in-use") => {
    const id = `F${++flowN}`;
    flows.push({ id, from, to, mechanism, when, state });
    return id;
  };
  const issue = (severity: Severity, origin: string, text: string, sys: string[]) => {
    const id = `I${++issueN}`;
    issues.push({ id, severity, status: "Open", origin, issue: text, systems: sys });
    return id;
  };

  const sourcesByName = new Map<string, Record<string, unknown>>();
  const sourcesById = new Map<string, Record<string, unknown>>();
  for (const s of g.sources) {
    sourcesByName.set(String(s.name), s);
    sourcesById.set(String(s.id), s);
  }
  const transformsByName = new Map<string, Record<string, unknown>>();
  for (const t of g.transforms) transformsByName.set(String(t.name), t);
  const identityAttrNames = new Set(g.identityAttributes.map((a) => String(a.name)));
  const authoritativeIds = new Set<string>();
  for (const p of g.profiles) authoritativeIds.add(String(asRecord(p.authoritativeSource).id ?? ""));

  systems.push({ id: IDENTITY, label: "Identity attributes", lane: "isc", state: "in-use", description: `${identityAttrNames.size} identity attributes defined on the tenant.` });

  for (const s of g.sources) {
    const id = String(s.id);
    const authoritative = Boolean(s.authoritative) || authoritativeIds.has(id);
    const schema = (g.schemas.get(id) ?? []).find((x) => x.name === "account");
    const attrCount = asList(schema?.attributes).length;
    const features = asList(s.features).map(String);
    const desc = [
      `${String(s.type ?? "source")} connector`,
      authoritative ? "authoritative" : "",
      attrCount ? `${attrCount} account attributes` : "",
      features.includes("PROVISIONING") ? "provisioning" : "",
      features.includes("SYNC_PROVISIONING") ? "attribute sync" : "",
    ].filter(Boolean).join("; ");
    systems.push({ id: sourceSystemId(id), label: String(s.name), lane: authoritative ? "auth" : "target", state: "in-use", description: desc });
  }

  // Authoritative source -> identity profile -> identity attributes.
  for (const p of g.profiles) {
    const pid = String(p.id);
    const src = asRecord(p.authoritativeSource);
    const srcId = String(src.id ?? "");
    const srcName = String(src.name ?? sourcesById.get(srcId)?.name ?? "");
    const psys = profileSystemId(pid);
    const transforms = asList(asRecord(p.identityAttributeConfig).attributeTransforms);
    systems.push({ id: psys, label: `Identity profile: ${String(p.name)}`, lane: "isc", state: "in-use", description: `Authoritative source ${srcName || "(none)"}; ${transforms.length} attribute mappings; priority ${String(p.priority ?? "")}.` });
    if (srcId) flow(sourceSystemId(srcId), psys, "Account aggregation", "Scheduled and on demand");
    flow(psys, IDENTITY, "Identity attribute mapping", "On aggregation and identity refresh");
    if (!transforms.length) issue("low", "isc_dataflow", `Identity profile ${String(p.name)} maps no attributes.`, [psys]);
    const group = `Identity attributes: ${String(p.name)}`;
    for (const t of transforms) {
      const attr = String(t.identityAttributeName ?? "");
      const r = resolveTransform(t.transformDefinition, transformsByName);
      const rowIssues: string[] = [];
      for (const m of r.missing) rowIssues.push(issue("high", "isc_dataflow", `Mapping of ${attr} on ${String(p.name)} references transform "${m}", which does not exist.`, [psys]));
      const reads = r.reads.length ? r.reads : [{ sourceName: r.identity.length ? "Identity attributes" : "", attributeName: r.identity[0] ?? r.constants[0] ?? "" }];
      const unknownSources = r.reads.filter((x) => x.sourceName && !sourcesByName.has(x.sourceName)).map((x) => x.sourceName);
      for (const u of [...new Set(unknownSources)]) rowIssues.push(issue("medium", "isc_dataflow", `Mapping of ${attr} on ${String(p.name)} reads source "${u}", which is not on the tenant.`, [psys]));
      if (!identityAttrNames.has(attr)) rowIssues.push(issue("low", "isc_dataflow", `Identity attribute ${attr} (mapped on ${String(p.name)}) is not in the tenant's identity attribute list.`, [IDENTITY]));
      for (const read of reads) {
        mappings.push({
          group,
          sourceSystem: read.sourceName,
          sourceField: read.attributeName,
          viaSystem: `Identity profile: ${String(p.name)}`,
          via: attr,
          transform: r.chain,
          targetSystem: "Identity attributes",
          targetField: attr,
          operation: "C/U",
          issues: rowIssues,
          notes: r.constants.length ? `constants: ${r.constants.join(", ")}` : "",
          state: "in-use",
        });
      }
    }
  }

  // Identity attributes -> target source: CREATE policy, attribute sync; target -> identity: correlation.
  for (const s of g.sources) {
    const id = String(s.id);
    const name = String(s.name);
    const ssys = sourceSystemId(id);
    const authoritative = Boolean(s.authoritative) || authoritativeIds.has(id);
    const create = (g.policies.get(id) ?? []).find((p) => String(p.usageType ?? "").toUpperCase() === "CREATE");
    const fields = asList(create?.fields);
    if (fields.length) {
      flow(IDENTITY, ssys, "Provisioning: CREATE policy", "On role or access profile assignment");
      const group = `Provisioning: ${name}`;
      for (const f of fields) {
        const r = resolveTransform(f.transform, transformsByName);
        const rowIssues: string[] = [];
        for (const m of r.missing) rowIssues.push(issue("high", "isc_dataflow", `CREATE policy field ${String(f.name)} on ${name} references transform "${m}", which does not exist.`, [ssys]));
        for (const ia of r.identity) if (!identityAttrNames.has(ia)) rowIssues.push(issue("medium", "isc_dataflow", `CREATE policy field ${String(f.name)} on ${name} reads identity attribute ${ia}, which is not defined.`, [ssys, IDENTITY]));
        const from = r.identity[0] ?? r.reads[0]?.attributeName ?? r.constants[0] ?? "";
        mappings.push({
          group,
          sourceSystem: r.identity.length ? "Identity attributes" : r.reads[0]?.sourceName ?? "",
          sourceField: from,
          viaSystem: "",
          via: "",
          transform: r.chain || (f.attributes ? "static attributes" : ""),
          targetSystem: name,
          targetField: String(f.name ?? ""),
          operation: f.isRequired ? "C (required)" : "C",
          issues: rowIssues,
          notes: [typeof f.type === "string" ? f.type : "", f.isMultiValued ? "multi-valued" : ""].filter(Boolean).join(", "),
          state: "in-use",
        });
      }
    }
    const synced = g.sync.get(id) ?? [];
    if (synced.length) {
      const enabled = synced.filter((a) => a.enabled);
      flow(IDENTITY, ssys, "Attribute sync", "On identity attribute change", enabled.length ? "in-use" : "not-in-use");
      const group = `Attribute sync: ${name}`;
      for (const a of synced) {
        const ia = String(a.name ?? "");
        const rowIssues: string[] = [];
        if (a.enabled && !identityAttrNames.has(ia)) rowIssues.push(issue("medium", "isc_dataflow", `Attribute sync on ${name} maps identity attribute ${ia}, which is not defined.`, [ssys, IDENTITY]));
        mappings.push({
          group,
          sourceSystem: "Identity attributes",
          sourceField: ia,
          viaSystem: "",
          via: "",
          transform: "",
          targetSystem: name,
          targetField: String(a.target ?? ""),
          operation: "S",
          issues: rowIssues,
          notes: a.enabled ? "" : "sync disabled",
          state: a.enabled ? "in-use" : "not-in-use",
        });
      }
    }
    const corr = g.correlation.get(id) ?? [];
    if (!authoritative) flow(ssys, IDENTITY, corr.length ? "Account aggregation and correlation" : "Account aggregation (no correlation config)", "Scheduled and on demand");
    if (corr.length) {
      const group = `Correlation: ${name}`;
      const ordered = [...corr].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
      ordered.forEach((c, i) => {
        mappings.push({
          group,
          sourceSystem: name,
          sourceField: String(c.value ?? ""),
          viaSystem: "",
          via: "",
          transform: String(c.operation ?? "EQ") + (c.ignoreCase ? " (ignore case)" : ""),
          targetSystem: "Identity attributes",
          targetField: String(c.property ?? ""),
          operation: `K${i + 1}`,
          issues: [],
          notes: c.complex ? "complex" : "",
          state: "in-use",
        });
      });
    }
  }

  for (const [path, status] of Object.entries(g.unread)) {
    issue("low", "isc_dataflow", `Could not read ${path} (HTTP ${status}); the map is incomplete there.`, []);
  }

  return { title, lanes, systems, flows, mappings, issues };
}

export function dataFlowBlock(model: DataFlowModel): DataFlowBlock {
  return { kind: DATA_FLOW_KIND, version: 1, view: "dfd", model };
}

/** A compact digest for the chat reply: what was found, and the issues. */
export function summarise(model: DataFlowModel): Record<string, Json> {
  const groups: Record<string, number> = {};
  for (const m of model.mappings) groups[m.group] = (groups[m.group] ?? 0) + 1;
  return {
    systems: model.systems.length,
    flows: model.flows.length,
    mappings: model.mappings.length,
    mapping_groups: groups,
    issues: model.issues.map((i) => `${i.id} [${i.severity}] ${i.issue}`),
  };
}
