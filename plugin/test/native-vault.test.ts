import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { GitObsidianVault as Adapter } from "../src/git-sync/obsidian-vault";
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
function harness(modes = new Map<string, "100644" | "100755">()) {
  const files = new Map<
    string,
    { file: InstanceType<typeof loaded.TFile>; data: Uint8Array }
  >();
  let beforeProcess: (() => void) | undefined;
  const put = (path: string, data: Uint8Array) => {
    const file =
      files.get(path)?.file ??
      new loaded.TFile(path, { size: data.length, mtime: 1 });
    file.stat.size = data.length;
    files.set(path, { file, data });
  };
  const app = {
    vault: {
      getFiles: () => [...files.values()].map((x) => x.file),
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      readBinary: async (f: { path: string }) =>
        files.get(f.path)!.data.slice().buffer,
      adapter: { exists: async (p: string) => files.has(p) },
      createFolder: async () => {},
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
  return {
    vault: new loaded.GitObsidianVault(app as unknown as App, {
      get: path => modes.get(path) ?? "100644",
      set: (path, mode) => { modes.set(path, mode); },
    }),
    put,
    files,
    setHook: (fn: () => void) => {
      beforeProcess = fn;
    },
  };
}
test("atomic process catches an edit between preflight and actual write", async () => {
  const h = harness();
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
  const h = harness();
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
test("binary replacement and any deletion never invoke unsafe mutations", async () => {
  const h = harness();
  h.put("a.png", new Uint8Array([0, 1, 2]));
  const base = await h.vault.capture();
  h.put("a.png", new Uint8Array([3, 4, 5]));
  const remote = await h.vault.capture();
  h.put("a.png", new Uint8Array([0, 1, 2]));
  assert.equal(
    (await h.vault.apply("a.png", base["a.png"], remote["a.png"])).kind,
    "blocked",
  );
  assert.equal(
    (await h.vault.apply("a.png", base["a.png"], null)).kind,
    "blocked",
  );
  assert.deepEqual(h.files.get("a.png")!.data, new Uint8Array([0, 1, 2]));
});
test("creates preserve exact attachment bytes and skip hidden files", async () => {
  const h = harness();
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

test("logical executable mode survives equal bytes, edits and restart; unsafe creation is held", async () => {
  const modes = new Map<string, "100644" | "100755">();
  const h = harness(modes);
  h.put("tool.sh", bytes("echo ready\n"));
  const original = (await h.vault.capture())["tool.sh"];
  const executable = { ...original, mode: "100755" as const };
  assert.equal((await h.vault.apply("tool.sh", original, executable)).kind, "applied");
  assert.equal((await h.vault.capture())["tool.sh"].mode, "100755");
  h.put("tool.sh", bytes("echo edited\n"));
  assert.equal((await h.vault.capture())["tool.sh"].mode, "100755");
  const restarted = harness(modes);
  restarted.put("tool.sh", bytes("echo edited\n"));
  assert.equal((await restarted.vault.capture())["tool.sh"].mode, "100755");
  assert.equal((await restarted.vault.apply("new.sh", null, executable)).kind, "blocked");
  assert.equal(restarted.files.has("new.sh"), false);
});
