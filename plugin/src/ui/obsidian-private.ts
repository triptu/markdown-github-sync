// Obsidian APIs that work but aren't in its public typings. Each wrapper checks
// the shape at call time and degrades quietly if a release removes it.
import type { App } from "obsidian";

/** Opens Settings at the tab with `id`. False when the settings API isn't there. */
export function openSettingsTab(app: App, id: string): boolean {
  const setting: unknown = Reflect.get(app, "setting");
  const open: unknown = setting && Reflect.get(setting, "open");
  const tab: unknown = setting && Reflect.get(setting, "openTabById");
  if (typeof open !== "function" || typeof tab !== "function") return false;
  open.call(setting);
  tab.call(setting, id);
  return true;
}

/** Runs Obsidian's own "Reload app without saving" command, if present. */
export function reloadApp(app: App): void {
  const commands: unknown = Reflect.get(app, "commands");
  const run: unknown = commands && Reflect.get(commands, "executeCommandById");
  if (typeof run === "function") run.call(commands, "app:reload");
}

/** Whether a community plugin is loaded and running now, not merely listed as enabled. */
export function isPluginLoaded(app: App, id: string): boolean {
  const loaded: unknown = Reflect.get(Reflect.get(app, "plugins") ?? {}, "plugins");
  return typeof loaded === "object" && loaded !== null && id in loaded;
}
