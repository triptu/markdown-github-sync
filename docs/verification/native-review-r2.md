# Native safety review, round 2

**Verdict: do not give full safety approval.** The original torn-note publication defect is fixed end to end, including durable engine ingestion. Five additional behaviors are reproduced below; two concern overriding a user's choice or losing bytes, with the cleanup finding's writer assumptions stated explicitly. Oversize recovery and integrated Android acceptance also remain open.

Reviewed read-only in `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`, 2026-10-13. Initial HEAD was `e67801e` (native fix cherry-pick); later HEAD was `a734e0d` while root worked in parallel. Reviewed current native modules, engine boundary, and the root's updated `main.ts`/plugin fixture wiring. No repository edits, real vault access, remote/device operations, or subagents. Only scratch files and this report were written.

## Evidence and reproduction

Scratch harness: `/tmp/vsr/r2-harness.ts`; cases: `/tmp/vsr/r2-repro.test.ts`; output: `/tmp/vsr/r2-results.txt`. These adapt the round-one `/tmp/vsr` harness to **current root modules**, bundling production `GitObsidianVault` unchanged with the Obsidian class-identity fixture. Engine tests use the real `SyncSession`, current `NativeTransactionJournal`/`FileJournalStore`, and in-memory no-clobber adapter/MemoryRepository. They exercise scheduling points, not an actual Android host.

Run:

```sh
cd ~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600/plugin
node_modules/.bin/tsx --test /tmp/vsr/r2-repro.test.ts
```

12 scratch cases pass their assertions. **Five assert the presence of defects**, not acceptance. Independently ran the existing native transaction/vault/modes/journal suites (43 passing) and engine/plugin safety suites (104 passing), including root's new wired torn-note test. Engine/plugin output: `/tmp/vsr/r2-existing-engine-plugin.txt`. Passing suite counts do not negate the counterexamples.

## Findings

### R2-A — HIGH: a pending native intent can undo “keep local”

Locations: `session.ts:402-412`, `session.ts:303`, `obsidian-vault.ts:223-225`, `obsidian-vault.ts:133-139`.

Repro `R2-A`:

1. Enroll `n.md = "draft to keep"` and another file; GitHub deletes `n.md`.
2. Open its view while native `begin()` is persisting. The second open-view check refuses the deletion, leaving a durable, unattempted native intent. The engine returns `blocked`.
3. Invoke `keepLocal({path:"n.md"})`; it returns `recorded`.
4. Close the view, then sync.

Actual: native startup recovery replays the pending deletion **before** the engine processes its `kept` step. The visible note disappears; sync reports `synced`, `published:false`, `carried:["n.md"]`; GitHub still lacks the note. The preimage is recoverable, so this is not permanent byte destruction, but it directly contradicts the accepted user choice. The same state can occur after a crash with a persisted intent and a view opened before resumption.

`keepLocal` changes only the engine step. There is no cancellation/settlement handshake with the native intent. Simply skipping the engine step does not stop `capture()`/`recover()` from applying it. Acceptance requires the kept choice to durably neutralize an unattempted intent, or safely settle an attempted intent, before startup/capture recovery can mutate the path. Test crashes between both journals' transitions. Existing `applied`/`changed` recovery rules must still preserve any already displaced bytes.

Control `R2-C`: when the view is already open before `begin()`, no intent is created. Keeping local works and **publishes the note back to GitHub in the very next sync**. This is the documented `keepLocal` behavior (`session.ts:398-401`), not a local-only exemption. The UI must make the publication/deletion-reversal consequence explicit.

### R2-B — HIGH, conditional on a writer targeting an old hidden path: cleanup can delete newly changed bytes

Locations: `obsidian-vault.ts:232-248`.

Repro `R2-B`: complete a binary replacement, reopen with a different host lifetime, and inject a write of `"new late draft"` to the hold immediately after the cleanup read returns its old, expected bytes. Recovery removes the hold, produces zero issues, and no journal object contains the new bytes. The visible file is the replacement; the new hidden version is gone.

The code hashes a read, awaits validation of the **saved expected Entry**, then calls unconditional `adapter.remove(path)`. It never establishes that the removed bytes are the bytes it inspected. An adapter queue serializes each read/write/remove, but does not make this multi-call sequence atomic. No held file descriptor or same-host plugin reload is needed for this repro.

**Boundary:** changing host lifetime legitimately proves that references from the previous host are gone. It does not itself prove that no current-host plugin or external process can write to a known hidden path. This counterexample requires such a writer. If the supported threat model expressly forbids *all* writes to old hold/stage paths after true host restart, this is a documented exclusion rather than an in-contract blocker; do not claim blanket “changed bytes are never deleted.” An ordinary old reference surviving only a plugin reload is already handled correctly by retaining the same host ID. Adding one more non-atomic read alone cannot close this race. A complete fix needs ownership of cleanup against writers, or retention instead of deletion when that ownership cannot be established.

### R2-D — MEDIUM: opening a view during journal/stage awaits bypasses the open-view guard

Locations: `obsidian-vault.ts:133-139`, `obsidian-vault.ts:316-319`.

Repro `R2-D`: start deleting a closed note, then open a `FileView` while the attempted-marker record is being saved. The last `openView()` check has already run. Result is `applied`; the view's original `TFile.path` becomes `.git-vault-sync/.../hold/<id>`.

This is a normal UI scheduling race; the current guard protects only views open at its earlier observation. The user can continue editing a hidden file despite the stated refusal of open-file rename. Changed held bytes are eventually surfaced (confirmed separately), so this is not evidence that those edits are immediately destroyed. It does leave the N1 editor-safety gate unresolved. Recheck after asynchronous staging/intent persistence and determine how the host protects view lifetime through the queued rename; a preflight check by itself is not a proof. Test opening/reopening views during the host adapter's queue delay, not only before `apply()`.

### R2-F — MEDIUM: native mutations precede the duplicate-installation / paused-state fence

Locations: `session.ts:298-324`, `session.ts:907-920`, `obsidian-vault.ts:220-248`; root construction `main.ts:235-257`.

Repro `R2-F`: leave a native text intent `E → N`; use a migration-shaped state with `ledger.ref=null` and an existing device ledger. `sync()` first installs N, then returns `paused:duplicate-installation`. After that pause is durably present, another pending `N → P` intent is still replayed on the next sync before the same pause is returned.

This confirms the prior root-wiring requirement to gate native activity behind duplicate-installation remains unimplemented. `#recoverNative` also runs before repository identity validation and can clean old holds. Root's owner fence protects plugin instances sharing the same App; it is not this device-identity fence. Native recovery can be intentionally permitted to finish a verified accepted local operation during some ledger pauses, but that exception needs explicit scoped authorization; the present code runs every pending intent before examining any pause or operation. Read-only discovery and evidence retention can be separated from mutation/reclamation. Include `capture()`/enrollment/restore entry points in the decision because capture also replays native intents.

### R2-E — MEDIUM: the first interrupted-write decision is discarded without a content change

Locations: `session.ts:580-584`, `session.ts:620-631`, `reconcile.ts:316-320`.

Repro `R2-E`: tear a remote ten-line note to five lines, restart, obtain the first `interrupted-write` conflict, immediately resolve `next`, then sync without editing anything. Outcome is another `needs-decision` with a different ID; the selected version is not restored.

The first conflict is built with the carried old base. Before returning it, the no-incoming/no-outgoing branch clears carry and advances the checkpoint. The next call uses the new effective base; `nativeConflict` hashes that base into its ID, and `#transact` discards the recorded decision. Local, remote, expected, next and found bytes did not change. This is unrelated to duplicate issue delivery. Generate a review consistent with the durably stored checkpoint/carry, or bind native consent only to the versions actually relevant to the decision. Acceptance must resolve the **first** returned conflict; tests that sync several times before resolving miss this.

## Specific handoff and lifecycle checks that pass

- **Original R1, real adapter + engine:** a process failure after five of ten lines, native journal reopen, and two syncs produce `needs-decision/interrupted-write`. The GitHub head **OID** and complete remote bytes are unchanged. Expected, intended and found versions are available in the conflict. Native queue is empty because the engine acknowledged the issue after durable ingestion, not because evidence disappeared.
- **R2-G:** a changed hold is ingested, acknowledged, and every expected/next/found byte version remains in engine blobs. Resolve keeping current; reopen with a new host lifetime. The changed hold remains on disk and its unchanged contents do not reopen the conflict. A subsequent distinct hidden edit does create a fresh conflict.
- **R2-H, four cases:** fail engine persistence before/after the ingestion save and before/after the post-ack save. Reopen both layers. The issue is held exactly once, found bytes survive, and acknowledgment completes. No acknowledgment-before-durable-save loss reproduced.
- `FileJournalStore` use eliminates the native journal's duplicate-sequence blind spot and duplicates less persistence logic. Its shared-object queue, head checks, verification, and compaction tests pass. Native uncertain persistence fails closed and requires reopening.
- Current root passes the fenced journal and modes into the vault, uses a host-App lifetime ID, and excludes `.git-vault-sync` renames from user mode transfers. Current plugin tests exercise separate bundles/retired callbacks and the wired torn note. I found no new same-App retired-owner bypass in this review. This is not a cross-process filesystem lock.

## Prior findings, disposition

| Prior | Disposition against current code |
|---|---|
| F1 torn bytes merged/published | **Fixed for the reproduced native/engine path.** Real-adapter R1 and root wired regression pass. First-choice liveness defect R2-E remains. |
| F2 hidden edits never reach engine | **Fixed for tracked, in-limit changed holds.** R2-G verifies byte retention, acknowledgment, resolution and new edit rediscovery. Open-view exclusion remains racy (R2-D); oversize evidence still does not reach the engine. |
| F3 retention and every-apply scans | **Partly fixed.** Native object deduplication/8-record compaction and removal of the per-apply scan pass. Clean holds are reclaimed only on a new host lifetime. Long-lived hosts retain all holds; changed holds persist indefinitely. `recover()` plus `capture()` can scan multiple times per sync; it is not literally one scan per sync. Cleanup has R2-B's conditional race. |
| F4 oversized hidden file bricks everything | **Partly fixed, still an acceptance blocker.** Oversize files are retained as metadata and do not break unrelated capture/apply. But `issues()` explicitly filters them out (`native-transactions.ts:153`), so the engine/UI cannot ingest, resolve or export this recovery through the native hold protocol. `apply()` blocks that path; moving/removing the file alone leaves durable oversize metadata. Visible/pending-live files above 8 MiB still throw at `read()`. Hidden files without a TFile stat may be fully read before the limit is noticed. |
| F5 canvas/base/json rename | **Fixed for safe exact UTF-8 replacements.** Extension no longer controls process selection; the open-canvas test passes. Files with excluded control bytes still choose rename; open-view protection for that path has R2-D. |
| F6 second text-preimage read | **Fixed.** Hash recheck remains and regression passes. |
| F7 unattempted intent falsely interrupted | **Fixed for the useful distinguishable cases.** Durable attempted flag and caught-no-effect clear pass. A true crash after persisting attempted but before dispatch remains conservatively ambiguous, as expected. |
| F8 duplicate sequences/custom journal | **Fixed.** Native uses FileJournalStore and rejects duplicate sequences anywhere in the record list. |
| F9 validation/mode/tracking/consent details | Path length admission, post-install displaced mode, and tracking only existing hidden files are fixed. Unknown/malformed records still fail closed deliberately. Legacy `native-records` deliberately fail closed without migration; acceptable only if truly unreleased or explicitly quarantined. Engine/native cancellation coordination now has concrete counterexample R2-A. |

## Exact remaining acceptance gates

1. **Keep-local coordination:** R2-A must instead leave the selected local bytes visible and preserve intended publication semantics, including crashes around cancellation/settlement in both journals. A later capture/restart must not revive the discarded intent.
2. **Cleanup guarantee:** close R2-B under the claimed writer model, or explicitly narrow the guarantee to exclude all post-restart hidden-path writers. Continue proving that unchanged preimages are recoverable and changed holds survive true restart, acknowledgment, resolution and compaction. No “changed bytes never deleted” claim on the present implementation.
3. **Open editor behavior:** protect or explicitly handle the R2-D race and verify real Android FileView/Markdown/Canvas/Bases behavior. Test opening a view during persistence and the queued rename, not just pre-opened views. The current root code has no dirty-Markdown save/flush before capture; either implement the design's flush or verify actual dirty-buffer/process merge behavior before treating unsaved edits as covered. In-memory file tests cannot establish that guarantee.
4. **Pause/device ownership:** R2-F must honor the duplicate-installation fence before native replay/cleanup, including an already durable pause. Any permission to complete a previously accepted operation while paused must be narrow and tested. Same-App plugin ownership does not satisfy this gate by itself.
5. **First decision:** R2-E must restore the selected version after the first review, without a redundant second confirmation when no decision-bound bytes changed.
6. **Oversize recovery:** provide a durable engine-visible state and usable original-path/source-path/size metadata, a lossless export/inspection route that does not require core byte ingestion, and an explicit resolution/ack path. Prove unrelated files progress, the oversized bytes survive restart/cleanup, and the affected path can actually leave its blocked state. Test both a late oversized hold and oversize arising while an intent is pending.
7. **Storage/liveness bounds:** quantify or accept retention during an indefinitely running host and retention of resolved changed holds. A new process reclaims clean holds, but this is not a storage bound on an Android process that remains alive for weeks. Verify acceptable repeated-scan cost at realistic retained attachment volume.
8. **Integrated Android native crash gates:** run force-stop/reopen at intent, stage, displacement, installation, issue save/ack and cleanup boundaries on this integrated implementation; cover the 8 MiB rename and no-clobber recreation races. `docs/verification/android-rename-primitive.md:16` explicitly limits existing evidence to completed emulator calls, excluding process-death atomicity, power-loss durability, physical storage-provider behavior and open-editor compatibility. Node suites and generic earlier force-stop persistence tests do not close those gates. Power-loss fsync remains a stated unsupported boundary unless new evidence/mechanisms change it.
9. **Migration/recovery reachability:** confirm no released installation needs the refused experimental `native-records` format, or supply a reviewed migration/export path before deploying to such installations. Verify UI clearly states that “keep local” republishes that version, including resurrecting a remote deletion.

## Reviewed source fingerprints

SHA-256 at report preparation (root commits can move independently):

```text
native-transactions.ts 8e1f7685dbb62e1b35e74d8ec82de722428ba9400fc88a8be6076c416ac8c0df
obsidian-vault.ts       913c71e72c25204217cfaa3c49c3f97e46fa8e6a667a514032b12fa3b7b9a4f5
native-modes.ts         5fbd4e66244e3e519c6ac861cd5498da7cf2d8fb44d1d5ccc9ab445d86d40a0f
store.ts                a63573cfbb0c0ede56775cae8bd0079e85da6b9bf4eda8df7c9e1f71873ee999
session.ts              344fee8f70dfacda9640c196feaff9a5ef1ab2659661064aa522f1a9df88cba8
main.ts                 ce30a3d8a31ebd99fc93b9684b5e382afcf0802792d32e24d1c82b9191134444
```
