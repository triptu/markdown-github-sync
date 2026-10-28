// One file changed in both places, or a save cut off mid-write: compare and choose.
import { App, Modal, Notice } from "obsidian";
import type GitVaultSync from "../main";
import type { ChoiceInput } from "../git-sync/session";
import type { Entry } from "../git-sync/contracts";
import type { VersionConflict, NativeConflict } from "../git-sync/reconcile";
import { encodeBase64, entryText } from "../git-sync/codec";
import { combinedDraft } from "../conflict-view";
import { conflictLabels, describePath, failure, formatBytes } from "./copy";
import { collapsible, renderComparison } from "./entry-preview";

export class ConflictModal extends Modal {
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
        else void this.resolve({ kind }, button);
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
