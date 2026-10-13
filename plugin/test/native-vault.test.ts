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
      "export { GitObsidianVault } from './src/git-sync/obsidian-vault'; export { TFile } from 'obsidian';",
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
  const strings = new Map<string, string>();
  const folders = new Set<string>();
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
    list: async path => ({ files: [...files.keys(), ...strings.keys()].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")), folders: [] }),
  };
  const app = {
    vault: {
      getFiles: () => [...files.values()].map((x) => x.file),
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      readBinary: async (f: { path: string }) =>
        files.get(f.path)!.data.slice().buffer,
      adapter: {
        exists: journalFiles.exists, mkdir: journalFiles.mkdir, list: journalFiles.list, rename,
        readBinary: async (path: string) => files.get(path)!.data.slice().buffer,
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
  const open = async () => {
    const journal = await NativeTransactionJournal.open(journalFiles, "12345678-1234-1234-1234-123456789abc");
    const vault = new loaded.GitObsidianVault(app as unknown as App, {
      get: path => modes.get(path) ?? "100644",
      set: (path, mode) => { modes.set(path, mode); },
      remove: path => { modes.delete(path); },
    }, () => {}, journal);
    return { vault, journal };
  };
  const { vault } = await open();
  return {
    vault, open,
    put,
    files,
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
  assert.equal(h.vault.nativeRecoveries().some(record => record.path === "a.png"), true);
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
    && item.sourcePath === oldFile.path && item.kind === "orphan"));
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
  assert.equal(vault.nativeRecoveries().some(record => record.path === "a.bin"), true);
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
  assert.equal((await h.vault.apply("a.bin", original, next)).kind, "changed");
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([9]));
  assert.ok(h.vault.nativeRecoveries().some(record => record.path === "a.bin" && record.kind === "changed"));
});

test("write through displaced TFile before install is retained as newer hold bytes", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const original = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([1]));
  const next = (await h.vault.capture())["a.bin"];
  h.put("a.bin", new Uint8Array([0]));
  h.setRenameHook((from, to) => { if (from === "a.bin") h.put(to, new Uint8Array([9])); });
  assert.equal((await h.vault.apply("a.bin", original, next)).kind, "changed");
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([9]));
  await h.vault.capture();
  assert.ok(h.vault.nativeRecoveries().some(record => record.path === "a.bin" && record.kind === "orphan"));
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
