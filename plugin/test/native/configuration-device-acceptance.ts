import { defaultSettings } from "../../src/settings";
import { Platform, Plugin, requestUrl } from "obsidian";
import type GitVaultSync from "../../src/main";
import { entryFromText } from "../../src/git-sync/codec";
import type { CommitSnapshot, PreparedPublication } from "../../src/git-sync/contracts";
import { GitHubRepository } from "../../src/git-sync/github";
import { hostLifetimeId } from "../../src/git-sync/ownership";

declare const ACCEPTANCE_RUN_ID: string;
declare const ACCEPTANCE_BRANCH: string;
declare const EXPECTED_PRODUCTION_SHA: string;
declare const ANDROID_VAULT_PATH: string;

const owner = "triptu";
const repository = "vault-sync-test";
const secretId = `git-sync-config-${ACCEPTANCE_RUN_ID}-android`;
const root = `.native-config-device/${ACCEPTANCE_RUN_ID}`;
const configPath = ".obsidian/plugins/vault-sync-config-fixture/data.json";
const seedPath = `Configuration Lab ${ACCEPTANCE_RUN_ID}/Seed.md`;
const incomingNotePath = `Configuration Lab ${ACCEPTANCE_RUN_ID}/Incoming.md`;
const localNotePath = `Configuration Lab ${ACCEPTANCE_RUN_ID}/Local.md`;
const seedText = `Configuration acceptance seed ${ACCEPTANCE_RUN_ID}\n`;
const configText = (revision: number): string =>
  `${JSON.stringify({ acceptanceFixture: ACCEPTANCE_RUN_ID, revision, inert: true, challenge: "host-restart" })}\n`;
const incomingNoteText = `Unrelated incoming note ${ACCEPTANCE_RUN_ID}\n`;
const localNoteText = `Unrelated local note after restart ${ACCEPTANCE_RUN_ID}\n`;

type Stage = "await-hidden-consent" | "await-ui-apply" | "await-restart" |
  "await-guard-consent" | "complete";
type Check = { name: string; pass: boolean };
type State = {
  format: 1;
  runId: string;
  branch: string;
  productionSha256: string;
  fixtureInstallation: string;
  stage: Stage;
  firstHost: string;
  applyHost: string | null;
  restartHost: string | null;
  checks: Check[];
  commits: Record<string, string>;
};
const stages: readonly Stage[] = ["await-hidden-consent", "await-ui-apply", "await-restart", "await-guard-consent", "complete"];

async function prepareFixture(remote: GitHubRepository, parent: CommitSnapshot): Promise<PreparedPublication & { parent: string; anchor: string | null }> {
  const ledger = await remote.readLedger();
  const anchor = ledger.kind === "present" ? ledger.value : null;
  const candidate = await remote.prepare(parent, {
    [configPath]: await entryFromText(configText(2)),
    [incomingNotePath]: await entryFromText(incomingNoteText),
  }, `Configuration incoming ${ACCEPTANCE_RUN_ID}`, { anchor, operation: crypto.randomUUID() });
  return { ...candidate, parent: parent.oid, anchor };
}

export default class NativeConfigurationDeviceAcceptance extends Plugin {
  private running = false;

  onload(): void {
    this.addCommand({ id: "run-next", name: "Run next disposable Android configuration stage",
      callback: () => { void this.run(); } });
  }

  private guardVault(): void {
    const actual: unknown = Reflect.get(this.app.vault.adapter, "basePath");
    if (!Platform.isMobile || actual !== ANDROID_VAULT_PATH ||
        this.app.vault.getName() !== "Vault Sync Config Lab")
      throw new Error("This is not the exact new disposable Android configuration vault");
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

  private async hash(path: string): Promise<string> {
    const bytes = await this.app.vault.adapter.readBinary(path);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async remote(installation: string): Promise<GitHubRepository> {
    const remote = new GitHubRepository({ owner, name: repository, branch: ACCEPTANCE_BRANCH,
      installation, scopeRules: "config/1", configDir: ".obsidian",
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

  private check(state: State, name: string, pass: boolean): void {
    state.checks.push({ name, pass });
    if (!pass) throw new Error(name);
  }

  private async localIs(path: string, text: string): Promise<boolean> {
    const files = this.app.vault.adapter;
    return await files.exists(path) && await files.read(path) === text;
  }

  private async remoteIs(remote: GitHubRepository, path: string, text: string): Promise<boolean> {
    const entry = await entryFromText(text);
    const actual = (await remote.head()).files[path];
    return actual?.oid === entry.oid && actual.data === entry.data;
  }

  private async save(state: State, waitFor?: string): Promise<void> {
    const files = this.app.vault.adapter;
    await files.write(`${root}/state.json`, JSON.stringify(state, null, 2));
    await files.write(`${root}/progress.json`, JSON.stringify({
      runId: state.runId, branch: state.branch, productionSha256: state.productionSha256,
      stage: state.stage, waitFor: waitFor ?? null, checks: state.checks, commits: state.commits,
      firstHost: state.firstHost, applyHost: state.applyHost, restartHost: state.restartHost,
    }, null, 2));
  }

  private async stage(state: State, next: Stage, waitFor?: string): Promise<void> {
    state.stage = next;
    await this.save(state, waitFor);
    const path = `${root}/stage-${next}.json`;
    if (await this.app.vault.adapter.exists(path)) throw new Error(`Stage evidence already exists: ${next}`);
    await this.app.vault.adapter.write(path, JSON.stringify({
      runId: state.runId, stage: next, productionSha256: state.productionSha256,
      checks: state.checks, commits: state.commits, firstHost: state.firstHost,
      applyHost: state.applyHost, restartHost: state.restartHost,
    }, null, 2));
  }

  private async loadState(): Promise<State | null> {
    const path = `${root}/state.json`;
    if (!await this.app.vault.adapter.exists(path)) return null;
    const raw: unknown = JSON.parse(await this.app.vault.adapter.read(path));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid configuration acceptance state");
    const value = raw as Record<string, unknown>;
    if (value.format !== 1 || value.runId !== ACCEPTANCE_RUN_ID || value.branch !== ACCEPTANCE_BRANCH ||
        value.productionSha256 !== EXPECTED_PRODUCTION_SHA ||
        typeof value.fixtureInstallation !== "string" || !/^[0-9a-f-]{36}$/.test(value.fixtureInstallation) ||
        !stages.includes(value.stage as Stage) || typeof value.firstHost !== "string" ||
        !(value.applyHost === null || typeof value.applyHost === "string") ||
        !(value.restartHost === null || typeof value.restartHost === "string") ||
        !Array.isArray(value.checks) || typeof value.commits !== "object" || value.commits === null)
      throw new Error("Configuration acceptance state does not match this bundle");
    return raw as State;
  }

  private async assertFreshVisibleVault(): Promise<void> {
    const files = this.app.vault.adapter;
    const listed = await files.list("/");
    if (listed.files.some(path => !path.replace(/^\/+/, "").startsWith(".")) ||
        listed.folders.some(path => !path.replace(/^\/+/, "").startsWith(".")))
      throw new Error("Disposable vault already contains visible content");
  }

  private async provision(plugin: GitVaultSync): Promise<State> {
    if (plugin.settings.owner || plugin.settings.repository || plugin.settings.secretId || plugin.session)
      throw new Error("Production plugin is already configured; use a fresh disposable vault");
    await this.assertFreshVisibleVault();
    const response = await requestUrl({ url: `http://127.0.0.1:37922/bootstrap/${ACCEPTANCE_RUN_ID}/android` });
    const raw: unknown = JSON.parse(response.text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid loopback bootstrap");
    const bootstrap = raw as Record<string, unknown>;
    if (bootstrap.owner !== owner || bootstrap.repository !== repository || bootstrap.branch !== ACCEPTANCE_BRANCH ||
        bootstrap.runId !== ACCEPTANCE_RUN_ID || bootstrap.device !== "android" ||
        typeof bootstrap.token !== "string" || bootstrap.token.length < 20)
      throw new Error("Loopback bootstrap does not match this run");
    this.app.secretStorage.setSecret(secretId, bootstrap.token);
    await plugin.saveConfiguration({ ...defaultSettings(), format: 2, owner, repository, branch: ACCEPTANCE_BRANCH, secretId,
      deviceName: `Configuration lab ${ACCEPTANCE_RUN_ID}`, automatic: false, configuration: true });
    const active = this.production();
    if (!active.session) throw new Error("Production session failed to initialize");
    const fixtureInstallation = crypto.randomUUID();
    const remote = await this.remote(fixtureInstallation);
    const head = await remote.head();
    if (Object.keys(head.files).length !== 1 || !await this.remoteIs(remote, seedPath, seedText))
      throw new Error("Synthetic configuration branch has changed seed or extra files");
    const preview = await active.session.previewEnrollment();
    if (preview.kind !== "preview" || preview.repository.branch !== ACCEPTANCE_BRANCH ||
        !preview.items.some(item => item.path === seedPath && item.action === "download") ||
        preview.items.some(item => item.action !== "download" &&
          !(item.action === "upload" && item.path.startsWith(".obsidian/"))))
      throw new Error("Default config/1 enrollment preview has unexpected changes");
    if ((await active.session.enroll({ token: preview.token })).kind !== "enrolled")
      throw new Error("Production config/1 enrollment failed");
    await active.syncOnce();
    const listing = await active.session.listConfiguration();
    if (listing.kind !== "configuration" || listing.rules !== "config/1" ||
        !await this.localIs(seedPath, seedText)) throw new Error("Production config/1 seed did not enroll");
    const directory = ".obsidian/plugins/vault-sync-config-fixture";
    if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
    await this.app.vault.adapter.write(configPath, configText(1));
    await active.syncOnce();
    const offered = await active.session.listConfiguration();
    if (offered.kind !== "configuration" || !offered.unpublished.some(item => item.path === configPath) ||
        Object.hasOwn((await remote.head()).files, configPath))
      throw new Error("New hidden configuration was not held for consent");
    const state: State = { format: 1, runId: ACCEPTANCE_RUN_ID, branch: ACCEPTANCE_BRANCH,
      productionSha256: EXPECTED_PRODUCTION_SHA, fixtureInstallation,
      stage: "await-hidden-consent", firstHost: hostLifetimeId(this.app),
      applyHost: null, restartHost: null,
      checks: [
        { name: "installed production enrolled default config/1 and downloaded exact seed", pass: true },
        { name: "new local hidden configuration held before consent", pass: true },
      ], commits: { seed: head.oid } };
    await this.stage(state, "await-hidden-consent", `In production Configuration sync, approve only ${configPath}; then invoke this helper again.`);
    return state;
  }

  private async afterHiddenConsent(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const session = plugin.session;
    if (!session) throw new Error("Production session unavailable");
    const listing = await session.listConfiguration();
    if (listing.kind !== "configuration") throw new Error("Configuration listing unavailable");
    if (listing.unpublished.some(item => item.path === configPath)) {
      await this.save(state, `Approve only ${configPath} in the production Configuration sync UI.`);
      return;
    }
    this.check(state, "UI consent kept exact initial local bytes", await this.localIs(configPath, configText(1)));
    await plugin.syncOnce();
    const initial = await remote.head();
    this.check(state, "exact consented hidden addition published through production",
      await this.remoteIs(remote, configPath, configText(1)) &&
      Object.keys(initial.files).sort().join("|") === [configPath, seedPath].sort().join("|"));
    state.commits.initial = initial.oid;
    const candidate = await prepareFixture(remote, initial);
    await remote.publish({ parent: candidate.parent, candidate: candidate.oid,
      anchor: candidate.anchor, receipt: candidate.receipt });
    const ledger = await remote.readLedger();
    const fixture = await remote.head();
    this.check(state, "synthetic incoming fixture and ledger confirmed",
      fixture.oid === candidate.oid && ledger.kind === "present" && ledger.value === candidate.receipt &&
      await this.remoteIs(remote, configPath, configText(2)) &&
      await this.remoteIs(remote, incomingNotePath, incomingNoteText));
    state.commits.fixture = fixture.oid;
    await plugin.syncOnce();
    const deferred = await session.listConfiguration();
    const preview = await session.previewApplyConfiguration();
    const first = await entryFromText(configText(1));
    const second = await entryFromText(configText(2));
    this.check(state, "live configuration deferred while unrelated note downloaded",
      deferred.kind === "configuration" && deferred.deferred.length === 1 &&
      deferred.deferred[0]?.path === configPath &&
      deferred.deferred[0]?.expected?.oid === first.oid &&
      deferred.deferred[0]?.next?.oid === second.oid &&
      await this.localIs(configPath, configText(1)) &&
      await this.localIs(incomingNotePath, incomingNoteText));
    this.check(state, "production apply preview contains exact incoming bytes",
      preview.kind === "preview" && preview.blocked.length === 0 && preview.items.length === 1 &&
      preview.items[0]?.path === configPath &&
      preview.items[0]?.expectedEntry?.data === first.data &&
      preview.items[0]?.incomingEntry?.data === second.data);
    state.applyHost = hostLifetimeId(this.app);
    await this.stage(state, "await-ui-apply", "Apply the one incoming configuration in the production Configuration sync UI; then invoke this helper again before restarting.");
  }

  private async afterUiApply(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const session = plugin.session;
    if (!session) throw new Error("Production session unavailable");
    if (state.applyHost !== hostLifetimeId(this.app)) throw new Error("Host restarted before production UI apply was observed");
    if (!await this.localIs(configPath, configText(2))) {
      await this.save(state, "Apply the incoming configuration in production UI; then invoke this helper again.");
      return;
    }
    const listing = await session.listConfiguration();
    this.check(state, "production UI applied exact reviewed configuration",
      listing.kind === "configuration" && !listing.deferred.some(item => item.path === configPath) &&
      await this.remoteIs(remote, configPath, configText(2)));
    await this.app.vault.adapter.write(configPath, configText(3));
    await plugin.syncOnce();
    const held = await session.listConfiguration();
    const stale = await entryFromText(configText(3));
    this.check(state, "stale writer held in applying host before restart",
      held.kind === "configuration" && held.guarded.some(item => item.path === configPath && item.local?.oid === stale.oid) &&
      await this.localIs(configPath, configText(3)) && await this.remoteIs(remote, configPath, configText(2)));
    state.commits.beforeRestart = (await remote.head()).oid;
    await this.stage(state, "await-restart", "Fully force-stop and reopen Obsidian on this vault, then invoke this helper again.");
  }

  private async afterRestart(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const session = plugin.session;
    if (!session) throw new Error("Production session unavailable");
    if (state.applyHost === hostLifetimeId(this.app)) {
      await this.save(state, "A full Obsidian host restart is required; then invoke this helper again.");
      return;
    }
    this.check(state, "fresh host and stale bytes persisted across full restart",
      state.applyHost !== null && await this.localIs(configPath, configText(3)) &&
      (await remote.head()).oid === state.commits.beforeRestart);
    state.restartHost = hostLifetimeId(this.app);
    await plugin.syncOnce();
    const listing = await session.listConfiguration();
    const stale = await entryFromText(configText(3));
    this.check(state, "new host keeps stale configuration guarded and reviewed remote bytes",
      listing.kind === "configuration" && listing.guarded.some(item => item.path === configPath && item.local?.oid === stale.oid) &&
      await this.remoteIs(remote, configPath, configText(2)));
    this.check(state, "unrelated incoming note still exact after restart",
      await this.localIs(incomingNotePath, incomingNoteText));
    await this.app.vault.create(localNotePath, localNoteText);
    await plugin.syncOnce();
    this.check(state, "unrelated local note converged while configuration stayed held",
      await this.remoteIs(remote, localNotePath, localNoteText) &&
      await this.localIs(localNotePath, localNoteText) &&
      await this.remoteIs(remote, configPath, configText(2)));
    const guardPreview = await session.previewGuardedConfigurationPublication(configPath);
    const reviewed = await entryFromText(configText(2));
    this.check(state, "guard preview names exact reviewed source and stale local version",
      guardPreview.kind === "preview" && guardPreview.applied?.oid === reviewed.oid &&
      guardPreview.version?.oid === stale.oid && guardPreview.entry?.data === stale.data);
    state.commits.note = (await remote.head()).oid;
    await this.stage(state, "await-guard-consent", `In production Configuration sync, approve only guarded ${configPath}; then invoke this helper again.`);
  }

  private async afterGuardConsent(state: State, plugin: GitVaultSync, remote: GitHubRepository): Promise<void> {
    const session = plugin.session;
    if (!session) throw new Error("Production session unavailable");
    const second = await entryFromText(configText(2));
    const stale = await entryFromText(configText(3));
    await plugin.syncOnce();
    if (await this.remoteIs(remote, configPath, configText(2))) {
      await this.save(state, `Approve guarded ${configPath} in production UI; then invoke this helper again.`);
      return;
    }
    this.check(state, "only exact UI consented stale configuration published",
      await this.remoteIs(remote, configPath, configText(3)) &&
      await this.remoteIs(remote, incomingNotePath, incomingNoteText) &&
      await this.remoteIs(remote, localNotePath, localNoteText));
    state.commits.guarded = (await remote.head()).oid;
    await plugin.syncOnce();
    const cleared = await session.listConfiguration();
    this.check(state, "prior guard retired before historical restore",
      cleared.kind === "configuration" && !cleared.guarded.some(item => item.path === configPath));
    const history = await plugin.fileHistory({ path: configPath });
    this.check(state, "production file history contains incoming source commit",
      history.entries.some(item => item.commit === state.commits.fixture));
    const preview = await session.previewRestore({ path: configPath, commit: state.commits.fixture });
    this.check(state, "production restore preview has exact historical configuration",
      preview.kind === "preview" && preview.historical.data === second.data &&
      preview.current?.data === stale.data);
    if (preview.kind !== "preview") return;
    const restored = await session.restore({ token: preview.token, path: preview.path, commit: preview.commit });
    this.check(state, "production history restore wrote exact reviewed source bytes",
      restored.kind === "restored" && await this.localIs(configPath, configText(2)));
    await plugin.syncOnce();
    this.check(state, "historical configuration published as a new commit",
      await this.remoteIs(remote, configPath, configText(2)) &&
      (await remote.head()).oid !== state.commits.fixture);
    state.commits.restored = (await remote.head()).oid;
    await plugin.syncOnce();
    await this.app.vault.adapter.write(configPath, configText(3));
    await plugin.syncOnce();
    const sourceGuard = await session.previewGuardedConfigurationPublication(configPath);
    const finalListing = await session.listConfiguration();
    const finalHead = await remote.head();
    const finalStatus = await session.inspect();
    this.check(state, "new restore source guard holds stale writer without overwriting restored GitHub bytes",
      sourceGuard.kind === "preview" && sourceGuard.applied?.oid === second.oid &&
      sourceGuard.version?.oid === stale.oid && sourceGuard.entry?.data === stale.data &&
      finalListing.kind === "configuration" && finalListing.guarded.some(item => item.path === configPath && item.local?.oid === stale.oid) &&
      finalStatus.kind === "enrolled" && finalStatus.pause === null &&
      finalStatus.conflicts.length === 0 && finalStatus.blocked.length === 0 &&
      finalStatus.nativeErrors.length === 0 && finalStatus.commit === finalHead.oid &&
      finalHead.oid === state.commits.restored &&
      Object.keys(finalHead.files).sort().join("|") ===
        [seedPath, configPath, incomingNotePath, localNotePath].sort().join("|") &&
      await this.remoteIs(remote, configPath, configText(2)) &&
      await this.localIs(configPath, configText(3)));
    await this.stage(state, "complete");
    const path = `${root}/result.json`;
    if (await this.app.vault.adapter.exists(path)) throw new Error("Result already exists");
    await this.app.vault.adapter.write(path, JSON.stringify({ completed: true, runId: state.runId,
      branch: state.branch, productionSha256: state.productionSha256, configPath,
      bytes: { initial: configText(1), reviewed: configText(2), stale: configText(3),
        incomingNote: incomingNoteText, localNote: localNoteText },
      firstHost: state.firstHost, applyHost: state.applyHost, restartHost: state.restartHost,
      commits: state.commits, checks: state.checks, sourceGuardHeld: true,
    }, null, 2));
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let guarded = false;
    let state: State | null = null;
    try {
      this.guardVault(); // No vault write before exact physical path check.
      guarded = true;
      const files = this.app.vault.adapter;
      if (!await files.exists(".native-config-device")) await files.mkdir(".native-config-device");
      if (!await files.exists(root)) await files.mkdir(root);
      if (await files.exists(`${root}/result.json`)) return; // Failure and success results are immutable.
      if (await this.hash(".obsidian/plugins/github-vault-sync/main.js") !== EXPECTED_PRODUCTION_SHA)
        throw new Error("Installed production bundle SHA-256 differs from build argument");
      const plugin = this.production();
      state = await this.loadState();
      if (state === null) { await this.provision(plugin); return; }
      if (plugin.settings.owner !== owner || plugin.settings.repository !== repository ||
          plugin.settings.branch !== ACCEPTANCE_BRANCH || plugin.settings.secretId !== secretId ||
          plugin.settings.configuration !== true || plugin.settings.automatic !== false ||
          !this.app.secretStorage.getSecret(secretId) || !plugin.session)
        throw new Error("Production configuration or credential differs from this run");
      const remote = await this.remote(state.fixtureInstallation);
      switch (state.stage) {
        case "await-hidden-consent": await this.afterHiddenConsent(state, plugin, remote); break;
        case "await-ui-apply": await this.afterUiApply(state, plugin, remote); break;
        case "await-restart": await this.afterRestart(state, plugin, remote); break;
        case "await-guard-consent": await this.afterGuardConsent(state, plugin, remote); break;
        case "complete": throw new Error("Complete state has no immutable result");
      }
    } catch (error) {
      if (guarded) {
        const path = `${root}/result.json`;
        if (!await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, JSON.stringify({
          completed: false, runId: ACCEPTANCE_RUN_ID, branch: ACCEPTANCE_BRANCH,
          productionSha256: EXPECTED_PRODUCTION_SHA, failedAt: state?.stage ?? "preflight",
          checks: state?.checks ?? [], commits: state?.commits ?? {},
          error: error instanceof Error ? error.message : "Unknown failure",
        }, null, 2));
      }
    } finally { this.running = false; }
  }
}
