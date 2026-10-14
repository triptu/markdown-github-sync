// Publishes the built plugin to the `updates` branch that the updater plugin reads.
// The branch holds one commit (force-pushed) with latest.json + latest/{main.js,manifest.json,styles.css}.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = ["main.js", "manifest.json", "styles.css"];
const dist = "dist/github-vault-sync";
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
const hashes = {};
for (const name of files) hashes[name] = createHash("sha256").update(await readFile(join(dist, name))).digest("hex");

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const dir = await mkdtemp(join(tmpdir(), "vault-sync-updates-"));
try {
  git(["worktree", "add", "--detach", dir, "HEAD"]);
  git(["checkout", "--orphan", "updates-publish"], dir);
  git(["rm", "-rf", "--quiet", "."], dir);
  await mkdir(join(dir, "latest"));
  for (const name of files) await copyFile(join(dist, name), join(dir, "latest", name));
  await writeFile(join(dir, "latest.json"), JSON.stringify({ version: manifest.version, minAppVersion: manifest.minAppVersion, files: hashes }, null, 2) + "\n");
  git(["add", "latest.json", "latest"], dir);
  git(["commit", "--quiet", "-m", `Update channel: ${manifest.version}`], dir);
  git(["push", "--force", "--quiet", "origin", "HEAD:updates"], dir);
  console.log(`Published ${manifest.version} to the updates branch.`);
} finally {
  git(["worktree", "remove", "--force", dir]);
  try { git(["branch", "-D", "updates-publish"]); } catch {}
  await rm(dir, { recursive: true, force: true });
}
