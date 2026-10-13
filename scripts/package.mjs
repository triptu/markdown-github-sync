import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
await copyFile("README.md", "dist/cloud-vault-sync/README.md");
execFileSync("zip", ["-r", "-q", "cloud-vault-sync.zip", "cloud-vault-sync"], {
  cwd: "dist",
});
console.log("Plugin package: dist/cloud-vault-sync.zip");
