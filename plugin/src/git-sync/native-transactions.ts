import type { Entry, FileMode } from "./contracts";
import { decodeBase64, encodeBase64, hashBlob, isFileMode, isOid, isSyncablePath, verifyEntry } from "./codec";
import type { JournalFiles } from "./store";

export type NativeMethod = "text-process" | "rename";
export interface FileIntent {
  id: string;
  path: string;
  expected: string | null;
  next: string | null;
  mode: FileMode | null;
  method: NativeMethod;
  stage: string | null;
  hold: string | null;
  nextEntry: Entry | null;
}
export type NativeRecoveryKind = "changed" | "interrupted" | "displaced" | "orphan";
export interface NativeRecovery {
  id: string;
  kind: NativeRecoveryKind;
  path: string;
  sourcePath: string;
  evidencePath: string;
  oid: string;
  expected: string | null;
  next: string | null;
}
interface TrackedHidden { path: string; expected: string | null; next: string | null }
interface JournalState { format: 2; intents: Record<string, FileIntent>; tracked: Record<string, TrackedHidden>; recoveries: NativeRecovery[] }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIntent(value: unknown): value is FileIntent {
  if (!isObject(value)) return false;
  return typeof value.id === "string" && /^[0-9a-f-]{36}$/.test(value.id)
    && typeof value.path === "string" && value.path.length > 0
    && (value.expected === null || isOid(value.expected))
    && (value.next === null || isOid(value.next))
    && (value.mode === null || isFileMode(value.mode))
    && (value.method === "rename" || value.method === "text-process")
    && (value.stage === null || typeof value.stage === "string")
    && (value.hold === null || typeof value.hold === "string")
    && (value.nextEntry === null || (isObject(value.nextEntry) && isOid(value.nextEntry.oid)
      && isFileMode(value.nextEntry.mode) && typeof value.nextEntry.data === "string"))
    && (value.nextEntry === null ? value.next === null : value.nextEntry.oid === value.next);
}
function parseState(value: unknown): JournalState {
  if (!isObject(value) || value.format !== 2 || !isObject(value.intents)
    || !isObject(value.tracked) || !Array.isArray(value.recoveries))
    throw new Error("Native transaction journal is corrupt.");
  const intents: Record<string, FileIntent> = Object.create(null);
  for (const [path, intent] of Object.entries(value.intents)) {
    if (!isIntent(intent) || intent.path !== path) throw new Error("Native transaction intent is corrupt.");
    intents[path] = intent;
  }
  const tracked: Record<string, TrackedHidden> = Object.create(null);
  for (const [path, item] of Object.entries(value.tracked)) {
    if (!isObject(item) || typeof item.path !== "string"
      || (item.expected !== null && !isOid(item.expected))
      || (item.next !== null && !isOid(item.next))) throw new Error("Native hidden-file tracking is corrupt.");
    tracked[path] = { path: item.path, expected: item.expected, next: item.next };
  }
  const recoveries: NativeRecovery[] = [];
  for (const item of value.recoveries) {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.path !== "string"
      || typeof item.sourcePath !== "string"
      || typeof item.evidencePath !== "string" || !isOid(item.oid)
      || (item.expected !== null && !isOid(item.expected))
      || (item.next !== null && !isOid(item.next)))
      throw new Error("Native recovery record is corrupt.");
    const kind = item.kind;
    if (kind !== "changed" && kind !== "interrupted" && kind !== "displaced" && kind !== "orphan")
      throw new Error("Native recovery record is corrupt.");
    recoveries.push({ id: item.id, kind, path: item.path, sourcePath: item.sourcePath,
      evidencePath: item.evidencePath, oid: item.oid, expected: item.expected, next: item.next });
  }
  return { format: 2, intents, tracked, recoveries };
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Separate append-only record chain. A failed save blocks this instance until reopen. */
export class NativeTransactionJournal {
  readonly root: string;
  private state: JournalState = { format: 2, intents: Object.create(null), tracked: Object.create(null), recoveries: [] };
  private sequence = 0;
  private uncertain = false;
  private constructor(private files: JournalFiles, installationId: string) {
    if (!/^[a-f0-9-]{36}$/.test(installationId)) throw new Error("Invalid installation identity");
    this.root = `.git-vault-sync/${installationId}`;
  }
  static async open(files: JournalFiles, installationId: string): Promise<NativeTransactionJournal> {
    const journal = new NativeTransactionJournal(files, installationId);
    await journal.ensure();
    const records = await journal.records();
    if (records.length) {
      const latest = records[0];
      const data = await files.read(latest.path);
      if (await digest(data) !== latest.hash) throw new Error("Latest native transaction record is corrupt.");
      journal.state = parseState(JSON.parse(data));
      journal.sequence = latest.sequence;
      for (const intent of Object.values(journal.state.intents)) {
        if (!isSyncablePath(intent.path) || (intent.expected === null && intent.next === null)
          || intent.stage !== (intent.method === "rename" && intent.next
            ? `${journal.root}/stage/${intent.id}` : null)
          || intent.hold !== (intent.method === "rename" && intent.expected
            ? `${journal.root}/hold/${intent.id}` : null)
          || (intent.method === "text-process" && (!intent.expected || !intent.next))
          || intent.nextEntry?.mode !== (intent.mode ?? undefined))
          throw new Error("Native transaction intent is corrupt.");
        if (intent.nextEntry) await verifyEntry(intent.path, intent.nextEntry);
      }
      for (const [path, item] of Object.entries(journal.state.tracked)) {
        const hiddenId = path.startsWith(`${journal.root}/stage/`)
          ? path.slice(`${journal.root}/stage/`.length)
          : path.startsWith(`${journal.root}/hold/`)
            ? path.slice(`${journal.root}/hold/`.length) : "";
        if (!isSyncablePath(item.path) || !/^[0-9a-f-]{36}$/.test(hiddenId))
          throw new Error("Native hidden-file tracking is corrupt.");
      }
      for (const record of journal.state.recoveries) {
        if (!record.evidencePath.startsWith(`${journal.root}/recovery/`)
          || !/^[0-9a-f-]{36}$/.test(record.evidencePath.slice(`${journal.root}/recovery/`.length)))
          throw new Error("Native recovery record is corrupt.");
      }
    }
    return journal;
  }
  private async ensure(): Promise<void> {
    for (const path of [".git-vault-sync", this.root, `${this.root}/native-records`,
      `${this.root}/stage`, `${this.root}/hold`, `${this.root}/recovery`]) {
      if (!(await this.files.exists(path))) await this.files.mkdir(path);
    }
  }
  private async records(): Promise<Array<{ path: string; sequence: number; hash: string }>> {
    const result = (await this.files.list(`${this.root}/native-records`)).files.filter(path => path.endsWith(".json")).map(path => {
      const match = /\/(\d{12})-([a-f0-9]{64})\.json$/.exec(path);
      if (!match) throw new Error("Unrecognized native transaction record.");
      return { path, sequence: Number(match[1]), hash: match[2] };
    }).sort((a, b) => b.sequence - a.sequence);
    if (result.length > 1 && result[0].sequence === result[1].sequence)
      throw new Error("Multiple native transaction writers detected.");
    return result;
  }
  private trusted(): void {
    if (this.uncertain) throw new Error("Native transaction persistence is uncertain. Reload before syncing.");
  }
  private async save(state: JournalState): Promise<void> {
    this.trusted();
    this.uncertain = true;
    const latest = (await this.records())[0];
    if ((latest?.sequence ?? 0) !== this.sequence) throw new Error("Stale native transaction writer.");
    const data = JSON.stringify(state);
    const hash = await digest(data);
    const path = `${this.root}/native-records/${String(this.sequence + 1).padStart(12, "0")}-${hash}.json`;
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await this.files.write(temp, data);
    if (await this.files.read(temp) !== data) throw new Error("Native journal write verification failed.");
    await this.files.rename(temp, path);
    if (await this.files.read(path) !== data) throw new Error("Native journal commit verification failed.");
    this.state = state;
    this.sequence++;
    this.uncertain = false;
  }
  intent(path: string): FileIntent | null { this.trusted(); return this.state.intents[path] ?? null; }
  pending(): FileIntent[] { this.trusted(); return Object.values(this.state.intents); }
  tracked(path: string): TrackedHidden | null { this.trusted(); return this.state.tracked[path] ?? null; }
  recoveries(): NativeRecovery[] { this.trusted(); return [...this.state.recoveries]; }
  async begin(path: string, expected: Entry | null, next: Entry | null, method: NativeMethod): Promise<FileIntent> {
    this.trusted();
    if (this.state.intents[path]) throw new Error(`Unresolved native transaction: ${path}`);
    if (next) await verifyEntry(path, next);
    const id = crypto.randomUUID();
    const intent: FileIntent = { id, path, expected: expected?.oid ?? null, next: next?.oid ?? null,
      mode: next?.mode ?? null, method, stage: method === "rename" && next ? `${this.root}/stage/${id}` : null,
      hold: method === "rename" && expected ? `${this.root}/hold/${id}` : null, nextEntry: next };
    const intents = Object.assign(Object.create(null), this.state.intents);
    intents[path] = intent;
    await this.save({ ...this.state, intents });
    return intent;
  }
  async finish(path: string): Promise<void> {
    this.trusted();
    if (!this.state.intents[path]) return;
    const intents = Object.assign(Object.create(null), this.state.intents);
    const intent = intents[path];
    delete intents[path];
    const tracked = Object.assign(Object.create(null), this.state.tracked);
    for (const hidden of [intent.stage, intent.hold]) {
      if (hidden) tracked[hidden] = { path: intent.path, expected: intent.expected, next: intent.next };
    }
    await this.save({ ...this.state, intents, tracked });
  }
  async retain(input: Omit<NativeRecovery, "id">): Promise<NativeRecovery> {
    this.trusted();
    const record = { ...input, id: crypto.randomUUID() };
    await this.save({ ...this.state, recoveries: [...this.state.recoveries, record] });
    return record;
  }
  async readEvidence(record: NativeRecovery): Promise<Uint8Array> {
    this.trusted();
    if (!this.state.recoveries.some(item => item.id === record.id && item.evidencePath === record.evidencePath))
      throw new Error("Unknown native recovery record.");
    // Evidence is stored as canonical base64 text, not UTF-8 file content.
    const bytes = decodeBase64(await this.files.read(record.evidencePath));
    if (await hashBlob(bytes) !== record.oid) throw new Error("Native recovery evidence is corrupt.");
    return bytes;
  }
  /** Adopt a verified evidence file left between its write and its journal record. */
  async scanOrphanEvidence(): Promise<void> {
    this.trusted();
    for (const path of (await this.files.list(`${this.root}/recovery`)).files) {
      if (this.state.recoveries.some(item => item.evidencePath === path)) continue;
      const bytes = decodeBase64(await this.files.read(path));
      const oid = await hashBlob(bytes);
      await this.retain({ kind: "orphan", path, sourcePath: path, evidencePath: path,
        oid, expected: null, next: null });
    }
  }
  async storeEvidence(bytes: Uint8Array, path: string, sourcePath: string, kind: NativeRecoveryKind,
    expected: string | null, next: string | null): Promise<NativeRecovery> {
    this.trusted();
    const oid = await hashBlob(bytes);
    const evidencePath = `${this.root}/recovery/${crypto.randomUUID()}`;
    const data = encodeBase64(bytes);
    await this.files.write(evidencePath, data);
    if (await this.files.read(evidencePath) !== data) throw new Error("Native recovery evidence write failed.");
    return this.retain({ kind, path, sourcePath, evidencePath, oid, expected, next });
  }
}
