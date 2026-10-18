// The Huntaway view: one row per tenant, which opens into the tenant's
// object types, which open into the objects themselves. Clicking an object
// opens its JSON read-only in an editor. Credentials are shown only as
// present or missing; the last Test Connection result stays on the row.

import * as vscode from "vscode";
import { hostOf, type TenantRecord } from "./shared/config.js";
import type { TenantStore } from "./tenants.js";
import type { IscClient } from "./server/isc.js";
import { BrowseError, CATEGORIES, listCategory, nameOf, summarise, type Category } from "./browser.js";

/** The outcome of the last Test Connection this session, shown on the row
 *  so it does not vanish with a toast. */
export interface TenantStatus {
  ok: boolean;
  text: string;
  at: Date;
}

export class TenantItem extends vscode.TreeItem {
  constructor(readonly tenant: TenantRecord, readonly hasCredentials: boolean, status?: TenantStatus) {
    super(tenant.label, hasCredentials ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `tenant:${tenant.key}`;
    const state = !hasCredentials ? "no credentials" : status ? status.text : "";
    this.description = [`${tenant.key}${tenant.isDefault ? " (default)" : ""}`, state].filter(Boolean).join(": ");
    this.tooltip = [
      `${tenant.label} [${tenant.key}]`,
      hostOf(tenant.baseUrl),
      tenant.purpose ?? "",
      hasCredentials ? "Credentials: set" : "Credentials: not set",
      status ? `Last test (${status.at.toLocaleTimeString()}): ${status.text}` : "Not tested yet. Use Test Connection.",
      tenant.maskTokens?.length ? `Masked tokens: ${tenant.maskTokens.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    this.contextValue = hasCredentials ? "tenant" : "tenant-no-credentials";
    this.iconPath = !hasCredentials
      ? new vscode.ThemeIcon("warning")
      : status
        ? new vscode.ThemeIcon(status.ok ? "pass" : "error", new vscode.ThemeColor(status.ok ? "testing.iconPassed" : "testing.iconFailed"))
        : new vscode.ThemeIcon("cloud");
  }
}

export class CategoryItem extends vscode.TreeItem {
  constructor(readonly tenant: TenantRecord, readonly category: Category, count?: number, error?: string) {
    super(category.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `category:${tenant.key}:${category.id}`;
    this.description = error ? error : count === undefined ? "" : String(count);
    this.iconPath = new vscode.ThemeIcon(error ? "error" : category.icon);
    this.contextValue = "category";
    this.tooltip = error ? `${category.label}: ${error}` : `${category.label} on ${tenant.label}`;
  }
}

export class ObjectItem extends vscode.TreeItem {
  constructor(readonly tenant: TenantRecord, readonly category: Category, readonly object: Record<string, unknown>) {
    super(nameOf(object), vscode.TreeItemCollapsibleState.None);
    this.id = `object:${tenant.key}:${category.id}:${String(object.id ?? object.name)}`;
    this.description = summarise(category, object);
    this.tooltip = [nameOf(object), typeof object.id === "string" ? `id ${object.id}` : "", typeof object.description === "string" ? object.description : ""]
      .filter(Boolean).join("\n");
    this.contextValue = "object";
    this.command = { command: "huntaway-isc.openObject", title: "Open JSON", arguments: [this] };
  }
}

export type Node = TenantItem | CategoryItem | ObjectItem;

export class TenantTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly status = new Map<string, TenantStatus>();
  /** Listings fetched this session, until Refresh. Keyed tenant:category. */
  private readonly listings = new Map<string, Record<string, unknown>[]>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly store: TenantStore,
    private readonly client: (key: string) => Promise<IscClient>,
  ) {
    store.onDidChange(() => this.refresh());
  }

  setStatus(key: string, ok: boolean, text: string): void {
    this.status.set(key, { ok, text, at: new Date() });
    this.changed.fire(undefined);
  }

  /** Drop fetched listings; the next expand reads the tenant again. */
  refresh(node?: Node): void {
    if (node instanceof CategoryItem) {
      this.listings.delete(`${node.tenant.key}:${node.category.id}`);
      this.errors.delete(`${node.tenant.key}:${node.category.id}`);
    } else {
      this.listings.clear();
      this.errors.clear();
    }
    this.changed.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      const items: TenantItem[] = [];
      for (const t of this.store.list()) items.push(new TenantItem(t, await this.store.hasCredentials(t.key), this.status.get(t.key)));
      return items.sort((a, b) => a.tenant.label.localeCompare(b.tenant.label));
    }
    if (element instanceof TenantItem) {
      return CATEGORIES.map((c) => {
        const k = `${element.tenant.key}:${c.id}`;
        return new CategoryItem(element.tenant, c, this.listings.get(k)?.length, this.errors.get(k));
      });
    }
    if (element instanceof CategoryItem) {
      const k = `${element.tenant.key}:${element.category.id}`;
      let list = this.listings.get(k);
      if (!list) {
        try {
          list = await listCategory(await this.client(element.tenant.key), element.tenant.key, element.category);
          this.listings.set(k, list);
          this.errors.delete(k);
        } catch (error) {
          const text = error instanceof BrowseError || error instanceof Error ? error.message : String(error);
          this.errors.set(k, text);
          list = [];
        }
        // Re-render the category row with its count or error, once this
        // request has returned.
        setTimeout(() => this.changed.fire(element), 0);
      }
      return list.map((o) => new ObjectItem(element.tenant, element.category, o));
    }
    return [];
  }
}
