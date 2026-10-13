import { test } from "node:test";
import assert from "node:assert/strict";
import { FileJournalStore, type JournalFiles } from "../src/git-sync/store";
const identity = "12345678-1234-1234-1234-123456789abc";

test("parallel object verification remains bounded and detects later corruption", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity);
  const state = { blobs: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`oid-${i}`, btoa(`content-${i}`)])) };
  await store.save(state);
  const read = files.read.bind(files);
  let active = 0, peak = 0, reads = 0;
  files.read = async path => {
    if (!path.includes("/objects/")) return read(path);
    active++; reads++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); return await read(path); }
    finally { active--; }
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await store.load())), state);
  assert.equal(reads, 12); assert.equal(peak, 4);
  reads = 0;
  await store.save({ ...state, revision: 1 });
  assert.equal(reads, 12); assert.equal(active, 0);
  const path = [...files.values.keys()].find(path => path.includes("/objects/"));
  assert.ok(path); files.values.set(path, "corrupt");
  await assert.rejects(store.load(), /checksum/);
  await assert.rejects(store.save(state), /corrupt/);
  assert.equal(active, 0);
});

test("failed parallel object writes drain before a queued save starts", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity);
  await store.save({ phase: "baseline" });
  const rename = files.rename.bind(files);
  let active = 0, peak = 0, calls = 0;
  files.rename = async (from, to) => {
    if (!to.includes("/objects/")) { assert.equal(active, 0); return rename(from, to); }
    const fail = calls++ === 0;
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, fail ? 1 : 10));
      if (fail) throw undefined;
      return await rename(from, to);
    } finally { active--; }
  };
  const state = { blobs: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`oid-${i}`, btoa(`new-${i}`)])) };
  const rejected = store.save(state).then(
    () => assert.fail("Expected the object write to fail"),
    error => assert.equal(error, undefined),
  );
  const next = store.save({ phase: "next" });
  await rejected; assert.equal(active, 0);
  await next; assert.ok(peak > 1 && peak <= 4);
  assert.deepEqual(JSON.parse(JSON.stringify(await store.load())), { phase: "next" });
});

test("parallel failures prefer an Error and drain started writes before the queued save", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity);
  await store.save({ phase: "baseline" });
  const rename = files.rename.bind(files);
  let active = 0, started = 0, release = () => {};
  const allStarted = new Promise<void>(resolve => { release = resolve; });
  files.rename = async (from, to) => {
    if (!to.includes("/objects/")) { assert.equal(active, 0); return rename(from, to); }
    const index = started++;
    active++;
    if (started === 4) release();
    try {
      await allStarted;
      if (index === 0) throw undefined;
      if (index === 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
        throw new Error("ENOSPC");
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      return await rename(from, to);
    } finally { active--; }
  };
  const state = { blobs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`oid-${i}`, btoa(`body-${i}`)])) };
  const failed = assert.rejects(store.save(state), /ENOSPC/);
  const queued = store.save({ phase: "after failure" });
  await failed;
  assert.equal(started, 4);
  assert.equal(active, 0);
  await queued;
  assert.deepEqual(plain(await store.load()), { phase: "after failure" });
});

test("duplicate blob bodies cannot race commits to the same immutable object", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity);
  const rename = files.rename.bind(files);
  let objectCommits = 0;
  files.rename = async (from, to) => {
    if (to.includes("/objects/")) {
      objectCommits++; assert.equal(files.values.has(to), false);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    return rename(from, to);
  };
  const state = { blobs: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`oid-${i}`, btoa("same bytes")])) };
  await store.save(state); assert.equal(objectCommits, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await store.load())), state);
});

function nativeRecord(references: number, unique: number, revision: number) {
  type Entry = { oid: string; mode: string; data: string };
  const tracked: Record<string, { expected: Entry | null; next: Entry | null }> = Object.create(null);
  for (let i = 0; i < 12; i++) tracked[`hold-${i}`] = { expected: null, next: null };
  for (let i = 0; i < references; i++) {
    const body = i % unique + (revision === 3 ? 2 : 0);
    const entry = { oid: `oid-${body}`, mode: "100644", data: btoa(`native-body-${body}`) };
    const item = tracked[`hold-${Math.floor(i / 2)}`];
    if (i % 2 === 0) item.expected = entry;
    else item.next = entry;
  }
  return {
    format: 3, policy: { rules: "config/1", configDir: ".obsidian" }, intents: {}, tracked,
    recoveries: [], acknowledgedOversize: [],
    supersededRecoveryIds: Array.from({ length: revision + 1 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`),
  };
}

test("native Entry.data verifies 64 unique objects across 160 retained references", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity, "native");
  const shapes = [[19, 7], [19, 7], [20, 8], [20, 8], [19, 7], [21, 9], [21, 9], [21, 9]];
  assert.equal(shapes.reduce((total, [references]) => total + references, 0), 160);
  assert.equal(shapes.reduce((total, [, unique]) => total + unique, 0), 64);
  for (const [revision, [references, unique]] of shapes.entries())
    await store.save(nativeRecord(references, unique, revision));
  const read = files.read.bind(files), exists = files.exists.bind(files);
  let objectReads = 0, objectExists = 0, active = 0, peak = 0;
  files.read = async path => {
    if (!path.includes("/objects/")) return read(path);
    objectReads++; active++; peak = Math.max(peak, active);
    try { return await read(path); } finally { active--; }
  };
  files.exists = async path => {
    if (path.includes("/objects/")) objectExists++;
    return exists(path);
  };
  await store.compact();
  assert.equal(objectReads, 64);
  assert.equal(peak, 1);
  objectReads = 0;
  const latest = nativeRecord(21, 9, 7);
  assert.deepEqual(plain(await store.load()), plain(latest));
  assert.equal(objectReads, 9);
  objectReads = 0;
  assert.deepEqual(plain(await store.load()), plain(latest));
  assert.equal(objectReads, 9);
  objectReads = 0; objectExists = 0;
  await store.save({ ...latest, supersededRecoveryIds: [...latest.supersededRecoveryIds, crypto.randomUUID()] });
  assert.equal(objectExists, 9);
  assert.equal(objectReads, 9);
  assert.equal(peak, 1);
  assert.equal(active, 0);
  const object = [...files.values.keys()].find(path => path.includes("/native/objects/"));
  assert.ok(object);
  files.values.set(object, "corrupt");
  await assert.rejects(store.load(), /checksum/);
  const recordCount = [...files.values.keys()].filter(path => path.includes("/native/records/") && path.endsWith(".json")).length;
  await assert.rejects(store.save(latest), /corrupt/);
  assert.equal([...files.values.keys()].filter(path => path.includes("/native/records/") && path.endsWith(".json")).length, recordCount);
});

test("native compaction rechecks a shared object in every retained record before deleting", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity, "native");
  const shared = { oid: "same", mode: "100644", data: btoa("retained native evidence") };
  for (let sequence = 0; sequence < 9; sequence++)
    await store.save({ sequence, tracked: { hold: { expected: shared, next: shared } } });
  const object = [...files.values.keys()].find(path => path.includes("/native/objects/"));
  assert.ok(object);
  const before = files.values.size, read = files.read.bind(files), remove = files.remove.bind(files);
  let recordReads = 0, objectReads = 0, removals = 0;
  files.read = async path => {
    if (path.includes("/native/records/") && path.endsWith(".json")) {
      if (++recordReads === 2) files.values.set(object, "corrupt");
    }
    if (path.includes("/native/objects/")) objectReads++;
    return read(path);
  };
  files.remove = async path => { removals++; return remove(path); };
  await assert.rejects(store.compact(), /checksum/);
  assert.equal(recordReads, 2);
  assert.equal(objectReads, 2);
  assert.equal(removals, 0);
  assert.equal(files.values.size, before);
});
class Files implements JournalFiles {
  values = new Map<string, string>();
  folders = new Set<string>();
  count = 0;
  failAt = Infinity;
  private tick() {
    if (++this.count === this.failAt) throw new Error("Simulated interruption");
  }
  async exists(path: string) {
    this.tick();
    return this.values.has(path) || this.folders.has(path);
  }
  async mkdir(path: string) {
    this.tick();
    this.folders.add(path);
  }
  async read(path: string) {
    this.tick();
    const value = this.values.get(path);
    if (value === undefined) throw new Error("Missing file");
    return value;
  }
  async write(path: string, value: string) {
    this.tick();
    this.values.set(path, value);
  }
  async rename(from: string, to: string) {
    this.tick();
    const value = this.values.get(from);
    if (value === undefined) throw new Error("Missing source");
    this.values.set(to, value);
    this.values.delete(from);
  }
  async remove(path: string) { this.tick(); this.values.delete(path); }
  async list(path: string) {
    this.tick();
    return {
      files: [...this.values.keys()].filter(
        (key) =>
          key.startsWith(path + "/") &&
          !key.slice(path.length + 1).includes("/"),
      ),
      folders: [],
    };
  }
}
const original = {
  phase: "ready",
  files: {
    "a.md": { oid: "abc", data: btoa("Original note"), mode: "100644" },
  },
};
const updated = {
  phase: "publishing",
  files: { "a.md": { oid: "def", data: btoa("New edit"), mode: "100644" } },
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
test("journal restores exact state and deduplicates immutable content", async () => {
  const files = new Files();
  const store = new FileJournalStore(files, identity);
  await store.save(original);
  const size = files.values.size;
  await store.save(original);
  assert.equal(files.values.size, size);
  assert.deepEqual(
    plain(await new FileJournalStore(files, identity).load()),
    original,
  );
  await store.save(updated);
  assert.deepEqual(
    plain(await new FileJournalStore(files, identity).load()),
    updated,
  );
  assert.ok([...files.values.values()].includes(btoa("Original note")));
});
test("each interrupted persistence boundary recovers a complete prior or new record", async () => {
  let failures = 0;
  const probeFiles = new Files(), probe = new FileJournalStore(probeFiles, identity);
  await probe.save(original);
  probeFiles.count = 0;
  await probe.save(updated);
  const boundaries = probeFiles.count;
  for (let position = 1; position <= boundaries + 1; position++) {
    const files = new Files();
    const store = new FileJournalStore(files, identity);
    await store.save(original);
    files.count = 0;
    files.failAt = position;
    try {
      await store.save(updated);
    } catch {
      failures++;
    }
    files.failAt = Infinity;
    const recovered = plain(await new FileJournalStore(files, identity).load());
    assert.ok(
      JSON.stringify(recovered) === JSON.stringify(original) ||
        JSON.stringify(recovered) === JSON.stringify(updated),
      `boundary ${position}`,
    );
  }
  assert.ok(failures >= 8);
});
test("each parallel blob persistence boundary recovers a complete prior or new record", async () => {
  const original = { ...updated, blobs: { shared: btoa("New edit") } };
  const updatedWithBlobs = {
    ...updated,
    phase: "parallel-save",
    blobs: Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
      [`oid-${i}`, btoa(i < 2 ? "New edit" : `parallel body ${i}`)])),
  };
  let failures = 0;
  const probeFiles = new Files(), probe = new FileJournalStore(probeFiles, identity);
  await probe.save(original);
  probeFiles.count = 0;
  await probe.save(updatedWithBlobs);
  const boundaries = probeFiles.count;
  for (let position = 1; position <= boundaries + 1; position++) {
    const files = new Files();
    const store = new FileJournalStore(files, identity);
    await store.save(original);
    files.count = 0;
    files.failAt = position;
    try {
      await store.save(updatedWithBlobs);
    } catch {
      failures++;
    }
    files.failAt = Infinity;
    const recovered = plain(await new FileJournalStore(files, identity).load());
    assert.ok(
      JSON.stringify(recovered) === JSON.stringify(original) ||
        JSON.stringify(recovered) === JSON.stringify(updatedWithBlobs),
      `boundary ${position}`,
    );
  }
  assert.ok(failures >= 8);
});
test("corrupt latest record blocks instead of rolling baseline backwards", async () => {
  const files = new Files();
  const store = new FileJournalStore(files, identity);
  await store.save(original);
  await store.save(updated);
  const latest = [...files.values.keys()]
    .filter((path) => path.includes("/records/"))
    .sort()
    .at(-1);
  assert.ok(latest);
  files.values.set(latest, "{}");
  await assert.rejects(new FileJournalStore(files, identity).load(), /corrupt/);
});
test("corrupt recovery bytes block load and cannot be overwritten by a fresh save", async () => {
  const files = new Files();
  const store = new FileJournalStore(files, identity);
  await store.save(original);
  const blob = [...files.values.keys()].find((path) =>
    path.includes("/objects/"),
  );
  assert.ok(blob);
  files.values.set(blob, "broken");
  await assert.rejects(
    new FileJournalStore(files, identity).load(),
    /checksum/,
  );
  await assert.rejects(store.save(original), /corrupt/);
});
test("an acknowledged empty record-temp write fails closed before rename", async () => {
  const files = new Files(), store = new FileJournalStore(files, identity);
  await store.save(original);
  const write = files.write.bind(files);
  let injected = false;
  files.write = async (path, text) => {
    if (!injected && path.includes("/records/") && path.endsWith(".tmp")) {
      injected = true;
      return write(path, "");
    }
    return write(path, text);
  };
  await assert.rejects(store.save(updated), /Recovery write verification failed/);
  assert.equal(injected, true);
  assert.deepEqual(plain(await new FileJournalStore(files, identity).load()), original);
  assert.equal([...files.values.keys()].filter(path => path.includes("/records/") && path.endsWith(".json")).length, 1);
  assert.equal([...files.values.entries()].filter(([path, value]) =>
    path.includes("/records/") && path.endsWith(".tmp") && value === "").length, 1);
});
test("another installation cannot inherit the checkpoint", async () => {
  const files = new Files();
  await new FileJournalStore(files, identity).save(original);
  assert.equal(
    await new FileJournalStore(
      files,
      "aaaaaaaa-1234-1234-1234-123456789abc",
    ).load(),
    null,
  );
});

test("stale writers cannot append, including an unchanged stale checkpoint", async () => {
  const files = new Files();
  const a = new FileJournalStore(files, identity), b = new FileJournalStore(files, identity);
  await a.save(original);
  await b.load();
  await a.save(updated);
  const count = files.values.size;
  await assert.rejects(b.save(original), /Stale journal writer/);
  await assert.rejects(b.save({ phase: "other-writer" }), /Stale journal writer/);
  assert.equal(files.values.size, count);
  assert.deepEqual(plain(await new FileJournalStore(files, identity).load()), updated);
});

test("concurrent appends share a lock and reject one stale writer", async () => {
  const files = new Files();
  const a = new FileJournalStore(files, identity), b = new FileJournalStore(files, identity);
  await a.save(original);
  await b.load();
  const results = await Promise.allSettled([a.save(updated), b.save({ phase: "other" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.match(String(rejected.reason), /Stale journal writer/);
  assert.deepEqual(plain(await new FileJournalStore(files, identity).load()), updated);
});

test("an older fork remains fatal after newer checkpoints, for load and save", async () => {
  const files = new Files();
  const a = new FileJournalStore(files, identity);
  await a.save(original);
  await a.save(updated);
  await a.save({ phase: "complete" });
  const first = [...files.values.keys()].find(path => path.includes("/records/000000000001-"));
  assert.ok(first);
  const fork = first.replace(/-[a-f0-9]{64}\.json$/, `-${"f".repeat(64)}.json`);
  files.values.set(fork, "{}");
  await assert.rejects(new FileJournalStore(files, identity).load(), /Multiple journal writers/);
  await assert.rejects(a.save({ phase: "later" }), /Multiple journal writers/);
  await assert.rejects(a.save({ phase: "complete" }), /Multiple journal writers/);
});

async function cleanupFixture() {
  const files = new Files(), store = new FileJournalStore(files, identity);
  for (let sequence = 0; sequence < 12; sequence++) await store.save({ sequence, draft: { oid: "local", data: btoa("unpublished draft") }, file: { oid: String(sequence), data: btoa(`version ${sequence}`) } });
  return { files, store };
}
test("cleanup retains recent records and every referenced unpublished byte", async () => {
  const {files, store} = await cleanupFixture();
  const result = await store.compact();
  assert.deepEqual(result, {recordsRemoved: 4, objectsRemoved: 4, temporaryFilesRemoved: 0});
  assert.equal([...files.values.keys()].filter(path => path.includes("/records/")).length, 8);
  assert.deepEqual(plain(await new FileJournalStore(files, identity).load()), {sequence: 11, draft: {oid: "local", data: btoa("unpublished draft")}, file: {oid: "11", data: btoa("version 11")}});
  assert.deepEqual(await store.compact(), {recordsRemoved: 0, objectsRemoved: 0, temporaryFilesRemoved: 0});
});
test("every interrupted cleanup boundary preserves the latest state and resumes", async () => {
  const sample = await cleanupFixture(); sample.files.count = 0; await sample.store.compact(); const boundaries = sample.files.count;
  for (let at = 1; at <= boundaries; at++) {
    const {files, store} = await cleanupFixture(); const expected = plain(await store.load());
    files.count = 0; files.failAt = at;
    await assert.rejects(store.compact(), /Simulated interruption/);
    files.failAt = Infinity;
    const reopened = new FileJournalStore(files, identity);
    assert.deepEqual(plain(await reopened.load()), expected, `boundary ${at}`);
    await reopened.compact();
    assert.deepEqual(plain(await reopened.load()), expected);
  }
});
test("cleanup refuses stale writers and corrupt retained data before deleting anything", async () => {
  const {files, store} = await cleanupFixture(); const stale = new FileJournalStore(files, identity); await stale.load();
  await store.save(updated); const count = files.values.size;
  await assert.rejects(stale.compact(), /Stale journal writer/); assert.equal(files.values.size, count);
  const latest = [...files.values.keys()].filter(path => path.includes("/records/")).sort().at(-1)!;
  files.values.set(latest, "{}");
  await assert.rejects(store.compact(), /checksum/); assert.equal(files.values.size, count);
});

test("cleanup removes interrupted-write temporary files only within its own namespace", async () => {
  const { files, store } = await cleanupFixture();
  const suffix = ".12345678-1234-1234-1234-123456789abc.tmp";
  const object = `${store.directory}/objects/${"a".repeat(64)}.json${suffix}`;
  const record = `${store.directory}/records/000000000013-${"b".repeat(64)}.json${suffix}`;
  const preserved = [`${store.directory}/records/user.tmp`, `${store.directory}/hold/${"a".repeat(64)}.json${suffix}`, `${store.directory}/modes/objects/${"a".repeat(64)}.json${suffix}`];
  for (const path of [object, record, ...preserved]) files.values.set(path, "partial");
  const result = await store.compact();
  assert.equal(result.temporaryFilesRemoved, 2);
  assert.equal(files.values.has(object), false); assert.equal(files.values.has(record), false);
  for (const path of preserved) assert.equal(files.values.has(path), true);
  assert.equal(plain(await new FileJournalStore(files, identity).load()).sequence, 11);
});

test("cleanup after every failed append keeps the last committed state and removes its temporary debris", async () => {
  const sample = new Files(), probe = new FileJournalStore(sample, identity);
  await probe.save(original); sample.count = 0; await probe.save(updated);
  for (let at = 1; at <= sample.count; at++) {
    const files = new Files(), store = new FileJournalStore(files, identity);
    await store.save(original); files.count = 0; files.failAt = at;
    try { await store.save(updated); } catch { /* Every storage boundary is interrupted in turn. */ }
    files.failAt = Infinity;
    const reopened = new FileJournalStore(files, identity), committed = plain(await reopened.load());
    await reopened.compact();
    assert.deepEqual(plain(await new FileJournalStore(files, identity).load()), committed);
    assert.equal([...files.values.keys()].some(path => path.endsWith(".tmp")), false, `boundary ${at}`);
  }
});
