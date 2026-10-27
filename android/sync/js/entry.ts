// The Android app's sync engine: the plugin's SyncSession, GitHubRepository
// and FileJournalStore, unchanged, over host ports for files and HTTP.
// Kotlin calls `__api.call(method, argsJson)` and gets back JSON
// `{ ok: result }` or `{ error: { category, message, status?, retryAt? } }`.
import "./polyfills";
import { exact, host } from "./host";
import { GitHubRepository } from "../../../plugin/src/git-sync/github";
import type { GitHubTransport } from "../../../plugin/src/git-sync/github";
import { SyncSession } from "../../../plugin/src/git-sync/session";
import type { ChoiceInput, SessionStatus, SyncOutcome } from "../../../plugin/src/git-sync/session";
import { FileJournalStore } from "../../../plugin/src/git-sync/store";
import type { JournalFiles } from "../../../plugin/src/git-sync/store";
import { dictionary, encodeBase64, entryText, isValidPath, trustVerifiedEntry, withMode, yieldToHost } from "../../../plugin/src/git-sync/codec";
import type { ApplyResult, Entry, FileMode, LocalVault, Snapshot, UnreadableFile } from "../../../plugin/src/git-sync/contracts";
import type { Conflict } from "../../../plugin/src/git-sync/reconcile";
import type { Scope } from "../../../plugin/src/git-sync/scope";
import { accessProblem, failure, offline, outcomeAttention, rejectedAccess } from "../../../plugin/src/ui/copy";

/**
 * The app keeps no Obsidian settings. A configuration directory no vault uses
 * puts every `.obsidian/` path (and every other hidden path) out of scope,
 * so the engine never reads, writes or deletes them.
 */
const CONFIG_DIR = ".notes-app";
const FILE_LIMIT = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT = 128 * 1024 * 1024;
/** A same-size rewrite within this window may keep the mtime, so recent stats prove nothing. */
const RACY_WINDOW_MS = 5_000;

interface OpenConfig {
  owner: string;
  name: string;
  branch: string;
  deviceName: string;
  installationId: string;
  /** Lowercase extensions left on GitHub and fetched on demand. */
  excludedExtensions: string[];
}

/** LocalVault over the app's private vault folder; the host does compare-and-swap writes. */
class HostVault implements LocalVault {
  private cache = new Map<string, { size: number; mtime: number; entry: Entry }>();

  async capture(scope: Scope): Promise<Snapshot> {
    const { files, unreadable } = await this.scan(scope);
    if (unreadable.length) throw new Error(`File exceeds 8 MiB: ${unreadable[0].path}`);
    return files;
  }

  /** Read-only. Unchanged files (same size and mtime, outside the racy window) reuse their last entry. */
  async scan(scope: Scope): Promise<{ files: Snapshot; unreadable: UnreadableFile[] }> {
    const listing = JSON.parse(host.vaultList()) as [string, number, number, boolean][];
    const files: Snapshot = dictionary();
    const unreadable: UnreadableFile[] = [];
    const seen = new Set<string>();
    let total = 0, count = 0;
    for (const [path, size, mtime, executable] of listing) {
      if (++count % 256 === 0) await yieldToHost();
      if (!isValidPath(path) || !scope.includes(path)) continue;
      if (size > FILE_LIMIT) { unreadable.push({ path, size, mtime, reason: "oversize" }); continue; }
      const mode: FileMode = executable ? "100755" : "100644";
      const cached = this.cache.get(path);
      if (cached && cached.size === size && cached.mtime === mtime) {
        total += size;
        if (total > SNAPSHOT_LIMIT) throw new Error("Vault content exceeds the 128 MiB safety limit.");
        files[path] = withMode(cached.entry, mode);
        seen.add(path);
        continue;
      }
      this.cache.delete(path);
      const read = this.read(path);
      if (read === null) throw new Error("The vault changed during capture. Sync will retry.");
      if ("oversize" in read) { unreadable.push({ path, size: read.oversize, mtime, reason: "oversize" }); continue; }
      total += read.size;
      if (total > SNAPSHOT_LIMIT) throw new Error("Vault content exceeds the 128 MiB safety limit.");
      // The host hashed exactly the bytes it encoded.
      const entry = trustVerifiedEntry({ oid: read.oid, mode, data: read.data });
      files[path] = entry;
      seen.add(path);
      if (read.size === size && read.mtime === mtime && Date.now() - mtime > RACY_WINDOW_MS)
        this.cache.set(path, { size, mtime, entry: withMode(entry, entry.mode) });
    }
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path);
    return { files, unreadable };
  }

  private read(path: string): { data: string; oid: string; size: number; mtime: number } | { oversize: number } | null {
    return JSON.parse(host.vaultRead(path));
  }

  /** Download hint for the repository: never throws, never writes. */
  async readCandidate(path: string, expectedSize: number): Promise<Entry | null> {
    try {
      if (!isValidPath(path) || expectedSize > FILE_LIMIT) return null;
      const cached = this.cache.get(path);
      if (cached && cached.size === expectedSize) return withMode(cached.entry, cached.entry.mode);
      const read = this.read(path);
      if (read === null || "oversize" in read || read.size !== expectedSize) return null;
      return trustVerifiedEntry({ oid: read.oid, mode: "100644", data: read.data });
    } catch {
      return null;
    }
  }

  async apply(path: string, expected: Entry | null, next: Entry | null): Promise<ApplyResult> {
    if (!isValidPath(path)) return { kind: "blocked", reason: `Invalid path: ${path}` };
    this.cache.delete(path);
    const result = host.vaultApply(path, expected?.oid ?? null, next?.data ?? null, next?.oid ?? null, next?.mode === "100755");
    if (result === "applied" || result === "changed") return { kind: result };
    if (result.startsWith("blocked:")) return { kind: "blocked", reason: result.slice("blocked:".length) };
    throw new Error(`Unexpected vault result for ${path}`);
  }
}

const journalFiles: JournalFiles = {
  exists: async (path) => host.journal("exists", path, null) === "true",
  mkdir: async (path) => { host.journal("mkdir", path, null); },
  read: async (path) => host.journal("read", path, null),
  write: async (path, data) => { host.journal("write", path, data); },
  rename: async (from, to) => { host.journal("rename", from, to); },
  list: async (path) => JSON.parse(host.journal("list", path, null)),
  remove: async (path) => { host.journal("remove", path, null); },
};

const transport: GitHubTransport = {
  async request(request) {
    const raw = JSON.parse(await host.http(JSON.stringify(request))) as { status: number; headers: Record<string, string>; body: string };
    let json: unknown = null;
    try { json = JSON.parse(raw.body); } catch { /* The repository rejects malformed answers. */ }
    return { status: raw.status, headers: raw.headers, json };
  },
  async requestArchive(request) {
    const [status, headers, bytes] = await host.archive(JSON.stringify(request));
    return { status, headers: JSON.parse(headers), bytes: exact(bytes) };
  },
};

interface Opened { config: OpenConfig; repository: GitHubRepository; session: SyncSession }
let opened: Opened | null = null;

function open(config: OpenConfig): { opened: true } {
  const vault = new HostVault();
  const repository = new GitHubRepository({
    owner: config.owner,
    name: config.name,
    branch: config.branch,
    installation: config.installationId,
    configDir: CONFIG_DIR,
    ...(config.excludedExtensions.length ? { excludedExtensions: config.excludedExtensions } : {}),
    transport,
    token: () => host.token(),
    readLocal: (path, size) => vault.readCandidate(path, size),
    onReadProgress: (done, total) => host.progress(done, total),
  });
  const store = new FileJournalStore(journalFiles, config.installationId);
  const session = new SyncSession({ repository, vault, store, deviceName: config.deviceName });
  opened = { config, repository, session };
  return { opened: true };
}

function current(): Opened {
  if (!opened) throw new Error("Sync is not set up on this device.");
  return opened;
}

// ---- Projections for the host: plain data, text instead of base64 ----------

function version(entry: Entry | null) {
  if (!entry) return null;
  const text = entryText(entry);
  return { oid: entry.oid, text, binary: text === null };
}

function conflict(item: Conflict) {
  switch (item.kind) {
    case "collision": return { kind: item.kind, id: item.id, paths: item.paths };
    case "bulk-deletion": return { kind: item.kind, id: item.id, paths: item.paths, direction: item.direction };
    default:
      return { kind: item.kind, id: item.id, path: item.path, choices: item.choices,
        sibling: "sibling" in item ? item.sibling : null,
        base: version(item.base), local: version(item.local), remote: version(item.remote) };
  }
}

function status(value: SessionStatus) {
  if (value.kind !== "enrolled") return value;
  return {
    kind: value.kind, commit: value.commit, phase: value.phase, pause: value.pause,
    conflicts: value.conflicts.map(conflict), blocked: value.blocked, carried: value.carried,
    pending: value.pending, unreadable: value.unreadable?.map((item) => item.path) ?? null,
  };
}

function outcome(value: SyncOutcome) {
  const attention = outcomeAttention(value)?.text ?? null;
  return value.kind === "needs-decision"
    ? { ...value, conflicts: value.conflicts.map(conflict), attention }
    : { ...value, attention };
}

function choice(input: unknown): ChoiceInput {
  if (input === "mine" || input === "remote" || input === "both") return { kind: input };
  if (typeof input === "object" && input !== null && typeof Reflect.get(input, "edit") === "string")
    return { kind: "edit", data: encodeBase64(new TextEncoder().encode(Reflect.get(input, "edit"))) };
  throw new Error("Unknown choice");
}

const handlers: Record<string, (args: any) => Promise<unknown> | unknown> = {
  open,
  status: async () => status(await current().session.status()),
  inspect: async () => status(await current().session.inspect()),
  checkAccess: async () => { await current().repository.checkAccess(); return { ok: true }; },
  previewEnrollment: async () => current().session.previewEnrollment(),
  enroll: async (args: { token: string }) => current().session.enroll({ token: args.token }),
  sync: async () => outcome(await current().session.sync()),
  resolve: async (args: { conflictId: string; choice: unknown }) =>
    current().session.resolve({ conflictId: args.conflictId, choice: choice(args.choice) }),
  keepLocal: async (args: { path: string }) => current().session.keepLocal({ path: args.path }),
};

function describe(error: unknown) {
  const status = typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
  const retryAt = typeof error === "object" && error !== null ? Reflect.get(error, "retryAt") : undefined;
  const target = opened ? { owner: opened.config.owner, repository: opened.config.name, branch: opened.config.branch } : null;
  const category = rejectedAccess(error) ? "access" : offline(error) ? "offline" : "other";
  const message = category === "access" && target ? accessProblem(error, target) : failure(error);
  const cause = typeof error === "object" && error !== null ? Reflect.get(error, "cause") : undefined;
  return {
    category, message,
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof retryAt === "number" ? { retryAt } : {}),
    ...(cause instanceof Error ? { cause: cause.message } : {}),
  };
}

Reflect.set(globalThis, "__api", {
  async call(method: string, argsJson: string): Promise<string> {
    try {
      const handler = handlers[method];
      if (!handler) throw new Error(`Unknown sync method: ${method}`);
      return JSON.stringify({ ok: await handler(JSON.parse(argsJson)) ?? null });
    } catch (error) {
      return JSON.stringify({ error: describe(error) });
    }
  },
});
