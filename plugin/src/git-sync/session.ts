// SyncSession: the single owner of synchronization state for one vault. All
// public methods run one at a time. Every publication and every local
// mutation is preceded by a durable save that is sufficient to recover it.
import type { CommitSnapshot, DurableStore, Entry, FileMode, LocalVault, Repository, RepositoryIdentity, Snapshot } from "./contracts";
import {
  IntegrityError,
  decodeBase64,
  digestText,
  entryFromBytes,
  isOid,
  isSyncablePath,
  sameEntry,
  sameManifest,
  toManifest,
  toRef,
  verifyEntry,
  verifySnapshot,
} from "./codec";
import type { Manifest, Ref } from "./codec";
import { reconcile } from "./reconcile";
import type { Choice, Conflict } from "./reconcile";
import { CorruptStateError, STATE_FORMAT, parseState, referencedBlobs } from "./state";
import type {
  ApplyOperation,
  Pause,
  PauseReason,
  PublishOperation,
  RecoveryReason,
  RecoveryRecord,
  StoredConflict,
  StoredState,
  StoredStep,
} from "./state";

export interface SessionPorts {
  repository: Repository;
  vault: LocalVault;
  store: DurableStore;
  /** Shown in commit messages. */
  deviceName?: string;
  now?: () => Date;
}

/** Unpinned recovery records (bytes known to be in GitHub history) kept for convenience. */
const RETAINED_RECOVERY = 20;
/** Publication attempts per sync when the branch keeps moving. */
const MAX_ATTEMPTS = 3;

type Unavailable = { kind: "unenrolled" } | { kind: "corrupt"; detail: string };

export type BlockedStep = { path: string; reason: string };

export type SyncOutcome =
  | Unavailable
  | { kind: "paused"; pause: Pause }
  | { kind: "up-to-date"; commit: string }
  /** The checkpoint advanced to `commit`; `carried` lists newer local edits kept as drafts. */
  | { kind: "synced"; commit: string; published: boolean; carried: string[] }
  | { kind: "needs-decision"; conflicts: Conflict[]; merged: string[] }
  /** Commit `commit` is partly applied; the listed paths need `keepLocal` or a manual change. */
  | { kind: "blocked"; commit: string; steps: BlockedStep[] }
  | { kind: "rejected"; message: string }
  | { kind: "contended" };

export type EnrollmentAction =
  | "download"
  | "upload"
  | "update-local"
  | "conflict"
  | "review-local-deletion"
  | "review-remote-deletion";

export interface EnrollmentPreview {
  kind: "preview";
  /** Pass to `enroll`; changes whenever the repository head or local files change. */
  token: string;
  repository: RepositoryIdentity;
  commit: string;
  /** True when re-enrolling after a pause; prior drafts are classified against the old checkpoint. */
  reenrollment: boolean;
  items: Array<{ path: string; action: EnrollmentAction }>;
  unchanged: number;
}

export type EnrollOutcome =
  | Unavailable
  | { kind: "already-enrolled" }
  | { kind: "stale"; preview: EnrollmentPreview }
  | { kind: "enrolled"; commit: string };

export type ChoiceInput = { kind: "mine" } | { kind: "remote" } | { kind: "both" } | { kind: "edit"; data: string };
export type DecisionOutcome = Unavailable | { kind: "recorded" } | { kind: "stale" } | { kind: "invalid"; reason: string };

export interface RestorePreview {
  kind: "preview";
  token: string;
  path: string;
  commit: string;
  historical: Entry;
  current: Entry | null;
}
export type RestoreRefusal =
  | Unavailable
  | { kind: "paused"; pause: Pause }
  | { kind: "busy" }
  | { kind: "invalid-path" }
  | { kind: "not-in-history" }
  | { kind: "missing" };
export type RestoreOutcome =
  | RestoreRefusal
  | { kind: "stale"; preview: RestorePreview | null }
  | { kind: "unchanged" }
  | { kind: "restored" }
  | { kind: "blocked"; reason: string };

export type Phase = "idle" | "local-changes" | "needs-decision" | "publication-unknown" | "applying" | "blocked" | "paused";

export interface PendingChange {
  path: string;
  change: "added" | "modified" | "deleted";
}

export type SessionStatus =
  | Unavailable
  | {
      kind: "enrolled";
      repository: RepositoryIdentity;
      commit: string;
      phase: Phase;
      pause: Pause | null;
      conflicts: Conflict[];
      blocked: BlockedStep[];
      /** Paths whose local content descends from a version other than the checkpoint. */
      carried: string[];
      /** Present only from `inspect()`, which scans the vault. */
      pending: PendingChange[] | null;
      recovery: number;
    };

export interface RecoverySummary {
  id: string;
  createdAt: string;
  reason: RecoveryReason;
  commit: string;
  pinned: boolean;
  paths: string[];
  bytes: number;
}

type Loaded = Unavailable | { kind: "enrolled"; state: StoredState };
type Applied = { kind: "complete"; commit: string; carried: string[] } | { kind: "blocked"; outcome: SyncOutcome };
type Settled = { kind: "published"; operation: ApplyOperation } | { kind: "not-published" } | { kind: "paused"; outcome: SyncOutcome };

export class SyncSession {
  readonly #repository: Repository;
  readonly #vault: LocalVault;
  readonly #store: DurableStore;
  readonly #deviceName: string;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ports: SessionPorts) {
    this.#repository = ports.repository;
    this.#vault = ports.vault;
    this.#store = ports.store;
    this.#deviceName = ports.deviceName ?? "Obsidian";
    this.#now = ports.now ?? (() => new Date());
  }

  // ---- Public API --------------------------------------------------------

  /** State only; no network or vault access. */
  status(): Promise<SessionStatus> {
    return this.#exclusive(() => this.#status(false));
  }

  /** State plus a scan of local changes relative to the checkpoint. No network access. */
  inspect(): Promise<SessionStatus> {
    return this.#exclusive(() => this.#status(true));
  }

  previewEnrollment(): Promise<EnrollmentPreview | Exclude<EnrollOutcome, { kind: "stale" } | { kind: "enrolled" }>> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind === "corrupt") return loaded;
      const prior = loaded.kind === "enrolled" ? loaded.state : null;
      if (prior && !prior.pause) return { kind: "already-enrolled" };
      return (await this.#survey(prior)).preview;
    });
  }

  /** Binds this vault to the repository head shown in the confirmed preview. Mutates no vault files. */
  enroll(input: { token: string }): Promise<EnrollOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind === "corrupt") return loaded;
      const prior = loaded.kind === "enrolled" ? loaded.state : null;
      if (prior && !prior.pause) return { kind: "already-enrolled" };
      const survey = await this.#survey(prior);
      if (survey.preview.token !== input.token) return { kind: "stale", preview: survey.preview };
      const state: StoredState = {
        format: STATE_FORMAT,
        repository: survey.preview.repository,
        base: commitState(survey.head),
        carry: survey.carry,
        operation: null,
        pause: null,
        review: null,
        decisions: {},
        recovery: prior?.recovery ?? [],
        blobs: { ...prior?.blobs },
        counter: prior?.counter ?? 0,
      };
      // Every carried version is a local draft, so the record also pins its bytes.
      this.#record(state, "enrollment", survey.drafts);
      await this.#save(state);
      return { kind: "enrolled", commit: survey.head.oid };
    });
  }

  sync(): Promise<SyncOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      if (state.pause) return { kind: "paused", pause: state.pause };
      const identity = await this.#repository.identity();
      if (!sameIdentity(identity, state.repository)) {
        return this.#pause(state, "repository-changed", `Expected ${describe(state.repository)}, found ${describe(identity)}`);
      }
      let published = false;
      const carried = new Set<string>();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (state.operation) {
          const resumed = await this.#resume(state);
          if (resumed.kind === "held") return resumed.outcome;
          published ||= resumed.published;
          resumed.carried.forEach((path) => carried.add(path));
        }
        const outcome = await this.#transact(state);
        if (outcome === "retry") continue;
        if (outcome.kind === "synced") {
          outcome.carried.forEach((path) => carried.add(path));
          return { ...outcome, published: outcome.published || published, carried: [...carried].sort() };
        }
        if (outcome.kind === "up-to-date" && (published || carried.size > 0)) {
          return { kind: "synced", commit: outcome.commit, published, carried: [...carried].sort() };
        }
        return outcome;
      }
      return { kind: "contended" };
    });
  }

  /** Records a decision for a conflict from the latest review. Applied by the next `sync` only if versions are unchanged. */
  resolve(input: { conflictId: string; choice: ChoiceInput }): Promise<DecisionOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      const conflict = state.review?.conflicts.find((item) => item.id === input.conflictId);
      if (!conflict) return { kind: "stale" };
      if (conflict.kind === "collision") return { kind: "invalid", reason: "Rename one of the colliding files, then sync again" };
      if (!conflict.choices.includes(input.choice.kind)) {
        return { kind: "invalid", reason: `${input.choice.kind} is not available for ${conflict.kind}` };
      }
      if (input.choice.kind === "edit") {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(input.choice.data);
        } catch {
          return { kind: "invalid", reason: "Edited content is not valid base64" };
        }
        const mode: FileMode = conflict.local?.mode ?? conflict.remote?.mode ?? "100644";
        const entry = await entryFromBytes(bytes, mode);
        state.blobs[entry.oid] = entry.data;
        state.decisions[conflict.id] = { kind: "edit", entry: toRef(entry) };
      } else {
        state.decisions[conflict.id] = { kind: input.choice.kind };
      }
      await this.#save(state);
      return { kind: "recorded" };
    });
  }

  /**
   * For a blocked step: keep this device's file instead of the commit's
   * version. The kept file becomes a draft relative to the new checkpoint and
   * is published by a later sync.
   */
  keepLocal(input: { path: string }): Promise<DecisionOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      const step = state.operation?.kind === "apply" ? state.operation.steps.find((item) => item.path === input.path) : undefined;
      if (!step || step.status !== "blocked") return { kind: "stale" };
      step.status = "kept";
      step.reason = null;
      await this.#save(state);
      return { kind: "recorded" };
    });
  }

  /** Shows what restoring `path` from a commit in the checkpoint's history would change. */
  previewRestore(input: { path: string; commit: string }): Promise<RestorePreview | RestoreRefusal> {
    return this.#exclusive(async () => {
      const ready = await this.#loadIdle();
      if (ready.kind !== "ready") return ready.outcome;
      return this.#restorePreview(ready.state, input);
    });
  }

  /** Writes the reviewed historical version into the vault as a local draft; `sync` publishes it as a new commit. */
  restore(input: { token: string; path: string; commit: string }): Promise<RestoreOutcome> {
    return this.#exclusive(async () => {
      const ready = await this.#loadIdle();
      if (ready.kind !== "ready") return ready.outcome;
      const { state } = ready;
      const preview = await this.#restorePreview(state, input);
      if (preview.kind !== "preview") return preview;
      if (preview.token !== input.token) return { kind: "stale", preview };
      if (sameEntry(preview.current, preview.historical)) return { kind: "unchanged" };
      this.#record(state, "restore", preview.current ? { [preview.path]: preview.current } : {});
      await this.#save(state);
      const result = await this.#vault.apply(preview.path, preview.current, preview.historical);
      if (result.kind === "applied") return { kind: "restored" };
      if (result.kind === "blocked") return { kind: "blocked", reason: result.reason };
      return { kind: "stale", preview: null };
    });
  }

  listRecovery(): Promise<RecoverySummary[] | Unavailable> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { blobs } = loaded.state;
      return loaded.state.recovery.map((record) => ({
        id: record.id,
        createdAt: record.createdAt,
        reason: record.reason,
        commit: record.commit,
        pinned: record.pinned,
        paths: Object.keys(record.files).sort(),
        bytes: Object.values(record.files).reduce((sum, entry) => sum + base64Length(blobs[entry.oid] ?? ""), 0),
      }));
    });
  }

  /** Exact bytes of a recovery record; `null` if it does not exist. */
  exportRecovery(input: { id: string }): Promise<Snapshot | null | Unavailable> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const record = loaded.state.recovery.find((item) => item.id === input.id);
      return record ? materialize(loaded.state, record.files) : null;
    });
  }

  discardRecovery(input: { id: string }): Promise<Unavailable | { kind: "discarded" } | { kind: "missing" } | { kind: "in-use" }> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      if (state.operation?.recoveryId === input.id) return { kind: "in-use" };
      const before = state.recovery.length;
      state.recovery = state.recovery.filter((record) => record.id !== input.id);
      if (state.recovery.length === before) return { kind: "missing" };
      await this.#save(state);
      return { kind: "discarded" };
    });
  }

  // ---- Synchronization ---------------------------------------------------

  async #transact(state: StoredState): Promise<SyncOutcome | "retry"> {
    const head = await this.#readHead();
    if (head.oid !== state.base.commit && !(await this.#repository.isAncestor(state.base.commit, head.oid))) {
      return this.#pause(state, "history-rewritten", `Checkpoint ${state.base.commit} is not an ancestor of head ${head.oid}`);
    }
    const local = await verifySnapshot(await this.#vault.capture(), "local capture");
    const base = await this.#effectiveBase(state, local, head);
    if (base.kind === "paused") return base.outcome;
    const plan = await reconcile({ base: base.files, local, remote: head.files, decisions: choices(state) });

    if (plan.kind === "needs-decision") {
      state.review = { head: head.oid, conflicts: plan.conflicts.map((item) => this.#storeConflict(state, item)) };
      await this.#save(state);
      return { kind: "needs-decision", conflicts: plan.conflicts, merged: plan.merged };
    }

    const outgoing = Object.keys(plan.outgoing).length;
    if (outgoing === 0 && plan.incoming.length === 0) {
      const settled =
        head.oid === state.base.commit &&
        Object.keys(state.carry).length === 0 &&
        !state.review &&
        Object.keys(state.decisions).length === 0;
      if (!settled) {
        state.base = commitState(head);
        state.carry = {};
        state.review = null;
        state.decisions = {};
        await this.#save(state);
      }
      return { kind: "up-to-date", commit: head.oid };
    }

    // Drafts (local differs from the effective base) and every preimage the
    // application could overwrite are recorded before anything leaves or changes.
    const drafts: Snapshot = {};
    for (const [path, entry] of Object.entries(local)) if (!sameEntry(entry, base.files[path])) drafts[path] = entry;
    for (const step of plan.incoming) if (step.expected) drafts[step.path] = step.expected;
    const recoveryId = this.#record(state, "sync", drafts);
    const steps: StoredStep[] = plan.incoming.map((step) => ({
      path: step.path,
      expected: step.expected && toRef(step.expected),
      next: step.next && toRef(step.next),
      status: "pending",
      reason: null,
    }));

    if (outgoing === 0) {
      const operation: ApplyOperation = {
        kind: "apply",
        id: this.#nextId(state, "apply"),
        target: { commit: head.oid, tree: head.treeOid, files: toManifest(head.files) },
        steps,
        recoveryId,
      };
      state.operation = operation;
      await this.#save(state);
      return this.#finish(state, operation, local, head.files, false);
    }

    const candidate = await this.#repository.prepare(head, plan.outgoing, this.#message(outgoing));
    if (!isOid(candidate.oid) || !isOid(candidate.treeOid) || candidate.oid === head.oid || !sameManifest(candidate.files, plan.target)) {
      throw new IntegrityError("Prepared commit does not contain exactly the planned files");
    }
    const operation: PublishOperation = {
      kind: "publish",
      id: this.#nextId(state, "publish"),
      parent: head.oid,
      candidate: { commit: candidate.oid, tree: candidate.treeOid },
      target: toManifest(plan.target),
      steps,
      recoveryId,
    };
    state.operation = operation;
    await this.#save(state);

    const result = await this.#repository.publish(head.oid, candidate.oid);
    if (result.kind === "accepted") {
      return this.#finish(state, await this.#promote(state, operation), local, plan.target, true);
    }
    // Never trust a non-acceptance blindly: the branch is the authority.
    const settled = await this.#settle(state, operation);
    if (settled.kind === "paused") return settled.outcome;
    if (settled.kind === "published") return this.#finish(state, settled.operation, local, plan.target, true);
    return result.kind === "rejected" ? { kind: "rejected", message: result.message } : "retry";
  }

  async #finish(
    state: StoredState,
    operation: ApplyOperation,
    local: Snapshot,
    files: Snapshot,
    published: boolean,
  ): Promise<SyncOutcome> {
    const applied = await this.#applySteps(state, operation, local, files);
    if (applied.kind === "blocked") return applied.outcome;
    return { kind: "synced", commit: applied.commit, published, carried: applied.carried };
  }

  /** Continues a persisted operation after a restart, error or block. */
  async #resume(state: StoredState): Promise<{ kind: "held"; outcome: SyncOutcome } | { kind: "continue"; published: boolean; carried: string[] }> {
    let operation = state.operation;
    if (!operation) return { kind: "continue", published: false, carried: [] };
    let published = false;
    if (operation.kind === "publish") {
      const settled = await this.#settle(state, operation);
      if (settled.kind === "paused") return { kind: "held", outcome: settled.outcome };
      if (settled.kind === "not-published") return { kind: "continue", published: false, carried: [] };
      operation = settled.operation;
      published = true;
    }
    const target = await this.#repository.readCommit(operation.target.commit);
    const files = await verifySnapshot(target.files, "target commit");
    if (target.oid !== operation.target.commit || !sameManifest(files, operation.target.files)) {
      throw new IntegrityError(`Commit ${operation.target.commit} does not match the recorded operation`);
    }
    const local = await verifySnapshot(await this.#vault.capture(), "local capture");
    const applied = await this.#applySteps(state, operation, local, files);
    if (applied.kind === "blocked") return { kind: "held", outcome: applied.outcome };
    return { kind: "continue", published, carried: applied.carried };
  }

  /**
   * Decides a recorded candidate's fate from the branch alone. A candidate
   * reachable from the head was published, even if later commits reverted it;
   * it is applied, never re-published.
   */
  async #settle(state: StoredState, operation: PublishOperation): Promise<Settled> {
    const head = await this.#repository.head();
    const candidate = operation.candidate.commit;
    let published: boolean;
    if (head.oid === candidate) published = true;
    else if (head.oid === operation.parent) published = false;
    else if (await this.#repository.isAncestor(candidate, head.oid)) published = true;
    else if (await this.#repository.isAncestor(operation.parent, head.oid)) published = false;
    else {
      return {
        kind: "paused",
        outcome: await this.#pause(state, "history-rewritten", `Head ${head.oid} descends from neither candidate ${candidate} nor its parent`),
      };
    }
    if (!published) {
      state.operation = null;
      await this.#save(state);
      return { kind: "not-published" };
    }
    return { kind: "published", operation: await this.#promote(state, operation) };
  }

  async #promote(state: StoredState, operation: PublishOperation): Promise<ApplyOperation> {
    const promoted: ApplyOperation = {
      kind: "apply",
      id: operation.id,
      target: { ...operation.candidate, files: operation.target },
      steps: operation.steps,
      recoveryId: operation.recoveryId,
    };
    state.operation = promoted;
    await this.#save(state);
    return promoted;
  }

  /**
   * Applies pending/blocked steps with compare-and-swap. A file that no longer
   * matches its captured version is left alone and carried as a newer draft.
   * The checkpoint advances only once every step is accounted for.
   */
  async #applySteps(state: StoredState, operation: ApplyOperation, local: Snapshot, files: Snapshot): Promise<Applied> {
    for (const step of operation.steps) {
      if (step.status !== "pending" && step.status !== "blocked") continue;
      const current = local[step.path] ?? null;
      if (sameEntry(current, step.next)) {
        markStep(step, "applied");
        continue;
      }
      if (!sameEntry(current, step.expected)) {
        markStep(step, "changed");
        continue;
      }
      const next = step.next ? files[step.path] : null;
      if (step.next && !sameEntry(next, step.next)) throw new IntegrityError(`Missing target content for ${step.path}`);
      const result = await this.#vault.apply(step.path, current, next ?? null);
      if (result.kind === "blocked") markStep(step, "blocked", result.reason || "Blocked by the vault adapter");
      else markStep(step, result.kind);
    }

    const blocked = operation.steps.filter((step) => step.status === "blocked");
    if (blocked.length > 0) {
      await this.#save(state);
      return {
        kind: "blocked",
        outcome: {
          kind: "blocked",
          commit: operation.target.commit,
          steps: blocked.map((step) => ({ path: step.path, reason: step.reason ?? "" })),
        },
      };
    }

    const carry: Record<string, Ref | null> = {};
    for (const step of operation.steps) {
      if (step.status === "changed") carry[step.path] = step.expected;
      else if (step.status === "kept") {
        carry[step.path] = step.next;
        const entry = files[step.path];
        if (step.next && entry) state.blobs[entry.oid] = entry.data;
      }
    }
    for (const entry of Object.values(carry)) {
      if (entry && !(entry.oid in state.blobs)) throw new IntegrityError(`Missing preserved bytes for ${entry.oid}`);
    }
    // Records whose bytes are all in GitHub history (old or new checkpoint)
    // become prunable; anything else stays pinned until the user discards it.
    const onGitHub = new Set([...Object.values(state.base.files), ...Object.values(operation.target.files)].map((entry) => entry.oid));
    for (const record of state.recovery) {
      if (record.pinned) record.pinned = Object.values(record.files).some((entry) => !onGitHub.has(entry.oid));
    }

    state.base = { commit: operation.target.commit, tree: operation.target.tree, files: operation.target.files };
    state.carry = carry;
    state.operation = null;
    state.review = null;
    state.decisions = {};
    await this.#save(state);
    return { kind: "complete", commit: operation.target.commit, carried: Object.keys(carry).sort() };
  }

  /** Checkpoint plus carry, with bytes from local/remote/blobs, fetching the checkpoint commit only if needed. */
  async #effectiveBase(
    state: StoredState,
    local: Snapshot,
    head: CommitSnapshot,
  ): Promise<{ kind: "ready"; files: Snapshot } | { kind: "paused"; outcome: SyncOutcome }> {
    const refs = effectiveManifest(state);
    const known = new Map<string, string>();
    for (const entry of [...Object.values(local), ...Object.values(head.files)]) known.set(entry.oid, entry.data);
    const files: Snapshot = {};
    const missing: string[] = [];
    for (const [path, entry] of Object.entries(refs)) {
      const data = known.get(entry.oid) ?? state.blobs[entry.oid];
      if (data === undefined) missing.push(path);
      else files[path] = { ...entry, data };
    }
    if (missing.length > 0) {
      const commit = await this.#repository.readCommit(state.base.commit);
      const checkpoint = await verifySnapshot(commit.files, "checkpoint commit");
      if (commit.oid !== state.base.commit || !sameManifest(checkpoint, state.base.files)) {
        return {
          kind: "paused",
          outcome: await this.#pause(state, "base-mismatch", `Commit ${state.base.commit} no longer matches the recorded checkpoint`),
        };
      }
      for (const path of missing) files[path] = checkpoint[path]!;
    }
    return { kind: "ready", files };
  }

  // ---- Enrollment --------------------------------------------------------

  async #survey(prior: StoredState | null): Promise<{
    preview: EnrollmentPreview;
    head: CommitSnapshot;
    local: Snapshot;
    carry: Record<string, Ref | null>;
    drafts: Snapshot;
  }> {
    const repository = await this.#repository.identity();
    const head = await this.#readHead();
    const local = await verifySnapshot(await this.#vault.capture(), "local capture");
    const old = prior ? effectiveManifest(prior) : null;
    const carry: Record<string, Ref | null> = {};
    const drafts: Snapshot = {};
    const items: EnrollmentPreview["items"] = [];
    let unchanged = 0;
    const paths = [...new Set([...Object.keys(local), ...Object.keys(head.files)])].sort();
    for (const path of paths) {
      const l = local[path] ?? null;
      const r = head.files[path] ?? null;
      const o = old?.[path] ?? null;
      if (sameEntry(l, r)) {
        unchanged++;
        continue;
      }
      if (l) drafts[path] = l;
      let action: EnrollmentAction;
      if (!l) {
        // Only on GitHub. Missing locally after a prior checkpoint had it unchanged = a local deletion to review.
        action = old && sameEntry(o, r) ? "review-local-deletion" : "download";
        if (action === "download") carry[path] = null;
      } else if (!r) {
        action = old && sameEntry(o, l) ? "review-remote-deletion" : "upload";
        if (action === "review-remote-deletion") carry[path] = toRef(l);
      } else if (old && sameEntry(o, l)) {
        action = "update-local";
        carry[path] = toRef(l);
      } else if (old && sameEntry(o, r)) {
        action = "upload";
      } else {
        action = "conflict";
        carry[path] = null;
      }
      items.push({ path, action });
    }
    const token = await digestText(
      JSON.stringify([
        "enroll/1",
        repository,
        head.oid,
        prior?.base.commit ?? null,
        Object.entries(toManifest(local)).sort(([a], [b]) => (a < b ? -1 : 1)),
      ]),
    );
    return {
      preview: { kind: "preview", token, repository, commit: head.oid, reenrollment: prior !== null, items, unchanged },
      head,
      local,
      carry,
      drafts,
    };
  }

  // ---- Restore -----------------------------------------------------------

  async #restorePreview(state: StoredState, input: { path: string; commit: string }): Promise<RestorePreview | RestoreRefusal> {
    if (!isSyncablePath(input.path)) return { kind: "invalid-path" };
    if (!isOid(input.commit)) return { kind: "not-in-history" };
    if (input.commit !== state.base.commit && !(await this.#repository.isAncestor(input.commit, state.base.commit))) {
      return { kind: "not-in-history" };
    }
    const commit = await this.#repository.readCommit(input.commit);
    if (commit.oid !== input.commit) throw new IntegrityError(`Read commit ${commit.oid} instead of ${input.commit}`);
    const raw = commit.files[input.path];
    if (raw === undefined) return { kind: "missing" };
    const historical = await verifyEntry(input.path, raw);
    const local = await verifySnapshot(await this.#vault.capture(), "local capture");
    const current = local[input.path] ?? null;
    const token = await digestText(
      JSON.stringify(["restore/1", input.path, input.commit, historical.oid, historical.mode, current?.oid ?? null, current?.mode ?? null]),
    );
    return { kind: "preview", token, path: input.path, commit: input.commit, historical, current };
  }

  async #loadIdle(): Promise<{ kind: "ready"; state: StoredState } | { kind: "refused"; outcome: RestoreRefusal }> {
    const loaded = await this.#load();
    if (loaded.kind !== "enrolled") return { kind: "refused", outcome: loaded };
    if (loaded.state.pause) return { kind: "refused", outcome: { kind: "paused", pause: loaded.state.pause } };
    if (loaded.state.operation) return { kind: "refused", outcome: { kind: "busy" } };
    return { kind: "ready", state: loaded.state };
  }

  // ---- Status ------------------------------------------------------------

  async #status(scan: boolean): Promise<SessionStatus> {
    const loaded = await this.#load();
    if (loaded.kind !== "enrolled") return loaded;
    const { state } = loaded;
    let pending: PendingChange[] | null = null;
    if (scan) {
      const local = await verifySnapshot(await this.#vault.capture(), "local capture");
      const base = effectiveManifest(state);
      pending = [];
      for (const path of [...new Set([...Object.keys(base), ...Object.keys(local)])].sort()) {
        const b = base[path];
        const l = local[path];
        if (sameEntry(b, l)) continue;
        pending.push({ path, change: !b ? "added" : !l ? "deleted" : "modified" });
      }
    }
    const operation = state.operation;
    const blocked =
      operation?.kind === "apply"
        ? operation.steps.filter((step) => step.status === "blocked").map((step) => ({ path: step.path, reason: step.reason ?? "" }))
        : [];
    const conflicts = (state.review?.conflicts ?? []).map((item) => restoreConflict(state, item));
    const phase: Phase = state.pause
      ? "paused"
      : operation?.kind === "publish"
        ? "publication-unknown"
        : operation
          ? blocked.length > 0
            ? "blocked"
            : "applying"
          : conflicts.length > 0
            ? "needs-decision"
            : pending && pending.length > 0
              ? "local-changes"
              : "idle";
    return {
      kind: "enrolled",
      repository: state.repository,
      commit: state.base.commit,
      phase,
      pause: state.pause,
      conflicts,
      blocked,
      carried: Object.keys(state.carry).sort(),
      pending,
      recovery: state.recovery.length,
    };
  }

  // ---- Persistence -------------------------------------------------------

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<Loaded> {
    const raw = await this.#store.load();
    if (raw === undefined || raw === null) return { kind: "unenrolled" };
    try {
      return { kind: "enrolled", state: await parseState(raw) };
    } catch (error) {
      if (error instanceof CorruptStateError) return { kind: "corrupt", detail: error.message };
      throw error;
    }
  }

  async #save(state: StoredState): Promise<void> {
    const active = state.operation?.recoveryId ?? null;
    const disposable = state.recovery.filter((record) => !record.pinned && record.id !== active);
    const drop = new Set(disposable.slice(0, Math.max(0, disposable.length - RETAINED_RECOVERY)).map((record) => record.id));
    state.recovery = state.recovery.filter((record) => !drop.has(record.id));
    const live = referencedBlobs(state);
    for (const oid of Object.keys(state.blobs)) if (!live.has(oid)) delete state.blobs[oid];
    await this.#store.save(structuredClone(state));
  }

  async #pause(state: StoredState, reason: PauseReason, detail: string): Promise<SyncOutcome> {
    state.pause = { reason, detail };
    await this.#save(state);
    return { kind: "paused", pause: state.pause };
  }

  async #readHead(): Promise<CommitSnapshot> {
    const head = await this.#repository.head();
    if (!isOid(head.oid) || !isOid(head.treeOid)) throw new IntegrityError("Repository head has malformed object IDs");
    return { oid: head.oid, treeOid: head.treeOid, files: await verifySnapshot(head.files, "remote head") };
  }

  /** Adds an immutable recovery record, reusing an identical pinned one. Returns its id. */
  #record(state: StoredState, reason: RecoveryReason, files: Snapshot): string | null {
    if (Object.keys(files).length === 0) return null;
    for (const entry of Object.values(files)) state.blobs[entry.oid] = entry.data;
    const existing = state.recovery.find((record) => record.pinned && sameManifest(record.files, files));
    if (existing) return existing.id;
    const record: RecoveryRecord = {
      id: this.#nextId(state, "recovery"),
      createdAt: this.#now().toISOString(),
      reason,
      commit: state.base.commit,
      files: toManifest(files),
      pinned: true,
    };
    state.recovery.push(record);
    return record.id;
  }

  #storeConflict(state: StoredState, conflict: Conflict): StoredConflict {
    if (conflict.kind === "collision") return { kind: "collision", id: conflict.id, paths: conflict.paths };
    const keep = (entry: Entry | null): Ref | null => {
      if (!entry) return null;
      state.blobs[entry.oid] = entry.data;
      return toRef(entry);
    };
    return {
      kind: conflict.kind,
      id: conflict.id,
      path: conflict.path,
      base: keep(conflict.base),
      local: keep(conflict.local),
      remote: keep(conflict.remote),
      choices: conflict.choices,
      sibling: conflict.sibling,
    };
  }

  #nextId(state: StoredState, prefix: string): string {
    state.counter += 1;
    return `${prefix}-${state.counter}`;
  }

  #message(count: number): string {
    return `Vault sync from ${this.#deviceName}: ${count} file${count === 1 ? "" : "s"}`;
  }
}

// ---- Helpers ---------------------------------------------------------------

function markStep(step: StoredStep, status: StoredStep["status"], reason: string | null = null): void {
  step.status = status;
  step.reason = reason;
}

function commitState(commit: CommitSnapshot): StoredState["base"] {
  return { commit: commit.oid, tree: commit.treeOid, files: toManifest(commit.files) };
}

function effectiveManifest(state: StoredState): Manifest {
  const refs: Manifest = { ...state.base.files };
  for (const [path, entry] of Object.entries(state.carry)) {
    if (entry) refs[path] = entry;
    else delete refs[path];
  }
  return refs;
}

function choices(state: StoredState): Record<string, Choice> {
  const result: Record<string, Choice> = {};
  for (const [id, decision] of Object.entries(state.decisions)) {
    if (decision.kind !== "edit") result[id] = decision;
    else result[id] = { kind: "edit", entry: { ...decision.entry, data: state.blobs[decision.entry.oid]! } };
  }
  return result;
}

function materialize(state: StoredState, files: Manifest): Snapshot {
  const snapshot: Snapshot = {};
  for (const [path, entry] of Object.entries(files)) snapshot[path] = { ...entry, data: state.blobs[entry.oid]! };
  return snapshot;
}

function restoreConflict(state: StoredState, conflict: StoredConflict): Conflict {
  if (conflict.kind === "collision") return conflict;
  const entry = (ref: Ref | null): Entry | null => (ref ? { ...ref, data: state.blobs[ref.oid]! } : null);
  return { ...conflict, base: entry(conflict.base), local: entry(conflict.local), remote: entry(conflict.remote) };
}

function sameIdentity(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.id === b.id && a.owner === b.owner && a.name === b.name && a.branch === b.branch;
}

function describe(identity: RepositoryIdentity): string {
  return `${identity.owner}/${identity.name}#${identity.branch} (${identity.id})`;
}

function base64Length(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}
