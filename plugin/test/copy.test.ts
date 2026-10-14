import { test } from "node:test";
import assert from "node:assert/strict";
import { describePath, formatBytes, offline, outcomeAttention, setConfigDirName } from "../src/ui/copy";
import type { SyncOutcome } from "../src/git-sync/session";

const withStatus = (status: number, message = "GitHub request failed") => Object.assign(new Error(message), { status });

test("offline: dropped connections, outages and rate limits are retried quietly", () => {
  assert.equal(offline(new Error("GitHub transport failed")), true);
  assert.equal(offline(new Error("java.net.UnknownHostException: Unable to resolve host \"api.github.com\"")), true);
  assert.equal(offline(new Error("net::ERR_INTERNET_DISCONNECTED")), true);
  assert.equal(offline(withStatus(0)), true);
  assert.equal(offline(withStatus(502)), true);
  assert.equal(offline(withStatus(503)), true);
  assert.equal(offline(withStatus(429)), true);
  assert.equal(offline(Object.assign(new Error("rate limited"), { status: 403, retryAt: 1_000 })), true);
});

test("offline: access and other failures are not offline", () => {
  assert.equal(offline(withStatus(401)), false);
  assert.equal(offline(withStatus(403)), false);
  assert.equal(offline(withStatus(404)), false);
  assert.equal(offline(new Error("GitHub credential unavailable")), false);
  assert.equal(offline(new Error("Disk full")), false);
});

const outcome = (value: unknown) => value as SyncOutcome;

test("outcomeAttention: each kind that needs a person gets a stable key and plain text", () => {
  assert.deepEqual(outcomeAttention(outcome({ kind: "needs-decision", conflicts: [{ id: "c1" }, { id: "c2" }], merged: [], published: false, carried: [] })), {
    key: "decide:c1,c2", text: "2 files were changed both here and on GitHub. Choose which version to keep.",
  });
  assert.deepEqual(outcomeAttention(outcome({ kind: "needs-decision", conflicts: [{ id: "c1" }], merged: [], published: false, carried: [] }))?.text,
    "1 file was changed both here and on GitHub. Choose which version to keep.");
  assert.deepEqual(outcomeAttention(outcome({ kind: "blocked", commit: "abc", steps: [{ path: "a.md" }] })), {
    key: "blocked:a.md", text: "1 update from GitHub couldn't be saved here, so sync is waiting.",
  });
  assert.deepEqual(outcomeAttention(outcome({ kind: "blocked", commit: "abc", steps: [{ path: "img.png", reason: "Close the open view before replacing or deleting img.png." }] }))?.text,
    "1 update from GitHub couldn't be saved here, so sync is waiting. Close the open view before replacing or deleting img.png.");
  assert.deepEqual(outcomeAttention(outcome({ kind: "publication-unknown" })), {
    key: "publication", text: "GitHub didn't confirm the last upload, so uploads are on hold.",
  });
  assert.deepEqual(outcomeAttention(outcome({ kind: "native-error" })), { key: "native", text: "A file couldn't be saved, so sync stopped." });
  assert.deepEqual(outcomeAttention(outcome({ kind: "corrupt", detail: "bad journal" })), {
    key: "corrupt:bad journal", text: "Sync needs repair: bad journal", fix: "settings",
  });
  assert.deepEqual(outcomeAttention(outcome({ kind: "paused", pause: { detail: "Review first" } })), {
    key: "paused:Review first", text: "Sync is paused: Review first", fix: "settings",
  });
});

test("outcomeAttention: files that can't sync count once; clean or transient outcomes need nothing", () => {
  const attention = { unreadable: [{ path: "big.pdf" }], held: [{ path: "a.md" }, { path: "b.md" }], deferred: 0 };
  assert.deepEqual(outcomeAttention(outcome({ kind: "synced", commit: "abc", published: true, carried: [], attention })), {
    key: "stuck:3", text: "3 files aren't syncing.",
  });
  assert.deepEqual(outcomeAttention(outcome({ kind: "up-to-date", commit: "abc", attention: { unreadable: [{ path: "big.pdf" }], held: [], deferred: 0 } })), {
    key: "stuck:1", text: "1 file isn't syncing.",
  });
  assert.equal(outcomeAttention(outcome({ kind: "synced", commit: "abc", published: true, carried: [] })), null);
  assert.equal(outcomeAttention(outcome({ kind: "up-to-date", commit: "abc", attention: { unreadable: [], held: [], deferred: 2 } })), null);
  assert.equal(outcomeAttention(outcome({ kind: "contended" })), null);
  assert.equal(outcomeAttention(outcome({ kind: "settling", operationId: "op", reason: "unreachable" })), null);
});

test("describePath: settings files, plugins, themes, snippets and notes", () => {
  assert.deepEqual(describePath(".obsidian/app.json"), { name: "Editor and files", place: "Obsidian settings" });
  assert.deepEqual(describePath(".obsidian/hotkeys.json"), { name: "Hotkeys", place: "Obsidian settings" });
  assert.deepEqual(describePath(".obsidian/workspace.json"), { name: "workspace.json", place: "Obsidian settings" });
  assert.deepEqual(describePath(".obsidian/plugins/dataview/main.js"), { name: "main.js", place: "dataview plugin" });
  assert.deepEqual(describePath(".obsidian/plugins/dataview/data.json"), { name: "data.json", place: "dataview plugin" });
  assert.deepEqual(describePath(".obsidian/themes/Minimal/theme.css"), { name: "theme.css", place: "Minimal theme" });
  assert.deepEqual(describePath(".obsidian/snippets/wide.css"), { name: "wide.css", place: "CSS snippet" });
  assert.deepEqual(describePath("Projects/2026/plan.md"), { name: "plan.md", place: "Projects/2026" });
  assert.deepEqual(describePath("inbox.md"), { name: "inbox.md", place: "Vault" });
});

test("describePath: follows a renamed settings folder", () => {
  setConfigDirName(".config");
  try {
    assert.deepEqual(describePath(".config/app.json"), { name: "Editor and files", place: "Obsidian settings" });
    assert.deepEqual(describePath(".config/plugins/dataview/main.js"), { name: "main.js", place: "dataview plugin" });
    // The default name is just a folder once the vault uses another one.
    assert.deepEqual(describePath(".obsidian/app.json"), { name: "app.json", place: ".obsidian" });
  } finally {
    setConfigDirName(".obsidian");
  }
});

test("formatBytes: whole bytes, then one decimal below 10 of a unit", () => {
  assert.equal(formatBytes(0), "0 bytes");
  assert.equal(formatBytes(1023), "1023 bytes");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024), "10 KB");
  assert.equal(formatBytes(8 * 1024 * 1024 + 1), "8.0 MB");
  assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  assert.equal(formatBytes(3 * 1024 ** 4), "3072 GB");
});
