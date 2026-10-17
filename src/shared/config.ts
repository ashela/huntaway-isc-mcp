// Tenant configuration shared by the extension (which stores it) and the
// server (which receives it). The extension keeps the non-secret part in
// globalState and the credentials in SecretStorage, and hands the merged
// list to the server process through ONE environment variable, set on the
// child process only. Nothing here is ever written to settings.json.

/** Environment variable carrying the JSON-encoded TenantRuntime[] to the server. */
export const TENANTS_ENV = "HUNTAWAY_ISC_TENANTS";
/** Workflow step cap the licence enforces on enable (20, 50 or 100). */
export const STEP_CAP_ENV = "HUNTAWAY_ISC_STEP_CAP";
export const DEFAULT_STEP_CAP = 50;

/** Tenant keys are what the model types: short, lower-case, stable. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface TenantRecord {
  /** Short handle used in every tool call, e.g. "dev", "prod", "sandbox". */
  key: string;
  /** Human label echoed on every response. */
  label: string;
  /** https://<tenant>.api.identitynow.com (any ISC API host). */
  baseUrl: string;
  /** Free text echoed on every response, e.g. "build tenant" or "demo data, do not cite". */
  purpose?: string;
  /** Environment tokens masked to <ENV> before two tenants are compared, e.g. ["DEV", "dev-tenant"]. */
  maskTokens?: string[];
  /** Used when a tool call names no tenant. */
  isDefault?: boolean;
}

export interface TenantRuntime extends TenantRecord {
  /** Client-credentials pair: a Personal Access Token or an API client. Empty when not yet set. */
  clientId: string;
  clientSecret: string;
}

export function normaliseBaseUrl(url: string): string {
  let out = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(out)) out = "https://" + out;
  return out;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(normaliseBaseUrl(baseUrl)).host;
  } catch {
    return baseUrl;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parses the server's environment into tenants, dropping anything malformed
 *  rather than failing the whole server over one bad entry. */
export function parseTenantsEnv(raw: string | undefined): TenantRuntime[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TenantRuntime[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const key = str(t.key).toLowerCase();
    const baseUrl = str(t.baseUrl);
    if (!KEY_PATTERN.test(key) || !baseUrl || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: str(t.label) || key,
      baseUrl: normaliseBaseUrl(baseUrl),
      purpose: str(t.purpose) || undefined,
      maskTokens: Array.isArray(t.maskTokens) ? t.maskTokens.map(str).filter(Boolean) : undefined,
      isDefault: t.isDefault === true,
      clientId: str(t.clientId),
      clientSecret: str(t.clientSecret),
    });
  }
  return out;
}

export function parseStepCap(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STEP_CAP;
}
