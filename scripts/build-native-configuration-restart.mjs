import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/build-native-configuration-restart.mjs");

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const productionSha256 = createHash("sha256")
  .update(await readFile("dist/github-vault-sync/main.js"))
  .digest("hex");
const output = "dist/native-configuration-restart";

await mkdir(output, { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/configuration-restart-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  define: { EXPECTED_PRODUCTION_SHA: JSON.stringify(productionSha256) },
  outfile: `${output}/main.js`,
});
await writeFile(`${output}/manifest.json`, JSON.stringify({
  id: "git-sync-native-configuration-restart",
  name: "Git Sync Native Configuration Restart Acceptance",
  version: "0.0.1",
  minAppVersion: "1.11.4",
  description: "Disposable private lab vault Android restart verification only",
  author: "Vault Sync",
  isDesktopOnly: false,
}));
await writeFile(`${output}/production-sha256.txt`, `${productionSha256}\n`);
