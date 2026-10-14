import { inspectGitTakeover, takeOverGit } from "./git-takeover";
import { detectGitRepository, type DetectedRepository } from "./git-setup";
import { readLocalCandidate } from "./git-sync/local-candidate";
import { Notice, Plugin, requestUrl } from "obsidian";
import { GitHubRepository } from "./git-sync/github";
import { SyncSession, type SyncOutcome } from "./git-sync/session";
import { parseState } from "./git-sync/state";
import type { FileMode, RepositoryIdentity } from "./git-sync/contracts";
import { decodeBase64 } from "./git-sync/codec";
import { GitObsidianVault } from "./git-sync/obsidian-vault";
import { FileJournalStore } from "./git-sync/store";
import { ForegroundScheduler } from "./git-sync/scheduler";
import { PluginOwnership, hostLifetimeId } from "./git-sync/ownership";
import { NativeTransactionJournal, NativePolicyMismatchError } from "./git-sync/native-transactions";
import { NativePathPolicy } from "./git-sync/native-path-policy";
import { NativeModeStore, parseModes } from "./git-sync/native-modes";
import { defaultSettings, parseSettings, type Settings } from "./settings";
import { formatCommitMessage } from "./commit-message";
import { installationId } from "./device";
import {
  accessProblem,
  ago,
  describeOutcome,
  failure,
  offline,
  outcomeAttention,
  rejectedAccess,
  setConfigDirName,
  type AccessTarget,
  type Activity,
} from "./ui/copy";
import { openSettingsTab } from "./ui/obsidian-private";
import { GitSettings, deviceSuggestion } from "./ui/settings-tab";
import { ChangesModal } from "./ui/changes-modal";
import { SyncHistoryModal, RestoreModal } from "./ui/history-modals";

/** Per-vault, per-device record of the last working GitHub access (see `activity`). */
const activityKey = "github-vault-sync-activity";
export default class GitVaultSync extends Plugin {
  settings: Settings = defaultSettings();
  session: SyncSession | null = null;
  statusText = "Set up GitHub sync";
  statusProblem = false;
  syncing = false;
  private alerted: string | null = null;
  private alertNotice: Notice | null = null;
  private scheduler: ForegroundScheduler | null = null;
  private statusElement: HTMLElement | null = null;
  private ready = false;
  private ownership: PluginOwnership | null = null;
  private unloaded = false;
  private rawSession: SyncSession | null = null;
  private repository: GitHubRepository | null = null;
  private journals: FileJournalStore[] = [];
  private lastCleanup = 0;
  private modes: NativeModeStore | null = null;
  private nativeJournal: NativeTransactionJournal | null = null;
  private nativeVault: GitObsidianVault | null = null;
  private owner(): PluginOwnership {
    if (this.unloaded) throw new Error("This sync instance has retired.");
    return this.ownership ??= new PluginOwnership(this.app);
  }
  private listeners = new Set<() => void>();
  // Reads current settings at commit time, so format edits apply without reconnecting.
  private commitMessage = (count: number, date: Date): string => formatCommitMessage(
    this.settings.commitMessageTemplate, this.settings.commitDateFormat, { device: this.settings.deviceName, count, date });
  async onload(): Promise<void> {
    this.owner();
    try {
      await this.owner().run(async () => {
        const settings = parseSettings(await this.loadData());
        this.owner().assertActive();
        // Never-connected vaults name commits after the platform; a connected vault keeps the name it already commits with.
        if (!settings.owner && settings.deviceName === defaultSettings().deviceName) settings.deviceName = deviceSuggestion();
        this.settings = settings;
      });
    } catch (error) {
      new Notice(failure(error), 12000);
      return;
    }
    setConfigDirName(this.app.vault.configDir);
    this.statusElement = this.addStatusBarItem();
    this.statusElement.addClass("git-sync-status");
    this.statusElement.setAttr("role", "button");
    this.statusElement.setAttr("tabindex", "0");
    this.statusElement.setAttr("aria-label", "Open sync status");
    this.statusElement.onclick = () => new ChangesModal(this.app, this).open();
    this.statusElement.onkeydown = event => { if (event.key === "Enter" || event.key === " ") new ChangesModal(this.app, this).open(); };
    this.setStatus("Set up GitHub sync");
    this.addSettingTab(new GitSettings(this.app, this));
    this.addRibbonIcon("git-branch", "Sync status", () =>
      new ChangesModal(this.app, this).open(),
    );
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => { void this.syncNow(); } });
    this.addCommand({ id: "changes", name: "Sync status", callback: () => new ChangesModal(this.app, this).open() });
    this.addCommand({ id: "history", name: "Sync history", callback: () => new SyncHistoryModal(this.app, this).open() });
    this.addCommand({ id: "restore", name: "File history", callback: () => new RestoreModal(this.app, this).open() });
    this.scheduler = new ForegroundScheduler(
      () => this.syncOnce(),
      () => this.ready && this.settings.automatic && this.session !== null,
      () => !document.hidden,
      (error) => this.fail(error),
    );
    const schedule = () => this.scheduler?.schedule();
    const edited = () => this.scheduler?.edited();
    const changed = (path: string) => {
      if (this.unloaded) return;
      if (path.split("/").some(part => part.startsWith("."))) return;
      void this.notifyLocalChange().then(edited).catch(error => this.fail(error));
    };
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        changed(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        changed(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        changed(file.path);
      }),
    );
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.unloaded) return;
      if ([oldPath, file.path].some(path => path === ".git-vault-sync" || path.startsWith(".git-vault-sync/"))) { schedule(); return; }
      if ([oldPath, file.path].every(path => path.split("/").some(part => part.startsWith(".")))) return;
      void this.recordRename(oldPath, file.path).then(edited).catch(error => this.fail(error));
    }));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) this.scheduler?.flush();
      else schedule();
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.ready = true;
      void this.initialize().catch((error) => this.fail(error));
    });
  }
  onunload(): void {
    this.alertNotice?.hide();
    this.unloaded = true;
    this.ready = false;
    this.scheduler?.stop();
    void this.ownership?.retire();
    this.listeners.clear();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  setStatus(value: string, problem = false): void {
    this.statusText = value;
    this.statusProblem = problem;
    this.statusElement?.setText(`GitHub: ${value}`);
    this.statusElement?.toggleClass("mod-warning", problem);
    for (const fn of this.listeners) fn();
  }
  /**
   * Success stays quiet in the status line. A problem also raises one notice
   * that stays until tapped, and only again once the problem changes.
   */
  private alert(key: string, text: string, fix: "status" | "settings" = "status"): void {
    if (this.alerted === key) return;
    this.alerted = key;
    this.alertNotice?.hide();
    const notice = this.alertNotice = new Notice(`${text} ${fix === "settings" ? "Tap to open settings." : "Tap for details."}`, 0);
    notice.noticeEl?.addEventListener("click", () => fix === "settings" ? this.openSettings() : new ChangesModal(this.app, this).open());
  }
  /** A sync that finished cleanly takes down any problem notice still on screen. */
  private settled(): void {
    this.alerted = null;
    this.alertNotice?.hide();
    this.alertNotice = null;
  }
  /** Opens this plugin's settings page; uses Obsidian's unofficial settings API when present. */
  openSettings(): void {
    if (!openSettingsTab(this.app, this.manifest.id)) new Notice("Open Settings → GitHub Vault Sync.");
  }
  /** Background failures: offline is retried quietly; anything else is shown until it's fixed. */
  fail(error: unknown): void {
    if (rejectedAccess(error)) {
      const problem = accessProblem(error, this.settings);
      this.setStatus(problem, true);
      this.alert(`access:${problem}`, `Sync stopped: ${problem}`, "settings");
      return;
    }
    if (offline(error)) {
      const last = this.activity.syncedAt;
      this.setStatus(last ? `Offline · last synced ${ago(last)}` : "Offline · will retry");
      // A long silence means something more than a flaky connection.
      if (last && Date.now() - last > 6 * 60 * 60 * 1000) this.alert("offline", `Can't reach GitHub. Last synced ${ago(last)}.`);
      return;
    }
    const message = failure(error);
    this.setStatus(message, true);
    this.alert(`error:${message}`, `Sync stopped: ${message}`);
  }
  initialize(): Promise<void> {
    return this.owner().run(() => this.initializeOwned());
  }
  private async initializeOwned(): Promise<void> {
    const owner = this.owner();
    owner.assertActive();
    await owner.drainAdmissions();
    // Invalidate queued callbacks holding previews from the prior configuration.
    this.rawSession = null;
    this.repository = null;
    this.journals = [];
    this.session = null;
    this.modes = null;
    this.nativeJournal = null;
    this.nativeVault = null;
    if (
      !this.settings.owner ||
      !this.settings.repository ||
      !this.settings.secretId
    )
      return;
    const installation = installationId(this.app, { create: true });
    if (!this.app.secretStorage)
      throw new Error(
        "Obsidian 1.11.4 or newer is required for secret storage.",
      );
    const files = owner.fence(this.app.vault.adapter);
    const store = new FileJournalStore(files, installation);
    const raw = await store.load();
    const state = raw === null ? null : await parseState(raw);
    const scopeRules = state?.pause?.reason === "scope-enrollment"
      ? "config/1"
      : state?.scope.rules ?? (this.settings.configuration ? "config/1" : "visible-only");
    const nativePolicy = scopeRules === "config/1"
      ? await NativePathPolicy.forConfig(this.app.vault.configDir)
      : NativePathPolicy.legacy;
    const repository = this.createRepository(installation, scopeRules);
    const modes: Record<string, FileMode> = Object.create(null);
    if (state !== null) {
      for (const [path, ref] of Object.entries(state.base.files)) modes[path] = ref.mode;
    }
    const modeKey = `github-vault-sync-modes-${installation}`;
    const storedModes: unknown = this.app.loadLocalStorage(modeKey);
    if (storedModes !== null && storedModes !== undefined)
      Object.assign(modes, parseModes(storedModes));
    const modeStore = new FileJournalStore(files, installation, "modes");
    this.modes = await NativeModeStore.open(modeStore, modes);
    let nativeJournal: NativeTransactionJournal;
    try {
      nativeJournal = await NativeTransactionJournal.open(files, installation, nativePolicy);
    } catch (error) {
      if (!(error instanceof NativePolicyMismatchError) || state?.pause?.reason !== "scope-enrollment") throw error;
      const legacyJournal = await NativeTransactionJournal.open(files, installation, NativePathPolicy.legacy);
      await legacyJournal.upgradePolicy(nativePolicy, async () => {
        owner.assertActive();
        const current = await store.load();
        if (current === null || (await parseState(current)).pause?.reason !== "scope-enrollment")
          throw new Error("Configuration sync requires a durable reviewed enrollment pause.");
        owner.assertActive();
      });
      nativeJournal = await NativeTransactionJournal.open(files, installation, nativePolicy);
    }
    this.nativeJournal = nativeJournal;
    await this.transferRenamesOwned();
    const nativeVault = new GitObsidianVault(this.app, owner.fence(this.modes), () => {
      owner.assertActive();
      if (owner.hasPendingRenames()) throw new Error("A vault rename is pending. Retry after its mode metadata is saved.");
    }, owner.fence(nativeJournal), hostLifetimeId(this.app), nativePolicy);
    this.nativeVault = nativeVault;
    const rawSession = new SyncSession({
      repository: owner.fence(repository),
      vault: owner.fence(nativeVault),
      store: owner.fence(store),
      deviceName: this.settings.deviceName,
      commitMessage: this.commitMessage,
      hostLifetimeId: hostLifetimeId(this.app),
      scopeRules,
    });
    owner.assertActive();
    this.rawSession = rawSession;
    this.repository = repository;
    this.journals = [store, modeStore];
    this.session = owner.queued(rawSession, () => this.rawSession === rawSession);
    const pendingChange = owner.pendingLocalChange();
    if (pendingChange !== null) {
      const result = await rawSession.notifyLocalChange();
      if (result.kind === "invalidated" || result.kind === "unenrolled") owner.acknowledgeLocalChange(pendingChange);
    }
    const status = await rawSession.status();
    if (status.kind === "corrupt") {
      this.setStatus(status.detail, true);
      this.alert(`corrupt:${status.detail}`, `Sync needs repair: ${status.detail}`, "settings");
    } else this.setStatus(status.kind === "unenrolled" ? "Not syncing yet · finish setup in settings" : "Ready to sync");
    if (status.kind === "enrolled") this.scheduler?.schedule(1000);
  }
  /** `target` checks a draft repository or unsaved token without touching saved settings or status. */
  private createRepository(installation: string, scopeRules: "visible-only" | "config/1", target?: AccessTarget): GitHubRepository {
    const owner = this.owner();
    return new GitHubRepository({
      installation,
      scopeRules,
      configDir: this.app.vault.configDir,
      owner: target?.owner ?? this.settings.owner,
      name: target?.repository ?? this.settings.repository,
      branch: target?.branch ?? this.settings.branch,
      ...(target ? {} : {
        readLocal: async (path: string, expectedSize: number) => {
          owner.assertActive();
          const bytes = await readLocalCandidate(this.app.vault.adapter, path, expectedSize);
          owner.assertActive();
          return bytes;
        },
        onReadProgress: (done: number, total: number) => {
          owner.assertActive();
          this.setStatus(`Checking GitHub files ${done.toLocaleString()} of ${total.toLocaleString()}`);
        },
      }),
      token: async () => {
        owner.assertActive();
        const token = target?.token ?? this.app.secretStorage.getSecret(this.settings.secretId);
        if (!token) throw new Error("Choose a GitHub token in settings.");
        return token;
      },
      transport: {
        requestArchive: async ({ url, method, headers }) => {
          owner.assertActive();
          const response = await requestUrl({ url, method, headers, throw: false });
          owner.assertActive();
          return { status: response.status, headers: response.headers, bytes: new Uint8Array(response.arrayBuffer) };
        },
        request: async ({ url, method, headers, body }) => {
          owner.assertActive();
          const response = await requestUrl({
            url,
            method,
            headers,
            body,
            throw: false,
          });
          let json: unknown = null;
          try {
            json = JSON.parse(response.text);
          } catch {
            /* Parsed as invalid by repository boundary. */
          }
          return { status: response.status, headers: response.headers, json };
        },
      },
    });
  }
  /** Read-only guess from this vault's Git metadata, used to prefill a blank setup form. */
  detectRepository(): Promise<DetectedRepository | null> {
    return detectGitRepository(this.owner().fence(this.app.vault.adapter));
  }
  hasToken(): boolean {
    return Boolean(this.settings.secretId && this.app.secretStorage?.getSecret(this.settings.secretId));
  }
  /**
   * Stores a token under a fresh key no other vault or plugin uses, so saving
   * never overwrites a secret something else relies on. Earlier keys are left
   * in place. Returns the key to save in settings.
   */
  saveToken(value: string): string {
    if (!this.app.secretStorage) throw new Error("Obsidian 1.11.4 or newer is required for secret storage.");
    const id = `github-vault-sync-token-${crypto.randomUUID()}`;
    this.app.secretStorage.setSecret(id, value.trim());
    return id;
  }
  /**
   * Reads the repository and branch head with a draft target, two GETs that
   * download no files and change nothing. A missing `token` uses the saved
   * one. Rejects with a message ready to show.
   */
  async checkAccess(target: AccessTarget): Promise<void> {
    try { await this.probeAccess(target); }
    catch (error) { throw new Error(accessProblem(error, target)); }
  }
  private async probeAccess(target: AccessTarget): Promise<void> {
    if (target.token === undefined && !this.hasToken()) throw new Error("No token is saved on this device. Paste one.");
    // Two read-only GETs; with no stored identity yet, a throwaway one names nothing.
    const installation = installationId(this.app, { create: false, nonString: "missing" }) ?? crypto.randomUUID();
    await this.createRepository(installation, "visible-only", target).checkAccess();
  }
  /** Re-checks the saved repository and token for the settings page. Being offline is not recorded as a token problem. */
  async verifyAccess(): Promise<void> {
    const checked = this.settings;
    // A token replaced or settings saved while this check ran makes its result obsolete.
    const current = () => {
      this.owner().assertActive();
      const now = this.settings;
      return now.secretId === checked.secretId && now.owner === checked.owner && now.repository === checked.repository && now.branch === checked.branch;
    };
    try { await this.probeAccess(checked); }
    catch (error) {
      if (current() && (rejectedAccess(error) || !this.hasToken())) this.noteAccess(accessProblem(error, checked));
      return;
    }
    if (current()) this.noteAccess(null);
  }
  /** Verifies `value` against the connected repository, then saves it. On failure the working token stays. Skips saving once `wanted` turns false. */
  async replaceToken(value: string, wanted: () => boolean = () => true): Promise<boolean> {
    const token = value.trim();
    await this.checkAccess({ ...this.settings, token });
    if (!wanted()) return false;
    const secretId = this.saveToken(token);
    await this.saveConfiguration({ ...this.settings, secretId });
    this.noteAccess(null);
    return true;
  }
  get activity(): Activity {
    const value: unknown = this.app.loadLocalStorage(activityKey);
    if (typeof value !== "object" || value === null) return {};
    const read = (key: string) => { const field: unknown = Reflect.get(value, key); return typeof field === "number" && Number.isFinite(field) ? field : undefined; };
    const problem: unknown = Reflect.get(value, "problem");
    return { checkedAt: read("checkedAt"), syncedAt: read("syncedAt"), problem: typeof problem === "string" ? problem : undefined };
  }
  /** `null` records working access now; a message records a failed check and keeps the last good time. */
  noteAccess(problem: string | null, synced = false): void {
    const now = Date.now(), last = this.activity;
    const next: Activity = problem === null
      ? { checkedAt: now, syncedAt: synced ? now : last.syncedAt }
      : { ...last, problem };
    this.app.saveLocalStorage(activityKey, next);
    for (const fn of this.listeners) fn();
  }
  previewConfigurationUpgrade() {
    return this.owner().run(async () => {
      const owner = this.owner();
      const current = this.rawSession;
      const vault = this.nativeVault;
      const store = this.journals[0];
      const journal = this.nativeJournal;
      if (!current || !vault || !store || !journal) throw new Error("Start syncing first, then turn on settings sync.");
      await this.assertSingleWriter();
      const configuration = await current.listConfiguration();
      if (configuration.kind === "configuration" && configuration.rules === "config/1")
        throw new Error("Settings sync is already on. Review incoming updates from Sync status.");
      const installation = installationId(this.app, { create: false, nonString: "missing" });
      if (installation === null) throw new Error("Missing device identity.");
      const migration = new SyncSession({
        repository: owner.fence(this.createRepository(installation, "config/1")),
        vault: owner.fence(vault), store: owner.fence(store),
        deviceName: this.settings.deviceName, commitMessage: this.commitMessage, scopeRules: "config/1", hostLifetimeId: hostLifetimeId(this.app),
      });
      const policy = await NativePathPolicy.forConfig(this.app.vault.configDir);
      await journal.previewPolicyUpgrade(policy);
      const preview = await migration.previewConfigurationScope();
      if (preview.kind !== "preview") throw new Error(preview.kind === "paused" ? `Sync is paused: ${preview.pause.detail}` : preview.kind === "busy" ? "Finish the open items in Sync status first." : "Settings sync can't start yet. Try again after the next sync.");
      return {
        note: preview.note,
        confirm: () => owner.run(async () => {
          if (this.rawSession !== current) throw new Error("Sync configuration changed. Reopen the review.");
          await this.assertSingleWriter();
          await journal.previewPolicyUpgrade(policy);
          const result = await migration.enableConfigurationScope({ token: preview.token });
          if (result.kind !== "reenroll") throw new Error(result.kind === "paused" ? `Sync is paused: ${result.pause.detail}` : "Something changed. Try turning on settings sync again.");
          await this.initializeOwned();
          return this.rawSession?.previewEnrollment();
        }),
      };
    });
  }
  async checkSetup(): Promise<boolean> {
    await this.assertNoCompetingSync();
    const check = await inspectGitTakeover(this.owner().fence(this.app.vault.adapter));
    if (check.kind === "blocked") throw new Error(check.reason);
    return check.kind === "ready";
  }
  startSyncing(token: string): ReturnType<SyncSession["enroll"]> {
    return this.owner().run(async () => {
      if (!this.rawSession) throw new Error("Connect to GitHub first.");
      await this.checkSetup();
      const preview = await this.rawSession.previewEnrollment();
      if (preview.kind !== "preview") return preview;
      if (preview.token !== token) return { kind: "stale", preview };
      const result = await takeOverGit(this.owner().fence(this.app.vault.adapter));
      if (result.kind === "blocked") throw new Error(result.reason);
      await this.assertSingleWriter();
      try {
        return await this.rawSession.enroll({ token });
      } catch (error) {
        if (result.kind === "moved")
          throw new Error(`${failure(error)} Your previous Git folder is kept at ${result.keptAt}. Reopen setup to try again.`);
        throw error;
      }
    });
  }
  async assertSingleWriter(): Promise<void> {
    if (await this.app.vault.adapter.exists(".git"))
      throw new Error("Finish connecting in GitHub Vault Sync settings before syncing this Git vault.");
    await this.assertNoCompetingSync();
  }
  private async assertNoCompetingSync(): Promise<void> {
    const path = `${this.app.vault.configDir}/community-plugins.json`;
    if (await this.app.vault.adapter.exists(path)) {
      const plugins: unknown = JSON.parse(
        await this.app.vault.adapter.read(path),
      );
      const conflicts = [
        "obsidian-git",
        "obsidian-livesync",
        "remotely-save",
        "remotely-sync",
        "cloud-vault-sync",
      ];
      if (
        Array.isArray(plugins) &&
        plugins.some((id) => typeof id === "string" && conflicts.includes(id))
      )
        throw new Error(
          "Turn off the other sync plugin in Settings → Community plugins, then try again.",
        );
    }
  }
  fileHistory(input: Parameters<GitHubRepository["history"]>[0]) {
    return this.owner().run(async () => {
      if (!this.repository || !this.session) throw new Error("Connect this vault to GitHub first.");
      const status = await this.rawSession?.status();
      if (status?.kind !== "enrolled") throw new Error("Start syncing to see history.");
      return this.repository.history({ ...input, at: input.at ?? status.commit });
    });
  }
  private async compactRecoveryOwned(): Promise<{ recordsRemoved: number; objectsRemoved: number }> {
    const status = await this.rawSession?.status();
    if (!status || status.kind !== "enrolled") throw new Error("Start syncing before cleaning up recovery copies.");
    const total = { recordsRemoved: 0, objectsRemoved: 0 };
    for (const journal of this.journals) {
      const result = await journal.compact();
      total.recordsRemoved += result.recordsRemoved;
      total.objectsRemoved += result.objectsRemoved;
    }
    if (this.nativeJournal?.pending().length) throw new Error("Finish the interrupted file operation before cleaning native recovery storage.");
    await this.nativeJournal?.compact();
    this.lastCleanup = Date.now();
    return total;
  }
  private observeLocalChange(): Promise<unknown> {
    // This call must happen at observation time: the engine retires the active generation synchronously.
    const owner = this.owner();
    const revision = owner.recordLocalChange();
    if (this.rawSession) return this.rawSession.notifyLocalChange().then(result => {
      if (result.kind === "invalidated" || result.kind === "unenrolled") owner.acknowledgeLocalChange(revision);
      return result;
    });
    return Promise.resolve();
  }
  async notifyLocalChange(): Promise<void> {
    const owner = this.owner();
    owner.assertActive();
    await owner.track(this.observeLocalChange());
  }
  private async transferRenamesOwned(): Promise<void> {
    if (!this.modes) return;
    const owner = this.owner();
    for (const rename of owner.pendingRenames()) {
      owner.assertActive();
      await this.modes.rename(rename.from, rename.to);
      owner.acknowledgeRename(rename.id);
    }
  }
  async recordRename(from: string, to: string): Promise<void> {
    const owner = this.owner();
    owner.recordRename(from, to);
    await owner.track(this.observeLocalChange(), () => this.transferRenamesOwned());
  }
  syncOnce(): Promise<void> {
    return this.owner().run(async () => {
      if (!this.rawSession || !this.ready) return;
      await this.assertSingleWriter();
      this.owner().assertActive();
      this.syncing = true;
      this.setStatus("Syncing…");
      let outcome: SyncOutcome;
      try { outcome = await this.rawSession.sync(); }
      catch (error) {
        if (rejectedAccess(error)) this.noteAccess(accessProblem(error, this.settings));
        throw error;
      } finally { this.syncing = false; }
      if (outcome.kind === "synced" || outcome.kind === "up-to-date") this.noteAccess(null, true);
      const attention = outcomeAttention(outcome);
      this.setStatus(describeOutcome(outcome), attention !== null);
      if (attention) this.alert(attention.key, attention.text, attention.fix);
      else this.settled();
      if (outcome.kind === "synced" && Date.now() - this.lastCleanup >= 30 * 60 * 1000) {
        // Internal safety copies are pruned quietly; a failed cleanup retries next time.
        try { await this.compactRecoveryOwned(); }
        catch (error) { console.warn("GitHub Vault Sync: cleanup skipped", error); }
      }
    });
  }
  async syncNow(): Promise<void> {
    if (!this.session) {
      new Notice("Finish setting up GitHub Vault Sync in settings.");
      return;
    }
    await this.scheduler?.now();
  }
  private async repositoryBinding(): Promise<RepositoryIdentity | null> {
    if (this.rawSession) {
      const status = await this.rawSession.status();
      if (status.kind === "corrupt") throw new Error(status.detail);
      return status.kind === "enrolled" ? status.repository : null;
    }
    const installation = installationId(this.app, { create: false });
    if (installation === null) return null;
    const store = new FileJournalStore(this.owner().fence(this.app.vault.adapter), installation);
    const state = await store.load();
    return state === null ? null : (await parseState(state)).repository;
  }
  saveConfiguration(next: Settings): Promise<void> {
    // Parse synchronously at admission; later edits to the form cannot alter queued saves.
    const saved = parseSettings(next);
    return this.owner().run(async () => {
      const binding = await this.repositoryBinding();
      if (!binding && Boolean(saved.configuration) !== Boolean(this.settings.configuration)) {
        const installation = installationId(this.app, { create: false, nonString: "missing" });
        const nativeState = installation !== null
          ? await new FileJournalStore(this.owner().fence(this.app.vault.adapter), installation, "native").load()
          : null;
        if (this.nativeJournal || nativeState !== null)
          throw new Error("Settings sync was already chosen for this vault. Start syncing first, then change it from the settings page.");
      }
      if (binding &&
          (saved.owner.toLowerCase() !== binding.owner.toLowerCase() ||
           saved.repository.toLowerCase() !== binding.name.toLowerCase() ||
           saved.branch !== binding.branch))
        throw new Error(`This vault already syncs with ${binding.owner}/${binding.name} (${binding.branch}). To sync a different repository, use another vault.`);
      this.owner().assertActive();
      await this.saveData(saved);
      this.owner().assertActive();
      this.settings = parseSettings(saved);
      if (!binding || !this.rawSession) await this.initializeOwned();
      else this.scheduler?.schedule();
    });
  }
  exportRecoveryCopy(id: string): Promise<string> {
    return this.owner().run(async () => {
      const snapshot = await this.rawSession?.exportRecovery({ id });
      if (!snapshot || ("kind" in snapshot && typeof snapshot.kind === "string"))
        throw new Error("Recovery record is unavailable.");
      const files = this.owner().fence(this.app.vault.adapter);
      const directory = `.git-vault-sync-export-${crypto.randomUUID()}`;
      await files.mkdir(directory);
      for (const [path, value] of Object.entries(snapshot)) {
        const segments = path.split("/");
        segments.pop();
        let parent = directory;
        for (const segment of segments) {
          parent += `/${segment}`;
          if (!(await files.exists(parent))) await files.mkdir(parent);
        }
        await files.writeBinary(`${directory}/${path}`, decodeBase64(value.data).buffer);
      }
      return directory;
    });
  }

}
