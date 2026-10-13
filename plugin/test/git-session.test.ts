import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBase64, entryFromBytes, entryText, sameManifest, toManifest } from "../src/git-sync/codec";
import type { Snapshot } from "../src/git-sync/contracts";
import { SyncSession } from "../src/git-sync/session";
import type { SyncOutcome } from "../src/git-sync/session";
import type { VersionConflict } from "../src/git-sync/reconcile";
import { Crash, MemoryRepository, MemoryStore, MemoryVault, bytes, snapshot, texts } from "./git-fakes";

const NOW = () => new Date("2026-10-13T12:00:00Z");
const lines = (count: number, edit: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => `${edit[index] ?? `line ${index}`}\n`).join("");

interface Device {
  vault: MemoryVault;
  store: MemoryStore;
  session: SyncSession;
  /** A fresh session over the same vault and store, as after an app restart. */
  restart(): SyncSession;
}

async function device(repository: MemoryRepository, files: Record<string, string> = {}, name = "A"): Promise<Device> {
  const vault = new MemoryVault(await snapshot(files));
  const store = new MemoryStore();
  const make = () => new SyncSession({ repository, vault, store, deviceName: name, now: NOW });
  const result: Device = { vault, store, session: make(), restart: () => (result.session = make()) };
  return result;
}

async function enrolled(repository: MemoryRepository, name = "A", files: Record<string, string> = {}): Promise<Device> {
  const result = await device(repository, files, name);
  const preview = await result.session.previewEnrollment();
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw new Error("no preview");
  assert.equal((await result.session.enroll({ token: preview.token })).kind, "enrolled");
  const synced = await result.session.sync();
  assert.ok(synced.kind === "synced" || synced.kind === "up-to-date", JSON.stringify(synced));
  return result;
}

function conflictsOf(outcome: SyncOutcome): VersionConflict[] {
  assert.equal(outcome.kind, "needs-decision", JSON.stringify(outcome));
  return outcome.kind === "needs-decision" ? outcome.conflicts.filter((item): item is VersionConflict => item.kind !== "collision") : [];
}

async function assertConverged(repository: MemoryRepository, ...devices: Device[]) {
  for (const item of devices) {
    assert.ok(sameManifest(await item.vault.capture(), repository.headFiles()), "vault equals the branch head");
    const status = await item.session.status();
    assert.ok(status.kind === "enrolled" && status.commit === repository.branchHead && status.phase === "idle", JSON.stringify(status));
  }
}

function chainLength(repository: MemoryRepository): number {
  let count = 0;
  for (let cursor: string | null = repository.branchHead; cursor; cursor = repository.commits.get(cursor)!.parent) count++;
  return count;
}

async function remoteFiles() {
  const binary = await entryFromBytes(Uint8Array.from({ length: 256 }, (_, index) => index));
  return snapshot({
    "notes/Café.md": "﻿# Café\r\nUnicode ✓\r\nno final newline",
    "img/all-bytes.png": binary,
    "tool.sh": { ...(await entryFromBytes(new TextEncoder().encode("#!/bin/sh\n"))), mode: "100755" },
    ".obsidian/app.json": "{}",
  });
}

test("enrollment needs the confirmed preview, mutates nothing itself, then downloads exact bytes", async () => {
  const repository = await MemoryRepository.create(await remoteFiles());
  const a = await device(repository);
  assert.deepEqual(await a.session.sync(), { kind: "unenrolled" });
  const preview = await a.session.previewEnrollment();
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") return;
  assert.deepEqual(preview.items.map((item) => item.action), ["download", "download", "download"]);
  assert.equal((await a.session.enroll({ token: "0".repeat(40) })).kind, "stale");
  await a.vault.write("draft.md", "typed during preview");
  assert.equal((await a.session.enroll({ token: preview.token })).kind, "stale", "local change invalidates the preview");
  const fresh = await a.session.previewEnrollment();
  if (fresh.kind !== "preview") return assert.fail();
  assert.equal((await a.session.enroll({ token: fresh.token })).kind, "enrolled");
  assert.deepEqual([...a.vault.files.keys()], ["draft.md"], "enroll writes no vault files");
  assert.deepEqual((await a.session.enroll({ token: fresh.token })).kind, "already-enrolled");

  const outcome = await a.session.sync();
  assert.equal(outcome.kind, "synced");
  assert.ok(outcome.kind === "synced" && outcome.published, "the previewed local file is published");
  const local = await a.vault.capture();
  const remote = repository.headFiles();
  assert.ok(sameManifest(local, remote));
  for (const [path, entry] of Object.entries(remote)) assert.equal(local[path]!.data, entry.data, path);
  assert.equal(local["tool.sh"]!.mode, "100755");
  assert.ok(!(".obsidian/app.json" in local), "excluded paths stay out of the vault");
  assert.ok(".obsidian/app.json" in repository.fullHeadFiles(), "excluded remote entries survive publication");
});

test("enrolling a non-empty vault previews differences and never overwrites either side", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "same.md": "s", "both.md": "remote", "remote-only.md": "r" }));
  const a = await device(repository, { "same.md": "s", "both.md": "local", "local-only.md": "l" });
  const preview = await a.session.previewEnrollment();
  if (preview.kind !== "preview") return assert.fail();
  assert.deepEqual(Object.fromEntries(preview.items.map((item) => [item.path, item.action])), {
    "both.md": "conflict",
    "local-only.md": "upload",
    "remote-only.md": "download",
  });
  assert.equal(preview.unchanged, 1);
  await a.session.enroll({ token: preview.token });
  const [conflict] = conflictsOf(await a.session.sync());
  assert.equal(conflict!.kind, "add-add");
  assert.equal(chainLength(repository), 1, "a pending decision pauses the whole batch");
  assert.deepEqual((await a.session.resolve({ conflictId: conflict!.id, choice: { kind: "both" } })).kind, "recorded");
  const synced = await a.session.sync();
  assert.equal(synced.kind, "synced");
  const files = texts(repository.headFiles());
  assert.equal(files["both.md"], "remote");
  assert.equal(files[conflict!.sibling!], "local");
  assert.equal(files["local-only.md"], "l");
  await assertConverged(repository, a);
});

test("two clients editing different files converge and preserve excluded remote entries", async () => {
  const repository = await MemoryRepository.create(await remoteFiles());
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await a.vault.write("notes/a.md", "from A");
  await b.vault.write("notes/b.md", "from B");
  b.vault.files.set("img/new.png", await bytes([137, 80, 78, 71, 0, 1, 2]));
  assert.equal((await a.session.sync()).kind, "synced");
  const fromB = await b.session.sync();
  assert.ok(fromB.kind === "synced" && fromB.published);
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal((await b.session.sync()).kind, "up-to-date");
  await assertConverged(repository, a, b);
  assert.equal(entryText(repository.fullHeadFiles()[".obsidian/app.json"]!), "{}");
  assert.equal(chainLength(repository), 3);
});

test("separated Markdown edits merge; overlapping ones wait for a decision tied to exact versions", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": lines(12) }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await a.vault.write("n.md", lines(12, { 1: "A one" }));
  await b.vault.write("n.md", lines(12, { 9: "B nine" }));
  await a.session.sync();
  const merged = await b.session.sync();
  assert.ok(merged.kind === "synced" && merged.published);
  assert.equal(b.vault.text("n.md"), lines(12, { 1: "A one", 9: "B nine" }));
  await a.session.sync();
  await assertConverged(repository, a, b);

  await a.vault.write("n.md", lines(12, { 1: "A one", 5: "A five", 9: "B nine" }));
  await a.session.sync();
  await b.vault.write("n.md", lines(12, { 1: "A one", 5: "B five", 9: "B nine" }));
  const [first] = conflictsOf(await b.session.sync());
  assert.equal(first!.kind, "content");
  assert.equal((await b.session.resolve({ conflictId: first!.id, choice: { kind: "mine" } })).kind, "recorded");
  assert.equal((await b.session.resolve({ conflictId: "f".repeat(40), choice: { kind: "mine" } })).kind, "stale");

  // GitHub moves again before B syncs: the recorded decision must not apply.
  await a.vault.write("n.md", lines(12, { 1: "A one", 5: "A five v2", 9: "B nine" }));
  await a.session.sync();
  const [second] = conflictsOf(await b.session.sync());
  assert.notEqual(second!.id, first!.id);
  assert.equal(entryText(second!.remote!), lines(12, { 1: "A one", 5: "A five v2", 9: "B nine" }));
  assert.equal(b.vault.text("n.md"), lines(12, { 1: "A one", 5: "B five", 9: "B nine" }), "nothing applied");

  const edited = lines(12, { 1: "A one", 5: "agreed", 9: "B nine" });
  const status = await b.session.resolve({ conflictId: second!.id, choice: { kind: "edit", data: encodeBase64(new TextEncoder().encode(edited)) } });
  assert.equal(status.kind, "recorded");
  assert.equal((await b.session.sync()).kind, "synced");
  assert.equal(entryText(repository.headFiles()["n.md"]!), edited);
  await a.session.sync();
  await assertConverged(repository, a, b);

  // B's discarded version remains recoverable byte for byte.
  const records = await b.session.listRecovery();
  if (!Array.isArray(records)) return assert.fail();
  const pinned = records.filter((record) => record.pinned);
  assert.ok(pinned.length > 0);
  const exported = await b.session.exportRecovery({ id: pinned.at(-1)!.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(entryText((exported as Snapshot)["n.md"]!), lines(12, { 1: "A one", 5: "B five", 9: "B nine" }));
});

test("deletions always need review; missing paths neither delete nor resurrect", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "a.md": "a", "b.md": "b", "c.md": "c", "keep.md": "k" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");

  a.vault.files.delete("a.md");
  const [deletion] = conflictsOf(await a.session.sync());
  assert.equal(deletion!.kind, "local-deletion");
  assert.ok("a.md" in repository.headFiles(), "not published");
  assert.ok(!a.vault.files.has("a.md"), "not resurrected");

  await a.vault.write("a.md", "a"); // recreated with the same content: nothing to do
  assert.equal((await a.session.sync()).kind, "up-to-date");
  a.vault.files.delete("a.md");
  const [again] = conflictsOf(await a.session.sync());
  await a.session.resolve({ conflictId: again!.id, choice: { kind: "mine" } });
  assert.equal((await a.session.sync()).kind, "synced");
  assert.ok(!("a.md" in repository.headFiles()));

  const [remoteDeletion] = conflictsOf(await b.session.sync());
  assert.equal(remoteDeletion!.kind, "remote-deletion");
  assert.ok(b.vault.files.has("a.md"), "remote deletion waits for review");
  await b.session.resolve({ conflictId: remoteDeletion!.id, choice: { kind: "remote" } });
  await b.session.sync();
  assert.ok(!b.vault.files.has("a.md"));

  // Delete on one side, edit on the other.
  a.vault.files.delete("c.md");
  await b.vault.write("c.md", "edited by B");
  const [aDelete] = conflictsOf(await a.session.sync());
  await a.session.resolve({ conflictId: aDelete!.id, choice: { kind: "mine" } });
  await a.session.sync();
  const [deleteEdit] = conflictsOf(await b.session.sync());
  assert.equal(deleteEdit!.kind, "local-edited-remote-deleted");
  await b.session.resolve({ conflictId: deleteEdit!.id, choice: { kind: "mine" } });
  await b.session.sync();
  assert.equal(entryText(repository.headFiles()["c.md"]!), "edited by B", "kept edit is republished explicitly");
  await a.session.sync();
  await assertConverged(repository, a, b);
});

test("a lost publication response is settled by ancestry, even after a later revert, and never replayed", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "original" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await a.vault.write("n.md", "A's edit");
  repository.publishFault = "after";
  await assert.rejects(a.session.sync(), Crash);
  repository.publishFault = null;
  const published = repository.branchHead;
  const status = await a.restart().status();
  assert.ok(status.kind === "enrolled" && status.phase === "publication-unknown");

  // Another client sees the commit and reverts its content.
  await b.session.sync();
  await b.vault.write("n.md", "original");
  await b.session.sync();
  const reverted = repository.branchHead;
  assert.ok(await repository.isAncestor(published, reverted));

  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.equal(repository.branchHead, reverted, "no replay commit");
  assert.equal(a.vault.text("n.md"), "original", "the later revert is applied locally");
  await assertConverged(repository, a, b);
});

test("unpublished or inconclusive candidates are retried only when the branch proves they did not land", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "v0" }));
  const a = await enrolled(repository, "A");

  await a.vault.write("n.md", "v1");
  repository.publishFault = "before";
  await assert.rejects(a.session.sync(), Crash);
  repository.publishFault = null;
  repository.ancestorFault = true;
  await a.vault.write("other.md", "o");
  const b = await enrolled(repository, "B"); // moves nothing; head still equals the candidate's parent
  assert.ok(b);
  const out = await a.restart().sync();
  assert.ok(out.kind === "synced" && out.published, "head == parent proves it did not land");
  repository.ancestorFault = false;
  assert.equal(chainLength(repository), 2);
  assert.deepEqual(texts(repository.headFiles()), { "n.md": "v1", "other.md": "o" });

  // The client claims the head moved, but the ref did move to our candidate.
  await a.vault.write("n.md", "v2");
  repository.publishFault = "head-moved-lie";
  const lie = await a.session.sync();
  repository.publishFault = null;
  assert.ok(lie.kind === "synced" && lie.published);
  assert.equal(chainLength(repository), 3);

  // Inconclusive ancestry keeps the operation and publishes nothing new.
  await a.vault.write("n.md", "v3");
  repository.publishFault = "after";
  await assert.rejects(a.session.sync(), Crash);
  repository.publishFault = null;
  await repository.push({ "x.md": (await snapshot({ x: "x" })).x! }); // someone else moves the head
  repository.ancestorFault = true;
  await assert.rejects(a.restart().sync(), Crash);
  const held = await a.session.status();
  assert.ok(held.kind === "enrolled" && held.phase === "publication-unknown");
  repository.ancestorFault = false;
  const settled = await a.session.sync();
  assert.ok(settled.kind === "synced" && settled.published);
  assert.equal(chainLength(repository), 5);
  assert.equal(a.vault.text("x.md"), "x");
  await assertConverged(repository, a);

  // A rejected publication is reported, keeps the capture, and does not loop.
  await a.vault.write("n.md", "v4");
  repository.publishFault = "reject";
  assert.deepEqual(await a.session.sync(), { kind: "rejected", message: "protected branch" });
  repository.publishFault = null;
  assert.equal(repository.calls.filter((call) => call === "publish").length, 5, "settling never re-publishes");
  assert.equal((await a.session.sync()).kind, "synced");
  const records = await a.session.listRecovery();
  assert.ok(Array.isArray(records) && records.length > 0 && records.every((record) => !record.pinned), "published drafts unpin");
});

test("a crash at every durable, publication and apply boundary converges without loss or replay", async () => {
  async function scenario() {
    const repository = await MemoryRepository.create(
      await snapshot({ "p.md": lines(8), "q.md": "q", "gone.md": "g", ".obsidian/x.json": "{}" }),
    );
    const a = await enrolled(repository, "A");
    const b = await enrolled(repository, "B");
    await b.vault.write("q.md", "q from B");
    await b.vault.write("remote-new.md", "r");
    await b.session.sync();
    await a.vault.write("p.md", lines(8, { 2: "A edit" }));
    a.vault.files.set("local.png", await bytes([1, 2, 3, 250]));
    return { repository, a, b, startSaves: a.store.saves, startApplies: a.vault.applyCalls };
  }
  const expected = { "p.md": lines(8, { 2: "A edit" }), "q.md": "q from B", "gone.md": "g", "remote-new.md": "r" };

  // Count boundaries in a clean run.
  const clean = await scenario();
  assert.equal((await clean.a.session.sync()).kind, "synced");
  const saves = clean.a.store.saves - clean.startSaves;
  const applies = clean.a.vault.applyCalls - clean.startApplies;
  assert.ok(saves >= 3 && applies === 2, `saves=${saves} applies=${applies}`);

  assert.equal(saves, 3, "operation, promotion, completion");
  const faults: Array<{ label: string; inject(world: Awaited<ReturnType<typeof scenario>>): void }> = [];
  for (let at = 1; at <= saves; at++) {
    for (const when of ["before", "after"] as const) {
      faults.push({ label: `save ${at} ${when}`, inject: (w) => (w.a.store.fault = { at: w.startSaves + at, when }) });
    }
  }
  for (const when of ["before", "after"] as const) {
    faults.push({ label: `prepare ${when}`, inject: (w) => (w.repository.prepareFault = when) });
    faults.push({ label: `publish ${when}`, inject: (w) => (w.repository.publishFault = when) });
  }
  faults.push({ label: "publish unknown", inject: (w) => (w.repository.publishFault = "lost") });
  for (let at = 1; at <= applies; at++) {
    for (const when of ["before", "after"] as const) {
      faults.push({ label: `apply ${at} ${when}`, inject: (w) => (w.a.vault.applyFault = { at: w.startApplies + at, when }) });
    }
  }

  for (const fault of faults) {
    const world = await scenario();
    const appliedBefore = world.a.vault.applyCalls;
    fault.inject(world);
    let crashed = false;
    try {
      await world.a.session.sync();
    } catch (error) {
      assert.ok(error instanceof Crash, `${fault.label}: ${String(error)}`);
      crashed = true;
    }
    assert.equal(crashed, fault.label !== "publish unknown", `${fault.label}: the fault fired`);
    world.a.store.fault = null;
    world.a.vault.applyFault = null;
    world.repository.prepareFault = null;
    world.repository.publishFault = null;
    world.a.restart();
    for (let round = 0; round < 3; round++) {
      const outcome = await world.a.session.sync();
      assert.ok(outcome.kind === "synced" || outcome.kind === "up-to-date", `${fault.label}: ${JSON.stringify(outcome)}`);
    }
    await world.b.session.sync();
    const files = texts(world.repository.headFiles());
    delete files["local.png"];
    assert.deepEqual(files, expected, fault.label);
    assert.deepEqual([...decodeBytes(world.repository.headFiles()["local.png"]!.data)], [1, 2, 3, 250], fault.label);
    assert.equal(chainLength(world.repository), 3, `${fault.label}: root, B, then exactly one commit from A`);
    assert.ok(".obsidian/x.json" in world.repository.fullHeadFiles(), fault.label);
    await assertConverged(world.repository, world.a, world.b);
    assert.ok(world.a.vault.applyCalls - appliedBefore <= applies + 1, `${fault.label}: no apply loop`);
  }
});

function decodeBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

test("a local edit during application is preserved and later merged, never silently overwritten", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": lines(10), "d.md": "d" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await b.vault.write("n.md", lines(10, { 1: "B one" }));
  b.vault.files.delete("d.md");
  const [deletion] = conflictsOf(await b.session.sync());
  await b.session.resolve({ conflictId: deletion!.id, choice: { kind: "mine" } });
  await b.session.sync();

  // A accepts the deletion, but the user edits both files while A applies.
  const [remoteDeletion] = conflictsOf(await a.session.sync());
  await a.session.resolve({ conflictId: remoteDeletion!.id, choice: { kind: "remote" } });
  a.vault.beforeApply = async (path, vault) => {
    if (path === "n.md") await vault.write("n.md", lines(10, { 7: "A seven" }));
    if (path === "d.md") await vault.write("d.md", "d edited during apply");
  };
  const outcome = await a.session.sync();
  a.vault.beforeApply = null;
  assert.deepEqual(outcome.kind === "synced" && outcome.carried, ["d.md", "n.md"]);
  assert.equal(a.vault.text("n.md"), lines(10, { 7: "A seven" }), "newer edit untouched");
  assert.equal(a.vault.text("d.md"), "d edited during apply");

  // Next sync: the text edit merges with B's change; the deletion becomes a reviewed conflict.
  const [conflict] = conflictsOf(await a.session.sync());
  assert.equal(conflict!.kind, "local-edited-remote-deleted");
  assert.equal(entryText(repository.headFiles()["n.md"]!), lines(10, { 1: "B one" }), "nothing published while a decision is pending");
  await a.session.resolve({ conflictId: conflict!.id, choice: { kind: "mine" } });
  assert.ok((await a.session.sync()).kind === "synced");
  assert.equal(entryText(repository.headFiles()["n.md"]!), lines(10, { 1: "B one", 7: "A seven" }));
  assert.equal(entryText(repository.headFiles()["d.md"]!), "d edited during apply");
  await b.session.sync();
  await assertConverged(repository, a, b);
});

test("blocked binary replacement holds a clear state, never loops, and resolves explicitly", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "img.png": await bytes([1]), "n.md": "n" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  b.vault.files.set("img.png", await bytes([2]));
  await b.session.sync();

  a.vault.blockBinary = true;
  const blocked = await a.session.sync();
  assert.deepEqual(blocked, {
    kind: "blocked",
    commit: repository.branchHead,
    steps: [{ path: "img.png", reason: "binary replacement/deletion is unsupported" }],
  });
  await a.vault.write("n.md", "edit while held");
  const publishes = repository.calls.filter((call) => call === "publish").length;
  assert.equal((await a.session.sync()).kind, "blocked", "one attempt per sync; held, not dropped");
  assert.equal(repository.calls.filter((call) => call === "publish").length, publishes, "nothing published while held");
  const status = await a.session.inspect();
  assert.ok(status.kind === "enrolled" && status.phase === "blocked" && status.blocked[0]!.path === "img.png");
  assert.deepEqual(status.kind === "enrolled" && status.pending, [{ path: "n.md", change: "modified" }], "the held image is not a local change");

  // Manually performing the replacement completes the step.
  a.vault.files.set("img.png", await bytes([2]));
  const done = await a.session.sync();
  assert.ok(done.kind === "synced" && done.published, JSON.stringify(done));
  await b.session.sync();
  await assertConverged(repository, a, b);

  // Or keep this device's version explicitly: it is published as a new change.
  b.vault.files.set("img.png", await bytes([3]));
  await b.session.sync();
  assert.equal((await a.session.sync()).kind, "blocked");
  assert.equal((await a.session.keepLocal({ path: "n.md" })).kind, "stale");
  assert.equal((await a.session.keepLocal({ path: "img.png" })).kind, "recorded");
  const kept = await a.session.sync();
  assert.ok(kept.kind === "synced" && kept.published, JSON.stringify(kept));
  assert.deepEqual([...decodeBytes(repository.headFiles()["img.png"]!.data)], [2]);
});

test("history rewrites and repository identity changes pause until explicit re-enrollment", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "keep.md": "k", "removed.md": "r", "edited.md": "e" }));
  const a = await enrolled(repository, "A");
  await a.vault.write("draft.md", "unpublished draft");
  await repository.forceReset(await snapshot({ "keep.md": "k", "edited.md": "e2" }));
  const before = await a.vault.capture();
  const paused = await a.session.sync();
  assert.equal(paused.kind === "paused" && paused.pause.reason, "history-rewritten");
  assert.equal((await a.session.sync()).kind, "paused");
  assert.ok(sameManifest(await a.vault.capture(), before), "no local mutation");

  const preview = await a.session.previewEnrollment();
  if (preview.kind !== "preview") return assert.fail();
  assert.ok(preview.reenrollment);
  assert.deepEqual(Object.fromEntries(preview.items.map((item) => [item.path, item.action])), {
    "draft.md": "upload",
    "edited.md": "update-local",
    "removed.md": "review-remote-deletion",
  });
  await a.session.enroll({ token: preview.token });
  const [review] = conflictsOf(await a.session.sync());
  assert.equal(review!.kind, "remote-deletion", "removed content is not resurrected");
  await a.session.resolve({ conflictId: review!.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "synced");
  assert.deepEqual(texts(repository.headFiles()), { "keep.md": "k", "edited.md": "e2", "draft.md": "unpublished draft" });
  await assertConverged(repository, a);

  repository.identityValue = { ...repository.identityValue, id: "R_2" };
  const moved = await a.session.sync();
  assert.equal(moved.kind === "paused" && moved.pause.reason, "repository-changed");
});

test("corrupt or tampered state blocks every mutation", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "n" }));
  const a = await enrolled(repository, "A");
  await a.vault.write("n.md", "local");
  const good = a.store.raw!;
  const head = repository.branchHead;
  const variants: Array<[string, string]> = [
    ["not JSON object", "[1,2]"],
    ["wrong format", good.replace("github-vault-sync/1", "github-vault-sync/9")],
    ["extra key", good.replace("{", '{"extra":1,')],
    ["bad path", good.replace('"n.md"', '"../n.md"')],
    ["bad oid", good.replace(/"commit":"[0-9a-f]{40}"/, '"commit":"zz"')],
  ];
  // A state that references blobs, then tampered.
  await a.vault.write("n.md", "conflict");
  await repository.push({ "n.md": (await snapshot({ x: "remote" })).x! });
  conflictsOf(await a.session.sync());
  const withBlobs = a.store.raw!;
  const parsed = JSON.parse(withBlobs);
  const [oid] = Object.keys(parsed.blobs);
  parsed.blobs[oid!] = encodeBase64(new TextEncoder().encode("tampered"));
  variants.push(["tampered blob", JSON.stringify(parsed)]);
  delete parsed.blobs[oid!];
  variants.push(["missing blob", JSON.stringify(parsed)]);

  for (const [label, raw] of variants) {
    a.store.raw = raw;
    const snapshotBefore = await a.vault.capture();
    const branch = repository.branchHead;
    const outcome = await a.restart().sync();
    assert.equal(outcome.kind, "corrupt", label);
    assert.equal((await a.session.previewEnrollment()).kind, "corrupt", label);
    assert.equal((await a.session.enroll({ token: "x" })).kind, "corrupt", label);
    assert.equal(a.store.raw, raw, `${label}: store untouched`);
    assert.ok(sameManifest(await a.vault.capture(), snapshotBefore), label);
    assert.equal(repository.branchHead, branch, label);
  }
  assert.notEqual(head, repository.branchHead);
});

test("history restore stages a reviewed draft that publishes as a new commit", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "v1" }));
  const a = await enrolled(repository, "A");
  const first = repository.branchHead;
  await a.vault.write("n.md", "v2");
  await a.session.sync();
  const second = repository.branchHead;

  assert.equal((await a.session.previewRestore({ path: "n.md", commit: "0".repeat(40) })).kind, "not-in-history");
  assert.equal((await a.session.previewRestore({ path: "../n.md", commit: first })).kind, "invalid-path");
  assert.equal((await a.session.previewRestore({ path: "nope.md", commit: first })).kind, "missing");
  const preview = await a.session.previewRestore({ path: "n.md", commit: first });
  if (preview.kind !== "preview") return assert.fail();
  assert.equal(entryText(preview.historical), "v1");
  assert.equal(entryText(preview.current!), "v2");

  await a.vault.write("n.md", "v2 edited");
  assert.equal((await a.session.restore(preview)).kind, "stale");
  const fresh = await a.session.previewRestore({ path: "n.md", commit: first });
  if (fresh.kind !== "preview") return assert.fail();
  assert.equal((await a.session.restore(fresh)).kind, "restored");
  assert.equal(a.vault.text("n.md"), "v1");
  assert.equal(repository.branchHead, second, "restore itself publishes nothing");
  const records = await a.session.listRecovery();
  assert.ok(Array.isArray(records) && records.some((record) => record.reason === "restore" && record.paths.includes("n.md")));

  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(entryText(repository.headFiles()["n.md"]!), "v1");
  assert.ok(await repository.isAncestor(second, repository.branchHead), "history is extended, not rewound");
});

test("case collisions need a rename; concurrent calls are serialized", async () => {
  const repository = await MemoryRepository.create(await snapshot({}));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await b.vault.write("Note.md", "B");
  await b.session.sync();
  await a.vault.write("note.md", "A");
  const outcome = await a.session.sync();
  assert.equal(outcome.kind, "needs-decision");
  if (outcome.kind !== "needs-decision") return;
  assert.equal(outcome.conflicts[0]!.kind, "collision");
  const decision = await a.session.resolve({ conflictId: outcome.conflicts[0]!.id, choice: { kind: "mine" } });
  assert.equal(decision.kind, "invalid");
  a.vault.files.delete("note.md");
  await a.vault.write("note (A).md", "A");

  const [one, two] = await Promise.all([a.session.sync(), a.session.sync()]);
  assert.equal(one.kind, "synced");
  assert.equal(two.kind, "up-to-date");
  assert.equal(repository.calls.filter((call) => call === "publish").length, 2);
  await b.session.sync();
  await assertConverged(repository, a, b);
  assert.deepEqual(toManifest(repository.headFiles())["Note.md"] !== undefined, true);
});
