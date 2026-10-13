// In-memory contract ports for engine tests, with fault injection at every
// durable, publication and apply boundary.
import type {
  ApplyResult,
  Changes,
  CommitSnapshot,
  DurableStore,
  Entry,
  LedgerRead,
  LocalVault,
  NativeIssue,
  PendingIntent,
  PreparedPublication,
  RecoveryAuthorization,
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
  /** First parent; ledger receipts also name the candidate as a second parent. */
  parent: string | null;
  parents: string[];
  files: Snapshot; // full tree, including excluded paths
  /** Set for device-ledger objects. */
  ledger?: "receipt" | "seal";
}

export type PublishFault =
  /** Request lost before delivery (thrown). */
  | "before"
  /** Applied atomically, response lost (thrown). */
  | "after"
  /** Applied atomically, then a generic GraphQL error. */
  | "error-after"
  /** Held in `delayed` and delivered only by `deliver()`; the caller sees a thrown loss. */
  | "delay"
  /** Generic error without effect. */
  | "reject"
  | null;

const BRANCH = "refs/heads/main";

/**
 * A GitHub-like repository: immutable commits, a branch, per-installation
 * ledger refs, and atomic multi-ref compare-and-swap with fault injection.
 */
export class MemoryRepository {
  readonly commits = new Map<string, CommitObject>();
  branchHead: string;
  readonly refs = new Map<string, string>();
  identityValue: RepositoryIdentity = { id: "R_1", owner: "me", name: "vault", branch: "main" };
  publishFault: PublishFault = null;
  sealFault: PublishFault = null;
  /** One-shot faults consumed per call before falling back to the standing fault. */
  publishQueue: PublishFault[] = [];
  sealQueue: PublishFault[] = [];
  prepareFault: Fault = null;
  headFault = false;
  ancestorFault = false;
  ledgerFault = false;
  /** Requests in flight: delivering one runs its atomic CAS now. */
  delayed: Array<{ label: string; deliver: () => boolean }> = [];
  calls: string[] = [];
  private sequence = 0;

  private constructor(root: CommitObject) {
    this.commits.set(root.oid, root);
    this.branchHead = root.oid;
  }

  static async create(files: Snapshot): Promise<MemoryRepository> {
    const root = await MemoryRepository.object(files, [], 0);
    return new MemoryRepository(root);
  }

  private static async object(files: Snapshot, parents: string[], sequence: number, label = ""): Promise<CommitObject> {
    const manifest = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, entry]) => [path, entry.mode, entry.oid]);
    const tree = await digestText(JSON.stringify(manifest));
    const oid = await digestText(JSON.stringify([tree, parents, sequence, label]));
    return { oid, tree, parent: parents[0] ?? null, parents, files: { ...files } };
  }

  private view(commit: CommitObject): CommitSnapshot {
    const files: Snapshot = {};
    for (const [path, entry] of Object.entries(commit.files)) if (!isExcludedPath(path)) files[path] = { ...entry };
    return { oid: commit.oid, treeOid: commit.tree, files };
  }

  /** A per-installation port sharing this repository; patches on the shared object still apply. */
  device(installation: string): Repository {
    const ledger = `refs/vault-sync/devices/${installation}`;
    return {
      identity: () => this.identity(),
      head: () => this.head(),
      readCommit: (oid) => this.readCommit(oid),
      isAncestor: (a, b) => this.isAncestor(a, b),
      ledgerRef: () => ledger,
      prepare: (parent, changes, message, input) => this.prepare(parent, changes, message, input),
      createSeal: (input) => this.createSeal(input),
      publish: (input) => this.publish(input, ledger),
      seal: (input) => this.seal(input, ledger),
      readLedger: () => this.readLedger(ledger),
    };
  }

  ledger(installation: string): string | undefined {
    return this.refs.get(`refs/vault-sync/devices/${installation}`);
  }

  /** Atomic multi-ref CAS (`null` = absent), like GraphQL updateRefs with force:false. */
  updateRefs(updates: Array<{ name: string; before: string | null; after: string }>): boolean {
    const current = (name: string) => (name === BRANCH ? this.branchHead : this.refs.get(name) ?? null);
    if (updates.some((update) => current(update.name) !== update.before)) return false;
    for (const update of updates) {
      if (update.name === BRANCH) this.branchHead = update.after;
      else this.refs.set(update.name, update.after);
    }
    return true;
  }

  /** Delivers every delayed request in order; returns their CAS results. */
  deliver(): boolean[] {
    const pending = this.delayed;
    this.delayed = [];
    return pending.map((item) => item.deliver());
  }

  /** Another client's ordinary commit on top of the current head. */
  async push(changes: Changes): Promise<string> {
    const parent = this.commits.get(this.branchHead)!;
    const files = { ...parent.files };
    for (const [path, entry] of Object.entries(changes)) {
      if (entry) files[path] = entry;
      else delete files[path];
    }
    const commit = await MemoryRepository.object(files, [parent.oid], ++this.sequence);
    this.commits.set(commit.oid, commit);
    this.branchHead = commit.oid;
    return commit.oid;
  }

  /** Force-moves the branch (history rewrite). */
  async forceReset(files: Snapshot): Promise<string> {
    const commit = await MemoryRepository.object(files, [], ++this.sequence);
    this.commits.set(commit.oid, commit);
    this.branchHead = commit.oid;
    return commit.oid;
  }

  /** An unrelated commit object (for out-of-contract ledger tampering). */
  async orphan(label: string): Promise<string> {
    const commit = await MemoryRepository.object({}, [], ++this.sequence, label);
    this.commits.set(commit.oid, commit);
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
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const cursor = queue.pop()!;
      if (cursor === ancestor) return true;
      if (seen.has(cursor)) continue;
      seen.add(cursor);
      queue.push(...(this.commits.get(cursor)?.parents ?? []));
    }
    return false;
  }

  async prepare(parent: CommitSnapshot, changes: Changes, _message: string, ledger: { anchor: string | null; operation: string }): Promise<PreparedPublication> {
    this.calls.push("prepare");
    if (this.prepareFault === "before") throw new Crash("prepare failed");
    const base = this.commits.get(parent.oid)!;
    const files = { ...base.files }; // excluded entries survive via the base tree
    for (const [path, entry] of Object.entries(changes)) {
      if (entry) files[path] = entry;
      else delete files[path];
    }
    const commit = await MemoryRepository.object(files, [parent.oid], ++this.sequence);
    this.commits.set(commit.oid, commit);
    const receipt = await MemoryRepository.object(files, ledger.anchor ? [ledger.anchor, commit.oid] : [commit.oid], ++this.sequence, `receipt ${ledger.operation}`);
    this.commits.set(receipt.oid, { ...receipt, ledger: "receipt" });
    if (this.prepareFault === "after") throw new Crash("prepare response lost");
    return { ...this.view(commit), receipt: receipt.oid };
  }

  async createSeal(input: { anchor: string | null; parent: string; operation: string }): Promise<string> {
    this.calls.push("createSeal");
    const parent = this.commits.get(input.parent)!;
    const seal = await MemoryRepository.object(parent.files, input.anchor ? [input.anchor] : [], ++this.sequence, `seal ${input.operation}`);
    this.commits.set(seal.oid, { ...seal, ledger: "seal" });
    return seal.oid;
  }

  private dispatch(fault: PublishFault, label: string, attempt: () => boolean): "acknowledged" | "unconfirmed" {
    if (fault === "before") throw new Crash(`${label} request lost`);
    if (fault === "reject") return "unconfirmed";
    if (fault === "delay") {
      this.delayed.push({ label, deliver: attempt });
      throw new Crash(`${label} response lost; request still in flight`);
    }
    const landed = attempt();
    if (fault === "after") throw new Crash(`${label} response lost`);
    if (fault === "error-after") return "unconfirmed";
    return landed ? "acknowledged" : "unconfirmed";
  }

  async publish(input: { parent: string; candidate: string; anchor: string | null; receipt: string }, ledger = "refs/vault-sync/devices/A"): Promise<"acknowledged" | "unconfirmed"> {
    this.calls.push("publish");
    return this.dispatch(this.publishQueue.length > 0 ? this.publishQueue.shift()! : this.publishFault, "publish", () => this.updateRefs([
      { name: BRANCH, before: input.parent, after: input.candidate },
      { name: ledger, before: input.anchor, after: input.receipt },
    ]));
  }

  async seal(input: { anchor: string | null; seal: string }, ledger = "refs/vault-sync/devices/A"): Promise<void> {
    this.calls.push("seal");
    this.dispatch(this.sealQueue.length > 0 ? this.sealQueue.shift()! : this.sealFault, "seal", () => this.updateRefs([{ name: ledger, before: input.anchor, after: input.seal }]));
  }

  async readLedger(ledger = "refs/vault-sync/devices/A"): Promise<LedgerRead> {
    this.calls.push("readLedger");
    if (this.ledgerFault) throw new Crash("ledger unavailable");
    const value = this.refs.get(ledger);
    return value === undefined ? { kind: "absent" } : { kind: "present", value };
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
  /** Native evidence returned by `recover` until acknowledged. */
  issues: NativeIssue[] = [];
  acknowledged: string[] = [];
  acknowledgeFault = false;
  /**
   * The next apply to `path` models a native transaction outcome: `interrupted`
   * leaves `bytes` (a torn write) at the path; `displaced` installs the intent
   * and moves `bytes` into the hold. `crash` loses the apply response.
   */
  native: { path: string; kind: "interrupted" | "displaced"; bytes: Entry | null; crash?: boolean } | null = null;
  /**
   * The next apply to `path` durably records a native intent and then stops:
   * `refuse` returns `blocked` (an open view refused the write after the
   * intent was saved); `crash` throws after marking it attempted with `torn`
   * bytes (or none) at the path.
   */
  pendingNext: { path: string; mode: "refuse" | "crash"; torn?: Entry | null } | null = null;
  /** Durable native intents by path (the native journal). */
  intents = new Map<string, { id: string; path: string; expected: Entry | null; next: Entry | null; attempted: boolean }>();
  /** Every authorization passed to `recover`. */
  authorizations: RecoveryAuthorization[] = [];
  /** Visible files `scan` reports as unreadable (oversize) instead of returning their bytes. */
  unreadable = new Set<string>();
  /** Writes that went through capture/scan/pendingIntents: must stay zero (read-only contract). */
  readOnlyViolations = 0;
  private issueSequence = 0;
  private intentSequence = 0;

  constructor(initial: Snapshot = {}) {
    for (const [path, entry] of Object.entries(initial)) this.files.set(path, entry);
  }

  async capture(): Promise<Snapshot> {
    return Object.fromEntries([...this.files].map(([path, entry]) => [path, { ...entry }]));
  }

  async scan(): Promise<{ files: Snapshot; unreadable: Array<{ path: string; size: number; mtime: number | null; reason: "oversize" }> }> {
    const files = await this.capture();
    const unreadable = [...this.unreadable].filter((path) => path in files).map((path) => ({ path, size: 9 * 1024 * 1024, mtime: 1, reason: "oversize" as const }));
    for (const item of unreadable) delete files[item.path];
    return { files, unreadable };
  }

  async pendingIntents(): Promise<PendingIntent[]> {
    return [...this.intents.values()].map((intent) => ({
      id: intent.id,
      path: intent.path,
      expected: intent.expected && { oid: intent.expected.oid, mode: intent.expected.mode },
      next: intent.next && { oid: intent.next.oid, mode: intent.next.mode },
      attempted: intent.attempted,
    }));
  }

  /** Mirrors the native rules: replay completes toward `next`; cancel never installs it. */
  private settle(intent: { id: string; path: string; expected: Entry | null; next: Entry | null; attempted: boolean }, replay: boolean): void {
    const live = this.files.get(intent.path) ?? null;
    this.intents.delete(intent.path);
    const issue = (found: Entry | null) => this.issues.push({ id: `issue-${++this.issueSequence}`, path: intent.path, kind: "interrupted", expected: intent.expected, next: intent.next, found });
    if (sameEntry(live, intent.next)) {
      // Already landed: under cancel, the kept preimage surfaces as evidence.
      if (!replay && intent.expected) this.issues.push({ id: `issue-${++this.issueSequence}`, path: intent.path, kind: "displaced", expected: intent.expected, next: intent.next, found: intent.expected });
      return;
    }
    if (sameEntry(live, intent.expected)) {
      if (!replay) return;
      if (intent.next) this.files.set(intent.path, intent.next);
      else this.files.delete(intent.path);
      this.applied.push(intent.path);
      return;
    }
    if (!intent.attempted) return; // Nothing could have been written; live bytes are the user's.
    issue(live);
  }

  async apply(path: string, expected: Entry | null, next: Entry | null): Promise<ApplyResult> {
    const count = ++this.applyCalls;
    if (this.applyFault?.at === count && this.applyFault.when === "before") throw new Crash(`apply ${path} failed`);
    const pending = this.intents.get(path);
    if (pending && (!sameEntry(pending.expected, expected) || !sameEntry(pending.next, next))) {
      return { kind: "blocked", reason: `A different native transaction is pending for ${path}` };
    }
    if (this.issues.some((item) => item.kind === "oversize" && item.path === path && !this.acknowledged.includes(item.id))) {
      return { kind: "blocked", reason: `Review oversized native recovery file for ${path}` };
    }
    await this.beforeApply?.(path, this);
    const current = this.files.get(path) ?? null;
    if (!sameEntry(current, expected)) return { kind: "changed" };
    const stop = this.pendingNext;
    if (stop && stop.path === path) {
      this.pendingNext = null;
      this.intents.set(path, { id: `intent-${++this.intentSequence}`, path, expected, next, attempted: stop.mode === "crash" });
      if (stop.mode === "refuse") return { kind: "blocked", reason: "Close the open view before replacing or deleting this file" };
      if (stop.torn === undefined) {
        // Landed fully, response lost.
        if (next) this.files.set(path, next);
        else this.files.delete(path);
      } else if (stop.torn) this.files.set(path, stop.torn);
      else this.files.delete(path);
      throw new Crash(`apply ${path} died with a pending intent`);
    }
    this.intents.delete(path);
    if (this.blockBinary && current && !path.endsWith(".md")) return { kind: "blocked", reason: "binary replacement/deletion is unsupported" };
    const native = this.native;
    if (native && native.path === path) {
      this.native = null;
      const landed = native.kind === "interrupted" ? native.bytes : next;
      if (landed) this.files.set(path, landed);
      else this.files.delete(path);
      const issue: NativeIssue = { id: `issue-${++this.issueSequence}`, path, kind: native.kind, expected, next, found: native.bytes };
      this.issues.push(issue);
      if (native.crash) throw new Crash(`apply ${path} died mid-transaction`);
      return { kind: native.kind, issue };
    }
    if (next) this.files.set(path, next);
    else this.files.delete(path);
    this.applied.push(path);
    if (this.applyFault?.at === count && this.applyFault.when === "after") throw new Crash(`apply ${path} response lost`);
    return { kind: "applied" };
  }

  async recover(authorization: RecoveryAuthorization): Promise<NativeIssue[]> {
    this.authorizations.push(structuredClone(authorization));
    for (const intent of [...this.intents.values()]) {
      if (authorization.replay.includes(intent.id)) this.settle(intent, true);
      else if (authorization.cancel.includes(intent.id)) this.settle(intent, false);
    }
    return this.issues.filter((issue) => !this.acknowledged.includes(issue.id));
  }

  async acknowledgeRecovery(ids: string[]): Promise<void> {
    if (this.acknowledgeFault) throw new Crash("acknowledgement failed");
    this.acknowledged.push(...ids.filter((id) => !this.acknowledged.includes(id)));
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
