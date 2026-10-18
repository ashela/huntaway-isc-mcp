// The MCP server definition provider. provideMcpServerDefinitions is called
// eagerly and must not prompt, so it hands back the server with only the
// non-secret configuration. resolveMcpServerDefinition runs when the editor
// is about to start the process: that is where the credentials are read from
// SecretStorage and placed in the child process's environment, and nowhere
// else.

import * as vscode from "vscode";
import * as path from "node:path";
import { STEP_CAP_ENV, TENANTS_ENV } from "./shared/config.js";
import type { TenantStore } from "./tenants.js";

export const PROVIDER_ID = "huntaway-isc.servers";
export const SERVER_LABEL = "Huntaway SailPoint ISC";

export class HuntawayIscProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.changed.event;

  constructor(
    private readonly store: TenantStore,
    private readonly serverScript: string,
    private readonly extensionVersion: string,
  ) {
    store.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("huntaway-isc")) this.changed.fire();
    });
  }

  provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
    if (!this.store.list().length) return [];
    return [this.definition({})];
  }

  async resolveMcpServerDefinition(server: vscode.McpStdioServerDefinition): Promise<vscode.McpStdioServerDefinition> {
    const tenants = await this.store.runtime();
    server.env = { ...server.env, [TENANTS_ENV]: JSON.stringify(tenants) };
    return server;
  }

  private definition(env: Record<string, string>): vscode.McpStdioServerDefinition {
    const stepCap = vscode.workspace.getConfiguration("huntaway-isc").get<number>("workflowStepCap", 50);
    const def = new vscode.McpStdioServerDefinition(
      SERVER_LABEL,
      process.execPath,
      [this.serverScript],
      {
        // process.execPath is the editor binary; this makes it behave as Node.
        ELECTRON_RUN_AS_NODE: "1",
        [STEP_CAP_ENV]: String(stepCap),
        ...env,
      },
      `${this.extensionVersion}-${this.store.version()}-${stepCap}`,
    );
    def.cwd = vscode.Uri.file(path.dirname(this.serverScript));
    return def;
  }
}
