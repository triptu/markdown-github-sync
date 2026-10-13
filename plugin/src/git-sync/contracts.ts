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
  readCommit(oid: string): Promise<CommitSnapshot>;
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
export interface NativeIssue {
  /** Stable vault-assigned id; `recover` keeps returning it until acknowledged. */
  id: string;
  /** Syncable vault path the bytes belong to. */
  path: string;
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
export type ApplyResult =
  | { kind: "applied" }
  /** Nothing was written: the live bytes differed from `expected` before any write could happen. */
  | { kind: "changed" }
  | { kind: "blocked"; reason: string }
  | { kind: "interrupted"; issue: NativeIssue }
  | { kind: "displaced"; issue: NativeIssue };
export interface LocalVault {
  capture(): Promise<Snapshot>;
  apply(
    path: string,
    expected: Entry | null,
    next: Entry | null,
  ): Promise<ApplyResult>;
  /** Every unacknowledged issue; called before the engine's first capture of a sync or restore. */
  recover?(): Promise<NativeIssue[]>;
  /** Called only after the engine durably saved these issues and their bytes. Idempotent. */
  acknowledgeRecovery?(ids: string[]): Promise<void>;
}
export interface DurableStore {
  load(): Promise<unknown>;
  save(state: unknown): Promise<void>;
}
