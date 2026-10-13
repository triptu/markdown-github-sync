import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IntegrityError,
  decodeBase64,
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

test("paths: structural validity and V1 scope", () => {
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

test("snapshot verification rejects tampered bytes and out-of-scope paths", async () => {
  const entry = await entryFromText("real");
  await verifySnapshot({ "a.md": entry }, "test");
  await assert.rejects(verifySnapshot({ "a.md": { ...entry, data: encodeBase64(new TextEncoder().encode("fake")) } }, "test"), IntegrityError);
  await assert.rejects(verifySnapshot({ ".obsidian/x.json": entry }, "test"), IntegrityError);
  await assert.rejects(verifySnapshot({ "a.md": { ...entry, mode: "120000" } }, "test"), IntegrityError);
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
  const verified = await verifySnapshot(source, "prototype files");
  const manifest = toManifest(verified);
  assert.equal(Object.getPrototypeOf(verified), null);
  assert.equal(Object.getPrototypeOf(manifest), null);
  assert.deepEqual(Object.keys(verified), Object.keys(source));
  for (const path of Object.keys(source)) assert.ok(sameEntry(verified[path], manifest[path]));
  assert.equal(own({}, "constructor"), undefined);
  assert.equal(own({}, "__proto__"), undefined);
  assert.ok(!sameManifest(Object.fromEntries([["constructor", entry]]), {}));
  const inherited = Object.create({ oid: entry.oid, mode: entry.mode, data: entry.data });
  await assert.rejects(verifySnapshot({ x: inherited }, "inherited entry fields"), IntegrityError);
});
