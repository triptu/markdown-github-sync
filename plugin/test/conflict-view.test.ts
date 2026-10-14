import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows } from "../src/conflict-view";

test("shows each side's lines and collapses long unchanged runs", () => {
  const common = Array.from({ length: 10 }, (_, at) => `line ${at}\n`).join("");
  const rows = diffRows(`${common}mine\n`, `${common}theirs\n`)!;
  assert.deepEqual(rows, [
    { kind: "skip", count: 8 },
    { kind: "same", text: "line 8\n" },
    { kind: "same", text: "line 9\n" },
    { kind: "theirs", text: "theirs\n" },
    { kind: "mine", text: "mine\n" },
  ]);
});

test("keeps short unchanged runs between changes", () => {
  const rows = diffRows("a\nx\nb\nc\nd\n", "a\ny\nb\nc\nd\n")!;
  assert.deepEqual(rows.map(row => row.kind), ["same", "theirs", "mine", "same", "same", "same"]);
});
