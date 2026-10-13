import type { Entry, NativeIssue } from "./contracts";
import { decodeBase64, entryFromBytes, hashBlob, isOid, isSyncablePath, verifyEntry } from "./codec";
import { FileJournalStore, type JournalFiles } from "./store";

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
export interface NativeBytesRecovery extends NativeIssue { sourcePath: string }
export interface NativeOversizeRecovery {
  id: string;
  kind: "oversize";
  path: string;
  sourcePath: string;
  expected: Entry | null;
  next: Entry | null;
  size: number;
}
export type NativeRecovery = NativeBytesRecovery | NativeOversizeRecovery;
interface TrackedHidden {
  path: string;
  expected: Entry | null;
  next: Entry | null;
  hostLifetime: string | null;
  observed: string | null;
}
interface JournalState {
  format: 3;
  intents: Record<string, FileIntent>;
  tracked: Record<string, TrackedHidden>;
  recoveries: NativeRecovery[];
}
const uuid = /^[0-9a-f-]{36}$/;
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
async function parseState(value: unknown, root: string): Promise<JournalState> {
  if (!object(value) || value.format !== 3 || !object(value.intents) || !object(value.tracked)
    || !Array.isArray(value.recoveries)) throw new Error("Native transaction journal is corrupt.");
  const intents: Record<string, FileIntent> = Object.create(null);
  for (const [path, raw] of Object.entries(value.intents)) {
    if (!object(raw) || !isSyncablePath(path) || raw.path !== path || typeof raw.id !== "string"
      || !uuid.test(raw.id) || !optionalEntry(raw.expectedEntry) || !optionalEntry(raw.nextEntry)
      || (raw.expected !== null && !isOid(raw.expected)) || (raw.next !== null && !isOid(raw.next))
      || raw.expected !== (raw.expectedEntry?.oid ?? null) || raw.next !== (raw.nextEntry?.oid ?? null)
      || (raw.method !== "rename" && raw.method !== "text-process")
      || typeof raw.attempted !== "boolean"
      || (raw.hostLifetime !== null && (typeof raw.hostLifetime !== "string" || !uuid.test(raw.hostLifetime)))
      || raw.stage !== (raw.method === "rename" && raw.next ? `${root}/stage/${raw.id}` : null)
      || raw.hold !== (raw.method === "rename" && raw.expected ? `${root}/hold/${raw.id}` : null)
      || (raw.method === "text-process" && (!raw.expected || !raw.next)))
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
  const tracked: Record<string, TrackedHidden> = Object.create(null);
  for (const [hidden, raw] of Object.entries(value.tracked)) {
    if (!object(raw) || typeof raw.path !== "string" || !isSyncablePath(raw.path)
      || !optionalEntry(raw.expected) || !optionalEntry(raw.next)
      || (raw.hostLifetime !== null && (typeof raw.hostLifetime !== "string" || !uuid.test(raw.hostLifetime)))
      || (raw.observed !== null && !isOid(raw.observed))
      || !new RegExp(`^${root.replaceAll(".", "\\.")}/(?:stage|hold)/[0-9a-f-]{36}$`).test(hidden))
      throw new Error("Native hidden-file tracking is corrupt.");
    await validateEntry(raw.path, raw.expected);
    await validateEntry(raw.path, raw.next);
    tracked[hidden] = { path: raw.path, expected: raw.expected, next: raw.next,
      hostLifetime: raw.hostLifetime, observed: raw.observed };
  }
  const recoveries: NativeRecovery[] = [];
  for (const raw of value.recoveries) {
    if (!object(raw) || typeof raw.id !== "string" || !uuid.test(raw.id)
      || !isSyncablePath(raw.path) || typeof raw.sourcePath !== "string"
      || !optionalEntry(raw.expected) || !optionalEntry(raw.next))
      throw new Error("Native recovery record is corrupt.");
    await validateEntry(raw.path, raw.expected);
    await validateEntry(raw.path, raw.next);
    if (raw.kind === "oversize") {
      if (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size <= 0)
        throw new Error("Native recovery record is corrupt.");
      recoveries.push({ id: raw.id, kind: "oversize", path: raw.path, sourcePath: raw.sourcePath,
        expected: raw.expected, next: raw.next, size: raw.size });
    } else if (raw.kind === "interrupted" || raw.kind === "displaced") {
      if (!optionalEntry(raw.found)) throw new Error("Native recovery record is corrupt.");
      await validateEntry(raw.path, raw.found);
      recoveries.push({ id: raw.id, kind: raw.kind, path: raw.path, sourcePath: raw.sourcePath,
        expected: raw.expected, next: raw.next, found: raw.found });
    } else throw new Error("Native recovery record is corrupt.");
  }
  return { format: 3, intents, tracked, recoveries };
}

/** Native intent and evidence state in the same verified, compactable journal implementation as engine state. */
export class NativeTransactionJournal {
  readonly root: string;
  private state: JournalState = { format: 3, intents: Object.create(null), tracked: Object.create(null), recoveries: [] };
  private uncertain = false;
  private constructor(private files: JournalFiles, private store: FileJournalStore, installationId: string) {
    this.root = `.git-vault-sync/${installationId}`;
  }
  static async open(files: JournalFiles, installationId: string): Promise<NativeTransactionJournal> {
    const store = new FileJournalStore(files, installationId, "native");
    const journal = new NativeTransactionJournal(files, store, installationId);
    // Old experimental journals contain evidence we cannot silently abandon.
    const legacy = `${journal.root}/native-records`;
    if (await files.exists(legacy) && (await files.list(legacy)).files.some(path => path.endsWith(".json")))
      throw new Error("Legacy native transaction journal needs migration before syncing.");
    const loaded = await store.load();
    if (loaded !== null) journal.state = await parseState(loaded, journal.root);
    for (const path of [journal.root, `${journal.root}/stage`, `${journal.root}/hold`]) {
      if (!(await files.exists(path))) await files.mkdir(path);
    }
    return journal;
  }
  private trusted(): void {
    if (this.uncertain) throw new Error("Native transaction persistence is uncertain. Reload before syncing.");
  }
  private async save(state: JournalState): Promise<void> {
    this.trusted();
    this.uncertain = true;
    await this.store.save(state);
    this.state = state;
    this.uncertain = false;
  }
  intent(path: string): FileIntent | null { this.trusted(); return this.state.intents[path] ?? null; }
  pending(): FileIntent[] { this.trusted(); return Object.values(this.state.intents); }
  tracked(path: string): TrackedHidden | null { this.trusted(); return this.state.tracked[path] ?? null; }
  recoveries(): NativeRecovery[] { this.trusted(); return [...this.state.recoveries]; }
  issues(): NativeIssue[] { this.trusted(); return this.state.recoveries.filter((item): item is NativeBytesRecovery => item.kind !== "oversize"); }
  async begin(path: string, expected: Entry | null, next: Entry | null, method: NativeMethod, hostLifetime: string | null = null): Promise<FileIntent> {
    this.trusted();
    if (!isSyncablePath(path) || (!expected && !next)) throw new Error(`Unsupported native transaction path: ${path}`);
    if (hostLifetime !== null && !uuid.test(hostLifetime)) throw new Error("Invalid host lifetime identity.");
    if (this.state.intents[path]) throw new Error(`Unresolved native transaction: ${path}`);
    await validateEntry(path, expected);
    await validateEntry(path, next);
    if (method === "text-process" && (!expected || !next)) throw new Error("Invalid text transaction.");
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
          hostLifetime: intent.hostLifetime, observed: observed?.kind === "oversize" ? null : observed?.found?.oid ?? null };
      }
    }
    await this.save({ ...this.state, intents, tracked });
  }
  async observe(path: string, oid: string): Promise<void> {
    this.trusted();
    const old = this.state.tracked[path];
    if (!old || old.observed === oid) return;
    await this.save({ ...this.state, tracked: { ...this.state.tracked, [path]: { ...old, observed: oid } } });
  }
  async untrack(path: string): Promise<void> {
    this.trusted();
    if (!this.state.tracked[path]) return;
    const tracked = { ...this.state.tracked }; delete tracked[path];
    await this.save({ ...this.state, tracked });
  }
  async retainIssue(input: Omit<NativeBytesRecovery, "id">): Promise<NativeBytesRecovery> {
    this.trusted();
    if (!isSyncablePath(input.path)) throw new Error("Invalid native issue path.");
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
  async retainOversize(path: string, sourcePath: string, expected: Entry | null, next: Entry | null, size: number): Promise<NativeOversizeRecovery> {
    this.trusted();
    const prior = this.state.recoveries.find(item => item.kind === "oversize" && item.sourcePath === sourcePath && item.size === size);
    if (prior?.kind === "oversize") return prior;
    const record: NativeOversizeRecovery = { id: crypto.randomUUID(), kind: "oversize", path, sourcePath, expected, next, size };
    await this.save({ ...this.state, recoveries: [...this.state.recoveries, record] });
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
    const recoveries = this.state.recoveries.filter(item => !accepted.has(item.id));
    if (recoveries.length !== this.state.recoveries.length) await this.save({ ...this.state, recoveries });
  }
  async compact(): Promise<void> { this.trusted(); if (this.files.remove) await this.store.compact(); }
}
