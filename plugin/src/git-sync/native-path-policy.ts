import type { DataAdapter } from "obsidian";
import { isValidPath } from "./codec";
import { assertNoNestedGitignore, assertValidConfigDir, canonicalFilesystemPath,
  compileScope, type Scope } from "./scope";

export interface NativePolicyBinding { readonly rules: "config/1"; readonly configDir: string }

/** Built-in path admission only. Commit-specific ignore and consent belong to the engine. */
export class NativePathPolicy {
  static async forConfig(configDir: string): Promise<NativePathPolicy> {
    assertValidConfigDir(configDir);
    const scope = await compileScope({ rules: "config/1", configDir, gitignore: null }, null);
    return new NativePathPolicy({ rules: "config/1", configDir }, scope);
  }

  private constructor(readonly binding: NativePolicyBinding, private readonly builtinScope: Scope) {}

  allows(path: string): boolean {
    return this.builtinScope.includes(path);
  }

  includes(path: string): boolean { return this.allows(path); }
}

export interface LocalInventory { files: Set<string>; folders: Set<string> }

/**
 * Folders whose every descendant is denied by every scope (`.git`,
 * `.git-vault-sync`, export directories, `.trash`, at any depth). Their own
 * names still enter an inventory, so aliases of them are still detected; a
 * descendant could only alias another descendant of a denied folder.
 */
export function isOpaqueFolder(path: string): boolean {
  const name = canonicalFilesystemPath(path.slice(path.lastIndexOf("/") + 1));
  return name === ".git" || name === ".git-vault-sync" || name.startsWith(".git-vault-sync-export-") || name === ".trash";
}

/**
 * Adapter names, including ignored and denied entries; never reads file bytes.
 * With `pruneOpaque`, folders matching `isOpaqueFolder` are listed by name
 * but not walked (the plugin journal, `.git` directories and trash).
 */
export async function inventoryLocal(files: Pick<DataAdapter, "list">, assertActive: () => void,
  options: { pruneOpaque?: boolean } = {}): Promise<LocalInventory> {
  const inventory: LocalInventory = { files: new Set(), folders: new Set() };
  const pending = [""];
  const visited = new Set<string>();
  while (pending.length) {
    const directory = pending.pop();
    if (directory === undefined) break;
    if (visited.has(directory)) throw new Error(`Repeated local directory: ${directory}`);
    visited.add(directory);
    assertActive();
    const listed = await files.list(directory || "/");
    const add = (listedPath: string, kind: "file" | "folder") => {
      const path = directory === "" && listedPath.startsWith("/") ? listedPath.slice(1) : listedPath;
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (!isValidPath(path) || parent !== directory || inventory.files.has(path) || inventory.folders.has(path))
        throw new Error(`Invalid local listing beneath ${directory || "vault root"}: ${path}`);
      if (kind === "file") inventory.files.add(path);
      else {
        inventory.folders.add(path);
        if (!(options.pruneOpaque && isOpaqueFolder(path))) pending.push(path);
      }
      if (inventory.files.size + inventory.folders.size > 100_000)
        throw new Error("Local path inventory exceeds 100,000 entries");
    };
    for (const path of listed.files) add(path, "file");
    for (const path of listed.folders) add(path, "folder");
  }
  assertActive();
  return inventory;
}

function prefixes(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Detect aliases against excluded names and ancestor directories before bytes or writes. */
export function assertLocalNamespace(inventory: LocalInventory, scope: Pick<Scope, "includes">, target?: string): void {
  const names = [...inventory.files, ...inventory.folders];
  assertNoNestedGitignore(names);
  const protectedNames = new Set<string>();
  for (const path of inventory.files) if (scope.includes(path))
    for (const prefix of prefixes(path)) protectedNames.add(prefix);
  if (target) for (const prefix of prefixes(target)) protectedNames.add(prefix);
  const seen = new Map<string, string>();
  for (const path of names) {
    const folded = canonicalFilesystemPath(path);
    const prior = seen.get(folded);
    if (prior && prior !== path && (protectedNames.has(prior) || protectedNames.has(path)))
      throw new Error(`Case or Unicode path collision: ${prior} and ${path}`);
    seen.set(folded, path);
  }
  if (target) for (const prefix of prefixes(target)) {
    const prior = seen.get(canonicalFilesystemPath(prefix));
    if (prior && prior !== prefix) throw new Error(`Case or Unicode path collision: ${prior} and ${prefix}`);
    if (prefix !== target && inventory.files.has(prefix))
      throw new Error(`File blocks configuration directory: ${prefix}`);
  }
}
