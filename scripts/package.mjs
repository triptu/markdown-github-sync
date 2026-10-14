import { execFileSync } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
await copyFile("README.md", "dist/github-vault-sync/README.md");
const zip = (name, files) => {
  execFileSync("zip", ["-q", `${name}.zip`, ...files.map(file => `${name}/${file}`)], { cwd: "dist" });
  console.log(`Plugin package: dist/${name}.zip`);
};
await rm("dist/github-vault-sync.zip", { force: true });
await rm("dist/github-vault-sync-updater.zip", { force: true });
zip("github-vault-sync", ["main.js", "manifest.json", "styles.css", "README.md"]);
zip("github-vault-sync-updater", ["main.js", "manifest.json"]);
