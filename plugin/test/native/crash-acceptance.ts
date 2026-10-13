import { Plugin, requestUrl } from "obsidian";
import type GitVaultSync from "../../src/main";
import { GitHubRepository } from "../../src/git-sync/github";
import { decodeBase64, entryFromBytes } from "../../src/git-sync/codec";
import type { Changes, CommitSnapshot } from "../../src/git-sync/contracts";

declare const EXPECTED_PRODUCTION_SHA: string;
declare const CRASH_POINT: "displace" | "install";
const owner = "triptu";
const repository = "vault-sync-test";
const branch = "native-android-1791894436601";
const prefix = `.git-sync-native-v2-crash-${CRASH_POINT}`;
const before = new Uint8Array([0, 255, 1, 0, 2, 0, 3]);
const after = new Uint8Array([0, 255, 4, 0, 5, 0, 6]);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

export default class NativeCrashAcceptance extends Plugin {
  onload(): void {
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => { void this.execute(); }, 2000);
    });
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const files = this.app.vault.adapter;
    if (await files.exists(`${prefix}-result.json`)) return;
    const checks: { name: string; pass: boolean }[] = [];
    const check = (name: string, pass: boolean): void => {
      checks.push({ name, pass });
      if (!pass) throw new Error(name);
    };
    let plugin: GitVaultSync | null = null;
    const originalRename = files.rename;
    let hooked = false;
    try {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
        await files.readBinary(".obsidian/plugins/github-vault-sync/main.js"))), value => value.toString(16).padStart(2, "0")).join("");
      check("installed production artifact matches", hash === EXPECTED_PRODUCTION_SHA);
      const manager: unknown = Reflect.get(this.app, "plugins");
      if (typeof manager !== "object" || manager === null) throw new Error("Plugin manager unavailable");
      const registry: unknown = Reflect.get(manager, "plugins");
      if (typeof registry !== "object" || registry === null) throw new Error("Plugin registry unavailable");
      const candidate: unknown = Reflect.get(registry, "github-vault-sync");
      if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "syncOnce") !== "function")
        throw new Error("Production plugin unavailable");
      plugin = candidate as GitVaultSync;
      check("exact synthetic target", plugin.settings.owner === owner && plugin.settings.repository === repository &&
        plugin.settings.branch === branch && plugin.settings.secretId === "git-sync-native-lab");
      const remote = new GitHubRepository({ owner, name: repository, branch, installation: crypto.randomUUID(),
        token: async () => this.app.secretStorage.getSecret("git-sync-native-lab") ?? "",
        transport: { request: async ({ url, method, headers, body }) => {
          const response = await requestUrl({ url, method, headers, body, throw: false });
          let json: unknown = null;
          try { json = JSON.parse(response.text); } catch { /* Client validates malformed responses. */ }
          return { status: response.status, headers: response.headers, json };
        } },
      });
      const publish = async (parent: CommitSnapshot, changes: Changes): Promise<string> => {
        const ledger = await remote.readLedger();
        const anchor = ledger.kind === "present" ? ledger.value : null;
        const next = await remote.prepare(parent, changes, `Native ${CRASH_POINT} crash acceptance`, { anchor, operation: crypto.randomUUID() });
        await remote.publish({ parent: parent.oid, candidate: next.oid, anchor, receipt: next.receipt });
        const receipt = await remote.readLedger();
        if (receipt.kind !== "present" || receipt.value !== next.receipt) throw new Error("Fixture publication unconfirmed; do not retry blindly");
        return next.oid;
      };
      if (await files.exists(`${prefix}-await-kill.json`)) {
        const state: unknown = JSON.parse(await files.read(`${prefix}-await-kill.json`));
        if (typeof state !== "object" || state === null) throw new Error("Invalid restart marker");
        const path: unknown = Reflect.get(state, "path");
        const commit: unknown = Reflect.get(state, "commit");
        const source: unknown = Reflect.get(state, "source");
        const destination: unknown = Reflect.get(state, "destination");
        if (typeof path !== "string" || !/^Native Crash Acceptance [0-9a-f-]{36}\.bin$/.test(path) ||
          typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || typeof source !== "string" || typeof destination !== "string")
          throw new Error("Invalid restart evidence");
        check("automatic stayed paused across process restart", !plugin.settings.automatic);
        check("completed native rename survived process restart", CRASH_POINT === "displace"
          ? !await files.exists(path) && equal(new Uint8Array(await files.readBinary(destination)), before)
          : equal(new Uint8Array(await files.readBinary(path)), after));
        await plugin.syncOnce();
        const status = await plugin.session?.inspect();
        check("recovery converges without user decision", status?.kind === "enrolled" && status.phase === "idle" && status.commit === commit &&
          status.conflicts.length === 0 && status.blocked.length === 0 && status.pending?.length === 0);
        check("replacement bytes exact after recovery", equal(new Uint8Array(await files.readBinary(path)), after));
        check("recovery did not publish another commit", (await remote.head()).oid === commit);
        let retained = false;
        const records = await plugin.session?.listRecovery();
        if (!Array.isArray(records)) throw new Error("Recovery list unavailable");
        for (const record of records) {
          if (!record.paths.includes(path)) continue;
          const snapshot = await plugin.session?.exportRecovery({ id: record.id });
          if (snapshot && !("kind" in snapshot) && snapshot[path] && equal(decodeBase64(snapshot[path].data), before)) retained = true;
        }
        check("preimage retained in durable recovery", retained);
        await plugin.saveConfiguration({ ...plugin.settings, automatic: true });
        await files.write(`${prefix}-result.json`, JSON.stringify({ completed: true, point: CRASH_POINT, checks, path, commit, productionSha256: hash }));
        return;
      }
      await plugin.saveConfiguration({ ...plugin.settings, automatic: false });
      await plugin.syncOnce();
      const status = await plugin.session?.inspect();
      check("clean enrolled starting point", status?.kind === "enrolled" && status.phase === "idle" && status.conflicts.length === 0);
      const path = `Native Crash Acceptance ${crypto.randomUUID()}.bin`;
      check("fresh fixture path", !await files.exists(path));
      await publish(await remote.head(), { [path]: await entryFromBytes(before) });
      await plugin.syncOnce();
      check("seed downloaded exactly", equal(new Uint8Array(await files.readBinary(path)), before));
      const commit = await publish(await remote.head(), { [path]: await entryFromBytes(after) });
      files.rename = async (source, destination) => {
        await originalRename.call(files, source, destination);
        const target = CRASH_POINT === "displace" ? source === path : destination === path;
        if (!target) return;
        await files.write(`${prefix}-await-kill.json`, JSON.stringify({ path, commit, source, destination, point: CRASH_POINT, checks, productionSha256: hash }));
        // The parent force-stops the entire app here, before the production call returns.
        await new Promise<void>(() => {});
      };
      hooked = true;
      await plugin.syncOnce();
      throw new Error("Expected rename boundary was not reached");
    } catch (error) {
      await files.write(`${prefix}-result.json`, JSON.stringify({ completed: false, point: CRASH_POINT, checks,
        error: error instanceof Error ? error.message : "Unknown failure", productionSha256: EXPECTED_PRODUCTION_SHA }));
    } finally {
      if (hooked) files.rename = originalRename;
    }
  }
}
