// Durable session state and its boundary parser. Everything loaded from the
// DurableStore is untrusted until `parseState` has checked shape, scope,
// references and blob hashes.
import type { RepositoryIdentity } from "./contracts";
import type { ChoiceKind, NativeConflictKind, VersionConflictKind } from "./reconcile";
import { choicesFor } from "./reconcile";
import { dictionary as safeDictionary, decodeBase64, hashBlob, isFileMode, isOid, isSyncablePath } from "./codec";
import type { Manifest, Ref } from "./codec";

export const STATE_FORMAT = "github-vault-sync/3";

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
   * checkpoint. Null for an absent base (or a hold stored before bases were).
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
 * `legacy`: a /2 publication sent without a ledger update; it cannot be sealed.
 */
export type Publication = { phase: "dispatched" } | { phase: "sealing"; seal: string } | { phase: "legacy" };

/**
 * One ledger-protocol publication: an atomic `branch parent -> candidate`,
 * `ledger anchor -> receipt` request settled only by the ledger value.
 */
export interface LedgerPublication {
  id: string;
  parent: string;
  candidate: CommitRef;
  receipt: string;
  anchor: string | null;
  publication: { phase: "dispatched" } | { phase: "sealing"; seal: string };
}

/** A candidate recorded before publication. */
export interface PublishOperation {
  kind: "publish";
  id: string;
  parent: string;
  candidate: CommitRef;
  /** Receipt commit identity, durable before the first dispatch; null only for legacy operations. */
  receipt: string | null;
  /** Ledger value the publication CASes from; equals `StoredState.ledger.anchor`. */
  anchor: string | null;
  publication: Publication;
  target: Manifest;
  steps: StoredStep[];
  recoveryId: string | null;
  incomingRecoveryId: string | null;
  /**
   * Legacy only: a same-tree fence commit on the legacy parent, published
   * through the ledger so the branch leaves the parent and the unfenced /2
   * request (`parent -> candidate`) can never land. Durable before dispatch.
   */
  fence: LedgerPublication | null;
}

/** Local application of a commit known to be accepted. */
export interface ApplyOperation {
  kind: "apply";
  id: string;
  target: CommitRef & { files: Manifest };
  steps: StoredStep[];
  recoveryId: string | null;
  incomingRecoveryId: string | null;
  /** Migrated from /2: steps are re-planned from a fresh capture before any vault write. */
  replan: boolean;
}

export type Operation = PublishOperation | ApplyOperation;

export type PauseReason = "repository-changed" | "history-rewritten" | "base-mismatch" | "ledger-diverged" | "duplicate-installation";

export interface Pause {
  reason: PauseReason;
  detail: string;
}

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

/** This installation's publication ledger. `ref` is null only for a migrated /2 state not yet bound. */
export interface Ledger {
  ref: string | null;
  /** The last ledger value durably settled by this device; changes only in a settlement save. */
  anchor: string | null;
}

export interface StoredState {
  format: typeof STATE_FORMAT;
  repository: RepositoryIdentity;
  ledger: Ledger;
  /** The coherent checkpoint: a commit fully applied to this vault. */
  base: CommitRef & { files: Manifest };
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
  if (!isSyncablePath(value)) fail(at, "expected an in-scope path");
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
  "local-deletion",
  "remote-deletion",
];
const STEP_STATUSES: readonly StepStatus[] = ["pending", "applied", "changed", "blocked", "kept", "interrupted", "displaced"];
const LEGACY_STEP_STATUSES = ["pending", "applied", "changed", "blocked", "kept", "revoked"] as const;
const PAUSE_REASONS: readonly PauseReason[] = ["repository-changed", "history-rewritten", "base-mismatch", "ledger-diverged", "duplicate-installation"];
const RECOVERY_REASONS: readonly RecoveryReason[] = ["sync", "enrollment", "restore", "incoming", "carried", "publication-recovery", "conflict-edit", "migration", "native"];
const CHOICE_KINDS: readonly ChoiceKind[] = ["mine", "remote", "both", "edit", "expected", "next", "found"];

type Version = "1" | "2" | "3";

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

/** Validates a /1 or /2 step shape; migrated operations re-plan, so only shape matters. */
function legacySteps(value: unknown, at: string): void {
  for (const [index, item] of array(value, at).entries()) {
    const where = `${at}[${index}]`;
    if (typeof item !== "object" || item === null) fail(where, "expected an object");
    const raw = object(item, where, ["path", "expected", "next", "status", "reason", ...(Object.hasOwn(item, "consent") ? ["consent"] : [])]);
    path(field(raw, "path"), `${where}.path`);
    literal(field(raw, "status"), `${where}.status`, LEGACY_STEP_STATUSES);
    nullable(field(raw, "expected"), `${where}.expected`, ref);
    nullable(field(raw, "next"), `${where}.next`, ref);
  }
}

function ledgerPublication(value: unknown, at: string): LedgerPublication {
  const raw = object(value, at, ["id", "parent", "candidate", "receipt", "anchor", "publication"]);
  const phase = publication(field(raw, "publication"), `${at}.publication`);
  if (phase.phase === "legacy") fail(`${at}.publication`, "a ledger publication cannot be legacy");
  const item: LedgerPublication = {
    id: text(field(raw, "id"), `${at}.id`),
    parent: oid(field(raw, "parent"), `${at}.parent`),
    candidate: commitRef(object(field(raw, "candidate"), `${at}.candidate`, ["commit", "tree"]), `${at}.candidate`),
    receipt: oid(field(raw, "receipt"), `${at}.receipt`),
    anchor: nullable(field(raw, "anchor"), `${at}.anchor`, oid),
    publication: phase,
  };
  const identities = [item.parent, item.candidate.commit, item.receipt, item.anchor, phase.phase === "sealing" ? phase.seal : null].filter((entry) => entry !== null);
  if (new Set(identities).size !== identities.length) fail(at, "publication identities must be distinct");
  return item;
}

function publication(value: unknown, at: string): Publication {
  if (typeof value !== "object" || value === null) fail(at, "expected publication state");
  const phase = literal(field(value, "phase"), `${at}.phase`, ["dispatched", "sealing", "legacy"] as const);
  if (phase === "sealing") {
    const raw = object(value, at, ["phase", "seal"]);
    return { phase, seal: oid(field(raw, "seal"), `${at}.seal`) };
  }
  object(value, at, ["phase"]);
  return { phase };
}

function operation(value: unknown, at: string, version: Version): Operation {
  if (typeof value !== "object" || value === null) fail(at, "expected an object");
  const kind = literal(field(value, "kind"), `${at}.kind`, ["publish", "apply"] as const);
  if (version !== "3") {
    // /1 and /2 operations carried approval and consent metadata that v3
    // retires. Their steps are re-planned from a fresh capture; publication
    // uncertainty stays a conservative legacy hold that no seal can fence.
    const optional = (["approval", "incoming"] as const).filter((key) => Object.hasOwn(value, key));
    const keys = kind === "publish" ? ["kind", "id", "parent", "candidate", "target", "steps", "recoveryId", ...optional] : ["kind", "id", "target", "steps", "recoveryId", ...optional];
    const raw = object(value, at, keys);
    legacySteps(field(raw, "steps"), `${at}.steps`);
    const id = text(field(raw, "id"), `${at}.id`);
    const recoveryId = nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text);
    if (kind === "publish") {
      return {
        kind, id,
        parent: oid(field(raw, "parent"), `${at}.parent`),
        candidate: commitRef(object(field(raw, "candidate"), `${at}.candidate`, ["commit", "tree"]), `${at}.candidate`),
        receipt: null, anchor: null, publication: { phase: "legacy" },
        target: manifest(field(raw, "target"), `${at}.target`),
        steps: [], recoveryId, incomingRecoveryId: null, fence: null,
      };
    }
    const target = object(field(raw, "target"), `${at}.target`, ["commit", "tree", "files"]);
    return {
      kind, id,
      target: { ...commitRef(target, `${at}.target`), files: manifest(field(target, "files"), `${at}.target.files`) },
      steps: [], recoveryId, incomingRecoveryId: null, replan: true,
    };
  }
  if (kind === "publish") {
    // `fence` was added within /3; journals written before it have none.
    const raw = object(value, at, ["kind", "id", "parent", "candidate", "receipt", "anchor", "publication", "target", "steps", "recoveryId", "incomingRecoveryId", ...(Object.hasOwn(value, "fence") ? ["fence"] : [])]);
    const op: PublishOperation = {
      kind,
      id: text(field(raw, "id"), `${at}.id`),
      parent: oid(field(raw, "parent"), `${at}.parent`),
      candidate: commitRef(object(field(raw, "candidate"), `${at}.candidate`, ["commit", "tree"]), `${at}.candidate`),
      receipt: nullable(field(raw, "receipt"), `${at}.receipt`, oid),
      anchor: nullable(field(raw, "anchor"), `${at}.anchor`, oid),
      publication: publication(field(raw, "publication"), `${at}.publication`),
      target: manifest(field(raw, "target"), `${at}.target`),
      steps: steps(field(raw, "steps"), `${at}.steps`),
      recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
      incomingRecoveryId: nullable(field(raw, "incomingRecoveryId"), `${at}.incomingRecoveryId`, text),
      fence: nullable(field(raw, "fence") ?? null, `${at}.fence`, ledgerPublication),
    };
    const legacy = op.publication.phase === "legacy";
    if (op.fence && !legacy) fail(`${at}.fence`, "only legacy publications are fenced");
    if (op.fence && op.fence.parent !== op.parent) fail(`${at}.fence.parent`, "a fence extends the legacy parent");
    if (op.fence && [op.candidate.commit, op.fence.candidate.commit, op.fence.receipt].some((item, index, all) => all.indexOf(item) !== index)) fail(`${at}.fence`, "fence identities must be distinct from the legacy candidate");
    if (legacy !== (op.receipt === null)) fail(`${at}.receipt`, "only legacy publications lack a receipt");
    if (legacy && op.steps.length > 0) fail(`${at}.steps`, "legacy publications re-plan their steps");
    const identities = [op.parent, op.candidate.commit, op.receipt, op.anchor, op.publication.phase === "sealing" ? op.publication.seal : null].filter((item) => item !== null);
    if (new Set(identities).size !== identities.length) fail(at, "publication identities must be distinct");
    return op;
  }
  const raw = object(value, at, ["kind", "id", "target", "steps", "recoveryId", "incomingRecoveryId", "replan"]);
  const target = object(field(raw, "target"), `${at}.target`, ["commit", "tree", "files"]);
  const replan = field(raw, "replan");
  if (typeof replan !== "boolean") fail(`${at}.replan`, "expected a boolean");
  const op: ApplyOperation = {
    kind,
    id: text(field(raw, "id"), `${at}.id`),
    target: { ...commitRef(target, `${at}.target`), files: manifest(field(target, "files"), `${at}.target.files`) },
    steps: steps(field(raw, "steps"), `${at}.steps`),
    recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
    incomingRecoveryId: nullable(field(raw, "incomingRecoveryId"), `${at}.incomingRecoveryId`, text),
    replan,
  };
  if (replan && op.steps.length > 0) fail(`${at}.steps`, "re-planned operations carry no steps yet");
  return op;
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
    const hasOversize = Object.hasOwn(value, "oversize");
    const raw = object(value, at, ["kind", "id", "path", "base", "local", "remote", "expected", "next", "found", ...(hasOversize ? ["oversize"] : [])]);
    const version = (key: string) => nullable(field(raw, key), `${at}.${key}`, ref);
    const found = version("found");
    if (nativeKind === "oversize-write" && found !== null) fail(`${at}.found`, "oversize evidence has no ingested bytes");
    return {
      kind: nativeKind,
      id: oid(field(raw, "id"), `${at}.id`),
      path: path(field(raw, "path"), `${at}.path`),
      base: version("base"), local: version("local"), remote: version("remote"),
      expected: version("expected"), next: version("next"), found,
      oversize: hasOversize ? oversizeList(field(raw, "oversize"), `${at}.oversize`) : [],
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
  // `base` and `oversize` were added within /3; older holds have neither.
  const optional = (["base", "oversize"] as const).filter((key) => typeof value === "object" && value !== null && Object.hasOwn(value, key));
  const raw = object(value, at, ["ids", "kind", "expected", "next", "found", ...optional]);
  const ids = array(field(raw, "ids"), `${at}.ids`).map((item, index) => text(item, `${at}.ids[${index}]`));
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail(`${at}.ids`, "expected distinct issue ids");
  const kind = literal(field(raw, "kind"), `${at}.kind`, ["interrupted", "displaced", "oversize"] as const);
  const found = nullable(field(raw, "found"), `${at}.found`, ref);
  const oversize = optional.includes("oversize") ? oversizeList(field(raw, "oversize"), `${at}.oversize`) : [];
  if (kind === "oversize" && (found !== null || oversize.length === 0)) fail(at, "an oversize hold has evidence metadata and no ingested bytes");
  if (oversize.some((item) => !ids.includes(item.id))) fail(`${at}.oversize`, "oversize evidence must belong to the hold");
  return {
    ids,
    kind,
    base: optional.includes("base") ? nullable(field(raw, "base"), `${at}.base`, ref) : null,
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
  const name = nullable(field(raw, "ref"), `${at}.ref`, text);
  if (name !== null && !/^refs\/vault-sync\/devices\/[A-Za-z0-9-]+$/.test(name)) fail(`${at}.ref`, "expected a device ledger ref");
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
  for (const entry of Object.values(state.carry)) if (entry) oids.add(entry.oid);
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

/** Parses untrusted stored data, migrating /1 and /2. `undefined`/`null` mean "never enrolled". */
export async function parseState(value: unknown): Promise<StoredState> {
  const at = "state";
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "expected an object");
  const format = field(value, "format");
  const version: Version | null = format === STATE_FORMAT ? "3" : format === "github-vault-sync/2" ? "2" : format === "github-vault-sync/1" ? "1" : null;
  if (!version) fail(`${at}.format`, "unsupported state format");
  const raw = object(value, at, [
    "format",
    ...(version === "2" && Object.hasOwn(value, "observation") ? ["observation"] : []),
    "repository",
    ...(version === "3" ? ["ledger"] : []),
    "base",
    "carry",
    "operation",
    "pause",
    "review",
    "decisions",
    ...(version === "3" ? ["holds", "unacknowledged"] : []),
    ...(version === "3" && Object.hasOwn(value, "nativeErrors") ? ["nativeErrors"] : []),
    "recovery",
    "blobs",
    "counter",
  ]);
  if (version === "2" && Object.hasOwn(raw, "observation")) literal(field(raw, "observation"), `${at}.observation`, ["settled", "pending"] as const);
  const base = object(field(raw, "base"), `${at}.base`, ["commit", "tree", "files"]);
  const carry: Record<string, Ref | null> = safeDictionary();
  for (const [key, entry] of dictionary(field(raw, "carry"), `${at}.carry`)) {
    carry[path(key, `${at}.carry`)] = nullable(entry, `${at}.carry[${key}]`, ref);
  }
  const pauseRaw = field(raw, "pause");
  const pause =
    pauseRaw === null
      ? null
      : (() => {
          const item = object(pauseRaw, `${at}.pause`, ["reason", "detail"]);
          return {
            reason: literal(field(item, "reason"), `${at}.pause.reason`, PAUSE_REASONS),
            detail: text(field(item, "detail"), `${at}.pause.detail`),
          };
        })();
  const reviewRaw = field(raw, "review");
  const reviewKeys = version === "1" ? ["head", "conflicts"] : version === "2" ? ["head", "conflicts", "scope", "local"] : ["head", "conflicts"];
  const review =
    reviewRaw === null
      ? null
      : (() => {
          const item = object(reviewRaw, `${at}.review`, reviewKeys);
          return {
            head: oid(field(item, "head"), `${at}.review.head`),
            conflicts: array(field(item, "conflicts"), `${at}.review.conflicts`).map((entry, index) =>
              conflict(entry, `${at}.review.conflicts[${index}]`),
            ),
          };
        })();
  const decisions: Record<string, StoredChoice> = safeDictionary();
  for (const [key, entry] of dictionary(field(raw, "decisions"), `${at}.decisions`)) {
    decisions[oid(key, `${at}.decisions`)] = choice(entry, `${at}.decisions[${key}]`);
  }
  const holds: Record<string, StoredHold> = safeDictionary();
  const unacknowledged: string[] = [];
  const nativeErrors: NativeError[] = [];
  if (version === "3" && Object.hasOwn(raw, "nativeErrors")) {
    for (const [index, item] of array(field(raw, "nativeErrors"), `${at}.nativeErrors`).entries()) nativeErrors.push(nativeError(item, `${at}.nativeErrors[${index}]`));
  }
  if (version === "3") {
    for (const [key, entry] of dictionary(field(raw, "holds"), `${at}.holds`)) holds[path(key, `${at}.holds`)] = hold(entry, `${at}.holds[${key}]`);
    for (const [index, item] of array(field(raw, "unacknowledged"), `${at}.unacknowledged`).entries()) unacknowledged.push(text(item, `${at}.unacknowledged[${index}]`));
    if (new Set(unacknowledged).size !== unacknowledged.length) fail(`${at}.unacknowledged`, "duplicate issue id");
  }
  const records = array(field(raw, "recovery"), `${at}.recovery`).map((entry, index) => recovery(entry, `${at}.recovery[${index}]`));
  if (new Set(records.map((record) => record.id)).size !== records.length) fail(`${at}.recovery`, "duplicate record id");
  let counter = field(raw, "counter");
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) fail(`${at}.counter`, "expected a counter");
  const op = nullable(field(raw, "operation"), `${at}.operation`, (value, at) => operation(value, at, version));
  const stateLedger: Ledger = version === "3" ? ledger(field(raw, "ledger"), `${at}.ledger`) : { ref: null, anchor: null };
  if (op) {
    if (op.kind === "publish" && op.publication.phase !== "legacy" && op.anchor !== stateLedger.anchor) {
      fail(`${at}.operation.anchor`, "publication anchor differs from the ledger anchor");
    }
    if (op.kind === "publish" && op.publication.phase !== "legacy" && stateLedger.ref === null) fail(`${at}.ledger.ref`, "a ledger publication needs a bound ledger");
    if (op.kind === "publish" && op.fence && (op.fence.anchor !== stateLedger.anchor || stateLedger.ref === null)) fail(`${at}.operation.fence.anchor`, "a fence publishes from the bound ledger anchor");
    // Every byte an operation may overwrite must be in its recovery record.
    const record = records.find((item) => item.id === op.recoveryId);
    if (op.recoveryId && !record) fail(`${at}.operation.recoveryId`, "missing recovery record");
    for (const item of op.steps) {
      const saved = record?.files[item.path];
      if (item.expected && !(saved && saved.oid === item.expected.oid && saved.mode === item.expected.mode)) {
        fail(`${at}.operation.steps`, `no preimage recorded for ${item.path}`);
      }
    }
    const incomingRecord = records.find((item) => item.id === op.incomingRecoveryId);
    if (op.incomingRecoveryId && !incomingRecord) fail(`${at}.operation.incomingRecoveryId`, "missing incoming recovery record");
    const target = op.kind === "publish" ? op.target : op.target.files;
    for (const item of op.steps) {
      const saved = incomingRecord?.files[item.path];
      const intended = target[item.path];
      if (item.next && !(saved && intended && saved.oid === item.next.oid && saved.mode === item.next.mode && intended.oid === saved.oid && intended.mode === saved.mode)) {
        fail(`${at}.operation.incomingRecoveryId`, `no incoming bytes recorded for ${item.path}`);
      }
    }
  }

  const blobs: Record<string, string> = safeDictionary();
  for (const [key, data] of dictionary(field(raw, "blobs"), `${at}.blobs`)) {
    const id = oid(key, `${at}.blobs`);
    if (typeof data !== "string") fail(`${at}.blobs[${key}]`, "expected base64 data");
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data);
    } catch {
      fail(`${at}.blobs[${key}]`, "invalid base64");
    }
    if ((await hashBlob(bytes)) !== id) fail(`${at}.blobs[${key}]`, "bytes do not match object ID");
    blobs[id] = data;
  }

  const retireReview = version !== "3";
  if (retireReview) {
    // Approval semantics changed: older decisions never carry over. Keep every
    // local version and edited replacement they referenced as pinned recovery.
    const localVersions: Manifest = safeDictionary();
    for (const item of review?.conflicts ?? []) {
      if (item.kind !== "collision" && item.kind !== "bulk-deletion" && item.local) localVersions[item.path] = item.local;
    }
    const preserve = (files: Manifest) => {
      if (Object.keys(files).length === 0) return;
      if (typeof counter !== "number") fail(`${at}.counter`, "expected a counter");
      counter += 1;
      records.push({ id: `migration-${counter}`, createdAt: new Date(0).toISOString(), reason: "migration", commit: oid(field(base, "commit"), `${at}.base.commit`), files, pinned: true });
    };
    preserve(localVersions);
    for (const [id, decision] of Object.entries(decisions)) {
      if (decision.kind !== "edit") continue;
      const item = review?.conflicts.find((item) => item.id === id);
      const path = item && "path" in item ? item.path : `Recovered conflict ${id}.md`;
      preserve(safeDictionary([[path, decision.entry]]));
    }
  }

  const state: StoredState = {
    format: STATE_FORMAT,
    repository: identity(field(raw, "repository"), `${at}.repository`),
    ledger: stateLedger,
    base: { ...commitRef(base, `${at}.base`), files: manifest(field(base, "files"), `${at}.base.files`) },
    carry,
    operation: op,
    pause,
    review: retireReview ? null : review,
    decisions: retireReview ? safeDictionary() : decisions,
    holds,
    unacknowledged,
    nativeErrors,
    recovery: records,
    blobs,
    counter,
  };
  for (const id of referencedBlobs(state)) if (!Object.hasOwn(blobs, id)) fail(`${at}.blobs`, `missing referenced blob ${id}`);
  return state;
}
