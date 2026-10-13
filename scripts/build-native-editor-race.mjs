import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expectedProductionSha = "2a1f0ecb9679e8bf4e7cd5c635f69d1f773e29af3a4e9cb6c7e9abf0c82bb93f";
const expectedNativeSources = {
  "plugin/src/git-sync/obsidian-vault.ts": "4ebf6eb10419ee3993142abbf030d55bec689368755903f308853dc216465622",
  "plugin/src/git-sync/native-transactions.ts": "b139c9ba955c901a9f5422d2c6272f5708016ed5709785415943a3bcc3d1645f",
};
const sha256 = data => createHash("sha256").update(data).digest("hex");
if (sha256(await readFile("dist/github-vault-sync/main.js")) !== expectedProductionSha)
  throw new Error("Production bundle SHA differs from the requested acceptance target");
for (const [path, expected] of Object.entries(expectedNativeSources))
  if (sha256(await readFile(path)) !== expected) throw new Error(`Native source changed: ${path}`);

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir("dist/native-editor-race-r2", { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/editor-race-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  define: { EXPECTED_PRODUCTION_SHA: JSON.stringify(expectedProductionSha) },
  outfile: "dist/native-editor-race-r2/main.js",
});
await writeFile("dist/native-editor-race-r2/manifest.json", JSON.stringify({
  id: "git-sync-native-editor-race-r2",
  name: "Git Sync Native Editor Race Acceptance R2",
  version: "0.0.2",
  minAppVersion: "1.11.4",
  description: "Disposable acceptance helper for the named synthetic Android vault",
  author: "Vault Sync",
  isDesktopOnly: false,
}));
