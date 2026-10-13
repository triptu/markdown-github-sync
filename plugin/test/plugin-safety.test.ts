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

const temporary = mkdtempSync(join(tmpdir(), "git-plugin-safety-"));
const hostModule = join(temporary, "obsidian.cjs");
const loadBundle = createRequire(import.meta.url);
async function bundle(name: string) {
  const outfile = join(temporary, name);
  await build({
    stdin: { contents: `export { default as GitVaultSync } from './src/main'; export { TFile } from 'obsidian'; export { GitObsidianVault } from './src/git-sync/obsidian-vault'; export function useRepository(repo) { globalThis.safetyRepository = repo; } export function options() { return globalThis.safetyOptions; }`, resolveDir: resolve(".") },
    bundle: true, platform: "node", format: "cjs", outfile,
    plugins: [{ name: "host-boundaries", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: hostModule, external: true }));
      build.onResolve({ filter: /^\.\/git-sync\/github$/ }, () => ({ path: "github", namespace: "host" }));
      build.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `export class GitHubRepository { constructor(options) { globalThis.safetyOptions = options; return globalThis.safetyRepository; } }` }));
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
};
// Separate plugin bundles share the host's Obsidian classes and App.
let loaded: BundleApi, reloaded: BundleApi;
before(async () => {
  await build({ entryPoints: [resolve("test/fixtures/obsidian-plugin.ts")], bundle: true, platform: "node", format: "cjs", outfile: hostModule });
  loaded = await bundle("first.cjs"); reloaded = await bundle("replacement.cjs");
  rmSync(temporary, { recursive: true, force: true });
});
class Files implements JournalFiles {
  values = new Map<string, string>(); folders = new Set<string>(); writes: string[] = [];
  async exists(path: string) { return this.values.has(path) || this.folders.has(path); }
  async mkdir(path: string) { this.writes.push(path); this.folders.add(path); }
  async read(path: string) { const value = this.values.get(path); if (value === undefined) throw Error("Missing file"); return value; }
  async write(path: string, text: string) { this.writes.push(path); this.values.set(path, text); }
  async rename(from: string, to: string) { this.writes.push(to); const value = await this.read(from); this.values.set(to, value); this.values.delete(from); }
  async list(path: string) { return { files: [...this.values.keys()].filter(key => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/")), folders: [] }; }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const settings = { format: 2 as const, owner: "me", repository: "vault", branch: "main", secretId: "secret", deviceName: "Lab", automatic: false };
function harness() {
  const docs = new Map<string, { file: InstanceType<typeof loaded.TFile>; data: Uint8Array }>();
  const local = new Map<string, unknown>(), files = new Files();
  let crashAfter = false, crashBefore = false;
  let beforeProcess: (() => Promise<void>) | null = null;
  const events = new Map<string, (file: { path: string }, oldPath?: string) => void>();
  const put = (path: string, text: string) => { const data = new TextEncoder().encode(text); docs.set(path, { file: new loaded.TFile(path, { size: data.length, mtime: 1 }), data }); };
  const app = {
    savedSettings: structuredClone(settings),
    loadLocalStorage: (key: string) => structuredClone(local.get(key) ?? null),
    saveLocalStorage: (key: string, value: unknown) => local.set(key, structuredClone(value)),
    secretStorage: { getSecret: (id: string) => `token:${id}` },
    workspace: { onLayoutReady: (_callback: () => void) => {} },
    vault: {
      on: (name: string, callback: (file: { path: string }, oldPath?: string) => void) => { events.set(name, callback); return {}; },
      adapter: files, configDir: ".obsidian",
      getFiles: () => [...docs.values()].map(d => d.file),
      getAbstractFileByPath: (path: string) => docs.get(path)?.file ?? null,
      readBinary: async (file: { path: string }) => docs.get(file.path)!.data.slice().buffer,
      createFolder: async () => {},
      createBinary: async (path: string, data: ArrayBuffer) => { if (docs.has(path)) throw Error("exists"); put(path, new TextDecoder("utf8", { ignoreBOM: true }).decode(data)); },
      process: async (file: { path: string }, fn: (text: string) => string) => {
        await beforeProcess?.();
        if (crashBefore) { crashBefore = false; throw Error("before native write"); }
        const next = fn(new TextDecoder("utf8", { ignoreBOM: true }).decode(docs.get(file.path)!.data)); put(file.path, next);
        if (crashAfter) { crashAfter = false; throw Error("after native write"); }
        return next;
      },
    },
  };
  const create = (replacement = false) => {
    const plugin = new (replacement ? reloaded : loaded).GitVaultSync(app as unknown as App, { id: "git-vault-sync", name: "GitHub Vault Sync", version: "test", minAppVersion: "1.11.4", description: "Safety test", author: "Test" }); plugin.app = app as unknown as App;
    plugin.settings = structuredClone(settings); Reflect.set(plugin, "ready", true); return plugin;
  };
  return { app, docs, files, local, put, create, emit: (name: string, path: string, oldPath?: string) => events.get(name)?.({ path }, oldPath), beforeProcess: (callback: () => Promise<void>) => { beforeProcess = callback; }, crashAfter: () => { crashAfter = true; }, crashBefore: () => { crashBefore = true; } };
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
  const sequences = [...host.files.values.keys()].filter(p => /\/records\/\d{12}-/.test(p) && !p.includes("/modes/")).map(p => p.match(/\/records\/(\d{12})-/)![1]);
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

test("pre-write restore interruption cannot change the current bytes or mode", async () => {
  const repo = await MemoryRepository.create({ "a.md": await entryFromText("historical\n", "100755") }); const history = repo.branchHead;
  await repo.push({ "a.md": await entryFromText("current\n", "100644") }); loaded.useRepository(repo);
  const host = harness(), plugin = host.create(); await plugin.initialize(); await enroll(plugin);
  const preview = await plugin.session!.previewRestore({ path: "a.md", commit: history });
  assert.equal(preview.kind, "preview"); if (preview.kind !== "preview") return;
  host.crashBefore(); await assert.rejects(plugin.session!.restore({ path: "a.md", commit: history, token: preview.token }), /before native write/);
  plugin.onunload(); const next = host.create(true); await next.initialize(); await next.syncOnce();
  assert.equal(entryText(repo.headFiles()["a.md"]), "current\n"); assert.equal(repo.headFiles()["a.md"].mode, "100644");
});

test("remote executable update still recovers after native write interruption", async () => {
  const { repo, host, plugin } = await setup(); await repo.push({ "a.md": await entryFromText("remote\n", "100755") });
  host.crashAfter(); await assert.rejects(plugin.session!.sync(), /after native write/);
  plugin.onunload(); const next = host.create(true); await next.initialize(); await next.syncOnce(); await next.syncOnce();
  assert.equal(repo.headFiles()["a.md"].mode, "100755"); assert.equal(entryText(repo.headFiles()["a.md"]), "remote\n");
});

test("file and folder renames retain executable mode through restart and deletion approval", async () => {
  const { repo, host, plugin } = await setup("executable\n", "100755");
  host.put("folder/a.md", "executable\n"); host.docs.delete("a.md"); await plugin.recordRename("a.md", "folder/a.md");
  host.put("moved/a.md", "executable\n"); host.docs.delete("folder/a.md"); await plugin.recordRename("folder", "moved");
  plugin.onunload(); const next = host.create(true); await next.initialize(); const outcome = await next.session!.sync();
  assert.equal(outcome.kind, "needs-decision"); if (outcome.kind !== "needs-decision") return;
  await next.session!.resolve({ conflictId: outcome.conflicts[0].id, choice: { kind: "mine" } }); await next.syncOnce();
  assert.equal(repo.headFiles()["a.md"], undefined); assert.equal(repo.headFiles()["moved/a.md"].mode, "100755");
});

test("saved drafts are isolated and enrollment identity binds every subsequent save", async () => {
  const { host, plugin } = await setup(); const draft = { ...plugin.settings }; await plugin.saveConfiguration(draft);
  draft.repository = "different"; draft.secretId = "unsaved";
  assert.equal(plugin.settings.repository, "vault"); assert.equal(plugin.settings.secretId, "secret"); assert.equal(await loaded.options().token(), "token:secret");
  await assert.rejects(plugin.saveConfiguration(draft), /bound to this vault/);
  plugin.settings.repository = "different"; await assert.rejects(plugin.saveConfiguration(draft), /bound to this vault/);
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

test("native create/modify/delete/rename notifications retire same-byte approvals before scheduling", async () => {
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
      Reflect.set(plugin, "scheduler", { stop() {}, schedule() {
        scheduled++;
        const latest = [...host.files.values.keys()].filter(p => /\/records\/\d{12}-/.test(p) && !p.includes("/modes/")).sort().at(-1)!;
        assert.deepEqual(JSON.parse(host.files.values.get(latest)!).decisions, {}, "notification must be durable before scheduling");
      } });
      // A complete edit/revert or recreate cycle can end at the same manifest.
      host.emit(kind, "a.md", "a.md");
      const outcome = await plugin.session!.sync();
      assert.equal(outcome.kind, "needs-decision", kind); assert.equal(scheduled, 1, kind);
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
  await assert.rejects(next.saveConfiguration({ ...settings, repository: "different" }), /bound to this vault/);
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
  await assert.rejects(next.syncOnce(), /mode intent has been retained/);
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
  const outcome = await plugin.session!.sync(); assert.equal(outcome.kind, "needs-decision");
  if (outcome.kind !== "needs-decision") throw Error("missing deletion review");
  await plugin.session!.resolve({ conflictId: outcome.conflicts[0].id, choice: { kind: "mine" } }); await plugin.syncOnce();
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

test("a notification fenced by unload remains pending across bundles and retires saved approvals", async () => {
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
  assert.equal(outcome.kind, "needs-decision", "replacement must not reuse an approval from before the observed cycle");
  assert.equal(entryText(repo.headFiles()["a.md"]), "remote\n");
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
  const outcome = await next.session!.sync(); assert.equal(outcome.kind, "needs-decision");
  if (outcome.kind !== "needs-decision") throw Error("missing deletion review");
  await next.session!.resolve({ conflictId: outcome.conflicts[0].id, choice: { kind: "mine" } }); await next.syncOnce();
  assert.equal(repo.headFiles()["renamed.md"].mode, "100755");
});

test("native same-byte recreate/delete events invalidate an approval already loaded by active sync", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  try {
    const { repo, host, plugin } = await setup(); await plugin.onload(); host.docs.delete("a.md");
    const reviewed = await plugin.session!.sync(); assert.equal(reviewed.kind, "needs-decision");
    if (reviewed.kind !== "needs-decision") throw Error("missing deletion review");
    const approval = reviewed.conflicts[0].id;
    await plugin.session!.resolve({ conflictId: approval, choice: { kind: "mine" } });
    const arrived = deferred(), release = deferred(), head = repo.head.bind(repo);
    repo.head = async () => { const result = await head(); arrived.resolve(); await release.promise; return result; };
    const run = plugin.syncOnce(); await arrived.promise;
    host.put("a.md", "base\n"); host.emit("create", "a.md"); host.docs.delete("a.md"); host.emit("delete", "a.md");
    release.resolve(); await run; repo.head = head;
    assert.equal(entryText(repo.headFiles()["a.md"]), "base\n", "an observed cycle must not consume the earlier deletion approval");
    const outcome = await plugin.session!.sync(); assert.equal(outcome.kind, "needs-decision");
    if (outcome.kind !== "needs-decision") throw Error("missing renewed review");
    assert.notEqual(outcome.conflicts[0].id, approval); plugin.onunload();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document");
  }
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
