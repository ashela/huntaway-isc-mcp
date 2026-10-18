// The optional localhost endpoint, from the extension's side: the token the
// person hands to Huntaway, and the server process that listens for it.
//
// The editor starts its own copy of the server over stdio for Copilot Chat
// and keeps that copy's pipes to itself, so another program cannot share it.
// This starts a sibling: the same script, the same tenants and credentials
// from SecretStorage, listening on 127.0.0.1 (src/server/http.ts). Huntaway
// then holds one bearer token that reaches this endpoint and nothing else,
// never a tenant's client id or secret.
//
// The token is shown ONCE, when it is minted by Huntaway ISC: Connect
// Huntaway. Only its SHA-256 is kept (in SecretStorage) and only the hash is
// handed to the server. Minting a new one replaces the old, which is also
// how a leaked one is revoked; Huntaway ISC: Disconnect Huntaway forgets it
// and stops the endpoint.

import * as vscode from "vscode";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_HTTP_PORT, HTTP_PORT_ENV, HTTP_TOKEN_SHA256_ENV, STEP_CAP_ENV, TENANTS_ENV } from "./shared/config.js";
import { endpointUrl, mintToken, sha256Hex } from "./shared/token.js";

export { endpointUrl, huntawayInstructions, mintToken } from "./shared/token.js";
import type { TenantStore } from "./tenants.js";

const TOKEN_HASH_KEY = "huntaway-isc.httpEndpoint.tokenSha256";
const START_TIMEOUT_MS = 15_000;

/** The port the server says it is listening on: the first line it writes. */
function reportedPort(child: ChildProcess, asked: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the endpoint did not report its port")), START_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolve(Number((JSON.parse(buffer.slice(0, nl)) as { listening: number }).listening));
      } catch {
        reject(new Error("the endpoint wrote something unexpected"));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the endpoint exited (${code}); is port ${asked} in use?`));
    });
  });
}

export class HttpEndpoint implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private port: number | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly store: TenantStore,
    private readonly secrets: vscode.SecretStorage,
    private readonly serverScript: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  private config() {
    const c = vscode.workspace.getConfiguration("huntaway-isc");
    return {
      enabled: c.get<boolean>("httpEndpoint.enabled", false),
      port: c.get<number>("httpEndpoint.port", DEFAULT_HTTP_PORT),
      stepCap: c.get<number>("workflowStepCap", 50),
    };
  }

  /** The port it listens on, when it is running. */
  listening(): number | undefined {
    return this.child ? this.port : undefined;
  }

  /** Mints a token, keeps its hash, and (re)starts the endpoint with it. */
  async mint(): Promise<{ token: string; port: number }> {
    const token = mintToken();
    await this.secrets.store(TOKEN_HASH_KEY, sha256Hex(token));
    await this.restart();
    const port = this.listening();
    if (port === undefined) throw new Error("the endpoint did not start; see the Huntaway ISC output");
    return { token, port };
  }

  /** Forgets the token and stops the endpoint. */
  async forget(): Promise<void> {
    await this.secrets.delete(TOKEN_HASH_KEY);
    this.stop();
  }

  /** Starts, restarts or stops the endpoint to match the settings, the
   *  tenants and the token. Called on activation and on every change. */
  async restart(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    this.stop();
    const { enabled, port, stepCap } = this.config();
    const tokenSha256 = await this.secrets.get(TOKEN_HASH_KEY);
    if (!enabled || !tokenSha256 || !this.store.list().length) return;
    const tenants = await this.store.runtime();
    const child = spawn(process.execPath, [this.serverScript], {
      cwd: path.dirname(this.serverScript),
      env: {
        ...process.env,
        // process.execPath is the editor binary; this makes it behave as Node.
        ELECTRON_RUN_AS_NODE: "1",
        [TENANTS_ENV]: JSON.stringify(tenants),
        [STEP_CAP_ENV]: String(stepCap),
        [HTTP_PORT_ENV]: String(port),
        [HTTP_TOKEN_SHA256_ENV]: tokenSha256,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.log.append(chunk));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
        this.port = undefined;
      }
      this.log.appendLine(`localhost endpoint stopped (${signal ?? code})`);
    });
    let listening: number;
    try {
      listening = await reportedPort(child, port);
    } catch (error) {
      this.log.appendLine(`localhost endpoint: ${error instanceof Error ? error.message : String(error)}`);
      this.stop();
      return;
    }
    if (this.child !== child) return;
    this.port = listening;
    this.log.appendLine(`localhost endpoint listening on ${endpointUrl(listening)}`);
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.port = undefined;
    if (child && child.exitCode === null) child.kill();
  }

  dispose(): void {
    this.stop();
  }
}
