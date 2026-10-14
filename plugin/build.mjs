import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("../dist/github-vault-sync", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  outfile: "../dist/github-vault-sync/main.js",
  logLevel: "info",
});
await copyFile("manifest.json", "../dist/github-vault-sync/manifest.json");

await copyFile("styles.css", "../dist/github-vault-sync/styles.css");

// The updater is its own small plugin so a broken sync build can't block the fix.
await mkdir("../dist/github-vault-sync-updater", { recursive: true });
await build({
  entryPoints: ["updater/main.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  outfile: "../dist/github-vault-sync-updater/main.js",
  logLevel: "info",
});
await copyFile("updater/manifest.json", "../dist/github-vault-sync-updater/manifest.json");
