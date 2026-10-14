// Commit history for the whole vault, and earlier versions of one note.
import { App, Modal, Notice, Setting } from "obsidian";
import type GitVaultSync from "../main";
import { failure } from "./copy";
import { entryPreview } from "./entry-preview";

export class SyncHistoryModal extends Modal {
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
export class RestoreModal extends Modal {
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
