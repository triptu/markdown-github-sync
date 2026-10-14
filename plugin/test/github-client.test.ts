import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync } from "fflate";
import { GitHubError, GitHubRepository, encodeGitData, gitBlobOid } from "../src/git-sync/github";
import { ScopeError } from "../src/git-sync/scope";
import type { GitHubBinaryResponse, GitHubRequest, GitHubResponse, GitHubTransport } from "../src/git-sync/github";
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
  mutation: "normal" | "lost" | "lost-later" | "failed" | "rejected" | "error-after" = "normal";
  refs = new Map<string, string>();
  ledgerQuery: "normal" | "other-ref" | "not-commit" | "prefix-list" = "normal";
  intercept?: (request: GitHubRequest) => GitHubResponse | undefined;
  constructor(initial: Snapshot = { "note.md": file("base\r\n"), ".obsidian/config.json": file("secret config"), "nested/.cache/skip": file("skip") }) {
    this.head = this.addCommit(initial);
  }
  addCommit(snapshot: Snapshot, parent?: string | string[]): string {
    const files = new Map(Object.entries(snapshot));
    const t = tree(files); this.trees.set(t.sha, t); this.files.set(t.sha, files);
    for (const entry of files.values()) this.blobs.set(entry.oid, entry);
    const parents = parent === undefined ? [] : Array.isArray(parent) ? parent : [parent];
    const sha = createHash("sha1").update(`${t.sha}:${parents.join(",")}:${++this.sequence}`).digest("hex");
    this.commits.set(sha, { sha, tree: { sha: t.sha }, parents: parents.map(p => ({ sha: p })) });
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
    if (path.startsWith("/git/ref/vault-sync/devices/") && request.method === "GET") {
      const name = `refs/${decodeURIComponent(path.slice("/git/ref/".length))}`;
      const value = this.refs.get(name);
      if (this.ledgerQuery === "prefix-list") return response([{ ref: `${name}-other`, object: { type: "commit", sha: "d".repeat(40) } }]);
      if (value === undefined) return response({ message: "Not Found" }, 404);
      return response({ ref: this.ledgerQuery === "other-ref" ? "refs/vault-sync/devices/other" : name, object: { type: this.ledgerQuery === "not-commit" ? "tag" : "commit", sha: value } });
    }
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
    if (path === "/git/commits" && "tree" in body && typeof body.tree === "string" && "parents" in body && Array.isArray(body.parents) && body.parents.every(p => typeof p === "string")) {
      const sha = this.addCommit(Object.fromEntries(this.files.get(body.tree) ?? []), body.parents.map(String)); return response(this.commits.get(sha), 201);
    }
    if (path === "/graphql" && "query" in body && typeof body.query === "string" && body.query.startsWith("query")) {
      // Live GitHub: Repository.ref is null for existing refs outside heads/tags.
      return response({ data: { node: { ref: null } } });
    }
    if (path === "/graphql" && "variables" in body && typeof body.variables === "object" && body.variables !== null && "input" in body.variables) {
      const input: unknown = body.variables.input;
      if (typeof input !== "object" || input === null || !("refUpdates" in input) || !Array.isArray(input.refUpdates) || !("clientMutationId" in input)) throw new Error("Invalid updateRefs");
      const updates = input.refUpdates.map((update: unknown) => {
        if (typeof update !== "object" || update === null || !("name" in update) || typeof update.name !== "string" || !("beforeOid" in update) || typeof update.beforeOid !== "string" || !("afterOid" in update) || typeof update.afterOid !== "string" || !("force" in update)) throw new Error("Invalid exact update");
        assert.equal(update.force, false);
        return { name: update.name, before: update.beforeOid, after: update.afterOid };
      });
      if (this.mutation === "failed") throw new Error("network error with token SHOULD_NOT_ESCAPE");
      const current = (name: string) => name === "refs/heads/main" ? this.head : this.refs.get(name) ?? "0".repeat(40);
      if (this.mutation === "rejected" || updates.some(update => current(update.name) !== update.before)) return response({ errors: [{ message: "generic error" }] });
      for (const update of updates) {
        if (update.name === "refs/heads/main") this.head = update.after; else this.refs.set(update.name, update.after);
      }
      if (this.mutation === "lost-later") this.head = this.addCommit({ "note.md": file("later revert") }, this.head);
      if (this.mutation === "lost" || this.mutation === "lost-later") throw new Error("lost response");
      if (this.mutation === "error-after") return response({ errors: [{ message: "Something went wrong" }] });
      return response({ data: { updateRefs: { clientMutationId: input.clientMutationId } } });
    }
    throw new Error(`Unhandled ${request.method} ${path}`);
  }
}
const INSTALLATION = "0f8a6e3c-1b2d-4c5e-8f90-123456789abc";
const LEDGER = `refs/vault-sync/devices/${INSTALLATION}`;
const L = { anchor: null, operation: "publish-1" };
function client(api: FakeGitHub, token: () => Promise<string> = async () => "SHOULD_NOT_ESCAPE", installation = INSTALLATION, scopeRules?: "visible-only" | "config/1", configDir?: string): GitHubRepository {
  return new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token, installation, now: () => 1_000_000, scopeRules, configDir });
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
  const candidate = await repo.prepare(parent, { "notes/42.md": file("changed") }, "one file", L);
  // The candidate and its ledger receipt are each independently reread once.
  assert.deepEqual(objectGets(api), { commits: 2, trees: 1, blobs: 0, refs: 0 });
  assert.equal(api.requests.filter(r => r.method === "POST" && r.url.endsWith("/git/blobs")).length, 1);
  api.requests = [];
  assert.deepEqual(await repo.readCommit(candidate.oid), { oid: candidate.oid, treeOid: candidate.treeOid, files: candidate.files });
  assert.equal(api.requests.length, 0, "verified uploaded blob and candidate tree/commit should be reusable");
  api.head = api.addCommit({ ...initial, "notes/42.md": file("remote changed") });
  api.requests = [];
  const delta = await repo.head();
  assert.equal(delta.files["notes/42.md"].data, file("remote changed").data);
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 1, refs: 1 });
});
function trackBlobReads(api: FakeGitHub): { maximum: () => number } {
  const original = api.request.bind(api);
  let active = 0, maximum = 0;
  api.request = async request => {
    const read = request.method === "GET" && request.url.includes("/git/blobs/");
    if (read) { active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => setImmediate(resolve)); }
    try { return await original(request); } finally { if (read) active--; }
  };
  return { maximum: () => maximum };
}
test("657-file first read downloads at most four blobs at once and reports progress", async () => {
  const initial = Object.fromEntries(Array.from({ length: 657 }, (_, i) => [`notes/${i}.md`, file(`note ${i}`)]));
  const api = new FakeGitHub(initial), tracker = trackBlobReads(api), progress: [number, number][] = [];
  const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION, onReadProgress: (done, total) => { progress.push([done, total]); } });
  const head = await repo.head();
  assert.equal(Object.keys(head.files).length, 657);
  assert.equal(tracker.maximum(), 4);
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 657, refs: 1 });
  assert.deepEqual(progress, Array.from({ length: 658 }, (_, i) => [i, 657]));
  api.requests = []; progress.length = 0;
  assert.deepEqual(await repo.head(), head);
  assert.deepEqual(objectGets(api), { commits: 0, trees: 0, blobs: 0, refs: 1 });
  assert.deepEqual(progress, [], "no progress when nothing downloads");
});
test("a failed blob read rejects without a partial snapshot and stops starting new reads", async () => {
  const initial = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n${i}.md`, file(`note ${i}`)]));
  const api = new FakeGitHub(initial), bad = file("note 10").oid;
  trackBlobReads(api);
  api.intercept = r => r.url.endsWith(`/git/blobs/${bad}`) ? response({ message: "boom" }, 500) : undefined;
  const repo = client(api);
  await assert.rejects(repo.head(), error => error instanceof GitHubError && error.status === 500);
  const attempted = objectGets(api).blobs;
  assert.ok(attempted < 40, `stopped after failure (${attempted} reads)`);
  api.intercept = undefined; api.requests = [];
  const head = await repo.head();
  assert.equal(Object.keys(head.files).length, 40);
  assert.equal(objectGets(api).blobs, 40 - (attempted - 1), "verified blobs from the failed attempt are reused");
});
test("a snapshot over the LRU budget polls with one ref read, resists mutation and still sees remote changes", async () => {
  // 9 x 6 MiB = 54 MiB decoded, about 144 MiB of retained base64 accounting.
  const initial = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`large/${i}.bin`, file(Buffer.alloc(6 * 1024 * 1024, i))]));
  const api = new FakeGitHub(initial), repo = client(api);
  const first = await repo.head();
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 9, refs: 1 });
  first.files["large/0.bin"].data = file("forged").data;
  for (let i = 0; i < 3; i++) {
    api.requests = [];
    const again = await repo.head();
    assert.equal(again.files["large/0.bin"].data, initial["large/0.bin"].data);
    assert.deepEqual(objectGets(api), { commits: 0, trees: 0, blobs: 0, refs: 1 });
  }
  api.head = api.addCommit({ ...initial, "large/3.bin": file("remote edit") }, api.head);
  api.requests = [];
  const changed = await repo.head();
  assert.equal(changed.oid, api.head);
  assert.equal(changed.files["large/3.bin"].data, file("remote edit").data);
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 1, refs: 1 });
});
test("checkAccess is two fresh GETs with no blob reads or mutations, and surfaces auth and branch failures", async () => {
  const api = new FakeGitHub(), repo = client(api);
  await repo.checkAccess();
  assert.equal(api.requests.length, 2);
  assert.ok(api.requests.every(r => r.method === "GET" && !r.url.includes("/git/blobs/")));
  api.intercept = r => r.url.includes("/git/ref/heads/") ? response({ message: "Not Found" }, 404) : undefined;
  await assert.rejects(repo.checkAccess(), /branch missing/);
  api.intercept = () => response({ message: "Bad credentials" }, 401);
  await assert.rejects(repo.checkAccess(), error => error instanceof GitHubError && error.status === 401);
  assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
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
test("mutable branch reads bypass a URL cache while ancestry still checks the new head", async () => {
  const api = new FakeGitHub({ "note.md": file("base") });
  const cachedRefs = new Map<string, GitHubResponse>();
  const transport: GitHubTransport = {
    async request(request) {
      if (request.method !== "GET" || !new URL(request.url).pathname.includes("/git/ref/heads/")) return api.request(request);
      const cached = cachedRefs.get(request.url);
      if (cached) return cached;
      const result = await api.request(request);
      cachedRefs.set(request.url, result);
      return result;
    },
  };
  const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport, token: async () => "t", installation: INSTALLATION });
  const before = await repo.head();
  api.head = api.addCommit({ "note.md": file("new") }, before.oid);
  const after = await repo.head();
  assert.equal(after.oid, api.head);
  assert.equal(await repo.isAncestor(before.oid, after.oid), true);
  const refReads = api.requests.filter(request => new URL(request.url).pathname.includes("/git/ref/heads/"));
  assert.equal(refReads.length, 2, "each mutable branch read must reach the transport");
  assert.notEqual(refReads[0]?.url, refReads[1]?.url);
  for (const request of refReads) {
    assert.equal(request.headers["Cache-Control"], "no-cache");
    assert.equal(request.headers.Pragma, "no-cache");
  }
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
  await assert.rejects(repo.prepare(parent, {}, "forged parent", L), /Parent snapshot mismatch/);
  parent.oid = "a".repeat(40); parent.treeOid = "b".repeat(40);
  const fresh = await repo.head();
  assert.equal(fresh.oid, expected.oid); assert.equal(fresh.treeOid, expected.treeOid);
  assert.deepEqual({ ...fresh.files }, expected.files);
  const change = file("new"), candidate = await repo.prepare(fresh, { "new.md": change }, "valid parent", L);
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
  await assert.rejects(repo.prepare(parent, {}, "forged create acknowledgment", L), /Prepared commit identity mismatch/);
  assert.equal(objectGets(api).commits, 1);
  assert.equal(api.head, parent.oid);
});
test("prepare preserves excluded paths, binaries, modes and parent without advancing ref", async () => {
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
  const changes = { "note.md": file("\ufeff日本語\r\n"), "media/binary.bin": file(Uint8Array.from([0, 128, 255])), "scripts/run.sh": file("#!/bin/sh\n", "100755") };
  const candidate = await repo.prepare(parent, changes, "roundtrip", L);
  assert.equal(api.head, parent.oid); assert.deepEqual(candidate.files, Object.assign(Object.create(null), changes));
  const stored = api.files.get(candidate.treeOid); assert.equal(stored?.get(".obsidian/config.json")?.oid, file("secret config").oid);
  assert.equal(stored?.get("nested/.cache/skip")?.oid, file("skip").oid);
  assert.deepEqual(await repo.readCommit(candidate.oid), { oid: candidate.oid, treeOid: candidate.treeOid, files: candidate.files });
  assert.equal(await repo.publish({ parent: parent.oid, candidate: candidate.oid, anchor: null, receipt: candidate.receipt }), "acknowledged");
  assert.equal(api.head, candidate.oid);
  const mutation = api.requests.find(r => r.url.endsWith("graphql")); assert.ok(mutation?.body?.includes(`"beforeOid":"${parent.oid}"`));
  assert.ok(api.requests.filter(r => r.method === "POST").every(r => !r.url.includes("/git/refs")));
});
test("an empty change set prepares a same-tree fence without creating a tree and publishes through the ledger", async () => {
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
  api.requests = [];
  const fence = await repo.prepare(parent, {}, "fence", { anchor: null, operation: "fence-1" });
  assert.ok(!api.requests.some(r => r.method === "POST" && r.url.endsWith("/git/trees")), "GitHub rejects an empty tree edit list");
  assert.equal(fence.treeOid, parent.treeOid);
  assert.notEqual(fence.oid, parent.oid);
  assert.deepEqual(api.commits.get(fence.oid)!.parents, [{ sha: parent.oid }]);
  assert.deepEqual(Object.keys(fence.files), Object.keys(parent.files));
  assert.equal(await repo.publish({ parent: parent.oid, candidate: fence.oid, anchor: null, receipt: fence.receipt }), "acknowledged");
  assert.equal(api.head, fence.oid);
  assert.deepEqual(await repo.readLedger(), { kind: "present", value: fence.receipt });
});
test("deletes only visible paths and supports executable mode-only edits", async () => {
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
  const candidate = await repo.prepare(parent, { "note.md": null, "run.sh": file("run", "100755") }, "delete and executable", L);
  assert.equal(candidate.files["note.md"], undefined); assert.equal(candidate.files["run.sh"].mode, "100755");
});
for (const path of ["../note", "/note", "a//b", "a/../b", "a\\b", "C:note", "a\0b", "a.", "CON.md", "a/．", "a/ｂ／c", "a/\ud800", ".hidden", "a/.hidden/note"]) {
  test(`rejects unsafe or excluded change ${JSON.stringify(path)} before uploads`, async () => {
    const api = new FakeGitHub(); const repo = client(api), parent = await repo.head();
    await assert.rejects(repo.prepare(parent, { [path]: file("new") }, "bad", L), GitHubError);
    assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  });
}
test("rejects case, Unicode, prefix and file/directory collisions before uploads", async () => {
  const cases: Changes[] = [{ "Note.md": file("x") }, { "é.md": file("x"), "e\u0301.md": file("y") }, { "Foo/a": file("a"), "foo/b": file("b") }, { "dir": file("a"), "dir/file": file("b") }, { "STRASSE": file("a"), "straße": file("b") }];
  for (const changes of cases) {
    const api = new FakeGitHub(); const repo = client(api);
    await assert.rejects(repo.prepare(await repo.head(), changes, "bad", L), /collision/);
    assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  }
});
test("rejects forged parent, hash mismatch, noncanonical base64 and LFS before uploads", async () => {
  for (const next of [{ ...file("x"), oid: "a".repeat(40) }, { ...file("x"), data: "eA==\n" }, file("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n")]) {
    const api = new FakeGitHub(); const repo = client(api);
    await assert.rejects(repo.prepare(await repo.head(), { "note.md": next }, "bad", L), GitHubError);
    assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  }
  const api = new FakeGitHub(); const repo = client(api), parent = await repo.head(); parent.files["note.md"] = file("forged");
  await assert.rejects(repo.prepare(parent, {}, "bad", L), /Parent snapshot/);
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
test("refuses an uploaded blob hash mismatch before creating any tree or commit", async () => {
  const api = new FakeGitHub(); api.intercept = r => r.method === "POST" && r.url.endsWith("/git/blobs") ? response({ sha: "b".repeat(40) }, 201) : undefined;
  const repo = client(api); await assert.rejects(repo.prepare(await repo.head(), { "a": file("a"), "b": file("b") }, "bad", L), /Uploaded blob hash/);
  const posts = api.requests.filter(r => r.method === "POST");
  assert.ok(posts.length >= 1 && posts.length <= 2);
  assert.ok(posts.every(r => r.url.endsWith("/git/blobs")), "no tree, commit or ref request follows a failed upload");
});
test("prepare creates a receipt with parents [anchor?, candidate] and the candidate tree, never moving refs", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  const first = await repo.prepare(parent, { "note.md": file("new") }, "first", L);
  const receipt = api.commits.get(first.receipt)!;
  assert.deepEqual(receipt.parents.map(p => p.sha), [first.oid]);
  assert.equal(receipt.tree.sha, first.treeOid);
  const anchored = await repo.prepare(parent, { "note.md": file("other") }, "anchored", { anchor: first.receipt, operation: "publish-2" });
  assert.deepEqual(api.commits.get(anchored.receipt)!.parents.map(p => p.sha), [first.receipt, anchored.oid]);
  assert.equal(api.head, parent.oid);
  assert.equal(api.refs.size, 0);
  await assert.rejects(repo.prepare(parent, {}, "bad", { anchor: "zz", operation: "publish-3" }), GitHubError);
  await assert.rejects(repo.prepare(parent, {}, "bad", { anchor: null, operation: "line\nbreak" }), /operation label/);
});
test("publication atomically moves branch and ledger; a stale CAS moves neither and proves nothing", async () => {
  const api = new FakeGitHub(), a = client(api), b = client(api, undefined, "11111111-2222-4333-8444-555555555555"), parent = await a.head();
  const left = await a.prepare(parent, { "a": file("a") }, "left", L), right = await b.prepare(parent, { "b": file("b") }, "right", L);
  const results = await Promise.all([
    a.publish({ parent: parent.oid, candidate: left.oid, anchor: null, receipt: left.receipt }),
    b.publish({ parent: parent.oid, candidate: right.oid, anchor: null, receipt: right.receipt }),
  ]);
  assert.deepEqual(results.sort(), ["acknowledged", "unconfirmed"]);
  const winner = results[0] === "acknowledged" ? a : b;
  assert.deepEqual(await winner.readLedger(), { kind: "present", value: winner === a ? left.receipt : right.receipt });
  assert.deepEqual(await (winner === a ? b : a).readLedger(), { kind: "absent" }, "the loser's ledger did not move");
  const update = JSON.parse(api.requests.filter(r => r.url.endsWith("graphql") && r.body?.includes("updateRefs")).at(-1)!.body!);
  assert.deepEqual(update.variables.input.refUpdates.map((u: { name: string; beforeOid: string; force: boolean }) => [u.name, u.beforeOid, u.force]).sort(), [
    ["refs/heads/main", parent.oid, false],
    [winner === a ? "refs/vault-sync/devices/11111111-2222-4333-8444-555555555555" : LEDGER, "0".repeat(40), false],
  ].sort());
});
for (const mode of ["lost", "lost-later", "failed", "rejected", "error-after"] as const) {
  test(`publication ${mode} never infers a verdict from the response or branch`, async () => {
    const api = new FakeGitHub(), repo = client(api), parent = await repo.head(), candidate = await repo.prepare(parent, { "note.md": file("new") }, "new", L);
    api.mutation = mode;
    const input = { parent: parent.oid, candidate: candidate.oid, anchor: null, receipt: candidate.receipt };
    if (mode === "lost" || mode === "lost-later" || mode === "failed") await assert.rejects(repo.publish(input), error => error instanceof GitHubError && !error.message.includes("SHOULD_NOT_ESCAPE"));
    else assert.equal(await repo.publish(input), "unconfirmed");
    const landed = mode !== "failed" && mode !== "rejected";
    assert.deepEqual(await repo.readLedger(), landed ? { kind: "present", value: candidate.receipt } : { kind: "absent" }, "only the ledger read decides");
  });
}
test("seals extend exactly the anchor, use the parent tree, and race delayed publication on the ledger", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  const candidate = await repo.prepare(parent, { "note.md": file("new") }, "new", L);
  const seal = await repo.createSeal({ anchor: null, parent: parent.oid, operation: "publish-1" });
  assert.deepEqual(api.commits.get(seal)!.parents, []);
  assert.equal(api.commits.get(seal)!.tree.sha, parent.treeOid);
  await repo.seal({ anchor: null, seal });
  assert.deepEqual(await repo.readLedger(), { kind: "present", value: seal });
  assert.equal(await repo.publish({ parent: parent.oid, candidate: candidate.oid, anchor: null, receipt: candidate.receipt }), "unconfirmed");
  assert.equal(api.head, parent.oid, "the sealed publication can never land");
  const next = await repo.prepare(parent, { "note.md": file("again") }, "again", { anchor: seal, operation: "publish-2" });
  const lateSeal = await repo.createSeal({ anchor: seal, parent: parent.oid, operation: "publish-2" });
  assert.deepEqual(api.commits.get(lateSeal)!.parents.map(p => p.sha), [seal]);
  assert.equal(await repo.publish({ parent: parent.oid, candidate: next.oid, anchor: seal, receipt: next.receipt }), "acknowledged");
  await repo.seal({ anchor: seal, seal: lateSeal });
  assert.deepEqual(await repo.readLedger(), { kind: "present", value: next.receipt }, "the publication winner prevents the late seal");
  await assert.rejects(repo.seal({ anchor: null, seal: lateSeal }), /exactly the anchor/);
});
test("publication refuses mismatched receipts and candidates before any mutation", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  const candidate = await repo.prepare(parent, { "note.md": file("new") }, "new", L);
  await assert.rejects(repo.publish({ parent: parent.oid, candidate: parent.oid, anchor: null, receipt: candidate.receipt }), /exactly the expected/);
  await assert.rejects(repo.publish({ parent: parent.oid, candidate: candidate.oid, anchor: "a".repeat(40), receipt: candidate.receipt }), /Receipt must record/);
  await assert.rejects(repo.publish({ parent: parent.oid, candidate: candidate.oid, anchor: null, receipt: candidate.oid }), /Receipt must record/);
  assert.equal(api.requests.filter(r => r.body?.includes("updateRefs")).length, 0);
  assert.equal(api.head, parent.oid);
});
test("ledger reads are fresh exact-ref REST GETs, not GraphQL (null for custom refs), and fail closed on malformed answers", async () => {
  const api = new FakeGitHub(); const repo = client(api);
  assert.equal(repo.ledgerRef(), LEDGER);
  assert.deepEqual(await repo.readLedger(), { kind: "absent" });
  const first = api.requests.at(-1)!;
  assert.ok(first.method === "GET" && new URL(first.url).pathname === `/repos/owner/repo/git/ref/vault-sync/devices/${INSTALLATION}`);
  assert.equal(first.headers["Cache-Control"], "no-cache");
  api.refs.set(LEDGER, "c".repeat(40));
  assert.deepEqual(await repo.readLedger(), { kind: "present", value: "c".repeat(40) }, "present via REST although GraphQL reports null");
  assert.notEqual(api.requests.at(-1)!.url, first.url, "every read has a unique URL");
  assert.ok(!api.requests.some(r => r.url.endsWith("/graphql")), "GraphQL never decides the ledger");
  api.ledgerQuery = "other-ref";
  await assert.rejects(repo.readLedger(), /another ref/);
  api.ledgerQuery = "not-commit";
  await assert.rejects(repo.readLedger(), /commit/);
  api.ledgerQuery = "prefix-list";
  assert.deepEqual(await repo.readLedger(), { kind: "absent" }, "a prefix list without the exact ref is absence");
  api.ledgerQuery = "normal";
  api.intercept = r => r.url.includes("/git/ref/vault-sync/") ? response([{ ref: LEDGER, object: { type: "commit", sha: "c".repeat(40) } }]) : undefined;
  await assert.rejects(repo.readLedger(), /Ambiguous/);
  api.intercept = r => r.url.includes("/git/ref/vault-sync/") ? response({ ref: LEDGER }) : undefined;
  await assert.rejects(repo.readLedger(), /Malformed/);
  api.intercept = r => r.url.includes("/git/ref/vault-sync/") ? response({}, 500) : undefined;
  await assert.rejects(repo.readLedger(), error => error instanceof GitHubError && error.status === 500);
  api.intercept = r => r.url.includes("/git/ref/vault-sync/") ? response({}, 429, { "retry-after": "120" }) : undefined;
  await assert.rejects(repo.readLedger(), error => error instanceof GitHubError && error.retryAt === 1_120_000);
});
test("the installation identity is required and validated; there is no default ledger", async () => {
  const api = new FakeGitHub();
  for (const installation of ["", "default", "0F8A6E3C-1B2D-4C5E-8F90-123456789ABC", "0f8a6e3c-1b2d-4c5e-8f90-123456789abc/x", undefined]) {
    assert.throws(() => new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: installation as string }), /installation identity/);
  }
});
test("ancestry fails on uncertainty", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
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
  const candidate = await repo.prepare(parent, { "large.bin": file(bytes, "100755") }, "large mode change", L);
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
    await assert.rejects(repo.prepare(parent, { "new.md": file("new") }, "corrupt object", L), GitHubError);
    assert.equal(api.head, parent.oid);
  }
});
test("rejects oversized outgoing entries, incorrect parent tree and invalid repository coordinates", async () => {
  const api = new FakeGitHub(), repo = client(api), parent = await repo.head();
  await assert.rejects(repo.prepare(parent, { "big": file(Buffer.alloc(8 * 1024 * 1024 + 1)) }, "too large", L), /oversized/);
  await assert.rejects(repo.prepare({ ...parent, treeOid: "a".repeat(40) }, {}, "forged", L), /Parent tree/);
  assert.equal(api.requests.filter(r => r.method === "POST").length, 0);
  assert.throws(() => new GitHubRepository({ owner: "..", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION }), /coordinates/);
});

test("blob uploads within preparation run at most four at a time, once per distinct blob, before the tree", async () => {
  const api = new FakeGitHub(); const original = api.request.bind(api);
  let active = 0, maximum = 0, treeAfterUploads = true;
  api.request = async request => {
    const transfer = request.url.includes("/git/blobs");
    if (request.url.endsWith("/git/trees") && active > 0) treeAfterUploads = false;
    if (transfer) { active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => setImmediate(resolve)); }
    try { return await original(request); } finally { if (transfer) active--; }
  };
  const repo = client(api);
  const changes: Changes = { "copy.bin": file("same"), "same.bin": file("same") };
  for (let index = 0; index < 9; index++) changes[`f${index}.bin`] = file(`body ${index}`);
  const prepared = await repo.prepare(await repo.head(), changes, "parallel uploads", L);
  assert.equal(maximum, 4);
  assert.equal(api.requests.filter(r => r.method === "POST" && r.url.endsWith("/git/blobs")).length, 10);
  assert.ok(treeAfterUploads);
  for (const [path, entry] of Object.entries(changes)) assert.equal(prepared.files[path]?.oid, entry!.oid);
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

test("file history pins pagination to a commit and safely encodes the file path", async () => {
  const api = new FakeGitHub(), repo = client(api), originalHead = api.head;
  const metadata = (index: number) => ({ sha: index.toString(16).padStart(40, "0"), commit: { message: `Version ${index}\nDetails`, author: { name: "Writer", date: "2026-10-13T12:00:00Z" } } });
  api.intercept = request => {
    const url = new URL(request.url);
    if (url.pathname !== "/repos/owner/repo/commits") return undefined;
    assert.equal(url.searchParams.get("sha"), originalHead);
    assert.equal(url.searchParams.get("path"), "Notes/a & b.md");
    return response(url.searchParams.get("page") === "1" ? Array.from({length: 30}, (_, i) => metadata(i + 1)) : [metadata(31)]);
  };
  const first = await repo.history({ path: "Notes/a & b.md" });
  assert.equal(first.at, originalHead); assert.equal(first.entries.length, 30); assert.equal(first.nextPage, 2);
  assert.deepEqual(first.entries[0], { commit: "1".padStart(40, "0"), message: "Version 1\nDetails", author: "Writer", date: "2026-10-13T12:00:00Z" });
  api.head = api.addCommit({ "note.md": file("changed") }, api.head);
  const second = await repo.history({path: "Notes/a & b.md", at: first.at, page: 2});
  assert.equal(second.entries.length, 1); assert.equal(second.nextPage, null);
  assert.equal(api.requests.filter(request => request.url.includes("/git/ref/")).length, 1);
});
test("history rejects unsafe paths, unpinned later pages and malformed metadata", async () => {
  const api = new FakeGitHub(), repo = client(api);
  for (const path of ["", ".obsidian/settings.json", "../note.md"]) await assert.rejects(repo.history({path}));
  await assert.rejects(repo.history({path: "note.md", page: 2}), /history page/);
  assert.equal(api.requests.length, 0);
  api.intercept = request => new URL(request.url).pathname === "/repos/owner/repo/commits" ? response([{sha: "a".repeat(40), commit: { message: "broken", author: { name: "author", date: "not-a-date" } }}]) : undefined;
  await assert.rejects(repo.history({path: "note.md"}), /history date/);
});

test("config scope reads tracked eligible hidden files while preserving ignored and denied tree entries", async () => {
  const initial = {
    ".gitignore": file(".gitignore\n.obsidian/plugins/vikalp/data.json\n.obsidian/cache/\n"),
    "note.md": file("note"),
    ".obsidian/appearance.json": file("{\"theme\":\"dark\"}"),
    ".obsidian/plugins/vikalp/main.js": file("plugin", "100755"),
    ".obsidian/plugins/vikalp/data.json": file("private tracked bytes"),
    ".obsidian/cache/index": file("cache"),
    ".obsidian/workspace.json": file("workspace"),
    ".obsidian/plugins/obsidian-git/main.js": file("competing"),
    ".obsidian/plugins/github-vault-sync/data.json": file("device secret"),
  };
  const api = new FakeGitHub(initial), repo = client(api, undefined, INSTALLATION, "config/1");
  const snapshot = await repo.head();
  assert.deepEqual(Object.keys(snapshot.files).sort(), [".gitignore", ".obsidian/appearance.json", ".obsidian/plugins/vikalp/main.js", "note.md"].sort());
  assert.equal(await repo.readRootGitignore(snapshot.oid), Buffer.from(initial[".gitignore"].data, "base64").toString());
  const scope = await repo.scopeFor(snapshot.oid);
  assert.equal(scope.rules.gitignore, initial[".gitignore"].oid);
  assert.equal(scope.classify(".obsidian/plugins/vikalp/data.json"), "ignored");
  assert.equal(scope.classify(".obsidian/plugins/obsidian-git/main.js"), "denied");
  assert.equal(scope.classify(".gitignore"), "config-inert", "root control file cannot ignore itself");
  const legacy = await client(api).head();
  assert.deepEqual(Object.keys(legacy.files), ["note.md"], "default is still visible-only");
});

test("prepare retains every excluded parent terminal exactly and returns the candidate's new policy", async () => {
  const initial = {
    ".gitignore": file(".obsidian/cache/\n"),
    "note.md": file("note"),
    ".obsidian/config.json": file("tracked config"),
    ".obsidian/cache/index": file("ignored bytes", "100755"),
    ".obsidian/plugins/obsidian-git/main.js": file("denied bytes"),
  };
  const api = new FakeGitHub(initial), repo = client(api, undefined, INSTALLATION, "config/1");
  const parent = await repo.head();
  const candidate = await repo.prepare(parent, { ".gitignore": file(".obsidian/cache/\n.obsidian/config.json\n"), "note.md": file("edited") }, "scope update", L);
  assert.deepEqual(Object.keys(candidate.files).sort(), [".gitignore", "note.md"]);
  assert.equal(candidate.files["note.md"].oid, file("edited").oid);
  const parentTree = api.files.get(parent.treeOid)!;
  const candidateTree = api.files.get(candidate.treeOid)!;
  for (const path of [".obsidian/config.json", ".obsidian/cache/index", ".obsidian/plugins/obsidian-git/main.js"]) {
    assert.deepEqual(candidateTree.get(path), parentTree.get(path), `${path} is preserved with its exact bytes and mode`);
  }
  for (const path of [".obsidian/cache", ".obsidian/plugins/obsidian-git"]) {
    assert.deepEqual(api.trees.get(candidate.treeOid)!.tree.find(item => item.path === path),
      api.trees.get(parent.treeOid)!.tree.find(item => item.path === path), `${path} tree identity is preserved`);
  }
  assert.equal((await repo.scopeFor(candidate.oid)).includes(".obsidian/config.json"), false);
  assert.deepEqual((await repo.readCommit(candidate.oid)).files, candidate.files);
  assert.equal(api.head, parent.oid);
});

const firstConfigCases: Snapshot[] = [
  { ".obsidian/workspace.json": file("workspace"), ".obsidian/plugins/github-vault-sync/data.json": file("device secret"), "note.md": file("safe") },
  { "note.md": file("safe") },
];
for (const initial of firstConfigCases) {
  test(`first eligible config file can be added with ${Object.keys(initial).length === 1 ? "a new" : "an excluded-only"} config directory`, async () => {
    const api = new FakeGitHub(initial), repo = client(api, undefined, INSTALLATION, "config/1");
    const parent = await repo.head();
    const candidate = await repo.prepare(parent, { ".obsidian/appearance.json": file("new config") }, "add configuration", L);
    assert.equal(candidate.files[".obsidian/appearance.json"].oid, file("new config").oid);
    const parentFiles = api.files.get(parent.treeOid)!;
    const candidateFiles = api.files.get(candidate.treeOid)!;
    for (const path of [".obsidian/workspace.json", ".obsidian/plugins/github-vault-sync/data.json"]) {
      assert.deepEqual(candidateFiles.get(path), parentFiles.get(path), `${path} remains exact`);
    }
    assert.equal(api.head, parent.oid);
  });
}

test("a forged candidate changing excluded terminal bytes is refused while adding first config file", async () => {
  const path = ".obsidian/workspace.json";
  const api = new FakeGitHub({ [path]: file("workspace"), "note.md": file("safe") });
  const original = api.request.bind(api);
  api.request = async request => {
    const result = await original(request);
    if (request.method !== "POST" || !request.url.endsWith("/git/trees")) return result;
    const treeOid = (result.json as { sha: string }).sha;
    const forgedFiles = new Map(api.files.get(treeOid));
    forgedFiles.set(path, file("tampered workspace"));
    const forgedTree = tree(forgedFiles);
    api.trees.set(forgedTree.sha, forgedTree);
    api.files.set(forgedTree.sha, forgedFiles);
    return response({ sha: forgedTree.sha }, 201);
  };
  const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
  await assert.rejects(repo.prepare(parent, { ".obsidian/appearance.json": file("new config") }, "forged", L),
    /Prepared tree changed excluded repository paths/);
  assert.equal(api.requests.filter(request => request.method === "POST" && request.url.endsWith("/git/commits")).length, 0);
  assert.equal(api.head, parent.oid);
});

test("a new local ignore rule rejects changes it excludes before uploading or deleting", async () => {
  for (const changed of [file("new private bytes"), null]) {
    const api = new FakeGitHub({ ".gitignore": file(""), "note.md": file("base"), ".obsidian/plugins/vikalp/data.json": file("old") });
    const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
    await assert.rejects(repo.prepare(parent, {
      ".gitignore": file(".obsidian/plugins/vikalp/data.json\n"),
      ".obsidian/plugins/vikalp/data.json": changed,
    }, "unsafe policy edit", L), /excluded by candidate/);
    assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
    assert.equal(api.files.get(parent.treeOid)!.get(".obsidian/plugins/vikalp/data.json")!.oid, file("old").oid);
  }
});

test("ambiguous candidate ignore text is rejected before any secret blob POST", async () => {
  const path = ".obsidian/plugins/custom/data.json";
  for (const pattern of [`${path}\n\ufeff!${path}\n`, `${path}\0garbage\n`]) {
    const api = new FakeGitHub({ ".gitignore": file(""), [path]: file("tracked baseline"), "note.md": file("safe") });
    const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
    await assert.rejects(repo.prepare(parent, { ".gitignore": file(pattern), [path]: file("synthetic private change") }, "unsafe policy", L), ScopeError);
    assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
    assert.equal(api.head, parent.oid);
  }
});

test("an ambiguous committed ignore policy blocks capture before hidden blob reads", async () => {
  const path = ".obsidian/plugins/custom/data.json", secret = file("synthetic private bytes");
  for (const pattern of [`${path}\n\ufeff!${path}\n`, `${path}\0garbage\n`]) {
    const api = new FakeGitHub({ ".gitignore": file(pattern), [path]: secret, "note.md": file("safe") });
    const repo = client(api, undefined, INSTALLATION, "config/1");
    await assert.rejects(repo.head(), ScopeError);
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0);
    assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
  }
});

test("included paths and ancestors cannot alias ignored paths in a verified tree", async () => {
  const cases = [
    [".obsidian/plugins/custom/Data.json", ".obsidian/plugins/custom/data.json"],
    [".obsidian/Plugins/custom/private.json", ".obsidian/plugins/custom/main.js"],
    [".obsidian/plugins/custom/e\u0301.json", ".obsidian/plugins/custom/é.json"],
  ] as const;
  for (const [excluded, included] of cases) {
    const secret = file("synthetic excluded bytes");
    const api = new FakeGitHub({ ".gitignore": file(`${excluded}\n`), [excluded]: secret, [included]: file("included") });
    const repo = client(api, undefined, INSTALLATION, "config/1");
    await assert.rejects(repo.head(), /collision/);
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0,
      `excluded bytes were read for ${excluded}`);
  }
});

test("proposed full namespace rejects an included alias before any blob POST", async () => {
  const cases = [
    [".obsidian/plugins/custom/Data.json", ".obsidian/plugins/custom/data.json"],
    [".obsidian/Plugins/custom/private.json", ".obsidian/plugins/custom/main.js"],
    [".obsidian/plugins/custom/e\u0301.json", ".obsidian/plugins/custom/é.json"],
  ] as const;
  for (const [excluded, added] of cases) {
    const secret = file("synthetic excluded bytes");
    const api = new FakeGitHub({ ".gitignore": file(`${excluded}\n`), [excluded]: secret, "note.md": file("safe") });
    const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
    await assert.rejects(repo.prepare(parent, { [added]: file("new included bytes") }, "alias", L), /collision/);
    assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0);
    assert.equal(api.files.get(parent.treeOid)!.get(excluded)!.oid, secret.oid);
  }
});

test("a candidate ignore edit that unignores aliases fails before every POST", async () => {
  const first = ".obsidian/plugins/custom/Data.json", second = ".obsidian/plugins/custom/data.json";
  const privateA = file("synthetic private A"), privateB = file("synthetic private B");
  const api = new FakeGitHub({ ".gitignore": file(`${first}\n${second}\n`), [first]: privateA, [second]: privateB, "note.md": file("safe") });
  const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
  await assert.rejects(repo.prepare(parent, { ".gitignore": file("") }, "unignore aliases", L), /collision/);
  assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
  for (const secret of [privateA, privateB])
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0);
});

test("removed parent directories do not block case and Unicode directory renames", async () => {
  const cases = [
    ["Folder/note.md", "folder/note.md"],
    ["café/note.md", "cafe\u0301/note.md"],
    [".obsidian/snippets/Custom/theme.css", ".obsidian/snippets/custom/theme.css"],
  ] as const;
  for (const [from, to] of cases) {
    const original = file("unchanged");
    const api = new FakeGitHub({ [from]: original }), repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
    const candidate = await repo.prepare(parent, { [from]: null, [to]: original }, "rename", L);
    assert.deepEqual(Object.keys(candidate.files), [to]);
    assert.deepEqual(Array.from(api.files.get(candidate.treeOid)!.keys()), [to]);
  }
});

test("a genuinely empty preserved tree still blocks an included directory alias", async () => {
  const note = file("safe"), api = new FakeGitHub({ "note.md": note });
  const emptyTree = hash("tree", Buffer.alloc(0));
  const rootBody = Buffer.concat([
    Buffer.from("40000 Empty\0"), Buffer.from(emptyTree, "hex"),
    Buffer.from("100644 note.md\0"), Buffer.from(note.oid, "hex"),
  ]);
  const rootTree = hash("tree", rootBody);
  api.trees.set(rootTree, { sha: rootTree, truncated: false, tree: [
    { path: "Empty", mode: "040000", type: "tree", sha: emptyTree },
    { path: "note.md", mode: "100644", type: "blob", sha: note.oid, size: 4 },
  ] });
  api.files.set(rootTree, new Map([["note.md", note]]));
  api.commits.get(api.head)!.tree.sha = rootTree;
  const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
  await assert.rejects(repo.prepare(parent, { "empty/new.md": file("new") }, "unsafe alias", L), /collision/);
  assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
});

test("canonical aliases of root and nested ignore controls block GitHub reads and changes", async () => {
  const hidden = ".obsidian/plugins/custom/data.json", secret = file("synthetic private bytes");
  for (const control of [".GITIGNORE", ".obsidian/plugins/custom/.GITIGNORE"]) {
    const api = new FakeGitHub({ [control]: file("data.json\n"), [hidden]: secret });
    await assert.rejects(client(api, undefined, INSTALLATION, "config/1").head(), ScopeError);
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0);
    assert.equal(api.requests.filter(request => request.method === "POST").length, 0);

    const clean = new FakeGitHub({ "note.md": file("safe") });
    const repo = client(clean, undefined, INSTALLATION, "config/1"), parent = await repo.head();
    await assert.rejects(repo.prepare(parent, { [control]: file("data.json\n") }, "control alias", L), ScopeError);
    assert.equal(clean.requests.filter(request => request.method === "POST").length, 0);
  }
});

test("an excluded-only alias namespace remains readable without downloading excluded bytes", async () => {
  const first = ".obsidian/plugins/custom/Data.json", second = ".obsidian/plugins/custom/data.json";
  const api = new FakeGitHub({ ".gitignore": file(`${first}\n${second}\n`), [first]: file("first private"), [second]: file("second private"), "note.md": file("safe") });
  const repo = client(api, undefined, INSTALLATION, "config/1"), snapshot = await repo.head();
  assert.deepEqual(Object.keys(snapshot.files).sort(), [".gitignore", "note.md"]);
  const candidate = await repo.prepare(snapshot, { "note.md": file("changed") }, "visible edit", L);
  assert.equal(candidate.files["note.md"].oid, file("changed").oid);
  assert.equal(api.files.get(candidate.treeOid)!.get(first)!.oid, file("first private").oid);
  assert.equal(api.files.get(candidate.treeOid)!.get(second)!.oid, file("second private").oid);
  for (const secret of [file("first private"), file("second private")])
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0);
});

test("a canonical self-plugin alias is excluded even when no second spelling exists", async () => {
  const protectedPath = ".obsidian/plugins/GITHUB-VAULT-SYNC/data.json", secret = file("synthetic device binding");
  const api = new FakeGitHub({ [protectedPath]: secret, "note.md": file("safe") });
  const repo = client(api, undefined, INSTALLATION, "config/1");
  const snapshot = await repo.head();
  assert.equal(snapshot.files[protectedPath], undefined);
  assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${secret.oid}`)).length, 0);
  await assert.rejects(repo.prepare(snapshot, { [protectedPath]: file("changed") }, "protected", L), /outside parent commit scope/);
  assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
});

test("denied and ignored tracked paths cannot be edited, including competing sync plugins", async () => {
  const api = new FakeGitHub({
    ".gitignore": file(".obsidian/plugins/vikalp/data.json\n"),
    ".obsidian/plugins/vikalp/data.json": file("ignored"),
    ".obsidian/plugins/obsidian-git/main.js": file("denied"),
    ".obsidian/plugins/github-vault-sync/data.json": file("self"),
    ".obsidian/workspace.json": file("live workspace"),
    "note.md": file("safe"),
  });
  const repo = client(api, undefined, INSTALLATION, "config/1"), parent = await repo.head();
  for (const path of [".obsidian/plugins/vikalp/data.json", ".obsidian/plugins/obsidian-git/main.js", ".obsidian/plugins/github-vault-sync/data.json", ".obsidian/workspace.json"]) {
    await assert.rejects(repo.prepare(parent, { [path]: null }, "forbidden", L), /outside parent commit scope/);
  }
  assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
});

test("different commits retain independent ignore policies and repeat reads reuse the pinned blob", async () => {
  const api = new FakeGitHub({ ".gitignore": file(""), "note.md": file("one"), ".obsidian/config.json": file("config") });
  const first = api.head;
  const second = api.addCommit({ ".gitignore": file(".obsidian/config.json\n"), "note.md": file("two"), ".obsidian/config.json": file("config") }, first);
  const repo = client(api, undefined, INSTALLATION, "config/1");
  assert.ok((await repo.scopeFor(first)).includes(".obsidian/config.json"));
  assert.equal((await repo.scopeFor(second)).includes(".obsidian/config.json"), false);
  assert.ok((await repo.scopeFor(first)).includes(".obsidian/config.json"));
  assert.equal((await repo.readCommit(first)).files[".obsidian/config.json"].oid, file("config").oid);
  assert.equal((await repo.readCommit(second)).files[".obsidian/config.json"], undefined);
  for (const ignoreOid of [file("").oid, file(".obsidian/config.json\n").oid]) {
    assert.equal(api.requests.filter(request => request.method === "GET" && request.url.endsWith(`/git/blobs/${ignoreOid}`)).length, 1,
      "each pinned policy blob is read only once");
  }
});

test("nested ignore rules block config activation even inside denied directories", async () => {
  const api = new FakeGitHub({ ".gitignore": file(""), ".obsidian/plugins/obsidian-git/.gitignore": file("secret\n"), "note.md": file("safe") });
  const repo = client(api, undefined, INSTALLATION, "config/1");
  await assert.rejects(repo.head(), /Nested .gitignore is unsupported/);
  await assert.rejects(repo.scopeFor(api.head), /Nested .gitignore is unsupported/);
  assert.equal(api.requests.filter(request => request.method === "POST").length, 0);
});

test("eligible hidden LFS pointers and size limits block config snapshots", async () => {
  for (const hidden of [file("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n"), file(Buffer.alloc(8 * 1024 * 1024 + 1))]) {
    const api = new FakeGitHub({ ".obsidian/plugins/vikalp/main.js": hidden, "note.md": file("safe") });
    await assert.rejects(client(api, undefined, INSTALLATION, "config/1").head(), /LFS|size limit/);
  }
});

test("hidden symlinks block when eligible and remain untouched when ignored", async () => {
  const symlink = { ...file("target"), mode: "120000" } as unknown as Entry;
  const initial = { ".gitignore": file(""), ".obsidian/plugins/vikalp/main.js": symlink, "note.md": file("safe") };
  const api = new FakeGitHub(initial), repo = client(api, undefined, INSTALLATION, "config/1");
  await assert.rejects(repo.head(), /Symlink or submodule unsupported/);
  const ignored = api.addCommit({ ...initial, ".gitignore": file(".obsidian/plugins/vikalp/main.js\n") }, api.head);
  const snapshot = await repo.readCommit(ignored);
  assert.equal(snapshot.files[".obsidian/plugins/vikalp/main.js"], undefined);
  assert.equal(api.files.get(snapshot.treeOid)!.get(".obsidian/plugins/vikalp/main.js")!.mode, "120000");
});

test("history accepts only paths in the selected commit's scope, including tracked hidden paths", async () => {
  const api = new FakeGitHub({ ".gitignore": file(".obsidian/plugins/vikalp/data.json\n"), ".obsidian/appearance.json": file("{}"), ".obsidian/plugins/vikalp/data.json": file("ignored"), "note.md": file("safe") });
  const repo = client(api, undefined, INSTALLATION, "config/1");
  api.intercept = request => new URL(request.url).pathname === "/repos/owner/repo/commits" ? response([]) : undefined;
  const history = await repo.history({ path: ".obsidian/appearance.json", at: api.head });
  assert.equal(history.at, api.head);
  assert.equal(new URL(api.requests.at(-1)!.url).searchParams.get("path"), ".obsidian/appearance.json");
  for (const path of [".obsidian/plugins/vikalp/data.json", ".obsidian/plugins/obsidian-git/main.js", "nested/.gitignore"]) {
    await assert.rejects(repo.history({ path, at: api.head }));
  }
});

test("explicit configuration directory is applied to commit scope", async () => {
  const api = new FakeGitHub({ ".gitignore": file(".vault/private.json\n"), ".vault/settings.json": file("sync"), ".vault/private.json": file("ignored"), ".obsidian/settings.json": file("other config"), "note.md": file("safe") });
  const repo = client(api, undefined, INSTALLATION, "config/1", ".vault");
  const head = await repo.head();
  assert.ok(head.files[".vault/settings.json"]);
  assert.equal(head.files[".vault/private.json"], undefined);
  assert.equal(head.files[".obsidian/settings.json"], undefined);
  assert.equal((await repo.scopeFor(head.oid)).rules.configDir, ".vault");
});

test("config client reads an ignored visible historical checkpoint under visible-only rules", async () => {
  const ignored = file("visible checkpoint bytes");
  const api = new FakeGitHub({ ".gitignore": file("drafts/\n"), "drafts/x.md": ignored, "note.md": file("base") });
  const repo = client(api, undefined, INSTALLATION, "config/1");
  assert.equal((await repo.readCommit(api.head)).files["drafts/x.md"], undefined);
  const checkpoint = await repo.readCommitForScope(api.head, "visible-only");
  assert.equal(checkpoint.files["drafts/x.md"]?.oid, ignored.oid);
  assert.equal(checkpoint.files[".gitignore"], undefined);
  assert.equal(checkpoint.treeOid, (await repo.readCommit(api.head)).treeOid);
});

test("sync history lists all files and pins pagination without a path filter", async () => {
  const api = new FakeGitHub(), repo = client(api), originalHead = api.head;
  api.intercept = request => {
    const url = new URL(request.url);
    if (url.pathname !== "/repos/owner/repo/commits") return undefined;
    assert.equal(url.searchParams.get("sha"), originalHead);
    assert.equal(url.searchParams.has("path"), false);
    return response(Array.from({ length: url.searchParams.get("page") === "1" ? 30 : 1 }, (_, i) => ({
      sha: String(i + 1).padStart(40, "0"), commit: { message: "vault backup mac (1): 6th Oct, 2026 13:08:19", author: { name: "Tushar", date: "2026-10-06T07:38:19Z" } },
    })));
  };
  const first = await repo.history({});
  assert.equal(first.nextPage, 2);
  assert.equal(first.entries[0].message, "vault backup mac (1): 6th Oct, 2026 13:08:19");
  api.head = api.addCommit({ "note.md": file("changed") }, api.head);
  assert.equal((await repo.history({ at: first.at, page: 2 })).entries.length, 1);
});

/** Serves real deflated zipballs of exact commits, like api.github.com's 302 to codeload. */
class ArchiveGitHub extends FakeGitHub {
  archives: GitHubRequest[] = [];
  redirect = false;
  /** Edits the archived files (repository path -> bytes) before zipping. */
  shape?: (files: Record<string, Uint8Array>) => void;
  archiveIntercept?: (request: GitHubRequest) => GitHubBinaryResponse | undefined;
  async requestArchive(request: GitHubRequest): Promise<GitHubBinaryResponse> {
    this.archives.push(request);
    const intercepted = this.archiveIntercept?.(request); if (intercepted) return intercepted;
    const url = new URL(request.url);
    if (url.hostname === "api.github.com" && this.redirect) return { status: 302, headers: { Location: `https://codeload.github.com/owner/repo/legacy.zip/${url.pathname.split("/").pop()}?token=SHORT` }, bytes: new Uint8Array() };
    const sha = url.pathname.split("/").pop() ?? "", commit = this.commits.get(sha);
    if (!commit) return { status: 404, headers: {}, bytes: new Uint8Array() };
    const files: Record<string, Uint8Array> = {};
    for (const [path, entry] of this.files.get(commit.tree.sha) ?? []) files[path] = Buffer.from(entry.data, "base64");
    this.shape?.(files);
    const zip: Record<string, Uint8Array> = {};
    for (const [path, bytes] of Object.entries(files)) zip[`owner-repo-${sha.slice(0, 7)}/${path}`] = bytes;
    return { status: 200, headers: { "content-type": "application/zip" }, bytes: zipSync(zip, { level: 6 }) };
  }
}
function vault(count: number, prefix = "note"): Snapshot {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`notes/${i}.md`, file(`${prefix} ${i}\n${"body ".repeat(i)}`)]));
}
function archiveClient(api: FakeGitHub, local?: Map<string, Uint8Array>, reads?: string[]): GitHubRepository {
  return new GitHubRepository({
    owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION, now: () => 1_000_000,
    ...(local ? { readLocal: async (path: string, expectedSize: number) => { reads?.push(path); const bytes = local.get(path); return bytes && bytes.length === expectedSize ? bytes : null; } } : {})
  });
}
function localCopy(snapshot: Snapshot): Map<string, Uint8Array> {
  return new Map(Object.entries(snapshot).map(([path, entry]) => [path, Buffer.from(entry.data, "base64")]));
}
test("an empty vault's first read is one zipball of the pinned commit, verified against the tree", async () => {
  const initial = { ...vault(60), ".obsidian/app.json": file("{}") };
  const api = new ArchiveGitHub(initial), progress: [number, number][] = [];
  const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION, readLocal: async () => null, onReadProgress: (done, total) => { progress.push([done, total]); } });
  const head = await repo.head();
  assert.equal(Object.keys(head.files).length, 60);
  for (const [path, entry] of Object.entries(vault(60))) assert.deepEqual(head.files[path], entry);
  assert.equal(api.archives.length, 1);
  assert.equal(new URL(api.archives[0].url).pathname, `/repos/owner/repo/zipball/${api.head}`);
  assert.equal(api.archives[0].headers.Authorization, "Bearer t");
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 0, refs: 1 });
  assert.deepEqual(progress, Array.from({ length: 61 }, (_, i) => [i, 60]));
  api.requests = []; api.archives = [];
  assert.deepEqual(await repo.head(), head);
  assert.deepEqual(objectGets(api), { commits: 0, trees: 0, blobs: 0, refs: 1 });
  assert.equal(api.archives.length, 0, "no zipball for an unchanged tree");
});
test("a redirect to codeload is followed without credentials; any other host is refused and blobs are read instead", async () => {
  const api = new ArchiveGitHub(vault(40)), repo = archiveClient(api);
  api.redirect = true;
  await repo.head();
  assert.equal(api.archives.length, 2);
  assert.equal(new URL(api.archives[1].url).hostname, "codeload.github.com");
  assert.equal(api.archives[1].headers.Authorization, undefined);
  assert.equal(objectGets(api).blobs, 0);
  const evil = new ArchiveGitHub(vault(40));
  evil.archiveIntercept = r => new URL(r.url).hostname === "api.github.com" ? { status: 302, headers: { location: "https://evil.example/zip" }, bytes: new Uint8Array() } : undefined;
  assert.equal(Object.keys((await archiveClient(evil).head()).files).length, 40);
  assert.equal(evil.archives.length, 1);
  assert.equal(objectGets(evil).blobs, 40);
});
test("export-ignore, export-subst and wrong-size archive members fall back to single blobs", async () => {
  const initial = vault(40), api = new ArchiveGitHub(initial);
  api.shape = files => {
    delete files["notes/1.md"];
    files["notes/2.md"] = Buffer.from("$Format:%H$ expanded");
    const same = Buffer.from(files["notes/3.md"]); same[0] ^= 1; files["notes/3.md"] = same;
    files["notes/4.md"] = Buffer.alloc(9 * 1024 * 1024, 1);
  };
  const head = await archiveClient(api).head();
  for (const [path, entry] of Object.entries(initial)) assert.deepEqual(head.files[path], entry);
  const fetched = api.requests.filter(r => r.url.includes("/git/blobs/")).map(r => r.url.split("/").pop());
  assert.deepEqual(fetched.sort(), [1, 2, 3, 4].map(i => initial[`notes/${i}.md`].oid).sort());
});
test("duplicate, truncated, oversized or failed archives fall back to blobs; auth and rate limits do not", async () => {
  const cases: [string, (api: ArchiveGitHub) => void][] = [
    ["duplicate", api => { api.archiveIntercept = () => { const zip = Buffer.from(zipSync({ "r/notes/0.md": Buffer.from("note 0\n"), "r/notes/X.md": Buffer.from("forged\n") }, { level: 0 })); for (let i = zip.indexOf("notes/X.md"); i >= 0; i = zip.indexOf("notes/X.md", i + 1)) zip.write("notes/0.md", i); return { status: 200, headers: {}, bytes: zip }; }; }],
    ["truncated", api => { const original = api.requestArchive.bind(api); api.requestArchive = async r => { const result = await original(r); return { ...result, bytes: result.bytes.subarray(0, result.bytes.length - 100) }; }; }],
    ["oversized", api => { api.archiveIntercept = () => ({ status: 200, headers: {}, bytes: new Uint8Array(256 * 1024 * 1024 + 1) }); }],
    ["server error", api => { api.archiveIntercept = () => ({ status: 502, headers: {}, bytes: new Uint8Array() }); }],
    ["transport", api => { api.requestArchive = async () => { throw new Error("socket SHOULD_NOT_ESCAPE"); }; }],
  ];
  for (const [name, arrange] of cases) {
    const initial = vault(40), api = new ArchiveGitHub(initial);
    arrange(api);
    const head = await archiveClient(api).head();
    for (const [path, entry] of Object.entries(initial)) assert.deepEqual(head.files[path], entry, name);
    assert.equal(objectGets(api).blobs, 40, name);
  }
  for (const [status, headers, check] of [
    [401, {}, (e: GitHubError) => e.status === 401 && e.retryAt === undefined],
    [403, {}, (e: GitHubError) => e.status === 403 && e.retryAt === undefined],
    [404, {}, (e: GitHubError) => e.status === 404],
    [429, { "retry-after": "120" }, (e: GitHubError) => e.retryAt === 1_000_000 + 120_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5000" }, (e: GitHubError) => e.retryAt === 5_000_000],
  ] as [number, Record<string, string>, (e: GitHubError) => boolean][]) {
    const api = new ArchiveGitHub(vault(40));
    api.archiveIntercept = () => ({ status, headers, bytes: new Uint8Array() });
    await assert.rejects(archiveClient(api).head(), error => error instanceof GitHubError && check(error) && !error.message.includes("SHOULD_NOT_ESCAPE"));
    assert.equal(objectGets(api).blobs, 0, `HTTP ${status} is not masked by blob reads`);
  }
});
test("existing vault reuses verified local bytes and downloads only changed or unreadable files without writing", async () => {
  const initial = vault(651), api = new ArchiveGitHub(initial), local = localCopy(initial), reads: string[] = [];
  local.set("notes/7.md", Buffer.from("local edit, same size?"));
  const edited = Buffer.from(local.get("notes/8.md") ?? []); edited[0] ^= 1; local.set("notes/8.md", edited);
  local.delete("notes/9.md");
  const before = new Map(local);
  const head = await archiveClient(api, local, reads).head();
  for (const [path, entry] of Object.entries(initial)) assert.deepEqual(head.files[path], entry);
  assert.equal(reads.length, 651);
  assert.equal(api.archives.length, 0, "three missing blobs stay below the archive threshold");
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 3, refs: 1 });
  assert.deepEqual(local, before, "local candidates are only read");
});
test("many local mismatches use the archive; a matching tree with an identical blob at two paths reads the first match", async () => {
  const initial = { ...vault(50), "copy.md": file("note 0\n") }, api = new ArchiveGitHub(initial);
  const local = localCopy(initial);
  for (let i = 10; i < 50; i++) local.set(`notes/${i}.md`, Buffer.from(`stale ${i}`));
  local.delete("notes/0.md");
  const head = await archiveClient(api, local).head();
  for (const [path, entry] of Object.entries(initial)) assert.deepEqual(head.files[path], entry);
  assert.equal(api.archives.length, 1);
  assert.equal(objectGets(api).blobs, 0);
});
test("after a restart, a one-file remote change costs one blob and the rest is verified locally", async () => {
  const initial = vault(651), api = new ArchiveGitHub(initial);
  const synced = await archiveClient(api).head();
  assert.equal(api.archives.length, 1);
  const local = localCopy(synced.files);
  api.head = api.addCommit({ ...initial, "notes/42.md": file("remote change") }, api.head);
  api.requests = []; api.archives = [];
  const restarted = archiveClient(api, local), after = await restarted.head();
  assert.equal(after.files["notes/42.md"].data, file("remote change").data);
  assert.equal(api.archives.length, 0);
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 1, refs: 1 });
  api.head = api.addCommit({ ...initial, "notes/42.md": file("again") }, api.head);
  api.requests = [];
  await restarted.head();
  assert.deepEqual(objectGets(api), { commits: 1, trees: 1, blobs: 1, refs: 1 }, "in-memory delta, no local rereads needed");
});
test("a failed read publishes no partial snapshot, and readLocal failures fail the read", async () => {
  const initial = vault(40), api = new ArchiveGitHub(initial), bad = initial["notes/5.md"].oid;
  api.shape = files => { delete files["notes/5.md"]; };
  api.intercept = r => r.url.endsWith(`/git/blobs/${bad}`) ? response({ message: "boom" }, 500) : undefined;
  const repo = archiveClient(api);
  await assert.rejects(repo.head(), error => error instanceof GitHubError && error.status === 500);
  api.intercept = undefined; api.requests = []; api.archives = [];
  const head = await repo.head();
  assert.deepEqual(head.files["notes/5.md"], initial["notes/5.md"]);
  assert.deepEqual([api.archives.length, objectGets(api).blobs], [0, 1], "verified archive blobs were retained, nothing else refetched");
  const fenced = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: new ArchiveGitHub(initial), token: async () => "t", installation: INSTALLATION, readLocal: async () => { throw new Error("vault owner changed"); } });
  await assert.rejects(fenced.head(), /vault owner changed/);
});
test("the root .gitignore establishing scope is read on its own before the archive", async () => {
  const initial: Snapshot = { ...vault(40), ".gitignore": file("private/\n"), "private/secret.md": file("x"), ".obsidian/app.json": file("{}") };
  const api = new ArchiveGitHub(initial);
  const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION, scopeRules: "config/1" });
  const head = await repo.head();
  assert.equal(head.files["private/secret.md"], undefined);
  assert.deepEqual(head.files["notes/3.md"], initial["notes/3.md"]);
  assert.equal(objectGets(api).blobs, 1);
  assert.equal(api.archives.length, 1);
});
test("offered blob bodies replace downloads only when they hash to the tree's blob", async () => {
  const initial = { "big.bin": file(Buffer.alloc(1024 * 1024, 7)), "a.md": file("a"), "b.md": file("b") };
  const api = new FakeGitHub(initial), checkpoint = api.head;
  api.head = api.addCommit({ ...initial, "a.md": file("remote") }, checkpoint);
  const repo = client(api);
  repo.offerKnownBlobs([
    { oid: initial["big.bin"].oid, data: initial["big.bin"].data },
    { oid: initial["a.md"].oid, data: file("forged").data },
    { oid: initial["b.md"].oid, data: "not base64!" },
  ]);
  api.requests = [];
  const read = await repo.readCommit(checkpoint);
  assert.deepEqual(read.files, Object.assign(Object.create(null), initial));
  assert.equal(objectGets(api).blobs, 2, "only the forged and malformed offers fall back to downloads");
  assert.ok(!api.requests.some(r => r.url.endsWith(`/git/blobs/${initial["big.bin"].oid}`)));
});
test("alternating head and checkpoint reads over the LRU budget keep both snapshots retained", async () => {
  // 9 x 6 MiB per snapshot exceeds the 128 MiB LRU accounting on its own.
  const initial = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`large/${i}.bin`, file(Buffer.alloc(6 * 1024 * 1024, i))]));
  const api = new FakeGitHub(initial), checkpoint = api.head;
  api.head = api.addCommit(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`large/${i}.bin`, file(Buffer.alloc(6 * 1024 * 1024, i + 100))])), checkpoint);
  const repo = client(api);
  await repo.head();
  await repo.readCommit(checkpoint);
  api.requests = [];
  for (let i = 0; i < 2; i++) {
    assert.equal((await repo.head()).files["large/0.bin"].data, file(Buffer.alloc(6 * 1024 * 1024, 100)).data);
    assert.equal((await repo.readCommit(checkpoint)).files["large/0.bin"].data, initial["large/0.bin"].data);
  }
  assert.equal(objectGets(api).blobs, 0);
});

test("verified engine entries skip rehashing as offers, local candidates and changes, but never skip identity, size or LFS checks", async () => {
  const { entryFromBytes, entryFromText } = await import("../src/git-sync/codec");
  const initial: Snapshot = { "a.md": await entryFromText("alpha"), "b.md": await entryFromText("bravo"), "c.md": await entryFromText("charlie") };
  const subtle = globalThis.crypto.subtle, digest = subtle.digest.bind(subtle);
  let blobHashes = 0;
  Object.defineProperty(subtle, "digest", { configurable: true, value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    if (new TextDecoder().decode(view.subarray(0, 5)) === "blob ") blobHashes++;
    return digest(algorithm, data);
  } });
  try {
    // Offers: trusted entries are taken as is; plain copies are hashed.
    for (const trusted of [true, false]) {
      const api = new FakeGitHub(initial), repo = client(api);
      repo.offerKnownBlobs(Object.values(initial).map(entry => trusted ? entry : { oid: entry.oid, data: entry.data }));
      api.requests = []; blobHashes = 0;
      const head = await repo.head();
      assert.equal(objectGets(api).blobs, 0);
      assert.equal(blobHashes, trusted ? 0 : 3);
      assert.deepEqual(Object.keys(head.files).sort(), ["a.md", "b.md", "c.md"]);
    }
    // A trusted entry for another blob or size is never substituted.
    {
      const api = new FakeGitHub(initial), repo = client(api);
      repo.offerKnownBlobs([{ ...(await entryFromText("other")), oid: initial["a.md"].oid }]);
      api.requests = [];
      assert.equal((await repo.head()).files["a.md"].data, initial["a.md"].data);
      assert.ok(objectGets(api).blobs >= 1);
    }
    // Local candidates returned as entries.
    const local = new Map<string, Entry>([["a.md", initial["a.md"]], ["b.md", await entryFromText("edited")], ["c.md", { oid: initial["c.md"].oid, mode: "100644", data: Buffer.from("forged!").toString("base64") }]]);
    const api = new FakeGitHub(initial);
    const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION,
      readLocal: async path => local.get(path) ?? null });
    api.requests = []; blobHashes = 0;
    const head = await repo.head();
    assert.deepEqual(head.files, Object.assign(Object.create(null), initial));
    assert.deepEqual(api.requests.filter(r => r.url.includes("/git/blobs/")).map(r => r.url.split("/").pop()).sort(), [initial["b.md"].oid, initial["c.md"].oid].sort(),
      "the edited and forged local entries fall back to downloads");
    // Changes: a trusted LFS pointer is still refused.
    const pointer = await entryFromBytes(new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"));
    await assert.rejects(repo.prepare(head, { "lfs.md": pointer }, "lfs", L), /Git LFS/);
    const change = await entryFromText("delta");
    blobHashes = 0;
    const prepared = await repo.prepare(head, { "d.md": change }, "trusted change", L);
    assert.equal(prepared.files["d.md"].data, Buffer.from("delta").toString("base64"));
    assert.equal(blobHashes, 0, "a verified change and the parent snapshot are not rehashed");
  } finally {
    Reflect.deleteProperty(subtle, "digest");
  }
});

test("ref updates reuse a recent successful identity check and recheck after expiry or failure", async () => {
  const api = new FakeGitHub();
  let now = 1_000_000;
  const repo = new GitHubRepository({ owner: "owner", name: "repo", branch: "main", transport: api, token: async () => "t", installation: INSTALLATION, now: () => now });
  const identityGets = () => api.requests.filter(r => r.method === "GET" && new URL(r.url).pathname === "/repos/owner/repo").length;
  const publishOnce = async () => {
    const parent = await repo.head();
    const prepared = await repo.prepare(parent, { "note.md": file(`v${now}`) }, "m", { anchor: api.refs.get(repo.ledgerRef()) ?? null, operation: "publish-1" });
    return repo.publish({ parent: parent.oid, candidate: prepared.oid, anchor: api.refs.get(repo.ledgerRef()) ?? null, receipt: prepared.receipt });
  };
  assert.equal(await publishOnce(), "acknowledged");
  assert.equal(identityGets(), 1, "no prior check: the update checks identity itself");
  await repo.identity();
  assert.equal(await publishOnce(), "acknowledged");
  assert.equal(identityGets(), 2, "the sync's own identity check is reused");
  now += 11 * 60_000;
  assert.equal(await publishOnce(), "acknowledged");
  assert.equal(identityGets(), 3, "an old check is not reused");
  api.intercept = r => r.method === "GET" && new URL(r.url).pathname === "/repos/owner/repo" ? response({ private: false, node_id: "R_stable", owner: { login: "owner" }, name: "repo" }) : undefined;
  await assert.rejects(repo.identity(), /private/);
  await assert.rejects(publishOnce(), /private/, "a failed check voids the reusable identity");
});

test("headOid reads the branch ref alone and agrees with head()", async () => {
  const api = new FakeGitHub(), repo = client(api);
  api.requests = [];
  const oid = await repo.headOid();
  assert.equal(api.requests.length, 1);
  assert.equal(oid, (await repo.head()).oid);
});

// Regression (review): a prepare whose uploads evicted their own blobs from the
// LRU re-read the candidate via an archive of commit "" and failed every retry.
test("a 4200-file publication prepares without re-reading uploaded blobs or requesting an archive", async () => {
  const api = new ArchiveGitHub({ "note.md": file("base\n") });
  const repo = archiveClient(api);
  const head = await repo.head();
  const changes: Changes = {};
  for (let i = 0; i < 4200; i++) changes[`n/${i}.md`] = file(`note ${i}\n`);
  api.archives = [];
  api.requests = [];
  const candidate = await repo.prepare(head, changes, "msg", L);
  assert.equal(api.archives.length, 0, "no archive of an uncommitted tree");
  assert.equal(api.requests.filter(r => r.method === "GET" && r.url.includes("/git/blobs/")).length, 0);
  assert.equal(Object.keys(candidate.files).length, 4201);
  assert.deepEqual(candidate.files["n/4199.md"], changes["n/4199.md"]);
});

test("a retried publication skips blobs it already created or the parent already holds", async () => {
  const api = new FakeGitHub({ "note.md": file("base\n") });
  const repo = client(api);
  const head = await repo.head();
  const changes: Changes = {};
  for (let i = 0; i < 40; i++) changes[`n/${i}.md`] = file(`note ${i}\n`);
  changes["copy.md"] = file("base\n");
  // GitHub's secondary limit stops the first attempt after some uploads.
  let posts = 0;
  api.intercept = request => request.method === "POST" && request.url.endsWith("/git/blobs") && ++posts > 25
    ? response({ message: "secondary rate limit" }, 403, { "retry-after": "60" }) : undefined;
  await assert.rejects(repo.prepare(head, changes, "msg", L), /rate limit/);
  api.intercept = undefined;
  api.requests = [];
  const candidate = await repo.prepare(head, changes, "msg", L);
  const uploaded = api.requests.filter(r => r.method === "POST" && r.url.endsWith("/git/blobs")).map(r => JSON.parse(r.body ?? "{}").content);
  assert.equal(uploaded.length, 40 - 25, "only blobs the first attempt did not create");
  assert.ok(!uploaded.includes(changes["copy.md"]!.data), "a blob of the parent tree is never re-uploaded");
  assert.equal(Object.keys(candidate.files).length, 42);
});

test("a skipped blob that GitHub no longer has is uploaded again on the next attempt", async () => {
  const api = new FakeGitHub({ "note.md": file("base\n") });
  const repo = client(api);
  const head = await repo.head();
  const a = file("a\n");
  await repo.prepare(head, { "a.md": a }, "msg", L);
  api.blobs.delete(a.oid); // collected as unreferenced
  await assert.rejects(repo.prepare(head, { "a.md": a }, "msg", L));
  api.requests = [];
  const again = await repo.prepare(head, { "a.md": a }, "msg", L);
  assert.deepEqual(again.files["a.md"], a);
  assert.equal(api.requests.filter(r => r.method === "POST" && r.url.endsWith("/git/blobs")).length, 1);
});
