// In-memory contract ports for engine tests, with fault injection at every
// durable, publication and apply boundary.
import type {
  ApplyResult,
  Changes,
  CommitSnapshot,
  DurableStore,
  Entry,
  LocalVault,
  PublishResult,
  Repository,
  RepositoryIdentity,
  Snapshot,
} from "../src/git-sync/contracts";
import { digestText, entryFromBytes, entryFromText, entryText, isExcludedPath, sameEntry } from "../src/git-sync/codec";

export class Crash extends Error {
  override name = "Crash";
}

/** Fault hooks: return/throw to inject. `when` lets a test target the nth call. */
export type Fault = "before" | "after" | null;

interface CommitObject {
  oid: string;
  tree: string;
  parent: string | null;
  files: Snapshot; // full tree, including excluded paths
}

/** A GitHub-like branch: immutable commits, exact-head conditional publication. */
export class MemoryRepository implements Repository {
  readonly commits = new Map<string, CommitObject>();
  branchHead: string;
  identityValue: RepositoryIdentity = { id: "R_1", owner: "me", name: "vault", branch: "main" };
  /** `after` = ref moves but the response is lost (thrown); `lost` = ref moves, result "unknown". */
  publishFault: "before" | "after" | "lost" | "head-moved-lie" | "reject" | null = null;
  prepareFault: Fault = null;
  headFault = false;
  ancestorFault = false;
  calls: string[] = [];
  private sequence = 0;

  private constructor(root: CommitObject) {
    this.commits.set(root.oid, root);
    this.branchHead = root.oid;
  }

  static async create(files: Snapshot): Promise<MemoryRepository> {
    const root = await MemoryRepository.object(files, null, 0);
    return new MemoryRepository(root);
  }

  private static async object(files: Snapshot, parent: string | null, sequence: number): Promise<CommitObject> {
    const manifest = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, entry]) => [path, entry.mode, entry.oid]);
    const tree = await digestText(JSON.stringify(manifest));
    const oid = await digestText(JSON.stringify([tree, parent, sequence]));
    return { oid, tree, parent, files: { ...files } };
  }

  private view(commit: CommitObject): CommitSnapshot {
    const files: Snapshot = {};
    for (const [path, entry] of Object.entries(commit.files)) if (!isExcludedPath(path)) files[path] = { ...entry };
    return { oid: commit.oid, treeOid: commit.tree, files };
  }

  /** Another client's ordinary commit on top of the current head. */
  async push(changes: Changes): Promise<string> {
    const parent = this.commits.get(this.branchHead)!;
    const files = { ...parent.files };
    for (const [path, entry] of Object.entries(changes)) {
      if (entry) files[path] = entry;
      else delete files[path];
    }
    const commit = await MemoryRepository.object(files, parent.oid, ++this.sequence);
    this.commits.set(commit.oid, commit);
    this.branchHead = commit.oid;
    return commit.oid;
  }

  /** Force-moves the branch (history rewrite). */
  async forceReset(files: Snapshot): Promise<string> {
    const commit = await MemoryRepository.object(files, null, ++this.sequence);
    this.commits.set(commit.oid, commit);
    this.branchHead = commit.oid;
    return commit.oid;
  }

  headFiles(): Snapshot {
    return this.view(this.commits.get(this.branchHead)!).files;
  }

  fullHeadFiles(): Snapshot {
    return { ...this.commits.get(this.branchHead)!.files };
  }

  async identity(): Promise<RepositoryIdentity> {
    return { ...this.identityValue };
  }

  async head(): Promise<CommitSnapshot> {
    this.calls.push("head");
    if (this.headFault) throw new Crash("head unavailable");
    return this.view(this.commits.get(this.branchHead)!);
  }

  async readCommit(oid: string): Promise<CommitSnapshot> {
    this.calls.push("readCommit");
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`no commit ${oid}`);
    return this.view(commit);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    this.calls.push("isAncestor");
    if (this.ancestorFault) throw new Crash("ancestry unavailable");
    let cursor: string | null = descendant;
    while (cursor) {
      if (cursor === ancestor) return true;
      cursor = this.commits.get(cursor)?.parent ?? null;
    }
    return false;
  }

  async prepare(parent: CommitSnapshot, changes: Changes, _message: string): Promise<CommitSnapshot> {
    this.calls.push("prepare");
    if (this.prepareFault === "before") throw new Crash("prepare failed");
    const base = this.commits.get(parent.oid)!;
    const files = { ...base.files }; // excluded entries survive via the base tree
    for (const [path, entry] of Object.entries(changes)) {
      if (entry) files[path] = entry;
      else delete files[path];
    }
    const commit = await MemoryRepository.object(files, parent.oid, ++this.sequence);
    this.commits.set(commit.oid, commit);
    if (this.prepareFault === "after") throw new Crash("prepare response lost");
    return this.view(commit);
  }

  async publish(expectedHead: string, candidate: string): Promise<PublishResult> {
    this.calls.push("publish");
    const fault = this.publishFault;
    if (fault === "before") throw new Crash("publish request failed");
    if (fault === "reject") return { kind: "rejected", message: "protected branch" };
    if (this.branchHead !== expectedHead) return { kind: "head-moved" };
    if (fault === "head-moved-lie") {
      this.branchHead = candidate;
      return { kind: "head-moved" };
    }
    this.branchHead = candidate;
    if (fault === "after") throw new Crash("publish response lost");
    if (fault === "lost") return { kind: "unknown" };
    return { kind: "accepted" };
  }
}

export type ApplyHook = (path: string, vault: MemoryVault) => Promise<void> | void;

/** A vault with compare-and-swap writes; binary replacement/deletion can be blocked like the Obsidian adapter. */
export class MemoryVault implements LocalVault {
  files = new Map<string, Entry>();
  blockBinary = false;
  /** Runs before the CAS check of each apply: simulates the user editing during application. */
  beforeApply: ApplyHook | null = null;
  applyFault: { at: number; when: "before" | "after" } | null = null;
  applied: string[] = [];
  /** Total apply calls, for targeting faults. */
  applyCalls = 0;

  constructor(initial: Snapshot = {}) {
    for (const [path, entry] of Object.entries(initial)) this.files.set(path, entry);
  }

  async capture(): Promise<Snapshot> {
    return Object.fromEntries([...this.files].map(([path, entry]) => [path, { ...entry }]));
  }

  async apply(path: string, expected: Entry | null, next: Entry | null): Promise<ApplyResult> {
    const count = ++this.applyCalls;
    if (this.applyFault?.at === count && this.applyFault.when === "before") throw new Crash(`apply ${path} failed`);
    await this.beforeApply?.(path, this);
    const current = this.files.get(path) ?? null;
    if (!sameEntry(current, expected)) return { kind: "changed" };
    if (this.blockBinary && current && !path.endsWith(".md")) return { kind: "blocked", reason: "binary replacement/deletion is unsupported" };
    if (next) this.files.set(path, next);
    else this.files.delete(path);
    this.applied.push(path);
    if (this.applyFault?.at === count && this.applyFault.when === "after") throw new Crash(`apply ${path} response lost`);
    return { kind: "applied" };
  }

  text(path: string): string | null {
    const entry = this.files.get(path);
    return entry ? entryText(entry) : null;
  }

  async write(path: string, text: string): Promise<void> {
    this.files.set(path, await entryFromText(text));
  }
}

/** JSON round-trips every save, like a real file; can fail before or after the write lands. */
export class MemoryStore implements DurableStore {
  raw: string | null = null;
  saves = 0;
  fault: { at: number; when: "before" | "after" } | null = null;

  async load(): Promise<unknown> {
    return this.raw === null ? undefined : JSON.parse(this.raw);
  }

  async save(state: unknown): Promise<void> {
    const count = ++this.saves;
    if (this.fault?.at === count && this.fault.when === "before") throw new Crash("save failed");
    this.raw = JSON.stringify(state);
    if (this.fault?.at === count && this.fault.when === "after") throw new Crash("save acknowledged lost");
  }
}

export const text = (value: string) => entryFromText(value);
export const bytes = (values: number[]) => entryFromBytes(new Uint8Array(values));

export async function snapshot(files: Record<string, string | Entry>): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const [path, value] of Object.entries(files)) result[path] = typeof value === "string" ? await entryFromText(value) : value;
  return result;
}

export function texts(files: Snapshot): Record<string, string | null> {
  return Object.fromEntries(Object.entries(files).map(([path, entry]) => [path, entryText(entry)]));
}
