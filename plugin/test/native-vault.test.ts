import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { GitObsidianVault as Adapter } from "../src/git-sync/obsidian-vault";
import { NativeTransactionJournal } from "../src/git-sync/native-transactions";
import { NativePathPolicy } from "../src/git-sync/native-path-policy";
import { compileScope } from "../src/git-sync/scope";
import { entryFromBytes, hashBlob } from "../src/git-sync/codec";
import { FileJournalStore, type JournalFiles } from "../src/git-sync/store";
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
const inspectHidden = (vault: Adapter) => vault.recover({ replay: [], cancel: [] });
const replayPending = async (vault: Adapter) => vault.recover({
  replay: (await vault.pendingIntents()).map(intent => intent.id), cancel: [],
});
async function harness(modes = new Map<string, "100644" | "100755">(),
  nativePolicy = NativePathPolicy.legacy) {
  const files = new Map<
    string,
    { file: InstanceType<typeof loaded.TFile>; data: Uint8Array }
  >();
  let beforeProcess: (() => void) | undefined;
  let beforeRename: ((from: string, to: string) => void) | undefined;
  let afterRename: ((from: string, to: string) => void) | undefined;
  let afterRead: ((path: string) => void) | undefined;
  let journalWrite: ((path: string) => void) | undefined;
  let listHook: ((path: string) => Promise<void>) | undefined;
  let queuedRename: ((from: string, to: string) => Promise<void>) | undefined;
  let indexTick: () => Promise<void> = async () => {};
  const views: Array<{ view: InstanceType<typeof loaded.FileView> }> = [];
  const strings = new Map<string, string>();
  const folders = new Set<string>();
  const absentFromIndex = new Set<string>();
  const indexGhosts = new Map<string, InstanceType<typeof loaded.TFile>>();
  const lookupOverrides = new Map<string, InstanceType<typeof loaded.TFile> | null>();
  let active = true;
  let holdReads = 0;
  let processCalls = 0;
  const adapterReads: string[] = [];
  const put = (path: string, data: Uint8Array) => {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join("/"));
    const old = files.get(path)?.file;
    const file =
      old ??
      new loaded.TFile(path, { size: data.length, mtime: 1 });
    file.stat.size = data.length;
    if (old) file.stat.mtime += 1;
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
    write: async (path, value) => { journalWrite?.(path); strings.set(path, value); },
    rename,
    remove: async path => { strings.delete(path); files.delete(path); },
    list: async listedPath => {
      await listHook?.(listedPath);
      const path = listedPath === "/" ? "" : listedPath;
      const foundFiles = new Set<string>(), foundFolders = new Set<string>();
      for (const item of [...files.keys(), ...strings.keys(), ...folders]) {
        if (path && !item.startsWith(`${path}/`)) continue;
        const rest = path ? item.slice(path.length + 1) : item;
        if (!rest) continue;
        const child = rest.split("/")[0];
        const name = path ? `${path}/${child}` : child;
        if (rest.includes("/") || folders.has(item)) foundFolders.add(name);
        else foundFiles.add(name);
      }
      return { files: [...foundFiles], folders: [...foundFolders] };
    },
  };
  const app = {
    workspace: { iterateAllLeaves: (visit: (leaf: { view: InstanceType<typeof loaded.FileView> }) => void) => views.forEach(visit) },
    vault: {
      configDir: ".obsidian",
      getFiles: () => [...files.values()].filter(x => !absentFromIndex.has(x.file.path)).map(x => x.file)
        .concat([...indexGhosts.values()]),
      getAbstractFileByPath: (p: string) => {
        if (p.startsWith(".") || p.split("/").some(part => part.startsWith(".")))
          throw new Error(`Hidden TFile lookup: ${p}`);
        if (lookupOverrides.has(p)) return lookupOverrides.get(p) ?? null;
        if (indexGhosts.has(p)) return indexGhosts.get(p) ?? null;
        return absentFromIndex.has(p) ? null : files.get(p)?.file ?? null;
      },
      readBinary: async (f: { path: string }) =>
        files.get(f.path)!.data.slice().buffer,
      adapter: {
        exists: journalFiles.exists, mkdir: journalFiles.mkdir, list: journalFiles.list,
        rename: async (from: string, to: string) => { await queuedRename?.(from, to); await rename(from, to); },
        stat: async (path: string) => {
          const item = files.get(path);
          return item ? { type: "file", size: item.file.stat.size, mtime: item.file.stat.mtime }
            : folders.has(path) ? { type: "folder", size: 0, mtime: 1 } : null;
        },
        copy: async (from: string, to: string) => {
          const item = files.get(from);
          if (!item) throw new Error("missing copy source");
          put(to, item.data);
        },
        readBinary: async (path: string) => {
          adapterReads.push(path);
          if (path.includes("/hold/")) holdReads++;
          const data = files.get(path)!.data.slice().buffer;
          afterRead?.(path);
          return data;
        },
        writeBinary: async (path: string, data: ArrayBuffer) => { put(path, new Uint8Array(data)); },
        remove: async (path: string) => { files.delete(path); },
      },
      createFolder: async (path: string) => { folders.add(path); },
      createBinary: async (p: string, d: ArrayBuffer) => {
        if (files.has(p)) throw Error("exists");
        put(p, new Uint8Array(d));
      },
      process: async (f: { path: string }, fn: (s: string) => string) => {
        processCalls++;
        beforeProcess?.();
        const next = fn(text(files.get(f.path)!.data));
        put(f.path, bytes(next));
        return next;
      },
    },
  };
  const open = async (hostLifetime = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    policy = nativePolicy) => {
    const journal = await NativeTransactionJournal.open(journalFiles,
      "12345678-1234-1234-1234-123456789abc", policy);
    const vault = new loaded.GitObsidianVault(app as unknown as App, {
      get: path => modes.get(path) ?? "100644",
      set: (path, mode) => { modes.set(path, mode); },
      remove: path => { modes.delete(path); },
    }, () => { if (!active) throw new Error("Native owner retired"); }, journal, hostLifetime, policy, () => indexTick());
    return { vault, journal };
  };
  const { vault } = await open();
  return {
    vault, open,
    openView: (path: string) => { const view = new loaded.FileView(files.get(path)?.file ?? null); views.push({ view }); return view; },
    closeViews: () => { views.length = 0; },
    holdReads: () => holdReads,
    processCalls: () => processCalls,
    adapterReads,
    journalFiles,
    excludeFromIndex: (path: string) => { absentFromIndex.add(path); },
    includeInIndex: (path: string) => { absentFromIndex.delete(path); },
    addIndexGhost: (path: string) => { indexGhosts.set(path, new loaded.TFile(path, { size: 0, mtime: 1 })); },
    clearIndexGhost: (path: string) => { indexGhosts.delete(path); },
    setWrongLookup: (path: string) => { lookupOverrides.set(path, new loaded.TFile(path, { size: 0, mtime: 1 })); },
    clearLookupOverride: (path: string) => { lookupOverrides.delete(path); },
    retireOwner: () => { active = false; },
    setConfigDir: (configDir: string) => { app.vault.configDir = configDir; },
    put,
    files,
    strings,
    setReadHook: (fn?: (path: string) => void) => { afterRead = fn; },
    setJournalWriteHook: (fn?: (path: string) => void) => { journalWrite = fn; },
    setListHook: (fn?: (path: string) => Promise<void>) => { listHook = fn; },
    setQueuedRenameHook: (fn?: (from: string, to: string) => Promise<void>) => { queuedRename = fn; },
    setRenameHook: (fn?: (from: string, to: string) => void) => { afterRename = fn; },
    setIndexTickHook: (fn: () => Promise<void>) => { indexTick = fn; },
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

test("new visible file remains a durable native intent while host index omits it", async () => {
  const h = await harness();
  const next = await entryFromBytes(bytes("seed\n"));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "seed.md") h.excludeFromIndex(to);
  });
  let ticks = 0;
  h.setIndexTickHook(async () => { ticks++; });
  await assert.rejects(h.vault.apply("seed.md", null, next), /host index/);
  assert.equal(ticks, 100);
  assert.deepEqual(h.files.get("seed.md")?.data, bytes("seed\n"));
  assert.equal((await h.vault.pendingIntents())[0]?.attempted, true);
});

test("visible create waits for the same TFile in lookup and getFiles before retiring intent", async () => {
  const h = await harness();
  const next = await entryFromBytes(bytes("seed\n"));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "seed.md") h.excludeFromIndex(to);
  });
  let ticks = 0;
  h.setIndexTickHook(async () => {
    if (++ticks === 2) h.includeInIndex("seed.md");
  });
  assert.equal((await h.vault.apply("seed.md", null, next)).kind, "applied");
  assert.equal(ticks, 2);
  assert.equal((await h.vault.pendingIntents()).length, 0);
  assert.deepEqual((await h.vault.capture())["seed.md"], next);
});

test("matching path with a different host lookup object does not acknowledge create", async () => {
  const h = await harness();
  const next = await entryFromBytes(bytes("seed\n"));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "seed.md") h.setWrongLookup(to);
  });
  let ticks = 0;
  h.setIndexTickHook(async () => {
    ticks++;
    h.clearLookupOverride("seed.md");
  });
  assert.equal((await h.vault.apply("seed.md", null, next)).kind, "applied");
  assert.equal(ticks, 1);
  assert.equal((await h.vault.pendingIntents()).length, 0);
});

test("visible deletion waits for stale host index entry to disappear", async () => {
  const h = await harness();
  h.put("delete.bin", new Uint8Array([0, 255, 1]));
  const expected = (await h.vault.capture())["delete.bin"];
  h.setRenameHook((from) => {
    if (from === "delete.bin") h.addIndexGhost(from);
  });
  let ticks = 0;
  h.setIndexTickHook(async () => {
    if (++ticks === 2) h.clearIndexGhost("delete.bin");
  });
  assert.equal((await h.vault.apply("delete.bin", expected, null)).kind, "applied");
  assert.equal(ticks, 2);
  assert.equal(h.files.has("delete.bin"), false);
  assert.equal((await h.vault.pendingIntents()).length, 0);
});

test("replay also waits for host index before retiring an installed create", async () => {
  const h = await harness();
  const next = await entryFromBytes(bytes("seed\n"));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "seed.md") h.excludeFromIndex(to);
  });
  await assert.rejects(h.vault.apply("seed.md", null, next), /host index/);
  assert.equal((await h.vault.pendingIntents()).length, 1);
  let ticks = 0;
  h.setIndexTickHook(async () => {
    ticks++;
    h.includeInIndex("seed.md");
  });
  const { vault } = await h.open();
  await replayPending(vault);
  assert.equal(ticks, 1);
  assert.equal((await vault.pendingIntents()).length, 0);
  assert.deepEqual((await vault.capture())["seed.md"], next);
});

test("new visible edit during index wait keeps the native intent and edited bytes", async () => {
  const h = await harness();
  const next = await entryFromBytes(bytes("seed\n"));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "seed.md") h.excludeFromIndex(to);
  });
  h.setIndexTickHook(async () => {
    h.put("seed.md", bytes("new edit\n"));
    h.includeInIndex("seed.md");
  });
  await assert.rejects(h.vault.apply("seed.md", null, next), /Native file changed while waiting/);
  assert.equal(text(h.files.get("seed.md")!.data), "new edit\n");
  assert.equal((await h.vault.pendingIntents()).length, 1);
});

test("owner retirement during index wait leaves the attempted intent", async () => {
  const h = await harness();
  const next = await entryFromBytes(bytes("seed\n"));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "seed.md") h.excludeFromIndex(to);
  });
  h.setIndexTickHook(async () => { h.retireOwner(); });
  await assert.rejects(h.vault.apply("seed.md", null, next), /owner retired/);
  const { journal } = await h.open();
  assert.equal(journal.pending().length, 1);
});

test("hold view opened during index wait blocks retirement", async () => {
  const h = await harness();
  h.put("image.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["image.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "image.bin") h.excludeFromIndex(to);
  });
  h.setIndexTickHook(async () => {
    const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
    assert.ok(hold);
    h.openView(hold);
    h.includeInIndex("image.bin");
  });
  const result = await h.vault.apply("image.bin", expected, next);
  assert.equal(result.kind, "blocked");
  assert.equal((await h.vault.pendingIntents()).length, 1);
});

test("hold edit during index wait cannot retire displaced bytes", async () => {
  const h = await harness();
  h.put("image.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["image.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook((from, to) => {
    if (from.includes("/stage/") && to === "image.bin") h.excludeFromIndex(to);
  });
  h.setIndexTickHook(async () => {
    const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
    assert.ok(hold);
    h.put(hold, new Uint8Array([9]));
    h.includeInIndex("image.bin");
  });
  await assert.rejects(h.vault.apply("image.bin", expected, next), /Native held file changed while waiting/);
  assert.equal((await h.vault.pendingIntents()).length, 1);
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([9]));
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
  await replayPending(vault);
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
  await inspectHidden(h.vault);
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
  await replayPending(vault);
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
  await inspectHidden(h.vault);
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
  await replayPending(vault);
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

test("clean hold remains retained across host lifetimes without atomic remove-if-hash", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 1, 2]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([3, 4, 5]));
  assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const sameHost = await h.open();
  await inspectHidden(sameHost.vault);
  assert.equal(h.files.has(hold), true);
  const newHost = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await inspectHidden(newHost.vault);
  assert.equal(h.files.has(hold), true);
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
  await inspectHidden(h.vault);
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
  assert.deepEqual(await replayPending(restarted.vault), []);
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
  await inspectHidden(h.vault);
  assert.ok([...h.strings.keys()].filter(path => path.includes("/native/records/") && path.endsWith(".json")).length <= 8);
  assert.equal([...h.files.keys()].filter(path => path.includes("/hold/")).length, 12);
  const newHost = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await inspectHidden(newHost.vault);
  assert.equal([...h.files.keys()].filter(path => path.includes("/hold/")).length, 12);
});

test("finished holds are not rehashed while unchanged and are reclaimed once their bytes are held elsewhere", async () => {
  const h = await harness();
  h.vault.now = () => 1_000_000;
  h.put("a.bin", new Uint8Array([0, 1]));
  let expected = (await h.vault.capture())["a.bin"];
  const preimages: string[] = [];
  for (let value = 1; value <= 4; value++) {
    const next = await entryFromBytes(new Uint8Array([value, value + 1]));
    assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
    preimages.push(expected.oid);
    expected = next;
  }
  const holds = () => [...h.files.keys()].filter(path => path.includes("/hold/"));
  assert.equal(holds().length, 4);
  // The engine holds all but the first preimage.
  const released = preimages.slice(1);
  await h.vault.recover({ replay: [], cancel: [], released });
  const reads = h.holdReads();
  await h.vault.recover({ replay: [], cancel: [], released });
  assert.equal(h.holdReads(), reads, "unchanged holds are not reread or rehashed");
  assert.equal(holds().length, 4, "not reclaimed before the quiet period");
  // A writer that still had a replaced file open changes one hold.
  const changed = holds().find(path => h.files.get(path)!.data[0] === 2)!;
  h.files.get(changed)!.data = new Uint8Array([7, 7]);
  h.files.get(changed)!.file.stat.mtime += 1;
  h.vault.now = () => 1_000_000 + 11 * 60_000;
  const issues = await h.vault.recover({ replay: [], cancel: [], released });
  assert.deepEqual(holds().sort(), [changed, ...holds().filter(path => h.files.get(path)!.data[0] === 0)].sort(),
    "reclaims only unchanged holds whose bytes the engine holds");
  assert.ok(issues.some(issue => issue.kind === "displaced" && "found" in issue && issue.found !== null && [...Buffer.from(issue.found.data, "base64")].join() === "7,7"));
  // Without an engine authorization nothing is reclaimed, and a restart rehashes once.
  const restarted = await h.open();
  restarted.vault.now = () => 1_000_000 + 30 * 60_000;
  await restarted.vault.recover({ replay: [], cancel: [] });
  assert.equal(holds().length, 2);
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
  assert.deepEqual(await replayPending(restarted.vault), []);
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

test("capture cannot replay an intent; a durable kept choice cancels it across restarts", async () => {
  const h = await harness();
  h.put("n.md", bytes("draft to keep"));
  const expected = (await h.vault.capture())["n.md"];
  const { journal } = await h.open();
  const intent = await journal.begin("n.md", expected, null, "rename");
  const current = (await h.open()).vault;
  const before = h.strings.size;
  assert.equal((await current.capture())["n.md"].oid, expected.oid);
  assert.equal(h.strings.size, before, "capture must not persist recovery state");
  assert.deepEqual((await current.pendingIntents()).map(item => item.id), [intent.id]);
  assert.equal((await current.apply("n.md", expected, await entryFromBytes(bytes("different")))).kind, "blocked");
  const restarted = await h.open();
  await restarted.vault.recover({ replay: [], cancel: [intent.id] });
  assert.equal(text(h.files.get("n.md")!.data), "draft to keep");
  const afterCancel = await h.open();
  assert.deepEqual(await afterCancel.vault.pendingIntents(), []);
  await afterCancel.vault.recover({ replay: [], cancel: [intent.id] });
  assert.equal(text(h.files.get("n.md")!.data), "draft to keep");
});

test("attempted displacement is cancelled backward after a crash", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0, 1]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([2, 3]));
  h.setRenameHook(from => { if (from === "a.bin") throw new Error("crash after displacement"); });
  await assert.rejects(h.vault.apply("a.bin", expected, next), /crash after displacement/);
  h.setRenameHook();
  const restarted = await h.open();
  const [intent] = await restarted.vault.pendingIntents();
  assert.equal(intent.attempted, true);
  await restarted.vault.recover({ replay: [], cancel: [intent.id] });
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([0, 1]));
  assert.deepEqual(await (await h.open()).vault.pendingIntents(), []);
});

test("cancel after installation retains the selected preimage as an issue", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook(from => { if (from.includes("/stage/")) throw new Error("crash after install"); });
  await assert.rejects(h.vault.apply("a.bin", expected, next), /crash after install/);
  h.setRenameHook();
  const restarted = await h.open();
  const [intent] = await restarted.vault.pendingIntents();
  const issues = await restarted.vault.recover({ replay: [], cancel: [intent.id] });
  assert.equal(issues.some(issue => issue.kind === "displaced" && issue.found?.oid === expected.oid), true);
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
  assert.deepEqual(await (await h.open()).vault.pendingIntents(), []);
});

test("a view opened during marker persistence blocks the rename", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const file = h.files.get("a.bin")!.file;
  const expected = (await h.vault.capture())["a.bin"];
  let records = 0;
  h.setJournalWriteHook(path => {
    if (path.includes("/native/records/") && ++records === 2) h.openView("a.bin");
  });
  assert.equal((await h.vault.apply("a.bin", expected, null)).kind, "blocked");
  assert.equal(file.path, "a.bin");
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([0]));
});

test("a view opened inside the queued rename is restored before installation", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const file = h.files.get("a.bin")!.file;
  const expected = (await h.vault.capture())["a.bin"];
  h.setQueuedRenameHook(async from => { if (from === "a.bin") h.openView("a.bin"); });
  assert.equal((await h.vault.apply("a.bin", expected, null)).kind, "blocked");
  assert.equal(file.path, "a.bin");
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([0]));
  assert.equal((await h.vault.pendingIntents())[0].attempted, false);
  h.closeViews();
  h.setQueuedRenameHook();
  assert.equal((await h.vault.apply("a.bin", expected, null)).kind, "applied");
  assert.deepEqual(await h.vault.pendingIntents(), []);
});

for (const choice of ["replay", "cancel"] as const) {
  test(`a view opened during queued installation keeps ${choice} pending with its dirty hold`, async () => {
    const h = await harness();
    h.put("a.bin", new Uint8Array([0]));
    const oldFile = h.files.get("a.bin")!.file;
    const expected = (await h.vault.capture())["a.bin"];
    const next = await entryFromBytes(new Uint8Array([1]));
    h.setQueuedRenameHook(async from => {
      if (from.includes("/stage/")) h.openView(oldFile.path);
    });
    const result = await h.vault.apply("a.bin", expected, next);
    assert.equal(result.kind, "blocked");
    assert.match(result.kind === "blocked" ? result.reason : "", /a\.bin/);
    const hold = oldFile.path;
    assert.match(hold, /\/hold\//);
    assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
    assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
    const [intent] = await h.vault.pendingIntents();
    assert.equal(intent.attempted, true);
    assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "blocked");
    h.put(hold, bytes("unsaved editor draft flushed to hold"));
    const restarted = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    await restarted.vault.recover({ replay: choice === "replay" ? [intent.id] : [],
      cancel: choice === "cancel" ? [intent.id] : [] });
    assert.deepEqual((await restarted.vault.pendingIntents()).map(item => item.id), [intent.id]);
    assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
    assert.equal(text(h.files.get(hold)!.data), "unsaved editor draft flushed to hold");
    h.closeViews();
    const afterClose = await h.open("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const issues = await afterClose.vault.recover({ replay: choice === "replay" ? [intent.id] : [],
      cancel: choice === "cancel" ? [intent.id] : [] });
    assert.deepEqual(await afterClose.vault.pendingIntents(), []);
    assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
    assert.equal(text(h.files.get(hold)!.data), "unsaved editor draft flushed to hold");
    assert.ok(issues.some(issue => issue.kind === "displaced" && issue.sourcePath === hold
      && issue.found?.data === Buffer.from(bytes("unsaved editor draft flushed to hold")).toString("base64")));
    if (choice === "cancel")
      assert.ok(issues.some(issue => issue.kind === "displaced" && issue.found?.oid === expected.oid));
  });
}

test("replay final fast path waits for an open hold before settling exact bytes", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook(from => { if (from.includes("/stage/")) throw new Error("crash after install"); });
  await assert.rejects(h.vault.apply("a.bin", expected, next), /crash after install/);
  h.setRenameHook();
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  h.openView(hold);
  const restarted = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const [intent] = await restarted.vault.pendingIntents();
  await restarted.vault.recover({ replay: [intent.id], cancel: [] });
  assert.deepEqual((await restarted.vault.pendingIntents()).map(item => item.id), [intent.id]);
  assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
  h.closeViews();
  await restarted.vault.recover({ replay: [intent.id], cancel: [] });
  assert.deepEqual(await restarted.vault.pendingIntents(), []);
  assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
});

test("cancel rechecks a hold view opened while retaining recovery evidence", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook(from => { if (from.includes("/stage/")) throw new Error("crash after install"); });
  await assert.rejects(h.vault.apply("a.bin", expected, next), /crash after install/);
  h.setRenameHook();
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const restarted = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const [intent] = await restarted.vault.pendingIntents();
  let writes = 0;
  h.setJournalWriteHook(path => {
    if (path.includes("/native/records/") && ++writes === 1) h.openView(hold);
  });
  await restarted.vault.recover({ replay: [], cancel: [intent.id] });
  h.setJournalWriteHook();
  assert.deepEqual((await restarted.vault.pendingIntents()).map(item => item.id), [intent.id]);
  assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
  assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([1]));
  h.closeViews();
  await restarted.vault.recover({ replay: [], cancel: [intent.id] });
  assert.deepEqual(await restarted.vault.pendingIntents(), []);
});

test("a late write during clean-hold inspection is retained and then raised", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const restarted = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  h.setReadHook(path => { if (path === hold) { h.setReadHook(); h.put(path, bytes("late draft")); } });
  await inspectHidden(restarted.vault);
  assert.equal(text(h.files.get(hold)!.data), "late draft");
  await inspectHidden(restarted.vault);
  assert.equal(restarted.vault.nativeRecoveries().some(item => item.kind === "displaced" && item.sourcePath === hold), true);
});

test("oversize source can be inspected, exported, acknowledged and rediscovered after a new edit", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  await h.vault.apply("a.bin", expected, next);
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const large = new Uint8Array(8 * 1024 * 1024 + 1); large[large.length - 1] = 7;
  h.put(hold, large);
  const restarted = await h.open("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const issues = await inspectHidden(restarted.vault);
  const record = restarted.vault.nativeRecoveries().find(item => item.kind === "oversize");
  assert.ok(record && record.kind === "oversize");
  assert.equal(issues.some(item => item.kind === "oversize" && item.id === record.id), true);
  const inspection = await restarted.vault.inspectOversize(record.id);
  assert.equal(inspection.recovery.sourcePath, hold);
  assert.equal(inspection.currentSize, large.length);
  await assert.rejects(restarted.vault.exportOversize(record.id, "recovered.bin"), /dedicated hidden directory/);
  const existing = `.git-vault-sync-export-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/existing.bin`;
  h.put(existing, bytes("existing export"));
  await assert.rejects(restarted.vault.exportOversize(record.id, existing), /destination exists/);
  assert.equal(text(h.files.get(existing)!.data), "existing export");
  const raced = `.git-vault-sync-export-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/raced.bin`;
  h.setBeforeRenameHook((_from, to) => { if (to === raced) h.put(to, bytes("racing writer")); });
  await assert.rejects(restarted.vault.exportOversize(record.id, raced), /no-clobber/);
  h.setBeforeRenameHook();
  assert.equal(text(h.files.get(raced)!.data), "racing writer");
  assert.deepEqual(h.files.get(hold)!.data, large);
  const output = `.git-vault-sync-export-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/recovered.bin`;
  assert.deepEqual(await restarted.vault.exportOversize(record.id, output), { path: output, size: large.length });
  assert.deepEqual(h.files.get(output)!.data, large);
  assert.deepEqual(h.files.get(hold)!.data, large);
  assert.deepEqual(Object.keys(await restarted.vault.capture()), ["a.bin"]);
  const storage = await restarted.vault.retainedHiddenSummary();
  assert.equal(storage.holds, 1);
  assert.ok(storage.bytes >= large.length);
  await restarted.vault.acknowledgeOversize(record.id);
  const reopened = await h.open("cccccccc-cccc-cccc-cccc-cccccccccccc");
  await inspectHidden(reopened.vault);
  assert.equal(reopened.vault.nativeRecoveries().some(item => item.kind === "oversize"), false);
  assert.equal((await reopened.vault.apply("a.bin", next, null)).kind, "applied");
  large[0] = 9; h.put(hold, large);
  await inspectHidden(reopened.vault);
  assert.equal(reopened.vault.nativeRecoveries().some(item => item.kind === "oversize"), true);
});

test("oversize arising in a pending intent can be acknowledged and cancelled without losing source", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook(from => { if (from === "a.bin") throw new Error("crash after hold"); });
  await assert.rejects(h.vault.apply("a.bin", expected, next), /crash after hold/);
  h.setRenameHook();
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const large = new Uint8Array(8 * 1024 * 1024 + 1); large[3] = 5;
  h.put(hold, large);
  const restarted = await h.open();
  const [intent] = await restarted.vault.pendingIntents();
  await restarted.vault.recover({ replay: [intent.id], cancel: [] });
  const record = restarted.vault.nativeRecoveries().find(item => item.kind === "oversize");
  assert.ok(record && record.kind === "oversize");
  assert.equal((await restarted.vault.apply("other.bin", null, next)).kind, "applied");
  const output = (await restarted.vault.exportOversize(record.id)).path;
  assert.match(output, /^\.git-vault-sync-export-[0-9a-f-]{36}\//);
  await restarted.vault.acknowledgeOversize(record.id);
  await restarted.vault.recover({ replay: [], cancel: [intent.id] });
  assert.deepEqual(await restarted.vault.pendingIntents(), []);
  assert.equal((await restarted.vault.apply("a.bin", null, next)).kind, "applied");
  assert.deepEqual(h.files.get(hold)!.data, large);
  assert.deepEqual(h.files.get(output)!.data, large);
});

test("read-only scan reports a visible oversized file while capturing unrelated files", async () => {
  const h = await harness();
  const large = new Uint8Array(8 * 1024 * 1024 + 1); large[0] = 4;
  h.put("huge.bin", large);
  h.put("other.md", bytes("unrelated"));
  const before = h.strings.size;
  const survey = await h.vault.scan();
  assert.deepEqual(Object.keys(survey.files), ["other.md"]);
  assert.deepEqual(survey.unreadable.map(item => ({ path: item.path, size: item.size, reason: item.reason })),
    [{ path: "huge.bin", size: large.length, reason: "oversize" }]);
  assert.equal(h.strings.size, before);
  assert.deepEqual(h.files.get("huge.bin")!.data, large);
  await assert.rejects(h.vault.capture(), /File exceeds 8 MiB/);
});

test("case-only visible aliases are both captured so the engine can report a collision", async () => {
  const h = await harness();
  h.put("Note.md", bytes("upper"));
  h.put("note.md", bytes("lower"));
  const survey = await h.vault.scan();
  assert.deepEqual(Object.keys(survey.files).sort(), ["Note.md", "note.md"]);
});

test("an oversized source changed before acknowledgement requires a fresh record", async () => {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  await h.vault.apply("a.bin", expected, next);
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const large = new Uint8Array(8 * 1024 * 1024 + 1);
  h.put(hold, large);
  await inspectHidden(h.vault);
  const first = h.vault.nativeRecoveries().find(item => item.kind === "oversize");
  assert.ok(first);
  large[0] = 8; h.put(hold, large);
  await assert.rejects(h.vault.acknowledgeRecovery([first.id]), /source changed/);
  await inspectHidden(h.vault);
  const second = h.vault.nativeRecoveries().find(item => item.kind === "oversize");
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  await h.vault.acknowledgeRecovery([second.id]);
  assert.equal(h.vault.nativeRecoveries().some(item => item.kind === "oversize"), false);
  assert.deepEqual(h.files.get(hold)!.data, large);
});

async function interruptedBinaryIntent() {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  h.setRenameHook(from => { if (from === "a.bin") throw new Error("crash after displacement"); });
  await assert.rejects(h.vault.apply("a.bin", expected, next), /crash after displacement/);
  h.setRenameHook();
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  return { h, hold, expected, next };
}

for (const authorization of ["replay", "cancel"] as const) {
  test(`oversized visible source blocks pending ${authorization} locally and keeps authorization recoverable`, async () => {
    const { h, hold, next } = await interruptedBinaryIntent();
    const large = new Uint8Array(8 * 1024 * 1024 + 1);
    large[0] = 8;
    h.put("a.bin", large);
    h.setReadHook(path => { if (path === "a.bin") throw new Error("oversized bytes were read"); });
    for (let restart = 0; restart < 2; restart++) {
      const { vault } = await h.open();
      const [intent] = await vault.pendingIntents();
      assert.ok(intent);
      const issues = await vault.recover({ replay: authorization === "replay" ? [intent.id] : [],
        cancel: authorization === "cancel" ? [intent.id] : [] });
      assert.equal(issues.some(issue => issue.kind === "oversize" && issue.sourcePath === "a.bin"), true);
      assert.equal((await vault.pendingIntents())[0].id, intent.id);
      assert.deepEqual(h.files.get("a.bin")!.data, large);
      assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
      assert.equal((await vault.scan()).unreadable[0].path, "a.bin");
      if (restart === 0) assert.equal((await vault.apply("other.bin", null, next)).kind, "applied");
    }
    h.setReadHook();
    const { vault } = await h.open();
    const old = vault.nativeRecoveries().find(issue => issue.kind === "oversize" && issue.sourcePath === "a.bin");
    assert.ok(old);
    h.put("a.bin", new Uint8Array([9]));
    const [intent] = await vault.pendingIntents();
    const fresh = await vault.recover({ replay: authorization === "replay" ? [intent.id] : [],
      cancel: authorization === "cancel" ? [intent.id] : [] });
    const replacement = await entryFromBytes(new Uint8Array([9]));
    assert.equal(fresh.some(issue => issue.kind === "interrupted" && issue.found?.oid === replacement.oid), true);
    assert.equal((await vault.pendingIntents()).length, 1);
    await assert.rejects(vault.acknowledgeRecovery([old.id]), /source changed/);
    assert.deepEqual(h.files.get("a.bin")!.data, new Uint8Array([9]));
  });
}

test("pending visible source revalidates after an acknowledged oversized version shrinks", async () => {
  const { h, hold } = await interruptedBinaryIntent();
  h.put("a.bin", new Uint8Array(8 * 1024 * 1024 + 1));
  const vault = (await h.open()).vault;
  const [intent] = await vault.pendingIntents();
  await vault.recover({ replay: [intent.id], cancel: [] });
  const old = vault.nativeRecoveries().find(issue => issue.kind === "oversize" && issue.sourcePath === "a.bin");
  assert.ok(old);
  await vault.acknowledgeOversize(old.id);
  h.put("a.bin", new Uint8Array([0]));
  const fresh = await vault.recover({ replay: [intent.id], cancel: [] });
  assert.equal(fresh.some(issue => issue.kind === "interrupted" && issue.found?.data === "AA=="), true);
  assert.equal((await vault.pendingIntents()).length, 1);
  assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
});

for (const authorization of ["replay", "cancel"] as const) {
  test(`late visible growth during pending ${authorization} stays path-local`, async () => {
    const { h, hold, next } = await interruptedBinaryIntent();
    h.put("a.bin", new Uint8Array([9]));
    const large = new Uint8Array(8 * 1024 * 1024 + 1);
    h.setReadHook(path => { if (path === "a.bin") { h.setReadHook(); h.put(path, large); } });
    const vault = (await h.open()).vault;
    const [intent] = await vault.pendingIntents();
    const issues = await vault.recover({ replay: authorization === "replay" ? [intent.id] : [],
      cancel: authorization === "cancel" ? [intent.id] : [] });
    assert.equal(issues.some(issue => issue.kind === "oversize" && issue.sourcePath === "a.bin"), true);
    assert.equal((await vault.pendingIntents()).length, 1);
    assert.deepEqual(h.files.get("a.bin")!.data, large);
    assert.deepEqual(h.files.get(hold)!.data, new Uint8Array([0]));
    assert.equal((await vault.apply("other.bin", null, next)).kind, "applied");
  });
}

async function retainedOversizeSource() {
  const h = await harness();
  h.put("a.bin", new Uint8Array([0]));
  const expected = (await h.vault.capture())["a.bin"];
  const next = await entryFromBytes(new Uint8Array([1]));
  assert.equal((await h.vault.apply("a.bin", expected, next)).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const large = new Uint8Array(8 * 1024 * 1024 + 1);
  large[0] = 7;
  h.put(hold, large);
  await inspectHidden(h.vault);
  const old = h.vault.nativeRecoveries().find(issue => issue.kind === "oversize" && issue.sourcePath === hold);
  assert.ok(old);
  const exported = await h.vault.exportOversize(old.id);
  assert.deepEqual(h.files.get(exported.path)!.data, large);
  return { h, hold, old, exported, large };
}

for (const change of ["missing", "readable"] as const) {
  test(`retained oversized source becoming ${change} replaces stale metadata with durable evidence`, async () => {
    const { h, hold, old, exported, large } = await retainedOversizeSource();
    const replacement = bytes("new readable hidden draft");
    if (change === "missing") h.files.delete(hold);
    else h.put(hold, replacement);
    const issues = await inspectHidden(h.vault);
    assert.equal(issues.some(issue => issue.id === old.id), false);
    const fresh = h.vault.nativeRecoveries().find(issue => issue.sourcePath === hold && issue.kind === "displaced");
    assert.ok(fresh && fresh.kind === "displaced");
    assert.deepEqual(fresh.found, change === "missing" ? null : await entryFromBytes(replacement));
    await assert.rejects(h.vault.acknowledgeRecovery([old.id]), /source changed/);
    const reopened = (await h.open()).vault;
    const persisted = reopened.nativeRecoveries().find(issue => issue.id === fresh.id);
    assert.equal(persisted?.id, fresh.id);
    assert.equal(persisted?.kind, fresh.kind);
    if (persisted?.kind === "displaced") assert.deepEqual(persisted.found?.data ?? null, fresh.found?.data ?? null);
    await reopened.acknowledgeRecovery([fresh.id]);
    assert.equal(reopened.nativeRecoveries().some(issue => issue.sourcePath === hold), false);
    assert.deepEqual(h.files.get(exported.path)!.data, large);
    if (change === "readable") assert.deepEqual(h.files.get(hold)!.data, replacement);
    else {
      assert.equal(h.files.has(hold), false);
      h.put(hold, new Uint8Array([0]));
      await inspectHidden(reopened);
      const reappeared = reopened.nativeRecoveries().find(issue => issue.sourcePath === hold && issue.kind === "displaced");
      assert.ok(reappeared && reappeared.kind === "displaced");
      assert.equal(reappeared.found?.data, "AA==");
    }
  });
}

for (const change of ["missing", "restored-preimage"] as const) {
  test(`acknowledged oversized source becoming ${change} still requires fresh evidence`, async () => {
    const { h, hold, old } = await retainedOversizeSource();
    await h.vault.acknowledgeOversize(old.id);
    if (change === "missing") h.files.delete(hold);
    else h.put(hold, new Uint8Array([0]));
    await inspectHidden(h.vault);
    const fresh = h.vault.nativeRecoveries().find(issue => issue.sourcePath === hold);
    assert.ok(fresh && fresh.kind === "displaced");
    assert.equal(fresh.found?.data ?? null, change === "missing" ? null : "AA==");
    assert.notEqual(fresh.id, old.id);
    const reopened = (await h.open()).vault;
    assert.equal(reopened.nativeRecoveries().some(issue => issue.id === fresh.id), true);
  });
}

test("missing retained source reappearing before consent invalidates its missing issue", async () => {
  const { h, hold } = await retainedOversizeSource();
  h.files.delete(hold);
  await inspectHidden(h.vault);
  const missing = h.vault.nativeRecoveries().find(issue => issue.sourcePath === hold && issue.kind === "displaced");
  assert.ok(missing && missing.kind === "displaced" && missing.found === null);
  h.put(hold, new Uint8Array([0]));
  await inspectHidden(h.vault);
  const reappeared = h.vault.nativeRecoveries().find(issue => issue.sourcePath === hold && issue.kind === "displaced");
  assert.ok(reappeared && reappeared.kind === "displaced");
  assert.notEqual(reappeared.id, missing.id);
  assert.equal(reappeared.found?.data, "AA==");
  await assert.rejects(h.vault.acknowledgeRecovery([missing.id]), /source changed/);
});

for (const boundary of ["before-write", "after-record-rename"] as const) {
  test(`oversize metadata supersession survives ${boundary} interruption`, async () => {
    const { h, hold, old } = await retainedOversizeSource();
    const replacement = bytes("new hidden bytes after export");
    h.put(hold, replacement);
    if (boundary === "before-write") h.setJournalWriteHook(path => {
      if (path.includes("/native/records/")) throw new Error("crash before replacement record");
    });
    else h.setRenameHook((_from, to) => {
      if (to.includes("/native/records/")) throw new Error("crash after replacement record");
    });
    await assert.rejects(inspectHidden(h.vault), /crash/);
    h.setJournalWriteHook();
    h.setRenameHook();
    const reopened = (await h.open()).vault;
    const durable = reopened.nativeRecoveries();
    assert.equal(durable.some(issue => issue.id === old.id), boundary === "before-write");
    if (boundary === "before-write") await inspectHidden(reopened);
    const fresh = reopened.nativeRecoveries().find(issue => issue.sourcePath === hold && issue.kind === "displaced");
    assert.ok(fresh && fresh.kind === "displaced");
    assert.equal(fresh.found?.data, (await entryFromBytes(replacement)).data);
    assert.equal(reopened.nativeRecoveries().some(issue => issue.id === old.id), false);
    await assert.rejects(reopened.acknowledgeRecovery([old.id]), /source changed/);
    assert.deepEqual(h.files.get(hold)!.data, replacement);
  });
}

async function configScope(gitignore: string | null = null) {
  return compileScope({ rules: "config/1", configDir: ".obsidian",
    gitignore: gitignore === null ? null : await hashBlob(bytes(gitignore)) }, gitignore);
}

test("scoped capture combines visible and adapter-only configuration while legacy remains visible", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  h.put("note.md", bytes("note"));
  h.put(".gitignore", bytes("*.tmp\n"));
  h.put(".obsidian/app.json", bytes('{"theme":"dark"}'));
  h.put(".obsidian/plugins/example/data.json", bytes('{"enabled":true}'));
  h.put(".obsidian/workspace.json", bytes("private workspace"));
  h.put(".obsidian/plugins/github-vault-sync/data.json", bytes("private sync state"));
  assert.deepEqual(Object.keys(await h.vault.capture()), ["note.md"]);
  h.adapterReads.length = 0;
  const captured = await h.vault.capture(await configScope());
  assert.deepEqual(Object.keys(captured).sort(), [".gitignore", ".obsidian/app.json",
    ".obsidian/plugins/example/data.json", "note.md"]);
  assert.equal(h.adapterReads.includes(".obsidian/workspace.json"), false);
  assert.equal(h.adapterReads.includes(".obsidian/plugins/github-vault-sync/data.json"), false);
});

test("hidden configuration and root ignore apply by adapter rename, retain holds, and survive restart", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const path = ".obsidian/app.json";
  const before = await entryFromBytes(bytes("old")), next = await entryFromBytes(bytes("new"));
  h.put(path, bytes("old"));
  assert.equal((await h.vault.apply(path, before, next)).kind, "applied");
  assert.deepEqual(h.files.get(path)?.data, bytes("new"));
  assert.ok([...h.files.keys()].some(name => name.includes("/hold/")));
  assert.equal(h.processCalls(), 0);
  const restarted = (await h.open()).vault;
  assert.equal((await restarted.scan(await configScope())).files[path].oid, next.oid);
  assert.equal((await restarted.apply(path, next, null)).kind, "applied");
  assert.equal(h.files.has(path), false);
  const ignore = await entryFromBytes(bytes("*.tmp\n"));
  assert.equal((await restarted.apply(".gitignore", null, ignore)).kind, "applied");
  assert.deepEqual(h.files.get(".gitignore")?.data, bytes("*.tmp\n"));
  assert.equal(h.processCalls(), 0);
});

test("hidden replay resumes after displacement crash without clobber or TFile process", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const path = ".obsidian/app.json";
  const before = await entryFromBytes(bytes("before")), next = await entryFromBytes(bytes("after"));
  h.put(path, bytes("before"));
  h.setRenameHook(from => { if (from === path) throw new Error("crash after hidden displacement"); });
  await assert.rejects(h.vault.apply(path, before, next), /crash after hidden displacement/);
  assert.equal(h.files.has(path), false);
  h.setRenameHook();
  const restarted = (await h.open()).vault;
  await replayPending(restarted);
  assert.deepEqual(h.files.get(path)?.data, bytes("after"));
  assert.equal(h.processCalls(), 0);
});

test("hidden replay preserves a destination created during the crash window", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const path = ".obsidian/app.json";
  const before = await entryFromBytes(bytes("before")), next = await entryFromBytes(bytes("after"));
  h.put(path, bytes("before"));
  h.setRenameHook(from => { if (from === path) throw new Error("crash after hidden displacement"); });
  await assert.rejects(h.vault.apply(path, before, next), /crash after hidden displacement/);
  h.setRenameHook();
  h.put(path, bytes("new local edit"));
  const restarted = (await h.open()).vault;
  await replayPending(restarted);
  assert.deepEqual(h.files.get(path)?.data, bytes("new local edit"));
  assert.ok(restarted.nativeRecoveries().some(issue => issue.path === path && issue.kind === "interrupted"));
});

for (const choice of ["replay", "cancel"] as const) {
  test(`oversized hidden source blocks pending ${choice} locally and keeps its bytes`, async () => {
    const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
    const path = ".obsidian/app.json";
    const before = await entryFromBytes(bytes("before")), next = await entryFromBytes(bytes("after"));
    h.put(path, bytes("before"));
    h.setBeforeRenameHook(from => { if (from === path) throw new Error("before hidden displacement"); });
    await assert.rejects(h.vault.apply(path, before, next), /before hidden displacement/);
    h.setBeforeRenameHook();
    const large = new Uint8Array(8 * 1024 * 1024 + 1);
    h.put(path, large);
    const restarted = (await h.open()).vault;
    const [intent] = await restarted.pendingIntents();
    await restarted.recover({ replay: choice === "replay" ? [intent.id] : [],
      cancel: choice === "cancel" ? [intent.id] : [] });
    assert.deepEqual(h.files.get(path)?.data, large);
    assert.equal((await restarted.pendingIntents()).length, 1);
    assert.ok(restarted.nativeRecoveries().some(issue => issue.kind === "oversize" && issue.path === path));
    assert.equal((await restarted.apply("unrelated.md", null,
      await entryFromBytes(bytes("progress")))).kind, "applied");
  });
}

test("retained oversized hidden hold becoming missing durably replaces stale metadata", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const path = ".obsidian/app.json";
  const before = await entryFromBytes(new Uint8Array([0, 255]));
  const next = await entryFromBytes(new Uint8Array([1, 254]));
  h.put(path, new Uint8Array([0, 255]));
  assert.equal((await h.vault.apply(path, before, next)).kind, "applied");
  const hold = [...h.files.keys()].find(name => name.includes("/hold/"));
  assert.ok(hold);
  h.put(hold, new Uint8Array(8 * 1024 * 1024 + 1));
  await inspectHidden(h.vault);
  const old = h.vault.nativeRecoveries().find(issue => issue.kind === "oversize" && issue.sourcePath === hold);
  assert.ok(old);
  h.files.delete(hold);
  const restarted = (await h.open()).vault;
  await inspectHidden(restarted);
  const missing = restarted.nativeRecoveries().find(issue => issue.sourcePath === hold && issue.kind === "displaced");
  assert.ok(missing && missing.kind === "displaced" && missing.found === null);
  assert.equal(restarted.nativeRecoveries().some(issue => issue.id === old.id), false);
  await assert.rejects(restarted.acknowledgeRecovery([old.id]), /source changed/);
  assert.deepEqual(h.files.get(path)?.data, new Uint8Array([1, 254]));
});

test("ignored confidential paths are inventoried by name but never read", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  h.put(".obsidian/app.json", bytes("included"));
  h.put(".obsidian/private.txt", bytes("confidential"));
  h.put("content/private.bin", bytes("confidential"));
  h.put("content/public.bin", bytes("public"));
  h.setReadHook(path => {
    if (path.endsWith("private.txt") || path.endsWith("private.bin")) throw new Error("ignored bytes read");
  });
  const result = await h.vault.scan(await configScope(".obsidian/private.txt\ncontent/private.bin\n"));
  assert.deepEqual(Object.keys(result.files).sort(), [".obsidian/app.json", "content/public.bin"]);
  assert.equal(h.adapterReads.some(path => path.endsWith("private.txt") || path.endsWith("private.bin")), false);
});

test("nested ignore in an ordinary content directory blocks before byte reads", async () => {
  for (const control of [".gitignore", ".GITIGNORE", ".ＧＩＴＩＧＮＯＲＥ"]) {
    const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
    h.put("note.md", bytes("safe"));
    h.put(`ordinary/deep/${control}`, bytes("*.md\n"));
    await assert.rejects(h.vault.scan(await configScope()), /Nested .gitignore/);
    assert.deepEqual(h.adapterReads, []);
  }
});

test("hidden and visible bytes share one 128 MiB capture limit", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const chunk = new Uint8Array(8 * 1024 * 1024);
  for (let index = 0; index < 16; index++) h.put(`.obsidian/part-${index}.bin`, chunk);
  h.put("one.md", bytes("x"));
  await assert.rejects(h.vault.scan(await configScope()), /Vault content exceeds the 128 MiB safety limit/);
  assert.equal(h.adapterReads.includes("one.md"), true);
});

test("case and Unicode aliases across excluded names and path prefixes block scoped capture and apply", async () => {
  for (const pair of [
    [".obsidian/app.json", ".OBSIDIAN/app.json", null],
    ["Docs/keep.md", "docs/secret.txt", "docs/secret.txt\n"],
    ["Notes/Ａ.md", "Notes/A.md", "Notes/A.md\n"],
  ] as const) {
    const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
    h.put(pair[0], bytes("included"));
    h.put(pair[1], bytes("excluded"));
    await assert.rejects(h.vault.scan(await configScope(pair[2])), /Case or Unicode path collision/);
    assert.deepEqual(h.adapterReads, []);
    await assert.rejects(h.vault.apply(pair[0], null, await entryFromBytes(bytes("remote"))),
      /Case or Unicode path collision/);
    assert.deepEqual(h.files.get(pair[0])?.data, bytes("included"));
  }
});

test("legacy journal refuses config scope and configured journal refuses another binding", async () => {
  const policy = await NativePathPolicy.forConfig(".obsidian");
  const legacy = await harness();
  legacy.put("note.bin", bytes("old"));
  await legacy.vault.apply("note.bin", await entryFromBytes(bytes("old")),
    await entryFromBytes(bytes("new")));
  await assert.rejects(legacy.open(undefined, policy), /policy does not match/);
  await assert.rejects(legacy.vault.apply(".obsidian/app.json", null,
    await entryFromBytes(bytes("hidden"))), /Unsupported vault path/);
  const configured = await harness(undefined, policy);
  configured.put(".obsidian/app.json", bytes("old"));
  await configured.vault.apply(".obsidian/app.json", await entryFromBytes(bytes("old")),
    await entryFromBytes(bytes("new")));
  await assert.rejects(configured.open(undefined, NativePathPolicy.legacy), /policy does not match/);
  configured.setConfigDir(".settings");
  await assert.rejects(configured.open(), /configuration directory does not match/);
  await assert.rejects(configured.vault.apply(".obsidian/app.json", null,
    await entryFromBytes(bytes("changed"))), /configuration directory does not match/);
});

test("reviewed policy upgrade retains the same journal and historical native holds", async () => {
  const h = await harness();
  const before = new Uint8Array([0, 255]), next = new Uint8Array([1, 254]);
  h.put("note.bin", before);
  assert.equal((await h.vault.apply("note.bin", await entryFromBytes(before),
    await entryFromBytes(next))).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const policy = await NativePathPolicy.forConfig(".obsidian");
  const { journal } = await h.open();
  let checked = false;
  await journal.upgradePolicy(policy, async () => { checked = true; });
  assert.equal(checked, true);
  assert.equal(journal.matchesPolicy(policy), true);
  assert.deepEqual(h.files.get(hold)?.data, before);
  const configured = await h.open(undefined, policy);
  assert.ok(configured.journal.trackedPaths().includes(hold));
  assert.deepEqual(h.files.get(hold)?.data, before);
  await assert.rejects(h.open(), /policy does not match/);
  assert.equal((await configured.vault.apply(".obsidian/app.json", null,
    await entryFromBytes(bytes("ready")))).kind, "applied");
});

test("policy upgrade requires the durable review gate and no unresolved intent or issue", async () => {
  const h = await harness();
  const policy = await NativePathPolicy.forConfig(".obsidian");
  const { journal } = await h.open();
  await assert.rejects(journal.upgradePolicy(policy, async () => { throw new Error("review pause absent"); }),
    /review pause absent/);
  await assert.rejects(h.open(undefined, policy), /policy does not match/);
  const before = await entryFromBytes(bytes("old")), next = await entryFromBytes(bytes("new"));
  await journal.begin("note.bin", before, next, "rename");
  await assert.rejects(journal.upgradePolicy(policy, async () => {}), /Resolve native intents/);
  await journal.cancel("note.bin");
  const issue = await journal.retainBytes(bytes("evidence"), "note.bin", "historical-source", "displaced", null, null);
  await assert.rejects(journal.upgradePolicy(policy, async () => {}), /Resolve native intents/);
  await journal.acknowledge([issue.id]);
  await journal.upgradePolicy(policy, async () => {});
  assert.equal((await h.open(undefined, policy)).journal.matchesPolicy(policy), true);
});

test("policy upgrade checks historical paths and physical stage files at commit time", async () => {
  const h = await harness();
  const before = new Uint8Array([0, 255]), next = new Uint8Array([1, 254]);
  h.put("Thumbs.db", before);
  await h.vault.apply("Thumbs.db", await entryFromBytes(before),
    await entryFromBytes(next));
  const { journal } = await h.open();
  const policy = await NativePathPolicy.forConfig(".obsidian");
  await assert.rejects(journal.upgradePolicy(policy, async () => {}), /outside configuration policy/);
  assert.equal(journal.matchesPolicy(NativePathPolicy.legacy), true);
  const clean = await harness();
  const opened = await clean.open();
  const untracked = `${opened.journal.root}/stage/${crypto.randomUUID()}`;
  clean.put(untracked, bytes("untracked"));
  await assert.rejects(opened.journal.upgradePolicy(policy, async () => {}), /Untracked native stage/);
  assert.deepEqual(clean.files.get(untracked)?.data, bytes("untracked"));
});

for (const boundary of ["before-write", "after-record-rename"] as const) {
  test(`policy upgrade resolves ${boundary} interruption from durable binding`, async () => {
    const h = await harness();
    const policy = await NativePathPolicy.forConfig(".obsidian");
    const { journal } = await h.open();
    if (boundary === "before-write") h.setJournalWriteHook(path => {
      if (path.includes("/native/records/")) throw new Error("upgrade crash before record");
    });
    else h.setRenameHook((_from, to) => {
      if (to.includes("/native/records/")) throw new Error("upgrade crash after record");
    });
    await assert.rejects(journal.upgradePolicy(policy, async () => {}), /upgrade crash/);
    assert.throws(() => journal.pending(), /persistence is uncertain/);
    h.setJournalWriteHook();
    h.setRenameHook();
    if (boundary === "before-write") {
      await assert.rejects(h.open(undefined, policy), /policy does not match/);
      const legacy = await h.open();
      await legacy.journal.upgradePolicy(policy, async () => {});
    } else await assert.rejects(h.open(), /policy does not match/);
    assert.equal((await h.open(undefined, policy)).journal.matchesPolicy(policy), true);
  });
}

test("a protected directory alias introduced after a hidden crash blocks replay", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const path = ".obsidian/app.json";
  const before = await entryFromBytes(bytes("before")), next = await entryFromBytes(bytes("after"));
  h.put(path, bytes("before"));
  h.setRenameHook(from => { if (from === path) throw new Error("crash after hidden displacement"); });
  await assert.rejects(h.vault.apply(path, before, next), /crash after hidden displacement/);
  h.setRenameHook();
  h.put(".OBSIDIAN/foreign.json", bytes("foreign"));
  const restarted = (await h.open()).vault;
  await assert.rejects(replayPending(restarted), /Case or Unicode path collision/);
  assert.equal(h.files.has(path), false);
  assert.deepEqual(h.files.get(".OBSIDIAN/foreign.json")?.data, bytes("foreign"));
  assert.equal((await restarted.pendingIntents()).length, 1);
});

test("oversized scoped config can export only under a dedicated hidden recovery directory", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const source = ".obsidian/app.json";
  const large = new Uint8Array(8 * 1024 * 1024 + 1);
  h.put(source, large);
  const { vault, journal } = await h.open();
  const record = await journal.retainOversize(source, source, null, null, large.length, 1);
  assert.ok(record);
  const output = `.git-vault-sync-export-${crypto.randomUUID()}/.obsidian/app.json`;
  const exported = await vault.exportOversize(record.id, output);
  assert.equal(exported.path, output);
  assert.deepEqual(h.files.get(output)?.data, large);
  assert.deepEqual(h.files.get(source)?.data, large);
  await assert.rejects(vault.exportOversize(record.id,
    `.git-vault-sync-export-${crypto.randomUUID()}/.obsidian/workspace.json`), /Unsupported vault path/);
  await assert.rejects(vault.exportOversize(record.id,
    `.git-vault-sync-export-${crypto.randomUUID()}/.git-vault-sync/state.json`), /Unsupported vault path/);
});

test("export rejects a relocated root ignore control before copying and leaves scoped scans usable", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  const before = await entryFromBytes(bytes("old-pattern\n"));
  const next = await entryFromBytes(bytes("new-pattern\n"));
  h.put(".gitignore", bytes("old-pattern\n"));
  assert.equal((await h.vault.apply(".gitignore", before, next)).kind, "applied");
  const hold = [...h.files.keys()].find(path => path.includes("/hold/"));
  assert.ok(hold);
  const large = new Uint8Array(8 * 1024 * 1024 + 1);
  h.put(hold, large);
  await inspectHidden(h.vault);
  const issue = h.vault.nativeRecoveries().find(record => record.kind === "oversize" && record.sourcePath === hold);
  assert.ok(issue);
  const directory = `.git-vault-sync-export-${crypto.randomUUID()}`;
  for (const name of [".gitignore", ".GITIGNORE"]) {
    await assert.rejects(h.vault.exportOversize(issue.id, `${directory}/${name}`), /Nested .gitignore/);
  }
  assert.equal([...h.files.keys()].some(path => path.startsWith(`${directory}/`)), false);
  assert.deepEqual(h.files.get(hold)?.data, large);
  const safeOutput = `${directory}/gitignore-recovery.bin`;
  assert.equal((await h.vault.exportOversize(issue.id, safeOutput)).path, safeOutput);
  const reopened = (await h.open()).vault;
  const captured = await reopened.scan(await configScope("new-pattern\n"));
  assert.equal(captured.files[".gitignore"].oid, next.oid);
  assert.deepEqual(h.files.get(safeOutput)?.data, large);
});

test("policy upgrade rechecks the durable review pause after asynchronous inventory", async () => {
  const h = await harness();
  const { journal } = await h.open();
  const policy = await NativePathPolicy.forConfig(".obsidian");
  const gate = new FileJournalStore(h.journalFiles, "12345678-1234-1234-1234-123456789abc");
  await gate.save({ pause: "reviewed" });
  let checks = 0;
  h.setListHook(async path => { if (path === "/") await gate.save({ pause: null }); });
  await assert.rejects(journal.upgradePolicy(policy, async () => {
    checks++;
    const durable = await gate.load();
    if (!durable || typeof durable !== "object" || !("pause" in durable) || durable.pause !== "reviewed")
      throw new Error("review pause revoked");
  }), /review pause revoked/);
  h.setListHook();
  assert.equal(checks, 2);
  assert.equal(journal.matchesPolicy(NativePathPolicy.legacy), true);
  await assert.rejects(h.open(undefined, policy), /policy does not match/);
});

for (const scoped of [false, true]) {
  test(`${scoped ? "configured" : "legacy"} capture refuses a visible disk file omitted by the host index`, async () => {
    const h = await harness(undefined, scoped ? await NativePathPolicy.forConfig(".obsidian") : NativePathPolicy.legacy);
    h.put("note.md", bytes("still on disk"));
    h.put(".obsidian/private", bytes("excluded confidential bytes"));
    h.excludeFromIndex("note.md");
    const scope = scoped ? await configScope() : undefined;
    await assert.rejects(h.vault.scan(scope), /Visible file missing from host index: note.md/);
    await assert.rejects(h.vault.capture(scope), /Visible file missing from host index: note.md/);
    assert.deepEqual(h.files.get("note.md")?.data, bytes("still on disk"));
    assert.deepEqual(h.adapterReads, []);
  });
}

test("scoped inventory ignores an omitted host-index file excluded by committed rules", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  h.put(".gitignore", bytes("ignored.md\n"));
  h.put("ignored.md", bytes("private bytes"));
  h.excludeFromIndex("ignored.md");
  const scanned = await h.vault.scan(await configScope("ignored.md\n"));
  assert.deepEqual(Object.keys(scanned.files), [".gitignore"]);
  assert.equal(h.adapterReads.includes("ignored.md"), false);
});

test("scan reuses captured bytes while size and mtime match and rereads after any change", async () => {
  const h = await harness();
  h.put("a.md", bytes("alpha"));
  h.put("b.md", bytes("bravo"));
  const first = await h.vault.capture();
  assert.deepEqual(h.adapterReads.filter(path => path.endsWith(".md")).sort(), ["a.md", "b.md"]);
  h.adapterReads.length = 0;
  const second = await h.vault.capture();
  assert.deepEqual(h.adapterReads, [], "unchanged files are neither read nor hashed again");
  assert.deepEqual(second, first);
  h.put("a.md", bytes("ALPHA")); // Same size; the fake bumps mtime like a real write.
  const third = await h.vault.capture();
  assert.deepEqual(h.adapterReads, ["a.md"]);
  assert.equal(third["a.md"].oid, (await entryFromBytes(bytes("ALPHA"))).oid);
  assert.equal(third["b.md"].oid, second["b.md"].oid);
});

test("scan does not cache racily recent or incomplete stats", async () => {
  const h = await harness();
  h.put("recent.md", bytes("recent"));
  h.put("nomtime.md", bytes("no mtime"));
  h.files.get("recent.md")!.file.stat.mtime = 1_000_000;
  h.files.get("nomtime.md")!.file.stat.mtime = Number.NaN;
  h.vault.now = () => 1_000_000 + 1_000;
  await h.vault.scan();
  h.adapterReads.length = 0;
  // A same-size, same-mtime rewrite inside the racy window could otherwise be missed.
  await h.vault.scan();
  assert.deepEqual(h.adapterReads.sort(), ["nomtime.md", "recent.md"]);
  h.vault.now = () => 1_000_000 + 60_000;
  await h.vault.scan();
  h.adapterReads.length = 0;
  await h.vault.scan();
  assert.deepEqual(h.adapterReads, ["nomtime.md"]);
});

test("a deleted path leaves the scan cache and apply invalidates its path", async () => {
  const h = await harness();
  h.put("a.md", bytes("one"));
  const base = await h.vault.capture();
  h.files.delete("a.md");
  assert.deepEqual(Object.keys(await h.vault.capture()), []);
  h.put("a.md", bytes("one"));
  h.files.get("a.md")!.file.stat.mtime = 1; // Reappears with the exact earlier stat.
  h.adapterReads.length = 0;
  await h.vault.capture();
  assert.deepEqual(h.adapterReads, ["a.md"]);
  const next = await entryFromBytes(bytes("two"));
  assert.equal((await h.vault.apply("a.md", base["a.md"], next)).kind, "applied");
  h.adapterReads.length = 0;
  assert.equal((await h.vault.capture())["a.md"].oid, next.oid);
  assert.ok(h.adapterReads.includes("a.md"));
});

test("configuration files are cached like visible files and invalidated by size, mtime or apply", async () => {
  const h = await harness(undefined, await NativePathPolicy.forConfig(".obsidian"));
  h.put(".obsidian/app.json", bytes("{}"));
  h.put(".obsidian/plugins/big/main.js", bytes("x".repeat(4096)));
  const scope = await configScope();
  const first = await h.vault.scan(scope);
  assert.ok(h.adapterReads.includes(".obsidian/plugins/big/main.js"));
  h.adapterReads.length = 0;
  const second = await h.vault.scan(scope);
  assert.deepEqual(h.adapterReads.filter(path => path.startsWith(".obsidian/")), [], "unchanged configuration is not reread");
  assert.deepEqual(second.files, first.files);
  h.put(".obsidian/app.json", bytes("{ }")); // Size and mtime change.
  const third = await h.vault.scan(scope);
  assert.deepEqual(h.adapterReads.filter(path => path.startsWith(".obsidian/")), [".obsidian/app.json"]);
  assert.equal(third.files[".obsidian/app.json"].oid, (await entryFromBytes(bytes("{ }"))).oid);
  const next = await entryFromBytes(bytes("[]"));
  assert.equal((await h.vault.apply(".obsidian/app.json", third.files[".obsidian/app.json"], next)).kind, "applied");
  h.adapterReads.length = 0;
  assert.equal((await h.vault.scan(scope)).files[".obsidian/app.json"].oid, next.oid);
  assert.ok(h.adapterReads.includes(".obsidian/app.json"));
});

test("readCandidate serves and fills the scan cache, so a following capture reads nothing twice", async () => {
  const h = await harness();
  h.put("a.md", bytes("alpha"));
  h.put("b.md", bytes("bravo"));
  const a = await h.vault.readCandidate("a.md", 5);
  assert.equal(a?.oid, (await entryFromBytes(bytes("alpha"))).oid);
  assert.equal(await h.vault.readCandidate("b.md", 4), null, "a size mismatch is not read");
  assert.equal(await h.vault.readCandidate("missing.md", 4), null);
  assert.equal(await h.vault.readCandidate("../escape.md", 4), null);
  assert.deepEqual(h.adapterReads.filter(path => path.endsWith(".md")), ["a.md"]);
  h.adapterReads.length = 0;
  const captured = await h.vault.capture();
  assert.deepEqual(h.adapterReads.filter(path => path.endsWith(".md")), ["b.md"]);
  assert.equal(captured["a.md"].oid, a?.oid);
  h.adapterReads.length = 0;
  assert.equal((await h.vault.readCandidate("b.md", 5))?.oid, captured["b.md"].oid);
  assert.deepEqual(h.adapterReads, [], "a cached entry is served without reading");
  h.put("b.md", bytes("BRAVO"));
  assert.equal((await h.vault.readCandidate("b.md", 5))?.oid, (await entryFromBytes(bytes("BRAVO"))).oid);
  assert.deepEqual(h.adapterReads, ["b.md"]);
});

test("inventory lists but never walks .git, .trash or the plugin journal", async () => {
  for (const policy of [NativePathPolicy.legacy, await NativePathPolicy.forConfig(".obsidian")]) {
    const h = await harness(undefined, policy);
    h.put("note.md", bytes("note"));
    h.put(".obsidian/app.json", bytes("{}"));
    h.put(".git/objects/ab/cdef", bytes("packed"));
    h.put(".trash/old.md", bytes("old"));
    h.put(".git-vault-sync/previous-git/x/dot-git/HEAD", bytes("ref"));
    const listed: string[] = [];
    h.setListHook(async path => { listed.push(path); });
    const scanned = await h.vault.scan(policy.binding.rules === "config/1" ? await configScope() : undefined);
    h.setListHook();
    assert.ok(Object.hasOwn(scanned.files, "note.md"));
    assert.equal(Object.hasOwn(scanned.files, ".obsidian/app.json"), policy.binding.rules === "config/1");
    assert.ok(listed.includes("/"));
    assert.deepEqual(listed.filter(path => /^(\.git|\.trash|\.git-vault-sync)(\/|$)/.test(path)), []);
  }
});
