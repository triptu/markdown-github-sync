# Native safety review, round 3 (independent, read-only)

**Scoped verdict for the briefed commit 5769c99 (native dd93f95, contracts 5a67a87): NOT accepted.** The R2 keep-local/capture/fence redesign is implemented faithfully to the cancel port, and every cancellation and replay schedule I traced preserves bytes. But three oversize-lifecycle defects at that commit make a user decision permanently unappliable or take native recovery down for every path (R3-A, R3-B, R3-C). All three are closed on the current root HEAD by the later commit d5cc192 "Handle oversized native intent and retained-source transitions"; my defect repros fail there, meaning the defects are gone, while my control repros still pass. One residual editor race (R3-E) and one design note (R3-F) remain on HEAD.

Reviewed in `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`, 2026-10-13/14. The brief named HEAD 5769c99; during the review root advanced 55+ commits to ed0683e and then 7792d70. I extracted 5769c99 with `git archive` to `/tmp/vsr/at-5769c99` so that the briefed commit could be exercised without touching the repository, and ran the same scratch suite against the live root. No repository edits, real vault, remote, device or subagents. Only `/tmp/vsr/*` and this report were written.

Read in full: `docs/verification/native-review-r1.md`, `native-review-r2.md`, `/tmp/github-v2-native-cancel-port.md`, `/tmp/github-v2-native-oversize-port.md`; at HEAD also `docs/verification/native-oversize-r3-port.md` and `engine-native-review-r3.md` (another R3 engine review already recorded there; I did not re-derive its findings).

## Evidence

- Scratch harness `/tmp/vsr/r3-harness.ts` bundles production `GitObsidianVault` unchanged against `test/fixtures/obsidian.ts` with the real `NativeTransactionJournal`/`FileJournalStore` over map-backed files with no-clobber rename, folder inventory and stat (adapted to HEAD's recursive `inventoryLocal`). `VSR_PLUGIN` selects the source tree.
- Cases `/tmp/vsr/r3-repro.test.ts`; output of both runs `/tmp/vsr/r3-results.txt`.

```sh
# briefed commit
cd /tmp/vsr/at-5769c99/plugin && VSR_PLUGIN=/tmp/vsr/at-5769c99/plugin node_modules/.bin/tsx --test /tmp/vsr/r3-repro.test.ts
# live root
cd <root>/plugin && node_modules/.bin/tsx --test /tmp/vsr/r3-repro.test.ts
```

| Case | 5769c99 | HEAD 7792d70 | Meaning |
|---|---|---|---|
| R3-A deleted oversize source | defect reproduces | defect gone | fixed by supersession |
| R3-B shrunken oversize source | defect reproduces | defect gone | fixed by supersession |
| R3-C visible oversize at pending path | defect reproduces | defect gone | fixed by `pendingSource` |
| R3-D re-raise after ack (hypothesis) | no defect | no defect | hypothesis refuted, see below |
| R3-E view opened during install rename | residual | residual | editor-safety gate stays open |
| R3-F cancel with absent path + changed hold | as designed | as designed | design note |
| R3-G cancel crash idempotence | pass | pass | |
| R3-H export never deletes/publishes | pass | pass | |
| R3-I replay restores changed hold | pass | pass | |
| R3-J compaction keeps evidence | pass | pass | |

Owned suites: at 5769c99 `native-vault`/`native-transactions`/`native-modes`/`journal-store` 54/54; at HEAD 91/91. Passing counts do not negate the counterexamples below.

## Findings at 5769c99

### R3-A — HIGH (liveness / decision override): removing the oversize source makes the user's decision permanently unappliable

`obsidian-vault.ts:324-334` (`acknowledgeRecovery` requires current size and mtime to equal the record), `:450-451` (`apply` blocks any path with an oversize record), `:300-301` (scan merely untracks a missing hidden file and never retires its oversize record).

Repro R3-A: oversize hold is recorded, exported, then the user deletes the hidden original, which is exactly the workflow `native-oversize-recovery.md` documents ("export ... then explicitly remove old hidden files"). Next recover: the stale oversize record survives with the same id; `acknowledgeRecovery([id])` throws `Oversized source changed. Recover again before acknowledging.` forever, and `apply("a.bin", next, null)` returns `blocked` forever, across a new host lifetime. Since the engine acknowledges an oversize id only after the user's decision is durable and immediately before applying it, the decision can never be executed and the path can never be written again. No bytes are lost.

### R3-B — HIGH (same mechanism): an oversize source that shrinks to readable bytes leaves a stale oversize block

Same locations plus `:302-313`. Repro R3-B: the hold shrinks to a small changed version. The scan correctly raises a `displaced` issue with the new bytes but still returns the old oversize id; ack of that id throws and `apply` stays blocked. Two holds for one path with contradictory evidence.

Fix for both (what HEAD now does): when a tracked source with an oversize record becomes missing or readable, atomically replace the oversize record with a byte issue (`found` = exact bytes or `null`) in one journal save, record the superseded id so a stale ack is rejected rather than silently accepted, and drop the matching `acknowledgedOversize` entry. The engine must treat the vanished id as superseded evidence (recorded as engine R3-1 in `engine-native-review-r3.md`).

### R3-C — MEDIUM (liveness, global): a visible oversized file at a pending intent's path throws out of every `recover()`

`obsidian-vault.ts:48-55` (`read` throws over 8 MiB), `:250` and `:129` (cancel and replay both hash the live path through `oid`), `:288-294` (the loop has no per-intent isolation).

Repro R3-C: crash after displacement leaves an attempted intent with the preimage in the hold and the path absent; the user drops a >8 MiB attachment at that path. `scan()` lists it as unreadable, but `recover({cancel})` and `recover({replay})` both throw `File exceeds 8 MiB`, the loop aborts before any other intent or the hidden scan runs, and the intent can never be settled. Because the engine calls `recover` on every sync, native recovery for the whole vault is down until the user moves the file. The kept preimage stays stuck in the hold.

Fix (what HEAD now does): hash the pending path with the size-tolerant hidden reader, retain an oversize issue with `sourcePath === path`, leave the intent pending and continue with the other intents and the scan; catch the late-growth race per intent.

### R3-D — not a defect (refuted hypothesis, kept as a control)

I expected cancel-with-changed-hold to overwrite `tracked.observed` with the expected oid (the last record for that source is the retained preimage) and re-raise the hold bytes under a new id after acknowledgement. It does not: the hidden scan inside the same `recover` call dedupes against the not-yet-acknowledged record and durably observes the hold's real oid before any ack can happen. The test asserting the defect fails on both snapshots.

### R3-E — MEDIUM, residual (unchanged from R2-D, narrowed): a view opened during the install rename stays retargeted

`obsidian-vault.ts:159-167` restores a view that opens during the first queued rename (path to hold); nothing rechecks after the second queued rename (stage to path) at `:183`. Repro R3-E: a view bound to the old `TFile` opens while the install rename is queued; `apply` returns `applied`, the view's `TFile.path` is the hold, and later edits land in the hidden file. They are surfaced as `displaced` on the next recover (not lost), but the N1 editor-safety gate remains open. This is a host-lifetime question Node cannot settle; verify on Android with the real `FileView` and rename queue, and consider a final `openView(hold)` check after install that at least reports the retarget.

### R3-F — design note, not a defect: cancel does not restore a changed hold to an absent path

`cancelIntent` (`:266-275`) retains a changed hold as `displaced` and leaves the visible path absent, whereas replay at `:138-140` renames the changed hold back when the path is absent. Both match the cancel port ("settle backward ... anything else: retain an issue"). The user who chose "keep local" sees the note vanish until they resolve the displaced hold with `found`. Byte-safe, but worth an explicit UI expectation or a port amendment allowing the no-clobber restore of the newest hold bytes.

## Port guarantees verified at 5769c99 and HEAD

- `capture()`, `scan()`, `pendingIntents()` perform no journal, hidden-file or mode-store writes (checked by journal write counting). `scan()` reports a visible oversize file as unreadable without reading it.
- `apply()` refuses a pending intent whose expected/next oid or mode differs; a matching call continues the intent. Unknown intent ids in neither list are untouched; conflicting replay/cancel throws.
- Cancellation: unattempted drops in one save; attempted settles backward (restore hold when path absent, retain both hold bytes and the preimage when the install landed, retain torn live bytes); every retention save precedes the cancel save and `retainIssue` dedupes, so a crash between them converges (R3-G, plus the owned lost-ack test). A changed hold is never downgraded: its bytes are retained before the intent is dropped, and replay restores them to an absent path (R3-I).
- Oversize ack compares exact size and mtime; export copies to a private temporary file, verifies size and source metadata, publishes by no-clobber rename under a dot-prefixed directory, and never removes the source (R3-H, remove calls counted). The root UI exposes inspect/export only; ack remains engine-driven.
- Same-App fence: `assertActive` precedes every rename, copy, stage write and the fenced journal save; HEAD adds the config-dir check. Not a cross-process lock.
- Journal-only compaction keeps every object referenced by the latest eight records, including displaced evidence (R3-J). Hold/stage retention is unbounded by explicit decision; `retainedHiddenSummary` is read-only.

## Remaining native acceptance gates

1. **Oversize lifecycle (R3-A/B/C):** closed on HEAD by d5cc192; the briefed commit must not ship without it. Engine must consume superseded ids (engine R3-1 is open).
2. **Editor safety (R3-E):** window after the install rename; Android verification with real views required; no dirty-buffer flush exists.
3. **Hidden reads without a stat:** `hiddenBytes` still reads a whole file into memory before the limit check when `stat` returns null (HEAD stats visible paths first in `read`, hidden ones only via `stat`). Low.
4. **Retention/liveness:** unbounded holds and `acknowledgedOversize`/`supersededRecoveryIds` lists grow without a prune; accepted explicitly, but quantify before beta attachments.
5. **Cross-layer R2-A / R2-E / R2-F final verification:** pending engine integration, not passed here. The old-session `recover()` type error at 5769c99 is the known integration gap, not a new defect.
6. **Android crash boundaries, fsync, dirty-editor proof:** out of scope for Node, still open.

## Reviewed source fingerprints (SHA-256)

```text
at 5769c99
obsidian-vault.ts       dbbb4c5083470f0e18f53eee2e69893155a3632cacee996258a9bc57c7abc55b
native-transactions.ts  3d33c75484cb1c5e688d5126e14a57c4aa6722e6428f8c81b49af4bff5e2669d
contracts.ts            feb616d84c107da6c56828d9a9f584823a1971956302e8df45ffe9bb09606f05
at HEAD 7792d70
10441518e5a0741296a2c61fe9841ffaa1c3cb111dbb77a4e2daa44f82a920c5  obsidian-vault.ts
b139c9ba955c901a9f5422d2c6272f5708016ed5709785415943a3bcc3d1645f  native-transactions.ts
dd567c02d1165280bc9f54859662f5a3814ad34addd85eb37c806e0848a33a5a  contracts.ts
```
