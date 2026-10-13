# Native transactions review, round 1 (commit 8af242c, branch implement/native-v2)

Scope: `native-transactions.ts`, `obsidian-vault.ts`, `native-modes.ts` delta and the three focused test files, read against `/tmp/github-v2-design-opus-r1.md` §5–§6 and `docs/verification/android-rename-primitive.md`. Read-only; no emulator, no real vault. Scratch repros live in `/tmp/vsr/` (`harness.ts` is the test harness with counters; `repro.test.ts` has R1–R6). Run from the worktree: `cd /tmp/vault-sync-native-v2/plugin && npx tsx --test /tmp/vsr/repro.test.ts` (I symlinked `plugin/node_modules` to the main checkout's install; it is gitignored). All 6 repros reproduce on 8af242c; the focused suite is 20/20 there.

Verdict: **FAIL for "no lost drafts" as wired today.** The transaction mechanics (stage/displace/install on no-clobber rename, journaled intents, restart recovery) are sound in every path I traced, and the Android rename primitive doc supports the primitive. The failure is at the vault→engine boundary: the vault collapses `interrupted`/`displaced`/`orphan` into `{kind:"changed"}`, and the baseline engine treats `changed` as "the user has a newer draft", which it auto-merges and publishes. Plus unbounded retention that will degrade an Android vault within weeks.

## Findings (severity order)

### F1 — HIGH, confirmed by executable repro: interrupted text write is published to GitHub as the merged note
- `plugin/src/git-sync/obsidian-vault.ts:140-143` and `:158-161` return `{kind:"changed"}` after storing `interrupted` evidence; `contracts.ts:37-40` has no `interrupted` kind.
- `session.ts:710-712` and `:762-763`: `changed` ⇒ carry origin = `expected`, live bytes recorded as the newer draft. Next reconcile: base E, local = torn bytes, remote N ⇒ `.md` both-edited ⇒ `mergeText` (`reconcile.ts:116`) ⇒ automatic ⇒ publish.
- Repro R1 (real `SyncSession` + `MemoryRepository` + real `GitObsidianVault` + journal): remote edits line 1 of a 10-line note; `vault.process` dies after 5 lines land (desktop `fs.writeFile` truncate-then-write shape). Restart, `sync()` twice. Result: `synced, published:true, carried:["n.md"]`; GitHub head `n.md` is the 5-line truncation; the vault classified it `interrupted` but nobody read that. Design §6 says this must be an `interrupted-write` conflict "never auto-merged". Lost tail is recoverable only from hidden evidence with no UI.
- The same path fires for any host-side byte transformation (`process` stripping a BOM or normalizing CRLF on mobile): `matched && oid != N` ⇒ `interrupted` ⇒ `changed` ⇒ published as a user edit.

### F2 — HIGH: `displaced`/`orphan` bytes (a real user edit through a retargeted `TFile`) never reach the engine
- `obsidian-vault.ts:80-86`, `:122-127`, `:174-186`. Post-install writes through the old `TFile` land in `hold/` (confirmed by the Android probe: "The original TFile object is retargeted to the hidden holding path"). They are stored as `displaced`/`orphan` evidence and the step returns `applied` or `changed`; the visible path keeps N. The user's typing has silently moved into a hidden file. Existing test `native-vault.test.ts:221-235` demonstrates exactly this and only asserts a recovery record exists.
- Combined with design §4 making remote deletions automatic, a note open on Android that is deleted remotely gets its view retargeted to `hold/<id>`; subsequent edits are invisible. N1 gate is unresolved; root must either refuse rename transactions on files with open views or surface these records in the recovery UI before deletions go automatic.

### F3 — HIGH: hold and evidence retention are unbounded and scanned on every `apply()` step
- `obsidian-vault.ts:77` keeps every hold forever (design §6 step 6 removes it after re-hash). `:175-186` then copies every hold whose oid is not already recorded, including holds whose oid == `expected` (already pinned by the engine), into `recovery/` as base64. `:224` runs this whole scan inside every `apply()`, i.e. once per step, not once per sync.
- Repro R2: 30 replacements of a 64 KiB binary ⇒ 30 holds (1.9 MiB), 30 evidence files (2.5 MiB, base64), 90 full-state journal records (3.7 MiB, each record carries the whole `recoveries` array, so growth is quadratic), and a subsequent unrelated 1-byte `apply()` reads 32 files / 1.9 MiB. With real attachments (MiB each) and a sync of n steps, cost per sync is O(n × total hold bytes); storage ≈ 2.3× the size of every binary ever replaced or deleted, never reclaimed. Deleted attachments also persist on device indefinitely (privacy).
- Fix shape: scan once per `capture()`, not per `apply()`; skip evidence for holds with `oid == tracked.expected`; remove a hold at the first `recoverNative` after a process restart when its oid still equals E (no stale `TFile` can survive a restart) or after one subsequent capture otherwise; compact `native-records` like `FileJournalStore.compact` does for the main store (design §11 says compaction must skip `stage/`/`hold/`, not that they are immortal).

### F4 — MEDIUM: an oversized file in `hold/` or `stage/` bricks sync permanently
- `obsidian-vault.ts:178` calls `this.read()`, which throws at `:34` for > 8 MiB. Repro R3: a plugin writing 8 MiB + 1 byte through the stale `TFile` makes `capture()` and every `apply()` throw, across restarts. Nothing in the UI points at the hidden folder. Should be recorded as an oversize recovery record (hash only) and skipped, never thrown.

### F5 — MEDIUM: text-process is restricted to `.md`; `.canvas`, `.base`, `.json`, `.txt` take the rename path
- `obsidian-vault.ts:242`. Design §5: "notes stay on `process` and are never renamed while open". Repro R4: a canvas with an open `TFile` is retargeted to `hold/`. Canvas/Bases views are long-lived in Obsidian; this is the F2 hazard on the files most likely to be open. Recommend: text-process for any exact-UTF-8 content regardless of extension, or at least for every extension Obsidian opens in a view.

### F6 — MEDIUM (accepted by parent, fixed on root, not in 8af242c): `textTransaction` TOCTOU
- `obsidian-vault.ts:135-144`: `oid(path)==expected` then a second `read()` whose hash is never checked becomes the `process` compare preimage. An edit between the two reads is overwritten. Parent's regression confirmed it; root fix rehashes the second read. Not re-litigated here.

### F7 — LOW: crash-before-write and torn-write are indistinguishable at recovery
- Repro R6: intent written, `process` never ran, user edits after restart ⇒ `interrupted` evidence. Safe direction, but once F1 is fixed it becomes a spurious conflict. Add a durable `attempted` flag saved immediately before `process`/`rename` so recovery can classify "no write could have happened" as plain `changed`.

### F8 — LOW: duplicate-sequence detection compares only the top two records
- `native-transactions.ts:142`. `FileJournalStore.records()` (`store.ts:140-143`) checks every adjacent pair. Repro R5: records `1a,1b,2` open silently. Runtime `save()` makes a third write unlikely, but the open-time check is weaker than the store it duplicates. Also the custom journal re-implements `put`/verify/sequence logic from `store.ts:46-57` and `:199-210`; a `FileJournalStore(files, id, "native")` namespace would have given compaction and full duplicate detection for free.

### F9 — LOW: validation gaps and loose ends
- `native-transactions.ts:104-111` validates intent paths with `isSyncablePath`, while `apply()` admits paths via `safePath` (`obsidian-vault.ts:11-15`). `isValidPath` rejects > 4096 chars, `safePath` does not; any admitted-but-unsyncable path turns into a journal that throws "corrupt" on every open. Use one validator.
- `obsidian-vault.ts:125-126`: `displaced` after a successful install returns `changed` without `modes.set(intent.mode)`; executable bit is lost until the next sync.
- `native-records/`: any `.json` not matching `NNNN-hash.json` (Dropbox/Syncthing conflict copies) throws "Unrecognized" forever (`:139`); same policy as the main store, but now there are two such directories.
- `finish()` (`:183-194`) adds `tracked` entries for stage/hold paths that were never created; harmless but grows every record.
- `recoverNative` runs pending intents unconditionally at `capture()`, before the engine decides anything about the resumed operation. Under design §5 (consent = exact (E,N)) this is correct; under the baseline engine's `approval.kind === "revoked"` semantics (`session.ts:704`) it installs N for a step the engine would have marked `revoked`. Not a data-loss path (path == E was consented), but the two consent models must not be mixed when wiring.

## Things I traced and found sound
- Every branch of `renameTransaction` (replace, create, delete; crash at each of the 7 boundaries; writer injection before displace, between displace and install, after install, into hold): no version is dropped, no clobber possible, restart reruns the same decision function. The no-clobber create race (`native-vault.test.ts:281`) and displaced-recreate (`:254`) are correct.
- Journal: lost-ack on the record rename leaves `uncertain` set and the on-disk record is adopted on reopen; `.tmp` leftovers are ignored by the `.json` filter; stale writer is detected on every `save()`.
- Stage bytes are verified by re-hash after `writeBinary` (covers mobile chunked write + delete-on-error).
- `modes.remove` on delete fixes the stale-executable-bit-on-recreate case; mode is re-applied on restart via the `final()` branch.

## Assessment of the parent's proposal (durable per-path native hold, no global block)
Agree, with three requirements:
1. **New `ApplyResult` kinds**, not a flag on `changed`: `{kind:"interrupted", recoveryId}` and `{kind:"displaced", recoveryId}` (post-install write found in hold). The engine marks the step `interrupted`/`displaced` (the design's `StepStatus` already lists both) and the checkpoint may still advance for other paths.
2. **The hold must live in engine state and be consulted by reconcile**, keyed by path with the three oids (E, N, found). While present, reconcile must emit an `interrupted-write` conflict for that path and must not route it through the automatic rows or `mergeText`, regardless of what the user has since typed. If live bytes later differ from `found`, keep the hold and add the newest version to the choices; never auto-resolve. Resolution choices: keep current, restore E, take N. Publishing other paths continues.
3. **The vault must only raise `interrupted` when a write could have happened** (F7's `attempted` flag), otherwise the hold fires on every crash-before-write and users learn to click through it.
Also surface `orphan` records (F2) through the same per-path hold rather than a silent record; they are the user's lost edits.

## Root wiring requirements (root has not integrated yet)
1. Do not integrate until F1's `ApplyResult` kinds exist and `#applySteps` + reconcile honor them. R1 must flip to "needs-decision with `interrupted-write`" with the GitHub head unchanged.
2. Construct `NativeTransactionJournal.open(files, installationId)` once, fenced by the owner like the mode store, and on "persistence is uncertain" / "Stale native transaction writer" errors reopen it rather than retry.
3. Call `recoverNative()` once per sync before capture; remove the per-`apply()` scan (F3).
4. Gate native journal use behind the same `duplicate-installation` pause as the main journal: a cloned `installationId` means two devices share `stage/`, `hold/` and `native-records/`.
5. Keep text-process for every open-able text file (F5) until N1 is answered, and do not make remote deletions automatic for files with open views.
6. Add compaction for `native-records/`, a hold-release policy, and the oversized-file guard (F3, F4) before beta vaults accumulate attachments.
7. Expose native recoveries (`nativeRecoveries()`) in the existing recovery UI; today nothing reads them.

Pass/fail per concern raised in the brief: races in rename path PASS; interrupted writes FAIL (F1); corrupt state PASS (fails closed); startup pending intents PASS mechanically, CAVEAT F9 consent mixing; unknown bytes returning `changed` with engine auto-merge FAIL (F1, R1 executable); hold retention FAIL (F3); save-after-effect errors PASS (idempotent recovery); stale concurrent journals PASS at runtime, weaker at open (F8); custom journal duplication CONFIRMED (F8); path/state validation gaps CONFIRMED low (F9); all-hold scanning CONFIRMED (F3, R2 numbers). Full replacement of Obsidian Git is not claimed and is not supported by this review.
