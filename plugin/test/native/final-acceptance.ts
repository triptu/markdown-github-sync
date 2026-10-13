import { Platform, Plugin, requestUrl, TFile } from "obsidian";
import type GitVaultSync from "../../src/main";
import { decodeBase64, entryFromBytes, entryFromText } from "../../src/git-sync/codec";
import type { Changes, CommitSnapshot, PreparedPublication } from "../../src/git-sync/contracts";
import { GitHubRepository } from "../../src/git-sync/github";
import { hostLifetimeId } from "../../src/git-sync/ownership";

declare const ACCEPTANCE_RUN_ID: string;
declare const ACCEPTANCE_BRANCH: string;
declare const EXPECTED_PRODUCTION_SHA: string;
declare const DESKTOP_VAULT_PATH: string;
declare const ANDROID_VAULT_PATH: string;

const owner = "triptu";
const repository = "vault-sync-test";
const root = `.native-final-acceptance/${ACCEPTANCE_RUN_ID}`;
const seedPath = `Final Acceptance ${ACCEPTANCE_RUN_ID}/Seed.md`;
const fixtureDirectory = `Final Acceptance ${ACCEPTANCE_RUN_ID}`;
const initialText = `Final acceptance seed ${ACCEPTANCE_RUN_ID}\n`;
const autoRemoteText = `Automatic GitHub edit ${ACCEPTANCE_RUN_ID}\n`;
const autoLocalText = `Automatic native edit ${ACCEPTANCE_RUN_ID}\n`;
const editorBefore = `Edit this visible note in Obsidian and save it.\n`;
const editorAfter = `Edited and saved in Obsidian for final acceptance ${ACCEPTANCE_RUN_ID}.\n`;
const baseText = `Common version ${ACCEPTANCE_RUN_ID}\n`;
const localText = `Local conflicting version ${ACCEPTANCE_RUN_ID}\n`;
const remoteText = `GitHub conflicting version ${ACCEPTANCE_RUN_ID}\n`;
const resolvedText = `Reviewed merged version ${ACCEPTANCE_RUN_ID}\n`;
const removedText = `Delete me from GitHub ${ACCEPTANCE_RUN_ID}\n`;
const localIndependentText = `Independent local edit ${ACCEPTANCE_RUN_ID}\n`;
const remoteIndependentText = `Independent GitHub edit ${ACCEPTANCE_RUN_ID}\n`;
const binaryBefore = new Uint8Array([0, 255, 17, 35, 68, 0, 201, 10]);
const binaryAfter = new Uint8Array([0, 255, 17, 35, 69, 0, 202, 10]);
type Device = "desktop" | "android";
type Stage = "auto-running" | "await-restart" | "await-editor" | "controlled" | "complete";
type Check = { name: string; pass: boolean };
type State = {
  format: 1;
  runId: string;
  branch: string;
  device: Device;
  productionSha256: string;
  stage: Stage;
  firstHost: string;
  originalAutomatic: boolean;
  checks: Check[];
  commits: Record<string, string>;
};
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

async function prepareFixture(remote: GitHubRepository, parent: CommitSnapshot, changes: Changes, message: string) {
  const ledger = await remote.readLedger();
  const anchor = ledger.kind === "present" ? ledger.value : null;
  const candidate = await remote.prepare(parent, changes, message, { anchor, operation: crypto.randomUUID() });
  return { ...candidate, anchor, parent: parent.oid };
}
async function publishFixture(remote: GitHubRepository, candidate: PreparedPublication & { anchor: string | null; parent: string }): Promise<void> {
  await remote.publish({ parent: candidate.parent, candidate: candidate.oid, anchor: candidate.anchor, receipt: candidate.receipt });
  const ledger = await remote.readLedger();
  if (ledger.kind !== "present" || ledger.value !== candidate.receipt) throw new Error("Fixture publication was not confirmed");
}

export default class NativeFinalAcceptance extends Plugin {
  private running = false;

  onload(): void {
    this.addCommand({ id: "run-next", name: "Run next disposable final acceptance stage", callback: () => { void this.run(); } });
  }

  private check(state: State, name: string, pass: boolean): void {
    state.checks.push({ name, pass });
    if (!pass) throw new Error(name);
  }

  private device(): Device {
    const device: Device = Platform.isMobile ? "android" : "desktop";
    const expected = device === "desktop" ? DESKTOP_VAULT_PATH : ANDROID_VAULT_PATH;
    const adapter = this.app.vault.adapter;
    const getBasePath: unknown = Reflect.get(adapter, "getBasePath");
    if (typeof getBasePath !== "function") throw new Error("Native vault path unavailable; refusing to run");
    const actual: unknown = Reflect.apply(getBasePath, adapter, []);
    if (actual !== expected || this.app.vault.getName() !== expected.split("/").at(-1) ||
        actual === "/sdcard/Documents/Vault Sync Lab")
      throw new Error("This is not the exact disposable acceptance vault");
    return device;
  }

  private async hash(path: string): Promise<string> {
    const bytes = await this.app.vault.adapter.readBinary(path);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private production(): GitVaultSync {
    const manager: unknown = Reflect.get(this.app, "plugins");
    const installed: unknown = typeof manager === "object" && manager !== null ? Reflect.get(manager, "plugins") : null;
    const candidate: unknown = typeof installed === "object" && installed !== null ? Reflect.get(installed, "github-vault-sync") : null;
    if (typeof candidate !== "object" || candidate === null ||
        typeof Reflect.get(candidate, "syncOnce") !== "function" ||
        typeof Reflect.get(candidate, "saveConfiguration") !== "function" ||
        typeof Reflect.get(candidate, "fileHistory") !== "function")
      throw new Error("Installed production plugin is not enabled");
    return candidate as GitVaultSync;
  }

  private async remote(device: Device): Promise<GitHubRepository> {
    const secretId = `git-sync-final-${ACCEPTANCE_RUN_ID}-${device}`;
    const remote = new GitHubRepository({ owner, name: repository, branch: ACCEPTANCE_BRANCH,
      installation: crypto.randomUUID(), scopeRules: "visible-only",
      token: async () => this.app.secretStorage.getSecret(secretId) ?? "",
      transport: { request: async ({ url, method, headers, body }) => {
        const response = await requestUrl({ url, method, headers, body, throw: false });
        let json: unknown = null;
        try { json = JSON.parse(response.text); } catch { /* Repository validates malformed responses. */ }
        return { status: response.status, headers: response.headers, json };
      } },
    });
    const identity = await remote.identity();
    if (identity.owner.toLowerCase() !== owner || identity.name !== repository || identity.branch !== ACCEPTANCE_BRANCH)
      throw new Error("Wrong private lab repository identity");
    return remote;
  }

  private async writeState(state: State): Promise<void> {
    await this.app.vault.adapter.write(`${root}/state-${state.device}.json`, JSON.stringify(state, null, 2));
  }

  private async stage(state: State, next: Stage): Promise<void> {
    state.stage = next;
    await this.writeState(state);
    await this.app.vault.adapter.write(`${root}/${state.device}-${next}.json`, JSON.stringify({
      runId: state.runId, stage: next, productionSha256: state.productionSha256,
      checks: state.checks, commits: state.commits,
    }, null, 2));
  }

  private async loadState(device: Device): Promise<State | null> {
    const path = `${root}/state-${device}.json`;
    if (!await this.app.vault.adapter.exists(path)) return null;
    const value: unknown = JSON.parse(await this.app.vault.adapter.read(path));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid final acceptance state");
    const candidate = value as Record<string, unknown>;
    if (candidate.format !== 1 || candidate.runId !== ACCEPTANCE_RUN_ID || candidate.branch !== ACCEPTANCE_BRANCH ||
        candidate.device !== device || candidate.productionSha256 !== EXPECTED_PRODUCTION_SHA ||
        !["auto-running", "await-restart", "await-editor", "controlled", "complete"].includes(String(candidate.stage)) ||
        typeof candidate.firstHost !== "string" || typeof candidate.originalAutomatic !== "boolean" ||
        !Array.isArray(candidate.checks) || typeof candidate.commits !== "object" || candidate.commits === null)
      throw new Error("Final acceptance state does not match this bundle");
    return value as State;
  }

  private async assertEmptyVisibleVault(): Promise<void> {
    const files = this.app.vault.adapter;
    const walk = async (directory: string): Promise<void> => {
      const listed = await files.list(directory);
      for (const path of listed.files) {
        const relative = path.replace(/^\/+/, "");
        if (!relative.startsWith(".obsidian/") && !relative.startsWith(".native-final-acceptance/") &&
            !relative.startsWith(".git-vault-sync/"))
          throw new Error(`Disposable vault contains pre-existing visible file: ${path}`);
      }
      for (const path of listed.folders) {
        const relative = path.replace(/^\/+/, "");
        if (relative === ".obsidian" || relative === ".native-final-acceptance" || relative === ".git-vault-sync") continue;
        await walk(path);
      }
    };
    await walk("/");
  }

  private async provision(device: Device, plugin: GitVaultSync): Promise<State> {
    if (plugin.settings.owner || plugin.settings.repository || plugin.settings.secretId || plugin.session)
      throw new Error("Production plugin is already configured; use a fresh disposable vault");
    await this.assertEmptyVisibleVault();
    const response = await requestUrl({ url: `http://127.0.0.1:37921/bootstrap/${ACCEPTANCE_RUN_ID}/${device}` });
    const raw: unknown = JSON.parse(response.text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid loopback bootstrap");
    const bootstrap = raw as Record<string, unknown>;
    if (bootstrap.owner !== owner || bootstrap.repository !== repository || bootstrap.branch !== ACCEPTANCE_BRANCH ||
        bootstrap.runId !== ACCEPTANCE_RUN_ID || bootstrap.device !== device ||
        typeof bootstrap.token !== "string" || bootstrap.token.length < 20)
      throw new Error("Loopback bootstrap does not match this run");
    const secretId = `git-sync-final-${ACCEPTANCE_RUN_ID}-${device}`;
    this.app.secretStorage.setSecret(secretId, bootstrap.token);
    await plugin.saveConfiguration({ format: 2, owner, repository, branch: ACCEPTANCE_BRANCH, secretId,
      deviceName: `Final acceptance ${device}`, automatic: true, configuration: false });
    if (!plugin.session) throw new Error("Production session failed to initialize");
    const remote = await this.remote(device);
    const head = await remote.head();
    if (head.files[seedPath]?.data !== btoa(initialText) ||
        Object.keys(head.files).some(path => !path.startsWith(`${fixtureDirectory}/`)))
      throw new Error("Synthetic branch contains unexpected files or changed seed");
    const active = this.production();
    if (!active.session) throw new Error("Production session failed to initialize");
    const preview = await active.session.previewEnrollment();
    if (preview.kind !== "preview" || preview.repository.branch !== ACCEPTANCE_BRANCH ||
        preview.items.length !== Object.keys(head.files).length ||
        preview.items.some(item => item.action !== "download" || !head.files[item.path]))
      throw new Error("Enrollment preview contains unexpected vault changes");
    if ((await active.session.enroll({ token: preview.token })).kind !== "enrolled")
      throw new Error("Production enrollment failed");
    await plugin.syncOnce();
    const seed = this.app.vault.getAbstractFileByPath(seedPath);
    if (!(seed instanceof TFile) || await this.app.vault.read(seed) !== initialText)
      throw new Error("Production did not install exact seed bytes");
    const state: State = { format: 1, runId: ACCEPTANCE_RUN_ID, branch: ACCEPTANCE_BRANCH, device,
      productionSha256: EXPECTED_PRODUCTION_SHA, stage: "auto-running",
      firstHost: hostLifetimeId(this.app), originalAutomatic: true,
      checks: [{ name: "exact private branch enrolled through installed production plugin", pass: true }],
      commits: { seed: head.oid } };
    await this.writeState(state);
    return state;
  }

  private async automatic(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const device = state.device;
    const local = `${fixtureDirectory}/${device}-automatic-local.md`;
    const incoming = `${fixtureDirectory}/${device}-automatic-remote.md`;
    const head = await remote.head();
    this.check(state, "automatic fixture paths fresh", !head.files[local] && !head.files[incoming] &&
      !this.app.vault.getAbstractFileByPath(local) && !this.app.vault.getAbstractFileByPath(incoming));
    const fixture = await prepareFixture(remote, head, { [incoming]: await entryFromText(autoRemoteText) },
      `Final automatic remote fixture ${ACCEPTANCE_RUN_ID} ${device}`);
    await publishFixture(remote, fixture);
    state.commits.autoRemote = fixture.oid;
    await this.writeState(state);
    await this.app.vault.create(local, autoLocalText);
    const deadline = Date.now() + 180_000;
    let converged = false;
    while (Date.now() < deadline) {
      const current = await remote.head();
      const status = await plugin.session?.inspect();
      const received = this.app.vault.getAbstractFileByPath(incoming);
      converged = current.files[local]?.data === btoa(autoLocalText) &&
        current.files[incoming]?.data === btoa(autoRemoteText) &&
        status?.kind === "enrolled" && status.commit === current.oid &&
        status.pause === null && status.conflicts.length === 0 && status.blocked.length === 0 &&
        received instanceof TFile && await this.app.vault.read(received) === autoRemoteText;
      if (converged) { state.commits.autoConverged = current.oid; break; }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    this.check(state, "foreground automatic local and GitHub edits converged without Sync now", converged);
    await this.stage(state, "await-restart");
  }

  private async afterRestart(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    this.check(state, "new Obsidian host after full restart", hostLifetimeId(this.app) !== state.firstHost);
    const head = await remote.head();
    const status = await plugin.session?.inspect();
    const incoming = this.app.vault.getAbstractFileByPath(`${fixtureDirectory}/${state.device}-automatic-remote.md`);
    const local = this.app.vault.getAbstractFileByPath(`${fixtureDirectory}/${state.device}-automatic-local.md`);
    this.check(state, "automatic checkpoint and bytes survive restart", status?.kind === "enrolled" &&
      status.commit === head.oid && status.pause === null && status.conflicts.length === 0 &&
      incoming instanceof TFile && local instanceof TFile &&
      await this.app.vault.read(incoming) === autoRemoteText && await this.app.vault.read(local) === autoLocalText &&
      head.files[local.path]?.data === btoa(autoLocalText) && head.files[incoming.path]?.data === btoa(autoRemoteText));
    await plugin.saveConfiguration({ ...plugin.settings, automatic: false });
    this.check(state, "automatic paused for ordinary saved-edit case", !plugin.settings.automatic);
    const editorPath = `${fixtureDirectory}/${state.device}-editor.md`;
    this.check(state, "visible editor fixture path fresh", !head.files[editorPath] && !this.app.vault.getAbstractFileByPath(editorPath));
    await this.app.vault.create(editorPath, editorBefore);
    await this.stage(state, "await-editor");
  }

  private async editor(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const path = `${fixtureDirectory}/${state.device}-editor.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    this.check(state, "visible Markdown edit was saved to native vault bytes",
      file instanceof TFile && await this.app.vault.read(file) === editorAfter);
    await plugin.syncOnce();
    const head = await remote.head();
    this.check(state, "ordinary saved Markdown edit published through production sync",
      head.files[path]?.data === btoa(editorAfter));
    state.commits.editor = head.oid;
    await this.stage(state, "controlled");
  }

  private async controlled(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const prefix = `${fixtureDirectory}/${state.device}`;
    const overlap = `${prefix}-overlap.md`;
    const binary = `${prefix}-attachment.bin`;
    const removed = `${prefix}-deleted.md`;
    const localIndependent = `${prefix}-independent-local.md`;
    const remoteIndependent = `${prefix}-independent-remote.md`;
    const paths = [overlap, binary, removed, localIndependent, remoteIndependent];
    const before = await remote.head();
    this.check(state, "controlled fixture paths fresh", paths.every(path => !before.files[path] && !this.app.vault.getAbstractFileByPath(path)));
    const seeded = await prepareFixture(remote, before, {
      [overlap]: await entryFromText(baseText), [binary]: await entryFromBytes(binaryBefore),
      [removed]: await entryFromText(removedText),
    }, `Final controlled seed ${ACCEPTANCE_RUN_ID} ${state.device}`);
    await publishFixture(remote, seeded);
    state.commits.controlledSeed = seeded.oid;
    await this.writeState(state);
    await plugin.syncOnce();
    const overlapFile = this.app.vault.getAbstractFileByPath(overlap);
    const binaryFile = this.app.vault.getAbstractFileByPath(binary);
    const removedFile = this.app.vault.getAbstractFileByPath(removed);
    this.check(state, "remote text and binary seed installed by production", overlapFile instanceof TFile &&
      binaryFile instanceof TFile && removedFile instanceof TFile &&
      await this.app.vault.read(overlapFile) === baseText &&
      bytesEqual(new Uint8Array(await this.app.vault.readBinary(binaryFile)), binaryBefore) &&
      await this.app.vault.read(removedFile) === removedText);
    await this.app.vault.create(localIndependent, localIndependentText);
    const independent = await prepareFixture(remote, await remote.head(), {
      [remoteIndependent]: await entryFromText(remoteIndependentText),
    }, `Final independent remote edit ${ACCEPTANCE_RUN_ID} ${state.device}`);
    await publishFixture(remote, independent);
    await plugin.syncOnce();
    const joined = await remote.head();
    const received = this.app.vault.getAbstractFileByPath(remoteIndependent);
    this.check(state, "ordinary nonconflicting local and remote edits converged", joined.files[localIndependent]?.data === btoa(localIndependentText) &&
      joined.files[remoteIndependent]?.data === btoa(remoteIndependentText) && received instanceof TFile &&
      await this.app.vault.read(received) === remoteIndependentText);
    state.commits.independent = joined.oid;

    if (!(overlapFile instanceof TFile)) throw new Error("Overlap fixture unavailable");
    await this.app.vault.modify(overlapFile, localText);
    await plugin.notifyLocalChange();
    const competing = await prepareFixture(remote, joined, { [overlap]: await entryFromText(remoteText) },
      `Final competing edit ${ACCEPTANCE_RUN_ID} ${state.device}`);
    await publishFixture(remote, competing);
    await plugin.syncOnce();
    const review = await plugin.session?.inspect();
    const conflict = review?.kind === "enrolled" ? review.conflicts.find(item => "path" in item && item.path === overlap) : undefined;
    this.check(state, "same-file conflict appears without clobbering local bytes", review?.kind === "enrolled" &&
      conflict?.kind === "content" && await this.app.vault.read(overlapFile) === localText);
    if (!conflict) throw new Error("Conflict unavailable");
    this.check(state, "reviewed conflict decision recorded", (await plugin.session?.resolve({
      conflictId: conflict.id, choice: { kind: "edit", data: btoa(resolvedText) },
    }))?.kind === "recorded");
    await plugin.syncOnce();
    const resolved = await remote.head();
    this.check(state, "reviewed merged bytes published and installed", resolved.files[overlap]?.data === btoa(resolvedText) &&
      await this.app.vault.read(overlapFile) === resolvedText);
    state.commits.resolved = resolved.oid;

    const incoming = await prepareFixture(remote, resolved, {
      [binary]: await entryFromBytes(binaryAfter), [removed]: null,
    }, `Final binary replacement and deletion ${ACCEPTANCE_RUN_ID} ${state.device}`);
    await publishFixture(remote, incoming);
    await plugin.syncOnce();
    const replacement = this.app.vault.getAbstractFileByPath(binary);
    const applied = await remote.head();
    this.check(state, "remote binary replacement exact and deletion applied", replacement instanceof TFile &&
      bytesEqual(new Uint8Array(await this.app.vault.readBinary(replacement)), binaryAfter) &&
      !await this.app.vault.adapter.exists(removed) && !applied.files[removed] &&
      bytesEqual(decodeBase64(applied.files[binary]?.data ?? ""), binaryAfter) && applied.oid === incoming.oid);
    state.commits.binaryDelete = applied.oid;

    const history = await plugin.fileHistory({ path: overlap });
    this.check(state, "production history includes original fixture commit", history.entries.some(item => item.commit === seeded.oid));
    const preview = await plugin.session?.previewRestore({ path: overlap, commit: seeded.oid });
    this.check(state, "production history restore preview has exact versions", preview?.kind === "preview" &&
      preview.historical.data === btoa(baseText) && preview.current?.data === btoa(resolvedText));
    if (preview?.kind !== "preview") throw new Error("Restore preview unavailable");
    this.check(state, "reviewed historical version restored as local draft", (await plugin.session?.restore({
      token: preview.token, path: overlap, commit: seeded.oid,
    }))?.kind === "restored");
    await plugin.syncOnce();
    const restored = await remote.head();
    const status = await plugin.session?.inspect();
    this.check(state, "history restore published exact old bytes as new commit", restored.oid !== seeded.oid &&
      restored.files[overlap]?.data === btoa(baseText) && await this.app.vault.read(overlapFile) === baseText &&
      status?.kind === "enrolled" && status.commit === restored.oid && status.pause === null &&
      status.conflicts.length === 0 && status.blocked.length === 0);
    state.commits.restored = restored.oid;
    await plugin.saveConfiguration({ ...plugin.settings, automatic: state.originalAutomatic });
    this.check(state, "automatic setting restored", plugin.settings.automatic === state.originalAutomatic);
    await this.stage(state, "complete");
    await this.writeSuccess(state, status?.kind === "enrolled" ? status.phase : null,
      status?.kind === "enrolled" ? status.pending : null);
  }

  private async writeSuccess(state: State, finalPhase: string | null, pending: unknown): Promise<void> {
    await this.app.vault.adapter.write(`${root}/${state.device}-result.json`, JSON.stringify({
      completed: true, runId: state.runId, device: state.device, branch: state.branch,
      productionSha256: state.productionSha256, checks: state.checks, commits: state.commits,
      finalPhase, pending,
    }, null, 2));
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let device: Device | null = null;
    let state: State | null = null;
    try {
      device = this.device(); // No vault write before the exact physical path guard.
      const files = this.app.vault.adapter;
      if (!await files.exists(".native-final-acceptance")) await files.mkdir(".native-final-acceptance");
      if (!await files.exists(root)) await files.mkdir(root);
      const resultPath = `${root}/${device}-result.json`;
      if (await files.exists(resultPath)) return; // A failed run is immutable; build a new UUID.
      if (await this.hash(".obsidian/plugins/github-vault-sync/main.js") !== EXPECTED_PRODUCTION_SHA)
        throw new Error("Installed production bundle hash differs from build-time SHA-256");
      const plugin = this.production();
      state = await this.loadState(device);
      if (state === null) {
        state = await this.provision(device, plugin);
        const remote = await this.remote(device);
        await this.automatic(state, plugin, remote);
        return;
      }
      if (plugin.settings.owner !== owner || plugin.settings.repository !== repository ||
          plugin.settings.branch !== ACCEPTANCE_BRANCH ||
          plugin.settings.secretId !== `git-sync-final-${ACCEPTANCE_RUN_ID}-${device}` ||
          !this.app.secretStorage.getSecret(plugin.settings.secretId) || !plugin.session)
        throw new Error("Production configuration or credential differs from this run");
      const remote = await this.remote(device);
      switch (state.stage) {
        case "auto-running": throw new Error("Automatic stage was interrupted; preserve evidence and build a fresh run");
        case "await-restart": await this.afterRestart(state, plugin, remote); break;
        case "await-editor": await this.editor(state, plugin, remote); break;
        case "controlled": await this.controlled(state, plugin, remote); break;
        case "complete": {
          const status = await plugin.session?.inspect();
          const head = await remote.head();
          if (status?.kind !== "enrolled" || status.commit !== head.oid ||
              status.conflicts.length || status.blocked.length || status.pause ||
              head.oid !== state.commits.restored)
            throw new Error("Completed stage changed before success evidence was written");
          await this.writeSuccess(state, status.phase, status.pending);
          break;
        }
      }
    } catch (error) {
      if (device !== null) {
        const path = `${root}/${device}-result.json`;
        if (!await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, JSON.stringify({
          completed: false, runId: ACCEPTANCE_RUN_ID, device, stage: state?.stage ?? "preflight",
          productionSha256: EXPECTED_PRODUCTION_SHA, checks: state?.checks ?? [], commits: state?.commits ?? {},
          error: error instanceof Error ? error.message : "Unknown failure",
        }, null, 2));
      }
    } finally { this.running = false; }
  }
}
