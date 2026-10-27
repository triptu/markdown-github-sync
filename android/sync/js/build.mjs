// Bundles the plugin's sync engine (plugin/src/git-sync) with the Android
// host API into one script for QuickJS. Uses the plugin's own esbuild and
// dependencies, so run `npm run setup` in the repository root first.
// Usage: node android/sync/js/build.mjs <outfile>
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, "../../../plugin");
const outfile = resolve(process.argv[2] ?? join(here, "../build/generated/syncEngine/sync-engine.js"));
let esbuild;
try {
  esbuild = createRequire(join(plugin, "package.json"))("esbuild");
} catch {
  console.error("esbuild is missing. Run `npm run setup` in the repository root.");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [join(here, "entry.ts")],
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  // QuickJS supports ES2023 natively, including private class fields.
  target: "es2022",
  outfile,
  legalComments: "none",
  logLevel: "warning",
});
console.log(`sync engine bundle: ${outfile}`);
