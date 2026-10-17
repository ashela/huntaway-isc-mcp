// The read-only asset browser behind the Huntaway view: which object types
// are listed under a tenant, how each is fetched, and how one object's full
// JSON is read for the editor. Pure (no vscode import) so it is unit-tested;
// tree.ts turns it into tree items.

import type { IscClient } from "./server/isc.js";
import { asList, asRecord } from "./server/util.js";

export interface Category {
  id: string;
  label: string;
  /** Listing path, without query. */
  path: string;
  /** Whether the listing honours limit/offset. Workflows and transforms do not. */
  paged: boolean;
  /** Path of one object's full JSON. */
  detail: (o: Record<string, unknown>) => string;
  icon: string;
}

const byId = (base: string) => (o: Record<string, unknown>) => `${base}/${encodeURIComponent(String(o.id))}`;

export const CATEGORIES: Category[] = [
  { id: "sources", label: "Sources", path: "/v2025/sources", paged: true, detail: byId("/v2025/sources"), icon: "database" },
  { id: "identity-profiles", label: "Identity profiles", path: "/v3/identity-profiles", paged: false, detail: byId("/v3/identity-profiles"), icon: "person" },
  { id: "identity-attributes", label: "Identity attributes", path: "/v2025/identity-attributes", paged: false, detail: (o) => `/v2025/identity-attributes/${encodeURIComponent(String(o.name))}`, icon: "symbol-field" },
  { id: "transforms", label: "Transforms", path: "/v3/transforms", paged: false, detail: byId("/v3/transforms"), icon: "symbol-operator" },
  { id: "workflows", label: "Workflows", path: "/beta/workflows", paged: false, detail: byId("/beta/workflows"), icon: "git-merge" },
  { id: "launchers", label: "Launchers", path: "/beta/launchers", paged: true, detail: byId("/beta/launchers"), icon: "rocket" },
  { id: "form-definitions", label: "Forms", path: "/v2025/form-definitions", paged: true, detail: byId("/v2025/form-definitions"), icon: "checklist" },
  { id: "access-profiles", label: "Access profiles", path: "/v2025/access-profiles", paged: true, detail: byId("/v2025/access-profiles"), icon: "key" },
  { id: "roles", label: "Roles", path: "/v2025/roles", paged: true, detail: byId("/v2025/roles"), icon: "organization" },
  { id: "governance-groups", label: "Governance groups", path: "/v2025/workgroups", paged: true, detail: byId("/v2025/workgroups"), icon: "people" },
  { id: "non-employee-sources", label: "Non-employee sources", path: "/v2025/non-employee-sources", paged: true, detail: byId("/v2025/non-employee-sources"), icon: "briefcase" },
  { id: "campaign-templates", label: "Campaign templates", path: "/v2025/campaign-templates", paged: true, detail: byId("/v2025/campaign-templates"), icon: "calendar" },
  { id: "sod-policies", label: "SoD policies", path: "/v2025/sod-policies", paged: true, detail: byId("/v2025/sod-policies"), icon: "shield" },
];

export const PAGE = 250;
/** Enough for any real tenant's configuration objects; accounts and identities are not browsed here. */
export const MAX_OBJECTS = 5000;

export class BrowseError extends Error {}

/** Every object of one category, named and sorted. A listing that is not
 *  paged is read once; a paged one is read until a short page. */
export async function listCategory(isc: IscClient, tenant: string, cat: Category): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const path = cat.paged ? `${cat.path}?limit=${PAGE}&offset=${offset}` : cat.path;
    const { status, body } = await isc.call(tenant, "GET", path);
    if (status < 200 || status >= 300) {
      throw new BrowseError(status === 403 ? "HTTP 403: this credential has no user context or lacks the scope" : `HTTP ${status}`);
    }
    const page = asList(body);
    out.push(...page);
    if (!cat.paged || page.length < PAGE || out.length >= MAX_OBJECTS) break;
  }
  return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }));
}

export async function readObject(isc: IscClient, tenant: string, cat: Category, o: Record<string, unknown>): Promise<string> {
  const { status, body } = await isc.call(tenant, "GET", cat.detail(o));
  if (status < 200 || status >= 300) throw new BrowseError(`HTTP ${status}`);
  return JSON.stringify(body, null, 2);
}

export function nameOf(o: Record<string, unknown>): string {
  return typeof o.name === "string" && o.name ? o.name : typeof o.id === "string" ? o.id : "";
}

/** The one-line description beside an object's name. */
export function summarise(cat: Category, o: Record<string, unknown>): string {
  switch (cat.id) {
    case "sources":
      return [o.type, o.authoritative ? "authoritative" : ""].filter(Boolean).join(", ");
    case "workflows":
      return [o.enabled ? "enabled" : "disabled", asRecord(o.trigger).type].filter(Boolean).join(", ");
    case "launchers":
      return [o.disabled ? "disabled" : "enabled", asRecord(o.reference).type].filter(Boolean).join(", ");
    case "identity-profiles":
      return String(asRecord(o.authoritativeSource).name ?? "");
    case "identity-attributes":
      return [o.type, o.searchable ? "searchable" : ""].filter(Boolean).join(", ");
    case "transforms":
      return String(o.type ?? "");
    case "access-profiles":
    case "roles":
      return [o.enabled ? "enabled" : "disabled", o.requestable ? "requestable" : ""].filter(Boolean).join(", ");
    default:
      return "";
  }
}
