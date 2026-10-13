import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBlob } from "../src/git-sync/codec";
import {
  ScopeError,
  UnsupportedNestedGitignoreError,
  assertNoNestedGitignore,
  compileScope,
  freezeTransactionScope,
  scopeForTree,
  type ScopeRules,
} from "../src/git-sync/scope";

interface Fixture {
  patterns: string;
  rows: { path: string; description: string; ignored: boolean }[];
}

const fixture: Fixture = JSON.parse(readFileSync(new URL("./fixtures/gitignore-conformance.json", import.meta.url), "utf8"));

async function scope(text: string | null = null) {
  const gitignore = text === null ? null : await hashBlob(new TextEncoder().encode(text));
  return compileScope({ rules: "config/1", configDir: ".obsidian", gitignore }, text);
}

test("synthetic gitignore fixture agrees with isolated git check-ignore", async () => {
  const compiled = await scope(fixture.patterns);
  for (const row of fixture.rows) {
    const expected = row.path === ".gitignore" ? false : row.ignored;
    assert.equal(compiled.includes(row.path), !expected, `${row.description}: ${row.path}`);
  }
  assert.equal(fixture.rows.find((row) => row.path === ".gitignore")?.ignored, true,
    "the control file is the explicit Git deviation");
  assert.equal(compiled.classify(".gitignore"), "config-inert");
  assert.equal(compiled.classify(".obsidian/plugins/vikalp/data.json"), "ignored",
    "an ignored tracked file is out of scope even though Git would continue tracking it");
});

test("ambiguous ignore encodings fail closed against the isolated Git oracle", async () => {
  const path = ".obsidian/plugins/custom/data.json";
  const directory = mkdtempSync(join(tmpdir(), "vault-ignore-oracle-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" };
  try {
    assert.equal(spawnSync("git", ["init", "-q", directory], { env }).status, 0);
    for (const pattern of [
      `${path}\n\ufeff!${path}\n`,
      `${path}\0garbage\n`,
    ]) {
      writeFileSync(join(directory, ".gitignore"), pattern);
      const git = spawnSync("git", ["-c", "core.ignorecase=false", "-c", "core.precomposeunicode=false",
        "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--quiet", "--", path], { cwd: directory, env });
      assert.equal(git.status, 0, `Git ignores the path for ${JSON.stringify(pattern)}`);
      await assert.rejects(scope(pattern), ScopeError);
      const baseline = await scope("");
      await assert.rejects(freezeTransactionScope(baseline, baseline, pattern), ScopeError);
    }
    const leadingBOM = `\ufeff${path}\n`;
    const valid = await scope(leadingBOM);
    assert.equal(valid.classify(path), "ignored");
    assert.equal(valid.rules.gitignore, await hashBlob(new TextEncoder().encode(leadingBOM)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical aliases of built-in protected names are denied while ignore matching stays case-sensitive", async () => {
  const compiled = await scope(".obsidian/plugins/custom/data.json\n");
  for (const path of [
    ".OBSIDIAN/plugins/GITHUB-VAULT-SYNC/data.json",
    ".obsidian/plugins/OBSIDIAN-GIT/main.js",
    ".obsidian/plugins/OBSIDIAN-LIVESYNC/main.js",
    ".obsidian/plugins/REMOTELY-SAVE/main.js",
    ".obsidian/plugins/REMOTELY-SYNC/main.js",
    ".obsidian/plugins/CLOUD-VAULT-SYNC/main.js",
    ".obsidian/WORKSPACE.json", ".obsidian/WORKSPACE-MOBILE.json",
    ".obsidian/CACHE/index", ".GIT/config", ".GIT-VAULT-SYNC/state",
    ".GIT-VAULT-SYNC-EXPORT-2026/file", ".TRASH/deleted",
    ".obsidian/plugins/custom/TOKENS.JSON", ".obsidian/plugins/custom/.ENV.LOCAL",
    ".obsidian/plugins/custom/PRIVATE.PEM", "docs/.ds_store", "THUMBS.DB",
  ]) assert.equal(compiled.classify(path), "denied", path);
  assert.equal(compiled.classify(".obsidian/plugins/custom/Data.json"), "config-inert",
    "user ignore patterns remain case-sensitive");
  for (const configDir of [".GIT", ".Git-Vault-Sync", ".GITIGNORE", ".TRASH", ".ds_store",
    ".ENV", ".Git-Vault-Sync-Export-2026", ".ＧＩＴ"]) {
    await assert.rejects(compileScope({ rules: "config/1", configDir, gitignore: null }, null), ScopeError);
  }
});

test("built-in privacy denies dominate an empty or negating .gitignore", async () => {
  const compiled = await scope("!**\n");
  for (const path of [
    ".git/config", "nested/.git/index", ".git-vault-sync/state.json",
    ".git-vault-sync-export-2026/file.md", ".trash/deleted.md", "docs/.trash/deleted.md",
    ".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".obsidian/workspace/layout",
    ".obsidian/cache/index", ".obsidian/plugins/github-vault-sync/data.json",
    ".obsidian/plugins/obsidian-git/main.js", ".obsidian/plugins/obsidian-livesync/main.js",
    ".obsidian/plugins/remotely-save/main.js", ".obsidian/plugins/remotely-sync/main.js",
    ".obsidian/plugins/cloud-vault-sync/main.js", ".obsidian/todoist-token",
    ".obsidian/plugins/unknown/.env", ".obsidian/plugins/unknown/tokens.json",
    ".obsidian/plugins/unknown/private.pem", "docs/.DS_Store", "Thumbs.db", "desktop.ini",
    "notes/.hidden.md", "./traversal.md", "a/../b.md", "a//b.md",
  ]) {
    assert.equal(compiled.includes(path), false, path);
  }
  assert.equal(compiled.classify("notes/.hidden.md"), "outside");
  assert.equal(compiled.classify(".obsidian/plugins/unknown/private.pem"), "denied");
  const otherConfigDir = await compileScope({ rules: "config/1", configDir: ".config", gitignore: null }, null);
  assert.equal(otherConfigDir.classify(".obsidian/todoist-token"), "denied");
});

test("allowed config paths classify live versus inert and all new hidden files need consent", async () => {
  const compiled = await scope();
  const examples = [
    ["note.md", "content", "auto"],
    [".gitignore", "config-inert", "auto"],
    [".obsidian/app.json", "config-live", "consent"],
    [".obsidian/core-plugins.json", "config-live", "consent"],
    [".obsidian/plugins/unknown/data.json", "config-live", "consent"],
    [".obsidian/plugins/unknown/main.js", "config-inert", "consent"],
    [".obsidian/plugins/unknown/rules/.builtin-rules.json", "config-inert", "consent"],
    [".obsidian/themes/custom/theme.css", "config-inert", "consent"],
    [".obsidian/snippets/ui.css", "config-inert", "consent"],
  ] as const;
  for (const [path, classification, policy] of examples) {
    assert.equal(compiled.classify(path), classification, path);
    assert.equal(compiled.includes(path), true, path);
    assert.equal(compiled.isLive(path), classification === "config-live", path);
    assert.equal(compiled.newHiddenPolicy(path), policy, path);
  }
  assert.equal(compiled.newHiddenPolicy(".obsidian/plugins/unknown/secrets.json"), "consent");
});

test("root .gitignore is a control file even when its own rules match it", async () => {
  for (const text of [".gitignore\n", "*\n", ".*\n"]) {
    const compiled = await scope(text);
    assert.equal(compiled.classify(".gitignore"), "config-inert", text);
    assert.equal(compiled.newHiddenPolicy(".gitignore"), "auto", text);
  }
});

test("transaction scope is the intersection of parent, remote and local exclusions", async () => {
  const parent = await scope();
  const remote = await scope("remote.md\n");
  const transaction = await freezeTransactionScope(parent, remote, "local.md\n");
  assert.equal(transaction.includes("local.md"), false, "new local rule blocks upload in the same transaction");
  assert.equal(transaction.classify("local.md"), "ignored");
  assert.equal(transaction.includes("remote.md"), false);
  assert.equal(transaction.includes("kept.md"), true);
  assert.equal(transaction.includes(".gitignore"), true);
  const formerlyIgnored = await scope("old.md\n");
  const unignored = await freezeTransactionScope(formerlyIgnored, parent, "");
  assert.equal(unignored.includes("old.md"), false, "parent exclusion remains frozen for this transaction");
});

test("nested .gitignore blocks activation, including a file under a denied directory", async () => {
  assert.throws(() => assertNoNestedGitignore(["notes/a.md", "folder/.gitignore"]), UnsupportedNestedGitignoreError);
  const compiled = await scope();
  assert.throws(() => compiled.classify(".obsidian/cache/.gitignore"), UnsupportedNestedGitignoreError);
  await assert.rejects(scopeForTree(
    [{ path: ".obsidian/cache/.gitignore", type: "blob", sha: "0".repeat(40) }],
    async () => new Uint8Array(), ".obsidian", "config/1",
  ), UnsupportedNestedGitignoreError);
  assert.equal((await scopeForTree([], async () => new Uint8Array(), ".obsidian", "config/1")).includes("note.md"), true);
});

test("tree resolution validates bytes, object ID, UTF-8 and the 64 KiB limit", async () => {
  const text = "*.tmp\n";
  const bytes = new TextEncoder().encode(text);
  const oid = await hashBlob(bytes);
  const item = { path: ".gitignore", type: "blob", sha: oid };
  const resolved = await scopeForTree([item], async () => bytes, ".obsidian", "config/1");
  assert.equal(resolved.classify("draft.tmp"), "ignored");
  assert.equal(resolved.rules.gitignore, oid);
  await assert.rejects(scopeForTree([item], async () => Uint8Array.of(0xff), ".obsidian", "config/1"), ScopeError);
  const invalid = Uint8Array.of(0xff);
  await assert.rejects(scopeForTree(
    [{ ...item, sha: await hashBlob(invalid) }], async () => invalid, ".obsidian", "config/1",
  ), /valid UTF-8/);
  await assert.rejects(scopeForTree([item], async () => new Uint8Array(65537), ".obsidian", "config/1"), ScopeError);
  await assert.rejects(scopeForTree([{ ...item, type: "tree" }], async () => bytes, ".obsidian", "config/1"), ScopeError);
  await assert.rejects(() => compileScope({ rules: "config/1", configDir: ".obsidian", gitignore: oid }, "other\n"), ScopeError);
});

test("digest is SHA-1 of canonical rules and policy version, independent of object identity", async () => {
  const text = "*.tmp\n";
  const oid = await hashBlob(new TextEncoder().encode(text));
  const rules: ScopeRules = { rules: "config/1", configDir: ".obsidian", gitignore: oid };
  const expected = createHash("sha1").update(JSON.stringify(["scope-policy/3", rules])).digest("hex");
  assert.equal((await compileScope(rules, text)).digest, expected);
  assert.equal((await compileScope({ ...rules }, text)).digest, expected);
  assert.notEqual((await scope("!*.tmp\n")).digest, expected);
  const legacy = await compileScope({ rules: "visible-only", configDir: ".obsidian", gitignore: null }, null);
  assert.equal(legacy.classify(".obsidian/app.json"), "outside");
  assert.equal(legacy.classify("note.md"), "content");
  const maximumText = `#${"x".repeat(65534)}\n`;
  const maximumRules: ScopeRules = {
    rules: "config/1", configDir: ".obsidian",
    gitignore: await hashBlob(new TextEncoder().encode(maximumText)),
  };
  assert.equal((await compileScope(maximumRules, maximumText)).digest,
    createHash("sha1").update(JSON.stringify(["scope-policy/3", maximumRules])).digest("hex"));
  const overflowText = `${maximumText}x`;
  const overflowOid = await hashBlob(new TextEncoder().encode(overflowText));
  await assert.rejects(() => compileScope({ ...maximumRules, gitignore: overflowOid },
    overflowText), /64 KiB/);
});
