import { MarkdownView, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { entryFromBytes } from "../../src/git-sync/codec";
import { NativeTransactionJournal } from "../../src/git-sync/native-transactions";
import { GitObsidianVault } from "../../src/git-sync/obsidian-vault";

declare const INSTALLED_PRODUCTION_SHA: string;
declare const BUNDLED_NATIVE_SOURCE_HASHES: Record<string, string>;

const pointerPath = ".git-sync-native-visible-markdown-run.json";
const resultPath = (id: string): string => `.git-sync-native-visible-markdown-${id}-result.json`;
const journalRoot = (id: string): string => `.git-vault-sync/${id}`;
const priorResults = {
  R1: { path: ".git-sync-native-editor-race-result.json", sha256: "36cabf1f7fb4ee88726733246ffaf853bd0e6d68aad4567f48a1fbf6918a2d40" },
  R2: { path: ".git-sync-native-editor-race-r2-e4918102-ee90-4f4c-ba7d-221fc2e0dbb9-result.json", sha256: "e7a35c69638892124a50741f468181cdc3fd118386608f5fc75db71811e9380f" },
  R3: { path: ".git-sync-native-editor-race-r3-c18ec716-04a2-4243-a2e3-9a90b61ea8e3-result.json", sha256: "4a8bd892b3b49203d2658f575714b97eb3d943093a9ca4c4f67f336b62815850" },
};
const encoder = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Check = { name: string; pass: boolean };
type Observation = {
  phase: string;
  elapsedMs: number;
  path: string;
  disk: string;
  view: string;
  dirty: unknown;
  viewType: string;
  boundPath: string | null;
  sameTFile: boolean;
  pendingIntentCount: number;
  recoveryCount: number;
  holdFiles: string[];
  stageFiles: string[];
};
type Outcome = { caseName: "T1" | "T2" | "T3"; applyKind: Awaited<ReturnType<GitObsidianVault["apply"]>>["kind"] };

function original(id: string, caseName: string): string {
  return `L1 original ${caseName} ${id}\nL2 keep\nL3 keep\nL4 keep\nL5 keep\n`;
}
function incoming(id: string, caseName: string): string {
  return `L1 incoming ${caseName} ${id}\nL2 keep\nL3 keep\nL4 keep\nL5 keep\n`;
}
function draft(id: string, caseName: string): string {
  return `draft ${caseName} ${id}\n`;
}

export default class NativeVisibleMarkdownAcceptance extends Plugin {
  onload(): void {
    this.app.workspace.onLayoutReady(() => { window.setTimeout(() => { void this.execute(); }, 2000); });
  }

  private async sha256(path: string): Promise<string | null> {
    const fs = this.app.vault.adapter;
    if (!await fs.exists(path)) return null;
    const bytes = await fs.readBinary(path);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private check(checks: Check[], name: string, pass: boolean): void {
    checks.push({ name, pass });
    if (!pass) throw new Error(name);
  }

  private productionDisabled(): boolean {
    const manager: unknown = Reflect.get(this.app, "plugins");
    if (typeof manager !== "object" || manager === null) return false;
    const loaded: unknown = Reflect.get(manager, "plugins");
    if (typeof loaded !== "object" || loaded === null ||
        Reflect.get(loaded, "github-vault-sync") !== undefined) return false;
    const enabled: unknown = Reflect.get(manager, "enabledPlugins");
    return !(enabled instanceof Set && enabled.has("github-vault-sync"));
  }

  private async priorEvidenceUnchanged(): Promise<boolean> {
    for (const { path, sha256 } of Object.values(priorResults))
      if (await this.sha256(path) !== sha256) return false;
    return true;
  }

  private async folderFiles(path: string): Promise<string[]> {
    const fs = this.app.vault.adapter;
    if (!await fs.exists(path)) return [];
    const { files, folders } = await fs.list(path);
    return [...files, ...folders];
  }

  private viewFor(leaf: WorkspaceLeaf, file: TFile): MarkdownView {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file !== file || file.path !== file.name ||
        this.app.vault.getAbstractFileByPath(file.path) !== file)
      throw new Error(`Natural MarkdownView is no longer bound to ${file.path}`);
    return view;
  }

  private async observe(phase: string, started: number, leaf: WorkspaceLeaf, file: TFile,
    vault: GitObsidianVault, id: string, observations: Observation[]): Promise<void> {
    const view = this.viewFor(leaf, file);
    const [disk, pending, holdFiles, stageFiles] = await Promise.all([
      this.app.vault.adapter.read(file.path), vault.pendingIntents(),
      this.folderFiles(`${journalRoot(id)}/hold`), this.folderFiles(`${journalRoot(id)}/stage`),
    ]);
    observations.push({ phase, elapsedMs: Date.now() - started, path: file.path, disk,
      view: view.getViewData(), dirty: Reflect.get(view, "dirty") ?? null,
      viewType: view.getViewType(), boundPath: view.file?.path ?? null, sameTFile: view.file === file,
      pendingIntentCount: pending.length, recoveryCount: vault.nativeRecoveries().length, holdFiles, stageFiles });
  }

  private async settled(name: string, expected: string, checks: Check[], leaf: WorkspaceLeaf, file: TFile,
    vault: GitObsidianVault, id: string, observations: Observation[]): Promise<void> {
    await this.observe(`${name}-settled`, Date.now(), leaf, file, vault, id, observations);
    const state = observations[observations.length - 1];
    this.check(checks, `${name}: natural MarkdownView and visible TFile remain bound`,
      state.viewType === "markdown" && state.sameTFile && state.boundPath === file.path);
    this.check(checks, `${name}: final disk and view bytes exact`, state.disk === expected && state.view === expected);
    this.check(checks, `${name}: no hold, stage, pending intent, or recovery`,
      state.holdFiles.length === 0 && state.stageFiles.length === 0 &&
      state.pendingIntentCount === 0 && state.recoveryCount === 0);
    this.check(checks, `${name}: R1/R2/R3 result bytes unchanged`, await this.priorEvidenceUnchanged());
  }

  private async openFixture(path: string, content: string, leaf: WorkspaceLeaf,
    checks: Check[]): Promise<{ file: TFile; view: MarkdownView }> {
    const fs = this.app.vault.adapter;
    this.check(checks, `${path}: new UUID fixture name unused`, !await fs.exists(path));
    const file = await this.app.vault.create(path, content);
    this.check(checks, `${path}: indexed plain UTF-8 fixture`,
      file instanceof TFile && this.app.vault.getAbstractFileByPath(path) === file &&
      await fs.read(path) === content && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content));
    await leaf.openFile(file);
    await leaf.loadIfDeferred();
    const view = this.viewFor(leaf, file);
    this.check(checks, `${path}: host naturally opened MarkdownView`, view.getViewType() === "markdown" &&
      view.getViewData() === content);
    return { file, view };
  }

  private async waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await condition()) return true;
      await sleep(50);
    } while (Date.now() < deadline);
    return condition();
  }

  private async runCase(id: string, caseName: "T1" | "T2" | "T3", leaf: WorkspaceLeaf,
    vault: GitObsidianVault, checks: Check[], observations: Observation[], outcomes: Outcome[]): Promise<void> {
    const path = `Native Visible Markdown ${caseName} ${id}.md`;
    const source = original(id, caseName);
    const next = incoming(id, caseName);
    const userDraft = draft(id, caseName);
    const { file, view } = await this.openFixture(path, source, leaf, checks);
    const started = Date.now();
    await this.observe(`${caseName}-opened`, started, leaf, file, vault, id, observations);

    if (caseName !== "T1") {
      const editStarted = Date.now();
      view.editor.replaceRange(userDraft, { line: 5, ch: 0 });
      const edited = source + userDraft;
      this.check(checks, `${caseName}: editor contains exact draft`, view.getViewData() === edited);
      if (caseName === "T2") {
        const hostDirty = await this.waitFor(() => Reflect.get(view, "dirty") === true, 500);
        await this.observe("T2-dirty-before-apply", editStarted, leaf, file, vault, id, observations);
        this.check(checks, "T2: host reports dirty MarkdownView before apply", hostDirty);
        this.check(checks, "T2: draft is unsaved on disk before apply",
          await this.app.vault.adapter.read(path) === source);
        this.check(checks, "T2: apply begins inside host autosave window", Date.now() - editStarted < 2000);
      } else {
        await this.observe("T3-dirty-before-save", editStarted, leaf, file, vault, id, observations);
        const saved = await this.waitFor(async () => await this.app.vault.adapter.read(path) === edited, 4000);
        await this.observe("T3-after-host-save", editStarted, leaf, file, vault, id, observations);
        this.check(checks, "T3: host saved exact draft before apply", saved);
      }
    }

    const applyStarted = Date.now();
    const result = await vault.apply(path, await entryFromBytes(encoder.encode(source)),
      await entryFromBytes(encoder.encode(next)));
    outcomes.push({ caseName, applyKind: result.kind });
    await this.observe(`${caseName}-after-apply`, applyStarted, leaf, file, vault, id, observations);
    if (caseName === "T3") {
      this.check(checks, "T3: saved edit causes changed", result.kind === "changed");
      this.check(checks, "T3: saved disk and view bytes remain exact",
        await this.app.vault.adapter.read(path) === source + userDraft &&
        view.getViewData() === source + userDraft);
    } else {
      this.check(checks, `${caseName}: text apply returns applied`, result.kind === "applied");
      this.check(checks, `${caseName}: incoming bytes on disk immediately after apply`,
        await this.app.vault.adapter.read(path) === next);
      if (caseName === "T1") {
        const updated = await this.waitFor(() => view.getViewData() === next, 3000);
        this.check(checks, "T1: clean view shows exact incoming bytes", updated);
      } else {
        const merged = next + userDraft;
        const viewMerged = await this.waitFor(() => view.getViewData() === merged, 3000);
        await this.observe("T2-after-host-merge", applyStarted, leaf, file, vault, id, observations);
        this.check(checks, "T2: host view merged incoming line and unsaved draft", viewMerged);
        const diskMerged = await this.waitFor(async () => await this.app.vault.adapter.read(path) === merged, 4000);
        this.check(checks, "T2: host saved exact merged bytes", diskMerged);
        const captured = await vault.capture();
        const expected = await entryFromBytes(encoder.encode(merged));
        this.check(checks, "T2: native capture sees merged local version",
          captured[path]?.oid === expected.oid && captured[path]?.data === expected.data);
      }
    }
    await this.settled(caseName, caseName === "T1" ? next : caseName === "T2" ? next + userDraft : source + userDraft,
      checks, leaf, file, vault, id, observations);
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const fs = this.app.vault.adapter;
    if (await fs.exists(pointerPath)) return;
    const id = crypto.randomUUID();
    if (!uuid.test(id)) throw new Error("Host randomUUID did not return a UUID");
    const checks: Check[] = [];
    const observations: Observation[] = [];
    const outcomes: Outcome[] = [];
    let completed = false;
    let error: string | null = null;
    try {
      await fs.write(pointerPath, JSON.stringify({ format: 1, runId: id }));
      this.check(checks, "named disposable lab vault", this.app.vault.getName() === "Vault Sync Lab");
      this.check(checks, "installed production bundle has exact injected SHA",
        await this.sha256(".obsidian/plugins/github-vault-sync/main.js") === INSTALLED_PRODUCTION_SHA);
      this.check(checks, "production sync plugin disabled", this.productionDisabled());
      this.check(checks, "R1/R2/R3 result bytes match preserved hashes", await this.priorEvidenceUnchanged());
      const transactions = await NativeTransactionJournal.open(fs, id);
      const vault = new GitObsidianVault(this.app, undefined, undefined, transactions);
      const leaf = this.app.workspace.getLeaf(true);
      await this.runCase(id, "T1", leaf, vault, checks, observations, outcomes);
      await this.runCase(id, "T2", leaf, vault, checks, observations, outcomes);
      await this.runCase(id, "T3", leaf, vault, checks, observations, outcomes);
      this.check(checks, "installed production SHA unchanged at end",
        await this.sha256(".obsidian/plugins/github-vault-sync/main.js") === INSTALLED_PRODUCTION_SHA);
      completed = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    try {
      const preserved = await this.priorEvidenceUnchanged();
      checks.push({ name: "R1/R2/R3 result bytes unchanged at finish", pass: preserved });
      if (!preserved) { completed = false; error ??= "R1/R2/R3 result bytes changed during run"; }
    } catch (cause) {
      completed = false;
      error ??= `Could not verify R1/R2/R3 at finish: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    await fs.write(resultPath(id), JSON.stringify({ format: 1, completed, runId: id, error, checks,
      observations, outcomes, previousResultHashes: priorResults,
      installedProductionSha256Expected: INSTALLED_PRODUCTION_SHA,
      bundledNativeSourceHashes: BUNDLED_NATIVE_SOURCE_HASHES,
      sourceBoundary: "Current GitObsidianVault and NativeTransactionJournal are bundled in this disposable helper; installed production is checked only for provenance.",
      scope: "Real Android MarkdownView text-process path; T1 clean, T2 dirty unsaved non-overlap, T3 saved before apply.",
      notEstablished: ["in-flight editor save ordering", "non-plaintext or third-party views", "power loss", "physical storage providers"],
    }, null, 2));
  }
}
