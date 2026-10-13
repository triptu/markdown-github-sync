import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTransactionJournal } from "../src/git-sync/native-transactions";
import { entryFromBytes } from "../src/git-sync/codec";
import type { JournalFiles } from "../src/git-sync/store";
const installation = "12345678-1234-1234-1234-123456789abc";
async function filesystem() {
  const root = await mkdtemp(join(tmpdir(), "native-txn-fs-"));
  let loseAck = false;
  const absolute = (path: string) => join(root, path);
  const files: JournalFiles = {
    exists: async path => { try { await access(absolute(path)); return true; } catch { return false; } },
    mkdir: async path => { await mkdir(absolute(path), { recursive: true }); },
    read: path => readFile(absolute(path), "utf8"),
    write: (path, data) => writeFile(absolute(path), data),
    rename: async (from, to) => {
      if (await files.exists(to)) throw new Error("no-clobber");
      await rename(absolute(from), absolute(to));
      if (loseAck && to.includes("/native/records/")) { loseAck = false; throw new Error("lost acknowledgment"); }
    },
    list: async path => {
      const rows = await readdir(absolute(path), { withFileTypes: true });
      return { files: rows.filter(row => row.isFile()).map(row => `${path}/${row.name}`),
        folders: rows.filter(row => row.isDirectory()).map(row => `${path}/${row.name}`) };
    },
  };
  return { files, root, loseNextRecordAck: () => { loseAck = true; }, close: () => rm(root, { recursive: true, force: true }) };
}
test("real filesystem journal reopens a committed intent after lost acknowledgment", async () => {
  const fs = await filesystem();
  try {
    const journal = await NativeTransactionJournal.open(fs.files, installation);
    const expected = await entryFromBytes(new Uint8Array([0, 255, 1]));
    const next = await entryFromBytes(new Uint8Array([2, 254, 3]));
    fs.loseNextRecordAck();
    await assert.rejects(journal.begin("image.png", expected, next, "rename"), /lost acknowledgment/);
    assert.throws(() => journal.pending(), /persistence is uncertain/);
    const reopened = await NativeTransactionJournal.open(fs.files, installation);
    const [intent] = reopened.pending();
    assert.equal(intent.path, "image.png");
    assert.equal(intent.expected, expected.oid);
    assert.equal(intent.next, next.oid);
    await reopened.finish("image.png");
    assert.equal((await NativeTransactionJournal.open(fs.files, installation)).pending().length, 0);
  } finally { await fs.close(); }
});
test("real filesystem recovery evidence survives restart with exact bytes", async () => {
  const fs = await filesystem();
  try {
    const journal = await NativeTransactionJournal.open(fs.files, installation);
    const original = new Uint8Array([0, 255, 128, 13]);
    const record = await journal.retainBytes(original, "image.png", "hidden/hold", "displaced", null, null);
    const reopened = await NativeTransactionJournal.open(fs.files, installation);
    const first = reopened.recoveries()[0];
    if (first.kind === "oversize") throw new Error("Expected byte evidence");
    assert.equal(first.kind, "displaced");
    assert.deepEqual(await reopened.readEvidence(first), original);
    await reopened.acknowledge([record.id]);
    assert.deepEqual(reopened.issues(), []);
  } finally { await fs.close(); }
});
test("duplicate native record sequence is rejected on open", async () => {
  const fs = await filesystem();
  try {
    const journal = await NativeTransactionJournal.open(fs.files, installation);
    const before = await entryFromBytes(new Uint8Array([1]));
    const after = await entryFromBytes(new Uint8Array([2]));
    await journal.begin("n.md", before, after, "text-process");
    await journal.finish("n.md");
    const records = (await fs.files.list(`${journal.root}/native/records`)).files;
    const first = records.find(path => /000000000001-[a-f0-9]{64}\.json$/.test(path));
    assert.ok(first);
    const duplicate = first.replace(/-[a-f0-9]{64}\.json$/, `-${"f".repeat(64)}.json`);
    await fs.files.write(duplicate, "{}");
    await assert.rejects(NativeTransactionJournal.open(fs.files, installation), /Multiple journal writers/);
  } finally { await fs.close(); }
});
