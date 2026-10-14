// Read-only renderings of file versions for review and conflict screens.
import { Setting } from "obsidian";
import type { Entry } from "../git-sync/contracts";
import { decodeBase64, entryText } from "../git-sync/codec";
import { diffRows } from "../conflict-view";
import { plural } from "./copy";

export function entryPreview(value: Entry | null): string {
  if (!value) return "File absent";
  const decoded = entryText(value);
  return decoded === null
    ? `Binary file · ${decodeBase64(value.data).length.toLocaleString()} bytes · ${value.oid.slice(0, 10)}`
    : decoded.slice(0, 16000) +
        (decoded.length > 16000
          ? "\n[Preview truncated; full bytes retained]"
          : "");
}
export function configurationEntryPreview(container: HTMLElement, value: Entry | null): void {
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
export function collapsible(container: HTMLElement, label: string, value: Entry | null): void {
  const details = container.createEl("details", { cls: "git-sync-group" });
  details.createEl("summary").createSpan({ text: label });
  details.createEl("pre", { text: entryPreview(value), cls: "git-sync-preview" });
}
/** Line diff between this device and GitHub, or a short note when either side isn't text. */
export function renderComparison(container: HTMLElement, local: Entry | null, remote: Entry | null): void {
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
