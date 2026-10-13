import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const resumeFailedPrestate = process.argv[2] === "--resume-failed-prestate";
if (process.argv.length > (resumeFailedPrestate ? 3 : 2))
  throw new Error("Usage: node scripts/build-native-configuration-restart.mjs [--resume-failed-prestate]");

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const expectedProductionSha256 = "2a1f0ecb9679e8bf4e7cd5c635f69d1f773e29af3a4e9cb6c7e9abf0c82bb93f";
const productionSha256 = createHash("sha256")
  .update(await readFile("dist/github-vault-sync/main.js"))
  .digest("hex");
if (productionSha256 !== expectedProductionSha256)
  throw new Error(`Production bundle hash changed: ${productionSha256}`);
const output = "dist/native-configuration-restart";

await mkdir(output, { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/configuration-restart-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  define: { EXPECTED_PRODUCTION_SHA: JSON.stringify(productionSha256),
    RESUME_FAILED_PRESTATE: JSON.stringify(resumeFailedPrestate) },
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
