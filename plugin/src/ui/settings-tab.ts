// The plugin's settings page: setup form, then status and options once syncing.
import { App, Notice, Platform, PluginSettingTab, Setting, debounce } from "obsidian";
import type GitVaultSync from "../main";
import type { SyncSession } from "../git-sync/session";
import type { RepositoryIdentity } from "../git-sync/contracts";
import type { Settings } from "../settings";
import { formatCommitMessage } from "../commit-message";
import { failure, plural, parseRepository, describeActivity, tokenCreationUrl, type AccessTarget } from "./copy";
import { EnrollmentModal } from "./enrollment-modal";
import { SyncHistoryModal, RestoreModal } from "./history-modals";
import { ConfigurationModal } from "./configuration-modal";
import { renderDecisions } from "./changes-modal";

/** Default device name for commits, after the platform. */
export function deviceSuggestion(): string {
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
type SettingsView = "setup" | "paused" | "syncing";
function settingsView(status: Awaited<ReturnType<SyncSession["status"]>> | { kind: "corrupt" } | undefined): SettingsView {
  if (status?.kind !== "enrolled") return "setup";
  return status.pause ? "paused" : "syncing";
}
export class GitSettings extends PluginSettingTab {
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
      .setDesc("Owner and name, or paste the repository link.")
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
      await this.plugin.assertSingleWriter();
      const session = this.plugin.session;
      if (!session) throw new Error(this.plugin.statusText);
      const preview = await session.previewEnrollment();
      if (preview.kind === "corrupt") throw new Error(preview.detail);
      if (preview.kind === "preview") new EnrollmentModal(this.app, this.plugin, preview, () => this.refresh()).open();
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
    const waiting = listing.deferred.length + listing.guarded.length + listing.unpublished.length;
    setting.setDesc(waiting ? `${plural(waiting, "change")} waiting for your review.` : "Themes, hotkeys and plugins sync along with your notes.")
      .addButton(button => {
        button.setButtonText(waiting ? "Review" : "View").onClick(() => new ConfigurationModal(this.app, this.plugin).open());
        if (waiting) button.setCta();
      });
  }
}
