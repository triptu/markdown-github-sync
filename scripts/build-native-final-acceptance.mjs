import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const usage = "Usage: node scripts/build-native-final-acceptance.mjs <expected-production-sha256>";
const expected = process.argv[2];
if (process.argv.length !== 3 || !/^[0-9a-f]{64}$/.test(expected ?? "")) throw new Error(usage);
const actual = createHash("sha256").update(await readFile("dist/github-vault-sync/main.js")).digest("hex");
if (actual !== expected) throw new Error(`Production bundle hash differs: ${actual}`);

const runId = randomUUID();
const branch = `native-final-${runId}`;
const output = `dist/native-final-acceptance/${runId}`;
const desktopVault = "/tmp/github-vault-sync-desktop-v2-1791919653/Vault Sync Lab";
const androidVault = "/storage/emulated/0/Documents/Vault Sync Final Lab";
const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir(output, { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/final-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  define: {
    ACCEPTANCE_RUN_ID: JSON.stringify(runId),
    ACCEPTANCE_BRANCH: JSON.stringify(branch),
    EXPECTED_PRODUCTION_SHA: JSON.stringify(expected),
    DESKTOP_VAULT_PATH: JSON.stringify(desktopVault),
    ANDROID_VAULT_PATH: JSON.stringify(androidVault),
  },
  outfile: `${output}/main.js`,
});
await writeFile(`${output}/manifest.json`, JSON.stringify({
  id: "git-sync-native-final", name: "Git Sync Final Acceptance", version: "0.0.1",
  minAppVersion: "1.11.4", description: "Disposable final acceptance vaults only",
  author: "Vault Sync", isDesktopOnly: false,
}));
await writeFile(`${output}/run.json`, JSON.stringify({
  format: 1, runId, branch, expectedProductionSha256: expected, desktopVault, androidVault,
}, null, 2) + "\n", { flag: "wx" });
console.log(`Final helper built: ${output}; run ${runId}; expected production SHA-256 ${expected}`);
