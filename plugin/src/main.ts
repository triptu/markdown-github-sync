import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
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
import type { VersionConflict, NativeConflict, BulkDeletionConflict } from "./git-sync/reconcile";
import { decodeBase64, encodeBase64, entryText } from "./git-sync/codec";
import { GitObsidianVault } from "./git-sync/obsidian-vault";
import { FileJournalStore } from "./git-sync/store";
import { ForegroundScheduler } from "./git-sync/scheduler";
import { PluginOwnership, hostLifetimeId } from "./git-sync/ownership";
import { NativeTransactionJournal, NativePolicyMismatchError } from "./git-sync/native-transactions";
import { NativePathPolicy } from "./git-sync/native-path-policy";
import { NativeModeStore, parseModes } from "./git-sync/native-modes";
import { defaultSettings, parseSettings, type Settings } from "./settings";

const installationKey = "github-vault-sync-installation-v2";
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
  async onload(): Promise<void> {
    this.owner();
    try {
      await this.owner().run(async () => {
        const settings = parseSettings(await this.loadData());
        this.owner().assertActive();
        this.settings = settings;
      });
    } catch (error) {
      new Notice(failure(error), 12000);
      return;
    }
    this.statusElement = this.addStatusBarItem();
    this.statusElement.addClass("git-sync-status");
    this.statusElement.onclick = () => new ChangesModal(this.app, this).open();
    this.setStatus("Set up GitHub sync");
    this.addSettingTab(new GitSettings(this.app, this));
    this.addRibbonIcon("git-branch", "GitHub sync: changes and status", () =>
      new ChangesModal(this.app, this).open(),
    );
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow();
      },
    });
    this.addCommand({
      id: "changes",
      name: "Review changes and conflicts",
      callback: () => new ChangesModal(this.app, this).open(),
    });
    this.addCommand({
      id: "configuration",
      name: "Review configuration sync",
      callback: () => new ConfigurationModal(this.app, this).open(),
    });
    this.addCommand({
      id: "restore",
      name: "Restore a historical file",
      callback: () => new RestoreModal(this.app, this).open(),
    });
    this.addCommand({
      id: "recovery",
      name: "Browse local recovery",
      callback: () => new RecoveryModal(this.app, this).open(),
    });
    this.scheduler = new ForegroundScheduler(
      () => this.syncOnce(),
      () => this.ready && this.settings.automatic && this.session !== null,
      () => !document.hidden,
      (error) => this.setStatus(failure(error)),
    );
    const schedule = () => this.scheduler?.schedule();
    const changed = (path: string) => {
      if (this.unloaded) return;
      if (path.split("/").some(part => part.startsWith("."))) return;
      void this.notifyLocalChange().then(schedule).catch(error => this.setStatus(failure(error)));
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
      void this.recordRename(oldPath, file.path).then(schedule).catch(error => this.setStatus(failure(error)));
    }));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) schedule();
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.ready = true;
      void this.initialize().catch((error) => this.setStatus(failure(error)));
    });
  }
  onunload(): void {
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
  setStatus(value: string): void {
    this.statusText = value;
    this.statusElement?.setText(`GitHub: ${value}`);
    for (const fn of this.listeners) fn();
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
        "Invalid device identity. Preserve the local journal before recovery.",
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
    this.setStatus(
      status.kind === "unenrolled"
        ? "Review enrollment in settings"
        : status.kind === "corrupt"
          ? status.detail
          : "Ready to sync",
    );
    if (status.kind === "enrolled") this.scheduler?.schedule(1000);
  }
  private createRepository(installation: string, scopeRules: "visible-only" | "config/1"): GitHubRepository {
    const owner = this.owner();
    return new GitHubRepository({
      installation,
      scopeRules,
      configDir: this.app.vault.configDir,
      owner: this.settings.owner,
      name: this.settings.repository,
      branch: this.settings.branch,
      token: async () => {
        owner.assertActive();
        const token = this.app.secretStorage.getSecret(this.settings.secretId);
        if (!token) throw new Error("Choose a GitHub token in settings.");
        return token;
      },
      transport: {
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
  previewConfigurationUpgrade() {
    return this.owner().run(async () => {
      const owner = this.owner();
      const current = this.rawSession;
      const vault = this.nativeVault;
      const store = this.journals[0];
      const journal = this.nativeJournal;
      if (!current || !vault || !store || !journal) throw new Error("Save settings and enroll this device first.");
      await this.assertSingleWriter();
      const installation: unknown = this.app.loadLocalStorage(installationKey);
      if (typeof installation !== "string") throw new Error("Missing device identity.");
      const migration = new SyncSession({
        repository: owner.fence(this.createRepository(installation, "config/1")),
        vault: owner.fence(vault), store: owner.fence(store),
        deviceName: this.settings.deviceName, scopeRules: "config/1", hostLifetimeId: hostLifetimeId(this.app),
      });
      const policy = await NativePathPolicy.forConfig(this.app.vault.configDir);
      await journal.previewPolicyUpgrade(policy);
      const preview = await migration.previewConfigurationScope();
      if (preview.kind !== "preview") throw new Error(preview.kind === "paused" ? `Resolve the existing pause first: ${preview.pause.detail}` : `Configuration review unavailable: ${preview.kind}`);
      return {
        note: preview.note,
        confirm: () => owner.run(async () => {
          if (this.rawSession !== current) throw new Error("Sync configuration changed. Reopen the review.");
          await this.assertSingleWriter();
          await journal.previewPolicyUpgrade(policy);
          const result = await migration.enableConfigurationScope({ token: preview.token });
          if (result.kind !== "reenroll") throw new Error(result.kind === "paused" ? `Resolve the existing pause first: ${result.pause.detail}` : `Reopen the configuration review: ${result.kind}`);
          await this.initializeOwned();
          return this.rawSession?.previewEnrollment();
        }),
      };
    });
  }
  async assertSingleWriter(): Promise<void> {
    if (await this.app.vault.adapter.exists(".git"))
      throw new Error(
        "Use a fresh plugin-owned vault. Keep your existing Git checkout as the rollback copy.",
      );
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
          "Disable the other sync plugin in this vault before enrolling or syncing.",
        );
    }
  }
  fileHistory(input: Parameters<GitHubRepository["history"]>[0]) {
    return this.owner().run(async () => {
      if (!this.repository || !this.session) throw new Error("Connect this vault to GitHub first.");
      const status = await this.rawSession?.status();
      if (status?.kind !== "enrolled") throw new Error("Enroll this device before browsing its history.");
      return this.repository.history({ ...input, at: input.at ?? status.commit });
    });
  }
  compactRecovery() {
    return this.owner().run(() => this.compactRecoveryOwned());
  }
  private async compactRecoveryOwned(): Promise<{ recordsRemoved: number; objectsRemoved: number }> {
    const status = await this.rawSession?.status();
    if (!status || status.kind !== "enrolled") throw new Error("Recovery cleanup requires a readable enrolled vault.");
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
      this.setStatus("Checking saved changes…");
      const outcome = await this.rawSession.sync();
      this.setStatus(describeOutcome(outcome));
      if (outcome.kind === "synced" && Date.now() - this.lastCleanup >= 30 * 60 * 1000) {
        try { await this.compactRecoveryOwned(); }
        catch (error) { this.setStatus(`Synced. Recovery cleanup paused: ${failure(error)}`); }
      }
    });
  }
  async syncNow(): Promise<void> {
    if (!this.session) {
      new Notice(
        "Configure your repository and review enrollment in GitHub Vault Sync settings.",
      );
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
      if (!binding && this.nativeJournal && Boolean(saved.configuration) !== Boolean(this.settings.configuration))
        throw new Error("Initial scope is already bound to this vault. Finish enrollment, then use the configuration migration review.");
      if (binding &&
          (saved.owner.toLowerCase() !== binding.owner.toLowerCase() ||
           saved.repository.toLowerCase() !== binding.name.toLowerCase() ||
           saved.branch !== binding.branch))
        throw new Error("Repository and branch are bound to this vault. Enroll a fresh vault to change them.");
      this.owner().assertActive();
      await this.saveData(saved);
      this.owner().assertActive();
      this.settings = parseSettings(saved);
      if (!binding || !this.rawSession) await this.initializeOwned();
      else this.scheduler?.schedule();
    });
  }
  nativeRecoveryOverview() {
    return this.owner().run(async () => {
      if (!this.nativeVault) throw new Error("Connect this vault before inspecting native recovery.");
      return {
        oversized: this.nativeVault.nativeRecoveries().filter(record => record.kind === "oversize"),
        retained: await this.nativeVault.retainedHiddenSummary(),
      };
    });
  }
  inspectOversizeRecovery(id: string) {
    return this.owner().run(async () => {
      if (!this.nativeVault) throw new Error("Native recovery is unavailable.");
      return this.nativeVault.inspectOversize(id);
    });
  }
  exportOversizeRecovery(id: string) {
    return this.owner().run(async () => {
      if (!this.nativeVault) throw new Error("Native recovery is unavailable.");
      return this.nativeVault.exportOversize(id);
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
function describeOutcome(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case "unenrolled":
      return "Review enrollment in settings";
    case "corrupt":
      return `Recovery needed: ${outcome.detail}`;
    case "paused":
      return `Paused: ${outcome.pause.detail}`;
    case "up-to-date":
    case "synced": {
      const pending: string[] = [];
      if (outcome.attention?.unreadable.length) pending.push(`${outcome.attention.unreadable.length} unreadable files`);
      if (outcome.attention?.held.length) pending.push(`${outcome.attention.held.length} held files`);
      if (outcome.attention?.deferred) pending.push(`${outcome.attention.deferred} configuration updates`);
      if (outcome.kind === "synced" && outcome.carried.length) pending.push(`${outcome.carried.length} newer local edits`);
      const progress = outcome.kind === "synced" && outcome.published ? "Changes published" : "Checked GitHub";
      return pending.length ? `${progress} · ${pending.join(" · ")} pending`
        : `Content synced · ${outcome.commit.slice(0, 7)}`;
    }
    case "needs-decision":
      return `${outcome.conflicts.length} decisions needed${outcome.published ? " · other changes published" : ""}${outcome.carried.length ? ` · ${outcome.carried.length} drafts retained` : ""}`;
    case "blocked":
      return `${outcome.steps.length} file updates held · open Changes`;
    case "publication-unknown":
      return "Publication uncertain · open Changes to review";
    case "settling":
      return "Waiting for GitHub to confirm the upload; retrying automatically";
    case "contended":
      return "Another device is publishing; retrying shortly";
    case "native-error":
      return "Recovery evidence needs attention · open Changes";
  }
}
class GitSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: GitVaultSync,
  ) {
    super(app, plugin);
  }
  display(): void {
    const el = this.containerEl;
    el.empty();
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: "GitHub Vault Sync" });
    el.createEl("p", {
      text: "Saved notes become commits in your private repository. Only accepted GitHub versions are shared. Configuration sync is enabled separately after review.",
    });
    const draft = { ...this.plugin.settings };
    new Setting(el).setName("GitHub owner").addText((t) =>
      t
        .setValue(draft.owner)
        .setPlaceholder("Your username")
        .onChange((v) => (draft.owner = v.trim())),
    );
    new Setting(el).setName("Repository").addText((t) =>
      t
        .setValue(draft.repository)
        .setPlaceholder("notes")
        .onChange((v) => (draft.repository = v.trim())),
    );
    new Setting(el)
      .setName("Branch")
      .addText((t) =>
        t.setValue(draft.branch).onChange((v) => (draft.branch = v.trim())),
      );
    new Setting(el)
      .setName("GitHub token")
      .setDesc(
        "Use a fine-grained token for this repository with Contents read/write and Metadata read. The token stays in Obsidian SecretStorage, outside vault files.",
      )
      .addComponent((container) =>
        new SecretComponent(this.app, container)
          .setValue(draft.secretId)
          .onChange((v) => (draft.secretId = v ?? "")),
      );
    new Setting(el)
      .setName("Device name")
      .setDesc("Included in commit messages.")
      .addText((t) =>
        t.setValue(draft.deviceName).onChange((v) => (draft.deviceName = v)),
      );
    new Setting(el)
      .setName("Automatic sync")
      .setDesc(
        "Publish saved changes after a short pause; check for remote changes every minute while Obsidian is active.",
      )
      .addToggle((t) =>
        t.setValue(draft.automatic).onChange((v) => (draft.automatic = v)),
      );
    new Setting(el).setName("Include configuration in first enrollment")
      .setDesc("Choose before connecting this new vault. Existing enrolled vaults use the separate migration review below.")
      .addToggle(toggle => toggle.setValue(draft.configuration ?? false)
        .setDisabled(this.plugin.session !== null)
        .onChange(value => { draft.configuration = value; }));
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Save settings")
        .setCta()
        .onClick(async () => {
          b.setDisabled(true);
          try {
            await this.plugin.saveConfiguration(draft);
            new Notice("Settings saved.");
          } catch (error) {
            new Notice(failure(error), 12000);
          } finally {
            b.setDisabled(false);
          }
        }),
    );
    new Setting(el).setName("Configuration changes")
      .setDesc("Preview incoming settings and choose which new local configuration files may be published.")
      .addButton(button => button.setButtonText("Review changes").onClick(() => new ConfigurationModal(this.app, this.plugin).open()));
    new Setting(el).setName("Reconnect after a startup error")
      .setDesc(this.plugin.statusText)
      .addButton(button => button.setButtonText("Retry connection").onClick(async () => {
        button.setDisabled(true);
        try { await this.plugin.initialize(); this.display(); }
        catch (error) { this.plugin.setStatus(failure(error)); new Notice(failure(error), 12000); }
        finally { button.setDisabled(false); }
      }));
    el.createEl("h3", { text: "Enroll this device" });
    el.createEl("p", {
      text: "Start with a fresh vault and keep your existing vault as a backup. Disable Obsidian Sync, Git, cloud-folder sync, and other sync tools for this vault. Enrollment previews all differences before making changes.",
    });
    let soleWriter = false;
    new Setting(el)
      .setName("This plugin is the only sync writer")
      .addToggle((t) => t.onChange((v) => (soleWriter = v)));
    new Setting(el).addButton((b) =>
      b.setButtonText("Preview enrollment").onClick(async () => {
        if (!soleWriter) {
          new Notice(
            "Confirm that other sync tools are disabled for this vault.",
          );
          return;
        }
        b.setDisabled(true);
        try {
          await this.plugin.assertSingleWriter();
          if (!this.plugin.session)
            throw new Error(`Sync is unavailable: ${this.plugin.statusText}. Use Retry connection after resolving the reported error.`);
          const preview = await this.plugin.session.previewEnrollment();
          if (preview.kind !== "preview") {
            new Notice(
              preview.kind === "corrupt"
                ? preview.detail
                : "This device is already enrolled.",
            );
            return;
          }
          new EnrollmentModal(this.app, this.plugin, preview).open();
        } catch (error) {
          new Notice(failure(error), 12000);
        } finally {
          b.setDisabled(false);
        }
      }),
    );
    new Setting(el).setName("Include Obsidian configuration")
      .setDesc("After initial enrollment, review eligible settings, themes and plugins. Incoming configuration waits for approval; new local configuration files need publication consent.")
      .addButton(button => button.setButtonText("Review configuration sync").onClick(async () => {
        button.setDisabled(true);
        try {
          const upgrade = await this.plugin.previewConfigurationUpgrade();
          new ConfirmModal(this.app, "Include Obsidian configuration?",
            `${upgrade.note}. Sync will pause while you review enrollment. Your existing notes and recovery copies remain on this device.`,
            async () => {
              const preview = await upgrade.confirm();
              if (preview?.kind !== "preview") throw new Error("Open enrollment in settings to continue the configuration review.");
              new EnrollmentModal(this.app, this.plugin, preview).open();
            }).open();
        } catch (error) { new Notice(failure(error), 12000); }
        finally { button.setDisabled(false); }
      }));
    el.createEl("p", {
      text: "Review conflicts, interrupted operations, and files above the size limit in Changes. Original files retained in .git-vault-sync are not deleted automatically; inspect storage in Local recovery.",
      cls: "git-sync-muted",
    });
  }
}
class ConfigurationModal extends Modal {
  private generation = 0;
  constructor(app: App, private plugin: GitVaultSync) { super(app); }
  onOpen(): void { void this.render(); }
  onClose(): void { this.generation++; }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    const session = this.plugin.session;
    const current = () => generation === this.generation && session === this.plugin.session;
    const el = this.contentEl;
    el.empty(); el.addClass("git-sync-panel");
    el.createEl("h2", { text: "Configuration sync" });
    el.createEl("p", { text: "Review the exact saved versions before sharing or applying them. Applying does not reload Obsidian or restart plugins." });
    if (!session) { el.createEl("p", { text: "Connect and enroll this vault in settings first." }); return; }
    try {
      const listing = await session.listConfiguration();
      if (!current()) return;
      if (listing.kind !== "configuration") throw new Error(`Configuration unavailable: ${listing.kind}`);
      if (listing.rules !== "config/1") {
        el.createEl("p", { text: "Configuration sync is off. Enable it through the reviewed enrollment in GitHub Vault Sync settings." }); return;
      }
      if (listing.guarded.length) {
        el.createEl("h3", { text: `Applied configuration changed locally · ${listing.guarded.length}` });
        el.createEl("p", { text: "Obsidian or a plugin saved a different version after you applied an update. These files are held on this device; unrelated notes can still sync. Review the saved version before deciding whether to publish it." });
        for (const item of listing.guarded) {
          new Setting(el).setName(item.path)
            .setDesc(item.unreadable ? "This file cannot be read within the size limit. Its bytes have not been treated as a deletion." : "An applied update was changed locally. Publication is held.")
            .addButton(button => button.setButtonText("Review saved version").setDisabled(item.unreadable).onClick(async () => {
              button.setDisabled(true);
              try {
                const preview = await session.previewGuardedConfigurationPublication(item.path);
                if (!current()) return;
                if (preview.kind !== "preview") throw new Error(`Reopen this review: ${preview.kind}`);
                const modal = new Modal(this.app);
                modal.contentEl.addClass("git-sync-panel");
                modal.contentEl.createEl("h2", { text: preview.path });
                modal.contentEl.createEl("p", { text: preview.entry === null
                  ? "This file was deleted locally after a configuration update. Approving publishes that deletion."
                  : "This is the saved local version that would replace the reviewed configuration on GitHub." });
                configurationEntryPreview(modal.contentEl, preview.entry);
                new Setting(modal.contentEl).addButton(approve => approve
                  .setButtonText(preview.entry === null ? "Approve this deletion" : "Approve this saved version")
                  .setCta().onClick(async () => {
                    approve.setDisabled(true);
                    try {
                      if (!current()) throw new Error("Configuration changed. Reopen this review.");
                      const result = await session.consentGuardedConfigurationPublication({ path: preview.path, token: preview.token });
                      if (result.kind !== "recorded") throw new Error(`File changed; review it again: ${result.kind}`);
                      modal.close(); await this.plugin.syncNow(); await this.render();
                    } catch (error) { new Notice(failure(error), 12000); approve.setDisabled(false); }
                  }));
                modal.open();
              } catch (error) { new Notice(failure(error), 12000); }
              finally { button.setDisabled(false); }
            }));
        }
      }
      el.createEl("h3", { text: `New local files · ${listing.unpublished.length}` });
      el.createEl("p", { text: "These files remain on this device until you approve their contents. Check for secrets before publishing.", cls: "git-sync-muted" });
      for (const item of listing.unpublished) {
        new Setting(el).setName(item.path).addButton(button => button.setButtonText("Preview publication").onClick(async () => {
          button.setDisabled(true);
          try {
            const preview = await session.previewHiddenPublication(item.path);
            if (!current()) return;
            if (preview.kind !== "preview") throw new Error(`Reopen the preview: ${preview.kind}`);
            const modal = new Modal(this.app);
            modal.contentEl.addClass("git-sync-panel");
            modal.contentEl.createEl("h2", { text: preview.path });
            configurationEntryPreview(modal.contentEl, preview.entry);
            new Setting(modal.contentEl).addButton(approve => approve.setButtonText("Allow this version to publish").setCta().onClick(async () => {
              approve.setDisabled(true);
              try {
                if (!current()) throw new Error("Configuration changed. Reopen this review.");
                const result = await session.consentHiddenPublication({ path: preview.path, token: preview.token });
                if (result.kind !== "recorded") throw new Error(`File changed; review it again: ${result.kind}`);
                modal.close(); await this.plugin.syncNow(); await this.render();
              } catch (error) { new Notice(failure(error), 12000); approve.setDisabled(false); }
            }));
            modal.open();
          } catch (error) { new Notice(failure(error), 12000); }
          finally { button.setDisabled(false); }
        }));
      }
      el.createEl("h3", { text: `Incoming updates · ${listing.deferred.length}` });
      if (!listing.deferred.length) { el.createEl("p", { text: "No configuration updates waiting." }); return; }
      const preview = await session.previewApplyConfiguration();
      if (!current()) return;
      if (preview.kind !== "preview") throw new Error(`Configuration application unavailable: ${preview.kind}`);
      for (const item of preview.items) {
        const details = el.createEl("details");
        details.createEl("summary", { text: item.path });
        details.createEl("h4", { text: "Expected local version" });
        configurationEntryPreview(details, item.expectedEntry);
        details.createEl("h4", { text: "Incoming committed version" });
        configurationEntryPreview(details, item.incomingEntry);
        if (item.blockedReason) details.createEl("p", { text: item.blockedReason });
      }
      for (const blocked of preview.blocked) el.createEl("p", { text: `${blocked.path}: ${blocked.reason}` });
      el.createEl("p", { text: "Finish editing settings and disable affected third-party plugins before applying. Their running code may overwrite files. Restart Obsidian yourself afterward to load the saved configuration." });
      new Setting(el).addButton(button => button.setButtonText("Apply reviewed updates").setCta().setDisabled(preview.blocked.length > 0).onClick(async () => {
        button.setDisabled(true);
        try {
          if (!current()) throw new Error("Configuration changed. Reopen this review.");
          await this.plugin.assertSingleWriter();
          const result = await session.applyConfiguration({ token: preview.token });
          if (result.kind === "review-needed") {
            new Notice(`${result.applied.length} updates saved. ${result.changed.length} files changed during application and need review in Changes.`, 15000);
            this.close();
            new ChangesModal(this.app, this.plugin).open();
            return;
          }
          if (result.kind !== "applied") throw new Error(`Configuration needs another review: ${result.kind}`);
          new Notice(`${result.paths.length} configuration updates saved. Restart Obsidian to load them.`, 12000);
          await this.render();
        } catch (error) { new Notice(failure(error), 12000); button.setDisabled(false); }
      }));
    } catch (error) { if (current()) el.createEl("p", { text: failure(error) }); }
  }
}
class EnrollmentModal extends Modal {
  constructor(
    app: App,
    private plugin: GitVaultSync,
    private preview: EnrollmentPreview,
  ) {
    super(app);
  }
  onOpen(): void {
    const el = this.contentEl;
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: "Review this device" });
    el.createEl("p", {
      text: `${this.preview.repository.owner}/${this.preview.repository.name} · ${this.preview.repository.branch} · ${this.preview.commit.slice(0, 7)}`,
    });
    el.createEl("p", {
      text: `${this.preview.unchanged} unchanged files; ${this.preview.items.length} differences. Local-only files may be published after enrollment. Conflicting files require a decision.`,
    });
    const list = el.createDiv({ cls: "git-sync-list" });
    for (const item of this.preview.items)
      list.createEl("p", {
        text: `${item.action.replaceAll("-", " ")} · ${item.path}`,
      });
    new Setting(el)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Enroll and sync")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.assertSingleWriter();
              const outcome = await this.plugin.session?.enroll({
                token: this.preview.token,
              });
              if (outcome?.kind === "stale") {
                this.close();
                new EnrollmentModal(
                  this.app,
                  this.plugin,
                  outcome.preview,
                ).open();
                return;
              }
              if (outcome?.kind !== "enrolled")
                throw new Error(
                  "Enrollment could not complete. Reopen the preview.",
                );
              this.close();
              await this.plugin.syncNow();
              new ChangesModal(this.app, this.plugin).open();
            } catch (error) {
              new Notice(failure(error), 12000);
              b.setDisabled(false);
            }
          }),
      );
  }
}
class ChangesModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private summary: HTMLElement | null = null;
  constructor(
    app: App,
    private plugin: GitVaultSync,
  ) {
    super(app);
  }
  onOpen(): void {
    this.unsubscribe = this.plugin.subscribe(() =>
      this.summary?.setText(this.plugin.statusText),
    );
    void this.render();
  }
  onClose(): void {
    this.unsubscribe?.();
  }
  async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: "Changes" });
    this.summary = el.createEl("p", { text: this.plugin.statusText });
    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            await this.plugin.syncNow();
            await this.render();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Refresh").onClick(() => {
          void this.render();
        }),
      );
    try {
      const status = await this.plugin.session?.inspect();
      if (!status || status.kind === "unenrolled") {
        el.createEl("p", {
          text: "Open GitHub Vault Sync settings to connect and enroll this device.",
        });
        return;
      }
      if (status.kind === "corrupt") {
        el.createEl("p", { text: status.detail });
        return;
      }
      el.createEl("p", {
        text: `Last checkpoint ${status.commit.slice(0, 7)} · ${status.repository.owner}/${status.repository.name}`,
        cls: "git-sync-muted",
      });
      if (status.pause) el.createEl("p", { text: status.pause.detail });
      for (const error of status.nativeErrors) {
        new Setting(el).setName(error.path ?? "Recovery evidence")
          .setDesc(error.detail);
      }
      for (const file of status.unreadable ?? []) {
        new Setting(el).setName(file.path)
          .setDesc(`${file.size.toLocaleString()} bytes · exceeds the sync size limit. This file is left untouched; other readable files can sync. Move it outside the vault or reduce its size before retrying.`);
      }
      if (status.phase === "publication-unknown")
        new Setting(el)
          .setName("Publication needs review")
          .setDesc("The candidate is not confirmed in GitHub history. Automatic publication is held to avoid replaying a removed commit. Sync now checks again without republishing.")
          .addButton(b => b.setButtonText("Review recovery").onClick(async () => {
            b.setDisabled(true);
            try {
              const preview = await this.plugin.session?.previewPublicationRecovery();
              if (preview?.kind === "reachable") { await this.plugin.syncNow(); await this.render(); }
              else if (preview?.kind === "preview") new PublicationRecoveryModal(this.app, this.plugin, preview).open();
              else throw new Error(`Recovery unavailable: ${preview?.kind ?? "not enrolled"}`);
            } catch (error) { new Notice(failure(error), 12000); }
            finally { b.setDisabled(false); }
          }));
      for (const conflict of status.conflicts) {
        if (conflict.kind === "collision") {
          el.createEl("p", {
            text: `Rename these colliding paths before continuing: ${conflict.paths.join(", ")}`,
          });
          continue;
        }
        if (conflict.kind === "bulk-deletion") {
          new Setting(el).setName(`${conflict.paths.length} files would be deleted`)
            .setDesc(conflict.direction === "local" ? "Review deletions from this device before publishing." : "Review deletions from GitHub before applying.")
            .addButton(button => button.setButtonText("Review deletions").onClick(() =>
              new BulkDeletionModal(this.app, this.plugin, conflict, () => { void this.render(); }).open()));
          continue;
        }
        new Setting(el)
          .setName(conflict.path)
          .setDesc(conflict.kind.replaceAll("-", " "))
          .addButton((b) =>
            b.setButtonText("Review").onClick(() =>
              new ConflictModal(this.app, this.plugin, conflict, () => {
                void this.render();
              }).open(),
            ),
          );
      }
      for (const step of status.blocked)
        new Setting(el)
          .setName(step.path)
          .setDesc(step.reason)
          .addButton((b) =>
            b.setButtonText("Keep local instead").onClick(() => {
              new ConfirmModal(
                this.app,
                "Keep local version?",
                "Keep this device’s version and propose it for the next GitHub commit. If GitHub deleted this file, keeping it restores it to GitHub. Conflicts may still require review.",
                async () => {
                  const result = await this.plugin.session?.keepLocal({
                    path: step.path,
                  });
                  if (result?.kind !== "recorded")
                    throw new Error(
                      "The held update changed. Refresh and review again.",
                    );
                  await this.plugin.syncNow();
                  await this.render();
                },
              ).open();
            }),
          );
      const pending = status.pending ?? [];
      el.createEl("h3", { text: `Saved local changes (${pending.length})` });
      const list = el.createDiv({ cls: "git-sync-list" });
      for (const change of pending)
        list.createEl("p", { text: `${change.change} · ${change.path}` });
      if (!pending.length)
        list.createEl("p", { text: "No saved local changes." });
      el.createEl("p", {
        text: "Configuration sync requires separate review for .obsidian settings, plugins, hidden files, and Git metadata. Unsaved editor text is not yet a captured draft.",
        cls: "git-sync-muted",
      });
    } catch (error) {
      el.createEl("p", { text: failure(error) });
    }
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
          if (result?.kind !== "recorded") throw new Error("The file list changed. Refresh Changes and review again.");
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
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: this.conflict.path });
    el.createEl("p", {
      text: "expected" in this.conflict
        ? "A file write was interrupted or an edit was found in recovery. This file will not merge or publish automatically. Compare the saved versions and choose what to keep."
        : "Both reviewed versions remain recoverable. Your decision is rechecked if either version changes.",
    });
    for (const [label, value] of [
      ["Common version", this.conflict.base],
      ["This device", this.conflict.local],
      ["GitHub", this.conflict.remote],
    ] as const) {
      el.createEl("h3", { text: label });
      el.createEl("pre", {
        text: entryPreview(value),
        cls: "git-sync-preview",
      });
    }
    if ("oversize" in this.conflict && this.conflict.oversize.length) {
      el.createEl("h3", { text: "Large recovery files" });
      el.createEl("p", { text: "These originals remain in local recovery. Inspect or export them before choosing a version below. Confirming a decision does not delete the originals." });
      for (const source of this.conflict.oversize) {
        new Setting(el).setName(`${source.size.toLocaleString()} bytes`)
          .setDesc(source.sourcePath)
          .addButton(button => button.setButtonText("Inspect and export").onClick(() =>
            new RecoveryModal(this.app, this.plugin).open()));
      }
    }
    if ("expected" in this.conflict) {
      const versions: Array<readonly [string, Entry | null]> = [["Before the interrupted operation", this.conflict.expected], ["Intended update", this.conflict.next]];
      if (this.conflict.kind !== "oversize-write") versions.push(["Recovered bytes", this.conflict.found]);
      for (const [label, value] of versions) {
        el.createEl("h3", { text: label });
        el.createEl("pre", { text: entryPreview(value), cls: "git-sync-preview" });
      }
    }
    let choice: ChoiceInput | null = null;
    const result = el.createEl("pre", {
      text: "Choose a version to preview the result.",
      cls: "git-sync-preview",
    });
    const buttons = new Setting(el);
    for (const kind of this.conflict.choices) {
      if (
        kind === "edit" &&
        (!/\.md$/i.test(this.conflict.path) ||
          (this.conflict.local && entryText(this.conflict.local) === null))
      )
        continue;
      buttons.addButton((b) =>
        b
          .setButtonText(
            {
              mine: this.conflict.local ? "Use mine" : "Accept local deletion",
              remote: this.conflict.remote
                ? "Use GitHub"
                : "Accept GitHub deletion",
              both: "Keep both",
              edit: "Write merged note",
              expected: "Restore before the operation",
              next: "Use the intended update",
              found: "Use recovered bytes",
            }[kind],
          )
          .onClick(() => {
            if (kind === "edit") {
              const editor = el.createEl("textarea", {
                cls: "git-sync-editor",
              });
              editor.value =
                entryText(this.conflict.local ?? this.conflict.remote!) ?? "";
              choice = {
                kind: "edit",
                data: encodeBase64(new TextEncoder().encode(editor.value)),
              };
              editor.oninput = () => {
                choice = {
                  kind: "edit",
                  data: encodeBase64(new TextEncoder().encode(editor.value)),
                };
                result.setText(editor.value);
              };
              result.setText(editor.value);
            } else {
              choice = { kind };
              result.setText(
                kind === "both"
                  ? `GitHub version: ${this.conflict.path}\nYour version: ${"sibling" in this.conflict ? this.conflict.sibling : ""}`
                  : entryPreview(
                      kind === "mine"
                        ? this.conflict.local
                        : (kind === "expected" || kind === "next" || kind === "found") && "expected" in this.conflict
                          ? this.conflict[kind]
                          : this.conflict.remote,
                    ),
              );
            }
          }),
      );
    }
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Confirm decision")
        .setCta()
        .onClick(async () => {
          if (!choice) {
            new Notice("Choose a version first.");
            return;
          }
          b.setDisabled(true);
          try {
            const resolution = await this.plugin.session?.resolve({
              conflictId: this.conflict.id,
              choice,
            });
            if (resolution?.kind !== "recorded")
              throw new Error(
                "This conflict changed. Refresh Changes and review the new versions.",
              );
            this.close();
            await this.plugin.syncNow();
            this.done();
          } catch (error) {
            new Notice(failure(error), 12000);
            b.setDisabled(false);
          }
        }),
    );
  }
}
class PublicationRecoveryModal extends Modal {
  constructor(app: App, private plugin: GitVaultSync, private preview: PublicationRecoveryPreview) { super(app); }
  onOpen(): void {
    const el = this.contentEl;
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: "Review uncertain publication" });
    el.createEl("p", { text: "Continuing archives the candidate and your current drafts locally, releases the held operation, and pauses for a fresh enrollment review. It does not change GitHub or your notes. Archived drafts can be recovered explicitly afterward." });
    el.createEl("p", { text: `Candidate ${this.preview.candidate} · current GitHub head ${this.preview.head}`, cls: "git-sync-muted" });
    const paths = new Set([...Object.keys(this.preview.candidateFiles), ...Object.keys(this.preview.headFiles), ...Object.keys(this.preview.localFiles)]);
    for (const path of [...paths].sort()) {
      const local = this.preview.localFiles[path] ?? null;
      const remote = this.preview.headFiles[path] ?? null;
      const candidate = this.preview.candidateFiles[path] ?? null;
      if (local?.oid === remote?.oid && remote?.oid === candidate?.oid && local?.mode === remote?.mode && remote?.mode === candidate?.mode) continue;
      const details = el.createEl("details");
      details.createEl("summary", { text: path });
      for (const [label, value] of [["This device", local], ["Current GitHub", remote], ["Held candidate", candidate]] as const) {
        details.createEl("h3", { text: label });
        details.createEl("pre", { text: entryPreview(value), cls: "git-sync-preview" });
      }
    }
    new Setting(el).addButton(b => b.setButtonText("Keep held").onClick(() => this.close())).addButton(b => b.setButtonText("Archive and review enrollment").onClick(() => {
      new ConfirmModal(this.app, "Release this held publication?", "Both the candidate and current drafts will be retained in local recovery. A fresh enrollment preview is required before syncing can resume.", async () => {
        const result = await this.plugin.session?.recoverPublication({ token: this.preview.token });
        if (result?.kind !== "released") throw new Error("The publication or local files changed. Close this preview and review again.");
        this.plugin.setStatus("Paused · review enrollment");
        this.close();
        const enrollment = await this.plugin.session?.previewEnrollment();
        if (enrollment?.kind === "preview") new EnrollmentModal(this.app, this.plugin, enrollment).open();
        else new Notice("Open settings to review enrollment before resuming sync.");
      }).open();
    }));
  }
}
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private detail: string,
    private action: () => Promise<void>,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.titleText });
    this.contentEl.createEl("p", { text: this.detail });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Confirm")
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
        if (preview.kind !== "preview") throw new Error(`Cannot preview this version: ${preview.kind}`);
        output.empty();
        output.createEl("h3", { text: "Selected version" });
        output.createEl("pre", { text: entryPreview(preview.historical), cls: "git-sync-preview" });
        new Setting(output).addButton(button => button.setButtonText("Restore this version").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            if (!current(revision) || selection !== this.previewRevision || this.plugin.session !== session) throw new Error("The vault or selection changed. Browse history again.");
            const outcome = await session.restore({ token: preview.token, path: filePath, commit });
            if (outcome.kind !== "restored" && outcome.kind !== "unchanged") throw new Error(`Restore needs a fresh preview: ${outcome.kind}`);
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
class RecoveryModal extends Modal {
  constructor(
    app: App,
    private plugin: GitVaultSync,
  ) {
    super(app);
  }
  onOpen(): void {
    void this.render();
  }
  async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: "Local recovery" });
    el.createEl("p", {
      text: "Captured drafts and preimages stay on this device. Export creates a separate hidden folder and does not overwrite notes.",
    });
    new Setting(el).setName("Compact recovery journals")
      .setDesc("Remove superseded journal records and unreferenced journal objects. Retained original files and exports are not deleted. Also runs automatically after successful sync.")
      .addButton(button => button.setButtonText("Compact journals").onClick(async () => {
        button.setDisabled(true);
        try {
          const result = await this.plugin.compactRecovery();
          new Notice(`Removed ${result.recordsRemoved} old journal records and ${result.objectsRemoved} unused copies.`);
        } catch (error) { new Notice(failure(error), 12000); }
        finally { button.setDisabled(false); }
      }));
    try {
      const native = await this.plugin.nativeRecoveryOverview();
      el.createEl("h3", { text: "Retained original files" });
      el.createEl("p", { text: `${native.retained.files.toLocaleString()} files · ${native.retained.bytes.toLocaleString()} known bytes${native.retained.missingStats ? ` · ${native.retained.missingStats} sizes unavailable` : ""}` });
      el.createEl("p", { text: "These originals are not deleted automatically and can accumulate. Close editors and other writers before managing them in your file manager. Export and inspect anything you need to keep first.", cls: "git-sync-muted" });
      if (native.oversized.length) el.createEl("h3", { text: "Large files needing review" });
      for (const record of native.oversized) {
        const details = el.createEl("details");
        details.createEl("summary", { text: `${record.path} · ${record.size.toLocaleString()} bytes` });
        details.createEl("p", { text: "The original remains on this device. Export makes a separate copy excluded from sync. Choose the version to sync in Changes; inspecting or exporting does not resolve the conflict." });
        details.createEl("pre", { text: record.sourcePath, cls: "git-sync-preview" });
        const status = details.createEl("p", { text: "Inspect to check whether this saved version is still present." });
        new Setting(details)
          .addButton(button => button.setButtonText("Inspect source").onClick(async () => {
            button.setDisabled(true);
            try {
              const inspection = await this.plugin.inspectOversizeRecovery(record.id);
              status.setText(inspection.currentSize === null ? "Source is missing. Review its location before resolving."
                : inspection.currentSize === record.size && inspection.currentMtime === inspection.recovery.mtime
                  ? `${inspection.currentSize.toLocaleString()} bytes · size and modification time match the saved record.`
                  : "Source has changed. Sync now to refresh recovery before choosing a version.");
            } catch (error) { status.setText(failure(error)); }
            finally { button.setDisabled(false); }
          }))
          .addButton(button => button.setButtonText("Export copy").onClick(async () => {
            button.setDisabled(true);
            try {
              const exported = await this.plugin.exportOversizeRecovery(record.id);
              status.setText(`Exported ${exported.size.toLocaleString()} bytes to ${exported.path}. The original remains. Open this hidden folder in your file manager to inspect the copy.`);
            } catch (error) { status.setText(failure(error)); }
            finally { button.setDisabled(false); }
          }));
      }
      const records = await this.plugin.session?.listRecovery();
      if (!Array.isArray(records)) {
        el.createEl("p", { text: "No accessible recovery records." });
        return;
      }
      for (const record of records)
        new Setting(el)
          .setName(`${record.createdAt} · ${record.paths.length} files`)
          .setDesc(
            `${record.reason} · ${record.bytes.toLocaleString()} bytes${record.pinned ? " · local-only bytes retained" : ""}`,
          )
          .addButton((b) =>
            b.setButtonText("Export copy").onClick(async () => {
              b.setDisabled(true);
              try {
                const directory = await this.plugin.exportRecoveryCopy(record.id);
                new Notice(`Recovery exported to ${directory}`, 15000);
              } catch (error) {
                new Notice(failure(error), 12000);
              } finally {
                b.setDisabled(false);
              }
            }),
          );
    } catch (error) {
      el.createEl("p", { text: failure(error) });
    }
  }
}
