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
    const conflict = plan.conflicts[0] as VersionConflict;
    assert.equal(conflict.kind, "content");
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

// Changed guarantee (v3): one-sided deletions are automatic like edits; only
// delete/edit and add/add remain decisions tied to exact versions.
test("one-sided deletions are automatic; delete/edit and add/add need a decision tied to exact versions", async () => {
  const base = await snapshot({ "gone-here.md": "x", "gone-there.md": "y", "del-edit.md": "1", "edit-del.md": "1" });
  const local = await snapshot({ "gone-there.md": "y", "edit-del.md": "2", "both.md": "mine" });
  const remote = await snapshot({ "gone-here.md": "x", "del-edit.md": "2", "both.md": "theirs" });
  const plan = await reconcile({ base, local, remote, decisions: {} });
  assert.equal(plan.kind, "needs-decision");
  if (plan.kind !== "needs-decision") return;
  const kinds = Object.fromEntries((plan.conflicts as VersionConflict[]).map((item) => [item.path, item.kind]));
  assert.deepEqual(kinds, {
    "both.md": "add-add",
    "del-edit.md": "local-deleted-remote-edited",
    "edit-del.md": "local-edited-remote-deleted",
  });

  const conflicts = plan.conflicts as VersionConflict[];
  const id = (path: string) => conflicts.find((item) => item.path === path)!.id;
  const decisions: Record<string, Choice> = {
    [id("both.md")]: { kind: "both" },
    [id("del-edit.md")]: { kind: "remote" },
    [id("edit-del.md")]: { kind: "edit", entry: await entryFromText("edited") },
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
  const deletions = resolved.incoming.filter((step) => !step.next).map((step) => [step.path, step.decision]);
  assert.deepEqual(deletions, [["gone-there.md", null]], "the one-sided remote deletion is an automatic step");
  assert.equal(resolved.incoming.at(-1)!.path, "gone-there.md", "deletions run last");

  // A changed version produces a new id: the old decision no longer applies.
  const moved = { ...remote, "both.md": await entryFromText("theirs v2") };
  const again = await reconcile({ base, local, remote: moved, decisions });
  assert.equal(again.kind, "needs-decision");
  if (again.kind === "needs-decision") assert.deepEqual(again.conflicts.map((item) => item.kind), ["add-add"]);
});

for (const side of ["local", "remote"] as const) {
  test(`a pure ${side} rename against an edit of the old path moves the edit automatically`, async () => {
    const base = await snapshot({ "old.md": "body", "other.md": "o" });
    const renamed = await snapshot({ "new.md": "body", "other.md": "o" });
    const edited = await snapshot({ "old.md": "body edited", "other.md": "o" });
    const local = side === "local" ? renamed : edited;
    const remote = side === "local" ? edited : renamed;
    const plan = await reconcile({ base, local, remote, decisions: {} });
    assert.ok(plan.kind === "ready", JSON.stringify(plan));
    assert.deepEqual(Object.fromEntries(Object.entries(plan.target).map(([path, entry]) => [path, entryText(entry)])), { "new.md": "body edited", "other.md": "o" });
    assert.ok(plan.incoming.every((step) => step.decision === null));
    const incoming = Object.fromEntries(plan.incoming.map((step) => [step.path, step.next ? entryText(step.next) : null]));
    assert.deepEqual(incoming, side === "local" ? { "new.md": "body edited" } : { "new.md": "body edited", "old.md": null });
    assert.deepEqual(Object.keys(plan.outgoing).sort(), side === "local" ? ["new.md", "old.md"] : ["new.md"]);
  });
}

test("ambiguous renames against an edit stay ordinary conflicts", async () => {
  const base = await snapshot({ "a.md": "same", "b.md": "same" });
  // Two deleted paths share the moved bytes: which one moved is unknowable.
  const local = await snapshot({ "c.md": "same" });
  const remote = await snapshot({ "a.md": "edited", "b.md": "same" });
  const plan = await reconcile({ base, local, remote, decisions: {} });
  assert.ok(plan.kind === "needs-decision");
  assert.deepEqual((plan.conflicts as VersionConflict[]).map((item) => [item.path, item.kind]), [["a.md", "local-deleted-remote-edited"]]);
});

for (const direction of ["local", "remote"] as const) {
  test(`deleting at least max(25, 20%) of base paths from the ${direction} side needs exactly one confirmation`, async () => {
    const names = Array.from({ length: 125 }, (_, index) => `n${String(index).padStart(3, "0")}.md`);
    const base = await snapshot(Object.fromEntries(names.map((name) => [name, `body ${name}`])));
    const survivors = (count: number) => Object.fromEntries(Object.entries(base).slice(count));
    // 24 deletions out of 125 is below max(25, ceil(25)) = 25 and stays automatic.
    for (const [count, guarded] of [[24, false], [25, true]] as const) {
      const shrunk = survivors(count);
      const local = direction === "local" ? shrunk : base;
      const remote = direction === "local" ? base : shrunk;
      const plan = await reconcile({ base, local, remote, decisions: {}, guardScope: "head:local" });
      if (!guarded) {
        assert.equal(plan.kind, "ready");
        continue;
      }
      assert.ok(plan.kind === "needs-decision");
      assert.equal(plan.conflicts.length, 1);
      const conflict = plan.conflicts[0]!;
      assert.ok(conflict.kind === "bulk-deletion" && conflict.direction === direction && conflict.paths.length === 25);
      const proceed = await reconcile({ base, local, remote, guardScope: "head:local", decisions: { [conflict.id]: { kind: direction === "local" ? "mine" : "remote" } } });
      assert.ok(proceed.kind === "ready");
      assert.equal(Object.keys(proceed.target).length, 100);
      if (direction === "remote") assert.ok(proceed.incoming.every((step) => step.next === null && step.decision === conflict.id));
      const restore = await reconcile({ base, local, remote, guardScope: "head:local", decisions: { [conflict.id]: { kind: direction === "local" ? "remote" : "mine" } } });
      assert.ok(restore.kind === "ready");
      assert.equal(Object.keys(restore.target).length, 125, "keeping the other side restores every file");
      const rescoped = await reconcile({ base, local, remote, guardScope: "head2:local", decisions: { [conflict.id]: { kind: "mine" } } });
      assert.ok(rescoped.kind === "needs-decision" && rescoped.conflicts[0]!.id !== conflict.id, "the confirmation binds head and local manifest");
    }
  });
}

test("moving a whole folder is not a bulk deletion", async () => {
  const names = Array.from({ length: 40 }, (_, index) => `old/n${index}.md`);
  const base = await snapshot(Object.fromEntries(names.map((name) => [name, `body ${name}`])));
  const local = await snapshot(Object.fromEntries(names.map((name) => [name.replace("old/", "new/"), `body ${name}`])));
  const plan = await reconcile({ base, local, remote: base, decisions: {} });
  assert.ok(plan.kind === "ready");
  assert.equal(Object.values(plan.outgoing).filter((entry) => entry === null).length, 40);
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
  // v3: the remote rename is automatic (delete + create).
  assert.equal(renamed.kind, "ready");
  if (renamed.kind === "ready") assert.deepEqual(renamed.incoming.map((step) => [step.path, step.next ? "write" : "delete"]), [["a.md", "delete"], ["A.md", "write"]]);
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
    assert.ok(deletion.kind === "ready" && Object.hasOwn(deletion.outgoing, path) && deletion.outgoing[path] === null, path);
  }
});

test("a decision is valid only within an optional review scope", async () => {
  const versions = { base: await snapshot({ "n.md": "base" }), local: await snapshot({ "n.md": "local" }), remote: await snapshot({ "n.md": "remote" }) };
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

test("incoming steps name the decision they implement; automatic steps name none", async () => {
  const base = await snapshot({ "automatic.md": "old", "conflict.md": "base", "gone.md": "delete me" });
  const local = await snapshot({ "automatic.md": "old", "conflict.md": "local", "gone.md": "delete me" });
  const remote = await snapshot({ "automatic.md": "new", "conflict.md": "remote" });
  const review = await reconcile({ base, local, remote, decisions: {} });
  assert.ok(review.kind === "needs-decision");
  assert.equal(review.conflicts.length, 1);
  const conflict = review.conflicts[0]!;
  const plan = await reconcile({ base, local, remote, decisions: { [conflict.id]: { kind: "both" } } });
  assert.ok(plan.kind === "ready");
  assert.equal(plan.incoming.find((step) => step.path === "automatic.md")?.decision, null);
  assert.equal(plan.incoming.find((step) => step.path === "gone.md")?.decision, null);
  assert.equal(plan.incoming.find((step) => step.path === "conflict.md")?.decision, conflict.id);
  const sibling = siblingPath("conflict.md", local["conflict.md"]!.oid);
  assert.equal(plan.incoming.find((step) => step.path === sibling)?.decision, conflict.id);
});
