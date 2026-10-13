import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const expected = process.argv[2];
if (process.argv.length !== 3 || !/^[0-9a-f]{64}$/.test(expected ?? ""))
  throw new Error("Usage: node scripts/build-native-configuration-device.mjs <production-main-js-sha256>");
const actual = createHash("sha256").update(await readFile("dist/github-vault-sync/main.js")).digest("hex");
if (actual !== expected) throw new Error(`Production bundle SHA-256 differs: ${actual}`);

const runId = randomUUID();
const branch = `newnative-config-${runId}`;
const output = `dist/native-configuration-device/${runId}`;
const androidVault = "/storage/emulated/0/Documents/Vault Sync Config Lab";
const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir(output, { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/configuration-device-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  define: {
    ACCEPTANCE_RUN_ID: JSON.stringify(runId),
    ACCEPTANCE_BRANCH: JSON.stringify(branch),
    EXPECTED_PRODUCTION_SHA: JSON.stringify(expected),
    ANDROID_VAULT_PATH: JSON.stringify(androidVault),
  },
  outfile: `${output}/main.js`,
});
await writeFile(`${output}/manifest.json`, JSON.stringify({
  id: "git-sync-native-config-device", name: "Git Sync Configuration Device Acceptance",
  version: "0.0.1", minAppVersion: "1.11.4",
  description: "Disposable Android configuration acceptance vault only",
  author: "Vault Sync", isDesktopOnly: false,
}));
await writeFile(`${output}/run.json`, JSON.stringify({
  format: 1, runId, branch, expectedProductionSha256: expected, androidVault,
}, null, 2) + "\n", { flag: "wx" });
console.log(`Configuration helper built: ${output}; run ${runId}; production SHA-256 ${expected}`);
