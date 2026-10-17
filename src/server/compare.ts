// Tenant comparison. Two tenants differ BY DESIGN in object ids, OAuth
// binds, hostnames, environment prefixes and mail recipients. Everything
// here masks exactly those, so what survives the diff is logic drift.
//
// Environment tokens are per tenant (TenantRecord.maskTokens): "DEV" and
// "dev-tenant" on one side, "UAT" and "uat-tenant" on the other. Each token
// is masked to <ENV> wherever it appears bounded by non-letters, in every
// case, with longer tokens first so "dev-tenant" is masked before "dev".

import { asList, asRecord } from "./util.js";

/** Dropped at EVERY nesting level, not just the top. `enabled` is deliberately
 *  absent: it differs for real reasons and is exactly what a replay must surface. */
export const DIFF_NOISE = new Set([
  "id", "created", "modified", "owner", "creator", "modifiedBy", "ownerId", "executionCount",
  "failureCount", "dailyExecutionCount", "cloudExternalId", "health", "healthy", "since",
  "status", "synced", "lastUpdated", "refID", "param_oauth", "usedBy", "identityCount",
  "lastChanged", "cluster", "connectorImplementationId", "identityRefreshRequired",
  "accountsFile", "priority", "createdBy", "updatedBy", "modifiedAt", "createdAt",
  "lastModified", "version",
]);

const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const RECIPIENT_LEAF = /(recipient|carbonCopy|blindCarbonCopy|from|replyTo)/i;
export const ABSENT = "<absent>";
const VALUE_CHARS = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Normaliser {
  text(value: string): string;
  value(value: unknown): unknown;
  /** Pairing key: the leading environment token comes off BEFORE masking. */
  key(name: string | undefined): string;
}

export function makeNormaliser(tokens: string[]): Normaliser {
  const sorted = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const tokenRx = sorted.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${sorted.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "gi")
    : null;
  const prefixRx = sorted.length ? new RegExp(`^(?:${sorted.map(escapeRegExp).join("|")})[ _-]`, "i") : null;

  const text = (value: string): string => {
    // Decode first: an id inside %22...%22 is preceded by the hex digit 2,
    // so the hex-boundary match never fires and the id survives as noise.
    let s = value;
    if (s.includes("%")) {
      try {
        s = decodeURIComponent(s);
      } catch {
        /* keep the raw string */
      }
    }
    s = s.replace(EMAIL, "<EMAIL>").replace(UUID, "<ID>").replace(HEX32, "<ID>");
    if (tokenRx) s = s.replace(tokenRx, "<ENV>");
    return s;
  };

  const value = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        if (DIFF_NOISE.has(k)) continue;
        let next = raw;
        // define-variable variables, keyed by name: their order carries no
        // meaning, and one inserted mid-list would otherwise report every
        // later variable as changed.
        if (k === "variables" && Array.isArray(raw) && raw.length && raw.every((x) => x && typeof x === "object" && "name" in x)) {
          const keyed: Record<string, unknown> = {};
          for (const x of raw as Record<string, unknown>[]) keyed[text(String(x.name))] = value(x);
          next = keyed;
        } else {
          next = value(raw);
        }
        out[text(k)] = next;
      }
      return out;
    }
    if (typeof v === "string") return text(v);
    return v;
  };

  const key = (name: string | undefined): string => {
    let n = name ?? "";
    if (prefixRx) n = n.replace(prefixRx, "");
    return text(n).trim();
  };

  return { text, value, key };
}

/** (path, leaf) pairs. Empty containers are leaves, so `{}` vs absent still differs. */
export function flatten(o: unknown, path = ""): [string, unknown][] {
  if (Array.isArray(o)) {
    if (!o.length) return [[path, []]];
    return o.flatMap((v, i) => flatten(v, `${path}[${i}]`));
  }
  if (o && typeof o === "object") {
    const entries = Object.entries(o as Record<string, unknown>);
    if (!entries.length) return [[path, {}]];
    return entries.flatMap(([k, v]) => flatten(v, `${path}/${k}`));
  }
  return [[path, o]];
}

/** Every address-bearing leaf, compared RAW and reported apart from the logic
 *  diff, because a build tenant routes mail to a test address on purpose. */
export function recipients(o: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, v] of flatten(o)) {
    if (typeof v === "string" && RECIPIENT_LEAF.test(p.split("/").pop() ?? "")) out[p] = v;
  }
  return out;
}

export function short(v: unknown): unknown {
  if (typeof v === "string" && v.length > VALUE_CHARS) return `${v.slice(0, VALUE_CHARS)}...(+${v.length - VALUE_CHARS} chars)`;
  return v;
}

export function topKey(path: string): string {
  return path.replace(/^\//, "").split(/[/[]/)[0];
}

export interface DiffPath {
  path: string;
  a: unknown;
  b: unknown;
}

/** Differing leaf paths between two already-collected objects. */
export function diffObjects(aObj: unknown, bObj: unknown, norm: Normaliser): DiffPath[] {
  const fa = new Map(flatten(norm.value(aObj)));
  const fb = new Map(flatten(norm.value(bObj)));
  const paths = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const out: DiffPath[] = [];
  for (const p of paths) {
    const va = fa.has(p) ? fa.get(p) : ABSENT;
    const vb = fb.has(p) ? fb.get(p) : ABSENT;
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ path: p, a: va, b: vb });
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Collectors: one tenant's objects of a type, keyed by name, shaped so that */
/* per-tenant membership compares as names and ids never reach the diff.   */
/* ---------------------------------------------------------------------- */

export interface ReadOnlyView {
  listing(path: string, paged?: boolean): Promise<Record<string, unknown>[]>;
  sub(path: string): Promise<unknown>;
}

export type Wanted = (name: string) => boolean;
export type Collector = (view: ReadOnlyView, wanted: Wanted) => Promise<Record<string, unknown>>;

export function nameOf(o: Record<string, unknown>): string {
  return typeof o.name === "string" && o.name ? o.name : typeof o.id === "string" ? o.id : "";
}

const listing = (path: string, paged = true): Collector => async (view) => {
  const out: Record<string, unknown> = {};
  for (const x of await view.listing(path, paged)) out[nameOf(x)] = x;
  return out;
};

/** Presence only: these carry per-tenant membership, so name parity is the signal. */
const names = (path: string): Collector => async (view) => {
  const out: Record<string, unknown> = {};
  for (const x of await view.listing(path)) out[nameOf(x)] = {};
  return out;
};

const forms: Collector = async (view, wanted) => {
  const out: Record<string, unknown> = {};
  for (const f of await view.listing("/v2025/form-definitions")) {
    const full = wanted(nameOf(f)) ? await view.sub(`/v2025/form-definitions/${f.id}`) : null;
    out[nameOf(f)] = full && typeof full === "object" ? full : f;
  }
  return out;
};

const identityProfiles: Collector = async (view, wanted) => {
  const out: Record<string, unknown> = {};
  for (const p of await view.listing("/v3/identity-profiles", false)) {
    if (!wanted(nameOf(p))) {
      out[nameOf(p)] = p;
      continue;
    }
    const cfg = { ...asRecord(p.identityAttributeConfig) };
    // Keyed by attribute so a reordered mapping list is not reported as drift.
    const transforms: Record<string, unknown> = {};
    for (const a of asList(cfg.attributeTransforms)) transforms[String(a.identityAttributeName)] = a;
    cfg.attributeTransforms = transforms;
    const ls = await view.sub(`/v3/identity-profiles/${p.id}/lifecycle-states`);
    const lifecycle: Record<string, unknown> = {};
    for (const x of asList(ls)) lifecycle[String(x.technicalName)] = x;
    const { authoritativeSource: _source, ...rest } = p;
    out[nameOf(p)] = { ...rest, identityAttributeConfig: cfg, lifecycleStates: lifecycle };
  }
  return out;
};

const sortedNames = (list: unknown): string[] => asList(list).map((e) => (typeof e.name === "string" ? e.name : "")).sort();

const accessProfiles: Collector = async (view) => {
  const out: Record<string, unknown> = {};
  for (const a of await view.listing("/v2025/access-profiles")) {
    // Entitlement refs carry per-tenant ids; sorted names compare membership.
    out[nameOf(a)] = { ...a, entitlements: sortedNames(a.entitlements) };
  }
  return out;
};

const roles: Collector = async (view) => {
  const out: Record<string, unknown> = {};
  for (const r of await view.listing("/v2025/roles")) {
    out[nameOf(r)] = { ...r, accessProfiles: sortedNames(r.accessProfiles), entitlements: sortedNames(r.entitlements) };
  }
  return out;
};

/** Connector attributes that encode behaviour. The rest is hosts, masked
 *  credentials and cache timestamps, which differ per tenant by construction. */
const SOURCE_CONNECTOR_KEYS = [
  "accountFilterAttribute", "deleteThresholdPercentage", "checkDeletedDisabled", "searchDNs",
  "groupSearchDNs", "filterString", "groupFilterString", "deltaAggregationEnabled",
  "manageRecycleBin", "enableProvisioningFeature", "accountFilter", "groupFilter", "deleteToDisable",
];

const sources: Collector = async (view, wanted) => {
  const out: Record<string, unknown> = {};
  for (const s of await view.listing("/v2025/sources")) {
    if (!wanted(nameOf(s))) {
      out[nameOf(s)] = {};
      continue;
    }
    const ca = asRecord(s.connectorAttributes);
    const selected: Record<string, unknown> = {};
    for (const k of SOURCE_CONNECTOR_KEYS) if (k in ca) selected[k] = ca[k];
    const [pol, sch, cc] = await Promise.all([
      view.sub(`/v3/sources/${s.id}/provisioning-policies`),
      view.sub(`/v3/sources/${s.id}/schemas`),
      view.sub(`/beta/sources/${s.id}/correlation-config`),
    ]);
    const policies: Record<string, unknown> = {};
    for (const p of asList(pol)) {
      const fields: Record<string, unknown> = {};
      for (const f of asList(p.fields)) fields[String(f.name)] = f;
      policies[String(p.usageType)] = fields;
    }
    const schemas: Record<string, unknown> = {};
    for (const x of asList(sch)) schemas[String(x.name)] = sortedNames(x.attributes);
    out[nameOf(s)] = {
      type: s.type,
      authoritative: s.authoritative,
      features: [...asList(s.features) as unknown[]].map(String).sort(),
      deleteThreshold: s.deleteThreshold,
      managementWorkgroup: Boolean(s.managementWorkgroup),
      "connectorAttributes(selected)": selected,
      provisioningPolicies: policies,
      schemas,
      correlation: cc && typeof cc === "object" && !Array.isArray(cc) ? asRecord(cc).attributeAssignments : cc,
    };
  }
  return out;
};

const nonEmployeeSources: Collector = async (view, wanted) => {
  const out: Record<string, unknown> = {};
  for (const n of await view.listing("/v2025/non-employee-sources")) {
    if (!wanted(nameOf(n))) {
      out[nameOf(n)] = {};
      continue;
    }
    const sa = await view.sub(`/v2025/non-employee-sources/${n.id}/schema-attributes`);
    const schema: Record<string, unknown> = {};
    for (const a of asList(sa)) {
      schema[String(a.technicalName)] = { label: a.label, type: a.type, required: a.required, helpText: a.helpText, placeholder: a.placeholder };
    }
    // Approvers and account managers are per-tenant identities; their number is comparable.
    out[nameOf(n)] = {
      description: n.description,
      approvers: asList(n.approvers).length,
      accountManagers: asList(n.accountManagers).length,
      schema,
    };
  }
  return out;
};

export const COLLECTORS: Record<string, Collector> = {
  workflows: listing("/beta/workflows", false),
  "form-definitions": forms,
  launchers: listing("/beta/launchers"),
  transforms: listing("/v3/transforms", false),
  "identity-attributes": listing("/v2025/identity-attributes", false),
  "identity-profiles": identityProfiles,
  "access-profiles": accessProfiles,
  roles,
  sources,
  "non-employee-sources": nonEmployeeSources,
  "governance-groups": names("/v2025/workgroups"),
  "campaign-templates": names("/v2025/campaign-templates"),
  "sod-policies": names("/v2025/sod-policies"),
};

export const COMPARE_ALIASES: Record<string, string> = { forms: "form-definitions" };
export const COMPARE_TYPES = [...Object.keys(COLLECTORS), ...Object.keys(COMPARE_ALIASES)].sort();
