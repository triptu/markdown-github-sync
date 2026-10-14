// Review of Obsidian settings sync: incoming updates to apply, and local files waiting for consent to upload.
import { App, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import type GitVaultSync from "../main";
import type { Entry } from "../git-sync/contracts";
import { configDirName, describePath, failure, plural } from "./copy";
import { collapsible, configurationEntryPreview } from "./entry-preview";
import { isPluginLoaded, reloadApp } from "./obsidian-private";

export class ConfigurationModal extends Modal {
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
            .addButton(button => button.setButtonText("Review").setDisabled(item.unreadable).onClick(() => this.approve(button, current, {
              preview: () => session.previewGuardedConfigurationPublication(item.path),
              consent: input => session.consentGuardedConfigurationPublication(input),
              detail: entry => entry === null
                ? "Deleted here after an update. Approving removes it from GitHub too."
                : "This version would replace the one on GitHub.",
              approveText: entry => entry === null ? "Remove from GitHub" : "Upload this version",
            })));
        }
      }
      const unpublished = el.createDiv();
      if (listing.unpublished.length) {
        new Setting(unpublished).setName(`New on this device · ${listing.unpublished.length}`).setHeading()
          .setDesc("These upload only after you approve each one. Check them for passwords or API keys first.");
      }
      for (const item of listing.unpublished) {
        new Setting(unpublished).setName(item.path).addButton(button => button.setButtonText("Review").onClick(() => this.approve(button, current, {
          preview: () => session.previewHiddenPublication(item.path),
          consent: input => session.consentHiddenPublication(input),
          approveText: () => "Upload this version",
        })));
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
      const pluginsDir = `${configDirName()}/plugins/`;
      const running = [...new Set(preview.items.map(item => item.path.startsWith(pluginsDir) ? item.path.slice(pluginsDir.length).split("/")[0] : undefined).filter((id): id is string =>
        id !== undefined && id !== this.plugin.manifest.id && isPluginLoaded(this.app, id)))];
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
            .addButton(reload => reload.setButtonText("Reload Obsidian").setCta().onClick(() => reloadApp(this.app)));
        } catch (error) { new Notice(failure(error), 12000); button.setDisabled(false); }
      }));
      apply.settingEl.addClass("git-sync-footer");
    } catch (error) { if (current()) el.createEl("p", { text: failure(error) }); }
  }
  /**
   * One settings file held for consent: preview it, show it, and on approval
   * record consent, sync and redraw. A preview that changed meanwhile fails
   * instead of uploading something the person didn't see.
   */
  private async approve(button: ButtonComponent, current: () => boolean, flow: ApprovalFlow): Promise<void> {
    button.setDisabled(true);
    try {
      const preview = await flow.preview();
      if (!current()) return;
      if (!isPublication(preview)) throw new Error("This file changed. Close and try again.");
      new ApprovalModal(this.app, {
        title: preview.path,
        detail: flow.detail?.(preview.entry),
        entry: preview.entry,
        approveText: flow.approveText(preview.entry),
        approve: async () => {
          if (!current()) throw new Error("Something changed. Close and try again.");
          const result = await flow.consent({ path: preview.path, token: preview.token });
          if (result.kind !== "recorded") throw new Error("This file changed. Close and try again.");
        },
        approved: async () => { await this.plugin.syncNow(); await this.render(); },
      }).open();
    } catch (error) { new Notice(failure(error), 12000); }
    finally { button.setDisabled(false); }
  }
}
interface Publication { kind: "preview"; path: string; token: string; entry: Entry | null }
function isPublication(value: { kind: string }): value is Publication {
  return value.kind === "preview";
}
interface ApprovalFlow {
  preview(): Promise<{ kind: string }>;
  consent(input: { path: string; token: string }): Promise<{ kind: string }>;
  detail?(entry: Entry | null): string;
  approveText(entry: Entry | null): string;
}
/** One file's contents and a single approve button. Closes once `approve` succeeds, then runs `approved`. */
class ApprovalModal extends Modal {
  constructor(app: App, private options: {
    title: string;
    detail?: string;
    entry: Entry | null;
    approveText: string;
    approve(): Promise<void>;
    approved(): Promise<void>;
  }) { super(app); }
  onOpen(): void {
    const el = this.contentEl;
    const options = this.options;
    el.addClass("git-sync-panel");
    el.createEl("h2", { text: options.title });
    if (options.detail !== undefined) el.createEl("p", { text: options.detail });
    configurationEntryPreview(el, options.entry);
    new Setting(el).addButton(approve => approve.setButtonText(options.approveText).setCta().onClick(async () => {
      approve.setDisabled(true);
      try {
        await options.approve();
        this.close(); await options.approved();
      } catch (error) { new Notice(failure(error), 12000); approve.setDisabled(false); }
    }));
  }
}
