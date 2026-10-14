import { test } from "node:test";
import assert from "node:assert/strict";
import { combinedDraft, diffRows } from "../src/conflict-view";
import { entryFromBytes, entryFromText } from "../src/git-sync/codec";

test("shows each side's lines and collapses long unchanged runs", () => {
  const common = Array.from({ length: 10 }, (_, at) => `line ${at}\n`).join("");
  const rows = diffRows(`${common}mine\n`, `${common}theirs\n`)!;
  assert.deepEqual(rows, [
    { kind: "skip", count: 8 },
    { kind: "same", text: "line 8\n" },
    { kind: "same", text: "line 9\n" },
    { kind: "mine", text: "mine\n" },
    { kind: "theirs", text: "theirs\n" },
  ]);
});

test("keeps short unchanged runs between changes", () => {
  const rows = diffRows("a\nx\nb\nc\nd\n", "a\ny\nb\nc\nd\n")!;
  assert.deepEqual(rows.map(row => row.kind), ["same", "mine", "theirs", "same", "same", "same"]);
});

test("combinedDraft keeps unchanged lines once and both sides of each change, this device first", async () => {
  const draft = combinedDraft(await entryFromText("a\nmine\nc\nadded here\n"), await entryFromText("a\ntheirs\nc\n"));
  assert.equal(draft, "a\nmine\ntheirs\nc\nadded here\n");
  // A line only on GitHub stays; identical texts come back unchanged.
  assert.equal(combinedDraft(await entryFromText("a\nc\n"), await entryFromText("a\nb\nc\n")), "a\nb\nc\n");
  assert.equal(combinedDraft(await entryFromText("same\n"), await entryFromText("same\n")), "same\n");
});

test("combinedDraft keeps last lines without a newline from running together", async () => {
  assert.equal(combinedDraft(await entryFromText("a\nmine"), await entryFromText("a\ntheirs")), "a\nmine\ntheirs");
});

test("combinedDraft is null when either side is deleted or not text", async () => {
  const text = await entryFromText("a\n");
  const binary = await entryFromBytes(new Uint8Array([0xff, 0xfe, 0x00]));
  assert.equal(combinedDraft(null, text), null);
  assert.equal(combinedDraft(text, null), null);
  assert.equal(combinedDraft(binary, text), null);
});
