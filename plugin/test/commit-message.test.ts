import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCommitMessage, defaultCommitDateFormat, defaultCommitMessageTemplate } from "../src/commit-message";
import { defaultSettings, parseSettings } from "../src/settings";
import { SyncSession } from "../src/git-sync/session";
import { MemoryRepository, MemoryStore, MemoryVault, snapshot } from "./git-fakes";
import { entryFromText } from "../src/git-sync/codec";

const date = new Date(2026, 9, 6, 13, 8, 19);
test("default matches existing vault backup commit style using device-local dates", () => {
  assert.equal(formatCommitMessage(defaultCommitMessageTemplate, defaultCommitDateFormat,
    { device: "mac", count: 1, date }), "vault backup mac (1): 6th Oct, 2026 13:08:19");
  assert.equal(formatCommitMessage("vault backup {{hostname}} ({{numFiles}}): {{date}}", defaultCommitDateFormat,
    { device: "mac", count: 1, date }), "vault backup mac (1): 6th Oct, 2026 13:08:19");
  for (const [day, ordinal] of [[1, "1st"], [2, "2nd"], [3, "3rd"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [23, "23rd"], [31, "31st"]] as const) {
    assert.equal(formatCommitMessage("{{date}}", "Do", { device: "", count: 0, date: new Date(2026, 9, day) }), ordinal);
  }
});
test("custom messages and dates preserve literal text and do not recursively expand device names", () => {
  assert.equal(formatCommitMessage("Saved {{count}} from {{device}} at {{date}}", "YYYY-MM-DD[T]HH:mm:ss",
    { device: "{{date}}", count: 3, date }), "Saved 3 from {{date}} at 2026-10-06T13:08:19");
});
test("old settings load defaults, custom formats survive reload, invalid messages are rejected", () => {
  const { commitDateFormat, commitMessageTemplate, ...old } = defaultSettings();
  assert.equal(parseSettings(old).commitMessageTemplate, defaultCommitMessageTemplate);
  const customized = { ...old, commitMessageTemplate: "Notes: {{date}}", commitDateFormat: "YYYY-MM-DD" };
  assert.deepEqual(parseSettings(customized), customized);
  for (const value of ["", "\nmessage", "x".repeat(257), 3]) {
    assert.throws(() => parseSettings({ ...old, commitMessageTemplate: value }));
  }
});
test("saved edits publish the configured message through the actual sync session", async () => {
  const repository = await MemoryRepository.create(await snapshot({ "note.md": "before" }));
  const port = repository.device("mac");
  const messages: string[] = [];
  const prepare = port.prepare.bind(port);
  port.prepare = async (parent, changes, message, ledger) => { messages.push(message); return prepare(parent, changes, message, ledger); };
  const vault = new MemoryVault(await snapshot({ "note.md": "before" }));
  const session = new SyncSession({ repository: port, vault, store: new MemoryStore(), now: () => date,
    commitMessage: (count, date) => formatCommitMessage("My notes ({{count}}): {{date}}", "YYYY-MM-DD", { device: "mac", count, date }) });
  const preview = await session.previewEnrollment();
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw Error("Expected preview");
  await session.enroll({ token: preview.token });
  vault.files.set("note.md", await entryFromText("after"));
  assert.equal((await session.sync()).kind, "synced");
  assert.deepEqual(messages, ["My notes (1): 2026-10-06"]);
});
