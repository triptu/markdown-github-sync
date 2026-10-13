import { App, FileView, TFile } from "obsidian";
import { decodeBase64, entryFromBytes, hashBlob, isSyncablePath, verifyEntry } from "./codec";
import type { ApplyResult, Entry, LocalVault, NativeIssue, Snapshot } from "./contracts";
import type { NativeModes } from "./native-modes";
import { NativeTransactionJournal, type FileIntent, type NativeRecovery } from "./native-transactions";

const maxFileBytes = 8 * 1024 * 1024;
const maxVaultBytes = 128 * 1024 * 1024;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function visible(path: string): boolean { return path.split("/").every(part => !part.startsWith(".")); }
function safePath(path: string): void {
  if (!isSyncablePath(path) || path.split("/").some(part => !part || part === "." || part === ".."
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || /[\\:\x00-\x1f\x7f]/.test(path)) throw new Error(`Unsupported vault path: ${path}`);
}
function exactText(bytes: Uint8Array): string | null {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return equal(new TextEncoder().encode(value), bytes) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null;
  } catch { return null; }
}
export class GitObsidianVault implements LocalVault {
  private oversized = new Map<string, number>();
  constructor(
    private app: App,
    private modes: NativeModes = { get: () => "100644", set: () => {} },
    private assertActive: () => void = () => {},
    private transactions?: NativeTransactionJournal,
    private hostLifetime: string | null = null,
  ) {}
  private openView(path: string): boolean {
    let open = false;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof FileView && leaf.view.file?.path === path) open = true;
    });
    return open;
  }
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
  private async hiddenBytes(path: string): Promise<Uint8Array | "oversize" | null> {
    if (!(await this.app.vault.adapter.exists(path))) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && file.stat.size > maxFileBytes) {
      this.oversized.set(path, file.stat.size);
      return "oversize";
    }
    const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
    if (bytes.length > maxFileBytes) {
      this.oversized.set(path, bytes.length);
      return "oversize";
    }
    this.oversized.delete(path);
    return bytes;
  }
  private async hiddenOid(path: string): Promise<string | "oversize" | null> {
    const bytes = await this.hiddenBytes(path);
    return bytes === null || bytes === "oversize" ? bytes : hashBlob(bytes);
  }
  private async preserve(path: string, intent: FileIntent, kind: "interrupted" | "displaced"): Promise<ApplyResult> {
    const bytes = path === intent.path ? await this.read(path) : await this.hiddenBytes(path);
    if (bytes === "oversize") {
      await this.transactions?.retainOversize(intent.path, path, intent.expectedEntry, intent.nextEntry,
        this.oversized.get(path) ?? maxFileBytes + 1);
      return { kind: "blocked", reason: `Native recovery file exceeds 8 MiB: ${intent.path}. Review the retained hidden file.` };
    }
    if (bytes === null && path !== intent.path)
      return { kind: "blocked", reason: `Native recovery file moved during inspection: ${intent.path}. Retry after reviewing hidden files.` };
    const issue = bytes === null
      ? await this.transactions!.retainMissing(intent.path, intent.expectedEntry, intent.nextEntry)
      : await this.transactions!.retainBytes(bytes, intent.path, path, kind, intent.expectedEntry, intent.nextEntry);
    return { kind, issue };
  }
  private async stage(intent: FileIntent): Promise<ApplyResult | null> {
    if (!intent.stage || !intent.nextEntry) return null;
    if (await this.app.vault.adapter.exists(intent.stage)) {
      if (await this.hiddenOid(intent.stage) === intent.next) return null;
      return this.preserve(intent.stage, intent, "displaced");
    }
    const bytes = decodeBase64(intent.nextEntry.data);
    this.assertActive();
    await this.app.vault.adapter.writeBinary(intent.stage, bytes.buffer);
    if (await this.hiddenOid(intent.stage) !== intent.next) throw new Error(`Native stage verification failed: ${intent.path}`);
    return null;
  }
  private async rollbackHeld(intent: FileIntent): Promise<void> {
    if (intent.hold && await this.oid(intent.path) === null && await this.hiddenOid(intent.hold) !== null) {
      this.assertActive();
      await this.transactions?.markAttempted(intent.path);
      await this.app.vault.adapter.rename(intent.hold, intent.path);
    }
  }
  private async finish(intent: FileIntent, result: ApplyResult): Promise<ApplyResult> {
    if (result.kind === "blocked") return result;
    await this.transactions?.finish(intent.path);
    return result;
  }
  private async renameTransaction(intent: FileIntent): Promise<ApplyResult> {
    if (!this.transactions) throw new Error("Native transaction journal is unavailable.");
    const adapter = this.app.vault.adapter;
    let live = await this.oid(intent.path);
    let held = intent.hold ? await this.hiddenOid(intent.hold) : null;
    if (held === "oversize" && intent.hold) return this.preserve(intent.hold, intent, "displaced");
    const final = () => intent.next === null ? live === null : live === intent.next;
    if (final() && (held === null || held === intent.expected)) {
      if (intent.nextEntry) await this.modes.set(intent.path, intent.nextEntry.mode);
      else await this.modes.remove?.(intent.path);
      return this.finish(intent, { kind: "applied" });
    }
    if (held !== null && held !== intent.expected) {
      const issue = await this.preserve(intent.hold!, intent, "displaced");
      if (live === null) await this.rollbackHeld(intent);
      if (final() && intent.nextEntry) await this.modes.set(intent.path, intent.nextEntry.mode);
      return this.finish(intent, issue);
    }
    if (held !== null && live !== null) {
      const issue = await this.preserve(intent.path, intent, "interrupted");
      return this.finish(intent, issue);
    }
    if (held === null && live !== intent.expected) {
      if (!this.transactions.intent(intent.path)?.attempted) return this.finish(intent, { kind: "changed" });
      return this.finish(intent, await this.preserve(intent.path, intent, "interrupted"));
    }
    if (held === null && intent.expected !== null) {
      if (this.openView(intent.path)) return { kind: "blocked", reason: `Close the open view before replacing or deleting ${intent.path}.` };
      const staged = await this.stage(intent);
      if (staged) return this.finish(intent, staged);
      await this.transactions.markAttempted(intent.path);
      this.assertActive();
      await adapter.rename(intent.path, intent.hold!);
      held = await this.hiddenOid(intent.hold!);
      if (held !== intent.expected) {
        const issue = await this.preserve(intent.hold!, intent, "displaced");
        if (await this.oid(intent.path) === null) await this.rollbackHeld(intent);
        return this.finish(intent, issue);
      }
    }
    if (intent.next !== null) {
      const staged = await this.stage(intent);
      if (staged) { await this.rollbackHeld(intent); return this.finish(intent, staged); }
      if (await this.oid(intent.path) !== null) {
        return this.finish(intent, await this.preserve(intent.path, intent, "interrupted"));
      }
      await this.transactions.markAttempted(intent.path);
      this.assertActive();
      await adapter.rename(intent.stage!, intent.path);
      live = await this.oid(intent.path);
      if (live !== intent.next) return this.finish(intent, await this.preserve(intent.path, intent, "interrupted"));
    }
    if (intent.hold) {
      held = await this.hiddenOid(intent.hold);
      if (held !== intent.expected) {
        const issue = await this.preserve(intent.hold, intent, "displaced");
        if (intent.nextEntry) await this.modes.set(intent.path, intent.nextEntry.mode);
        return this.finish(intent, issue);
      }
    }
    if (intent.nextEntry) await this.modes.set(intent.path, intent.nextEntry.mode);
    else await this.modes.remove?.(intent.path);
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
      if (!this.transactions?.intent(intent.path)?.attempted) return this.finish(intent, { kind: "changed" });
      return this.finish(intent, await this.preserve(intent.path, intent, "interrupted"));
    }
    const before = await this.read(intent.path);
    if (before === null || await hashBlob(before) !== intent.expected) {
      if (!this.transactions?.intent(intent.path)?.attempted) return this.finish(intent, { kind: "changed" });
      return this.finish(intent, await this.preserve(intent.path, intent, "interrupted"));
    }
    const from = exactText(before);
    const to = exactText(decodeBase64(intent.nextEntry.data));
    if (from === null || to === null) throw new Error("Text transaction has non-UTF-8 bytes.");
    const file = this.app.vault.getAbstractFileByPath(intent.path);
    if (!(file instanceof TFile)) return this.finish(intent, { kind: "changed" });
    let matched = false;
    let observedText: string | null = null;
    await this.transactions?.markAttempted(intent.path);
    this.assertActive();
    try {
      await this.app.vault.process(file, text => {
        this.assertActive();
        observedText = text;
        if (text !== from) return text;
        matched = true;
        return to;
      });
    } catch (error) {
      // A caught failure can prove no visible write landed. A process death cannot,
      // so its durable attempted marker remains for restart recovery.
      if (await this.oid(intent.path) === intent.expected) await this.transactions?.clearAttempt(intent.path);
      throw error;
    }
    const after = await this.oid(intent.path);
    if (after !== intent.next) {
      if (!matched && observedText !== null && after === await hashBlob(new TextEncoder().encode(observedText)))
        return this.finish(intent, { kind: "changed" });
      return this.finish(intent, await this.preserve(intent.path, intent, "interrupted"));
    }
    await this.modes.set(intent.path, intent.nextEntry.mode);
    return this.finish(intent, { kind: "applied" });
  }
  /** Replays pending intents and scans hidden files once at this boundary, never per apply step. */
  async recoverNative(): Promise<NativeRecovery[]> {
    this.assertActive();
    if (!this.transactions) return [];
    for (const intent of this.transactions.pending()) {
      if (intent.method === "rename") await this.renameTransaction(intent);
      else await this.textTransaction(intent);
    }
    for (const kind of ["hold", "stage"] as const) {
      const directory = `${this.transactions.root}/${kind}`;
      for (const path of (await this.app.vault.adapter.list(directory)).files) {
        const tracked = this.transactions.tracked(path);
        if (!tracked) continue;
        const bytes = await this.hiddenBytes(path);
        if (bytes === null) { await this.transactions.untrack(path); continue; }
        if (bytes === "oversize") {
          await this.transactions.retainOversize(tracked.path, path, tracked.expected, tracked.next,
            this.oversized.get(path) ?? maxFileBytes + 1);
          continue;
        }
        const oid = await hashBlob(bytes);
        // Only a new host App lifetime proves the old TFile and its delayed writes are gone.
        // The journal has already durably stored and verified the exact preimage entry.
        const known = kind === "hold" ? tracked.expected : tracked.next;
        if (tracked.hostLifetime && this.hostLifetime && tracked.hostLifetime !== this.hostLifetime
          && known?.oid === oid && this.app.vault.adapter.remove) {
          await verifyEntry(tracked.path, known);
          this.assertActive();
          await this.app.vault.adapter.remove(path);
          await this.transactions.untrack(path);
          continue;
        }
        if (oid === (kind === "hold" ? tracked.expected?.oid : tracked.next?.oid) || oid === tracked.observed) continue;
        await this.transactions.retainBytes(bytes, tracked.path, path, "displaced", tracked.expected, tracked.next);
        await this.transactions.observe(path, oid);
      }
    }
    await this.transactions.compact();
    return this.transactions.recoveries();
  }
  async recover(): Promise<NativeIssue[]> {
    await this.recoverNative();
    return this.transactions?.issues() ?? [];
  }
  async acknowledgeRecovery(ids: string[]): Promise<void> { await this.transactions?.acknowledge(ids); }
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
    if (this.transactions?.recoveries().some(item => item.kind === "oversize" && item.path === path))
      return { kind: "blocked", reason: `Review oversized native recovery file for ${path} before writing this path.` };
    const pending = this.transactions?.intent(path);
    if (pending) return pending.method === "rename" ? this.renameTransaction(pending) : this.textTransaction(pending);
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
    const method = expected && next
      && exactText(decodeBase64(expected.data)) !== null && exactText(decodeBase64(next.data)) !== null
      ? "text-process" : "rename";
    if (method === "rename" && expected && this.openView(path))
      return { kind: "blocked", reason: `Close the open view before replacing or deleting ${path}.` };
    const intent = await this.transactions.begin(path, expected, next, method, this.hostLifetime);
    return method === "rename" ? this.renameTransaction(intent) : this.textTransaction(intent);
  }
}
