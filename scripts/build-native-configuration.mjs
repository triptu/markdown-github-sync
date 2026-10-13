import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const productionSha256 = "2b38871ad3c8cfa91bd3c0c12cfa70271e61ae9ad3578d2aba84ff9cf6972fee";
const resumeArgument = process.argv[2];
if (process.argv.length > 3 || resumeArgument && !/^--resume-failed-fixture-published=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resumeArgument))
  throw new Error("Usage: node scripts/build-native-configuration.mjs [--resume-failed-fixture-published=<run UUID>]");
const actualSha256 = createHash("sha256").update(await readFile("dist/github-vault-sync/main.js")).digest("hex");
if (actualSha256 !== productionSha256) throw new Error(`Production bundle hash changed: ${actualSha256}`);
const resumeFailedRunId = resumeArgument?.split("=")[1] ?? null;
await mkdir("dist/native-configuration", { recursive: true });
await require("esbuild").build({
  entryPoints: ["plugin/test/native/configuration-acceptance.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["obsidian"],
  define: { EXPECTED_PRODUCTION_SHA: JSON.stringify(productionSha256),
    RESUME_FAILED_RUN_ID: JSON.stringify(resumeFailedRunId) },
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
