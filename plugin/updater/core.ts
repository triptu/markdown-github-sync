/**
 * Self-contained update logic for the sync plugin. Kept free of Obsidian
 * imports so it can be tested, and kept small so it rarely needs updating.
 */

export const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"] as const;
export type PluginFile = (typeof PLUGIN_FILES)[number];

/** `latest.json` on the updates branch: the newest build and each file's SHA-256. */
export interface UpdateIndex {
  version: string;
  minAppVersion: string | null;
  files: Record<PluginFile, string>;
}

export function parseIndex(value: unknown): UpdateIndex {
  if (typeof value !== "object" || value === null) throw new Error("The update index isn't valid.");
  const { version, minAppVersion, files } = value as Record<string, unknown>;
  if (typeof version !== "string" || !parseVersion(version)) throw new Error("The update index has no valid version.");
  if (typeof files !== "object" || files === null) throw new Error("The update index lists no files.");
  const hashes = {} as Record<PluginFile, string>;
  for (const name of PLUGIN_FILES) {
    const hash = (files as Record<string, unknown>)[name];
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`The update index has no checksum for ${name}.`);
    hashes[name] = hash;
  }
  return { version, minAppVersion: typeof minAppVersion === "string" ? minAppVersion : null, files: hashes };
}

interface Version { core: number[]; pre: Array<number | string> }

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".").map(part => /^\d+$/.test(part) ? Number(part) : part) : [],
  };
}

/** Semver order, prereleases included: 0.3.0-beta.6 < 0.3.0-beta.10 < 0.3.0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`Can't compare versions ${a} and ${b}.`);
  for (let at = 0; at < 3; at++) if (x.core[at] !== y.core[at]) return x.core[at]! - y.core[at]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let at = 0; at < Math.max(x.pre.length, y.pre.length); at++) {
    const p = x.pre[at], q = y.pre[at];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** What the updater needs from Obsidian; a fake stands in for it in tests. */
export interface UpdateHost {
  installedVersion(): Promise<string | null>;
  appVersion(): string;
  /** A file from the public updates branch. */
  download(name: string): Promise<ArrayBuffer>;
  read(name: PluginFile): Promise<ArrayBuffer | null>;
  write(name: PluginFile, data: ArrayBuffer): Promise<void>;
  remove(name: PluginFile): Promise<void>;
  /** Waits until no sync is running, or gives up after a while. */
  idle(): Promise<boolean>;
  /** Reloads the plugin if it was enabled; true when it loaded at `version`. */
  reload(version: string): Promise<boolean>;
}

export type UpdateResult =
  | { kind: "up-to-date"; version: string }
  | { kind: "skipped"; version: string; reason: string }
  | { kind: "busy" }
  | { kind: "updated"; from: string | null; to: string }
  | { kind: "rolled-back"; version: string };

export async function checkForUpdate(host: UpdateHost, rejected: ReadonlySet<string>): Promise<UpdateResult> {
  const index = parseIndex(JSON.parse(new TextDecoder().decode(await host.download("latest.json"))));
  const installed = await host.installedVersion();
  if (installed && compareVersions(index.version, installed) <= 0) return { kind: "up-to-date", version: installed };
  if (rejected.has(index.version)) return { kind: "skipped", version: index.version, reason: "It failed to load here before." };
  if (index.minAppVersion && compareVersions(host.appVersion(), index.minAppVersion) < 0)
    return { kind: "skipped", version: index.version, reason: `It needs Obsidian ${index.minAppVersion} or newer.` };

  // Everything is downloaded and checked before a single file is touched.
  const incoming = {} as Record<PluginFile, ArrayBuffer>;
  for (const name of PLUGIN_FILES) {
    const data = await host.download(`latest/${name}`);
    if (await sha256Hex(data) !== index.files[name]) throw new Error(`The downloaded ${name} doesn't match its checksum.`);
    incoming[name] = data;
  }
  const manifest: unknown = JSON.parse(new TextDecoder().decode(incoming["manifest.json"]));
  if (typeof manifest !== "object" || manifest === null || Reflect.get(manifest, "version") !== index.version)
    throw new Error("The downloaded manifest doesn't match the update index.");

  if (!(await host.idle())) return { kind: "busy" };
  const backup = {} as Record<PluginFile, ArrayBuffer | null>;
  for (const name of PLUGIN_FILES) backup[name] = await host.read(name);
  // The manifest goes last: until it changes, Obsidian still sees the old version.
  for (const name of ["styles.css", "main.js", "manifest.json"] as const) await host.write(name, incoming[name]);
  if (await host.reload(index.version)) return { kind: "updated", from: installed, to: index.version };

  for (const name of ["styles.css", "main.js", "manifest.json"] as const) {
    const previous = backup[name];
    if (previous) await host.write(name, previous);
    else await host.remove(name);
  }
  if (installed) await host.reload(installed);
  return { kind: "rolled-back", version: index.version };
}
