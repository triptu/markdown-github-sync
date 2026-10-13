/** Authorized integration target is hard-coded; never accepts a real-vault repository argument. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { GitHubRepository, GitHubError, encodeGitData, gitBlobOid } from "../plugin/src/git-sync/github";
import type { GitHubRequest, GitHubResponse, GitHubTransport } from "../plugin/src/git-sync/github";
import { SyncSession } from "../plugin/src/git-sync/session";
import { MemoryVault, MemoryStore } from "../plugin/test/git-fakes";
import type { Entry, Changes, CommitSnapshot, PreparedPublication } from "../plugin/src/git-sync/contracts";

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
    const json: unknown = await result.json();
    return { status: result.status, headers, json };
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
  assert.equal(metadata.private, true, "Lab repository must remain private");
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
  const options = { owner, name, branch, transport, token, installation: randomUUID() };
  const a = new GitHubRepository(options), b = new GitHubRepository({ ...options, installation: randomUUID() });
  const prepare = async (client: GitHubRepository, parent: CommitSnapshot, changes: Changes, message: string) => {
    const ledger = await client.readLedger();
    return client.prepare(parent, changes, message, { anchor: ledger.kind === "present" ? ledger.value : null, operation: randomUUID() });
  };
  const publish = async (client: GitHubRepository, parent: string, prepared: PreparedPublication) => {
    const ledger = await client.readLedger();
    const anchor = ledger.kind === "present" ? ledger.value : null;
    let response: "acknowledged" | "unconfirmed";
    try { response = await client.publish({ parent, candidate: prepared.oid, receipt: prepared.receipt, anchor }); }
    catch (error) {
      if (!(error instanceof GitHubError) || error.message !== "GitHub transport failed; request outcome may be unknown") throw error;
      response = "unconfirmed";
    }
    const after = await client.readLedger();
    return { response, accepted: after.kind === "present" && after.value === prepared.receipt };
  };
  const parent = await a.head(); assert.equal(parent.oid, seed); assert.deepEqual(Object.keys(parent.files), ["fixture.md"]);
  const binary = randomBytes(4_320_889);
  const changes = {
    "fixture.md": await entry(Buffer.from("\ufeff日本語 🐇\r\nsecond line\r\n")),
    "media/large.bin": await entry(binary),
    "media/small.bin": await entry(Uint8Array.from([0, 255, 128, 10, 13])),
    "tools/run.sh": await entry(Buffer.from("#!/bin/sh\nprintf test\n"), "100755")
  };
  const roundtrip = await prepare(a, parent, changes, "Synthetic note and binary roundtrip");
  assert.equal((await b.head()).oid, seed, "prepare advanced branch");
  assert.equal((await publish(a, seed, roundtrip)).accepted, true);
  const downloaded = await b.head(); assert.equal(downloaded.oid, roundtrip.oid); assert.deepEqual(downloaded.files, roundtrip.files);
  assert.equal(downloaded.files["tools/run.sh"].mode, "100755");
  const remoteTree = await harness(`/git/trees/${roundtrip.treeOid}?recursive=1`, "GET");
  const hiddenEntries = Array.isArray(remoteTree.tree) ? remoteTree.tree.map(object).filter(i => typeof i.path === "string" && i.path.startsWith(".fixture/")) : [];
  assert.equal(hiddenEntries.length, 3); assert.equal(hiddenEntries.find(i => i.path === ".fixture/keep.bin")?.sha, hidden.oid);
  assert.equal(hiddenEntries.find(i => i.path === ".fixture/link")?.mode, "120000"); assert.equal(hiddenEntries.find(i => i.path === ".fixture/module")?.mode, "160000");
  const left = await prepare(a, downloaded, { "left.md": await entry(Buffer.from("left")) }, "Independent client left");
  const right = await prepare(b, downloaded, { "right.md": await entry(Buffer.from("right")) }, "Independent client right");
  const race = await Promise.all([publish(a, downloaded.oid, left), publish(b, downloaded.oid, right)]);
  assert.deepEqual(race.map(r => r.accepted).sort(), [false, true]);
  const winner = await a.head(); const loser = winner.oid === left.oid ? right : left;
  assert.equal((await publish(winner.oid === left.oid ? b : a, downloaded.oid, loser)).accepted, false);
  const rewindCandidate = await prepare(a, winner, { "rewind.md": await entry(Buffer.from("must not publish")) }, "Exact beforeOid forced rewind test");
  await harness(`/git/refs/heads/${branch}`, "PATCH", { sha: downloaded.oid, force: true });
  assert.equal((await publish(a, winner.oid, rewindCandidate)).accepted, false);
  assert.equal((await b.head()).oid, downloaded.oid, "stale candidate resurrected history after rewind");
  const recovery = await prepare(a, downloaded, { "lost-response.md": await entry(Buffer.from("lost response accepted")), "media/small.bin": null }, "Lost response recovery and delete");
  let dropped = false;
  const lossy: GitHubTransport = { async request(request) { const result = await transport.request(request); if (request.url.endsWith("/graphql") && request.body?.includes("updateRefs") && !dropped) { dropped = true; throw new Error("Synthetic response loss after server completion"); } return result; } };
  const lost = new GitHubRepository({ ...options, transport: lossy });
  const lostResult = await publish(lost, downloaded.oid, recovery);
  assert.equal(dropped, true); assert.equal(lostResult.response, "unconfirmed"); assert.equal(lostResult.accepted, true);
  assert.equal((await b.head()).oid, recovery.oid);
  assert.equal(await a.isAncestor(downloaded.oid, recovery.oid), true);
  assert.equal(await a.isAncestor(recovery.oid, downloaded.oid), false);
  // Real SyncSession + production GitHub adapter. Only the local filesystem is simulated.
  let armedRace = false, waiting = 0;
  let releaseRace: () => void = () => {};
  const raceGate = new Promise<void>(resolve => { releaseRace = resolve; });
  let loseNext = false, offline = false, responseLost = false;
  const engineTransport: GitHubTransport = { async request(request) {
    if (offline) throw new Error("Synthetic network unavailable until restart");
    const publication = request.url.endsWith("/graphql") && request.body?.includes("updateRefs") && request.body.includes("refs/heads/");
    if (publication && armedRace) {
      waiting++;
      if (waiting === 2) { armedRace = false; releaseRace(); }
      await raceGate;
    }
    const result = await transport.request(request);
    if (publication && loseNext) { loseNext = false; offline = true; responseLost = true; throw new Error("Synthetic accepted response loss"); }
    return result;
  } };
  const starting = await a.head();
  const makeDevice = () => {
    const repository = new GitHubRepository({ ...options, installation: randomUUID(), transport: engineTransport });
    const vault = new MemoryVault(starting.files), store = new MemoryStore();
    const restart = () => new SyncSession({ repository, vault, store, delay: async () => {} });
    return { repository, vault, store, restart, session: restart() };
  };
  const devices = [makeDevice(), makeDevice()];
  for (const device of devices) {
    const preview = await device.session.previewEnrollment();
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") throw new Error("Expected enrollment preview");
    assert.equal((await device.session.enroll({ token: preview.token })).kind, "enrolled");
  }
  await devices[0].vault.write("engine-left.md", "left device draft");
  await devices[1].vault.write("engine-right.md", "right device draft");
  armedRace = true;
  const timeout = setTimeout(() => releaseRace(), 60_000);
  let engineRace;
  try { engineRace = await Promise.all(devices.map(device => device.session.sync())); }
  finally { clearTimeout(timeout); }
  assert.equal(waiting, 2, "Both devices must reach publication from the shared checkpoint");
  const acceptable = new Set(["synced", "up-to-date"]);
  for (const outcome of engineRace) assert.ok(acceptable.has(outcome.kind), JSON.stringify(outcome));
  for (const device of devices) {
    assert.ok(acceptable.has((await device.session.sync()).kind));
    assert.equal(device.vault.text("engine-left.md"), "left device draft");
    assert.equal(device.vault.text("engine-right.md"), "right device draft");
  }
  const engineConverged = await a.head();
  assert.equal(engineConverged.files["engine-left.md"].oid, devices[0].vault.files.get("engine-left.md")?.oid);
  assert.equal(engineConverged.files["engine-right.md"].oid, devices[1].vault.files.get("engine-right.md")?.oid);
  await devices[0].vault.write("engine-lost-response.md", "durable draft after restart");
  loseNext = true;
  const unsettled = await devices[0].session.sync();
  assert.equal(responseLost, true); assert.equal(unsettled.kind, "settling");
  offline = false;
  const acceptedHead = await a.head();
  devices[0].session = devices[0].restart();
  const resumed = await devices[0].session.sync();
  assert.ok(acceptable.has(resumed.kind), JSON.stringify(resumed));
  assert.equal((await a.head()).oid, acceptedHead.oid, "Restart duplicated the accepted commit");
  await devices[1].session.sync();
  assert.equal(devices[1].vault.text("engine-lost-response.md"), "durable draft after restart");
  assert.equal(sha(object((await harness(`/git/ref/heads/${encodeURIComponent(String(defaultBranch))}`, "GET")).object).sha), defaultHead, "default branch changed during lab test");
  console.log(JSON.stringify({ repository: `${owner}/${name}`, branch, seed, roundtrip: roundtrip.oid, binaryBytes: binary.length, race: race.map(r => r.accepted ? "accepted" : "not-accepted"), raceCandidates: [left.oid, right.oid], winner: winner.oid, forcedRewindCandidate: rewindCandidate.oid, forcedRewind: "blocked; head unchanged", lostResponse: recovery.oid, hiddenEntriesPreserved: hiddenEntries.length, engineRace: engineRace.map(outcome => outcome.kind), engineConverged: engineConverged.oid, engineLostResponseRestart: resumed.kind, acceptedHead: acceptedHead.oid, scope: "Production GitHub adapter and SyncSession; in-memory vault and durable-store serialization, not native filesystem or process-kill acceptance", requests, defaultBranchUnchanged: defaultHead }, null, 2));
}
void run().catch((error: unknown) => { console.error(error instanceof Error && !String(error.stack).includes(credential) ? error.stack : "Integration failed; sensitive error suppressed"); process.exitCode = 1; }).finally(() => { credential = ""; });
