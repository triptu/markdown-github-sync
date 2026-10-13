import { test } from "node:test";
import assert from "node:assert/strict";
import { FileJournalStore, type JournalFiles } from "../src/git-sync/store";
import { NativeModeStore } from "../src/git-sync/native-modes";
import { entryFromText } from "../src/git-sync/codec";
const installation = "12345678-1234-1234-1234-123456789abc";
function storage() {
  const values = new Map<string, string>();
  const folders = new Set<string>();
  let fail = false, lostAck = false, unreadable = false;
  const files: JournalFiles = {
    exists: async p => values.has(p) || folders.has(p),
    mkdir: async p => { folders.add(p); },
    read: async p => { if (unreadable) throw new Error("unreadable durable head"); const v = values.get(p); if (v === undefined) throw new Error("missing"); return v; },
    write: async (p, v) => { if (fail && p.includes("/records/")) { fail = false; throw new Error("injected record failure"); } values.set(p, v); },
    rename: async (a, b) => { const v = values.get(a); if (v === undefined) throw new Error("missing"); values.set(b, v); values.delete(a); if (lostAck && b.includes("/records/")) { lostAck = false; throw new Error("lost acknowledgment"); } },
    list: async p => ({ files: [...values.keys()].filter(k => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")), folders: [] }),
  };
  return { loseAck: () => { lostAck = true; }, unreadable: (value: boolean) => { unreadable = value; }, failNext: () => { fail = true; }, open: () => NativeModeStore.open(new FileJournalStore(files, installation, "modes"), { "folder/a.md": "100755" }) };
}
test("failed mode save does not suppress retry and survives reopening", async () => {
  const h = storage(), modes = await h.open();
  h.failNext();
  await assert.rejects(modes.set("folder/a.md", "100644"), /injected/);
  assert.equal(modes.get("folder/a.md"), "100755");
  await modes.set("folder/a.md", "100644");
  assert.equal((await h.open()).get("folder/a.md"), "100644");
});
test("failed folder rename can be replayed and persists executable mode", async () => {
  const h = storage(), modes = await h.open();
  h.failNext();
  await assert.rejects(modes.rename("folder", "renamed"), /injected/);
  assert.equal(modes.get("folder/a.md"), "100755");
  await modes.rename("folder", "renamed");
  const reopened = await h.open();
  assert.equal(reopened.get("renamed/a.md"), "100755");
  assert.equal(reopened.get("folder/a.md"), "100644");
});
test("failed intent begin and cancellation leave retryable durable state", async () => {
  const h = storage(), modes = await h.open();
  const before = await entryFromText("before", "100755"), next = await entryFromText("after", "100644");
  h.failNext();
  await assert.rejects(modes.begin("folder/a.md", before, next), /injected/);
  await modes.begin("folder/a.md", before, next);
  h.failNext();
  await assert.rejects(modes.cancel("folder/a.md"), /injected/);
  await modes.cancel("folder/a.md");
  const reopened = await h.open();
  await reopened.recover(async () => "0".repeat(40));
  assert.equal(reopened.get("folder/a.md"), "100755");
});

test("lost save acknowledgment reloads committed mode before allowing reads", async () => {
  const h = storage(), modes = await h.open();
  h.loseAck();
  await assert.rejects(modes.set("folder/a.md", "100644"), /lost acknowledgment/);
  assert.equal(modes.get("folder/a.md"), "100644");
  assert.equal((await h.open()).get("folder/a.md"), "100644");
});
test("uncertain persistence blocks captures when durable reread also fails", async () => {
  const h = storage(), modes = await h.open();
  h.unreadable(true);
  await assert.rejects(modes.set("folder/a.md", "100644"), /unreadable/);
  assert.throws(() => modes.get("folder/a.md"), /persistence is uncertain/);
  await assert.rejects(modes.recover(async () => null), /persistence is uncertain/);
  await assert.rejects(modes.rename("folder", "renamed"), /persistence is uncertain/);
  h.unreadable(false);
  assert.equal((await h.open()).get("folder/a.md"), "100755");
});
