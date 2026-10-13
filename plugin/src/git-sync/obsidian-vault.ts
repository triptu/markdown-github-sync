import { App, TFile } from "obsidian";
import { entryFromBytes as entry, decodeBase64 as decode } from "./codec";
import type {
  ApplyResult,
  Entry,
  LocalVault,
  Snapshot,
} from "./contracts";

import type { NativeModes } from "./native-modes";

const maxFileBytes = 8 * 1024 * 1024;
const maxVaultBytes = 128 * 1024 * 1024;
const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
function visible(path: string): boolean {
  return path.split("/").every((part) => !part.startsWith("."));
}
function safePath(path: string): void {
  if (
    !path ||
    !visible(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) ||
    /[\\:\x00-\x1f\x7f]/.test(path)
  )
    throw new Error(`Unsupported vault path: ${path}`);
}
export class GitObsidianVault implements LocalVault {
  constructor(
    private app: App,
    private modes: NativeModes = { get: () => "100644", set: () => {} },
    private assertActive: () => void = () => {},
  ) {}
  private async read(path: string): Promise<Uint8Array | null> {
    this.assertActive();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`A folder occupies ${path}`);
    if (file.stat.size > maxFileBytes)
      throw new Error(`File exceeds 8 MiB: ${path}`);
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    if (bytes.length > maxFileBytes)
      throw new Error(`File exceeds 8 MiB: ${path}`);
    return bytes;
  }
  async capture(): Promise<Snapshot> {
    this.assertActive();
    await this.modes.recover?.(async path => {
      const bytes = await this.read(path);
      return bytes === null ? null : (await entry(bytes)).oid;
    });
    const files = this.app.vault
      .getFiles()
      .filter((file) => visible(file.path));
    const snapshot: Snapshot = Object.create(null);
    const paths = new Set<string>();
    let total = 0;
    for (const file of files) {
      safePath(file.path);
      const folded = file.path.normalize("NFC").toLowerCase();
      if (paths.has(folded))
        throw new Error(`Case or Unicode path collision: ${file.path}`);
      paths.add(folded);
      const bytes = await this.read(file.path);
      if (!bytes)
        throw new Error("The vault changed during capture. Sync will retry.");
      total += bytes.length;
      if (total > maxVaultBytes)
        throw new Error("Vault content exceeds the 128 MiB safety limit.");
      snapshot[file.path] = await entry(bytes, this.modes.get(file.path));
    }
    return snapshot;
  }
  private async folders(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(prefix))) {
        try {
          this.assertActive();
          await this.app.vault.createFolder(prefix);
        } catch (error) {
          if (!(await this.app.vault.adapter.exists(prefix))) throw error;
        }
      }
    }
  }
  async apply(
    path: string,
    expected: Entry | null,
    next: Entry | null,
  ): Promise<ApplyResult> {
    safePath(path);
    await this.modes.recover?.(async pendingPath => {
      const bytes = await this.read(pendingPath);
      return bytes === null ? null : (await entry(bytes)).oid;
    });
    const current = await this.read(path);
    if (next && current && bytesEqual(current, decode(next.data))) {
      this.assertActive();
      await this.modes.set(path, next.mode);
      return { kind: "applied" };
    }
    if (!next && !current) return { kind: "applied" };
    if (
      expected
        ? !current || !bytesEqual(current, decode(expected.data))
        : current !== null
    )
      return { kind: "changed" };
    if (!next)
      return {
        kind: "blocked",
        reason: `Deletion of ${path} needs a controlled manual apply. Automatic trash cannot safely compare and delete on this platform.`,
      };
    const bytes = decode(next.data);
    if (bytes.length > maxFileBytes || (await entry(bytes)).oid !== next.oid)
      throw new Error(`Invalid incoming bytes: ${path}`);
    if (!this.modes.begin && next.mode !== this.modes.get(path))
      return { kind: "blocked", reason: `Mode-changing update of ${path} requires a durable native mode journal.` };
    if (!expected) {
      await this.folders(path);
      await this.modes.begin?.(path, expected, next);
      try {
        this.assertActive();
        await this.app.vault.createBinary(path, new Uint8Array(bytes).buffer);
      } catch (error) {
        if (await this.read(path)) return { kind: "changed" };
        throw error;
      }
      this.assertActive();
      await this.modes.set(path, next.mode);
      return { kind: "applied" };
    }
    if (!/\.md$/i.test(path))
      return {
        kind: "blocked",
        reason: `Replacement of ${path} is held because the vault API has no atomic binary replacement. Original and incoming bytes remain in recovery.`,
      };
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let before: string, after: string;
    try {
      before = decoder.decode(decode(expected.data));
      after = decoder.decode(bytes);
      if (
        !bytesEqual(new TextEncoder().encode(before), decode(expected.data)) ||
        !bytesEqual(new TextEncoder().encode(after), bytes)
      )
        throw new Error("Lossy text");
    } catch {
      return {
        kind: "blocked",
        reason: `Non-UTF-8 note ${path} cannot be replaced atomically.`,
      };
    }
    this.assertActive();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { kind: "changed" };
    await this.modes.begin?.(path, expected, next);
    let changed = false;
    this.assertActive();
    await this.app.vault.process(file, (text) => {
      this.assertActive();
      if (text !== before) return text;
      changed = true;
      return after;
    });
    this.assertActive();
    if (changed) await this.modes.set(path, next.mode);
    else await this.modes.cancel?.(path);
    return { kind: changed ? "applied" : "changed" };
  }
}
