/** Read-only acceptance: production client, real private vault, no writes or content in output. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { GitHubRepository, type GitHubTransport } from "../plugin/src/git-sync/github";
import { readLocalCandidate } from "../plugin/src/git-sync/local-candidate";

const owner = "triptu", name = "notes", branch = "main";
const base = `https://api.github.com/repos/${owner}/${name}`;
const local = resolve(process.argv[2] ?? "~/vault");
const credential = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let counts = { requests: 0, blobs: 0, archives: 0, errors: 0, localReads: 0 };
const transport: GitHubTransport = {
  async request(request) {
    assert.equal(request.method, "GET");
    assert.ok(request.url === base || request.url.startsWith(base + "/"));
    counts.requests++;
    if (request.url.includes("/git/blobs/")) counts.blobs++;
    const response = await fetch(request.url, { headers: request.headers, redirect: "error" });
    if (!response.ok) counts.errors++;
    return { status: response.status, headers: Object.fromEntries(response.headers), json: await response.json() };
  },
  async requestArchive(request) {
    assert.equal(request.method, "GET");
    const url = new URL(request.url);
    assert.ok(request.url.startsWith(base + "/zipball/") || url.hostname === "codeload.github.com");
    if (url.hostname === "codeload.github.com") assert.equal(request.headers.Authorization, undefined);
    counts.requests++;
    if (request.url.startsWith(base + "/zipball/")) counts.archives++;
    const response = await fetch(request.url, { headers: request.headers, redirect: "manual" });
    if (!response.ok && response.status !== 302) counts.errors++;
    return { status: response.status, headers: Object.fromEntries(response.headers), bytes: new Uint8Array(await response.arrayBuffer()) };
  },
};
function pathFor(path: string): string {
  const absolute = resolve(local, path);
  assert.ok(absolute.startsWith(local + sep));
  return absolute;
}
const files = {
  async stat(path: string) { const info = await stat(pathFor(path)); return { type: info.isFile() ? "file" : "folder", size: info.size }; },
  async readBinary(path: string) { counts.localReads++; const bytes = await readFile(pathFor(path)); return Uint8Array.from(bytes).buffer; },
};
const options = { owner, name, branch, scopeRules: "config/1" as const, transport, token: async () => credential, installation: randomUUID() };
async function run() {
  const client = new GitHubRepository({ ...options, readLocal: (path, size) => readLocalCandidate(files, path, size) });
  assert.equal((await client.identity()).name, name); // identity() rejects public repositories.
  const snapshot = await client.head();
  assert.ok(Object.keys(snapshot.files).length > 500);
  const existing = { ...counts };
  assert.equal(existing.archives, 0, "Matching existing vault should not need an archive");
  counts = { requests: 0, blobs: 0, archives: 0, errors: 0, localReads: 0 };
  const repeat = await client.head();
  assert.deepEqual(repeat, snapshot);
  const repeatCounts = { ...counts };
  assert.equal(repeatCounts.blobs, 0);
  assert.equal(repeatCounts.requests, 1);
  counts = { requests: 0, blobs: 0, archives: 0, errors: 0, localReads: 0 };
  const cold = await new GitHubRepository(options).readCommit(snapshot.oid);
  assert.deepEqual(cold, snapshot);
  assert.equal(counts.archives, 1);
  assert.ok(counts.blobs < 5, "Cold download must use ZIP, not hundreds of blobs");
  assert.equal(existing.errors + repeatCounts.errors + counts.errors, 0);
  console.log(JSON.stringify({ repository: `${owner}/${name}`, commit: snapshot.oid, files: Object.keys(snapshot.files).length, existing, unchangedHead: repeatCounts, coldArchive: counts, byteIdentical: true, writes: 0, scope: "One read-only Node transport run; not an Android latency measurement" }, null, 2));
}
void run().catch(error => { console.error(error instanceof Error ? error.message : "Download acceptance failed"); process.exitCode = 1; });
