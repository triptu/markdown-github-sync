import { test } from "node:test";
import assert from "node:assert/strict";
import { dictionary, own, encodeBase64, entryFromBytes, entryFromText, entryText, sameManifest, toManifest } from "../src/git-sync/codec";
import type { StoredState } from "../src/git-sync/state";
import { parseState, STATE_FORMAT } from "../src/git-sync/state";
import type { Snapshot } from "../src/git-sync/contracts";
import { SyncSession } from "../src/git-sync/session";
import type { SyncOutcome } from "../src/git-sync/session";
import type { VersionConflict } from "../src/git-sync/reconcile";
import { Crash, MemoryRepository, MemoryStore, MemoryVault, bytes, snapshot, texts } from "./git-fakes";

function failSaveMatching(store: MemoryStore, matches: (state: StoredState) => boolean, when: "before" | "after") {
  const save = store.save.bind(store);
  store.save = async (state) => {
    if (matches(await parseState(state))) {
      store.save = save;
      store.fault = { at: store.saves + 1, when };
    }
    await save(state);
  };
}

const NOW = () => new Date("2026-10-13T12:00:00Z");
const lines = (count: number, edit: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => `${edit[index] ?? `line ${index}`}\n`).join("");

for (const observer of ["inspect", "previewRestore", "restore", "restore-response-lost", "notifyLocalChange"] as const) {
  test(`${observer} invalidates deletion approval across recreation and a second deletion`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "blocker.md": "base" }));
    const a = await enrolled(repository);
    const original = repository.branchHead;
    a.vault.files.delete("n.md");
    await a.vault.write("blocker.md", "local");
    await repository.push({ "blocker.md": await entryFromText("remote") });
    const first = conflictsOf(await a.session.sync()).find((item) => item.path === "n.md")!;
    assert.equal(first.kind, "local-deletion");
    await a.session.resolve({ conflictId: first.id, choice: { kind: "mine" } });
    if (observer === "restore" || observer === "restore-response-lost") {
      const preview = await a.session.previewRestore({ path: "n.md", commit: original });
      assert.ok(preview.kind === "preview");
      if (observer === "restore-response-lost") {
        a.vault.applyFault = { at: a.vault.applyCalls + 1, when: "after" };
        await assert.rejects(a.session.restore(preview), Crash);
        a.vault.applyFault = null;
      } else assert.equal((await a.session.restore(preview)).kind, "restored");
      assert.equal(a.vault.text("n.md"), "base");
    } else {
      await a.vault.write("n.md", "new incarnation");
      if (observer === "inspect") {
        const observed = await a.session.inspect();
        assert.ok(observed.kind === "enrolled" && observed.pending?.some((item) => item.path === "n.md"));
      } else if (observer === "previewRestore") {
        assert.equal((await a.session.previewRestore({ path: "n.md", commit: original })).kind, "preview");
      } else {
        // The port has already observed events, but capture sees identical absence.
        a.vault.files.delete("n.md");
        assert.equal((await a.session.notifyLocalChange()).kind, "invalidated");
      }
    }
    a.vault.files.delete("n.md");
    const fresh = conflictsOf(await a.restart().sync());
    const deletion = fresh.find((item) => item.path === "n.md");
    assert.ok(deletion, "the second deletion requires fresh review after restart");
    assert.notEqual(deletion.id, first.id);
    assert.equal((await a.session.resolve({ conflictId: first.id, choice: { kind: "mine" } })).kind, "stale");
    const blocker = fresh.find((item) => item.path === "blocker.md")!;
    await a.session.resolve({ conflictId: blocker.id, choice: { kind: "remote" } });
    assert.ok(conflictsOf(await a.session.sync()).some((item) => item.path === "n.md"));
    assert.ok(Object.hasOwn(repository.headFiles(), "n.md"), "resolving the other conflict cannot publish the unapproved deletion");
    await a.session.resolve({ conflictId: deletion.id, choice: { kind: "remote" } });
    assert.equal((await a.session.sync()).kind, "synced");
    assert.equal(a.vault.text("n.md"), "base");
  });
}

test("an unrelated edit during apply preserves its carry origin before pruning and converges", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "unmodified baseline" }));
  const a = await enrolled(repository);
  await repository.push({ "n.md": await entryFromText("remote") });
  a.vault.beforeApply = async (_path, vault) => vault.write("other.md", "edited while applying n.md");
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.carried.includes("other.md"));
  const saved = await parseState(await a.store.load());
  const origin = await entryFromText("unmodified baseline");
  assert.equal(saved.carry["other.md"]?.oid, origin.oid);
  assert.equal(saved.blobs[origin.oid], origin.data);
  const draft = await entryFromText("edited while applying n.md");
  assert.equal(saved.blobs[draft.oid], draft.data);
  a.vault.beforeApply = null;
  assert.equal((await a.restart().sync()).kind, "synced");
  await assertConverged(repository, a);
});

test("blocked application and resumes archive captured concurrent Markdown drafts", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "image.png": "old binary" }));
  const a = await enrolled(repository);
  await repository.push(await snapshot({ "n.md": "remote", "image.png": "new binary" }));
  a.vault.blockBinary = true;
  a.vault.beforeApply = async (path, vault) => {
    if (path === "n.md") await vault.write(path, "newer edit during blocked transaction");
  };
  assert.equal((await a.session.sync()).kind, "blocked");
  const firstSaved = await parseState(await a.store.load());
  const firstDraft = (await a.vault.capture())["n.md"]!;
  assert.equal(firstSaved.blobs[firstDraft.oid], firstDraft.data, "post-apply capture is archived on the first blocked return");
  a.vault.beforeApply = null;
  const drafts = [await entryFromText("newer edit during blocked transaction"), await entryFromText("newer draft on resume")];
  // The first post-apply capture and a later resume capture must both survive.
  for (const draft of drafts) {
    await a.vault.write("n.md", entryText(draft)!);
    assert.equal((await a.restart().sync()).kind, "blocked");
    const saved = await parseState(await a.store.load());
    assert.equal(saved.blobs[draft.oid], draft.data);
    const record = saved.recovery.find((item) => item.pinned && item.files["n.md"]?.oid === draft.oid);
    assert.ok(record);
    const exported = await a.session.exportRecovery({ id: record.id });
    assert.ok(exported && !("kind" in exported));
    assert.equal(exported["n.md"]?.data, draft.data);
  }
});

test("an intermediate carry save retains an unrelated draft's origin across a lost response", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "unmodified baseline" }));
  const a = await enrolled(repository);
  const checkpoint = repository.branchHead;
  await repository.push({ "n.md": await entryFromText("remote") });
  a.vault.beforeApply = async (_path, vault) => vault.write("other.md", "draft during application");
  failSaveMatching(a.store, (state) => state.recovery.some((record) => record.reason === "carried" && "other.md" in record.files), "after");
  await assert.rejects(a.session.sync(), Crash);
  const saved = await parseState(await a.store.load());
  assert.equal(saved.base.commit, checkpoint);
  assert.ok(saved.operation?.kind === "apply");
  const origin = await entryFromText("unmodified baseline");
  const draft = await entryFromText("draft during application");
  for (const entry of [origin, draft]) {
    assert.equal(saved.blobs[entry.oid], entry.data);
    assert.ok(saved.recovery.some((record) => record.pinned && record.files["other.md"]?.oid === entry.oid));
  }
  a.store.fault = null;
  a.vault.beforeApply = null;
  const resumed = await a.restart().sync();
  assert.ok(resumed.kind === "synced" || resumed.kind === "up-to-date");
  await assertConverged(repository, a);
});

test("a valid long conflict path stays durable without an invalid sibling choice", async () => {
  const path = ("a".repeat(200) + "/").repeat(20) + "n".repeat(61) + ".md";
  const repository = await MemoryRepository.create(await snapshot({ [path]: "base" }));
  const a = await enrolled(repository);
  await a.vault.write(path, "local");
  await repository.push({ [path]: await entryFromText("remote") });
  const conflict = conflictsOf(await a.session.sync())[0]!;
  assert.equal(conflict.sibling, null);
  assert.ok(!conflict.choices.includes("both"));
  assert.equal((await a.restart().status()).kind, "enrolled");
  assert.equal((await a.session.resolve({ conflictId: conflict.id, choice: { kind: "both" } })).kind, "invalid");
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "synced");
  await assertConverged(repository, a);
});

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

test("uncertain candidates remain held until reachable, including at their parent", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "v0" }));
  const a = await enrolled(repository, "A");

  await a.vault.write("n.md", "v1");
  repository.publishFault = "before";
  await assert.rejects(a.session.sync(), Crash);
  repository.publishFault = null;
  const parent = repository.branchHead;
  const heldAtParent = await a.restart().sync();
  assert.equal(heldAtParent.kind, "publication-unknown");
  assert.equal(repository.branchHead, parent);
  assert.equal(repository.calls.filter((call) => call === "prepare").length, 1);
  const pending = await parseState(await a.store.load());
  assert.ok(pending.operation?.kind === "publish");
  // Only an externally confirmed reachable candidate can settle automatically.
  repository.branchHead = pending.operation.candidate.commit;
  assert.ok((await a.session.sync()).kind === "synced");
  assert.equal(chainLength(repository), 2);
  assert.deepEqual(texts(repository.headFiles()), { "n.md": "v1" });

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
  assert.equal((await a.restart().sync()).kind, "publication-unknown");
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
  assert.equal((await a.session.sync()).kind, "publication-unknown");
  repository.publishFault = null;
  assert.equal(repository.calls.filter((call) => call === "publish").length, 4, "settling never re-publishes");
  assert.equal((await a.session.sync()).kind, "publication-unknown", "a classification cannot prove nonpublication");
  const records = await a.session.listRecovery();
  assert.ok(Array.isArray(records) && records.some((record) => record.pinned), "held drafts remain pinned");
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

  assert.ok(saves >= 8, "operation, observation attempts/results, promotion and completion are durable");
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
      let outcome = await world.a.session.sync();
      if (outcome.kind === "publication-unknown") {
        assert.equal(world.repository.branchHead, outcome.parent, `${fault.label}: no speculative retry`);
        const pending = await parseState(await world.a.store.load());
        assert.ok(pending.operation?.kind === "publish");
        // Model a separately reviewed owner action that makes this exact
        // candidate reachable; the engine itself must never retry it.
        world.repository.branchHead = pending.operation.candidate.commit;
        outcome = await world.a.session.sync();
      }
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
    assert.equal(path, "n.md", "the CAS-observed edit revokes the later deletion");
    await vault.write("n.md", lines(10, { 7: "A seven" }));
    await vault.write("d.md", "d edited during apply");
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
    ["wrong format", good.replace(STATE_FORMAT, "github-vault-sync/9")],
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

for (const sibling of [false, true]) {
  test(`unknown publication stays held after an accepted candidate is rewound${sibling ? " and replaced by a sibling" : ""}`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    const parent = repository.branchHead;
    await a.vault.write("n.md", "edit intentionally removed by rewind");
    const originalPublish = repository.publish.bind(repository);
    repository.publish = async (expected, candidate) => {
      await originalPublish(expected, candidate);
      repository.branchHead = parent;
      if (sibling) await repository.push({ "sibling.md": await entryFromText("sibling") });
      repository.publish = originalPublish;
      return { kind: "unknown" };
    };
    const headAfterRewind = () => repository.branchHead;
    assert.equal((await a.session.sync()).kind, "publication-unknown");
    const heldHead = headAfterRewind();
    const prepares = repository.calls.filter((call) => call === "prepare").length;
    const publishes = repository.calls.filter((call) => call === "publish").length;
    for (let round = 0; round < 3; round++) assert.equal((await a.restart().sync()).kind, "publication-unknown");
    assert.equal(repository.branchHead, heldHead);
    assert.equal(entryText(repository.headFiles()["n.md"]!), "base");
    assert.equal(repository.calls.filter((call) => call === "prepare").length, prepares);
    assert.equal(repository.calls.filter((call) => call === "publish").length, publishes);
    assert.ok((await parseState(await a.store.load())).operation?.kind === "publish");
    assert.equal(a.vault.text("n.md"), "edit intentionally removed by rewind");
  });
}

test("head-moved without candidate reachability is held, never treated as proof of nonpublication", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "draft");
  repository.publish = async () => {
    await repository.push({ "sibling.md": await entryFromText("sibling") });
    return { kind: "head-moved" };
  };
  assert.equal((await a.session.sync()).kind, "publication-unknown");
  const head = repository.branchHead;
  assert.equal((await a.restart().sync()).kind, "publication-unknown");
  assert.equal(repository.branchHead, head);
  assert.equal(repository.calls.filter((call) => call === "prepare").length, 1);
});

test("changed remote heads invalidate approvals even when the same remote bytes return", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "blocked.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "local");
  await a.vault.write("blocked.md", "local");
  await repository.push(await snapshot({ "n.md": "remote1", "blocked.md": "remote" }));
  const first = conflictsOf(await a.session.sync()).find((item) => item.path === "n.md")!;
  await a.session.resolve({ conflictId: first.id, choice: { kind: "remote" } });
  assert.ok(Object.hasOwn((await parseState(await a.store.load())).decisions, first.id));
  await repository.push(await snapshot({ "n.md": "remote2" }));
  assert.ok(conflictsOf(await a.session.sync()).some((item) => item.path === "n.md"));
  assert.equal(Object.keys((await parseState(await a.store.load())).decisions).length, 0);
  await repository.push(await snapshot({ "n.md": "remote1" }));
  const returned = conflictsOf(await a.session.sync()).find((item) => item.path === "n.md")!;
  assert.notEqual(returned.id, first.id);
  assert.equal((await a.session.resolve({ conflictId: first.id, choice: { kind: "remote" } })).kind, "stale");
  assert.equal(a.vault.text("n.md"), "local");
});

test("a recreated file invalidates deletion approval before a distinct deletion with identical versions", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "blocked.md": "base" }));
  const a = await enrolled(repository);
  a.vault.files.delete("n.md");
  await a.vault.write("blocked.md", "local");
  await repository.push(await snapshot({ "blocked.md": "remote" }));
  const first = conflictsOf(await a.session.sync()).find((item) => item.path === "n.md")!;
  await a.session.resolve({ conflictId: first.id, choice: { kind: "mine" } });
  await a.vault.write("n.md", "base");
  assert.ok(!conflictsOf(await a.session.sync()).some((item) => item.path === "n.md"));
  assert.equal(Object.keys((await parseState(await a.store.load())).decisions).length, 0);
  a.vault.files.delete("n.md");
  const second = conflictsOf(await a.restart().sync()).find((item) => item.path === "n.md")!;
  assert.equal(second.kind, "local-deletion");
  assert.notEqual(second.id, first.id);
  assert.equal((await a.session.resolve({ conflictId: first.id, choice: { kind: "mine" } })).kind, "stale");
  assert.ok(Object.hasOwn(repository.headFiles(), "n.md"));
});

test("newer carried bytes are durable with their own recovery record before checkpoint advancement", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  const old = repository.branchHead;
  const incoming = await entryFromText("remote");
  await repository.push({ "n.md": incoming });
  a.vault.beforeApply = async (path, vault) => {
    await vault.write(path, "newer edit during application");
    await vault.write("constructor", "newer added file");
  };
  const target = repository.branchHead;
  // Lose completion acknowledgement after the state lands; restart must still
  // recover the exact captured draft, without relying on the live file.
  const save = a.store.save.bind(a.store);
  a.store.save = async (state) => {
    await save(state);
    if ((await parseState(state)).base.commit === target) throw new Crash("checkpoint acknowledgement lost");
  };
  await assert.rejects(a.session.sync(), Crash);
  const saved = await parseState(await a.store.load());
  assert.notEqual(saved.base.commit, old);
  assert.equal(saved.base.commit, target);
  const live = await a.vault.capture();
  assert.equal(saved.blobs[live["n.md"]!.oid], live["n.md"]!.data);
  assert.equal(saved.blobs[own(live, "constructor")!.oid], own(live, "constructor")!.data);
  assert.equal(saved.carry["n.md"]?.oid, (await entryFromText("base")).oid, "origin is distinct from captured draft");
  const newerRecord = saved.recovery.find((record) => record.files["n.md"]?.oid === live["n.md"]!.oid)!;
  assert.ok(newerRecord.pinned);
  assert.equal(saved.operation, null);
  a.store.save = save;
  a.vault.files.clear();
  const exported = await a.restart().exportRecovery({ id: newerRecord.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(exported["n.md"]?.data, live["n.md"]!.data);
  assert.equal(own(exported, "constructor")?.data, own(live, "constructor")!.data);
});

test("blocked incoming binaries have durable, pinned, exportable bytes and are validated on load", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "image.png": await bytes([1, 255]) }));
  const a = await enrolled(repository);
  const incoming = await bytes([2, 0, 254]);
  await repository.push({ "image.png": incoming });
  a.vault.blockBinary = true;
  assert.equal((await a.session.sync()).kind, "blocked");
  const saved = await parseState(await a.store.load());
  assert.ok(saved.operation?.incoming.kind === "captured");
  const incomingId = saved.operation.incoming.recoveryId!;
  assert.ok(saved.recovery.find((record) => record.id === incomingId)?.pinned);
  assert.equal(saved.blobs[incoming.oid], incoming.data);
  const exported = await a.restart().exportRecovery({ id: incomingId });
  assert.ok(exported && !("kind" in exported));
  assert.equal(exported["image.png"]?.data, incoming.data);
  assert.equal((await a.session.discardRecovery({ id: incomingId })).kind, "in-use");
  const tampered = JSON.parse(a.store.raw!);
  delete tampered.blobs[incoming.oid];
  a.store.raw = JSON.stringify(tampered);
  assert.equal((await a.restart().sync()).kind, "corrupt");
  assert.equal(a.vault.text("image.png"), entryText(await bytes([1, 255])));
});

test("publication abandonment requires a fresh review, preserves candidate and drafts, and prevents replay on re-enrollment", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "removed.md": "old" }));
  const a = await enrolled(repository);
  const parent = repository.branchHead;
  await a.vault.write("n.md", "candidate draft");
  await a.vault.write("removed.md", "candidate removed by owner");
  const publish = repository.publish.bind(repository);
  repository.publish = async (expected, candidate) => {
    await publish(expected, candidate);
    repository.branchHead = parent;
    await repository.push({ "removed.md": null });
    repository.publish = publish;
    return { kind: "unknown" };
  };
  assert.equal((await a.session.sync()).kind, "publication-unknown");
  const first = await a.session.previewPublicationRecovery();
  assert.ok(first.kind === "preview");
  assert.equal(entryText(first.candidateFiles["n.md"]!), "candidate draft");
  await a.vault.write("n.md", "newer reviewed draft");
  assert.equal((await a.session.recoverPublication({ token: first.token })).kind, "stale");
  const next = await a.session.previewPublicationRecovery();
  assert.ok(next.kind === "preview");
  await repository.push({ "other.md": await entryFromText("new head") });
  assert.equal((await a.session.recoverPublication({ token: next.token })).kind, "stale");
  const preview = await a.session.previewPublicationRecovery();
  assert.ok(preview.kind === "preview");
  const head = repository.branchHead;
  const vaultBefore = await a.vault.capture();
  const publishedBefore = repository.calls.filter((call) => call === "publish").length;
  assert.equal((await a.session.recoverPublication({ token: preview.token })).kind, "released");
  assert.equal(repository.branchHead, head);
  assert.ok(sameManifest(await a.vault.capture(), vaultBefore));
  const saved = await parseState(await a.store.load());
  assert.equal(saved.operation, null);
  assert.ok(saved.pause);
  const candidateRecord = saved.recovery.find((record) => record.files["n.md"]?.oid === preview.candidateFiles["n.md"]!.oid)!;
  const draftRecord = saved.recovery.find((record) => record.files["n.md"]?.oid === preview.localFiles["n.md"]!.oid)!;
  assert.ok(candidateRecord.pinned && draftRecord.pinned);
  const exported = await a.session.exportRecovery({ id: candidateRecord.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(exported["n.md"]?.data, preview.candidateFiles["n.md"]!.data);
  const enrollment = await a.session.previewEnrollment();
  assert.ok(enrollment.kind === "preview");
  assert.equal(enrollment.items.find((item) => item.path === "n.md")?.action, "update-local");
  assert.equal(enrollment.items.find((item) => item.path === "removed.md")?.action, "review-remote-deletion");
  await a.session.enroll({ token: enrollment.token });
  const deletion = conflictsOf(await a.session.sync()).find((item) => item.path === "removed.md")!;
  await a.session.resolve({ conflictId: deletion.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(a.vault.text("n.md"), "base");
  assert.equal(a.vault.text("removed.md"), null);
  assert.equal(repository.calls.filter((call) => call === "publish").length, publishedBefore);
  assert.equal((await a.session.previewPublicationRecovery()).kind, "missing");
});

test("recovery refuses a candidate that became reachable and enrollment cannot clear a held operation", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "draft");
  repository.publishFault = "before";
  await assert.rejects(a.session.sync(), Crash);
  repository.publishFault = null;
  const preview = await a.session.previewPublicationRecovery();
  assert.ok(preview.kind === "preview");
  const identity = repository.identityValue;
  repository.identityValue = { ...identity, id: "other-repository" };
  assert.equal((await a.session.sync()).kind, "paused");
  assert.equal((await a.session.previewEnrollment()).kind, "already-enrolled");
  assert.equal((await a.session.enroll({ token: "anything" })).kind, "already-enrolled");
  assert.equal((await a.session.recoverPublication({ token: preview.token })).kind, "paused");
  repository.identityValue = identity;
  repository.branchHead = preview.candidate;
  assert.equal((await a.session.recoverPublication({ token: preview.token })).kind, "reachable");
  assert.equal((await a.restart().sync()).kind, "synced", "restored identity resumes the preserved operation");
});

test("legacy approvals are discarded and legacy uncertain publication remains held", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "local");
  await repository.push(await snapshot({ "n.md": "remote" }));
  const first = conflictsOf(await a.session.sync())[0]!;
  const edited = await entryFromText("replacement only in legacy approval");
  await a.session.resolve({ conflictId: first.id, choice: { kind: "edit", data: edited.data } });
  const legacyReview = JSON.parse(a.store.raw!);
  legacyReview.format = "github-vault-sync/1";
  delete legacyReview.review.scope;
  delete legacyReview.review.local;
  a.store.raw = JSON.stringify(legacyReview);
  const migrated = await parseState(await a.store.load());
  assert.equal(migrated.format, STATE_FORMAT);
  assert.equal(migrated.review, null);
  assert.deepEqual(Object.keys(migrated.decisions), []);
  assert.ok(migrated.recovery.some((record) => record.files["n.md"]?.oid === edited.oid && record.pinned));
  assert.equal(migrated.blobs[edited.oid], edited.data);
  const fresh = conflictsOf(await a.restart().sync())[0]!;
  assert.notEqual(fresh.id, first.id);
  await a.session.resolve({ conflictId: fresh.id, choice: { kind: "mine" } });
  repository.publishFault = "before";
  await assert.rejects(a.session.sync(), Crash);
  repository.publishFault = null;
  const legacyOperation = JSON.parse(a.store.raw!);
  legacyOperation.format = "github-vault-sync/1";
  delete legacyOperation.operation.incoming;
  if (legacyOperation.review) {
    delete legacyOperation.review.scope;
    delete legacyOperation.review.local;
  }
  a.store.raw = JSON.stringify(legacyOperation);
  const head = repository.branchHead;
  const prepares = repository.calls.filter((call) => call === "prepare").length;
  assert.equal((await a.restart().sync()).kind, "publication-unknown");
  assert.equal(repository.branchHead, head);
  assert.equal(repository.calls.filter((call) => call === "prepare").length, prepares);
  assert.ok((await parseState(await a.store.load())).operation?.kind === "publish");
});

test("legacy incoming operations acquire durable incoming bytes before application resumes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "image.png": await bytes([1]) }));
  const a = await enrolled(repository);
  const incoming = await bytes([2]);
  await repository.push({ "image.png": incoming });
  a.vault.blockBinary = true;
  assert.equal((await a.session.sync()).kind, "blocked");
  const saved = await parseState(await a.store.load());
  assert.ok(saved.operation?.incoming.kind === "captured");
  const incomingId = saved.operation.incoming.recoveryId;
  const legacy = JSON.parse(a.store.raw!);
  legacy.format = "github-vault-sync/1";
  legacy.recovery = legacy.recovery.filter((record: { id: string }) => record.id !== incomingId);
  delete legacy.blobs[incoming.oid];
  delete legacy.operation.incoming;
  if (legacy.review) {
    delete legacy.review.scope;
    delete legacy.review.local;
  }
  a.store.raw = JSON.stringify(legacy);
  assert.equal((await a.restart().sync()).kind, "blocked");
  const repaired = await parseState(await a.store.load());
  assert.equal(repaired.format, STATE_FORMAT);
  assert.ok(repaired.operation?.incoming.kind === "captured");
  assert.equal(repaired.blobs[incoming.oid], incoming.data);
  assert.ok(repaired.recovery.some((record) => record.files["image.png"]?.oid === incoming.oid && record.pinned));
});

test("JSON prototype-key manifests, carry and recovery retain own keys at load and save boundaries", async () => {
  const repository = await MemoryRepository.create(await snapshot({}));
  const a = await device(repository);
  const save = a.store.save.bind(a.store);
  a.store.save = async (state) => {
    assert.ok(typeof state === "object" && state !== null);
    for (const key of ["carry", "decisions", "blobs"]) assert.equal(Object.getPrototypeOf(Reflect.get(state, key)), null);
    assert.equal(Object.getPrototypeOf(Reflect.get(state, "base").files), null);
    for (const record of Reflect.get(state, "recovery")) assert.equal(Object.getPrototypeOf(record.files), null);
    await save(state);
  };
  const entries = Object.fromEntries(await Promise.all(["__proto__", "constructor", "toString"].map(async (path) => [path, await entryFromText(path)] as const)));
  for (const [path, entry] of Object.entries(entries)) a.vault.files.set(path, entry);
  const preview = await a.session.previewEnrollment();
  assert.ok(preview.kind === "preview");
  assert.deepEqual(preview.items.map((item) => item.path).sort(), Object.keys(entries).sort());
  await a.session.enroll({ token: preview.token });
  const saved = await parseState(await a.store.load());
  const record = saved.recovery[0]!;
  assert.equal(Object.getPrototypeOf(saved.base.files), null);
  assert.equal(Object.getPrototypeOf(saved.carry), null);
  assert.equal(Object.getPrototypeOf(saved.blobs), null);
  assert.equal(Object.getPrototypeOf(saved.decisions), null);
  assert.equal(Object.getPrototypeOf(record.files), null);
  assert.deepEqual(Object.keys(record.files).sort(), Object.keys(entries).sort());
  const exported = await a.session.exportRecovery({ id: record.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(Object.getPrototypeOf(exported), null);
  assert.ok(sameManifest(exported, entries));
  const raw = JSON.parse(a.store.raw!);
  raw.base.files = toManifest(entries);
  raw.carry = Object.fromEntries(Object.entries(toManifest(entries)));
  await assert.doesNotReject(parseState(raw));
  const parsed = await parseState(raw);
  assert.deepEqual(Object.keys(parsed.base.files).sort(), Object.keys(entries).sort());
  assert.deepEqual(Object.keys(parsed.carry).sort(), Object.keys(entries).sort());
});

test("an omitted legacy __proto__ baseline is recovered from the immutable checkpoint before deletion review", async () => {
  const entry = await entryFromText("prototype file");
  const repository = await MemoryRepository.create(Object.fromEntries([["__proto__", entry]]));
  // These ports expose the own Git tree key. The shared test fake's view uses an
  // ordinary assignment and would itself drop it before the engine can see it.
  const view = async (commit: string) => {
    const raw = repository.commits.get(commit)!;
    return { oid: raw.oid, treeOid: raw.tree, files: dictionary(Object.entries(raw.files)) };
  };
  repository.head = () => view(repository.branchHead);
  repository.readCommit = view;
  const a = await device(repository);
  a.vault.files.set("__proto__", entry);
  const preview = await a.session.previewEnrollment();
  assert.ok(preview.kind === "preview");
  await a.session.enroll({ token: preview.token });
  const raw = JSON.parse(a.store.raw!);
  raw.format = "github-vault-sync/1";
  delete raw.base.files["__proto__"];
  a.store.raw = JSON.stringify(raw);
  a.vault.files.delete("__proto__");
  const conflict = conflictsOf(await a.restart().sync())[0]!;
  assert.equal(conflict.path, "__proto__");
  assert.equal(conflict.kind, "local-deletion");
  const saved = await parseState(await a.store.load());
  assert.equal(saved.base.files["__proto__"]?.oid, entry.oid);
  assert.equal(Object.getPrototypeOf(saved.review?.local), null);
});

test("carried draft persistence can crash before checkpoint advancement without losing the captured bytes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  const base = repository.branchHead;
  await repository.push(await snapshot({ "n.md": "remote" }));
  a.vault.beforeApply = async (path, vault) => vault.write(path, "newer captured draft");
  const draft = await entryFromText("newer captured draft");
  const save = a.store.save.bind(a.store);
  a.store.save = async (state) => {
    await save(state);
    const saved = await parseState(state);
    if (saved.base.commit === base && saved.recovery.some((record) => record.files["n.md"]?.oid === draft.oid)) {
      throw new Crash("carried draft acknowledgement lost");
    }
  };
  await assert.rejects(a.session.sync(), Crash);
  const saved = await parseState(await a.store.load());
  assert.equal(saved.base.commit, base, "draft is durable before advancement");
  assert.ok(saved.operation?.kind === "apply");
  const newer = (await a.vault.capture())["n.md"]!;
  const record = saved.recovery.find((item) => item.files["n.md"]?.oid === newer.oid)!;
  assert.ok(record.pinned);
  assert.equal(saved.blobs[newer.oid], newer.data);
  a.store.save = save;
  a.vault.beforeApply = null;
  const exported = await a.restart().exportRecovery({ id: record.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(exported["n.md"]?.data, newer.data);
  assert.equal((await a.session.sync()).kind, "needs-decision", "the carried conflict is reviewed after resuming");
});

test("invalidating an edited conflict approval preserves its replacement and the prior local version", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "blocked.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "prior local version");
  await a.vault.write("blocked.md", "local");
  await repository.push(await snapshot({ "n.md": "remote", "blocked.md": "remote" }));
  const conflict = conflictsOf(await a.session.sync()).find((item) => item.path === "n.md")!;
  const edited = await entryFromText("edited replacement");
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "edit", data: edited.data } });
  await a.vault.write("n.md", "changed again");
  conflictsOf(await a.session.sync());
  const saved = await parseState(await a.store.load());
  assert.equal(Object.keys(saved.decisions).length, 0);
  for (const entry of [edited, conflict.local!]) {
    assert.equal(saved.blobs[entry.oid], entry.data);
    assert.ok(saved.recovery.some((record) => record.pinned && record.files["n.md"]?.oid === entry.oid));
  }
});

test("re-enrollment repairs an omitted prototype baseline before classifying content removed by a rewrite", async () => {
  const entry = await entryFromText("removed prototype file");
  const repository = await MemoryRepository.create(Object.fromEntries([["__proto__", entry]]));
  const view = async (commit: string) => {
    const raw = repository.commits.get(commit)!;
    return { oid: raw.oid, treeOid: raw.tree, files: dictionary(Object.entries(raw.files)) };
  };
  repository.head = () => view(repository.branchHead);
  repository.readCommit = view;
  const a = await device(repository);
  a.vault.files.set("__proto__", entry);
  const preview = await a.session.previewEnrollment();
  assert.ok(preview.kind === "preview");
  await a.session.enroll({ token: preview.token });
  const raw = JSON.parse(a.store.raw!);
  raw.format = "github-vault-sync/1";
  delete raw.base.files["__proto__"];
  a.store.raw = JSON.stringify(raw);
  await repository.forceReset(await snapshot({ "other.md": "replacement history" }));
  assert.equal((await a.session.sync()).kind, "paused");
  const reenrollment = await a.session.previewEnrollment();
  assert.ok(reenrollment.kind === "preview");
  assert.equal(reenrollment.items.find((item) => item.path === "__proto__")?.action, "review-remote-deletion");
});

function eventGate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function reviewedDeletion() {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  a.vault.files.delete("n.md");
  const conflict = conflictsOf(await a.session.sync())[0]!;
  return { ...a, repository, conflict };
}

function forwardSameByteCycle(a: { vault: MemoryVault; session: SyncSession }, entry: Snapshot[string]) {
  const original = a.vault.files.get("n.md");
  a.vault.files.set("n.md", entry);
  const changed = a.session.notifyLocalChange();
  if (original) a.vault.files.set("n.md", original);
  else a.vault.files.delete("n.md");
  const reverted = a.session.notifyLocalChange();
  return Promise.all([changed, reverted]);
}

for (const boundary of ["head", "capture", "checkpoint", "prepare", "publish-save"] as const) {
  test(`forwarded same-byte events at ${boundary} retire an active sync's deletion approval before publication`, async () => {
    const a = await reviewedDeletion();
    if (boundary === "checkpoint") {
      await a.repository.push(await snapshot({ "other.md": "remote addition" }));
      a.conflict = conflictsOf(await a.session.sync())[0]!;
    }
    await a.session.resolve({ conflictId: a.conflict.id, choice: { kind: "mine" } });
    const entered = eventGate(), resume = eventGate();
    let first = true;
    const pause = async () => {
      if (!first) return;
      first = false;
      entered.release();
      await resume.wait;
    };
    if (boundary === "head") {
      const head = a.repository.head.bind(a.repository);
      a.repository.head = async () => { await pause(); return head(); };
    } else if (boundary === "capture") {
      const capture = a.vault.capture.bind(a.vault);
      a.vault.capture = async () => { const files = await capture(); await pause(); return files; };
    } else if (boundary === "checkpoint") {
      const readCommit = a.repository.readCommit.bind(a.repository);
      a.repository.readCommit = async (...args) => { const commit = await readCommit(...args); await pause(); return commit; };
    } else if (boundary === "prepare") {
      const prepare = a.repository.prepare.bind(a.repository);
      a.repository.prepare = async (...args) => { const candidate = await prepare(...args); await pause(); return candidate; };
    } else {
      const save = a.store.save.bind(a.store);
      a.store.save = async (state) => {
        if ((await parseState(state)).operation?.kind === "publish") await pause();
        await save(state);
      };
    }
    const syncing = a.session.sync();
    await entered.wait;
    const notifications = forwardSameByteCycle(a, await entryFromText("second incarnation"));
    resume.release();
    const fresh = conflictsOf(await syncing)[0]!;
    await notifications;
    assert.notEqual(fresh.id, a.conflict.id);
    assert.equal(a.repository.calls.filter((call) => call === "publish").length, 0);
    assert.ok(Object.hasOwn(a.repository.headFiles(), "n.md"));
    const saved = await parseState(await a.store.load());
    assert.equal(saved.operation, null, "an unsent candidate must not leave publication held");
    assert.deepEqual(Object.keys(saved.decisions), []);
    const restarted = a.restart();
    assert.equal((await restarted.resolve({ conflictId: a.conflict.id, choice: { kind: "mine" } })).kind, "stale");
    const durable = conflictsOf(await restarted.sync())[0]!;
    assert.equal(durable.id, fresh.id, "the queued notification cannot retire a review made after its event");
    await restarted.resolve({ conflictId: durable.id, choice: { kind: "remote" } });
    assert.equal((await restarted.sync()).kind, "synced");
    await assertConverged(a.repository, { ...a, session: restarted });
  });
}

test("forwarded events during the apply-operation save revoke an approved remote deletion before vault dispatch", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await repository.push({ "n.md": null });
  const conflict = conflictsOf(await a.session.sync())[0]!;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  const entered = eventGate(), resume = eventGate(), save = a.store.save.bind(a.store);
  let first = true;
  a.store.save = async (state) => {
    if (first && (await parseState(state)).operation?.kind === "apply") {
      first = false;
      entered.release();
      await resume.wait;
    }
    await save(state);
  };
  const applies = a.vault.applyCalls;
  const syncing = a.session.sync();
  await entered.wait;
  const notifications = forwardSameByteCycle(a, await entryFromText("edited and reverted"));
  resume.release();
  const fresh = conflictsOf(await syncing)[0]!;
  await notifications;
  assert.notEqual(fresh.id, conflict.id);
  assert.equal(a.vault.applyCalls, applies);
  assert.equal(a.vault.text("n.md"), "base");
  assert.equal((await a.restart().resolve({ conflictId: conflict.id, choice: { kind: "remote" } })).kind, "stale");
});

for (const boundary of ["load", "save"] as const) {
  test(`resolve refuses an approval when an observed same-byte cycle occurs during ${boundary}`, async () => {
    const a = await reviewedDeletion();
    const entered = eventGate(), resume = eventGate();
    if (boundary === "load") {
      const load = a.store.load.bind(a.store);
      let first = true;
      a.store.load = async () => {
        const state = await load();
        if (first) { first = false; entered.release(); await resume.wait; }
        return state;
      };
    } else {
      const save = a.store.save.bind(a.store);
      let first = true;
      a.store.save = async (state) => {
        if (first) { first = false; entered.release(); await resume.wait; }
        await save(state);
      };
    }
    const resolving = a.session.resolve({ conflictId: a.conflict.id, choice: { kind: "mine" } });
    await entered.wait;
    const notifications = forwardSameByteCycle(a, await entryFromText("recreated"));
    resume.release();
    assert.equal((await resolving).kind, "stale");
    await notifications;
    const saved = await parseState(await a.store.load());
    assert.equal(saved.review, null);
    assert.deepEqual(Object.keys(saved.decisions), []);
    assert.notEqual(conflictsOf(await a.restart().sync())[0]!.id, a.conflict.id);
    assert.ok(Object.hasOwn(a.repository.headFiles(), "n.md"));
  });
}

for (const api of ["enrollment", "restore", "publication-recovery"] as const) {
  for (const boundary of ["before-confirmation", "capture"] as const) {
    test(`${api} preview tokens reject an observed same-byte cycle ${boundary}`, async () => {
      const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
      const a = api === "enrollment" ? await device(repository, { "n.md": "draft" }) : await enrolled(repository);
      if (api === "restore" || api === "publication-recovery") await a.vault.write("n.md", "draft");
      if (api === "publication-recovery") {
        repository.publishFault = "before";
        await assert.rejects(a.session.sync(), Crash);
        repository.publishFault = null;
      }
      const preview = api === "enrollment" ? await a.session.previewEnrollment()
        : api === "restore" ? await a.session.previewRestore({ path: "n.md", commit: repository.branchHead })
        : await a.session.previewPublicationRecovery();
      assert.ok(preview.kind === "preview");
      const confirm = () => api === "enrollment" ? a.session.enroll({ token: preview.token })
        : api === "restore" ? a.session.restore({ token: preview.token, path: "n.md", commit: repository.branchHead })
        : a.session.recoverPublication({ token: preview.token });
      let confirmation;
      let notifications;
      if (boundary === "capture") {
        const entered = eventGate(), resume = eventGate(), capture = a.vault.capture.bind(a.vault);
        let first = true;
        a.vault.capture = async () => {
          const files = await capture();
          if (first) { first = false; entered.release(); await resume.wait; }
          return files;
        };
        confirmation = confirm();
        await entered.wait;
        notifications = forwardSameByteCycle(a, await entryFromText("changed transiently"));
        resume.release();
      } else {
        notifications = forwardSameByteCycle(a, await entryFromText("changed transiently"));
        confirmation = confirm();
      }
      assert.equal((await confirmation).kind, "stale");
      await notifications;
      assert.equal(a.vault.text("n.md"), "draft");
      if (api === "enrollment") assert.equal(a.store.raw, null);
      if (api === "publication-recovery") assert.ok((await parseState(await a.store.load())).operation?.kind === "publish");
      const fresh = api === "enrollment" ? await a.session.previewEnrollment()
        : api === "restore" ? await a.session.previewRestore({ path: "n.md", commit: repository.branchHead })
        : await a.session.previewPublicationRecovery();
      assert.ok(fresh.kind === "preview");
      assert.notEqual(fresh.token, preview.token);
      const outcome = api === "enrollment" ? await a.session.enroll({ token: fresh.token })
        : api === "restore" ? await a.session.restore({ token: fresh.token, path: "n.md", commit: repository.branchHead })
        : await a.session.recoverPublication({ token: fresh.token });
      assert.equal(outcome.kind, api === "enrollment" ? "enrolled" : api === "restore" ? "restored" : "released");
    });
  }
}

test("restore fences events during its durable save before dispatching a same-byte CAS write", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "draft");
  const preview = await a.session.previewRestore({ path: "n.md", commit: repository.branchHead });
  assert.ok(preview.kind === "preview");
  const entered = eventGate(), resume = eventGate(), save = a.store.save.bind(a.store);
  let first = true;
  a.store.save = async (state) => {
    if (first) { first = false; entered.release(); await resume.wait; }
    await save(state);
  };
  const applies = a.vault.applyCalls;
  const restoring = a.session.restore(preview);
  await entered.wait;
  const notifications = forwardSameByteCycle(a, await entryFromText("transient edit"));
  resume.release();
  assert.equal((await restoring).kind, "stale");
  await notifications;
  assert.equal(a.vault.applyCalls, applies);
  assert.equal(a.vault.text("n.md"), "draft");
});

test("events after publication dispatch preserve newer drafts without claiming to cancel the in-flight commit", async () => {
  const a = await reviewedDeletion();
  await a.session.resolve({ conflictId: a.conflict.id, choice: { kind: "mine" } });
  const entered = eventGate(), resume = eventGate(), publish = a.repository.publish.bind(a.repository);
  a.repository.publish = async (...args) => { entered.release(); await resume.wait; return publish(...args); };
  const syncing = a.session.sync();
  await entered.wait;
  await a.vault.write("n.md", "newer postdispatch draft");
  const notification = a.session.notifyLocalChange();
  resume.release();
  const outcome = await syncing;
  await notification;
  assert.ok(outcome.kind === "synced" && outcome.published && outcome.carried.includes("n.md"));
  assert.equal(Object.hasOwn(a.repository.headFiles(), "n.md"), false);
  assert.equal(a.vault.text("n.md"), "newer postdispatch draft");
  const saved = await parseState(await a.store.load());
  const draft = (await a.vault.capture())["n.md"]!;
  const record = saved.recovery.find((item) => item.files["n.md"]?.oid === draft.oid)!;
  assert.ok(record.pinned);
  const restarted = a.restart();
  const exported = await restarted.exportRecovery({ id: record.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(exported["n.md"]?.data, draft.data);
  assert.equal((await restarted.sync()).kind, "synced");
  await assertConverged(a.repository, { ...a, session: restarted });
});

for (const when of ["before", "after"] as const) {
  test(`notification persistence failure ${when} save cannot hide the synchronous event from the next sync`, async () => {
    const a = await reviewedDeletion();
    await a.session.resolve({ conflictId: a.conflict.id, choice: { kind: "mine" } });
    a.vault.files.set("n.md", await entryFromText("recreated"));
    a.vault.files.delete("n.md");
    a.store.fault = { at: a.store.saves + 1, when };
    await assert.rejects(a.session.notifyLocalChange(), Crash);
    a.store.fault = null;
    // A failed notification still retires the in-memory approval. A save that
    // landed before its response was lost also protects a restarted session.
    const session = when === "after" ? a.restart() : a.session;
    const fresh = conflictsOf(await session.sync())[0]!;
    assert.notEqual(fresh.id, a.conflict.id);
    assert.equal((await a.restart().resolve({ conflictId: a.conflict.id, choice: { kind: "mine" } })).kind, "stale");
    assert.ok(Object.hasOwn(a.repository.headFiles(), "n.md"));
  });
}

test("preview tokens require fresh review after session restart even with identical bytes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await device(repository, { "n.md": "draft" });
  const enrollment = await a.session.previewEnrollment();
  assert.ok(enrollment.kind === "preview");
  assert.equal((await a.restart().enroll({ token: enrollment.token })).kind, "stale");
  const fresh = await a.session.previewEnrollment();
  assert.ok(fresh.kind === "preview");
  await a.session.enroll({ token: fresh.token });
  const restore = await a.session.previewRestore({ path: "n.md", commit: repository.branchHead });
  assert.ok(restore.kind === "preview");
  assert.equal((await a.restart().restore(restore)).kind, "stale");
  assert.equal(a.vault.text("n.md"), "draft");
});

test("an event during edited approval persistence retires consent while preserving the replacement bytes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "local preimage");
  await repository.push(await snapshot({ "n.md": "remote" }));
  const conflict = conflictsOf(await a.session.sync())[0]!;
  const edited = await entryFromText("replacement entered in review");
  const entered = eventGate(), resume = eventGate(), save = a.store.save.bind(a.store);
  let first = true;
  a.store.save = async (state) => {
    if (first) { first = false; entered.release(); await resume.wait; }
    await save(state);
  };
  const resolving = a.session.resolve({ conflictId: conflict.id, choice: { kind: "edit", data: edited.data } });
  await entered.wait;
  const notifications = forwardSameByteCycle(a, await entryFromText("transient edit"));
  resume.release();
  assert.equal((await resolving).kind, "stale");
  await notifications;
  const saved = await parseState(await a.store.load());
  assert.deepEqual(Object.keys(saved.decisions), []);
  const record = saved.recovery.find((item) => item.files["n.md"]?.oid === edited.oid)!;
  assert.ok(record.pinned);
  const restarted = a.restart();
  const exported = await restarted.exportRecovery({ id: record.id });
  assert.ok(exported && !("kind" in exported));
  assert.equal(exported["n.md"]?.data, edited.data);
  assert.notEqual(conflictsOf(await restarted.sync())[0]!.id, conflict.id);
  assert.equal(entryText(repository.headFiles()["n.md"]!), "remote");
});

function recreateWithNotifications(a: Device, path: string) {
  const original = a.vault.files.get(path);
  assert.ok(original);
  a.vault.files.delete(path);
  const removed = a.session.notifyLocalChange();
  a.vault.files.set(path, original);
  const recreated = a.session.notifyLocalChange();
  return Promise.all([removed, recreated]);
}

for (const mutation of ["deletion", "replacement"] as const) {
  test(`a CAS-observed change revokes a later reviewed ${mutation} without a forwarded event`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "a.md": "old", "n.md": "base" }));
    const a = await enrolled(repository);
    if (mutation === "replacement") await a.vault.write("n.md", "local");
    await repository.push({ "a.md": await entryFromText("remote a"), "n.md": mutation === "deletion" ? null : await entryFromText("remote n") });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
    a.vault.beforeApply = async (path, vault) => {
      if (path === "a.md") await vault.write(path, "concurrent a");
    };
    const applies = a.vault.applyCalls;
    const outcome = await a.session.sync();
    assert.equal(outcome.kind === "synced" && outcome.carried.includes("n.md"), true, "the reviewed file must be carried without mutation");
    assert.equal(a.vault.applyCalls, applies + 1, "CAS mismatch retires the remaining reviewed dispatches");
    assert.equal(a.vault.text("a.md"), "concurrent a");
    assert.equal(a.vault.text("n.md"), mutation === "deletion" ? "base" : "local");
    a.vault.beforeApply = null;
    const fresh = conflictsOf(await a.restart().sync());
    const next = fresh.find((item) => item.path === "n.md")!;
    assert.ok(next, "revoked work returns to review after restart");
    assert.notEqual(next.id, conflict.id);
    for (const item of fresh) await a.session.resolve({ conflictId: item.id, choice: { kind: "remote" } });
    assert.equal((await a.session.sync()).kind, "synced");
    await assertConverged(repository, a);
  });
}

test("lost CAS-revocation save acknowledgement cannot revive pending deletion after bytes return", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "a.md": "old", "n.md": "base" }));
  const a = await enrolled(repository);
  await repository.push({ "a.md": await entryFromText("remote a"), "n.md": null });
  const conflict = conflictsOf(await a.session.sync())[0]!;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  a.vault.beforeApply = async (path, vault) => {
    assert.equal(path, "a.md", "the later deletion must never dispatch");
    await vault.write(path, "concurrent a");
  };
  failSaveMatching(a.store, (state) => state.operation?.steps.some((step) => step.path === "a.md" && step.status === "changed") ?? false, "after");
  await assert.rejects(a.session.sync(), Crash);
  const saved = await parseState(await a.store.load());
  assert.equal(saved.operation?.approval.kind, "revoked");
  assert.equal(saved.operation?.steps.find((step) => step.path === "n.md")?.status, "pending");
  assert.equal(saved.review, null);
  a.store.fault = null;
  a.vault.beforeApply = null;
  // Capture can no longer detect the intervening edit; only stored revocation can.
  await a.vault.write("a.md", "old");
  const applies = a.vault.applyCalls;
  const fresh = conflictsOf(await a.restart().sync())[0]!;
  assert.equal(a.vault.applyCalls, applies);
  assert.equal(a.vault.text("n.md"), "base");
  assert.notEqual(fresh.id, conflict.id);
  await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "synced");
  await assertConverged(repository, a);
});

for (const choice of ["deletion", "remote-replacement", "edited-replacement"] as const) {
  test(`lost apply-save acknowledgement durably revokes pending ${choice} across restart`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    if (choice !== "deletion") await a.vault.write("n.md", "local");
    await repository.push({ "n.md": choice === "deletion" ? null : await entryFromText("remote") });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    const replacement = await entryFromText("edited replacement");
    await a.session.resolve({ conflictId: conflict.id, choice: choice === "edited-replacement"
      ? { kind: "edit", data: replacement.data } : { kind: "remote" } });
    const entered = eventGate(), resume = eventGate(), save = a.store.save.bind(a.store);
    let first = true;
    a.store.save = async (state) => {
      await save(state);
      if (first && (await parseState(state)).operation?.kind === "apply") {
        first = false;
        entered.release();
        await resume.wait;
        throw new Crash("apply operation landed; acknowledgement lost");
      }
    };
    const applies = a.vault.applyCalls;
    const crashed = assert.rejects(a.session.sync(), Crash);
    await entered.wait;
    const notifications = recreateWithNotifications(a, "n.md");
    resume.release();
    await crashed;
    await notifications;
    const saved = await parseState(await a.store.load());
    assert.equal(saved.review, null);
    assert.deepEqual(Object.keys(saved.decisions), []);
    assert.equal(saved.operation?.approval.kind, "revoked");
    assert.equal(saved.operation?.steps[0]?.status, "pending");
    assert.equal(a.vault.applyCalls, applies, "no vault effect was dispatched");
    const head = repository.branchHead;
    const publications = repository.calls.filter((call) => call === "publish").length;
    const prepares = repository.calls.filter((call) => call === "prepare").length;
    const fresh = conflictsOf(await a.restart().sync())[0]!;
    assert.notEqual(fresh.id, conflict.id);
    assert.equal(a.vault.text("n.md"), choice === "deletion" ? "base" : "local");
    assert.equal(a.vault.applyCalls, applies, "resume cannot dispatch revoked consent");
    assert.equal(repository.branchHead, head);
    assert.equal(repository.calls.filter((call) => call === "publish").length, publications);
    assert.equal(repository.calls.filter((call) => call === "prepare").length, prepares);
    assert.equal((await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } })).kind, "stale");
    assert.equal((await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } })).kind, "recorded");
    assert.equal((await a.session.sync()).kind, "synced");
    await assertConverged(repository, a);
  });

  test(`events during an unrelated dispatched write revoke later ${choice} and preserve completed work`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "a.md": "old", "n.md": "base" }));
    const a = await enrolled(repository);
    if (choice !== "deletion") await a.vault.write("n.md", "local");
    await repository.push({ "a.md": await entryFromText("new"), "n.md": choice === "deletion" ? null : await entryFromText("remote") });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    const replacement = await entryFromText("edited replacement");
    await a.session.resolve({ conflictId: conflict.id, choice: choice === "edited-replacement"
      ? { kind: "edit", data: replacement.data } : { kind: "remote" } });
    const entered = eventGate(), resume = eventGate();
    a.vault.beforeApply = async (path) => {
      assert.equal(path, "a.md", "the reviewed later mutation must never dispatch");
      entered.release();
      await resume.wait;
    };
    const applies = a.vault.applyCalls;
    const syncing = a.session.sync();
    await entered.wait;
    const notifications = recreateWithNotifications(a, "n.md");
    resume.release();
    const outcome = await syncing;
    await notifications;
    assert.ok(outcome.kind === "synced" && outcome.carried.includes("n.md"));
    assert.equal(a.vault.applyCalls, applies + 1);
    assert.equal(a.vault.text("a.md"), "new", "already dispatched write completes");
    assert.equal(a.vault.text("n.md"), choice === "deletion" ? "base" : "local");
    const head = repository.branchHead;
    const publications = repository.calls.filter((call) => call === "publish").length;
    a.vault.beforeApply = null;
    const fresh = conflictsOf(await a.restart().sync())[0]!;
    assert.notEqual(fresh.id, conflict.id);
    assert.equal(repository.branchHead, head);
    assert.equal(repository.calls.filter((call) => call === "publish").length, publications);
    await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
    assert.equal((await a.session.sync()).kind, "synced");
    await assertConverged(repository, a);
  });
}

for (const response of ["accepted", "unknown", "lost-response"] as const) {
  test(`${response} publication settles once while local events revoke its pending reviewed replacement`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    await a.vault.write("n.md", "local");
    await repository.push({ "n.md": await entryFromText("remote") });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    await a.session.resolve({ conflictId: conflict.id, choice: { kind: "edit", data: (await entryFromText("edited")).data } });
    const entered = eventGate(), resume = eventGate(), publish = repository.publish.bind(repository);
    repository.publish = async (...args) => {
      const result = await publish(...args);
      entered.release();
      await resume.wait;
      if (response === "lost-response") throw new Crash("publication landed; acknowledgement lost");
      return response === "unknown" ? { kind: "unknown" } : result;
    };
    const applies = a.vault.applyCalls;
    const syncing = response === "lost-response" ? assert.rejects(a.session.sync(), Crash) : a.session.sync();
    await entered.wait;
    const notifications = recreateWithNotifications(a, "n.md");
    resume.release();
    await syncing;
    await notifications;
    const head = repository.branchHead;
    const fresh = conflictsOf(await a.restart().sync())[0]!;
    assert.equal(a.vault.applyCalls, applies);
    assert.equal(a.vault.text("n.md"), "local");
    assert.equal(repository.branchHead, head);
    assert.equal(repository.calls.filter((call) => call === "publish").length, 1);
    assert.equal(repository.calls.filter((call) => call === "prepare").length, 1);
    assert.notEqual(fresh.id, conflict.id);
    await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
    assert.equal((await a.session.sync()).kind, "synced");
    await assertConverged(repository, a);
  });
}

test("a resumed capture revokes pending consent after an unforwarded local change", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "baseline" }));
  const a = await enrolled(repository);
  await repository.push({ "n.md": null });
  const conflict = conflictsOf(await a.session.sync())[0]!;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  failSaveMatching(a.store, (state) => state.operation !== null, "after");
  await assert.rejects(a.session.sync(), Crash);
  a.store.fault = null;
  await a.vault.write("other.md", "new local draft");
  const applies = a.vault.applyCalls;
  const fresh = conflictsOf(await a.restart().sync())[0]!;
  assert.notEqual(fresh.id, conflict.id);
  assert.equal(a.vault.applyCalls, applies);
  assert.equal(a.vault.text("n.md"), "base");
  assert.equal(a.vault.text("other.md"), "new local draft");
});

for (const format of ["github-vault-sync/1", "github-vault-sync/2"] as const) {
  test(`${format} operations without approval metadata migrate pending deletion fail closed`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    await repository.push({ "n.md": null });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
    failSaveMatching(a.store, (state) => state.operation !== null, "after");
    await assert.rejects(a.session.sync(), Crash);
    a.store.fault = null;
    const old = JSON.parse(a.store.raw!);
    old.format = format;
    delete old.operation.approval;
    for (const step of old.operation.steps) delete step.consent;
    if (format === "github-vault-sync/1") {
      delete old.operation.incoming;
      delete old.review.scope;
      delete old.review.local;
    }
    a.store.raw = JSON.stringify(old);
    const migrated = await parseState(await a.store.load());
    assert.equal(migrated.operation?.approval.kind, "revoked");
    const applies = a.vault.applyCalls;
    const fresh = conflictsOf(await a.restart().sync())[0]!;
    assert.notEqual(fresh.id, conflict.id);
    assert.equal(a.vault.applyCalls, applies);
    assert.equal(a.vault.text("n.md"), "base");
    await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
    assert.equal((await a.session.sync()).kind, "synced");
    await assertConverged(repository, a);
  });
}

for (const when of ["before", "after"] as const) {
  test(`failed notification persistence ${when} save cannot revive a pending operation's approval`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    await repository.push({ "n.md": null });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
    failSaveMatching(a.store, (state) => state.operation !== null, "after");
    await assert.rejects(a.session.sync(), Crash);
    a.store.fault = { at: a.store.saves + 1, when };
    await assert.rejects(a.session.notifyLocalChange(), Crash);
    a.store.fault = null;
    const applies = a.vault.applyCalls;
    const session = when === "after" ? a.restart() : a.session;
    const fresh = conflictsOf(await session.sync())[0]!;
    assert.notEqual(fresh.id, conflict.id);
    assert.equal(a.vault.applyCalls, applies);
    assert.equal(a.vault.text("n.md"), "base");
  });
}

test("lost carry-save acknowledgement preserves revoked consent and completed writes on restart", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "a.md": "old", "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "local");
  await repository.push(await snapshot({ "a.md": "new", "n.md": "remote" }));
  const conflict = conflictsOf(await a.session.sync())[0]!;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  const entered = eventGate(), resume = eventGate();
  a.vault.beforeApply = async (path) => {
    assert.equal(path, "a.md");
    entered.release();
    await resume.wait;
  };
  failSaveMatching(a.store, (state) => state.operation?.steps.some((step) => step.status === "revoked") ?? false, "after");
  const crashed = assert.rejects(a.session.sync(), Crash);
  await entered.wait;
  const notifications = recreateWithNotifications(a, "n.md");
  resume.release();
  await crashed;
  await notifications;
  a.store.fault = null;
  a.vault.beforeApply = null;
  const saved = await parseState(await a.store.load());
  assert.equal(saved.operation?.approval.kind, "revoked");
  assert.equal(saved.operation?.steps.find((step) => step.path === "a.md")?.status, "applied");
  assert.equal(saved.operation?.steps.find((step) => step.path === "n.md")?.status, "revoked");
  const applies = a.vault.applyCalls;
  const fresh = conflictsOf(await a.restart().sync())[0]!;
  assert.notEqual(fresh.id, conflict.id);
  assert.equal(a.vault.applyCalls, applies);
  assert.equal(a.vault.text("a.md"), "new");
  assert.equal(a.vault.text("n.md"), "local");
  const recovered = await parseState(await a.store.load());
  for (const text of ["base", "local", "remote"]) {
    const entry = await entryFromText(text);
    assert.equal(recovered.blobs[entry.oid], entry.data, `${text} survives revocation and review`);
  }
  await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "synced");
  await assertConverged(repository, a);
});

test("stored approval metadata rejects invalid lifetimes and missing conflict origin bytes", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "local");
  await repository.push({ "n.md": await entryFromText("remote") });
  const conflict = conflictsOf(await a.session.sync())[0]!;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  failSaveMatching(a.store, (state) => state.operation !== null, "after");
  await assert.rejects(a.session.sync(), Crash);
  a.store.fault = null;
  const raw = JSON.parse(a.store.raw!);
  const invalidLifetime = structuredClone(raw);
  invalidLifetime.operation.approval.kind = "expired";
  await assert.rejects(parseState(invalidLifetime), /expected one of valid,revoked/);
  const invalidStatus = structuredClone(raw);
  invalidStatus.operation.steps[0].status = "revoked";
  await assert.rejects(parseState(invalidStatus), /revoked step cannot retain valid approval/);
  const automaticDeletion = structuredClone(raw);
  automaticDeletion.operation.steps[0].next = null;
  automaticDeletion.operation.steps[0].consent = { kind: "automatic" };
  await assert.rejects(parseState(automaticDeletion), /deletions require reviewed consent/);
  const missingOrigin = structuredClone(raw);
  delete missingOrigin.blobs[missingOrigin.operation.steps[0].consent.base.oid];
  await assert.rejects(parseState(missingOrigin), /missing referenced blob/);
});

test("a revoked blocked deletion stops retrying the adapter and permits a fresh review", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "image.png": "binary preimage" }));
  const a = await enrolled(repository);
  await repository.push({ "image.png": null });
  const conflict = conflictsOf(await a.session.sync())[0]!;
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  a.vault.blockBinary = true;
  assert.equal((await a.session.sync()).kind, "blocked");
  await a.session.notifyLocalChange();
  const applies = a.vault.applyCalls;
  const fresh = conflictsOf(await a.restart().sync())[0]!;
  assert.notEqual(fresh.id, conflict.id);
  assert.equal(a.vault.applyCalls, applies, "revoked blocked consent cannot be retried");
  assert.equal(a.vault.text("image.png"), "binary preimage");
  await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
  assert.equal((await a.session.sync()).kind, "blocked");
  assert.equal(a.vault.applyCalls, applies + 1, "a fresh decision permits exactly one new attempt");
  assert.equal((await a.session.keepLocal({ path: "image.png" })).kind, "recorded");
  assert.equal((await a.session.sync()).kind, "synced");
  await assertConverged(repository, a);
});

for (const when of ["before", "after"] as const) {
  test(`CAS observation survives revocation save failure ${when} persistence after bytes return`, async () => {
    // Reviewer harness: automatic a.md update observes an unforwarded edit,
    // followed by an approved n.md deletion. Restore a.md before restart.
    const repository = await MemoryRepository.create(await snapshot({ "a.md": "old", "n.md": "base" }));
    const a = await enrolled(repository);
    await repository.push({ "a.md": await entryFromText("remote"), "n.md": null });
    const conflict = conflictsOf(await a.session.sync())[0]!;
    await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
    a.vault.beforeApply = async (path, vault) => {
      assert.equal(path, "a.md");
      await vault.write(path, "transient user edit");
      a.store.fault = { at: a.store.saves + 1, when };
    };
    await assert.rejects(a.session.sync(), Crash);
    assert.equal(a.vault.text("a.md"), "transient user edit");
    assert.equal(a.vault.text("n.md"), "base");
    a.store.fault = null;
    a.vault.beforeApply = null;
    await a.vault.write("a.md", "old");
    const fresh = conflictsOf(await a.restart().sync());
    assert.equal(a.vault.text("n.md"), "base", "uncertain CAS cannot revive the deletion approval");
    const deletion = fresh.find((item) => item.path === "n.md")!;
    assert.ok(deletion);
    assert.notEqual(deletion.id, conflict.id);
    for (const item of fresh) await a.session.resolve({ conflictId: item.id, choice: { kind: "remote" } });
    await a.session.sync();
    await assertConverged(repository, a);
  });
}

async function reviewedBatch() {
  const repository = await MemoryRepository.create(await snapshot({
    "a.md": "old a", "b.md": "base b", "c.md": "base c", "n.md": "base n",
  }));
  const a = await enrolled(repository);
  await a.vault.write("b.md", "local b");
  await a.vault.write("c.md", "local c");
  await repository.push({
    "a.md": await entryFromText("remote a"), "b.md": await entryFromText("remote b"),
    "c.md": await entryFromText("remote c"), "n.md": null,
  });
  const conflicts = conflictsOf(await a.session.sync());
  for (const conflict of conflicts) {
    await a.session.resolve({ conflictId: conflict.id, choice: conflict.path === "c.md"
      ? { kind: "edit", data: (await entryFromText("reviewed c")).data } : { kind: "remote" } });
  }
  a.vault.applied.length = 0;
  return { a, repository, conflicts };
}

for (const path of ["a.md", "b.md", "c.md", "n.md"]) {
  for (const boundary of ["attempt", "result"] as const) {
    for (const when of ["before", "after"] as const) {
      test(`${path} ${boundary} save failure ${when} persistence preserves a reviewed multi-step publication`, async () => {
        const { a, repository, conflicts } = await reviewedBatch();
        failSaveMatching(a.store, (state) => {
          const op = state.operation;
          if (op?.kind !== "apply") return false;
          const step = op.steps.find((item) => item.path === path);
          return boundary === "attempt"
            ? state.observation === "pending" && op.steps.find((item) => item.status === "pending")?.path === path
            : state.observation === "settled" && step?.status === "applied";
        }, when);
        await assert.rejects(a.session.sync(), Crash);
        const persisted = await parseState(await a.store.load());
        const completed = [...a.vault.applied];
        const before = texts(await a.vault.capture());
        const published = repository.branchHead;
        assert.equal(repository.calls.filter((call) => call === "publish").length, 1);
        a.store.fault = null;
        // A newer edit to an already completed write must remain a draft, even
        // if the response recording that write was lost.
        const newerDraft = completed.includes("a.md") && !completed.includes("n.md");
        if (newerDraft) await a.vault.write("a.md", "newer carried draft");
        const outcome = await a.restart().sync();
        assert.equal(repository.branchHead, published, "settlement never republishes the candidate");
        assert.equal(repository.calls.filter((call) => call === "publish").length, 1);
        for (const done of completed) {
          assert.equal(a.vault.applied.filter((item) => item === done).length, 1, `${done}: completed writes are not replayed`);
          assert.equal(a.vault.text(done), done === "a.md" && newerDraft ? "newer carried draft" : before[done] ?? null);
        }
        if (persisted.operation?.approval.kind === "revoked" || newerDraft) {
          for (const pending of ["b.md", "c.md", "n.md"].filter((item) => !completed.includes(item))) {
            assert.equal(a.vault.text(pending), before[pending] ?? null, `${pending}: pending consent stays retired`);
          }
        }
        if (newerDraft) {
          const saved = await parseState(await a.store.load());
          const draft = await entryFromText("newer carried draft");
          assert.equal(saved.blobs[draft.oid], draft.data);
          assert.ok(saved.recovery.some((record) => record.pinned && record.files["a.md"]?.oid === draft.oid));
        }
        if (outcome.kind === "needs-decision") {
          for (const conflict of outcome.conflicts) {
            assert.ok(!conflicts.some((old) => old.id === conflict.id));
            await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
          }
        }
        for (let round = 0; round < 3; round++) {
          const result = await a.session.sync();
          if (result.kind === "needs-decision") {
            for (const conflict of result.conflicts) await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
          }
        }
        await assertConverged(repository, a);
      });
    }
  }
}

for (const when of ["before", "after"] as const) {
  test(`a reviewed CAS mismatch after completed work survives ${when} result persistence`, async () => {
    const { a, repository, conflicts } = await reviewedBatch();
    a.vault.beforeApply = async (path, vault) => {
      if (path !== "b.md") return;
      await vault.write(path, "transient b");
      a.store.fault = { at: a.store.saves + 1, when };
    };
    await assert.rejects(a.session.sync(), Crash);
    a.store.fault = null;
    a.vault.beforeApply = null;
    await a.vault.write("b.md", "local b");
    const applies = a.vault.applyCalls;
    const fresh = conflictsOf(await a.restart().sync());
    assert.equal(a.vault.applyCalls, applies);
    assert.equal(a.vault.text("a.md"), "remote a");
    assert.equal(a.vault.text("b.md"), "local b");
    assert.equal(a.vault.text("c.md"), "local c");
    assert.equal(a.vault.text("n.md"), "base n");
    assert.equal(repository.calls.filter((call) => call === "publish").length, 1);
    for (const conflict of fresh) {
      assert.ok(!conflicts.some((old) => old.id === conflict.id));
      await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
    }
    await a.session.sync();
    await assertConverged(repository, a);
  });
}

for (const observation of ["capture", "head"] as const) {
  for (const when of ["before", "after"] as const) {
    test(`${observation} observation retires approval when result save fails ${when} persistence`, async () => {
      const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "old" }));
      const a = await enrolled(repository);
      await repository.push({ "n.md": null });
      const conflict = conflictsOf(await a.session.sync())[0]!;
      await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
      const head = repository.branchHead;
      const capture = a.vault.capture.bind(a.vault), readHead = repository.head.bind(repository);
      if (observation === "capture") {
        a.vault.capture = async () => {
          await a.vault.write("other.md", "transient draft");
          a.store.fault = { at: a.store.saves + 1, when };
          return capture();
        };
      } else {
        repository.head = async () => {
          await repository.push({ "other.md": await entryFromText("transient remote") });
          a.store.fault = { at: a.store.saves + 1, when };
          return readHead();
        };
      }
      await assert.rejects(a.session.sync(), Crash);
      a.store.fault = null;
      a.vault.capture = capture;
      repository.head = readHead;
      repository.branchHead = head;
      await a.vault.write("other.md", "old");
      const applies = a.vault.applyCalls;
      const fresh = conflictsOf(await a.restart().sync())[0]!;
      assert.equal(a.vault.applyCalls, applies);
      assert.equal(a.vault.text("n.md"), "base");
      assert.notEqual(fresh.id, conflict.id);
      await a.session.resolve({ conflictId: fresh.id, choice: { kind: "remote" } });
      await a.session.sync();
      await assertConverged(repository, a);
    });
  }
}

for (const phase of ["publish", "apply", "completed-step"] as const) {
  test(`/2 state without observation metadata revokes consent and preserves ${phase}`, async () => {
    const { a, repository } = await reviewedBatch();
    failSaveMatching(a.store, (state) => phase === "completed-step"
      ? state.operation?.steps.some((step) => step.path === "a.md" && step.status === "applied") ?? false
      : state.operation?.kind === phase, "after");
    await assert.rejects(a.session.sync(), Crash);
    a.store.fault = null;
    const raw = JSON.parse(a.store.raw!);
    delete raw.observation;
    a.store.raw = JSON.stringify(raw);
    const migrated = await parseState(await a.store.load());
    assert.equal(migrated.operation?.approval.kind, "revoked");
    assert.equal(migrated.review, null);
    if (phase === "publish") {
      const publishes = repository.calls.filter((call) => call === "publish").length;
      assert.equal((await a.restart().sync()).kind, "publication-unknown");
      assert.equal(repository.calls.filter((call) => call === "publish").length, publishes);
      assert.ok(migrated.operation?.kind === "publish");
      // Separately reviewed external action establishes reachability.
      repository.branchHead = migrated.operation.candidate.commit;
    }
    const fresh = conflictsOf(await a.restart().sync());
    assert.equal(a.vault.text("a.md"), "remote a");
    assert.equal(a.vault.text("b.md"), "local b");
    assert.equal(a.vault.text("c.md"), "local c");
    assert.equal(a.vault.text("n.md"), "base n");
    for (const conflict of fresh) await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
    await a.session.sync();
    await assertConverged(repository, a);
  });
}

test("older /2 review decisions without an observation marker require fresh consent and preserve edits", async () => {
  const { a, repository, conflicts } = await reviewedBatch();
  const raw = JSON.parse(a.store.raw!);
  delete raw.observation;
  a.store.raw = JSON.stringify(raw);
  const applies = a.vault.applyCalls;
  const fresh = conflictsOf(await a.restart().sync());
  assert.equal(a.vault.applyCalls, applies);
  assert.equal(repository.calls.filter((call) => call === "publish").length, 0);
  const saved = await parseState(await a.store.load());
  const replacement = await entryFromText("reviewed c");
  assert.equal(saved.blobs[replacement.oid], replacement.data);
  assert.ok(saved.recovery.some((record) => record.pinned && record.files["c.md"]?.oid === replacement.oid));
  for (const conflict of fresh) {
    assert.ok(!conflicts.some((old) => old.id === conflict.id));
    await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  }
  await a.session.sync();
  await assertConverged(repository, a);
});

test("observation markers reject unknown states at the durable boundary", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  const raw = JSON.parse(a.store.raw!);
  raw.observation = "finished";
  await assert.rejects(parseState(raw), /observation: expected one of settled,pending/);
});
test("ancestry lookup failure returns publication-unknown and never republishes the held candidate", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "draft");
  repository.publishFault = "reject";
  repository.ancestorFault = true;
  assert.equal((await a.session.sync()).kind, "publication-unknown");
  assert.equal((await parseState(await a.store.load())).operation?.kind, "publish");
  assert.equal((await a.restart().sync()).kind, "publication-unknown");
  repository.ancestorFault = false;
  assert.equal((await a.restart().sync()).kind, "publication-unknown");
  assert.equal(repository.calls.filter(call => call === "publish").length, 1);
  assert.equal(a.vault.text("n.md"), "draft");
});
