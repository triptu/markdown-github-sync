import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GitHubError, GitHubRepository, encodeGitData, gitBlobOid } from "../src/git-sync/github";
import type { GitHubRequest, GitHubResponse, GitHubTransport } from "../src/git-sync/github";
import type { Changes, Entry, Snapshot } from "../src/git-sync/contracts";

function hash(kind: string, bytes: Uint8Array): string {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
}
function file(text: string | Uint8Array, mode: Entry["mode"] = "100644"): Entry {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  return { oid: hash("blob", bytes), mode, data: Buffer.from(bytes).toString("base64") };
}
interface Item { path: string; mode: string; type: string; sha: string; size?: number }
interface StoredCommit { sha: string; tree: { sha: string }; parents: { sha: string }[] }
function tree(files: Map<string, Entry>): { sha: string; tree: Item[]; truncated: boolean } {
  const directories = new Map<string, Item[]>([["", []]]);
  for (const [path, entry] of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.set(parts.slice(0, i).join("/"), directories.get(parts.slice(0, i).join("/")) ?? []);
    directories.get(parts.slice(0, -1).join("/"))?.push({ path, mode: entry.mode, type: "blob", sha: entry.oid, size: Buffer.from(entry.data, "base64").length });
  }
  const all: Item[] = [];
  let root = "";
  for (const directory of Array.from(directories.keys()).sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length)) {
    const rows = directories.get(directory) ?? [];
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.path.slice(directory ? directory.length + 1 : 0) + (a.type === "tree" ? "/" : "")), Buffer.from(b.path.slice(directory ? directory.length + 1 : 0) + (b.type === "tree" ? "/" : ""))));
    const body = Buffer.concat(rows.map(item => Buffer.concat([Buffer.from(`${item.mode === "040000" ? "40000" : item.mode} ${item.path.slice(directory ? directory.length + 1 : 0)}\0`), Buffer.from(item.sha, "hex")])));
    const sha = hash("tree", body);
    all.push(...rows);
    if (!directory) root = sha;
    else directories.get(directory.split("/").slice(0, -1).join("/"))?.push({ path: directory, mode: "040000", type: "tree", sha });
  }
  return { sha: root, tree: all, truncated: false };
}
function response(json: unknown, status = 200, headers: Record<string, string> = {}): GitHubResponse { return { json, status, headers }; }
class FakeGitHub implements GitHubTransport {
  requests: GitHubRequest[] = [];
  files = new Map<string, Map<string, Entry>>();
  trees = new Map<string, ReturnType<typeof tree>>();
  commits = new Map<string, StoredCommit>();
  blobs = new Map<string, Entry>();
  head = "";
  sequence = 0;
  mutation: "normal" | "lost" | "lost-later" | "failed" | "rejected" = "normal";
  intercept?: (request: GitHubRequest) => GitHubResponse | undefined;
  constructor(initial: Snapshot = { "note.md": file("base\r\n"), ".obsidian/config.json": file("secret config"), "nested/.cache/skip": file("skip") }) {
    this.head = this.addCommit(initial);
  }
  addCommit(snapshot: Snapshot, parent?: string): string {
    const files = new Map(Object.entries(snapshot));
    const t = tree(files); this.trees.set(t.sha, t); this.files.set(t.sha, files);
    for (const entry of files.values()) this.blobs.set(entry.oid, entry);
    const sha = createHash("sha1").update(`${t.sha}:${parent}:${++this.sequence}`).digest("hex");
    this.commits.set(sha, { sha, tree: { sha: t.sha }, parents: parent ? [{ sha: parent }] : [] });
    return sha;
  }
  ancestor(a: string, b: string): boolean {
    return a === b || (this.commits.get(b)?.parents ?? []).some(p => this.ancestor(a, p.sha));
  }
  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(request);
    const intercepted = this.intercept?.(request); if (intercepted) return intercepted;
    const body: unknown = request.body ? JSON.parse(request.body) : undefined;
    const url = new URL(request.url), path = url.pathname.replace("/repos/owner/repo", "");
    if (!path) return response({ private: true, node_id: "R_stable", owner: { login: "owner" }, name: "repo" });
    if (path.startsWith("/git/ref/")) return response({ ref: "refs/heads/main", object: { type: "commit", sha: this.head } });
    if (path.startsWith("/git/commits/") && request.method === "GET") return response(this.commits.get(path.split("/").pop() ?? "") ?? null);
    if (path.startsWith("/git/trees/") && request.method === "GET") return response(this.trees.get(path.split("/").pop() ?? "") ?? null);
    if (path.startsWith("/git/blobs/") && request.method === "GET") {
      const entry = this.blobs.get(path.split("/").pop() ?? "");
      return response(entry ? { sha: entry.oid, encoding: "base64", size: Buffer.from(entry.data, "base64").length, content: entry.data.replace(/.{1,60}/g, "$&\n") } : null);
    }
    if (path.startsWith("/compare/")) {
      const [a, b] = path.slice(9).split("...");
      const ahead = this.ancestor(a, b), behind = this.ancestor(b, a);
      return response({ base_commit: { sha: a }, merge_base_commit: { sha: ahead ? a : behind ? b : "a".repeat(40) }, status: ahead ? "ahead" : behind ? "behind" : "diverged" });
    }
    if (typeof body !== "object" || body === null) throw new Error("Expected request object");
    if (path === "/git/blobs" && "content" in body && typeof body.content === "string") {
      const entry = file(Buffer.from(body.content, "base64")); this.blobs.set(entry.oid, entry); return response({ sha: entry.oid }, 201);
    }
    if (path === "/git/trees" && "base_tree" in body && typeof body.base_tree === "string" && "tree" in body && Array.isArray(body.tree)) {
      const files = new Map(this.files.get(body.base_tree));
      for (const value of body.tree) {
        if (typeof value !== "object" || value === null || !("path" in value) || typeof value.path !== "string" || !("sha" in value) || !("mode" in value)) throw new Error("Invalid tree edit");
        if (value.sha === null) files.delete(value.path);
        else if (typeof value.sha === "string" && (value.mode === "100644" || value.mode === "100755")) {
          const blob = this.blobs.get(value.sha); if (!blob) throw new Error("Missing blob");
          files.set(value.path, { ...blob, mode: value.mode });
        }
      }
      const t = tree(files); this.trees.set(t.sha, t); this.files.set(t.sha, files); return response(t, 201);
    }
    if (path === "/git/commits" && "tree" in body && typeof body.tree === "string" && "parents" in body && Array.isArray(body.parents) && typeof body.parents[0] === "string") {
      const sha = this.addCommit(Object.fromEntries(this.files.get(body.tree) ?? []), body.parents[0]); return response(this.commits.get(sha), 201);
    }
    if (path === "/graphql" && "variables" in body && typeof body.variables === "object" && body.variables !== null && "input" in body.variables) {
      const input: unknown = body.variables.input;
      if (typeof input !== "object" || input === null || !("refUpdates" in input) || !Array.isArray(input.refUpdates)) throw new Error("Invalid updateRefs");
      const update: unknown = input.refUpdates[0];
      if (typeof update !== "object" || update === null || !("beforeOid" in update) || !("afterOid" in update) || typeof update.afterOid !== "string" || !("force" in update)) throw new Error("Invalid exact update");
      assert.equal(update.force, false);
      if (this.mutation === "failed") throw new Error("network error with token SHOULD_NOT_ESCAPE");
      if (this.mutation === "rejected" || update.beforeOid !== this.head) return response({ errors: [{ message: "generic error" }] });
      this.head = update.afterOid;
      if (this.mutation === "lost-later") this.head = this.addCommit({ "note.md": file("later revert") }, this.head);
      if (this.mutation === "lost" || this.mutation === "lost-later") throw new Error("lost response");
      return response({ data: { updateRefs: { clientMutationId: update.afterOid } } });
    }
    throw new Error(`Unhandled ${request.method} ${path}`);
  }
}
function client(api: FakeGitHub, token: () => Promise<string> = async () => "SHOULD_NOT_ESCAPE"): GitHubRepository {
  return new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token, now: () => 1_000_000 });
}
test("browser byte codec matches independent Git hashing including binary and empty blobs", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("\ufeffhello 日本語\r\n"), Buffer.from([0, 255, 128, 10])]) {
    assert.equal(await gitBlobOid(bytes), hash("blob", bytes)); assert.equal(encodeGitData(bytes), bytes.toString("base64"));
  }
});
test("identity includes stable repository node id; snapshots exclude every dot component", async () => {
  const api = new FakeGitHub(); const repo = client(api);
  assert.deepEqual(await repo.identity(), { id: "R_stable", owner: "owner", name: "repo", branch: "main" });
  const head = await repo.head(); assert.deepEqual(Object.keys(head.files), ["note.md"]);
  assert.equal(head.files["note.md"].data, file("base\r\n").data);
  assert.equal(api.requests.filter(r => r.url.includes("/git/blobs/")).length, 1);
});
function objectGets(api: FakeGitHub): { commits: number; trees: number; blobs: number; refs: number } {
  const gets = api.requests.filter(r => r.method === "GET");
  return {
    commits: gets.filter(r => r.url.includes("/git/commits/")).length,
    trees: gets.filter(r => r.url.includes("/git/trees/")).length,
    blobs: gets.filter(r => r.url.includes("/git/blobs/")).length,
    refs: gets.filter(r => r.url.includes("/git/ref/")).length
  };
}
test("577-file polling reuses verified objects and preparation reuses the parent", async () => {
  const initial = Object.fromEntries(Array.from({ length: 577 }, (_, i) => [`notes/${i}.md`, file(`note ${i}`)]));
  const api = new FakeGitHub(initial), repo = client(api), parent = await repo.head();
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 577, refs: 1 });
  api.requests = [];
  for (let i = 0; i < 3; i++) assert.deepEqual(await repo.head(), parent);
  assert.deepEqual(objectGets(api), { commits: 0, trees: 0, blobs: 0, refs: 3 });
  api.requests = [];
  const candidate = await repo.prepare(parent, { "notes/42.md": file("changed") }, "one file");
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 0, refs: 0 });
  assert.equal(api.requests.filter(r => r.method === "POST" && r.url.endsWith("/git/blobs")).length, 1);
  api.requests = [];
  assert.deepEqual(await repo.readCommit(candidate.oid), candidate);
  assert.equal(api.requests.length, 0, "verified uploaded blob and candidate tree/commit should be reusable");
  api.head = api.addCommit({ ...initial, "notes/42.md": file("remote changed") });
  api.requests = [];
  const delta = await repo.head();
  assert.equal(delta.files["notes/42.md"].data, file("remote changed").data);
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 1, refs: 1 });
});
test("one-file deltas fetch only the new blob, even across an unrelated head and force rewind", async () => {
  const initial = { "a.md": file("a"), "b.md": file("b"), "run.sh": file("run") };
  const api = new FakeGitHub(initial), repo = client(api), parent = await repo.head();
  api.head = api.addCommit({ ...initial, "a.md": file("changed"), "run.sh": file("run", "100755") });
  api.requests = [];
  const next = await repo.head();
  assert.equal(next.files["a.md"].data, file("changed").data);
  assert.equal(next.files["run.sh"].mode, "100755");
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 1, refs: 1 });
  api.head = parent.oid;
  api.requests = [];
  assert.deepEqual(await repo.head(), parent);
  assert.deepEqual(objectGets(api), { commits: 0, trees: 0, blobs: 0, refs: 1 });
  const other = client(api);
  api.requests = [];
  assert.deepEqual(await other.head(), parent);
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 3, refs: 1 }, "instances must not share cache state");
});
test("caller mutation of snapshots, entries and prepared results cannot poison cached objects", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  const expected = structuredClone(parent);
  const second = await repo.head();
  assert.notEqual(second.files, parent.files);
  assert.notEqual(second.files["note.md"], parent.files["note.md"]);
  parent.files["note.md"].data = file("forged").data;
  parent.files["note.md"].oid = file("forged").oid;
  parent.files["note.md"].mode = "100755";
  parent.files["injected.md"] = file("injected");
  await assert.rejects(repo.prepare(parent, {}, "forged parent"), /Parent snapshot mismatch/);
  parent.oid = "a".repeat(40); parent.treeOid = "b".repeat(40);
  const fresh = await repo.head();
  assert.equal(fresh.oid, expected.oid); assert.equal(fresh.treeOid, expected.treeOid);
  assert.deepEqual({ ...fresh.files }, expected.files);
  const change = file("new"), candidate = await repo.prepare(fresh, { "new.md": change }, "valid parent");
  change.data = file("tampered input").data;
  candidate.files["note.md"].data = file("tampered return").data;
  candidate.files["new.md"].data = file("tampered new return").data;
  const reread = await repo.readCommit(candidate.oid);
  assert.equal(reread.files["note.md"].data, file("base\r\n").data);
  assert.equal(reread.files["new.md"].data, file("new").data);
});
test("rejected blob/tree hashes and commit identities are never cached", async () => {
  for (const kind of ["blob", "tree", "commit"]) {
    const api = new FakeGitHub(), repo = client(api);
    const stored = api.commits.get(api.head); assert.ok(stored);
    api.intercept = r => {
      if (kind === "blob" && r.url.includes("/git/blobs/")) return response({ sha: file("base\r\n").oid, encoding: "base64", size: 6, content: file("evil\r\n").data });
      if (kind === "tree" && r.url.includes("/git/trees/")) {
        const original = api.trees.get(stored.tree.sha); assert.ok(original);
        return response({ ...original, tree: original.tree.map(i => i.path === "note.md" ? { ...i, sha: "a".repeat(40) } : i) });
      }
      if (kind === "commit" && r.url.includes("/git/commits/")) return response({ ...stored, sha: "a".repeat(40) });
      return undefined;
    };
    await assert.rejects(repo.head(), kind === "commit" ? /Commit identity mismatch/ : /hash mismatch/);
    api.intercept = undefined;
    const valid = await repo.head(); assert.equal(valid.files["note.md"].data, file("base\r\n").data);
    const counts = objectGets(api);
    assert.equal(kind === "blob" ? counts.blobs : kind === "tree" ? counts.trees : counts.commits, 2);
    api.requests = [];
    await repo.head(); assert.equal(api.requests.length, 1);
  }
});
test("cached blobs still reject conflicting tree-declared sizes and ref failures", async () => {
  const api = new FakeGitHub(), repo = client(api); await repo.head();
  api.head = api.addCommit({ "renamed.md": file("base\r\n") });
  const stored = api.commits.get(api.head); assert.ok(stored);
  const items = api.trees.get(stored.tree.sha); assert.ok(items);
  items.tree[0].size = 7; // Sizes are absent from the cryptographic Git tree body.
  api.requests = [];
  await assert.rejects(repo.head(), /Blob identity or size mismatch/);
  assert.equal(objectGets(api).blobs, 0);
  api.intercept = r => r.url.includes("/git/ref/") ? response({}, 401) : undefined;
  await assert.rejects(repo.head(), error => error instanceof GitHubError && error.status === 401);
});
test("combined cache evicts least recently used blobs under the retained base64 byte budget", async () => {
  const api = new FakeGitHub({}), repo = client(api);
  const commits = Array.from({ length: 6 }, (_, i) => api.addCommit({ "large.bin": file(Buffer.alloc(8 * 1024 * 1024, i)) }));
  // Five blobs fit; six need over 128 MiB at two bytes per base64 code unit.
  for (const hash of commits.slice(0, 5)) await repo.readCommit(hash);
  await repo.readCommit(commits[0]); // Keep the first blob more recent than the second.
  await repo.readCommit(commits[5]);
  api.requests = [];
  await repo.readCommit(commits[0]); assert.equal(objectGets(api).blobs, 0);
  await repo.readCommit(commits[1]); assert.equal(objectGets(api).blobs, 1, "evicted blob must be fetched and verified again");
});
test("combined cache bounds tiny object count and refreshes LRU order on hits", async () => {
  const api = new FakeGitHub({}), repo = client(api);
  const commits = Array.from({ length: 4096 }, () => api.addCommit({}));
  for (const hash of commits.slice(0, -1)) await repo.readCommit(hash); // 4095 commits + one shared empty tree.
  await repo.readCommit(commits[0]);
  await repo.readCommit(commits[4095]);
  api.requests = [];
  await repo.readCommit(commits[0]); assert.equal(api.requests.length, 0);
  await repo.readCommit(commits[1]); assert.equal(objectGets(api).commits, 1);
});
test("preparation independently rereads a candidate even when its claimed ID is cached", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  api.intercept = r => r.method === "POST" && r.url.endsWith("/git/commits")
    ? response({ sha: parent.oid, tree: { sha: parent.treeOid }, parents: [{ sha: parent.oid }] }, 201)
    : undefined;
  api.requests = [];
  await assert.rejects(repo.prepare(parent, {}, "forged create acknowledgment"), /Prepared commit identity mismatch/);
  assert.equal(objectGets(api).commits, 1);
  assert.equal(api.head, parent.oid);
});
test("prepare preserves excluded paths, binaries, modes and parent without advancing ref", async () => {
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
  const changes = { "note.md": file("\ufeff日本語\r\n"), "media/binary.bin": file(Uint8Array.from([0, 128, 255])), "scripts/run.sh": file("#!/bin/sh\n", "100755") };
  const candidate = await repo.prepare(parent, changes, "roundtrip");
  assert.equal(api.head, parent.oid); assert.deepEqual(candidate.files, Object.assign(Object.create(null), changes));
  const stored = api.files.get(candidate.treeOid); assert.equal(stored?.get(".obsidian/config.json")?.oid, file("secret config").oid);
  assert.equal(stored?.get("nested/.cache/skip")?.oid, file("skip").oid);
  assert.deepEqual(await repo.readCommit(candidate.oid), candidate);
  assert.deepEqual(await repo.publish(parent.oid, candidate.oid), { kind: "accepted" });
  assert.equal(api.head, candidate.oid);
  const mutation = api.requests.find(r => r.url.endsWith("graphql")); assert.ok(mutation?.body?.includes(`"beforeOid":"${parent.oid}"`));
  assert.ok(api.requests.filter(r => r.method === "POST").every(r => !r.url.includes("/git/refs")));
});
test("deletes only visible paths and supports executable mode-only edits", async () => {
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
  const candidate = await repo.prepare(parent, { "note.md": null, "run.sh": file("run", "100755") }, "delete and executable");
  assert.equal(candidate.files["note.md"], undefined); assert.equal(candidate.files["run.sh"].mode, "100755");
});
for (const path of ["../note", "/note", "a//b", "a/../b", "a\\b", "C:note", "a\0b", "a.", "CON.md", "a/．", "a/ｂ／c", "a/\ud800", ".hidden", "a/.hidden/note"]) {
  test(`rejects unsafe or excluded change ${JSON.stringify(path)} before uploads`, async () => {
    const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
    await assert.rejects(repo.prepare(parent, { [path]: file("new") }, "bad"), GitHubError);
    assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  });
}
test("rejects case, Unicode, prefix and file/directory collisions before uploads", async () => {
  const cases: Changes[] = [{ "Note.md": file("x") }, { "é.md": file("x"), "e\u0301.md": file("y") }, { "Foo/a": file("a"), "foo/b": file("b") }, { "dir": file("a"), "dir/file": file("b") }, { "STRASSE": file("a"), "straße": file("b") }];
  for (const changes of cases) {
    const api = new FakeGitHub(); const repo = client(api);
    await assert.rejects(repo.prepare(await repo.head(), changes, "bad"), /collision/);
    assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  }
});
test("rejects forged parent, hash mismatch, noncanonical base64 and LFS before uploads", async () => {
  for (const next of [{ ...file("x"), oid: "a".repeat(40) }, { ...file("x"), data: "eA==\n" }, file("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n")]) {
    const api = new FakeGitHub(); const repo = client(api);
    await assert.rejects(repo.prepare(await repo.head(), { "note.md": next }, "bad"), GitHubError);
    assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  }
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head(); parent.files["note.md"] = file("forged");
  await assert.rejects(repo.prepare(parent, {}, "bad"), /Parent snapshot/);
});
test("rejects malformed payloads, API errors and missing/unborn branch with sanitized errors", async () => {
  for (const result of [response(null), response({ object: { sha: "bad" } }), response({ message: "SHOULD_NOT_ESCAPE" }, 401), response({}, 404), response({}, 409)]) {
    const api = new FakeGitHub(); api.intercept = () => result;
    await assert.rejects(client(api).head(), error => error instanceof GitHubError && !error.message.includes("SHOULD_NOT_ESCAPE"));
  }
  const api = new FakeGitHub(); api.intercept = () => response({}, 409);
  await assert.rejects(client(api).head(), /Unsupported enrollment.*empty\/unborn/);
});
test("rate limits surface retryAt once, honor mixed-case headers and never busy retry", async () => {
  for (const result of [response({}, 429, { "Retry-After": "120" }), response({}, 403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1300" }), response({ errors: [{ type: "RATE_LIMITED" }] }, 200, { "Retry-After": "120" }), response({}, 429, { "Retry-After": new Date(1_200_000).toUTCString() })]) {
    const api = new FakeGitHub(); api.intercept = () => result;
    await assert.rejects(client(api).head(), error => error instanceof GitHubError && error.retryAt !== undefined && error.retryAt >= 1_120_000);
    assert.equal(api.requests.length, 1);
  }
});
test("blocks truncated, identity-mismatched and cryptographically corrupted trees", async () => {
  for (const mutate of [(t: ReturnType<typeof tree>) => ({ ...t, truncated: true }), (t: ReturnType<typeof tree>) => ({ ...t, sha: "b".repeat(40) }), (t: ReturnType<typeof tree>) => ({ ...t, tree: t.tree.map(i => i.path === "note.md" ? { ...i, sha: "b".repeat(40) } : i) })]) {
    const api = new FakeGitHub(); api.intercept = r => r.url.includes("/git/trees/") ? response(mutate(Array.from(api.trees.values())[0])) : undefined;
    await assert.rejects(client(api).head(), GitHubError);
    assert.equal(api.requests.filter(r => r.url.includes("/git/blobs/")).length, 0);
  }
});
test("remote hostile paths, symlinks, submodules, Unicode collisions and LFS block snapshots", async () => {
  for (const mutate of [(items: Item[]) => items.map(i => i.path === "note.md" ? { ...i, path: "../bad" } : i), (items: Item[]) => items.map(i => i.path === "note.md" ? { ...i, mode: "120000" } : i), (items: Item[]) => items.map(i => i.path === "note.md" ? { ...i, mode: "160000", type: "commit" } : i), (items: Item[]) => [...items, { ...items[0], path: "NOTE.md" }]]) {
    const api = new FakeGitHub(); api.intercept = r => r.url.includes("/git/trees/") ? response({ ...Array.from(api.trees.values())[0], tree: mutate(Array.from(api.trees.values())[0].tree) }) : undefined;
    await assert.rejects(client(api).head(), GitHubError);
  }
  await assert.rejects(client(new FakeGitHub({ "lfs.bin": file("version https://git-lfs.github.com/spec/v1\n") })).head(), /LFS/);
});
test("verifies downloaded blob bytes, sizes, SHA and returned encoding", async () => {
  for (const payload of [{ content: file("tampered").data }, { sha: "b".repeat(40) }, { size: 1 }, { encoding: "utf-8" }, { content: "!!!!" }]) {
    const api = new FakeGitHub(); api.intercept = r => r.url.includes("/git/blobs/") ? response({ sha: file("base\r\n").oid, content: file("base\r\n").data, size: 6, encoding: "base64", ...payload }) : undefined;
    await assert.rejects(client(api).head(), GitHubError);
  }
});
test("preflights decoded per-file and total snapshot limits before blob transfers", async () => {
  for (const lengths of [[8 * 1024 * 1024 + 1], Array(17).fill(8 * 1024 * 1024)]) {
    const api = new FakeGitHub(); const items = lengths.map((length, index) => ({ path: `${index}.bin`, mode: "100644", type: "blob", sha: "a".repeat(40), size: length }));
    // Size is not part of a Git tree hash: generate an independent valid tree with these entries.
    const bytes = Buffer.concat(items.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(i => Buffer.concat([Buffer.from(`100644 ${i.path}\0`), Buffer.from(i.sha, "hex")])));
    const treeSha = hash("tree", bytes); const stored = api.commits.get(api.head); assert.ok(stored); stored.tree.sha = treeSha;
    api.trees.set(treeSha, { sha: treeSha, tree: items, truncated: false });
    await assert.rejects(client(api).head(), /size limit/);
    assert.equal(api.requests.filter(r => r.url.includes("/git/blobs/")).length, 0);
  }
});
test("uploads sequentially and refuses an uploaded blob hash mismatch", async () => {
  const api = new FakeGitHub(); api.intercept = r => r.method === "POST" && r.url.endsWith("/git/blobs") ? response({ sha: "b".repeat(40) }, 201) : undefined;
  const repo = client(api); await assert.rejects(repo.prepare(await repo.head(), { "a": file("a"), "b": file("b") }, "bad"), /Uploaded blob hash/);
  assert.equal(api.requests.filter(r => r.method === "POST").length, 1);
});
test("independent clients race: exactly one accepts; stale expected head cannot publish", async () => {
  const api = new FakeGitHub(), a = client(api), b = client(api), parent = await a.head();
  const left = await a.prepare(parent, { "a": file("a") }, "left"), right = await b.prepare(parent, { "b": file("b") }, "right");
  const results = await Promise.all([a.publish(parent.oid, left.oid), b.publish(parent.oid, right.oid)]);
  assert.deepEqual(results.map(r => r.kind).sort(), ["accepted", "head-moved"]);
  assert.deepEqual(await b.publish(parent.oid, right.oid), { kind: "head-moved" });
});
for (const mode of ["lost", "lost-later", "failed", "rejected"]) {
  test(`classifies publication ${mode} by rereading immutable candidate ancestry`, async () => {
    const api = new FakeGitHub(), repo = client(api), parent = await repo.head(), candidate = await repo.prepare(parent, { "note.md": file("new") }, "new");
    if (mode === "lost" || mode === "lost-later" || mode === "failed" || mode === "rejected") api.mutation = mode;
    assert.equal((await repo.publish(parent.oid, candidate.oid)).kind, mode.startsWith("lost") ? "accepted" : mode === "failed" ? "unknown" : "rejected");
  });
}
test("publication rate limits remain schedulable; unreadable ambiguity remains unknown", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head(), candidate = await repo.prepare(parent, { "note.md": file("new") }, "new");
  api.intercept = r => r.url.endsWith("graphql") ? response({}, 429, { "retry-after": "120" }) : undefined;
  await assert.rejects(repo.publish(parent.oid, candidate.oid), error => error instanceof GitHubError && error.retryAt === 1_120_000);
  api.mutation = "failed"; api.intercept = r => r.url.includes("/git/ref/") ? response({}, 503) : undefined;
  assert.deepEqual(await repo.publish(parent.oid, candidate.oid), { kind: "unknown" });
});
test("ancestry fails on uncertainty and publish rejects a candidate with the wrong parent", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  await assert.rejects(repo.publish(parent.oid, parent.oid), /exactly the expected/);
  api.intercept = r => r.url.includes("/compare/") ? response({ status: "ahead" }) : undefined;
  await assert.rejects(repo.isAncestor(parent.oid, "b".repeat(40)), GitHubError);
});
test("credential callback runs per request and secrets never escape errors", async () => {
  const api = new FakeGitHub(); let calls = 0;
  const repo = client(api, async () => { calls++; return "SHOULD_NOT_ESCAPE"; });
  await repo.head(); assert.equal(calls, api.requests.length);
  await assert.rejects(client(api, async () => { throw new Error("SHOULD_NOT_ESCAPE"); }).head(), error => error instanceof GitHubError && !error.message.includes("SHOULD_NOT_ESCAPE"));
});

test("multi-megabyte base64 validation and roundtrip remain bounded and do not overflow the stack", async () => {
  const bytes = Buffer.alloc(4_320_889, 0xff);
  const api = new FakeGitHub({ "large.bin": file(bytes) }), repo = client(api);
  const parent = await repo.head(); assert.equal(parent.files["large.bin"].data, bytes.toString("base64"));
  const candidate = await repo.prepare(parent, { "large.bin": file(bytes, "100755") }, "large mode change");
  assert.equal(candidate.files["large.bin"].mode, "100755");
});

test("preparation refuses server-created trees or commits that differ from the requested objects", async () => {
  for (const corrupt of ["tree", "commit"]) {
    const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
    api.intercept = r => {
      if (r.method !== "POST") return undefined;
      if (corrupt === "tree" && r.url.endsWith("/git/trees")) return response({ sha: parent.treeOid }, 201);
      if (corrupt === "commit" && r.url.endsWith("/git/commits")) return response({ sha: "b".repeat(40), tree: { sha: parent.treeOid }, parents: [] }, 201);
      return undefined;
    };
    await assert.rejects(repo.prepare(parent, { "new.md": file("new") }, "corrupt object"), GitHubError);
    assert.equal(api.head, parent.oid);
  }
});
test("rejects oversized outgoing entries, incorrect parent tree and invalid repository coordinates", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  await assert.rejects(repo.prepare(parent, { "big": file(Buffer.alloc(8 * 1024 * 1024 + 1)) }, "too large"), /oversized/);
  await assert.rejects(repo.prepare({ ...parent, treeOid: "a".repeat(40) }, {}, "forged"), /Parent tree/);
  assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  assert.throws(() => new GitHubRepository({ owner: "..", name: "repo", branch: "main", transport: api, token: async () => "t" }), /coordinates/);
});

test("blob transfer concurrency never exceeds one within preparation", async () => {
  const api = new FakeGitHub(); const original = api.request.bind(api);
  let active = 0, maximum = 0;
  api.request = async request => {
    const transfer = request.url.includes("/git/blobs");
    if (transfer) { active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => setImmediate(resolve)); }
    try { return await original(request); } finally { if (transfer) active--; }
  };
  const repo = client(api);
  await repo.prepare(await repo.head(), { "a.bin": file("a"), "b.bin": file("b") }, "sequential uploads");
  assert.equal(maximum, 1);
});

for (const visibility of [false, undefined, "true", null]) {
  test(`identity refuses non-private or malformed visibility: ${String(visibility)}`, async () => {
    const api = new FakeGitHub();
    api.intercept = request => new URL(request.url).pathname === "/repos/owner/repo"
      ? response({ private: visibility, node_id: "R_stable", owner: { login: "owner" }, name: "repo" }) : undefined;
    await assert.rejects(client(api).identity(), /private GitHub repository/);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "GET");
  });
}
