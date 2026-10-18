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
/** Set only when the extension starts the optional localhost endpoint: the
 *  port to listen on (0 picks one). Unset means stdio, as the editor runs it. */
export const HTTP_PORT_ENV = "HUNTAWAY_ISC_HTTP_PORT";
/** The hex SHA-256 of the endpoint's bearer token. The token itself never
 *  reaches the server process. */
export const HTTP_TOKEN_SHA256_ENV = "HUNTAWAY_ISC_HTTP_TOKEN_SHA256";
/** The endpoint's port when the person has not chosen one. */
export const DEFAULT_HTTP_PORT = 37615;

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

/** The endpoint's port from the environment, or null for stdio mode. */
export function parseHttpPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${HTTP_PORT_ENV} must be a port number, not ${JSON.stringify(raw)}`);
  return n;
}
