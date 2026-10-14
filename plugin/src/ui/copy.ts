// Plain-language text for sync states, errors and paths. Pure: no Obsidian imports, so tests load it directly.
import type { SyncOutcome, EnrollmentPreview } from "../git-sync/session";

export function failure(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Sync failed. Your local files have been retained.";
}
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}
export function describeOutcome(outcome: SyncOutcome): string {
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
export function outcomeAttention(outcome: SyncOutcome): { key: string; text: string; fix?: "status" | "settings" } | null {
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
export function offline(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "retryAt") === "number") return true;
  const status = httpStatus(error);
  if (typeof status === "number") return status === 0 || status === 429 || status >= 500;
  return /transport failed|net::|network|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|UnknownHost|Unable to resolve|Failed to fetch|offline/i.test(failure(error));
}
export interface AccessTarget { owner: string; repository: string; branch: string; token?: string }
/** Per-vault, per-device record of the last working GitHub access, for the settings page. */
export interface Activity { checkedAt?: number; syncedAt?: number; problem?: string }
export function httpStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
}
/** Failures that mean the token or its repository access is wrong, not a network hiccup. */
export function rejectedAccess(error: unknown): boolean {
  if (typeof error === "object" && error !== null && typeof Reflect.get(error, "retryAt") === "number") return false;
  const status = httpStatus(error);
  return status === 401 || status === 403 || status === 404 || /credential unavailable/.test(failure(error));
}
export function accessProblem(error: unknown, target: Pick<AccessTarget, "owner" | "repository" | "branch">): string {
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
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `on ${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
export function parseRepository(value: string): { owner: string; repository: string } | null {
  const match = /^(?:(?:https?:\/\/)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value.trim());
  return match ? { owner: match[1]!, repository: match[2]! } : null;
}
/** Last sync and last verified access, or the reason access failed. */
export function describeActivity(activity: Activity): { text: string; problem: boolean } {
  if (activity.problem) return { text: `Access problem: ${activity.problem}`, problem: true };
  const parts: string[] = [];
  if (activity.syncedAt) parts.push(`Last synced ${ago(activity.syncedAt)}`);
  if (activity.checkedAt) parts.push(`${parts.length ? "access" : "Access"} verified ${ago(activity.checkedAt)}`);
  return { text: parts.join(" · "), problem: false };
}
export const reviewGroups: ReadonlyArray<readonly [EnrollmentPreview["items"][number]["action"], string, string]> = [
  ["conflict", "Changed in both places", "You'll choose which version to keep."],
  ["review-local-deletion", "Deleted on this device", "You'll confirm before they're removed from GitHub."],
  ["review-remote-deletion", "Deleted on GitHub", "You'll confirm before they're removed here."],
  ["upload", "Only on this device", "Will be added to GitHub."],
  ["download", "Only on GitHub", "Will be added to this device."],
  ["update-local", "Newer on GitHub", "Will be updated on this device."],
  ["unreadable", "Too large to sync", "Left as they are."],
  ["native-pending", "Interrupted saves", "You'll choose which version to keep."],
];
export const conflictLabels: Record<string, string> = {
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
let configDir = ".obsidian";
export function setConfigDirName(name: string): void {
  configDir = name;
}
export function configDirName(): string {
  return configDir;
}
export const settingsFiles: Record<string, string> = {
  "community-plugins.json": "Enabled community plugins",
  "core-plugins.json": "Enabled core plugins",
  "appearance.json": "Appearance",
  "hotkeys.json": "Hotkeys",
  "app.json": "Editor and files",
  "bookmarks.json": "Bookmarks",
  "graph.json": "Graph view",
};
/** `.obsidian/plugins/vikalp/main.js` → main.js in "vikalp plugin"; notes keep their folder. */
export function describePath(path: string): { name: string; place: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  if (parts[0] === configDir) {
    if (parts.length === 1 && settingsFiles[name]) return { name: settingsFiles[name], place: "Obsidian settings" };
    if (parts[1] === "plugins" && parts[2]) return { name, place: `${parts[2]} plugin` };
    if (parts[1] === "themes" && parts[2]) return { name, place: `${parts[2]} theme` };
    if (parts[1] === "snippets") return { name, place: "CSS snippet" };
    return { name, place: "Obsidian settings" };
  }
  return { name, place: parts.length ? parts.join("/") : "Vault" };
}
