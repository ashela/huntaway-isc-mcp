// Tenant storage. The non-secret part (key, label, host, purpose, mask
// tokens, default flag) lives in globalState; the client id and secret live
// in SecretStorage under one key per tenant. Nothing is written to
// settings.json, so Settings Sync and a committed .vscode folder can never
// carry a credential or a tenant host.

import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { KEY_PATTERN, normaliseBaseUrl, type TenantRecord, type TenantRuntime } from "./shared/config.js";

const STATE_KEY = "huntaway-isc.tenants";
const SECRET_PREFIX = "huntaway-isc.credentials.";

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export class TenantStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  list(): TenantRecord[] {
    const raw = this.state.get<unknown>(STATE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is TenantRecord => Boolean(t) && typeof t === "object" && KEY_PATTERN.test(String((t as TenantRecord).key)));
  }

  get(key: string): TenantRecord | undefined {
    return this.list().find((t) => t.key === key);
  }

  async upsert(record: TenantRecord): Promise<void> {
    if (!KEY_PATTERN.test(record.key)) throw new Error(`Tenant key must match ${KEY_PATTERN}`);
    const next = this.list().filter((t) => t.key !== record.key);
    next.push({ ...record, baseUrl: normaliseBaseUrl(record.baseUrl) });
    if (next.length === 1) next[0].isDefault = true;
    await this.save(next);
  }

  async remove(key: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + key);
    await this.save(this.list().filter((t) => t.key !== key));
  }

  async setDefault(key: string): Promise<void> {
    await this.save(this.list().map((t) => ({ ...t, isDefault: t.key === key })));
  }

  async setCredentials(key: string, creds: Credentials): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + key, JSON.stringify(creds));
    this.changed.fire();
  }

  async getCredentials(key: string): Promise<Credentials | undefined> {
    const raw = await this.secrets.get(SECRET_PREFIX + key);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<Credentials>;
      if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string") return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    } catch {
      /* unreadable: treat as unset */
    }
    return undefined;
  }

  async hasCredentials(key: string): Promise<boolean> {
    return Boolean(await this.getCredentials(key));
  }

  /** Records merged with their secrets: what the server process receives.
   *  A tenant without credentials is included so the server can say so. */
  async runtime(): Promise<TenantRuntime[]> {
    const out: TenantRuntime[] = [];
    for (const t of this.list()) {
      const creds = await this.getCredentials(t.key);
      out.push({ ...t, clientId: creds?.clientId ?? "", clientSecret: creds?.clientSecret ?? "" });
    }
    return out;
  }

  /** Changes when the non-secret configuration changes, so the editor
   *  refreshes the server's tool list. Secrets are not part of it. */
  version(): string {
    const digest = createHash("sha256").update(JSON.stringify(this.list())).digest("hex");
    return digest.slice(0, 12);
  }

  private async save(records: TenantRecord[]): Promise<void> {
    await this.state.update(STATE_KEY, records);
    this.changed.fire();
  }
}
