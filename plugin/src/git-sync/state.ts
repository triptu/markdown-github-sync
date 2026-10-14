// Durable session state and its boundary parser. Everything loaded from the
// DurableStore is untrusted until `parseState` has checked shape, scope,
// references and blob hashes.
import type { RepositoryIdentity } from "./contracts";
import type { ChoiceKind, NativeConflictKind, VersionConflictKind } from "./reconcile";
import { choicesFor } from "./reconcile";
import { dictionary as safeDictionary, decodeBase64, hashBlob, isFileMode, isOid, isValidPath } from "./codec";
import type { Manifest, Ref } from "./codec";
import type { ScopeRules } from "./scope";
import { compileScope } from "./scope";

export const STATE_FORMAT = "github-vault-sync/4";

/**
 * `interrupted`/`displaced`: the vault reported native evidence for the path;
 * the operation never writes it again and a durable hold takes over.
 */
export type StepStatus = "pending" | "applied" | "changed" | "blocked" | "kept" | "interrupted" | "displaced";

export interface StoredStep {
  path: string;
  expected: Ref | null;
  next: Ref | null;
  status: StepStatus;
  /** Conflict id when the step implements a user decision; consent is the exact (expected, next) pair. */
  decision: string | null;
  /** Adapter explanation for `blocked`. */
  reason: string | null;
}

export type StoredChoice =
  | { kind: "mine" }
  | { kind: "remote" }
  | { kind: "both" }
  | { kind: "edit"; entry: Ref }
  | { kind: "expected" }
  | { kind: "next" }
  | { kind: "found" };

/** Retained hidden bytes too large to ingest; only the vault holds them. */
export interface OversizeEvidence {
  id: string;
  sourcePath: string;
  size: number;
  mtime: number | null;
}

/** A durable per-path native hold; its versions' bytes are pinned in recovery. */
export interface StoredHold {
  /** Every vault issue id merged into this hold. */
  ids: string[];
  /** `oversize`: every issue so far was oversize evidence (no ingested `found`). */
  kind: "interrupted" | "displaced" | "oversize";
  /**
   * The effective base of the path when the hold was created. Fixed for the
   * hold's lifetime so its conflict identity does not drift with the
   * checkpoint. Null for an absent base.
   */
  base: Ref | null;
  expected: Ref | null;
  next: Ref | null;
  /** The latest unexpected version; earlier ones stay in pinned recovery records. */
  found: Ref | null;
  oversize: OversizeEvidence[];
}

/** A native issue the engine could not verify. It is never acknowledged; its scope stays held. */
export interface NativeError {
  /** Issue id when readable. */
  id: string | null;
  /** The affected syncable path; null when unknown, which fails the whole vault closed. */
  path: string | null;
  detail: string;
}

export type StoredConflict =
  | {
      kind: VersionConflictKind;
      id: string;
      path: string;
      base: Ref | null;
      local: Ref | null;
      remote: Ref | null;
      choices: ChoiceKind[];
      sibling: string | null;
    }
  | { kind: "collision"; id: string; paths: string[] }
  | { kind: "bulk-deletion"; id: string; direction: "local" | "remote"; paths: string[] }
  | {
      kind: NativeConflictKind;
      id: string;
      path: string;
      base: Ref | null;
      local: Ref | null;
      remote: Ref | null;
      expected: Ref | null;
      next: Ref | null;
      found: Ref | null;
      oversize: OversizeEvidence[];
    };

export interface CommitRef {
  commit: string;
  tree: string;
}

/**
 * Ledger settlement state of a publication. `dispatched`: the request may be
 * in flight; only a ledger read decides it. `sealing`: the seal identity is
 * durable and is the only cancellation ever dispatched for this operation.
 */
export type Publication = { phase: "dispatched" } | { phase: "sealing"; seal: string };

/**
 * A candidate recorded before publication: an atomic `branch parent ->
 * candidate`, `ledger anchor -> receipt` request settled only by the ledger value.
 */
export interface PublishOperation {
  kind: "publish";
  id: string;
  parent: string;
  candidate: CommitRef;
  /** Receipt commit identity, durable before the first dispatch. */
  receipt: string;
  /** Ledger value the publication CASes from; equals `StoredState.ledger.anchor`. */
  anchor: string | null;
  publication: Publication;
  target: Manifest;
  steps: StoredStep[];
  recoveryId: string | null;
  incomingRecoveryId: string | null;
  /** Always null; a fixed field of the stored record. */
  fence: null;
}

/** Local application of a commit known to be accepted. */
export interface ApplyOperation {
  kind: "apply";
  id: string;
  target: CommitRef & { files: Manifest };
  steps: StoredStep[];
  recoveryId: string | null;
  incomingRecoveryId: string | null;
  /** Always false; a fixed field of the stored record. */
  replan: false;
}

/** A reviewed historical version being installed as a local draft, not a checkpoint. */
export interface RestoreOperation {
  kind: "restore";
  id: string;
  sourceCommit: string;
  baseCommit: string;
  step: StoredStep;
  recoveryId: string | null;
  incomingRecoveryId: string;
}

/** Explicitly reviewed config writes. The operation is durable before a native apply. */
export interface ConfigurationOperation {
  kind: "configuration";
  id: string;
  baseCommit: string;
  steps: StoredStep[];
  recoveryId: string | null;
  incomingRecoveryId: string | null;
  /** The host that reviewed this apply, retained across a plugin reload. */
  hostLifetimeId: string | null;
}

export interface ConfigurationGuard {
  hostLifetimeId: string | null;
  applied: Ref | null;
  consent: { version: Ref | null; head: string; scope: string } | null;
}

export type Operation = PublishOperation | ApplyOperation | RestoreOperation | ConfigurationOperation;

export type PauseReason = "repository-changed" | "history-rewritten" | "base-mismatch" | "ledger-diverged" | "duplicate-installation" | "scope-unreadable";

export interface Pause {
  reason: PauseReason;
  detail: string;
}

/** `migration` is accepted in stored records; the engine never creates it. */
export type RecoveryReason = "sync" | "enrollment" | "restore" | "incoming" | "carried" | "publication-recovery" | "conflict-edit" | "migration" | "native";

/** Immutable copy of local bytes taken before publication or replacement. */
export interface RecoveryRecord {
  id: string;
  createdAt: string;
  reason: RecoveryReason;
  /** Checkpoint commit when the record was made. */
  commit: string;
  files: Manifest;
  /** True while some bytes may exist nowhere else; such records are never pruned automatically. */
  pinned: boolean;
}

/** This installation's publication ledger. */
export interface Ledger {
  ref: string;
  /** The last ledger value durably settled by this device; changes only in a settlement save. */
  anchor: string | null;
}

export interface StoredState {
  format: typeof STATE_FORMAT;
  repository: RepositoryIdentity;
  ledger: Ledger;
  /** The coherent checkpoint: a commit fully applied to this vault. */
  base: CommitRef & { files: Manifest };
  scope: Readonly<ScopeRules> & { digest: string };
  /** A live configuration version awaiting reviewed application. */
  deferred: Record<string, { expected: Ref | null; next: Ref | null; commit: string; blockedReason: string | null }>;
  /** One-shot authorization for an exact new local hidden version. */
  hiddenConsent: Record<string, Ref>;
  /** Same-host config writer reversals require exact-version review. */
  configurationGuards: Record<string, ConfigurationGuard>;
  /** Paths re-entering after an excluded checkpoint have no remembered merge base. */
  reentry: string[];
  /**
   * Paths whose live local content descends from a version other than the
   * checkpoint's (newer edits preserved during application, enrollment
   * classifications). `null` means "derived from absence".
   */
  carry: Record<string, Ref | null>;
  operation: Operation | null;
  pause: Pause | null;
  review: { head: string; conflicts: StoredConflict[] } | null;
  /** Decisions by conflict id; ids bind exact versions (bulk guards also bind head and local manifest). */
  decisions: Record<string, StoredChoice>;
  /** Native holds by path: never planned automatically until a decision makes the chosen version live. */
  holds: Record<string, StoredHold>;
  /** Ingested vault issue ids not yet acknowledged to the vault. */
  unacknowledged: string[];
  /** Unverifiable native issues from the latest recovery pass. */
  nativeErrors: NativeError[];
  recovery: RecoveryRecord[];
  /** Content-addressed bytes (base64) referenced by carry, decisions, review, holds and recovery. */
  blobs: Record<string, string>;
  counter: number;
}

export class CorruptStateError extends Error {
  override name = "CorruptStateError";
}

// ---------------------------------------------------------------------------

function fail(at: string, problem: string): never {
  throw new CorruptStateError(`${at}: ${problem}`);
}

function object(value: unknown, at: string, keys: readonly string[]): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "expected an object");
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(at, `expected keys ${wanted.join(",")}, found ${actual.join(",")}`);
  }
  return value;
}

function dictionary(value: unknown, at: string): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "expected an object");
  return Object.entries(value);
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail(at, "expected an array");
  return value;
}

const field = (value: object, key: string): unknown => Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) fail(at, "expected a non-empty string");
  return value;
}

function oid(value: unknown, at: string): string {
  if (!isOid(value)) fail(at, "expected a 40-hex object ID");
  return value;
}

function path(value: unknown, at: string): string {
  if (!isValidPath(value)) fail(at, "expected a structurally safe path");
  const parts = value.split("/");
  if (parts.some((part) => part === ".git" || part === ".git-vault-sync" || part.startsWith(".git-vault-sync-export-") || part === ".trash" || part === ".DS_Store" || part === "Thumbs.db" || part === "desktop.ini")) fail(at, "protected path");
  if (parts[0] === ".obsidian" && (parts[1] === "workspace" || parts[1] === "workspace.json" || parts[1] === "workspace-mobile.json" || parts[1] === "cache" ||
    (parts[1] === "plugins" && ["github-vault-sync", "obsidian-git", "obsidian-livesync", "remotely-save", "remotely-sync", "cloud-vault-sync"].includes(parts[2] ?? "")))) fail(at, "protected configuration path");
  return value;
}

function nullable<T>(value: unknown, at: string, parse: (value: unknown, at: string) => T): T | null {
  return value === null ? null : parse(value, at);
}

function literal<T extends string>(value: unknown, at: string, options: readonly T[]): T {
  const match = options.find((option) => option === value);
  if (match === undefined) fail(at, `expected one of ${options.join(",")}`);
  return match;
}

function ref(value: unknown, at: string): Ref {
  const raw = object(value, at, ["oid", "mode"]);
  const mode = field(raw, "mode");
  if (!isFileMode(mode)) fail(`${at}.mode`, "unsupported file mode");
  return { oid: oid(field(raw, "oid"), `${at}.oid`), mode };
}

function manifest(value: unknown, at: string): Manifest {
  const result: Manifest = safeDictionary();
  for (const [key, entry] of dictionary(value, at)) result[path(key, at)] = ref(entry, `${at}[${key}]`);
  return result;
}

function commitRef(raw: object, at: string): CommitRef {
  return { commit: oid(field(raw, "commit"), `${at}.commit`), tree: oid(field(raw, "tree"), `${at}.tree`) };
}

const VERSION_KINDS: readonly VersionConflictKind[] = [
  "content",
  "add-add",
  "local-deleted-remote-edited",
  "local-edited-remote-deleted",
];
const STEP_STATUSES: readonly StepStatus[] = ["pending", "applied", "changed", "blocked", "kept", "interrupted", "displaced"];
const PAUSE_REASONS: readonly PauseReason[] = ["repository-changed", "history-rewritten", "base-mismatch", "ledger-diverged", "duplicate-installation", "scope-unreadable"];
const RECOVERY_REASONS: readonly RecoveryReason[] = ["sync", "enrollment", "restore", "incoming", "carried", "publication-recovery", "conflict-edit", "migration", "native"];
const CHOICE_KINDS: readonly ChoiceKind[] = ["mine", "remote", "both", "edit", "expected", "next", "found"];

function step(value: unknown, at: string): StoredStep {
  const raw = object(value, at, ["path", "expected", "next", "status", "decision", "reason"]);
  const status = literal(field(raw, "status"), `${at}.status`, STEP_STATUSES);
  const reason = nullable(field(raw, "reason"), `${at}.reason`, text);
  if ((status === "blocked") !== (reason !== null)) fail(at, "blocked steps, and only they, carry a reason");
  const expected = nullable(field(raw, "expected"), `${at}.expected`, ref);
  const next = nullable(field(raw, "next"), `${at}.next`, ref);
  if (!expected && !next) fail(at, "a step must change something");
  return { path: path(field(raw, "path"), `${at}.path`), expected, next, status, decision: nullable(field(raw, "decision"), `${at}.decision`, oid), reason };
}

function steps(value: unknown, at: string): StoredStep[] {
  const parsed = array(value, at).map((item, index) => step(item, `${at}[${index}]`));
  if (new Set(parsed.map((item) => item.path)).size !== parsed.length) fail(at, "duplicate step path");
  return parsed;
}

function publication(value: unknown, at: string): Publication {
  if (typeof value !== "object" || value === null) fail(at, "expected publication state");
  const phase = literal(field(value, "phase"), `${at}.phase`, ["dispatched", "sealing"] as const);
  if (phase === "sealing") {
    const raw = object(value, at, ["phase", "seal"]);
    return { phase, seal: oid(field(raw, "seal"), `${at}.seal`) };
  }
  object(value, at, ["phase"]);
  return { phase };
}

function operation(value: unknown, at: string): Operation {
  if (typeof value !== "object" || value === null) fail(at, "expected an object");
  const kind = literal(field(value, "kind"), `${at}.kind`, ["publish", "apply", "restore", "configuration"] as const);
  if (kind === "configuration") {
    const raw = object(value, at, ["kind", "id", "baseCommit", "steps", "recoveryId", "incomingRecoveryId", "hostLifetimeId"]);
    const parsed = steps(field(raw, "steps"), `${at}.steps`);
    if (parsed.length === 0 || parsed.some((item) => item.decision !== null || item.status === "kept")) fail(`${at}.steps`, "configuration needs reviewed write steps");
    return { kind, id: text(field(raw, "id"), `${at}.id`), baseCommit: oid(field(raw, "baseCommit"), `${at}.baseCommit`), steps: parsed,
      recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text), incomingRecoveryId: nullable(field(raw, "incomingRecoveryId"), `${at}.incomingRecoveryId`, text),
      hostLifetimeId: nullable(field(raw, "hostLifetimeId"), `${at}.hostLifetimeId`, text) };
  }
  if (kind === "restore") {
    const raw = object(value, at, ["kind", "id", "sourceCommit", "baseCommit", "step", "recoveryId", "incomingRecoveryId"]);
    const parsedStep = step(field(raw, "step"), `${at}.step`);
    if (parsedStep.next === null || parsedStep.decision !== null || !["pending", "blocked"].includes(parsedStep.status)) fail(`${at}.step`, "restore needs an unfinished historical write");
    return {
      kind,
      id: text(field(raw, "id"), `${at}.id`),
      sourceCommit: oid(field(raw, "sourceCommit"), `${at}.sourceCommit`),
      baseCommit: oid(field(raw, "baseCommit"), `${at}.baseCommit`),
      step: parsedStep,
      recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
      incomingRecoveryId: text(field(raw, "incomingRecoveryId"), `${at}.incomingRecoveryId`),
    };
  }
  if (kind === "publish") {
    const raw = object(value, at, ["kind", "id", "parent", "candidate", "receipt", "anchor", "publication", "target", "steps", "recoveryId", "incomingRecoveryId", "fence"]);
    if (field(raw, "fence") !== null) fail(`${at}.fence`, "expected null");
    const op: PublishOperation = {
      kind,
      id: text(field(raw, "id"), `${at}.id`),
      parent: oid(field(raw, "parent"), `${at}.parent`),
      candidate: commitRef(object(field(raw, "candidate"), `${at}.candidate`, ["commit", "tree"]), `${at}.candidate`),
      receipt: oid(field(raw, "receipt"), `${at}.receipt`),
      anchor: nullable(field(raw, "anchor"), `${at}.anchor`, oid),
      publication: publication(field(raw, "publication"), `${at}.publication`),
      target: manifest(field(raw, "target"), `${at}.target`),
      steps: steps(field(raw, "steps"), `${at}.steps`),
      recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
      incomingRecoveryId: nullable(field(raw, "incomingRecoveryId"), `${at}.incomingRecoveryId`, text),
      fence: null,
    };
    const identities = [op.parent, op.candidate.commit, op.receipt, op.anchor, op.publication.phase === "sealing" ? op.publication.seal : null].filter((item) => item !== null);
    if (new Set(identities).size !== identities.length) fail(at, "publication identities must be distinct");
    return op;
  }
  const raw = object(value, at, ["kind", "id", "target", "steps", "recoveryId", "incomingRecoveryId", "replan"]);
  if (field(raw, "replan") !== false) fail(`${at}.replan`, "expected false");
  const target = object(field(raw, "target"), `${at}.target`, ["commit", "tree", "files"]);
  return {
    kind,
    id: text(field(raw, "id"), `${at}.id`),
    target: { ...commitRef(target, `${at}.target`), files: manifest(field(target, "files"), `${at}.target.files`) },
    steps: steps(field(raw, "steps"), `${at}.steps`),
    recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
    incomingRecoveryId: nullable(field(raw, "incomingRecoveryId"), `${at}.incomingRecoveryId`, text),
    replan: false,
  };
}

function conflict(value: unknown, at: string): StoredConflict {
  if (typeof value !== "object" || value === null) fail(at, "expected an object");
  if (field(value, "kind") === "collision") {
    const raw = object(value, at, ["kind", "id", "paths"]);
    const paths = array(field(raw, "paths"), `${at}.paths`).map((item, index) => path(item, `${at}.paths[${index}]`));
    if (paths.length < 2) fail(at, "a collision needs at least two paths");
    return { kind: "collision", id: oid(field(raw, "id"), `${at}.id`), paths };
  }
  if (field(value, "kind") === "bulk-deletion") {
    const raw = object(value, at, ["kind", "id", "direction", "paths"]);
    const paths = array(field(raw, "paths"), `${at}.paths`).map((item, index) => path(item, `${at}.paths[${index}]`));
    if (paths.length === 0 || new Set(paths).size !== paths.length) fail(at, "a bulk deletion needs distinct paths");
    return { kind: "bulk-deletion", id: oid(field(raw, "id"), `${at}.id`), direction: literal(field(raw, "direction"), `${at}.direction`, ["local", "remote"] as const), paths };
  }
  const nativeKind = field(value, "kind");
  if (nativeKind === "interrupted-write" || nativeKind === "displaced-write" || nativeKind === "oversize-write") {
    const raw = object(value, at, ["kind", "id", "path", "base", "local", "remote", "expected", "next", "found", "oversize"]);
    const version = (key: string) => nullable(field(raw, key), `${at}.${key}`, ref);
    const found = version("found");
    if (nativeKind === "oversize-write" && found !== null) fail(`${at}.found`, "oversize evidence has no ingested bytes");
    return {
      kind: nativeKind,
      id: oid(field(raw, "id"), `${at}.id`),
      path: path(field(raw, "path"), `${at}.path`),
      base: version("base"), local: version("local"), remote: version("remote"),
      expected: version("expected"), next: version("next"), found,
      oversize: oversizeList(field(raw, "oversize"), `${at}.oversize`),
    };
  }
  const raw = object(value, at, ["kind", "id", "path", "base", "local", "remote", "choices", "sibling"]);
  const kind = literal(field(raw, "kind"), `${at}.kind`, VERSION_KINDS);
  const choices = array(field(raw, "choices"), `${at}.choices`).map((item, index) => literal(item, `${at}.choices[${index}]`, CHOICE_KINDS));
  const sibling = nullable(field(raw, "sibling"), `${at}.sibling`, path);
  const allowed = choicesFor(kind).filter((choice) => choice !== "both" || sibling !== null);
  if (choices.length !== allowed.length || choices.some((choice, index) => choice !== allowed[index])) fail(at, "choices do not match kind");
  return {
    kind,
    id: oid(field(raw, "id"), `${at}.id`),
    path: path(field(raw, "path"), `${at}.path`),
    base: nullable(field(raw, "base"), `${at}.base`, ref),
    local: nullable(field(raw, "local"), `${at}.local`, ref),
    remote: nullable(field(raw, "remote"), `${at}.remote`, ref),
    choices,
    sibling,
  };
}

function choice(value: unknown, at: string): StoredChoice {
  if (typeof value !== "object" || value === null) fail(at, "expected an object");
  const kind = literal(field(value, "kind"), `${at}.kind`, CHOICE_KINDS);
  if (kind === "edit") {
    const raw = object(value, at, ["kind", "entry"]);
    return { kind, entry: ref(field(raw, "entry"), `${at}.entry`) };
  }
  object(value, at, ["kind"]);
  return { kind };
}

function oversizeList(value: unknown, at: string): OversizeEvidence[] {
  const items = array(value, at).map((item, index) => {
    const where = `${at}[${index}]`;
    const raw = object(item, where, ["id", "sourcePath", "size", "mtime"]);
    const size = field(raw, "size");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) fail(`${where}.size`, "expected a positive size");
    const mtime = field(raw, "mtime");
    if (mtime !== null && (typeof mtime !== "number" || !Number.isFinite(mtime))) fail(`${where}.mtime`, "expected a timestamp or null");
    return { id: text(field(raw, "id"), `${where}.id`), sourcePath: text(field(raw, "sourcePath"), `${where}.sourcePath`), size, mtime };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(at, "duplicate oversize id");
  return items;
}

function hold(value: unknown, at: string): StoredHold {
  const raw = object(value, at, ["ids", "kind", "base", "expected", "next", "found", "oversize"]);
  const ids = array(field(raw, "ids"), `${at}.ids`).map((item, index) => text(item, `${at}.ids[${index}]`));
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail(`${at}.ids`, "expected distinct issue ids");
  const kind = literal(field(raw, "kind"), `${at}.kind`, ["interrupted", "displaced", "oversize"] as const);
  const found = nullable(field(raw, "found"), `${at}.found`, ref);
  const oversize = oversizeList(field(raw, "oversize"), `${at}.oversize`);
  if (kind === "oversize" && (found !== null || oversize.length === 0)) fail(at, "an oversize hold has evidence metadata and no ingested bytes");
  if (oversize.some((item) => !ids.includes(item.id))) fail(`${at}.oversize`, "oversize evidence must belong to the hold");
  return {
    ids,
    kind,
    base: nullable(field(raw, "base"), `${at}.base`, ref),
    expected: nullable(field(raw, "expected"), `${at}.expected`, ref),
    next: nullable(field(raw, "next"), `${at}.next`, ref),
    found,
    oversize,
  };
}

function nativeError(value: unknown, at: string): NativeError {
  const raw = object(value, at, ["id", "path", "detail"]);
  return {
    id: nullable(field(raw, "id"), `${at}.id`, text),
    path: nullable(field(raw, "path"), `${at}.path`, path),
    detail: text(field(raw, "detail"), `${at}.detail`),
  };
}

function identity(value: unknown, at: string): RepositoryIdentity {
  const raw = object(value, at, ["id", "owner", "name", "branch"]);
  return {
    id: text(field(raw, "id"), `${at}.id`),
    owner: text(field(raw, "owner"), `${at}.owner`),
    name: text(field(raw, "name"), `${at}.name`),
    branch: text(field(raw, "branch"), `${at}.branch`),
  };
}

function ledger(value: unknown, at: string): Ledger {
  const raw = object(value, at, ["ref", "anchor"]);
  const name = text(field(raw, "ref"), `${at}.ref`);
  if (!/^refs\/vault-sync\/devices\/[A-Za-z0-9-]+$/.test(name)) fail(`${at}.ref`, "expected a device ledger ref");
  return { ref: name, anchor: nullable(field(raw, "anchor"), `${at}.anchor`, oid) };
}

function recovery(value: unknown, at: string): RecoveryRecord {
  const raw = object(value, at, ["id", "createdAt", "reason", "commit", "files", "pinned"]);
  const createdAt = text(field(raw, "createdAt"), `${at}.createdAt`);
  if (Number.isNaN(Date.parse(createdAt))) fail(`${at}.createdAt`, "expected a timestamp");
  const pinned = field(raw, "pinned");
  if (typeof pinned !== "boolean") fail(`${at}.pinned`, "expected a boolean");
  return {
    id: text(field(raw, "id"), `${at}.id`),
    createdAt,
    reason: literal(field(raw, "reason"), `${at}.reason`, RECOVERY_REASONS),
    commit: oid(field(raw, "commit"), `${at}.commit`),
    files: manifest(field(raw, "files"), `${at}.files`),
    pinned,
  };
}

/** Every blob the state promises to hold locally. */
export function referencedBlobs(state: Omit<StoredState, "blobs">): Set<string> {
  const oids = new Set<string>();
  for (const item of Object.values(state.deferred)) for (const entry of [item.expected, item.next]) if (entry) oids.add(entry.oid);
  for (const entry of Object.values(state.carry)) if (entry) oids.add(entry.oid);
  for (const guard of Object.values(state.configurationGuards)) for (const entry of [guard.applied, guard.consent?.version]) if (entry) oids.add(entry.oid);
  for (const decision of Object.values(state.decisions)) if (decision.kind === "edit") oids.add(decision.entry.oid);
  for (const item of state.review?.conflicts ?? []) {
    if (item.kind === "collision" || item.kind === "bulk-deletion") continue;
    const native = item.kind === "interrupted-write" || item.kind === "displaced-write" || item.kind === "oversize-write" ? [item.expected, item.next, item.found] : [];
    for (const entry of [item.base, item.local, item.remote, ...native]) if (entry) oids.add(entry.oid);
  }
  for (const item of Object.values(state.holds)) for (const entry of [item.base, item.expected, item.next, item.found]) if (entry) oids.add(entry.oid);
  for (const record of state.recovery) for (const entry of Object.values(record.files)) oids.add(entry.oid);
  return oids;
}

/**
 * Blob bodies the previous parse verified, keyed by object ID. A blob is
 * skipped only when its base64 text is identical to a verified one, so the
 * check is a pure function of (id, data) and stays correct across states.
 */
let verifiedBlobs = new Map<string, string>();

/** Parses untrusted stored data. `undefined`/`null` mean "never enrolled". */
export async function parseState(value: unknown): Promise<StoredState> {
  const at = "state";
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "expected an object");
  if (field(value, "format") !== STATE_FORMAT) fail(`${at}.format`, "unsupported state format");
  const raw = object(value, at, [
    "format", "repository", "ledger", "base", "scope", "deferred", "hiddenConsent", "configurationGuards", "reentry",
    "carry", "operation", "pause", "review", "decisions", "holds", "unacknowledged", "nativeErrors", "recovery", "blobs", "counter",
  ]);
  const base = object(field(raw, "base"), `${at}.base`, ["commit", "tree", "files"]);
  const baseCommit = oid(field(base, "commit"), `${at}.base.commit`);
  const carry: Record<string, Ref | null> = safeDictionary();
  for (const [key, entry] of dictionary(field(raw, "carry"), `${at}.carry`)) {
    carry[path(key, `${at}.carry`)] = nullable(entry, `${at}.carry[${key}]`, ref);
  }
  const pause = nullable(field(raw, "pause"), `${at}.pause`, (value, at) => {
    const item = object(value, at, ["reason", "detail"]);
    return { reason: literal(field(item, "reason"), `${at}.reason`, PAUSE_REASONS), detail: text(field(item, "detail"), `${at}.detail`) };
  });
  const review = nullable(field(raw, "review"), `${at}.review`, (value, at) => {
    const item = object(value, at, ["head", "conflicts"]);
    return {
      head: oid(field(item, "head"), `${at}.head`),
      conflicts: array(field(item, "conflicts"), `${at}.conflicts`).map((entry, index) => conflict(entry, `${at}.conflicts[${index}]`)),
    };
  });
  const decisions: Record<string, StoredChoice> = safeDictionary();
  for (const [key, entry] of dictionary(field(raw, "decisions"), `${at}.decisions`)) {
    decisions[oid(key, `${at}.decisions`)] = choice(entry, `${at}.decisions[${key}]`);
  }
  const nativeErrors = array(field(raw, "nativeErrors"), `${at}.nativeErrors`).map((item, index) => nativeError(item, `${at}.nativeErrors[${index}]`));
  const holds: Record<string, StoredHold> = safeDictionary();
  for (const [key, entry] of dictionary(field(raw, "holds"), `${at}.holds`)) holds[path(key, `${at}.holds`)] = hold(entry, `${at}.holds[${key}]`);
  const unacknowledged = array(field(raw, "unacknowledged"), `${at}.unacknowledged`).map((item, index) => text(item, `${at}.unacknowledged[${index}]`));
  if (new Set(unacknowledged).size !== unacknowledged.length) fail(`${at}.unacknowledged`, "duplicate issue id");
  const records = array(field(raw, "recovery"), `${at}.recovery`).map((entry, index) => recovery(entry, `${at}.recovery[${index}]`));
  if (new Set(records.map((record) => record.id)).size !== records.length) fail(`${at}.recovery`, "duplicate record id");
  const counter = field(raw, "counter");
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) fail(`${at}.counter`, "expected a counter");
  const op = nullable(field(raw, "operation"), `${at}.operation`, operation);
  const stateLedger = ledger(field(raw, "ledger"), `${at}.ledger`);
  if (op) {
    if (op.kind === "publish" && op.anchor !== stateLedger.anchor) fail(`${at}.operation.anchor`, "publication anchor differs from the ledger anchor");
    // Every byte an operation may overwrite must be in its recovery record.
    const record = records.find((item) => item.id === op.recoveryId);
    if (op.recoveryId && !record) fail(`${at}.operation.recoveryId`, "missing recovery record");
    const operationSteps = op.kind === "restore" ? [op.step] : op.steps;
    if (op.kind === "restore" && op.baseCommit !== baseCommit) fail(`${at}.operation.baseCommit`, "restore checkpoint changed");
    if (op.kind === "configuration" && op.baseCommit !== baseCommit) fail(`${at}.operation.baseCommit`, "configuration checkpoint changed");
    for (const item of operationSteps) {
      const saved = record?.files[item.path];
      if (item.expected && !(saved && saved.oid === item.expected.oid && saved.mode === item.expected.mode)) {
        fail(`${at}.operation.steps`, `no preimage recorded for ${item.path}`);
      }
    }
    const incomingRecord = records.find((item) => item.id === op.incomingRecoveryId);
    if (op.incomingRecoveryId && !incomingRecord) fail(`${at}.operation.incomingRecoveryId`, "missing incoming recovery record");
    const target = op.kind === "publish" ? op.target : op.kind === "apply" ? op.target.files : null;
    for (const item of operationSteps) {
      const saved = incomingRecord?.files[item.path];
      const intended = target?.[item.path] ?? (op.kind === "restore" || op.kind === "configuration" ? item.next : undefined);
      if (item.next && !(saved && intended && saved.oid === item.next.oid && saved.mode === item.next.mode && intended.oid === saved.oid && intended.mode === saved.mode)) {
        fail(`${at}.operation.incomingRecoveryId`, `no incoming bytes recorded for ${item.path}`);
      }
    }
  }

  const blobs: Record<string, string> = safeDictionary();
  const checked = new Map<string, string>();
  for (const [key, data] of dictionary(field(raw, "blobs"), `${at}.blobs`)) {
    const id = oid(key, `${at}.blobs`);
    if (typeof data !== "string") fail(`${at}.blobs[${key}]`, "expected base64 data");
    // Exactly these bytes already decoded canonically and hashed to this id.
    if (verifiedBlobs.get(id) === data) {
      checked.set(id, data);
      blobs[id] = data;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data);
    } catch {
      fail(`${at}.blobs[${key}]`, "invalid base64");
    }
    if ((await hashBlob(bytes)) !== id) fail(`${at}.blobs[${key}]`, "bytes do not match object ID");
    checked.set(id, data);
    blobs[id] = data;
  }
  // Bounded by one state's blob table; strings are shared with the parsed state.
  verifiedBlobs = checked;

  const rawScope = object(field(raw, "scope"), `${at}.scope`, ["rules", "configDir", "gitignore", "digest"]);
  const configDir = text(field(rawScope, "configDir"), `${at}.scope.configDir`);
  if (!isValidPath(configDir) || !configDir.startsWith(".") || configDir.includes("/")) fail(`${at}.scope.configDir`, "invalid config directory");
  const scope: StoredState["scope"] = {
    rules: literal(field(rawScope, "rules"), `${at}.scope.rules`, ["config/1"] as const),
    configDir,
    gitignore: nullable(field(rawScope, "gitignore"), `${at}.scope.gitignore`, oid),
    digest: oid(field(rawScope, "digest"), `${at}.scope.digest`),
  };
  const deferred: StoredState["deferred"] = safeDictionary();
  for (const [key, item] of dictionary(field(raw, "deferred"), `${at}.deferred`)) {
    const p = path(key, `${at}.deferred`);
    const entry = object(item, `${at}.deferred[${key}]`, ["expected", "next", "commit", "blockedReason"]);
    deferred[p] = { expected: nullable(field(entry, "expected"), `${at}.deferred.expected`, ref), next: nullable(field(entry, "next"), `${at}.deferred.next`, ref),
      commit: oid(field(entry, "commit"), `${at}.deferred.commit`), blockedReason: nullable(field(entry, "blockedReason"), `${at}.deferred.blockedReason`, text) };
  }
  const hiddenConsent: StoredState["hiddenConsent"] = safeDictionary();
  for (const [key, item] of dictionary(field(raw, "hiddenConsent"), `${at}.hiddenConsent`)) hiddenConsent[path(key, `${at}.hiddenConsent`)] = ref(item, `${at}.hiddenConsent[${key}]`);
  const configurationGuards: StoredState["configurationGuards"] = safeDictionary();
  for (const [key, item] of dictionary(field(raw, "configurationGuards"), `${at}.configurationGuards`)) {
    const p = path(key, `${at}.configurationGuards`);
    const guard = object(item, `${at}.configurationGuards[${key}]`, ["hostLifetimeId", "applied", "consent"]);
    const rawConsent = field(guard, "consent");
    const consent = rawConsent === null ? null : object(rawConsent, `${at}.configurationGuards[${key}].consent`, ["version", "head", "scope"]);
    configurationGuards[p] = {
      hostLifetimeId: nullable(field(guard, "hostLifetimeId"), `${at}.configurationGuards.hostLifetimeId`, text),
      applied: nullable(field(guard, "applied"), `${at}.configurationGuards.applied`, ref),
      consent: consent === null ? null : {
        version: nullable(field(consent, "version"), `${at}.configurationGuards.consent.version`, ref),
        head: oid(field(consent, "head"), `${at}.configurationGuards.consent.head`),
        scope: oid(field(consent, "scope"), `${at}.configurationGuards.consent.scope`),
      },
    };
  }
  const reentry = array(field(raw, "reentry"), `${at}.reentry`).map((item, index) => path(item, `${at}.reentry[${index}]`));
  if (new Set(reentry).size !== reentry.length) fail(`${at}.reentry`, "duplicate path");
  const state: StoredState = {
    format: STATE_FORMAT,
    repository: identity(field(raw, "repository"), `${at}.repository`),
    ledger: stateLedger,
    base: { commit: baseCommit, tree: oid(field(base, "tree"), `${at}.base.tree`), files: manifest(field(base, "files"), `${at}.base.files`) },
    scope,
    deferred,
    hiddenConsent,
    configurationGuards,
    reentry,
    carry,
    operation: op,
    pause,
    review,
    decisions,
    holds,
    unacknowledged,
    nativeErrors,
    recovery: records,
    blobs,
    counter,
  };
  for (const key of Object.keys(state.deferred)) {
    if (Object.hasOwn(state.carry, key) || Object.hasOwn(state.holds, key)) fail(`${at}.deferred`, `deferred path overlaps a carry or native hold: ${key}`);
    if (!key.startsWith(`${state.scope.configDir}/`)) fail(`${at}.deferred`, `deferred path is outside configuration: ${key}`);
  }
  for (const key of Object.keys(state.configurationGuards)) {
    if (!key.startsWith(`${state.scope.configDir}/`)) fail(`${at}.configurationGuards`, `guarded path is outside configuration: ${key}`);
  }
  const storedPaths = [
    ...Object.keys(state.base.files), ...Object.keys(state.carry), ...Object.keys(state.holds),
    ...Object.keys(state.deferred), ...Object.keys(state.hiddenConsent), ...Object.keys(state.configurationGuards), ...state.reentry,
    ...state.nativeErrors.flatMap((item) => item.path === null ? [] : [item.path]),
    ...(state.operation ? (state.operation.kind === "restore" ? [state.operation.step.path] : state.operation.steps.map((item) => item.path)) : []),
    ...(state.review?.conflicts.flatMap((item) => item.kind === "collision" || item.kind === "bulk-deletion" ? item.paths : [item.path]) ?? []),
    ...state.recovery.flatMap((record) => Object.keys(record.files)),
  ];
  const builtin = await compileScope({ rules: state.scope.rules, configDir: state.scope.configDir, gitignore: null }, null);
  if (storedPaths.some((item) => !builtin.includes(item))) fail(at, "state contains a path outside built-in scope");
  for (const id of referencedBlobs(state)) if (!Object.hasOwn(blobs, id)) fail(`${at}.blobs`, `missing referenced blob ${id}`);
  return state;
}
