import type { DurableStore } from "./contracts";
import { serialize } from "./ownership";

export interface JournalFiles {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  remove?(path: string): Promise<void>;
}
const root = ".git-vault-sync";
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
async function digest(text: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapObjects<T, R>(items: T[], operation: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index]); }
      catch (error) { failures.push(error); }
    }
  }));
  // Every started object write has settled before the journal queue can advance.
  if (failures.length) throw failures.find(error => error instanceof Error) ?? failures[0];
  return results;
}

/** Append-only, verified journal. A corrupt latest record blocks recovery instead of silently using an older checkpoint. */
export class FileJournalStore implements DurableStore {
  private sequence = 0;
  private lastDigest: string | null = null;
  private loaded = false;
  /**
   * Parsed (still packed) JSON of the latest record this instance read or
   * wrote, keyed by its file name, which embeds the sequence and SHA-256 of
   * the exact text. A load whose listing names the same head reuses it.
   */
  private head: { path: string; record: unknown } | null = null;
  /**
   * Object bodies whose SHA-256 this instance verified (on read) or wrote and
   * read back (on save). Content addressed, so each is verified once per
   * instance; pruned to the objects the latest loaded record references.
   * Saves still compare every existing object on disk before appending.
   */
  private verified = new Map<string, string>();
  readonly directory: string;
  constructor(
    private files: JournalFiles,
    installationId: string,
    namespace?: "modes" | "native",
  ) {
    if (!/^[a-f0-9-]{36}$/.test(installationId))
      throw new Error("Invalid installation identity");
    this.directory = `${root}/${installationId}${namespace ? `/${namespace}` : ""}`;
  }
  private async ensure(path: string): Promise<void> {
    if (!(await this.files.exists(path))) await this.files.mkdir(path);
  }
  private async prepare(): Promise<void> {
    await this.ensure(root);
    await this.ensure(this.directory.split("/").slice(0, 2).join("/"));
    await this.ensure(this.directory);
    await this.ensure(`${this.directory}/objects`);
    await this.ensure(`${this.directory}/records`);
  }
  private async put(path: string, text: string): Promise<void> {
    if (await this.files.exists(path)) {
      if ((await this.files.read(path)) !== text)
        throw new Error("Recovery object is corrupt. Sync stopped.");
      return;
    }
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await this.files.write(temp, text);
    if ((await this.files.read(temp)) !== text)
      throw new Error("Recovery write verification failed. Sync stopped.");
    await this.files.rename(temp, path);
    if ((await this.files.read(path)) !== text)
      throw new Error("Recovery commit verification failed. Sync stopped.");
  }
  private async packObject(data: string, pending: Map<string, Promise<string>>): Promise<string> {
    let object = pending.get(data);
    if (!object) {
      object = (async () => {
        const hash = await digest(data);
        await this.put(`${this.directory}/objects/${hash}.json`, data);
        this.verified.set(hash, data);
        return hash;
      })();
      pending.set(data, object);
    }
    return object;
  }
  private async pack(value: unknown, pending = new Map<string, Promise<string>>()): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await this.pack(item, pending));
      return result;
    }
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (
        key === "data" &&
        typeof item === "string" &&
        typeof value.oid === "string"
      ) {
        out[key] = { journalBlob: await this.packObject(item, pending) };
      } else if (key === "blobs" && isObject(item)) {
        const references: Record<string, unknown> = Object.create(null);
        const packed = await mapObjects(Object.entries(item), async ([oid, data]) => {
          if (typeof data !== "string")
            throw new Error("Invalid journal blob table");
          return { oid, hash: await this.packObject(data, pending) };
        });
        for (const { oid, hash } of packed) references[oid] = { journalBlob: hash };
        out[key] = references;
      } else out[key] = await this.pack(item, pending);
    }
    return out;
  }
  private async unpack(value: unknown, pending = new Map<string, Promise<string>>(), cached = true): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await this.unpack(item, pending, cached));
      return result;
    }
    if (!isObject(value)) return value;
    if (
      typeof value.journalBlob === "string" &&
      Object.keys(value).length === 1
    ) {
      if (!/^[a-f0-9]{64}$/.test(value.journalBlob))
        throw new Error("Invalid recovery object reference");
      const hash = value.journalBlob;
      let object = pending.get(hash);
      if (!object) {
        const known = cached ? this.verified.get(hash) : undefined;
        object = known !== undefined ? Promise.resolve(known) : (async () => {
          const bytes = await this.files.read(`${this.directory}/objects/${hash}.json`);
          if ((await digest(bytes)) !== hash)
            throw new Error("Recovery object checksum failed");
          if (cached) this.verified.set(hash, bytes);
          return bytes;
        })();
        pending.set(hash, object);
      }
      return object;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (key === "blobs" && isObject(item)) {
        const unpacked = await mapObjects(Object.entries(item), async ([oid, reference]) =>
          ({ oid, bytes: await this.unpack(reference, pending, cached) }));
        const blobs: Record<string, unknown> = Object.create(null);
        for (const { oid, bytes } of unpacked) blobs[oid] = bytes;
        result[key] = blobs;
      } else result[key] = await this.unpack(item, pending, cached);
    }
    return result;
  }
  load(): Promise<unknown> {
    return serialize(this.files, this.directory, () => this.forgetOnFailure(() => this.loadRecord()));
  }
  /**
   * Any failed load, save or cleanup drops the in-memory head and verified
   * objects, so the next load rereads and reverifies everything from disk.
   */
  private async forgetOnFailure<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      this.head = null;
      this.verified.clear();
      throw error;
    }
  }
  private async records() {
    await this.prepare();
    const listing = await this.files.list(`${this.directory}/records`);
    const records = listing.files
      .filter((path) => path.endsWith(".json"))
      .map((path) => {
        const match = /\/(\d{12})-([a-f0-9]{64})\.json$/.exec(path);
        if (!match)
          throw new Error("Unrecognized recovery record. Sync stopped.");
        return { path, sequence: Number(match[1]), hash: match[2] };
      })
      .sort((a, b) => b.sequence - a.sequence);
    for (let i = 1; i < records.length; i++) {
      if (records[i].sequence === records[i - 1].sequence)
        throw new Error("Multiple journal writers detected. Sync stopped.");
    }
    return records;
  }
  private async loadRecord(): Promise<unknown> {
    const records = await this.records();
    if (!records.length) {
      this.sequence = 0;
      this.lastDigest = null;
      this.loaded = true;
      this.head = null;
      this.verified.clear();
      return null;
    }
    const latest = records[0];
    let state: unknown;
    if (this.head?.path === latest.path) state = this.head.record;
    else {
      const text = await this.files.read(latest.path);
      if ((await digest(text)) !== latest.hash)
        throw new Error(
          "Latest recovery record is corrupt. Preserve the journal before recovering.",
        );
      state = JSON.parse(text);
    }
    // `unpack` builds a fresh tree and never mutates the cached record.
    const referenced = new Map<string, Promise<string>>();
    const unpacked = await this.unpack(state, referenced);
    this.head = { path: latest.path, record: state };
    for (const hash of [...this.verified.keys()]) if (!referenced.has(hash)) this.verified.delete(hash);
    this.sequence = latest.sequence;
    this.lastDigest = latest.hash;
    this.loaded = true;
    return unpacked;
  }
  save(state: unknown): Promise<void> {
    return serialize(this.files, this.directory, () => this.forgetOnFailure(() => this.append(state)));
  }
  /** Rereads and reverifies every retained record and object from disk; never uses the load caches. */
  compact(): Promise<{ recordsRemoved: number; objectsRemoved: number; temporaryFilesRemoved: number }> {
    return serialize(this.files, this.directory, () => this.forgetOnFailure(async () => {
      if (!this.files.remove) throw new Error("This storage adapter does not support recovery cleanup.");
      if (!this.loaded) await this.loadRecord();
      await this.assertHead();
      const records = await this.records();
      const retained = records.slice(0, 8);
      const live = new Set<string>();
      const references = (value: unknown): void => {
        if (Array.isArray(value)) { for (const item of value) references(item); return; }
        if (!isObject(value)) return;
        if (typeof value.journalBlob === "string" && Object.keys(value).length === 1) {
          live.add(value.journalBlob);
          return;
        }
        for (const item of Object.values(value)) references(item);
      };
      for (const record of retained) {
        const text = await this.files.read(record.path);
        if (await digest(text) !== record.hash) throw new Error("Recovery record checksum failed. Cleanup stopped.");
        const state: unknown = JSON.parse(text);
        await this.unpack(state, new Map(), false);
        references(state);
      }
      await this.assertHead();
      let recordsRemoved = 0, objectsRemoved = 0, temporaryFilesRemoved = 0;
      // Remove obsolete records first: an interruption may leave extra objects, never dangling references.
      for (const record of records.slice(8)) { await this.files.remove(record.path); recordsRemoved++; }
      for (const path of (await this.files.list(`${this.directory}/objects`)).files) {
        const match = /^([a-f0-9]{64})\.json$/.exec(path.slice(`${this.directory}/objects/`.length));
        if (path.startsWith(`${this.directory}/objects/`) && match && !live.has(match[1])) {
          await this.files.remove(path); objectsRemoved++;
        }
      }
      // Saves use the same queue. Only our exact temporary naming scheme is disposable.
      for (const kind of ["records", "objects"] as const) {
        const prefix = `${this.directory}/${kind}/`;
        const pattern = kind === "records"
          ? /^\d{12}-[a-f0-9]{64}\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/
          : /^[a-f0-9]{64}\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
        for (const path of (await this.files.list(`${this.directory}/${kind}`)).files) {
          if (path.startsWith(prefix) && pattern.test(path.slice(prefix.length))) {
            await this.files.remove(path);
            temporaryFilesRemoved++;
          }
        }
      }
      return { recordsRemoved, objectsRemoved, temporaryFilesRemoved };
    }));
  }
  private async assertHead(): Promise<void> {
    const latest = (await this.records())[0];
    if ((latest?.sequence ?? 0) !== this.sequence || (latest?.hash ?? null) !== this.lastDigest)
      throw new Error("Stale journal writer detected. Reload before syncing.");
  }
  private async append(state: unknown): Promise<void> {
    if (!this.loaded) await this.loadRecord();
    await this.assertHead();
    const written = new Map<string, Promise<string>>();
    const text = JSON.stringify(await this.pack(state, written));
    if (typeof text !== "string") throw new Error("Invalid journal state");
    const referenced = new Set(await Promise.all(written.values()));
    for (const known of [...this.verified.keys()]) if (!referenced.has(known)) this.verified.delete(known);
    const hash = await digest(text);
    await this.assertHead();
    if (hash === this.lastDigest) return;
    const next = this.sequence + 1;
    const path = `${this.directory}/records/${String(next).padStart(12, "0")}-${hash}.json`;
    await this.put(path, text);
    this.sequence = next;
    this.lastDigest = hash;
    this.head = { path, record: JSON.parse(text) };
  }
}
