import { test } from "node:test";
import assert from "node:assert/strict";
import { detectGitRepository } from "../src/git-setup";
const adapter = (config: string, head = "ref: refs/heads/main\n") => ({
  async exists(path: string) { return path === ".git/config" || path === ".git/HEAD"; },
  async read(path: string) { if (path === ".git/config") return config; if (path === ".git/HEAD") return head; throw Error("Unexpected read"); },
});
test("detects owner/repo and current branch from HTTPS and SSH remotes", async () => {
  for (const url of ["https://github.com/your-name/notes.git", "git@github.com:your-name/notes.git", "ssh://git@github.com/your-name/notes.git"]) {
    assert.deepEqual(await detectGitRepository(adapter(`[remote "origin"]\n url = ${url}\n`)), { owner: "triptu", repository: "notes", branch: "main" });
  }
});
test("respects the current branch's upstream remote and branch instead of guessing main", async () => {
  const config = '[remote "origin"]\n url = git@github.com:someone/else.git\n[remote "notes"]\n url = https://github.com/your-name/notes\n[branch "laptop"]\n remote = notes\n merge = refs/heads/notes/main\n';
  assert.deepEqual(await detectGitRepository(adapter(config,"ref: refs/heads/laptop")), { owner: "triptu", repository: "notes", branch: "notes/main" });
});
test("does not disclose credentials embedded in a remote URL", async () => {
  assert.deepEqual(await detectGitRepository(adapter('[remote "origin"]\n url = https://user:private@github.com/your-name/notes.git')), { owner: "triptu", repository: "notes", branch: "main" });
});
test("leaves detached, absent, and unsupported remotes for manual entry", async () => {
  assert.equal(await detectGitRepository(adapter('[remote "origin"]\nurl=https://github.com/your-name/notes', 'a'.repeat(40))), null);
  assert.equal(await detectGitRepository(adapter('[remote "origin"]\nurl=https://github.example/your-name/notes')), null);
  assert.equal(await detectGitRepository({ exists: async () => false, read: async () => { throw Error("must not read"); } }), null);
});
