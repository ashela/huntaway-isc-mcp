// Two bundles: the extension (runs in the extension host, `vscode` external)
// and the server (a self-contained script the editor runs with its own
// Node.js). Both are CommonJS so they load from the packaged .vsix with no
// node_modules beside them.
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  minify: !watch,
  logLevel: "info",
  define: { __HUNTAWAY_VERSION__: JSON.stringify(pkg.version) },
};

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  { ...common, entryPoints: ["src/server/main.ts"], outfile: "dist/server.js" },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
