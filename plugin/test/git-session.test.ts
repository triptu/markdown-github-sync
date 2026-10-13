// SyncSession tests for the v3 engine (format github-vault-sync/3).
//
// Guarantees deliberately changed from v2, and the tests that replace them:
// - Publication uncertainty: v2 held until branch reachability ("uncertain
//   candidates remain held", "unknown publication stays held after rewind",
//   "head-moved ... held", "ancestry lookup failure ...") is replaced by the
//   ledger protocol tests (receipt / seal / delayed delivery / outage /
//   divergence / rewind-without-replay). Legacy /2 publications are fenced
//   through the ledger before their review ("... uncertain publication is
//   fenced through the ledger before review ...").
// - Deletion approvals: v2 required review for every one-sided deletion and
//   revoked approvals on observation ("invalidates deletion approval ...",
//   "a recreated file invalidates deletion approval ...", "deletions always
//   need review") are replaced by "one-sided deletions ..." tests and the
//   bulk-deletion and empty-capture guards.
// - Event/observation authority: v2 tests of approval revocation through
//   forwarded events, observation markers and approval persistence ("forwarded
//   same-byte events ...", "resolve refuses an approval when ...", "...
//   preview tokens reject an observed same-byte cycle ...", "lost apply-save
//   acknowledgement durably revokes ...", "events during an unrelated
//   dispatched write revoke ...", "... publication settles once while local
//   events revoke ...", "CAS observation survives ...", "... observation
//   retires approval ...", "a revoked blocked deletion ...", "stored approval
//   metadata rejects ...") are replaced by the exact-version consent tests:
//   self-echo, same-byte versus different-byte cycles, unexpected bytes at
//   write time, the result-save failure matrix, token binding and
//   notifyLocalChange as a no-op. The same-byte case is the consciously
//   accepted contract; any byte difference is never auto-applied.
// - Legacy formats: v2 tests that downgraded live journals now use `toLegacy`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dictionary, own, encodeBase64, entryFromBytes, entryFromText, entryText, sameManifest, toManifest } from "../src/git-sync/codec";
import type { StoredState } from "../src/git-sync/state";
import { parseState, STATE_FORMAT } from "../src/git-sync/state";
import type { Snapshot } from "../src/git-sync/contracts";
import { SyncSession, VaultCaptureError } from "../src/git-sync/session";

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
  const make = () => new SyncSession({ repository: repository.device(name), vault, store, deviceName: name, now: NOW, delay: async () => {} });
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
  // The re-enrollment preview is the one confirmation; removed content is not resurrected.
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(a.vault.text("removed.md"), null);
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

for (const when of ["before", "after"] as const) {
  test(`restore authorization save failure ${when} durability resumes only a saved review`, async () => {
    const historical = await entryFromText("historical", "100755");
    const current = await entryFromText("current", "100644");
    const repository = await MemoryRepository.create({ "n.md": historical });
    const source = repository.branchHead;
    await repository.push({ "n.md": current });
    const a = await enrolled(repository);
    const checkpoint = repository.branchHead;
    const preview = await a.session.previewRestore({ path: "n.md", commit: source });
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") return;
    const applyCalls = a.vault.applyCalls;
    failSaveMatching(a.store, (state) => state.operation?.kind === "restore", when);
    await assert.rejects(a.session.restore(preview), Crash);
    assert.equal(a.vault.applyCalls, applyCalls, "authorization must be durable before the native write");
    const saved = await parseState(await a.store.load());
    assert.equal(saved.base.commit, checkpoint);
    assert.equal(saved.operation?.kind === "restore", when === "after");
    const outcome = await a.restart().sync();
    assert.ok(outcome.kind === "synced" || outcome.kind === "up-to-date", JSON.stringify(outcome));
    assert.equal(a.vault.text("n.md"), when === "after" ? "historical" : "current");
    assert.equal(repository.headFiles()["n.md"].mode, when === "after" ? "100755" : "100644");
    assert.equal(entryText(repository.headFiles()["n.md"]), when === "after" ? "historical" : "current");
  });
}

for (const attempted of [false, true]) {
  test(`reviewed restore replays exact native intent after ${attempted ? "post" : "pre"} write interruption`, async () => {
    const historical = await entryFromText("historical", "100755");
    const repository = await MemoryRepository.create({ "n.md": historical });
    const source = repository.branchHead;
    await repository.push({ "n.md": await entryFromText("current", "100644") });
    const a = await enrolled(repository);
    const checkpoint = repository.branchHead;
    const preview = await a.session.previewRestore({ path: "n.md", commit: source });
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") return;
    a.vault.pendingNext = { path: "n.md", mode: attempted ? "crash" : "refuse" };
    if (attempted) await assert.rejects(a.session.restore(preview), Crash);
    else assert.equal((await a.session.restore(preview)).kind, "blocked");
    const intent = [...a.vault.intents.values()][0]!;
    const saved = await parseState(await a.store.load());
    assert.equal(saved.base.commit, checkpoint, "restore does not move the checkpoint to the historical commit");
    assert.ok(saved.operation?.kind === "restore" && saved.operation.sourceCommit === source);
    assert.equal((await a.restart().sync()).kind, "synced");
    assert.ok(a.vault.authorizations.some((item) => item.replay.includes(intent.id)));
    assert.equal(a.vault.text("n.md"), "historical");
    assert.equal(repository.headFiles()["n.md"].mode, "100755");
    assert.ok(await repository.isAncestor(checkpoint, repository.branchHead));
  });
}

test("newer local edit after a restore interruption survives restart and is never replaced by history", async () => {
  const historical = await entryFromText("historical", "100755");
  const repository = await MemoryRepository.create({ "n.md": historical });
  const source = repository.branchHead;
  await repository.push({ "n.md": await entryFromText("current", "100644") });
  const a = await enrolled(repository);
  const preview = await a.session.previewRestore({ path: "n.md", commit: source });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") return;
  a.vault.pendingNext = { path: "n.md", mode: "refuse" };
  assert.equal((await a.session.restore(preview)).kind, "blocked");
  await a.vault.write("n.md", "newer edit");
  const intent = [...a.vault.intents.values()][0]!;
  const outcome = await a.restart().sync();
  assert.equal(outcome.kind, "synced");
  assert.equal(a.vault.text("n.md"), "newer edit");
  assert.ok(a.vault.authorizations.some((item) => item.replay.includes(intent.id)));
  assert.equal(entryText(repository.headFiles()["n.md"]), "newer edit");
  assert.equal((await parseState(await a.store.load())).operation, null);
});

test("a restore whose durable history no longer matches cannot authorize native replay", async () => {
  const repository = await MemoryRepository.create({ "n.md": await entryFromText("historical", "100755") });
  const source = repository.branchHead;
  await repository.push({ "n.md": await entryFromText("current", "100644") });
  const a = await enrolled(repository);
  const preview = await a.session.previewRestore({ path: "n.md", commit: source });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") return;
  a.vault.pendingNext = { path: "n.md", mode: "refuse" };
  assert.equal((await a.session.restore(preview)).kind, "blocked");
  const saved = JSON.parse(a.store.raw!);
  saved.operation.sourceCommit = repository.branchHead;
  a.store.raw = JSON.stringify(saved);
  const authorizations = a.vault.authorizations.length;
  await assert.rejects(a.restart().sync(), /Historical bytes differ/);
  assert.equal(a.vault.authorizations.length, authorizations);
  assert.equal(a.vault.intents.size, 1);
  assert.equal(a.vault.text("n.md"), "current");
});

test("restore authorization replays only its path and cancels an unrelated native intent", async () => {
  const repository = await MemoryRepository.create({ "n.md": await entryFromText("historical") });
  const source = repository.branchHead;
  await repository.push({ "n.md": await entryFromText("current") });
  const a = await enrolled(repository);
  const preview = await a.session.previewRestore({ path: "n.md", commit: source });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") return;
  a.vault.pendingNext = { path: "n.md", mode: "refuse" };
  assert.equal((await a.session.restore(preview)).kind, "blocked");
  const restoreIntent = a.vault.intents.get("n.md")!;
  const kept = await entryFromText("kept");
  a.vault.files.set("other.md", kept);
  a.vault.pendingNext = { path: "other.md", mode: "refuse" };
  assert.equal((await a.vault.apply("other.md", kept, await entryFromText("unreviewed"))).kind, "blocked");
  const unrelatedIntent = a.vault.intents.get("other.md")!;
  await a.restart().sync();
  assert.ok(a.vault.authorizations.some((item) => item.replay.includes(restoreIntent.id) && item.cancel.includes(unrelatedIntent.id)));
  assert.equal(a.vault.text("n.md"), "historical");
  assert.equal(a.vault.text("other.md"), "kept");
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
  const incomingId = saved.operation?.incomingRecoveryId;
  assert.ok(incomingId);
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

test("a superseded edited decision preserves its replacement and the prior local version", async () => {
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

// v3 replaces v2's deletion approvals: a one-sided deletion is ordinary
// automatic content, and observation (inspect, previews, restore, events) no
// longer carries consent. Recreating with different bytes is an ordinary edit.
for (const observer of ["inspect", "previewRestore", "restore", "notifyLocalChange"] as const) {
  test(`one-sided deletions publish automatically and ${observer} carries no consent state`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "base" }));
    const a = await enrolled(repository);
    const original = repository.branchHead;
    a.vault.files.delete("n.md");
    const deleted = await a.session.sync();
    assert.ok(deleted.kind === "synced" && deleted.published);
    assert.ok(!Object.hasOwn(repository.headFiles(), "n.md"));
    if (observer === "inspect") assert.ok((await a.session.inspect()).kind === "enrolled");
    else if (observer === "notifyLocalChange") {
      const before = a.store.saves;
      assert.equal((await a.session.notifyLocalChange()).kind, "invalidated");
      assert.equal(a.store.saves, before, "events change no durable state");
    } else {
      const preview = await a.session.previewRestore({ path: "n.md", commit: original });
      assert.ok(preview.kind === "preview" && preview.current === null);
      if (observer === "restore") assert.equal((await a.session.restore(preview)).kind, "restored");
    }
    if (observer !== "restore") await a.vault.write("n.md", "new incarnation");
    const recreated = await a.restart().sync();
    assert.ok(recreated.kind === "synced" && recreated.published);
    assert.equal(entryText(repository.headFiles()["n.md"]!), observer === "restore" ? "base" : "new incarnation");
    await assertConverged(repository, a);
  });
}

// Changed guarantee (v3): one-sided deletions are automatic in both
// directions; a deletion against an edit still needs a decision.
test("one-sided deletions converge automatically; delete/edit keeps both versions until decided", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "a.md": "a", "b.md": "b", "c.md": "c", "keep.md": "k" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");

  a.vault.files.delete("a.md");
  assert.equal((await a.session.sync()).kind, "synced");
  assert.ok(!("a.md" in repository.headFiles()));
  assert.equal((await b.session.sync()).kind, "synced");
  assert.ok(!b.vault.files.has("a.md"), "the remote deletion applies where the file was unchanged");

  a.vault.files.delete("c.md");
  await b.vault.write("c.md", "edited by B");
  assert.equal((await a.session.sync()).kind, "synced");
  const [deleteEdit] = conflictsOf(await b.session.sync());
  assert.equal(deleteEdit!.kind, "local-edited-remote-deleted");
  assert.equal(b.vault.text("c.md"), "edited by B", "the edit is untouched while undecided");
  await b.session.resolve({ conflictId: deleteEdit!.id, choice: { kind: "mine" } });
  await b.session.sync();
  assert.equal(entryText(repository.headFiles()["c.md"]!), "edited by B", "kept edit is republished explicitly");
  await a.session.sync();
  await assertConverged(repository, a, b);

  // A rename is a deletion plus a creation, both automatic.
  b.vault.files.set("renamed/keep.md", b.vault.files.get("keep.md")!);
  b.vault.files.delete("keep.md");
  assert.equal((await b.session.sync()).kind, "synced");
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(a.vault.text("renamed/keep.md"), "k");
  assert.equal(a.vault.text("keep.md"), null);
  await assertConverged(repository, a, b);
});

// Changed guarantee (v3): uncertainty is settled by the device ledger, not by
// branch ancestry, and within the same sync rather than by a later hold.
test("a lost publication response is settled by the ledger receipt, even after a later revert, and never replayed", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "original" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await a.vault.write("n.md", "A's edit");
  repository.publishFault = "after";
  const outcome = await a.session.sync();
  repository.publishFault = null;
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  const published = repository.branchHead;
  const saved = await parseState(await a.store.load());
  assert.equal(saved.ledger.anchor, repository.ledger("A"), "the receipt is the new anchor");
  assert.ok(await repository.isAncestor(published, saved.ledger.anchor!), "the receipt keeps the candidate reachable");

  await b.session.sync();
  await b.vault.write("n.md", "original");
  await b.session.sync();
  const reverted = repository.branchHead;
  const again = await a.restart().sync();
  assert.ok(again.kind === "synced" && !again.published);
  assert.equal(repository.branchHead, reverted, "no replay commit");
  assert.equal(a.vault.text("n.md"), "original", "the later revert is applied locally");
  assert.equal(repository.calls.filter((call) => call === "publish").length, 2, "A once, B's revert once");
  await assertConverged(repository, a, b);
});


test("a crash or fault at every durable, publication, settlement and apply boundary converges without loss or replay", async () => {
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

  // Count boundaries in a clean run, then in a run whose first publication is sealed.
  const clean = await scenario();
  assert.equal((await clean.a.session.sync()).kind, "synced");
  const saves = clean.a.store.saves - clean.startSaves;
  const applies = clean.a.vault.applyCalls - clean.startApplies;
  assert.ok(saves >= 4 && applies === 2, `saves=${saves} applies=${applies}`);
  const sealedRun = await scenario();
  sealedRun.repository.publishQueue = ["before"];
  assert.equal((await sealedRun.a.session.sync()).kind, "synced");
  const sealedSaves = sealedRun.a.store.saves - sealedRun.startSaves;
  assert.ok(sealedSaves > saves, "seal identity and cancellation are durable saves");

  const faults: Array<{ label: string; crashes: boolean; inject(world: Awaited<ReturnType<typeof scenario>>): void }> = [];
  for (let at = 1; at <= sealedSaves; at++) {
    for (const when of ["before", "after"] as const) {
      faults.push({ label: `sealed run save ${at} ${when}`, crashes: true, inject: (w) => {
        w.repository.publishQueue = ["before"];
        w.a.store.fault = { at: w.startSaves + at, when };
      } });
    }
  }
  for (let at = 1; at <= saves; at++) {
    for (const when of ["before", "after"] as const) {
      faults.push({ label: `save ${at} ${when}`, crashes: true, inject: (w) => (w.a.store.fault = { at: w.startSaves + at, when }) });
    }
  }
  for (const when of ["before", "after"] as const) faults.push({ label: `prepare ${when}`, crashes: true, inject: (w) => (w.repository.prepareFault = when) });
  // Publication and seal faults never surface: the ledger settles them in the same sync.
  for (const fault of ["before", "after", "error-after", "reject", "delay"] as const) {
    faults.push({ label: `publish ${fault}`, crashes: false, inject: (w) => (w.repository.publishQueue = [fault]) });
    faults.push({ label: `publish before, seal ${fault}`, crashes: false, inject: (w) => {
      w.repository.publishQueue = ["before"];
      w.repository.sealQueue = [fault];
    } });
  }
  faults.push({ label: "ledger unreadable", crashes: false, inject: (w) => {
    w.repository.publishQueue = ["after"];
    w.repository.ledgerFault = true;
  } });
  for (let at = 1; at <= applies; at++) {
    for (const when of ["before", "after"] as const) {
      faults.push({ label: `apply ${at} ${when}`, crashes: true, inject: (w) => (w.a.vault.applyFault = { at: w.startApplies + at, when }) });
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
    assert.equal(crashed, fault.crashes, `${fault.label}: fault surfaced as expected`);
    world.a.store.fault = null;
    world.a.vault.applyFault = null;
    world.repository.prepareFault = null;
    world.repository.publishQueue = [];
    world.repository.sealQueue = [];
    world.repository.ledgerFault = false;
    // Requests still in flight arrive late; at most one of them or a seal can win.
    world.repository.deliver();
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
    const saved = await parseState(await world.a.store.load());
    assert.equal(saved.ledger.anchor, world.repository.ledger("A") ?? null, `${fault.label}: anchor equals the settled ledger`);
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
  assert.equal((await b.session.sync()).kind, "synced");

  // A applies B's commit automatically, but the user edits both files meanwhile.
  let first = true;
  a.vault.beforeApply = async (_path, vault) => {
    if (!first) return;
    first = false;
    await vault.write("n.md", lines(10, { 7: "A seven" }));
    await vault.write("d.md", "d edited during apply");
  };
  const outcome = await a.session.sync();
  a.vault.beforeApply = null;
  assert.deepEqual(outcome.kind === "synced" && outcome.carried, ["d.md", "n.md"]);
  assert.equal(a.vault.text("n.md"), lines(10, { 7: "A seven" }), "newer edit untouched");
  assert.equal(a.vault.text("d.md"), "d edited during apply", "the deletion's compare-and-swap refused unexpected bytes");

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


// ---- Ledger protocol (v3) ---------------------------------------------------

function ledgerChain(repository: MemoryRepository, installation = "A"): string[] {
  const chain: string[] = [];
  for (let cursor = repository.ledger(installation) ?? null; cursor;) {
    chain.push(cursor);
    const commit = repository.commits.get(cursor);
    // A receipt's first parent is the previous ledger value only when it has two parents.
    cursor = commit?.ledger === "receipt" ? (commit.parents.length === 2 ? commit.parents[0]! : null) : commit?.ledger === "seal" ? commit.parents[0] ?? null : null;
  }
  return chain;
}

async function editedDevice(text = "edit") {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "o" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", text);
  return { repository, a };
}

const count = (repository: MemoryRepository, call: string) => repository.calls.filter((item) => item === call).length;

test("a generic error after acceptance is settled by the receipt without a seal", async () => {
  const { repository, a } = await editedDevice();
  repository.publishQueue = ["error-after"];
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published);
  assert.equal(count(repository, "createSeal"), 0);
  assert.equal(chainLength(repository), 2);
  await assertConverged(repository, a);
});

test("a request lost before delivery is sealed, and the same sync republishes exactly once", async () => {
  const { repository, a } = await editedDevice();
  repository.publishQueue = ["before"];
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.equal(count(repository, "prepare"), 2);
  assert.equal(count(repository, "createSeal"), 1);
  assert.equal(chainLength(repository), 2);
  const chain = ledgerChain(repository);
  assert.equal(chain.length, 2, "receipt over seal");
  assert.equal((await parseState(await a.store.load())).ledger.anchor, chain[0]);
  await assertConverged(repository, a);
});

for (const winner of ["seal", "publication"] as const) {
  test(`a delayed publication racing its seal settles exactly once when the ${winner} wins`, async () => {
    const { repository, a } = await editedDevice();
    repository.publishQueue = ["delay"];
    if (winner === "publication") {
      const seal = repository.seal.bind(repository);
      repository.seal = async (input, ledger) => {
        repository.deliver();
        return seal(input, ledger);
      };
    }
    const outcome = await a.session.sync();
    assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
    assert.deepEqual(repository.deliver(), winner === "seal" ? [false] : [], "a sealed request delivered late cannot land");
    assert.equal(count(repository, "prepare"), winner === "seal" ? 2 : 1);
    assert.equal(chainLength(repository), 2, "exactly one candidate landed");
    assert.equal(ledgerChain(repository).length, winner === "seal" ? 2 : 1);
    await assertConverged(repository, a);
  });
}

test("a request delivered after its seal won can never land, even after later operations", async () => {
  const { repository, a } = await editedDevice();
  repository.publishQueue = ["delay"];
  assert.equal((await a.session.sync()).kind, "synced");
  await a.vault.write("n.md", "later edit");
  assert.equal((await a.session.sync()).kind, "synced");
  const head = repository.branchHead;
  assert.deepEqual(repository.deliver(), [false]);
  assert.equal(repository.branchHead, head);
  assert.equal(entryText(repository.headFiles()["n.md"]!), "later edit");
});

test("a lost seal response is settled by rereading the ledger", async () => {
  const { repository, a } = await editedDevice();
  repository.publishQueue = ["before"];
  repository.sealQueue = ["after"];
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published);
  assert.equal(count(repository, "seal"), 1);
  assert.equal(chainLength(repository), 2);
});

test("the seal identity is durable before dispatch and reused across retries and restart", async () => {
  const { repository, a } = await editedDevice();
  repository.publishQueue = ["before"];
  repository.sealFault = "before";
  const held = await a.session.sync();
  assert.ok(held.kind === "settling", JSON.stringify(held));
  const saved = await parseState(await a.store.load());
  assert.ok(saved.operation?.kind === "publish" && saved.operation.publication.phase === "sealing");
  const seal = saved.operation.publication.seal;
  const status = await a.session.status();
  assert.ok(status.kind === "enrolled" && status.phase === "settling");
  assert.ok(count(repository, "seal") > 1, "the same seal is redispatched");
  assert.equal(count(repository, "createSeal"), 1);
  assert.equal((await a.session.previewPublicationRecovery()).kind, "settling", "automatic settlement needs no review");
  repository.sealFault = null;
  const outcome = await a.restart().sync();
  assert.ok(outcome.kind === "synced" && outcome.published);
  assert.equal(count(repository, "createSeal"), 1, "no second seal for the same operation");
  assert.ok(ledgerChain(repository).includes(seal));
  assert.equal(chainLength(repository), 2);
  await assertConverged(repository, a);
});

test("a GitHub outage while dispatched returns settling and resumes automatically without replay", async () => {
  const { repository, a } = await editedDevice();
  repository.publishQueue = ["delay"];
  repository.ledgerFault = true;
  assert.equal((await a.session.sync()).kind, "settling");
  assert.equal((await a.restart().sync()).kind, "settling");
  assert.equal(a.vault.text("n.md"), "edit");
  repository.deliver();
  repository.ledgerFault = false;
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published);
  assert.equal(count(repository, "prepare"), 1);
  assert.equal(count(repository, "createSeal"), 0);
  assert.equal(chainLength(repository), 2);

  // Rate limits stay schedulable rather than turning into a settled verdict.
  await a.vault.write("n.md", "rate limited");
  repository.publishQueue = ["before"];
  const read = repository.readLedger.bind(repository);
  repository.readLedger = async () => { throw Object.assign(new Error("rate limited"), { retryAt: 123 }); };
  await assert.rejects(a.session.sync(), (error: unknown) => typeof error === "object" && error !== null && Reflect.get(error, "retryAt") === 123);
  repository.readLedger = read;
  assert.ok((await parseState(await a.store.load())).operation?.kind === "publish");
  assert.equal((await a.session.sync()).kind, "synced");
});

for (const tamper of ["deleted", "foreign", "older"] as const) {
  test(`an out-of-contract ${tamper} ledger fails closed without any write`, async () => {
    const { repository, a } = await editedDevice("first");
    assert.equal((await a.session.sync()).kind, "synced");
    const first = repository.ledger("A")!;
    await a.vault.write("n.md", "second");
    assert.equal((await a.session.sync()).kind, "synced");
    await a.vault.write("n.md", "third");
    const ref = "refs/vault-sync/devices/A";
    const foreign = await repository.orphan("foreign");
    const publish = repository.publish.bind(repository);
    repository.publish = async (input, ledger) => {
      if (tamper === "deleted") repository.refs.delete(ref);
      else repository.refs.set(ref, tamper === "foreign" ? foreign : first);
      return publish(input, ledger);
    };
    const head = repository.branchHead;
    const anchor = repository.ledger("A")!;
    const outcome = await a.session.sync();
    if (tamper === "foreign") {
      assert.ok(outcome.kind === "paused" && outcome.pause.reason === "ledger-diverged", JSON.stringify(outcome));
    } else {
      // Absent or older than the anchor is explainable by a stale replica: it
      // never becomes a verdict, and nothing is sent while it persists.
      assert.ok(outcome.kind === "settling" && outcome.reason === "stale-ledger", JSON.stringify(outcome));
      assert.equal((await parseState(await a.store.load())).pause, null);
    }
    assert.equal(count(repository, "seal") + count(repository, "createSeal"), 0, "a diverged ledger is never written");
    assert.equal(repository.branchHead, head);
    assert.equal(a.vault.text("n.md"), "third");
    repository.publish = publish;
    const again = await a.restart().sync();
    assert.equal(again.kind, tamper === "foreign" ? "paused" : "settling", "never auto-dismissed, never written");
    assert.equal(count(repository, "publish"), 3);
    assert.equal(count(repository, "seal") + count(repository, "createSeal"), 0);
    if (tamper === "foreign") return;
    // A fresh read of the real anchor resumes ordinary settlement: seal, then republish once.
    repository.refs.set(ref, anchor);
    const resumed = await a.session.sync();
    assert.ok(resumed.kind === "synced" && resumed.published, JSON.stringify(resumed));
    assert.equal(count(repository, "seal"), 1);
    assert.equal(entryText(repository.headFiles()["n.md"]!), "third");
  });
}

test("one stale older ledger read is reread and settles without a write", async () => {
  const { repository, a } = await editedDevice("first");
  assert.equal((await a.session.sync()).kind, "synced");
  const older = repository.ledger("A")!;
  await a.vault.write("n.md", "second");
  assert.equal((await a.session.sync()).kind, "synced");
  await a.vault.write("n.md", "third");
  repository.publishQueue = ["error-after"];
  const read = repository.readLedger.bind(repository);
  let stale = true;
  repository.readLedger = async (ledger) => {
    if (!stale) return read(ledger);
    stale = false;
    return { kind: "present", value: older }; // an ancestor of the current anchor
  };
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.equal(count(repository, "createSeal"), 0);
});

for (const stale of ["absent once", "older twice", "older on every read of one sync"] as const) {
  test(`F2: a landed publication read as ${stale} settles from a later fresh read, never pausing or writing`, async () => {
    const { repository, a } = await editedDevice("first");
    assert.equal((await a.session.sync()).kind, "synced");
    const older = repository.ledger("A")!;
    await a.vault.write("n.md", "second");
    assert.equal((await a.session.sync()).kind, "synced");
    await a.vault.write("n.md", "third");
    repository.publishQueue = ["after"]; // lands, response lost
    const read = repository.readLedger.bind(repository);
    let remaining = stale === "absent once" ? 1 : stale === "older twice" ? 2 : 1 + 3 + 1;
    repository.readLedger = async (ledger) => {
      if (remaining <= 0) return read(ledger);
      remaining--;
      return stale === "absent once" ? { kind: "absent" } : { kind: "present", value: older };
    };
    let outcome = await a.session.sync();
    if (stale === "older on every read of one sync") {
      assert.ok(outcome.kind === "settling" && outcome.reason === "stale-ledger", JSON.stringify(outcome));
      assert.equal((await parseState(await a.store.load())).pause, null, "never a sticky pause");
      outcome = await a.restart().sync();
    }
    assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
    assert.equal(count(repository, "createSeal") + count(repository, "seal"), 0, "a stale read never triggers a write");
    assert.equal(count(repository, "publish"), 3, "never republished");
    assert.equal(entryText(repository.headFiles()["n.md"]!), "third");
    await assertConverged(repository, a);
  });
}

test("F2: a ledger-diverged pause rereads read-only each sync and settles on a fresh receipt", async () => {
  const { repository, a } = await editedDevice("candidate");
  repository.publishQueue = ["after"];
  const foreign = await repository.orphan("glitch");
  const read = repository.readLedger.bind(repository);
  let glitch = true;
  repository.readLedger = async (ledger) => (glitch ? { kind: "present", value: foreign } : read(ledger));
  const paused = await a.session.sync();
  assert.ok(paused.kind === "paused" && paused.pause.reason === "ledger-diverged", JSON.stringify(paused));
  assert.equal((await a.restart().sync()).kind, "paused", "still diverged: stays paused");
  assert.equal(count(repository, "seal") + count(repository, "createSeal"), 0);
  glitch = false;
  const settled = await a.session.sync();
  assert.ok(settled.kind === "synced" && settled.published, JSON.stringify(settled));
  assert.equal((await parseState(await a.store.load())).pause, null);
  assert.equal(count(repository, "publish"), 1);
  await assertConverged(repository, a);
});

test("another installation advancing past our receipt yields the accepted verdict and a duplicate-installation hold", async () => {
  const { repository, a } = await editedDevice("candidate");
  repository.publishQueue = ["error-after"];
  const publish = repository.publish.bind(repository);
  repository.publish = async (input, ledger) => {
    const result = await publish(input, ledger);
    // A copied journal elsewhere writes the same ledger.
    const child = await repository.createSeal({ anchor: input.receipt, parent: input.candidate, operation: "copied" });
    repository.refs.set("refs/vault-sync/devices/A", child);
    repository.publish = publish;
    return result;
  };
  const paused = await a.session.sync();
  assert.ok(paused.kind === "paused" && paused.pause.reason === "duplicate-installation", JSON.stringify(paused));
  const saved = await parseState(await a.store.load());
  assert.equal(saved.operation?.kind, "apply", "the accepted verdict is durable");
  // Local completion needs no remote write and proceeds under the hold.
  assert.equal((await a.session.sync()).kind, "paused");
  assert.equal(repository.calls.filter((call) => call === "publish").length, 1);
  const completed = await parseState(await a.store.load());
  assert.equal(completed.operation, null);
  assert.equal(completed.base.commit, repository.branchHead);
  // Re-enrollment re-anchors to the value it observes.
  const preview = await a.session.previewEnrollment();
  assert.ok(preview.kind === "preview");
  assert.equal((await a.session.enroll({ token: preview.token })).kind, "enrolled");
  assert.equal((await parseState(await a.store.load())).ledger.anchor, repository.ledger("A"));
  await a.vault.write("n.md", "after re-anchor");
  assert.equal((await a.session.sync()).kind, "synced");
});

for (const choice of ["discard", "republish"] as const) {
  test(`a diverged publication offers one reviewed ${choice} and re-anchors on re-enrollment`, async () => {
    const { repository, a } = await editedDevice("first");
    assert.equal((await a.session.sync()).kind, "synced");
    await a.vault.write("n.md", "held draft");
    const publish = repository.publish.bind(repository);
    const foreign = await repository.orphan("foreign");
    repository.publish = async (input, ledger) => {
      repository.refs.set("refs/vault-sync/devices/A", foreign);
      repository.publish = publish;
      return publish(input, ledger);
    };
    assert.equal((await a.session.sync()).kind, "paused");
    const preview = await a.session.previewPublicationRecovery();
    assert.ok(preview.kind === "preview");
    assert.equal(entryText(preview.candidateFiles["n.md"]!), "held draft");
    const released = await a.session.recoverPublication({ token: preview.token, choice });
    assert.ok(released.kind === "released" && !released.pause.detail.includes("cannot be cancelled"));
    const enrollment = await a.session.previewEnrollment();
    assert.ok(enrollment.kind === "preview");
    assert.equal(enrollment.items.find((item) => item.path === "n.md")?.action, choice === "republish" ? "upload" : "update-local");
    await a.session.enroll({ token: enrollment.token });
    assert.equal((await parseState(await a.store.load())).ledger.anchor, foreign, "anchored at the observed ledger");
    assert.equal((await a.session.sync()).kind, "synced");
    assert.equal(entryText(repository.headFiles()["n.md"]!), choice === "republish" ? "held draft" : "first");
    const records = await a.session.listRecovery();
    assert.ok(Array.isArray(records) && records.some((record) => record.reason === "publication-recovery"));
    await assertConverged(repository, a);
  });
}

test("an accepted publication rewound on the branch is never replayed and needs one re-enrollment confirmation", async () => {
  const { repository, a } = await editedDevice("accepted then rewound");
  const parent = repository.branchHead;
  const publish = repository.publish.bind(repository);
  repository.publish = async (input, ledger) => {
    await publish(input, ledger);
    repository.branchHead = parent; // force-push rewind before the response
    await repository.push({ "sibling.md": await entryFromText("sibling") });
    repository.publish = publish;
    return "unconfirmed";
  };
  const accepted = await a.session.sync();
  assert.ok(accepted.kind === "synced" && accepted.published, "the receipt proves acceptance despite the rewind");
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "paused" && outcome.pause.reason === "history-rewritten", JSON.stringify(outcome));
  const receipt = repository.ledger("A")!;
  assert.equal((await parseState(await a.store.load())).ledger.anchor, receipt, "the receipt proved acceptance");
  assert.equal(count(repository, "createSeal"), 0);
  const preview = await a.session.previewEnrollment();
  assert.ok(preview.kind === "preview");
  assert.equal(preview.items.find((item) => item.path === "n.md")?.action, "update-local");
  await a.session.enroll({ token: preview.token });
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(entryText(repository.headFiles()["n.md"]!), "base", "rewound content is not republished");
  assert.equal(a.vault.text("n.md"), "base");
  assert.equal(a.vault.text("sibling.md"), "sibling");
  assert.equal(count(repository, "publish"), 1);
  assert.ok(await repository.isAncestor(receipt, repository.ledger("A")!) || repository.ledger("A") === receipt, "the receipt stays in the ledger history");
  await assertConverged(repository, a);
});

test("two devices publishing from the same checkpoint converge automatically", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "a.md": "a", "b.md": "b" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await a.vault.write("a.md", "from A");
  await b.vault.write("b.md", "from B");
  const publish = repository.publish.bind(repository);
  let raced = false;
  repository.publish = async (input, ledger) => {
    if (!raced && ledger === "refs/vault-sync/devices/B") {
      raced = true;
      assert.equal((await a.session.sync()).kind, "synced");
    }
    return publish(input, ledger);
  };
  const outcome = await b.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.equal((await a.session.sync()).kind, "synced");
  assert.deepEqual(texts(repository.headFiles()), { "a.md": "from A", "b.md": "from B" });
  assert.equal(chainLength(repository), 3);
  assert.equal(ledgerChain(repository, "B").length, 2, "B's seal then receipt");
  await assertConverged(repository, a, b);
});

test("losing every round of one sync returns contended; the next sync converges", async () => {
  const { repository, a } = await editedDevice("mine");
  const publish = repository.publish.bind(repository);
  let rounds = 0;
  repository.publish = async (input, ledger) => {
    rounds++;
    await repository.push({ [`other-${rounds}.md`]: await entryFromText(`other ${rounds}`) });
    return publish(input, ledger);
  };
  assert.equal((await a.session.sync()).kind, "contended");
  assert.equal(rounds, 3);
  assert.equal((await parseState(await a.store.load())).operation, null, "every lost round is sealed and cleared");
  repository.publish = publish;
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published);
  assert.equal(entryText(repository.headFiles()["n.md"]!), "mine");
  await assertConverged(repository, a);
});

// ---- Consent: exact versions, no event authority (v3) ---------------------
// These replace v2's approval/observation/revocation tests: events no longer
// revoke anything, and every write is a compare-and-swap against exact bytes.

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
  assert.deepEqual(conflicts.map((item) => item.path).sort(), ["b.md", "c.md"]);
  for (const conflict of conflicts) {
    await a.session.resolve({ conflictId: conflict.id, choice: conflict.path === "c.md"
      ? { kind: "edit", data: (await entryFromText("reviewed c")).data } : { kind: "remote" } });
  }
  a.vault.applied.length = 0;
  return { a, repository, conflicts };
}

test("self-echo: an event per engine write cannot stall a multi-step reviewed operation", async () => {
  const { a, repository } = await reviewedBatch();
  const apply = a.vault.apply.bind(a.vault);
  const echoes: Promise<unknown>[] = [];
  a.vault.apply = async (...args) => {
    const result = await apply(...args);
    echoes.push(a.session.notifyLocalChange());
    return result;
  };
  const outcome = await a.session.sync();
  await Promise.all(echoes);
  assert.ok(outcome.kind === "synced" && outcome.published && outcome.carried.length === 0, JSON.stringify(outcome));
  assert.deepEqual([...a.vault.applied].sort(), ["a.md", "b.md", "c.md", "n.md"]);
  assert.equal(a.vault.text("b.md"), "remote b");
  assert.equal(a.vault.text("n.md"), null);
  assert.equal((await a.session.sync()).kind, "up-to-date", "every reviewed step completed in one sync");
  assert.equal(entryText(repository.headFiles()["c.md"]!), "reviewed c");
  await assertConverged(repository, a);
});

for (const cycle of ["same-bytes", "different-bytes"] as const) {
  test(`a decision binds exact versions: a ${cycle} local cycle ${cycle === "same-bytes" ? "keeps" : "retires"} it`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "other.md": "o" }));
    const a = await enrolled(repository);
    await a.vault.write("n.md", "local");
    await repository.push({ "n.md": await entryFromText("remote") });
    const [conflict] = conflictsOf(await a.session.sync());
    assert.equal((await a.session.resolve({ conflictId: conflict!.id, choice: { kind: "remote" } })).kind, "recorded");
    await a.vault.write("n.md", "transient");
    await a.session.notifyLocalChange();
    await a.vault.write("n.md", cycle === "same-bytes" ? "local" : "local, edited again");
    await a.session.notifyLocalChange();
    // An unrelated head change keeps the exact (base, local, remote) triple.
    await repository.push({ "other.md": await entryFromText("o2") });
    const outcome = await a.restart().sync();
    if (cycle === "same-bytes") {
      assert.equal(outcome.kind, "synced", "the consciously accepted same-byte contract");
      assert.equal(a.vault.text("n.md"), "remote");
      const records = await a.session.listRecovery();
      assert.ok(Array.isArray(records) && records.some((record) => record.pinned && record.paths.includes("n.md")), "the replaced bytes stay recoverable");
    } else {
      const [fresh] = conflictsOf(outcome);
      assert.notEqual(fresh!.id, conflict!.id);
      assert.equal(a.vault.text("n.md"), "local, edited again", "unexpected bytes never auto-apply");
      assert.equal((await a.session.resolve({ conflictId: conflict!.id, choice: { kind: "remote" } })).kind, "stale");
    }
  });
}

test("unexpected bytes at write time are never overwritten; the edit is carried and reviewed again", async () => {
  const { a, repository, conflicts } = await reviewedBatch();
  a.vault.beforeApply = async (path, vault) => {
    if (path === "b.md") await vault.write(path, "concurrent b");
  };
  const outcome = await a.session.sync();
  a.vault.beforeApply = null;
  assert.ok(outcome.kind === "synced" && outcome.carried.includes("b.md"), JSON.stringify(outcome));
  assert.equal(a.vault.text("b.md"), "concurrent b");
  assert.equal(a.vault.text("a.md"), "remote a", "other exact-version steps still complete");
  assert.equal(a.vault.text("n.md"), null);
  const fresh = conflictsOf(await a.restart().sync());
  assert.deepEqual(fresh.map((item) => item.path), ["b.md"]);
  assert.ok(!conflicts.some((old) => old.id === fresh[0]!.id));
  await a.session.resolve({ conflictId: fresh[0]!.id, choice: { kind: "mine" } });
  assert.equal((await a.session.sync()).kind, "synced");
  assert.equal(entryText(repository.headFiles()["b.md"]!), "concurrent b");
});

for (const path of ["a.md", "b.md", "c.md", "n.md"]) {
  for (const when of ["before", "after"] as const) {
    test(`${path} result save failure ${when} persistence never replays completed writes`, async () => {
      const { a, repository } = await reviewedBatch();
      failSaveMatching(a.store, (state) => {
        const op = state.operation;
        return op?.kind === "apply" && op.steps.find((item) => item.path === path)?.status === "applied";
      }, when);
      await assert.rejects(a.session.sync(), Crash);
      const completed = [...a.vault.applied];
      assert.ok(completed.includes(path));
      a.store.fault = null;
      const newerDraft = path === "a.md";
      if (newerDraft) await a.vault.write("a.md", "newer carried draft");
      await a.restart().sync();
      for (const done of completed) assert.equal(a.vault.applied.filter((item) => item === done).length, 1, `${done}: completed writes are not replayed`);
      assert.equal(a.vault.text("a.md"), newerDraft ? "newer carried draft" : "remote a");
      // A lost result save makes the carried origin conservative: a spurious
      // conflict may be asked, never a silent overwrite. Keep this device's draft.
      for (let round = 0; round < 3; round++) {
        const result = await a.session.sync();
        if (result.kind === "needs-decision") for (const item of result.conflicts) await a.session.resolve({ conflictId: item.id, choice: { kind: "mine" } });
      }
      assert.equal(entryText(repository.headFiles()["c.md"]!), "reviewed c");
      if (newerDraft) assert.equal(entryText(repository.headFiles()["a.md"]!), "newer carried draft", "the newer draft is preserved and published");
      await assertConverged(repository, a);
    });
  }
}

test("events after publication dispatch preserve newer drafts without claiming to cancel the in-flight commit", async () => {
  const { repository, a } = await editedDevice("published draft");
  const publish = repository.publish.bind(repository);
  repository.publish = async (input, ledger) => {
    await a.vault.write("n.md", "newer postdispatch draft");
    void a.session.notifyLocalChange();
    return publish(input, ledger);
  };
  const outcome = await a.session.sync();
  repository.publish = publish;
  assert.ok(outcome.kind === "synced" && outcome.published && outcome.carried.includes("n.md"));
  assert.equal(entryText(repository.headFiles()["n.md"]!), "published draft");
  assert.equal(a.vault.text("n.md"), "newer postdispatch draft");
  const saved = await parseState(await a.store.load());
  const draft = (await a.vault.capture())["n.md"]!;
  assert.ok(saved.recovery.find((item) => item.files["n.md"]?.oid === draft.oid)?.pinned);
  assert.equal((await a.restart().sync()).kind, "synced");
  await assertConverged(repository, a);
});

for (const api of ["enrollment", "restore"] as const) {
  test(`${api} preview tokens bind exact bytes: a same-byte cycle confirms, different bytes are stale`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = api === "enrollment" ? await device(repository, { "n.md": "draft" }) : await enrolled(repository);
    if (api === "restore") await a.vault.write("n.md", "draft");
    const preview = api === "enrollment" ? await a.session.previewEnrollment() : await a.session.previewRestore({ path: "n.md", commit: repository.branchHead });
    assert.ok(preview.kind === "preview");
    const confirm = (token: string) => api === "enrollment" ? a.session.enroll({ token }) : a.session.restore({ token, path: "n.md", commit: repository.branchHead });
    await a.vault.write("n.md", "different");
    await a.session.notifyLocalChange();
    assert.equal((await confirm(preview.token)).kind, "stale");
    await a.vault.write("n.md", "draft");
    await a.session.notifyLocalChange();
    assert.equal((await confirm(preview.token)).kind, api === "enrollment" ? "enrolled" : "restored");
  });
}

test("notifyLocalChange is a scheduling hint that never writes the journal", async () => {
  const { a } = await reviewedBatch();
  const raw = a.store.raw;
  const saves = a.store.saves;
  for (let index = 0; index < 5; index++) assert.equal((await a.session.notifyLocalChange()).kind, "invalidated");
  assert.equal(a.store.saves, saves);
  assert.equal(a.store.raw, raw);
});

// ---- Guards ---------------------------------------------------------------

test("an empty capture against a non-empty checkpoint is refused as storage loss, never planned", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "a.md": "a", "b.md": "b" }));
  const a = await enrolled(repository);
  const saved = new Map(a.vault.files);
  a.vault.files.clear();
  await assert.rejects(a.session.sync(), VaultCaptureError);
  assert.equal(count(repository, "prepare"), 0);
  assert.deepEqual(Object.keys(repository.headFiles()).sort(), ["a.md", "b.md"]);
  a.vault.files = saved;
  assert.equal((await a.session.sync()).kind, "up-to-date");
});

for (const direction of ["local", "remote"] as const) {
  test(`a ${direction} bulk deletion needs one confirmation; a smaller deletion stays automatic`, async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`folder/n${index}.md`, `body ${index}`]));
    const repository = await MemoryRepository.create(await snapshot({ ...files, "keep.md": "k" }));
    const a = await enrolled(repository, "A");
    const b = await enrolled(repository, "B");
    const deleter = direction === "local" ? a : b;
    for (const path of Object.keys(files)) deleter.vault.files.delete(path);
    if (direction === "remote") {
      const reviewed = await b.session.sync();
      assert.equal(reviewed.kind, "needs-decision");
      const [bulk] = reviewed.kind === "needs-decision" ? reviewed.conflicts : [];
      assert.ok(bulk?.kind === "bulk-deletion" && bulk.direction === "local");
      await b.session.resolve({ conflictId: bulk.id, choice: { kind: "mine" } });
      assert.equal((await b.session.sync()).kind, "synced");
    }
    const outcome = await a.session.sync();
    assert.equal(outcome.kind, "needs-decision", "a vanished folder is reviewed, not permanently blocked");
    const [conflict] = outcome.kind === "needs-decision" ? outcome.conflicts : [];
    assert.ok(conflict?.kind === "bulk-deletion" && conflict.direction === direction && conflict.paths.length === 30);
    const status = await a.session.status();
    assert.ok(status.kind === "enrolled" && status.phase === "needs-decision" && status.conflicts[0]?.kind === "bulk-deletion");
    assert.equal((await a.session.resolve({ conflictId: conflict.id, choice: { kind: "both" } })).kind, "invalid");
    if (direction === "local") {
      // Keep GitHub's side: the files return locally and nothing is deleted remotely.
      await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
      assert.equal((await a.session.sync()).kind, "synced");
      assert.equal(a.vault.text("folder/n0.md"), "body 0");
      assert.ok("folder/n0.md" in repository.headFiles());
    } else {
      await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
      assert.equal((await a.session.sync()).kind, "synced");
      assert.equal(a.vault.text("folder/n0.md"), null);
    }
    await b.session.sync();
    await assertConverged(repository, a, b);
  });
}


test("F4: a whole top-level folder vanishing (3+ files, below the bulk floor) needs one review in each direction; exact paths", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "attachments/a.md": "a", "attachments/b.md": "b", "attachments/sub/c.md": "c", "keep.md": "k", "loose.md": "l" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  for (const path of ["attachments/a.md", "attachments/b.md", "attachments/sub/c.md", "loose.md"]) a.vault.files.delete(path);
  const reviewed = await a.session.sync();
  const [bulk] = reviewed.kind === "needs-decision" ? reviewed.conflicts : [];
  assert.ok(bulk?.kind === "bulk-deletion" && bulk.direction === "local", JSON.stringify(reviewed));
  assert.deepEqual(bulk.paths, ["attachments/a.md", "attachments/b.md", "attachments/sub/c.md", "loose.md"], "exactly this side's deletions");
  assert.ok("attachments/a.md" in repository.headFiles(), "nothing deleted before the decision");
  await a.session.resolve({ conflictId: bulk.id, choice: { kind: "mine" } });
  assert.equal((await a.session.sync()).kind, "synced");
  assert.deepEqual(Object.keys(repository.headFiles()).sort(), ["keep.md"]);
  const incoming = await b.session.sync();
  const [remote] = incoming.kind === "needs-decision" ? incoming.conflicts : [];
  assert.ok(remote?.kind === "bulk-deletion" && remote.direction === "remote" && remote.paths.length === 4, JSON.stringify(incoming));
  assert.equal(b.vault.text("attachments/a.md"), "a");
  await b.session.resolve({ conflictId: remote.id, choice: { kind: "remote" } });
  assert.equal((await b.session.sync()).kind, "synced");
  await assertConverged(repository, a, b);
});

test("F4: a two-file folder deletion and a pure folder move stay automatic", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "pair/a.md": "a", "pair/b.md": "b", "photos/1.md": "1", "photos/2.md": "2", "photos/3.md": "3", "keep.md": "k" }));
  const a = await enrolled(repository, "A");
  a.vault.files.delete("pair/a.md");
  a.vault.files.delete("pair/b.md");
  for (const index of [1, 2, 3]) {
    a.vault.files.set(`media/${index}.md`, a.vault.files.get(`photos/${index}.md`)!);
    a.vault.files.delete(`photos/${index}.md`);
  }
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.deepEqual(Object.keys(repository.headFiles()).sort(), ["keep.md", "media/1.md", "media/2.md", "media/3.md"]);
});

// ---- Migration /1 and /2 -> /3 ---------------------------------------------

type Raw = Record<string, unknown> & { operation: Record<string, unknown> | null; review: Record<string, unknown> | null };

/** Rewrites a /3 journal into the /1 or /2 shape that older releases wrote. */
function toLegacy(state: string, format: "github-vault-sync/1" | "github-vault-sync/2", observation: "settled" | "pending" | null = "settled"): string {
  const old = JSON.parse(state) as Raw;
  old.format = format;
  delete old.ledger;
  delete old.holds;
  delete old.unacknowledged;
  delete old.nativeErrors;
  if (format === "github-vault-sync/2" && observation) old.observation = observation;
  if (old.review && format === "github-vault-sync/2") Object.assign(old.review, { scope: "review-1", local: {} });
  const op = old.operation;
  if (op) {
    const incoming = op.incomingRecoveryId;
    for (const key of ["incomingRecoveryId", "receipt", "anchor", "publication", "replan", "fence"]) delete op[key];
    op.steps = (op.steps as Array<Record<string, unknown>>).map(({ decision, ...step }) =>
      format === "github-vault-sync/2" ? { ...step, consent: decision ? { kind: "reviewed", base: null } : { kind: "automatic" } } : step);
    if (format === "github-vault-sync/2") {
      op.incoming = { kind: "captured", recoveryId: incoming };
      op.approval = { kind: "revoked" };
    }
  }
  return JSON.stringify(old);
}

/** A recorded, never-dispatched publish operation (crash after its durable save). */
async function recordedPublication(a: Device) {
  failSaveMatching(a.store, (state) => state.operation?.kind === "publish", "after");
  await assert.rejects(a.session.sync(), Crash);
  a.store.fault = null;
  const saved = await parseState(await a.store.load());
  assert.ok(saved.operation?.kind === "publish");
  return saved.operation;
}

for (const format of ["github-vault-sync/1", "github-vault-sync/2"] as const) {
  test(`${format} uncertain publication is fenced through the ledger before review, so a late request can never land`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    await a.vault.write("n.md", "legacy candidate");
    const operation = await recordedPublication(a);
    a.store.raw = toLegacy(a.store.raw!, format);
    const migrated = await parseState(await a.store.load());
    assert.ok(migrated.operation?.kind === "publish" && migrated.operation.publication.phase === "legacy" && migrated.operation.receipt === null);
    // The /2 request moved only the branch; model it as still in flight.
    const legacyRequest = () => repository.updateRefs([{ name: "refs/heads/main", before: operation.parent, after: operation.candidate.commit }]);
    assert.equal((await a.restart().previewPublicationRecovery()).kind, "unfenced", "no release while the branch sits at the parent");
    const publishes = count(repository, "publish");
    repository.ancestorFault = true;
    const fenced = await a.session.sync();
    repository.ancestorFault = false;
    assert.ok(fenced.kind === "publication-unknown" && fenced.fenced, JSON.stringify(fenced));
    assert.equal(count(repository, "publish"), publishes + 1, "exactly one fence publication");
    assert.equal(count(repository, "seal") + count(repository, "createSeal"), 0);
    const fence = repository.commits.get(repository.branchHead)!;
    assert.deepEqual(fence.parents, [operation.parent]);
    assert.equal(fence.tree, repository.commits.get(operation.parent)!.tree, "the fence changes no file");
    const saved = await parseState(await a.store.load());
    assert.ok(saved.operation?.kind === "publish" && saved.operation.fence === null && saved.ledger.anchor === repository.ledger("A"));
    assert.equal(legacyRequest(), false, "the late /2 request can never land");
    assert.equal((await a.session.sync()).kind, "publication-unknown", "a fence proves nothing about the candidate; review stays");
    assert.equal(count(repository, "publish"), publishes + 1, "no second fence once the branch left the parent");
    const status = await a.session.status();
    assert.ok(status.kind === "enrolled" && status.phase === "publication-unknown");
    const preview = await a.session.previewPublicationRecovery();
    assert.ok(preview.kind === "preview");
    const released = await a.session.recoverPublication({ token: preview.token });
    assert.ok(released.kind === "released" && released.pause.detail.includes("can no longer land"));
    const enrollment = await a.session.previewEnrollment();
    assert.ok(enrollment.kind === "preview");
    await a.session.enroll({ token: enrollment.token });
    assert.equal((await a.session.sync()).kind, "synced");
    assert.equal(a.vault.text("n.md"), "base");
    assert.equal(legacyRequest(), false);
    assert.equal((await a.session.sync()).kind, "up-to-date");
    assert.equal(a.vault.text("n.md"), "base", "the discard is never reversed by the old request");
    const candidate = await entryFromText("legacy candidate");
    assert.ok((await parseState(await a.store.load())).recovery.some((record) => record.files["n.md"]?.oid === candidate.oid), "the archived candidate stays recoverable");
    await assertConverged(repository, a);
  });

  for (const order of ["fence-first", "legacy-first"] as const) {
    test(`${format} a fence crash-recorded before dispatch and delayed (${order}) settles by its receipt or seal only`, async () => {
      const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
      const a = await enrolled(repository);
      await a.vault.write("n.md", "legacy candidate");
      const operation = await recordedPublication(a);
      a.store.raw = toLegacy(a.store.raw!, format);
      const legacyRequest = () => repository.updateRefs([{ name: "refs/heads/main", before: operation.parent, after: operation.candidate.commit }]);
      // Crash right after the fence identity is durable, before its dispatch.
      failSaveMatching(a.store, (state) => state.operation?.kind === "publish" && state.operation.fence !== null, "after");
      await assert.rejects(a.restart().sync(), Crash);
      a.store.fault = null;
      const recorded = await parseState(await a.store.load());
      assert.ok(recorded.operation?.kind === "publish" && recorded.operation.fence);
      const prepares = count(repository, "prepare");
      // The fence was never sent: the restart seals it (never re-dispatches it).
      repository.sealFault = "delay";
      assert.equal((await a.restart().sync()).kind, "settling");
      repository.sealFault = null;
      assert.equal(count(repository, "publish"), 0, "the recorded fence is never dispatched after the crash");
      if (order === "legacy-first") assert.equal(legacyRequest(), true, "the branch is still at the parent");
      repository.deliver();
      const settled = await a.session.sync();
      if (order === "legacy-first") {
        assert.ok(settled.kind === "synced" && settled.published, "a reachable legacy candidate is accepted");
        assert.equal(a.vault.text("n.md"), "legacy candidate");
      } else {
        assert.ok(settled.kind === "publication-unknown" && settled.fenced, JSON.stringify(settled));
        assert.equal(legacyRequest(), false);
        assert.ok(count(repository, "prepare") === prepares + 1, "one new fence after the sealed one");
      }
      assert.equal((await parseState(await a.store.load())).ledger.anchor, repository.ledger("A"), "the anchor follows only settled ledger values");
      assert.equal(count(repository, "createSeal"), 1, "one durable seal identity for the crashed fence");
    });
  }

  test(`${format} publication found reachable is accepted and its steps re-planned`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "m.md": "m" }));
    const a = await enrolled(repository);
    await a.vault.write("n.md", "legacy accepted");
    await repository.push({ "m.md": await entryFromText("remote m") });
    const operation = await recordedPublication(a);
    a.store.raw = toLegacy(a.store.raw!, format);
    repository.branchHead = operation.candidate.commit;
    const reviewed = await a.session.previewPublicationRecovery();
    assert.equal(reviewed.kind, "reachable");
    const outcome = await a.restart().sync();
    assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
    assert.equal(a.vault.text("m.md"), "remote m");
    assert.equal(repository.calls.filter((call) => call === "publish").length, 0);
    await assertConverged(repository, a);
  });

  test(`${format} blocked or reviewed apply steps re-plan to exact automatic steps`, async () => {
    const repository = await MemoryRepository.create(await snapshot({ "image.png": await bytes([1]), "n.md": "base", "d.md": "d" }));
    const a = await enrolled(repository);
    const incoming = await bytes([2]);
    await repository.push({ "image.png": incoming, "n.md": await entryFromText("remote"), "d.md": null });
    a.vault.blockBinary = true;
    assert.equal((await a.session.sync()).kind, "blocked");
    a.store.raw = toLegacy(a.store.raw!, format);
    const migrated = await parseState(await a.store.load());
    assert.ok(migrated.operation?.kind === "apply" && migrated.operation.replan && migrated.operation.steps.length === 0);
    a.vault.blockBinary = false;
    const outcome = await a.restart().sync();
    assert.ok(outcome.kind === "synced" || outcome.kind === "up-to-date", JSON.stringify(outcome));
    assert.deepEqual([...decodeBytes(a.vault.files.get("image.png")!.data)], [2]);
    assert.equal(a.vault.text("d.md"), null);
    await assertConverged(repository, a);
  });
}

test("/2 re-planning carries a path whose bytes differ from the checkpoint and asks again", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await repository.push({ "n.md": await entryFromText("remote") });
  failSaveMatching(a.store, (state) => state.operation?.kind === "apply", "after");
  await assert.rejects(a.session.sync(), Crash);
  a.store.fault = null;
  a.store.raw = toLegacy(a.store.raw!, "github-vault-sync/2");
  await a.vault.write("n.md", "local edit made under /2");
  const outcome = await a.restart().sync();
  const [conflict] = conflictsOf(outcome);
  assert.equal(conflict!.kind, "content");
  assert.equal(a.vault.text("n.md"), "local edit made under /2", "unexpected bytes are never overwritten");
});

test("a migrated /2 vault binds its ledger only if the ref is absent; a present ref is a duplicate installation", async () => {
  for (const present of [false, true]) {
    const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
    const a = await enrolled(repository);
    a.store.raw = toLegacy(a.store.raw!, "github-vault-sync/2");
    if (present) repository.refs.set("refs/vault-sync/devices/A", await repository.orphan("copied"));
    await a.vault.write("n.md", "after migration");
    const outcome = await a.restart().sync();
    if (present) {
      assert.ok(outcome.kind === "paused" && outcome.pause.reason === "duplicate-installation");
      assert.equal(repository.calls.filter((call) => call === "prepare").length, 0);
    } else {
      assert.ok(outcome.kind === "synced" && outcome.published);
      const saved = await parseState(await a.store.load());
      assert.equal(saved.ledger.ref, "refs/vault-sync/devices/A");
      assert.equal(saved.ledger.anchor, repository.ledger("A"));
    }
  }
});

test("a journal bound to another installation's ledger pauses as a duplicate installation", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository, "A");
  const copied = new SyncSession({ repository: repository.device("B"), vault: a.vault, store: a.store, now: NOW, delay: async () => {} });
  const outcome = await copied.sync();
  assert.ok(outcome.kind === "paused" && outcome.pause.reason === "duplicate-installation");
});

test("/2 review decisions and observation markers retire with every referenced version preserved", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "local");
  await repository.push({ "n.md": await entryFromText("remote") });
  const [conflict] = conflictsOf(await a.session.sync());
  const edited = await entryFromText("replacement only in the retired decision");
  await a.session.resolve({ conflictId: conflict!.id, choice: { kind: "edit", data: edited.data } });
  for (const observation of ["pending", null, "settled"] as const) {
    const raw = toLegacy(a.store.raw!, "github-vault-sync/2", observation);
    const migrated = await parseState(JSON.parse(raw));
    assert.equal(migrated.review, null);
    assert.deepEqual(Object.keys(migrated.decisions), []);
    assert.ok(migrated.recovery.some((record) => record.pinned && record.files["n.md"]?.oid === edited.oid));
  }
  const bad = JSON.parse(toLegacy(a.store.raw!, "github-vault-sync/2"));
  bad.observation = "finished";
  await assert.rejects(parseState(bad), /observation: expected one of settled,pending/);
  a.store.raw = toLegacy(a.store.raw!, "github-vault-sync/1");
  const fresh = conflictsOf(await a.restart().sync());
  assert.equal(fresh.length, 1, "the conflict is asked again under v3");
  assert.equal(a.vault.text("n.md"), "local");
});

test("an omitted /1 __proto__ baseline is recovered from the immutable checkpoint before a deletion is planned", async () => {
  const entry = await entryFromText("prototype file");
  const repository = await MemoryRepository.create(Object.fromEntries([["__proto__", entry]]));
  const view = async (commit: string) => {
    const raw = repository.commits.get(commit)!;
    return { oid: raw.oid, treeOid: raw.tree, files: dictionary(Object.entries(raw.files)) };
  };
  repository.head = () => view(repository.branchHead);
  repository.readCommit = view;
  const a = await device(repository);
  a.vault.files.set("__proto__", entry);
  await a.vault.write("keep.md", "k");
  const preview = await a.session.previewEnrollment();
  assert.ok(preview.kind === "preview");
  await a.session.enroll({ token: preview.token });
  const raw = JSON.parse(toLegacy(a.store.raw!, "github-vault-sync/1"));
  delete raw.base.files["__proto__"];
  a.store.raw = JSON.stringify(raw);
  a.vault.files.delete("__proto__");
  const outcome = await a.restart().sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.equal(Object.hasOwn(repository.fullHeadFiles(), "__proto__"), false, "the deletion is planned against the recovered baseline");
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
  const raw = JSON.parse(toLegacy(a.store.raw!, "github-vault-sync/1"));
  delete raw.base.files["__proto__"];
  a.store.raw = JSON.stringify(raw);
  await repository.forceReset(await snapshot({ "other.md": "replacement history" }));
  assert.equal((await a.restart().sync()).kind, "paused");
  const reenrollment = await a.session.previewEnrollment();
  assert.ok(reenrollment.kind === "preview");
  assert.equal(reenrollment.items.find((item) => item.path === "__proto__")?.action, "review-remote-deletion");
});

test("stored /3 metadata rejects retired statuses, malformed decisions and inconsistent ledger identities", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base" }));
  const a = await enrolled(repository);
  await a.vault.write("n.md", "draft");
  await recordedPublication(a);
  const raw = JSON.parse(a.store.raw!);
  await assert.doesNotReject(parseState(raw));
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["revoked status", (value) => value.operation.steps.push({ path: "x.md", expected: null, next: value.operation.steps[0]?.next ?? { oid: "a".repeat(40), mode: "100644" }, status: "revoked", decision: null, reason: null }), /expected one of/],
    ["anchor mismatch", (value) => (value.operation.anchor = "b".repeat(40)), /anchor differs/],
    ["missing receipt", (value) => (value.operation.receipt = null), /lack a receipt/],
    ["receipt equals candidate", (value) => (value.operation.receipt = value.operation.candidate.commit), /distinct/],
    ["unknown phase", (value) => (value.operation.publication = { phase: "prepared" }), /expected one of/],
    ["malformed ledger ref", (value) => (value.ledger.ref = "refs/heads/main"), /device ledger ref/],
    ["unbound ledger with publication", (value) => (value.ledger.ref = null), /bound ledger/],
    ["malformed hold", (value) => (value.holds["n.md"] = { ids: [], kind: "interrupted", expected: null, next: null, found: null }), /distinct issue ids/],
  ];
  for (const [label, mutate, error] of cases) {
    const copy = structuredClone(raw);
    mutate(copy);
    await assert.rejects(parseState(copy), error, label);
  }
});


// ---- Native evidence holds (review F1/F2) ----------------------------------

async function tornSetup() {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": lines(10), "other.md": "o" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await b.vault.write("n.md", lines(10, { 1: "B one" }));
  assert.equal((await b.session.sync()).kind, "synced");
  const torn = await entryFromText(lines(10, { 1: "B one" }).split("\n").slice(0, 5).join("\n") + "\n");
  return { repository, a, b, torn };
}

for (const delivery of ["result", "crash"] as const) {
  test(`R1: an interrupted text write (${delivery}) becomes a held conflict and is never merged or published`, async () => {
    const { repository, a, b, torn } = await tornSetup();
    a.vault.native = { path: "n.md", kind: "interrupted", bytes: torn, crash: delivery === "crash" };
    if (delivery === "crash") {
      await assert.rejects(a.session.sync(), Crash);
      a.restart();
    }
    const head = repository.branchHead;
    const outcome = await a.session.sync();
    assert.equal(outcome.kind, "needs-decision", JSON.stringify(outcome));
    assert.equal(repository.branchHead, head, "the torn bytes never reach GitHub");
    assert.equal(entryText(repository.headFiles()["n.md"]!), lines(10, { 1: "B one" }));
    const conflict = outcome.kind === "needs-decision" ? outcome.conflicts.find((item) => item.kind === "interrupted-write") : undefined;
    assert.ok(conflict && conflict.kind === "interrupted-write");
    assert.equal(conflict.found?.oid, torn.oid);
    assert.equal(entryText(conflict.expected!), lines(10));
    assert.equal(entryText(conflict.next!), lines(10, { 1: "B one" }));
    assert.deepEqual(conflict.choices, ["mine", "expected", "next", "found", "remote", "edit"]);
    assert.deepEqual(a.vault.acknowledged, ["issue-1"], "acknowledged only after durable ingestion");
    const saved = await parseState(await a.store.load());
    assert.ok(saved.holds["n.md"] && saved.unacknowledged.length === 0);
    assert.ok(saved.recovery.some((record) => record.reason === "native" && record.pinned && record.files["n.md"]?.oid === torn.oid));
    // Other files keep synchronizing while the note is held.
    await b.vault.write("other.md", "o from B");
    await b.session.sync();
    await a.vault.write("fresh.md", "new local file");
    const progressed = await a.session.sync();
    assert.equal(progressed.kind, "needs-decision");
    assert.equal(a.vault.text("other.md"), "o from B");
    assert.equal(entryText(repository.headFiles()["fresh.md"]!), "new local file");
    assert.equal(a.vault.text("n.md"), entryText(torn), "the held path is untouched");
    // Choosing GitHub's intended version restores the note; the hold clears only after the exact write.
    const current = (await a.session.status());
    assert.ok(current.kind === "enrolled");
    const held = current.conflicts.find((item) => item.kind === "interrupted-write")!;
    assert.equal((await a.session.resolve({ conflictId: held.id, choice: { kind: "next" } })).kind, "recorded");
    assert.equal((await a.session.sync()).kind, "synced");
    assert.equal(a.vault.text("n.md"), lines(10, { 1: "B one" }));
    assert.deepEqual(Object.keys((await parseState(await a.store.load())).holds), []);
    await b.session.sync();
    await assertConverged(repository, a, b);
  });
}

for (const between of ["nothing", "restart", "unrelated apply", "unrelated publish"] as const) {
  test(`F1: the first held conflict's decision is applied by the next sync (${between} in between)`, async () => {
    const { repository, a, b, torn } = await tornSetup();
    a.vault.native = { path: "n.md", kind: "interrupted", bytes: torn };
    const first = await a.session.sync();
    const conflict = first.kind === "needs-decision" ? first.conflicts.find((item) => item.kind === "interrupted-write") : undefined;
    assert.ok(conflict && conflict.kind === "interrupted-write", JSON.stringify(first));
    assert.equal(entryText(conflict.base!), lines(10), "the review shows the version the write started from");
    assert.equal((await a.session.resolve({ conflictId: conflict.id, choice: { kind: "next" } })).kind, "recorded");
    if (between === "restart") a.restart();
    if (between === "unrelated apply") {
      await b.vault.write("other.md", "o from B");
      assert.equal((await b.session.sync()).kind, "synced");
    }
    if (between === "unrelated publish") await a.vault.write("fresh.md", "fresh");
    const second = await a.session.sync();
    assert.ok(second.kind === "synced", JSON.stringify(second));
    assert.equal(a.vault.text("n.md"), lines(10, { 1: "B one" }));
    assert.deepEqual(Object.keys((await parseState(await a.store.load())).holds), []);
    await b.session.sync();
    await assertConverged(repository, a, b);
  });
}

test("F1: a hold's base is fixed at ingestion, durable and parsed back", async () => {
  const { a, torn } = await tornSetup();
  a.vault.native = { path: "n.md", kind: "interrupted", bytes: torn };
  await a.session.sync();
  const saved = await parseState(await a.store.load());
  const base = await entryFromText(lines(10));
  assert.equal(saved.holds["n.md"]?.base?.oid, base.oid);
  assert.equal(saved.blobs[base.oid], base.data, "the base bytes are pinned while the hold exists");
  assert.notEqual(saved.base.files["n.md"]?.oid, base.oid, "the checkpoint advanced; the hold's base did not");
  const legacy = JSON.parse(a.store.raw!);
  delete legacy.holds["n.md"].base;
  delete legacy.holds["n.md"].oversize;
  assert.equal((await parseState(legacy)).holds["n.md"]?.base, null, "holds stored before bases were recorded still load");
});

test("F6: a sync that publishes and then stops for a held decision reports both", async () => {
  const { a, torn } = await tornSetup();
  a.vault.native = { path: "n.md", kind: "interrupted", bytes: torn };
  await a.vault.write("fresh.md", "fresh");
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "needs-decision" && outcome.published, JSON.stringify(outcome));
  assert.deepEqual(outcome.carried, ["n.md"], "the interrupted step's path is reported as carried, not applied");
});

test("a held note edited after its decision asks again instead of auto-resolving", async () => {
  const { repository, a, torn } = await tornSetup();
  a.vault.native = { path: "n.md", kind: "interrupted", bytes: torn };
  const first = await a.session.sync();
  const conflict = first.kind === "needs-decision" ? first.conflicts.find((item) => item.kind === "interrupted-write")! : assert.fail();
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "expected" } });
  await a.vault.write("n.md", "typed after deciding");
  const again = await a.session.sync();
  assert.equal(again.kind, "needs-decision");
  const fresh = again.kind === "needs-decision" ? again.conflicts.find((item) => item.kind === "interrupted-write")! : assert.fail();
  assert.notEqual(fresh.id, conflict.id);
  assert.equal(a.vault.text("n.md"), "typed after deciding");
  assert.equal(entryText(repository.headFiles()["n.md"]!), lines(10, { 1: "B one" }));
  // Keeping the current bytes is an explicit choice; it clears with the next durable save and publishes.
  await a.session.resolve({ conflictId: fresh.id, choice: { kind: "mine" } });
  const kept = await a.session.sync();
  assert.ok(kept.kind === "synced" && kept.published, JSON.stringify(kept));
  assert.equal(entryText(repository.headFiles()["n.md"]!), "typed after deciding");
  assert.deepEqual(Object.keys((await parseState(await a.store.load())).holds), []);
});

test("F2: displaced bytes surface as a held conflict offering the moved edit", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "base", "image.png": await bytes([1]) }));
  const a = await enrolled(repository, "A");
  await repository.push({ "image.png": await bytes([2]) });
  const moved = await bytes([1, 9, 9]);
  a.vault.native = { path: "image.png", kind: "displaced", bytes: moved };
  const outcome = await a.session.sync();
  assert.equal(outcome.kind, "needs-decision", JSON.stringify(outcome));
  const conflict = outcome.kind === "needs-decision" ? outcome.conflicts[0]! : assert.fail();
  assert.ok(conflict.kind === "displaced-write" && conflict.found?.oid === moved.oid);
  assert.deepEqual([...decodeBytes(a.vault.files.get("image.png")!.data)], [2], "the intent is installed");
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "found" } });
  const restored = await a.session.sync();
  assert.ok(restored.kind === "synced" && restored.published, JSON.stringify(restored));
  assert.deepEqual([...decodeBytes(repository.headFiles()["image.png"]!.data)], [1, 9, 9]);
  await assertConverged(repository, a);
});

test("native ingestion is idempotent across a failed acknowledgement and verifies issue bytes", async () => {
  const { a, torn } = await tornSetup();
  a.vault.native = { path: "n.md", kind: "interrupted", bytes: torn };
  a.vault.acknowledgeFault = true;
  assert.equal((await a.session.sync()).kind, "needs-decision");
  assert.deepEqual(a.vault.acknowledged, []);
  assert.deepEqual((await parseState(await a.store.load())).unacknowledged, ["issue-1"]);
  a.vault.acknowledgeFault = false;
  assert.equal((await a.restart().sync()).kind, "needs-decision");
  const saved = await parseState(await a.store.load());
  assert.deepEqual(saved.holds["n.md"]?.ids, ["issue-1"], "the re-reported issue is not ingested twice");
  assert.deepEqual(saved.unacknowledged, []);
  assert.deepEqual(a.vault.acknowledged, ["issue-1"]);
});

test("F5: an unverifiable native issue is never acknowledged and holds its path (or the vault, when its path is unknown) with a readable error", async () => {
  const { repository, a, b } = await tornSetup();
  // A forged issue for a known path quarantines that path; everything else syncs.
  a.vault.issues.push({ id: "forged", path: "n.md", kind: "interrupted", expected: null, next: null, found: { ...(await entryFromText("x")), oid: "f".repeat(40) } });
  await b.vault.write("other.md", "o from B");
  assert.equal((await b.session.sync()).kind, "synced");
  await a.vault.write("fresh.md", "fresh");
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && outcome.published, JSON.stringify(outcome));
  assert.equal(a.vault.text("other.md"), "o from B");
  assert.equal(a.vault.text("n.md"), lines(10), "the quarantined path is never written");
  assert.equal(entryText(repository.headFiles()["n.md"]!), lines(10, { 1: "B one" }));
  assert.ok(!(a.vault.acknowledged as string[]).includes("forged"));
  let status = await a.restart().status();
  assert.ok(status.kind === "enrolled" && status.nativeErrors.length === 1 && status.nativeErrors[0]!.path === "n.md" && status.nativeErrors[0]!.id === "forged", JSON.stringify(status));
  assert.match(status.nativeErrors[0]!.detail, /does not match its object ID/);
  // An issue whose path is unknown blocks the whole vault before any capture or plan.
  a.vault.issues.push({ id: "escape", path: "../n.md", kind: "displaced", expected: null, next: null, found: await entryFromText("x") });
  const prepares = count(repository, "prepare");
  await a.vault.write("fresh.md", "edited");
  const blocked = await a.session.sync();
  assert.ok(blocked.kind === "native-error" && blocked.errors.some((item) => item.id === "escape" && item.path === null), JSON.stringify(blocked));
  assert.equal(count(repository, "prepare"), prepares);
  status = await a.session.status();
  assert.ok(status.kind === "enrolled" && status.phase === "native-error");
  // Once the vault stops reporting them (fixed or withdrawn), both errors clear and the vault converges.
  a.vault.issues = a.vault.issues.filter((issue) => issue.id !== "forged" && issue.id !== "escape");
  const cleared = await a.session.sync();
  assert.ok(cleared.kind === "synced" && cleared.published, JSON.stringify(cleared));
  status = await a.session.status();
  assert.ok(status.kind === "enrolled" && status.nativeErrors.length === 0);
  await b.session.sync();
  await assertConverged(repository, a, b);
});

test("restore ingests native evidence first and refuses a held path", async () => {
  const { repository, a, torn } = await tornSetup();
  const original = repository.commits.get(repository.branchHead)!.parent!;
  // An orphan reported by the vault's startup scan, unrelated to any step.
  a.vault.issues.push({ id: "orphan-1", path: "n.md", kind: "displaced", expected: null, next: null, found: torn });
  const preview = await a.restart().previewRestore({ path: "n.md", commit: original });
  assert.ok(preview.kind === "preview");
  assert.equal((await a.session.restore(preview)).kind, "stale");
  assert.ok((await parseState(await a.store.load())).holds["n.md"]);
  assert.deepEqual(a.vault.acknowledged, ["orphan-1"]);
  assert.equal(a.vault.text("n.md"), lines(10));
});


// ---- Native cancellation, fences, oversize and unreadable files (native R2) --

async function refusedDeletion() {
  const repository = await MemoryRepository.create(await snapshot({ "n.md": "draft to keep", "other.md": "o" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  b.vault.files.delete("n.md");
  assert.equal((await b.session.sync()).kind, "synced");
  // The native intent is durable, then an open view refuses the write.
  a.vault.pendingNext = { path: "n.md", mode: "refuse" };
  const blocked = await a.session.sync();
  assert.ok(blocked.kind === "blocked" && blocked.steps[0]?.path === "n.md", JSON.stringify(blocked));
  assert.equal(a.vault.intents.size, 1);
  return { repository, a, b };
}

test("R2-A: keepLocal durably cancels the pending native intent; the deletion never resurrects", async () => {
  const { repository, a, b } = await refusedDeletion();
  assert.equal((await a.session.keepLocal({ path: "n.md" })).kind, "recorded");
  assert.equal(a.vault.intents.size, 1, "keepLocal itself never touches the vault");
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced", JSON.stringify(outcome));
  assert.equal(a.vault.text("n.md"), "draft to keep");
  assert.equal(a.vault.intents.size, 0);
  const intentId = a.vault.authorizations.flatMap((item) => item.cancel)[0];
  assert.ok(intentId && !a.vault.authorizations.some((item) => item.replay.includes(intentId)), "never authorized for replay");
  // Keep-local republishes the kept note (documented consequence).
  assert.equal(entryText(repository.headFiles()["n.md"]!), "draft to keep");
  assert.equal((await a.restart().sync()).kind, "up-to-date");
  assert.equal(a.vault.text("n.md"), "draft to keep");
  await b.session.sync();
  await assertConverged(repository, a, b);
});

for (const crash of ["before native cancel", "after native cancel, before engine save"] as const) {
  test(`R2-A: a crash ${crash} converges without resurrecting the intent`, async () => {
    const { repository, a } = await refusedDeletion();
    await a.session.keepLocal({ path: "n.md" });
    const recover = a.vault.recover.bind(a.vault);
    if (crash === "before native cancel") {
      a.vault.recover = async () => { a.vault.recover = recover; throw new Crash("died before the native save"); };
    } else {
      a.vault.recover = async (authorization) => {
        a.vault.recover = recover;
        await recover(authorization);
        throw new Crash("died after the native save");
      };
    }
    await assert.rejects(a.restart().sync(), Crash);
    assert.equal(a.vault.text("n.md"), "draft to keep");
    const saved = await parseState(await a.store.load());
    assert.ok(saved.operation?.kind === "apply" && saved.operation.steps.find((step) => step.path === "n.md")?.status === "kept");
    assert.equal((await a.restart().sync()).kind, "synced");
    assert.equal(a.vault.text("n.md"), "draft to keep");
    assert.equal(a.vault.intents.size, 0);
    assert.equal(entryText(repository.headFiles()["n.md"]!), "draft to keep");
  });
}

test("R2-A: a stale intent whose step is no longer pending is refused by apply and cancelled, never replayed", async () => {
  const { a } = await refusedDeletion();
  // An apply call for different versions while the intent is pending is refused without mutation.
  const result = await a.vault.apply("n.md", await entryFromText("draft to keep"), await entryFromText("other"));
  assert.equal(result.kind, "blocked");
  assert.equal(a.vault.text("n.md"), "draft to keep");
});

test("R2-A: an accepted operation's pending intent is replayed only when it matches an unfinished step", async () => {
  const { repository, a, b } = await refusedDeletion();
  // The view closes; the next sync authorizes exactly that intent.
  const intent = [...a.vault.intents.values()][0]!;
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" || outcome.kind === "up-to-date", JSON.stringify(outcome));
  assert.equal(a.vault.text("n.md"), null);
  assert.deepEqual(a.vault.authorizations.at(-1), { replay: [intent.id], cancel: [] });
  await b.session.sync();
  await assertConverged(repository, a, b);
});

test("R2-F: no native recovery runs while paused, under another repository, or for a duplicate installation", async () => {
  const { repository, a } = await refusedDeletion();
  const calls = () => a.vault.authorizations.length;
  const before = calls();
  repository.identityValue = { ...repository.identityValue, id: "R_other" };
  assert.equal((await a.session.sync()).kind, "paused");
  assert.equal((await a.restart().sync()).kind, "paused");
  assert.equal(calls(), before, "identity change: nothing native was replayed or cancelled");
  assert.equal(a.vault.intents.size, 1);
  repository.identityValue = { ...repository.identityValue, id: "R_1" };
  // A durable duplicate-installation pause also fences every later sync.
  const raw = JSON.parse(a.store.raw!);
  raw.pause = { reason: "duplicate-installation", detail: "shared" };
  raw.operation = null;
  a.store.raw = JSON.stringify(raw);
  for (let round = 0; round < 2; round++) assert.equal((await a.restart().sync()).kind, "paused");
  assert.equal(calls(), before);
  assert.equal(a.vault.intents.size, 1);
  assert.equal(a.vault.text("n.md"), "draft to keep");
  // Status, inspect and previews are read-only.
  await a.session.inspect();
  await a.session.previewEnrollment();
  assert.equal(calls(), before);
});

test("R2-F: enrollment previews a pending intent, cancels it only on confirmation, then asks again", async () => {
  const { a } = await refusedDeletion();
  const raw = JSON.parse(a.store.raw!);
  raw.pause = { reason: "history-rewritten", detail: "re-enroll" };
  raw.operation = null;
  a.store.raw = JSON.stringify(raw);
  const preview = await a.restart().previewEnrollment();
  assert.ok(preview.kind === "preview" && preview.items.some((item) => item.path === "n.md" && item.action === "native-pending"), JSON.stringify(preview));
  assert.equal(a.vault.intents.size, 1);
  const first = await a.session.enroll({ token: preview.token });
  assert.ok(first.kind === "stale", "cancelling may change the vault, so a fresh confirmation follows");
  assert.equal(a.vault.intents.size, 0);
  assert.equal(a.vault.text("n.md"), "draft to keep", "cancellation never installs the intent");
  assert.ok(first.kind === "stale" && !first.preview.items.some((item) => item.action === "native-pending"));
  assert.equal((await a.session.enroll({ token: first.kind === "stale" ? first.preview.token : "" })).kind, "enrolled");
});

test("oversize evidence is a metadata-only hold, acknowledged only after a durable decision, while other paths progress", async () => {
  const { repository, a, b } = await tornSetup();
  const expected = await entryFromText(lines(10));
  a.vault.issues.push({ id: "big-1", path: "n.md", kind: "oversize", sourcePath: ".git-vault-sync/A/hold/x", size: 9_000_000, mtime: 5, expected, next: null });
  await b.vault.write("other.md", "o from B");
  await b.session.sync();
  const outcome = await a.session.sync();
  assert.equal(outcome.kind, "needs-decision", JSON.stringify(outcome));
  const conflict = outcome.kind === "needs-decision" ? outcome.conflicts.find((item) => item.kind === "oversize-write") : undefined;
  assert.ok(conflict && conflict.kind === "oversize-write", JSON.stringify(outcome));
  assert.equal(conflict.found, null);
  assert.deepEqual(conflict.oversize, [{ id: "big-1", sourcePath: ".git-vault-sync/A/hold/x", size: 9_000_000, mtime: 5 }]);
  assert.deepEqual(conflict.choices, ["mine", "expected", "next", "remote", "edit"]);
  assert.equal((await a.session.resolve({ conflictId: conflict.id, choice: { kind: "found" } })).kind, "invalid");
  assert.equal(a.vault.text("other.md"), "o from B", "unrelated paths progress");
  assert.equal(a.vault.text("n.md"), lines(10), "the held path is untouched");
  assert.ok(!(a.vault.acknowledged as string[]).includes("big-1"), "never acknowledged before a decision");
  // Restarts re-report the same id without duplicating the hold or changing its identity.
  const again = await a.restart().sync();
  assert.ok(again.kind === "needs-decision" && again.conflicts.some((item) => item.id === conflict.id));
  await a.session.resolve({ conflictId: conflict.id, choice: { kind: "remote" } });
  const settled = await a.session.sync();
  assert.ok(settled.kind === "synced", JSON.stringify(settled));
  assert.ok((a.vault.acknowledged as string[]).includes("big-1"));
  assert.equal(a.vault.text("n.md"), lines(10, { 1: "B one" }));
  assert.deepEqual(Object.keys((await parseState(await a.store.load())).holds), []);
  await assertConverged(repository, a, b);
});

test("an unreadable visible file is never deleted, published or overwritten, and is compared once readable", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "big.md": "base", "other.md": "o" }));
  const a = await enrolled(repository, "A");
  const b = await enrolled(repository, "B");
  await a.vault.write("big.md", "local edit while huge");
  a.vault.unreadable.add("big.md");
  await b.vault.write("big.md", "remote edit");
  await b.vault.write("other.md", "o from B");
  await b.session.sync();
  const outcome = await a.session.sync();
  assert.ok(outcome.kind === "synced" && !outcome.published, JSON.stringify(outcome));
  assert.equal(a.vault.text("other.md"), "o from B");
  assert.equal(a.vault.text("big.md"), "local edit while huge", "never written");
  assert.equal(entryText(repository.headFiles()["big.md"]!), "remote edit", "never deleted or replaced remotely");
  const status = await a.session.inspect();
  assert.ok(status.kind === "enrolled" && status.unreadable?.[0]?.path === "big.md", JSON.stringify(status));
  assert.equal((await a.restart().sync()).kind, "up-to-date");
  // Readable again: both sides changed from the preserved origin, so it is a reviewed conflict.
  a.vault.unreadable.clear();
  const conflict = conflictsOf(await a.session.sync())[0]!;
  assert.equal(conflict.path, "big.md");
  assert.equal(entryText(conflict.base!), "base");
});
