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

/** Append-only, verified journal. A corrupt latest record blocks recovery instead of silently using an older checkpoint. */
export class FileJournalStore implements DurableStore {
  private sequence = 0;
  private lastDigest: string | null = null;
  private loaded = false;
  readonly directory: string;
  constructor(
    private files: JournalFiles,
    installationId: string,
    namespace?: "modes",
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
  private async pack(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await this.pack(item));
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
        const hash = await digest(item);
        await this.put(`${this.directory}/objects/${hash}.json`, item);
        out[key] = { journalBlob: hash };
      } else if (key === "blobs" && isObject(item)) {
        const references: Record<string, unknown> = Object.create(null);
        for (const [oid, data] of Object.entries(item)) {
          if (typeof data !== "string")
            throw new Error("Invalid journal blob table");
          const hash = await digest(data);
          await this.put(`${this.directory}/objects/${hash}.json`, data);
          references[oid] = { journalBlob: hash };
        }
        out[key] = references;
      } else out[key] = await this.pack(item);
    }
    return out;
  }
  private async unpack(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await this.unpack(item));
      return result;
    }
    if (!isObject(value)) return value;
    if (
      typeof value.journalBlob === "string" &&
      Object.keys(value).length === 1
    ) {
      if (!/^[a-f0-9]{64}$/.test(value.journalBlob))
        throw new Error("Invalid recovery object reference");
      const bytes = await this.files.read(
        `${this.directory}/objects/${value.journalBlob}.json`,
      );
      if ((await digest(bytes)) !== value.journalBlob)
        throw new Error("Recovery object checksum failed");
      return bytes;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value))
      result[key] = await this.unpack(item);
    return result;
  }
  load(): Promise<unknown> {
    return serialize(this.files, this.directory, () => this.loadRecord());
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
      return null;
    }
    const latest = records[0];
    const text = await this.files.read(latest.path);
    if ((await digest(text)) !== latest.hash)
      throw new Error(
        "Latest recovery record is corrupt. Preserve the journal before recovering.",
      );
    const state: unknown = JSON.parse(text);
    const unpacked = await this.unpack(state);
    this.sequence = latest.sequence;
    this.lastDigest = latest.hash;
    this.loaded = true;
    return unpacked;
  }
  save(state: unknown): Promise<void> {
    return serialize(this.files, this.directory, () => this.append(state));
  }
  compact(): Promise<{ recordsRemoved: number; objectsRemoved: number; temporaryFilesRemoved: number }> {
    return serialize(this.files, this.directory, async () => {
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
        await this.unpack(state);
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
    });
  }
  private async assertHead(): Promise<void> {
    const latest = (await this.records())[0];
    if ((latest?.sequence ?? 0) !== this.sequence || (latest?.hash ?? null) !== this.lastDigest)
      throw new Error("Stale journal writer detected. Reload before syncing.");
  }
  private async append(state: unknown): Promise<void> {
    if (!this.loaded) await this.loadRecord();
    await this.assertHead();
    const text = JSON.stringify(await this.pack(state));
    if (typeof text !== "string") throw new Error("Invalid journal state");
    const hash = await digest(text);
    await this.assertHead();
    if (hash === this.lastDigest) return;
    const next = this.sequence + 1;
    const path = `${this.directory}/records/${String(next).padStart(12, "0")}-${hash}.json`;
    await this.put(path, text);
    this.sequence = next;
    this.lastDigest = hash;
  }
}
