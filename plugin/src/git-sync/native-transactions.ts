import type { Entry, NativeIssue } from "./contracts";
import { decodeBase64, entryFromBytes, hashBlob, isOid, isSyncablePath, verifyEntry } from "./codec";
import { FileJournalStore, type JournalFiles } from "./store";
import type { NativePathPolicy, NativePolicyBinding } from "./native-path-policy";

export type NativeMethod = "text-process" | "rename";
export interface FileIntent {
  id: string;
  path: string;
  expected: string | null;
  next: string | null;
  expectedEntry: Entry | null;
  nextEntry: Entry | null;
  method: NativeMethod;
  stage: string | null;
  hold: string | null;
  attempted: boolean;
  hostLifetime: string | null;
}
export interface NativeBytesRecovery {
  id: string;
  kind: "interrupted" | "displaced";
  path: string;
  sourcePath: string;
  expected: Entry | null;
  next: Entry | null;
  found: Entry | null;
}
export interface NativeOversizeRecovery {
  id: string;
  kind: "oversize";
  path: string;
  sourcePath: string;
  expected: Entry | null;
  next: Entry | null;
  size: number;
  mtime: number | null;
}
export type NativeRecovery = NativeBytesRecovery | NativeOversizeRecovery;
export interface PendingNativeIntent {
  id: string;
  path: string;
  expected: { oid: string; mode: Entry["mode"] } | null;
  next: { oid: string; mode: Entry["mode"] } | null;
  attempted: boolean;
}
interface AcknowledgedOversize { sourcePath: string; size: number; mtime: number | null }
interface TrackedHidden {
  path: string;
  expected: Entry | null;
  next: Entry | null;
  hostLifetime: string | null;
  observed: string | null;
  missing: boolean;
}
interface JournalState {
  format: 3;
  policy: NativePolicyBinding;
  intents: Record<string, FileIntent>;
  tracked: Record<string, TrackedHidden>;
  recoveries: NativeRecovery[];
  acknowledgedOversize: AcknowledgedOversize[];
  supersededRecoveryIds: string[];
}
const uuid = /^[0-9a-f-]{36}$/;
function isHiddenPath(root: string, path: string): boolean {
  return new RegExp(`^${root.replaceAll(".", "\\.")}/(?:stage|hold)/[0-9a-f-]{36}$`).test(path);
}
function isRecoverySource(root: string, path: string, sourcePath: string, policy: NativePathPolicy): boolean {
  return isHiddenPath(root, sourcePath) || (sourcePath === path && policy.allows(sourcePath));
}
function samePolicy(a: NativePolicyBinding, b: NativePolicyBinding): boolean {
  return a.rules === b.rules && a.configDir === b.configDir;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function entry(value: unknown): value is Entry {
  return object(value) && isOid(value.oid) && (value.mode === "100644" || value.mode === "100755") && typeof value.data === "string";
}
function optionalEntry(value: unknown): value is Entry | null { return value === null || entry(value); }
async function validateEntry(path: string, value: Entry | null): Promise<void> {
  if (value) await verifyEntry(path, value);
}
async function parseState(value: unknown, root: string, policy: NativePathPolicy): Promise<JournalState> {
  if (!object(value) || value.format !== 3 || !object(value.intents) || !object(value.tracked)
    || !Array.isArray(value.recoveries)
    || (value.acknowledgedOversize !== undefined && !Array.isArray(value.acknowledgedOversize))
    || (value.supersededRecoveryIds !== undefined && !Array.isArray(value.supersededRecoveryIds)))
    throw new Error("Native transaction journal is corrupt.");
  const storedPolicy = value.policy;
  if (!object(storedPolicy) || storedPolicy.rules !== "config/1" || storedPolicy.configDir !== policy.binding.configDir)
    throw new Error("Native transaction journal policy does not match this vault.");
  const intents = Object.create(null) as Record<string, FileIntent>;
  for (const [path, raw] of Object.entries(value.intents)) {
    if (!object(raw) || !policy.allows(path) || raw.path !== path || typeof raw.id !== "string"
      || !uuid.test(raw.id) || !optionalEntry(raw.expectedEntry) || !optionalEntry(raw.nextEntry)
      || (raw.expected !== null && !isOid(raw.expected)) || (raw.next !== null && !isOid(raw.next))
      || raw.expected !== (raw.expectedEntry?.oid ?? null) || raw.next !== (raw.nextEntry?.oid ?? null)
      || (raw.method !== "rename" && raw.method !== "text-process")
      || typeof raw.attempted !== "boolean"
      || (raw.hostLifetime !== null && (typeof raw.hostLifetime !== "string" || !uuid.test(raw.hostLifetime)))
      || raw.stage !== (raw.method === "rename" && raw.next ? `${root}/stage/${raw.id}` : null)
      || raw.hold !== (raw.method === "rename" && raw.expected ? `${root}/hold/${raw.id}` : null)
      || (raw.method === "text-process" && (!raw.expected || !raw.next || !isSyncablePath(path))))
      throw new Error("Native transaction intent is corrupt.");
    await validateEntry(path, raw.expectedEntry);
    await validateEntry(path, raw.nextEntry);
    intents[path] = {
      id: raw.id, path, expected: raw.expected, next: raw.next,
      expectedEntry: raw.expectedEntry, nextEntry: raw.nextEntry,
      method: raw.method,
      stage: raw.method === "rename" && raw.next ? `${root}/stage/${raw.id}` : null,
      hold: raw.method === "rename" && raw.expected ? `${root}/hold/${raw.id}` : null,
      attempted: raw.attempted, hostLifetime: raw.hostLifetime,
    };
  }
  const tracked = Object.create(null) as Record<string, TrackedHidden>;
  for (const [hidden, raw] of Object.entries(value.tracked)) {
    if (!object(raw) || typeof raw.path !== "string" || !policy.allows(raw.path)
      || !optionalEntry(raw.expected) || !optionalEntry(raw.next)
      || (raw.hostLifetime !== null && (typeof raw.hostLifetime !== "string" || !uuid.test(raw.hostLifetime)))
      || (raw.observed !== null && !isOid(raw.observed))
      || (raw.missing !== undefined && typeof raw.missing !== "boolean")
      || !isHiddenPath(root, hidden))
      throw new Error("Native hidden-file tracking is corrupt.");
    await validateEntry(raw.path, raw.expected);
    await validateEntry(raw.path, raw.next);
    tracked[hidden] = { path: raw.path, expected: raw.expected, next: raw.next,
      hostLifetime: raw.hostLifetime, observed: raw.observed, missing: raw.missing ?? false };
  }
  const recoveries: NativeRecovery[] = [];
  for (const raw of value.recoveries) {
    if (!object(raw) || typeof raw.id !== "string" || !uuid.test(raw.id) || typeof raw.path !== "string"
      || !policy.allows(raw.path) || typeof raw.sourcePath !== "string"
      || !optionalEntry(raw.expected) || !optionalEntry(raw.next))
      throw new Error("Native recovery record is corrupt.");
    await validateEntry(raw.path, raw.expected);
    await validateEntry(raw.path, raw.next);
    if (raw.kind === "oversize") {
      if (!isRecoverySource(root, raw.path, raw.sourcePath, policy) || typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size <= 0
        || (raw.mtime !== undefined && raw.mtime !== null
          && (typeof raw.mtime !== "number" || !Number.isSafeInteger(raw.mtime) || raw.mtime < 0)))
        throw new Error("Native recovery record is corrupt.");
      recoveries.push({ id: raw.id, kind: "oversize", path: raw.path, sourcePath: raw.sourcePath,
        expected: raw.expected, next: raw.next, size: raw.size, mtime: raw.mtime ?? null });
    } else if (raw.kind === "interrupted" || raw.kind === "displaced") {
      if (!isRecoverySource(root, raw.path, raw.sourcePath, policy) || !optionalEntry(raw.found))
        throw new Error("Native recovery record is corrupt.");
      await validateEntry(raw.path, raw.found);
      recoveries.push({ id: raw.id, kind: raw.kind, path: raw.path, sourcePath: raw.sourcePath,
        expected: raw.expected, next: raw.next, found: raw.found });
    } else throw new Error("Native recovery record is corrupt.");
  }
  const acknowledgedOversize: AcknowledgedOversize[] = [];
  for (const raw of value.acknowledgedOversize ?? []) {
    if (!object(raw) || typeof raw.sourcePath !== "string"
      || (!isHiddenPath(root, raw.sourcePath) && !policy.allows(raw.sourcePath))
      || !Number.isSafeInteger(raw.size) || typeof raw.size !== "number" || raw.size <= 0
      || (raw.mtime !== null && (typeof raw.mtime !== "number" || !Number.isSafeInteger(raw.mtime) || raw.mtime < 0)))
      throw new Error("Native oversize acknowledgement is corrupt.");
    acknowledgedOversize.push({ sourcePath: raw.sourcePath, size: raw.size, mtime: raw.mtime });
  }
  const supersededRecoveryIds: unknown[] = value.supersededRecoveryIds ?? [];
  if (!supersededRecoveryIds.every((id): id is string => typeof id === "string" && uuid.test(id)))
    throw new Error("Native superseded recovery IDs are corrupt.");
  return { format: 3, policy: policy.binding, intents, tracked, recoveries, acknowledgedOversize, supersededRecoveryIds };
}

/** Native intent and evidence state in the same verified, compactable journal implementation as engine state. */
export class NativeTransactionJournal {
  readonly root: string;
  private state: JournalState;
  private uncertain = false;
  private constructor(private files: JournalFiles, private store: FileJournalStore, installationId: string,
    private readonly policy: NativePathPolicy) {
    this.root = `.git-vault-sync/${installationId}`;
    this.state = { format: 3, policy: policy.binding, intents: Object.create(null) as Record<string, FileIntent>,
      tracked: Object.create(null) as Record<string, TrackedHidden>,
      recoveries: [], acknowledgedOversize: [], supersededRecoveryIds: [] };
  }
  static async open(files: JournalFiles, installationId: string, policy: NativePathPolicy): Promise<NativeTransactionJournal> {
    const store = new FileJournalStore(files, installationId, "native");
    const journal = new NativeTransactionJournal(files, store, installationId, policy);
    const loaded = await store.load();
    if (loaded !== null) journal.state = await parseState(loaded, journal.root, policy);
    for (const path of [journal.root, `${journal.root}/stage`, `${journal.root}/hold`]) {
      if (!(await files.exists(path))) await files.mkdir(path);
    }
    if (loaded === null) {
      for (const kind of ["stage", "hold"] as const) {
        const listed = await files.list(`${journal.root}/${kind}`);
        if (listed.files.length || listed.folders.length)
          throw new Error(`Untracked native ${kind} files block configuration enrollment.`);
      }
      await journal.save(journal.state);
    }
    return journal;
  }
  private trusted(): void {
    if (this.uncertain) throw new Error("Native transaction persistence is uncertain. Reload before syncing.");
  }
  matchesPolicy(policy: NativePathPolicy): boolean { return samePolicy(this.state.policy, policy.binding); }
  private async save(state: JournalState): Promise<void> {
    this.trusted();
    this.uncertain = true;
    await this.store.save(state);
    this.state = state;
    this.uncertain = false;
  }
  intent(path: string): FileIntent | null { this.trusted(); return this.state.intents[path] ?? null; }
  pending(): FileIntent[] { this.trusted(); return Object.values(this.state.intents); }
  pendingIntents(): PendingNativeIntent[] {
    return this.pending().map(intent => ({ id: intent.id, path: intent.path,
      expected: intent.expectedEntry ? { oid: intent.expectedEntry.oid, mode: intent.expectedEntry.mode } : null,
      next: intent.nextEntry ? { oid: intent.nextEntry.oid, mode: intent.nextEntry.mode } : null,
      attempted: intent.attempted }));
  }
  tracked(path: string): TrackedHidden | null { this.trusted(); return this.state.tracked[path] ?? null; }
  trackedPaths(): string[] { this.trusted(); return Object.keys(this.state.tracked); }
  recoveries(): NativeRecovery[] { this.trusted(); return [...this.state.recoveries]; }
  oversizeForSource(sourcePath: string): NativeOversizeRecovery | null {
    this.trusted();
    return this.state.recoveries.find((item): item is NativeOversizeRecovery =>
      item.kind === "oversize" && item.sourcePath === sourcePath) ?? null;
  }
  missingForSource(sourcePath: string): NativeBytesRecovery | null {
    this.trusted();
    return this.state.recoveries.find((item): item is NativeBytesRecovery =>
      item.kind !== "oversize" && item.sourcePath === sourcePath && item.found === null) ?? null;
  }
  hasAcknowledgedOversizeSource(sourcePath: string): boolean {
    this.trusted();
    return this.state.acknowledgedOversize.some(item => item.sourcePath === sourcePath);
  }
  issues(): NativeIssue[] { this.trusted(); return [...this.state.recoveries]; }
  async begin(path: string, expected: Entry | null, next: Entry | null, method: NativeMethod, hostLifetime: string | null = null): Promise<FileIntent> {
    this.trusted();
    if (!this.policy.allows(path) || (!expected && !next)) throw new Error(`Unsupported native transaction path: ${path}`);
    if (hostLifetime !== null && !uuid.test(hostLifetime)) throw new Error("Invalid host lifetime identity.");
    if (this.state.intents[path]) throw new Error(`Unresolved native transaction: ${path}`);
    await validateEntry(path, expected);
    await validateEntry(path, next);
    if (method === "text-process" && (!expected || !next || !isSyncablePath(path))) throw new Error("Invalid text transaction.");
    const id = crypto.randomUUID();
    const intent: FileIntent = { id, path, expected: expected?.oid ?? null, next: next?.oid ?? null,
      expectedEntry: expected, nextEntry: next, method, attempted: false, hostLifetime,
      stage: method === "rename" && next ? `${this.root}/stage/${id}` : null,
      hold: method === "rename" && expected ? `${this.root}/hold/${id}` : null };
    await this.save({ ...this.state, intents: { ...this.state.intents, [path]: intent } });
    return intent;
  }
  async markAttempted(path: string): Promise<FileIntent> {
    this.trusted();
    const intent = this.state.intents[path];
    if (!intent) throw new Error(`Missing native transaction: ${path}`);
    if (intent.attempted) return intent;
    const updated = { ...intent, attempted: true };
    await this.save({ ...this.state, intents: { ...this.state.intents, [path]: updated } });
    return updated;
  }
  /** Clear an attempt only after the caller re-reads the exact unchanged preimage. */
  async clearAttempt(path: string): Promise<void> {
    this.trusted();
    const intent = this.state.intents[path];
    if (!intent?.attempted) return;
    await this.save({ ...this.state, intents: { ...this.state.intents, [path]: { ...intent, attempted: false } } });
  }
  async finish(path: string): Promise<void> {
    this.trusted();
    const intent = this.state.intents[path];
    if (!intent) return;
    const intents = { ...this.state.intents }; delete intents[path];
    const tracked = { ...this.state.tracked };
    for (const hidden of [intent.stage, intent.hold]) {
      if (hidden && await this.files.exists(hidden)) {
        const observed = [...this.state.recoveries].reverse().find(item => item.sourcePath === hidden);
        tracked[hidden] = { path, expected: intent.expectedEntry, next: intent.nextEntry,
          hostLifetime: intent.hostLifetime, observed: observed?.kind === "oversize" ? null : observed?.found?.oid ?? null,
          missing: false };
      }
    }
    await this.save({ ...this.state, intents, tracked });
  }
  /** Durable cancellation; hidden stage/hold files remain tracked for inspection. */
  async cancel(path: string): Promise<void> { await this.finish(path); }
  async observe(path: string, oid: string): Promise<void> {
    this.trusted();
    const old = this.state.tracked[path];
    if (!old || (old.observed === oid && !old.missing)) return;
    await this.save({ ...this.state, tracked: { ...this.state.tracked, [path]: { ...old, observed: oid, missing: false } } });
  }
  /**
   * True when a finished hold may be reclaimed: tracked, present, never seen
   * with bytes other than its preimage, and no recovery record, oversize
   * acknowledgement or pending intent refers to it.
   */
  reclaimable(path: string): boolean {
    this.trusted();
    const tracked = this.state.tracked[path];
    if (!tracked?.expected || tracked.missing || !path.startsWith(`${this.root}/hold/`)) return false;
    if (tracked.observed !== null && tracked.observed !== tracked.expected.oid) return false;
    if (this.state.recoveries.some(item => item.sourcePath === path)) return false;
    if (this.state.acknowledgedOversize.some(item => item.sourcePath === path)) return false;
    return !Object.values(this.state.intents).some(intent => intent.hold === path || intent.stage === path);
  }
  /** Stops tracking a reclaimed hold whose file the caller already removed. */
  async release(path: string): Promise<void> {
    this.trusted();
    if (!this.reclaimable(path)) throw new Error(`Native hold is not reclaimable: ${path}`);
    const tracked = { ...this.state.tracked }; delete tracked[path];
    await this.save({ ...this.state, tracked });
  }
  async observeMissing(path: string): Promise<void> {
    this.trusted();
    const old = this.state.tracked[path];
    if (!old || old.missing) return;
    await this.save({ ...this.state, tracked: { ...this.state.tracked, [path]: { ...old, missing: true } } });
  }
  async retainIssue(input: Omit<NativeBytesRecovery, "id">): Promise<NativeBytesRecovery> {
    this.trusted();
    if (!this.policy.allows(input.path) || !isRecoverySource(this.root, input.path, input.sourcePath, this.policy))
      throw new Error("Invalid native issue path.");
    await validateEntry(input.path, input.expected);
    await validateEntry(input.path, input.next);
    await validateEntry(input.path, input.found);
    const prior = this.state.recoveries.find(item => item.kind === input.kind && item.path === input.path
      && item.sourcePath === input.sourcePath && item.found?.oid === input.found?.oid
      && item.expected?.oid === input.expected?.oid && item.next?.oid === input.next?.oid);
    if (prior && prior.kind !== "oversize") return prior;
    const record = { ...input, id: crypto.randomUUID() };
    await this.save({ ...this.state, recoveries: [...this.state.recoveries, record] });
    return record;
  }
  async retainBytes(bytes: Uint8Array, path: string, sourcePath: string, kind: "interrupted" | "displaced",
    expected: Entry | null, next: Entry | null): Promise<NativeBytesRecovery> {
    return this.retainIssue({ kind, path, sourcePath, expected, next,
      found: await entryFromBytes(bytes, expected?.mode ?? next?.mode ?? "100644") });
  }
  async retainMissing(path: string, expected: Entry | null, next: Entry | null): Promise<NativeBytesRecovery> {
    return this.retainIssue({ kind: "interrupted", path, sourcePath: path, expected, next, found: null });
  }
  async retainOversize(path: string, sourcePath: string, expected: Entry | null, next: Entry | null,
    size: number, mtime: number | null = null): Promise<NativeOversizeRecovery | null> {
    this.trusted();
    if (!this.policy.allows(path) || !isRecoverySource(this.root, path, sourcePath, this.policy))
      throw new Error(`Unsupported native recovery source: ${sourcePath}`);
    if (this.state.acknowledgedOversize.some(item => item.sourcePath === sourcePath && item.size === size && item.mtime === mtime)) return null;
    const prior = this.state.recoveries.find(item => item.kind === "oversize" && item.sourcePath === sourcePath && item.size === size && item.mtime === mtime);
    if (prior?.kind === "oversize") return prior;
    const record: NativeOversizeRecovery = { id: crypto.randomUUID(), kind: "oversize", path, sourcePath, expected, next, size, mtime };
    // A changed source supersedes its old metadata; the old version is no
    // longer exportable or acknowledgeable from this path.
    const recoveries = this.state.recoveries.filter(item => item.sourcePath !== sourcePath ||
      (item.kind !== "oversize" && item.found !== null));
    const superseded = this.state.recoveries.filter(item => item.sourcePath === sourcePath &&
      (item.kind === "oversize" || item.found === null));
    await this.save({ ...this.state, recoveries: [...recoveries, record],
      acknowledgedOversize: this.state.acknowledgedOversize.filter(item => item.sourcePath !== sourcePath),
      supersededRecoveryIds: [...this.state.supersededRecoveryIds, ...superseded.map(item => item.id)] });
    return record;
  }
  /** Replace an impossible old-size acknowledgement with durable current evidence in one journal record. */
  async supersedeOversize(sourcePath: string, bytes: Uint8Array | null): Promise<NativeBytesRecovery> {
    this.trusted();
    const old = this.oversizeForSource(sourcePath);
    if (!old) throw new Error(`No oversized source to supersede: ${sourcePath}`);
    const record: NativeBytesRecovery = {
      id: crypto.randomUUID(), kind: sourcePath === old.path ? "interrupted" : "displaced",
      path: old.path, sourcePath, expected: old.expected, next: old.next,
      found: bytes === null ? null : await entryFromBytes(bytes, old.expected?.mode ?? old.next?.mode ?? "100644"),
    };
    await validateEntry(record.path, record.found);
    await this.save({ ...this.state, acknowledgedOversize: this.state.acknowledgedOversize.filter(item => item.sourcePath !== sourcePath),
      supersededRecoveryIds: [...this.state.supersededRecoveryIds, old.id], recoveries: [
      ...this.state.recoveries.filter(item => item.kind !== "oversize" || item.sourcePath !== sourcePath), record,
    ] });
    return record;
  }
  /** A changed source needs fresh consent even when its old oversized version was already acknowledged. */
  async retainChangedAcknowledgedSource(path: string, sourcePath: string, expected: Entry | null,
    next: Entry | null, bytes: Uint8Array | null): Promise<NativeBytesRecovery> {
    this.trusted();
    if (!this.hasAcknowledgedOversizeSource(sourcePath))
      throw new Error(`No acknowledged oversized source to replace: ${sourcePath}`);
    const record: NativeBytesRecovery = {
      id: crypto.randomUUID(), kind: sourcePath === path ? "interrupted" : "displaced",
      path, sourcePath, expected, next,
      found: bytes === null ? null : await entryFromBytes(bytes, expected?.mode ?? next?.mode ?? "100644"),
    };
    await validateEntry(path, record.found);
    await this.save({ ...this.state,
      acknowledgedOversize: this.state.acknowledgedOversize.filter(item => item.sourcePath !== sourcePath),
      recoveries: [...this.state.recoveries, record] });
    return record;
  }
  /** A missing source that reappears is new evidence, even if its bytes equal an old preimage. */
  async supersedeMissing(sourcePath: string, bytes: Uint8Array): Promise<NativeBytesRecovery> {
    this.trusted();
    const old = this.missingForSource(sourcePath);
    if (!old) throw new Error(`No missing source to supersede: ${sourcePath}`);
    const record: NativeBytesRecovery = { ...old, id: crypto.randomUUID(),
      found: await entryFromBytes(bytes, old.expected?.mode ?? old.next?.mode ?? "100644") };
    await validateEntry(record.path, record.found);
    await this.save({ ...this.state, supersededRecoveryIds: [...this.state.supersededRecoveryIds, old.id],
      recoveries: [...this.state.recoveries.filter(item => item.id !== old.id), record] });
    return record;
  }
  async readEvidence(record: NativeBytesRecovery): Promise<Uint8Array> {
    this.trusted();
    if (!this.state.recoveries.some(item => item.id === record.id)) throw new Error("Unknown native recovery record.");
    if (!record.found) throw new Error("Native recovery has no bytes.");
    const bytes = decodeBase64(record.found.data);
    if (await hashBlob(bytes) !== record.found.oid) throw new Error("Native recovery evidence is corrupt.");
    return bytes;
  }
  async acknowledge(ids: string[]): Promise<void> {
    this.trusted();
    const accepted = new Set(ids);
    if (this.state.supersededRecoveryIds.some(id => accepted.has(id)))
      throw new Error("Native source changed. Recover again before acknowledging.");
    const recoveries = this.state.recoveries.filter(item => !accepted.has(item.id));
    if (recoveries.length !== this.state.recoveries.length) {
      const acknowledgedOversize = [...this.state.acknowledgedOversize];
      for (const item of this.state.recoveries) if (accepted.has(item.id) && item.kind === "oversize")
        acknowledgedOversize.push({ sourcePath: item.sourcePath, size: item.size, mtime: item.mtime });
      await this.save({ ...this.state, recoveries, acknowledgedOversize });
    }
  }
  async compact(): Promise<void> { this.trusted(); if (this.files.remove) await this.store.compact(); }
}
