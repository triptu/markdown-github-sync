import {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  requestUrl,
  Modal,
  App,
  TextComponent,
} from "obsidian";
import {
  SyncEngine,
  type SyncState,
  type Transport,
  type Head,
  type RemoteObject,
} from "./engine";
import { generateSecret, VaultCrypto, base64ToBytes } from "./crypto";
import { ObsidianVaultPort } from "./vault-port";

interface Connection {
  endpoint: string;
  vaultId: string;
  token: string;
  secret: string;
}
interface Saved {
  connection: Connection;
  enabled: boolean;
  state?: SyncState;
}
const empty = (): Connection => ({
  endpoint: "",
  vaultId: "",
  token: "",
  secret: "",
});
function validate(c: Connection) {
  const url = new URL(c.endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use an HTTPS Worker origin, without a path or query.");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(c.vaultId))
    throw new Error(
      "Vault ID must be 16–128 letters, digits, dashes or underscores.",
    );
  if (c.token.length < 32)
    throw new Error("Server token must be at least 32 characters.");
  if (base64ToBytes(c.secret).length !== 32)
    throw new Error("Use the generated 32-byte encryption key.");
}
export default class CloudVaultSync extends Plugin {
  saved: Saved = { connection: empty(), enabled: false };
  status = "Not connected";
  private engine?: SyncEngine;
  private busy = false;
  private stopped = false;
  private timer?: number;
  private statusEl!: HTMLElement;
  async onload() {
    const data = await this.loadData();
    if (data) this.saved = data;
    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.saved.enabled ? "Waiting for sync" : "Paused");
    this.addSettingTab(new SyncSettings(this.app, this));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.sync(true);
      },
    });
    this.addCommand({
      id: "history",
      name: "Browse file history",
      callback: () => {
        new HistoryModal(this.app, this).open();
      },
    });
    this.addRibbonIcon("refresh-cw", "Sync vault", () => {
      void this.sync(true);
    });
    this.registerInterval(
      window.setInterval(() => {
        if (this.saved.enabled) void this.sync();
      }, 30000),
    );
    const schedule = () => {
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        if (this.saved.enabled) void this.sync();
      }, 1500);
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden && this.saved.enabled) void this.sync();
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.saved.enabled) void this.sync();
    });
  }
  onunload() {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
  }
  private setStatus(text: string) {
    this.status = text;
    this.statusEl.setText(`Cloud Sync: ${text}`);
  }
  async persist() {
    await this.saveData(this.saved);
  }
  async configure(connection: Connection) {
    if (this.busy) throw new Error("Wait for the current sync to finish.");
    validate(connection);
    connection = {
      ...connection,
      endpoint: new URL(connection.endpoint).origin,
    };
    // Binding existing baseline to a different remote/key is unsafe; use a new local vault instead.
    const previous = this.saved.connection;
    if (
      this.saved.state &&
      (connection.endpoint !== previous.endpoint ||
        connection.vaultId !== previous.vaultId ||
        connection.secret !== previous.secret)
    )
      throw new Error(
        "This vault already has sync history. Set up a new local vault to change server, vault ID, or encryption key.",
      );
    this.saved.connection = { ...connection };
    this.engine = undefined;
    await this.persist();
    this.setStatus("Connection saved");
  }
  async api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (this.stopped) throw new Error("Plugin unloaded");
    const c = this.saved.connection;
    validate(c);
    const response = await requestUrl({
      url: `${c.endpoint.replace(/\/$/, "")}/v1/vaults/${c.vaultId}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(
        response.status === 401
          ? "Server rejected the access token."
          : `Sync server returned ${response.status}.`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return response.json as T;
  }
  async sync(manual = false) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.setStatus("Syncing…");
    try {
      validate(this.saved.connection);
      if (!this.engine) {
        const transport: Transport = {
          heads: () => this.api("/heads"),
          get: (id, version) =>
            this.api(`/objects/${id}${version ? `?version=${version}` : ""}`),
          put: (id, body) => this.api(`/objects/${id}`, "PUT", body),
        };
        const port = new ObsidianVaultPort(this.app);
        this.engine = new SyncEngine({
          vaultId: this.saved.connection.vaultId,
          secret: this.saved.connection.secret,
          transport,
          port: {
            list: () => {
              this.guard();
              return port.list();
            },
            read: (p) => {
              this.guard();
              return port.read(p);
            },
            write: (...a) => {
              this.guard();
              return port.write(...a);
            },
            remove: (...a) => {
              this.guard();
              return port.remove(...a);
            },
          },
          state: this.saved.state,
          saveState: async (state) => {
            this.saved.state = state;
            await this.persist();
          },
        });
      }
      const r = await this.engine.sync();
      this.setStatus(
        `${r.uploaded} sent · ${r.downloaded} received${r.conflicts ? ` · ${r.conflicts} conflicts` : ""}${r.deferred ? " · retry pending" : ""}`,
      );
      if (manual || r.conflicts) new Notice(`Cloud Sync: ${this.status}`);
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : "Sync failed");
      if (manual) new Notice(this.status, 8000);
    } finally {
      this.busy = false;
    }
  }
  private guard() {
    if (this.stopped) throw new Error("Plugin unloaded");
  }
}
class SyncSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: CloudVaultSync,
  ) {
    super(app, plugin);
  }
  display() {
    const el = this.containerEl;
    el.empty();
    const p = this.plugin;
    const draft = { ...p.saved.connection };
    el.createEl("h2", { text: "Cloud Vault Sync" });
    new Setting(el)
      .setName("Sync status")
      .setDesc(p.status)
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            await p.sync(true);
            this.display();
          }),
      );
    new Setting(el)
      .setName("Automatic sync")
      .setDesc(
        "Sync changes while Obsidian is open; check other devices every 30 seconds.",
      )
      .addToggle((t) =>
        t.setValue(p.saved.enabled).onChange(async (v) => {
          p.saved.enabled = v;
          await p.persist();
        }),
      );
    el.createEl("h3", { text: "Connection" });
    const inputs: Partial<Record<keyof Connection, TextComponent>> = {};
    const field = (name: string, key: keyof Connection, secret = false) =>
      new Setting(el).setName(name).addText((t) => {
        inputs[key] = t;
        t.setValue(draft[key]);
        t.inputEl.type = secret ? "password" : "text";
        t.inputEl.autocomplete = "off";
        t.onChange((v) => {
          draft[key] = v.trim();
        });
      });
    field("Worker URL", "endpoint");
    field("Server access token", "token", true);
    field("Vault ID", "vaultId");
    field("Encryption key", "secret", true);
    new Setting(el)
      .setName("New remote vault")
      .setDesc(
        "Generate identifiers on the first device only. Transfer the same connection details to every other device.",
      )
      .addButton((b) =>
        b.setButtonText("Generate").onClick(() => {
          draft.vaultId = crypto.randomUUID();
          draft.secret = generateSecret();
          inputs.vaultId?.setValue(draft.vaultId);
          inputs.secret?.setValue(draft.secret);
          new ConnectionModal(this.app, draft).open();
        }),
      );
    new Setting(el)
      .setName("Save connection")
      .setDesc(
        "Token and key are stored locally in this plugin’s data.json. Keep that file private.",
      )
      .addButton((b) =>
        b.setButtonText("Save").onClick(async () => {
          try {
            await p.configure(draft);
            this.display();
          } catch (e) {
            new Notice(String(e));
          }
        }),
      );
    new Setting(el)
      .setName("Connect another device")
      .addButton((b) =>
        b
          .setButtonText("Show setup code")
          .onClick(() =>
            new ConnectionModal(this.app, p.saved.connection).open(),
          ),
      )
      .addButton((b) =>
        b
          .setButtonText("Import setup code")
          .onClick(() =>
            new ImportModal(this.app, p, () => this.display()).open(),
          ),
      );
    el.createEl("h3", { text: "Recovery" });
    new Setting(el)
      .setName("File history")
      .setDesc("Recover an older version as a separate file.")
      .addButton((b) =>
        b
          .setButtonText("Browse history")
          .onClick(() => new HistoryModal(this.app, p).open()),
      );
    el.createEl("p", {
      text: "Notes and attachments up to 8 MiB sync. Hidden folders, Obsidian settings and plugins are excluded. Conflicting edits are kept as separate files. Local recovery copies are kept in .cloud-vault-sync-recovery.",
    });
  }
}
class ConnectionModal extends Modal {
  constructor(
    app: App,
    private connection: Connection,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Private setup code" });
    this.contentEl.createEl("p", {
      text: "This code grants full access to your vault. Save the connection on this device, then transfer it privately to your other devices.",
    });
    const t = this.contentEl.createEl("textarea");
    t.value = JSON.stringify(this.connection);
    t.rows = 8;
    t.style.width = "100%";
    t.readOnly = true;
    t.addEventListener("click", () => t.select());
  }
}
class ImportModal extends Modal {
  constructor(
    app: App,
    private plugin: CloudVaultSync,
    private done: () => void,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Import private setup code" });
    const t = this.contentEl.createEl("textarea");
    t.rows = 8;
    t.style.width = "100%";
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Import and save")
        .setCta()
        .onClick(async () => {
          try {
            const v = JSON.parse(t.value);
            await this.plugin.configure({
              endpoint: v.endpoint,
              token: v.token,
              vaultId: v.vaultId,
              secret: v.secret,
            });
            this.close();
            this.done();
          } catch (e) {
            new Notice(String(e));
          }
        }),
    );
  }
}
class HistoryModal extends Modal {
  constructor(
    app: App,
    private plugin: CloudVaultSync,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "File history" });
    let path = this.app.workspace.getActiveFile()?.path ?? "";
    new Setting(this.contentEl)
      .setName("Vault file path")
      .addText((t) => t.setValue(path).onChange((v) => (path = v)));
    const results = this.contentEl.createDiv();
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Load versions").onClick(async () => {
        results.empty();
        const selectedPath = path;
        try {
          const c = this.plugin.saved.connection;
          const crypt = await VaultCrypto.create(c.vaultId, c.secret);
          const id = await crypt.id(selectedPath);
          const loadPage = async (before?: number): Promise<void> => {
            const response = await this.plugin.api<{
              versions: Head[];
              before: number | null;
            }>(`/history/${id}${before ? `?before=${before}` : ""}`);
            for (const v of response.versions) {
              new Setting(results)
                .setName(
                  `${new Date(v.updatedAt).toLocaleString()} · revision ${v.version}${v.deleted ? " · deleted" : ""}`,
                )
                .addButton((button) =>
                  button
                    .setButtonText("Recover copy")
                    .setDisabled(v.deleted)
                    .onClick(async () => {
                      try {
                        const object = await this.plugin.api<RemoteObject>(
                          `/objects/${id}?version=${v.version}`,
                        );
                        if (
                          object.id !== id ||
                          object.version !== v.version ||
                          object.deleted !== v.deleted
                        )
                          throw new Error("History metadata mismatch.");
                        const plain = await crypt.open(
                          id,
                          object.payload,
                          object.deleted,
                        );
                        if (plain.content === null)
                          throw new Error("This is a deletion marker.");
                        const dot = selectedPath.lastIndexOf("."),
                          split =
                            dot > selectedPath.lastIndexOf("/")
                              ? dot
                              : selectedPath.length;
                        const dest = `${selectedPath.slice(0, split)} (recovered ${v.version}-${crypto.randomUUID()})${selectedPath.slice(split)}`;
                        if (
                          !(await new ObsidianVaultPort(this.app).write(
                            dest,
                            base64ToBytes(plain.content),
                            plain.mtime,
                            null,
                          ))
                        )
                          throw new Error("Recovery destination exists.");
                        new Notice(`Recovered ${dest}`);
                      } catch (e) {
                        new Notice(String(e));
                      }
                    }),
                );
            }
            if (response.before !== null) {
              const more = new Setting(results).addButton((button) =>
                button
                  .setButtonText("Load older versions")
                  .onClick(async () => {
                    button.setDisabled(true);
                    try {
                      await loadPage(response.before!);
                      more.settingEl.remove();
                    } catch (e) {
                      new Notice(String(e));
                      button.setDisabled(false);
                    }
                  }),
              );
            }
            if (!before && !response.versions.length)
              results.setText("No versions found.");
          };
          await loadPage();
        } catch (e) {
          results.setText(String(e));
        }
      }),
    );
  }
}
