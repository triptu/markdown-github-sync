import type { DataAdapter } from "obsidian";
import type { FileMode, Snapshot, UnreadableFile } from "./contracts";
import { dictionary, entryFromBytes, isValidPath } from "./codec";
import { assertNoNestedGitignore, assertValidConfigDir, type Scope } from "./scope";

type ReadFiles = Pick<DataAdapter, "exists" | "list" | "stat" | "readBinary">;
const FILE_LIMIT = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT = 128 * 1024 * 1024;

/** Reads configuration without relying on Obsidian's visible-file index. Never writes or reloads plugins. */
export class HiddenConfigPort {
  constructor(
    private files: ReadFiles,
    private configDir: string,
    private assertActive: () => void,
  ) {
    assertValidConfigDir(configDir);
  }

  /** Names only: ignored bytes are never read, but unsupported nested ignore files must be detected. */
  async inventory(): Promise<string[]> {
    const paths = new Set<string>();
    const seen = new Set<string>();
    const pending: string[] = [];
    this.assertActive();
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
      const bytes = new Uint8Array(await this.files.readBinary(path));
      this.assertActive();
      if (bytes.length > FILE_LIMIT) {
        unreadable.push({ path, size: bytes.length, mtime: stat.mtime, reason: "oversize" });
        continue;
      }
      total += bytes.length;
      if (total > SNAPSHOT_LIMIT) throw new Error("Configuration snapshot exceeds 128 MiB");
      files[path] = await entryFromBytes(bytes, mode(path));
    }
    this.assertActive();
    return { files, unreadable };
  }
}
