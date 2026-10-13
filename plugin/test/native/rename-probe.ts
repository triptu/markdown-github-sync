import { Plugin, TFile } from "obsidian";

// Deliberately separate from the sync plugin: this probes the host's actual primitives.
export default class RenameProbe extends Plugin {
  onload() { this.app.workspace.onLayoutReady(() => { void this.run(); }); }
  async run() {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const vault = this.app.vault, fs = vault.adapter;
    const output = ".git-sync-rename-probe.json";
    if (await fs.exists(output)) return;
    const id = crypto.randomUUID(), root = `.git-sync-rename-probe-${id}`;
    const path = `Rename primitive ${id}.bin`, hold = `${root}/hold.bin`, stage = `${root}/stage.bin`;
    const events: { event: string; path: string; oldPath?: string }[] = [];
    const checks: { name: string; pass: boolean }[] = [];
    const check = (name: string, pass: boolean) => { checks.push({ name, pass }); if (!pass) throw Error(name); };
    const digest = async (path: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await fs.readBinary(path))), b => b.toString(16).padStart(2, "0")).join("");
    const settle = () => new Promise(resolve => setTimeout(resolve, 500));
    this.registerEvent(vault.on("create", file => { events.push({ event: "create", path: file.path }); }));
    this.registerEvent(vault.on("modify", file => { events.push({ event: "modify", path: file.path }); }));
    this.registerEvent(vault.on("delete", file => { events.push({ event: "delete", path: file.path }); }));
    this.registerEvent(vault.on("rename", (file, oldPath) => { events.push({ event: "rename", path: file.path, oldPath }); }));
    try {
      await fs.mkdir(root);
      const original = new Uint8Array(8 * 1024 * 1024), incoming = new Uint8Array(original.length);
      for (let i = 0; i < original.length; i++) { original[i] = i % 251; incoming[i] = (i + 57) % 251; }
      const file = await vault.createBinary(path, original.buffer);
      await fs.writeBinary(stage, incoming.buffer);
      const before = await digest(path), next = await digest(stage);
      await fs.rename(path, hold);
      check("8 MiB displacement preserves exact original bytes", await digest(hold) === before && !await fs.exists(path));
      await settle();
      const displacedIndex = { originalTFilePath: file.path, visiblePresent: vault.getAbstractFileByPath(path) !== null, hiddenPresent: vault.getAbstractFileByPath(hold) !== null };
      await fs.rename(stage, path);
      check("8 MiB installation preserves exact incoming bytes", await digest(path) === next && !await fs.exists(stage));
      let refused = false;
      try { await fs.rename(hold, path); } catch { refused = true; }
      check("rename refuses occupied destination without overwriting either file", refused && await digest(path) === next && await digest(hold) === before);
      await settle();
      const installed = vault.getAbstractFileByPath(path);
      check("visible vault index recovers installed binary", installed instanceof TFile && (await vault.readBinary(installed)).byteLength === incoming.length);
      const restart = { path, hold, before, next, originalTFilePath: file.path, displacedIndex, installedTFilePath: installed?.path };
      await fs.write(".git-sync-rename-probe-restart-input.json", JSON.stringify(restart));
      await fs.write(output, JSON.stringify({ completed: true, platform: "Android 15 / Obsidian 1.14.4", checks, events, ...restart }, null, 2));
    } catch (error) {
      await fs.write(output, JSON.stringify({ completed: false, checks, events, error: error instanceof Error ? error.message : String(error) }, null, 2));
    }
  }
}
