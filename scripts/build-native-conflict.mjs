import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir("dist/native-conflict", { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/conflict-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  outfile: "dist/native-conflict/main.js",
});
await writeFile("dist/native-conflict/manifest.json", JSON.stringify({
  id: "git-sync-native-conflict",
  name: "Git Sync Native Conflict Acceptance",
  version: "0.0.1",
  minAppVersion: "1.11.4",
  description: "Disposable lab vault and private lab branch only",
  author: "Vault Sync",
  isDesktopOnly: false,
}));
