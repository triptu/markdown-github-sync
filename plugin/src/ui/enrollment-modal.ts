// Reviews that end in (re)starting sync: the first-sync preview and recovery from an unconfirmed upload.
import { App, Modal, Notice, Setting } from "obsidian";
import type GitVaultSync from "../main";
import type { EnrollmentPreview, PublicationRecoveryPreview } from "../git-sync/session";
import { failure, plural, reviewGroups } from "./copy";
import { entryPreview } from "./entry-preview";
import { ConfirmModal } from "./confirm-modal";
import { ChangesModal } from "./changes-modal";

/** Shows what the first sync would do. Starting is the only step that changes anything. */
export class EnrollmentModal extends Modal {
  constructor(
    app: App,
    private plugin: GitVaultSync,
    private preview: EnrollmentPreview,
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
              new EnrollmentModal(this.app, this.plugin, outcome.preview, this.done).open();
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
export class PublicationRecoveryModal extends Modal {
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
        if (enrollment?.kind === "preview") new EnrollmentModal(this.app, this.plugin, enrollment).open();
        else new Notice("Open Gitless Vault Sync settings to review changes and resume.");
      }, "Save copies and review").open();
    }));
  }
}
