import type { Entry, FileMode } from "./contracts";
import { FileJournalStore } from "./store";

export interface ModeIntent {
  expectedOid: string | null;
  nextOid: string;
  mode: FileMode;
}
export interface NativeModes {
  get(path: string): FileMode;
  set(path: string, mode: FileMode): void | Promise<void>;
  remove?(path: string): void | Promise<void>;
  begin?(path: string, expected: Entry | null, next: Entry): Promise<void>;
  cancel?(path: string): Promise<void>;
  recover?(readOid: (path: string) => Promise<string | null>): Promise<void>;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mode(value: unknown): value is FileMode { return value === "100644" || value === "100755"; }
function oid(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value); }
export function parseModes(value: unknown): Record<string, FileMode> {
  if (!object(value)) throw new Error("File mode metadata is corrupt.");
  const modes: Record<string, FileMode> = Object.create(null);
  for (const [path, item] of Object.entries(value)) {
    if (!mode(item)) throw new Error("File mode metadata is corrupt.");
    modes[path] = item;
  }
  return modes;
}
/** The intent is committed before touching bytes; capture resolves interrupted writes by their blob IDs. */
export class NativeModeStore implements NativeModes {
  private pending: Record<string, ModeIntent> = Object.create(null);
  private uncertain = false;
  private constructor(private journal: FileJournalStore, private modes: Record<string, FileMode>) {}
  static async open(journal: FileJournalStore, seed: Record<string, FileMode>): Promise<NativeModeStore> {
    const saved = await journal.load();
    const store = new NativeModeStore(journal, Object.assign(Object.create(null), seed));
    if (saved !== null) {
      if (!object(saved) || saved.format !== 1 || !object(saved.pending)) throw new Error("File mode journal is corrupt.");
      store.modes = parseModes(saved.modes);
      for (const [path, item] of Object.entries(saved.pending)) {
        if (!object(item) || !(item.expectedOid === null || oid(item.expectedOid)) || !oid(item.nextOid) || !mode(item.mode))
          throw new Error("File mode intent is corrupt.");
        store.pending[path] = { expectedOid: item.expectedOid, nextOid: item.nextOid, mode: item.mode };
      }
    } else if (Object.keys(seed).length) {
      // Persist inherited modes before the engine can advance away from their checkpoint.
      await store.save();
    }
    return store;
  }
  private save(): Promise<void> {
    return this.journal.save({ format: 1, modes: this.modes, pending: this.pending });
  }
  private assertTrusted(): void {
    if (this.uncertain) throw new Error("File mode persistence is uncertain. Reload the plugin before syncing.");
  }
  private async commit(modes: Record<string, FileMode>, pending: Record<string, ModeIntent>): Promise<void> {
    this.assertTrusted();
    this.uncertain = true;
    try {
      await this.journal.save({ format: 1, modes, pending });
      this.modes = modes;
      this.pending = pending;
      this.uncertain = false;
    } catch (error) {
      try {
        // A failed acknowledgment does not tell us whether the record committed.
        const durable = await NativeModeStore.open(this.journal, this.modes);
        this.modes = durable.modes;
        this.pending = durable.pending;
        this.uncertain = false;
      } catch { /* Keep reads blocked until a successful reopen. */ }
      throw error;
    }
  }
  get(path: string): FileMode { this.assertTrusted(); return this.modes[path] ?? "100644"; }
  async set(path: string, value: FileMode): Promise<void> {
    this.assertTrusted();
    if (!this.pending[path] && this.get(path) === value) return;
    const modes = Object.assign(Object.create(null), this.modes);
    const pending = Object.assign(Object.create(null), this.pending);
    modes[path] = value;
    delete pending[path];
    await this.commit(modes, pending);
  }
  async remove(path: string): Promise<void> {
    this.assertTrusted();
    if (!Object.hasOwn(this.modes, path) && !this.pending[path]) return;
    const modes = Object.assign(Object.create(null), this.modes);
    const pending = Object.assign(Object.create(null), this.pending);
    delete modes[path];
    delete pending[path];
    await this.commit(modes, pending);
  }
  async begin(path: string, expected: Entry | null, next: Entry): Promise<void> {
    this.assertTrusted();
    if (this.pending[path]) throw new Error(`Unresolved file mode intent: ${path}`);
    if (next.mode === this.get(path)) return;
    const pending = Object.assign(Object.create(null), this.pending);
    pending[path] = { expectedOid: expected?.oid ?? null, nextOid: next.oid, mode: next.mode };
    await this.commit(this.modes, pending);
  }
  async cancel(path: string): Promise<void> {
    this.assertTrusted();
    if (!this.pending[path]) return;
    const pending = Object.assign(Object.create(null), this.pending);
    delete pending[path];
    await this.commit(this.modes, pending);
  }
  async recover(readOid: (path: string) => Promise<string | null>): Promise<void> {
    this.assertTrusted();
    for (const [path, intent] of Object.entries(this.pending)) {
      const current = await readOid(path);
      if (current === intent.nextOid) await this.set(path, intent.mode);
      else if (current === intent.expectedOid) await this.cancel(path);
      else throw new Error(`Interrupted file update at ${path} needs recovery before syncing. Its mode intent has been retained.`);
    }
  }
  async rename(from: string, to: string): Promise<void> {
    this.assertTrusted();
    const moved = (path: string) => path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
    // Remove source keys first, so folder moves cannot accidentally consume newly moved keys.
    const modes = Object.entries(this.modes).flatMap(([path, value]) => {
      const target = moved(path); return target === null ? [] : [{ path, target, value }];
    });
    const intents = Object.entries(this.pending).flatMap(([path, value]) => {
      const target = moved(path); return target === null ? [] : [{ path, target, value }];
    });
    if (!modes.length && !intents.length) return;
    const nextModes = Object.assign(Object.create(null), this.modes);
    const nextPending = Object.assign(Object.create(null), this.pending);
    for (const item of modes) delete nextModes[item.path];
    for (const item of intents) delete nextPending[item.path];
    for (const item of modes) nextModes[item.target] = item.value;
    for (const item of intents) nextPending[item.target] = item.value;
    await this.commit(nextModes, nextPending);
  }
}
