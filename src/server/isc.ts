// The ISC client: tenant resolution, the client-credentials token, one HTTP
// call with retries, and the response envelope every tool stamps.
//
// A Personal Access Token and an API client both use the client-credentials
// grant and are indistinguishable at the token endpoint; they differ in what
// they can reach. An API client has no user context, so workflows, forms,
// launchers and work-items return 403 through it whatever its scopes.
// Capability is therefore MEASURED by isc_tenants, never inferred.

import type { TenantRuntime } from "../shared/config.js";
import { hostOf } from "../shared/config.js";
import type { Json } from "./util.js";

export const HTTP_TIMEOUT_MS = 60_000;

export class IscError extends Error {}

export interface CallResult {
  status: number;
  body: Json;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface HttpResponse {
  status: number;
  text: string;
  headers: { get(name: string): string | null };
}

export type HttpFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponse>;

/** fetch, narrowed to what the client uses, so tests can substitute it. */
export const defaultHttp: HttpFn = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IscClient {
  private readonly tokens = new Map<string, CachedToken>();

  constructor(
    readonly tenants: TenantRuntime[],
    readonly userAgent: string,
    private readonly http: HttpFn = defaultHttp,
    private readonly delay: (ms: number) => Promise<unknown> = sleep,
  ) {}

  keys(): string[] {
    return this.tenants.map((t) => t.key);
  }

  /** The tenant a call addresses: the named one, else the default, else the
   *  only one. With several tenants and no default, the caller must choose. */
  resolve(key?: string): TenantRuntime {
    if (!this.tenants.length) {
      throw new IscError("No tenants are configured. Add one in VS Code: Huntaway ISC: Add Tenant.");
    }
    if (key) {
      const found = this.tenants.find((t) => t.key === key.toLowerCase());
      if (!found) {
        throw new IscError(`unknown tenant ${JSON.stringify(key)}. Configured: ${this.describeTenants()}`);
      }
      return found;
    }
    const def = this.tenants.find((t) => t.isDefault);
    if (def) return def;
    if (this.tenants.length === 1) return this.tenants[0];
    throw new IscError(`pass tenant: no default is set. Configured: ${this.describeTenants()}`);
  }

  private describeTenants(): string {
    return this.tenants.map((t) => `${t.key} (${t.label})`).join(", ");
  }

  async token(key?: string): Promise<{ tenant: TenantRuntime; token: string }> {
    const tenant = this.resolve(key);
    const cached = this.tokens.get(tenant.key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { tenant, token: cached.token };
    if (!tenant.clientId || !tenant.clientSecret) {
      throw new IscError(
        `${tenant.key} (${tenant.label}) has no credentials. Set them in VS Code: Huntaway ISC: Set Credentials. ` +
          "Prefer a Personal Access Token: an API client cannot reach workflows, forms, launchers or work-items.",
      );
    }
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: tenant.clientId,
      client_secret: tenant.clientSecret,
    });
    let res: HttpResponse;
    try {
      res = await this.http(`${tenant.baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": this.userAgent },
        body: form.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new IscError(`could not reach ${tenant.baseUrl}: ${describe(error)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new IscError(
        `auth failed for ${tenant.key} (HTTP ${res.status}). Check the client id and secret, and that the token has not been revoked.`,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      throw new IscError(`auth response for ${tenant.key} was not JSON`);
    }
    const token = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!token) throw new IscError(`auth response for ${tenant.key} contained no access_token`);
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    this.tokens.set(tenant.key, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return { tenant, token };
  }

  /** One API call. Retries 429 and 5xx with a short backoff; returns the
   *  status and parsed body rather than throwing on a non-2xx, so a tool can
   *  report exactly what the tenant said. */
  async call(
    key: string | undefined,
    method: string,
    path: string,
    body?: Json,
    contentType = "application/json",
    retries = 3,
  ): Promise<CallResult> {
    const { tenant, token } = await this.token(key);
    const url = tenant.baseUrl + (path.startsWith("/") ? path : "/" + path);
    const payload = body === undefined || body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    let last: CallResult = { status: 0, body: null };
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await this.http(url, {
          method: method.toUpperCase(),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": contentType,
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          body: payload,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        const parsed = parseBody(res.text);
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries - 1) {
          last = { status: res.status, body: parsed };
          await this.delay(2000 * (attempt + 1));
          continue;
        }
        return { status: res.status, body: parsed };
      } catch (error) {
        last = { status: 0, body: describe(error) };
        if (attempt < retries - 1) await this.delay(2000 * (attempt + 1));
      }
    }
    return last;
  }

  /** Stamps which tenant answered, so a result can never be misattributed. */
  async envelope(key: string | undefined, rest: Record<string, Json>): Promise<Record<string, Json>> {
    const tenant = this.resolve(key);
    const env: Record<string, Json> = {
      tenant: tenant.key,
      tenant_label: tenant.label,
      host: hostOf(tenant.baseUrl),
    };
    if (tenant.purpose) env.purpose = tenant.purpose;
    return { ...env, ...rest };
  }
}

function parseBody(text: string): Json {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 1200 ? text.slice(0, 1200) : text;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
