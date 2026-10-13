import { Plugin, requestUrl } from "obsidian";
import type GitVaultSync from "../../src/main";
import { entryFromText, hashBlob } from "../../src/git-sync/codec";
import { GitHubRepository } from "../../src/git-sync/github";
import { hostLifetimeId } from "../../src/git-sync/ownership";

declare const EXPECTED_PRODUCTION_SHA: string;

const owner = "triptu";
const repository = "vault-sync-test";
const branch = "native-android-1791894436601";
const secretId = "git-sync-native-lab";
const configurationPath = ".obsidian/plugins/vault-sync-restart-acceptance/data.json";
const predecessorRun = "e0b6c53d-c823-4d32-b9ac-274d65ce554d";
const predecessorSha = "2b38871ad3c8cfa91bd3c0c12cfa70271e61ae9ad3578d2aba84ff9cf6972fee";
const predecessorNamespace = `.git-sync-native-v2-${predecessorSha.slice(0, 12)}-configuration`;
const predecessorConfigurationPath = ".obsidian/plugins/vault-sync-acceptance-settings/data.json";
const namespace = `.git-sync-native-v2-${EXPECTED_PRODUCTION_SHA.slice(0, 12)}-configuration-restart`;
const statePath = `${namespace}-state.json`;
const progressPath = `${namespace}-progress.json`;
const resultPath = `${namespace}-result.json`;
const oid = /^[0-9a-f]{40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Stage = "created" | "paused" | "local-created" | "initial-consented" |
  "initial-published" | "fixture-prepared" | "fixture-published" |
  "awaiting-ui-apply" | "applied" | "awaiting-restart" | "restarted-held" |
  "note-converged" | "guard-consented" | "complete" | "failed";
type Check = { name: string; pass: boolean };
type Prepared = { parent: string; candidate: string; receipt: string; anchor: string | null };
type Predecessor = { runId: string; fixtureHead: string; resultSha256: string; stateSha256: string };
type State = {
  format: 1;
  productionSha256: string;
  runId: string;
  installation: string;
  stage: Stage;
  originalAutomatic: boolean;
  notePath: string;
  remoteHiddenBefore: Record<string, string>;
  localHiddenBefore: Record<string, string>;
  localExclusions: Record<string, string>;
  predecessor: Predecessor;
  commits: Record<string, string>;
  prepared: Prepared | null;
  applyHost: string | null;
  restartHost: string | null;
  failure: string | null;
  checks: Check[];
};

const stages: readonly Stage[] = ["created", "paused", "local-created", "initial-consented",
  "initial-published", "fixture-prepared", "fixture-published", "awaiting-ui-apply",
  "applied", "awaiting-restart", "restarted-held", "note-converged",
  "guard-consented", "complete", "failed"];
const configText = (id: string, revision: number): string =>
  `${JSON.stringify({ acceptanceFixture: id, revision, inert: true, challenge: "host-restart" })}\n`;
const noteText = (id: string, revision: number): string =>
  `Native configuration restart acceptance ${id}; note revision ${revision}.\n`;
const hidden = (path: string): boolean => path.split("/").some(part => part.startsWith("."));
const localExclusion = (path: string): string | null => {
  if (/^\.obsidian\/workspace[^/]*\.json$/.test(path)) return "Obsidian host-owned workspace state";
  if (path.startsWith(".obsidian/plugins/git-sync-native-configuration-restart/"))
    return "this disposable acceptance helper artifact";
  return null;
};
const predecessorText = (revision: number): string =>
  `${JSON.stringify({ acceptanceFixture: predecessorRun, revision, inert: true })}\n`;
const predecessorNote = `Native configuration acceptance ${predecessorRun}: remote note.\n`;

function parseState(value: unknown): State {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid restart acceptance state");
  const state = value as Record<string, unknown>;
  if (state.format !== 1 || state.productionSha256 !== EXPECTED_PRODUCTION_SHA ||
      typeof state.runId !== "string" || !uuid.test(state.runId) ||
      typeof state.installation !== "string" || !uuid.test(state.installation) ||
      !stages.includes(state.stage as Stage) || typeof state.originalAutomatic !== "boolean" ||
      state.notePath !== `Native Configuration Restart ${state.runId}.md` ||
      typeof state.remoteHiddenBefore !== "object" || state.remoteHiddenBefore === null || Array.isArray(state.remoteHiddenBefore) ||
      typeof state.localHiddenBefore !== "object" || state.localHiddenBefore === null || Array.isArray(state.localHiddenBefore) ||
      typeof state.localExclusions !== "object" || state.localExclusions === null || Array.isArray(state.localExclusions) ||
      typeof state.predecessor !== "object" || state.predecessor === null ||
      typeof state.commits !== "object" || state.commits === null || Array.isArray(state.commits) ||
      !(state.applyHost === null || typeof state.applyHost === "string") ||
      !(state.restartHost === null || typeof state.restartHost === "string") ||
      !(state.failure === null || typeof state.failure === "string") || !Array.isArray(state.checks))
    throw new Error("Invalid restart acceptance state fields");
  for (const map of [state.remoteHiddenBefore, state.localHiddenBefore, state.commits])
    for (const [path, hash] of Object.entries(map))
      if (typeof path !== "string" || typeof hash !== "string" || !/^[0-9a-f]{40,64}$/.test(hash))
        throw new Error("Invalid restart acceptance hash evidence");
  for (const [path, reason] of Object.entries(state.localExclusions))
    if (!Object.hasOwn(state.localHiddenBefore, path) || localExclusion(path) !== reason)
      throw new Error("Invalid local exclusion evidence");
  const predecessor = state.predecessor as Record<string, unknown>;
  if (predecessor.runId !== predecessorRun || typeof predecessor.fixtureHead !== "string" || !oid.test(predecessor.fixtureHead) ||
      typeof predecessor.resultSha256 !== "string" || !/^[0-9a-f]{64}$/.test(predecessor.resultSha256) ||
      typeof predecessor.stateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(predecessor.stateSha256))
    throw new Error("Invalid predecessor evidence");
  if (state.prepared !== null) {
    if (typeof state.prepared !== "object" || state.prepared === null) throw new Error("Invalid prepared fixture");
    const prepared = state.prepared as Record<string, unknown>;
    if (![prepared.parent, prepared.candidate, prepared.receipt].every(value => typeof value === "string" && oid.test(value)) ||
        !(prepared.anchor === null || typeof prepared.anchor === "string" && oid.test(prepared.anchor)))
      throw new Error("Invalid prepared fixture identities");
  }
  for (const item of state.checks)
    if (typeof item !== "object" || item === null || typeof Reflect.get(item, "name") !== "string" ||
        typeof Reflect.get(item, "pass") !== "boolean") throw new Error("Invalid restart acceptance check");
  return value as State;
}

export default class NativeConfigurationRestartAcceptance extends Plugin {
  onload(): void {
    this.app.workspace.onLayoutReady(() => { setTimeout(() => { void this.execute(); }, 2000); });
  }

  private production(): GitVaultSync {
    const manager: unknown = Reflect.get(this.app, "plugins");
    if (typeof manager !== "object" || manager === null) throw new Error("Plugin manager unavailable");
    const registry: unknown = Reflect.get(manager, "plugins");
    if (typeof registry !== "object" || registry === null) throw new Error("Plugin registry unavailable");
    const candidate: unknown = Reflect.get(registry, "github-vault-sync");
    if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "syncOnce") !== "function")
      throw new Error("Production plugin unavailable");
    return candidate as GitVaultSync;
  }

  private async remote(installation: string): Promise<GitHubRepository> {
    const remote = new GitHubRepository({ owner, name: repository, branch, installation,
      scopeRules: "config/1", configDir: ".obsidian",
      token: async () => this.app.secretStorage.getSecret(secretId) ?? "",
      transport: { request: async ({ url, method, headers, body }) => {
        const response = await requestUrl({ url, method, headers, body, throw: false });
        let json: unknown = null;
        try { json = JSON.parse(response.text); } catch { /* Repository validates malformed responses. */ }
        return { status: response.status, headers: response.headers, json };
      } },
    });
    const identity = await remote.identity();
    if (identity.owner !== owner || identity.name !== repository || identity.branch !== branch)
      throw new Error("Wrong private lab repository identity");
    return remote;
  }

  private async sha256(path: string): Promise<string> {
    const bytes = await this.app.vault.adapter.readBinary(path);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async digestText(text: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async hiddenInventory(): Promise<Record<string, string>> {
    const files = this.app.vault.adapter;
    const found: Record<string, string> = Object.create(null);
    const walk = async (directory: string): Promise<void> => {
      if (!await files.exists(directory)) return;
      const listed = await files.list(directory);
      for (const path of listed.files) found[path] = await this.sha256(path);
      for (const child of listed.folders) await walk(child);
    };
    await walk(".obsidian");
    if (await files.exists(".gitignore")) found[".gitignore"] = await this.sha256(".gitignore");
    return found;
  }

  private async save(state: State): Promise<void> {
    const files = this.app.vault.adapter;
    await files.write(statePath, JSON.stringify(state));
    await files.write(progressPath, JSON.stringify({ stage: state.stage, runId: state.runId,
      productionSha256: state.productionSha256, configurationPath, notePath: state.notePath,
      commits: state.commits, prepared: state.prepared, checks: state.checks,
      predecessor: state.predecessor, localExclusions: state.localExclusions,
      applyHost: state.applyHost, restartHost: state.restartHost,
      automaticRestorePending: state.stage !== "complete" && state.originalAutomatic }));
  }

  private async stage(state: State, next: Stage): Promise<void> { state.stage = next; await this.save(state); }
  private async check(state: State, name: string, pass: boolean): Promise<void> {
    state.checks.push({ name, pass });
    await this.save(state);
    if (!pass) throw new Error(name);
  }

  private async localIs(path: string, text: string): Promise<boolean> {
    const files = this.app.vault.adapter;
    return await files.exists(path) && await files.read(path) === text;
  }

  private async remoteIs(remote: GitHubRepository, path: string, text: string): Promise<boolean> {
    const expected = await entryFromText(text);
    const actual = (await remote.head()).files[path];
    return actual?.oid === expected.oid && actual.data === expected.data;
  }

  private async assertOtherHidden(state: State, remote: GitHubRepository): Promise<void> {
    const after = Object.fromEntries(Object.entries((await remote.head()).files)
      .filter(([path]) => hidden(path) && path !== configurationPath)
      .map(([path, entry]) => [path, entry.oid]));
    await this.check(state, "other remote hidden files retain exact baseline blobs",
      JSON.stringify(Object.entries(after).sort()) === JSON.stringify(Object.entries(state.remoteHiddenBefore).sort()));
  }

  private async assertLocalHidden(state: State): Promise<void> {
    for (const [path, before] of Object.entries(state.localHiddenBefore)) {
      if (state.localExclusions[path]) continue;
      await this.check(state, `existing local hidden bytes preserved: ${path}`,
        await this.app.vault.adapter.exists(path) && await this.sha256(path) === before);
    }
  }

  private async verifyPredecessor(remote: GitHubRepository, plugin: GitVaultSync): Promise<{ originalAutomatic: boolean; evidence: Predecessor }> {
    const files = this.app.vault.adapter;
    const resultFile = `${predecessorNamespace}-result.json`;
    const stateFile = `${predecessorNamespace}-state.json`;
    const archiveFile = `${predecessorNamespace}-failed-fixture-published-${predecessorRun}.json`;
    if (!await files.exists(resultFile) || !await files.exists(stateFile) || !await files.exists(archiveFile))
      throw new Error("Exact predecessor failed run and archive are required");
    const rawResult = await files.read(resultFile);
    const rawState = await files.read(stateFile);
    const result: unknown = JSON.parse(rawResult);
    const prior: unknown = JSON.parse(rawState);
    if (typeof result !== "object" || result === null || typeof prior !== "object" || prior === null)
      throw new Error("Invalid predecessor records");
    const last = Reflect.get(result, "checks");
    const commits = Reflect.get(result, "commits");
    const priorCommits = Reflect.get(prior, "commits");
    const required = ["configuration applied during current host lifetime",
      "production UI applied both exact incoming versions", "incoming configuration no longer deferred",
      "production UI preview cleared after both updates", "UI applied exact incoming hash",
      "UI applied exact preexisting lab configuration bytes"];
    if (Reflect.get(result, "completed") !== false || Reflect.get(result, "failedAt") !== "applied" ||
        Reflect.get(result, "error") !== "other local hidden bytes preserved: .obsidian/workspace-mobile.json" ||
        Reflect.get(result, "productionSha256") !== predecessorSha ||
        Reflect.get(result, "configurationPath") !== predecessorConfigurationPath ||
        Reflect.get(result, "notePath") !== `Native Configuration Acceptance ${predecessorRun}.md` ||
        Reflect.get(result, "priorFailureEvidence") !== archiveFile ||
        Reflect.get(result, "automaticRestorePending") !== true ||
        Reflect.get(prior, "runId") !== predecessorRun || Reflect.get(prior, "stage") !== "failed" ||
        Reflect.get(prior, "failure") !== Reflect.get(result, "error") ||
        Reflect.get(prior, "productionSha256") !== predecessorSha ||
        Reflect.get(prior, "originalAutomatic") !== true ||
        !Array.isArray(last) || last.length < required.length + 1 ||
        !last.every((item, index) => typeof item === "object" && item !== null &&
          typeof Reflect.get(item, "name") === "string" && Reflect.get(item, "pass") === (index === last.length - 1 ? false : true)) ||
        required.some(name => !last.some(item => item.name === name && item.pass === true)) ||
        last.at(-1)?.name !== Reflect.get(result, "error") ||
        JSON.stringify(Reflect.get(prior, "checks")) !== JSON.stringify(last) ||
        typeof commits !== "object" || commits === null || typeof priorCommits !== "object" || priorCommits === null ||
        !oid.test(Reflect.get(commits, "fixture")) ||
        Reflect.get(priorCommits, "fixture") !== Reflect.get(commits, "fixture"))
      throw new Error("Predecessor is not the exact known post-UI workspace failure");
    const head = await remote.head();
    const fixtureHead = Reflect.get(commits, "fixture") as string;
    if (head.oid !== fixtureHead ||
        !await this.remoteIs(remote, predecessorConfigurationPath, predecessorText(3)) ||
        !await this.localIs(predecessorConfigurationPath, predecessorText(3)) ||
        !await this.remoteIs(remote, `Native Configuration Acceptance ${predecessorRun}.md`, predecessorNote) ||
        !head.files[".obsidian/lab-config.json"] ||
        !await files.exists(".obsidian/lab-config.json") ||
        await hashBlob(new Uint8Array(await files.readBinary(".obsidian/lab-config.json"))) !== head.files[".obsidian/lab-config.json"].oid)
      throw new Error("Predecessor fixture head or revision-3 bytes changed");
    const status = await plugin.session?.inspect();
    const listing = await plugin.session?.listConfiguration();
    if (status?.kind !== "enrolled" || status.phase !== "idle" || status.pause !== null ||
        listing?.kind !== "configuration" || listing.rules !== "config/1" ||
        listing.deferred.length !== 0 || listing.guarded.length !== 0)
      throw new Error("Predecessor production session is not idle with cleared review");
    return { originalAutomatic: Reflect.get(prior, "originalAutomatic") === true, evidence: { runId: predecessorRun, fixtureHead,
      resultSha256: await this.digestText(rawResult), stateSha256: await this.digestText(rawState) } };
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const files = this.app.vault.adapter;
    if (await files.exists(resultPath)) return;
    let state: State | null = null;
    try {
      if (await files.exists(statePath)) state = parseState(JSON.parse(await files.read(statePath)));
      const actualSha = await this.sha256(".obsidian/plugins/github-vault-sync/main.js");
      if (actualSha !== EXPECTED_PRODUCTION_SHA) throw new Error("Installed production bundle hash changed");
      const plugin = this.production();
      if (plugin.settings.owner !== owner || plugin.settings.repository !== repository ||
          plugin.settings.branch !== branch || plugin.settings.secretId !== secretId ||
          !this.app.secretStorage.getSecret(secretId)) throw new Error("Wrong lab configuration or missing lab credential");
      if (!plugin.session) throw new Error("Production session unavailable");
      const installation = state?.installation ?? crypto.randomUUID();
      const remote = await this.remote(installation);
      if (!state) {
        const predecessor = await this.verifyPredecessor(remote, plugin);
        const status = await plugin.session.inspect();
        const listing = await plugin.session.listConfiguration();
        if (status.kind !== "enrolled" || status.pause !== null || status.phase !== "idle" ||
            listing.kind !== "configuration" || listing.rules !== "config/1" ||
            listing.deferred.length || listing.guarded.length)
          throw new Error("Initial config/1 session is not clean");
        const head = await remote.head();
        if (await files.exists(configurationPath) || Object.hasOwn(head.files, configurationPath))
          throw new Error("Synthetic configuration path is already occupied");
        if (await files.exists(".gitignore")) {
          const localIgnore = new Uint8Array(await files.readBinary(".gitignore"));
          if (!head.files[".gitignore"] || await hashBlob(localIgnore) !== head.files[".gitignore"].oid)
            throw new Error("Local root .gitignore differs from GitHub");
        }
        const runId = crypto.randomUUID();
        const notePath = `Native Configuration Restart ${runId}.md`;
        if (await files.exists(notePath) || Object.hasOwn(head.files, notePath))
          throw new Error("Synthetic note path is already occupied");
        state = { format: 1, productionSha256: EXPECTED_PRODUCTION_SHA, runId,
          installation, stage: "created", originalAutomatic: predecessor.originalAutomatic,
          notePath, remoteHiddenBefore: Object.fromEntries(Object.entries(head.files)
            .filter(([path]) => hidden(path)).map(([path, entry]) => [path, entry.oid])),
          localHiddenBefore: Object.create(null), localExclusions: Object.create(null),
          predecessor: predecessor.evidence, commits: { initial: head.oid }, prepared: null,
          applyHost: null, restartHost: null, failure: null, checks: [] };
        await this.save(state);
      }
      if (state.stage === "complete") { await this.writeSuccess(state); return; }
      if (state.stage === "failed") return;
      await this.drive(state, plugin, remote);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      if (state) {
        const failedAt = state.stage;
        state.failure = message;
        await this.stage(state, "failed");
        await files.write(resultPath, JSON.stringify({ completed: false, failedAt, error: message,
          productionSha256: EXPECTED_PRODUCTION_SHA, configurationPath, notePath: state.notePath,
          commits: state.commits, prepared: state.prepared, checks: state.checks,
          predecessor: state.predecessor, localExclusions: state.localExclusions,
          automaticRestorePending: state.originalAutomatic }));
      } else await files.write(resultPath, JSON.stringify({ completed: false, error: message,
        productionSha256: EXPECTED_PRODUCTION_SHA }));
    }
  }

  private async writeSuccess(state: State): Promise<void> {
    await this.app.vault.adapter.write(resultPath, JSON.stringify({ completed: true,
      productionSha256: EXPECTED_PRODUCTION_SHA, configurationPath, notePath: state.notePath,
      bytes: { initial: configText(state.runId, 1), reviewed: configText(state.runId, 2),
        stale: configText(state.runId, 3), remoteNote: noteText(state.runId, 1),
        convergedNote: noteText(state.runId, 2) },
      commits: state.commits, prepared: state.prepared, applyHost: state.applyHost,
      restartHost: state.restartHost, remoteHiddenBefore: state.remoteHiddenBefore,
      localHiddenBefore: state.localHiddenBefore, localExclusions: state.localExclusions,
      predecessor: state.predecessor, checks: state.checks, automaticRestored: true }));
  }

  private async drive(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const files = this.app.vault.adapter;
    const session = () => { if (!plugin.session) throw new Error("Production session unavailable"); return plugin.session; };
    if (state.stage === "created") {
      if (plugin.settings.automatic) await plugin.saveConfiguration({ ...plugin.settings, automatic: false });
      await this.check(state, "automatic sync paused", !plugin.settings.automatic);
      state.localHiddenBefore = await this.hiddenInventory();
      state.localExclusions = Object.fromEntries(Object.keys(state.localHiddenBefore)
        .map(path => [path, localExclusion(path)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null));
      await this.stage(state, "paused");
    }
    if (state.stage === "paused") {
      const directory = ".obsidian/plugins/vault-sync-restart-acceptance";
      if (!await files.exists(directory)) await files.mkdir(directory);
      if (!await files.exists(configurationPath)) await files.write(configurationPath, configText(state.runId, 1));
      await this.check(state, "synthetic initial bytes exact", await this.localIs(configurationPath, configText(state.runId, 1)));
      await plugin.syncOnce();
      await this.check(state, "new hidden fixture held before consent", !Object.hasOwn((await remote.head()).files, configurationPath));
      const listing = await session().listConfiguration();
      await this.check(state, "new hidden fixture offered for publication review",
        listing.kind === "configuration" && listing.unpublished.some(item => item.path === configurationPath));
      await this.stage(state, "local-created");
    }
    if (state.stage === "local-created") {
      const preview = await session().previewHiddenPublication(configurationPath);
      if (preview.kind !== "preview") throw new Error(`Initial publication preview unavailable: ${preview.kind}`);
      const expected = await entryFromText(configText(state.runId, 1));
      await this.check(state, "initial publication preview exact bytes", preview.entry.oid === expected.oid && preview.entry.data === expected.data);
      const consent = await session().consentHiddenPublication({ path: preview.path, token: preview.token });
      await this.check(state, "initial exact hidden consent recorded", consent.kind === "recorded");
      await this.stage(state, "initial-consented");
    }
    if (state.stage === "initial-consented") {
      await plugin.syncOnce();
      await this.check(state, "initial exact hidden bytes published", await this.remoteIs(remote, configurationPath, configText(state.runId, 1)));
      state.commits.initialPublished = (await remote.head()).oid;
      await this.assertOtherHidden(state, remote);
      await this.stage(state, "initial-published");
    }
    if (state.stage === "initial-published") {
      const head = await remote.head();
      await this.check(state, "fixture parent is initial published head", head.oid === state.commits.initialPublished);
      const ledger = await remote.readLedger();
      const anchor = ledger.kind === "present" ? ledger.value : null;
      const candidate = await remote.prepare(head, {
        [configurationPath]: await entryFromText(configText(state.runId, 2)),
        [state.notePath]: await entryFromText(noteText(state.runId, 1)),
      }, `Native configuration restart incoming ${state.runId}`, { anchor, operation: crypto.randomUUID() });
      state.prepared = { parent: head.oid, candidate: candidate.oid, receipt: candidate.receipt, anchor };
      await this.stage(state, "fixture-prepared");
    }
    if (state.stage === "fixture-prepared") {
      if (!state.prepared) throw new Error("Prepared fixture missing");
      const prepared = state.prepared;
      const head = await remote.head();
      const ledger = await remote.readLedger();
      if (head.oid === prepared.parent && (ledger.kind === "absent" ? null : ledger.value) === prepared.anchor)
        await remote.publish(prepared);
      const observed = await remote.head();
      const receipt = await remote.readLedger();
      await this.check(state, "fixture branch and ledger confirm exact candidate",
        observed.oid === prepared.candidate && receipt.kind === "present" && receipt.value === prepared.receipt);
      await this.check(state, "fixture exact remote configuration and note",
        await this.remoteIs(remote, configurationPath, configText(state.runId, 2)) &&
        await this.remoteIs(remote, state.notePath, noteText(state.runId, 1)));
      state.commits.fixture = observed.oid;
      await this.stage(state, "fixture-published");
    }
    if (state.stage === "fixture-published") {
      await plugin.syncOnce();
      const listing = await session().listConfiguration();
      const initial = await entryFromText(configText(state.runId, 1));
      const reviewed = await entryFromText(configText(state.runId, 2));
      await this.check(state, "only synthetic incoming configuration deferred", listing.kind === "configuration" &&
        listing.deferred.length === 1 && listing.deferred[0]?.path === configurationPath &&
        listing.deferred[0]?.expected?.oid === initial.oid && listing.deferred[0]?.next?.oid === reviewed.oid &&
        listing.deferred[0]?.blockedReason === null);
      const preview = await session().previewApplyConfiguration();
      await this.check(state, "production review has exact incoming bytes", preview.kind === "preview" &&
        preview.blocked.length === 0 && preview.items.length === 1 &&
        preview.items[0]?.path === configurationPath &&
        preview.items[0]?.expectedEntry?.data === initial.data &&
        preview.items[0]?.incomingEntry?.data === reviewed.data);
      await this.check(state, "review did not apply configuration", await this.localIs(configurationPath, configText(state.runId, 1)));
      await this.check(state, "unrelated remote note downloaded", await this.localIs(state.notePath, noteText(state.runId, 1)));
      await this.assertOtherHidden(state, remote);
      state.applyHost = hostLifetimeId(this.app);
      await this.stage(state, "awaiting-ui-apply");
    }
    if (state.stage === "awaiting-ui-apply") {
      // Read-only observation. Root taps Apply in the production Configuration modal.
      for (let attempt = 0; attempt < 24; attempt++) {
        if (await this.localIs(configurationPath, configText(state.runId, 2))) {
          const listing = await session().listConfiguration();
          if (listing.kind === "configuration" && !listing.deferred.some(item => item.path === configurationPath)) {
            await this.check(state, "production UI applied reviewed bytes in observed host", state.applyHost === hostLifetimeId(this.app));
            await this.check(state, "reviewed remote bytes remain unchanged", await this.remoteIs(remote, configurationPath, configText(state.runId, 2)));
            await this.stage(state, "applied");
            break;
          }
        } else if (state.applyHost !== hostLifetimeId(this.app)) {
          const listing = await session().listConfiguration();
          await this.check(state, "pre-apply restart still has deferred review", listing.kind === "configuration" &&
            listing.deferred.some(item => item.path === configurationPath) &&
            await this.localIs(configurationPath, configText(state.runId, 1)));
          state.applyHost = hostLifetimeId(this.app);
          await this.save(state);
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      if (state.stage === "awaiting-ui-apply") return;
    }
    if (state.stage === "applied") {
      await this.check(state, "stale write happens in applying host", state.applyHost === hostLifetimeId(this.app));
      await this.check(state, "reviewed local bytes before stale write", await this.localIs(configurationPath, configText(state.runId, 2)) ||
        await this.localIs(configurationPath, configText(state.runId, 3)));
      if (await this.localIs(configurationPath, configText(state.runId, 2)))
        await files.write(configurationPath, configText(state.runId, 3));
      await this.check(state, "stale local bytes exact", await this.localIs(configurationPath, configText(state.runId, 3)));
      await plugin.syncOnce();
      const listing = await session().listConfiguration();
      const stale = await entryFromText(configText(state.runId, 3));
      await this.check(state, "same-host stale version held before restart", listing.kind === "configuration" &&
        listing.guarded.some(item => item.path === configurationPath && item.local?.oid === stale.oid));
      const head = await remote.head();
      await this.check(state, "GitHub head unchanged before restart", head.oid === state.commits.fixture &&
        head.files[configurationPath]?.data === (await entryFromText(configText(state.runId, 2))).data);
      state.commits.beforeRestart = head.oid;
      await this.stage(state, "awaiting-restart");
      return;
    }
    if (state.stage === "awaiting-restart") {
      if (state.applyHost === hostLifetimeId(this.app)) return;
      await this.check(state, "fresh Obsidian host after durable marker", state.applyHost !== null);
      await this.check(state, "stale local bytes survived full restart", await this.localIs(configurationPath, configText(state.runId, 3)));
      await this.check(state, "remote head still unchanged before restart sync", (await remote.head()).oid === state.commits.beforeRestart);
      state.restartHost = hostLifetimeId(this.app);
      await this.save(state);
      await plugin.syncOnce();
      const listing = await session().listConfiguration();
      const stale = await entryFromText(configText(state.runId, 3));
      await this.check(state, "new host keeps stale version guarded", listing.kind === "configuration" &&
        listing.guarded.some(item => item.path === configurationPath && item.local?.oid === stale.oid));
      await this.check(state, "remote keeps reviewed bytes after restart sync", await this.remoteIs(remote, configurationPath, configText(state.runId, 2)));
      await this.check(state, "local keeps stale bytes after restart sync", await this.localIs(configurationPath, configText(state.runId, 3)));
      await this.stage(state, "restarted-held");
    }
    if (state.stage === "restarted-held") {
      await this.check(state, "unrelated note has expected starting bytes", await this.localIs(state.notePath, noteText(state.runId, 1)) ||
        await this.localIs(state.notePath, noteText(state.runId, 2)));
      if (await this.localIs(state.notePath, noteText(state.runId, 1)))
        await files.write(state.notePath, noteText(state.runId, 2));
      await plugin.syncOnce();
      await this.check(state, "unrelated note converged while stale configuration held",
        await this.remoteIs(remote, state.notePath, noteText(state.runId, 2)) &&
        await this.localIs(state.notePath, noteText(state.runId, 2)));
      await this.check(state, "reviewed configuration still remote after note sync",
        await this.remoteIs(remote, configurationPath, configText(state.runId, 2)));
      state.commits.note = (await remote.head()).oid;
      const listing = await session().listConfiguration();
      await this.check(state, "guard remains listed after unrelated convergence", listing.kind === "configuration" &&
        listing.guarded.some(item => item.path === configurationPath));
      await this.stage(state, "note-converged");
    }
    if (state.stage === "note-converged") {
      const preview = await session().previewGuardedConfigurationPublication(configurationPath);
      if (preview.kind !== "preview") throw new Error(`Restart guard preview unavailable: ${preview.kind}`);
      const stale = await entryFromText(configText(state.runId, 3));
      await this.check(state, "restart guard preview exact stale bytes and hash",
        preview.entry?.data === stale.data && preview.version?.oid === stale.oid && preview.applied?.oid ===
        (await entryFromText(configText(state.runId, 2))).oid);
      const consent = await session().consentGuardedConfigurationPublication({ path: preview.path, token: preview.token });
      await this.check(state, "exact restart guard consent recorded", consent.kind === "recorded");
      await this.stage(state, "guard-consented");
    }
    if (state.stage === "guard-consented") {
      await plugin.syncOnce();
      await this.check(state, "only exact consented stale version published",
        await this.remoteIs(remote, configurationPath, configText(state.runId, 3)));
      await this.check(state, "unrelated note retained after guarded publication",
        await this.remoteIs(remote, state.notePath, noteText(state.runId, 2)));
      await this.assertOtherHidden(state, remote);
      await this.assertLocalHidden(state);
      state.commits.final = (await remote.head()).oid;
      if (plugin.settings.automatic !== state.originalAutomatic)
        await plugin.saveConfiguration({ ...plugin.settings, automatic: state.originalAutomatic });
      await this.check(state, "automatic setting restored", plugin.settings.automatic === state.originalAutomatic);
      await this.stage(state, "complete");
      await this.writeSuccess(state);
    }
  }
}
