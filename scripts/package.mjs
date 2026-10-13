import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
await copyFile("README.md", "dist/github-vault-sync/README.md");
execFileSync("zip", ["-r", "-q", "github-vault-sync.zip", "github-vault-sync"], {
  cwd: "dist",
});
console.log("Plugin package: dist/github-vault-sync.zip");
