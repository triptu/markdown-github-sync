import type { DataAdapter } from "obsidian";
import type { Entry, FileMode, Snapshot, UnreadableFile } from "./contracts";
import { dictionary, entryFromBytes, isValidPath, withMode } from "./codec";
import { assertNoNestedGitignore, assertValidConfigDir, canonicalFilesystemPath, type Scope } from "./scope";

type ReadFiles = Pick<DataAdapter, "exists" | "list" | "stat" | "readBinary">;
const FILE_LIMIT = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT = 128 * 1024 * 1024;
/**
 * A file whose mtime is this recent may still be rewritten within the same
 * timestamp granule (FAT/exFAT storage has 2 s), so its stat proves nothing.
 */
export const racyWindowMs = 5_000;
export interface ScanKey { size: number; mtime: number; ctime: number | null }
/** Entries reused while a file keeps the same complete stat. Shared by visible and configuration scans. */
export type ScanCache = Map<string, ScanKey & { entry: Entry }>;
/** A cache key only for a complete stat; anything missing disables caching. */
export function scanKey(stat: { size: unknown; mtime: unknown; ctime?: unknown }): ScanKey | null {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!valid(stat.size) || !valid(stat.mtime) || stat.mtime === 0) return null;
  return { size: stat.size, mtime: stat.mtime, ctime: valid(stat.ctime) ? stat.ctime : null };
}
export function sameScanKey(a: ScanKey, b: ScanKey): boolean {
  return a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}

/** Reads configuration without relying on Obsidian's visible-file index. Never writes or reloads plugins. */
export class HiddenConfigPort {
  constructor(
    private files: ReadFiles,
    private configDir: string,
    private assertActive: () => void,
    /**
     * Optional entries from earlier scans, reused under the same rules as the
     * visible scan: a complete stat equal in size, mtime and ctime, bytes
     * whose length matched that stat, and an mtime outside the racy window
     * when cached. The owner must drop paths it writes.
     */
    private cache?: ScanCache,
    private now: () => number = () => Date.now(),
  ) {
    assertValidConfigDir(configDir);
  }

  /** Names only: ignored bytes are never read, but unsupported nested ignore files must be detected. */
  async inventory(): Promise<string[]> {
    const paths = new Set<string>();
    const seen = new Set<string>();
    const pending: string[] = [];
    this.assertActive();
    // `exists(".gitignore")` can resolve `.GITIGNORE` on a case-insensitive
    // adapter. Enumerate names first so that spelling cannot be hidden.
    const root = await this.files.list("/");
    for (const path of [...root.files, ...root.folders]) {
      const name = path.replace(/^\/+/, "");
      if (canonicalFilesystemPath(name) === ".gitignore") assertNoNestedGitignore([name]);
    }
    if (await this.files.exists(".gitignore")) paths.add(".gitignore");
    if (await this.files.exists(this.configDir)) pending.push(this.configDir);
    while (pending.length) {
      const directory = pending.pop();
      if (directory === undefined) break;
      if (seen.has(directory)) throw new Error("Repeated configuration directory");
      seen.add(directory);
      this.assertActive();
      const listed = await this.files.list(directory);
      const child = (path: string): void => {
        if (!isValidPath(path) || !path.startsWith(`${directory}/`) || path.slice(directory.length + 1).includes("/"))
          throw new Error(`Invalid configuration listing beneath ${directory}`);
        if (paths.has(path) || seen.has(path) || pending.includes(path)) throw new Error("Duplicate configuration listing");
      };
      for (const path of listed.files) { child(path); paths.add(path); }
      for (const path of listed.folders) { child(path); pending.push(path); }
      if (paths.size + seen.size + pending.length > 50_000) throw new Error("Configuration inventory exceeds 50,000 entries");
    }
    this.assertActive();
    return [...paths].sort();
  }

  async scan(scope: Scope, mode: (path: string) => FileMode = () => "100644"):
    Promise<{ files: Snapshot; unreadable: UnreadableFile[] }> {
    if (scope.rules.configDir !== this.configDir) throw new Error("Configuration directory does not match the repository scope");
    const files: Snapshot = dictionary();
    const unreadable: UnreadableFile[] = [];
    if (scope.rules.rules === "visible-only") return { files, unreadable };
    const paths = await this.inventory();
    assertNoNestedGitignore(paths);
    let total = 0;
    const seen = new Set<string>();
    for (const path of paths) {
      if (!scope.includes(path)) continue;
      this.assertActive();
      const stat = await this.files.stat(path);
      if (!stat || stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtime))
        throw new Error(`Configuration file changed or cannot be inspected: ${path}`);
      if (stat.size > FILE_LIMIT) {
        unreadable.push({ path, size: stat.size, mtime: stat.mtime, reason: "oversize" });
        continue;
      }
      seen.add(path);
      const key = this.cache ? scanKey(stat) : null;
      const cached = key ? this.cache?.get(path) : undefined;
      if (key && cached && sameScanKey(cached, key)) {
        total += key.size;
        if (total > SNAPSHOT_LIMIT) throw new Error("Configuration snapshot exceeds 128 MiB");
        files[path] = withMode(cached.entry, mode(path));
        continue;
      }
      this.cache?.delete(path);
      const bytes = new Uint8Array(await this.files.readBinary(path));
      this.assertActive();
      if (bytes.length > FILE_LIMIT) {
        unreadable.push({ path, size: bytes.length, mtime: stat.mtime, reason: "oversize" });
        continue;
      }
      total += bytes.length;
      if (total > SNAPSHOT_LIMIT) throw new Error("Configuration snapshot exceeds 128 MiB");
      const entry = await entryFromBytes(bytes, mode(path));
      files[path] = entry;
      if (key && bytes.length === key.size && this.now() - key.mtime > racyWindowMs)
        this.cache?.set(path, { ...key, entry: withMode(entry, entry.mode) }); // Private copy.
    }
    if (this.cache) for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path);
    this.assertActive();
    return { files, unreadable };
  }
}
