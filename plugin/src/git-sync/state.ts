// Durable session state and its boundary parser. Everything loaded from the
// DurableStore is untrusted until `parseState` has checked shape, scope,
// references and blob hashes.
import type { RepositoryIdentity } from "./contracts";
import type { ChoiceKind, VersionConflictKind } from "./reconcile";
import { choicesFor } from "./reconcile";
import { decodeBase64, hashBlob, isFileMode, isOid, isSyncablePath } from "./codec";
import type { Manifest, Ref } from "./codec";

export const STATE_FORMAT = "github-vault-sync/1";

export type StepStatus = "pending" | "applied" | "changed" | "blocked" | "kept";

export interface StoredStep {
  path: string;
  expected: Ref | null;
  next: Ref | null;
  status: StepStatus;
  /** Adapter explanation for `blocked`. */
  reason: string | null;
}

export type StoredChoice = { kind: "mine" } | { kind: "remote" } | { kind: "both" } | { kind: "edit"; entry: Ref };

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
  | { kind: "collision"; id: string; paths: string[] };

export interface CommitRef {
  commit: string;
  tree: string;
}

/** A candidate commit recorded before publication; its outcome is unknown until settled. */
export interface PublishOperation {
  kind: "publish";
  id: string;
  parent: string;
  candidate: CommitRef;
  target: Manifest;
  steps: StoredStep[];
  recoveryId: string | null;
}

/** Local application of a commit known to be on the branch. */
export interface ApplyOperation {
  kind: "apply";
  id: string;
  target: CommitRef & { files: Manifest };
  steps: StoredStep[];
  recoveryId: string | null;
}

export type Operation = PublishOperation | ApplyOperation;

export type PauseReason = "repository-changed" | "history-rewritten" | "base-mismatch";

export interface Pause {
  reason: PauseReason;
  detail: string;
}

export type RecoveryReason = "sync" | "enrollment" | "restore";

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

export interface StoredState {
  format: typeof STATE_FORMAT;
  repository: RepositoryIdentity;
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
  decisions: Record<string, StoredChoice>;
  recovery: RecoveryRecord[];
  /** Content-addressed bytes (base64) referenced by carry, decisions, review and recovery. */
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

const field = (value: object, key: string): unknown => Reflect.get(value, key);

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
  const result: Manifest = {};
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
const STEP_STATUSES: readonly StepStatus[] = ["pending", "applied", "changed", "blocked", "kept"];
const PAUSE_REASONS: readonly PauseReason[] = ["repository-changed", "history-rewritten", "base-mismatch"];
const RECOVERY_REASONS: readonly RecoveryReason[] = ["sync", "enrollment", "restore"];
const CHOICE_KINDS: readonly ChoiceKind[] = ["mine", "remote", "both", "edit"];

function step(value: unknown, at: string): StoredStep {
  const raw = object(value, at, ["path", "expected", "next", "status", "reason"]);
  const status = literal(field(raw, "status"), `${at}.status`, STEP_STATUSES);
  const reason = nullable(field(raw, "reason"), `${at}.reason`, text);
  if ((status === "blocked") !== (reason !== null)) fail(at, "blocked steps, and only they, carry a reason");
  const expected = nullable(field(raw, "expected"), `${at}.expected`, ref);
  const next = nullable(field(raw, "next"), `${at}.next`, ref);
  if (!expected && !next) fail(at, "a step must change something");
  return { path: path(field(raw, "path"), `${at}.path`), expected, next, status, reason };
}

function steps(value: unknown, at: string): StoredStep[] {
  const parsed = array(value, at).map((item, index) => step(item, `${at}[${index}]`));
  if (new Set(parsed.map((item) => item.path)).size !== parsed.length) fail(at, "duplicate step path");
  return parsed;
}

function operation(value: unknown, at: string): Operation {
  if (typeof value !== "object" || value === null) fail(at, "expected an object");
  const kind = literal(field(value, "kind"), `${at}.kind`, ["publish", "apply"] as const);
  if (kind === "publish") {
    const raw = object(value, at, ["kind", "id", "parent", "candidate", "target", "steps", "recoveryId"]);
    return {
      kind,
      id: text(field(raw, "id"), `${at}.id`),
      parent: oid(field(raw, "parent"), `${at}.parent`),
      candidate: commitRef(object(field(raw, "candidate"), `${at}.candidate`, ["commit", "tree"]), `${at}.candidate`),
      target: manifest(field(raw, "target"), `${at}.target`),
      steps: steps(field(raw, "steps"), `${at}.steps`),
      recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
    };
  }
  const raw = object(value, at, ["kind", "id", "target", "steps", "recoveryId"]);
  const target = object(field(raw, "target"), `${at}.target`, ["commit", "tree", "files"]);
  return {
    kind,
    id: text(field(raw, "id"), `${at}.id`),
    target: { ...commitRef(target, `${at}.target`), files: manifest(field(target, "files"), `${at}.target.files`) },
    steps: steps(field(raw, "steps"), `${at}.steps`),
    recoveryId: nullable(field(raw, "recoveryId"), `${at}.recoveryId`, text),
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

function identity(value: unknown, at: string): RepositoryIdentity {
  const raw = object(value, at, ["id", "owner", "name", "branch"]);
  return {
    id: text(field(raw, "id"), `${at}.id`),
    owner: text(field(raw, "owner"), `${at}.owner`),
    name: text(field(raw, "name"), `${at}.name`),
    branch: text(field(raw, "branch"), `${at}.branch`),
  };
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
    if (item.kind === "collision") continue;
    for (const entry of [item.base, item.local, item.remote]) if (entry) oids.add(entry.oid);
  }
  for (const record of state.recovery) for (const entry of Object.values(record.files)) oids.add(entry.oid);
  return oids;
}

/** Parses untrusted stored data. `undefined`/`null` mean "never enrolled". */
export async function parseState(value: unknown): Promise<StoredState> {
  const at = "state";
  const raw = object(value, at, [
    "format",
    "repository",
    "base",
    "carry",
    "operation",
    "pause",
    "review",
    "decisions",
    "recovery",
    "blobs",
    "counter",
  ]);
  if (field(raw, "format") !== STATE_FORMAT) fail(`${at}.format`, "unsupported state format");
  const base = object(field(raw, "base"), `${at}.base`, ["commit", "tree", "files"]);
  const carry: Record<string, Ref | null> = {};
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
  const review =
    reviewRaw === null
      ? null
      : (() => {
          const item = object(reviewRaw, `${at}.review`, ["head", "conflicts"]);
          return {
            head: oid(field(item, "head"), `${at}.review.head`),
            conflicts: array(field(item, "conflicts"), `${at}.review.conflicts`).map((entry, index) =>
              conflict(entry, `${at}.review.conflicts[${index}]`),
            ),
          };
        })();
  const decisions: Record<string, StoredChoice> = {};
  for (const [key, entry] of dictionary(field(raw, "decisions"), `${at}.decisions`)) {
    decisions[oid(key, `${at}.decisions`)] = choice(entry, `${at}.decisions[${key}]`);
  }
  const records = array(field(raw, "recovery"), `${at}.recovery`).map((entry, index) => recovery(entry, `${at}.recovery[${index}]`));
  if (new Set(records.map((record) => record.id)).size !== records.length) fail(`${at}.recovery`, "duplicate record id");
  const counter = field(raw, "counter");
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) fail(`${at}.counter`, "expected a counter");
  const op = nullable(field(raw, "operation"), `${at}.operation`, operation);
  if (op) {
    // Every byte an operation may overwrite must be in its recovery record.
    const record = records.find((item) => item.id === op.recoveryId);
    if (op.recoveryId && !record) fail(`${at}.operation.recoveryId`, "missing recovery record");
    for (const item of op.steps) {
      const saved = record?.files[item.path];
      if (item.expected && !(saved && saved.oid === item.expected.oid && saved.mode === item.expected.mode)) {
        fail(`${at}.operation.steps`, `no preimage recorded for ${item.path}`);
      }
    }
  }

  const blobs: Record<string, string> = {};
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

  const state: StoredState = {
    format: STATE_FORMAT,
    repository: identity(field(raw, "repository"), `${at}.repository`),
    base: { ...commitRef(base, `${at}.base`), files: manifest(field(base, "files"), `${at}.base.files`) },
    carry,
    operation: op,
    pause,
    review,
    decisions,
    recovery: records,
    blobs,
    counter,
  };
  for (const id of referencedBlobs(state)) if (!(id in blobs)) fail(`${at}.blobs`, `missing referenced blob ${id}`);
  return state;
}
