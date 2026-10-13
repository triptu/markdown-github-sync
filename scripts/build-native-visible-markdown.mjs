import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const expectedInstalledSha = "a85020d6205f2efbcf777074e47d896f4acafc69e7385744a48d2e2cfa4ecad5";
const productionPath = "dist/github-vault-sync/main.js";
const output = "dist/native-visible-markdown";
const sourcePaths = [
  "plugin/src/git-sync/obsidian-vault.ts",
  "plugin/src/git-sync/native-transactions.ts",
  "plugin/src/git-sync/store.ts",
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const installedProductionSha = sha256(await readFile(productionPath));
if (installedProductionSha !== expectedInstalledSha)
  throw new Error(`Installed production provenance changed: ${installedProductionSha}`);

const bundledNativeSources = Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, sha256(await readFile(path))])));
const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir(output, { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/visible-markdown-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  define: {
    INSTALLED_PRODUCTION_SHA: JSON.stringify(installedProductionSha),
    BUNDLED_NATIVE_SOURCE_HASHES: JSON.stringify(bundledNativeSources),
  },
  outfile: `${output}/main.js`,
});
for (const [path, before] of Object.entries(bundledNativeSources))
  if (sha256(await readFile(path)) !== before) throw new Error(`Native source changed during build: ${path}`);
if (sha256(await readFile(productionPath)) !== installedProductionSha)
  throw new Error("Production bundle changed during helper build");

await writeFile(`${output}/manifest.json`, JSON.stringify({
  id: "git-sync-native-visible-markdown",
  name: "Git Sync Native Visible Markdown Acceptance",
  version: "0.0.1",
  minAppVersion: "1.11.4",
  description: "Disposable visible Markdown acceptance helper for Vault Sync Lab",
  author: "Vault Sync",
  isDesktopOnly: false,
}, null, 2) + "\n");
await writeFile(`${output}/build-metadata.json`, JSON.stringify({
  format: 1,
  installedProductionExpectedSha256: installedProductionSha,
  bundledNativeSources,
  bundleSha256: sha256(await readFile(`${output}/main.js`)),
}, null, 2) + "\n");
console.log(`Visible Markdown helper built in ${output}; installed production SHA-256 ${installedProductionSha}`);
