import { inspectGitTakeover, takeOverGit } from "./git-takeover";
import { detectGitRepository, tokenCreationUrl, type DetectedRepository } from "./git-setup";
import { readLocalCandidate } from "./git-sync/local-candidate";
import {
  App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  debounce,
  requestUrl,
} from "obsidian";
import { GitHubRepository } from "./git-sync/github";
import {
  SyncSession,
  type SessionStatus,
  type SyncOutcome,
  type EnrollmentPreview,
  type ChoiceInput,
  type PublicationRecoveryPreview,
} from "./git-sync/session";
import { parseState } from "./git-sync/state";
import type { Entry, FileMode, RepositoryIdentity } from "./git-sync/contracts";
import type { Conflict, VersionConflict, NativeConflict, BulkDeletionConflict } from "./git-sync/reconcile";
import { decodeBase64, encodeBase64, entryText } from "./git-sync/codec";
import { GitObsidianVault } from "./git-sync/obsidian-vault";
import { FileJournalStore } from "./git-sync/store";
import { ForegroundScheduler } from "./git-sync/scheduler";
import { PluginOwnership, hostLifetimeId } from "./git-sync/ownership";
import { NativeTransactionJournal, NativePolicyMismatchError } from "./git-sync/native-transactions";
import { NativePathPolicy } from "./git-sync/native-path-policy";
import { NativeModeStore, parseModes } from "./git-sync/native-modes";
import { defaultSettings, parseSettings, type Settings } from "./settings";
import { formatCommitMessage } from "./commit-message";
import { diffRows } from "./conflict-view";
import { diff, splitLines } from "./git-sync/reconcile";

const installationKey = "github-vault-sync-installation-v2";
const activityKey = "github-vault-sync-activity";
function failure(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Sync failed. Your local files have been retained.";
}
function entryPreview(value: Entry | null): string {
  if (!value) return "File absent";
  const decoded = entryText(value);
  return decoded === null
    ? `Binary file · ${decodeBase64(value.data).length.toLocaleString()} bytes · ${value.oid.slice(0, 10)}`
    : decoded.slice(0, 16000) +
        (decoded.length > 16000
          ? "\n[Preview truncated; full bytes retained]"
          : "");
}
function configurationEntryPreview(container: HTMLElement, value: Entry | null): void {
  const preview = container.createEl("pre", { text: entryPreview(value), cls: "git-sync-preview" });
  const decoded = value ? entryText(value) : null;
  if (decoded !== null && decoded.length > 16000) {
    new Setting(container).setDesc("The initial preview is shortened. Expand it to inspect every character before approving.")
      .addButton(button => button.setButtonText("Show full text").onClick(() => {
        preview.setText(decoded);
        button.setDisabled(true).setButtonText("Full text shown");
      }));
  }
}
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
    configDirName = this.app.vault.configDir;
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
    const setting: unknown = Reflect.get(this.app, "setting");
    const open: unknown = setting && Reflect.get(setting, "open");
    const tab: unknown = setting && Reflect.get(setting, "openTabById");
    if (typeof open === "function" && typeof tab === "function") { open.call(setting); tab.call(setting, this.manifest.id); }
    else new Notice("Open Settings → GitHub Vault Sync.");
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
    let installation: unknown = this.app.loadLocalStorage(installationKey);
    if (installation === null || installation === undefined) {
      installation = crypto.randomUUID();
      this.app.saveLocalStorage(installationKey, installation);
    }
    if (
      typeof installation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(installation)
    )
      throw new Error(
        "This device's sync identity is damaged. Reinstall the plugin's data or contact support before syncing again.",
      );
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
    const saved: unknown = this.app.loadLocalStorage(installationKey);
    const installation = typeof saved === "string" ? saved : crypto.randomUUID();
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
      const installation: unknown = this.app.loadLocalStorage(installationKey);
      if (typeof installation !== "string") throw new Error("Missing device identity.");
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
    const installation: unknown = this.app.loadLocalStorage(installationKey);
    if (installation === null || installation === undefined) return null;
    if (typeof installation !== "string") throw new Error("Invalid device identity.");
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
        const installation: unknown = this.app.loadLocalStorage(installationKey);
        const nativeState = typeof installation === "string"
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
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}
function describeOutcome(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case "unenrolled":
      return "Not syncing yet · finish setup in settings";
    case "corrupt":
      return `Needs repair: ${outcome.detail}`;
    case "paused":
      return `Paused: ${outcome.pause.detail}`;
    case "up-to-date":
    case "synced": {
      const pending: string[] = [];
      if (outcome.attention?.unreadable.length) pending.push(`${plural(outcome.attention.unreadable.length, "file")} too large`);
      if (outcome.attention?.held.length) pending.push(`${plural(outcome.attention.held.length, "file")} to review`);
      if (outcome.attention?.deferred) pending.push(`${plural(outcome.attention.deferred, "settings update")} to review`);
      if (outcome.kind === "synced" && outcome.carried.length) pending.push(`${plural(outcome.carried.length, "newer edit")} queued`);
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return pending.length ? `Synced at ${time} · ${pending.join(" · ")}` : `Synced at ${time}`;
    }
    case "needs-decision":
      return `${plural(outcome.conflicts.length, "file needs", "files need")} your choice`;
    case "blocked":
      return `${plural(outcome.steps.length, "update")} waiting · open Sync status`;
    case "publication-unknown":
      return "Couldn't confirm the last upload · open Sync status";
    case "settling":
      return "Waiting for GitHub to confirm the upload…";
    case "contended":
      return "Another device is syncing · retrying soon";
    case "native-error":
      return "A file needs attention · open Sync status";
  }
}
/** What a sync left for the person to do, or null when nothing needs them. */
function outcomeAttention(outcome: SyncOutcome): { key: string; text: string; fix?: "status" | "settings" } | null {
  switch (outcome.kind) {
    case "needs-decision":
      return { key: `decide:${outcome.conflicts.map(conflict => conflict.id).join()}`,
        text: `${plural(outcome.conflicts.length, "file was", "files were")} changed both here and on GitHub. Choose which version to keep.` };
    case "blocked":
      return { key: `blocked:${outcome.steps.map(step => step.path).join()}`, text: `${plural(outcome.steps.length, "update")} from GitHub couldn't be saved here.` };
    case "publication-unknown":
      return { key: "publication", text: "GitHub didn't confirm the last upload, so uploads are on hold." };
    case "native-error":
      return { key: "native", text: "A file couldn't be saved, so sync stopped." };
    case "corrupt":
      return { key: `corrupt:${outcome.detail}`, text: `Sync needs repair: ${outcome.detail}`, fix: "settings" };
    case "paused":
      return { key: `paused:${outcome.pause.detail}`, text: `Sync is paused: ${outcome.pause.detail}`, fix: "settings" };
    case "synced":
    case "up-to-date": {
      const stuck = (outcome.attention?.unreadable.length ?? 0) + (outcome.attention?.held.length ?? 0);
      return stuck ? { key: `stuck:${stuck}`, text: `${plural(stuck, "file isn't", "files aren't")} syncing.` } : null;
    }
    default:
      return null;
  }
}
/** A dropped connection or a GitHub outage: worth retrying, not worth interrupting for. */
function offline(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "retryAt") === "number") return true;
  const status = httpStatus(error);
  if (typeof status === "number") return status === 0 || status === 429 || status >= 500;
  return /transport failed|net::|network|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|UnknownHost|Unable to resolve|Failed to fetch|offline/i.test(failure(error));
}
interface AccessTarget { owner: string; repository: string; branch: string; token?: string }
/** Per-vault, per-device record of the last working GitHub access, for the settings page. */
interface Activity { checkedAt?: number; syncedAt?: number; problem?: string }
function httpStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
}
/** Failures that mean the token or its repository access is wrong, not a network hiccup. */
function rejectedAccess(error: unknown): boolean {
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "retryAt") === "number") return false;
  const status = httpStatus(error);
  return status === 401 || status === 403 || status === 404 || /credential unavailable/.test(failure(error));
}
function accessProblem(error: unknown, target: Pick<AccessTarget, "owner" | "repository" | "branch">): string {
  const message = failure(error), status = httpStatus(error);
  const name = `${target.owner}/${target.repository}`;
  if (/No token is saved/.test(message)) return message;
  if (/Invalid repository coordinates/.test(message)) return "Enter the repository as owner/name.";
  if (/Invalid branch name/.test(message)) return `"${target.branch}" isn't a valid branch name.`;
  if (/branch missing|empty\/unborn/.test(message)) return `Branch "${target.branch}" wasn't found on GitHub, or the repository is empty.`;
  if (/rate limit/.test(message)) return "GitHub is limiting requests. Sync will retry automatically.";
  if (status === 401 || /credential unavailable/.test(message)) return "GitHub rejected this token. It may be mistyped, expired or revoked.";
  if (status === 403) return `GitHub denied access to ${name}. Check that the token has Contents read and write permission.`;
  if (status === 404) return `This token can't see ${name}. Check the name and the token's repository access.`;
  if (/private GitHub repository/.test(message)) return `${name} is public. Sync only works with a private repository.`;
  if (/identity mismatch/.test(message)) return `GitHub returned a different repository for ${name}. Check the name.`;
  if (/transport failed/.test(message)) return "Couldn't reach GitHub. Check your connection.";
  return message;
}
function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `on ${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
function parseRepository(value: string): { owner: string; repository: string } | null {
  const match = /^(?:(?:https?:\/\/)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value.trim());
  return match ? { owner: match[1]!, repository: match[2]! } : null;
}
function deviceSuggestion(): string {
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows";
  return "Linux";
}
type CommitDraft = Pick<Settings, "deviceName" | "commitMessageTemplate" | "commitDateFormat">;
/** Device name, message and date format with a live preview. `changed` runs only on user edits with a valid format. */
function renderCommitSettings(el: HTMLElement, draft: CommitDraft, changed: () => void): void {
  const preview = new Setting(el).setName("Preview");
  preview.descEl.addClass("git-sync-code");
  const update = (): boolean => {
    const valid = Boolean(draft.commitMessageTemplate.trim() && draft.commitDateFormat.trim());
    preview.setDesc(valid
      ? formatCommitMessage(draft.commitMessageTemplate, draft.commitDateFormat, { device: draft.deviceName || deviceSuggestion(), count: 3, date: new Date() })
      : "Message and date format can't be empty.");
    return valid;
  };
  const edited = () => { if (update()) changed(); };
  new Setting(el).setName("Device name")
    .addText(text => text.setValue(draft.deviceName).setPlaceholder(deviceSuggestion())
      .onChange(value => { draft.deviceName = value.trim() || deviceSuggestion(); edited(); }));
  new Setting(el).setClass("git-sync-format-field").setName("Message")
    .setDesc("{{device}}, {{count}} (files changed) and {{date}} are filled in.")
    .addText(text => text.setValue(draft.commitMessageTemplate)
      .onChange(value => { draft.commitMessageTemplate = value; edited(); }));
  new Setting(el).setClass("git-sync-format-field").setName("Date format")
    .setDesc("YYYY MM MMM D DD Do HH mm ss. Wrap other text in [brackets].")
    .addText(text => text.setValue(draft.commitDateFormat)
      .onChange(value => { draft.commitDateFormat = value; edited(); }));
  el.appendChild(preview.settingEl);
  update();
}
function tokenDescription(url: () => string): DocumentFragment {
  return createFragment(fragment => {
    const link = fragment.createEl("a", { text: "Create token", href: url() });
    link.addEventListener("click", () => { link.href = url(); });
    fragment.appendText(" — permissions are filled in. Select only this repository on GitHub.");
  });
}
/** Masked token field. Blank keeps the saved token; the saved value is never read back into the page. */
function tokenInput(setting: Setting, saved: boolean, handlers: { edited(): void; committed(value: string): void }, url: () => string) {
  let input: HTMLInputElement | null = null;
  setting.addText(text => {
    input = text.inputEl;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    text.setPlaceholder(saved ? "Token saved" : "github_pat_…");
  });
  setting.addButton(button => button.setButtonText("Copy link").onClick(async () => {
    try {
      await navigator.clipboard.writeText(url());
      new Notice("Link copied. Open it in your browser.");
    } catch {
      new Notice("Couldn't copy. Long-press Create token to copy the link.");
    }
  }));
  const field = input as HTMLInputElement | null;
  if (!field) throw new Error("Token field failed to render.");
  // Checks run on leave or Enter, and after a pause in typing or pasting.
  const commit = () => { pause.cancel(); const value = field.value.trim(); if (value) handlers.committed(value); };
  const pause = debounce(commit, 800, true);
  field.addEventListener("input", () => { handlers.edited(); pause(); });
  field.addEventListener("change", commit);
  return {
    value: () => field.value.trim(),
    saved: () => { field.value = ""; field.placeholder = "Token saved"; },
  };
}
/** One status line under a setting. A result for superseded input is dropped. */
function accessLine(setting: Setting) {
  const line = setting.descEl.createDiv({ cls: "git-sync-line" });
  let current = 0;
  const show = (text: string, tone?: "ok" | "error") => {
    line.setText(text);
    line.toggleClass("mod-success", tone === "ok");
    line.toggleClass("mod-warning", tone === "error");
  };
  return {
    clear: () => { current++; show(""); },
    /** Resolves true only if the check passed and nothing changed meanwhile. */
    run: async (check: () => Promise<unknown>, verified = "Repository access verified"): Promise<boolean> => {
      const id = ++current;
      show("Checking access…");
      try {
        await check();
        if (id === current) show(`✓ ${verified}`, "ok");
        return id === current;
      } catch (error) {
        if (id === current) show(failure(error), "error");
        return false;
      }
    },
  };
}
/** Last sync and last verified access, or the reason access failed. */
function describeActivity(activity: Activity): { text: string; problem: boolean } {
  if (activity.problem) return { text: `Access problem: ${activity.problem}`, problem: true };
  const parts: string[] = [];
  if (activity.syncedAt) parts.push(`Last synced ${ago(activity.syncedAt)}`);
  if (activity.checkedAt) parts.push(`${parts.length ? "access" : "Access"} verified ${ago(activity.checkedAt)}`);
  return { text: parts.join(" · "), problem: false };
}
type SettingsView = "setup" | "paused" | "syncing";
function settingsView(status: Awaited<ReturnType<SyncSession["status"]>> | { kind: "corrupt" } | undefined): SettingsView {
  if (status?.kind !== "enrolled") return "setup";
  return status.pause ? "paused" : "syncing";
}
class GitSettings extends PluginSettingTab {
  private generation = 0;
  private shown = false;
  private unsubscribe: (() => void) | null = null;
  private watching: (() => void) | null = null;
  constructor(
    app: App,
    private plugin: GitVaultSync,
  ) {
    super(app, plugin);
  }
  display(): void {
    this.shown = true;
    void this.render();
  }
  /** Redraw from callbacks that may finish after the settings window has closed. */
  private refresh(): void {
    if (this.shown) this.display();
  }
  hide(): void {
    this.shown = false;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.watching?.();
    this.watching = null;
  }
  /**
   * Re-renders when sync starts, pauses or resumes, whichever modal or command
   * caused it, so the page never shows setup behind a running sync. Typing in
   * the setup form is kept because a status change within one view is ignored.
   */
  private watch(view: SettingsView, generation: number): void {
    this.watching?.();
    const check = debounce(async () => {
      if (generation !== this.generation) return;
      const status = await this.plugin.session?.status().catch(() => undefined);
      if (generation === this.generation && settingsView(status) !== view) this.display();
    }, 500, true);
    const unsubscribe = this.plugin.subscribe(() => { check(); });
    this.watching = () => { unsubscribe(); check.cancel(); };
  }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const session = this.plugin.session;
    const status = await session?.status().catch((error: unknown) => ({ kind: "corrupt" as const, detail: failure(error) }));
    if (generation !== this.generation) return;
    this.watch(settingsView(status), generation);
    const el = this.containerEl;
    el.empty();
    el.addClass("git-sync-panel");
    if (status?.kind === "enrolled" && !status.pause) {
      await this.renderSyncing(el, status.repository, generation);
      return;
    }
    if (status?.kind === "enrolled" && status.pause) {
      new Setting(el).setName("Sync is paused").setDesc(status.pause.detail)
        .addButton(button => button.setButtonText("Review changes").setCta().onClick(() => this.review(button)));
      return;
    }
    if (status?.kind === "corrupt") this.renderProblem(el, status.detail);
    else if (!session && this.plugin.settings.owner && this.plugin.settings.secretId) this.renderProblem(el, this.plugin.statusText);
    await this.renderSetup(el, generation);
  }
  private renderProblem(el: HTMLElement, detail: string): void {
    new Setting(el).setName("Can't connect").setDesc(detail)
      .addButton(button => button.setButtonText("Try again").onClick(async () => {
        button.setDisabled(true);
        try { await this.plugin.initialize(); this.refresh(); }
        catch (error) { this.plugin.fail(error); new Notice(failure(error), 12000); button.setDisabled(false); }
      }));
  }
  private async renderSetup(el: HTMLElement, generation: number): Promise<void> {
    const draft = { ...this.plugin.settings };
    new Setting(el).setName("Connect to GitHub").setHeading()
      .setDesc("Your notes are saved as commits in a private GitHub repository you own.");
    // Detection only fills blanks; anything already saved or typed wins.
    let detected = false;
    if (!draft.owner || !draft.repository) {
      const found = await this.plugin.detectRepository().catch(() => null);
      if (generation !== this.generation) return;
      if (found) {
        draft.owner = found.owner; draft.repository = found.repository; draft.branch = found.branch;
        detected = true;
      }
    }
    let repository = draft.owner && draft.repository ? `${draft.owner}/${draft.repository}` : "";
    const target = (): AccessTarget | null => {
      const parsed = parseRepository(repository);
      return parsed && { ...parsed, branch: draft.branch || "main", token: token.value() || undefined };
    };
    const check = (): Promise<boolean> => {
      const next = target();
      if (generation !== this.generation) return Promise.resolve(false);
      if (!next || (!next.token && !this.plugin.hasToken())) { access.clear(); return Promise.resolve(false); }
      return access.run(() => this.plugin.checkAccess(next));
    };
    const recheck = debounce(() => { void check(); }, 800, true);
    const edited = () => { access.clear(); recheck(); };
    new Setting(el).setName("Repository")
      .setDesc(detected ? "Found in this vault's Git folder. Edit if it's wrong." : "Owner and name, or paste the repository link.")
      .addText(text => text.setValue(repository).setPlaceholder("username/notes")
        .onChange(value => { repository = value; edited(); }));
    new Setting(el).setName("Branch")
      .addText(text => text.setValue(draft.branch).setPlaceholder("main")
        .onChange(value => { draft.branch = value.trim(); edited(); }));
    const creationUrl = () => tokenCreationUrl(parseRepository(repository)?.owner ?? "");
    const tokenSetting = new Setting(el).setName("Access token").setDesc(tokenDescription(creationUrl));
    const access = accessLine(tokenSetting);
    const token = tokenInput(tokenSetting, this.plugin.hasToken(), {
      edited: () => { recheck.cancel(); access.clear(); },
      committed: () => { recheck.cancel(); void check(); },
    }, creationUrl);
    void check();
    new Setting(el).setName("Sync themes, hotkeys and plugins")
      .setDesc(this.plugin.session === null
        ? "Include Obsidian settings on this device. Notes and attachments always sync."
        : "Include Obsidian settings on this device. Notes and attachments always sync. Already chosen for this vault; change it after syncing starts.")
      .addToggle(toggle => toggle.setValue(draft.configuration ?? false)
        .setDisabled(this.plugin.session !== null)
        .onChange(value => { draft.configuration = value; }));
    const commits = el.createEl("details", { cls: "git-sync-advanced" });
    commits.createEl("summary", { text: "Commit messages" });
    renderCommitSettings(commits, draft, () => {});
    const connect = new Setting(el);
    connect.addButton(button => button.setButtonText("Connect").setCta().onClick(async () => {
      const parsed = parseRepository(repository);
      if (!draft.commitMessageTemplate.trim() || !draft.commitDateFormat.trim()) { new Notice("Commit message and date format can't be empty."); return; }
      if (!parsed) { new Notice("Enter the repository as owner/name, for example your-name/notes."); return; }
      if (!token.value() && !this.plugin.hasToken()) { new Notice("Paste a GitHub access token first."); return; }
      button.setDisabled(true);
      recheck.cancel();
      // Nothing is saved until the token can read this repository and branch.
      if (!(await check())) { button.setDisabled(false); return; }
      if (generation !== this.generation) return;
      // The first check reads every file on GitHub, so show its progress while Connect runs.
      this.unsubscribe?.();
      const unsubscribe = this.plugin.subscribe(() => {
        if (generation === this.generation) connect.setDesc(this.plugin.statusText);
      });
      this.unsubscribe = unsubscribe;
      connect.setDesc("Connecting…");
      try {
        const secretId = token.value() ? this.plugin.saveToken(token.value()) : draft.secretId;
        await this.plugin.saveConfiguration({ ...draft, ...parsed, secretId, branch: draft.branch || "main" });
        this.plugin.noteAccess(null);
        if (generation !== this.generation) return;
        if (!this.plugin.session) { this.refresh(); throw new Error(this.plugin.statusText); }
        await this.review(button);
      } catch (error) {
        new Notice(failure(error), 12000);
      } finally {
        unsubscribe();
        if (this.unsubscribe === unsubscribe) this.unsubscribe = null;
        if (generation === this.generation) { connect.setDesc(""); button.setDisabled(false); }
      }
    }));
  }
  /** Opens the first-sync review; nothing changes until the user confirms there. */
  private async review(button: { setDisabled(disabled: boolean): unknown }): Promise<void> {
    button.setDisabled(true);
    try {
      const keepsGit = await this.plugin.checkSetup();
      const session = this.plugin.session;
      if (!session) throw new Error(this.plugin.statusText);
      const preview = await session.previewEnrollment();
      if (preview.kind === "corrupt") throw new Error(preview.detail);
      if (preview.kind === "preview") new EnrollmentModal(this.app, this.plugin, preview, keepsGit, () => this.refresh()).open();
      else this.refresh();
    } catch (error) {
      new Notice(failure(error), 12000);
    } finally {
      button.setDisabled(false);
    }
  }
  private async renderSyncing(el: HTMLElement, repository: RepositoryIdentity, generation: number): Promise<void> {
    const plugin = this.plugin;
    const draft = { ...plugin.settings };
    const save = debounce(() => {
      plugin.saveConfiguration({ ...plugin.settings, automatic: draft.automatic, deviceName: draft.deviceName,
        commitMessageTemplate: draft.commitMessageTemplate, commitDateFormat: draft.commitDateFormat })
        .catch(error => new Notice(failure(error), 12000));
    }, 600, true);

    // The page answers one question first: is sync working, and does anything need me?
    // Automatic sync does the routine work, so "Sync now" stays quiet; only things that need you get color.
    const summary = new Setting(el).setName(`${repository.owner}/${repository.name}`)
      .addButton(button => button.setButtonText("Sync now")
        .onClick(async () => {
          button.setDisabled(true);
          await plugin.syncNow();
          button.setDisabled(false);
        }));
    summary.settingEl.addClass("git-sync-summary");
    const decisions = el.createDiv();
    let shown: string | null = null;
    const refreshDecisions = async () => {
      const state = await plugin.session?.status().catch(() => null);
      if (generation !== this.generation) return;
      const conflicts = state?.kind === "enrolled" ? state.conflicts : [];
      const key = conflicts.map(conflict => conflict.id).join();
      if (key === shown) return;
      shown = key;
      renderDecisions(decisions, this.app, plugin, conflicts, () => { shown = null; void refreshDecisions(); });
    };
    const refresh = () => {
      const access = describeActivity(plugin.activity);
      const problem = access.problem || plugin.statusProblem;
      summary.setDesc(access.problem ? access.text : plugin.statusText);
      summary.descEl.toggleClass("mod-warning", problem);
      // Progress updates arrive per file during a sync; decisions only change once it ends.
      if (!plugin.syncing) void refreshDecisions();
    };
    refresh();
    const unsubscribe = plugin.subscribe(refresh);
    const timer = window.setInterval(refresh, 30_000);
    this.unsubscribe = () => { unsubscribe(); window.clearInterval(timer); };
    // Opening settings re-checks a token that hasn't been proven in the last few minutes.
    const { checkedAt } = plugin.activity;
    if (!checkedAt || Date.now() - checkedAt > 5 * 60_000) void plugin.verifyAccess();

    new Setting(el).setName("Sync automatically")
      .setDesc("Syncs once you pause typing for 30 seconds and when you leave Obsidian. Checks GitHub for changes every 5 minutes.")
      .addToggle(toggle => toggle.setValue(draft.automatic).onChange(value => { draft.automatic = value; save(); }));
    const configuration = new Setting(el).setName("Obsidian settings").setDesc("Checking…");
    void this.describeConfiguration(configuration, generation);

    const advanced = el.createEl("details", { cls: "git-sync-advanced" });
    advanced.open = Boolean(plugin.activity.problem);
    advanced.createEl("summary", { text: "Advanced" });
    // A replacement is saved only after it can read this repository; until then the working token stays.
    const creationUrl = () => tokenCreationUrl(repository.owner);
    const tokenSetting = new Setting(advanced).setName("Access token").setDesc(tokenDescription(creationUrl));
    const access = accessLine(tokenSetting);
    const token = tokenInput(tokenSetting, plugin.hasToken(), {
      edited: () => access.clear(),
      committed: value => {
        void access.run(async () => {
          if (!(await plugin.replaceToken(value, () => generation === this.generation && token.value() === value))) throw new Error("Superseded");
          token.saved();
        }, "Repository access verified · token saved");
      },
    }, creationUrl);
    new Setting(advanced).setName("History")
      .setDesc("Every sync from every device, or earlier versions of one note.")
      .addButton(button => button.setButtonText("All syncs").onClick(() => new SyncHistoryModal(this.app, plugin).open()))
      .addButton(button => button.setButtonText("One note").onClick(() => new RestoreModal(this.app, plugin).open()));
    new Setting(advanced).setName("Commit messages").setHeading();
    renderCommitSettings(advanced, draft, save);
    new Setting(advanced).setName("Repository")
      .setDesc(`${repository.owner}/${repository.name} · ${repository.branch}. To sync a different repository, use another vault.`);
  }
  private async describeConfiguration(setting: Setting, generation: number): Promise<void> {
    const listing = await this.plugin.session?.listConfiguration().catch(() => null);
    if (generation !== this.generation || listing?.kind !== "configuration") { setting.settingEl.remove(); return; }
    if (listing.rules === "config/1") {
      const waiting = listing.deferred.length + listing.guarded.length + listing.unpublished.length;
      setting.setDesc(waiting ? `${plural(waiting, "change")} waiting for your review.` : "Themes, hotkeys and plugins sync along with your notes.")
        .addButton(button => {
          button.setButtonText(waiting ? "Review" : "View").onClick(() => new ConfigurationModal(this.app, this.plugin).open());
          if (waiting) button.setCta();
        });
      return;
    }
    setting.setDesc("Only notes and attachments sync. Turn on to include themes, hotkeys and plugins.")
      .addButton(button => button.setButtonText("Turn on").onClick(async () => {
        button.setDisabled(true);
        try {
          const upgrade = await this.plugin.previewConfigurationUpgrade();
          new ConfirmModal(this.app, "Sync Obsidian settings too?",
            "Sync pauses while you review what would change. Your notes stay as they are.",
            async () => {
              const preview = await upgrade.confirm();
              if (preview?.kind !== "preview") throw new Error("Open the settings page to review changes.");
              new EnrollmentModal(this.app, this.plugin, preview, false, () => this.refresh()).open();
            }).open();
        } catch (error) { new Notice(failure(error), 12000); }
        finally { button.setDisabled(false); }
      }));
  }
}
class ConfigurationModal extends Modal {
  private generation = 0;
  private closed = false;
  constructor(app: App, private plugin: GitVaultSync) { super(app); }
  onOpen(): void { void this.render(); }
  onClose(): void { this.closed = true; this.generation++; }
  private async render(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    const session = this.plugin.session;
    const current = () => generation === this.generation && session === this.plugin.session;
    const el = this.contentEl;
    el.empty(); el.addClass("git-sync-panel");
    this.setTitle("Obsidian settings");
    if (!session) { el.createEl("p", { text: "Connect to GitHub in GitHub Vault Sync settings first." }); return; }
    const loading = el.createEl("p", { text: "Checking settings on this device…", cls: "git-sync-muted" });
    try {
      const listing = await session.listConfiguration();
      if (!current()) return;
      if (listing.kind !== "configuration" || !listing.deferred.length) loading.remove();
      if (listing.kind !== "configuration") throw new Error(listing.kind === "unenrolled" ? "Connect to GitHub first." : "Settings can't be checked right now. Try again after the next sync.");
      if (listing.rules !== "config/1") {
        el.createEl("p", { text: "Settings sync is off. Turn it on in GitHub Vault Sync settings." }); return;
      }
      const incoming = el.createDiv();
      if (!listing.deferred.length && !listing.guarded.length && !listing.unpublished.length)
        el.createEl("p", { text: "Themes, hotkeys and plugins match your other devices. Nothing to review." });
      if (listing.guarded.length) {
        new Setting(el).setName(`Changed here after an update · ${listing.guarded.length}`).setHeading();
        el.createEl("p", { text: "Obsidian or a plugin changed these after you applied an update. They stay on this device until you check them. Notes keep syncing." });
        for (const item of listing.guarded) {
          new Setting(el).setName(item.path)
            .setDesc(item.unreadable ? "Too large to read. Left as is." : "Changed here after an update. Not uploaded yet.")
            .addButton(button => button.setButtonText("Review").setDisabled(item.unreadable).onClick(async () => {
              button.setDisabled(true);
              try {
                const preview = await session.previewGuardedConfigurationPublication(item.path);
                if (!current()) return;
                if (preview.kind !== "preview") throw new Error("This file changed. Close and try again.");
                const modal = new Modal(this.app);
                modal.contentEl.addClass("git-sync-panel");
                modal.contentEl.createEl("h2", { text: preview.path });
                modal.contentEl.createEl("p", { text: preview.entry === null
                  ? "Deleted here after an update. Approving removes it from GitHub too."
                  : "This version would replace the one on GitHub." });
                configurationEntryPreview(modal.contentEl, preview.entry);
                new Setting(modal.contentEl).addButton(approve => approve
                  .setButtonText(preview.entry === null ? "Remove from GitHub" : "Upload this version")
                  .setCta().onClick(async () => {
                    approve.setDisabled(true);
                    try {
                      if (!current()) throw new Error("Something changed. Close and try again.");
                      const result = await session.consentGuardedConfigurationPublication({ path: preview.path, token: preview.token });
                      if (result.kind !== "recorded") throw new Error("This file changed. Close and try again.");
                      modal.close(); await this.plugin.syncNow(); await this.render();
                    } catch (error) { new Notice(failure(error), 12000); approve.setDisabled(false); }
                  }));
                modal.open();
              } catch (error) { new Notice(failure(error), 12000); }
              finally { button.setDisabled(false); }
            }));
        }
      }
      const unpublished = el.createDiv();
      if (listing.unpublished.length) {
        new Setting(unpublished).setName(`New on this device · ${listing.unpublished.length}`).setHeading()
          .setDesc("These upload only after you approve each one. Check them for passwords or API keys first.");
      }
      for (const item of listing.unpublished) {
        new Setting(unpublished).setName(item.path).addButton(button => button.setButtonText("Review").onClick(async () => {
          button.setDisabled(true);
          try {
            const preview = await session.previewHiddenPublication(item.path);
            if (!current()) return;
            if (preview.kind !== "preview") throw new Error("This file changed. Close and try again.");
            const modal = new Modal(this.app);
            modal.contentEl.addClass("git-sync-panel");
            modal.contentEl.createEl("h2", { text: preview.path });
            configurationEntryPreview(modal.contentEl, preview.entry);
            new Setting(modal.contentEl).addButton(approve => approve.setButtonText("Upload this version").setCta().onClick(async () => {
              approve.setDisabled(true);
              try {
                if (!current()) throw new Error("Something changed. Close and try again.");
                const result = await session.consentHiddenPublication({ path: preview.path, token: preview.token });
                if (result.kind !== "recorded") throw new Error("This file changed. Close and try again.");
                modal.close(); await this.plugin.syncNow(); await this.render();
              } catch (error) { new Notice(failure(error), 12000); approve.setDisabled(false); }
            }));
            modal.open();
          } catch (error) { new Notice(failure(error), 12000); }
          finally { button.setDisabled(false); }
        }));
      }
      if (!listing.deferred.length) return;
      const preview = await session.previewApplyConfiguration();
      if (!current()) return;
      loading.remove();
      if (preview.kind !== "preview") throw new Error("These updates can't be applied right now. Close this and try again after the next sync.");
      new Setting(incoming).setName(`From your other devices · ${preview.items.length}`).setHeading()
        .setDesc("Applying writes them into this device's Obsidian settings.");
      // One row per plugin or theme, with each file's before and after one tap away.
      const groups = new Map<string, typeof preview.items>();
      for (const item of preview.items) {
        const { place } = describePath(item.path);
        groups.set(place, [...(groups.get(place) ?? []), item]);
      }
      for (const [place, items] of groups) {
        const details = incoming.createEl("details", { cls: "git-sync-group" });
        const summary = details.createEl("summary");
        summary.createSpan({ text: place });
        summary.createSpan({ text: items.map(item => describePath(item.path).name).join(", "), cls: "git-sync-muted" });
        for (const item of items) {
          details.createEl("h4", { text: describePath(item.path).name });
          if (item.blockedReason) details.createEl("p", { text: item.blockedReason, cls: "mod-warning" });
          collapsible(details, "On this device now", item.expectedEntry);
          collapsible(details, "Incoming", item.incomingEntry);
        }
      }
      for (const blocked of preview.blocked)
        incoming.createEl("p", { text: `${describePath(blocked.path).name}: ${blocked.reason}`, cls: "mod-warning" });
      // Only plugins actually running here can overwrite an update before the restart.
      // Loaded instances, not the enabled list: a desktop-only plugin is listed on a phone but never runs there.
      const loaded: unknown = Reflect.get(Reflect.get(this.app, "plugins") ?? {}, "plugins");
      const pluginsDir = `${configDirName}/plugins/`;
      const running = [...new Set(preview.items.map(item => item.path.startsWith(pluginsDir) ? item.path.slice(pluginsDir.length).split("/")[0] : undefined).filter((id): id is string =>
        id !== undefined && id !== this.plugin.manifest.id && typeof loaded === "object" && loaded !== null && id in loaded))];
      if (running.length)
        incoming.createEl("p", { text: `Turn off ${running.join(", ")} in Community plugins first, so ${running.length === 1 ? "it doesn't" : "they don't"} overwrite the update.`, cls: "mod-warning" });
      const apply = new Setting(incoming).addButton(button => button.setButtonText(`Apply ${plural(preview.items.length, "update")}`).setCta().setDisabled(preview.blocked.length > 0).onClick(async () => {
        button.setDisabled(true);
        try {
          if (!current()) throw new Error("Something changed. Close this and try again.");
          await this.plugin.assertSingleWriter();
          const result = await session.applyConfiguration({ token: preview.token });
          if (result.kind === "review-needed") {
            new Notice(`${plural(result.applied.length, "update")} applied. ${plural(result.changed.length, "file")} changed while applying; check Sync status.`, 15000);
            this.close();
            return;
          }
          if (result.kind !== "applied") throw new Error("Something changed. Close this and try again.");
          apply.settingEl.remove();
          new Setting(incoming).setName(`${plural(result.paths.length, "update")} applied`)
            .setDesc("Obsidian picks them up after a reload.")
            .addButton(reload => reload.setButtonText("Reload Obsidian").setCta().onClick(() => {
              const commands: unknown = Reflect.get(this.app, "commands");
              const run: unknown = commands && Reflect.get(commands, "executeCommandById");
              if (typeof run === "function") run.call(commands, "app:reload");
            }));
        } catch (error) { new Notice(failure(error), 12000); button.setDisabled(false); }
      }));
      apply.settingEl.addClass("git-sync-footer");
    } catch (error) { if (current()) el.createEl("p", { text: failure(error) }); }
  }
}
const reviewGroups: ReadonlyArray<readonly [EnrollmentPreview["items"][number]["action"], string, string]> = [
  ["conflict", "Changed in both places", "You'll choose which version to keep."],
  ["review-local-deletion", "Deleted on this device", "You'll confirm before they're removed from GitHub."],
  ["review-remote-deletion", "Deleted on GitHub", "You'll confirm before they're removed here."],
  ["upload", "Only on this device", "Will be added to GitHub."],
  ["download", "Only on GitHub", "Will be added to this device."],
  ["update-local", "Newer on GitHub", "Will be updated on this device."],
  ["unreadable", "Too large to sync", "Left as they are."],
  ["native-pending", "Interrupted saves", "You'll choose which version to keep."],
];
/** Shows what the first sync would do. Starting is the only step that changes anything. */
class EnrollmentModal extends Modal {
  constructor(
    app: App,
    private plugin: GitVaultSync,
    private preview: EnrollmentPreview,
    private keepsGit: boolean,
    private done?: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    const el = this.contentEl;
    const { repository } = this.preview;
    el.addClass("git-sync-panel");
    this.setTitle(this.preview.reenrollment ? "Resume syncing" : "Start syncing");
    el.createEl("p", { text: `${repository.owner}/${repository.name} · ${repository.branch}`, cls: "git-sync-muted" });
    el.createEl("p", {
      text: this.preview.items.length
        ? `${plural(this.preview.unchanged, "file")} already match. Files changed in both places, and deletions found now, wait for your choice.`
        : `Everything already matches GitHub (${plural(this.preview.unchanged, "file")}).`,
    });
    if (this.keepsGit)
      el.createEl("p", { text: "Your notes stay here. Your previous Git setup will be kept locally for switching back. It won't receive new syncs." });
    for (const [action, name, description] of reviewGroups) {
      const paths = this.preview.items.filter(item => item.action === action).map(item => item.path);
      if (!paths.length) continue;
      const group = el.createEl("details", { cls: "git-sync-group" });
      const summary = group.createEl("summary");
      summary.createSpan({ text: `${name} · ${paths.length}` });
      summary.createSpan({ text: description, cls: "git-sync-muted" });
      const list = group.createDiv({ cls: "git-sync-list" });
      for (const path of paths) list.createEl("p", { text: path });
    }
    new Setting(el)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b
        .setButtonText(this.preview.reenrollment ? "Resume syncing" : "Start syncing")
        .setCta()
        .onClick(async () => {
          b.setDisabled(true);
          try {
            const outcome = await this.plugin.startSyncing(this.preview.token);
            if (outcome?.kind === "stale") {
              this.close();
              new Notice("Files changed while you were reviewing. Here is the updated list.");
              new EnrollmentModal(this.app, this.plugin, outcome.preview, this.keepsGit, this.done).open();
              return;
            }
            if (outcome?.kind !== "enrolled") throw new Error("Couldn't start syncing. Open the review again.");
            this.close();
            this.done?.();
            await this.plugin.syncNow();
            const status = await this.plugin.session?.status();
            if (status?.kind === "enrolled" && (status.conflicts.length || status.blocked.length || status.pause || status.nativeErrors.length))
              new ChangesModal(this.app, this.plugin).open();
            else new Notice(`Syncing with ${this.preview.repository.owner}/${this.preview.repository.name}.`);
          } catch (error) {
            new Notice(failure(error), 12000);
            b.setDisabled(false);
          }
        }));
  }
}
const conflictLabels: Record<string, string> = {
  "content": "Edited here and on GitHub",
  "add-add": "Different here and on GitHub",
  "local-deleted-remote-edited": "Deleted here, edited on GitHub",
  "local-edited-remote-deleted": "Edited here, deleted on GitHub",
  "local-deletion": "Deleted here",
  "remote-deletion": "Deleted on GitHub",
  "interrupted-write": "A save was interrupted",
  "displaced-write": "Changed while sync was saving it",
  "oversize-write": "Too large to compare",
};
/** The vault's settings folder; Obsidian lets people rename it. Set at load. */
let configDirName = ".obsidian";
const settingsFiles: Record<string, string> = {
  "community-plugins.json": "Enabled community plugins",
  "core-plugins.json": "Enabled core plugins",
  "appearance.json": "Appearance",
  "hotkeys.json": "Hotkeys",
  "app.json": "Editor and files",
  "bookmarks.json": "Bookmarks",
  "graph.json": "Graph view",
};
/** `.obsidian/plugins/vikalp/main.js` → main.js in "vikalp plugin"; notes keep their folder. */
function describePath(path: string): { name: string; place: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  if (parts[0] === configDirName) {
    if (parts.length === 1 && settingsFiles[name]) return { name: settingsFiles[name], place: "Obsidian settings" };
    if (parts[1] === "plugins" && parts[2]) return { name, place: `${parts[2]} plugin` };
    if (parts[1] === "themes" && parts[2]) return { name, place: `${parts[2]} theme` };
    if (parts[1] === "snippets") return { name, place: "CSS snippet" };
    return { name, place: "Obsidian settings" };
  }
  return { name, place: parts.length ? parts.join("/") : "Vault" };
}
/** Files waiting on a choice, one row each, plus one shared choice when there are several. */
function renderDecisions(container: HTMLElement, app: App, plugin: GitVaultSync, conflicts: readonly Conflict[], changed: () => void): void {
  container.empty();
  container.toggleClass("git-sync-decisions", conflicts.length > 0);
  for (const conflict of conflicts) {
    const row = new Setting(container);
    if (conflict.kind === "collision") {
      row.setName("Names differ only by capital letters")
        .setDesc(`Rename one of these to keep syncing: ${conflict.paths.join(", ")}`);
      continue;
    }
    if (conflict.kind === "bulk-deletion") {
      row.setName(`${plural(conflict.paths.length, "file")} deleted ${conflict.direction === "local" ? "here" : "on GitHub"}`)
        .setDesc(conflict.direction === "local" ? "Confirm before they're removed from GitHub too." : "Confirm before they're removed here too.")
        .addButton(button => button.setButtonText("Review").onClick(() => new BulkDeletionModal(app, plugin, conflict, changed).open()));
      continue;
    }
    const { name, place } = describePath(conflict.path);
    row.setName(name).setDesc(`${place} · ${conflictLabels[conflict.kind] ?? conflict.kind.replaceAll("-", " ")}`)
      .addButton(button => button.setButtonText("Resolve").onClick(() => new ConflictModal(app, plugin, conflict, changed).open()));
  }
  renderBulkChoice(container, app, plugin, conflicts, changed);
}
class SyncHistoryModal extends Modal {
  private closed = false;
  constructor(app: App, private plugin: GitVaultSync) { super(app); }
  onClose(): void { this.closed = true; }
  onOpen(): void {
    const el = this.contentEl;
    el.addClass("git-sync-panel");
    this.setTitle("Sync history");
    const { owner, repository, branch } = this.plugin.settings;
    el.createEl("p", { text: `Commits from all your devices · ${owner}/${repository} · ${branch}`, cls: "git-sync-muted" });
    const list = el.createDiv();
    list.createEl("p", { text: "Loading…", cls: "git-sync-muted" });
    new Setting(el).setName("Looking for one note?")
      .addButton(b => b.setButtonText("File history").onClick(() => { this.close(); new RestoreModal(this.app, this.plugin).open(); }));
    const load = async (at?: string, page = 1): Promise<boolean> => {
      try {
        const result = await this.plugin.fileHistory({ at, page });
        if (this.closed) return false;
        if (page === 1) list.empty();
        for (const version of result.entries) {
          new Setting(list)
            .setName(version.message.split("\n")[0] || "Sync")
            .setDesc(`${new Date(version.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${version.author}`)
            .addExtraButton(b => b.setIcon("external-link").setTooltip("Open on GitHub").onClick(() =>
              window.open(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commit/${version.commit}`)));
        }
        if (page === 1 && !result.entries.length) list.createEl("p", { text: "No commits yet." });
        if (result.nextPage !== null) {
          const nextPage = result.nextPage;
          const more = new Setting(list).addButton(b => b.setButtonText("Show older").onClick(async () => {
            b.setDisabled(true);
            // Keep the button after a failed load so it can be tried again.
            if (await load(result.at, nextPage)) more.settingEl.remove();
            else b.setDisabled(false);
          }));
        }
        return true;
      } catch (error) {
        if (this.closed) return false;
        if (page === 1) list.empty();
        new Notice(`Couldn't load sync history. ${failure(error)}`, 8000);
        if (page === 1) list.createEl("p", { text: failure(error), cls: "mod-warning" });
        return false;
      }
    };
    void load();
  }
}
class ChangesModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private summary: HTMLElement | null = null;
  private generation = 0;
  private closed = false;
  private redraw: ReturnType<typeof debounce> | null = null;
  constructor(
    app: App,
    private plugin: GitVaultSync,
  ) {
    super(app);
  }
  onOpen(): void {
    // A finished background sync can add or clear decisions, so redraw once it settles.
    const redraw = this.redraw = debounce(() => { void this.render(); }, 400, true);
    this.unsubscribe = this.plugin.subscribe(() => {
      this.showSummary();
      if (!this.plugin.syncing) redraw();
    });
    void this.render();
  }
  onClose(): void {
    this.closed = true;
    this.generation++;
    this.redraw?.cancel();
    this.unsubscribe?.();
  }
  async render(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const el = this.contentEl;
    el.empty();
    el.addClass("git-sync-panel");
    this.setTitle("Sync status");
    const summary = this.summary = el.createEl("p", { cls: "git-sync-summary-line" });
    this.showSummary();
    const body = el.createDiv();
    const actions = new Setting(el);
    // A problem's fix usually lives in settings (token, repository, paused review).
    if (this.plugin.statusProblem)
      actions.addButton(b => b.setButtonText("Open settings").setCta().onClick(() => { this.close(); this.plugin.openSettings(); }));
    actions
      .addButton(b => b.setButtonText("History").onClick(() => new SyncHistoryModal(this.app, this.plugin).open()))
      .addButton(b => b.setButtonText("Sync now").onClick(async () => {
        b.setDisabled(true);
        await this.plugin.syncNow();
        await this.render();
      }));
    actions.settingEl.addClass("git-sync-footer");
    // Details wait for a running sync; say so instead of showing an empty panel.
    if (this.plugin.syncing) body.createEl("p", { text: "Details appear when this sync finishes.", cls: "git-sync-muted" });
    try {
      // The cheap status lists decisions right away; the slower local scan fills in unsynced files below.
      const status = await this.plugin.session?.status();
      if (!current()) return;
      body.empty();
      if (!status || status.kind === "unenrolled") {
        summary.setText("Sync isn't set up yet. Connect to GitHub in GitHub Vault Sync settings.");
        return;
      }
      if (status.kind === "corrupt") {
        summary.setText(status.detail);
        summary.addClass("mod-warning");
        return;
      }
      if (status.pause) body.createEl("p", { text: status.pause.detail, cls: "mod-warning" });
      for (const error of status.nativeErrors)
        new Setting(body).setName(error.path ?? "Sync can't continue").setDesc(error.detail).settingEl.addClass("mod-warning");
      if (status.phase === "publication-unknown")
        new Setting(body)
          .setName("Last upload wasn't confirmed")
          .setDesc("Uploads are on hold. Sync now asks GitHub again without uploading twice.")
          .addButton(b => b.setButtonText("Review").onClick(async () => {
            b.setDisabled(true);
            try {
              const preview = await this.plugin.session?.previewPublicationRecovery();
              if (preview?.kind === "reachable") { await this.plugin.syncNow(); await this.render(); }
              else if (preview?.kind === "preview") new PublicationRecoveryModal(this.app, this.plugin, preview).open();
              else throw new Error("This can't be reviewed right now. Try again after the next sync.");
            } catch (error) { new Notice(failure(error), 12000); }
            finally { b.setDisabled(false); }
          }));
      renderDecisions(body.createDiv(), this.app, this.plugin, status.conflicts, () => { void this.render(); });
      for (const step of status.blocked)
        new Setting(body)
          .setName(describePath(step.path).name)
          .setDesc(`${describePath(step.path).place} · ${step.reason}`)
          .addButton(b => b.setButtonText("Keep this device's").onClick(() => {
            new ConfirmModal(this.app, "Keep this device's version?",
              "It uploads on the next sync. If GitHub deleted it, it comes back.",
              async () => {
                const result = await this.plugin.session?.keepLocal({ path: step.path });
                if (result?.kind !== "recorded") throw new Error("This file changed again. Close this and try again.");
                await this.plugin.syncNow();
                await this.render();
              }, "Keep this device's").open();
          }));
      const configuration = await this.plugin.session?.listConfiguration().catch(() => null);
      if (!current()) return;
      const waiting = configuration?.kind === "configuration" && configuration.rules === "config/1"
        ? configuration.deferred.length + configuration.guarded.length + configuration.unpublished.length : 0;
      if (waiting)
        new Setting(body).setName("Obsidian settings").setDesc(`${plural(waiting, "change")} waiting for your review.`)
          .addButton(b => b.setButtonText("Review").setCta().onClick(() => new ConfigurationModal(this.app, this.plugin).open()));
      // Settings files waiting for review are listed there, not as uploads.
      const reviewing = new Set(configuration?.kind === "configuration" ? configuration.deferred.map(item => item.path) : []);
      const scanned = body.createDiv();
      scanned.createEl("p", { text: "Checking this device for changes…", cls: "git-sync-muted" });
      void this.plugin.session?.inspect().then(inspected => {
        if (!current()) return;
        scanned.empty();
        if (inspected.kind !== "enrolled") return;
        for (const file of inspected.unreadable ?? [])
          new Setting(scanned).setName(describePath(file.path).name)
            .setDesc(`Too large to sync (${formatBytes(file.size)}). It stays on this device; other files keep syncing.`);
        const pending = (inspected.pending ?? []).filter(change => !reviewing.has(change.path));
        if (!pending.length) { scanned.createEl("p", { text: "Everything on this device is on GitHub.", cls: "git-sync-muted" }); return; }
        new Setting(scanned).setName(`Waiting to upload · ${pending.length}`).setHeading();
        const list = scanned.createDiv({ cls: "git-sync-list" });
        for (const change of pending) {
          const { name, place } = describePath(change.path);
          list.createEl("p", { text: `${name} · ${place} · ${change.change}` });
        }
      }, error => scanned.setText(failure(error)));
    } catch (error) {
      if (!current()) return;
      summary.setText(failure(error));
      summary.addClass("mod-warning");
    }
  }
  private showSummary(): void {
    this.summary?.setText(this.plugin.statusText);
    this.summary?.toggleClass("mod-warning", this.plugin.statusProblem);
  }
}
class BulkDeletionModal extends Modal {
  constructor(app: App, private plugin: GitVaultSync, private conflict: BulkDeletionConflict, private done: () => void) { super(app); }
  onOpen(): void {
    const el = this.contentEl;
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: `Review deletion of ${this.conflict.paths.length} files` });
    el.createEl("p", { text: this.conflict.direction === "local" ? "These files were removed on this device. Confirm before removing them from GitHub too." : "These files were removed from GitHub. Confirm before removing them from this device too." });
    el.createEl("pre", { text: this.conflict.paths.join("\n"), cls: "git-sync-preview" });
    for (const deletion of [false, true]) {
      new Setting(el).addButton(button => button.setButtonText(deletion ? "Confirm these deletions" : "Keep these files").onClick(async () => {
        button.setDisabled(true);
        try {
          const kind = (this.conflict.direction === "local") === deletion ? "mine" : "remote";
          const result = await this.plugin.session?.resolve({ conflictId: this.conflict.id, choice: { kind } });
          if (result?.kind !== "recorded") throw new Error("The file list changed. Close this and review again.");
          this.close(); await this.plugin.syncNow(); this.done();
        } catch (error) { new Notice(failure(error), 12000); button.setDisabled(false); }
      }));
    }
  }
}
class ConflictModal extends Modal {
  constructor(
    app: App,
    private plugin: GitVaultSync,
    private conflict: VersionConflict | NativeConflict,
    private done: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    const el = this.contentEl;
    const conflict = this.conflict;
    this.modalEl.addClass("git-sync-conflict");
    el.addClass("git-sync-panel");
    const { name, place } = describePath(conflict.path);
    this.setTitle(name);
    el.createEl("p", { text: `${place} · ${conflictLabels[conflict.kind] ?? conflict.kind.replaceAll("-", " ")}`, cls: "git-sync-muted" });
    if ("expected" in conflict) {
      // Rare: a save was cut off mid-write. Each saved version is one tap away.
      const versions: Array<readonly [string, Entry | null]> = [["Before the save", conflict.expected], ["What sync was saving", conflict.next]];
      if (conflict.kind !== "oversize-write") versions.push(["What's in the file now", conflict.found]);
      versions.push(["This device", conflict.local], ["GitHub", conflict.remote]);
      const box = el.createDiv({ cls: "git-sync-diff" });
      for (const [label, value] of versions) collapsible(box, label, value);
      for (const source of conflict.oversize)
        el.createEl("p", { text: `The large original (${formatBytes(source.size)}) stays at ${source.sourcePath}.`, cls: "git-sync-muted" });
    } else {
      renderComparison(el, conflict.local, conflict.remote);
    }
    this.renderActions(el.createDiv({ cls: "git-sync-actions" }));
  }
  private renderActions(actions: HTMLElement): void {
    const conflict = this.conflict;
    const source = conflict.local ?? conflict.remote;
    const editable = /\.md$/i.test(conflict.path) && source !== null && entryText(source) !== null;
    const labels: Record<string, string> = {
      mine: conflict.local ? "Keep this device's" : "Delete it, as on this device",
      remote: conflict.remote ? "Keep GitHub's" : "Delete it, as on GitHub",
      both: "Keep both",
      edit: "Edit and combine",
      expected: "Use the version before the save",
      next: "Use what sync was saving",
      found: "Use what's in the file now",
    };
    for (const kind of conflict.choices) {
      if (kind === "edit" && !editable) continue;
      const secondary = kind === "both" || kind === "edit";
      const button = actions.createEl("button", { text: labels[kind] ?? kind, cls: secondary ? "git-sync-secondary" : "" });
      if (kind === "both" && "sibling" in conflict && conflict.sibling)
        button.setText(`Keep both · yours as ${describePath(conflict.sibling).name}`);
      button.onclick = () => {
        if (kind === "edit") this.edit(actions);
        else void this.resolve({ kind } as ChoiceInput, button);
      };
    }
  }
  private edit(actions: HTMLElement): void {
    const diff = this.contentEl.querySelector(".git-sync-diff");
    const legend = this.contentEl.querySelector(".git-sync-legend");
    legend?.remove();
    const editor = createEl("textarea", { cls: "git-sync-editor" });
    const draft = combinedDraft(this.conflict.local, this.conflict.remote);
    editor.value = draft ?? entryText((this.conflict.local ?? this.conflict.remote)!) ?? "";
    editor.setAttribute("aria-label", "Combined note");
    if (diff) diff.replaceWith(editor); else actions.before(editor);
    actions.empty();
    actions.createEl("p", { text: draft !== null ? "Lines that differ appear twice, this device's first. Delete what you don't want." : "This is this device's version. Edit it into the note you want to keep.", cls: "git-sync-muted" });
    const cancel = actions.createEl("button", { text: "Cancel", cls: "git-sync-secondary" });
    cancel.onclick = () => { this.contentEl.empty(); this.onOpen(); };
    const save = actions.createEl("button", { text: "Save note", cls: "mod-cta" });
    save.onclick = () => void this.resolve({ kind: "edit", data: encodeBase64(new TextEncoder().encode(editor.value)) }, save);
    editor.focus();
  }
  private async resolve(choice: ChoiceInput, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const resolution = await this.plugin.session?.resolve({ conflictId: this.conflict.id, choice });
      if (resolution?.kind !== "recorded") throw new Error("This file changed again. Close this and review the new versions.");
      this.close();
      await this.plugin.syncNow();
      this.done();
    } catch (error) {
      new Notice(failure(error), 12000);
      button.disabled = false;
    }
  }
}
/** One shared choice for several files that changed in both places. */
function renderBulkChoice(container: HTMLElement, app: App, plugin: GitVaultSync, conflicts: readonly Conflict[], done: () => void): void {
  const files = conflicts.filter((conflict): conflict is VersionConflict =>
    conflict.kind !== "collision" && conflict.kind !== "bulk-deletion" && !("expected" in conflict));
  if (files.length < 2) return;
  const setting = new Setting(container).setName(`All ${files.length} files`);
  setting.settingEl.addClass("git-sync-bulk");
  for (const kind of ["mine", "remote"] as const) {
    const eligible = files.filter(file => file.choices.includes(kind));
    if (eligible.length < 2) continue;
    const label = kind === "remote" ? "Keep GitHub's" : "Keep this device's";
    setting.addButton(button => button.setButtonText(label)
      .onClick(() => new ConfirmModal(app,
        kind === "remote" ? `Keep GitHub's version of ${eligible.length} files?` : `Keep this device's version of ${eligible.length} files?`,
        eligible.map(file => file.path).join("\n"),
        async () => {
          let recorded = 0;
          for (const file of eligible) {
            const result = await plugin.session?.resolve({ conflictId: file.id, choice: { kind } }).catch(() => null);
            if (result?.kind === "recorded") recorded++;
          }
          // Recorded choices apply either way; whatever changed meanwhile stays in the list.
          if (recorded < eligible.length)
            new Notice(`${recorded} of ${eligible.length} done. The rest changed again; resolve them one by one.`, 10000);
          await plugin.syncNow();
          done();
        }, label).open()));
  }
}
function collapsible(container: HTMLElement, label: string, value: Entry | null): void {
  const details = container.createEl("details", { cls: "git-sync-group" });
  details.createEl("summary").createSpan({ text: label });
  details.createEl("pre", { text: entryPreview(value), cls: "git-sync-preview" });
}
/** Line diff between this device and GitHub, or a short note when either side isn't text. */
function renderComparison(container: HTMLElement, local: Entry | null, remote: Entry | null): void {
  const legend = container.createDiv({ cls: "git-sync-legend" });
  legend.createSpan({ text: "This device", cls: "git-sync-mine" });
  legend.createSpan({ text: "GitHub", cls: "git-sync-theirs" });
  const box = container.createDiv({ cls: "git-sync-diff" });
  const mine = local ? entryText(local) : null;
  const theirs = remote ? entryText(remote) : null;
  const rows = mine !== null && theirs !== null ? diffRows(mine, theirs) : null;
  if (!rows) {
    for (const [kind, value, where] of [["mine", local, "this device"], ["theirs", remote, "GitHub"]] as const)
      box.createDiv({ text: value === null ? `Deleted on ${where}` : entryPreview(value), cls: `git-sync-row git-sync-${kind}` });
    return;
  }
  for (const row of rows) {
    if (row.kind === "skip") box.createDiv({ text: `${plural(row.count, "unchanged line")}`, cls: "git-sync-row git-sync-skip" });
    else {
      const line = box.createDiv({ text: row.text.replace(/\r?\n$/, "") || " ", cls: `git-sync-row git-sync-${row.kind}` });
      // Screen readers hear which side a line belongs to; sighted readers get color and edge style.
      if (row.kind !== "same") line.setAttr("aria-label", `${row.kind === "mine" ? "This device" : "GitHub"}: ${line.textContent ?? ""}`);
    }
  }
}
/** Markdown with each differing block from both sides, labelled, for "Edit and combine". */
function combinedDraft(local: Entry | null, remote: Entry | null): string | null {
  const mine = local ? entryText(local) : null;
  const theirs = remote ? entryText(remote) : null;
  if (mine === null || theirs === null) return null;
  const a = splitLines(theirs);
  const hunks = diff(a, splitLines(mine));
  if (!hunks) return null;
  const out: string[] = [];
  let position = 0;
  for (const hunk of hunks) {
    out.push(...a.slice(position, hunk.start));
    const gh = a.slice(hunk.start, hunk.end);
    if (!gh.length) out.push(...hunk.lines);
    else if (!hunk.lines.length) out.push(...gh);
    else out.push(...hunk.lines, ...gh);
    position = hunk.end;
  }
  out.push(...a.slice(position));
  // A side's last line may lack a newline; keep lines from running together.
  return out.map((line, at) => at < out.length - 1 && !line.endsWith("\n") ? `${line}\n` : line).join("");
}
class PublicationRecoveryModal extends Modal {
  constructor(app: App, private plugin: GitVaultSync, private preview: PublicationRecoveryPreview) { super(app); }
  onOpen(): void {
    const el = this.contentEl;
    el.addClass("git-sync-panel");
    this.setTitle("Last upload wasn't confirmed");
    el.createEl("p", { text: "GitHub never confirmed the last upload, so sync is on hold. Continuing saves copies of both versions on this device, then shows a fresh review before syncing resumes. GitHub and your notes are not changed." });
    el.createEl("p", { text: "Each file below shows your last upload next to what GitHub has now.", cls: "git-sync-muted" });
    const paths = new Set([...Object.keys(this.preview.candidateFiles), ...Object.keys(this.preview.headFiles), ...Object.keys(this.preview.localFiles)]);
    for (const path of [...paths].sort()) {
      const local = this.preview.localFiles[path] ?? null;
      const remote = this.preview.headFiles[path] ?? null;
      const candidate = this.preview.candidateFiles[path] ?? null;
      if (local?.oid === remote?.oid && remote?.oid === candidate?.oid && local?.mode === remote?.mode && remote?.mode === candidate?.mode) continue;
      const details = el.createEl("details");
      details.createEl("summary", { text: path });
      for (const [label, value] of [["This device", local], ["GitHub now", remote], ["Unconfirmed upload", candidate]] as const) {
        details.createEl("h3", { text: label });
        details.createEl("pre", { text: entryPreview(value), cls: "git-sync-preview" });
      }
    }
    new Setting(el).addButton(b => b.setButtonText("Not now").onClick(() => this.close())).addButton(b => b.setButtonText("Save copies and review").setCta().onClick(() => {
      new ConfirmModal(this.app, "Save copies and review?", "Sync resumes after you review the changes.", async () => {
        const result = await this.plugin.session?.recoverPublication({ token: this.preview.token });
        if (result?.kind !== "released") throw new Error("Something changed. Close this and try again.");
        this.plugin.setStatus("Paused · review changes in settings");
        this.close();
        const enrollment = await this.plugin.session?.previewEnrollment();
        if (enrollment?.kind === "preview") new EnrollmentModal(this.app, this.plugin, enrollment, false).open();
        else new Notice("Open GitHub Vault Sync settings to review changes and resume.");
      }, "Save copies and review").open();
    }));
  }
}
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private detail: string,
    private action: () => Promise<void>,
    private confirmText = "Confirm",
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.titleText });
    this.contentEl.createEl("p", { text: this.detail, cls: "git-sync-detail" });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.confirmText)
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.action();
              this.close();
            } catch (error) {
              new Notice(failure(error), 12000);
              b.setDisabled(false);
            }
          }),
      );
  }
}
class RestoreModal extends Modal {
  private revision = 0;
  private previewRevision = 0;
  private closed = false;
  constructor(app: App, private plugin: GitVaultSync) { super(app); }
  onClose(): void { this.closed = true; this.revision++; }
  onOpen(): void {
    const el = this.contentEl;
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: "File history" });
    el.createEl("p", { text: "Choose an earlier version. Restoring creates a new change and keeps your GitHub history." });
    let path = this.app.workspace.getActiveFile()?.path ?? "";
    const history = el.createDiv({ cls: "git-sync-history" });
    const output = el.createDiv();
    const current = (revision: number) => !this.closed && revision === this.revision;
    const previewVersion = async (filePath: string, commit: string, revision: number) => {
      const selection = ++this.previewRevision;
      output.empty();
      const session = this.plugin.session;
      if (!session) { output.createEl("p", { text: "Connect this vault to GitHub first." }); return; }
      try {
        const preview = await session.previewRestore({ path: filePath, commit });
        if (!current(revision) || selection !== this.previewRevision) return;
        if (preview.kind !== "preview") throw new Error("This version can't be shown right now. Try another one or sync first.");
        output.empty();
        output.createEl("h3", { text: "Selected version" });
        output.createEl("pre", { text: entryPreview(preview.historical), cls: "git-sync-preview" });
        new Setting(output).addButton(button => button.setButtonText("Restore this version").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            if (!current(revision) || selection !== this.previewRevision || this.plugin.session !== session) throw new Error("The vault or selection changed. Browse history again.");
            const outcome = await session.restore({ token: preview.token, path: filePath, commit });
            if (outcome.kind !== "restored" && outcome.kind !== "unchanged") throw new Error("The note changed while you were looking. Pick the version again.");
            this.close();
            await this.plugin.syncNow();
          } catch (error) { new Notice(failure(error), 12000); button.setDisabled(false); }
        }));
      } catch (error) { if (current(revision) && selection === this.previewRevision) output.createEl("p", { text: failure(error) }); }
    };
    const load = async (filePath: string, revision: number, at?: string, page = 1): Promise<boolean> => {
      try {
        const result = await this.plugin.fileHistory({ path: filePath, at, page });
        if (!current(revision)) return false;
        if (page === 1) history.empty();
        for (const version of result.entries) {
          new Setting(history)
            .setName(version.message.split("\n")[0] || "Saved version")
            .setDesc(`${new Date(version.date).toLocaleString()} · ${version.author}`)
            .addButton(button => button.setButtonText("Preview").onClick(async () => {
              button.setDisabled(true);
              await previewVersion(filePath, version.commit, revision);
              button.setDisabled(false);
            }));
        }
        if (page === 1 && result.entries.length === 0) history.createEl("p", { text: "No committed versions for this path. For a renamed file, search its earlier path too." });
        if (result.nextPage !== null) {
          const nextPage = result.nextPage;
          const more = new Setting(history).addButton(button => button.setButtonText("Older versions").onClick(async () => {
            button.setDisabled(true);
            if (await load(filePath, revision, result.at, nextPage)) more.settingEl.remove();
            else button.setDisabled(false);
          }));
        }
        return true;
      } catch (error) { if (current(revision)) history.createEl("p", { text: failure(error) }); return false; }
    };
    const controls = new Setting(el).setName("File path").setDesc("You can also enter the path of a deleted note.")
      .addText(text => text.setValue(path).setPlaceholder("Notes/My note.md").onChange(value => {
        path = value; this.revision++; history.empty(); output.empty();
      }))
      .addButton(button => button.setButtonText("Browse history").setCta().onClick(async () => {
        const revision = ++this.revision;
        history.empty(); output.empty(); history.createEl("p", { text: "Loading versions…" });
        button.setDisabled(true);
        await load(path, revision);
        button.setDisabled(false);
      }));
    el.insertBefore(controls.settingEl, history);
    if (path) void load(path, ++this.revision);
  }
}
