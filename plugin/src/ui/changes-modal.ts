// Sync status: what needs a choice, what's blocked, and what hasn't uploaded yet.
import { App, Modal, Notice, Setting, debounce } from "obsidian";
import type GitVaultSync from "../main";
import type { Conflict, VersionConflict, BulkDeletionConflict } from "../git-sync/reconcile";
import { conflictLabels, describePath, failure, formatBytes, plural } from "./copy";
import { ConflictModal } from "./conflict-modal";
import { ConfirmModal } from "./confirm-modal";
import { ConfigurationModal } from "./configuration-modal";
import { PublicationRecoveryModal } from "./enrollment-modal";
import { SyncHistoryModal } from "./history-modals";

/** Files waiting on a choice, one row each, plus one shared choice when there are several. */
export function renderDecisions(container: HTMLElement, app: App, plugin: GitVaultSync, conflicts: readonly Conflict[], changed: () => void): void {
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
export class ChangesModal extends Modal {
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
      if (status.pause?.reason === "ledger-diverged" || status.pause?.reason === "duplicate-installation")
        new Setting(body)
          .setName("Last upload wasn't confirmed")
          .setDesc("Uploads are on hold. Sync now asks GitHub again without uploading twice.")
          .addButton(b => b.setButtonText("Review").onClick(async () => {
            b.setDisabled(true);
            try {
              const preview = await this.plugin.session?.previewPublicationRecovery();
              if (preview?.kind === "preview") new PublicationRecoveryModal(this.app, this.plugin, preview).open();
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
      const waiting = configuration?.kind === "configuration"
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
