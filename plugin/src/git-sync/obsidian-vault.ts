import { App, FileView, TFile } from "obsidian";
import { decodeBase64, entryFromBytes, hashBlob, hasControlCharacter, isValidPath, verifyEntry, withMode, yieldToHost } from "./codec";
import type { ApplyResult, Entry, LocalVault, NativeIssue, Snapshot } from "./contracts";
import type { NativeModes } from "./native-modes";
import { NativeTransactionJournal, type FileIntent, type NativeOversizeRecovery, type NativeRecovery, type PendingNativeIntent } from "./native-transactions";
import { HiddenConfigPort, racyWindowMs, sameScanKey, scanKey, type ScanCache } from "./hidden-config";
import { assertLocalNamespace, inventoryLocal, type NativePathPolicy } from "./native-path-policy";
import { assertNoNestedGitignore, type Scope } from "./scope";

export interface RecoveryAuthorization { replay: string[]; cancel: string[]; released?: string[] }
export interface UnreadableNativeFile { path: string; size: number; mtime: number | null; reason: "oversize" }

const maxFileBytes = 8 * 1024 * 1024;
const statConcurrency = 8;
/** Runs `work` at most `width` at a time, keeping input order; rejects after in-flight work settles. */
async function mapConcurrent<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]); }
      catch (error) { failure ??= { error }; }
    }
  }));
  if (failure !== undefined) throw failure.error;
  return results;
}
const maxVaultBytes = 128 * 1024 * 1024;
/**
 * A finished hold must read unchanged (same bytes, size and mtime) for this
 * long in this process before it is reclaimed, so a writer that still had the
 * replaced file open has time to show up as displaced evidence instead.
 */
const holdQuietMs = 10 * 60_000;
const indexWaitIntervalMs = 50;
const indexWaitTicks = 100;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
class OversizeReadError extends Error {
  constructor(readonly path: string) { super(`File exceeds 8 MiB: ${path}`); }
}
function visible(path: string): boolean { return path.split("/").every(part => !part.startsWith(".")); }
function safePath(path: string, policy: NativePathPolicy): void {
  if (!policy.allows(path) || path.split("/").some(part => !part || part === "." || part === ".."
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || /[\\:]/.test(path) || hasControlCharacter(path)) throw new Error(`Unsupported vault path: ${path}`);
}
function safeExportPath(path: string, policy: NativePathPolicy): void {
  if (!isValidPath(path)) throw new Error(`Unsupported export path: ${String(path)}`);
  const [directory, ...suffix] = path.split("/");
  if (!/^\.git-vault-sync-export-[0-9a-f-]{36}$/.test(directory) || suffix.length === 0)
    throw new Error(`Export must use a dedicated hidden directory: ${path}`);
  assertNoNestedGitignore([path]);
  safePath(suffix.join("/"), policy);
}
function exactText(bytes: Uint8Array): string | null {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return equal(new TextEncoder().encode(value), bytes) && !hasControlCharacter(value, "\t\n\r") ? value : null;
  } catch { return null; }
}
export class GitObsidianVault implements LocalVault {
  private oversized = new Map<string, number>();
  /**
   * Visible files captured by `scan`, reused while the adapter reports the
   * same size, mtime and ctime. Entries are stored only for complete stats
   * outside the racy window, dropped on any mismatch, on `apply` to the path
   * and when the path leaves a scan.
   */
  private scanCache: ScanCache = new Map();
  /** The same cache for configuration files read by `HiddenConfigPort`. */
  private hiddenScanCache: ScanCache = new Map();
  /** Finished holds last read with their expected bytes: stat at that read, and when first seen so. */
  private cleanHolds = new Map<string, { size: number; mtime: number; since: number }>();
  /** Wall clock for the racy-mtime window; replaceable in tests. */
  now: () => number = () => Date.now();
  constructor(
    private app: App,
    private nativePolicy: NativePathPolicy,
    private modes: NativeModes = { get: () => "100644", set: () => {} },
    private assertActive: () => void = () => {},
    private transactions?: NativeTransactionJournal,
    private hostLifetime: string | null = null,
    private indexTick: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, indexWaitIntervalMs)),
  ) {
    if (transactions && !transactions.matchesPolicy(nativePolicy))
      throw new Error("Native transaction journal policy does not match the vault.");
    this.assertConfigDir();
  }
  private assertConfigDir(): void {
    if (this.app.vault.configDir !== this.nativePolicy.binding.configDir)
      throw new Error("Vault configuration directory does not match native policy.");
  }
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
    const file = visible(path) ? this.app.vault.getAbstractFileByPath(path) : null;
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
  /** The blob ID, "oversize", or null when the file is missing. */
  private async hiddenOid(path: string): Promise<string | null> {
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
  private heldViewBlock(intent: FileIntent): ApplyResult | null {
    return intent.hold && visible(intent.path) && this.openView(intent.hold)
      ? { kind: "blocked", reason: `Close the open view for ${intent.path} before native recovery can finish. Its original file is retained in a hidden hold.` }
      : null;
  }
  private hostIndexAgrees(path: string, next: string | null): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    const indexed = this.app.vault.getFiles().filter(file => file.path === path);
    return next === null
      ? abstract === null && indexed.length === 0
      : abstract instanceof TFile && abstract.path === path &&
        indexed.length === 1 && indexed[0] === abstract;
  }
  /** Adapter rename can finish on disk before Obsidian indexes the visible path. */
  private async waitForVisibleRename(intent: FileIntent): Promise<void> {
    for (let tick = 0; tick <= indexWaitTicks; tick++) {
      this.assertActive();
      if (this.hostIndexAgrees(intent.path, intent.next)) {
        const live = await this.oid(intent.path);
        this.assertActive();
        if (live !== intent.next)
          throw new Error(`Native file changed while waiting for host index: ${intent.path}`);
        if (intent.hold) {
          const held = await this.hiddenOid(intent.hold);
          this.assertActive();
          if (held !== intent.expected)
            throw new Error(`Native held file changed while waiting for host index: ${intent.path}`);
        }
        if (this.hostIndexAgrees(intent.path, intent.next)) return;
      }
      if (tick === indexWaitTicks) break;
      await this.indexTick();
    }
    this.assertActive();
    throw new Error(`Visible native file did not settle in host index: ${intent.path}`);
  }
  private async finish(intent: FileIntent, result: ApplyResult): Promise<ApplyResult> {
    if (result.kind === "blocked") return result;
    const heldView = this.heldViewBlock(intent);
    if (heldView) return heldView;
    if (result.kind === "applied" && intent.method === "rename" && visible(intent.path)) {
      await this.waitForVisibleRename(intent);
      const newlyHeldView = this.heldViewBlock(intent);
      if (newlyHeldView) return newlyHeldView;
    }
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
    await this.assertWritableNamespace(intent.path);
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
      if (visible(intent.path) && this.openView(intent.path)) return { kind: "blocked", reason: `Close the open view before replacing or deleting ${intent.path}.` };
      const staged = await this.stage(intent);
      if (staged) return this.finish(intent, staged);
      await this.transactions.markAttempted(intent.path);
      if (visible(intent.path) && this.openView(intent.path)) return { kind: "blocked", reason: `Close the open view before replacing or deleting ${intent.path}.` };
      this.assertActive();
      await adapter.rename(intent.path, intent.hold!);
      // The adapter may queue a rename while a view opens. Undo the retargeting
      // before proceeding; the no-clobber reverse rename preserves later edits.
      if (visible(intent.path) && this.openView(intent.hold!)) {
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
  private async finishCancel(intent: FileIntent): Promise<void> {
    if (!this.heldViewBlock(intent)) await this.transactions?.cancel(intent.path);
  }
  private async cancelIntent(intent: FileIntent): Promise<void> {
    if (!this.transactions) return;
    await this.assertWritableNamespace(intent.path);
    if (this.heldViewBlock(intent)) return;
    if (!intent.attempted) { await this.finishCancel(intent); return; }
    if (await this.pendingSource(intent)) return;
    const live = await this.oid(intent.path);
    const held = intent.hold ? await this.hiddenOid(intent.hold) : null;
    if (live === intent.expected && (held === null || held === intent.expected)) {
      await this.finishCancel(intent);
      return;
    }
    if (live === null && held === intent.expected && intent.hold) {
      await this.rollbackHeld(intent);
      await this.finishCancel(intent);
      return;
    }
    if (held === "oversize" && intent.hold) {
      await this.preserve(intent.hold, intent, "displaced");
      await this.finishCancel(intent);
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
    await this.finishCancel(intent);
  }
  pendingIntents(): Promise<PendingNativeIntent[]> {
    this.assertActive();
    return Promise.resolve(this.transactions?.pendingIntents() ?? []);
  }
  /** Only an engine-authorized call may replay/cancel intents or persist hidden evidence. */
  async recoverNative(authorization: RecoveryAuthorization): Promise<NativeRecovery[]> {
    this.assertActive();
    this.assertConfigDir();
    if (!this.transactions) return [];
    // Replays write files: rescan whatever they may have touched.
    if (this.transactions.pending().length) { this.scanCache.clear(); this.hiddenScanCache.clear(); }
    const replay = new Set(authorization.replay), cancel = new Set(authorization.cancel);
    const released = new Set(Array.isArray(authorization.released) ? authorization.released : []);
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
        if (!tracked) { this.cleanHolds.delete(path); continue; }
        if (kind === "hold" && await this.reclaimHold(path, tracked.expected?.oid ?? null, released)) continue;
        this.cleanHolds.delete(path);
        const before = kind === "hold" ? await this.app.vault.adapter.stat(path) : null;
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
        // No atomic remove-if-hash exists, so a clean preimage is reclaimed
        // (reclaimHold) only after it has read unchanged for holdQuietMs and
        // only when the engine already holds the same bytes.
        const known = kind === "hold" ? tracked.expected : tracked.next;
        if (kind === "hold" && oid === tracked.expected?.oid && this.transactions.reclaimable(path) && before?.type === "file") {
          // Remember the stat only when it bracketed the read and is outside
          // the racy window, so a same-size rewrite must change it.
          const after = await this.app.vault.adapter.stat(path);
          if (after?.type === "file" && after.size === bytes.length && before.size === after.size && before.mtime === after.mtime &&
            Number.isFinite(after.mtime) && this.now() - after.mtime > racyWindowMs)
            this.cleanHolds.set(path, { size: after.size, mtime: after.mtime, since: this.now() });
        }
        if (oid === known?.oid || oid === tracked.observed) continue;
        await this.transactions.retainBytes(bytes, tracked.path, path, "displaced", tracked.expected, tracked.next);
        await this.transactions.observe(path, oid);
      }
    }
    await this.transactions.compact();
    return this.transactions.recoveries();
  }
  /**
   * For a finished hold whose expected bytes were read before and whose stat
   * is unchanged since: skips rereading and rehashing it, and removes it once
   * it has stayed so for `holdQuietMs` and the engine holds those bytes
   * (`released`). True when the hold needs no further inspection this pass.
   */
  private async reclaimHold(path: string, expected: string | null, released: ReadonlySet<string>): Promise<boolean> {
    const clean = this.cleanHolds.get(path);
    if (!clean || !this.transactions?.reclaimable(path)) return false;
    const adapter = this.app.vault.adapter;
    const unchanged = async () => {
      const stat = await adapter.stat(path);
      return stat?.type === "file" && stat.size === clean.size && stat.mtime === clean.mtime;
    };
    if (!(await unchanged())) return false;
    if (expected === null || !released.has(expected) || this.now() - clean.since < holdQuietMs || !adapter.remove) return true;
    this.assertActive();
    if (!(await unchanged())) return false;
    await adapter.remove(path);
    this.cleanHolds.delete(path);
    await this.transactions.release(path);
    return true;
  }
  async recover(authorization?: RecoveryAuthorization): Promise<NativeIssue[]> {
    if (!authorization) throw new Error("Native recovery requires engine authorization.");
    await this.recoverNative(authorization);
    return this.transactions?.issues() ?? [];
  }
  async acknowledgeRecovery(ids: string[]): Promise<void> {
    this.assertActive();
    this.assertConfigDir();
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
    this.assertConfigDir();
    const { recovery, currentSize, currentMtime } = await this.inspectOversize(id);
    const output = destination ?? `.git-vault-sync-export-${crypto.randomUUID()}/${recovery.id}.bin`;
    safeExportPath(output, this.nativePolicy);
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
  async capture(scope: Scope): Promise<Snapshot> {
    const { files, unreadable } = await this.scan(scope);
    if (unreadable.length) throw new Error(`File exceeds 8 MiB: ${unreadable[0].path}`);
    return files;
  }
  /**
   * Read-only download hint for the repository's `readLocal`: the current
   * entry at `path` when its size is `expectedSize`, else null; never throws.
   * Served from the scan caches when the stat still matches, and fills them
   * under the same rules as `scan`, so a launch whose head read already
   * hashed a file does not read and hash it again in the capture that
   * follows. The repository still checks the entry against the tree's oid.
   */
  async readCandidate(path: string, expectedSize: number): Promise<Entry | null> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxFileBytes || !isValidPath(path)) return null;
    try {
      const adapter = this.app.vault.adapter;
      const cache = visible(path) ? this.scanCache : this.hiddenScanCache;
      const stat = await adapter.stat(path);
      if (!stat || stat.type !== "file" || stat.size !== expectedSize) return null;
      const key = scanKey(stat);
      const cached = key ? cache.get(path) : undefined;
      if (key && cached && sameScanKey(cached, key)) return withMode(cached.entry, cached.entry.mode);
      const bytes = new Uint8Array(await adapter.readBinary(path));
      if (bytes.length !== expectedSize) return null;
      const entry = await entryFromBytes(bytes);
      if (key && bytes.length === key.size && this.now() - key.mtime > racyWindowMs)
        cache.set(path, { ...key, entry: withMode(entry, entry.mode) }); // Private copy.
      return entry;
    } catch {
      // A missing, unreadable, or concurrently replaced local file is simply not a download source.
      return null;
    }
  }
  /** Read-only survey; oversized visible files are reported without reading their bytes. */
  async scan(scope: Scope): Promise<{ files: Snapshot; unreadable: UnreadableNativeFile[] }> {
    this.assertActive();
    this.assertConfigDir();
    if (scope.rules.configDir !== this.nativePolicy.binding.configDir)
      throw new Error("Configuration scope does not match the native vault policy.");
    const inventory = await inventoryLocal(this.app.vault.adapter, this.assertActive, { pruneOpaque: true });
    assertLocalNamespace(inventory, scope);
    const visibleFiles = this.app.vault.getFiles().filter(file => visible(file.path)).map(file => ({
      path: file.path, size: file.stat.size, mtime: file.stat.mtime,
    }));
    const indexed = new Set(visibleFiles.map(file => file.path));
    for (const file of visibleFiles) {
      if (!scope.includes(file.path)) continue;
      if (!inventory.files.has(file.path))
        throw new Error(`Visible file missing from local inventory: ${file.path}`);
    }
    for (const path of inventory.files) {
      if (!visible(path) || !scope.includes(path)) continue;
      if (!indexed.has(path)) throw new Error(`Visible file missing from host index: ${path}`);
    }
    const hidden = await new HiddenConfigPort(this.app.vault.adapter, scope.rules.configDir,
      this.assertActive, this.hiddenScanCache, () => this.now()).scan(scope, path => this.modes.get(path));
    const snapshot: Snapshot = hidden.files;
    const unreadable: UnreadableNativeFile[] = hidden.unreadable;
    let total = Object.values(snapshot).reduce((sum, entry) => sum + (entry.data.length / 4) * 3
      - (entry.data.endsWith("==") ? 2 : entry.data.endsWith("=") ? 1 : 0), 0);
    const seen = new Set<string>();
    const targets: typeof visibleFiles = [];
    for (const file of visibleFiles) {
      if (!scope.includes(file.path)) continue;
      safePath(file.path, this.nativePolicy);
      targets.push(file);
    }
    // Stats are independent reads; overlap them instead of one round trip per file.
    const stats = await mapConcurrent(targets, statConcurrency, file => this.app.vault.adapter.stat(file.path));
    for (const [index, file] of targets.entries()) {
      if (index % 256 === 255) await yieldToHost();
      const stat = stats[index];
      const size = stat?.type === "file" ? stat.size : file.size;
      const mtime = stat?.type === "file" ? stat.mtime : file.mtime;
      if (size > maxFileBytes) {
        unreadable.push({ path: file.path, size, mtime, reason: "oversize" });
        continue;
      }
      seen.add(file.path);
      const key = stat?.type === "file" ? scanKey(stat) : null;
      const cached = key ? this.scanCache.get(file.path) : undefined;
      if (key && cached && sameScanKey(cached, key)) {
        total += key.size;
        if (total > maxVaultBytes) throw new Error("Vault content exceeds the 128 MiB safety limit.");
        snapshot[file.path] = withMode(cached.entry, this.modes.get(file.path));
        continue;
      }
      this.scanCache.delete(file.path);
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
      const entry = await entryFromBytes(bytes, this.modes.get(file.path));
      snapshot[file.path] = entry;
      // Cache only bytes read under a complete stat that matches their length
      // and is old enough that a same-size rewrite must change the mtime.
      if (key && bytes.length === key.size && this.now() - key.mtime > racyWindowMs)
        this.scanCache.set(file.path, { ...key, entry: withMode(entry, entry.mode) }); // Private copy.
    }
    for (const path of [...this.scanCache.keys()]) if (!seen.has(path)) this.scanCache.delete(path);
    return { files: snapshot, unreadable };
  }
  private async folders(path: string): Promise<void> {
    const parts = path.split("/"); parts.pop();
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(prefix))) {
        try {
          this.assertActive();
          if (visible(path)) await this.app.vault.createFolder(prefix);
          else await this.app.vault.adapter.mkdir(prefix);
        }
        catch (error) { if (!(await this.app.vault.adapter.exists(prefix))) throw error; }
      }
      if ((await this.app.vault.adapter.stat(prefix))?.type !== "folder")
        throw new Error(`File blocks vault directory: ${prefix}`);
    }
  }
  private async assertWritableNamespace(path: string): Promise<void> {
    this.assertConfigDir();
    const inventory = await inventoryLocal(this.app.vault.adapter, this.assertActive, { pruneOpaque: true });
    assertLocalNamespace(inventory, this.nativePolicy, path);
  }
  async apply(path: string, expected: Entry | null, next: Entry | null): Promise<ApplyResult> {
    this.scanCache.delete(path);
    this.hiddenScanCache.delete(path);
    safePath(path, this.nativePolicy);
    await this.assertWritableNamespace(path);
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
    const method = visible(path) && expected && next
      && exactText(decodeBase64(expected.data)) !== null && exactText(decodeBase64(next.data)) !== null
      ? "text-process" : "rename";
    if (method === "rename" && expected && visible(path) && this.openView(path))
      return { kind: "blocked", reason: `Close the open view before replacing or deleting ${path}.` };
    const intent = await this.transactions.begin(path, expected, next, method, this.hostLifetime);
    return method === "rename" ? this.renameTransaction(intent) : this.textTransaction(intent);
  }
}
