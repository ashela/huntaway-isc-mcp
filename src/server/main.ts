// Entry point of the MCP server process. VS Code spawns it with its own
// Node.js (process.execPath from the extension host) and the tenant list in
// one environment variable, which is read once and then removed from the
// process environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HTTP_PORT_ENV, HTTP_TOKEN_SHA256_ENV, STEP_CAP_ENV, TENANTS_ENV, parseHttpPort, parseStepCap, parseTenantsEnv } from "../shared/config.js";
import { serveHttp } from "./http.js";
import { IscClient } from "./isc.js";
import { registerTools } from "./tools.js";

declare const __HUNTAWAY_VERSION__: string;
const VERSION = typeof __HUNTAWAY_VERSION__ === "string" ? __HUNTAWAY_VERSION__ : "0.0.0";

export function instructions(tenantKeys: string[], defaultKey: string | null): string {
  const list = tenantKeys.length ? tenantKeys.join(", ") : "(none configured yet: add one in the Huntaway ISC view)";
  return (
    "SailPoint Identity Security Cloud, through Huntaway. Every tool takes `tenant` and echoes back which tenant " +
    `answered; never assume, read it. Configured tenants: ${list}. Default: ${defaultKey ?? "none set"}.\n\n` +
    "Prefer the specific tools over isc_request: they compute diagnostics that are easy to get wrong by hand " +
    "(workflow step count against the licence cap, per-step OAuth bind state, unreachable steps, form-instance " +
    "formErrors, and launcher gate wiring; launcher visibility is an entitlement, never an admin user level).\n\n" +
    "Writes are never routine. isc_request with any method other than GET, and the create/cancel hosted " +
    "access-request tools, require confirm=true, which you set only after the user has agreed to that specific change. " +
    "Three operations are destructive: aggregating an authoritative delimited-file source with an incomplete file " +
    "(it terminates every identity missing from the file); writing param_oauth/refID on a workflow http step " +
    "(OAuth binding is builder-only, an API write leaves an unbound shell); a full PUT of a source (masked passwords " +
    "are written back as literal asterisks)."
  );
}

export async function main(): Promise<void> {
  const tenants = parseTenantsEnv(process.env[TENANTS_ENV]);
  const stepCap = parseStepCap(process.env[STEP_CAP_ENV]);
  const httpPort = parseHttpPort(process.env[HTTP_PORT_ENV]);
  const tokenSha256 = (process.env[HTTP_TOKEN_SHA256_ENV] ?? "").trim().toLowerCase();
  delete process.env[TENANTS_ENV];
  delete process.env[HTTP_TOKEN_SHA256_ENV];

  // One API client for the process, so a tenant's token is fetched once
  // whichever session asks first.
  const isc = new IscClient(tenants, `huntaway-isc-mcp/${VERSION}`);
  const def = tenants.find((t) => t.isDefault)?.key ?? (tenants.length === 1 ? tenants[0].key : null);
  const makeServer = () => {
    const server = new McpServer(
      { name: "huntaway-isc", version: VERSION },
      { instructions: instructions(tenants.map((t) => t.key), def) },
    );
    // The operator's calendar day is this machine's: the server runs where the person sits.
    registerTools(server, isc, { stepCap, todayOffsetHours: -new Date().getTimezoneOffset() / 60 });
    return server;
  };

  if (httpPort !== null) {
    // The localhost endpoint (src/server/http.ts). Without a token hash it
    // does not start: an endpoint nobody can authenticate to is a mistake.
    if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error(`${HTTP_PORT_ENV} is set but ${HTTP_TOKEN_SHA256_ENV} is not a SHA-256`);
    const http = await serveHttp({ port: httpPort, tokenSha256, makeServer });
    const address = http.address();
    // The one line the extension waits for. stdout is free in this mode.
    process.stdout.write(JSON.stringify({ listening: typeof address === "object" && address ? address.port : httpPort }) + "\n");
    return;
  }
  await makeServer().connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`huntaway-isc-mcp failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
