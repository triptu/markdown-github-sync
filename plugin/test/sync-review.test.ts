// Regression tests for sync engine findings from the October 2026 review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFromText } from "../src/git-sync/codec";
import { parseState } from "../src/git-sync/state";
import { StaleHeadError, SyncSession } from "../src/git-sync/session";
import { MemoryRepository, MemoryStore, MemoryVault, snapshot } from "./git-fakes";

async function enrolled(repository: MemoryRepository, files: Record<string, string> = {}, name = "A") {
  const clock = { now: new Date("2026-10-13T12:00:00Z").getTime() };
  const vault = new MemoryVault(await snapshot(files));
  const store = new MemoryStore();
  const session = new SyncSession({ repository: repository.device(name), vault, store, deviceName: name, now: () => new Date(clock.now), delay: async () => {} });
  const preview = await session.previewEnrollment();
  if (preview.kind !== "preview") throw new Error("no preview");
  await session.enroll({ token: preview.token });
  const first = await session.sync();
  assert.ok(first.kind === "synced" || first.kind === "up-to-date", JSON.stringify(first));
  return { vault, store, session, clock };
}

const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => `${edit[i] ?? `line ${i}`}\n`).join("");

// ---- Item 3: a stale (lagging replica) head read never pauses by itself ----

test("a single stale branch-head read is re-read instead of pausing as history-rewritten", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  const before = repository.branchHead;
  await a.vault.write("n.md", "local edit");
  assert.equal((await a.session.sync()).kind, "synced");
  const realHead = repository.head.bind(repository);
  let stale = 1;
  repository.head = async () => (stale-- > 0 ? repository.readCommit(before) : realHead());
  const next = await a.session.sync();
  assert.equal(next.kind, "up-to-date", JSON.stringify(next));
  assert.equal((await parseState(await a.store.load())).pause, null);
});

test("a head that stays behind the checkpoint retries later, and pauses only once it persists", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  const before = repository.branchHead;
  await a.vault.write("n.md", "local edit");
  assert.equal((await a.session.sync()).kind, "synced");
  repository.head = async () => repository.readCommit(before);
  const error = await a.session.sync().then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof StaleHeadError && typeof error.retryAt === "number", String(error));
  assert.equal((await parseState(await a.store.load())).pause, null, "a stale read is not durable");
  a.clock.now += 20 * 60_000;
  const paused = await a.session.sync();
  assert.ok(paused.kind === "paused" && paused.pause.reason === "history-rewritten", JSON.stringify(paused));
});

test("a diverged head still pauses immediately", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await repository.forceReset(await snapshot({ "n.md": "rewritten" }));
  const paused = await a.session.sync();
  assert.ok(paused.kind === "paused" && paused.pause.reason === "history-rewritten", JSON.stringify(paused));
});

// ---- Item 5: recovery records are released once superseded ----

test("pre-merge local drafts are released once the merged version is published", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": lines(40) }));
  const a = await enrolled(repository);
  for (let round = 0; round < 10; round++) {
    const local = a.vault.text("n.md")!.split("\n");
    local[0] = `local ${round}`;
    await a.vault.write("n.md", local.join("\n"));
    const remote = Buffer.from(repository.headFiles()["n.md"]!.data, "base64").toString().split("\n");
    remote[30] = `remote ${round}`;
    await repository.push({ "n.md": await entryFromText(remote.join("\n")) });
    const out = await a.session.sync();
    assert.ok(out.kind === "synced", JSON.stringify(out));
  }
  const state = await parseState(await a.store.load());
  assert.equal(state.recovery.filter((record) => record.pinned).length, 0, JSON.stringify(state.recovery));
});

test("the losing side of a remote choice stays pinned until the grace period passes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "o" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "mine, discarded by choice");
  await repository.push({ "n.md": await entryFromText("theirs") });
  const review = await a.session.sync();
  const [conflict] = review.kind === "needs-decision" ? review.conflicts : [];
  assert.ok(conflict);
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "synced");
  const losing = await entryFromText("mine, discarded by choice");
  const pinnedWith = async () => (await parseState(await a.store.load())).recovery.some((record) => record.pinned && Object.values(record.files).some((entry) => entry.oid === losing.oid));
  assert.ok(await pinnedWith(), "kept right after the choice");
  // An unrelated later publication does not release it early.
  await a.vault.write("other.md", "o2");
  assert.equal((await a.session.sync()).kind, "synced");
  assert.ok(await pinnedWith(), "kept while young");
  a.clock.now += 31 * 24 * 60 * 60_000;
  await a.vault.write("other.md", "o3");
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(await pinnedWith(), false, "released after the grace period");
});

test("an old record of an unpublished edit survives completions while its path is not settled", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "o" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "unpublished draft");
  // A conflict elsewhere stops the sync after its capture archived the draft.
  await a.vault.write("other.md", "local other");
  await repository.push({ "other.md": await entryFromText("remote other") });
  const review = await a.session.sync();
  const [conflict] = review.kind === "needs-decision" ? review.conflicts : [];
  assert.ok(conflict, JSON.stringify(review));
  const draft = await entryFromText("unpublished draft");
  const pinned = async () => (await parseState(await a.store.load())).recovery.some((record) => record.pinned && record.files["n.md"]?.oid === draft.oid);
  assert.ok(await pinned());
  // The file becomes unreadable (its bytes unknown) while other paths keep syncing a year later.
  a.vault.unreadable.add("n.md");
  a.clock.now += 365 * 24 * 60 * 60_000;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced", JSON.stringify(outcome));
  assert.ok(await pinned(), "never released while it may be the newest unpublished version");
  const state = await parseState(await a.store.load());
  assert.equal(state.blobs[draft.oid], draft.data);
});

test("unpinned convenience records expire after the grace period", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "published edit");
  assert.equal((await a.session.sync()).kind, "synced");
  const before = await parseState(await a.store.load());
  assert.ok(before.recovery.length > 0 && before.recovery.every((record) => !record.pinned), JSON.stringify(before.recovery));
  a.clock.now += 31 * 24 * 60 * 60_000;
  await a.vault.write("n.md", "second edit");
  assert.equal((await a.session.sync()).kind, "synced");
  const after = await parseState(await a.store.load());
  assert.ok(before.recovery.every((old) => !after.recovery.some((record) => record.id === old.id)), "expired records are dropped");
});

// ---- Item 7: local case-only collisions reach the collision review ----

test("two local files differing only by case are a collision decision, not a failing sync", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "keep.md": "k" }));
  const a = await enrolled(repository);
  await a.vault.write("A.md", "upper");
  await a.vault.write("a.md", "lower");
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "needs-decision" && outcome.conflicts[0]?.kind === "collision", JSON.stringify(outcome));
  assert.deepEqual(outcome.conflicts[0].kind === "collision" && outcome.conflicts[0].paths, ["A.md", "a.md"]);
  assert.deepEqual(Object.keys(repository.headFiles()), ["keep.md"], "nothing published");
  a.vault.files.delete("a.md");
  await a.vault.write("b.md", "lower");
  const synced = await a.session.sync();
  assert.ok(synced.kind === "synced" && synced.published, JSON.stringify(synced));
  assert.deepEqual(Object.keys(repository.headFiles()).sort(), ["A.md", "b.md", "keep.md"]);
});

// ---- Item 8: a bulk-deletion confirmation survives unrelated local edits ----

const bulkFiles = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`folder/n${index}.md`, `body ${index}`]));

test("a bulk-deletion confirmation stays valid across an unrelated local edit", async () => {
  const repository = await MemoryRepository.create(await snapshot({ ...bulkFiles, "keep.md": "k" }));
  const a = await enrolled(repository);
  for (const path of Object.keys(bulkFiles)) a.vault.files.delete(path);
  const reviewed = await a.session.sync();
  const [bulk] = reviewed.kind === "needs-decision" ? reviewed.conflicts : [];
  assert.ok(bulk?.kind === "bulk-deletion", JSON.stringify(reviewed));
  assert.equal((await a.session.resolve({ conflictId: bulk.id, choice: { kind: "mine" } })).kind, "recorded");
  await a.vault.write("keep.md", "edited after confirming");
  const synced = await a.session.sync();
  assert.ok(synced.kind === "synced" && synced.published, JSON.stringify(synced));
  assert.deepEqual(Object.keys(repository.headFiles()), ["keep.md"]);
});

test("a bulk-deletion confirmation is invalidated when the deleted set changes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ ...bulkFiles, "keep.md": "k" }));
  const a = await enrolled(repository);
  for (const path of Object.keys(bulkFiles)) a.vault.files.delete(path);
  const reviewed = await a.session.sync();
  const [bulk] = reviewed.kind === "needs-decision" ? reviewed.conflicts : [];
  assert.ok(bulk?.kind === "bulk-deletion");
  await a.session.resolve({ conflictId: bulk.id, choice: { kind: "mine" } });
  await a.vault.write("folder/n0.md", "body 0");
  const again = await a.session.sync();
  assert.equal(again.kind, "needs-decision", JSON.stringify(again));
  assert.ok("folder/n1.md" in repository.headFiles(), "nothing deleted on a stale confirmation");
});
