import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(new URL("../plugin/package.json", import.meta.url));
await mkdir("dist/native-rename-probe", { recursive: true });
await require("esbuild").build({ entryPoints: ["plugin/test/native/rename-probe.ts"], bundle: true, platform: "browser", format: "cjs", external: ["obsidian"], outfile: "dist/native-rename-probe/main.js" });
await writeFile("dist/native-rename-probe/manifest.json", JSON.stringify({ id: "git-sync-rename-probe", name: "Git Sync Rename Probe", version: "0.0.1", minAppVersion: "1.11.4", description: "Disposable vault native rename verification", author: "Vault Sync", isDesktopOnly: false }));
