import * as vscode from "vscode";
import * as path from "node:path";
import { KEY_PATTERN, hostOf, normaliseBaseUrl, type TenantRecord } from "./shared/config.js";
import { HuntawayIscProvider, PROVIDER_ID } from "./provider.js";
import { TenantStore } from "./tenants.js";
import { CategoryItem, ObjectItem, TenantItem, TenantTree, type Node } from "./tree.js";
import { IscClient } from "./server/isc.js";
import { readObject } from "./browser.js";

const JSON_SCHEME = "huntaway-isc";

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

  // One API client per configuration version, shared by the browser and
  // the JSON editor, so a token is fetched once per tenant per session.
  let clientVersion = "";
  let client: IscClient | undefined;
  const clientFor = async (key: string): Promise<IscClient> => {
    const v = store.version();
    if (!client || clientVersion !== v) {
      client = new IscClient(await store.runtime(), `huntaway-isc-mcp/${version}`);
      clientVersion = v;
    }
    client.resolve(key);
    return client;
  };
  store.onDidChange(() => {
    client = undefined;
  });

  const tree = new TenantTree(store, clientFor);
  context.subscriptions.push(vscode.window.createTreeView("huntawayIsc.tenants", { treeDataProvider: tree, showCollapseAll: true }));

  // An object's JSON, read on open and never written: the editor is the
  // viewer, so the URI names the tenant, type and object.
  const objects = new Map<string, ObjectItem>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(JSON_SCHEME, {
    async provideTextDocumentContent(uri) {
      const item = objects.get(uri.path);
      if (!item) return "// This object was opened in an earlier session. Open it again from the Huntaway view.";
      try {
        return await readObject(await clientFor(item.tenant.key), item.tenant.key, item.category, item.object);
      } catch (error) {
        return `// ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  }));

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
      placeHolder: "The 32-character id from Preferences, then Personal Access Tokens",
      ignoreFocusOut: true,
    });
    if (!clientId?.trim()) return false;
    const clientSecret = await vscode.window.showInputBox({
      title: `Credentials for ${key}: client secret`,
      prompt: "Never shown again, never written to settings.",
      placeHolder: "The secret shown once when the token was created",
      password: true,
      ignoreFocusOut: true,
    });
    if (!clientSecret?.trim()) return false;
    await store.setCredentials(key, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    return true;
  };

  const editRecord = async (existing?: TenantRecord): Promise<TenantRecord | undefined> => {
    const baseUrl = await vscode.window.showInputBox({
      title: existing ? `Edit ${existing.key}: API base URL` : "Add tenant (1 of 5): API base URL",
      prompt: "The tenant's API host: https://<tenant>.api.identitynow.com. Find <tenant> in the address bar when signed in to ISC.",
      placeHolder: "https://acme.api.identitynow.com",
      value: existing?.baseUrl ?? "",
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
    // The host's first label is usually the tenant name, and makes a good key.
    const suggestedKey = hostOf(normaliseBaseUrl(baseUrl)).split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 32);
    const key = existing?.key ?? (await vscode.window.showInputBox({
      title: "Add tenant (2 of 5): key",
      prompt: "Short handle you will use in chat, e.g. \"list workflows on dev\". Lower-case letters, digits and dashes.",
      placeHolder: "e.g. dev, prod, sandbox",
      value: suggestedKey,
      validateInput: (v) => (KEY_PATTERN.test(v.trim().toLowerCase()) ? undefined : "Use 1 to 32 lower-case letters, digits or dashes."),
      ignoreFocusOut: true,
    }))?.trim().toLowerCase();
    if (!key) return undefined;
    if (!existing && store.get(key)) {
      void vscode.window.showErrorMessage(`A tenant with key "${key}" already exists.`);
      return undefined;
    }
    const label = await vscode.window.showInputBox({
      title: existing ? `Edit ${existing.key}: label` : "Add tenant (3 of 5): label",
      prompt: "Shown in results and in the Huntaway view.",
      placeHolder: "e.g. Build tenant",
      value: existing?.label ?? key,
      ignoreFocusOut: true,
    });
    if (!label?.trim()) return undefined;
    const purpose = await vscode.window.showInputBox({
      title: existing ? `Edit ${existing.key}: purpose (optional)` : "Add tenant (4 of 5): purpose (optional, Enter to skip)",
      prompt: "Echoed on every result so the assistant knows what the tenant is for.",
      placeHolder: "e.g. build tenant, or: demo data, do not cite in deliverables",
      value: existing?.purpose ?? "",
      ignoreFocusOut: true,
    });
    if (purpose === undefined) return undefined;
    const tokens = await vscode.window.showInputBox({
      title: existing ? `Edit ${existing.key}: tokens to mask (optional)` : "Add tenant (5 of 5): tokens to mask when comparing tenants (optional, Enter to skip)",
      prompt: "Comma-separated. Masked to <ENV> when comparing tenants so environment prefixes do not read as drift.",
      placeHolder: "e.g. DEV, dev-tenant",
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

  context.subscriptions.push(vscode.commands.registerCommand("huntaway-isc.openObject", async (item: ObjectItem) => {
    const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    const path = `/${item.tenant.key}/${item.category.id}/${safe(String(item.object.id ?? ""))}/${safe(item.object.name ? String(item.object.name) : "object")}.json`;
    objects.set(path, item);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: JSON_SCHEME, path }));
    await vscode.window.showTextDocument(doc, { preview: true });
  }));

  context.subscriptions.push(vscode.commands.registerCommand("huntaway-isc.refresh", (node?: Node) => {
    tree.refresh(node instanceof CategoryItem ? node : undefined);
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
        tree.setStatus(key, false, `authentication failed (HTTP ${res.status})`);
        void vscode.window.showErrorMessage(`${key}: authentication failed (HTTP ${res.status}). Check the client id and secret.`, { modal: true });
        return;
      }
      const token = String((JSON.parse(await res.text()) as { access_token?: string }).access_token ?? "");
      const probe = await fetch(`${tenant.baseUrl}/beta/workflows`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": `huntaway-isc-mcp/${version}` }, signal: AbortSignal.timeout(30_000) });
      if (probe.ok) {
        tree.setStatus(key, true, "connected, user context");
        void vscode.window.showInformationMessage(`${key}: authenticated with user context (workflows reachable). Ask Copilot Chat in Agent mode, e.g. "list the workflows on ${key}".`);
      } else {
        tree.setStatus(key, false, `connected, no user context (HTTP ${probe.status})`);
        void vscode.window.showWarningMessage(
          `${key}: authenticated, but workflows returned HTTP ${probe.status}. An API client has no user context; use a Personal Access Token for workflows, forms and launchers.`,
          { modal: true },
        );
      }
    });
  });
}

export function deactivate(): void {}
