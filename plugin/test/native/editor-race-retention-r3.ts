import { FileView, MarkdownView, Plugin, TFile } from "obsidian";
import { entryFromBytes } from "../../src/git-sync/codec";
import type { ApplyResult, NativeIssue } from "../../src/git-sync/contracts";
import { NativeTransactionJournal } from "../../src/git-sync/native-transactions";
import { GitObsidianVault } from "../../src/git-sync/obsidian-vault";

declare const INSTALLED_PRODUCTION_SHA: string;
declare const BUNDLED_NATIVE_SOURCE_HASHES: Record<string, string>;

// R1 assumed openFile would select Markdown after the TFile moved to an extensionless hold.
// R2 assumed the host would keep an explicitly selected Markdown FileView open after install.
// The rerunnable census below records the actual owners of the file reference at each step.
const r1RunId = "254fe269-7e5d-4fea-8e85-c1a830544bf7";
const r2RunId = "e4918102-ee90-4f4c-ba7d-221fc2e0dbb9";
const r1Result = ".git-sync-native-editor-race-result.json";
const r1Archive = `.git-sync-native-editor-race-r1-${r1RunId}-result.json`;
const r2Result = `.git-sync-native-editor-race-r2-${r2RunId}-result.json`;
const pointerPath = ".git-sync-native-editor-race-r3-run.json";
const progressPath = (id: string): string => `.git-sync-native-editor-race-r3-${id}-progress.json`;
const resultPath = (id: string): string => `.git-sync-native-editor-race-r3-${id}-result.json`;
const encoder = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Check = { name: string; pass: boolean };
type Census = {
  phase: string;
  originalTFilePath: string | null;
  leaves: { type: string; filePath: string | null; sameOriginalTFile: boolean | null }[];
  files: { visible: string | null; hold: string | null; stage: string | null };
  pending: { id: string; attempted: boolean }[];
  recoveryIds: string[];
};
type Previous = { r1Archive: string; r1Sha256: string; r2Result: string; r2Sha256: string };
type Observed = {
  apply: ApplyResult["kind"];
  postApplyView: "held-open" | "closed";
  postApplyIntent: "pending" | "settled";
};
type Progress = {
  format: 3;
  runId: string;
  path: string;
  otherPath: string;
  hold: string;
  checks: Check[];
  census: Census[];
  observed: Observed;
  previous: Previous;
};

function parseRunId(value: unknown): string {
  const runId = typeof value === "object" && value !== null ? Reflect.get(value, "runId") : null;
  if (typeof value !== "object" || value === null || Reflect.get(value, "format") !== 3 ||
      typeof runId !== "string" || !uuid.test(runId)) throw new Error("Invalid R3 run pointer");
  return runId;
}

function parseProgress(value: unknown, runId: string): Progress {
  if (typeof value !== "object" || value === null || Reflect.get(value, "format") !== 3 ||
      Reflect.get(value, "runId") !== runId ||
      Reflect.get(value, "path") !== `Native Editor Race R3 ${runId}.md` ||
      Reflect.get(value, "otherPath") !== `Native Editor Race R3 Other ${runId}.bin` ||
      typeof Reflect.get(value, "hold") !== "string" ||
      !Reflect.get(value, "hold").startsWith(`.git-vault-sync/${runId}/hold/`) ||
      !Array.isArray(Reflect.get(value, "checks")) || !Array.isArray(Reflect.get(value, "census")) ||
      typeof Reflect.get(value, "observed") !== "object" || Reflect.get(value, "observed") === null ||
      typeof Reflect.get(value, "previous") !== "object" || Reflect.get(value, "previous") === null)
    throw new Error("Invalid R3 progress");
  return value as Progress;
}

function original(id: string): Uint8Array { return encoder.encode(`Native editor race R3 original ${id}\n\u000b`); }
function incoming(id: string): Uint8Array { return encoder.encode(`Native editor race R3 incoming ${id}\n\u000b`); }
function draft(id: string): Uint8Array { return encoder.encode(`Native editor race R3 saved draft ${id}\n`); }
function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export default class NativeEditorRaceRetentionR3 extends Plugin {
  private closeTimer: number | null = null;
  private settling = false;

  onload(): void {
    this.app.workspace.onLayoutReady(() => { setTimeout(() => { void this.execute(); }, 2000); });
    this.addCommand({ id: "settle-editor-race-r3", name: "Inspect R3 editor race retention after view closes",
      callback: () => { void this.settle(); } });
  }

  private async sha256(bytes: ArrayBuffer): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async fileHash(path: string): Promise<string | null> {
    const fs = this.app.vault.adapter;
    return await fs.exists(path) ? this.sha256(await fs.readBinary(path)) : null;
  }

  private async exact(path: string, expected: Uint8Array): Promise<boolean> {
    const fs = this.app.vault.adapter;
    return await fs.exists(path) && equal(new Uint8Array(await fs.readBinary(path)), expected);
  }

  private check(checks: Check[], name: string, pass: boolean): void {
    checks.push({ name, pass });
    if (!pass) throw new Error(name);
  }

  private productionEnabled(): boolean {
    const manager: unknown = Reflect.get(this.app, "plugins");
    if (typeof manager !== "object" || manager === null) return true;
    const loaded: unknown = Reflect.get(manager, "plugins");
    return typeof loaded !== "object" || loaded === null ||
      Reflect.get(loaded, "github-vault-sync") !== undefined;
  }

  private heldView(path: string): boolean {
    let open = false;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof FileView && leaf.view.file?.path === path) open = true;
    });
    return open;
  }

  private async journal(id: string): Promise<GitObsidianVault> {
    const transactions = await NativeTransactionJournal.open(this.app.vault.adapter, id);
    return new GitObsidianVault(this.app, undefined, undefined, transactions);
  }

  private async census(phase: string, vault: GitObsidianVault, file: TFile | null, path: string,
    hold: string | null, stage: string | null): Promise<Census> {
    const leaves: Census["leaves"] = [];
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      leaves.push({ type: view.getViewType(), filePath: view instanceof FileView ? view.file?.path ?? null : null,
        sameOriginalTFile: file === null ? null : view instanceof FileView && view.file === file });
    });
    const pending = await vault.pendingIntents();
    return { phase, originalTFilePath: file?.path ?? null, leaves,
      files: { visible: await this.fileHash(path), hold: hold ? await this.fileHash(hold) : null,
        stage: stage ? await this.fileHash(stage) : null },
      pending: pending.map(intent => ({ id: intent.id, attempted: intent.attempted })),
      recoveryIds: vault.nativeRecoveries().map(issue => issue.id) };
  }

  private async previous(): Promise<Previous> {
    const fs = this.app.vault.adapter;
    if (!await fs.exists(r1Result) || !await fs.exists(r2Result))
      throw new Error("R1 or R2 device result is missing; no prior evidence was removed");
    const r1 = await fs.read(r1Result), r2 = await fs.read(r2Result);
    const first: unknown = JSON.parse(r1), second: unknown = JSON.parse(r2);
    if (typeof first !== "object" || first === null || Reflect.get(first, "runId") !== r1RunId ||
        Reflect.get(first, "completed") !== false ||
        typeof second !== "object" || second === null || Reflect.get(second, "runId") !== r2RunId ||
        Reflect.get(second, "completed") !== false)
      throw new Error("R1 or R2 result does not match the reported failed run");
    if (await fs.exists(r1Archive)) {
      if (await fs.read(r1Archive) !== r1) throw new Error("R1 archive differs from original result");
    } else await fs.write(r1Archive, r1);
    if (await fs.read(r1Archive) !== r1) throw new Error("R1 result was not archived exactly");
    return { r1Archive, r1Sha256: await this.sha256(buffer(encoder.encode(r1))),
      r2Result, r2Sha256: await this.sha256(buffer(encoder.encode(r2))) };
  }

  private hasDraft(issues: NativeIssue[], hold: string, bytes: Uint8Array): boolean {
    const data = btoa(String.fromCharCode(...bytes));
    return issues.some(issue => issue.kind === "displaced" && issue.sourcePath === hold &&
      issue.found?.data === data);
  }

  private async report(runId: string, completed: boolean, checks: Check[], error: string | null,
    extra: Record<string, unknown>): Promise<void> {
    await this.app.vault.adapter.write(resultPath(runId), JSON.stringify({ completed, runId, error, checks,
      installedProductionSha256Expected: INSTALLED_PRODUCTION_SHA,
      bundledNativeSourceHashes: BUNDLED_NATIVE_SOURCE_HASHES,
      boundary: "R3 bundles current native sources in an isolated journal; installed Android production remains the older SHA and is checked only as provenance",
      premise: "A held Markdown FileView remains open through stage-to-visible install. R2 falsified this on Android; R3 records host lifecycle and tests a draft saved before install.",
      naturalUiReachabilityProven: false, unsavedBufferGuaranteeProven: false, ...extra }, null, 2));
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const fs = this.app.vault.adapter;
    if (await fs.exists(pointerPath)) {
      const runId = parseRunId(JSON.parse(await fs.read(pointerPath)));
      if (await fs.exists(resultPath(runId))) return;
      if (await fs.exists(progressPath(runId))) { await this.settle(); return; }
      await this.report(runId, false, [], "Attempt interrupted before progress was recorded", {});
      return;
    }
    const runId = crypto.randomUUID();
    const path = `Native Editor Race R3 ${runId}.md`;
    const otherPath = `Native Editor Race R3 Other ${runId}.bin`;
    const checks: Check[] = [], census: Census[] = [];
    let previous: Previous | null = null;
    let hold: string | null = null;
    let observed: Observed | null = null;
    try {
      await fs.write(pointerPath, JSON.stringify({ format: 3, runId }));
      previous = await this.previous();
      this.check(checks, "R1 archived exactly and R2 result retained", true);
      this.check(checks, "installed Android production SHA is known older artifact",
        await this.fileHash(".obsidian/plugins/github-vault-sync/main.js") === INSTALLED_PRODUCTION_SHA);
      this.check(checks, "production sync disabled for isolated local probe", !this.productionEnabled());
      this.check(checks, "new UUID fixture names unused", !await fs.exists(path) && !await fs.exists(otherPath));
      const file = await this.app.vault.createBinary(path, buffer(original(runId)));
      this.check(checks, "fixture is an indexed original TFile", file instanceof TFile &&
        this.app.vault.getAbstractFileByPath(path) === file && await this.exact(path, original(runId)));
      const vault = await this.journal(runId);
      const leaf = this.app.workspace.getLeaf(true);
      const originalRename = fs.rename;
      const rename = originalRename.bind(fs);
      let injected = false;
      fs.rename = async (from, to) => {
        if (from === path && to.startsWith(`.git-vault-sync/${runId}/hold/`)) {
          census.push(await this.census("before-first-rename", vault, file, path, null, null));
          await rename(from, to);
          census.push(await this.census("after-first-rename", vault, file, path, to, null));
          return;
        }
        if (to !== path || !from.startsWith(`.git-vault-sync/${runId}/stage/`)) return rename(from, to);
        if (injected) throw new Error("Stage-to-visible hook ran twice");
        injected = true;
        for (let attempt = 0; attempt < 100 && !file.path.includes("/hold/"); attempt++) await sleep(50);
        if (!file.path.startsWith(`.git-vault-sync/${runId}/hold/`))
          throw new Error("Original TFile did not move to its hidden hold");
        hold = file.path;
        census.push(await this.census("before-markdown-selection", vault, file, path, hold, from));
        await leaf.setViewState({ type: "markdown", state: { file: hold }, active: true });
        await leaf.loadIfDeferred();
        census.push(await this.census("after-markdown-selection", vault, file, path, hold, from));
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || view.file !== file || view.file.path !== hold)
          throw new Error("Host did not bind a real Markdown view to the original held TFile");
        view.editor.setValue(new TextDecoder().decode(draft(runId)));
        view.requestSave();
        let saved = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          if (await this.exact(hold, draft(runId))) { saved = true; break; }
          await sleep(250);
        }
        census.push(await this.census("draft-save-before-second-rename", vault, file, path, hold, from));
        this.check(checks, "host editor saved exact draft into hold before second rename", saved);
        await rename(from, to);
        census.push(await this.census("after-second-rename", vault, file, path, hold, from));
      };
      let result: ApplyResult;
      try {
        result = await vault.apply(path, await entryFromBytes(original(runId)), await entryFromBytes(incoming(runId)));
      } finally { fs.rename = originalRename; }
      this.check(checks, "second rename hook ran and saved draft", injected && hold !== null);
      if (hold === null) throw new Error("Missing held source path");
      census.push(await this.census("after-apply", vault, file, path, hold, null));
      const pending = await vault.pendingIntents();
      observed = { apply: result.kind, postApplyView: this.heldView(hold) ? "held-open" : "closed",
        postApplyIntent: pending.length ? "pending" : "settled" };
      this.check(checks, "incoming bytes intact after host lifecycle", await this.exact(path, incoming(runId)));
      this.check(checks, "saved draft remains accessible in hold", await this.exact(hold, draft(runId)));
      const issues = await vault.recover({ replay: pending.map(intent => intent.id), cancel: [] });
      census.push(await this.census("after-native-recovery", vault, file, path, hold, null));
      this.check(checks, "native recovery retains exact saved draft", this.hasDraft(issues, hold, draft(runId)));
      await this.app.vault.createBinary(otherPath, buffer(Uint8Array.of(0, 1)));
      const unrelated = await vault.apply(otherPath, await entryFromBytes(Uint8Array.of(0, 1)),
        await entryFromBytes(Uint8Array.of(0, 2)));
      this.check(checks, "unrelated native apply works", unrelated.kind === "applied" &&
        await this.exact(otherPath, Uint8Array.of(0, 2)));
      const progress: Progress = { format: 3, runId, path, otherPath, hold, checks, census, observed, previous };
      await fs.write(progressPath(runId), JSON.stringify(progress, null, 2));
      if (this.heldView(hold) && (await vault.pendingIntents()).length) this.watchForClose(hold);
      else await this.settle();
    } catch (error) {
      await this.report(runId, false, checks, error instanceof Error ? error.message : String(error),
        { path, hold, previous, observed, census });
    }
  }

  private watchForClose(hold: string): void {
    if (this.closeTimer !== null) return;
    const timer = window.setInterval(() => {
      if (!this.heldView(hold)) {
        window.clearInterval(timer);
        this.closeTimer = null;
        void this.settle();
      }
    }, 500);
    this.closeTimer = timer;
    this.registerInterval(timer);
  }

  private async settle(): Promise<void> {
    if (this.settling || this.app.vault.getName() !== "Vault Sync Lab") return;
    const fs = this.app.vault.adapter;
    if (!await fs.exists(pointerPath)) return;
    const runId = parseRunId(JSON.parse(await fs.read(pointerPath)));
    if (await fs.exists(resultPath(runId)) || !await fs.exists(progressPath(runId))) return;
    this.settling = true;
    let progress: Progress | null = null;
    try {
      progress = parseProgress(JSON.parse(await fs.read(progressPath(runId))), runId);
      if (this.heldView(progress.hold)) { this.watchForClose(progress.hold); return; }
      const checks = progress.checks;
      this.check(checks, "production sync remains disabled", !this.productionEnabled());
      const vault = await this.journal(runId);
      const pending = await vault.pendingIntents();
      const issues = await vault.recover({ replay: pending.map(intent => intent.id), cancel: [] });
      progress.census.push(await this.census("after-final-settlement", vault, null,
        progress.path, progress.hold, null));
      this.check(checks, "native intent safely settled after host view closes", (await vault.pendingIntents()).length === 0);
      this.check(checks, "exact incoming bytes remain visible", await this.exact(progress.path, incoming(runId)));
      this.check(checks, "exact saved draft remains in hidden hold", await this.exact(progress.hold, draft(runId)));
      this.check(checks, "exact draft remains a native displaced issue", this.hasDraft(issues, progress.hold, draft(runId)));
      const summary = await vault.retainedHiddenSummary();
      this.check(checks, "public native API counts retained hold", summary.holds >= 1 && summary.bytes >= draft(runId).length);
      this.check(checks, "unrelated result remains exact", await this.exact(progress.otherPath, Uint8Array.of(0, 2)));
      const previous = await this.previous();
      this.check(checks, "R1 and R2 evidence unchanged", previous.r1Sha256 === progress.previous.r1Sha256 &&
        previous.r2Sha256 === progress.previous.r2Sha256);
      const heldPath = progress.hold;
      await this.report(runId, true, checks, null, { path: progress.path, hold: progress.hold,
        previous, observed: progress.observed, finalIntent: "settled", census: progress.census,
        retainedIssueIds: issues.filter(issue => issue.sourcePath === heldPath).map(issue => issue.id),
        retainedHiddenSummary: summary });
    } catch (error) {
      await this.report(runId, false, progress?.checks ?? [], error instanceof Error ? error.message : String(error),
        { path: progress?.path ?? null, hold: progress?.hold ?? null,
          previous: progress?.previous ?? null, observed: progress?.observed ?? null,
          census: progress?.census ?? [] });
    } finally { this.settling = false; }
  }
}
