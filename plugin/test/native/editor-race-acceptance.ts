import { FileView, MarkdownView, Plugin, TFile } from "obsidian";
import { entryFromBytes } from "../../src/git-sync/codec";
import type { Entry, NativeIssue } from "../../src/git-sync/contracts";
import { NativeTransactionJournal } from "../../src/git-sync/native-transactions";
import { GitObsidianVault } from "../../src/git-sync/obsidian-vault";

declare const EXPECTED_PRODUCTION_SHA: string;

const progressPath = ".git-sync-native-editor-race-progress.json";
const resultPath = ".git-sync-native-editor-race-result.json";
const encoder = new TextEncoder();
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

type Check = { name: string; pass: boolean };
type Progress = {
  format: 1;
  runId: string;
  path: string;
  otherPath: string;
  hold: string;
  intentId: string;
  checks: Check[];
  injection: { originalPathAtSecondRename: string; viewType: string; boundPath: string | null };
};

function parseProgress(value: unknown): Progress {
  if (typeof value !== "object" || value === null) throw new Error("Invalid editor race progress");
  const runId = Reflect.get(value, "runId");
  const path = Reflect.get(value, "path");
  const otherPath = Reflect.get(value, "otherPath");
  const hold = Reflect.get(value, "hold");
  const intentId = Reflect.get(value, "intentId");
  const checks = Reflect.get(value, "checks");
  const injection = Reflect.get(value, "injection");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (Reflect.get(value, "format") !== 1 || typeof runId !== "string" || !uuid.test(runId) ||
      path !== `Native Editor Race ${runId}.md` || otherPath !== `Native Editor Race Other ${runId}.bin` ||
      typeof hold !== "string" || !hold.startsWith(`.git-vault-sync/${runId}/hold/`) ||
      typeof intentId !== "string" || !uuid.test(intentId) || !Array.isArray(checks) ||
      typeof injection !== "object" || injection === null)
    throw new Error("Invalid editor race progress");
  for (const item of checks) if (typeof item !== "object" || item === null ||
      typeof Reflect.get(item, "name") !== "string" || typeof Reflect.get(item, "pass") !== "boolean")
    throw new Error("Invalid editor race check");
  if (typeof Reflect.get(injection, "originalPathAtSecondRename") !== "string" ||
      typeof Reflect.get(injection, "viewType") !== "string" ||
      !(Reflect.get(injection, "boundPath") === null || typeof Reflect.get(injection, "boundPath") === "string"))
    throw new Error("Invalid editor race injection");
  return value as Progress;
}

function original(runId: string): Uint8Array {
  return encoder.encode(`Native editor race original ${runId}\n\u000b`);
}
function incoming(runId: string): Uint8Array {
  return encoder.encode(`Native editor race incoming ${runId}\n\u000b`);
}
function draft(runId: string): Uint8Array {
  return encoder.encode(`Native editor race draft ${runId}\n`);
}

export default class NativeEditorRaceAcceptance extends Plugin {
  private settling = false;
  private closeTimer: number | null = null;

  onload(): void {
    this.app.workspace.onLayoutReady(() => { setTimeout(() => { void this.execute(); }, 2000); });
    this.addCommand({ id: "settle-editor-race", name: "Settle native editor race after closing the fixture view",
      callback: () => { void this.settleFromProgress(); } });
  }

  private async sha256(path: string): Promise<string> {
    const bytes = await this.app.vault.adapter.readBinary(path);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async exact(path: string, expected: Uint8Array): Promise<boolean> {
    const fs = this.app.vault.adapter;
    return await fs.exists(path) && bytesEqual(new Uint8Array(await fs.readBinary(path)), expected);
  }

  private check(checks: Check[], name: string, pass: boolean): void {
    checks.push({ name, pass });
    if (!pass) throw new Error(name);
  }

  private heldView(path: string): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof FileView && leaf.view.file?.path === path) found = true;
    });
    return found;
  }

  private productionEnabled(): boolean {
    const manager: unknown = Reflect.get(this.app, "plugins");
    if (typeof manager !== "object" || manager === null) return true;
    const loaded: unknown = Reflect.get(manager, "plugins");
    return typeof loaded !== "object" || loaded === null ||
      Reflect.get(loaded, "github-vault-sync") !== undefined;
  }

  private async journal(runId: string): Promise<GitObsidianVault> {
    const transactions = await NativeTransactionJournal.open(this.app.vault.adapter, runId);
    return new GitObsidianVault(this.app, undefined, undefined, transactions);
  }

  private async report(completed: boolean, checks: Check[], runId: string | null, error: string | null,
    extra: Record<string, unknown> = {}): Promise<void> {
    await this.app.vault.adapter.write(resultPath, JSON.stringify({ completed, runId, productionSha256: EXPECTED_PRODUCTION_SHA,
      sourceBoundary: "Bundled current GitObsidianVault and NativeTransactionJournal with an isolated synthetic journal; installed production bundle hash checked separately",
      checks, error, ...extra }, null, 2));
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const fs = this.app.vault.adapter;
    if (await fs.exists(resultPath)) return;
    if (await fs.exists(progressPath)) { await this.settleFromProgress(); return; }
    const checks: Check[] = [];
    let runId: string | null = null;
    const race: { injected: boolean; injection: Progress["injection"] | null } =
      { injected: false, injection: null };
    try {
      this.check(checks, "installed production bundle is exact requested SHA",
        await this.sha256(".obsidian/plugins/github-vault-sync/main.js") === EXPECTED_PRODUCTION_SHA);
      this.check(checks, "production sync plugin disabled during isolated local race",
        !this.productionEnabled());
      runId = crypto.randomUUID();
      const path = `Native Editor Race ${runId}.md`;
      const otherPath = `Native Editor Race Other ${runId}.bin`;
      this.check(checks, "synthetic names unused", !await fs.exists(path) && !await fs.exists(otherPath));
      const source = original(runId), nextBytes = incoming(runId), draftBytes = draft(runId);
      const file = await this.app.vault.createBinary(path, buffer(source));
      this.check(checks, "original is actual indexed TFile", file instanceof TFile &&
        this.app.vault.getAbstractFileByPath(path) === file && await this.exact(path, source));
      const expected = await entryFromBytes(source);
      const next = await entryFromBytes(nextBytes);
      const vault = await this.journal(runId);
      const leaf = this.app.workspace.getLeaf(true);
      const originalRename = fs.rename;
      const rename = originalRename.bind(fs);
      fs.rename = async (from, to) => {
        if (to !== path || !from.startsWith(`.git-vault-sync/${runId}/stage/`))
          return rename(from, to);
        if (race.injected) throw new Error("Second rename injection ran twice");
        race.injected = true;
        for (let attempt = 0; attempt < 100 && !file.path.includes("/hold/"); attempt++) await wait(50);
        const originalPathAtSecondRename = file.path;
        if (!file.path.startsWith(`.git-vault-sync/${runId}/hold/`))
          throw new Error("Obsidian did not retarget the original TFile to its hidden hold");
        await leaf.openFile(file);
        const view = leaf.view;
        race.injection = { originalPathAtSecondRename, viewType: view.getViewType(),
          boundPath: view instanceof FileView ? view.file?.path ?? null : null };
        if (!(view instanceof MarkdownView) || view.file !== file || view.file.path !== file.path)
          throw new Error("Obsidian did not open a real Markdown FileView on the held TFile");
        return rename(from, to);
      };
      let result: Awaited<ReturnType<GitObsidianVault["apply"]>>;
      try { result = await vault.apply(path, expected, next); }
      finally { fs.rename = originalRename; }
      this.check(checks, "queued stage-to-visible rename opened a real held FileView", race.injected &&
        race.injection !== null && race.injection.boundPath === file.path && this.heldView(file.path));
      const hold = file.path;
      this.check(checks, "second rename returns blocked", result.kind === "blocked");
      this.check(checks, "incoming bytes installed and original bytes held", await this.exact(path, nextBytes) &&
        await this.exact(hold, source));
      const [intent] = await vault.pendingIntents();
      this.check(checks, "original intent remains attempted", intent?.path === path &&
        intent.attempted && intent.expected?.oid === expected.oid && intent.next?.oid === next.oid);
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file) throw new Error("Held Markdown view changed");
      view.editor.setValue(new TextDecoder().decode(draftBytes));
      view.requestSave();
      let saved = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await this.exact(hold, draftBytes)) { saved = true; break; }
        await wait(250);
      }
      this.check(checks, "real editor saved its draft into hidden hold", saved && this.heldView(hold));
      const openIssues = await vault.recover({ replay: [intent.id], cancel: [] });
      this.check(checks, "open-view replay retains exact draft without settling", this.hasDraft(openIssues, hold, draftBytes) &&
        (await vault.pendingIntents()).some(pending => pending.id === intent.id) && await this.exact(path, nextBytes));
      await vault.recover({ replay: [], cancel: [intent.id] });
      this.check(checks, "open-view cancel preserves attempted original intent", (await vault.pendingIntents()).some(pending =>
        pending.id === intent.id && pending.attempted) && await this.exact(hold, draftBytes));
      const repeated = await vault.apply(path, expected, next);
      this.check(checks, "repeat apply stays blocked", repeated.kind === "blocked");
      await this.app.vault.createBinary(otherPath, buffer(Uint8Array.of(0, 1)));
      const otherExpected = await entryFromBytes(Uint8Array.of(0, 1));
      const otherNext = await entryFromBytes(Uint8Array.of(0, 2));
      const otherResult = await vault.apply(otherPath, otherExpected, otherNext);
      this.check(checks, "unrelated native apply settles while first intent is held", otherResult.kind === "applied" &&
        await this.exact(otherPath, Uint8Array.of(0, 2)) &&
        (await vault.pendingIntents()).some(pending => pending.id === intent.id));
      const injection = race.injection;
      if (injection === null) throw new Error("Missing second rename observation");
      const progress: Progress = { format: 1, runId, path, otherPath, hold, intentId: intent.id, checks,
        injection };
      await fs.write(progressPath, JSON.stringify(progress, null, 2));
      this.watchForClose(progress);
    } catch (error) {
      await this.report(false, checks, runId, error instanceof Error ? error.message : String(error),
        { injection: race.injection });
    }
  }

  private hasDraft(issues: NativeIssue[], hold: string, draftBytes: Uint8Array): boolean {
    const encoded = btoa(String.fromCharCode(...draftBytes));
    return issues.some(issue => issue.kind === "displaced" && issue.sourcePath === hold && issue.found?.data === encoded);
  }

  private watchForClose(progress: Progress): void {
    if (this.closeTimer !== null) return;
    const timer = window.setInterval(() => {
      if (!this.heldView(progress.hold)) {
        window.clearInterval(timer);
        this.closeTimer = null;
        void this.settleFromProgress();
      }
    }, 500);
    this.closeTimer = timer;
    this.registerInterval(timer);
  }

  private async settleFromProgress(): Promise<void> {
    if (this.settling || this.app.vault.getName() !== "Vault Sync Lab") return;
    const fs = this.app.vault.adapter;
    if (await fs.exists(resultPath) || !await fs.exists(progressPath)) return;
    let progress: Progress;
    try { progress = parseProgress(JSON.parse(await fs.read(progressPath))); }
    catch (error) {
      await this.report(false, [], null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.heldView(progress.hold)) { this.watchForClose(progress); return; }
    if (this.productionEnabled()) return;
    this.settling = true;
    const checks = progress.checks;
    try {
      this.check(checks, "installed production bundle still matches", await this.sha256(
        ".obsidian/plugins/github-vault-sync/main.js") === EXPECTED_PRODUCTION_SHA);
      const vault = await this.journal(progress.runId);
      const [pending] = await vault.pendingIntents();
      this.check(checks, "only original pending intent awaits close", pending?.id === progress.intentId &&
        (await vault.pendingIntents()).length === 1 && pending.attempted);
      const issues = await vault.recover({ replay: [pending.id], cancel: [] });
      this.check(checks, "closing view settles original intent", (await vault.pendingIntents()).length === 0);
      this.check(checks, "incoming bytes stay visible", await this.exact(progress.path, incoming(progress.runId)));
      this.check(checks, "editor draft stays in retained hold", await this.exact(progress.hold, draft(progress.runId)));
      this.check(checks, "draft has durable displaced recovery", this.hasDraft(issues, progress.hold, draft(progress.runId)));
      this.check(checks, "unrelated result remains exact", await this.exact(progress.otherPath, Uint8Array.of(0, 2)));
      await this.report(true, checks, progress.runId, null, { path: progress.path, hold: progress.hold,
        otherPath: progress.otherPath, injection: progress.injection,
        retainedIssueIds: issues.filter(issue => issue.sourcePath === progress.hold).map(issue => issue.id) });
    } catch (error) {
      await this.report(false, checks, progress.runId, error instanceof Error ? error.message : String(error),
        { path: progress.path, hold: progress.hold, injection: progress.injection });
    } finally { this.settling = false; }
  }
}
