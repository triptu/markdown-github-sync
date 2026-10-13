# Integrated engine/native review R2 — ae497b4 + reviewed restore fix 9b5a782

**Verdict: changes requested. Do not give full Android/no-data-loss replacement approval.** The prior first-choice, keep-local cancellation, pause gating, stale-ledger and legacy-fence fixes work in the tested production composition. Five remaining findings are below. The strongest is an actual erroneous GitHub deletion: `mine` on a held path whose visible file is oversized is interpreted as “absent” and published as a deletion. The oversized local bytes remain; this is not evidence of permanent destruction of every copy.

Read-only review requested for `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`, initial HEAD `ae497b42ae8c45ad95c086b9aace2230af9ca3d7`, containing native `5769c99`, engine `1449866`, and REST ledger `caaa411`. Before the restore addendum, root advanced to `7449891b11d5cd69a0d3e5b48af40809a63b6db6`; the reviewed seven engine/native source files were then unchanged from ae497b4. At the user’s request I subsequently inspected integrated restore fix `9b5a782` (root cherry-pick `733ee98`) and reran the composition at report-time HEAD `7ff604c0422ecbb7d111c01f1b9dddbd25422737`. Findings remain reproduced after that change. Source line numbers in E2-1–E2-5 refer to ae497b4; restore addendum references the new source. A new `scope.ts` and root-owned UI/fixture/integration-script changes are outside this review. No repository edits, real-vault access, remote calls/writes, device actions, or subagents. Scratch only under `/tmp`. The old uncommitted native compile shim was not integrated.

## Context and evidence

Read fully:

- `docs/verification/publication-review-r1.md` (F1–F6).
- `docs/verification/native-review-r2.md` (A/B/D/E/F and acceptance gates).
- `/tmp/github-v2-native-cancel-port.md`, including visible-oversize addendum.
- `/tmp/github-v2-native-oversize-port.md`.
- Commit `1449866` description.
- The antecedent `/tmp/github-v2-design-opus-r1.md`, `/tmp/github-v2-native-review-r1.md`, and `/tmp/github-v2-native-port.md`.

New scratch cases and results: `/tmp/github-v2-engine-r2/`.

- `harness.ts`: adapted `/tmp/vsr/r3-harness.ts`, bundling **production GitObsidianVault unchanged**, with the same Obsidian fixture class identity, no-clobber in-memory host adapter, real NativeTransactionJournal/FileJournalStore, stat/copy/rename hooks, and process fault injection. All host files are maps, not a real vault.
- `composition.test.ts`: 26 cases, real SyncSession + real native adapter/journal; MemoryRepository and fault-injectable MemoryStore for the remaining ports.
- `two-journals.test.ts`: 4 cases with **real FileJournalStore for both the engine and native journal**, fail before record write / after final record rename on each side of keep/cancel, reopen both, confirm local draft survives and republishes once.
- `protocol.test.ts`: 9 cases. Four compose production GitHubRepository + production SyncSession + production native adapter, injecting HTTP responses at a scratch FakeGitHub transport. Five exercise legacy fencing/delivery/crashes/rewinds using MemoryRepository.
- `github-transport.ts`: scratch extraction of the official GitHub transport fixture, updated absolute source imports; no actual HTTP/network.
- `results.txt` (before restore fix): **39/39 pass**, of which **four deliberately assert defect presence** (deleted/shrunken oversize source and visible oversize during pending replay/cancel). Passing these four is not acceptance.
- `failing-acceptance.test.ts` / `failing-acceptance-results.txt`: **three safety acceptance cases, all fail**, reproducing findings E2-1, E2-4, E2-5. `post-restore-failing-acceptance.txt` reconfirms all three on the integrated restore fix.
- `restore.test.ts` / `restore-results.txt`: **15/15 new restore fault cases pass**, using production Session, GitObsidianVault, NativeTransactionJournal, NativeModeStore and FileJournalStore for all three journals.
- `post-restore-results.txt`: all four scratch suites together **54/54 pass**, retaining the same four defect-presence assertions; it is not 54 safety acceptances.
- `official-restore-results.txt`: targeted official tests named `restore`, both engine and plugin fixture suites, **13/13 pass**, including the original two reported plugin failures.
- `official-engine-results.txt`: official `git-session`, `git-reconcile`, `github-client` tests **184/184 pass**.
- `native-r3-rerun.txt`: independently executed existing `/tmp/vsr/r3-repro.test.ts`, **9 pass / 1 fail**. These are a mixture of defect assertions and controls. R3-D's defect assertion fails because the duplicate issue was *not* re-raised; do not carry that alleged defect forward. R3-A/B/C still reproduce, and R3-E still demonstrates the late stale-view boundary. This is independent execution, not an assumption that Fable's interrupted review passed.

Run from the plugin cwd:

```sh
cd ~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600/plugin
node_modules/.bin/tsx --test /tmp/github-v2-engine-r2/composition.test.ts /tmp/github-v2-engine-r2/protocol.test.ts /tmp/github-v2-engine-r2/two-journals.test.ts /tmp/github-v2-engine-r2/restore.test.ts
node_modules/.bin/tsx --test /tmp/github-v2-engine-r2/failing-acceptance.test.ts
node_modules/.bin/tsx --test test/git-session.test.ts test/git-reconcile.test.ts test/github-client.test.ts
```

The second command is supposed to exit 1 until the findings are fixed. The scratch code imports live checkout modules, so subsequent fixes will change results. No bounded formal result was treated as TypeScript implementation proof.

## Findings

### E2-1 — HIGH: unreadable visible bytes plus a native hold turn “mine” into a published deletion

Locations: `session.ts:1327–1330`, `reconcile.ts:224–249`, `session.ts:662–672`.

Repro: `failing-acceptance.test.ts`, `PROBE oversize hold plus oversized visible current: mine must not mean delete remote`.

1. Enroll `a.bin = 0x00` and another file. Pull remote `a.bin = 0x01` through production native rename, leaving its tracked hidden hold.
2. Grow the hidden hold beyond 8 MiB; sync returns `oversize-write`.
3. Grow the visible `a.bin` beyond 8 MiB as well. Native `scan()` correctly reports it as unreadable and omits it from `files`.
4. Sync produces a native conflict with **`local: null`** and offers **`mine`**.
5. Resolve that first current conflict with `mine`, then sync.

Actual: `{kind:'synced', published:true, carried:['a.bin']}`, GitHub's current tree no longer contains `a.bin`, while the visible file still contains 8 MiB + 1 byte. The checked assertion that GitHub retains the path fails. This is an actual production-session publication through the repository port, not only a reconcile toy.

Cause: `#untouched` removes every path with a hold from the unreadable/quarantined set. Reconcile explicitly bypasses its untouched check for holds, converts omitted local content to null, and chooses null for `mine`. The session can also release the hold because the omitted local and chosen absent target compare equal. Unknown bytes have become proven absence.

Fix direction: represent unreadable/unknown independently of absent throughout native conflict generation and decision validation; a hold must not bypass unknown-local protection. Do not offer or execute `mine` as deletion when current bytes are unavailable. Preserve the remote path and origin until there is a usable, exact local precondition or a separately reviewed operation that explicitly handles unknown bytes. Test all hold kinds intersecting unreadable/quarantine, not only oversize holds.

### E2-2 — MEDIUM, whole-vault liveness: pending intent plus oversized live path still throws before every sync

Locations: `obsidian-vault.ts:48–57`, `:127` (rename recovery's initial live read), `:247–250`, `:286–293`; `session.ts:1231`.

Repros: `composition.test.ts`, `DEFECT visible oversize pending replay` and `... cancel`.

1. Enroll binary 0x00, remote changes it to 0x01.
2. Inject a crash immediately after path → hold displacement, leaving a production native intent and durable engine apply operation.
3. Recreate the visible path as 8 MiB + 1 byte; edit an unrelated file.
4. Reopen the journal and session. Exercise both replay authorization and a kept-step cancellation authorization (the cancel case seeds the durable kept status explicitly).

Both calls throw `File exceeds 8 MiB: a.bin`, on every reopen. The native intent stays pending, the preimage stays hidden, and the unrelated edit never publishes. `scan()` handling is bypassed: replay and attempted cancellation call `oid()` → `read()` before the scan can classify the path. The whole-vault failure is not the root-owned display/native-error switch case.

Fix direction: recover pending visible oversize as a durable path-local unknown/blocked state, without reading it into an Entry and without installing or deleting anything. Continue recovery and sync on other paths. Retain the intended authorization so shrinking/restoring/exporting the file can later settle the intent safely.

### E2-3 — MEDIUM: removing or shrinking an oversized retained source leaves an unacknowledgeable native block

Locations: `obsidian-vault.ts:300–313`, `:324–333`, `:453–455`; `native-transactions.ts:276–286`; `session.ts:678–681`, `:1299–1306`.

Repros: `composition.test.ts`, `DEFECT oversize deleted` and `... shrunken`; also independently reproduced in preexisting R3-A/B.

Start with a tracked oversized hold and engine `oversize-write`. Export it through the real hidden export API. Then either remove the original via the simulated file manager or replace it with readable smaller bytes. Sync, resolve the current conflict to `expected`, sync and reopen repeatedly.

Actual: the original oversize id remains native-pending; acknowledge always rejects because current size/mtime can never match the recorded oversized version. A missing source is only untracked; a smaller source produces a displaced byte issue but does not retire the old oversized record. The engine swallows the ack error, publishes its chosen target, and leaves the local apply operation blocked. Repeated syncs and restarts cannot apply it. The apply operation can also hold up later unrelated work. No original source was automatically deleted; external removal was explicit in the test.

Control: an unchanged oversized hidden source **does** export, remain hidden/excluded from scan, get acknowledged only after a durable decision, and allow its path to apply and converge. So the route exists, but common source transitions break it.

Fix direction: give superseded/missing/no-longer-oversized metadata an explicit reconciliation/retirement rule. Preserve newly readable bytes before retiring stale metadata; preserve evidence that the former source is missing without indefinitely requiring its old stats. Engine decision IDs must still revalidate when evidence changes. An ack failure must remain visible and must not be treated as a completed local resolution. `retainOversize` already supersedes metadata for another oversized version; the absent/readable branches need corresponding semantics.

### E2-4 — MEDIUM: resumed remote deletion silently drops an unreadable path's origin

Locations: `session.ts:1117–1120`, `:1159–1174`, `:1183–1185`.

Repro: `failing-acceptance.test.ts`, `PROBE resumed remote deletion while local becomes oversized keeps unknown origin`.

Crash immediately after the engine saves an incoming delete operation, before the native intent exists. Grow that visible file beyond 8 MiB. Restart and sync. Native recovery has no intent, so the scan reports unreadable. `#applySteps` treats omitted local as null, compares it with delete's null target, and marks the step applied. Its carry construction excludes untouched paths present in `stepsByPath`, losing the old base. The outcome says up-to-date while the oversized file is still visible.

Make the file readable with distinct local edits, then sync. Actual: it automatically republishes/resurrects the remotely deleted path (`synced`, `published:true`). Expected: compare against the preserved original base and ask the local-edited/remote-deleted question. The normal non-resume unreadable test does preserve that origin; this is the persisted-operation bypass.

Fix direction: apply-time unknown-local paths need their own unfinished/untouched accounting before the `current == next` shortcut. Retain their effective origin regardless of whether a prior operation has a step for them. Never infer a deletion completed from omitted unreadable bytes.

### E2-5 — MEDIUM: a persisted apply operation bypasses newly ingested path quarantine

Locations: `session.ts:1233–1238`, `:1114–1129`, `:1327–1330`.

Repro: `failing-acceptance.test.ts`, `PROBE resumed apply must not write a quarantined path`.

Save an accepted incoming E→N apply operation and crash before native begin. On restart, return a malformed byte issue for that path from recovery (hash/data mismatch; production native recovery still runs, with the bad record injected at its boundary). Engine records a scoped nativeError and quarantines the path. `#resumeApply` then calls `#applySteps`, which checks holds but never quarantine/untouched, and production native apply installs N. Final outcome is up-to-date with local N. Assertion that the quarantined path remains E fails.

This concerns malformed-boundary resilience, not a claim that the native parser routinely produces invalid entries. It contradicts the advertised F5 rule that unverifiable evidence holds its path and never writes it. Ordinary new reconciliation honors the quarantine and still publishes unrelated files (verified).

Fix direction: enforce quarantine/unknown guards in resumed apply and any accepted-operation recovery authorization, not only new reconciliation. Audit whether an already quarantined native intent should be replayable before refreshed evidence is validated. Keep the verified preimage pinned and allow unrelated safe steps to complete without treating this path as settled.

## Restore fix addendum — integrated 9b5a782 / root 733ee98

**The two reported restore-crash regressions are fixed for the tested production composition.** This replaces the earlier pending-fix disposition. Inspected the complete session/state/test diff, then tested independently; did not rely on the worker’s reported counts or weaken the expected behavior.

The new `RestoreOperation` records the historical commit, current checkpoint, exact preimage/next modes and OIDs, and both recovery records before native apply. Parsing rejects a changed checkpoint, missing preimages/incoming bytes, or non-pending/non-blocked restore step. `#verifyRestoreOperation` checks source history and exact historical bytes before `#recoverNative` can authorize a pending restore. `#resumeRestore` keeps restored content as a local draft; it does not advance the checkpoint to history. The later ordinary sync publishes it on top of the current branch. Restore now passes the duplicate-installation binding check before native recovery.

Fifteen independent cases in `restore.test.ts` use real FileJournalStores for engine, native intents and mode metadata. They fail/reopen at:

- Authorization record before write / after final rename (before-durable case performs no restore; after-durable case resumes it).
- Native intent record before / after durability.
- Text processing before bytes change / after full bytes change and before native completion.
- Mode record before / after durability.
- Engine operation-clear record before / after durability.
- Binary rename after displacement, before stage install, and after install.
- A newer local edit after a pre-write interruption (edit survives and publishes; historical bytes remain archived).
- Tampered historical source (verification throws before any native journal mutation or file change).

All cases retain the original current checkpoint until ordinary publication, preserve the historical executable mode when restoration proceeds, clear the native intent, and converge. The two original plugin-level restore crash tests also pass in the independently run targeted official suite (13/13).

The five findings above are **still open** and were rerun against the integrated fix. Current key source anchors: `#applySteps` at session.ts:1182, untouched carry filtering at :1252, `#recoverNative` at :1286, and `#untouched` at :1399. The root-owned live harness’s normalized GitHubError mismatch is not a client defect.

## Prior findings: verified disposition

- **Publication F1 / native E:** first returned interrupted conflict can be decided once; the next sync restores intended bytes even when another remote path changed. No extra settling sync before choosing. Stored effective hold base survives checkpoint advancement.
- **Native A:** keep-local pending deletion no longer replays. Seven MemoryStore/native-journal fault schedules plus four real-two-FileJournalStore schedules cover kept save before/after, native cancel before/after, and engine save after cancellation before/after. Reopen both layers, preserve the visible draft, republish the remote deletion reversal, converge, no remaining intent.
- **Native F:** newly detected duplicate, already durable duplicate pause, repository identity change and an ordinary history pause produce no changes to native records, file bytes or modes. `inspect()` is also read-only. This tests the ordinary no-operation exception; accepted apply during a ledger pause is intentionally authorized by the port and not misclassified as a violation.
- **Native B:** after-read hidden mutation survives new host lifetime. Following sync raises exact changed bytes into pinned engine blobs. No hold/stage automatic remove. Native journal compaction is not hidden-content deletion. Retention is now intentionally unbounded; do not advertise a storage bound.
- **Native D:** view opened during attempted-marker save is blocked; view opened while displacement is queued causes post-rename reverse-rename backout. Both production-session paths preserve visible E; keepLocal then succeeds. This does not prove every stale editor reference is protected: preexisting R3-E reproduced a view opened on the old TFile during stage→path install remaining attached to the hidden hold. Subsequent typed bytes surface as displaced on recovery, not lost. Real Android buffer/metadata/open-view behavior remains a gate.
- **F2:** production REST adapter with actual Session/native composition: one stale 404, two older reads, a whole settling round of stale 404s, and an existing unrelated-value ledger-diverged pause all recover on fresh receipt without replay or extra seal writes. Every ledger read URL is distinct and has no-cache headers. No GraphQL ref lookup is sent. This is HTTP fault injection, not a claim about live GitHub consistency; root owns live validation.
- **F3:** both legacy/fence delivery orders work, including durable fence save then crash before dispatch and delayed seals. Discard/re-enrollment is refused while head is the old parent, permitted after the fence, and the delayed legacy request cannot land while that parent is no longer current. Rewind before review makes review unfenced again and next sync fences again. Rewind *after* discard/re-enrollment can allow the old branch-only CAS to land (fundamental branch-only boundary), but the recorded fence checkpoint then pauses history-rewritten and does not silently overwrite local content. Do not claim the old request can never land under arbitrary external rewind.
- **F4:** whole three-file top-level folder loss below bulk floor produces a bulk-deletion decision in both directions; no publication or local delete before decision.
- **F5:** ordinary scoped malformed issue quarantines only its path; valid neighbor evidence is saved/acked and unrelated edits publish. Unknown-scope malformed issue returns native-error and prevents publication. Resume bypass E2-5 remains.
- **F6:** publication alongside an unresolved oversize/native hold reports `needs-decision` with `published:true`. This regression is fixed in tested composition.
- **Oversize export/ack:** unchanged source export copies exact size to the dedicated hidden export directory, keeps source intact, and does not enter `scan().files`/unreadable. Failed decision-save does not ack; durable decision still does not ack until sync; restart applies and clears the block for stable source. Cases E2-1/2/3 are remaining gaps, not missing UI counts.

## Acceptance limits

No physical Android/force-stop/power-loss/editor-buffer evidence was generated here. The prior native R2 Android, unsaved-buffer, migration and long-lived-storage gates remain subject to root's actual evidence. The full GitHub-authoritative replacement claim additionally depends on scope/config/ignore and size-limit decisions; new scope work was not reviewed. Root-owned UI changes were not counted as engine bugs. Fable's rate-limit termination is not approval.

## Source fingerprints

SHA-256 at the initial ae497b4 review (before the restore addendum):

```text
session.ts              f7088dc4c179cd680c3a3dfff617054db06c4ed1a7137350c0d820708ba2d1d8
reconcile.ts            c1afce12bc01e31de42bbb68a21d790e1ea1a90fc85e5189ac7279f1d604ce48
state.ts                d82f92266073b66b1c2e0c9a8d830a188c3a461c093d4eb0abc3c0c7ba8eaf08
contracts.ts            feb616d84c107da6c56828d9a9f584823a1971956302e8df45ffe9bb09606f05
github.ts               105093d65215656cbbd79fdb1c732216557ef4f74027a2cc4502b6cb0f32beaf
obsidian-vault.ts       dbbb4c5083470f0e18f53eee2e69893155a3632cacee996258a9bc57c7abc55b
native-transactions.ts  3d33c75484cb1c5e688d5126e14a57c4aa6722e6428f8c81b49af4bff5e2669d
```

After integrated restore fix, the changed reviewed files are:

```text
session.ts  191ff6020ef380a30c2f31239860d950b752e6d5c01a282642127ca9a1d487bd
state.ts    0bbea68b6e137bd2292bdd19816befe737a316ac508e554c9753d2dc2fe5a4e0
```
