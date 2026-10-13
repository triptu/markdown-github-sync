import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir("dist/native-configuration", { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/configuration-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  define: { EXPECTED_PRODUCTION_SHA: JSON.stringify(createHash("sha256")
    .update(await readFile("dist/github-vault-sync/main.js")).digest("hex")) },
  outfile: "dist/native-configuration/main.js",
});
await writeFile("dist/native-configuration/manifest.json", JSON.stringify({
  id: "git-sync-native-configuration",
  name: "Git Sync Native Configuration Acceptance",
  version: "0.0.1",
  minAppVersion: "1.11.4",
  description: "Disposable private lab vault and native Android configuration verification only",
  author: "Vault Sync",
  isDesktopOnly: false,
}));
