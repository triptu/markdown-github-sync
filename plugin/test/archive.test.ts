import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { ArchiveError, selectArchiveFiles } from "../src/git-sync/archive";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
function rename(zip: Uint8Array, from: string, to: string): Uint8Array {
  const source = Buffer.from(zip), a = Buffer.from(from), b = Buffer.from(to);
  assert.equal(a.length, b.length);
  for (let i = source.indexOf(a); i >= 0; i = source.indexOf(a, i + 1)) b.copy(source, i);
  return new Uint8Array(source);
}

test("selects only wanted paths from a compressed archive below its single root", () => {
  const big = text("x".repeat(100_000));
  const zip = zipSync({ "owner-repo-abc/": {}, "owner-repo-abc/notes/a.md": text("alpha"), "owner-repo-abc/notes/big.md": big, "owner-repo-abc/skip.md": text("skip") }, { level: 9 });
  assert.ok(zip.length < 2000, "deflated");
  const files = selectArchiveFiles(zip, new Map([["notes/a.md", 5], ["notes/big.md", 100_000], ["absent.md", 1]]));
  assert.deepEqual([...files.keys()].sort(), ["notes/a.md", "notes/big.md"]);
  assert.deepEqual(files.get("notes/big.md"), big);
});
test("a declared size other than the wanted size is never inflated", () => {
  const zip = zipSync({ "r/a.md": text("x".repeat(1_000_000)) });
  assert.equal(selectArchiveFiles(zip, new Map([["a.md", 10]])).size, 0);
});
/** Rewrites one central directory field (byte offset within the header) of the entry named `name`. */
function patchCentral(zip: Uint8Array, name: string, offset: number, width: 2 | 4, value: number): Uint8Array {
  const bytes = Buffer.from(zip);
  for (let i = bytes.indexOf("PK\x01\x02", 0, "latin1"); i >= 0; i = bytes.indexOf("PK\x01\x02", i + 1, "latin1")) {
    if (bytes.toString("utf8", i + 46, i + 46 + bytes.readUInt16LE(i + 28)) !== name) continue;
    if (width === 2) bytes.writeUInt16LE(value, i + offset); else bytes.writeUInt32LE(value, i + offset);
    return new Uint8Array(bytes);
  }
  throw new Error(`no central entry ${name}`);
}
test("a stored entry whose compressed size disagrees, or an unsupported method, is skipped rather than copied", () => {
  const zip = zipSync({ "r/a.md": text("alpha"), "r/pad.bin": new Uint8Array(200_000).fill(7) }, { level: 0 });
  assert.equal(selectArchiveFiles(zip, new Map([["a.md", 5]])).get("a.md")?.length, 5);
  const inflatedCopy = patchCentral(zip, "r/a.md", 20, 4, 150_000);
  assert.equal(selectArchiveFiles(inflatedCopy, new Map([["a.md", 5]])).size, 0);
  const bzip2 = patchCentral(zip, "r/a.md", 10, 2, 12);
  assert.equal(selectArchiveFiles(bzip2, new Map([["a.md", 5]])).size, 0);
});
test("entry names are matched exactly, so traversal spellings select nothing", () => {
  const zip = zipSync({ "r/x/../a.md": text("evil"), "r/./a.md": text("evil"), "r//a.md": text("evil") });
  assert.equal(selectArchiveFiles(zip, new Map([["a.md", 4]])).size, 0);
});
test("rejects duplicate wanted paths, entries outside the root, and truncated or garbage input", () => {
  const twins = rename(zipSync({ "r/a.md": text("one"), "r/b.md": text("two") }, { level: 0 }), "r/b.md", "r/a.md");
  assert.throws(() => selectArchiveFiles(twins, new Map([["a.md", 3]])), (error: Error) => error instanceof ArchiveError && /Duplicate/.test(error.message));
  assert.equal(selectArchiveFiles(twins, new Map([["c.md", 3]])).size, 0, "unwanted duplicates are irrelevant");
  assert.throws(() => selectArchiveFiles(zipSync({ "r/a.md": text("a"), "s/a.md": text("b") }), new Map([["a.md", 1]])), /outside its root/);
  const zip = zipSync({ "r/a.md": text("alpha".repeat(1000)) });
  for (const bad of [zip.subarray(0, zip.length - 30), zip.subarray(0, 40), text("not a zip"), new Uint8Array(0)])
    assert.throws(() => selectArchiveFiles(bad, new Map([["a.md", 5000]])), ArchiveError);
});
