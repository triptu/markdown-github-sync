import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HiddenConfigPort } from "../src/git-sync/hidden-config";
import { compileScope } from "../src/git-sync/scope";
import { entryText, hashBlob } from "../src/git-sync/codec";

type Files = ConstructorParameters<typeof HiddenConfigPort>[0];
async function fixture(run: (input: { root: string; files: Files; reads: string[]; put(path: string, value: string | Uint8Array): Promise<void> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vault-config-"));
  const reads: string[] = [];
  const files: Files = {
    exists: async path => { try { await stat(join(root, path)); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; } },
    list: async path => {
      const items = await readdir(join(root, path), { withFileTypes: true });
      return { files: items.filter(item => item.isFile()).map(item => `${path}/${item.name}`), folders: items.filter(item => item.isDirectory()).map(item => `${path}/${item.name}`) };
    },
    stat: async path => {
      const value = await stat(join(root, path));
      return { type: value.isDirectory() ? "folder" : "file", size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs };
    },
    readBinary: async path => { reads.push(path); return new Uint8Array(await readFile(join(root, path))).buffer; },
  };
  const put = async (path: string, value: string | Uint8Array) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
  try { await run({ root, files, reads, put }); } finally { await rm(root, { recursive: true, force: true }); }
}
async function policy(text: string | null = null) {
  return compileScope({ rules: "config/1", configDir: ".obsidian", gitignore: text === null ? null : await hashBlob(new TextEncoder().encode(text)) }, text);
}

test("configuration scan reads allowed hidden files without reading ignored or protected bytes", async () => {
  await fixture(async ({ files, reads, put }) => {
    const ignore = ".obsidian/plugins/custom/data.json\n";
    await put(".gitignore", ignore);
    await put(".obsidian/app.json", '{"showLineNumber":true}');
    await put(".obsidian/plugins/custom/data.json", "synthetic-secret");
    await put(".obsidian/plugins/github-vault-sync/data.json", "synthetic-device-binding");
    await put(".obsidian/workspace.json", "synthetic-workspace");
    await put(".obsidian/snippets/a.css", "body{}");
    const result = await new HiddenConfigPort(files, ".obsidian", () => {}).scan(await policy(ignore));
    assert.deepEqual(Object.keys(result.files), [".gitignore", ".obsidian/app.json", ".obsidian/snippets/a.css"]);
    assert.equal(entryText(result.files[".obsidian/app.json"]), '{"showLineNumber":true}');
    assert.deepEqual(reads, Object.keys(result.files));
    assert.deepEqual(result.unreadable, []);
  });
});

test("configuration scan never reads canonical aliases of protected plugin bytes", async () => {
  await fixture(async ({ files, reads, put }) => {
    const protectedPath = ".obsidian/plugins/GITHUB-VAULT-SYNC/data.json";
    await put(protectedPath, "synthetic-device-binding");
    await put(".obsidian/plugins/custom/data.json", "ordinary config");
    const result = await new HiddenConfigPort(files, ".obsidian", () => {}).scan(await policy());
    assert.equal(result.files[protectedPath], undefined);
    assert.equal(entryText(result.files[".obsidian/plugins/custom/data.json"]), "ordinary config");
    assert.deepEqual(reads, [".obsidian/plugins/custom/data.json"]);
  });
});

test("configuration scan refuses nested ignore aliases before reading hidden bytes", async () => {
  await fixture(async ({ files, reads, put }) => {
    await put(".obsidian/plugins/custom/.GITIGNORE", "data.json\n");
    await put(".obsidian/plugins/custom/data.json", "synthetic private bytes");
    await assert.rejects(new HiddenConfigPort(files, ".obsidian", () => {}).scan(await policy()), /Nested .gitignore is unsupported/);
    assert.deepEqual(reads, []);
  });
});

test("root ignore aliases are detected by name before a case-insensitive adapter resolves them", async () => {
  await fixture(async ({ files, reads, put }) => {
    await put(".GITIGNORE", ".obsidian/plugins/custom/data.json\n");
    await put(".obsidian/plugins/custom/data.json", "synthetic private bytes");
    await assert.rejects(new HiddenConfigPort(files, ".obsidian", () => {}).scan(await policy()), /Root .gitignore alias is unsupported/);
    assert.deepEqual(reads, []);
  });
});

test("configuration port refuses canonical aliases of reserved directory names", async () => {
  await fixture(async ({ files, reads }) => {
    for (const name of [".GIT", ".Git-Vault-Sync", ".GIT-VAULT-SYNC-EXPORT-copy", ".ENV", ".ds_store"]) {
      assert.throws(() => new HiddenConfigPort(files, name, () => {}), /Invalid configuration directory/);
    }
    assert.deepEqual(reads, []);
  });
});

test("oversized configuration is reported without reading it or blocking unrelated files", async () => {
  await fixture(async ({ files, reads, put }) => {
    await put(".obsidian/plugins/big/main.js", new Uint8Array(8 * 1024 * 1024 + 1));
    await put(".obsidian/hotkeys.json", "{}");
    const result = await new HiddenConfigPort(files, ".obsidian", () => {}).scan(await policy());
    assert.deepEqual(Object.keys(result.files), [".obsidian/hotkeys.json"]);
    assert.equal(result.unreadable[0].path, ".obsidian/plugins/big/main.js");
    assert.equal(result.unreadable[0].size, 8 * 1024 * 1024 + 1);
    assert.deepEqual(reads, [".obsidian/hotkeys.json"]);
  });
});

test("same-sized hidden changes with unchanged timestamps are captured as new bytes", async () => {
  await fixture(async ({ root, files, put }) => {
    const path = ".obsidian/app.json", when = new Date(1_000_000);
    await put(path, '{"value":1}'); await utimes(join(root, path), when, when);
    const port = new HiddenConfigPort(files, ".obsidian", () => {}), scope = await policy();
    const first = await port.scan(scope);
    await put(path, '{"value":2}'); await utimes(join(root, path), when, when);
    const second = await port.scan(scope);
    assert.notEqual(first.files[path].oid, second.files[path].oid);
    assert.equal(entryText(second.files[path]), '{"value":2}');
  });
});

test("nested rules and escaped adapter listings fail before reading configuration bytes", async () => {
  await fixture(async ({ files, reads, put }) => {
    await put(".obsidian/cache/.gitignore", "*");
    await assert.rejects(new HiddenConfigPort(files, ".obsidian", () => {}).scan(await policy()), /Nested .gitignore/);
    assert.deepEqual(reads, []);
    const invalid = { ...files, list: async () => ({ files: ["../outside"], folders: [] }) };
    await assert.rejects(new HiddenConfigPort(invalid, ".obsidian", () => {}).scan(await policy()), /Invalid configuration listing/);
    assert.deepEqual(reads, []);
  });
});

test("retired owner and mismatched configuration directories cannot capture hidden bytes", async () => {
  await fixture(async ({ files, reads, put }) => {
    await put(".obsidian/app.json", "{}");
    await assert.rejects(new HiddenConfigPort(files, ".obsidian", () => { throw new Error("retired"); }).scan(await policy()), /retired/);
    await assert.rejects(new HiddenConfigPort(files, ".custom", () => {}).scan(await policy()), /does not match/);
    assert.deepEqual(reads, []);
  });
});

test("configuration scan cache: hits skip reads, misses on size or mtime, never caches racy or incomplete stats", async () => {
  await fixture(async ({ root, files, reads, put }) => {
    await put(".obsidian/app.json", "{}");
    await put(".obsidian/plugins/p/main.js", "x".repeat(2048));
    const scope = await policy();
    const cache: NonNullable<ConstructorParameters<typeof HiddenConfigPort>[3]> = new Map();
    let now = Date.now() + 60_000;
    const port = new HiddenConfigPort(files, ".obsidian", () => {}, cache, () => now);
    const executable = (path: string) => path.endsWith(".js") ? "100755" as const : "100644" as const;
    const first = await port.scan(scope, executable);
    assert.deepEqual(reads.sort(), [".obsidian/app.json", ".obsidian/plugins/p/main.js"]);
    reads.length = 0;
    const second = await port.scan(scope, executable);
    assert.deepEqual(reads, []);
    assert.deepEqual(second, first);
    assert.equal(second.files[".obsidian/plugins/p/main.js"].mode, "100755");
    // A cached entry takes the current mode.
    assert.equal((await port.scan(scope)).files[".obsidian/plugins/p/main.js"].mode, "100644");
    await put(".obsidian/app.json", "{ }");
    const third = await port.scan(scope);
    assert.deepEqual(reads, [".obsidian/app.json"]);
    assert.equal(entryText(third.files[".obsidian/app.json"]), "{ }");
    // Same size, different mtime.
    reads.length = 0;
    await put(".obsidian/app.json", "[ ]");
    await utimes(join(root, ".obsidian/app.json"), new Date(), new Date(Date.now() - 3_600_000));
    assert.equal(entryText((await port.scan(scope)).files[".obsidian/app.json"]), "[ ]");
    assert.deepEqual(reads, [".obsidian/app.json"]);
    // Inside the racy window nothing new is cached.
    now = Date.now();
    await put(".obsidian/app.json", "{}");
    reads.length = 0;
    await port.scan(scope); await port.scan(scope);
    assert.deepEqual(reads, [".obsidian/app.json", ".obsidian/app.json"]);
    // An incomplete stat disables the cache.
    now = Date.now() + 60_000;
    const incomplete = new HiddenConfigPort({ ...files, stat: async path => ({ ...(await files.stat(path))!, mtime: Number.NaN }) }, ".obsidian", () => {}, new Map(), () => now);
    reads.length = 0;
    await assert.rejects(incomplete.scan(scope), /cannot be inspected/);
    const zeroMtime = new HiddenConfigPort({ ...files, stat: async path => ({ ...(await files.stat(path))!, mtime: 0 }) }, ".obsidian", () => {}, new Map(), () => now);
    await zeroMtime.scan(scope); await zeroMtime.scan(scope);
    assert.equal(reads.length, 4, "a zero mtime is never a cache key");
    // Removed paths leave the cache.
    await rm(join(root, ".obsidian/plugins"), { recursive: true });
    await port.scan(scope);
    assert.deepEqual([...cache.keys()], [".obsidian/app.json"]);
  });
});
