import { execFileSync } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
await copyFile("README.md", "dist/github-vault-sync/README.md");
await rm("dist/github-vault-sync.zip", { force: true });
execFileSync("zip", ["-q", "github-vault-sync.zip", ...["main.js", "manifest.json", "styles.css", "README.md"].map(name => `github-vault-sync/${name}`)], {
  cwd: "dist",
});
console.log("Plugin package: dist/github-vault-sync.zip");
