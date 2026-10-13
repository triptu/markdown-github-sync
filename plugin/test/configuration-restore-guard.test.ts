import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFromText, entryText } from "../src/git-sync/codec";
import { SyncSession } from "../src/git-sync/session";
import { parseState } from "../src/git-sync/state";
import { Crash, MemoryRepository, MemoryStore, MemoryVault, snapshot } from "./git-fakes";

const PATH = ".obsidian/appearance.json";
const OLD = "old configuration";
const NEW = "new configuration";
const NOW = () => new Date("2026-10-13T12:00:00Z");

async function fixture(guarded: boolean) {
  const repository = await MemoryRepository.create(await snapshot({ "note.md": "note", [PATH]: OLD }));
  repository.scopeRules = "config/1";
  const historical = repository.branchHead;
  const vault = new MemoryVault(await snapshot({ "note.md": "note", [PATH]: OLD }));
  const store = new MemoryStore();
  const session = (hostLifetimeId: string) => new SyncSession({
    repository: repository.device("A"), vault, store, scopeRules: "config/1", hostLifetimeId, now: NOW, delay: async () => {},
  });
  const first = session("host-1");
  const enrollment = await first.previewEnrollment();
  assert.equal(enrollment.kind, "preview");
  if (enrollment.kind !== "preview") throw Error("Missing enrollment preview");
  assert.equal((await first.enroll({ token: enrollment.token })).kind, "enrolled");
  await first.sync();
  await repository.push({ [PATH]: await entryFromText(NEW) });
  await first.sync();
  if (guarded) {
    const preview = await first.previewApplyConfiguration();
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") throw Error("Missing configuration preview");
    assert.equal((await first.applyConfiguration({ token: preview.token })).kind, "applied");
    await first.sync();
  } else {
    await vault.write(PATH, NEW);
    await first.sync();
  }
  assert.equal(vault.text(PATH), NEW);
  assert.equal(entryText(repository.fullHeadFiles()[PATH]!), NEW);
  assert.equal(Boolean((await parseState(await store.load())).configurationGuards[PATH]), guarded);
  return { repository, historical, vault, store, session, first };
}

async function restore(session: SyncSession, historical: string, path = PATH) {
  const preview = await session.previewRestore({ path, commit: historical });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw Error("Missing restore preview");
  return session.restore(preview);
}

async function state(store: MemoryStore) { return parseState(await store.load()); }

function failRestoreRecordSave(store: MemoryStore) {
  const save = store.save.bind(store);
  store.save = async (value) => {
    const parsed = await parseState(value);
    if (parsed.operation?.kind === "restore") {
      store.save = save;
      store.fault = { at: store.saves + 1, when: "after" };
    }
    await save(value);
  };
}

async function assertStaleFlushHeld(data: Awaited<ReturnType<typeof fixture>>, session: SyncSession) {
  assert.equal(data.vault.text(PATH), OLD);
  assert.equal(entryText(data.repository.fullHeadFiles()[PATH]!), OLD);
  await data.vault.write(PATH, NEW);
  const outcome = await session.sync();
  assert.ok(outcome.kind === "synced" || outcome.kind === "up-to-date", JSON.stringify(outcome));
  assert.equal(entryText(data.repository.fullHeadFiles()[PATH]!), OLD);
  const listing = await session.listConfiguration();
  assert.ok(listing.kind === "configuration" && listing.guarded.some((item) => item.path === PATH));
}

for (const guarded of [true, false]) {
  test(`${guarded ? "existing" : "new"} guard: direct restore before first sync protects the writing host`, async () => {
    const data = await fixture(guarded);
    const second = data.session("host-2");
    assert.equal((await restore(second, data.historical)).kind, "restored");
    assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-2");
    await second.sync();
    await assertStaleFlushHeld(data, second);

    const preview = await second.previewGuardedConfigurationPublication(PATH);
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") throw Error("Missing guarded publication preview");
    assert.equal((await second.consentGuardedConfigurationPublication({ path: PATH, token: preview.token })).kind, "recorded");
    await second.sync();
    assert.equal(entryText(data.repository.fullHeadFiles()[PATH]!), NEW, "exact consent releases the held edit");
    await second.sync();
    const settled = (await state(data.store)).configurationGuards[PATH];
    assert.equal(settled?.consent, null);
    assert.equal(settled?.applied?.oid, (await entryFromText(NEW)).oid);
  });

  test(`${guarded ? "existing" : "new"} guard: restore record survives a crash before the write on a new host`, async () => {
    const data = await fixture(guarded);
    failRestoreRecordSave(data.store);
    await assert.rejects(restore(data.first, data.historical), Crash);
    data.store.fault = null;
    assert.equal(data.vault.text(PATH), NEW);
    assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-1");
    const second = data.session("host-2");
    await second.sync();
    assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-2");
    await assertStaleFlushHeld(data, second);
  });

  test(`${guarded ? "existing" : "new"} guard: native restore replay attributes the write to its new host`, async () => {
    const data = await fixture(guarded);
    data.vault.pendingNext = { path: PATH, mode: "refuse" };
    assert.equal((await restore(data.first, data.historical)).kind, "blocked");
    const applyCalls = data.vault.applyCalls;
    const second = data.session("host-2");
    await second.sync();
    assert.equal(data.vault.applyCalls, applyCalls, "native recovery installed the historical version");
    assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-2");
    await assertStaleFlushHeld(data, second);
  });
}

test("an already installed restore is observed at startup and may retire its old-host guard", async () => {
  const data = await fixture(true);
  data.vault.pendingNext = { path: PATH, mode: "crash" };
  await assert.rejects(restore(data.first, data.historical), Crash);
  assert.equal(data.vault.text(PATH), OLD);
  const second = data.session("host-2");
  await second.sync();
  assert.equal((await state(data.store)).configurationGuards[PATH], undefined);
  await data.vault.write(PATH, "later genuine edit");
  await second.sync();
  assert.equal(entryText(data.repository.fullHeadFiles()[PATH]!), "later genuine edit");
});

test("a lost native response followed by a quit-time flush reattributes the replayed restore", async () => {
  const data = await fixture(true);
  data.vault.pendingNext = { path: PATH, mode: "crash" };
  await assert.rejects(restore(data.first, data.historical), Crash);
  assert.equal(data.vault.text(PATH), OLD, "the first host landed the restore before losing the response");
  await data.vault.write(PATH, NEW); // Its editor flushes the old in-memory value at quit.
  const second = data.session("host-2");
  await second.sync();
  assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-2");
  await assertStaleFlushHeld(data, second);
});

test("an unguarded restore with a lost write response retains its durable guard", async () => {
  const data = await fixture(false);
  data.vault.pendingNext = { path: PATH, mode: "crash" };
  await assert.rejects(restore(data.first, data.historical), Crash);
  assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-1");
  await data.first.sync();
  await assertStaleFlushHeld(data, data.first);
});

test("native replay guards a missing visible path before restoring from its hold", async () => {
  const data = await fixture(false);
  data.vault.pendingNext = { path: PATH, mode: "refuse" };
  assert.equal((await restore(data.first, data.historical)).kind, "blocked");
  const intent = data.vault.intents.get(PATH);
  assert.ok(intent?.next);
  intent.attempted = true;
  data.vault.files.delete(PATH); // Native path → hold left only the hidden preimage.
  const nativeRecover = data.vault.recover.bind(data.vault);
  data.vault.recover = async (authorization) => {
    assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-2");
    assert.equal(data.vault.files.has(PATH), false);
    data.vault.files.set(PATH, intent.next!);
    data.vault.intents.delete(PATH);
    return [];
  };
  const second = data.session("host-2");
  await second.sync();
  data.vault.recover = nativeRecover;
  await assertStaleFlushHeld(data, second);
});

test("unknown pre-replay bytes retain the guard when native recovery installs the restore", async () => {
  const data = await fixture(true);
  data.vault.pendingNext = { path: PATH, mode: "refuse" };
  assert.equal((await restore(data.first, data.historical)).kind, "blocked");
  data.vault.unreadable.add(PATH);
  const nativeRecover = data.vault.recover.bind(data.vault);
  data.vault.recover = async (authorization) => {
    assert.equal((await state(data.store)).configurationGuards[PATH]?.hostLifetimeId, "host-2");
    data.vault.unreadable.delete(PATH);
    return nativeRecover(authorization);
  };
  const second = data.session("host-2");
  await second.sync();
  await assertStaleFlushHeld(data, second);
});

test("note history restore stays an ordinary reviewed draft without a configuration guard", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "note.md": "old note" }));
  const historical = repository.branchHead;
  await repository.push({ "note.md": await entryFromText("new note") });
  const vault = new MemoryVault(await snapshot({ "note.md": "new note" }));
  const store = new MemoryStore();
  const session = new SyncSession({ repository: repository.device("A"), vault, store, hostLifetimeId: "host-1", now: NOW, delay: async () => {} });
  const enrollment = await session.previewEnrollment();
  assert.equal(enrollment.kind, "preview");
  if (enrollment.kind !== "preview") throw Error("Missing enrollment preview");
  assert.equal((await session.enroll({ token: enrollment.token })).kind, "enrolled");
  await session.sync();
  assert.equal((await restore(session, historical, "note.md")).kind, "restored");
  assert.deepEqual(Object.keys((await state(store)).configurationGuards), []);
  await session.sync();
  assert.equal(entryText(repository.fullHeadFiles()["note.md"]!), "old note");
});
