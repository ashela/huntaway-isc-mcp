import * as vscode from "vscode";
import * as path from "node:path";
import { KEY_PATTERN, hostOf, normaliseBaseUrl, type TenantRecord } from "./shared/config.js";
import { HuntawayIscProvider, PROVIDER_ID } from "./provider.js";
import { TenantStore } from "./tenants.js";
import { TenantItem, TenantTree } from "./tree.js";

export function activate(context: vscode.ExtensionContext): void {
  const store = new TenantStore(context.globalState, context.secrets);
  const version = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");
  const serverScript = path.join(context.extensionPath, "dist", "server.js");

  if (typeof vscode.lm?.registerMcpServerDefinitionProvider === "function") {
    const provider = new HuntawayIscProvider(store, serverScript, version);
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
  } else {
    void vscode.window.showWarningMessage("Huntaway ISC: this VS Code version has no MCP server API. Update to 1.101 or later.");
  }

  const tree = new TenantTree(store);
  context.subscriptions.push(vscode.window.createTreeView("huntawayIsc.tenants", { treeDataProvider: tree }));

  const keyOf = async (item?: TenantItem): Promise<string | undefined> => {
    if (item?.tenant) return item.tenant.key;
    const tenants = store.list();
    if (!tenants.length) {
      void vscode.window.showInformationMessage("No tenants yet. Run Huntaway ISC: Add Tenant.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      tenants.map((t) => ({ label: t.label, description: t.key, detail: hostOf(t.baseUrl), key: t.key })),
      { placeHolder: "Choose a tenant" },
    );
    return picked?.key;
  };

  const askCredentials = async (key: string): Promise<boolean> => {
    const clientId = await vscode.window.showInputBox({
      title: `Credentials for ${key}: client id`,
      prompt: "Personal Access Token id (preferred) or API client id. Stored in VS Code's secret storage.",
      ignoreFocusOut: true,
    });
    if (!clientId?.trim()) return false;
    const clientSecret = await vscode.window.showInputBox({
      title: `Credentials for ${key}: client secret`,
      prompt: "Never shown again, never written to settings.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!clientSecret?.trim()) return false;
    await store.setCredentials(key, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    return true;
  };

  const editRecord = async (existing?: TenantRecord): Promise<TenantRecord | undefined> => {
    const key = existing?.key ?? (await vscode.window.showInputBox({
      title: "Tenant key",
      prompt: "Short handle the model will use in tool calls, e.g. dev, prod, sandbox. Lower-case letters, digits and dashes.",
      value: "",
      validateInput: (v) => (KEY_PATTERN.test(v.trim().toLowerCase()) ? undefined : "Use 1 to 32 lower-case letters, digits or dashes."),
      ignoreFocusOut: true,
    }))?.trim().toLowerCase();
    if (!key) return undefined;
    if (!existing && store.get(key)) {
      void vscode.window.showErrorMessage(`A tenant with key "${key}" already exists.`);
      return undefined;
    }
    const label = await vscode.window.showInputBox({ title: "Tenant label", prompt: "Shown in results, e.g. Build tenant.", value: existing?.label ?? key, ignoreFocusOut: true });
    if (!label?.trim()) return undefined;
    const baseUrl = await vscode.window.showInputBox({
      title: "API base URL",
      prompt: "The tenant's API host, e.g. https://acme.api.identitynow.com",
      value: existing?.baseUrl ?? "https://",
      validateInput: (v) => {
        try {
          const u = new URL(normaliseBaseUrl(v));
          return u.host.includes(".") ? undefined : "Enter the API host.";
        } catch {
          return "Enter a URL.";
        }
      },
      ignoreFocusOut: true,
    });
    if (!baseUrl?.trim()) return undefined;
    const purpose = await vscode.window.showInputBox({
      title: "Purpose (optional)",
      prompt: "Echoed on every result, e.g. 'build tenant' or 'demo data: do not cite in deliverables'.",
      value: existing?.purpose ?? "",
      ignoreFocusOut: true,
    });
    if (purpose === undefined) return undefined;
    const tokens = await vscode.window.showInputBox({
      title: "Environment tokens to mask when comparing tenants (optional)",
      prompt: "Comma-separated, e.g. DEV, dev-tenant. Masked to <ENV> so prefixes do not read as drift.",
      value: existing?.maskTokens?.join(", ") ?? "",
      ignoreFocusOut: true,
    });
    if (tokens === undefined) return undefined;
    return {
      key,
      label: label.trim(),
      baseUrl: normaliseBaseUrl(baseUrl),
      purpose: purpose.trim() || undefined,
      maskTokens: tokens.split(",").map((t) => t.trim()).filter(Boolean),
      isDefault: existing?.isDefault,
    };
  };

  const register = (command: string, fn: (item?: TenantItem) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, async (item?: TenantItem) => {
      try {
        await fn(item);
      } catch (error) {
        void vscode.window.showErrorMessage(`Huntaway ISC: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

  register("huntaway-isc.addTenant", async () => {
    const record = await editRecord();
    if (!record) return;
    await store.upsert(record);
    const set = await askCredentials(record.key);
    void vscode.window.showInformationMessage(set ? `Tenant ${record.key} added. The Huntaway ISC MCP server is available in chat.` : `Tenant ${record.key} added without credentials. Set them before use.`);
  });

  register("huntaway-isc.editTenant", async (item) => {
    const key = await keyOf(item);
    const existing = key ? store.get(key) : undefined;
    if (!existing) return;
    const record = await editRecord(existing);
    if (record) await store.upsert(record);
  });

  register("huntaway-isc.setCredentials", async (item) => {
    const key = await keyOf(item);
    if (key && (await askCredentials(key))) void vscode.window.showInformationMessage(`Credentials for ${key} saved.`);
  });

  register("huntaway-isc.setDefault", async (item) => {
    const key = await keyOf(item);
    if (key) await store.setDefault(key);
  });

  register("huntaway-isc.removeTenant", async (item) => {
    const key = await keyOf(item);
    if (!key) return;
    const answer = await vscode.window.showWarningMessage(`Remove tenant ${key} and its stored credentials?`, { modal: true }, "Remove");
    if (answer === "Remove") await store.remove(key);
  });

  register("huntaway-isc.testTenant", async (item) => {
    const key = await keyOf(item);
    if (!key) return;
    const tenant = store.get(key);
    const creds = await store.getCredentials(key);
    if (!tenant || !creds) {
      void vscode.window.showWarningMessage(`Tenant ${key} has no credentials. Run Huntaway ISC: Set Credentials.`);
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${key}` }, async () => {
      const res = await fetch(`${tenant.baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `huntaway-isc-mcp/${version}` },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        void vscode.window.showErrorMessage(`${key}: authentication failed (HTTP ${res.status}). Check the client id and secret.`);
        return;
      }
      const token = String((JSON.parse(await res.text()) as { access_token?: string }).access_token ?? "");
      const probe = await fetch(`${tenant.baseUrl}/beta/workflows`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": `huntaway-isc-mcp/${version}` }, signal: AbortSignal.timeout(30_000) });
      void vscode.window.showInformationMessage(
        probe.ok
          ? `${key}: authenticated with user context (workflows reachable).`
          : `${key}: authenticated, but workflows returned HTTP ${probe.status}. An API client has no user context; use a Personal Access Token for workflows, forms and launchers.`,
      );
    });
  });
}

export function deactivate(): void {}
