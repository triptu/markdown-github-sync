import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SyncEngine,
  type SyncState,
  type VaultPort,
  type Transport,
  type RemoteObject,
  type LocalFile,
} from "../src/engine";
import {
  generateSecret,
  equalBytes,
  VaultCrypto,
  bytesToBase64,
} from "../src/crypto";
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (file: LocalFile | null) =>
  file && new TextDecoder().decode(file.data);
class MemoryVault implements VaultPort {
  files = new Map<string, LocalFile>();
  beforeWrite?: () => void;
  async list() {
    return [...this.files.keys()];
  }
  async read(path: string) {
    const file = this.files.get(path);
    return file ? { data: file.data.slice(), mtime: file.mtime } : null;
  }
  edit(path: string, text: string) {
    this.files.set(path, { data: encode(text), mtime: Date.now() });
  }
  async write(
    path: string,
    data: Uint8Array,
    mtime: number,
    expected: Uint8Array | null,
  ) {
    this.beforeWrite?.();
    this.beforeWrite = undefined;
    if (!equalBytes(this.files.get(path)?.data ?? null, expected)) return false;
    this.files.set(path, { data: data.slice(), mtime });
    return true;
  }
  async remove(path: string, expected: Uint8Array) {
    if (!equalBytes(this.files.get(path)?.data ?? null, expected)) return false;
    this.files.delete(path);
    return true;
  }
}
class MemoryServer implements Transport {
  objects = new Map<string, RemoteObject>();
  revision = 0;
  beforePut?: () => void;
  async heads() {
    return {
      heads: [...this.objects.values()].map(({ payload, ...h }) => ({ ...h })),
      cursor: this.objects.size,
    };
  }
  async get(id: string, version?: number) {
    const o = this.objects.get(id);
    assert(o);
    assert.equal(o.version, version);
    return { ...o };
  }
  async put(id: string, input: Parameters<Transport["put"]>[1]) {
    this.beforePut?.();
    this.beforePut = undefined;
    const old = this.objects.get(id);
    if ((old?.version ?? 0) !== input.base)
      throw Object.assign(new Error("Conflict"), { status: 409 });
    const object = {
      id,
      version: ++this.revision,
      deleted: input.deleted,
      updatedAt: Date.now(),
      payload: input.payload,
    };
    this.objects.set(id, object);
    const { payload, ...head } = object;
    return head;
  }
}
const vaultId = "test-vault-123456789";
function device(server: MemoryServer, secret: string) {
  const port = new MemoryVault();
  let state: SyncState | undefined;
  const engine = new SyncEngine({
    vaultId,
    secret,
    port,
    transport: server,
    saveState: async (s) => {
      state = s;
    },
  });
  return { port, engine, state: () => state };
}
test("two devices sync initial union, binary attachments, offline edits and known deletions", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("note.md", "hello");
  b.port.edit("phone.md", "mobile");
  a.port.files.set("image.bin", {
    data: new Uint8Array([0, 255, 2]),
    mtime: 1,
  });
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  assert.equal(decode(await a.port.read("phone.md")), "mobile");
  assert.deepEqual(
    (await b.port.read("image.bin"))?.data,
    new Uint8Array([0, 255, 2]),
  );
  a.port.edit("note.md", "offline update");
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(decode(await b.port.read("note.md")), "offline update");
  b.port.files.delete("note.md");
  await b.engine.sync();
  await a.engine.sync();
  assert.equal(await a.port.read("note.md"), null);
  const fresh = device(server, secret);
  await fresh.engine.sync();
  assert.equal(await fresh.port.read("note.md"), null);
  assert(await fresh.port.read("phone.md"));
});
test("concurrent edits retain local bytes in a conflict sibling and converge", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("note.md", "base");
  await a.engine.sync();
  await b.engine.sync();
  a.port.edit("note.md", "desktop");
  b.port.edit("note.md", "phone");
  await a.engine.sync();
  assert.equal((await b.engine.sync()).conflicts, 1);
  assert.equal(decode(await b.port.read("note.md")), "desktop");
  const conflict = (await b.port.list()).find((p) => p.includes("(conflict "));
  assert(conflict);
  assert.equal(decode(await b.port.read(conflict)), "phone");
  await b.engine.sync();
  await a.engine.sync();
  assert.equal(decode(await a.port.read(conflict)), "phone");
});
test("wrong secret and tampering fail before any local mutation", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret);
  a.port.edit("note.md", "original");
  await a.engine.sync();
  const b = device(server, generateSecret());
  b.port.edit("local.md", "keep");
  await assert.rejects(b.engine.sync());
  assert.deepEqual(await b.port.list(), ["local.md"]);
  const object = [...server.objects.values()][0];
  object.deleted = true;
  const c = device(server, secret);
  await assert.rejects(c.engine.sync());
  assert.equal(c.port.files.size, 0);
});
test("edit while downloading fails CAS and survives next reconciliation", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("note.md", "base");
  await a.engine.sync();
  await b.engine.sync();
  a.port.edit("note.md", "remote");
  await a.engine.sync();
  b.port.beforeWrite = () => b.port.edit("note.md", "typing");
  assert.equal((await b.engine.sync()).deferred, 1);
  assert.equal(decode(await b.port.read("note.md")), "typing");
  assert.equal((await b.engine.sync()).conflicts, 1);
  assert.equal(decode(await b.port.read("note.md")), "remote");
  assert([...b.port.files.values()].some((f) => decode(f) === "typing"));
});
test("edit during upload remains dirty and uploads next pass", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("note.md", "first");
  server.beforePut = () => a.port.edit("note.md", "second");
  await a.engine.sync();
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(decode(await b.port.read("note.md")), "second");
});
test("committed upload followed by failed state save reconciles after restart", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    port = new MemoryVault();
  port.edit("note.md", "keep");
  const failing = new SyncEngine({
    vaultId,
    secret,
    port,
    transport: server,
    saveState: async () => {
      throw new Error("Disk full");
    },
  });
  await assert.rejects(failing.sync(), /Disk full/);
  assert.equal(server.objects.size, 1);
  const recovered = new SyncEngine({
    vaultId,
    secret,
    port,
    transport: server,
    saveState: async () => {},
  });
  await recovered.sync();
  assert.deepEqual(await port.list(), ["note.md"]);
  assert.equal([...server.objects.values()][0].version, 1);
});
test("server commit conflict is deferred without dropping local edits", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret);
  a.port.edit("note.md", "mine");
  server.beforePut = () => {
    throw Object.assign(new Error("race"), { status: 409 });
  };
  assert.equal((await a.engine.sync()).deferred, 1);
  assert.equal(decode(await a.port.read("note.md")), "mine");
  server.beforePut = undefined;
  assert.equal((await a.engine.sync()).uploaded, 1);
});
test("hidden files excluded and crypto rejects unsafe paths", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret);
  a.port.edit(".obsidian/settings.json", "private");
  a.port.edit(".git/config", "private");
  a.port.edit("allowed.md", "public");
  await a.engine.sync();
  assert.equal(server.objects.size, 1);
  const crypt = await VaultCrypto.create(vaultId, secret);
  for (const path of [
    "../secret",
    "a/../b",
    "/absolute",
    "a\\b",
    ".obsidian/file",
    "a//b",
  ])
    await assert.rejects(crypt.id(path));
  const id = await crypt.id("note.md");
  await assert.rejects(
    crypt.seal(id, {
      path: "wrong.md",
      content: bytesToBase64(encode("x")),
      mtime: 1,
      deleted: false,
    }),
  );
});
test("changed file versus remote deletion preserves content before deleting original", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("note.md", "base");
  await a.engine.sync();
  await b.engine.sync();
  a.port.files.delete("note.md");
  await a.engine.sync();
  b.port.edit("note.md", "offline");
  assert.equal((await b.engine.sync()).conflicts, 1);
  assert.equal(await b.port.read("note.md"), null);
  assert([...b.port.files.values()].some((f) => decode(f) === "offline"));
});
test("missing or regressed server history fails without replacing local changes", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret);
  a.port.edit("note.md", "first");
  await a.engine.sync();
  a.port.edit("note.md", "second");
  await a.engine.sync();
  const original = [...server.objects.values()][0];
  server.objects.set(original.id, { ...original, version: 1 });
  await assert.rejects(a.engine.sync(), /regressed/);
  assert.equal(decode(await a.port.read("note.md")), "second");
  server.objects.clear();
  await assert.rejects(a.engine.sync(), /history missing/);
  assert.equal(decode(await a.port.read("note.md")), "second");
});
test("preflight checks all files before application and re-fetches each immutable revision", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("one.md", "one");
  a.port.edit("two.md", "two");
  await a.engine.sync();
  const get = server.get.bind(server),
    fetched: string[] = [];
  server.get = async (id, version) => {
    fetched.push(id);
    if (fetched.length <= 2) assert.equal(b.port.files.size, 0);
    return get(id, version);
  };
  await b.engine.sync();
  assert.equal(fetched.length, 4);
  assert.deepEqual(fetched.slice(0, 2), fetched.slice(2));
});
test("case and Unicode normalization collisions fail before local or server mutations", async () => {
  for (const [first, second] of [
    ["Note.md", "note.md"],
    ["caf\u00e9.md", "cafe\u0301.md"],
  ]) {
    const server = new MemoryServer(),
      secret = generateSecret(),
      a = device(server, secret),
      b = device(server, secret);
    a.port.edit(first, "remote");
    await a.engine.sync();
    b.port.edit(second, "local");
    await assert.rejects(b.engine.sync(), /Paths collide/);
    assert.deepEqual(await b.port.list(), [second]);
    assert.equal(server.objects.size, 1);
  }
});
test("second fetch must match preflight content even with valid encryption", async () => {
  const server = new MemoryServer(),
    secret = generateSecret(),
    a = device(server, secret),
    b = device(server, secret);
  a.port.edit("note.md", "original");
  await a.engine.sync();
  const crypt = await VaultCrypto.create(vaultId, secret),
    get = server.get.bind(server);
  let reads = 0;
  server.get = async (id, version) => {
    const result = await get(id, version);
    if (++reads === 2)
      result.payload = await crypt.seal(id, {
        path: "note.md",
        content: bytesToBase64(encode("changed")),
        mtime: 1,
        deleted: false,
      });
    return result;
  };
  await assert.rejects(b.engine.sync(), /immutable revision changed/);
  assert.equal(b.port.files.size, 0);
});
