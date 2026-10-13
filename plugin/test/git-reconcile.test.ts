import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFromText, entryText, isSyncablePath } from "../src/git-sync/codec";
import { diff, mergeText, reconcile, siblingPath, splitLines } from "../src/git-sync/reconcile";
import type { Choice, VersionConflict } from "../src/git-sync/reconcile";
import { bytes, snapshot } from "./git-fakes";

const lines = (count: number, edit: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => `${edit[index] ?? `line ${index}`}\n`).join("");

test("keep both is offered only when the generated sibling fits the path limit", async () => {
  const prefix = ("a".repeat(200) + "/").repeat(20);
  const suffixLength = siblingPath("n.md", "0".repeat(40)).length - "n.md".length;
  for (const siblingLength of [4096, 4097]) {
    const path = prefix + "n".repeat(siblingLength - prefix.length - 3 - suffixLength) + ".md";
    assert.ok(isSyncablePath(path));
    const base = await snapshot({ [path]: "base" });
    const local = await snapshot({ [path]: "local" });
    const remote = await snapshot({ [path]: "remote" });
    assert.equal(siblingPath(path, local[path]!.oid).length, siblingLength);
    const plan = await reconcile({ base, local, remote, decisions: {} });
    assert.ok(plan.kind === "needs-decision");
    const conflict = plan.conflicts[0]!;
    assert.ok(conflict.kind !== "collision");
    assert.equal(conflict.choices.includes("both"), siblingLength === 4096);
    assert.equal(conflict.sibling !== null, siblingLength === 4096);
    if (conflict.sibling) {
      const resolved = await reconcile({ base, local, remote, decisions: { [conflict.id]: { kind: "both" } } });
      assert.ok(resolved.kind === "ready");
      assert.ok(Object.keys(resolved.target).every(isSyncablePath));
      assert.equal(resolved.target[conflict.sibling]?.data, local[path]!.data);
    }
  }
});

async function merge(base: string, local: string, remote: string, path = "n.md") {
  const result = await mergeText({ path, base: await entryFromText(base), local: await entryFromText(local), remote: await entryFromText(remote) });
  return result && entryText(result);
}

test("diff hunks reconstruct the target for random edits", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
    const b = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
    const hunks = diff(a, b)!;
    const out: string[] = [];
    let at = 0;
    for (const hunk of hunks) {
      out.push(...a.slice(at, hunk.start), ...hunk.lines);
      at = hunk.end;
    }
    out.push(...a.slice(at));
    assert.deepEqual(out, b);
  }
});

test("markdown merge combines separated edits and rejects touching ones", async () => {
  const base = lines(10);
  assert.equal(await merge(base, lines(10, { 1: "mine" }), lines(10, { 7: "theirs" })), lines(10, { 1: "mine", 7: "theirs" }));
  assert.equal(await merge(base, lines(10, { 3: "same" }), lines(10, { 3: "same" })), lines(10, { 3: "same" }), "identical edits");
  assert.equal(await merge(base, lines(10, { 3: "mine" }), lines(10, { 3: "theirs" })), null, "overlap");
  assert.equal(await merge(base, lines(10, { 3: "mine" }), lines(10, { 4: "theirs" })), null, "adjacent lines");
  assert.equal(await merge(base, base + "a\n", base + "b\n"), null, "same insertion point");
  assert.equal(await merge(base, lines(10, { 1: "mine" }), lines(10, { 7: "theirs" }), "data.base"), null, "only Markdown");
  const crlf = "a\r\nb\r\nc\r\nd\r\ne";
  assert.equal(await merge(crlf, "A\r\nb\r\nc\r\nd\r\ne", "a\r\nb\r\nc\r\nd\r\nE"), "A\r\nb\r\nc\r\nd\r\nE", "line endings and missing final newline");
  assert.deepEqual(splitLines("x\r\ny"), ["x\r\n", "y"]);
});

test("independent changes on both sides combine; only differences move", async () => {
  const base = await snapshot({ "a.md": "a", "b.md": "b", "c.md": "c" });
  const local = await snapshot({ "a.md": "a2", "b.md": "b", "c.md": "c", "new.md": "n" });
  const remote = await snapshot({ "a.md": "a", "b.md": "b2", "c.md": "c", "img.png": await bytes([0, 255]) });
  const plan = await reconcile({ base, local, remote, decisions: {} });
  assert.equal(plan.kind, "ready");
  if (plan.kind !== "ready") return;
  assert.deepEqual(Object.keys(plan.outgoing).sort(), ["a.md", "new.md"]);
  assert.deepEqual(plan.incoming.map((step) => step.path).sort(), ["b.md", "img.png"]);
  assert.deepEqual(Object.keys(plan.target).sort(), ["a.md", "b.md", "c.md", "img.png", "new.md"]);
});

test("every deletion, delete/edit and add/add needs a decision tied to exact versions", async () => {
  const base = await snapshot({ "gone-here.md": "x", "gone-there.md": "y", "del-edit.md": "1", "edit-del.md": "1" });
  const local = await snapshot({ "gone-there.md": "y", "edit-del.md": "2", "both.md": "mine" });
  const remote = await snapshot({ "gone-here.md": "x", "del-edit.md": "2", "both.md": "theirs" });
  const plan = await reconcile({ base, local, remote, decisions: {} });
  assert.equal(plan.kind, "needs-decision");
  if (plan.kind !== "needs-decision") return;
  const kinds = Object.fromEntries(plan.conflicts.map((item) => [item.kind === "collision" ? "" : item.path, item.kind]));
  assert.deepEqual(kinds, {
    "both.md": "add-add",
    "del-edit.md": "local-deleted-remote-edited",
    "edit-del.md": "local-edited-remote-deleted",
    "gone-here.md": "local-deletion",
    "gone-there.md": "remote-deletion",
  });

  const conflicts = plan.conflicts as VersionConflict[];
  const id = (path: string) => conflicts.find((item) => item.path === path)!.id;
  const decisions: Record<string, Choice> = {
    [id("both.md")]: { kind: "both" },
    [id("del-edit.md")]: { kind: "remote" },
    [id("edit-del.md")]: { kind: "edit", entry: await entryFromText("edited") },
    [id("gone-here.md")]: { kind: "mine" },
    [id("gone-there.md")]: { kind: "remote" },
  };
  const resolved = await reconcile({ base, local, remote, decisions });
  assert.equal(resolved.kind, "ready");
  if (resolved.kind !== "ready") return;
  const sibling = siblingPath("both.md", local["both.md"]!.oid);
  assert.match(sibling, /^both \(conflict [0-9a-f]{7}\)\.md$/);
  assert.deepEqual(Object.fromEntries(Object.entries(resolved.target).map(([path, entry]) => [path, entryText(entry)])), {
    "both.md": "theirs",
    [sibling]: "mine",
    "del-edit.md": "2",
    "edit-del.md": "edited",
  });
  assert.deepEqual(Object.keys(resolved.outgoing).sort(), ["edit-del.md", "gone-here.md", sibling].sort());
  const deletions = resolved.incoming.filter((step) => !step.next).map((step) => step.path);
  assert.deepEqual(deletions, ["gone-there.md"]);
  assert.equal(resolved.incoming.at(-1)!.path, "gone-there.md", "deletions run last");

  // A changed version produces a new id: the old decision no longer applies.
  const moved = { ...remote, "both.md": await entryFromText("theirs v2") };
  const again = await reconcile({ base, local, remote: moved, decisions });
  assert.equal(again.kind, "needs-decision");
  if (again.kind === "needs-decision") assert.deepEqual(again.conflicts.map((item) => item.kind), ["add-add"]);
});

test("case-insensitive collisions are reported instead of materialized", async () => {
  const plan = await reconcile({
    base: {},
    local: await snapshot({ "Note.md": "a" }),
    remote: await snapshot({ "note.md": "b" }),
    decisions: {},
  });
  assert.equal(plan.kind, "needs-decision");
  if (plan.kind === "needs-decision") assert.deepEqual(plan.conflicts[0], { ...plan.conflicts[0], kind: "collision", paths: ["Note.md", "note.md"] });

  // A case-only rename deletes the old name before creating the new one.
  const base = await snapshot({ "a.md": "x" });
  const renamed = await reconcile({
    base,
    local: base,
    remote: await snapshot({ "A.md": "x" }),
    decisions: {},
  });
  assert.equal(renamed.kind, "needs-decision", "the deletion half still needs review");
  if (renamed.kind !== "needs-decision") return;
  const accept = { [renamed.conflicts[0]!.id]: { kind: "remote" } as const };
  const ready = await reconcile({ base, local: base, remote: await snapshot({ "A.md": "x" }), decisions: accept });
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") assert.deepEqual(ready.incoming.map((step) => [step.path, step.next ? "write" : "delete"]), [["a.md", "delete"], ["A.md", "write"]]);
});

test("keep both is withheld when the sibling name is already taken", async () => {
  const local = await snapshot({ "n.md": "mine" });
  const sibling = siblingPath("n.md", local["n.md"]!.oid);
  const plan = await reconcile({
    base: {},
    local: { ...local, [sibling.toUpperCase()]: (await snapshot({ x: "existing" })).x! },
    remote: await snapshot({ "n.md": "theirs" }),
    decisions: {},
  });
  assert.equal(plan.kind, "needs-decision");
  const conflict = plan.kind === "needs-decision" ? (plan.conflicts[0] as VersionConflict) : null;
  assert.equal(conflict?.sibling, null);
  assert.deepEqual(conflict?.choices, ["mine", "remote", "edit"]);
});

test("prototype-key additions, updates and deletions use only own file entries", async () => {
  const entry = await entryFromText("prototype path bytes");
  for (const path of ["__proto__", "constructor", "toString"]) {
    const local = Object.fromEntries([[path, entry]]);
    const plan = await reconcile({ base: {}, local, remote: {}, decisions: {} });
    assert.equal(plan.kind, "ready", path);
    if (plan.kind !== "ready") return assert.fail();
    assert.equal(Object.getPrototypeOf(plan.target), null);
    assert.equal(Object.getPrototypeOf(plan.outgoing), null);
    assert.equal(plan.target[path]?.oid, entry.oid);
    assert.equal(plan.outgoing[path]?.oid, entry.oid);
    const deletion = await reconcile({ base: local, local: {}, remote: local, decisions: {} });
    assert.ok(deletion.kind === "needs-decision" && deletion.conflicts[0]?.kind === "local-deletion", path);
  }
});

test("a decision is valid only within its head and review generation", async () => {
  const versions = { base: await snapshot({ "n.md": "base" }), local: {}, remote: await snapshot({ "n.md": "base" }) };
  const first = await reconcile({ ...versions, decisions: {}, reviewScope: "head1:generation1" });
  assert.ok(first.kind === "needs-decision");
  const conflict = first.conflicts[0]!;
  const decisions: Record<string, Choice> = { [conflict.id]: { kind: "mine" } };
  assert.equal((await reconcile({ ...versions, decisions, reviewScope: "head1:generation1" })).kind, "ready");
  for (const reviewScope of ["head2:generation1", "head1:generation2"]) {
    const next = await reconcile({ ...versions, decisions, reviewScope });
    assert.ok(next.kind === "needs-decision");
    assert.notEqual(next.conflicts[0]?.id, conflict.id);
  }
});

test("incoming steps distinguish automatic updates from reviewed replacements and retain conflict origins", async () => {
  const base = await snapshot({ "automatic.md": "old", "conflict.md": "base", "gone.md": "delete me" });
  const local = await snapshot({ "automatic.md": "old", "conflict.md": "local", "gone.md": "delete me" });
  const remote = await snapshot({ "automatic.md": "new", "conflict.md": "remote" });
  const review = await reconcile({ base, local, remote, decisions: {} });
  assert.ok(review.kind === "needs-decision");
  const decisions: Record<string, Choice> = {};
  for (const item of review.conflicts) {
    assert.ok(item.kind !== "collision");
    decisions[item.id] = { kind: item.path === "conflict.md" ? "both" : "remote" };
  }
  const plan = await reconcile({ base, local, remote, decisions });
  assert.ok(plan.kind === "ready");
  assert.deepEqual(plan.incoming.find((step) => step.path === "automatic.md")?.consent, { kind: "automatic" });
  assert.deepEqual(plan.incoming.find((step) => step.path === "conflict.md")?.consent, { kind: "reviewed", base: base["conflict.md"] });
  assert.deepEqual(plan.incoming.find((step) => step.path === "gone.md")?.consent, { kind: "reviewed", base: base["gone.md"] });
  const sibling = siblingPath("conflict.md", local["conflict.md"]!.oid);
  assert.deepEqual(plan.incoming.find((step) => step.path === sibling)?.consent, { kind: "reviewed", base: null });
});
