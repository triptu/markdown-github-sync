import { defaultSettings } from "../src/settings";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type Plugin from "../src/main";
import type { App } from "obsidian";
import type { GitHubRepository } from "../src/git-sync/github";
import { MemoryRepository } from "./git-fakes";
import { entryFromText, entryText } from "../src/git-sync/codec";
import { NativeModeStore } from "../src/git-sync/native-modes";
import type { GitObsidianVault } from "../src/git-sync/obsidian-vault";
import { FileJournalStore, type JournalFiles } from "../src/git-sync/store";

// V3 consent follows exact contents: notifications no longer revoke unchanged decisions.
// One-sided renames sync automatically; a saved restore intent resumes after restart.
// Native uncertainty now produces a per-file decision instead of a global mode error.

const temporary = mkdtempSync(join(tmpdir(), "git-plugin-safety-"));
const hostModule = join(temporary, "obsidian.cjs");
const loadBundle = createRequire(import.meta.url);
async function bundle(name: string) {
  const outfile = join(temporary, name);
  await build({
    stdin: { contents: `export { default as GitVaultSync } from './src/main'; export { TFile } from 'obsidian'; export { GitObsidianVault } from './src/git-sync/obsidian-vault'; export { hostLifetimeId } from './src/git-sync/ownership'; export function useRepository(repo) { globalThis.safetyRepository = repo; } export function options() { return globalThis.safetyOptions; }`, resolveDir: resolve(".") },
    bundle: true, platform: "node", format: "cjs", outfile,
    plugins: [{ name: "host-boundaries", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: hostModule, external: true }));
      build.onResolve({ filter: /^\.\/git-sync\/github$/ }, () => ({ path: "github", namespace: "host" }));
      build.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `export class GitHubRepository { constructor(options) { globalThis.safetyOptions = options; return { ...globalThis.safetyRepository.device(options.installation), history: (...args) => globalThis.safetyRepository.history(...args), checkAccess: async () => { globalThis.safetyAccessOptions = options; await globalThis.safetyAccess?.(options); } }; } }` }));
    } }],
  });
  return loadBundle(outfile) as BundleApi;
}
type BundleApi = {
    GitVaultSync: typeof Plugin;
    GitObsidianVault: typeof GitObsidianVault;
    TFile: new (path: string, stat: { size: number; mtime: number }) => { path: string; stat: { size: number; mtime: number } };
    useRepository(repo: MemoryRepository): void;
    options(): ConstructorParameters<typeof GitHubRepository>[0];
    hostLifetimeId(host: object): string;
};
// Separate plugin bundles share the host's Obsidian classes and App.
let loaded: BundleApi, reloaded: BundleApi;
before(async () => {
  await build({ entryPoints: [resolve("test/fixtures/obsidian-plugin.ts")], bundle: true, platform: "node", format: "cjs", outfile: hostModule });
  loaded = await bundle("first.cjs"); reloaded = await bundle("replacement.cjs");
  rmSync(temporary, { recursive: true, force: true });
});
test("host lifetime identity survives separate plugin bundles but is never copied as vault state", () => {
  const host = {};
  const original = loaded.hostLifetimeId(host);
  assert.equal(reloaded.hostLifetimeId(host), original);
  assert.equal(loaded.hostLifetimeId(host), original);
  assert.notEqual(reloaded.hostLifetimeId({}), original);
  assert.deepEqual(JSON.parse(JSON.stringify(host)), {});
  assert.deepEqual(structuredClone(host), {});
  assert.throws(() => loaded.hostLifetimeId({ [Symbol.for("github-vault-sync.host-lifetime.v1")]: "corrupt" }), /Invalid/);
});
class Files implements JournalFiles {
  values = new Map<string, string>(); folders = new Set<string>(); writes: string[] = [];
  async exists(path: string) { return this.values.has(path) || this.folders.has(path); }
  async mkdir(path: string) { this.writes.push(path); this.folders.add(path); }
  async read(path: string) { const value = this.values.get(path); if (value === undefined) throw Error("Missing file"); return value; }
  async write(path: string, text: string) { this.writes.push(path); this.values.set(path, text); }
  async rename(from: string, to: string) { this.writes.push(to); const value = await this.read(from); this.values.set(to, value); this.values.delete(from); }
  async list(path: string): ReturnType<JournalFiles["list"]> { return { files: [...this.values.keys()].filter(key => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/")), folders: [] }; }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const settings = { ...defaultSettings(), configuration: false, format: 2 as const, owner: "me", repository: "vault", branch: "main", secretId: "secret", deviceName: "Lab", automatic: false };
function harness() {
  const docs = new Map<string, { file: InstanceType<typeof loaded.TFile>; data: Uint8Array }>();
  const local = new Map<string, unknown>(), files = new Files();
  let crashAfter = false, crashBefore = false;
  let tearNextWrite = false;
  let beforeProcess: (() => Promise<void>) | null = null;
  const events = new Map<string, (file: { path: string }, oldPath?: string) => void>();
  const put = (path: string, text: string) => { const parts = path.split("/"); for (let i = 1; i < parts.length; i++) files.folders.add(parts.slice(0, i).join("/")); const data = new TextEncoder().encode(text); docs.set(path, { file: new loaded.TFile(path, { size: data.length, mtime: 1 }), data }); };
  const exists = files.exists.bind(files), rename = files.rename.bind(files);
  files.exists = async path => docs.has(path) || exists(path);
  files.rename = async (from, to) => {
    if (await files.exists(to)) throw Error("Destination exists");
    const value = docs.get(from);
    if (!value) return rename(from, to);
    value.file.path = to; docs.set(to, value); docs.delete(from);
    events.get("rename")?.(value.file, from);
  };
  files.list = async path => {
    const prefix = path === "/" || path === "" ? "" : path + "/";
    const names = [...files.values.keys(), ...docs.keys()];
    const folders = new Set(files.folders);
    for (const name of names) {
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    const immediate = (name: string) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/") && name !== path;
    return { files: names.filter(immediate), folders: [...folders].filter(immediate) };
  };
  const adapter = Object.assign(files, {
    stat: async (path: string) => {
      const value = docs.get(path);
      if (value) return { type: "file", size: value.data.byteLength, mtime: value.file.stat.mtime, ctime: 1 };
      const text = files.values.get(path);
      if (text !== undefined) return { type: "file", size: new TextEncoder().encode(text).byteLength, mtime: 1, ctime: 1 };
      return files.folders.has(path) ? { type: "folder", size: 0, mtime: 1, ctime: 1 } : null;
    },
    copy: async (from: string, to: string) => {
      if (await files.exists(to)) throw Error("Destination exists");
      const value = docs.get(from);
      if (!value) throw Error("Missing binary file");
      docs.set(to, { file: new loaded.TFile(to, { ...value.file.stat }), data: value.data.slice() });
    },
    readBinary: async (path: string) => { const value = docs.get(path); if (!value) throw Error("Missing binary file"); return value.data.slice().buffer; },
    writeBinary: async (path: string, data: ArrayBuffer) => { docs.set(path, { file: new loaded.TFile(path, { size: data.byteLength, mtime: 1 }), data: new Uint8Array(data).slice() }); },
    remove: async (path: string) => { docs.delete(path); files.values.delete(path); },
  });
  const app = {
    savedSettings: structuredClone(settings),
    loadLocalStorage: (key: string) => structuredClone(local.get(key) ?? null),
    saveLocalStorage: (key: string, value: unknown) => local.set(key, structuredClone(value)),
    secretStorage: { getSecret: (id: string) => `token:${id}` },
    workspace: { onLayoutReady: (_callback: () => void) => {}, iterateAllLeaves: () => {} },
    vault: {
      on: (name: string, callback: (file: { path: string }, oldPath?: string) => void) => { events.set(name, callback); return {}; },
      adapter, configDir: ".obsidian",
      getFiles: () => [...docs.values()].map(d => d.file).filter(file => !file.path.split("/").some(part => part.startsWith("."))),
      getAbstractFileByPath: (path: string) => docs.get(path)?.file ?? null,
      readBinary: async (file: { path: string }) => docs.get(file.path)!.data.slice().buffer,
      createFolder: async () => {},
      createBinary: async (path: string, data: ArrayBuffer) => { if (docs.has(path)) throw Error("exists"); put(path, new TextDecoder("utf8", { ignoreBOM: true }).decode(data)); },
      process: async (file: { path: string }, fn: (text: string) => string) => {
        await beforeProcess?.();
        if (crashBefore) { crashBefore = false; throw Error("before native write"); }
        const next = fn(new TextDecoder("utf8", { ignoreBOM: true }).decode(docs.get(file.path)!.data)); put(file.path, next);
        if (tearNextWrite) { tearNextWrite = false; put(file.path, next.split("\n").slice(0, 5).join("\n") + "\n"); throw Error("torn native write"); }
        if (crashAfter) { crashAfter = false; throw Error("after native write"); }
        return next;
      },
    },
  };
  const create = (replacement = false) => {
    const plugin = new (replacement ? reloaded : loaded).GitVaultSync(app as unknown as App, { id: "git-vault-sync", name: "GitHub Vault Sync", version: "test", minAppVersion: "1.11.4", description: "Safety test", author: "Test" }); plugin.app = app as unknown as App;
    plugin.settings = structuredClone(settings); Reflect.set(plugin, "ready", true); return plugin;
  };
  return { app, docs, files, local, put, create, emit: (name: string, path: string, oldPath?: string) => events.get(name)?.({ path }, oldPath), beforeProcess: (callback: () => Promise<void>) => { beforeProcess = callback; }, crashAfter: () => { crashAfter = true; }, crashBefore: () => { crashBefore = true; }, tearWrite: () => { tearNextWrite = true; } };
}
async function enroll(plugin: Plugin) {
  const preview = await plugin.session!.previewEnrollment(); assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw Error("missing preview");
  assert.equal((await plugin.session!.enroll({ token: preview.token })).kind, "enrolled"); await plugin.session!.sync();
}
async function setup(initial = "base\n", mode: "100644" | "100755" = "100644") {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText(initial, mode) }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create(); await plugin.initialize(); await enroll(plugin); return { repo, host, plugin };
}

test("reload drains separate bundles and fences old publication plus queued UI operations", async () => {
  const { repo, host, plugin } = await setup(); host.put("a.md", "old capture\n");
  const prepared = deferred(), release = deferred(), prepare = repo.prepare.bind(repo);
  repo.prepare = async (...args) => { const result = await prepare(...args); prepared.resolve(); await release.promise; return result; };
  const running = plugin.syncOnce(); await prepared.promise;
  const oldUI = plugin.session!.previewRestore({ path: "a.md", commit: repo.branchHead });
  const runningRefused = assert.rejects(running, /retired/), uiRefused = assert.rejects(oldUI, /retired/);
  plugin.onunload(); const writes = host.files.writes.length, publishes = repo.calls.filter(c => c === "publish").length;
  host.put("a.md", "replacement capture\n"); const next = host.create(true); let initialized = false;
  const initialization = next.initialize().then(() => { initialized = true; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(initialized, false); assert.equal(host.files.writes.length, writes);
  release.resolve(); await runningRefused; await uiRefused;
  assert.equal(repo.calls.filter(c => c === "publish").length, publishes, "old writer cannot publish after unload");
  await initialization; repo.prepare = prepare; await next.syncOnce();
  assert.equal(entryText(repo.headFiles()["a.md"]), "replacement capture\n");
  const sequences = [...host.files.values.keys()].filter(p => /\/records\/\d{12}-/.test(p) && !p.includes("/modes/") && !p.includes("/native/")).map(p => p.match(/\/records\/(\d{12})-/)![1]);
  assert.equal(new Set(sequences).size, sequences.length); assert.equal((await next.session!.status()).kind, "enrolled");
  await assert.rejects(plugin.session!.sync(), /retired/);
});

test("historical restore recovers its mode after a native byte-write interruption", async () => {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText("historical\n", "100755") }); const history = repo.branchHead;
  await repo.push({ "a.md": await entryFromText("current\n", "100644") }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create(); await plugin.initialize(); await enroll(plugin);
  const preview = await plugin.session!.previewRestore({ path: "a.md", commit: history });
  assert.equal(preview.kind, "preview"); if (preview.kind !== "preview") return;
  host.crashAfter(); await assert.rejects(plugin.session!.restore({ path: "a.md", commit: history, token: preview.token }), /after native write/);
  plugin.onunload(); const next = host.create(true); await next.initialize(); await next.syncOnce();
  assert.equal(entryText(repo.headFiles()["a.md"]), "historical\n"); assert.equal(repo.headFiles()["a.md"].mode, "100755");
});

test("pre-write restore interruption resumes the exact reviewed restore after restart", async () => {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText("historical\n", "100755") }); const history = repo.branchHead;
  await repo.push({ "a.md": await entryFromText("current\n", "100644") }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create(); await plugin.initialize(); await enroll(plugin);
  const preview = await plugin.session!.previewRestore({ path: "a.md", commit: history });
  assert.equal(preview.kind, "preview"); if (preview.kind !== "preview") return;
  host.crashBefore(); await assert.rejects(plugin.session!.restore({ path: "a.md", commit: history, token: preview.token }), /before native write/);
  plugin.onunload(); const next = host.create(true); await next.initialize(); await next.syncOnce();
  assert.equal(entryText(repo.headFiles()["a.md"]), "historical\n"); assert.equal(repo.headFiles()["a.md"].mode, "100755");
});

test("remote executable update still recovers after native write interruption", async () => {
  const { repo, host, plugin } = await setup(); await repo.push({ "a.md": await entryFromText("remote\n", "100755") });
  host.crashAfter(); await assert.rejects(plugin.session!.sync(), /after native write/);
  plugin.onunload(); const next = host.create(true); await next.initialize(); await next.syncOnce(); await next.syncOnce();
  assert.equal(repo.headFiles()["a.md"].mode, "100755"); assert.equal(entryText(repo.headFiles()["a.md"]), "remote\n");
});

test("file and folder renames retain executable mode through automatic sync after restart", async () => {
  const { repo, host, plugin } = await setup("executable\n", "100755");
  host.put("folder/a.md", "executable\n"); host.docs.delete("a.md"); await plugin.recordRename("a.md", "folder/a.md");
  host.put("moved/a.md", "executable\n"); host.docs.delete("folder/a.md"); await plugin.recordRename("folder", "moved");
  plugin.onunload(); const next = host.create(true); await next.initialize(); const outcome = await next.session!.sync();
  assert.equal(outcome.kind, "synced");
  assert.equal(repo.headFiles()["a.md"], undefined); assert.equal(repo.headFiles()["moved/a.md"].mode, "100755");
});

test("saved drafts are isolated and enrollment identity binds every subsequent save", async () => {
  const { host, plugin } = await setup(); const draft = { ...plugin.settings }; await plugin.saveConfiguration(draft);
  draft.repository = "different"; draft.secretId = "unsaved";
  assert.equal(plugin.settings.repository, "vault"); assert.equal(plugin.settings.secretId, "secret"); assert.equal(await loaded.options().token(), "token:secret");
  await assert.rejects(plugin.saveConfiguration(draft), /already syncs with/);
  plugin.settings.repository = "different"; await assert.rejects(plugin.saveConfiguration(draft), /already syncs with/);
  assert.equal(host.app.savedSettings.repository, "vault");
});

test("saves snapshot drafts at admission and serialize with initialize; old previews become stale", async () => {
  const repo = await MemoryRepository.create({}); loaded.useRepository(repo); const host = harness(), plugin = host.create();
  const draft = { ...settings, secretId: "saved" }; const saved = plugin.saveConfiguration(draft); draft.secretId = "unsaved";
  const initialized = plugin.initialize(); await saved; await initialized;
  assert.equal(plugin.settings.secretId, "saved"); assert.equal(await loaded.options().token(), "token:saved");
  const old = plugin.session!, reset = plugin.initialize(), stale = assert.rejects(old.previewEnrollment(), /configuration changed/); await reset; await stale;
  assert.throws(() => plugin.saveConfiguration({ ...settings, automatic: "invalid" } as unknown as typeof settings), /automatic/);
});

test("a native process callback resuming after unload cannot write; its successor recovers the intent", async () => {
  const { repo, host, plugin } = await setup();
  await repo.push({ "a.md": await entryFromText("remote\n", "100755") });
  const arrived = deferred(), release = deferred();
  host.beforeProcess(async () => { arrived.resolve(); await release.promise; });
  const run = plugin.syncOnce(), refused = assert.rejects(run, /retired/);
  await arrived.promise; plugin.onunload();
  const next = host.create(true), initialization = next.initialize();
  release.resolve(); await refused;
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), "base\n");
  await initialization; await next.syncOnce(); await next.syncOnce();
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), "remote\n");
  assert.equal(repo.headFiles()["a.md"].mode, "100755");
});

test("native notifications schedule sync without retiring exact-content decisions", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  try {
    for (const kind of ["create", "modify", "delete", "rename"]) {
      const { repo, host, plugin } = await setup(); await plugin.onload();
      host.put("a.md", "local\n"); await repo.push({ "a.md": await entryFromText("remote\n") });
      const conflict = await plugin.session!.sync();
      assert.equal(conflict.kind, "needs-decision"); if (conflict.kind !== "needs-decision") throw Error("missing conflict");
      const id = conflict.conflicts[0].id;
      assert.equal((await plugin.session!.resolve({ conflictId: id, choice: { kind: "mine" } })).kind, "recorded");
      let scheduled = 0;
      Reflect.set(plugin, "scheduler", { stop() {}, schedule() { scheduled++; } });
      // A complete edit/revert or recreate cycle can end at the same manifest.
      host.emit(kind, "a.md", "a.md");
      const outcome = await plugin.session!.sync();
      assert.equal(outcome.kind, "synced", kind); assert.equal(scheduled, 1, kind);
      assert.equal(entryText(repo.headFiles()["a.md"]), "local\n");
      assert.equal((await plugin.session!.resolve({ conflictId: id, choice: { kind: "mine" } })).kind, "stale");
      const writes = host.files.writes.length; host.emit("modify", ".obsidian/data.json"); await plugin.session!.status();
      assert.equal(host.files.writes.length, writes); assert.equal(scheduled, 1);
      plugin.onunload(); host.emit(kind, "a.md", "a.md");
      // Error handlers settle without reaching retired ports.
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(host.files.writes.length, writes);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("an enrolled journal binds configuration even before a replacement is initialized", async () => {
  const { plugin, host } = await setup(); plugin.onunload();
  const next = host.create(true);
  await assert.rejects(next.saveConfiguration({ ...settings, repository: "different" }), /already syncs with/);
  assert.equal(host.app.savedSettings.repository, "vault");
});

test("a post-crash edit with ambiguous mode is held instead of published with a guessed mode", async () => {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText("historical\n", "100755") }); const history = repo.branchHead;
  await repo.push({ "a.md": await entryFromText("current\n", "100644") }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create(); await plugin.initialize(); await enroll(plugin);
  const preview = await plugin.session!.previewRestore({ path: "a.md", commit: history });
  assert.equal(preview.kind, "preview"); if (preview.kind !== "preview") throw Error("missing preview");
  host.crashAfter(); await assert.rejects(plugin.session!.restore({ path: "a.md", commit: history, token: preview.token }), /after native write/);
  host.put("a.md", "edited after interruption\n"); plugin.onunload();
  const next = host.create(true); await next.initialize();
  const outcome = await next.session!.sync();
  assert.equal(outcome.kind, "needs-decision");
  if (outcome.kind !== "needs-decision") throw Error("Missing native recovery conflict");
  assert.equal(outcome.conflicts[0].kind, "interrupted-write");
  assert.equal(entryText(repo.headFiles()["a.md"]), "current\n");
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), "edited after interruption\n");
});

test("new files named like Object prototype keys capture exact bytes with default logical modes", async () => {
  const host = harness();
  const modes = await NativeModeStore.open(new FileJournalStore(host.files, "12345678-1234-1234-1234-123456789abc", "modes"), Object.create(null));
  const vault = new loaded.GitObsidianVault(host.app as unknown as App, modes);
  for (const name of ["__proto__", "constructor", "toString"]) host.put(name, name + "\n");
  const captured = await vault.capture();
  for (const name of ["__proto__", "constructor", "toString"]) {
    assert.equal(entryText(captured[name]), name + "\n"); assert.equal(captured[name].mode, "100644");
  }
});

test("native events call the engine hook synchronously while a sync owns the lifetime queue", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  try {
    const { repo, host, plugin } = await setup(); await plugin.onload();
    const raw: unknown = Reflect.get(plugin, "rawSession"); assert.ok(typeof raw === "object" && raw !== null);
    const hook: unknown = Reflect.get(raw, "notifyLocalChange"); assert.equal(typeof hook, "function");
    if (typeof hook !== "function") throw Error("missing hook");
    let observed = 0;
    Reflect.set(raw, "notifyLocalChange", (...args: unknown[]) => { observed++; return Reflect.apply(hook, raw, args); });
    const arrived = deferred(), release = deferred(), head = repo.head.bind(repo);
    repo.head = async () => { const result = await head(); arrived.resolve(); await release.promise; return result; };
    host.put("a.md", "draft\n"); const sync = plugin.syncOnce(); await arrived.promise;
    for (const kind of ["create", "modify", "delete"]) host.emit(kind, "a.md");
    assert.equal(observed, 3, "events must not queue the hook call behind sync");
    const external = plugin.session!.notifyLocalChange();
    assert.equal(observed, 4, "the public session wrapper must preserve immediate hook admission too");
    release.resolve(); await sync; await external; await plugin.session!.status(); plugin.onunload();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a rename observed during active sync prevents capture with stale logical modes", async () => {
  const { repo, host, plugin } = await setup("executable\n", "100755");
  const arrived = deferred(), release = deferred(), head = repo.head.bind(repo);
  repo.head = async () => { const result = await head(); arrived.resolve(); await release.promise; return result; };
  const sync = plugin.syncOnce(), refused = assert.rejects(sync, /rename is pending/); await arrived.promise;
  host.put("renamed.md", "executable\n"); host.docs.delete("a.md");
  const rename = plugin.recordRename("a.md", "renamed.md"); release.resolve(); await refused; await rename;
  repo.head = head;
  const outcome = await plugin.session!.sync(); assert.equal(outcome.kind, "synced");
  assert.equal(repo.headFiles()["renamed.md"].mode, "100755");
});

test("initialize drains an immediately admitted notification even when its tracking task queues later", async () => {
  const { plugin } = await setup();
  const raw: unknown = Reflect.get(plugin, "rawSession"); assert.ok(typeof raw === "object" && raw !== null);
  const hook: unknown = Reflect.get(raw, "notifyLocalChange"); if (typeof hook !== "function") throw Error("missing hook");
  const release = deferred();
  Reflect.set(raw, "notifyLocalChange", async () => { await Reflect.apply(hook, raw, []); await release.promise; return { kind: "invalidated" }; });
  let initialized = false;
  const initialize = plugin.initialize().then(() => { initialized = true; });
  const event = plugin.session!.notifyLocalChange();
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert.equal(initialized, false);
  release.resolve(); await initialize; await event;
  assert.equal((await plugin.session!.status()).kind, "enrolled");
});

test("a notification fenced by unload drains across bundles without retiring exact-content decisions", async () => {
  const { repo, host, plugin } = await setup();
  host.put("a.md", "local\n"); await repo.push({ "a.md": await entryFromText("remote\n") });
  const reviewed = await plugin.session!.sync(); assert.equal(reviewed.kind, "needs-decision");
  if (reviewed.kind !== "needs-decision") throw Error("missing conflict");
  await plugin.session!.resolve({ conflictId: reviewed.conflicts[0].id, choice: { kind: "mine" } });
  const arrived = deferred(), release = deferred(), head = repo.head.bind(repo);
  repo.head = async () => { const result = await head(); arrived.resolve(); await release.promise; return result; };
  const run = plugin.syncOnce(), refused = assert.rejects(run, /retired/); await arrived.promise;
  const event = plugin.notifyLocalChange(), eventRefused = assert.rejects(event, /retired/);
  plugin.onunload(); const next = host.create(true), initialize = next.initialize();
  release.resolve(); await refused; await eventRefused; await initialize; repo.head = head;
  const outcome = await next.session!.sync();
  assert.equal(outcome.kind, "synced", "same bytes retain the reviewed decision across replacement");
  assert.equal(entryText(repo.headFiles()["a.md"]), "local\n");
});

test("rename metadata queued at unload transfers to the replacement bundle before capture", async () => {
  const { repo, host, plugin } = await setup("executable\n", "100755");
  const arrived = deferred(), release = deferred(), head = repo.head.bind(repo);
  repo.head = async () => { const result = await head(); arrived.resolve(); await release.promise; return result; };
  const run = plugin.syncOnce(), refused = assert.rejects(run, /retired/); await arrived.promise;
  host.put("renamed.md", "executable\n"); host.docs.delete("a.md");
  const rename = plugin.recordRename("a.md", "renamed.md"), renameRefused = assert.rejects(rename, /retired/);
  plugin.onunload(); const next = host.create(true), initialize = next.initialize();
  release.resolve(); await refused; await renameRefused; await initialize; repo.head = head;
  const outcome = await next.session!.sync(); assert.equal(outcome.kind, "synced");
  assert.equal(repo.headFiles()["renamed.md"].mode, "100755");
});

test("newer bytes arriving during a resumed decision are preserved and reviewed again", async () => {
  const { repo, host, plugin } = await setup();
  host.put("a.md", "local\n"); await repo.push({ "a.md": await entryFromText("remote\n") });
  const reviewed = await plugin.session!.sync();
  if (reviewed.kind !== "needs-decision") throw Error("missing content review");
  await plugin.session!.resolve({ conflictId: reviewed.conflicts[0].id, choice: { kind: "remote" } });
  const arrived = deferred(), release = deferred(), head = repo.head.bind(repo);
  repo.head = async () => { const result = await head(); arrived.resolve(); await release.promise; return result; };
  const run = plugin.syncOnce(); await arrived.promise;
  host.put("a.md", "a newer unsynced draft\n");
  release.resolve(); await run; repo.head = head;
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), "a newer unsynced draft\n");
  assert.equal(entryText(repo.headFiles()["a.md"]), "remote\n");
  const outcome = await plugin.session!.sync(); assert.equal(outcome.kind, "needs-decision");
});

test("history browser starts at this device's restorable checkpoint when GitHub is ahead", async () => {
  const {repo, plugin} = await setup();
  const checkpoint = repo.branchHead;
  await repo.push({"a.md": await entryFromText("new remote version\n")});
  let requested: Parameters<GitHubRepository["history"]>[0] | undefined;
  Object.assign(repo, {history: async (input: Parameters<GitHubRepository["history"]>[0]) => {
    requested = input;
    return {at: input.at!, entries: [], nextPage: null};
  }});
  await plugin.fileHistory({path: "a.md"});
  assert.equal(requested?.at, checkpoint);
  assert.notEqual(requested?.at, repo.branchHead);
  await plugin.fileHistory({path: "a.md", at: checkpoint, page: 2});
  assert.deepEqual(requested, {path: "a.md", at: checkpoint, page: 2});
});

test("the wired plugin never publishes a torn native note and continues syncing unrelated files", async () => {
  const base = Array.from({ length: 10 }, (_, index) => `line ${index}\n`).join("");
  const remote = base.replace("line 1\n", "remote line 1\n");
  const { repo, host, plugin } = await setup(base);
  await repo.push({ "a.md": await entryFromText(remote) });
  host.tearWrite();
  await assert.rejects(plugin.syncOnce(), /torn native write/);
  plugin.onunload();
  const next = host.create(true); await next.initialize();
  const first = await next.session!.sync();
  assert.equal(first.kind, "needs-decision");
  if (first.kind !== "needs-decision") throw Error("Missing interrupted-write decision");
  assert.equal(first.conflicts[0].kind, "interrupted-write");
  assert.equal(entryText(repo.headFiles()["a.md"]), remote);
  host.put("unrelated.md", "This draft should still sync.\n");
  await next.syncOnce(); await next.syncOnce();
  assert.equal(entryText(repo.headFiles()["a.md"]), remote);
  assert.equal(entryText(repo.headFiles()["unrelated.md"]), "This draft should still sync.\n");
  const held = await next.session!.inspect();
  assert.equal(held.kind, "enrolled");
  if (held.kind !== "enrolled") throw Error("Missing enrolled state");
  const conflict = held.conflicts.find(item => item.kind === "interrupted-write");
  assert.ok(conflict);
  assert.equal((await next.session!.resolve({ conflictId: conflict.id, choice: { kind: "next" } })).kind, "recorded");
  await next.syncOnce();
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), remote);
  assert.equal(entryText(repo.headFiles()["a.md"]), remote);
});

test("the first interrupted-write decision applies without a second review", async () => {
  const base = Array.from({ length: 10 }, (_, index) => `line ${index}\n`).join("");
  const remote = base.replace("line 1\n", "remote line 1\n");
  const { repo, host, plugin } = await setup(base);
  await repo.push({ "a.md": await entryFromText(remote) });
  host.tearWrite(); await assert.rejects(plugin.syncOnce(), /torn native write/);
  plugin.onunload(); const next = host.create(true); await next.initialize();
  const review = await next.session!.sync();
  assert.equal(review.kind, "needs-decision");
  if (review.kind !== "needs-decision") throw Error("Missing first decision");
  const conflict = review.conflicts.find(item => item.kind === "interrupted-write");
  assert.ok(conflict);
  assert.equal((await next.session!.resolve({ conflictId: conflict.id, choice: { kind: "next" } })).kind, "recorded");
  const result = await next.session!.sync();
  assert.ok(result.kind === "synced" || result.kind === "up-to-date", JSON.stringify(result));
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), remote);
  assert.equal(entryText(repo.headFiles()["a.md"]), remote);
});


test("configuration migration resumes fresh enrollment with the bound native policy across reload", async () => {
  const { repo, host, plugin } = await setup();
  assert.equal(loaded.options().scopeRules, "visible-only");
  repo.scopeRules = "config/1";
  const upgrade = await plugin.previewConfigurationUpgrade();
  assert.equal(loaded.options().scopeRules, "config/1");
  assert.equal((await upgrade.confirm())?.kind, "preview");
  plugin.onunload();
  const next = host.create(true);
  await next.initialize();
  assert.equal(reloaded.options().scopeRules, "config/1");
  const resumed = await next.session!.previewEnrollment();
  assert.equal(resumed.kind, "preview");
  if (resumed.kind !== "preview") throw Error("missing resumed enrollment");
  assert.equal((await next.session!.enroll({ token: resumed.token })).kind, "enrolled");
  const listing = await next.session!.listConfiguration();
  assert.equal(listing.kind, "configuration");
  if (listing.kind !== "configuration") throw Error("missing listing");
  assert.equal(listing.rules, "config/1");
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")!.data), "base\n");
});

test("a configuration migration preview cannot authorize a replacement plugin instance", async () => {
  const { repo, host, plugin } = await setup();
  repo.scopeRules = "config/1";
  const upgrade = await plugin.previewConfigurationUpgrade();
  plugin.onunload();
  const next = host.create(true);
  await next.initialize();
  assert.equal(reloaded.options().scopeRules, "visible-only");
  await assert.rejects(upgrade.confirm(), /retired/);
  const listing = await next.session!.listConfiguration();
  assert.equal(listing.kind, "configuration");
  if (listing.kind !== "configuration") throw Error("missing listing");
  assert.equal(listing.rules, "visible-only");
});

test("configuration inventory failures leave legacy enrollment usable without a durable migration pause", async () => {
  const { repo, host, plugin } = await setup();
  await host.files.write(".obsidian/plugins/example/.gitignore", "cache/\n");
  repo.scopeRules = "config/1";
  await assert.rejects(plugin.previewConfigurationUpgrade(), /Nested .gitignore/);
  assert.equal((await plugin.session!.sync()).kind, "up-to-date");
  plugin.onunload();
  const next = host.create(true);
  await next.initialize();
  assert.equal(reloaded.options().scopeRules, "visible-only");
  assert.equal((await next.session!.sync()).kind, "up-to-date");
  assert.equal(await host.files.read(".obsidian/plugins/example/.gitignore"), "cache/\n");
});

test("a fresh configured vault enrolls directly with hidden local files and committed ignores", async () => {
  const repo = await MemoryRepository.create({
    "a.md": await entryFromText("base\n"),
    ".gitignore": await entryFromText("private.md\n"),
    "private.md": await entryFromText("excluded remote file\n"),
  });
  repo.scopeRules = "config/1";
  loaded.useRepository(repo);
  const host = harness();
  host.put(".obsidian/app.json", "{\"local\":true}");
  const plugin = host.create();
  plugin.settings = { ...settings, configuration: true };
  await plugin.initialize();
  assert.equal(loaded.options().scopeRules, "config/1");
  await enroll(plugin);
  assert.equal((await plugin.session!.status()).kind, "enrolled");
  assert.equal(host.docs.has("private.md"), false);
  assert.equal(new TextDecoder().decode(host.docs.get(".obsidian/app.json")!.data), "{\"local\":true}");
  const listing = await plugin.session!.listConfiguration();
  assert.equal(listing.kind, "configuration");
  if (listing.kind !== "configuration") throw Error("missing listing");
  assert.equal(listing.rules, "config/1");
  assert.ok(listing.unpublished.some(file => file.path === ".obsidian/app.json"));
  await assert.rejects(plugin.previewConfigurationUpgrade(), /already on/);
});

test("startup failure cannot bypass the durable initial scope binding", async () => {
  loaded.useRepository(await MemoryRepository.create({ "a.md": await entryFromText("base\n") }));
  const host = harness();
  const first = host.create();
  await first.initialize();
  first.onunload();
  const secrets = host.app.secretStorage;
  Reflect.deleteProperty(host.app, "secretStorage");
  const next = host.create(true);
  await assert.rejects(next.initialize(), /secret storage/);
  await assert.rejects(next.saveConfiguration({ ...settings, configuration: true }), /Settings sync was already chosen/);
  assert.equal(Boolean(next.settings.configuration), false);
  host.app.secretStorage = secrets;
  await next.initialize();
  assert.equal((await next.session!.previewEnrollment()).kind, "preview");
});

test("existing Git vault can preview setup without moving anything; stale confirmation cannot archive Git", async () => {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText("base") }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create();
  host.files.folders.add(".git"); host.files.values.set(".git/HEAD", "ref: refs/heads/main\n");
  await plugin.initialize();
  const before = [...host.files.writes];
  assert.equal(await plugin.checkSetup(), true);
  assert.deepEqual(host.files.writes, before);
  const result = await plugin.startSyncing("stale-token");
  assert.equal(result.kind, "stale");
  assert.equal(await host.files.exists(".git"), true);
  await assert.rejects(plugin.assertSingleWriter(), /Finish connecting/);
});

test("setup detects an enabled old sync plugin before archiving Git", async () => {
  const host = harness(), plugin = host.create();
  host.files.folders.add(".git");
  host.files.values.set(".obsidian/community-plugins.json", JSON.stringify(["obsidian-git"]));
  await assert.rejects(plugin.checkSetup(), /Turn off the other sync plugin/);
  assert.equal(await host.files.exists(".git"), true);
  assert.deepEqual(host.files.writes, []);
});

test("Start syncing adopts an existing vault after review, preserving Git metadata and notes", async () => {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText("base") }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create(); host.put("a.md", "base");
  host.files.folders.add(".git"); host.files.values.set(".git/HEAD", "ref: refs/heads/main\n");
  const rename = host.app.vault.adapter.rename.bind(host.app.vault.adapter);
  host.app.vault.adapter.rename = async (from, to) => {
    if (from !== ".git") return rename(from, to);
    host.files.folders.delete(from); host.files.folders.add(to);
    for (const [name, data] of [...host.files.values]) if (name.startsWith(from + "/")) {
      host.files.values.set(to + name.slice(from.length), data); host.files.values.delete(name);
    }
  };
  await plugin.initialize();
  const preview = await plugin.session!.previewEnrollment();
  if (preview.kind !== "preview") throw Error("Expected setup preview");
  assert.equal((await plugin.startSyncing(preview.token)).kind, "enrolled");
  assert.equal(await host.files.exists(".git"), false);
  const kept = [...host.files.values].find(([path]) => path.endsWith("/dot-git/HEAD"));
  assert.equal(kept?.[1], "ref: refs/heads/main\n");
  assert.equal(new TextDecoder().decode(host.docs.get("a.md")?.data), "base");
  await plugin.assertSingleWriter();
});

function accessHost() {
  const host = harness(), secrets = new Map<string, string>([["secret", "old"]]);
  host.app.secretStorage = Object.assign(host.app.secretStorage, {
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, value: string) => { secrets.set(id, value); },
  });
  return { host, secrets };
}
function rejectWith(status: number | undefined, message: string) {
  Reflect.set(globalThis, "safetyAccess", async () => { throw Object.assign(new Error(message), { name: "GitHubError", status }); });
}
const accessOptions = () => Reflect.get(globalThis, "safetyAccessOptions") as ConstructorParameters<typeof GitHubRepository>[0];

test("a draft access check uses the typed repository and token without saving or reporting progress", async () => {
  loaded.useRepository(await MemoryRepository.create({ "a.md": await entryFromText("base") }));
  const { host } = accessHost(), plugin = host.create();
  Reflect.set(globalThis, "safetyAccess", undefined);
  await plugin.checkAccess({ owner: "someone", repository: "notes", branch: "dev", token: "typed" });
  const options = accessOptions();
  assert.deepEqual([options.owner, options.name, options.branch, await options.token()], ["someone", "notes", "dev", "typed"]);
  assert.equal(options.onReadProgress, undefined);
  assert.equal(plugin.settings.secretId, "secret");
  rejectWith(401, "GitHub API request rejected (HTTP 401)");
  await assert.rejects(plugin.checkAccess({ ...settings, token: "bad" }), /rejected this token/);
  rejectWith(404, "Unsupported enrollment: branch missing or repository empty/unborn");
  await assert.rejects(plugin.checkAccess(settings), /Branch "main" wasn't found/);
  rejectWith(404, "GitHub API request rejected (HTTP 404)");
  await assert.rejects(plugin.checkAccess(settings), /can't see me\/vault/);
  assert.deepEqual(plugin.activity, {});
  Reflect.set(globalThis, "safetyAccess", undefined);
});

test("a replacement token is saved under a fresh key only after it verifies; a failure keeps the working token", async () => {
  const { plugin } = await setup();
  const secrets = new Map<string, string>([["secret", "old"]]);
  plugin.app.secretStorage = Object.assign(plugin.app.secretStorage, {
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, value: string) => { secrets.set(id, value); },
  });
  rejectWith(401, "GitHub API request rejected (HTTP 401)");
  await assert.rejects(plugin.replaceToken(" wrong "), /rejected this token/);
  assert.equal(plugin.settings.secretId, "secret");
  assert.deepEqual([...secrets.keys()], ["secret"]);
  Reflect.set(globalThis, "safetyAccess", undefined);
  assert.equal(await plugin.replaceToken("stale", () => false), false);
  assert.deepEqual([...secrets.keys()], ["secret"]);
  assert.equal(await plugin.replaceToken(" fresh "), true);
  assert.equal(await accessOptions().token(), "fresh");
  const first = plugin.settings.secretId;
  assert.match(first, /^github-vault-sync-token-[0-9a-f-]{36}$/);
  assert.equal(secrets.get(first), "fresh");
  assert.equal(secrets.get("secret"), "old");
  assert.equal((plugin.app as unknown as { savedSettings: { secretId: string } }).savedSettings.secretId, first);
  assert.equal(await loaded.options().token(), "fresh");
  assert.equal(await plugin.replaceToken("newer"), true);
  assert.notEqual(plugin.settings.secretId, first);
  assert.equal(secrets.get(first), "fresh");
  assert.ok(plugin.activity.checkedAt);
});

test("access health records rejection, ignores being offline, and clears on the next successful sync", async () => {
  const { plugin } = await setup();
  rejectWith(undefined, "GitHub transport failed; request outcome may be unknown");
  await plugin.verifyAccess();
  assert.equal(plugin.activity.problem, undefined);
  Reflect.set(globalThis, "safetyAccess", async () => { throw Object.assign(new Error("GitHub rate limit; schedule a later attempt"), { status: 403, retryAt: Date.now() + 60_000 }); });
  await plugin.verifyAccess();
  assert.equal(plugin.activity.problem, undefined, "rate limiting is not a rejected token");
  await assert.rejects(plugin.checkAccess(settings), /limiting requests/);
  rejectWith(403, "GitHub API request rejected (HTTP 403)");
  await assert.rejects(plugin.checkAccess(settings), /Contents read and write/);
  rejectWith(401, "GitHub API request rejected (HTTP 401)");
  await plugin.verifyAccess();
  assert.match(plugin.activity.problem ?? "", /rejected this token/);
  Reflect.set(globalThis, "safetyAccess", undefined);
  await plugin.syncOnce();
  const activity = plugin.activity;
  assert.equal(activity.problem, undefined);
  assert.ok(activity.syncedAt && activity.checkedAt && activity.syncedAt === activity.checkedAt);
});

test("an access check that finishes after the token was replaced cannot record the old token's failure", async () => {
  const { plugin } = await setup();
  const secrets = new Map<string, string>([["secret", "old"]]);
  plugin.app.secretStorage = Object.assign(plugin.app.secretStorage, {
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, value: string) => { secrets.set(id, value); },
  });
  const gate = deferred();
  Reflect.set(globalThis, "safetyAccess", async () => { await gate.promise; throw Object.assign(new Error("GitHub API request rejected (HTTP 401)"), { status: 401 }); });
  const stale = plugin.verifyAccess();
  Reflect.set(globalThis, "safetyAccess", undefined);
  assert.equal(await plugin.replaceToken("fresh"), true);
  const verified = plugin.activity;
  gate.resolve(); await stale;
  assert.deepEqual(plugin.activity, verified);
  assert.equal(plugin.activity.problem, undefined);
});
