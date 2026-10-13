import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expectedProductionSha = "2a1f0ecb9679e8bf4e7cd5c635f69d1f773e29af3a4e9cb6c7e9abf0c82bb93f";
const expectedNativeSources = {
  "plugin/src/git-sync/obsidian-vault.ts": "4ebf6eb10419ee3993142abbf030d55bec689368755903f308853dc216465622",
  "plugin/src/git-sync/native-transactions.ts": "b139c9ba955c901a9f5422d2c6272f5708016ed5709785415943a3bcc3d1645f",
  "plugin/src/git-sync/store.ts": "86b72a3bfdbc610fa554d6eef89de74f1a1838c5c2842df8565ba0b77b224ea1",
};
const sha256 = data => createHash("sha256").update(data).digest("hex");
const bundledNativeSources = {};
for (const [path, expected] of Object.entries(expectedNativeSources))
  if ((bundledNativeSources[path] = sha256(await readFile(path))) !== expected)
    throw new Error(`Native source changed: ${path}`);

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir("dist/native-editor-race-r3", { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/editor-race-retention-r3.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  define: {
    INSTALLED_PRODUCTION_SHA: JSON.stringify(expectedProductionSha),
    BUNDLED_NATIVE_SOURCE_HASHES: JSON.stringify(bundledNativeSources),
  },
  outfile: "dist/native-editor-race-r3/main.js",
});
await writeFile("dist/native-editor-race-r3/manifest.json", JSON.stringify({
  id: "git-sync-native-editor-race-r3",
  name: "Git Sync Native Editor Race Retention R3",
  version: "0.0.3",
  minAppVersion: "1.11.4",
  description: "Disposable acceptance helper for the named synthetic Android vault",
  author: "Vault Sync",
  isDesktopOnly: false,
}));
await writeFile("dist/native-editor-race-r3/build-metadata.json", JSON.stringify({
  installedProductionExpectedSha256: expectedProductionSha,
  bundledNativeSources,
  bundleSha256: sha256(await readFile("dist/native-editor-race-r3/main.js")),
}, null, 2));
