/** Authorized integration target is hard-coded; never accepts a real-vault repository argument. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { GitHubRepository, encodeGitData, gitBlobOid } from "../plugin/src/git-sync/github";
import type { GitHubRequest, GitHubResponse, GitHubTransport } from "../plugin/src/git-sync/github";
import type { Entry } from "../plugin/src/git-sync/contracts";

const owner = "triptu", name = "vault-sync-test";
const base = `https://api.github.com/repos/${owner}/${name}`;
let credential: string;
try { credential = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
catch { throw new Error("Existing gh authentication unavailable"); }
const token = async () => credential;
let requests = 0;
const transport: GitHubTransport = {
  async request(request: GitHubRequest): Promise<GitHubResponse> {
    if (!request.url.startsWith(base + "/") && request.url !== base && request.url !== "https://api.github.com/graphql") throw new Error("Integration transport target blocked");
    requests++;
    const result = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => { headers[key] = value; });
    return { status: result.status, headers, json: await result.json() };
  }
};
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed integration response");
  return Object.fromEntries(Object.entries(value));
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error("Malformed integration SHA");
  return value;
}
async function harness(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<Record<string, unknown>> {
  // PATCH exists only in this lab harness to exercise a forced-rewind race on its unique branch.
  requests++;
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${credential}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Integration harness HTTP ${response.status}; no retry attempted`);
  return object(await response.json());
}
async function entry(bytes: Uint8Array, mode: Entry["mode"] = "100644"): Promise<Entry> { return { oid: await gitBlobOid(bytes), data: encodeGitData(bytes), mode }; }
async function run(): Promise<void> {
  const branch = `github-client-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const metadata = await harness("", "GET");
  assert.equal(metadata.full_name, `${owner}/${name}`);
  const defaultBranch = metadata.default_branch; assert.equal(typeof defaultBranch, "string");
  const defaultRef = await harness(`/git/ref/heads/${encodeURIComponent(String(defaultBranch))}`, "GET");
  const defaultHead = sha(object(defaultRef.object).sha);
  const seedNote = await entry(Buffer.from("fixture base\r\n"));
  const hidden = await entry(Buffer.from("preserve hidden bytes\0\xff", "latin1"));
  const symlink = await entry(Buffer.from("../fixture.md"));
  for (const item of [seedNote, hidden, symlink]) assert.equal(sha((await harness("/git/blobs", "POST", { content: item.data, encoding: "base64" })).sha), item.oid);
  const seedTree = sha((await harness("/git/trees", "POST", { tree: [
    { path: "fixture.md", mode: "100644", type: "blob", sha: seedNote.oid },
    { path: ".fixture/keep.bin", mode: "100755", type: "blob", sha: hidden.oid },
    { path: ".fixture/link", mode: "120000", type: "blob", sha: symlink.oid },
    { path: ".fixture/module", mode: "160000", type: "commit", sha: defaultHead }
  ] })).sha);
  const seed = sha((await harness("/git/commits", "POST", { message: "Synthetic GitHub client fixture", tree: seedTree, parents: [defaultHead] })).sha);
  await harness("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: seed });
  const options = { owner, name, branch, transport, token };
  const a = new GitHubRepository(options), b = new GitHubRepository(options);
  const parent = await a.head(); assert.equal(parent.oid, seed); assert.deepEqual(Object.keys(parent.files), ["fixture.md"]);
  const binary = randomBytes(4_320_889);
  const changes = {
    "fixture.md": await entry(Buffer.from("\ufeff日本語 🐇\r\nsecond line\r\n")),
    "media/large.bin": await entry(binary),
    "media/small.bin": await entry(Uint8Array.from([0, 255, 128, 10, 13])),
    "tools/run.sh": await entry(Buffer.from("#!/bin/sh\nprintf test\n"), "100755")
  };
  const roundtrip = await a.prepare(parent, changes, "Synthetic note and binary roundtrip");
  assert.equal((await b.head()).oid, seed, "prepare advanced branch");
  assert.deepEqual(await a.publish(seed, roundtrip.oid), { kind: "accepted" });
  const downloaded = await b.head(); assert.deepEqual(downloaded, roundtrip);
  assert.equal(downloaded.files["tools/run.sh"].mode, "100755");
  const remoteTree = await harness(`/git/trees/${roundtrip.treeOid}?recursive=1`, "GET");
  const hiddenEntries = Array.isArray(remoteTree.tree) ? remoteTree.tree.map(object).filter(i => typeof i.path === "string" && i.path.startsWith(".fixture/")) : [];
  assert.equal(hiddenEntries.length, 3); assert.equal(hiddenEntries.find(i => i.path === ".fixture/keep.bin")?.sha, hidden.oid);
  assert.equal(hiddenEntries.find(i => i.path === ".fixture/link")?.mode, "120000"); assert.equal(hiddenEntries.find(i => i.path === ".fixture/module")?.mode, "160000");
  const left = await a.prepare(downloaded, { "left.md": await entry(Buffer.from("left")) }, "Independent client left");
  const right = await b.prepare(downloaded, { "right.md": await entry(Buffer.from("right")) }, "Independent client right");
  const race = await Promise.all([a.publish(downloaded.oid, left.oid), b.publish(downloaded.oid, right.oid)]);
  assert.deepEqual(race.map(r => r.kind).sort(), ["accepted", "head-moved"]);
  const winner = await a.head(); const loser = winner.oid === left.oid ? right : left;
  assert.deepEqual(await b.publish(downloaded.oid, loser.oid), { kind: "head-moved" });
  const rewindCandidate = await a.prepare(winner, { "rewind.md": await entry(Buffer.from("must not publish")) }, "Exact beforeOid forced rewind test");
  await harness(`/git/refs/heads/${branch}`, "PATCH", { sha: downloaded.oid, force: true });
  assert.deepEqual(await a.publish(winner.oid, rewindCandidate.oid), { kind: "head-moved" });
  assert.equal((await b.head()).oid, downloaded.oid, "stale candidate resurrected history after rewind");
  const recovery = await a.prepare(downloaded, { "lost-response.md": await entry(Buffer.from("lost response accepted")), "media/small.bin": null }, "Lost response recovery and delete");
  let dropped = false;
  const lossy: GitHubTransport = { async request(request) { const result = await transport.request(request); if (request.url.endsWith("/graphql") && !dropped) { dropped = true; throw new Error("Synthetic response loss after server completion"); } return result; } };
  const lost = new GitHubRepository({ ...options, transport: lossy });
  assert.deepEqual(await lost.publish(downloaded.oid, recovery.oid), { kind: "accepted" });
  assert.equal((await b.head()).oid, recovery.oid);
  assert.equal(await a.isAncestor(downloaded.oid, recovery.oid), true);
  assert.equal(await a.isAncestor(recovery.oid, downloaded.oid), false);
  assert.equal(sha(object((await harness(`/git/ref/heads/${encodeURIComponent(String(defaultBranch))}`, "GET")).object).sha), defaultHead, "default branch changed during lab test");
  console.log(JSON.stringify({ repository: `${owner}/${name}`, branch, seed, roundtrip: roundtrip.oid, binaryBytes: binary.length, race: race.map(r => r.kind), raceCandidates: [left.oid, right.oid], winner: winner.oid, forcedRewindCandidate: rewindCandidate.oid, forcedRewind: "blocked; head unchanged", lostResponse: recovery.oid, hiddenEntriesPreserved: hiddenEntries.length, requests, defaultBranchUnchanged: defaultHead }, null, 2));
}
void run().catch((error: unknown) => { console.error(error instanceof Error && !error.message.includes(credential) ? error.message : "Integration failed; sensitive error suppressed"); process.exitCode = 1; }).finally(() => { credential = ""; });
