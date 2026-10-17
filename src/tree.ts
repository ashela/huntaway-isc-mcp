// The Huntaway ISC view: one row per tenant, with the context-menu commands
// that manage it. Credentials are shown only as present or missing.

import * as vscode from "vscode";
import { hostOf, type TenantRecord } from "./shared/config.js";
import type { TenantStore } from "./tenants.js";

export class TenantItem extends vscode.TreeItem {
  constructor(readonly tenant: TenantRecord, hasCredentials: boolean) {
    super(tenant.label, vscode.TreeItemCollapsibleState.None);
    this.id = tenant.key;
    this.description = `${tenant.key}${tenant.isDefault ? " (default)" : ""}`;
    this.tooltip = [
      `${tenant.label} [${tenant.key}]`,
      hostOf(tenant.baseUrl),
      tenant.purpose ?? "",
      hasCredentials ? "Credentials: set" : "Credentials: not set",
      tenant.maskTokens?.length ? `Masked tokens: ${tenant.maskTokens.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    this.contextValue = hasCredentials ? "tenant" : "tenant-no-credentials";
    this.iconPath = new vscode.ThemeIcon(hasCredentials ? "cloud" : "warning");
  }
}

export class TenantTree implements vscode.TreeDataProvider<TenantItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: TenantStore) {
    store.onDidChange(() => this.changed.fire());
  }

  getTreeItem(element: TenantItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<TenantItem[]> {
    const items: TenantItem[] = [];
    for (const t of this.store.list()) items.push(new TenantItem(t, await this.store.hasCredentials(t.key)));
    return items.sort((a, b) => a.tenant.label.localeCompare(b.tenant.label));
  }
}
