import { Plugin, TFile, requestUrl } from "obsidian";
import type GitVaultSync from "../../src/main";
import { decodeBase64, entryFromBytes, entryFromText } from "../../src/git-sync/codec";
import { GitHubRepository } from "../../src/git-sync/github";
import type { Entry } from "../../src/git-sync/contracts";

const owner = "triptu";
const repository = "vault-sync-test";
const branch = "native-android-1791894436601";
const expectedProductionSha = "3d076efb958be8cc672a6e76f754af171d9bdf13ed9c94fae2c05a6941dae4ea";
const progressPath = ".git-sync-native-conflict-progress.json";
const resultPath = ".git-sync-native-conflict-result.json";
const autoStagePath = ".git-sync-native-conflict-auto-stage.json";
const autoResultPath = ".git-sync-native-conflict-auto-result.json";
const holdConflict = ".git-sync-native-conflict-hold-conflict";
const holdBlocked = ".git-sync-native-conflict-hold-blocked";

type Check = { name: string; pass: boolean };
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export default class NativeConflictAcceptance extends Plugin {
  onload(): void {
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => { void this.execute(); }, 2000);
    });
  }

  private async productionHash(): Promise<string> {
    const bytes = await this.app.vault.adapter.readBinary(".obsidian/plugins/github-vault-sync/main.js");
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async execute(): Promise<void> {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    if (!(await this.runAutomaticPair())) return;
    await this.run();
  }

  /** An automatic two-file run is checked again after an external app restart. */
  private async runAutomaticPair(): Promise<boolean> {
    const files = this.app.vault.adapter;
    if (await files.exists(autoResultPath)) {
      const result: unknown = JSON.parse(await files.read(autoResultPath));
      return typeof result === "object" && result !== null && Reflect.get(result, "completed") === true;
    }
    const checks: Check[] = [];
    const check = (name: string, pass: boolean): void => {
      checks.push({ name, pass });
      if (!pass) throw new Error(name);
    };
    let paths: { local: string; remote: string } | null = null;
    let commit: string | null = null;
    try {
      check("r7 installed bundle hash", await this.productionHash() === expectedProductionSha);
      const manager: unknown = Reflect.get(this.app, "plugins");
      if (typeof manager !== "object" || manager === null) throw new Error("Plugin manager unavailable");
      const installed: unknown = Reflect.get(manager, "plugins");
      if (typeof installed !== "object" || installed === null) throw new Error("Plugin registry unavailable");
      const candidate: unknown = Reflect.get(installed, "github-vault-sync");
      if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "syncOnce") !== "function") throw new Error("Production plugin unavailable");
      const plugin = candidate as GitVaultSync;
      check("automatic lab configuration guarded", plugin.settings.owner === owner && plugin.settings.repository === repository && plugin.settings.branch === branch && plugin.settings.secretId === "git-sync-native-lab" && plugin.settings.automatic);
      check("automatic session enrolled", (await plugin.session?.inspect())?.kind === "enrolled");
      const remote = new GitHubRepository({
        owner, name: repository, branch,
        token: async () => this.app.secretStorage.getSecret("git-sync-native-lab") ?? "",
        transport: {
          request: async ({ url, method, headers, body }) => {
            const response = await requestUrl({ url, method, headers, body, throw: false });
            let json: unknown = null;
            try { json = JSON.parse(response.text); } catch { /* Repository validation owns malformed responses. */ }
            return { status: response.status, headers: response.headers, json };
          },
        },
      });
      const identity = await remote.identity();
      check("automatic repository is private lab target", identity.owner === owner && identity.name === repository && identity.branch === branch);
      const remoteText = "Committed to private lab while Android automatic sync was enabled.\n";
      const localText = "Created through native Obsidian vault for automatic sync.\n";
      if (await files.exists(autoStagePath)) {
        const saved: unknown = JSON.parse(await files.read(autoStagePath));
        if (typeof saved !== "object" || saved === null || Reflect.get(saved, "kind") !== "await-restart") throw new Error("Invalid automatic stage");
        const local: unknown = Reflect.get(saved, "local");
        const remotePath: unknown = Reflect.get(saved, "remote");
        const savedCommit: unknown = Reflect.get(saved, "commit");
        if (typeof local !== "string" || typeof remotePath !== "string" || typeof savedCommit !== "string" || !local.startsWith("Native Automatic Acceptance ") || !remotePath.startsWith("Native Automatic Acceptance ")) throw new Error("Invalid automatic paths");
        paths = { local, remote: remotePath };
        commit = savedCommit;
        const status = await plugin.session?.inspect();
        const head = await remote.head();
        const localFile = this.app.vault.getAbstractFileByPath(local);
        const remoteFile = this.app.vault.getAbstractFileByPath(remotePath);
        check("automatic checkpoint survives app restart", status?.kind === "enrolled" && status.phase === "idle" && status.commit === head.oid && status.pending?.length === 0);
        check("both automatic files survive app restart", localFile instanceof TFile && remoteFile instanceof TFile && await this.app.vault.read(localFile) === localText && await this.app.vault.read(remoteFile) === remoteText);
        check("both automatic bytes persist on GitHub", head.files[local]?.data === btoa(localText) && head.files[remotePath]?.data === btoa(remoteText));
        await files.write(autoResultPath, JSON.stringify({ completed: true, checks, paths, commit, afterRestart: head.oid, productionSha256: expectedProductionSha }));
        return true;
      }
      const initial = await remote.head();
      const directory = `Native Automatic Acceptance ${crypto.randomUUID()}`;
      paths = { local: `${directory}/Android.md`, remote: `${directory}/GitHub.md` };
      check("fresh pair paths unused", !Object.hasOwn(initial.files, paths.local) && !Object.hasOwn(initial.files, paths.remote) && !this.app.vault.getAbstractFileByPath(directory));
      const candidateCommit = await remote.prepare(initial, { [paths.remote]: await entryFromText(remoteText) }, `Native automatic pair ${directory}`);
      check("fresh remote file published", (await remote.publish(initial.oid, candidateCommit.oid)).kind === "accepted");
      await this.app.vault.createFolder(directory);
      await this.app.vault.create(paths.local, localText);
      const deadline = Date.now() + 180_000;
      let head = await remote.head();
      let status = await plugin.session?.inspect();
      while (Date.now() < deadline) {
        const remoteFile = this.app.vault.getAbstractFileByPath(paths.remote);
        if (status?.kind === "enrolled" && status.phase === "idle" && status.commit === head.oid && status.pending?.length === 0 &&
            head.files[paths.local]?.data === btoa(localText) && head.files[paths.remote]?.data === btoa(remoteText) &&
            remoteFile instanceof TFile && await this.app.vault.read(remoteFile) === remoteText) break;
        await new Promise(resolve => setTimeout(resolve, 3000));
        head = await remote.head();
        status = await plugin.session?.inspect();
      }
      check("automatic fresh pair converged without Sync now", status?.kind === "enrolled" && status.phase === "idle" && status.commit === head.oid && status.pending?.length === 0 && head.files[paths.local]?.data === btoa(localText) && head.files[paths.remote]?.data === btoa(remoteText));
      const remoteFile = this.app.vault.getAbstractFileByPath(paths.remote);
      check("automatic remote file reached native vault", remoteFile instanceof TFile && await this.app.vault.read(remoteFile) === remoteText);
      commit = head.oid;
      await files.write(autoStagePath, JSON.stringify({ kind: "await-restart", ...paths, commit }));
      await files.write(progressPath, JSON.stringify({ stage: "automatic-converged-await-restart", checks, paths, commit, productionSha256: expectedProductionSha }));
      return false;
    } catch (error) {
      await files.write(autoResultPath, JSON.stringify({ completed: false, checks, paths, commit, error: error instanceof Error ? error.message : "Unknown automatic failure", productionSha256: expectedProductionSha }));
      return false;
    }
  }

  private async run(): Promise<void> {
    // This probe is inert in every other vault, including the user's real vault.
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const files = this.app.vault.adapter;
    if (await files.exists(resultPath)) return;
    const checks: Check[] = [];
    const check = (name: string, pass: boolean): void => {
      checks.push({ name, pass });
      if (!pass) throw new Error(name);
    };
    let plugin: GitVaultSync | null = null;
    let originalAutomatic: boolean | null = null;
    const runId = crypto.randomUUID();
    const directory = `Native Conflict Acceptance ${runId}`;
    const overlap = `${directory}/Overlap.md`;
    const binary = `${directory}/Existing.bin`;
    const removed = `${directory}/Remote deletion.md`;
    const paths = { overlap, binary, removed };
    const commits: Record<string, string> = {};
    const exports: string[] = [];
    const progress = async (stage: string): Promise<void> => {
      await files.write(progressPath, JSON.stringify({ stage, runId, paths, checks, commits }));
    };
    const waitForScreenshot = async (marker: string): Promise<void> => {
      const deadline = Date.now() + 120_000;
      while (await files.exists(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    try {
      const manager: unknown = Reflect.get(this.app, "plugins");
      if (typeof manager !== "object" || manager === null) throw new Error("Plugin manager unavailable");
      const installed: unknown = Reflect.get(manager, "plugins");
      if (typeof installed !== "object" || installed === null) throw new Error("Plugin registry unavailable");
      const candidate: unknown = Reflect.get(installed, "github-vault-sync");
      if (typeof candidate !== "object" || candidate === null || typeof Reflect.get(candidate, "syncOnce") !== "function")
        throw new Error("Production plugin unavailable");
      plugin = candidate as GitVaultSync;
      check("r7 installed bundle hash", await this.productionHash() === expectedProductionSha);
      check("exact private lab target configured", plugin.settings.owner === owner && plugin.settings.repository === repository && plugin.settings.branch === branch);
      check("lab credential referenced", plugin.settings.secretId === "git-sync-native-lab" && Boolean(this.app.secretStorage.getSecret("git-sync-native-lab")));
      check("production session enrolled", (await plugin.session?.inspect())?.kind === "enrolled");
      originalAutomatic = plugin.settings.automatic;
      await plugin.saveConfiguration({ ...plugin.settings, automatic: false });
      check("automatic sync paused for controlled scenario", !plugin.settings.automatic);

      const remote = new GitHubRepository({
        owner, name: repository, branch,
        token: async () => this.app.secretStorage.getSecret("git-sync-native-lab") ?? "",
        transport: {
          request: async ({ url, method, headers, body }) => {
            const response = await requestUrl({ url, method, headers, body, throw: false });
            let json: unknown = null;
            try { json = JSON.parse(response.text); } catch { /* GitHubRepository rejects malformed responses. */ }
            return { status: response.status, headers: response.headers, json };
          },
        },
      });
      const identity = await remote.identity();
      check("GitHub confirms private lab identity", identity.owner === owner && identity.name === repository && identity.branch === branch);
      const initial = await remote.head();
      commits.initial = initial.oid;
      check("fixture paths unused on GitHub", Object.values(paths).every((path) => !Object.hasOwn(initial.files, path)));
      check("fixture paths unused in vault", Object.values(paths).every((path) => !this.app.vault.getAbstractFileByPath(path)) && !this.app.vault.getAbstractFileByPath(directory));

      const baseText = "Shared line for conflict acceptance.\n";
      const localText = "Android changed the shared line.\n";
      const remoteText = "GitHub changed the shared line.\n";
      const acceptedText = "Reviewed and accepted exact merged bytes.\n";
      const removedText = "Original text must remain on Android after remote deletion.\n";
      const binaryBefore = new Uint8Array([0, 255, 17, 35, 68, 0, 201, 10]);
      const binaryAfter = new Uint8Array([0, 255, 17, 35, 69, 0, 202, 10]);
      const seeded = await remote.prepare(initial, {
        [overlap]: await entryFromText(baseText),
        [binary]: await entryFromBytes(binaryBefore),
        [removed]: await entryFromText(removedText),
      }, `Native conflict acceptance fixture ${runId}`);
      check("fixture seed published with exact expected head", (await remote.publish(initial.oid, seeded.oid)).kind === "accepted");
      commits.seed = seeded.oid;
      await progress("seeded");
      await plugin.syncOnce();
      const overlapFile = this.app.vault.getAbstractFileByPath(overlap);
      const binaryFile = this.app.vault.getAbstractFileByPath(binary);
      const removedFile = this.app.vault.getAbstractFileByPath(removed);
      check("seed downloaded into native vault", overlapFile instanceof TFile && binaryFile instanceof TFile && removedFile instanceof TFile &&
        await this.app.vault.read(overlapFile) === baseText &&
        bytesEqual(new Uint8Array(await this.app.vault.readBinary(binaryFile)), binaryBefore) &&
        await this.app.vault.read(removedFile) === removedText);

      if (!(overlapFile instanceof TFile)) throw new Error("Missing overlap fixture");
      await this.app.vault.modify(overlapFile, localText);
      await plugin.notifyLocalChange();
      const conflictCommit = await remote.prepare(await remote.head(), { [overlap]: await entryFromText(remoteText) }, `Native overlapping edit ${runId}`);
      check("remote overlapping edit published", (await remote.publish(seeded.oid, conflictCommit.oid)).kind === "accepted");
      commits.conflict = conflictCommit.oid;
      await plugin.syncOnce();
      const conflictStatus = await plugin.session?.inspect();
      const conflict = conflictStatus?.kind === "enrolled" ? conflictStatus.conflicts.find((item) => item.kind !== "collision" && item.path === overlap) : undefined;
      check("same-file conflict appears in production inbox", conflictStatus?.kind === "enrolled" && conflictStatus.phase === "needs-decision" && conflict?.kind === "content");
      check("conflicting local bytes untouched", await this.app.vault.read(overlapFile) === localText);
      await progress("conflict-inbox");
      await waitForScreenshot(holdConflict);
      if (!conflict) throw new Error("Conflict disappeared");
      check("reviewed merge decision recorded", (await plugin.session?.resolve({
        conflictId: conflict.id,
        choice: { kind: "edit", data: btoa(acceptedText) },
      }))?.kind === "recorded");
      await plugin.syncOnce();
      const accepted = await remote.head();
      commits.accepted = accepted.oid;
      check("accepted bytes on GitHub exactly match reviewed decision", accepted.files[overlap]?.data === btoa(acceptedText));
      check("accepted bytes in native vault", await this.app.vault.read(overlapFile) === acceptedText);
      const acceptedStatus = await plugin.session?.inspect();
      check("conflict resolved and checkpoint advanced", acceptedStatus?.kind === "enrolled" && acceptedStatus.phase === "idle" && acceptedStatus.commit === accepted.oid && acceptedStatus.conflicts.length === 0);
      await progress("conflict-resolved");

      const incoming = await remote.prepare(accepted, {
        [binary]: await entryFromBytes(binaryAfter),
        [removed]: null,
      }, `Native binary replacement and deletion ${runId}`);
      check("remote binary and deletion published", (await remote.publish(accepted.oid, incoming.oid)).kind === "accepted");
      commits.incoming = incoming.oid;
      await plugin.syncOnce();
      const deletionStatus = await plugin.session?.inspect();
      const deletionConflict = deletionStatus?.kind === "enrolled" ? deletionStatus.conflicts.find((item) => item.kind !== "collision" && item.path === removed) : undefined;
      check("remote deletion requires explicit review", deletionStatus?.kind === "enrolled" && deletionConflict?.kind === "remote-deletion");
      check("deletion review preserves local bytes", removedFile instanceof TFile && await this.app.vault.read(removedFile) === removedText);
      if (!deletionConflict) throw new Error("Deletion conflict disappeared");
      check("remote deletion decision recorded", (await plugin.session?.resolve({ conflictId: deletionConflict.id, choice: { kind: "remote" } }))?.kind === "recorded");
      await plugin.syncOnce();
      const blocked = await plugin.session?.inspect();
      check("binary replacement blocked by native vault", blocked?.kind === "enrolled" && blocked.phase === "blocked" && blocked.blocked.some((step) => step.path === binary && step.reason.includes("atomic binary replacement")));
      check("remote deletion blocked by native vault", blocked?.kind === "enrolled" && blocked.blocked.some((step) => step.path === removed && step.reason.includes("controlled manual apply")));
      check("blocked files remain byte-for-byte untouched", binaryFile instanceof TFile && removedFile instanceof TFile &&
        bytesEqual(new Uint8Array(await this.app.vault.readBinary(binaryFile)), binaryBefore) &&
        await this.app.vault.read(removedFile) === removedText);
      const headAfterBlock = await remote.head();
      check("GitHub retains incoming binary and deletion", headAfterBlock.oid === incoming.oid &&
        headAfterBlock.files[binary]?.data === (await entryFromBytes(binaryAfter)).data && !Object.hasOwn(headAfterBlock.files, removed));
      await progress("blocked-inbox");
      await waitForScreenshot(holdBlocked);

      const records = await plugin.session?.listRecovery();
      if (!Array.isArray(records)) throw new Error("Recovery list unavailable");
      let beforeRecord: string | null = null;
      let afterRecord: string | null = null;
      for (const record of records) {
        if (!record.paths.includes(binary) && !record.paths.includes(removed)) continue;
        const snapshot = await plugin.session?.exportRecovery({ id: record.id });
        if (!snapshot || "kind" in snapshot) continue;
        const binaryEntry: Entry | undefined = snapshot[binary];
        if (binaryEntry && bytesEqual(decodeBase64(binaryEntry.data), binaryBefore) && snapshot[removed]?.data === btoa(removedText)) beforeRecord = record.id;
        if (binaryEntry && bytesEqual(decodeBase64(binaryEntry.data), binaryAfter)) afterRecord = record.id;
      }
      check("preimage and incoming binary both in recovery records", beforeRecord !== null && afterRecord !== null);
      if (!beforeRecord || !afterRecord) throw new Error("Missing recovery records");
      for (const id of [beforeRecord, afterRecord]) {
        const directoryPath = await plugin.exportRecoveryCopy(id);
        exports.push(directoryPath);
      }
      check("preimage export has untouched binary and deleted note", bytesEqual(new Uint8Array(await files.readBinary(`${exports[0]}/${binary}`)), binaryBefore) &&
        new TextDecoder().decode(await files.readBinary(`${exports[0]}/${removed}`)) === removedText);
      check("incoming export has remote binary bytes", bytesEqual(new Uint8Array(await files.readBinary(`${exports[1]}/${binary}`)), binaryAfter));
      await files.write(resultPath, JSON.stringify({ completed: true, checks, paths, commits, exports, device: "Android 15 emulator", obsidian: "1.14.4" }));
      await progress("complete");
    } catch (error) {
      await files.write(resultPath, JSON.stringify({ completed: false, checks, paths, commits, exports, error: error instanceof Error ? error.message : "Unknown failure" }));
      await progress("failed");
    } finally {
      if (plugin && originalAutomatic !== null) {
        try {
          await plugin.saveConfiguration({ ...plugin.settings, automatic: originalAutomatic });
        } catch (error) {
          await files.write(".git-sync-native-conflict-restore-error.json", JSON.stringify({ error: error instanceof Error ? error.message : "Unknown restore failure" }));
        }
      }
    }
  }
}
