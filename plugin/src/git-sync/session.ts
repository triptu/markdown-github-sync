import { formatCommitMessage, defaultCommitMessageTemplate, defaultCommitDateFormat } from "../commit-message";
// SyncSession: the single owner of synchronization state for one vault.
// Durable transactions run one at a time. Publication follows the
// per-installation ledger protocol; local mutation is compare-and-swap against
// exact captured versions, so vault events only schedule work.
import type { CommitSnapshot, DurableStore, Entry, FileMode, LocalVault, NativeIssue, PendingIntent, Repository, RepositoryIdentity, Snapshot, UnreadableFile } from "./contracts";
import {
  IntegrityError,
  decodeBase64,
  dictionary,
  own,
  digestText,
  entryFromBytes,
  isOid,
  isSyncablePath,
  isValidPath,
  entryText,
  sameEntry,
  sameManifest,
  toManifest,
  toRef,
  verifyEntry,
  verifySnapshot,
} from "./codec";
import type { Manifest, Ref } from "./codec";
import { nativeChoices, reconcile } from "./reconcile";
import type { Choice, Conflict, NativeHold } from "./reconcile";
import { CorruptStateError, STATE_FORMAT, parseState, referencedBlobs } from "./state";
import { compileScope, freezeTransactionScope, ScopeError } from "./scope";
import type { Scope, ScopeRules, TransactionScope } from "./scope";
import type {
  ApplyOperation,
  LedgerPublication,
  NativeError,
  OversizeEvidence,
  Pause,
  PauseReason,
  PublishOperation,
  RecoveryReason,
  RecoveryRecord,
  RestoreOperation,
  ConfigurationOperation,
  ConfigurationGuard,
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
  commitMessage?: (count: number, date: Date) => string;
  now?: () => Date;
  /** Backoff between cancelled publication rounds; injectable for tests. */
  delay?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Config sync is opt-in. Existing /3 enrollments remain visible-only until reviewed re-enrollment. */
  scopeRules?: ScopeRules["rules"];
  /** Stable for an Obsidian App lifetime, including plugin reloads; changes on full host restart. */
  hostLifetimeId?: string;
}

/** Unpinned recovery records (bytes known to be in GitHub history) kept for convenience. */
const RETAINED_RECOVERY = 20;

type Unavailable = { kind: "unenrolled" } | { kind: "corrupt"; detail: string };

/** A scanner omission is not evidence that a file is absent. */
type LocalObservation = { kind: "unknown" } | { kind: "known"; entry: Entry | null };

export type BlockedStep = { path: string; reason: string };

export type SyncOutcome =
  | Unavailable
  | { kind: "paused"; pause: Pause }
  | { kind: "up-to-date"; commit: string; attention?: OutstandingWork }
  /** The checkpoint advanced to `commit`; `carried` lists newer local edits kept as drafts. */
  | { kind: "synced"; commit: string; published: boolean; carried: string[]; attention?: OutstandingWork }
  /** `published`/`carried` report what this same sync accomplished before stopping for decisions. */
  | { kind: "needs-decision"; conflicts: Conflict[]; merged: string[]; published: boolean; carried: string[] }
  /** Commit `commit` is partly applied; the listed paths need `keepLocal` or a manual change. */
  | { kind: "blocked"; commit: string; steps: BlockedStep[] }
  /** Cancelled publications lost to other devices in every round of this sync; the scheduler retries. */
  | { kind: "contended" }
  /**
   * A dispatched publication awaits a decisive ledger read; the next sync
   * resumes it read-only first. `stale-ledger`: every read in this sync
   * returned an older value than this device settled, which only a stale
   * replica (or an out-of-contract rewind) explains; nothing is sent meanwhile.
   */
  | { kind: "settling"; operationId: string; reason: "unreachable" | "stale-ledger" }
  /**
   * A /2 publication sent without a ledger, held until reachable or reviewed.
   * `fenced`: the branch has left the legacy parent (through this device's
   * ledger fence or other commits), so the old request can no longer land and
   * publication recovery is available.
   */
  | { kind: "publication-unknown"; operationId: string; parent: string; candidate: string; head: string; fenced: boolean }
  /** Native recovery evidence of unknown scope could not be verified; nothing was planned. */
  | { kind: "native-error"; errors: NativeError[] };

/** Successful content progress can coexist with work deliberately held aside. */
export interface OutstandingWork {
  unreadable: string[];
  held: string[];
  deferred: number;
}

export type EnrollmentAction =
  /** A native transaction is unfinished here; enrolling cancels it without installing its intent (recoverable). */
  | "native-pending"
  /** The local file cannot be read (over 8 MiB); it is left untouched and compared once readable. */
  | "unreadable"
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

export type ChoiceInput =
  | { kind: "mine" }
  | { kind: "remote" }
  | { kind: "both" }
  | { kind: "edit"; data: string }
  /** Native holds only: pick the transaction's preimage, intent or the unexpected bytes. */
  | { kind: "expected" }
  | { kind: "next" }
  | { kind: "found" };
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

export interface ConfigurationListing {
  kind: "configuration";
  rules: ScopeRules["rules"];
  deferred: Array<{ path: string; expected: Ref | null; next: Ref | null; blockedReason: string | null }>;
  unpublished: Array<{ path: string; version: Ref }>;
  guarded: Array<{ path: string; applied: Ref | null; local: Ref | null; unreadable: boolean }>;
}
export type ConfigurationPreview =
  | Unavailable | { kind: "paused"; pause: Pause } | { kind: "busy" } | { kind: "disabled" }
  | { kind: "preview"; token: string; items: Array<ConfigurationListing["deferred"][number] & { expectedEntry: Entry | null; incomingEntry: Entry | null }>; blocked: BlockedStep[] };
export type ConfigurationOutcome = ConfigurationPreview | { kind: "stale" } | { kind: "applied"; paths: string[] } | { kind: "review-needed"; applied: string[]; changed: string[] } | { kind: "blocked"; steps: BlockedStep[] } | { kind: "native-error"; errors: NativeError[] };
export type HiddenPublicationPreview = Unavailable | { kind: "disabled" } | { kind: "missing" } | { kind: "tracked" } | { kind: "invalid-path" } | { kind: "preview"; token: string; path: string; version: Ref; entry: Entry };
export type GuardedConfigurationPreview = Unavailable | { kind: "disabled" } | { kind: "paused"; pause: Pause } | { kind: "busy" } | { kind: "missing" } | { kind: "unreadable" } | { kind: "preview"; token: string; path: string; head: string; scopeDigest: string; applied: Ref | null; version: Ref | null; entry: Entry | null };

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
export type PublicationRecoveryRefusal =
  | Unavailable
  | { kind: "missing" }
  | { kind: "reachable"; candidate: string }
  | { kind: "paused"; pause: Pause }
  /** The ledger protocol settles this publication automatically; no review applies. */
  | { kind: "settling" }
  /** A /2 publication whose branch still sits at its parent: sync first, which fences it. */
  | { kind: "unfenced" };
export type PublicationRecoveryOutcome = PublicationRecoveryRefusal | { kind: "stale" } | { kind: "released"; pause: Pause };

export type Phase = "idle" | "local-changes" | "needs-decision" | "publication-unknown" | "settling" | "applying" | "blocked" | "paused" | "native-error";

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
      /** Unverifiable native issues; a null path blocks synchronization, a path is held untouched. */
      nativeErrors: NativeError[];
      /** Present only from `inspect()`: visible files left untouched because they cannot be read. */
      unreadable: UnreadableFile[] | null;
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
type Settlement = { kind: "accepted"; operation: ApplyOperation } | { kind: "cancelled" } | { kind: "held"; outcome: SyncOutcome };
/** The ledger's verdict on one publication. */
type Verdict = { kind: "receipt" } | { kind: "seal"; seal: string } | { kind: "held"; outcome: SyncOutcome } | { kind: "diverged"; value: string | null };
type Cancelled = { kind: "cancelled" };

/** Ledger reads per settlement call before returning `settling`. */
const SETTLE_ROUNDS = 4;
/**
 * Extra reads, with jittered backoff, of a ledger value older than the anchor
 * before this sync gives up. No count makes a stale read definitive: the
 * operation stays settling and the next sync reads again.
 */
const STALE_REREADS = 3;
/** Cancelled publications reconciled again within one `sync()`. */
const RECONCILE_ROUNDS = 3;
const LEDGER_PAUSES: ReadonlySet<PauseReason> = new Set(["ledger-diverged", "duplicate-installation"]);

/** The vault adapter returned a capture that cannot be a real vault state (for example unmounted storage). */
export class VaultCaptureError extends Error {
  override name = "VaultCaptureError";
}

export class SyncSession {
  readonly #repository: Repository;
  readonly #vault: LocalVault;
  readonly #store: DurableStore;
  readonly #deviceName: string;
  readonly #commitMessage: (count: number, date: Date) => string;
  readonly #now: () => Date;
  readonly #delay: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #requestedRules: ScopeRules["rules"];
  readonly #hostLifetimeId: string | null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #previewSession = crypto.randomUUID();
  #holdPass = false;
  /** Visible files the latest capture could not read; they are untouched until readable. */
  #unreadable: UnreadableFile[] = [];
  #guarded: string[] = [];

  constructor(ports: SessionPorts) {
    this.#repository = ports.repository;
    this.#vault = ports.vault;
    this.#store = ports.store;
    this.#deviceName = ports.deviceName ?? "Obsidian";
    this.#commitMessage = ports.commitMessage ?? ((count, date) => formatCommitMessage(
      defaultCommitMessageTemplate, defaultCommitDateFormat, { device: this.#deviceName, count, date },
    ));
    this.#now = ports.now ?? (() => new Date());
    this.#delay = ports.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = ports.random ?? Math.random;
    this.#requestedRules = ports.scopeRules ?? "visible-only";
    this.#hostLifetimeId = ports.hostLifetimeId ?? null;
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

  /** Read-only inventory of consent-needed additions and pending live configuration. */
  listConfiguration(): Promise<ConfigurationListing | Unavailable> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const state = loaded.state;
      const unpublished: ConfigurationListing["unpublished"] = [];
      const guarded: ConfigurationListing["guarded"] = [];
      if (state.scope.rules === "config/1") {
        const head = await this.#readHead("config/1");
        const scope = await this.#scopeFor(head.oid, "config/1");
        const local = await this.#capture(state, "configuration inventory", false, scope);
        for (const [path, entry] of Object.entries(local)) {
          if (scope.classify(path) !== "config-inert" && scope.classify(path) !== "config-live") continue;
          if (path === ".gitignore" || head.files[path] || state.base.files[path]) continue;
          if (!sameEntry(state.hiddenConsent[path], entry)) unpublished.push({ path, version: toRef(entry) });
        }
        for (const [path, guard] of Object.entries(state.configurationGuards)) {
          if (!scope.includes(path)) continue;
          const unreadable = this.#unreadable.some((item) => item.path === path) || this.#quarantined(state).has(path);
          const entry = local[path] ?? null;
          if (unreadable || !sameEntry(entry, guard.applied) || needsConfigurationReconsent(guard, entry, head.oid, scope.digest)) {
            guarded.push({ path, applied: guard.applied, local: entry && toRef(entry), unreadable });
          }
        }
      }
      return { kind: "configuration", rules: state.scope.rules,
        deferred: Object.entries(state.deferred).map(([path, item]) => ({ path, expected: item.expected, next: item.next, blockedReason: item.blockedReason })),
        unpublished: unpublished.sort((a, b) => a.path.localeCompare(b.path)),
        guarded: guarded.sort((a, b) => a.path.localeCompare(b.path)) };
    });
  }

  previewConfigurationScope(): Promise<Unavailable | { kind: "already-enabled" } | { kind: "busy" } | { kind: "paused"; pause: Pause } | { kind: "preview"; token: string; note: string }> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const state = loaded.state;
      if (state.scope.rules === "config/1") return { kind: "already-enabled" };
      if (state.pause) return { kind: "paused", pause: state.pause };
      if (state.operation || state.review || Object.keys(state.holds).length || state.nativeErrors.length) return { kind: "busy" };
      const head = await this.#readHead("config/1");
      const scope = await this.#scopeFor(head.oid, "config/1");
      const token = await digestText(JSON.stringify(["scope-enable/1", this.#previewSession, state.base.commit, head.oid, scope.digest]));
      return { kind: "preview", token, note: "Fresh enrollment review is required before configuration scope becomes active" };
    });
  }

  enableConfigurationScope(input: { token: string }): Promise<Unavailable | { kind: "stale" } | { kind: "busy" } | { kind: "paused"; pause: Pause } | { kind: "already-enabled" } | { kind: "reenroll" }> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const state = loaded.state;
      if (state.scope.rules === "config/1") return { kind: "already-enabled" };
      if (state.pause) return { kind: "paused", pause: state.pause };
      if (state.operation || state.review || Object.keys(state.holds).length || state.nativeErrors.length) return { kind: "busy" };
      const head = await this.#readHead("config/1");
      const scope = await this.#scopeFor(head.oid, "config/1");
      const token = await digestText(JSON.stringify(["scope-enable/1", this.#previewSession, state.base.commit, head.oid, scope.digest]));
      if (token !== input.token) return { kind: "stale" };
      state.pause = { reason: "scope-enrollment", detail: "Review fresh enrollment before configuration sync starts" };
      await this.#save(state);
      return { kind: "reenroll" };
    });
  }

  previewHiddenPublication(path: string): Promise<HiddenPublicationPreview> {
    return this.#exclusive(async () => this.#hiddenPublicationPreview(path));
  }

  previewGuardedConfigurationPublication(path: string): Promise<GuardedConfigurationPreview> {
    return this.#exclusive(async () => this.#guardedConfigurationPreview(path));
  }

  consentGuardedConfigurationPublication(input: { path: string; token: string }): Promise<GuardedConfigurationPreview | { kind: "recorded" } | { kind: "stale" }> {
    return this.#exclusive(async () => {
      const preview = await this.#guardedConfigurationPreview(input.path);
      if (preview.kind !== "preview") return preview;
      if (preview.token !== input.token) return { kind: "stale" };
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const guard = loaded.state.configurationGuards[input.path];
      if (!guard) return { kind: "missing" };
      if (preview.entry) this.#record(loaded.state, "sync", dictionary([[input.path, preview.entry]]));
      guard.consent = { version: preview.version, head: preview.head, scope: preview.scopeDigest };
      await this.#save(loaded.state);
      return { kind: "recorded" };
    });
  }

  async #guardedConfigurationPreview(path: string): Promise<GuardedConfigurationPreview> {
    const loaded = await this.#load();
    if (loaded.kind !== "enrolled") return loaded;
    const state = loaded.state;
    if (state.scope.rules !== "config/1") return { kind: "disabled" };
    if (state.pause) return { kind: "paused", pause: state.pause };
    if (state.operation) return { kind: "busy" };
    const guard = state.configurationGuards[path];
    if (!guard) return { kind: "missing" };
    const head = await this.#readHead("config/1");
    const scope = await this.#scopeFor(head.oid, "config/1");
    if (!scope.includes(path)) return { kind: "missing" };
    const local = await this.#capture(state, "guarded configuration preview", false, scope);
    if (this.#unreadable.some((item) => item.path === path) || this.#quarantined(state).has(path)) return { kind: "unreadable" };
    const entry = local[path] ?? null;
    if (sameEntry(entry, guard.applied) && !needsConfigurationReconsent(guard, entry, head.oid, scope.digest)) return { kind: "missing" };
    const version = entry && toRef(entry);
    const token = await digestText(JSON.stringify(["configuration-publication/1", this.#previewSession, state.base.commit, head.oid, scope.digest, path, guard, version]));
    return { kind: "preview", token, path, head: head.oid, scopeDigest: scope.digest, applied: guard.applied, version, entry };
  }

  consentHiddenPublication(input: { path: string; token: string }): Promise<HiddenPublicationPreview | { kind: "recorded" } | { kind: "stale" }> {
    return this.#exclusive(async () => {
      const preview = await this.#hiddenPublicationPreview(input.path);
      if (preview.kind !== "preview") return preview;
      if (preview.token !== input.token) return { kind: "stale" };
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      loaded.state.hiddenConsent[input.path] = preview.version;
      await this.#save(loaded.state);
      return { kind: "recorded" };
    });
  }

  async #hiddenPublicationPreview(path: string): Promise<HiddenPublicationPreview> {
    const loaded = await this.#load();
    if (loaded.kind !== "enrolled") return loaded;
    const state = loaded.state;
    if (state.scope.rules !== "config/1") return { kind: "disabled" };
    if (!isValidPath(path)) return { kind: "invalid-path" };
    const head = await this.#readHead("config/1");
    const scope = await this.#scopeFor(head.oid, "config/1");
    if (!scope.includes(path) || scope.classify(path) === "content" || path === ".gitignore") return { kind: "invalid-path" };
    if (head.files[path] || state.base.files[path]) return { kind: "tracked" };
    const local = await this.#capture(state, "hidden publication preview", false, scope);
    const entry = local[path];
    if (!entry || this.#unreadable.some((item) => item.path === path)) return { kind: "missing" };
    const version = toRef(entry);
    const token = await digestText(JSON.stringify(["hidden-consent/1", this.#previewSession, state.base.commit, head.oid, scope.digest, path, version]));
    return { kind: "preview", token, path, version, entry };
  }

  previewApplyConfiguration(): Promise<ConfigurationPreview> {
    return this.#exclusive(async () => this.#configurationPreview());
  }

  async #configurationPreview(currentState?: StoredState): Promise<ConfigurationPreview> {
    let state = currentState;
    if (!state) {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      state = loaded.state;
    }
    if (state.scope.rules !== "config/1") return { kind: "disabled" };
    if (state.pause) return { kind: "paused", pause: state.pause };
    if (state.operation) return { kind: "busy" };
    const head = await this.#readHead("config/1");
    const scope = await this.#scopeFor(head.oid, "config/1");
    const local = await this.#capture(state, "configuration preview", false, scope);
    const items = Object.entries(state.deferred).sort(([a], [b]) => a.localeCompare(b)).map(([path, item]) => ({
      path, expected: item.expected, next: item.next, blockedReason: item.blockedReason,
      expectedEntry: item.expected ? materialize(state, dictionary([[path, item.expected]]))[path]! : null,
      incomingEntry: item.next ? materialize(state, dictionary([[path, item.next]]))[path]! : null,
    }));
    const blocked: BlockedStep[] = [];
    for (const item of items) {
      if (item.blockedReason) blocked.push({ path: item.path, reason: item.blockedReason });
      else if (item.path.endsWith("/community-plugins.json") && local[item.path] && enabledCompetingReason(local[item.path]!)) blocked.push({ path: item.path, reason: enabledCompetingReason(local[item.path]!)! });
      else if (this.#quarantined(state).has(item.path)) blocked.push({ path: item.path, reason: "Native recovery for this configuration needs review" });
      else if (!sameEntry(local[item.path], item.expected)) blocked.push({ path: item.path, reason: "Local configuration changed since it was deferred; sync to review the conflict" });
      else if (this.#unreadable.some((entry) => entry.path === item.path)) blocked.push({ path: item.path, reason: "Local configuration cannot be read" });
    }
    const token = await digestText(JSON.stringify(["apply-config/1", this.#previewSession, state.base.commit, head.oid, scope.digest, items, sortedManifest(local)]));
    return { kind: "preview", token, items, blocked };
  }

  applyConfiguration(input: { token: string }): Promise<ConfigurationOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const initial = loaded.state;
      if (initial.scope.rules !== "config/1") return { kind: "disabled" };
      if (initial.pause) return { kind: "paused", pause: initial.pause };
      if (initial.operation) return { kind: "busy" };
      const identity = await this.#repository.identity();
      if (!sameIdentity(identity, initial.repository)) {
        const result = await this.#pause(initial, "repository-changed", `Expected ${describe(initial.repository)}, found ${describe(identity)}`);
        if (result.kind !== "paused") throw new IntegrityError("Repository identity fence returned an unexpected outcome");
        return result;
      }
      const bound = await this.#bindLedger(initial);
      if (bound) {
        if (bound.kind !== "paused") throw new IntegrityError("Ledger binding returned an unexpected outcome");
        return bound;
      }
      const native = await this.#recoverNative(initial);
      if (native) {
        if (native.kind !== "native-error") throw new IntegrityError("Native recovery returned an unexpected outcome");
        return native;
      }
      const preview = await this.#configurationPreview(initial);
      if (preview.kind !== "preview") return preview;
      if (preview.token !== input.token) return { kind: "stale" };
      if (preview.blocked.length) return { kind: "blocked", steps: preview.blocked };
      if (preview.items.length === 0) return { kind: "applied", paths: [] };
      const state = initial;
      const expected: Snapshot = dictionary();
      const incoming: Snapshot = dictionary();
      const steps: StoredStep[] = preview.items.map((item) => {
        if (item.expected) expected[item.path] = materialize(state, dictionary([[item.path, item.expected]]))[item.path]!;
        if (item.next) incoming[item.path] = materialize(state, dictionary([[item.path, item.next]]))[item.path]!;
        return { path: item.path, expected: item.expected, next: item.next, status: "pending", decision: null, reason: null };
      });
      const operation: ConfigurationOperation = { kind: "configuration", id: this.#nextId(state, "configuration"), baseCommit: state.base.commit,
        steps, recoveryId: this.#record(state, "sync", expected), incomingRecoveryId: this.#record(state, "incoming", incoming), hostLifetimeId: this.#hostLifetimeId };
      state.operation = operation;
      await this.#save(state); // Approval and exact steps precede every native write.
      return this.#applyConfigurationSteps(state, operation);
    });
  }

  /**
   * Compatibility hook for vault events. Events only schedule synchronization:
   * consent is bound to exact versions and checked by compare-and-swap, so an
   * event (including the echo of this engine's own writes) changes no state.
   */
  notifyLocalChange(): Promise<Unavailable | { kind: "invalidated" }> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      return loaded.kind === "enrolled" ? { kind: "invalidated" } : loaded;
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

  /**
   * Binds this vault to the repository head shown in the confirmed preview and
   * anchors the device ledger at its current value. The confirmation also
   * authorizes cancelling unfinished native intents (never installing them);
   * when any existed, the vault may have changed, so a fresh preview returns.
   */
  enroll(input: { token: string }): Promise<EnrollOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind === "corrupt") return loaded;
      const prior = loaded.kind === "enrolled" ? loaded.state : null;
      if (prior && (!prior.pause || prior.operation)) return { kind: "already-enrolled" };
      const survey = await this.#survey(prior);
      if (survey.preview.token !== input.token) return { kind: "stale", preview: survey.preview };
      // Evidence is ingested into the new state below; until then it stays unacknowledged in the vault.
      const issues = this.#vault.recover ? await this.#vault.recover({ replay: [], cancel: survey.pending.map((intent) => intent.id) }) : [];
      if (survey.pending.length > 0) return { kind: "stale", preview: (await this.#survey(prior)).preview };
      // Adopting the observed value is safe: an older request of this device can
      // only land while the ledger still equals its own anchor, and any landing
      // after this point makes the next settlement fail closed as divergence.
      const anchor = await this.#readLedgerValue();
      const state: StoredState = {
        format: STATE_FORMAT,
        repository: survey.preview.repository,
        ledger: { ref: this.#repository.ledgerRef(), anchor },
        base: commitState(survey.head),
        scope: { ...survey.scope.rules, digest: survey.scope.digest },
        deferred: dictionary(Object.entries(prior?.deferred ?? {})),
        hiddenConsent: dictionary(),
        configurationGuards: dictionary(Object.entries(prior?.configurationGuards ?? {})),
        reentry: [],
        carry: survey.carry,
        operation: null,
        pause: null,
        review: null,
        decisions: dictionary(),
        // Native evidence outlives re-enrollment: it may be the only copy of an edit.
        holds: dictionary(Object.entries(prior?.holds ?? {})),
        unacknowledged: prior?.unacknowledged ?? [],
        nativeErrors: [],
        recovery: prior?.recovery ?? [],
        blobs: dictionary(Object.entries(prior?.blobs ?? {})),
        counter: prior?.counter ?? 0,
      };
      // Every carried version is a local draft, so the record also pins its bytes.
      this.#record(state, "enrollment", survey.drafts);
      await this.#save(state);
      await this.#ingest(state, issues, { replaceErrors: true, known: [survey.head.files, survey.local] });
      return { kind: "enrolled", commit: survey.head.oid };
    });
  }

  sync(): Promise<SyncOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      // Every fence precedes native recovery: nothing native is replayed,
      // cancelled or persisted for a vault that is paused, bound to another
      // repository or sharing its installation.
      const identity = await this.#repository.identity();
      const sameRepository = sameIdentity(identity, state.repository);
      let published = false;
      if (state.pause) {
        if (sameRepository && state.pause.reason === "ledger-diverged" && state.operation?.kind === "publish" && state.operation.publication.phase !== "legacy") {
          // Read-only: a fresh receipt or seal settles the publication; nothing is sent.
          const rechecked = await this.#recheckDiverged(state, state.operation);
          if (rechecked) return rechecked;
          published = (state.operation as StoredState["operation"])?.kind === "apply";
        } else if (state.pause.reason !== "repository-changed" || !state.operation || !sameRepository) {
          // Finishing an accepted commit locally needs no remote write, so a ledger hold allows it.
          if (sameRepository && LEDGER_PAUSES.has(state.pause.reason) && state.operation?.kind === "apply") {
            const pause = state.pause;
            const native = await this.#recoverNative(state);
            if (native) return native;
            const applied = await this.#resumeApply(state, state.operation);
            if (applied.kind === "blocked") return applied.outcome;
            return { kind: "paused", pause };
          }
          return { kind: "paused", pause: state.pause };
        } else {
          state.pause = null;
          await this.#save(state);
        }
      }
      if (!sameRepository) {
        return this.#pause(state, "repository-changed", `Expected ${describe(state.repository)}, found ${describe(identity)}`);
      }
      const bound = await this.#bindLedger(state);
      if (bound) return bound;
      const native = await this.#recoverNative(state);
      if (native) return native;
      let cancellations = 0;
      const carried = new Set<string>();
      const report = () => ({ published, carried: [...carried].sort() });
      for (;;) {
        let cancelled = false;
        if (state.operation) {
          const resumed = await this.#resume(state);
          if (resumed.kind === "held") return resumed.outcome;
          if (resumed.kind === "cancelled") cancelled = true;
          else {
            published ||= resumed.published;
            resumed.carried.forEach((path) => carried.add(path));
          }
        }
        const outcome: SyncOutcome | Cancelled = cancelled ? { kind: "cancelled" } : await this.#transact(state);
        if (outcome.kind === "cancelled") {
          // Another publication won the branch. Our seal is final, so reconcile
          // against the winner, with a short jittered pause between rounds.
          if (++cancellations >= RECONCILE_ROUNDS) return { kind: "contended" };
          await this.#delay(1000 + Math.floor(this.#random() * 3000));
          continue;
        }
        if (outcome.kind === "synced" || outcome.kind === "needs-decision") {
          published ||= outcome.published;
          outcome.carried.forEach((path) => carried.add(path));
          return this.#withAttention(state, { ...outcome, ...report() });
        }
        if (outcome.kind === "up-to-date" && (published || carried.size > 0)) {
          return this.#withAttention(state, { kind: "synced", commit: outcome.commit, ...report() });
        }
        return this.#withAttention(state, outcome);
      }
    });
  }

  #withAttention(state: StoredState, outcome: SyncOutcome): SyncOutcome {
    if (outcome.kind !== "up-to-date" && outcome.kind !== "synced") return outcome;
    const attention: OutstandingWork = {
      unreadable: [...new Set(this.#unreadable.map((item) => item.path))].sort(),
      held: [...new Set([...Object.keys(state.holds), ...this.#guarded, ...state.nativeErrors.flatMap((item) => item.path === null ? [] : [item.path])])].sort(),
      deferred: Object.keys(state.deferred).length,
    };
    return attention.unreadable.length || attention.held.length || attention.deferred ? { ...outcome, attention } : outcome;
  }

  /** Records a decision for a conflict from the latest review. Applied by a later `sync` only while its exact versions persist. */
  resolve(input: { conflictId: string; choice: ChoiceInput }): Promise<DecisionOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      const conflict = state.review?.conflicts.find((item) => item.id === input.conflictId);
      if (!conflict) return { kind: "stale" };
      if (conflict.kind === "collision") return { kind: "invalid", reason: "Rename one of the colliding files, then sync again" };
      if (conflict.kind === "bulk-deletion") {
        if (input.choice.kind !== "mine" && input.choice.kind !== "remote") return { kind: "invalid", reason: "Choose to keep this device's or GitHub's side of the deletion" };
        state.decisions[conflict.id] = { kind: input.choice.kind };
        await this.#save(state);
        return { kind: "recorded" };
      }
      const available = isNativeConflict(conflict) ? nativeChoices(conflict) : conflict.choices;
      if (!available.includes(input.choice.kind)) {
        return { kind: "invalid", reason: `${input.choice.kind} is not available for ${conflict.kind}` };
      }
      if (input.choice.kind === "edit") {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(input.choice.data);
        } catch {
          return { kind: "invalid", reason: "Edited content is not valid base64" };
        }
        const mode: FileMode = conflict.local?.mode ?? conflict.remote?.mode ?? ("next" in conflict ? conflict.next?.mode ?? conflict.expected?.mode : undefined) ?? "100644";
        const entry = await entryFromBytes(bytes, mode);
        this.#record(state, "conflict-edit", dictionary([[conflict.path, entry]]));
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
      if (!sameIdentity(await this.#repository.identity(), state.repository)) {
        return { kind: "paused", pause: { reason: "repository-changed", detail: "Restore the enrolled repository identity before restoring history" } };
      }
      const bound = await this.#bindLedger(state);
      if (bound) {
        if (bound.kind !== "paused") throw new IntegrityError("Ledger binding returned an unexpected outcome");
        return bound;
      }
      // No operation is in flight, so every pending native intent is cancelled.
      const native = await this.#recoverNative(state);
      if (native) return { kind: "blocked", reason: "Native recovery evidence could not be verified; open Changes" };
      if (state.holds[input.path] || this.#quarantined(state).has(input.path)) return { kind: "stale", preview: null };
      const preview = await this.#restorePreview(state, input);
      if (preview.kind !== "preview") return preview;
      if (preview.token !== input.token) return { kind: "stale", preview };
      if (sameEntry(preview.current, preview.historical)) return { kind: "unchanged" };
      const recoveryId = this.#record(state, "restore", preview.current ? dictionary([[preview.path, preview.current]]) : dictionary());
      const incomingRecoveryId = this.#record(state, "restore", dictionary([[preview.path, preview.historical]]));
      if (!incomingRecoveryId) throw new IntegrityError("Historical restore has no incoming recovery record");
      const operation: RestoreOperation = {
        kind: "restore",
        id: this.#nextId(state, "restore"),
        sourceCommit: preview.commit,
        baseCommit: state.base.commit,
        step: { path: preview.path, expected: preview.current ? toRef(preview.current) : null, next: toRef(preview.historical), status: "pending", decision: null, reason: null },
        recoveryId,
        incomingRecoveryId,
      };
      state.operation = operation;
      // A live configuration restore can race an editor that still holds the
      // pre-restore bytes, even when no reviewed apply left an earlier guard.
      // Save the guard with the operation so a lost write response is covered.
      await this.#ensureRestoreGuard(state, operation.step);
      await this.#save(state);
      // The write is a compare-and-swap against the previewed bytes.
      const result = await this.#vault.apply(preview.path, preview.current, preview.historical);
      if (result.kind === "applied") {
        const guard = state.configurationGuards[preview.path];
        if (guard) {
          guard.hostLifetimeId = this.#hostLifetimeId;
          guard.applied = toRef(preview.historical);
          guard.consent = { version: toRef(preview.historical), head: state.base.commit, scope: state.scope.digest };
        }
        state.operation = null;
        await this.#save(state);
        return { kind: "restored" };
      }
      if (result.kind === "blocked") {
        markStep(operation.step, "blocked", result.reason || "Blocked by the vault adapter");
        await this.#save(state);
        return { kind: "blocked", reason: result.reason };
      }
      if (result.kind === "interrupted" || result.kind === "displaced") await this.#ingest(state, [result.issue], { requiredPath: preview.path });
      state.operation = null;
      await this.#save(state);
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
      if (state.operation && (state.operation.recoveryId === input.id || state.operation.incomingRecoveryId === input.id)) return { kind: "in-use" };
      const before = state.recovery.length;
      state.recovery = state.recovery.filter((record) => record.id !== input.id);
      if (state.recovery.length === before) return { kind: "missing" };
      await this.#save(state);
      return { kind: "discarded" };
    });
  }

  /**
   * Review abandonment of a held candidate: a legacy /2 publication sent
   * without a ledger (only after the branch left its parent, see
   * `#settleLegacy`), or a publication held by ledger divergence. This never
   * asserts nonpublication.
   */
  previewPublicationRecovery(): Promise<PublicationRecoveryPreview | PublicationRecoveryRefusal> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      return this.#publicationRecoveryPreview(loaded.state);
    });
  }

  /**
   * Archive the reviewed candidate and live drafts, then require re-enrollment.
   * `discard` (default) makes the captured local versions the origins, so
   * re-enrollment adopts GitHub's head; `republish` keeps the old checkpoint,
   * so re-enrollment offers the local drafts as uploads. No publication or
   * vault writes happen here.
   */
  recoverPublication(input: { token: string; choice?: "discard" | "republish" }): Promise<PublicationRecoveryOutcome> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (loaded.kind !== "enrolled") return loaded;
      const { state } = loaded;
      const preview = await this.#publicationRecoveryPreview(state);
      if (preview.kind !== "preview") return preview;
      if (preview.token !== input.token) return { kind: "stale" };
      const operation = state.operation;
      const legacy = operation?.kind === "publish" && operation.publication.phase === "legacy";
      this.#record(state, "publication-recovery", preview.candidateFiles);
      this.#record(state, "publication-recovery", preview.localFiles);
      if (input.choice !== "republish") {
        state.carry = dictionary();
        for (const path of new Set([...Object.keys(state.base.files), ...Object.keys(preview.localFiles), ...Object.keys(preview.headFiles)])) {
          const entry = preview.localFiles[path];
          state.carry[path] = entry ? toRef(entry) : null;
        }
      }
      state.operation = null;
      state.review = null;
      state.decisions = dictionary();
      const sent = legacy
        ? `Its request was sent without a ledger; the branch has left its parent ${operation.parent}, so that request can no longer land`
        : "Re-enrollment anchors this device to the ledger value it then observes";
      state.pause = { reason: "history-rewritten", detail: `Archived unresolved candidate ${preview.candidate} after review. ${sent}. Re-enroll against the current head` };
      await this.#save(state);
      return { kind: "released", pause: state.pause };
    });
  }

  async #publicationRecoveryPreview(state: StoredState): Promise<PublicationRecoveryPreview | PublicationRecoveryRefusal> {
    const operation = state.operation;
    if (operation?.kind !== "publish") return { kind: "missing" };
    const legacy = operation.publication.phase === "legacy";
    if (!legacy && !(state.pause && LEDGER_PAUSES.has(state.pause.reason))) return { kind: "settling" };
    const identity = await this.#repository.identity();
    if (!sameIdentity(identity, state.repository)) {
      return { kind: "paused", pause: { reason: "repository-changed", detail: "Restore the enrolled repository identity before reviewing publication recovery" } };
    }
    const head = await this.#readHead(state.scope.rules);
    if (legacy && (head.oid === operation.candidate.commit || await this.#repository.isAncestor(operation.candidate.commit, head.oid))) {
      return { kind: "reachable", candidate: operation.candidate.commit };
    }
    // Releasing before the branch leaves the parent would let the old request land later as remote content.
    if (legacy && (head.oid === operation.parent || operation.fence)) return { kind: "unfenced" };
    const candidate = await this.#repository.readCommit(operation.candidate.commit);
    const candidateScope = await this.#scopeFor(candidate.oid, state.scope.rules);
    const candidateFiles = await verifySnapshot(filterSnapshot(candidate.files, candidateScope), "recovery candidate", candidateScope);
    if (candidate.oid !== operation.candidate.commit || candidate.treeOid !== operation.candidate.tree || !sameManifest(candidateFiles, operation.target)) {
      throw new IntegrityError("Recovery candidate differs from the durable operation");
    }
    const localFiles = await this.#capture(state, "recovery local capture");
    const token = await digestText(JSON.stringify(["publication-recovery/3", this.#previewSession, identity, operation, head.oid, sortedManifest(localFiles)]));
    return { kind: "preview", token, operationId: operation.id, parent: operation.parent, candidate: candidate.oid, head: head.oid, candidateFiles, headFiles: head.files, localFiles };
  }

  // ---- Synchronization ---------------------------------------------------

  async #transact(state: StoredState): Promise<SyncOutcome | Cancelled> {
    this.#guarded = [];
    let head: CommitSnapshot;
    try { head = await this.#readHead(state.scope.rules); }
    catch (error) {
      if (error instanceof ScopeError) return this.#pause(state, "scope-unreadable", error.message);
      throw error;
    }
    if (head.oid !== state.base.commit && !(await this.#repository.isAncestor(state.base.commit, head.oid))) {
      // One confirmation (re-enrollment) for a genuine rewrite. Accepted work is never replayed.
      return this.#pause(state, "history-rewritten", `Checkpoint ${state.base.commit} is not an ancestor of head ${head.oid}`);
    }
    const hadReview = state.review !== null || Object.keys(state.decisions).length > 0;
    const local = await this.#capture(state, "local capture");
    this.#guardCapture(state, local);
    const hadPrototypeBaseline = Object.hasOwn(state.base.files, "__proto__");
    const base = await this.#effectiveBase(state, local, head);
    if (base.kind === "paused") return base.outcome;
    let headScope: Scope;
    let parentScope: Scope;
    try {
      headScope = await this.#scopeFor(head.oid, state.scope.rules);
      parentScope = await this.#scopeFor(state.base.commit, state.scope.rules);
    } catch (error) {
      if (error instanceof ScopeError) return this.#pause(state, "scope-unreadable", error.message);
      throw error;
    }
    let transaction: TransactionScope = parentScope;
    if (state.scope.rules === "config/1") {
      if (this.#unreadable.some((item) => item.path === ".gitignore")) return this.#pause(state, "scope-unreadable", "Local .gitignore cannot be read");
      const localIgnore = local[".gitignore"] ? entryText(local[".gitignore"]!) : null;
      if (local[".gitignore"] && localIgnore === null) return this.#pause(state, "scope-unreadable", "Local .gitignore is not valid UTF-8");
      try { transaction = await freezeTransactionScope(parentScope, headScope, localIgnore); }
      catch (error) {
        if (error instanceof ScopeError) return this.#pause(state, "scope-unreadable", error.message);
        throw error;
      }
    }
    const planBase = filterSnapshot(base.files, transaction);
    for (const path of state.reentry) delete planBase[path];
    const planLocal = filterSnapshot(local, transaction);
    const planRemote = filterSnapshot(head.files, transaction);
    const excluded = [...new Set([...Object.keys(base.files), ...Object.keys(local), ...Object.keys(head.files)])].filter((path) => !transaction.includes(path));
    if (parentScope.digest !== headScope.digest) {
      const newlyIncluded = [...new Set([...Object.keys(state.carry), ...Object.keys(head.files)])]
        .filter((path) => !parentScope.includes(path) && headScope.includes(path));
      state.reentry = [...new Set([...state.reentry, ...newlyIncluded])].sort();
    }
    const parked: Snapshot = dictionary(excluded.flatMap((path) => base.files[path] ? [[path, base.files[path]!]] as const : []));
    this.#record(state, "sync", parked);
    for (const path of excluded) {
      delete state.deferred[path];
      delete state.hiddenConsent[path];
    }
    for (const [path, deferred] of Object.entries(state.deferred)) {
      const next = head.files[path] ?? null;
      if (!sameEntry(next, deferred.next)) {
        if (next) this.#record(state, "incoming", dictionary([[path, next]]));
        deferred.next = next && toRef(next);
        deferred.commit = head.oid;
        deferred.blockedReason = configurationBlockReason(path, next);
      }
      const observed = this.#observeLocal(state, local, path);
      if (observed.kind === "unknown" || sameEntry(observed.entry, deferred.expected)) continue;
      // The deferred remote version never became the local merge base. Move
      // its original preimage into carry before ordinary conflict planning.
      const origin = deferred.expected ? materialize(state, dictionary([[path, deferred.expected]]))[path]! : null;
      state.carry[path] = deferred.expected;
      if (origin) planBase[path] = origin;
      else delete planBase[path];
      delete state.deferred[path];
    }
    let guardsChanged = false;
    for (const [path, guard] of Object.entries(state.configurationGuards)) {
      // Consent is consumed once its bytes are the checkpoint, even when no
      // commit was needed because the checkpoint already had those bytes.
      if (guard.consent && sameRef(state.base.files[path], guard.consent.version)) {
        guard.applied = guard.consent.version;
        guard.consent = null;
        guardsChanged = true;
      }
      if (!transaction.includes(path)) {
        if (guard.hostLifetimeId !== this.#hostLifetimeId) {
          guard.hostLifetimeId = this.#hostLifetimeId;
          guardsChanged = true;
        }
        continue;
      }
      const observed = this.#observeLocal(state, local, path);
      const authorized = observed.kind === "known" && guard.consent && sameRef(guard.consent.version, observed.entry) && guard.consent.head === head.oid && guard.consent.scope === headScope.digest;
      const needsReconsent = observed.kind === "known" && needsConfigurationReconsent(guard, observed.entry, head.oid, headScope.digest);
      // A new host proves nothing about what was flushed at shutdown. Compare
      // its first observed version before retiring the old host's guard.
      if (guard.hostLifetimeId !== this.#hostLifetimeId) {
        if (observed.kind === "known" && ((sameEntry(observed.entry, guard.applied) && !needsReconsent) || authorized)) {
          delete state.configurationGuards[path];
          guardsChanged = true;
          continue;
        }
        guard.hostLifetimeId = this.#hostLifetimeId;
        guardsChanged = true;
      }
      if (observed.kind === "unknown" || (sameEntry(observed.entry, guard.applied) && !needsReconsent)) continue;
      if (!authorized) this.#guarded.push(path);
    }
    // A deferred live path and every unconsented hidden addition are held out
    // of all automatic reconciliation, including remote deletion counting.
    const unconsented: string[] = [];
    for (const [path, entry] of Object.entries(planLocal)) {
      if (headScope.classify(path) === "content" || path === ".gitignore" || planRemote[path] || planBase[path]) continue;
      if (sameEntry(state.hiddenConsent[path], entry)) continue;
      unconsented.push(path);
      if (state.hiddenConsent[path]) delete state.hiddenConsent[path];
    }
    const guardScope = await digestText(JSON.stringify(["guard/1", head.oid, sortedManifest(local)]));
    const holds = nativeHolds(state);
    const untouched = [...new Set([...this.#untouched(state), ...excluded, ...Object.keys(state.deferred), ...unconsented, ...this.#guarded])];
    const unresolved = await reconcile({ base: planBase, local: planLocal, remote: planRemote, decisions: dictionary(), guardScope, holds, untouched });
    const conflicts = unresolved.kind === "needs-decision" ? unresolved.conflicts : unresolved.held;
    // Decisions survive only while their exact conflict (versions, or guard scope) still exists.
    const validIds = new Set(conflicts.map((item) => item.id));
    for (const id of Object.keys(state.decisions)) if (!validIds.has(id)) delete state.decisions[id];
    const plan = Object.keys(state.decisions).length > 0
      ? await reconcile({ base: planBase, local: planLocal, remote: planRemote, decisions: choices(state), guardScope, holds, untouched })
      : unresolved;
    const reviewed = [...conflicts];
    const later = plan.kind === "needs-decision" ? plan.conflicts : plan.held;
    for (const item of later) if (!validIds.has(item.id)) reviewed.push(item);
    // A decided hold whose chosen version is already live is released now; the
    // release is durable with the save that follows on every path below.
    let released = false;
    const decidedOversize: string[] = [];
    if (plan.kind === "ready") {
      for (const item of plan.resolved) {
        if (!isNativeConflict(item)) continue;
        // The decision is durable (resolve saved it), so the vault may now release its apply block.
        decidedOversize.push(...item.oversize.map((evidence) => evidence.id));
        if (item.oversize.length === 0 && sameEntry(local[item.path], plan.target[item.path])) {
          delete state.holds[item.path];
          released = true;
        }
      }
    }
    state.review = reviewed.length > 0 ? { head: head.oid, conflicts: reviewed.map((item) => this.#storeConflict(state, item)) } : null;

    if (plan.kind === "needs-decision") {
      await this.#save(state);
      return { kind: "needs-decision", conflicts: plan.conflicts, merged: plan.merged, published: false, carried: [] };
    }
    if (state.scope.rules === "config/1") {
      for (const step of [...plan.incoming]) {
        if (!step.path.startsWith(`${headScope.rules.configDir}/`)) continue;
        this.#defer(state, step.path, step.expected, step.next, head.oid);
        plan.incoming.splice(plan.incoming.indexOf(step), 1);
      }
    }
    for (const id of decidedOversize) if (!state.unacknowledged.includes(id)) state.unacknowledged.push(id);
    if (decidedOversize.length > 0) {
      await this.#save(state);
      await this.#acknowledge(state);
      if (decidedOversize.some((id) => state.unacknowledged.includes(id))) {
        const steps = plan.resolved.flatMap((item) => isNativeConflict(item) && item.oversize.some((evidence) => state.unacknowledged.includes(evidence.id))
          ? [{ path: item.path, reason: "Native recovery acknowledgement did not complete; retry synchronization" }] : []);
        return { kind: "blocked", commit: head.oid, steps };
      }
      for (const item of plan.resolved) {
        if (isNativeConflict(item) && item.oversize.length > 0 && sameEntry(local[item.path], plan.target[item.path])) {
          delete state.holds[item.path];
          released = true;
        }
      }
    }

    const outgoing = Object.keys(plan.outgoing).length;
    const held = plan.held;
    if (outgoing === 0 && plan.incoming.length === 0) {
      // Untouched paths keep their origin so their unknown local bytes are compared later.
      const kept = await this.#untouchedCarry(state, untouched, [local, head.files, base.files], head.files);
      for (const path of Object.keys(state.deferred)) delete kept[path];
      const settled =
        !released &&
        head.oid === state.base.commit &&
        sameCarry(state.carry, kept) &&
        !guardsChanged &&
        !hadReview &&
        hadPrototypeBaseline === Object.hasOwn(state.base.files, "__proto__") &&
        !state.review &&
        Object.keys(state.decisions).length === 0;
      if (!settled) {
        const scopeChanged = state.scope.digest !== headScope.digest;
        state.base = commitState(head);
        state.scope = { ...headScope.rules, digest: headScope.digest };
        state.carry = kept;
        if (!scopeChanged) state.reentry = [];
        if (held.length === 0) {
          state.review = null;
          state.decisions = dictionary();
        }
        await this.#save(state);
      }
      if (held.length > 0) {
        await this.#save(state);
        return { kind: "needs-decision", conflicts: held, merged: plan.merged, published: false, carried: [] };
      }
      return { kind: "up-to-date", commit: head.oid };
    }

    // Drafts (local differs from the effective base) and every preimage the
    // application could overwrite are recorded before anything leaves or changes.
    const drafts: Snapshot = dictionary();
    for (const [path, entry] of Object.entries(planLocal)) if (!sameEntry(entry, planBase[path])) drafts[path] = entry;
    for (const step of plan.incoming) if (step.expected) drafts[step.path] = step.expected;
    const recoveryId = this.#record(state, "sync", drafts);
    const incomingFiles: Snapshot = dictionary();
    for (const step of plan.incoming) if (step.next) incomingFiles[step.path] = step.next;
    const incomingRecoveryId = this.#record(state, "incoming", incomingFiles);
    const steps: StoredStep[] = plan.incoming.map((step) => ({
      path: step.path,
      expected: step.expected && toRef(step.expected),
      next: step.next && toRef(step.next),
      status: "pending",
      decision: step.decision,
      reason: null,
    }));

    if (outgoing === 0) {
      const operation: ApplyOperation = {
        kind: "apply",
        id: this.#nextId(state, "apply"),
        target: { commit: head.oid, tree: head.treeOid, files: toManifest(head.files) },
        steps,
        recoveryId,
        incomingRecoveryId,
        replan: false,
      };
      state.operation = operation;
      await this.#save(state);
      return this.#withHolds(state, await this.#finish(state, operation, local, head.files, false));
    }

    const id = `${this.#nextId(state, "publish")}-${crypto.randomUUID()}`;
    const anchor = state.ledger.anchor;
    const candidate = await this.#repository.prepare(head, plan.outgoing, this.#message(outgoing), { anchor, operation: id });
    if (!isOid(candidate.oid) || !isOid(candidate.treeOid) || candidate.oid === head.oid || !sameManifest(filterSnapshot(candidate.files, transaction), plan.target)) {
      throw new IntegrityError("Prepared commit does not contain exactly the planned files");
    }
    if (!isOid(candidate.receipt) || [candidate.oid, head.oid, anchor].includes(candidate.receipt)) {
      throw new IntegrityError("Prepared receipt is not a distinct commit");
    }
    const operation: PublishOperation = {
      kind: "publish",
      id,
      parent: head.oid,
      candidate: { commit: candidate.oid, tree: candidate.treeOid },
      receipt: candidate.receipt,
      anchor,
      publication: { phase: "dispatched" },
      target: toManifest(candidate.files),
      steps,
      recoveryId,
      incomingRecoveryId,
      fence: null,
    };
    // The receipt identity is durable before the first and only dispatch.
    state.operation = operation;
    await this.#save(state);
    const ack = await this.#repository
      .publish({ parent: head.oid, candidate: candidate.oid, anchor, receipt: candidate.receipt })
      .catch(() => "unconfirmed" as const);
    const settled = ack === "acknowledged" ? await this.#accept(state, operation) : await this.#settle(state, operation);
    if (settled.kind === "held") return settled.outcome;
    if (settled.kind === "cancelled") return settled;
    return this.#withHolds(state, await this.#finish(state, settled.operation, local, candidate.files, true));
  }

  /**
   * Undecided native holds keep the sync asking for decisions after other
   * paths progressed. A hold ingested during this operation is surfaced by
   * one more reconcile pass, which never touches held paths.
   */
  async #withHolds(state: StoredState, outcome: SyncOutcome): Promise<SyncOutcome> {
    if (outcome.kind !== "synced" || Object.keys(state.holds).length === 0 || this.#holdPass) return outcome;
    this.#holdPass = true;
    try {
      const next = await this.#transact(state);
      if (next.kind === "cancelled" || next.kind === "up-to-date") return outcome;
      // Report what this sync already accomplished alongside the decisions.
      if (next.kind === "needs-decision") return { ...next, published: outcome.published, carried: outcome.carried };
      return next;
    } finally {
      this.#holdPass = false;
    }
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
  async #resume(state: StoredState): Promise<{ kind: "held"; outcome: SyncOutcome } | Cancelled | { kind: "continue"; published: boolean; carried: string[] }> {
    let operation = state.operation;
    if (!operation) return { kind: "continue", published: false, carried: [] };
    if (operation.kind === "restore") return this.#resumeRestore(state, operation);
    if (operation.kind === "configuration") {
      const outcome = await this.#applyConfigurationSteps(state, operation);
      return outcome.kind === "blocked"
        ? { kind: "held", outcome: { kind: "blocked", commit: state.base.commit, steps: outcome.steps } }
        : { kind: "continue", published: false, carried: [] };
    }
    let published = false;
    if (operation.kind === "publish") {
      const settled = await this.#settle(state, operation);
      if (settled.kind !== "accepted") return settled;
      operation = settled.operation;
      published = true;
    }
    const applied = await this.#resumeApply(state, operation);
    if (applied.kind === "blocked") return { kind: "held", outcome: applied.outcome };
    return { kind: "continue", published, carried: applied.carried };
  }

  async #resumeRestore(state: StoredState, operation: RestoreOperation): Promise<{ kind: "continue"; published: false; carried: string[] } | { kind: "held"; outcome: SyncOutcome }> {
    await this.#verifyRestoreOperation(state, operation);
    // Older journals can contain a reviewed restore without a guard. Install
    // one before any resumed write, including a write with a lost response.
    if (await this.#ensureRestoreGuard(state, operation.step)) await this.#save(state);
    const local = await this.#capture(state, "restore resumption capture");
    const step = operation.step;
    const observed = this.#observeLocal(state, local, step.path);
    if (observed.kind === "unknown" || state.holds[step.path]) {
      state.operation = null;
      await this.#save(state);
      return { kind: "continue", published: false, carried: [] };
    }
    const current = observed.entry;
    if (
        (!sameEntry(current, step.expected) && !sameEntry(current, step.next))) {
      state.operation = null;
      await this.#save(state);
      return { kind: "continue", published: false, carried: [] };
    }
    let installed = sameEntry(current, step.next);
    let writtenNow = false;
    if (!installed) {
      if (!step.next) throw new IntegrityError("Restore has no historical version");
      const next = materialize(state, dictionary([[step.path, step.next]]))[step.path];
      const result = await this.#vault.apply(step.path, current, next);
      if (result.kind === "blocked") {
        markStep(step, "blocked", result.reason || "Blocked by the vault adapter");
        await this.#save(state);
        return { kind: "held", outcome: { kind: "blocked", commit: state.base.commit, steps: [{ path: step.path, reason: result.reason }] } };
      }
      if (result.kind === "interrupted" || result.kind === "displaced") {
        await this.#ingest(state, [result.issue], { requiredPath: step.path });
      }
      installed = result.kind === "applied";
      writtenNow = installed;
    }
    // Historical restore carries its own exact review. Keep that durable
    // authorization across the next sync, including a plugin reload.
    const guard = state.configurationGuards[step.path];
    if (writtenNow && guard) guard.hostLifetimeId = this.#hostLifetimeId;
    if (installed && guard && step.next) {
      // An already-installed restore observed on a new host retains its old
      // guard, which the first observation may retire.
      if (guard.hostLifetimeId === this.#hostLifetimeId) guard.applied = step.next;
      guard.consent = { version: step.next, head: state.base.commit, scope: state.scope.digest };
    }
    state.operation = null;
    await this.#save(state);
    return { kind: "continue", published: false, carried: [] };
  }

  async #verifyRestoreOperation(state: StoredState, operation: RestoreOperation): Promise<void> {
    if (state.base.commit !== operation.baseCommit ||
        (operation.sourceCommit !== state.base.commit && !(await this.#repository.isAncestor(operation.sourceCommit, state.base.commit)))) {
      throw new IntegrityError("Reviewed restore is outside the current checkpoint history");
    }
    const source = await this.#repository.readCommit(operation.sourceCommit);
    if (source.oid !== operation.sourceCommit || !sameEntry(await verifyEntry(operation.step.path, source.files[operation.step.path]), operation.step.next)) {
      throw new IntegrityError("Historical bytes differ from the durable restore");
    }
  }

  async #resumeApply(state: StoredState, operation: ApplyOperation): Promise<Applied> {
    const target = await this.#repository.readCommit(operation.target.commit);
    const targetScope = await this.#scopeFor(target.oid, state.scope.rules);
    const files = await verifySnapshot(filterSnapshot(target.files, targetScope), "target commit", targetScope);
    if (target.oid !== operation.target.commit || target.treeOid !== operation.target.tree || !sameManifest(files, operation.target.files)) {
      throw new IntegrityError(`Commit ${operation.target.commit} does not match the recorded operation`);
    }
    const local = await this.#capture(state, "local capture");
    this.#guardCapture(state, local);
    if (operation.replan) {
      const planned = await this.#replan(state, operation, local, { oid: target.oid, treeOid: target.treeOid, files });
      if (planned) return { kind: "blocked", outcome: planned };
    }
    return this.#applySteps(state, operation, local, files);
  }

  /**
   * Migrated /2 operations: replace their consent-bearing steps by exact
   * compare-and-swap steps from the effective base to the accepted target.
   * Any path whose bytes differ from that base is carried, never written.
   */
  async #replan(state: StoredState, operation: ApplyOperation, local: Snapshot, target: CommitSnapshot): Promise<SyncOutcome | null> {
    const base = await this.#effectiveBase(state, local, target);
    if (base.kind === "paused") return base.outcome;
    const preimages: Snapshot = dictionary();
    const incoming: Snapshot = dictionary();
    const steps: StoredStep[] = [];
    for (const path of [...new Set([...Object.keys(base.files), ...Object.keys(local), ...Object.keys(target.files), ...this.#untouched(state)])].sort()) {
      const observed = this.#observeLocal(state, local, path);
      const next = target.files[path] ?? null;
      const expected = base.files[path] ?? null;
      if (observed.kind === "unknown") {
        if (expected) preimages[path] = expected;
        if (next) incoming[path] = next;
        steps.push({ path, expected: expected && toRef(expected), next: next && toRef(next), status: "changed", decision: null, reason: null });
        continue;
      }
      const current = observed.entry;
      if (sameEntry(current, next)) continue;
      if (expected) preimages[path] = expected;
      if (next) incoming[path] = next;
      steps.push({ path, expected: expected && toRef(expected), next: next && toRef(next), status: sameEntry(current, expected) ? "pending" : "changed", decision: null, reason: null });
    }
    operation.recoveryId = this.#record(state, "migration", preimages);
    operation.incomingRecoveryId = this.#record(state, "incoming", incoming);
    operation.steps = steps;
    operation.replan = false;
    await this.#save(state);
    return null;
  }

  /** Settles a ledger publication of the current operation: receipt accepts, own seal cancels. */
  async #settle(state: StoredState, operation: PublishOperation): Promise<Settlement> {
    if (operation.publication.phase === "legacy") return this.#settleLegacy(state, operation);
    const verdict = await this.#settleLedger(state, ledgerView(operation), operation.id);
    if (verdict.kind === "receipt") return this.#accept(state, operation);
    if (verdict.kind === "seal") return this.#cancel(state, operation, verdict.seal);
    if (verdict.kind === "held") return verdict;
    return this.#diverged(state, operation, verdict.value);
  }

  /**
   * The ledger state machine. Only the ledger value decides: the receipt means
   * accepted, the seal means cancelled forever, the anchor means undecided and
   * is raced by the one durable seal (the only write made here). A value older
   * than the anchor (or absent past it) can only be a stale replica or an
   * out-of-contract rewind: it is reread a bounded number of times, then the
   * publication stays settling and nothing is sent; no number of stale reads
   * is ever treated as divergence. Anything else fails closed as divergence.
   */
  async #settleLedger(state: StoredState, item: LedgerPublication, operationId: string): Promise<Verdict> {
    const held = (reason: "unreachable" | "stale-ledger"): Verdict => ({ kind: "held", outcome: { kind: "settling", operationId, reason } });
    let stale = 0;
    for (let round = 0; round < SETTLE_ROUNDS; ) {
      let value: string | null;
      try {
        value = await this.#readLedgerValue();
      } catch (error) {
        if (retryable(error)) throw error;
        return held("unreachable");
      }
      if (value === item.receipt) return { kind: "receipt" };
      if (item.publication.phase === "sealing" && value === item.publication.seal) return { kind: "seal", seal: item.publication.seal };
      if (value !== item.anchor) {
        const older = item.anchor === null ? false : value === null ? true : await this.#ancestry(value, item.anchor);
        if (older === null) return held("unreachable");
        if (!older) return { kind: "diverged", value };
        if (++stale > STALE_REREADS) return held("stale-ledger");
        await this.#delay(1000 * stale + Math.floor(this.#random() * 2000));
        continue;
      }
      round++;
      if (item.publication.phase !== "sealing") {
        let seal: string;
        try {
          seal = await this.#repository.createSeal({ anchor: item.anchor, parent: item.parent, operation: item.id });
        } catch (error) {
          if (retryable(error)) throw error;
          return held("unreachable");
        }
        if (!isOid(seal) || [item.receipt, item.anchor, item.parent, item.candidate.commit].includes(seal)) {
          throw new IntegrityError("Created seal is not a distinct commit");
        }
        // The seal identity is durable before its first dispatch and reused for every retry.
        item.publication = { phase: "sealing", seal };
        await this.#save(state);
      }
      await this.#repository.seal({ anchor: item.anchor, seal: item.publication.seal }).catch(() => undefined);
    }
    return held("unreachable");
  }

  /**
   * While paused `ledger-diverged`, each sync rereads the ledger without
   * writing: our receipt or seal settles the publication and lifts the pause;
   * anything else keeps the reviewed pause. Returns null once settled.
   */
  async #recheckDiverged(state: StoredState, operation: PublishOperation): Promise<SyncOutcome | null> {
    const pause = state.pause!;
    let value: string | null;
    try {
      value = await this.#readLedgerValue();
    } catch (error) {
      if (retryable(error)) throw error;
      return { kind: "paused", pause };
    }
    const seal = operation.publication.phase === "sealing" ? operation.publication.seal : null;
    if (value === null || (value !== operation.receipt && value !== seal)) return { kind: "paused", pause };
    state.pause = null;
    if (value === operation.receipt) await this.#accept(state, operation);
    else await this.#cancel(state, operation, value);
    return null;
  }

  /**
   * /2 publications carried no ledger update: only branch reachability can
   * accept them, and nothing ever proves them rejected. While the branch sits
   * at the legacy parent, the old request (`parent -> candidate`) could still
   * land, so the branch is moved off the parent by a same-tree fence commit
   * published through this device's ledger. The fence identity is durable
   * before dispatch and settles like any publication (receipt: fenced; seal:
   * retried). Release still needs the user's review: a fence proves only that
   * the old request can no longer land, not that it never did.
   */
  async #settleLegacy(state: StoredState, operation: PublishOperation, fenceAllowed = true): Promise<Settlement> {
    if (operation.fence) {
      const fence = operation.fence;
      const verdict = await this.#settleLedger(state, fence, operation.id);
      if (verdict.kind === "held") return verdict;
      if (verdict.kind === "diverged") return this.#fenceDiverged(state, operation, fence, verdict.value);
      state.ledger.anchor = verdict.kind === "receipt" ? fence.receipt : verdict.seal;
      operation.fence = null;
      await this.#save(state);
    }
    const head = await this.#readHead(state.scope.rules);
    const candidate = operation.candidate.commit;
    let published = head.oid === candidate;
    if (!published) {
      try {
        published = await this.#repository.isAncestor(candidate, head.oid);
      } catch {
        published = false;
      }
    }
    if (published) return this.#accept(state, operation);
    const unknown = (fenced: boolean, at: string): Settlement => ({ kind: "held", outcome: { kind: "publication-unknown", operationId: operation.id, parent: operation.parent, candidate, head: at, fenced } });
    if (head.oid !== operation.parent) return unknown(true, head.oid);
    // At most one new fence per sync; a sealed fence is retried by the next sync.
    if (!fenceAllowed) return unknown(false, head.oid);
    const id = `fence-${this.#nextId(state, "fence")}-${crypto.randomUUID()}`;
    const anchor = state.ledger.anchor;
    const prepared = await this.#repository.prepare(head, dictionary(), `Vault sync fence from ${this.#deviceName}`, { anchor, operation: id });
    if (!isOid(prepared.oid) || prepared.oid === head.oid || prepared.oid === candidate || prepared.treeOid !== head.treeOid || !sameManifest(prepared.files, head.files)) {
      throw new IntegrityError("Prepared fence is not a same-tree commit on the legacy parent");
    }
    if (!isOid(prepared.receipt) || [prepared.oid, head.oid, anchor, candidate].includes(prepared.receipt)) {
      throw new IntegrityError("Prepared fence receipt is not a distinct commit");
    }
    const fence: LedgerPublication = { id, parent: head.oid, candidate: { commit: prepared.oid, tree: prepared.treeOid }, receipt: prepared.receipt, anchor, publication: { phase: "dispatched" } };
    // The fence and legacy identities are durable before the fence's only dispatch.
    operation.fence = fence;
    await this.#save(state);
    const ack = await this.#repository.publish({ parent: head.oid, candidate: prepared.oid, anchor, receipt: prepared.receipt }).catch(() => "unconfirmed" as const);
    if (ack !== "acknowledged") return this.#settleLegacy(state, operation, false);
    state.ledger.anchor = fence.receipt;
    operation.fence = null;
    await this.#save(state);
    return unknown(true, fence.candidate.commit);
  }

  async #fenceDiverged(state: StoredState, operation: PublishOperation, fence: LedgerPublication, value: string | null): Promise<Settlement> {
    const settling: Settlement = { kind: "held", outcome: { kind: "settling", operationId: operation.id, reason: "unreachable" } };
    const seal = fence.publication.phase === "sealing" ? fence.publication.seal : null;
    for (const [mine, label] of [[fence.receipt, "fence receipt"], [seal, "fence seal"]] as const) {
      if (value === null || mine === null) continue;
      const past = await this.#ancestry(mine, value);
      if (past === null) return settling;
      if (past) {
        state.ledger.anchor = mine;
        operation.fence = null;
        await this.#save(state);
        return { kind: "held", outcome: await this.#pause(state, "duplicate-installation", `Ledger ${state.ledger.ref} advanced past this device's ${label} ${mine}; another installation is writing it`) };
      }
    }
    return { kind: "held", outcome: await this.#pause(state, "ledger-diverged", `Ledger ${state.ledger.ref} is ${value ?? "absent"}, expected ${fence.anchor ?? "absent"} while fencing a legacy publication; review publication recovery`) };
  }

  async #accept(state: StoredState, operation: PublishOperation): Promise<Settlement> {
    const promoted: ApplyOperation = {
      kind: "apply",
      id: operation.id,
      target: { ...operation.candidate, files: operation.target },
      steps: operation.steps,
      recoveryId: operation.recoveryId,
      incomingRecoveryId: operation.incomingRecoveryId,
      replan: operation.publication.phase === "legacy",
    };
    if (operation.receipt !== null) state.ledger.anchor = operation.receipt;
    state.operation = promoted;
    await this.#save(state);
    return { kind: "accepted", operation: promoted };
  }

  /** A publication never wrote the vault, so cancellation only moves the anchor. */
  async #cancel(state: StoredState, operation: PublishOperation, seal: string): Promise<Settlement> {
    if (state.operation !== operation) throw new IntegrityError("Cancelled a publication that is not current");
    state.ledger.anchor = seal;
    state.operation = null;
    await this.#save(state);
    return { kind: "cancelled" };
  }

  async #diverged(state: StoredState, operation: PublishOperation, value: string | null): Promise<Settlement> {
    const settling: Settlement = { kind: "held", outcome: { kind: "settling", operationId: operation.id, reason: "unreachable" } };
    if (value !== null && operation.receipt !== null) {
      const accepted = await this.#ancestry(operation.receipt, value);
      if (accepted === null) return settling;
      if (accepted) {
        await this.#accept(state, operation);
        return { kind: "held", outcome: await this.#pause(state, "duplicate-installation", `Ledger ${state.ledger.ref} advanced past this device's receipt ${operation.receipt}; another installation is writing it`) };
      }
      if (operation.publication.phase === "sealing") {
        const seal = operation.publication.seal;
        const cancelled = await this.#ancestry(seal, value);
        if (cancelled === null) return settling;
        if (cancelled) {
          await this.#cancel(state, operation, seal);
          return { kind: "held", outcome: await this.#pause(state, "duplicate-installation", `Ledger ${state.ledger.ref} advanced past this device's seal ${seal}; another installation is writing it`) };
        }
      }
    }
    const found = value ?? "absent";
    return { kind: "held", outcome: await this.#pause(state, "ledger-diverged", `Ledger ${state.ledger.ref} is ${found}, expected ${operation.anchor ?? "absent"}; review publication recovery`) };
  }

  /** Binds a migrated /2 state to this installation's ledger, which must not exist yet. */
  async #bindLedger(state: StoredState): Promise<SyncOutcome | null> {
    const ref = this.#repository.ledgerRef();
    if (state.ledger.ref === null) {
      if (await this.#readLedgerValue() !== null) {
        return this.#pause(state, "duplicate-installation", `Ledger ${ref} already exists before this vault's first ledger publication; this device identity may be shared`);
      }
      state.ledger.ref = ref;
      await this.#save(state);
      return null;
    }
    if (state.ledger.ref !== ref) {
      return this.#pause(state, "duplicate-installation", `This journal belongs to ${state.ledger.ref}, not ${ref}`);
    }
    return null;
  }

  async #readLedgerValue(): Promise<string | null> {
    const read = await this.#repository.readLedger();
    if (read.kind === "absent") return null;
    if (!isOid(read.value)) throw new IntegrityError("Ledger value is not an object ID");
    return read.value;
  }

  /** Ancestry with `null` for an inconclusive lookup. */
  async #ancestry(ancestor: string, descendant: string): Promise<boolean | null> {
    try {
      return await this.#repository.isAncestor(ancestor, descendant);
    } catch (error) {
      if (retryable(error)) throw error;
      return null;
    }
  }

  /**
   * Applies pending/blocked steps with compare-and-swap. A file that no longer
   * matches its captured version is left alone and carried as a newer draft.
   * The checkpoint advances only once every step is accounted for.
   */
  async #applySteps(state: StoredState, operation: ApplyOperation, local: Snapshot, files: Snapshot): Promise<Applied> {
    for (const step of operation.steps) {
      if (step.status !== "pending" && step.status !== "blocked") continue;
      const observed = this.#observeLocal(state, local, step.path);
      if (observed.kind === "unknown") {
        // Omission from a scan is unknown bytes, never proven absence. Preserve
        // the step's original precondition for a later exact comparison.
        markStep(step, "changed");
        await this.#save(state);
        continue;
      }
      const current = observed.entry;
      if (sameEntry(current, step.next)) {
        markStep(step, "applied");
        continue;
      }
      // A held path is written only to implement the decision on that hold.
      if (!sameEntry(current, step.expected) || (state.holds[step.path] && step.decision === null)) {
        markStep(step, "changed");
        continue;
      }
      const next = step.next ? files[step.path] : null;
      if (step.next && !sameEntry(next, step.next)) throw new IntegrityError(`Missing target content for ${step.path}`);
      const result = await this.#vault.apply(step.path, current, next ?? null);
      if (result.kind === "blocked") markStep(step, "blocked", result.reason || "Blocked by the vault adapter");
      else markStep(step, result.kind);
      if (result.kind === "applied" && step.decision !== null && state.holds[step.path]) {
        // The exact compare-and-swap made the chosen version live; release with this save.
        delete state.holds[step.path];
      }
      if (result.kind === "interrupted" || result.kind === "displaced") await this.#ingest(state, [result.issue], { requiredPath: step.path, known: [local, files] });
      else await this.#save(state);
    }

    // Preserve every observed newer draft even while another step remains blocked.
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
      if (step.status === "changed" || step.status === "interrupted") carry[step.path] = step.expected;
      else if (step.status === "kept") {
        carry[step.path] = step.next;
        const entry = files[step.path];
        if (step.next && entry) state.blobs[entry.oid] = entry.data;
      }
    }
    const stepsByPath = new Map(operation.steps.map((step) => [step.path, step]));
    for (const path of new Set([...Object.keys(local), ...Object.keys(recaptured), ...stepsByPath.keys()])) {
      const step = stepsByPath.get(path);
      const expected = step?.status === "changed" || step?.status === "interrupted" ? step.expected : step ? step.next : local[path];
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
    // Untouched paths (unknown local bytes) keep their origin across the advance.
    const untouched = this.#untouched(state).filter((path) => !stepsByPath.has(path));
    Object.assign(carry, await this.#untouchedCarry(state, untouched, [local, files], operation.target.files));
    const priorScope = await this.#scopeFor(state.base.commit, state.scope.rules);
    for (const [path, origin] of Object.entries(state.carry)) {
      if (!priorScope.includes(path) && !Object.hasOwn(carry, path)) carry[path] = origin;
    }
    for (const path of Object.keys(state.deferred)) delete carry[path];
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
    const appliedScope = await this.#scopeFor(operation.target.commit, state.scope.rules);
    const scopeChanged = appliedScope.digest !== state.scope.digest;
    state.scope = { ...appliedScope.rules, digest: appliedScope.digest };
    state.carry = carry;
    if (!scopeChanged) state.reentry = [];
    state.operation = null;
    state.review = null;
    state.decisions = dictionary();
    await this.#save(state);
    return { kind: "complete", commit: operation.target.commit, carried: Object.keys(carry).sort() };
  }

  async #applyConfigurationSteps(state: StoredState, operation: ConfigurationOperation): Promise<{ kind: "applied"; paths: string[] } | { kind: "review-needed"; applied: string[]; changed: string[] } | { kind: "blocked"; steps: BlockedStep[] }> {
    const scope = await this.#scopeFor(state.base.commit, state.scope.rules);
    const local = await this.#capture(state, "configuration application capture", true, scope);
    // A prior call may have saved an applied step before a crash. Rebuild its
    // guard before the operation can retire or another transaction can plan.
    for (const step of operation.steps) if (step.status === "applied") this.#restoreConfigurationGuard(state, operation, step);
    for (const step of operation.steps) {
      if (step.status !== "pending" && step.status !== "blocked") continue;
      const observed = this.#observeLocal(state, local, step.path);
      if (observed.kind === "unknown") {
        markStep(step, "changed");
        state.carry[step.path] = step.expected;
        delete state.deferred[step.path];
        await this.#save(state);
        continue;
      }
      const current = observed.entry;
      if (sameEntry(current, step.next)) {
        markStep(step, "applied");
        this.#restoreConfigurationGuard(state, operation, step);
        delete state.deferred[step.path];
        await this.#save(state);
        continue;
      }
      if (!sameEntry(current, step.expected) || state.holds[step.path]) {
        markStep(step, "changed");
        state.carry[step.path] = step.expected;
        delete state.deferred[step.path];
        await this.#save(state);
        continue;
      }
      const next = step.next ? materialize(state, dictionary([[step.path, step.next]]))[step.path]! : null;
      const result = await this.#vault.apply(step.path, current, next);
      if (result.kind === "blocked") markStep(step, "blocked", result.reason || "Blocked by the vault adapter");
      else markStep(step, result.kind);
      if (result.kind === "applied") this.#setConfigurationGuard(state, step, this.#hostLifetimeId);
      if (result.kind === "changed") state.carry[step.path] = step.expected;
      if (result.kind === "interrupted" || result.kind === "displaced") {
        await this.#ingest(state, [result.issue], { requiredPath: step.path, known: [local, next ? dictionary([[step.path, next]]) : dictionary()] });
      }
      if (result.kind !== "blocked") delete state.deferred[step.path];
      await this.#save(state);
    }
    const blocked = operation.steps.filter((step) => step.status === "blocked").map((step) => ({ path: step.path, reason: step.reason ?? "Blocked by the vault adapter" }));
    if (blocked.length) return { kind: "blocked", steps: blocked };
    await this.#capture(state, "post-configuration capture");
    state.operation = null;
    await this.#save(state);
    const applied = operation.steps.filter((step) => step.status === "applied").map((step) => step.path);
    const changed = operation.steps.filter((step) => step.status === "changed").map((step) => step.path);
    return changed.length > 0 ? { kind: "review-needed", applied, changed } : { kind: "applied", paths: applied };
  }

  #restoreConfigurationGuard(state: StoredState, operation: ConfigurationOperation, step: StoredStep): void {
    const existing = state.configurationGuards[step.path];
    if (existing && sameRef(existing.applied, step.next)) return;
    this.#setConfigurationGuard(state, step, operation.hostLifetimeId);
  }

  #setConfigurationGuard(state: StoredState, step: StoredStep, hostLifetimeId: string | null): void {
    state.configurationGuards[step.path] = { hostLifetimeId, applied: step.next, consent: null };
  }

  async #ensureRestoreGuard(state: StoredState, step: StoredStep): Promise<boolean> {
    if (state.configurationGuards[step.path]) return false;
    if (state.scope.rules !== "config/1" || !(await this.#scopeFor(state.base.commit, "config/1")).isLive(step.path)) return false;
    // Until the write lands, expected is the last version known to be on disk.
    // A later observation of next can retire on a different host, while the
    // writing host retains the guard through publication and stale flushes.
    state.configurationGuards[step.path] = { hostLifetimeId: this.#hostLifetimeId, applied: step.expected, consent: null };
    return true;
  }

  /**
   * The only call that lets the vault mutate native recovery state; every
   * caller has already passed the identity, pause and installation fences.
   * Authorizes replay only for intents exactly matching an unfinished step of
   * the durable accepted apply or reviewed restore operation. Every other
   * intent (a kept step, an abandoned operation) is cancelled, which never
   * installs its intent. A
   * crash on either side of the vault's cancellation save is idempotent: the
   * next pass cancels again or finds nothing. Returns an outcome only when
   * evidence of unknown scope blocks synchronization.
   */
  async #recoverNative(state: StoredState): Promise<SyncOutcome | null> {
    if (!this.#vault.recover) return null;
    if (state.operation?.kind === "restore") await this.#verifyRestoreOperation(state, state.operation);
    const pending = await this.#pendingIntents();
    const operation = state.operation;
    const replay: string[] = [];
    const configurationReplay: StoredStep[] = [];
    const restoreReplay: StoredStep[] = [];
    const cancel: string[] = [];
    const restoreScope = operation?.kind === "restore" && state.scope.rules === "config/1"
      ? await this.#scopeFor(state.base.commit, "config/1") : null;
    for (const intent of pending) {
      const step = operation?.kind === "apply" || operation?.kind === "configuration" ? operation.steps.find((item) => item.path === intent.path) :
        operation?.kind === "restore" && operation.step.path === intent.path ? operation.step : undefined;
      const authorized =
        step !== undefined &&
        (step.status === "pending" || step.status === "blocked") &&
        sameRef(step.expected, intent.expected) &&
        sameRef(step.next, intent.next) &&
        !(state.holds[step.path] && (step.decision === null || state.holds[step.path]!.oversize.length > 0)) &&
        !this.#quarantined(state).has(step.path) &&
        !this.#unreadable.some((item) => item.path === step.path);
      (authorized ? replay : cancel).push(intent.id);
      if (authorized && operation?.kind === "configuration" && step) configurationReplay.push(step);
      if (authorized && operation?.kind === "restore" && step &&
          (state.configurationGuards[step.path] || restoreScope?.isLive(step.path))) restoreReplay.push(step);
    }
    if (restoreReplay.length > 0) {
      const local = await this.#capture(state, "native restore replay preimage", false);
      let changed = false;
      for (const step of restoreReplay) {
        const observed = this.#observeLocal(state, local, step.path);
        if (observed.kind === "known" && sameEntry(observed.entry, step.next)) continue;
        if (await this.#ensureRestoreGuard(state, step)) changed = true;
        const guard = state.configurationGuards[step.path];
        if (guard && guard.hostLifetimeId !== this.#hostLifetimeId) {
          guard.hostLifetimeId = this.#hostLifetimeId;
          changed = true;
        }
      }
      // Native recovery can install next before the resumed step sees it.
      if (changed) await this.#save(state);
    }
    if (configurationReplay.length > 0) {
      // Recovery may install `next` before the resumed step observes it. Make
      // the current host's guard durable first unless `next` is already
      // visible. A missing or unreadable path can still be restored from a
      // native hold during replay.
      const local = await this.#capture(state, "native configuration replay preimage", false);
      let changed = false;
      for (const step of configurationReplay) {
        const observed = this.#observeLocal(state, local, step.path);
        if (observed.kind === "known" && sameEntry(observed.entry, step.next)) continue;
        this.#setConfigurationGuard(state, step, this.#hostLifetimeId);
        changed = true;
      }
      if (changed) await this.#save(state);
    }
    const issues = await this.#vault.recover({ replay, cancel });
    // Anything still pending was refused by the vault: hold its path untouched.
    const stuck = (await this.#pendingIntents()).map((intent): NativeError => ({ id: intent.id, path: intent.path, detail: "A native file transaction is still unfinished" }));
    await this.#ingest(state, issues, { replaceErrors: true, extraErrors: stuck });
    const global = state.nativeErrors.filter((item) => item.path === null);
    return global.length > 0 ? { kind: "native-error", errors: global } : null;
  }

  async #pendingIntents(): Promise<PendingIntent[]> {
    if (!this.#vault.pendingIntents) return [];
    const intents = await this.#vault.pendingIntents();
    for (const intent of intents) {
      if (typeof intent?.id !== "string" || !isValidPath(intent.path)) throw new IntegrityError("Native pending intent is malformed");
    }
    return intents;
  }

  /**
   * Verifies issues one at a time. A valid issue is pinned (bytes in a
   * recovery record; oversize evidence as metadata only), merged into a
   * durable per-path hold with its base fixed now, saved, then acknowledged
   * (oversize ids only once a decision exists). An invalid issue is never
   * acknowledged: it is recorded in `nativeErrors`, holding its path, or the
   * whole vault when its path is unknown. Idempotent by issue id.
   */
  async #ingest(
    state: StoredState,
    issues: unknown[],
    options: { requiredPath?: string; replaceErrors?: boolean; extraErrors?: NativeError[]; known?: Snapshot[] } = {},
  ): Promise<void> {
    const known = new Set([...state.unacknowledged, ...Object.values(state.holds).flatMap((item) => item.ids)]);
    const errors: NativeError[] = [...(options.extraErrors ?? [])];
    const before = JSON.stringify(state.nativeErrors);
    let changed = false;
    const builtins = await compileScope({ rules: state.scope.rules, configDir: state.scope.configDir, gitignore: null }, null);
    const checkedIssues = await Promise.all((Array.isArray(issues) ? issues : [issues]).map((raw) => checkIssue(raw, options.requiredPath, (path) => builtins.includes(path))));
    const authoritative = options.replaceErrors === true && checkedIssues.every((item) => item.kind === "valid");
    const currentIds = new Set(checkedIssues.flatMap((item) => item.kind === "valid" ? [item.issue.id] : []));
    for (const checked of checkedIssues) {
      if (checked.kind === "invalid") {
        errors.push(checked.error);
        continue;
      }
      const issue = checked.issue;
      const prior = state.holds[issue.path];
      // A malformed neighbor makes this listing non-authoritative. Keep a
      // replacement in the native journal until a clean listing can prove the
      // old oversized ID was actually superseded and retire it durably.
      const obsoleteOversize = prior?.oversize.some((item) => item.sourcePath === issue.sourcePath && !currentIds.has(item.id) && sameRef(prior.expected, issue.expected) && sameRef(prior.next, issue.next)) ?? false;
      if (authoritative && prior && issue.sourcePath) {
        const stale = prior.oversize.filter((item) => item.sourcePath === issue.sourcePath && !currentIds.has(item.id));
        if (stale.length > 0 && sameRef(prior.expected, issue.expected) && sameRef(prior.next, issue.next)) {
          const staleIds = new Set(stale.map((item) => item.id));
          prior.ids = prior.ids.filter((id) => !staleIds.has(id));
          prior.oversize = prior.oversize.filter((item) => !staleIds.has(item.id));
          state.unacknowledged = state.unacknowledged.filter((id) => !staleIds.has(id));
          known.forEach((id) => { if (staleIds.has(id)) known.delete(id); });
          if (state.review) {
            const retired = state.review.conflicts.filter((item) => "path" in item && item.path === issue.path);
            for (const item of retired) delete state.decisions[item.id];
            state.review.conflicts = state.review.conflicts.filter((item) => !("path" in item && item.path === issue.path));
            if (state.review.conflicts.length === 0) state.review = null;
          }
          if (state.operation && state.operation.kind !== "restore") {
            for (const step of state.operation.steps) if (step.path === issue.path && (step.status === "pending" || step.status === "blocked") && step.decision !== null) markStep(step, "changed");
          }
          changed = true;
        }
      }
      if (known.has(issue.id)) {
        if (authoritative && issue.kind !== "oversize" && !state.unacknowledged.includes(issue.id)) {
          state.unacknowledged.push(issue.id);
          changed = true;
        }
        continue;
      }
      known.add(issue.id);
      delete state.deferred[issue.path];
      const base = prior ? prior.base : await this.#origin(state, issue.path, options.known ?? []);
      if (issue.kind === "oversize") {
        const evidence: OversizeEvidence = { id: issue.id, sourcePath: issue.sourcePath, size: issue.size, mtime: issue.mtime };
        for (const entry of [issue.expected, issue.next]) if (entry) this.#record(state, "native", dictionary([[issue.path, entry]]));
        state.holds[issue.path] = prior
          ? { ...prior, ids: [...prior.ids, issue.id], oversize: [...prior.oversize, evidence] }
          : { ids: [issue.id], kind: "oversize", base, expected: issue.expected && toRef(issue.expected), next: issue.next && toRef(issue.next), found: null, oversize: [evidence] };
      } else {
        for (const entry of [issue.expected, issue.next, issue.found]) if (entry) this.#record(state, "native", dictionary([[issue.path, entry]]));
        const found = issue.found && toRef(issue.found);
        state.holds[issue.path] = prior
          ? { ...prior, ids: [...prior.ids, issue.id], kind: prior.kind === "interrupted" || issue.kind === "interrupted" ? "interrupted" : "displaced", found }
          : { ids: [issue.id], kind: issue.kind, base, expected: issue.expected && toRef(issue.expected), next: issue.next && toRef(issue.next), found, oversize: [] };
        if (authoritative || !obsoleteOversize) state.unacknowledged.push(issue.id);
      }
      changed = true;
    }
    state.nativeErrors = options.replaceErrors ? errors : [...state.nativeErrors, ...errors];
    if (changed || options.requiredPath !== undefined || JSON.stringify(state.nativeErrors) !== before) await this.#save(state);
    await this.#acknowledge(state);
  }

  async #acknowledge(state: StoredState): Promise<void> {
    if (state.unacknowledged.length === 0 || !this.#vault.acknowledgeRecovery) return;
    try {
      await this.#vault.acknowledgeRecovery([...state.unacknowledged]);
    } catch {
      return; // The ids stay unacknowledged and are retried; ingestion is idempotent.
    }
    state.unacknowledged = [];
    await this.#save(state);
  }

  /** The path's effective base with bytes pinned in `blobs`, for a hold's fixed base. */
  async #origin(state: StoredState, path: string, snapshots: Snapshot[]): Promise<Ref | null> {
    const ref = effectiveManifest(state)[path];
    if (!ref) return null;
    if (!Object.hasOwn(state.blobs, ref.oid)) {
      let data = snapshots.map((files) => files[path]).find((entry) => entry?.oid === ref.oid)?.data;
      if (data === undefined) {
        const commit = await this.#readWithKnown(state.base.commit, state, ...snapshots);
        const entry = commit.oid === state.base.commit ? own(commit.files, path) : undefined;
        if (!entry || !sameEntry(entry, ref)) throw new IntegrityError(`Missing base bytes for ${path}`);
        data = (await verifyEntry(path, entry)).data;
      }
      state.blobs[ref.oid] = data;
    }
    return { oid: ref.oid, mode: ref.mode };
  }

  /** Paths whose local bytes are unknown: unreadable in the latest capture, or quarantined. Holds are separate. */
  #untouched(state: StoredState): string[] {
    const paths = new Set([...this.#unreadable.map((item) => item.path), ...this.#quarantined(state)]);
    return [...paths].sort();
  }

  #observeLocal(state: StoredState, local: Snapshot, path: string): LocalObservation {
    if (this.#unreadable.some((item) => item.path === path) || this.#quarantined(state).has(path)) return { kind: "unknown" };
    return { kind: "known", entry: local[path] ?? null };
  }

  /** Carry entries keeping each untouched path's current origin wherever it differs from the new checkpoint. */
  async #untouchedCarry(state: StoredState, paths: readonly string[], snapshots: Snapshot[], target: Manifest | Snapshot): Promise<Record<string, Ref | null>> {
    const carry: Record<string, Ref | null> = dictionary();
    for (const path of paths) {
      const origin = await this.#origin(state, path, snapshots);
      if (!sameRef(origin, target[path])) carry[path] = origin;
    }
    return carry;
  }

  /** Paths held by unverifiable native evidence: never planned, published or written. */
  #quarantined(state: StoredState): Set<string> {
    return new Set(state.nativeErrors.flatMap((item) => (item.path === null ? [] : [item.path])));
  }

  /** An empty capture against a non-empty checkpoint is storage loss, never a plan. */
  #guardCapture(state: StoredState, local: Snapshot): void {
    const expected = Object.keys(effectiveManifest(state)).length;
    if (Object.keys(local).length === 0 && this.#unreadable.length === 0 && expected > 0) {
      throw new VaultCaptureError(`The vault reads as empty while ${expected} synchronized files are expected; storage may be unavailable, so nothing was planned`);
    }
  }

  /** Verify the immutable checkpoint, then materialize checkpoint plus carry. */
  async #effectiveBase(
    state: StoredState,
    local: Snapshot,
    head: CommitSnapshot,
  ): Promise<{ kind: "ready"; files: Snapshot } | { kind: "paused"; outcome: SyncOutcome }> {
    const commit = state.base.commit === head.oid ? head : await this.#readWithKnown(state.base.commit, state, local, head.files);
    const checkpointScope = await this.#scopeFor(commit.oid, state.scope.rules);
    if (checkpointScope.digest !== state.scope.digest) return { kind: "paused", outcome: await this.#pause(state, "base-mismatch", "Stored scope digest differs from the checkpoint policy") };
    const checkpoint = await verifySnapshot(filterSnapshot(commit.files, checkpointScope), "checkpoint commit", checkpointScope);
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
    pending: PendingIntent[];
    scope: Scope;
  }> {
    const repository = await this.#repository.identity();
    const rules = prior?.pause?.reason === "scope-enrollment" ? "config/1" : prior?.scope.rules ?? this.#requestedRules;
    const head = await this.#readHead(rules);
    const scope = await this.#scopeFor(head.oid, rules);
    const pending = await this.#pendingIntents();
    // A preview cannot pin newly visible hidden paths into the old visible-only
    // state: its parser would reject those paths on the next load.
    const local = await this.#capture(null, "local capture", false, scope);
    const unreadable = new Set(this.#unreadable.map((item) => item.path));
    const nativePending = new Set(pending.map((intent) => intent.path));
    if (prior) {
      const migrating = prior.scope.rules !== rules;
      let checkpointCommit: CommitSnapshot;
      if (migrating) {
        const readForScope = this.#repository.readCommitForScope;
        if (!readForScope) throw new IntegrityError("Repository cannot read the prior checkpoint under its original scope");
        checkpointCommit = await readForScope.call(this.#repository, prior.base.commit, prior.scope.rules);
      } else checkpointCommit = prior.base.commit === head.oid ? head : await this.#readWithKnown(prior.base.commit, prior, local, head.files);
      const priorScope = await this.#scopeFor(checkpointCommit.oid, prior.scope.rules);
      const checkpoint = await verifySnapshot(filterSnapshot(checkpointCommit.files, priorScope), "re-enrollment checkpoint", priorScope);
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
    const paths = [...new Set([...Object.keys(local), ...Object.keys(head.files), ...unreadable, ...nativePending])].sort();
    for (const path of paths) {
      const l = local[path] ?? null;
      const r = head.files[path] ?? null;
      const o = old?.[path] ?? null;
      if (nativePending.has(path) || unreadable.has(path)) {
        // Unknown local bytes: never classified as a deletion or download.
        // Derived from absence, so differing bytes ask once readable.
        if (r) carry[path] = null;
        if (l) drafts[path] = l;
        items.push({ path, action: nativePending.has(path) ? "native-pending" : "unreadable" });
        continue;
      }
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
        "enroll/3",
        this.#previewSession,
        repository,
        head.oid,
        prior?.base.commit ?? null,
        Object.entries(toManifest(local)).sort(([a], [b]) => (a < b ? -1 : 1)),
        pending.map((intent) => [intent.id, intent.attempted]).sort(),
        this.#unreadable.map((item) => [item.path, item.size, item.mtime]).sort(),
      ]),
    );
    return {
      preview: { kind: "preview", token, repository, commit: head.oid, reenrollment: prior !== null, items, unchanged },
      head,
      local,
      carry,
      drafts,
      pending,
      scope,
    };
  }

  // ---- Restore -----------------------------------------------------------

  async #restorePreview(state: StoredState, input: { path: string; commit: string }): Promise<RestorePreview | RestoreRefusal> {
    if (!isValidPath(input.path) || !(await this.#scopeFor(state.base.commit, state.scope.rules)).includes(input.path)) return { kind: "invalid-path" };
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
    const observed = this.#observeLocal(state, local, input.path);
    if (observed.kind === "unknown") return { kind: "missing" };
    const current = observed.entry;
    const token = await digestText(
      JSON.stringify(["restore/3", this.#previewSession, input.path, input.commit, historical.oid, historical.mode, current?.oid ?? null, current?.mode ?? null]),
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
      const local = await this.#capture(state, "local capture", false);
      const base = effectiveManifest(state);
      pending = [];
      for (const path of [...new Set([...Object.keys(base), ...Object.keys(local)])].sort()) {
        const observed = this.#observeLocal(state, local, path);
        if (observed.kind === "unknown") continue;
        const b = base[path];
        const l = observed.entry;
        if (sameEntry(b, l)) continue;
        pending.push({ path, change: !b ? "added" : !l ? "deleted" : "modified" });
      }
    }
    const operation = state.operation;
    const blocked =
      operation?.kind === "apply"
        ? operation.steps.filter((step) => step.status === "blocked").map((step) => ({ path: step.path, reason: step.reason ?? "" }))
        : operation?.kind === "restore" && operation.step.status === "blocked"
          ? [{ path: operation.step.path, reason: operation.step.reason ?? "" }]
        : [];
    const conflicts = (state.review?.conflicts ?? []).filter((item) => !Object.hasOwn(state.decisions, item.id)).map((item) => restoreConflict(state, item));
    const phase: Phase = state.pause
      ? "paused"
      : state.nativeErrors.some((item) => item.path === null)
        ? "native-error"
      : operation?.kind === "publish"
        ? operation.publication.phase === "legacy" ? "publication-unknown" : "settling"
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
      nativeErrors: state.nativeErrors,
      unreadable: scan ? this.#unreadable : null,
    };
  }

  // ---- Persistence -------------------------------------------------------

  /** Archives every local draft not already pinned before an API can return early. */
  async #capture(state: StoredState | null, label: string, persist = true, scope?: Scope): Promise<Snapshot> {
    const active = scope ?? (state ? await this.#scopeFor(state.base.commit, state.scope.rules) : undefined);
    const scanned = this.#vault.scan ? await this.#vault.scan(active) : { files: await this.#vault.capture(active), unreadable: [] };
    const local = await verifySnapshot(scanned.files, label, active);
    if (!Array.isArray(scanned.unreadable)) throw new IntegrityError(`${label}: malformed unreadable list`);
    for (const item of scanned.unreadable) {
      if (!isValidPath(item?.path) || (active ? !active.includes(item.path) : !isSyncablePath(item.path)) || Object.hasOwn(local, item.path) || typeof item.size !== "number" || item.reason !== "oversize") {
        throw new IntegrityError(`${label}: malformed unreadable file`);
      }
    }
    this.#unreadable = scanned.unreadable.map((item) => ({ path: item.path, size: item.size, mtime: typeof item.mtime === "number" ? item.mtime : null, reason: item.reason }));
    if (!state) return local;
    const base = effectiveManifest(state);
    const drafts: Snapshot = dictionary();
    // Records may hold different versions at the same path; use all pinned
    // records rather than reducing them into one last-version-wins manifest.
    for (const [path, entry] of Object.entries(local)) {
      if (!sameEntry(entry, base[path]) && !state.recovery.some((record) => record.pinned && sameEntry(record.files[path], entry))) drafts[path] = entry;
    }
    const counter = state.counter;
    this.#record(state, "sync", drafts);
    if (persist && state.counter !== counter) await this.#save(state);
    return local;
  }

  #defer(state: StoredState, path: string, expected: Entry | null, next: Entry | null, commit: string): void {
    if (expected) this.#record(state, "sync", dictionary([[path, expected]]));
    if (next) this.#record(state, "incoming", dictionary([[path, next]]));
    state.deferred[path] = {
      expected: expected && toRef(expected),
      next: next && toRef(next),
      commit,
      blockedReason: configurationBlockReason(path, next),
    };
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
      return { kind: "enrolled", state: await parseState(raw) };
    } catch (error) {
      if (error instanceof CorruptStateError) return { kind: "corrupt", detail: error.message };
      throw error;
    }
  }

  async #save(state: StoredState): Promise<void> {
    const active = new Set([state.operation?.recoveryId, state.operation?.incomingRecoveryId]);
    const disposable = state.recovery.filter((record) => !record.pinned && !active.has(record.id));
    const drop = new Set(disposable.slice(0, Math.max(0, disposable.length - RETAINED_RECOVERY)).map((record) => record.id));
    state.recovery = state.recovery.filter((record) => !drop.has(record.id));
    const live = referencedBlobs(state);
    for (const oid of Object.keys(state.blobs)) if (!live.has(oid)) delete state.blobs[oid];
    const copy = structuredClone(state);
    copy.base.files = toManifest(copy.base.files);
    copy.carry = dictionary(Object.entries(copy.carry));
    copy.deferred = dictionary(Object.entries(copy.deferred));
    copy.hiddenConsent = dictionary(Object.entries(copy.hiddenConsent));
    copy.configurationGuards = dictionary(Object.entries(copy.configurationGuards));
    copy.decisions = dictionary(Object.entries(copy.decisions));
    copy.blobs = dictionary(Object.entries(copy.blobs));
    if (copy.operation?.kind === "publish") copy.operation.target = toManifest(copy.operation.target);
    else if (copy.operation?.kind === "apply") copy.operation.target.files = toManifest(copy.operation.target.files);
    for (const record of copy.recovery) record.files = toManifest(record.files);
    await this.#store.save(copy);
  }

  async #pause(state: StoredState, reason: PauseReason, detail: string): Promise<SyncOutcome> {
    state.pause = { reason, detail };
    await this.#save(state);
    return { kind: "paused", pause: state.pause };
  }

  async #scopeFor(commit: string, rules: ScopeRules["rules"]): Promise<Scope> {
    if (rules === "visible-only") return compileScope({ rules, configDir: ".obsidian", gitignore: null }, null);
    if (!this.#repository.scopeFor || !this.#repository.readRootGitignore) throw new ScopeError("Repository does not support configuration scope");
    const scope = await this.#repository.scopeFor(commit);
    if (scope.rules.rules !== "config/1") throw new ScopeError("Repository scope mode does not match the session");
    const ignoreText = await this.#repository.readRootGitignore(commit);
    const verified = await compileScope({ ...scope.rules }, ignoreText);
    if (verified.digest !== scope.digest) throw new ScopeError("Repository scope and root .gitignore disagree");
    return scope;
  }

  /**
   * Reads a commit after offering the bodies already held in memory (journal
   * blobs, the local scan, the head), so the repository downloads only blobs
   * none of them has. The repository verifies every offered body it uses.
   */
  async #readWithKnown(oid: string, state: StoredState, ...snapshots: Snapshot[]): Promise<CommitSnapshot> {
    const offer = this.#repository.offerKnownBlobs;
    if (!offer) return this.#repository.readCommit(oid);
    const known = new Map<string, string>(Object.entries(state.blobs));
    for (const snapshot of snapshots) for (const entry of Object.values(snapshot)) known.set(entry.oid, entry.data);
    offer.call(this.#repository, Array.from(known, ([oid, data]) => ({ oid, data })));
    try {
      return await this.#repository.readCommit(oid);
    } finally {
      offer.call(this.#repository, []);
    }
  }

  async #readHead(rules: ScopeRules["rules"] = "visible-only"): Promise<CommitSnapshot> {
    const head = await this.#repository.head();
    if (!isOid(head.oid) || !isOid(head.treeOid)) throw new IntegrityError("Repository head has malformed object IDs");
    const scope = await this.#scopeFor(head.oid, rules);
    return { oid: head.oid, treeOid: head.treeOid, files: await verifySnapshot(filterSnapshot(head.files, scope), "remote head", scope) };
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
    if (conflict.kind === "bulk-deletion") return { kind: "bulk-deletion", id: conflict.id, direction: conflict.direction, paths: conflict.paths };
    const keep = (entry: Entry | null): Ref | null => {
      if (!entry) return null;
      state.blobs[entry.oid] = entry.data;
      return toRef(entry);
    };
    if (isNativeConflict(conflict)) {
      return {
        kind: conflict.kind, id: conflict.id, path: conflict.path,
        base: keep(conflict.base), local: keep(conflict.local), remote: keep(conflict.remote),
        expected: keep(conflict.expected), next: keep(conflict.next), found: keep(conflict.found),
        oversize: conflict.oversize,
      };
    }
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
    return this.#commitMessage(count, this.#now());
  }
}

// ---- Helpers ---------------------------------------------------------------

function filterSnapshot<T extends Ref>(files: Readonly<Record<string, T>>, scope: Pick<Scope, "includes">): Record<string, T> {
  for (const path of Object.keys(files)) if (!isValidPath(path)) throw new IntegrityError(`Structurally invalid path ${JSON.stringify(path)}`);
  return dictionary(Object.entries(files).filter(([path]) => scope.includes(path)));
}

function configurationBlockReason(path: string, next: Entry | null): string | null {
  if (!path.endsWith("/community-plugins.json")) return null;
  if (!next) return "Applying this file would remove the active sync plugin; review an edited version containing github-vault-sync";
  const content = entryText(next);
  let parsed: unknown;
  try { parsed = content === null ? null : JSON.parse(content); } catch { parsed = null; }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return "community-plugins.json must be a JSON array of plugin ids";
  if (!parsed.includes("github-vault-sync")) return "Add github-vault-sync to community-plugins.json before applying it";
  const competing = ["obsidian-git", "obsidian-livesync", "remotely-save", "remotely-sync", "cloud-vault-sync"];
  const enabled = competing.filter((id) => parsed.includes(id));
  return enabled.length ? `Disable competing sync plugins before applying community-plugins.json: ${enabled.join(", ")}` : null;
}

function enabledCompetingReason(entry: Entry): string | null {
  const content = entryText(entry);
  let parsed: unknown;
  try { parsed = content === null ? null : JSON.parse(content); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const enabled = ["obsidian-git", "obsidian-livesync", "remotely-save", "remotely-sync", "cloud-vault-sync"].filter((id) => parsed.includes(id));
  return enabled.length ? `Disable currently enabled competing sync plugins before applying community-plugins.json: ${enabled.join(", ")}` : null;
}

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

function sortedManifest(files: Snapshot | Manifest): Array<[string, string, string]> {
  return Object.entries(files).map(([path, entry]): [string, string, string] => [path, entry.mode, entry.oid]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryAt" in error && typeof error.retryAt === "number" && Number.isFinite(error.retryAt);
}

function isNativeConflict<T extends { kind: string }>(conflict: T): conflict is Extract<T, { kind: "interrupted-write" | "displaced-write" | "oversize-write" }> {
  return conflict.kind === "interrupted-write" || conflict.kind === "displaced-write" || conflict.kind === "oversize-write";
}

function nativeHolds(state: StoredState): Record<string, NativeHold> {
  const entry = (ref: Ref | null): Entry | null => (ref ? { ...ref, data: state.blobs[ref.oid]! } : null);
  const holds: Record<string, NativeHold> = dictionary();
  for (const [path, item] of Object.entries(state.holds)) {
    holds[path] = { id: item.ids.join(","), kind: item.kind, base: entry(item.base), expected: entry(item.expected), next: entry(item.next), found: entry(item.found), oversize: item.oversize };
  }
  return holds;
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
  if (conflict.kind === "bulk-deletion") return { ...conflict, choices: ["mine", "remote"] };
  const entry = (ref: Ref | null): Entry | null => (ref ? { ...ref, data: state.blobs[ref.oid]! } : null);
  if (isNativeConflict(conflict)) {
    return {
      ...conflict,
      base: entry(conflict.base), local: entry(conflict.local), remote: entry(conflict.remote),
      expected: entry(conflict.expected), next: entry(conflict.next), found: entry(conflict.found),
      choices: nativeChoices(conflict),
    };
  }
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

function sameRef(a: { oid: string; mode: string } | null | undefined, b: { oid: string; mode: string } | null | undefined): boolean {
  return (a ?? null) === null ? (b ?? null) === null : !!b && a!.oid === b.oid && a!.mode === b.mode;
}

function needsConfigurationReconsent(guard: ConfigurationGuard, entry: Entry | null, head: string, scope: string): boolean {
  // A restore may set applied to its own bytes before publication. A moved
  // head still invalidates that review, even though local equals applied.
  const consent = guard.consent;
  return consent !== null && sameRef(consent.version, entry) && (consent.head !== head || consent.scope !== scope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks one untrusted native issue; never throws. */
async function checkIssue(raw: unknown, requiredPath?: string, allowedPath: (path: string) => boolean = isSyncablePath): Promise<{ kind: "valid"; issue: NativeIssue } | { kind: "invalid"; error: NativeError }> {
  const id = isRecord(raw) && typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 256 ? raw.id : null;
  const candidate = isRecord(raw) ? raw.path : undefined;
  const path = isValidPath(candidate) && allowedPath(candidate) && (requiredPath === undefined || candidate === requiredPath) ? candidate : null;
  const invalid = (detail: string) => ({ kind: "invalid" as const, error: { id, path, detail: `Native issue ${id ?? "with no readable id"}: ${detail}` } });
  if (!isRecord(raw)) return invalid("malformed issue");
  if (path === null) return invalid("unexpected path");
  if (id === null) return invalid("malformed id");
  const entry = async (value: unknown, label: string): Promise<Entry | null> => (value === null ? null : verifyEntry(`native issue ${id} ${label}`, value));
  try {
    const expected = await entry(raw.expected, "expected");
    const next = await entry(raw.next, "next");
    if (raw.kind === "interrupted" || raw.kind === "displaced") {
      if (raw.sourcePath !== undefined && (!isValidPath(raw.sourcePath) || typeof raw.sourcePath !== "string")) return invalid("malformed source path");
      return { kind: "valid", issue: { id, path, kind: raw.kind, ...(typeof raw.sourcePath === "string" ? { sourcePath: raw.sourcePath } : {}), expected, next, found: await entry(raw.found, "found") } };
    }
    if (raw.kind === "oversize") {
      const { sourcePath, size, mtime } = raw;
      if (typeof sourcePath !== "string" || sourcePath.length === 0) return invalid("malformed source path");
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return invalid("malformed size");
      if (mtime !== null && (typeof mtime !== "number" || !Number.isFinite(mtime))) return invalid("malformed modification time");
      return { kind: "valid", issue: { id, path, kind: "oversize", sourcePath, size, mtime, expected, next } };
    }
    return invalid("unknown kind");
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "unverifiable bytes");
  }
}

function sameCarry(a: Record<string, Ref | null>, b: Record<string, Ref | null>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((path) => Object.hasOwn(b, path) && sameRef(a[path], b[path]));
}

/** The ledger fields of a non-legacy publish operation, sharing its publication state. */
function ledgerView(operation: PublishOperation): LedgerPublication {
  const view = {
    id: operation.id,
    parent: operation.parent,
    candidate: operation.candidate,
    receipt: operation.receipt!,
    anchor: operation.anchor,
    get publication() {
      return operation.publication as LedgerPublication["publication"];
    },
    set publication(value: LedgerPublication["publication"]) {
      operation.publication = value;
    },
  };
  return view;
}
