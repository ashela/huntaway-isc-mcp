#!/usr/bin/env node
// Build, gate the sources, package with vsce, then unzip the .vsix and gate
// its contents too. The .vsix is public and unzippable, so what is scanned
// is exactly what ships. Writes out/<name>-<version>.vsix.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const OUT = join(ROOT, "out");
const vsix = join(OUT, `${pkg.name}-${pkg.version}.vsix`);
const unpacked = join(OUT, "unpacked");

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

run("node", ["esbuild.mjs"]);
run("node", ["scripts/leak-gate.mjs"]);
run("npx", ["vsce", "package", "--no-dependencies", "--out", vsix]);

if (!existsSync(vsix)) {
  console.error(`package: ${vsix} was not produced`);
  process.exit(1);
}
new AdmZip(vsix).extractAllTo(unpacked, true);
run("node", ["scripts/leak-gate.mjs", "--unpacked", unpacked]);
rmSync(unpacked, { recursive: true, force: true });
console.log(`package: ${vsix} built and gated.`);
