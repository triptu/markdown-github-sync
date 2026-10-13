import { App, FileView, TFile } from "obsidian";
import { decodeBase64, entryFromBytes, hashBlob, isSyncablePath, isValidPath, verifyEntry } from "./codec";
import type { ApplyResult, Entry, LocalVault, NativeIssue, Snapshot } from "./contracts";
import type { NativeModes } from "./native-modes";
import { NativeTransactionJournal, type FileIntent, type NativeOversizeRecovery, type NativeRecovery, type PendingNativeIntent } from "./native-transactions";

export interface RecoveryAuthorization { replay: string[]; cancel: string[] }
export interface UnreadableNativeFile { path: string; size: number; mtime: number | null; reason: "oversize" }

const maxFileBytes = 8 * 1024 * 1024;
const maxVaultBytes = 128 * 1024 * 1024;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
class OversizeReadError extends Error {
  constructor(readonly path: string) { super(`File exceeds 8 MiB: ${path}`); }
}
function visible(path: string): boolean { return path.split("/").every(part => !part.startsWith(".")); }
function safePath(path: string): void {
  if (!isSyncablePath(path) || path.split("/").some(part => !part || part === "." || part === ".."
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || /[\\:\x00-\x1f\x7f]/.test(path)) throw new Error(`Unsupported vault path: ${path}`);
}
function safeExportPath(path: string): void {
  if (!isValidPath(path)) throw new Error(`Unsupported export path: ${path}`);
  const [directory, ...suffix] = path.split("/");
  if (!/^\.git-vault-sync-export-[0-9a-f-]{36}$/.test(directory) || suffix.length === 0)
    throw new Error(`Export must use a dedicated hidden directory: ${path}`);
  safePath(suffix.join("/"));
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
    const stat = await adapter.stat(path);
    if (stat?.type === "file" && stat.size > maxFileBytes) throw new OversizeReadError(path);
    const bytes = new Uint8Array(await adapter.readBinary(path));
    if (bytes.length > maxFileBytes) throw new OversizeReadError(path);
    return bytes;
  }
  private async oid(path: string): Promise<string | null> {
    const bytes = await this.read(path);
    return bytes === null ? null : hashBlob(bytes);
  }
  private async hiddenBytes(path: string): Promise<Uint8Array | "oversize" | null> {
    if (!(await this.app.vault.adapter.exists(path))) return null;
    const stat = await this.app.vault.adapter.stat(path);
    if (stat?.type === "file" && stat.size > maxFileBytes) {
      this.oversized.set(path, stat.size);
      return "oversize";
    }
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
  private async hiddenMtime(path: string): Promise<number | null> {
    const stat = await this.app.vault.adapter.stat(path);
    return stat?.type === "file" ? stat.mtime : null;
  }
  private async preserve(path: string, intent: FileIntent, kind: "interrupted" | "displaced"): Promise<ApplyResult> {
    const bytes = await this.hiddenBytes(path);
    if (bytes === "oversize") {
      await this.transactions?.retainOversize(intent.path, path, intent.expectedEntry, intent.nextEntry,
        this.oversized.get(path) ?? maxFileBytes + 1, await this.hiddenMtime(path));
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
  /** A pending intent cannot interpret an unreadable live source as absent. */
  private async pendingSource(intent: FileIntent): Promise<ApplyResult | null> {
    if (!this.transactions) return null;
    const bytes = await this.hiddenBytes(intent.path);
    if (bytes === "oversize") {
      await this.transactions.retainOversize(intent.path, intent.path, intent.expectedEntry, intent.nextEntry,
        this.oversized.get(intent.path) ?? maxFileBytes + 1, await this.hiddenMtime(intent.path));
    } else if (this.transactions.oversizeForSource(intent.path)) {
      await this.transactions.supersedeOversize(intent.path, bytes);
    } else if (this.transactions.hasAcknowledgedOversizeSource(intent.path)) {
      await this.transactions.retainChangedAcknowledgedSource(intent.path, intent.path,
        intent.expectedEntry, intent.nextEntry, bytes);
    } else if (this.transactions.missingForSource(intent.path)) {
      if (bytes !== null) await this.transactions.supersedeMissing(intent.path, bytes);
    } else return null;
    return { kind: "blocked", reason: `Native recovery source changed at ${intent.path}. Review the retained evidence.` };
  }
  private async pendingOversizeRace(intent: FileIntent, error: unknown): Promise<ApplyResult> {
    if (!(error instanceof OversizeReadError) || error.path !== intent.path) throw error;
    const result = await this.pendingSource(intent);
    if (!result) await this.preserve(intent.path, intent, "interrupted");
    return { kind: "blocked", reason: `Native recovery source changed at ${intent.path}. Review the retained evidence.` };
  }
  private async renameTransaction(intent: FileIntent): Promise<ApplyResult> {
    if (!this.transactions) throw new Error("Native transaction journal is unavailable.");
    const source = await this.pendingSource(intent);
    if (source) return source;
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
      if (this.openView(intent.path)) return { kind: "blocked", reason: `Close the open view before replacing or deleting ${intent.path}.` };
      this.assertActive();
      await adapter.rename(intent.path, intent.hold!);
      // The adapter may queue a rename while a view opens. Undo the retargeting
      // before proceeding; the no-clobber reverse rename preserves later edits.
      if (this.openView(intent.hold!)) {
        await this.rollbackHeld(intent);
        if (await this.oid(intent.path) === intent.expected && await this.hiddenOid(intent.hold!) === null)
          await this.transactions.clearAttempt(intent.path);
        return { kind: "blocked", reason: `Close the open view before replacing or deleting ${intent.path}.` };
      }
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
    const source = await this.pendingSource(intent);
    if (source) return source;
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
  private async cancelIntent(intent: FileIntent): Promise<void> {
    if (!this.transactions) return;
    if (!intent.attempted) { await this.transactions.cancel(intent.path); return; }
    if (await this.pendingSource(intent)) return;
    const live = await this.oid(intent.path);
    const held = intent.hold ? await this.hiddenOid(intent.hold) : null;
    if (live === intent.expected && (held === null || held === intent.expected)) {
      await this.transactions.cancel(intent.path);
      return;
    }
    if (live === null && held === intent.expected && intent.hold) {
      await this.rollbackHeld(intent);
      await this.transactions.cancel(intent.path);
      return;
    }
    if (held === "oversize" && intent.hold) {
      await this.preserve(intent.hold, intent, "displaced");
      await this.transactions.cancel(intent.path);
      return;
    }
    if (held !== null && held !== intent.expected && intent.hold)
      await this.preserve(intent.hold, intent, "displaced");
    if (live === intent.next && intent.expectedEntry) {
      await this.transactions.retainBytes(decodeBase64(intent.expectedEntry.data), intent.path,
        intent.hold ?? intent.path, "displaced", intent.expectedEntry, intent.nextEntry);
    } else if (live !== intent.expected && live !== intent.next) {
      await this.preserve(intent.path, intent, "interrupted");
    } else if (live === intent.next && intent.expected === null) {
      await this.preserve(intent.path, intent, "interrupted");
    }
    await this.transactions.cancel(intent.path);
  }
  pendingIntents(): Promise<PendingNativeIntent[]> {
    this.assertActive();
    return Promise.resolve(this.transactions?.pendingIntents() ?? []);
  }
  /** Only an engine-authorized call may replay/cancel intents or persist hidden evidence. */
  async recoverNative(authorization: RecoveryAuthorization): Promise<NativeRecovery[]> {
    this.assertActive();
    if (!this.transactions) return [];
    const replay = new Set(authorization.replay), cancel = new Set(authorization.cancel);
    for (const id of replay) if (cancel.has(id)) throw new Error(`Conflicting native recovery authorization: ${id}`);
    for (const intent of this.transactions.pending()) {
      try {
        if (cancel.has(intent.id)) await this.cancelIntent(intent);
        else if (replay.has(intent.id)) {
          if (intent.method === "rename") await this.renameTransaction(intent);
          else await this.textTransaction(intent);
        }
      } catch (error) { await this.pendingOversizeRace(intent, error); }
    }
    for (const kind of ["hold", "stage"] as const) {
      const directory = `${this.transactions.root}/${kind}`;
      const listed = (await this.app.vault.adapter.list(directory)).files;
      const paths = new Set([...listed, ...this.transactions.trackedPaths().filter(path => path.startsWith(`${directory}/`))]);
      for (const path of paths) {
        const tracked = this.transactions.tracked(path);
        if (!tracked) continue;
        const bytes = await this.hiddenBytes(path);
        if (bytes === null) {
          if (this.transactions.oversizeForSource(path)) await this.transactions.supersedeOversize(path, null);
          else if (this.transactions.hasAcknowledgedOversizeSource(path))
            await this.transactions.retainChangedAcknowledgedSource(tracked.path, path, tracked.expected, tracked.next, null);
          await this.transactions.observeMissing(path);
          continue;
        }
        if (bytes === "oversize") {
          await this.transactions.retainOversize(tracked.path, path, tracked.expected, tracked.next,
            this.oversized.get(path) ?? maxFileBytes + 1, await this.hiddenMtime(path));
          continue;
        }
        let changedFromMissingOrOversize = false;
        if (this.transactions.oversizeForSource(path)) {
          await this.transactions.supersedeOversize(path, bytes);
          changedFromMissingOrOversize = true;
        } else if (this.transactions.hasAcknowledgedOversizeSource(path)) {
          await this.transactions.retainChangedAcknowledgedSource(tracked.path, path, tracked.expected, tracked.next, bytes);
          changedFromMissingOrOversize = true;
        } else if (this.transactions.missingForSource(path)) {
          await this.transactions.supersedeMissing(path, bytes);
          changedFromMissingOrOversize = true;
        } else if (tracked.missing) {
          await this.transactions.retainBytes(bytes, tracked.path, path, "displaced", tracked.expected, tracked.next);
          changedFromMissingOrOversize = true;
        }
        const oid = await hashBlob(bytes);
        if (changedFromMissingOrOversize) { await this.transactions.observe(path, oid); continue; }
        // No atomic remove-if-hash exists. Keep even clean preimages because a
        // writer can change a hold between inspection and adapter.remove().
        const known = kind === "hold" ? tracked.expected : tracked.next;
        if (oid === known?.oid || oid === tracked.observed) continue;
        await this.transactions.retainBytes(bytes, tracked.path, path, "displaced", tracked.expected, tracked.next);
        await this.transactions.observe(path, oid);
      }
    }
    await this.transactions.compact();
    return this.transactions.recoveries();
  }
  async recover(authorization?: RecoveryAuthorization): Promise<NativeIssue[]> {
    if (!authorization) throw new Error("Native recovery requires engine authorization.");
    await this.recoverNative(authorization);
    return this.transactions?.issues() ?? [];
  }
  async acknowledgeRecovery(ids: string[]): Promise<void> {
    this.assertActive();
    const selected = new Set(ids);
    for (const record of this.transactions?.recoveries() ?? []) {
      if (record.kind !== "oversize" || !selected.has(record.id)) continue;
      const { currentSize, currentMtime } = await this.inspectOversize(record.id);
      if (currentSize !== record.size || currentMtime !== record.mtime)
        throw new Error("Oversized source changed. Recover again before acknowledging.");
    }
    await this.transactions?.acknowledge(ids);
  }
  nativeRecoveries(): NativeRecovery[] { return this.transactions?.recoveries() ?? []; }
  private oversizeRecord(id: string): NativeOversizeRecovery {
    const record = this.transactions?.recoveries().find(item => item.id === id);
    if (record?.kind !== "oversize") throw new Error(`Unknown oversized native recovery: ${id}`);
    return record;
  }
  /** Metadata inspection does not read oversized bytes into the sync engine. */
  async inspectOversize(id: string): Promise<{ recovery: NativeOversizeRecovery; currentSize: number | null; currentMtime: number | null }> {
    this.assertActive();
    const recovery = this.oversizeRecord(id);
    const stat = await this.app.vault.adapter.stat(recovery.sourcePath);
    return { recovery, currentSize: stat?.type === "file" ? stat.size : null,
      currentMtime: stat?.type === "file" ? stat.mtime : null };
  }
  /** Copy to an excluded export directory, then publish by no-clobber rename. The source remains retained. */
  async exportOversize(id: string, destination?: string): Promise<{ path: string; size: number }> {
    this.assertActive();
    const { recovery, currentSize, currentMtime } = await this.inspectOversize(id);
    const output = destination ?? `.git-vault-sync-export-${crypto.randomUUID()}/${recovery.id}.bin`;
    safeExportPath(output);
    if (currentSize !== recovery.size || currentMtime !== recovery.mtime)
      throw new Error("Oversized source changed. Recover again before exporting.");
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(output)) throw new Error(`Export destination exists: ${output}`);
    await this.folders(output);
    const temporary = `${output.split("/")[0]}/.stage-${crypto.randomUUID()}`;
    this.assertActive();
    await adapter.copy(recovery.sourcePath, temporary);
    const copied = await adapter.stat(temporary);
    if (copied?.type !== "file" || copied.size !== recovery.size)
      throw new Error(`Oversized export is incomplete at ${temporary}; source is retained.`);
    const sourceAfter = await adapter.stat(recovery.sourcePath);
    if (sourceAfter?.type !== "file" || sourceAfter.size !== recovery.size || sourceAfter.mtime !== recovery.mtime)
      throw new Error(`Oversized source changed during export. Keep the copy at ${temporary} for inspection.`);
    this.assertActive();
    await adapter.rename(temporary, output);
    return { path: output, size: copied.size };
  }
  /** Read-only storage accounting, including pending and untracked hidden files. */
  async retainedHiddenSummary(): Promise<{ files: number; bytes: number; missingStats: number; holds: number; stages: number }> {
    this.assertActive();
    if (!this.transactions) return { files: 0, bytes: 0, missingStats: 0, holds: 0, stages: 0 };
    const adapter = this.app.vault.adapter;
    let files = 0, bytes = 0, missingStats = 0, holds = 0, stages = 0;
    for (const kind of ["hold", "stage"] as const) {
      const listed = await adapter.list(`${this.transactions.root}/${kind}`);
      for (const path of listed.files) {
        files++;
        if (kind === "hold") holds++; else stages++;
        const stat = await adapter.stat(path);
        if (stat?.type === "file") bytes += stat.size;
        else missingStats++;
      }
    }
    return { files, bytes, missingStats, holds, stages };
  }
  /** Explicit user decision; the source is retained and later changed versions can reappear. */
  async acknowledgeOversize(id: string): Promise<void> {
    this.assertActive();
    this.oversizeRecord(id);
    await this.acknowledgeRecovery([id]);
  }
  async capture(): Promise<Snapshot> {
    const { files, unreadable } = await this.scan();
    if (unreadable.length) throw new Error(`File exceeds 8 MiB: ${unreadable[0].path}`);
    return files;
  }
  /** Read-only survey; oversized visible files are reported without reading their bytes. */
  async scan(): Promise<{ files: Snapshot; unreadable: UnreadableNativeFile[] }> {
    this.assertActive();
    const visibleFiles = this.app.vault.getFiles().filter(file => visible(file.path));
    const snapshot: Snapshot = Object.create(null);
    const unreadable: UnreadableNativeFile[] = [];
    const paths = new Set<string>();
    let total = 0;
    for (const file of visibleFiles) {
      safePath(file.path);
      const folded = file.path.normalize("NFC").toLowerCase();
      if (paths.has(folded)) throw new Error(`Case or Unicode path collision: ${file.path}`);
      paths.add(folded);
      const stat = await this.app.vault.adapter.stat(file.path);
      const size = stat?.type === "file" ? stat.size : file.stat.size;
      const mtime = stat?.type === "file" ? stat.mtime : file.stat.mtime;
      if (size > maxFileBytes) {
        unreadable.push({ path: file.path, size, mtime, reason: "oversize" });
        continue;
      }
      if (!(await this.app.vault.adapter.exists(file.path)))
        throw new Error("The vault changed during capture. Sync will retry.");
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(file.path));
      if (bytes.length > maxFileBytes) {
        const grown = await this.app.vault.adapter.stat(file.path);
        unreadable.push({ path: file.path, size: bytes.length,
          mtime: grown?.type === "file" ? grown.mtime : null, reason: "oversize" });
        continue;
      }
      total += bytes.length;
      if (total > maxVaultBytes) throw new Error("Vault content exceeds the 128 MiB safety limit.");
      snapshot[file.path] = await entryFromBytes(bytes, this.modes.get(file.path));
    }
    return { files: snapshot, unreadable };
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
    if (pending) {
      if (pending.expected !== (expected?.oid ?? null) || pending.next !== (next?.oid ?? null)
        || pending.expectedEntry?.mode !== expected?.mode || pending.nextEntry?.mode !== next?.mode)
        return { kind: "blocked", reason: `A different native transaction is pending for ${path}.` };
      try { return pending.method === "rename" ? await this.renameTransaction(pending) : await this.textTransaction(pending); }
      catch (error) { return this.pendingOversizeRace(pending, error); }
    }
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
