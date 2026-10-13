import { App, TFile } from "obsidian";
import { decodeBase64, entryFromBytes, hashBlob, verifyEntry } from "./codec";
import type { ApplyResult, Entry, LocalVault, Snapshot } from "./contracts";
import type { NativeModes } from "./native-modes";
import { NativeTransactionJournal, type FileIntent, type NativeRecovery } from "./native-transactions";

const maxFileBytes = 8 * 1024 * 1024;
const maxVaultBytes = 128 * 1024 * 1024;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function visible(path: string): boolean { return path.split("/").every(part => !part.startsWith(".")); }
function safePath(path: string): void {
  if (!path || !visible(path) || path.split("/").some(part => !part || part === "." || part === ".."
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || /[\\:\x00-\x1f\x7f]/.test(path)) throw new Error(`Unsupported vault path: ${path}`);
}
function exactText(bytes: Uint8Array): string | null {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return equal(new TextEncoder().encode(value), bytes) ? value : null;
  } catch { return null; }
}
export class GitObsidianVault implements LocalVault {
  constructor(
    private app: App,
    private modes: NativeModes = { get: () => "100644", set: () => {} },
    private assertActive: () => void = () => {},
    private transactions?: NativeTransactionJournal,
  ) {}
  private async read(path: string): Promise<Uint8Array | null> {
    this.assertActive();
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    const bytes = new Uint8Array(await adapter.readBinary(path));
    if (bytes.length > maxFileBytes) throw new Error(`File exceeds 8 MiB: ${path}`);
    return bytes;
  }
  private async oid(path: string): Promise<string | null> {
    const bytes = await this.read(path);
    return bytes === null ? null : hashBlob(bytes);
  }
  private async preserve(path: string, intent: FileIntent, kind: NativeRecovery["kind"]): Promise<void> {
    const bytes = await this.read(path);
    if (bytes) await this.transactions?.storeEvidence(bytes, intent.path, path, kind, intent.expected, intent.next);
  }
  private async stage(intent: FileIntent): Promise<boolean> {
    if (!intent.stage || !intent.nextEntry) return true;
    if (await this.app.vault.adapter.exists(intent.stage)) {
      if (await this.oid(intent.stage) === intent.next) return true;
      await this.preserve(intent.stage, intent, "orphan");
      return false;
    }
    const bytes = decodeBase64(intent.nextEntry.data);
    this.assertActive();
    await this.app.vault.adapter.writeBinary(intent.stage, bytes.buffer);
    if (await this.oid(intent.stage) !== intent.next) throw new Error(`Native stage verification failed: ${intent.path}`);
    return true;
  }
  private async rollbackHeld(intent: FileIntent): Promise<void> {
    if (intent.hold && await this.oid(intent.path) === null && await this.oid(intent.hold) !== null) {
      this.assertActive();
      await this.app.vault.adapter.rename(intent.hold, intent.path);
    }
  }
  private async finish(intent: FileIntent, result: ApplyResult): Promise<ApplyResult> {
    await this.transactions?.finish(intent.path);
    return result;
  }
  private async renameTransaction(intent: FileIntent): Promise<ApplyResult> {
    if (!this.transactions) throw new Error("Native transaction journal is unavailable.");
    const adapter = this.app.vault.adapter;
    let live = await this.oid(intent.path);
    let held = intent.hold ? await this.oid(intent.hold) : null;
    const final = () => intent.next === null ? live === null : live === intent.next;
    if (final() && (held === null || held === intent.expected)) {
      if (intent.next && intent.mode) await this.modes.set(intent.path, intent.mode);
      if (!intent.next) await this.modes.remove?.(intent.path);
      // Keep the hold: Obsidian retargets an existing TFile to it. A delayed write must remain observable.
      return this.finish(intent, { kind: "applied" });
    }
    if (held !== null && held !== intent.expected) {
      if (live === null) {
        this.assertActive();
        await adapter.rename(intent.hold!, intent.path); // no-clobber rollback
      } else await this.preserve(intent.hold!, intent, "displaced");
      return this.finish(intent, { kind: "changed" });
    }
    if (held !== null && live !== null) {
      await this.preserve(intent.hold!, intent, "changed");
      return this.finish(intent, { kind: "changed" });
    }
    if (held === null && live !== intent.expected) return this.finish(intent, { kind: "changed" });
    if (held === null && intent.expected !== null) {
      if (!(await this.stage(intent))) return this.finish(intent, { kind: "changed" });
      this.assertActive();
      await adapter.rename(intent.path, intent.hold!);
      held = await this.oid(intent.hold!);
      if (held !== intent.expected) {
        if (await this.oid(intent.path) === null) {
          this.assertActive();
          await adapter.rename(intent.hold!, intent.path);
        } else await this.preserve(intent.hold!, intent, "changed");
        return this.finish(intent, { kind: "changed" });
      }
    }
    if (intent.next !== null) {
      if (!(await this.stage(intent))) {
        await this.rollbackHeld(intent);
        return this.finish(intent, { kind: "changed" });
      }
      if (await this.oid(intent.path) !== null) {
        if (intent.hold) await this.preserve(intent.hold, intent, "changed");
        return this.finish(intent, { kind: "changed" });
      }
      this.assertActive();
      await adapter.rename(intent.stage!, intent.path);
      live = await this.oid(intent.path);
      if (live !== intent.next) {
        await this.preserve(intent.path, intent, "interrupted");
        return this.finish(intent, { kind: "changed" });
      }
    }
    if (intent.hold) {
      held = await this.oid(intent.hold);
      if (held !== intent.expected) {
        await this.preserve(intent.hold, intent, "displaced");
        return this.finish(intent, { kind: "changed" });
      }
    }
    if (intent.next && intent.mode) await this.modes.set(intent.path, intent.mode);
    if (!intent.next) await this.modes.remove?.(intent.path);
    return this.finish(intent, { kind: "applied" });
  }
  private async textTransaction(intent: FileIntent): Promise<ApplyResult> {
    if (!intent.nextEntry || !intent.expected) throw new Error("Invalid text transaction.");
    const now = await this.oid(intent.path);
    if (now === intent.next) {
      await this.modes.set(intent.path, intent.nextEntry.mode);
      return this.finish(intent, { kind: "applied" });
    }
    if (now !== intent.expected) {
      await this.preserve(intent.path, intent, "interrupted");
      return this.finish(intent, { kind: "changed" });
    }
    const before = await this.read(intent.path);
    const from = before && exactText(before);
    const to = exactText(decodeBase64(intent.nextEntry.data));
    if (from === null || to === null) throw new Error("Text transaction has non-UTF-8 bytes.");
    const file = this.app.vault.getAbstractFileByPath(intent.path);
    if (!(file instanceof TFile)) return this.finish(intent, { kind: "changed" });
    let matched = false;
    this.assertActive();
    await this.app.vault.process(file, text => {
      this.assertActive();
      if (text !== from) return text;
      matched = true;
      return to;
    });
    if (!matched || await this.oid(intent.path) !== intent.next) {
      await this.preserve(intent.path, intent, "interrupted");
      return this.finish(intent, { kind: "changed" });
    }
    await this.modes.set(intent.path, intent.nextEntry.mode);
    return this.finish(intent, { kind: "applied" });
  }
  /** Complete pending intents before capture can plan from local bytes. */
  async recoverNative(): Promise<NativeRecovery[]> {
    this.assertActive();
    if (!this.transactions) return [];
    await this.transactions.scanOrphanEvidence();
    for (const intent of this.transactions.pending()) {
      if (intent.method === "rename") await this.renameTransaction(intent);
      else await this.textTransaction(intent);
    }
    // A hold can receive a later write through its retargeted TFile. Record each exact version.
    for (const kind of ["hold", "stage"] as const) {
      const directory = `${this.transactions.root}/${kind}`;
      for (const path of (await this.app.vault.adapter.list(directory)).files) {
        const bytes = await this.read(path);
        if (!bytes) continue;
        const oid = await hashBlob(bytes);
        if (this.transactions.recoveries().some(record => record.sourcePath === path && record.oid === oid)) continue;
        const tracked = this.transactions.tracked(path);
        await this.transactions.storeEvidence(bytes, tracked?.path ?? path, path, "orphan",
          tracked?.expected ?? null, tracked?.next ?? null);
      }
    }
    return this.transactions.recoveries();
  }
  nativeRecoveries(): NativeRecovery[] { return this.transactions?.recoveries() ?? []; }
  async capture(): Promise<Snapshot> {
    this.assertActive();
    await this.recoverNative();
    await this.modes.recover?.(path => this.oid(path));
    const files = this.app.vault.getFiles().filter(file => visible(file.path));
    const snapshot: Snapshot = Object.create(null);
    const paths = new Set<string>();
    let total = 0;
    for (const file of files) {
      safePath(file.path);
      const folded = file.path.normalize("NFC").toLowerCase();
      if (paths.has(folded)) throw new Error(`Case or Unicode path collision: ${file.path}`);
      paths.add(folded);
      const bytes = await this.read(file.path);
      if (!bytes) throw new Error("The vault changed during capture. Sync will retry.");
      total += bytes.length;
      if (total > maxVaultBytes) throw new Error("Vault content exceeds the 128 MiB safety limit.");
      snapshot[file.path] = await entryFromBytes(bytes, this.modes.get(file.path));
    }
    return snapshot;
  }
  private async folders(path: string): Promise<void> {
    const parts = path.split("/"); parts.pop();
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(prefix))) {
        try { this.assertActive(); await this.app.vault.createFolder(prefix); }
        catch (error) { if (!(await this.app.vault.adapter.exists(prefix))) throw error; }
      }
    }
  }
  async apply(path: string, expected: Entry | null, next: Entry | null): Promise<ApplyResult> {
    safePath(path);
    await this.recoverNative();
    await this.modes.recover?.(pendingPath => this.oid(pendingPath));
    if (expected) await verifyEntry(path, expected);
    if (next) await verifyEntry(path, next);
    const current = await this.read(path);
    if (next && current && equal(current, decodeBase64(next.data))) {
      await this.modes.set(path, next.mode);
      return { kind: "applied" };
    }
    if (!next && !current) {
      await this.modes.remove?.(path);
      return { kind: "applied" };
    }
    if (expected ? !current || !equal(current, decodeBase64(expected.data)) : current !== null)
      return { kind: "changed" };
    if (next && decodeBase64(next.data).length > maxFileBytes) throw new Error(`Invalid incoming bytes: ${path}`);
    if (!this.transactions) return { kind: "blocked", reason: `Native transaction journal is required for ${path}.` };
    if (next) await this.folders(path);
    const method = expected && next && /\.md$/i.test(path)
      && exactText(decodeBase64(expected.data)) !== null && exactText(decodeBase64(next.data)) !== null
      ? "text-process" : "rename";
    const intent = await this.transactions.begin(path, expected, next, method);
    return method === "rename" ? this.renameTransaction(intent) : this.textTransaction(intent);
  }
}
