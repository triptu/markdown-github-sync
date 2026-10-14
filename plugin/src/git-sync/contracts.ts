import type { Scope } from "./scope";

export type FileMode = "100644" | "100755";
export interface Entry {
  oid: string;
  mode: FileMode;
  data: string;
}
export type Snapshot = Record<string, Entry>;
export interface CommitSnapshot {
  oid: string;
  treeOid: string;
  files: Snapshot;
}
export interface RepositoryIdentity {
  id: string;
  owner: string;
  name: string;
  branch: string;
}
export type Changes = Record<string, Entry | null>;
/** A device ledger ref value; `absent` only before this installation's first settlement. */
export type LedgerRead = { kind: "present"; value: string } | { kind: "absent" };
/** A prepared candidate plus its receipt commit (parents `[anchor?, candidate]`), neither yet referenced. */
export interface PreparedPublication extends CommitSnapshot {
  receipt: string;
}
/**
 * Publication follows the per-installation ledger protocol: one atomic
 * `updateRefs` moves the branch `parent -> candidate` and the ledger
 * `anchor -> receipt`. Only the ledger value decides an unconfirmed attempt.
 */
export interface Repository {
  identity(): Promise<RepositoryIdentity>;
  head(): Promise<CommitSnapshot>;
  /**
   * Optional: the branch head commit id alone, read fresh. Lets the engine
   * overlap it with other requests; `readCommit(await headOid())` must equal `head()`.
   */
  headOid?(): Promise<string>;
  readCommit(oid: string): Promise<CommitSnapshot>;
  /**
   * Optional hint: blob bodies the engine already holds. A repository may use
   * one in place of a download only after verifying it hashes to the blob ID.
   */
  offerKnownBlobs?(blobs: Iterable<{ oid: string; data: string }>): void;
  /** Immutable policy for the complete tree at this commit. */
  scopeFor(commit: string): Promise<Scope>;
  /** Verified root ignore text at this commit. */
  readRootGitignore(commit: string): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** `refs/vault-sync/devices/<installationId>`, written only by this installation. */
  ledgerRef(): string;
  prepare(
    parent: CommitSnapshot,
    changes: Changes,
    message: string,
    ledger: { anchor: string | null; operation: string },
  ): Promise<PreparedPublication>;
  /** Creates (never dispatches) the cancellation seal: parents `[anchor?]`, tree of `parent`. */
  createSeal(input: { anchor: string | null; parent: string; operation: string }): Promise<string>;
  /** One updateRefs. `acknowledged` only for a validated echo; anything else proves nothing. */
  publish(input: { parent: string; candidate: string; anchor: string | null; receipt: string }): Promise<"acknowledged" | "unconfirmed">;
  /** One updateRefs moving only the ledger `anchor -> seal`; the outcome is learned only from `readLedger`. */
  seal(input: { anchor: string | null; seal: string }): Promise<void>;
  /** A fresh, uncached read of this installation's ledger ref. */
  readLedger(): Promise<LedgerRead>;
}
/**
 * Evidence from the vault's native file transactions that bytes other than the
 * transaction's preimage (`expected`) and intent (`next`) exist. The engine
 * turns each into a durable per-path hold that is never merged automatically.
 */
export type NativeIssue = NativeBytesIssue | NativeOversizeIssue;
export interface NativeBytesIssue {
  /** Stable vault-assigned id; `recover` keeps returning it until acknowledged. */
  id: string;
  /** Syncable vault path the bytes belong to. */
  path: string;
  /** Native source whose old oversize evidence this exact version supersedes. */
  sourcePath?: string;
  /**
   * `interrupted`: a write could have happened and the live path holds bytes
   * that are neither `expected` nor `next` (left as found). `displaced`: the
   * intent is installed at `path`, but unexpected bytes landed in the hold.
   */
  kind: "interrupted" | "displaced";
  expected: Entry | null;
  next: Entry | null;
  /** The unexpected bytes; null only when an interrupted path is now absent. */
  found: Entry | null;
}
/**
 * Unexpected bytes too large for engine ingestion (over 8 MiB), retained by
 * the vault at `sourcePath`. The engine holds `path` without its bytes and
 * acknowledges the id only once the user's decision for the hold is durable,
 * immediately before that decision is written. Acknowledgement must not delete
 * the retained file; a later size/mtime change is reported as a new id.
 */
export interface NativeOversizeIssue {
  id: string;
  path: string;
  kind: "oversize";
  sourcePath: string;
  size: number;
  /** Modification time in epoch milliseconds, when the host reports one. */
  mtime: number | null;
  expected: Entry | null;
  next: Entry | null;
}
/** A durable native intent that has not finished; a read-only view. */
export interface PendingIntent {
  id: string;
  path: string;
  expected: { oid: string; mode: FileMode } | null;
  next: { oid: string; mode: FileMode } | null;
  /** True once a visible write could have happened. */
  attempted: boolean;
}
/** Per-intent instruction from the engine; intents in neither list stay pending, untouched. */
export interface RecoveryAuthorization {
  /** Complete toward `next`, or report an issue. */
  replay: string[];
  /** Never install `next`: drop an unattempted intent, settle an attempted one backward or report an issue. */
  cancel: string[];
  /**
   * Blob ids whose bytes the engine holds durably (in its journal or in the
   * published checkpoint). A finished native hold whose bytes are exactly one
   * of these, and that nothing else refers to, may be reclaimed.
   */
  released?: string[];
}
export type ApplyResult =
  | { kind: "applied" }
  /** Nothing was written: the live bytes differed from `expected` before any write could happen. */
  | { kind: "changed" }
  | { kind: "blocked"; reason: string }
  | { kind: "interrupted"; issue: NativeBytesIssue }
  | { kind: "displaced"; issue: NativeBytesIssue };
/** A visible file the vault cannot capture with its bytes (over the 8 MiB entry limit). */
export interface UnreadableFile {
  path: string;
  size: number;
  mtime: number | null;
  reason: "oversize";
}
/** Only `apply`, `recover` and `acknowledgeRecovery` mutate the vault or its native journal. */
export interface LocalVault {
  /** Strictly read-only: never replays intents, persists evidence or reclaims hidden files. */
  capture(scope: Scope): Promise<Snapshot>;
  /**
   * Strictly read-only capture that reports unreadable visible files instead
   * of throwing; preferred over `capture` when present. An unreadable path is
   * never treated as deleted: the engine leaves it untouched on both sides.
   */
  scan?(scope: Scope): Promise<{ files: Snapshot; unreadable: UnreadableFile[] }>;
  /** A pending intent at `path` whose (expected, next) differ from the call returns `blocked` without mutation. */
  apply(
    path: string,
    expected: Entry | null,
    next: Entry | null,
  ): Promise<ApplyResult>;
  /** Strictly read-only: every unfinished native intent. */
  pendingIntents?(): Promise<PendingIntent[]>;
  /**
   * The only native entry point that settles intents, persists hidden-file
   * evidence or reclaims; called by the engine only after its identity, pause
   * and installation fences. Returns every unacknowledged issue.
   */
  recover?(authorization: RecoveryAuthorization): Promise<NativeIssue[]>;
  /**
   * Called only after the engine durably saved these issues (and the bytes of
   * byte issues; for oversize issues, the user's decision). Idempotent.
   */
  acknowledgeRecovery?(ids: string[]): Promise<void>;
}
export interface DurableStore {
  load(): Promise<unknown>;
  save(state: unknown): Promise<void>;
}
