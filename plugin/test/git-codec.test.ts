import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IntegrityError,
  base64Length,
  decodeBase64,
  decodeBase64Portable,
  encodeBase64Portable,
  encodeBase64,
  entryFromBytes,
  entryFromText,
  entryText,
  foldPath,
  hashBlob,
  isExcludedPath,
  isSyncablePath,
  isValidPath,
  sameEntry,
  sameManifest,
  toManifest,
  own,
  verifySnapshot,
  withMode,
} from "../src/git-sync/codec";
import { compileScope } from "../src/git-sync/scope";

test("blob hashes match git hash-object", async () => {
  assert.equal(await hashBlob(new Uint8Array()), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(await hashBlob(new TextEncoder().encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("base64 round-trips every byte value and large buffers exactly", () => {
  const all = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.deepEqual(decodeBase64(encodeBase64(all)), all);
  const large = Uint8Array.from({ length: 300_001 }, (_, index) => (index * 7919) % 251);
  assert.deepEqual(decodeBase64(encodeBase64(large)), large);
  for (const invalid of ["abc", "ab c", "-_==", "QQ=", "Q===", "QQ==QQ=="]) {
    assert.throws(() => decodeBase64(invalid), IntegrityError, invalid);
  }
});

test("text entries keep BOM, CRLF, missing final newline and Unicode byte-exact", async () => {
  const source = "﻿# Café\r\nline two\r\nno newline 🙂";
  const entry = await entryFromText(source);
  assert.equal(entryText(entry), source);
  assert.deepEqual(decodeBase64(entry.data).slice(0, 3), Uint8Array.of(0xef, 0xbb, 0xbf));
  assert.equal(entryText(await entryFromBytes(Uint8Array.of(0xff, 0xfe, 0x00))), null, "invalid UTF-8 is not text");
});

test("paths: structural validity and visible content", () => {
  for (const ok of ["a.md", "Notes/Plan 2026.md", "img/ü.png", "a/b/c.canvas"]) assert.ok(isSyncablePath(ok), ok);
  for (const bad of ["", "/a.md", "a.md/", "a//b.md", "./a.md", "a/../b.md", "a\\b.md", "a\u0000.md", "a\nb.md"]) {
    assert.equal(isValidPath(bad), false, JSON.stringify(bad));
  }
  for (const hidden of [".obsidian/app.json", ".git/config", "notes/.trash/x.md", ".hidden.md"]) {
    assert.ok(isValidPath(hidden) && isExcludedPath(hidden) && !isSyncablePath(hidden), hidden);
  }
  assert.equal(foldPath("Notes/Café.md"), foldPath("notes/café.md"));
});

test("semantic equality compares content identity and mode, not encoding", async () => {
  const plain = await entryFromText("x");
  const reencoded = { ...plain, data: "ignored" };
  assert.ok(sameEntry(plain, reencoded));
  assert.ok(!sameEntry(plain, { ...plain, mode: "100755" }));
  assert.ok(sameEntry(null, undefined));
  assert.ok(!sameEntry(plain, null));
});

/** Admits ordinary visible paths only. */
const visible = { includes: isSyncablePath };

test("snapshot verification rejects tampered bytes and out-of-scope paths", async () => {
  const entry = await entryFromText("real");
  await verifySnapshot({ "a.md": entry }, "test", visible);
  await assert.rejects(verifySnapshot({ "a.md": { ...entry, data: encodeBase64(new TextEncoder().encode("fake")) } }, "test", visible), IntegrityError);
  await assert.rejects(verifySnapshot({ ".obsidian/x.json": entry }, "test", visible), IntegrityError);
  await assert.rejects(verifySnapshot({ "a.md": { ...entry, mode: "120000" } }, "test", visible), IntegrityError);
});

test("explicit configuration scope admits eligible hidden files but still rejects protected paths", async () => {
  const scope = await compileScope({ rules: "config/1", configDir: ".obsidian", gitignore: null }, null);
  const entry = await entryFromText("exact bytes");
  await verifySnapshot({ ".obsidian/appearance.json": entry, ".gitignore": entry }, "config", scope);
  await assert.rejects(verifySnapshot({ ".obsidian/plugins/github-vault-sync/data.json": entry }, "protected", scope), IntegrityError);
  await assert.rejects(verifySnapshot({ ".git/config": entry }, "protected", scope), IntegrityError);
  await assert.rejects(verifySnapshot({ ".obsidian/appearance.json": { ...entry, data: "YmFk" } }, "tampered", scope), IntegrityError);
});

 test("large attachment base64 decoding does not overflow the regex stack", () => {
  const data = new Uint8Array(4321024);
  for (let i=0; i<data.length; i++) data[i]=i%251;
  assert.deepEqual(decodeBase64(encodeBase64(data)), data);
 });

test("prototype-key files survive verification and manifests; absent access is own-only", async () => {
  const entry = await entryFromText("saved prototype-key bytes");
  const source = Object.fromEntries(["__proto__", "constructor", "toString"].map((path) => [path, entry]));
  const verified = await verifySnapshot(source, "prototype files", visible);
  const manifest = toManifest(verified);
  assert.equal(Object.getPrototypeOf(verified), null);
  assert.equal(Object.getPrototypeOf(manifest), null);
  assert.deepEqual(Object.keys(verified), Object.keys(source));
  for (const path of Object.keys(source)) assert.ok(sameEntry(verified[path], manifest[path]));
  assert.equal(own({}, "constructor"), undefined);
  assert.equal(own({}, "__proto__"), undefined);
  assert.ok(!sameManifest(Object.fromEntries([["constructor", entry]]), {}));
  const inherited = Object.create({ oid: entry.oid, mode: entry.mode, data: entry.data });
  await assert.rejects(verifySnapshot({ x: inherited }, "inherited entry fields", visible), IntegrityError);
});

test("entries hashed by their producer skip re-verification until their fields change", async () => {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  let digests = 0;
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: (algorithm: AlgorithmIdentifier, data: BufferSource) => { digests++; return original.call(subtle, algorithm, data); },
  });
  try {
    const produced = await entryFromText("produced");
    digests = 0;
    const verified = await verifySnapshot({ "a.md": produced, "b.md": withMode(produced, "100755") }, "trusted", visible);
    assert.equal(digests, 0, "producer-hashed entries and their mode copies are not hashed again");
    assert.equal(verified["b.md"].mode, "100755");
    // A structurally identical copy from untrusted input is hashed once, then trusted.
    const copy = JSON.parse(JSON.stringify(produced)) as typeof produced;
    await verifySnapshot({ "a.md": copy }, "copy", visible);
    assert.equal(digests, 1);
    await verifySnapshot({ "a.md": copy }, "copy again", visible);
    assert.equal(digests, 1);
    // Mutation voids trust: forged bytes under the trusted oid are rejected.
    copy.data = encodeBase64(new TextEncoder().encode("forged"));
    await assert.rejects(verifySnapshot({ "a.md": copy }, "mutated", visible), IntegrityError);
    produced.oid = (await entryFromText("other")).oid;
    await assert.rejects(verifySnapshot({ "a.md": produced }, "mutated oid", visible), IntegrityError);
  } finally {
    delete (subtle as { digest?: unknown }).digest;
  }
});

test("base64 size arithmetic equals decoded length and rejects exactly what a round trip rejects", () => {
  for (let length = 0; length <= 9; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 13) & 255);
    const text = Buffer.from(bytes).toString("base64");
    assert.equal(base64Length(text), length);
    assert.deepEqual(decodeBase64(text), bytes);
  }
  // Every possible final character before one or two padding characters.
  for (const prefix of ["", "QUJD"]) for (const pad of ["=", "=="]) for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/") {
    const text = `${prefix}${pad === "=" ? "QU" : "Q"}${char}${pad}`;
    const canonical = btoa(atob(text)) === text;
    assert.equal(typeof base64Length(text) === "number", canonical, text);
    if (canonical) assert.equal(base64Length(text), atob(text).length);
    else assert.throws(() => decodeBase64(text), /Noncanonical/);
  }
  for (const text of ["A", "AB=", "A===", "AA=A", "QQ==QQ==", "QU JD", "QUJD\n", "QUJ-", "QUJ_", "====", "QQ=="]) {
    let expected: boolean;
    try { expected = text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text) && btoa(atob(text)) === text; } catch { expected = false; }
    assert.equal(typeof base64Length(text) === "number", expected, JSON.stringify(text));
    if (!expected) assert.throws(() => decodeBase64(text), IntegrityError);
  }
  assert.deepEqual(decodeBase64Portable("QUJD"), new TextEncoder().encode("ABC"));
  assert.equal(encodeBase64Portable(new Uint8Array()), "");
});

test("base64 encoding matches Buffer for random buffers across chunk boundaries", () => {
  for (const length of [0, 1, 2, 3, 4, 1000, 0x8000 - 1, 0x8000, 0x8000 + 1, 0x8000 * 2 + 2, 200_003]) {
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(length, at + 65536)));
    const expected = Buffer.from(bytes).toString("base64");
    assert.equal(encodeBase64Portable(bytes), expected, `portable ${length}`);
    assert.equal(encodeBase64(bytes), expected, `default ${length}`);
    assert.deepEqual(decodeBase64Portable(expected), bytes);
    assert.deepEqual(decodeBase64(expected), bytes);
  }
});
