// Device-local scope exclusion (`ScopeRules.excludedExtensions`), used by the
// Android app to leave attachments on GitHub without treating them as deleted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GitHubRepository } from "../src/git-sync/github";
import type { GitHubRequest, GitHubResponse, GitHubTransport } from "../src/git-sync/github";
import { ScopeError, compileScope, freezeTransactionScope } from "../src/git-sync/scope";
import type { Entry, Snapshot } from "../src/git-sync/contracts";

test("rules without excluded extensions keep their shape and digest", async () => {
  const plain = await compileScope({ rules: "config/1", configDir: ".obsidian", gitignore: null }, null);
  assert.deepEqual(Object.keys(plain.rules), ["rules", "configDir", "gitignore"]);
  // Pinned: the digest existing journals store for this policy.
  const digest = createHash("sha1").update(JSON.stringify(["scope-policy/4", { rules: "config/1", configDir: ".obsidian", gitignore: null }])).digest("hex");
  assert.equal(plain.digest, digest);
});

test("excluded extensions classify only visible files and are part of the digest", async () => {
  const rules = { rules: "config/1", configDir: ".notes-app", gitignore: null } as const;
  const phone = await compileScope({ ...rules, excludedExtensions: ["png", "jpg"] }, null);
  assert.deepEqual(phone.rules.excludedExtensions, ["jpg", "png"]);
  assert.notEqual(phone.digest, (await compileScope(rules, null)).digest);
  assert.equal(phone.classify("a/photo.JPG"), "ignored");
  assert.equal(phone.includes("a/photo.jpg"), false);
  assert.equal(phone.classify("photo.png.md"), "content");
  assert.equal(phone.classify("png"), "content");
  assert.equal(phone.classify(".obsidian/app.json"), "outside", "another device's config directory is out of scope");
  assert.equal(phone.classify(".notes-app/icon.png"), "config-inert", "exclusion applies to visible files only");
  for (const bad of [[], ["PNG"], [".png"], ["png", "png"], [""]])
    await assert.rejects(compileScope({ ...rules, excludedExtensions: bad }, null), ScopeError);
  await assert.rejects(freezeTransactionScope(phone, await compileScope(rules, null), null), ScopeError);
  const frozen = await freezeTransactionScope(phone, phone, "notes/private.md\n");
  assert.equal(frozen.includes("a/b.png"), false);
  assert.equal(frozen.includes("notes/private.md"), false);
  assert.equal(frozen.includes("notes/public.md"), true);
});

function hash(kind: string, bytes: Uint8Array): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])).digest("hex");
}
function file(content: string | Uint8Array): Entry {
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  return { oid: hash("blob", bytes), mode: "100644", data: bytes.toString("base64") };
}
interface Item { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number }
function tree(files: Map<string, Entry>): { sha: string; tree: Item[]; truncated: false } {
  const items: Item[] = [];
  const build = (prefix: string): string => {
    const names = new Map<string, Item>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length), slash = rest.indexOf("/");
      if (slash < 0) names.set(rest, { path, mode: entry.mode, type: "blob", sha: entry.oid, size: Buffer.from(entry.data, "base64").length });
      else if (!names.has(rest.slice(0, slash) + "/")) names.set(rest.slice(0, slash) + "/", { path: prefix + rest.slice(0, slash), mode: "040000", type: "tree", sha: "" });
    }
    const rows = [...names.entries()].map(([name, item]) => {
      if (item.type === "tree") item.sha = build(item.path + "/");
      items.push(item);
      const bare = name.endsWith("/") ? name.slice(0, -1) : name;
      return { sort: name, bytes: Buffer.concat([Buffer.from(`${item.mode === "040000" ? "40000" : item.mode} ${bare}\0`), Buffer.from(item.sha, "hex")]) };
    }).sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    return hash("tree", Buffer.concat(rows.map(row => row.bytes)));
  };
  const sha = build("");
  return { sha, tree: items, truncated: false };
}

/** Just enough of the GitHub API for one read and one prepare. */
class Fake implements GitHubTransport {
  requests: GitHubRequest[] = [];
  trees = new Map<string, { files: Map<string, Entry>; json: ReturnType<typeof tree> }>();
  commits = new Map<string, unknown>();
  blobs = new Map<string, Entry>();
  head: string;
  constructor(files: Snapshot) { this.head = this.commit(new Map(Object.entries(files)), []); }
  commit(files: Map<string, Entry>, parents: string[]): string {
    const json = tree(files); this.trees.set(json.sha, { files, json });
    for (const entry of files.values()) this.blobs.set(entry.oid, entry);
    const sha = createHash("sha1").update(`${json.sha}:${parents.join()}:${this.commits.size}`).digest("hex");
    this.commits.set(sha, { sha, tree: { sha: json.sha }, parents: parents.map(p => ({ sha: p })) });
    return sha;
  }
  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(request);
    const ok = (json: unknown, status = 200): GitHubResponse => ({ status, headers: {}, json });
    const path = new URL(request.url).pathname.replace("/repos/owner/repo", "");
    const body = request.body ? JSON.parse(request.body) : undefined;
    const last = path.split("/").pop() ?? "";
    if (path.startsWith("/git/ref/")) return ok({ ref: "refs/heads/main", object: { type: "commit", sha: this.head } });
    if (path.startsWith("/git/commits/")) return ok(this.commits.get(last) ?? null, this.commits.has(last) ? 200 : 404);
    if (path.startsWith("/git/trees/")) return ok(this.trees.get(last)?.json ?? null);
    if (path.startsWith("/git/blobs/")) {
      const entry = this.blobs.get(last)!;
      return ok({ sha: entry.oid, encoding: "base64", size: Buffer.from(entry.data, "base64").length, content: entry.data });
    }
    if (path === "/git/blobs") { const entry = file(Buffer.from(body.content, "base64")); this.blobs.set(entry.oid, entry); return ok({ sha: entry.oid }, 201); }
    if (path === "/git/trees") {
      const files = new Map(this.trees.get(body.base_tree)!.files);
      for (const edit of body.tree) {
        if (edit.sha === null) files.delete(edit.path); else files.set(edit.path, { ...this.blobs.get(edit.sha)!, mode: edit.mode });
      }
      const json = tree(files); this.trees.set(json.sha, { files, json });
      return ok(json, 201);
    }
    if (path === "/git/commits") {
      const files = this.trees.get(body.tree)!.files;
      return ok(this.commits.get(this.commit(files, body.parents)), 201);
    }
    throw new Error(`Unhandled ${request.method} ${path}`);
  }
}

test("a repository with excluded extensions never downloads them and preserves them in its commits", async () => {
  const photo = file(Uint8Array.from([137, 80, 78, 71, 0, 1, 2]));
  const paper = file("%PDF-1.7");
  const api = new Fake({ "note.md": file("base\n"), "media/photo.PNG": photo, "docs/paper.pdf": paper, ".obsidian/app.json": file("{}") });
  const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t",
    installation: "0f8a6e3c-1b2d-4c5e-8f90-123456789abc", now: () => 1_000_000, configDir: ".notes-app", excludedExtensions: ["pdf", "png"] });
  const parent = await repo.head();
  assert.deepEqual(Object.keys(parent.files), ["note.md"]);
  assert.equal(api.requests.filter(r => r.url.includes("/git/blobs/")).length, 1, "only the note's blob is read");
  assert.equal((await repo.scopeFor(parent.oid)).classify("media/photo.PNG"), "ignored");
  const L = { anchor: null, operation: "publish-1" };
  await assert.rejects(repo.prepare(parent, { "media/new.png": photo }, "excluded", L), /outside parent commit scope/);
  const candidate = await repo.prepare(parent, { "note.md": null, "other.md": file("new\n") }, "edit", L);
  const stored = api.trees.get(candidate.treeOid)!.files;
  assert.equal(stored.get("media/photo.PNG")?.oid, photo.oid);
  assert.equal(stored.get("docs/paper.pdf")?.oid, paper.oid);
  assert.equal(stored.get(".obsidian/app.json")?.oid, file("{}").oid);
  assert.deepEqual(Object.keys(candidate.files), ["other.md"]);
});
