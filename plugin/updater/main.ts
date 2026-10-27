import { Notice, Plugin, apiVersion, normalizePath, requestUrl } from "obsidian";
import { checkForUpdate, type PluginFile, type UpdateHost, type UpdateResult } from "./core";

const TARGET = "github-vault-sync";
const REPOSITORY = "triptu/markdown-github-sync";
const BRANCH = "updates";
const EVERY = 6 * 60 * 60 * 1000;
/** After a failed check (often a phone waking without network), try again this soon. */
const RETRY = 15 * 60 * 1000;

interface UpdaterData { rejected: string[] }

/** Obsidian's plugin manager. Unofficial API, so every use is guarded. */
interface PluginManager {
  plugins: Record<string, { syncing?: boolean; manifest?: { version?: string } } | undefined>;
  enabledPlugins: Set<string>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<boolean | void>;
  loadManifests?(): Promise<void>;
}

/** Keeps GitHub Vault Sync current from the public `updates` branch of its repository. */
export default class SyncUpdater extends Plugin {
  private data: UpdaterData = { rejected: [] };
  private checking = false;
  private checkedAt = 0;
  private failedAt = 0;

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    const rejected: unknown = saved && Reflect.get(saved, "rejected");
    if (Array.isArray(rejected)) this.data.rejected = rejected.filter((item): item is string => typeof item === "string");
    this.addCommand({ id: "check", name: "Check for GitHub Vault Sync update", callback: () => { void this.check(true); } });
    this.app.workspace.onLayoutReady(() => {
      // Let startup and the first sync settle before looking for updates.
      this.registerInterval(window.setTimeout(() => { void this.check(false); }, 20_000));
      this.registerInterval(window.setInterval(() => { if (this.due()) void this.check(false); }, 60_000));
      this.registerDomEvent(document, "visibilitychange", () => {
        if (!document.hidden && this.due()) window.setTimeout(() => { void this.check(false); }, 10_000);
      });
    });
  }

  private due(): boolean {
    const now = Date.now();
    return this.failedAt > this.checkedAt ? now - this.failedAt > RETRY : now - this.checkedAt > EVERY;
  }

  private get dir(): string { return normalizePath(`${this.app.vault.configDir}/plugins/${TARGET}`); }

  private manager(): PluginManager | null {
    const plugins: unknown = Reflect.get(this.app, "plugins");
    return plugins && typeof Reflect.get(plugins, "enablePlugin") === "function" ? plugins as PluginManager : null;
  }

  async check(manual: boolean): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const result = await checkForUpdate(this.host(), new Set(this.data.rejected));
      // A sync that kept running counts as a miss, so it's retried soon rather than in 6 hours.
      if (result.kind === "busy") this.failedAt = Date.now(); else this.checkedAt = Date.now();
      await this.report(result, manual);
    } catch (error) {
      this.failedAt = Date.now();
      // Background checks stay quiet on failure (often just offline); a manual check says why.
      if (manual) new Notice(`Couldn't check for a GitHub Vault Sync update. ${error instanceof Error ? error.message : ""}`, 8000);
      else console.warn("GitHub Vault Sync updater:", error);
    } finally {
      this.checking = false;
    }
  }

  private async report(result: UpdateResult, manual: boolean): Promise<void> {
    switch (result.kind) {
      case "updated":
        new Notice(`GitHub Vault Sync updated to ${result.to}.`, 4000);
        return;
      case "rolled-back":
        this.data.rejected = [...new Set([...this.data.rejected, result.version])];
        await this.saveData(this.data);
        new Notice(`GitHub Vault Sync ${result.version} didn't load on this device, so the previous version was restored.`, 0);
        return;
      case "skipped":
        if (manual) new Notice(`GitHub Vault Sync ${result.version} is available but wasn't installed. ${result.reason}`, 8000);
        return;
      case "busy":
        if (manual) new Notice("A sync is running. The update will be tried again later.", 6000);
        return;
      case "up-to-date":
        if (manual) new Notice(`GitHub Vault Sync is up to date (${result.version}).`, 4000);
    }
  }

  private host(): UpdateHost {
    const adapter = this.app.vault.adapter;
    const path = (name: PluginFile) => `${this.dir}/${name}`;
    const manager = this.manager();
    return {
      installedVersion: async () => {
        if (!(await adapter.exists(path("manifest.json")))) return null;
        const version: unknown = Reflect.get(JSON.parse(await adapter.read(path("manifest.json"))) ?? {}, "version");
        return typeof version === "string" ? version : null;
      },
      appVersion: () => apiVersion,
      download: async name => {
        const response = await requestUrl({ url: `https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}/${name}`, throw: false });
        if (response.status !== 200) throw new Error(`GitHub answered ${response.status}.`);
        return response.arrayBuffer;
      },
      read: async name => (await adapter.exists(path(name))) ? adapter.readBinary(path(name)) : null,
      write: async (name, data) => {
        if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
        await adapter.writeBinary(path(name), data);
      },
      remove: async name => { if (await adapter.exists(path(name))) await adapter.remove(path(name)); },
      idle: async () => {
        for (let waited = 0; waited < 120_000; waited += 2000) {
          if (!manager?.plugins[TARGET]?.syncing) return true;
          await new Promise(resolve => window.setTimeout(resolve, 2000));
        }
        return false;
      },
      reload: async version => {
        // Without the plugin manager, the new files load on the next start.
        if (!manager) return true;
        if (!manager.enabledPlugins.has(TARGET)) return true;
        await manager.disablePlugin(TARGET);
        // Obsidian caches manifests at startup; re-read them so the new version is the one loaded.
        await manager.loadManifests?.();
        await manager.enablePlugin(TARGET);
        return manager.plugins[TARGET]?.manifest?.version === version;
      },
    };
  }
}
