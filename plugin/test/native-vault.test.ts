import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { GitObsidianVault as Adapter } from "../src/git-sync/obsidian-vault";
import { NativeTransactionJournal } from "../src/git-sync/native-transactions";
import { entryFromBytes } from "../src/git-sync/codec";
import type { JournalFiles } from "../src/git-sync/store";
import type { App } from "obsidian";
const temporary = mkdtempSync(join(tmpdir(), "git-native-vault-"));
const bundle = join(temporary, "adapter.cjs");
buildSync({
  stdin: {
    contents:
      "export { GitObsidianVault } from './src/git-sync/obsidian-vault'; export { TFile, FileView } from 'obsidian';",
    resolveDir: resolve("."),
  },
  alias: { obsidian: resolve("test/fixtures/obsidian.ts") },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundle,
});
const loaded = createRequire(import.meta.url)(bundle) as {
  GitObsidianVault: typeof Adapter;
  FileView: new (file: { path: string } | null) => { file: { path: string } | null };
  TFile: new (
    path: string,
    stat: { size: number; mtime: number },
  ) => { path: string; stat: { size: number; mtime: number } };
};
rmSync(temporary, { recursive: true, force: true });
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
async function harness(modes = new Map<string, "100644" | "100755">()) {
  const files = new Map<
    string,
    { file: InstanceType<typeof loaded.TFile>; data: Uint8Array }
  >();
  let beforeProcess: (() => void) | undefined;
  let beforeRename: ((from: string, to: string) => void) | undefined;
  let afterRename: ((from: string, to: string) => void) | undefined;
  let afterRead: ((path: string) => void) | undefined;
  const views: Array<{ view: InstanceType<typeof loaded.FileView> }> = [];
  const strings = new Map<string, string>();
  const folders = new Set<string>();
  let holdReads = 0;
  const put = (path: string, data: Uint8Array) => {
    const file =
      files.get(path)?.file ??
      new loaded.TFile(path, { size: data.length, mtime: 1 });
    file.stat.size = data.length;
    files.set(path, { file, data: data.slice() });
  };
  const rename = async (from: string, to: string) => {
    beforeRename?.(from, to);
    if (files.has(to) || strings.has(to)) throw new Error("no-clobber destination exists");
    const source = files.get(from);
    if (source) {
      files.delete(from);
      source.file.path = to;
      files.set(to, source);
    } else {
      const data = strings.get(from);
      if (data === undefined) throw new Error("missing rename source");
      strings.delete(from);
      strings.set(to, data);
    }
    afterRename?.(from, to);
  };
  const journalFiles: JournalFiles = {
    exists: async path => files.has(path) || strings.has(path) || folders.has(path),
    mkdir: async path => { folders.add(path); },
    read: async path => { const value = strings.get(path); if (value === undefined) throw new Error("missing"); return value; },
    write: async (path, value) => { strings.set(path, value); },
    rename,
    remove: async path => { strings.delete(path); files.delete(path); },
    list: async path => ({ files: [...files.keys(), ...strings.keys()].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")), folders: [] }),
  };
  const app = {
    workspace: { iterateAllLeaves: (visit: (leaf: { view: InstanceType<typeof loaded.FileView> }) => void) => views.forEach(visit) },
    vault: {
      getFiles: () => [...files.values()].map((x) => x.file),
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      readBinary: async (f: { path: string }) =>
        files.get(f.path)!.data.slice().buffer,
      adapter: {
        exists: journalFiles.exists, mkdir: journalFiles.mkdir, list: journalFiles.list, rename,
        readBinary: async (path: string) => { if (path.includes("/hold/")) holdReads++; const data = files.get(path)!.data.slice().buffer; afterRead?.(path); return data; },
        writeBinary: async (path: string, data: ArrayBuffer) => { put(path, new Uint8Array(data)); },
        remove: async (path: string) => { files.delete(path); },
      },
      createFolder: async (path: string) => { folders.add(path); },
      createBinary: async (p: string, d: ArrayBuffer) => {
        if (files.has(p)) throw Error("exists");
        put(p, new Uint8Array(d));
      },
      process: async (f: { path: string }, fn: (s: string) => string) => {
        beforeProcess?.();
        const next = fn(text(files.get(f.path)!.data));
        put(f.path, bytes(next));
        return next;
      },
    },
  };
  const open = async (hostLifetime = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") => {
    const journal = await NativeTransactionJournal.open(journalFiles, "12345678-1234-1234-1234-123456789abc");
    const vault = new loaded.GitObsidianVault(app as unknown as App, {
      get: path => modes.get(path) ?? "100644",
      set: (path, mode) => { modes.set(path, mode); },
      remove: path => { modes.delete(path); },
    }, () => {}, journal, hostLifetime);
    return { vault, journal };
  };
  const { vault } = await open();
  return {
    vault, open,
    openView: (path: string) => { const view = new loaded.FileView(files.get(path)?.file ?? null); views.push({ view }); return view; },
    closeViews: () => { views.length = 0; },
    holdReads: () => holdReads,
    put,
    files,
    strings,
    setReadHook: (fn?: (path: string) => void) => { afterRead = fn; },
    setRenameHook: (fn?: (from: string, to: string) => void) => { afterRename = fn; },
    setBeforeRenameHook: (fn?: (from: string, to: string) => void) => { beforeRename = fn; },
    setHook: (fn: () => void) => {
      beforeProcess = fn;
    },
  };
}
test("atomic process catches an edit between preflight and actual write", async () => {
  const h = await harness();
  h.put("a.md", bytes("base"));
  const base = await h.vault.capture();
  h.put("a.md", bytes("remote"));
  const remote = await h.vault.capture();
  h.put("a.md", bytes("base"));
  h.setHook(() => h.put("a.md", bytes("new edit")));
  assert.equal(
    (await h.vault.apply("a.md", base["a.md"], remote["a.md"])).kind,
    "changed",
  );
  assert.equal(text(h.files.get("a.md")!.data), "new edit");
});
test("a newer edit between the hash read and text read is never adopted as the reviewed preimage", async () => {
  const h = await harness();
  const before = await entryFromBytes(bytes("base")), next = await entryFromBytes(bytes("remote"));
  h.put("a.md", bytes("base"));
  let reads = 0;
  h.setReadHook(path => {
    if (path === "a.md" && ++reads === 2) h.put("a.md", bytes("newer edit"));
  });
  assert.equal((await h.vault.apply("a.md", before, next)).kind, "changed");
  assert.equal(text(h.files.get("a.md")!.data), "newer edit");
});
test("UTF8 BOM CRLF bytes preserved by atomic note replacement", async () => {
  const h = await harness();
  h.put("a.md", bytes("before"));
  const base = await h.vault.capture();
  h.put("a.md", bytes("\uFEFFafter\r\n"));
  const remote = await h.vault.capture();
  h.put("a.md", bytes("before"));
  assert.equal(
    (await h.vault.apply("a.md", base["a.md"], remote["a.md"])).kind,
    "applied",
  );
  assert.deepEqual(h.files.get("a.md")!.data, bytes("\uFEFFafter\r\n"));
});
test("binary replacement and deletion use exact staged rename", async () => {
  const h = await harness();
  h.put("a.png", new Uint8Array([0, 1, 2]));
  const base = await h.vault.capture();
  h.put("a.png", new Uint8Array([3, 4, 5]));
  const remote = await h.vault.capture();
  h.put("a.png", new Uint8Array([0, 1, 2]));
  assert.equal(
    (await h.vault.apply("a.png", base["a.png"], remote["a.png"])).kind,
    "applied",
  );
  assert.equal(
    (await h.vault.apply("a.png", base["a.png"], null)).kind,
    "changed",
  );
  assert.deepEqual(h.files.get("a.png")!.data, new Uint8Array([3, 4, 5]));
  assert.ok([...h.files.keys()].some(path => path.includes("/hold/")));
  assert.equal((await h.vault.apply("a.png", remote["a.png"], null)).kind, "applied");
  assert.equal(h.files.has("a.png"), false);
  assert.equal(h.vault.nativeRecoveries().some(record => record.path === "a.png"), false);
});
test("creates preserve exact attachment bytes and skip hidden files", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 255, 128]));
  h.put(".obsidian/private", bytes("secret"));
  const captured = await h.vault.capture();
  assert.deepEqual(Object.keys(captured), ["a.bin"]);
  h.files.delete("a.bin");
  assert.equal(
    (await h.vault.apply("a.bin", null, captured["a.bin"])).kind,
    "applied",
  );
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([0, 255, 128]));
});

test("logical executable mode survives equal bytes and creates", async () => {
  const modes = new Map<string, "100644" | "100755">();
  const h = await harness(modes);
  h.put("tool.sh", bytes("echo ready\n"));
  const original = (await h.vault.capture())["tool.sh"];
  const executable = { ...original, mode: "100755" as const };
  assert.equal((await h.vault.apply("tool.sh", original, executable)).kind, "applied");
  assert.equal((await h.vault.capture())["tool.sh"].mode, "100755");
  h.put("tool.sh", bytes("echo edited\n"));
  assert.equal((await h.vault.capture())["tool.sh"].mode, "100755");
  const restarted = await harness(modes);
  restarted.put("tool.sh", bytes("echo edited\n"));
  assert.equal((await restarted.vault.capture())["tool.sh"].mode, "100755");
  assert.equal((await restarted.vault.apply("new.sh", null, executable)).kind, "applied");
  assert.equal(restarted.files.has("new.sh"), true);
});

test("restart finishes a displace interrupted after rename", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 1, 2]));
  const original = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([3, 4, 5]));
  const next = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([0, 1, 2]));
  h.setRenameHook((from) => { if (from === "a.bin") throw new Error("simulated process death"); });
  await assert.rejects(h.vault.apply("a.bin", original, next), /simulated process death/);
  assert.equal(h.files.has("a.bin"), false);
  assert.ok([...h.files.keys()].some(path => path.includes("/hold/")));
  h.setRenameHook();
  const { vault } = await h.open();
  await vault.capture();
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([3, 4, 5]));
});

test("late write through a retargeted TFile is captured from hold", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const oldFile = h.files.get("a.bin")!.file;
  const original = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([1]));
  const next = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([0]));
  assert.equal((await h.vault.apply("a.bin", original, next)).kind, "applied");
  assert.ok(oldFile.path.includes("/hold/"));
  h.put(oldFile.path, new Uint8Array([2]));
  await h.vault.capture();
  assert.ok(h.vault.nativeRecoveries().some(item => item.path === "a.bin"
    && item.sourcePath === oldFile.path && item.kind === "displaced"));
});

test("restart after install recognizes exact next bytes", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const original = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([1]));
  const next = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([0]));
  h.setRenameHook((from) => { if (from.includes("/stage/")) throw new Error("after install crash"); });
  await assert.rejects(h.vault.apply("a.bin", original, next), /after install crash/);
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
  h.setRenameHook();
  const { vault } = await h.open();
  await vault.capture();
  assert.equal(vault.nativeRecoveries().some(record => record.path === "a.bin"), false);
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
});

test("recreated destination after displacement is not clobbered", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const original = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([1]));
  const next = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([0]));
  h.setRenameHook((from) => { if (from === "a.bin") h.put("a.bin", new Uint8Array([9])); });
  assert.equal((await h.vault.apply("a.bin", original, next)).kind, "interrupted");
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([9]));
  assert.ok(h.vault.nativeRecoveries().some(record => record.path === "a.bin" && record.kind === "interrupted"));
});

test("write through displaced TFile before install is retained as newer hold bytes", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const original = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([1]));
  const next = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([0]));
  h.setRenameHook((from, to) => { if (from === "a.bin") h.put(to, new Uint8Array([9])); });
  assert.equal((await h.vault.apply("a.bin", original, next)).kind, "displaced");
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([9]));
  await h.vault.capture();
  assert.ok(h.vault.nativeRecoveries().some(record => record.path === "a.bin" && record.kind === "displaced"));
});

test("create fails no-clobber when another writer creates the destination before rename", async () => {
  const h = await harness();
  const next = await entryFromBytes(new Uint8Array([1, 2, 3]));
  h.setBeforeRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "new.bin") h.put(to, new Uint8Array([9]));
  });
  await assert.rejects(h.vault.apply("new.bin", null, next), /no-clobber/);
  assert.deepEqual(h.files.get("new.bin")!.data, new Uint8Array([9]));
  h.setBeforeRenameHook();
  const { vault } = await h.open();
  await vault.capture();
  assert.deepEqual(h.files.get("new.bin")!.data, new Uint8Array([9]));
});

test("open binary view blocks rename without retargeting its TFile", async () => {
  const h = await harness();
  h.put("image.bin", new Uint8Array([0, 1, 2]));
  const file = h.files.get("image.bin")!.file;
  const expected = (await h.vault.capture())["image.bin"];
  const next = await entryFromBytes(new Uint8Array([3, 4, 5]));
  h.openView("image.bin");
  const result = await h.vault.apply("image.bin", expected, next);
  assert.equal(result.kind, "blocked");
  assert.match(result.kind === "blocked" ? result.reason : "", /open view/);
  assert.equal(file.path, "image.bin");
  assert.deepEqual(h.files.get("image.bin")!.data, new Uint8Array([0, 1, 2]));
  h.closeViews();
  assert.equal((await h.vault.apply("image.bin", expected, next)).kind, "applied");
});

test("open canvas uses process and keeps the original TFile path", async () => {
  const h = await harness();
  h.put("board.canvas", bytes('{"nodes":[]}'));
  const file = h.files.get("board.canvas")!.file;
  const expected = (await h.vault.capture())["board.canvas"];
  const next = await entryFromBytes(bytes('{"nodes":[1]}'));
  h.openView("board.canvas");
  assert.equal((await h.vault.apply("board.canvas", expected, next)).kind, "applied");
  assert.equal(file.path, "board.canvas");
  assert.equal(text(h.files.get("board.canvas")!.data), '{"nodes":[1]}');
});

test("same host lifetime retains a clean hold; new lifetime releases verified preimage", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 1, 2]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([3, 4, 5]));
  assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const sameHost = await h.open();
  await sameHost.vault.recover();
  assert.equal(h.files.has(hold), true);
  const newHost = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await newHost.vault.recover();
  assert.equal(h.files.has(hold), false);
});

test("oversized hidden hold is retained and does not block unrelated files", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 1, 2]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([3, 4, 5]));
  assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  h.put(hold, new Uint8Array(8 * 1024 * 1024 + 1));
  await h.vault.capture();
  assert.ok(h.vault.nativeRecoveries().some(item => item.kind === "oversize" && item.path === "a.bin"));
  assert.equal((await h.vault.apply("a.bin", next, null)).kind, "blocked");
  assert.equal((await h.vault.apply("other.bin", null, await entryFromBytes(new Uint8Array([9])))).kind, "applied");
  assert.equal(h.files.has(hold), true);
});

test("unattempted text intent treats a later user edit as changed, without an issue", async () => {
  const h = await harness();
  h.put("n.md", bytes("before"));
  const expected = (await h.vault.capture())["n.md"];
  const next = await entryFromBytes(bytes("after"));
  const { journal } = await h.open();
  await journal.begin("n.md", expected, next, "text-process");
  h.put("n.md", bytes("user typed"));
  const restarted = await h.open();
  assert.deepEqual(await restarted.vault.recover(), []);
  assert.equal(text(h.files.get("n.md")!.data), "user typed");
});

test("apply does not rescan old holds and recovery compacts native records", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 1]));
  let expected = (await h.vault.capture())["a.bin"];
  for (let value = 1; value <= 12; value++) {
    const next = await entryFromBytes(new Uint8Array([value, value + 1]));
    assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
    expected = next;
  }
  const before = h.holdReads();
  assert.equal((await h.vault.apply("other.bin", null, await entryFromBytes(new Uint8Array([9, 0])))).kind, "applied");
  assert.equal(h.holdReads(), before, "unrelated apply must not read prior holds");
  await h.vault.capture();
  assert.ok([...h.strings.keys()].filter(path => path.includes("/native/records/") && path.endsWith(".json")).length <= 8);
  assert.equal([...h.files.keys()].filter(path => path.includes("/hold/")).length, 12);
  const newHost = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await newHost.vault.recover();
  assert.equal([...h.files.keys()].filter(path => path.includes("/hold/")).length, 0);
});

test("caught failure before text bytes change clears attempted marker", async () => {
  const h = await harness();
  h.put("n.md", bytes("before"));
  const expected = (await h.vault.capture())["n.md"];
  const next = await entryFromBytes(bytes("after"));
  h.setHook(() => { throw new Error("before write"); });
  await assert.rejects(h.vault.apply("n.md", expected, next), /before write/);
  h.setHook(() => {});
  h.put("n.md", bytes("user typed"));
  const restarted = await h.open();
  assert.deepEqual(await restarted.vault.recover(), []);
  assert.equal(text(h.files.get("n.md")!.data), "user typed");
});

test("displaced write still applies the installed file mode", async () => {
  const modes = new Map<string, "100644" | "100755">();
  const h = await harness(modes);
  h.put("a.bin", new Uint8Array([0, 1]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([2, 3]), "100755");
  h.setRenameHook((from) => {
    if (from.includes("/stage/")) {
      const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
      if (hold) h.put(hold, new Uint8Array([9, 9]));
    }
  });
  assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "displaced");
  assert.equal(modes.get("a.bin"), "100755");
});

test("unsupported long path is rejected before native journal writes", async () => {
  const h = await harness();
  const path = `${"x".repeat(4097)}.md`;
  const next = await entryFromBytes(bytes("new"));
  const { journal } = await h.open();
  await assert.rejects(h.vault.apply(path, null, next), /Unsupported vault path/);
  await assert.rejects(journal.begin(path, null, next, "rename"), /Unsupported native transaction path/);
  assert.deepEqual(journal.pending(), []);
});
