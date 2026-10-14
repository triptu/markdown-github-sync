import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, compareVersions, sha256Hex, PLUGIN_FILES, type PluginFile, type UpdateHost } from "../updater/core";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (data: ArrayBuffer | null) => data === null ? null : new TextDecoder().decode(data);

async function release(version: string, tamper?: PluginFile) {
  const files: Record<string, ArrayBuffer> = {
    "main.js": bytes(`module.exports = "${version}";`),
    "manifest.json": bytes(JSON.stringify({ id: "github-vault-sync", version })),
    "styles.css": bytes(`/* ${version} */`),
  };
  const hashes: Record<string, string> = {};
  for (const name of PLUGIN_FILES) hashes[name] = await sha256Hex(files[name]!);
  if (tamper) files[tamper] = bytes("tampered");
  return { "latest.json": bytes(JSON.stringify({ version, minAppVersion: "1.11.4", files: hashes })),
    ...Object.fromEntries(Object.entries(files).map(([name, data]) => [`latest/${name}`, data])) };
}

function fakeHost(remote: Record<string, ArrayBuffer>, installed: string | null, loads = true) {
  const disk = new Map<PluginFile, ArrayBuffer>();
  if (installed) {
    disk.set("main.js", bytes(`old ${installed}`));
    disk.set("manifest.json", bytes(JSON.stringify({ id: "github-vault-sync", version: installed })));
  }
  const reloads: string[] = [];
  const host: UpdateHost = {
    token: async () => "token",
    installedVersion: async () => installed && JSON.parse(text(disk.get("manifest.json") ?? null) ?? "{}").version,
    appVersion: () => "1.12.0",
    download: async name => { const data = remote[name]; if (!data) throw new Error(`missing ${name}`); return data; },
    read: async name => disk.get(name) ?? null,
    write: async (name, data) => { disk.set(name, data); },
    remove: async name => { disk.delete(name); },
    idle: async () => true,
    reload: async version => { reloads.push(version); return loads || version === installed; },
  };
  return { host, disk, reloads };
}

test("versions order by semver, prereleases before the release", () => {
  assert.ok(compareVersions("0.3.0-beta.10", "0.3.0-beta.6") > 0);
  assert.ok(compareVersions("0.3.0", "0.3.0-beta.10") > 0);
  assert.ok(compareVersions("0.3.1-beta.1", "0.3.0") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("a newer verified release replaces the files and reloads", async () => {
  const { host, disk, reloads } = fakeHost(await release("0.3.0-beta.7"), "0.3.0-beta.6");
  assert.deepEqual(await checkForUpdate(host, new Set()), { kind: "updated", from: "0.3.0-beta.6", to: "0.3.0-beta.7" });
  assert.equal(text(disk.get("main.js") ?? null), `module.exports = "0.3.0-beta.7";`);
  assert.deepEqual(reloads, ["0.3.0-beta.7"]);
});

test("the same or older version is left alone", async () => {
  const { host, reloads } = fakeHost(await release("0.3.0-beta.6"), "0.3.0-beta.6");
  assert.deepEqual(await checkForUpdate(host, new Set()), { kind: "up-to-date", version: "0.3.0-beta.6" });
  assert.deepEqual(reloads, []);
});

test("a file that fails its checksum is never written", async () => {
  const { host, disk } = fakeHost(await release("0.3.0-beta.7", "main.js"), "0.3.0-beta.6");
  await assert.rejects(checkForUpdate(host, new Set()), /checksum/);
  assert.equal(text(disk.get("main.js") ?? null), "old 0.3.0-beta.6");
});

test("a build that fails to load is rolled back and then skipped", async () => {
  const { host, disk, reloads } = fakeHost(await release("0.3.0-beta.7"), "0.3.0-beta.6", false);
  assert.deepEqual(await checkForUpdate(host, new Set()), { kind: "rolled-back", version: "0.3.0-beta.7" });
  assert.equal(text(disk.get("main.js") ?? null), "old 0.3.0-beta.6");
  assert.equal(disk.has("styles.css"), false, "a file the old version didn't have is removed again");
  assert.deepEqual(reloads, ["0.3.0-beta.7", "0.3.0-beta.6"]);
  const again = await checkForUpdate(host, new Set(["0.3.0-beta.7"]));
  assert.equal(again.kind, "skipped");
});
