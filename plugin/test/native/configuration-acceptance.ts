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
const configurationPath = ".obsidian/plugins/vault-sync-acceptance-settings/data.json";
const namespace = `.git-sync-native-v2-${EXPECTED_PRODUCTION_SHA.slice(0, 12)}-configuration`;
const statePath = `${namespace}-state.json`;
const progressPath = `${namespace}-progress.json`;
const resultPath = `${namespace}-result.json`;
const oid = /^[0-9a-f]{40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Stage = "created" | "paused" | "upgrade-requested" | "reenrollment" | "migrated" |
  "local-created" | "stale-hidden-checked" | "hidden-consented" | "hidden-published" |
  "fixture-prepared" | "fixture-published" | "awaiting-ui-apply" | "applied" | "host-flush-started" |
  "host-flush-held" | "stale-guard-checked" | "guard-consented" | "complete" | "failed";
type Check = { name: string; pass: boolean };
type Prepared = { parent: string; candidate: string; receipt: string; anchor: string | null };
type State = {
  format: 1;
  productionSha256: string;
  runId: string;
  fixtureInstallation: string;
  stage: Stage;
  originalAutomatic: boolean;
  hiddenBefore: Record<string, string>;
  remoteHiddenBefore: Record<string, string>;
  notePath: string;
  commits: Record<string, string>;
  prepared: Prepared | null;
  uiHostLifetimeId: string | null;
  failure: string | null;
  checks: Check[];
};

const stages: readonly Stage[] = ["created", "paused", "upgrade-requested", "reenrollment", "migrated",
  "local-created", "stale-hidden-checked", "hidden-consented", "hidden-published", "fixture-prepared",
  "fixture-published", "awaiting-ui-apply", "applied", "host-flush-started", "host-flush-held", "stale-guard-checked",
  "guard-consented", "complete", "failed"];
const configText = (id: string, revision: number): string =>
  `${JSON.stringify({ acceptanceFixture: id, revision, inert: true })}\n`;
const noteText = (id: string, side: "remote" | "local"): string =>
  `Native configuration acceptance ${id}: ${side} note.\n`;

function parseState(value: unknown): State {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid configuration acceptance state");
  const state = value as Record<string, unknown>;
  if (state.format !== 1 || state.productionSha256 !== EXPECTED_PRODUCTION_SHA ||
      typeof state.runId !== "string" || !uuid.test(state.runId) ||
      typeof state.fixtureInstallation !== "string" || !uuid.test(state.fixtureInstallation) ||
      !stages.includes(state.stage as Stage) || typeof state.originalAutomatic !== "boolean" ||
      state.notePath !== `Native Configuration Acceptance ${state.runId}.md` ||
      typeof state.hiddenBefore !== "object" || state.hiddenBefore === null ||
      typeof state.remoteHiddenBefore !== "object" || state.remoteHiddenBefore === null ||
      typeof state.commits !== "object" || state.commits === null ||
      !(state.uiHostLifetimeId === null || typeof state.uiHostLifetimeId === "string") ||
      !(state.failure === null || typeof state.failure === "string") || !Array.isArray(state.checks))
    throw new Error("Invalid configuration acceptance state");
  for (const map of [state.hiddenBefore, state.remoteHiddenBefore, state.commits]) {
    for (const [path, hash] of Object.entries(map)) if (typeof path !== "string" || typeof hash !== "string" || !/^[0-9a-f]{40,64}$/.test(hash))
      throw new Error("Invalid configuration acceptance hash evidence");
  }
  if (state.prepared !== null) {
    if (typeof state.prepared !== "object" || state.prepared === null) throw new Error("Invalid prepared fixture");
    const prepared = state.prepared as Record<string, unknown>;
    if (![prepared.parent, prepared.candidate, prepared.receipt].every(value => typeof value === "string" && oid.test(value)) ||
        !(prepared.anchor === null || typeof prepared.anchor === "string" && oid.test(prepared.anchor)))
      throw new Error("Invalid prepared fixture identities");
  }
  for (const item of state.checks) if (typeof item !== "object" || item === null ||
    typeof Reflect.get(item, "name") !== "string" || typeof Reflect.get(item, "pass") !== "boolean")
    throw new Error("Invalid configuration acceptance check");
  return value as State;
}

export default class NativeConfigurationAcceptance extends Plugin {
  onload(): void {
    this.app.workspace.onLayoutReady(() => { setTimeout(() => { void this.execute(); }, 2000); });
  }

  private async sha256(path: string): Promise<string> {
    const bytes = await this.app.vault.adapter.readBinary(path);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
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
    return found;
  }

  private async remote(installation: string): Promise<GitHubRepository> {
    const remote = new GitHubRepository({ owner, name: repository, branch, installation,
      scopeRules: "config/1", configDir: ".obsidian",
      token: async () => this.app.secretStorage.getSecret(secretId) ?? "",
      transport: { request: async ({ url, method, headers, body }) => {
        const response = await requestUrl({ url, method, headers, body, throw: false });
        let json: unknown = null;
        try { json = JSON.parse(response.text); } catch { /* The repository validates malformed responses. */ }
        return { status: response.status, headers: response.headers, json };
      } },
    });
    const identity = await remote.identity(); // Refuses a public repository.
    if (identity.owner !== owner || identity.name !== repository || identity.branch !== branch)
      throw new Error("Wrong private lab repository identity");
    return remote;
  }

  private production(): GitVaultSync {
    const manager: unknown = Reflect.get(this.app, "plugins");
    if (typeof manager !== "object" || manager === null) throw new Error("Plugin manager unavailable");
    const registry: unknown = Reflect.get(manager, "plugins");
    if (typeof registry !== "object" || registry === null) throw new Error("Plugin registry unavailable");
    const candidate: unknown = Reflect.get(registry, "github-vault-sync");
    if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "syncOnce") !== "function" ||
        typeof Reflect.get(candidate, "previewConfigurationUpgrade") !== "function")
      throw new Error("Production plugin unavailable");
    return candidate as GitVaultSync;
  }

  private async save(state: State): Promise<void> {
    await this.app.vault.adapter.write(statePath, JSON.stringify(state));
    await this.app.vault.adapter.write(progressPath, JSON.stringify({ stage: state.stage, runId: state.runId,
      configurationPath, notePath: state.notePath, commits: state.commits, checks: state.checks,
      productionSha256: EXPECTED_PRODUCTION_SHA, automaticRestorePending: state.stage !== "complete" && state.originalAutomatic }));
  }

  private async check(state: State, name: string, pass: boolean): Promise<void> {
    state.checks.push({ name, pass });
    await this.save(state);
    if (!pass) throw new Error(name);
  }

  private async stage(state: State, next: Stage): Promise<void> { state.stage = next; await this.save(state); }

  private async exactLocal(path: string, text: string): Promise<boolean> {
    const files = this.app.vault.adapter;
    return await files.exists(path) && await files.read(path) === text;
  }

  private async assertHiddenPreserved(state: State, exact: boolean): Promise<void> {
    for (const [path, before] of Object.entries(state.hiddenBefore))
      await this.check(state, `existing hidden ${exact ? "bytes" : "path"} preserved: ${path}`,
        await this.app.vault.adapter.exists(path) && (!exact || await this.sha256(path) === before));
  }

  private async assertNoOtherHiddenPublished(state: State, remote: GitHubRepository): Promise<void> {
    const head = await remote.head();
    const after = Object.fromEntries(Object.entries(head.files)
      .filter(([path]) => path.startsWith(".obsidian/") && path !== configurationPath)
      .map(([path, entry]) => [path, entry.oid]));
    await this.check(state, "no other hidden configuration published", JSON.stringify(Object.entries(after).sort()) ===
      JSON.stringify(Object.entries(state.remoteHiddenBefore).sort()));
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const files = this.app.vault.adapter;
    if (await files.exists(resultPath)) return;
    let state: State | null = null;
    try {
      if (await files.exists(statePath)) state = parseState(JSON.parse(await files.read(statePath)));
      const productionSha256 = await this.sha256(".obsidian/plugins/github-vault-sync/main.js");
      if (productionSha256 !== EXPECTED_PRODUCTION_SHA) throw new Error("Installed production bundle hash changed");
      const plugin = this.production();
      if (plugin.settings.owner !== owner || plugin.settings.repository !== repository || plugin.settings.branch !== branch ||
          plugin.settings.secretId !== secretId || !this.app.secretStorage.getSecret(secretId))
        throw new Error("Wrong lab configuration or missing lab credential");
      if (!plugin.session) throw new Error("Production session unavailable");
      const fixtureInstallation = state?.fixtureInstallation ?? crypto.randomUUID();
      const remote = await this.remote(fixtureInstallation);
      if (!state) {
        const status = await plugin.session.inspect();
        if (status.kind !== "enrolled" || status.phase !== "idle" || status.pause !== null ||
            (await plugin.session.listConfiguration()).kind !== "configuration") throw new Error("Initial enrolled session is not clean");
        const listing = await plugin.session.listConfiguration();
        if (listing.kind !== "configuration" || listing.rules !== "visible-only") throw new Error("Expected legacy visible-only enrollment");
        const head = await remote.head();
        if (await files.exists(configurationPath) || Object.hasOwn(head.files, configurationPath))
          throw new Error("Synthetic configuration path is already occupied");
        const runId = crypto.randomUUID();
        state = { format: 1, productionSha256, runId, fixtureInstallation, stage: "created", originalAutomatic: plugin.settings.automatic,
          hiddenBefore: Object.create(null), remoteHiddenBefore: Object.fromEntries(Object.entries(head.files)
            .filter(([path]) => path.startsWith(".obsidian/")).map(([path, entry]) => [path, entry.oid])),
          notePath: `Native Configuration Acceptance ${runId}.md`, commits: { initial: head.oid },
          prepared: null, uiHostLifetimeId: null, failure: null, checks: [] };
        await this.save(state);
      }
      if (state.stage === "complete") { await this.writeSuccess(state); return; }
      if (state.stage === "failed") { await this.writeFailure(state, "prior stage", state.failure ?? "Previous failure"); return; }
      await this.drive(state, plugin, remote);
    } catch (error) {
      if (state) {
        const failedAt = state.stage;
        state.failure = error instanceof Error ? error.message : "Unknown failure";
        await this.stage(state, "failed");
        await this.writeFailure(state, failedAt, state.failure);
      } else {
        await files.write(resultPath, JSON.stringify({ completed: false, error: error instanceof Error ? error.message : "Unknown failure",
          productionSha256: EXPECTED_PRODUCTION_SHA }));
      }
    }
  }

  private async writeFailure(state: State, failedAt: string, error: string): Promise<void> {
    await this.app.vault.adapter.write(resultPath, JSON.stringify({ completed: false, failedAt, error,
      checks: state.checks, commits: state.commits, configurationPath, notePath: state.notePath,
      productionSha256: EXPECTED_PRODUCTION_SHA, automaticRestorePending: state.originalAutomatic }));
  }

  private async writeSuccess(state: State): Promise<void> {
    await this.app.vault.adapter.write(resultPath, JSON.stringify({ completed: true, checks: state.checks, commits: state.commits,
      configurationPath, notePath: state.notePath, localNote: `${state.notePath.slice(0, -3)} Android.md`,
      fixtureSha256: await this.sha256(configurationPath), productionSha256: EXPECTED_PRODUCTION_SHA,
      automaticRestored: true }));
  }

  private async drive(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const files = this.app.vault.adapter;
    const session = () => { if (!plugin.session) throw new Error("Production session unavailable"); return plugin.session; };
    const localNote = `${state.notePath.slice(0, -3)} Android.md`;
    if (state.stage === "created") {
      if (plugin.settings.automatic) await plugin.saveConfiguration({ ...plugin.settings, automatic: false });
      await this.check(state, "automatic sync paused", !plugin.settings.automatic);
      state.hiddenBefore = await this.hiddenInventory();
      await this.stage(state, "paused");
    }
    if (state.stage === "paused" || state.stage === "upgrade-requested") {
      if (state.stage === "paused") await this.stage(state, "upgrade-requested");
      const status = await session().status();
      if (status.kind === "enrolled" && status.pause?.reason === "scope-enrollment") {
        await this.stage(state, "reenrollment");
      } else {
        const upgrade = await plugin.previewConfigurationUpgrade();
        await this.check(state, "production migration preview requires fresh enrollment", upgrade.note.includes("Fresh enrollment"));
        const preview = await upgrade.confirm();
        await this.check(state, "production migration confirmation opened reenrollment", preview?.kind === "preview" && preview.reenrollment);
        await this.stage(state, "reenrollment");
      }
    }
    if (state.stage === "reenrollment") {
      const status = await session().status();
      const scope = await session().listConfiguration();
      if (status.kind === "enrolled" && status.pause === null && scope.kind === "configuration" && scope.rules === "config/1")
        await this.stage(state, "migrated");
    }
    if (state.stage === "reenrollment") {
      const preview = await session().previewEnrollment();
      await this.check(state, "fresh configuration enrollment preview", preview.kind === "preview" && preview.reenrollment);
      if (preview.kind !== "preview") throw new Error("Enrollment preview unavailable");
      await this.check(state, "existing hidden files will not be overwritten by enrollment",
        preview.items.every(item => !Object.hasOwn(state.hiddenBefore, item.path) || item.action === "upload" || item.action === "unreadable"));
      const outcome = await session().enroll({ token: preview.token });
      await this.check(state, "production reenrollment confirmed", outcome.kind === "enrolled");
      await this.stage(state, "migrated");
    }
    if (state.stage === "migrated") {
      const listing = await session().listConfiguration();
      await this.check(state, "configuration scope active", listing.kind === "configuration" && listing.rules === "config/1");
      await this.assertHiddenPreserved(state, true);
      await this.assertNoOtherHiddenPublished(state, remote);
      await this.check(state, "synthetic configuration still unused", !await files.exists(configurationPath));
      await this.stage(state, "local-created");
    }
    if (state.stage === "local-created") {
      if (!await files.exists(".obsidian/plugins/vault-sync-acceptance-settings"))
        await files.mkdir(".obsidian/plugins/vault-sync-acceptance-settings");
      if (!await files.exists(configurationPath)) await files.write(configurationPath, configText(state.runId, 1));
      // A force-stop after the local edit can be replayed from the earlier fixture version.
      if (await this.exactLocal(configurationPath, configText(state.runId, 2)))
        await files.write(configurationPath, configText(state.runId, 1));
      await this.check(state, "new hidden fixture exact local bytes", await this.exactLocal(configurationPath, configText(state.runId, 1)));
      await plugin.syncOnce();
      await this.check(state, "new hidden file held before consent", !Object.hasOwn((await remote.head()).files, configurationPath));
      const listing = await session().listConfiguration();
      await this.check(state, "new hidden file offered for exact preview", listing.kind === "configuration" && listing.unpublished.some(item => item.path === configurationPath));
      const old = await session().previewHiddenPublication(configurationPath);
      if (old.kind !== "preview") throw new Error(`Hidden preview unavailable: ${old.kind}`);
      await files.write(configurationPath, configText(state.runId, 2));
      const stale = await session().consentHiddenPublication({ path: configurationPath, token: old.token });
      await this.check(state, "edited hidden version rejects old consent", stale.kind === "stale");
      await this.check(state, "stale consent did not publish", !Object.hasOwn((await remote.head()).files, configurationPath));
      await this.stage(state, "stale-hidden-checked");
    }
    if (state.stage === "stale-hidden-checked") {
      await this.check(state, "edited hidden fixture exact local bytes", await this.exactLocal(configurationPath, configText(state.runId, 2)));
      const fresh = await session().previewHiddenPublication(configurationPath);
      if (fresh.kind !== "preview") throw new Error(`Fresh hidden preview unavailable: ${fresh.kind}`);
      const expected = await entryFromText(configText(state.runId, 2));
      await this.check(state, "fresh hidden preview exact bytes and hash", fresh.path === configurationPath && fresh.entry.data === expected.data && fresh.version.oid === expected.oid);
      const consent = await session().consentHiddenPublication({ path: fresh.path, token: fresh.token });
      await this.check(state, "fresh hidden consent recorded", consent.kind === "recorded");
      await this.stage(state, "hidden-consented");
    }
    if (state.stage === "hidden-consented") {
      await plugin.syncOnce();
      const head = await remote.head();
      const expected = await entryFromText(configText(state.runId, 2));
      await this.check(state, "exact consented hidden version published", head.files[configurationPath]?.oid === expected.oid && head.files[configurationPath]?.data === expected.data);
      state.commits.hidden = head.oid;
      await this.assertNoOtherHiddenPublished(state, remote);
      await this.stage(state, "hidden-published");
    }
    if (state.stage === "hidden-published") {
      const head = await remote.head();
      await this.check(state, "fixture parent is consented head", head.oid === state.commits.hidden);
      await this.check(state, "unrelated note path unused", !Object.hasOwn(head.files, state.notePath) && !await files.exists(state.notePath));
      const ledger = await remote.readLedger();
      const anchor = ledger.kind === "present" ? ledger.value : null;
      const candidate = await remote.prepare(head, {
        [configurationPath]: await entryFromText(configText(state.runId, 3)),
        [state.notePath]: await entryFromText(noteText(state.runId, "remote")),
      }, `Native configuration incoming ${state.runId}`, { anchor, operation: crypto.randomUUID() });
      state.prepared = { parent: head.oid, candidate: candidate.oid, receipt: candidate.receipt, anchor };
      await this.stage(state, "fixture-prepared");
    }
    if (state.stage === "fixture-prepared") {
      if (!state.prepared) throw new Error("Prepared fixture missing");
      const prepared = state.prepared;
      const head = await remote.head();
      const ledger = await remote.readLedger();
      if (head.oid === prepared.parent && (ledger.kind === "absent" ? null : ledger.value) === prepared.anchor)
        await remote.publish({ parent: prepared.parent, candidate: prepared.candidate, anchor: prepared.anchor, receipt: prepared.receipt });
      const observedHead = await remote.head();
      const observedLedger = await remote.readLedger();
      await this.check(state, "fixture branch and independent ledger confirm exact candidate",
        observedHead.oid === prepared.candidate && observedLedger.kind === "present" && observedLedger.value === prepared.receipt);
      state.commits.fixture = prepared.candidate;
      await this.stage(state, "fixture-published");
    }
    if (state.stage === "fixture-published") {
      await plugin.syncOnce();
      const listing = await session().listConfiguration();
      await this.check(state, "remote configuration deferred for UI review", listing.kind === "configuration" &&
        listing.deferred.length === 1 && listing.deferred[0]?.path === configurationPath);
      const preview = await session().previewApplyConfiguration();
      const expected = await entryFromText(configText(state.runId, 2));
      const incoming = await entryFromText(configText(state.runId, 3));
      await this.check(state, "production UI preview contains only exact synthetic update",
        preview.kind === "preview" && preview.blocked.length === 0 && preview.items.length === 1 &&
        preview.items[0]?.path === configurationPath && preview.items[0]?.expectedEntry?.oid === expected.oid &&
        preview.items[0]?.incomingEntry?.oid === incoming.oid);
      await this.check(state, "deferred configuration kept local bytes", await this.exactLocal(configurationPath, configText(state.runId, 2)));
      await this.check(state, "unrelated remote note downloaded", await this.exactLocal(state.notePath, noteText(state.runId, "remote")));
      await this.assertNoOtherHiddenPublished(state, remote);
      state.uiHostLifetimeId = hostLifetimeId(this.app);
      await this.stage(state, "awaiting-ui-apply");
      return;
    }
    if (state.stage === "awaiting-ui-apply") {
      // Read-only wait. The root agent must open the production Configuration command and tap Apply.
      for (let attempt = 0; attempt < 120; attempt++) {
        const listing = await session().listConfiguration();
        if (listing.kind === "configuration" && listing.deferred.some(item => item.path === configurationPath) &&
            state.uiHostLifetimeId !== hostLifetimeId(this.app)) {
          state.uiHostLifetimeId = hostLifetimeId(this.app);
          await this.save(state);
        }
        if (listing.kind === "configuration" && !listing.deferred.some(item => item.path === configurationPath) &&
            await this.exactLocal(configurationPath, configText(state.runId, 3))) {
          await this.check(state, "configuration applied during current host lifetime", state.uiHostLifetimeId === hostLifetimeId(this.app));
          await this.check(state, "production UI applied exact incoming bytes", true);
          await this.stage(state, "applied");
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (state.stage === "awaiting-ui-apply") return;
    }
    if (["applied", "host-flush-started", "host-flush-held", "stale-guard-checked", "guard-consented"].includes(state.stage) &&
        state.uiHostLifetimeId !== hostLifetimeId(this.app))
      throw new Error("Same-host guard acceptance was interrupted by a full app restart after UI application");
    if (state.stage === "applied") {
      const listing = await session().listConfiguration();
      await this.check(state, "incoming configuration no longer deferred", listing.kind === "configuration" &&
        !listing.deferred.some(item => item.path === configurationPath));
      await this.check(state, "UI applied exact incoming hash", await this.exactLocal(configurationPath, configText(state.runId, 3)) &&
        await hashBlob(new TextEncoder().encode(await files.read(configurationPath))) === (await remote.head()).files[configurationPath]?.oid);
      await this.stage(state, "host-flush-started");
    }
    if (state.stage === "host-flush-started") {
      if (await this.exactLocal(configurationPath, configText(state.runId, 3)))
        await files.write(configurationPath, configText(state.runId, 4));
      await this.check(state, "host flush exact local bytes", await this.exactLocal(configurationPath, configText(state.runId, 4)));
      await plugin.syncOnce();
      const held = await session().listConfiguration();
      const flushed = await entryFromText(configText(state.runId, 4));
      await this.check(state, "same-host rewrite held by configuration guard", held.kind === "configuration" &&
        held.guarded.some(item => item.path === configurationPath && item.local?.oid === flushed.oid));
      await this.check(state, "host flush did not publish", (await remote.head()).files[configurationPath]?.data === (await entryFromText(configText(state.runId, 3))).data);
      if (!await files.exists(localNote)) await files.write(localNote, noteText(state.runId, "local"));
      await plugin.syncOnce();
      await this.check(state, "unrelated Android note converged while configuration held", (await remote.head()).files[localNote]?.data === (await entryFromText(noteText(state.runId, "local"))).data);
      state.commits.note = (await remote.head()).oid;
      await this.stage(state, "host-flush-held");
    }
    if (state.stage === "host-flush-held") {
      // The preview token is deliberately ephemeral; replay the same synthetic local edit after a process stop.
      if (await this.exactLocal(configurationPath, configText(state.runId, 5)))
        await files.write(configurationPath, configText(state.runId, 4));
      const old = await session().previewGuardedConfigurationPublication(configurationPath);
      if (old.kind !== "preview") throw new Error(`Guard preview unavailable: ${old.kind}`);
      await this.check(state, "guard preview shows exact host-flush bytes", old.entry?.data === (await entryFromText(configText(state.runId, 4))).data);
      await files.write(configurationPath, configText(state.runId, 5));
      const stale = await session().consentGuardedConfigurationPublication({ path: configurationPath, token: old.token });
      await this.check(state, "edited guarded version rejects stale consent", stale.kind === "stale");
      await this.check(state, "stale guard consent did not publish", (await remote.head()).files[configurationPath]?.data === (await entryFromText(configText(state.runId, 3))).data);
      await this.stage(state, "stale-guard-checked");
    }
    if (state.stage === "stale-guard-checked") {
      const fresh = await session().previewGuardedConfigurationPublication(configurationPath);
      if (fresh.kind !== "preview") throw new Error(`Fresh guard preview unavailable: ${fresh.kind}`);
      const expected = await entryFromText(configText(state.runId, 5));
      await this.check(state, "fresh guard preview exact bytes and hash", fresh.entry?.data === expected.data && fresh.version?.oid === expected.oid);
      const consent = await session().consentGuardedConfigurationPublication({ path: fresh.path, token: fresh.token });
      await this.check(state, "exact guarded version consent recorded", consent.kind === "recorded");
      await this.stage(state, "guard-consented");
    }
    if (state.stage === "guard-consented") {
      await plugin.syncOnce();
      const head = await remote.head();
      const expected = await entryFromText(configText(state.runId, 5));
      await this.check(state, "exact guarded consent published", head.files[configurationPath]?.data === expected.data && head.files[configurationPath]?.oid === expected.oid);
      await this.check(state, "unrelated notes remain on GitHub", head.files[localNote]?.data === (await entryFromText(noteText(state.runId, "local"))).data &&
        head.files[state.notePath]?.data === (await entryFromText(noteText(state.runId, "remote"))).data);
      await this.assertNoOtherHiddenPublished(state, remote);
      await this.assertHiddenPreserved(state, false);
      state.commits.final = head.oid;
      if (plugin.settings.automatic !== state.originalAutomatic)
        await plugin.saveConfiguration({ ...plugin.settings, automatic: state.originalAutomatic });
      await this.check(state, "automatic setting restored", plugin.settings.automatic === state.originalAutomatic);
      await this.stage(state, "complete");
      await this.writeSuccess(state);
    }
  }
}
