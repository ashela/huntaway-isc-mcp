// The localhost endpoint through the BUILT server, as the extension starts
// it: tenants and the token's hash in the environment, a port of 0, the
// port read back from the first line on stdout. Against the same kind of
// fake ISC API as server.test.ts. Proves the gate in front of the MCP layer
// (path, Host, Origin, bearer) and that a session works end to end.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HTTP_PORT_ENV, HTTP_TOKEN_SHA256_ENV, TENANTS_ENV, parseHttpPort } from "../src/shared/config.js";
import { allowedHosts, bearerMatches } from "../src/server/http.js";
import { endpointUrl, huntawayInstructions, mintToken, sha256Hex } from "../src/shared/token.js";

const SERVER = join(process.cwd(), "dist", "server.js");
const TOKEN = "test-token-not-a-secret-0123456789";

let api: Server;
let child: ChildProcess;
let port = 0;
let stderr = "";

beforeAll(async () => {
  api = createServer((req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/oauth/token") return send(200, { access_token: "tok", expires_in: 3600 });
    if (req.url === "/beta/workflows") return send(200, []);
    return send(404, {});
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiPort = (api.address() as { port: number }).port;
  const tenants = [{ key: "dev", label: "Build", baseUrl: `http://127.0.0.1:${apiPort}`, clientId: "id", clientSecret: "shh", isDefault: true }];
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, [TENANTS_ENV]: JSON.stringify(tenants), [HTTP_PORT_ENV]: "0", [HTTP_TOKEN_SHA256_ENV]: sha256Hex(TOKEN) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += String(c)));
  port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    child.stdout!.on("data", (c) => {
      buffer += String(c);
      const nl = buffer.indexOf("\n");
      if (nl >= 0) resolve((JSON.parse(buffer.slice(0, nl)) as { listening: number }).listening);
    });
    child.once("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});

/** A raw request, so Host and Origin can be set to what an attacker would send. */
function raw(headers: Record<string, string>, path = "/mcp"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
  });
}

describe("the localhost endpoint", () => {
  it("refuses without the token, with a wrong one, from another host, from a browser, and off its path", async () => {
    const host = `127.0.0.1:${port}`;
    expect(await raw({ host })).toBe(401);
    expect(await raw({ host, authorization: "Bearer wrong" })).toBe(401);
    expect(await raw({ host, authorization: `Basic ${TOKEN}` })).toBe(401);
    expect(await raw({ host: `attacker.example:${port}`, authorization: `Bearer ${TOKEN}` })).toBe(403);
    expect(await raw({ host, authorization: `Bearer ${TOKEN}`, origin: "https://attacker.example" })).toBe(403);
    expect(await raw({ host, authorization: `Bearer ${TOKEN}` }, "/other")).toBe(404);
    expect(await raw({ host, authorization: `Bearer ${TOKEN}` })).toBe(200);
  });

  it("serves the tools to a client holding the token, never the tenant's secret", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpointUrl(port)), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("isc_dataflow");
    expect(client.getInstructions()).toContain("Configured tenants: dev");
    const out = await client.callTool({ name: "isc_tenants", arguments: {} });
    const text = (out.content as { text: string }[])[0].text;
    expect(JSON.parse(text).tenants[0]).toMatchObject({ tenant: "dev", auth: "ok" });
    expect(text).not.toContain("shh");
    await client.close();
  });

  it("is not reachable on any address but loopback", () => {
    // Bound to 127.0.0.1 by construction; the Host list says the same.
    expect(allowedHosts(port)).toEqual([`127.0.0.1:${port}`, `localhost:${port}`]);
  });
});

describe("the token", () => {
  it("is matched by hash, exactly", () => {
    const hash = sha256Hex(TOKEN);
    expect(bearerMatches(`Bearer ${TOKEN}`, hash)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, hash)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, hash)).toBe(false);
    expect(bearerMatches(undefined, hash)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}`, "not-a-hash")).toBe(false);
  });

  it("is minted fresh, 256 bits, URL-safe, and handed over with the address", () => {
    const a = mintToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintToken()).not.toBe(a);
    const text = huntawayInstructions(37615, a);
    expect(text).toContain("Address: http://127.0.0.1:37615/mcp");
    expect(text).toContain(`Header value: Bearer ${a}`);
  });

  it("reads the port from the environment, or stdio when unset", () => {
    expect(parseHttpPort(undefined)).toBeNull();
    expect(parseHttpPort("")).toBeNull();
    expect(parseHttpPort("0")).toBe(0);
    expect(parseHttpPort("37615")).toBe(37615);
    expect(() => parseHttpPort("http")).toThrow();
  });
});
