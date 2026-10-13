import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("../dist/cloud-vault-sync", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  outfile: "../dist/cloud-vault-sync/main.js",
  logLevel: "info",
});
await copyFile("manifest.json", "../dist/cloud-vault-sync/manifest.json");
