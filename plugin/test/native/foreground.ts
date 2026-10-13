import { Plugin, TFile } from "obsidian";
import type GitVaultSync from "../../src/main";
export default class ForegroundProbe extends Plugin {
  onload() { this.app.workspace.onLayoutReady(() => { setTimeout(() => { void this.run(); }, 3000); }); }
  async run() {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const files = this.app.vault.adapter;
    const output = '.git-sync-native-foreground-final-r2.json';
    if (await files.exists(output)) return;
    const checks: { name: string; pass: boolean }[] = [];
    const check = (name: string, pass: boolean) => { checks.push({ name, pass }); if (!pass) throw new Error(name); };
    try {
      const manager: unknown = Reflect.get(this.app, 'plugins');
      if (typeof manager !== 'object' || manager === null) throw new Error('No manager');
      const plugins: unknown = Reflect.get(manager, 'plugins');
      if (typeof plugins !== 'object' || plugins === null) throw new Error('No plugins');
      const candidate: unknown = Reflect.get(plugins, 'github-vault-sync');
      if (typeof candidate !== 'object' || candidate === null || typeof Reflect.get(candidate, 'syncNow') !== 'function') throw new Error('No production plugin');
      const plugin = candidate as GitVaultSync;
      if (plugin.settings.owner !== 'triptu' || plugin.settings.repository !== 'vault-sync-test' || plugin.settings.branch !== 'native-android-1791894436601') throw new Error('Wrong synthetic target');
      check('automatic enabled', plugin.settings.automatic);
      const before = await plugin.session?.inspect();
      check('prior journal loads after upgrade', before?.kind === 'enrolled');
      if (!this.app.vault.getAbstractFileByPath('Final r2 Phone.md')) await this.app.vault.create('Final r2 Phone.md', 'Saved through native vault API; automatic sync only.\n');
      const started = Date.now();
      let commit: string | null = null;
      while (Date.now() - started < 150000) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const status = await plugin.session?.inspect();
        await files.write('.git-sync-native-foreground-progress.json', JSON.stringify({statusText: plugin.statusText, hidden: document.hidden, ready: Reflect.get(plugin, 'ready'), status}));
        const laptop = this.app.vault.getAbstractFileByPath('Final r2 Laptop.md');
        if (status?.kind === 'enrolled' && status.phase === 'idle' && status.pending?.length === 0 && laptop instanceof TFile && await this.app.vault.read(laptop) === 'Committed on laptop while Android was closed.\n') { commit = status.commit; break; }
      }
      check('automatic independent-file convergence without Sync now', commit !== null);
      await files.write(output, JSON.stringify({ completed: true, checks, commit, elapsedMs: Date.now() - started, branch: plugin.settings.branch, device: 'Android 15 emulator', obsidian: '1.14.4' }));
    } catch (error) { await files.write('.git-sync-native-foreground-error.json', JSON.stringify({ checks, error: error instanceof Error ? error.message : 'Failed' })); }
  }
}
