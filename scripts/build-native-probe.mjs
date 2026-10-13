import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../plugin/package.json", import.meta.url),
);
const { build } = require("esbuild");
await mkdir("dist/native-probe", { recursive: true });
await build({
  entryPoints: ["plugin/test/native/probe.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  outfile: "dist/native-probe/main.js",
});
await writeFile(
  "dist/native-probe/manifest.json",
  JSON.stringify({
    id: "git-sync-native-probe",
    name: "Git Sync Native Probe",
    version: "0.0.1",
    minAppVersion: "1.11.4",
    description: "Synthetic-vault native verification only",
    author: "Vault Sync",
    isDesktopOnly: false,
  }),
);
