import { Plugin, requestUrl, TFile } from "obsidian";
import { FileJournalStore } from "../../src/git-sync/store";
import { GitObsidianVault } from "../../src/git-sync/obsidian-vault";
const id = "abcd1234-1234-1234-1234-123456789abc";
export default class NativeProbe extends Plugin {
  async onload() {
    this.app.workspace.onLayoutReady(() => {
      void this.run();
    });
  }
  async run() {
    if (this.app.vault.getName() !== "Vault Sync Lab") return;
    const results: { name: string; pass: boolean }[] = [];
    const check = (name: string, pass: boolean) => {
      results.push({ name, pass });
      if (!pass) throw new Error(name);
    };
    const files = this.app.vault.adapter;
    try {
      const store = new FileJournalStore(files, id);
      if (this.app.loadLocalStorage("git-sync-probe-stage") === 1) {
        const state = await store.load();
        check(
          "journal survives force-stop",
          JSON.stringify(state) ===
            JSON.stringify({
              marker: "native-journal",
              entry: { oid: "test", data: btoa("persistent bytes") },
            }),
        );
        check(
          "secret survives force-stop",
          this.app.secretStorage.getSecret("git-sync-probe") ===
            "synthetic-secret-only",
        );
        await files.write(
          ".git-sync-probe-restart.json",
          JSON.stringify({ results, platform: "android", completed: true }),
        );
        return;
      }
      this.app.secretStorage.setSecret(
        "git-sync-probe",
        "synthetic-secret-only",
      );
      check(
        "SecretStorage roundtrip",
        this.app.secretStorage.getSecret("git-sync-probe") ===
          "synthetic-secret-only",
      );
      const response = await requestUrl({
        url: "https://api.github.com/repos/obsidianmd/obsidian-releases",
        throw: false,
      });
      check(
        "native GitHub requestUrl",
        response.status === 200 &&
          response.json.full_name === "obsidianmd/obsidian-releases",
      );
      await store.save({
        marker: "native-journal",
        entry: { oid: "test", data: btoa("persistent bytes") },
      });
      check(
        "native append-only journal roundtrip",
        JSON.stringify(await new FileJournalStore(files, id).load()) ===
          JSON.stringify({
            marker: "native-journal",
            entry: { oid: "test", data: btoa("persistent bytes") },
          }),
      );
      const note = "Native probe.md";
      if (this.app.vault.getAbstractFileByPath(note) || this.app.vault.getAbstractFileByPath("Native attachment.bin"))
        throw new Error("Native probe fixture already exists; use a new disposable vault");
      await this.app.vault.create(note, "\uFEFFBefore\r\n");
      const vault = new GitObsidianVault(this.app);
      const captured = await vault.capture();
      const fixture = this.app.vault.getAbstractFileByPath(note);
      if (!(fixture instanceof TFile)) throw new Error("Missing fixture");
      await this.app.vault.modify(fixture, "A newer edit\n");
      const newer = await vault.capture();
      check(
        "stale local snapshot refuses replacement",
        (
          await vault.apply(note, captured[note], {
            ...captured[note],
            data: captured[note].data,
          })
        ).kind === "changed",
      );
      check(
        "native atomic markdown application",
        (await vault.apply(note, newer[note], captured[note])).kind ===
          "applied",
      );
      check(
        "BOM and CRLF retained",
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          await this.app.vault.readBinary(fixture),
        ) === "\uFEFFBefore\r\n",
      );
      await files.write(
        ".git-sync-probe-text-behavior.json",
        JSON.stringify({
          readText: await this.app.vault.read(fixture),
          binaryText: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            await this.app.vault.readBinary(fixture),
          ),
          repeat: await vault.apply(note, captured[note], newer[note]),
        }),
      );
      check(
        "unsafe native deletion held",
        (await vault.apply(note, newer[note], null)).kind === "blocked",
      );
      const binary = new Uint8Array(4321024);
      for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
      if (!this.app.vault.getAbstractFileByPath("Native attachment.bin"))
        await this.app.vault.createBinary(
          "Native attachment.bin",
          binary.buffer,
        );
      const roundtrip = await vault.capture();
      check(
        "4.32 MB native attachment capture",
        atob(roundtrip["Native attachment.bin"].data).length === binary.length,
      );
      this.app.saveLocalStorage("git-sync-probe-stage", 1);
      await files.write(
        ".git-sync-probe-result.json",
        JSON.stringify({ results, platform: "android", completed: true }),
      );
    } catch (error) {
      await files.write(
        ".git-sync-probe-error.json",
        JSON.stringify({
          results,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
