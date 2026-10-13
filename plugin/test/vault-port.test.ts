import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

// Obsidian ships types, not a Node runtime. Bundle the real adapter against a
// small identity stub, then exercise its behavior with an instrumented vault.
const temporary = mkdtempSync(join(tmpdir(), "vault-port-test-"));
const bundle = join(temporary, "adapter.cjs");
let ObsidianVaultPort: any, TFile: any;
try {
  buildSync({
    stdin: {
      contents:
        "export { ObsidianVaultPort } from './src/vault-port'; export { TFile } from 'obsidian';",
      resolveDir: resolve("."),
    },
    alias: { obsidian: resolve("test/fixtures/obsidian.ts") },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
  });
  ({ ObsidianVaultPort, TFile } = createRequire(import.meta.url)(bundle));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
function harness() {
  const files = new Map<string, { file: any; data: Uint8Array }>();
  const folders = new Set<string>();
  const backups = new Map<string, Uint8Array>();
  const events: string[] = [];
  const hooks: {
    beforeCreate?: () => void;
    beforeProcess?: () => void;
    afterBackup?: () => void;
    readError?: Error;
    backupError?: Error;
  } = {};
  const edit = (path: string, data: Uint8Array) => {
    const file =
      files.get(path)?.file ?? new TFile(path, { size: data.length, mtime: 1 });
    file.stat.size = data.length;
    files.set(path, { file, data: data.slice() });
  };
  const vault = {
    getFiles: () => [...files.values()].map((f) => f.file),
    getAbstractFileByPath: (path: string) =>
      files.get(path)?.file ?? (folders.has(path) ? {} : null),
    readBinary: async (file: any) => {
      if (hooks.readError) throw hooks.readError;
      return files.get(file.path)!.data.slice().buffer;
    },
    createFolder: async (path: string) => {
      folders.add(path);
    },
    createBinary: async (path: string, data: ArrayBuffer) => {
      hooks.beforeCreate?.();
      if (files.has(path)) throw new Error("Exists");
      events.push("create");
      edit(path, new Uint8Array(data));
    },
    process: async (file: any, fn: (s: string) => string) => {
      hooks.beforeProcess?.();
      events.push("process");
      edit(file.path, bytes(fn(text(files.get(file.path)!.data))));
    },
    modifyBinary: async (file: any, data: ArrayBuffer) => {
      events.push("modify");
      edit(file.path, new Uint8Array(data));
    },
    trash: async (file: any) => {
      events.push("trash");
      files.delete(file.path);
    },
    adapter: {
      exists: async (path: string) => folders.has(path) || files.has(path),
      writeBinary: async (path: string, data: ArrayBuffer) => {
        if (hooks.backupError) throw hooks.backupError;
        events.push("backup");
        backups.set(path, new Uint8Array(data).slice());
        hooks.afterBackup?.();
      },
    },
  };
  return {
    port: new ObsidianVaultPort({ vault }),
    files,
    folders,
    backups,
    events,
    hooks,
    edit,
  };
}
test("create-only writes make parents and refuse existing files including create races", async () => {
  const h = harness();
  assert.equal(
    await h.port.write("nested/note.md", bytes("new"), 2, null),
    true,
  );
  assert(h.folders.has("nested"));
  assert.equal(
    await h.port.write("nested/note.md", bytes("replace"), 2, null),
    false,
  );
  h.hooks.beforeCreate = () => h.edit("race.md", bytes("racing editor"));
  assert.equal(await h.port.write("race.md", bytes("remote"), 2, null), false);
  assert.equal(text(h.files.get("race.md")!.data), "racing editor");
  assert.equal(h.backups.size, 0);
});
test("stale expected bytes refuse replacement and deletion without backups", async () => {
  const h = harness();
  h.edit("note.md", bytes("local"));
  assert.equal(
    await h.port.write("note.md", bytes("remote"), 2, bytes("old")),
    false,
  );
  assert.equal(await h.port.remove("note.md", bytes("old")), false);
  assert.equal(text(h.files.get("note.md")!.data), "local");
  assert.deepEqual(h.events, []);
});
test("atomic text processing preserves edits made after the first comparison", async () => {
  const h = harness();
  h.edit("note.md", bytes("base"));
  h.hooks.beforeProcess = () => h.edit("note.md", bytes("typing"));
  assert.equal(
    await h.port.write("note.md", bytes("remote"), 2, bytes("base")),
    false,
  );
  assert.equal(text(h.files.get("note.md")!.data), "typing");
  assert.equal(text([...h.backups.values()][0]), "base");
});
test("replacement backs up original bytes before atomic text write, including UTF-8 BOM", async () => {
  const h = harness(),
    before = bytes("\uFEFForiginal");
  h.edit("note.md", before);
  assert.equal(await h.port.write("note.md", bytes("remote"), 2, before), true);
  assert.deepEqual(h.events, ["backup", "process"]);
  assert.deepEqual([...h.backups.values()][0], before);
  assert([...h.backups.keys()][0].startsWith(".cloud-vault-sync-recovery/"));
  assert.equal(text(h.files.get("note.md")!.data), "remote");
});
test("binary write and deletion keep recovery copies before destructive operations", async () => {
  const h = harness(),
    before = new Uint8Array([255, 0, 254]);
  h.edit("blob.bin", before);
  assert.equal(
    await h.port.write("blob.bin", new Uint8Array([254, 3]), 2, before),
    true,
  );
  assert.deepEqual(h.events, ["backup", "modify"]);
  assert.deepEqual([...h.backups.values()][0], before);
  h.events.length = 0;
  assert.equal(await h.port.remove("blob.bin", new Uint8Array([254, 3])), true);
  assert.deepEqual(h.events, ["backup", "trash"]);
  assert.equal(h.files.has("blob.bin"), false);
  assert.deepEqual([...h.backups.values()][1], new Uint8Array([254, 3]));
});
test("binary replacement and delete recheck changes during recovery writes", async () => {
  for (const remove of [false, true]) {
    const h = harness(),
      before = new Uint8Array([255, 0]);
    h.edit("blob.bin", before);
    h.hooks.afterBackup = () => h.edit("blob.bin", new Uint8Array([255, 1]));
    assert.equal(
      remove
        ? await h.port.remove("blob.bin", before)
        : await h.port.write("blob.bin", new Uint8Array([255, 2]), 2, before),
      false,
    );
    assert.deepEqual(h.events, ["backup"]);
    assert.deepEqual(h.files.get("blob.bin")!.data, new Uint8Array([255, 1]));
  }
});
test("read and backup failures propagate without replacing or deleting a file", async () => {
  for (const failure of ["readError", "backupError"] as const)
    for (const remove of [false, true]) {
      const h = harness();
      h.edit("note.md", bytes("keep"));
      h.hooks[failure] = new Error("disk failure");
      await assert.rejects(
        remove
          ? h.port.remove("note.md", bytes("keep"))
          : h.port.write("note.md", bytes("remote"), 2, bytes("keep")),
        /disk failure/,
      );
      assert.equal(text(h.files.get("note.md")!.data), "keep");
      assert.deepEqual(h.events, []);
    }
});
test("reads distinguish absent paths, folders and oversized files from valid content", async () => {
  const h = harness();
  assert.equal(await h.port.read("missing"), null);
  h.folders.add("folder");
  await assert.rejects(h.port.read("folder"), /folder occupies/);
  h.edit("large.bin", bytes("small"));
  h.files.get("large.bin")!.file.stat.size = 8 * 1024 * 1024 + 1;
  await assert.rejects(h.port.read("large.bin"), /exceeds 8 MiB/);
});
