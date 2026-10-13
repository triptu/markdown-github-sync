// SyncSession: the single owner of synchronization state for one vault.
// Durable transactions run one at a time; vault events are visible immediately.
// Publication and local mutation require a durable recovery save first.
import type { CommitSnapshot, DurableStore, Entry, FileMode, LocalVault, Repository, RepositoryIdentity, Snapshot } from "./contracts";
import {
  IntegrityError,
  decodeBase64,
  dictionary,
  own,
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
  | { kind: "contended" }
  | { kind: "publication-unknown"; operationId: string; parent: string; candidate: string; head: string };

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

export interface PublicationRecoveryPreview {
  kind: "preview";
  token: string;
  operationId: string;
  parent: string;
  candidate: string;
  head: string;
  candidateFiles: Snapshot;
  headFiles: Snapshot;
  localFiles: Snapshot;
}
export type PublicationRecoveryRefusal = Unavailable | { kind: "missing" } | { kind: "reachable"; candidate: string } | { kind: "paused"; pause: Pause };
export type PublicationRecoveryOutcome = PublicationRecoveryRefusal | { kind: "stale" } | { kind: "released"; pause: Pause };

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
type Settled = { kind: "published"; operation: ApplyOperation } | { kind: "held"; outcome: SyncOutcome };

export class SyncSession {
  readonly #repository: Repository;
  readonly #vault: LocalVault;
  readonly #store: DurableStore;
  readonly #deviceName: string;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();
  // Per-state generations track events consumed by an active transaction. Only
  // a successful save advances the generation trusted by subsequent loads.
  #localGeneration = 0;
  #durableGeneration = 0;
  readonly #stateGenerations = new WeakMap<StoredState, number>();
  readonly #previewSession = crypto.randomUUID();

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

  /** Call immediately for each observed vault event; await the result for durable invalidation. */
  notifyLocalChange(): Promise<Unavailable | { kind: "invalidated" }> {
    ++this.#localGeneration;
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      await this.#save(loaded.state);
      return { kind: "invalidated" };
    });
  }

  previewEnrollment(): Promise<EnrollmentPreview | Exclude<EnrollOutcome, { kind: "stale" } | { kind: "enrolled" }>> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind === "corrupt") return loaded;
      const prior = loaded.kind === "enrolled" ? loaded.state : null;
      if (prior && (!prior.pause || prior.operation)) return { kind: "already-enrolled" };
      return (await this.#survey(prior)).preview;
    });
  }

  /** Binds this vault to the repository head shown in the confirmed preview. Mutates no vault files. */
  enroll(input: { token: string }): Promise<EnrollOutcome> {
    return this.#exclusive(async () => {
      const generation = this.#localGeneration;
      const loaded = await this.#load();
      if (loaded.kind === "corrupt") return loaded;
      const prior = loaded.kind === "enrolled" ? loaded.state : null;
      if (prior && (!prior.pause || prior.operation)) return { kind: "already-enrolled" };
      const survey = await this.#survey(prior);
      if (generation !== this.#localGeneration || survey.preview.token !== input.token) return { kind: "stale", preview: survey.preview };
      const state: StoredState = {
        format: STATE_FORMAT,
        observation: "settled",
        repository: survey.preview.repository,
        base: commitState(survey.head),
        carry: survey.carry,
        operation: null,
        pause: null,
        review: null,
        decisions: dictionary(),
        recovery: prior?.recovery ?? [],
        blobs: dictionary(Object.entries(prior?.blobs ?? {})),
        counter: prior?.counter ?? 0,
      };
      this.#stateGenerations.set(state, generation);
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
      const identity = await this.#repository.identity();
      if (state.pause) {
        if (state.pause.reason !== "repository-changed" || !state.operation || !sameIdentity(identity, state.repository)) return { kind: "paused", pause: state.pause };
        state.pause = null;
        await this.#save(state);
      }
      if (!sameIdentity(identity, state.repository)) {
        return this.#pause(state, "repository-changed", `Expected ${describe(state.repository)}, found ${describe(identity)}`);
      }
      let published = false;
      const carried = new Set<string>();
      if (state.operation) {
        const resumed = await this.#resume(state);
        if (resumed.kind === "held") return resumed.outcome;
        published ||= resumed.published;
        resumed.carried.forEach((path) => carried.add(path));
      }
      const outcome = await this.#transact(state);
      if (outcome.kind === "synced") {
        outcome.carried.forEach((path) => carried.add(path));
        return { ...outcome, published: outcome.published || published, carried: [...carried].sort() };
      }
      if (outcome.kind === "up-to-date" && (published || carried.size > 0)) {
        return { kind: "synced", commit: outcome.commit, published, carried: [...carried].sort() };
      }
      return outcome;
    });
  }

  /** Records a decision for a conflict from the latest review. Applied by the next `sync` only if versions are unchanged. */
  resolve(input: { conflictId: string; choice: ChoiceInput }): Promise<DecisionOutcome> {
    return this.#exclusive(async () => {
      const generation = this.#localGeneration;
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      const conflict = state.review?.conflicts.find((item) => item.id === input.conflictId);
      if (!conflict || generation !== this.#localGeneration) return { kind: "stale" };
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
        this.#record(state, "conflict-edit", dictionary([[conflict.path, entry]]));
        state.decisions[conflict.id] = { kind: "edit", entry: toRef(entry) };
      } else {
        state.decisions[conflict.id] = { kind: input.choice.kind };
      }
      await this.#save(state);
      if (generation !== this.#localGeneration) {
        await this.#save(state);
        return { kind: "stale" };
      }
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
      const generation = this.#localGeneration;
      const ready = await this.#loadIdle();
      if (ready.kind !== "ready") return ready.outcome;
      const { state } = ready;
      const preview = await this.#restorePreview(state, input);
      if (preview.kind !== "preview") return preview;
      if (generation !== this.#localGeneration || preview.token !== input.token) return { kind: "stale", preview };
      if (sameEntry(preview.current, preview.historical)) return { kind: "unchanged" };
      // Invalidate before the write: a lost apply response must not leave an
      // approval valid across a recreation and subsequent deletion.
      this.#invalidateReview(state);
      this.#record(state, "restore", preview.current ? { [preview.path]: preview.current } : {});
      this.#record(state, "restore", dictionary([[preview.path, preview.historical]]));
      await this.#save(state);
      if (generation !== this.#localGeneration) return { kind: "stale", preview: null };
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
      if (state.operation?.recoveryId === input.id || (state.operation?.incoming.kind === "captured" && state.operation.incoming.recoveryId === input.id)) return { kind: "in-use" };
      const before = state.recovery.length;
      state.recovery = state.recovery.filter((record) => record.id !== input.id);
      if (state.recovery.length === before) return { kind: "missing" };
      await this.#save(state);
      return { kind: "discarded" };
    });
  }

  /** Review abandonment of a held candidate. This never asserts nonpublication. */
  previewPublicationRecovery(): Promise<PublicationRecoveryPreview | PublicationRecoveryRefusal> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      return this.#publicationRecoveryPreview(loaded.state);
    });
  }

  /** Archive the reviewed candidate and live drafts, then require re-enrollment. No publication or vault writes. */
  recoverPublication(input: { token: string }): Promise<PublicationRecoveryOutcome> {
    return this.#exclusive(async () => {
      const generation = this.#localGeneration;
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      const preview = await this.#publicationRecoveryPreview(state);
      if (preview.kind !== "preview") return preview;
      if (generation !== this.#localGeneration || preview.token !== input.token) return { kind: "stale" };
      this.#record(state, "publication-recovery", preview.candidateFiles);
      this.#record(state, "publication-recovery", preview.localFiles);
      // Reviewed abandonment makes the captured local versions the origins;
      // re-enrollment then offers the live head as updates/deletions, never replay.
      state.carry = dictionary();
      for (const path of new Set([...Object.keys(state.base.files), ...Object.keys(preview.localFiles), ...Object.keys(preview.headFiles)])) {
        const entry = preview.localFiles[path];
        state.carry[path] = entry ? toRef(entry) : null;
      }
      state.operation = null;
      state.review = null;
      state.decisions = dictionary();
      state.pause = { reason: "history-rewritten", detail: `Abandoned unresolved candidate ${preview.candidate} after review; re-enroll against the current head` };
      await this.#save(state);
      return { kind: "released", pause: state.pause };
    });
  }

  async #publicationRecoveryPreview(state: StoredState): Promise<PublicationRecoveryPreview | PublicationRecoveryRefusal> {
    const generation = this.#localGeneration;
    const operation = state.operation;
    if (operation?.kind !== "publish") return { kind: "missing" };
    const identity = await this.#repository.identity();
    if (!sameIdentity(identity, state.repository)) {
      return { kind: "paused", pause: { reason: "repository-changed", detail: "Restore the enrolled repository identity before reviewing publication recovery" } };
    }
    const head = await this.#readHead(state);
    if (head.oid === operation.candidate.commit || await this.#repository.isAncestor(operation.candidate.commit, head.oid)) {
      return { kind: "reachable", candidate: operation.candidate.commit };
    }
    const candidate = await this.#repository.readCommit(operation.candidate.commit);
    const candidateFiles = await verifySnapshot(candidate.files, "recovery candidate");
    if (candidate.oid !== operation.candidate.commit || candidate.treeOid !== operation.candidate.tree || !sameManifest(candidateFiles, operation.target)) {
      throw new IntegrityError("Recovery candidate differs from the durable operation");
    }
    const localFiles = await this.#capture(state, "recovery local capture");
    const token = await digestText(JSON.stringify(["publication-recovery/2", this.#previewSession, generation, identity, operation, head.oid, toManifest(localFiles)]));
    return { kind: "preview", token, operationId: operation.id, parent: operation.parent, candidate: candidate.oid, head: head.oid, candidateFiles, headFiles: head.files, localFiles };
  }

  // ---- Synchronization ---------------------------------------------------

  async #transact(state: StoredState): Promise<SyncOutcome> {
    const head = await this.#readHead(state);
    if (head.oid !== state.base.commit && !(await this.#repository.isAncestor(state.base.commit, head.oid))) {
      return this.#pause(state, "history-rewritten", `Checkpoint ${state.base.commit} is not an ancestor of head ${head.oid}`);
    }
    this.#observeLocalEvents(state);
    const generation = this.#localGeneration;
    const hadReview = state.review !== null || Object.keys(state.decisions).length > 0;
    const local = await this.#capture(state, "local capture");
    const hadPrototypeBaseline = Object.hasOwn(state.base.files, "__proto__");
    const base = await this.#effectiveBase(state, local, head);
    if (base.kind === "paused") return base.outcome;
    if (generation !== this.#localGeneration) return this.#restartReview(state);
    if (!state.review || state.review.head !== head.oid || !sameManifest(state.review.local, local)) {
      this.#invalidateReview(state);
      state.review = { head: head.oid, scope: this.#nextId(state, "review"), local: toManifest(local), conflicts: [] };
    }
    const reviewScope = `${head.oid}:${state.review.scope}`;
    const unresolved = await reconcile({ base: base.files, local, remote: head.files, decisions: dictionary(), reviewScope });
    if (generation !== this.#localGeneration) return this.#restartReview(state);
    const conflicts = unresolved.kind === "needs-decision" ? unresolved.conflicts : [];
    const validIds = new Set(conflicts.map((item) => item.id));
    for (const id of Object.keys(state.decisions)) if (!validIds.has(id)) delete state.decisions[id];
    if (conflicts.length === 0) state.review = null;
    else state.review.conflicts = conflicts.map((item) => this.#storeConflict(state, item));
    const plan = Object.keys(state.decisions).length > 0
      ? await reconcile({ base: base.files, local, remote: head.files, decisions: choices(state), reviewScope })
      : unresolved;
    if (generation !== this.#localGeneration) return this.#restartReview(state);

    if (plan.kind === "needs-decision") {
      await this.#save(state);
      return { kind: "needs-decision", conflicts: plan.conflicts, merged: plan.merged };
    }

    const outgoing = Object.keys(plan.outgoing).length;
    if (outgoing === 0 && plan.incoming.length === 0) {
      const settled =
        head.oid === state.base.commit &&
        Object.keys(state.carry).length === 0 &&
        !hadReview &&
        hadPrototypeBaseline === Object.hasOwn(state.base.files, "__proto__") &&
        !state.review &&
        Object.keys(state.decisions).length === 0;
      if (!settled) {
        state.base = commitState(head);
        state.carry = dictionary();
        state.review = null;
        state.decisions = dictionary();
        await this.#save(state);
      }
      return { kind: "up-to-date", commit: head.oid };
    }

    // Drafts (local differs from the effective base) and every preimage the
    // application could overwrite are recorded before anything leaves or changes.
    const drafts: Snapshot = dictionary();
    for (const [path, entry] of Object.entries(local)) if (!sameEntry(entry, base.files[path])) drafts[path] = entry;
    for (const step of plan.incoming) if (step.expected) drafts[step.path] = step.expected;
    const recoveryId = this.#record(state, "sync", drafts);
    const incomingFiles: Snapshot = dictionary();
    for (const step of plan.incoming) if (step.next) incomingFiles[step.path] = step.next;
    const incoming = { kind: "captured", recoveryId: this.#record(state, "incoming", incomingFiles) } satisfies ApplyOperation["incoming"];
    const steps: StoredStep[] = plan.incoming.map((step) => {
      const consent = step.consent;
      if (consent.kind === "reviewed" && consent.base) state.blobs[consent.base.oid] = consent.base.data;
      return {
        path: step.path,
        expected: step.expected && toRef(step.expected),
        next: step.next && toRef(step.next),
        status: "pending",
        reason: null,
        consent: consent.kind === "reviewed"
          ? { kind: "reviewed", base: consent.base && toRef(consent.base) }
          : { kind: "automatic" },
      };
    });

    if (outgoing === 0) {
      const operation: ApplyOperation = {
        kind: "apply",
        id: this.#nextId(state, "apply"),
        target: { commit: head.oid, tree: head.treeOid, files: toManifest(head.files) },
        steps,
        approval: { kind: "valid", local: toManifest(local) },
        recoveryId,
        incoming,
      };
      state.operation = operation;
      await this.#save(state);
      if (generation !== this.#localGeneration) return this.#restartReview(state);
      return this.#finish(state, operation, local, head.files, false);
    }

    const candidate = await this.#repository.prepare(head, plan.outgoing, this.#message(outgoing));
    if (!isOid(candidate.oid) || !isOid(candidate.treeOid) || candidate.oid === head.oid || !sameManifest(candidate.files, plan.target)) {
      throw new IntegrityError("Prepared commit does not contain exactly the planned files");
    }
    if (generation !== this.#localGeneration) return this.#restartReview(state);
    const operation: PublishOperation = {
      kind: "publish",
      id: this.#nextId(state, "publish"),
      parent: head.oid,
      candidate: { commit: candidate.oid, tree: candidate.treeOid },
      target: toManifest(plan.target),
      steps,
      approval: { kind: "valid", local: toManifest(local) },
      recoveryId,
      incoming,
    };
    state.operation = operation;
    await this.#save(state);

    if (generation !== this.#localGeneration) return this.#restartReview(state);
    const result = await this.#repository.publish(head.oid, candidate.oid);
    if (result.kind === "accepted") {
      return this.#finish(state, await this.#promote(state, operation), local, plan.target, true);
    }
    // Never trust a non-acceptance blindly: the branch is the authority.
    const settled = await this.#settle(state, operation);
    if (settled.kind === "held") return settled.outcome;
    return this.#finish(state, settled.operation, local, plan.target, true);
  }

  /** Only called before dispatch: the recorded candidate has never been sent. */
  async #restartReview(state: StoredState): Promise<SyncOutcome> {
    state.operation = null;
    this.#observeLocalEvents(state);
    await this.#save(state);
    return this.#transact(state);
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
      if (settled.kind === "held") return { kind: "held", outcome: settled.outcome };
      operation = settled.operation;
      published = true;
    }
    const target = await this.#repository.readCommit(operation.target.commit);
    const files = await verifySnapshot(target.files, "target commit");
    if (target.oid !== operation.target.commit || target.treeOid !== operation.target.tree || !sameManifest(files, operation.target.files)) {
      throw new IntegrityError(`Commit ${operation.target.commit} does not match the recorded operation`);
    }
    if (operation.incoming.kind === "legacy") {
      const incomingFiles: Snapshot = dictionary();
      for (const step of operation.steps) if (step.next) incomingFiles[step.path] = files[step.path]!;
      operation.incoming = { kind: "captured", recoveryId: this.#record(state, "incoming", incomingFiles) };
      await this.#save(state);
    }
    const local = await this.#capture(state, "local capture");
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
    const head = await this.#readHead(state);
    const candidate = operation.candidate.commit;
    let published = head.oid === candidate;
    if (!published) {
      try {
        published = await this.#repository.isAncestor(candidate, head.oid);
      } catch {
        published = false;
      }
    }
    if (published) {
      return { kind: "published", operation: await this.#promote(state, operation) };
    }
    // A missing candidate can have landed and then been removed by a rewind.
    // Neither an unchanged parent nor a sibling descendant proves nonpublication.
    return { kind: "held", outcome: { kind: "publication-unknown", operationId: operation.id, parent: operation.parent, candidate, head: head.oid } };
  }

  async #promote(state: StoredState, operation: PublishOperation): Promise<ApplyOperation> {
    const promoted: ApplyOperation = {
      kind: "apply",
      id: operation.id,
      target: { ...operation.candidate, files: operation.target },
      steps: operation.steps,
      approval: operation.approval,
      recoveryId: operation.recoveryId,
      incoming: operation.incoming,
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
      this.#observeLocalEvents(state);
      const current = local[step.path] ?? null;
      if (sameEntry(current, step.next)) {
        markStep(step, "applied");
        continue;
      }
      if (step.consent.kind === "reviewed" && operation.approval.kind === "revoked") {
        markStep(step, "revoked");
        continue;
      }
      if (!sameEntry(current, step.expected)) {
        markStep(step, "changed");
        continue;
      }
      const next = step.next ? files[step.path] : null;
      if (step.next && !sameEntry(next, step.next)) throw new IntegrityError(`Missing target content for ${step.path}`);
      await this.#beginObservation(state);
      // Saving the attempt can itself receive a forwarded event.
      this.#observeLocalEvents(state);
      if (step.consent.kind === "reviewed" && operation.approval.kind === "revoked") {
        markStep(step, "revoked");
        await this.#endObservation(state);
        continue;
      }
      const result = await this.#vault.apply(step.path, current, next ?? null);
      if (result.kind === "blocked") markStep(step, "blocked", result.reason || "Blocked by the vault adapter");
      else markStep(step, result.kind);
      if (result.kind === "changed") {
        // A failed CAS observes a local change even without a forwarded event.
        // The durable pending observation already fences a lost result save.
        this.#invalidateReview(state);
      }
      // Account for our own completed write when comparing later captures.
      if (result.kind === "applied" && operation.approval.kind === "valid") {
        if (step.next) operation.approval.local[step.path] = step.next;
        else delete operation.approval.local[step.path];
      }
      // Record the result and our own write before another observation starts.
      await this.#endObservation(state);
    }

    // Preserve every observed newer draft even while another step remains blocked.
    // The capture settles any consent observation; completion pins carry origins below.
    const recaptured = await this.#capture(state, "post-application capture", false);
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

    // Capture the actual newer draft, separately from the carry's origin.
    // Save it durably before advancing the checkpoint.
    const newer: Snapshot = dictionary();
    const carry: Record<string, Ref | null> = dictionary();
    for (const step of operation.steps) {
      if (step.status === "revoked" && step.consent.kind === "reviewed") carry[step.path] = step.consent.base;
      else if (step.status === "changed") carry[step.path] = step.expected;
      else if (step.status === "kept") {
        carry[step.path] = step.next;
        const entry = files[step.path];
        if (step.next && entry) state.blobs[entry.oid] = entry.data;
      }
    }
    const stepsByPath = new Map(operation.steps.map((step) => [step.path, step]));
    for (const path of new Set([...Object.keys(local), ...Object.keys(recaptured), ...stepsByPath.keys()])) {
      const step = stepsByPath.get(path);
      const expected = step?.status === "revoked" && step.consent.kind === "reviewed"
        ? step.consent.base
        : step?.status === "changed" ? step.expected : step ? step.next : local[path];
      if (!sameEntry(recaptured[path], expected) || Object.hasOwn(carry, path)) {
        if (!Object.hasOwn(carry, path)) carry[path] = expected ? toRef(expected) : null;
        const draft = recaptured[path];
        if (draft) newer[path] = draft;
      }
      if (expected && local[path]?.oid === expected.oid) state.blobs[expected.oid] = local[path]!.data;
    }
    this.#record(state, "carried", newer);
    const origins: Manifest = dictionary();
    for (const entry of Object.values(carry)) {
      if (entry && !Object.hasOwn(state.blobs, entry.oid)) throw new IntegrityError(`Missing preserved bytes for ${entry.oid}`);
    }
    for (const [path, entry] of Object.entries(carry)) if (entry) origins[path] = entry;
    // The carry map is not yet in state. Pin its origins before #save prunes
    // blobs, so both this completion and a restart retain the same evidence.
    this.#record(state, "carried", materialize(state, origins));
    if (Object.keys(newer).length > 0) await this.#save(state);
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
    state.decisions = dictionary();
    await this.#save(state);
    return { kind: "complete", commit: operation.target.commit, carried: Object.keys(carry).sort() };
  }

  /** Verify the immutable checkpoint, then materialize checkpoint plus carry. */
  async #effectiveBase(
    state: StoredState,
    local: Snapshot,
    head: CommitSnapshot,
  ): Promise<{ kind: "ready"; files: Snapshot } | { kind: "paused"; outcome: SyncOutcome }> {
    const commit = state.base.commit === head.oid ? head : await this.#repository.readCommit(state.base.commit);
    const checkpoint = await verifySnapshot(commit.files, "checkpoint commit");
    // Old ordinary-object manifests could omit the __proto__ path. Recover its
    // baseline from the immutable checkpoint before classifying any deletion.
    if (!Object.hasOwn(state.base.files, "__proto__") && Object.hasOwn(checkpoint, "__proto__")) {
      state.base.files["__proto__"] = toRef(checkpoint["__proto__"]!);
    }
    if (commit.oid !== state.base.commit || commit.treeOid !== state.base.tree || !sameManifest(checkpoint, state.base.files)) {
      return { kind: "paused", outcome: await this.#pause(state, "base-mismatch", `Commit ${state.base.commit} no longer matches the recorded checkpoint`) };
    }
    const refs = effectiveManifest(state);
    const known = new Map<string, string>();
    for (const entry of [...Object.values(local), ...Object.values(head.files)]) known.set(entry.oid, entry.data);
    const files: Snapshot = dictionary();
    const missing: string[] = [];
    for (const [path, entry] of Object.entries(refs)) {
      const data = known.get(entry.oid) ?? state.blobs[entry.oid];
      if (data === undefined) missing.push(path);
      else files[path] = { ...entry, data };
    }
    for (const path of missing) {
      const entry = checkpoint[path];
      if (!entry || !sameEntry(entry, refs[path])) throw new IntegrityError(`Missing carried origin for ${path}`);
      files[path] = entry;
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
    const generation = this.#localGeneration;
    const repository = await this.#repository.identity();
    const head = await this.#readHead(prior);
    const local = await this.#capture(prior, "local capture");
    if (prior) {
      const checkpointCommit = prior.base.commit === head.oid ? head : await this.#repository.readCommit(prior.base.commit);
      const checkpoint = await verifySnapshot(checkpointCommit.files, "re-enrollment checkpoint");
      if (!Object.hasOwn(prior.base.files, "__proto__") && Object.hasOwn(checkpoint, "__proto__")) prior.base.files["__proto__"] = toRef(checkpoint["__proto__"]!);
      if (checkpointCommit.oid !== prior.base.commit || checkpointCommit.treeOid !== prior.base.tree || !sameManifest(checkpoint, prior.base.files)) {
        throw new IntegrityError("Re-enrollment checkpoint differs from its immutable commit");
      }
    }
    const old = prior ? effectiveManifest(prior) : null;
    const carry: Record<string, Ref | null> = dictionary();
    const drafts: Snapshot = dictionary();
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
        "enroll/2",
        this.#previewSession,
        generation,
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
    const generation = this.#localGeneration;
    if (!isSyncablePath(input.path)) return { kind: "invalid-path" };
    if (!isOid(input.commit)) return { kind: "not-in-history" };
    if (input.commit !== state.base.commit && !(await this.#repository.isAncestor(input.commit, state.base.commit))) {
      return { kind: "not-in-history" };
    }
    const commit = await this.#repository.readCommit(input.commit);
    if (commit.oid !== input.commit) throw new IntegrityError(`Read commit ${commit.oid} instead of ${input.commit}`);
    const raw = own(commit.files, input.path);
    if (raw === undefined) return { kind: "missing" };
    const historical = await verifyEntry(input.path, raw);
    const local = await this.#capture(state, "local capture");
    const current = local[input.path] ?? null;
    const token = await digestText(
      JSON.stringify(["restore/2", this.#previewSession, generation, input.path, input.commit, historical.oid, historical.mode, current?.oid ?? null, current?.mode ?? null]),
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
      const local = await this.#capture(state, "local capture");
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
    const conflicts = (state.review?.conflicts ?? []).filter((item) => !Object.hasOwn(state.decisions, item.id)).map((item) => restoreConflict(state, item));
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

  #observeLocalEvents(state: StoredState): boolean {
    if ((this.#stateGenerations.get(state) ?? this.#durableGeneration) === this.#localGeneration) return false;
    this.#invalidateReview(state);
    this.#stateGenerations.set(state, this.#localGeneration);
    return true;
  }

  #invalidateReview(state: StoredState): boolean {
    const revoked = state.operation?.approval.kind === "valid";
    if (revoked && state.operation) state.operation.approval = { kind: "revoked" };
    if (!state.review && Object.keys(state.decisions).length === 0) return revoked;
    const priorDrafts: Manifest = dictionary();
    for (const conflict of state.review?.conflicts ?? []) {
      if (conflict.kind !== "collision" && conflict.local) priorDrafts[conflict.path] = conflict.local;
    }
    this.#record(state, "sync", materialize(state, priorDrafts));
    state.review = null;
    state.decisions = dictionary();
    return true;
  }

  /** All enrolled captures archive drafts and retire approvals before an API can return early. */
  async #capture(state: StoredState | null, label: string, persist = true): Promise<Snapshot> {
    if (state) await this.#beginObservation(state);
    const observed = state ? this.#observeLocalEvents(state) : false;
    const local = await verifySnapshot(await this.#vault.capture(), label);
    if (!state) return local;
    let changed = this.#observeLocalEvents(state) || observed;
    if ((state.review && !sameManifest(state.review.local, local)) ||
        (state.operation?.approval.kind === "valid" && !sameManifest(state.operation.approval.local, local))) {
      changed = this.#invalidateReview(state) || changed;
    }
    const base = effectiveManifest(state);
    const drafts: Snapshot = dictionary();
    // Records may hold different versions at the same path; use all pinned
    // records rather than reducing them into one last-version-wins manifest.
    for (const [path, entry] of Object.entries(local)) {
      if (!sameEntry(entry, base[path]) && !state.recovery.some((record) => record.pinned && sameEntry(record.files[path], entry))) drafts[path] = entry;
    }
    const counter = state.counter;
    this.#record(state, "sync", drafts);
    if (state.observation === "pending") await this.#endObservation(state);
    else if (persist && (changed || state.counter !== counter)) await this.#save(state);
    return local;
  }

  /** Persist uncertainty before calling a port that can disprove live consent. */
  async #beginObservation(state: StoredState): Promise<void> {
    if (!state.review && state.operation?.approval.kind !== "valid") return;
    state.observation = "pending";
    await this.#save(state);
  }

  async #endObservation(state: StoredState): Promise<void> {
    state.observation = "settled";
    await this.#save(state);
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<Loaded> {
    const raw = await this.#store.load();
    if (raw === undefined || raw === null) return { kind: "unenrolled" };
    try {
      const state = await parseState(raw);
      this.#stateGenerations.set(state, this.#durableGeneration);
      const observed = this.#observeLocalEvents(state);
      if (state.observation === "pending") await this.#endObservation(state);
      else if (observed) await this.#save(state);
      return { kind: "enrolled", state };
    } catch (error) {
      if (error instanceof CorruptStateError) return { kind: "corrupt", detail: error.message };
      throw error;
    }
  }

  async #save(state: StoredState): Promise<void> {
    this.#observeLocalEvents(state);
    const generation = this.#stateGenerations.get(state) ?? this.#durableGeneration;
    const active = new Set([state.operation?.recoveryId, state.operation?.incoming.kind === "captured" ? state.operation.incoming.recoveryId : null]);
    const disposable = state.recovery.filter((record) => !record.pinned && !active.has(record.id));
    const drop = new Set(disposable.slice(0, Math.max(0, disposable.length - RETAINED_RECOVERY)).map((record) => record.id));
    state.recovery = state.recovery.filter((record) => !drop.has(record.id));
    const live = referencedBlobs(state);
    for (const oid of Object.keys(state.blobs)) if (!live.has(oid)) delete state.blobs[oid];
    const copy = structuredClone(state);
    copy.base.files = toManifest(copy.base.files);
    copy.carry = dictionary(Object.entries(copy.carry));
    copy.decisions = dictionary(Object.entries(copy.decisions));
    copy.blobs = dictionary(Object.entries(copy.blobs));
    if (copy.review) copy.review.local = toManifest(copy.review.local);
    if (copy.operation?.approval.kind === "valid") copy.operation.approval.local = toManifest(copy.operation.approval.local);
    if (copy.operation?.kind === "publish") copy.operation.target = toManifest(copy.operation.target);
    else if (copy.operation) copy.operation.target.files = toManifest(copy.operation.target.files);
    for (const record of copy.recovery) record.files = toManifest(record.files);
    await this.#store.save(copy);
    this.#durableGeneration = generation;
  }

  async #pause(state: StoredState, reason: PauseReason, detail: string): Promise<SyncOutcome> {
    state.pause = { reason, detail };
    await this.#save(state);
    return { kind: "paused", pause: state.pause };
  }

  async #readHead(state: StoredState | null = null): Promise<CommitSnapshot> {
    if (state) await this.#beginObservation(state);
    const head = await this.#repository.head();
    if (!isOid(head.oid) || !isOid(head.treeOid)) throw new IntegrityError("Repository head has malformed object IDs");
    const verified = { oid: head.oid, treeOid: head.treeOid, files: await verifySnapshot(head.files, "remote head") };
    if (state) {
      // A candidate we just published is an expected head transition.
      const expectedHead = state.operation?.kind === "publish" ? state.operation.candidate.commit
        : state.operation?.kind === "apply" ? state.operation.target.commit : state.review?.head;
      if (expectedHead && expectedHead !== head.oid) this.#invalidateReview(state);
      if (state.observation === "pending") await this.#endObservation(state);
    }
    return verified;
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
  const refs: Manifest = dictionary(Object.entries(state.base.files));
  for (const [path, entry] of Object.entries(state.carry)) {
    if (entry) refs[path] = entry;
    else delete refs[path];
  }
  return refs;
}

function choices(state: StoredState): Record<string, Choice> {
  const result: Record<string, Choice> = dictionary();
  for (const [id, decision] of Object.entries(state.decisions)) {
    if (decision.kind !== "edit") result[id] = decision;
    else result[id] = { kind: "edit", entry: { ...decision.entry, data: state.blobs[decision.entry.oid]! } };
  }
  return result;
}

function materialize(state: StoredState, files: Manifest): Snapshot {
  const snapshot: Snapshot = dictionary();
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
