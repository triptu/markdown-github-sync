import { App, TFile } from "obsidian";
import type { VaultPort } from "./engine";

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const buffer = (a: Uint8Array): ArrayBuffer => new Uint8Array(a).buffer;

/** Obsidian has atomic text processing, but no binary compare-and-swap API.
 * Keep a local recovery copy before every replacement/deletion. */
export class ObsidianVaultPort implements VaultPort {
  constructor(private app: App) {}
  async list() {
    return this.app.vault.getFiles().map((f) => f.path);
  }
  async read(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return null;
    if (!(f instanceof TFile)) throw new Error(`A folder occupies ${path}`);
    if (f.stat.size > 8 * 1024 * 1024)
      throw new Error(`File exceeds 8 MiB: ${path}`);
    return {
      data: new Uint8Array(await this.app.vault.readBinary(f)),
      mtime: f.stat.mtime,
    };
  }
  private async folders(path: string) {
    const parts = path.split("/");
    parts.pop();
    let p = "";
    for (const part of parts) {
      p = p ? `${p}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(p))) {
        try {
          await this.app.vault.createFolder(p);
        } catch (e) {
          if (!(await this.app.vault.adapter.exists(p))) throw e;
        }
      }
    }
  }
  private async backup(path: string, data: Uint8Array) {
    const dest = `.cloud-vault-sync-recovery/${Date.now()}-${crypto.randomUUID()}/${path}`;
    await this.folders(dest);
    await this.app.vault.adapter.writeBinary(dest, buffer(data));
  }
  async write(
    path: string,
    data: Uint8Array,
    mtime: number,
    expected: Uint8Array | null,
  ) {
    await this.folders(path);
    const current = await this.read(path);
    if (expected === null) {
      if (current) return false;
      try {
        await this.app.vault.createBinary(path, buffer(data), { mtime });
        return true;
      } catch (e) {
        if (await this.read(path)) return false;
        throw e;
      }
    }
    if (!current || !same(current.data, expected)) return false;
    await this.backup(path, current.data);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    // Only losslessly decodable UTF-8 goes through the atomic text API.
    let before: string | undefined, after: string | undefined;
    try {
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      before = decoder.decode(expected);
      after = decoder.decode(data);
    } catch {
      /* Binary attachment. */
    }
    if (before !== undefined && after !== undefined) {
      let changed = false;
      await this.app.vault.process(
        file,
        (text) => {
          if (text !== before) return text;
          changed = true;
          return after!;
        },
        { mtime },
      );
      return changed;
    }
    const checked = await this.read(path);
    if (!checked || !same(checked.data, expected)) return false;
    await this.app.vault.modifyBinary(file, buffer(data), { mtime });
    return true;
  }
  async remove(path: string, expected: Uint8Array) {
    const current = await this.read(path);
    if (!current || !same(current.data, expected)) return false;
    await this.backup(path, current.data);
    const checked = await this.read(path);
    if (!checked || !same(checked.data, expected)) return false;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return false;
    await this.app.vault.trash(f, false);
    return true;
  }
}
