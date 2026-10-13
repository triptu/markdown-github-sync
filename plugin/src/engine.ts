import {
  VaultCrypto,
  MAX_FILE_BYTES,
  validPath,
  contentHash,
  bytesToBase64,
  base64ToBytes,
} from "./crypto";
export interface Head {
  id: string;
  version: number;
  deleted: boolean;
  updatedAt: number;
}
export interface RemoteObject extends Head {
  payload: string;
}
export interface Transport {
  heads(): Promise<{ heads: Head[]; cursor: number }>;
  get(id: string, version?: number): Promise<RemoteObject>;
  put(
    id: string,
    input: {
      base: number;
      payload: string;
      deleted: boolean;
      operationId: string;
    },
  ): Promise<Head>;
}
export interface LocalFile {
  data: Uint8Array;
  mtime: number;
}
export interface VaultPort {
  list(): Promise<string[]>;
  read(path: string): Promise<LocalFile | null>;
  /** Compare-and-swap: expected null requires absence; return false if current bytes differ. */
  write(
    path: string,
    data: Uint8Array,
    mtime: number,
    expected: Uint8Array | null,
  ): Promise<boolean>;
  remove(path: string, expected: Uint8Array): Promise<boolean>;
}
export interface Baseline {
  path: string;
  version: number;
  hash: string | null;
}
export interface SyncState {
  format: 1;
  vaultId: string;
  baseline: Record<string, Baseline>;
}
export interface SyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  deferred: number;
}
export interface EngineOptions {
  vaultId: string;
  secret: string;
  port: VaultPort;
  transport: Transport;
  state?: SyncState;
  saveState(state: SyncState): Promise<void>;
}
export class SyncEngine {
  private state: SyncState;
  private running: Promise<SyncResult> | null = null;
  constructor(private options: EngineOptions) {
    const state = options.state;
    if (state && (state.format !== 1 || state.vaultId !== options.vaultId))
      throw new Error(
        "Sync state belongs to another vault; reset it explicitly",
      );
    this.state = state
      ? structuredClone(state)
      : { format: 1, vaultId: options.vaultId, baseline: {} };
    for (const [id, baseline] of Object.entries(this.state.baseline))
      if (
        !/^[a-f0-9]{64}$/.test(id) ||
        !validPath(baseline.path) ||
        !Number.isSafeInteger(baseline.version) ||
        baseline.version < 1 ||
        !(baseline.hash === null || /^[a-f0-9]{64}$/.test(baseline.hash))
      )
        throw new Error("Invalid saved sync state");
  }
  sync(): Promise<SyncResult> {
    if (!this.running)
      this.running = this.run().finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async remember(id: string, baseline: Baseline): Promise<void> {
    const next = structuredClone(this.state);
    next.baseline[id] = baseline;
    await this.options.saveState(next);
    this.state = next;
  }
  private async run(): Promise<SyncResult> {
    const { vaultId, secret, port, transport } = this.options;
    const crypt = await VaultCrypto.create(vaultId, secret);
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      deferred: 0,
    };
    const response = await transport.heads();
    const heads = new Map<string, Head>();
    for (const h of response.heads) {
      if (
        !/^[a-f0-9]{64}$/.test(h.id) ||
        !Number.isSafeInteger(h.version) ||
        h.version < 1 ||
        typeof h.deleted !== "boolean" ||
        heads.has(h.id)
      )
        throw new Error("Invalid remote inventory");
      heads.set(h.id, h);
    }
    // Authenticate every unfamiliar head before mutating local files (wrong secrets fail closed).
    // Retain only metadata; download immutable revisions again during application so memory
    // is bounded by individual files, not the total size of a first-time vault download.
    const remote = new Map<
      string,
      { head: Head; path: string; hash: string | null; mtime: number }
    >();
    const fetchRemote = async (head: Head) => {
      const object = await transport.get(head.id, head.version);
      if (
        object.id !== head.id ||
        object.version !== head.version ||
        object.deleted !== head.deleted
      )
        throw new Error("Remote object metadata mismatch");
      const plain = await crypt.open(head.id, object.payload, head.deleted);
      const data = plain.content === null ? null : base64ToBytes(plain.content);
      return {
        path: plain.path,
        data,
        hash: data === null ? null : await contentHash(data),
        mtime: plain.mtime,
      };
    };
    for (const head of heads.values()) {
      const baseline = this.state.baseline[head.id];
      if (baseline && head.version < baseline.version)
        throw new Error(
          "Remote history regressed; refusing to overwrite files",
        );
      if (!baseline || baseline.version !== head.version) {
        const { path, hash, mtime } = await fetchRemote(head);
        remote.set(head.id, { head, path, hash, mtime });
      }
    }
    const paths = new Map<string, string>();
    for (const path of await port.list())
      if (validPath(path)) paths.set(await crypt.id(path), path);
    for (const [id, b] of Object.entries(this.state.baseline)) {
      if ((await crypt.id(b.path)) !== id)
        throw new Error("Saved state key mismatch");
      if (!heads.has(id))
        throw new Error(
          "Remote history missing; restore server data or use a new vault",
        );
      paths.set(id, b.path);
    }
    for (const [id, r] of remote) paths.set(id, r.path);
    // Different platforms normalize/case-fold names differently. Refuse the entire
    // pass before writes instead of silently overwriting one spelling with another.
    const portablePaths = new Map<string, string>();
    for (const path of paths.values()) {
      const portable = path.normalize("NFC").toLowerCase();
      const prior = portablePaths.get(portable);
      if (prior !== undefined && prior !== path)
        throw new Error(
          `Paths collide on another device: ${prior} and ${path}`,
        );
      portablePaths.set(portable, path);
    }
    for (const [id, path] of paths) {
      const baseline = this.state.baseline[id];
      const head = heads.get(id);
      const local = await port.read(path);
      if (local && local.data.length > MAX_FILE_BYTES)
        throw new Error(`File exceeds 8 MiB limit: ${path}`);
      const localHash = local ? await contentHash(local.data) : null;
      const changed = baseline ? localHash !== baseline.hash : local !== null;
      const incoming = remote.get(id);
      if (incoming) {
        const fetched = await fetchRemote(incoming.head);
        if (
          fetched.path !== incoming.path ||
          fetched.hash !== incoming.hash ||
          fetched.mtime !== incoming.mtime
        )
          throw new Error("Remote immutable revision changed during sync");
        const incomingHash = incoming.hash;
        if (changed && localHash !== incomingHash && local) {
          // Preserve a uniquely named sibling before replacing the original. Conflict files sync normally.
          const dot = path.lastIndexOf(".");
          const slash = path.lastIndexOf("/");
          const split = dot > slash ? dot : path.length;
          const conflictPath = `${path.slice(0, split)} (conflict ${crypto.randomUUID()})${path.slice(split)}`;
          if (!(await port.write(conflictPath, local.data, local.mtime, null)))
            throw new Error("Unable to preserve conflict copy");
          result.conflicts++;
        }
        // Remote edits win over local deletion; local nonempty conflicts survive in a sibling.
        let applied = true;
        if (incomingHash !== localHash)
          applied =
            fetched.data === null
              ? !local || (await port.remove(path, local.data))
              : await port.write(
                  path,
                  fetched.data,
                  incoming.mtime,
                  local?.data ?? null,
                );
        if (!applied) {
          result.deferred++;
          continue;
        }
        await this.remember(id, {
          path,
          version: incoming.head.version,
          hash: incomingHash,
        });
        result.downloaded++;
      } else if (changed) {
        const deleted = local === null;
        const payload = await crypt.seal(id, {
          path,
          content: local ? bytesToBase64(local.data) : null,
          mtime: local?.mtime ?? Date.now(),
          deleted,
        });
        try {
          const updated = await transport.put(id, {
            base: head?.version ?? 0,
            payload,
            deleted,
            operationId: crypto.randomUUID(),
          });
          if (
            updated.id !== id ||
            !Number.isSafeInteger(updated.version) ||
            updated.version <= (head?.version ?? 0) ||
            updated.deleted !== deleted
          )
            throw new Error("Invalid commit response");
          // Store the submitted hash, not a re-read: edits during upload remain dirty next pass.
          await this.remember(id, {
            path,
            version: updated.version,
            hash: localHash,
          });
          result.uploaded++;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 409
          )
            result.deferred++;
          else throw error;
        }
      }
    }
    return result;
  }
}
