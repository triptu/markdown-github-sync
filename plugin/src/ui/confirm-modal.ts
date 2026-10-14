import { App, Modal, Notice, Setting } from "obsidian";
import { failure } from "./copy";

/** Title, detail and Cancel / confirm. A failed action shows its error and keeps the modal open. */
export class ConfirmModal extends Modal {
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
