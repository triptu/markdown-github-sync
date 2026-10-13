import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectGitTakeover, takeOverGit, type TakeoverFiles } from "../src/git-takeover";

/** Synthetic Obsidian adapter: files map to text, folders are tracked explicitly, paths are vault-relative. */
class Vault implements TakeoverFiles {
  files = new Map<string, string>();
  folders = new Set<string>();
  calls: string[] = [];
  constructor(files: Record<string, string>) {
    for (const [path, data] of Object.entries(files)) { this.files.set(path, data); this.parents(path); }
  }
  private parents(path: string) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }
  async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
  async stat(path: string) {
    return this.files.has(path) ? { type: "file" as const } : this.folders.has(path) ? { type: "folder" as const } : null;
  }
  async list(path: string) {
    const child = (p: string) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/");
    return { files: [...this.files.keys()].filter(child), folders: [...this.folders].filter(child) };
  }
  async write(path: string, data: string) { this.calls.push(`write ${path}`); this.files.set(path, data); this.parents(path); }
  async mkdir(path: string) { this.calls.push(`mkdir ${path}`); this.folders.add(path); this.parents(path); }
  async rename(from: string, to: string) {
    this.calls.push(`rename ${from} -> ${to}`);
    if (await this.exists(to)) throw new Error("Destination file already exists!");
    this.copy(from, to);
    this.remove(from);
  }
  copy(from: string, to: string) {
    const move = (p: string) => to + p.slice(from.length);
    const inside = (p: string) => p === from || p.startsWith(`${from}/`);
    for (const [p, d] of [...this.files]) if (inside(p)) { this.files.set(move(p), d); this.parents(move(p)); }
    for (const p of [...this.folders]) if (inside(p)) this.folders.add(move(p));
  }
  remove(path: string) {
    const inside = (p: string) => p === path || p.startsWith(`${path}/`);
    for (const p of [...this.files.keys()]) if (inside(p)) this.files.delete(p);
    for (const p of [...this.folders]) if (inside(p)) this.folders.delete(p);
  }
  snapshot(prefix: string) {
    return Object.fromEntries([...this.files].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => [p.slice(prefix.length), d]).sort());
  }
}

const repo = () => new Vault({
  "Daily/2026-10-14.md": "today",
  "Ideas.md": "ideas",
  ".obsidian/app.json": "{}",
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/config": "[remote \"origin\"]\n",
  ".git/index": "stale-index",
  ".git/refs/heads/main": "abc\n",
  ".git/objects/ab/c": "blob",
});
const now = () => new Date("2026-10-14T10:15:00Z");
const notes = (v: Vault) => Object.fromEntries([...v.files].filter(([p]) => !p.startsWith(".git")));

test("no .git: nothing to do and nothing written", async () => {
  const v = new Vault({ "a.md": "x" });
  assert.deepEqual(await inspectGitTakeover(v), { kind: "none" });
  assert.deepEqual(await takeOverGit(v, { now }), { kind: "none" });
  assert.deepEqual(v.calls, []);
});

test("inspection is read-only", async () => {
  const v = repo();
  assert.deepEqual(await inspectGitTakeover(v), { kind: "ready", resume: false });
  assert.deepEqual(v.calls, []);
});

test("takeover keeps the entire .git byte-for-byte, leaves notes untouched, removes live .git", async () => {
  const v = repo(), before = v.snapshot(".git/"), notesBefore = notes(v);
  const result = await takeOverGit(v, { now });
  assert.equal(result.kind, "moved");
  if (result.kind !== "moved") return;
  assert.match(result.keptAt, /^\.git-vault-sync\/previous-git\/20261014-101500-[0-9a-f]{4}\/dot-git$/);
  assert.equal(await v.exists(".git"), false);
  assert.deepEqual(v.snapshot(`${result.keptAt}/`), before);
  assert.deepEqual(notes(v), notesBefore);
  assert.ok(await v.exists(result.keptAt.replace(/dot-git$/, "done")));
  assert.deepEqual(await inspectGitTakeover(v), { kind: "none" });
  assert.deepEqual(await takeOverGit(v, { now }), { kind: "none" });
});

test("crash after the start marker reuses the same folder", async () => {
  const v = repo(), rename = v.rename.bind(v);
  v.rename = async () => { throw new Error("app closed"); };
  await assert.rejects(takeOverGit(v, { now }), /Couldn.t move the old Git folder/);
  assert.ok(await v.exists(".git/index"));
  assert.deepEqual(await inspectGitTakeover(v), { kind: "ready", resume: true });
  v.rename = rename;
  const result = await takeOverGit(v, { now });
  assert.equal(result.kind, "moved");
  assert.equal((await v.list(".git-vault-sync/previous-git")).folders.length, 1);
});

test("crash after the move but before the done marker finishes on retry", async () => {
  const v = repo(), write = v.write.bind(v);
  v.write = async (path, data) => { if (path.endsWith("/done")) throw new Error("app closed"); return write(path, data); };
  await assert.rejects(takeOverGit(v, { now }), /app closed/);
  assert.equal(await v.exists(".git"), false);
  assert.deepEqual(await inspectGitTakeover(v), { kind: "ready", resume: true });
  v.write = write;
  const result = await takeOverGit(v, { now });
  assert.equal(result.kind, "moved");
  assert.equal(v.calls.filter(c => c.startsWith("rename")).length, 1);
  assert.deepEqual(await inspectGitTakeover(v), { kind: "none" });
});

test("half-finished copy-style move is reported and never touched again", async () => {
  const v = repo();
  v.rename = async (from, to) => { v.copy(from, to); throw new Error("app closed"); };
  await assert.rejects(takeOverGit(v, { now }));
  const check = await inspectGitTakeover(v);
  assert.equal(check.kind === "blocked" && check.code, "interrupted");
  const calls = v.calls.length;
  assert.equal((await takeOverGit(v, { now })).kind, "blocked");
  assert.equal(v.calls.length, calls);
  assert.ok(await v.exists(".git/index"));
});

test("a later fresh .git after a completed takeover gets its own kept folder", async () => {
  const v = repo();
  const first = await takeOverGit(v, { now });
  await v.write(".git/HEAD", "ref: refs/heads/other\n");
  const second = await takeOverGit(v, { now });
  assert.ok(first.kind === "moved" && second.kind === "moved" && first.keptAt !== second.keptAt);
  assert.equal((await v.list(".git-vault-sync/previous-git")).folders.length, 2);
});

for (const [label, files, code, pattern] of [
  [".git pointer file", { ".git": "gitdir: /elsewhere/.git/worktrees/v\n" }, "git-link", /another folder/],
  ["commondir", { ".git/HEAD": "x", ".git/commondir": "../.." }, "git-link", /another folder/],
  ["linked worktrees", { ".git/HEAD": "x", ".git/worktrees/feature/HEAD": "x" }, "linked-worktrees", /git worktree remove/],
  ["index lock", { ".git/HEAD": "x", ".git/index.lock": "" }, "git-busy", /delete \.git\/index\.lock/],
  ["ref lock", { ".git/HEAD": "x", ".git/refs/heads/main.lock": "" }, "git-busy", /\.git\/refs\/heads\/main\.lock/],
  ["merge", { ".git/HEAD": "x", ".git/MERGE_HEAD": "abc" }, "git-mid-operation", /merge or rebase/],
  ["rebase", { ".git/HEAD": "x", ".git/rebase-merge/done": "" }, "git-mid-operation", /merge or rebase/],
] as const) {
  test(`blocked without changes: ${label}`, async () => {
    const v = new Vault({ "a.md": "x", ...files });
    for (const result of [await inspectGitTakeover(v), await takeOverGit(v, { now })]) {
      assert.equal(result.kind, "blocked");
      if (result.kind !== "blocked") continue;
      assert.equal(result.code, code);
      assert.match(result.reason, pattern);
    }
    assert.deepEqual(v.calls, []);
  });
}

test("a real Git checkout keeps every Git file and note when adopted", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-adoption-"));
  const at = (name: string) => path.join(root, name);
  try {
    execFileSync("git", ["init", "--quiet", root]);
    await fs.writeFile(at("note.md"), "my existing note\n");
    execFileSync("git", ["-C", root, "add", "note.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"]);
    const walk = async (folder: string): Promise<Record<string, string>> => {
      const result: Record<string, string> = {};
      for (const name of await fs.readdir(at(folder), { recursive: true })) {
        const full = path.join(folder, name);
        if ((await fs.stat(at(full))).isFile()) result[name] = (await fs.readFile(at(full))).toString("base64");
      }
      return result;
    };
    const before = await walk(".git");
    const adapter: TakeoverFiles = {
      async exists(name) { try { await fs.stat(at(name)); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; } },
      async stat(name) { try { const s = await fs.stat(at(name)); return { type: s.isDirectory() ? "folder" : "file" }; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; } },
      async list(name) { const entries = await fs.readdir(at(name), { withFileTypes: true }); return { files: entries.filter(e => e.isFile()).map(e => `${name}/${e.name}`), folders: entries.filter(e => e.isDirectory()).map(e => `${name}/${e.name}`) }; },
      async mkdir(name) { await fs.mkdir(at(name)); },
      async write(name, data) { await fs.writeFile(at(name), data); },
      async rename(from, to) { await fs.rename(at(from), at(to)); },
    };
    assert.equal((await inspectGitTakeover(adapter)).kind, "ready");
    const result = await takeOverGit(adapter);
    assert.equal(result.kind, "moved");
    if (result.kind !== "moved") throw Error("Expected moved Git folder");
    assert.deepEqual(await walk(result.keptAt), before);
    assert.equal(await fs.readFile(at("note.md"), "utf8"), "my existing note\n");
    assert.equal(await adapter.exists(".git"), false);
    assert.equal((await takeOverGit(adapter)).kind, "none");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Git submodules are identified before any metadata moves", async () => {
  const v = repo();
  await v.write(".git/modules/child/HEAD", "ref: refs/heads/main\n");
  v.calls.length = 0;
  const result = await takeOverGit(v);
  assert.equal(result.kind, "blocked");
  assert.ok(result.kind === "blocked" && result.reason.includes("submodules"));
  assert.ok(await v.exists(".git/index"));
  assert.deepEqual(v.calls, []);
});
