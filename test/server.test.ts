// Round trip through the BUILT server over stdio, exactly as the editor runs
// it, against a fake ISC API on localhost. Proves the wiring: tenants from
// the environment, token exchange, the envelope, annotations, and the
// confirm gate on writes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TENANTS_ENV } from "../src/shared/config.js";

const SERVER = join(process.cwd(), "dist", "server.js");

interface Seen {
  method: string;
  path: string;
  auth?: string;
}

let api: Server;
let port = 0;
const seen: Seen[] = [];
let client: Client;
let transport: StdioClientTransport;

const WORKFLOW = {
  id: "wf1",
  name: "Onboard",
  enabled: true,
  trigger: { type: "EVENT" },
  definition: { start: "a", steps: { a: { actionId: "sp:http", attributes: {}, nextStep: "b" }, b: { actionId: "sp:choice" } } },
};

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? "";
      if (url === "/oauth/token") {
        return body.includes("client_secret=good") ? send(200, { access_token: "tok", expires_in: 3600 }) : send(401, { error: "bad" });
      }
      if (req.headers.authorization !== "Bearer tok") return send(401, { error: "no token" });
      if (url === "/beta/workflows") return send(200, [WORKFLOW]);
      if (url === "/beta/workflows/wf1") return send(200, WORKFLOW);
      if (url.startsWith("/v2025/launchers")) return send(403, { message: "no user context" });
      if (url.startsWith("/v2025/form-definitions")) return send(200, { results: [] });
      if (url.startsWith("/beta/work-items")) return send(200, []);
      if (url.startsWith("/v2025/search")) return send(200, [{ id: "i1", name: "Ada", attributes: { uid: "ada" } }]);
      if (url === "/v2025/echo" && req.method === "PATCH") return send(200, { patched: JSON.parse(body) });
      return send(404, { path: url });
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  port = (api.address() as { port: number }).port;

  const tenants = [
    { key: "dev", label: "Build", baseUrl: `http://127.0.0.1:${port}`, purpose: "test double", clientId: "id", clientSecret: "good", isDefault: true },
    { key: "broken", label: "No creds", baseUrl: `http://127.0.0.1:${port}`, clientId: "", clientSecret: "" },
  ];
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, [TENANTS_ENV]: JSON.stringify(tenants), HUNTAWAY_ISC_STEP_CAP: "1" } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});

const text = (res: unknown) => JSON.parse(((res as { content: { text: string }[] }).content)[0].text) as Record<string, unknown>;

describe("the built server over stdio", () => {
  it("lists the eleven tools with the right annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "isc_access_requests", "isc_accounts", "isc_compare_tenants", "isc_form_instances", "isc_identity", "isc_launchers",
      "isc_request", "isc_search", "isc_tenants", "isc_workflow", "isc_workflow_executions",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.isc_search?.readOnlyHint).toBe(true);
    expect(byName.isc_compare_tenants?.readOnlyHint).toBe(true);
    expect(byName.isc_request?.readOnlyHint).toBe(false);
    expect(byName.isc_request?.destructiveHint).toBe(true);
    expect(byName.isc_access_requests?.readOnlyHint).toBe(false);
  });

  it("carries the tenant list in its instructions, never a secret", async () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Configured tenants: dev, broken");
    expect(instructions).not.toContain("good");
  });

  it("measures each tenant: auth, user-context reach, and a missing credential", async () => {
    const out = text(await client.callTool({ name: "isc_tenants", arguments: {} }));
    const rows = out.tenants as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ tenant: "dev", auth: "ok", is_default: true, purpose: "test double", has_full_user_context: false });
    expect((rows[0].user_context_reach as Record<string, number>).launchers).toBe(403);
    expect(String(rows[0].warning)).toMatch(/Denied on launchers/);
    expect(rows[1]).toMatchObject({ tenant: "broken", auth: "unavailable" });
    expect(String(rows[1].detail)).toMatch(/no credentials/);
    expect(JSON.stringify(out)).not.toContain("good");
  });

  it("stamps every response with the tenant that answered", async () => {
    const out = text(await client.callTool({ name: "isc_search", arguments: { query: "name:Ada", fields: ["name", "uid"] } }));
    expect(out).toMatchObject({ tenant: "dev", tenant_label: "Build", host: `127.0.0.1:${port}`, ok: true, count: 1 });
    expect(out.results).toEqual([{ name: "Ada", uid: "ada" }]);
  });

  it("applies the step cap from the environment to workflow diagnostics", async () => {
    const out = text(await client.callTool({ name: "isc_workflow", arguments: { name: "onboard" } }));
    const wf = out.workflow as Record<string, unknown>;
    expect(wf).toMatchObject({ id: "wf1", step_count: 2, step_cap: 1, over_cap: true, unbound_http_steps: ["a"] });
    expect(String(wf.WARNING)).toMatch(/ONE-WAY DOOR/);
  });

  it("refuses a write without confirm=true and performs it with", async () => {
    const refused = text(await client.callTool({ name: "isc_request", arguments: { path: "/v2025/echo", method: "PATCH", body: [{ op: "add" }] } }));
    expect(refused.ok).toBe(false);
    expect(String(refused.refused)).toMatch(/confirm=true/);
    expect(seen.some((s) => s.method === "PATCH")).toBe(false);

    const done = text(await client.callTool({ name: "isc_request", arguments: { path: "/v2025/echo", method: "PATCH", body: [{ op: "add" }], json_patch: true, confirm: true } }));
    expect(done).toMatchObject({ ok: true, status: 200, method: "PATCH" });
    expect(seen.some((s) => s.method === "PATCH" && s.path === "/v2025/echo")).toBe(true);
  });

  it("names the tenant on an unknown key and on a missing credential", async () => {
    const unknown = await client.callTool({ name: "isc_search", arguments: { query: "x", tenant: "nope" } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown).error).toMatch(/unknown tenant "nope"/);
    const broken = await client.callTool({ name: "isc_search", arguments: { query: "x", tenant: "broken" } });
    expect(text(broken).error).toMatch(/has no credentials/);
  });
});
