// The optional localhost endpoint: the same tools over Streamable HTTP, so a
// client on this computer that is not the editor (the Huntaway desktop app)
// can use the tenants configured here without ever holding their
// credentials. The extension starts this mode on its own, only when the
// person switched it on and minted a token (Huntaway ISC: Connect Huntaway).
//
// What a request must carry, checked in this order, before the MCP layer
// sees a byte of it:
//   - the path /mcp;
//   - a Host header naming this loopback port (a DNS-rebinding page arrives
//     with its own host name);
//   - no Origin header at all (a browser always sends one on a cross-site
//     POST; a desktop client's main process never does);
//   - Authorization: Bearer <token>, compared by SHA-256 in constant time.
//     This process is handed the token's hash, never the token.
// The socket is bound to 127.0.0.1 only, so nothing off this computer can
// reach it whatever the firewall says.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { sha256Hex } from "../shared/token.js";

export { sha256Hex };

export const HTTP_PATH = "/mcp";
/** A request body larger than this is refused before it is parsed. */
export const BODY_MAX_BYTES = 1024 * 1024;
/** Sessions held at once. The oldest idle one is closed to admit a new one:
 *  a client that never says goodbye cannot grow this process without bound. */
export const SESSION_MAX = 8;

export interface HttpOptions {
  port: number;
  /** Hex SHA-256 of the bearer token. */
  tokenSha256: string;
  /** A fresh server for each session, sharing whatever the caller shares. */
  makeServer: () => McpServer;
  /** Defaults to 127.0.0.1. Tests may not pass anything else. */
  host?: "127.0.0.1";
}

/** Whether a presented Authorization header carries the token. */
export function bearerMatches(header: string | undefined, tokenSha256: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!match || !/^[0-9a-f]{64}$/.test(tokenSha256)) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(match[1]), "hex"), Buffer.from(tokenSha256, "hex"));
}

/** The Host values a request to this endpoint may carry. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
}

function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Starts the endpoint. Resolves with the server once it is listening. */
export async function serveHttp(options: HttpOptions): Promise<Server> {
  const { port, tokenSha256, makeServer } = options;
  // Filled once listening: with port 0 the real port is known only then.
  let hosts = new Set<string>();
  const sessions = new Map<string, Session>();

  const evictIfFull = async () => {
    if (sessions.size < SESSION_MAX) return;
    let oldest: [string, Session] | undefined;
    for (const entry of sessions) if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
    if (!oldest) return;
    sessions.delete(oldest[0]);
    await oldest[1].transport.close().catch(() => undefined);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== HTTP_PATH) return refuse(res, 404, "not found");
    if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) return refuse(res, 403, "this endpoint answers only on 127.0.0.1");
    if (req.headers.origin !== undefined) return refuse(res, 403, "browser requests are not accepted");
    if (!bearerMatches(req.headers.authorization, tokenSha256)) {
      return refuse(res, 401, "a valid bearer token is required: run Huntaway ISC: Connect Huntaway in VS Code", { "WWW-Authenticate": "Bearer" });
    }

    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (error) {
        return refuse(res, error instanceof Error && error.message === "too large" ? 413 : 400, error instanceof Error ? error.message : "bad body");
      }
    }

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return refuse(res, 404, "unknown session: initialize again");
      session.lastUsed = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) return refuse(res, 400, "initialize first");

    await evictIfFull();
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // One JSON answer per POST: the tools here never stream, and a
      // plain answer is what the simplest client can read.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastUsed: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((error) => {
      process.stderr.write(`huntaway-isc-mcp http: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) refuse(res, 500, "internal error");
      else res.end();
    });
  });
  http.on("close", () => {
    for (const session of sessions.values()) void session.transport.close().catch(() => undefined);
    sessions.clear();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, options.host ?? "127.0.0.1", () => {
      http.off("error", reject);
      const address = http.address();
      hosts = new Set(allowedHosts(typeof address === "object" && address ? address.port : port));
      resolve();
    });
  });
  return http;
}
