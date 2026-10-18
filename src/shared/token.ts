// The localhost endpoint's bearer token is never stored or handed on, only
// its hash: the extension keeps the hash in SecretStorage, the server
// compares against it. Shared here so the extension bundle does not pull in
// the server's MCP SDK for one function.

import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A new bearer token: 32 random bytes, URL-safe. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function endpointUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** What Huntaway's Settings, then Tools, needs: a web address and one header. */
export function huntawayInstructions(port: number, token: string): string {
  return [
    "In Huntaway: Settings, then Tools, then Add a tool server.",
    "Name: Huntaway SailPoint ISC",
    "Kind: Web address",
    `Address: ${endpointUrl(port)}`,
    "Header name: Authorization",
    `Header value: Bearer ${token}`,
  ].join("\n");
}
