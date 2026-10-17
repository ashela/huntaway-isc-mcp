#!/usr/bin/env node
// The leak gate. Fails when anything that must never ship is found in the
// files it is pointed at: an email address, an object id, a tenant host, a
// credential-looking value, or any term from the private term list.
//
// The term list (client names, tenant hosts, source and workflow ids) is
// deliberately NOT in this public repository. Locally it lives in
// `.leak-gate.local` (gitignored); in CI it is written from the
// LEAK_GATE_TERMS repository secret. A missing list fails the gate, so a
// package can never be built without it.
//
//   node scripts/leak-gate.mjs [paths...]      default: the source tree
//   node scripts/leak-gate.mjs --unpacked DIR  an unzipped .vsix
//
// Term list format: one entry per line; `# comments`; `re:<pattern>` for a
// regular expression (case-insensitive); anything else is matched as a
// case-insensitive whole-word literal.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const TERMS_FILE = join(ROOT, ".leak-gate.local");
const SKIP_DIRS = new Set([".git", "node_modules", "out", ".vscode-test"]);
const BINARY_EXT = new Set([".png", ".ico", ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".ttf", ".vsix", ".zip"]);
const DEFAULT_PATHS = ["src", "test", "scripts", "resources", "README.md", "CHANGELOG.md", "package.json", "esbuild.mjs", ".vscodeignore", ".github", "dist"];

/** Placeholders a README may legitimately use for a tenant host. */
const HOST_PLACEHOLDERS = /^(<[^>]+>|tenant|your-tenant|example|acme|org|mytenant)$/i;

export const BUILTIN_RULES = [
  { name: "email address", rx: /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g },
  // The nil UUID is a sentinel, not an object id; the MCP SDK carries one.
  { name: "uuid", rx: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, allow: (m) => /^[0-]+$/.test(m[0]) },
  { name: "32-hex object id", rx: /(?<![0-9a-zA-Z/+=_-])[0-9a-f]{32}(?![0-9a-zA-Z/+=_-])/g },
  { name: "tenant host", rx: /(?<![\w.-])([a-z0-9<>_-]+)\.(?:api\.)?identitynow(?:-demo)?\.com\b/gi, allow: (m) => HOST_PLACEHOLDERS.test(m[1]) },
  { name: "credential value", rx: /\b(client_?secret|client_?id|access_?token|api_?key|password)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{16,}/gi },
  { name: "private env key", rx: /\bSAILPOINT_[A-Z0-9_]*(?:PAT|CLIENT|BASE_URL|SECRET)[A-Z0-9_]*\b/g },
  { name: "local windows path", rx: /\bC:\\Users\\[^\s"'\\]+/gi },
];

export function loadTerms(file = TERMS_FILE) {
  if (!existsSync(file)) return null;
  const rules = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("re:")) rules.push({ name: `term /${line.slice(3)}/`, rx: new RegExp(line.slice(3), "gi") });
    else rules.push({ name: `term "${line}"`, rx: new RegExp(`(?<![A-Za-z0-9])${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi") });
  }
  return rules;
}

function* walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(join(path, entry));
    }
  } else yield path;
}

function isBinary(path, buf) {
  if (BINARY_EXT.has(extname(path).toLowerCase())) return true;
  return buf.subarray(0, 8000).includes(0);
}

/** A file whose first line carries this marker is a fixture for the
 *  built-in rules (test inputs that must look like leaks). Private terms
 *  are still enforced in it. */
const FIXTURE_MARKER = /^\/\/ leak-gate: fixtures\b/;

export function scanText(text, rules, file = "<text>") {
  const findings = [];
  if (FIXTURE_MARKER.test(text)) rules = rules.filter((r) => r.name.startsWith("term "));
  const lines = text.split("\n");
  for (const rule of rules) {
    rule.rx.lastIndex = 0;
    let m;
    while ((m = rule.rx.exec(text)) !== null) {
      if (rule.allow?.(m)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({ file, line, rule: rule.name, match: m[0].length > 60 ? m[0].slice(0, 60) + "..." : m[0], context: (lines[line - 1] ?? "").trim().slice(0, 120) });
      if (findings.length > 200) return findings;
    }
  }
  return findings;
}

export function scanPaths(paths, rules) {
  const findings = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const file of walk(p)) {
      const buf = readFileSync(file);
      if (isBinary(file, buf)) continue;
      findings.push(...scanText(buf.toString("utf8"), rules, relative(ROOT, file) || file));
    }
  }
  return findings;
}

function main(argv) {
  const args = argv.slice(2);
  const unpackedAt = args.indexOf("--unpacked");
  const paths = unpackedAt >= 0 ? [args[unpackedAt + 1]] : args.filter((a) => !a.startsWith("--"));
  const terms = loadTerms();
  if (terms === null) {
    console.error(`leak gate: ${relative(ROOT, TERMS_FILE)} is missing. Create it locally (one term per line) or set the LEAK_GATE_TERMS secret in CI. The gate refuses to pass without it.`);
    return 2;
  }
  const rules = [...BUILTIN_RULES, ...terms];
  const findings = scanPaths(paths.length ? paths : DEFAULT_PATHS, rules);
  if (!findings.length) {
    console.log(`leak gate: clean (${rules.length} rules, ${terms.length} private terms).`);
    return 0;
  }
  console.error(`leak gate: ${findings.length} finding(s)`);
  for (const f of findings) {
    // Private terms are never echoed: the rule name says which kind of term hit.
    const shown = f.rule.startsWith("term ") ? "[private term]" : f.match;
    console.error(`  ${f.file}:${f.line}  ${f.rule}  ${shown}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv));
}
