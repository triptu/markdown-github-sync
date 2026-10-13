import { test } from "node:test";
import assert from "node:assert/strict";
import { readLocalCandidate } from "../src/git-sync/local-candidate";

test("local download hints preflight file size and never write", async () => {
  let reads = 0;
  const files = { stat: async () => ({ type: "file", size: 3 }), readBinary: async () => { reads++; return new Uint8Array([1, 2, 3]).buffer; } };
  assert.deepEqual(await readLocalCandidate(files, "note.md", 3), new Uint8Array([1, 2, 3]));
  assert.equal(await readLocalCandidate(files, "note.md", 4), null);
  assert.equal(await readLocalCandidate(files, "note.md", 9 * 1024 * 1024), null);
  assert.equal(reads, 1);
});

test("missing files, folders, read failures and racing size changes fall back to GitHub", async () => {
  const readBinary = async () => new Uint8Array([1, 2]).buffer;
  assert.equal(await readLocalCandidate({ stat: async () => null, readBinary }, "gone", 3), null);
  assert.equal(await readLocalCandidate({ stat: async () => ({ type: "folder", size: 3 }), readBinary }, "folder", 3), null);
  const stat = async () => ({ type: "file", size: 3 });
  assert.equal(await readLocalCandidate({ stat, readBinary }, "changed", 3), null);
  assert.equal(await readLocalCandidate({ stat, readBinary: async () => { throw Error("unreadable"); } }, "locked", 3), null);
});
