# Native host-index acknowledgement review, round 1 (independent, read-only)

**Scoped verdict for c19c33e "Wait for native visible files to enter host index": correct at the boundary the diagnosis named, no defect found.** A visible rename-method intent (create, replacement, deletion) is no longer retired until the host index holds the same `TFile` in both `getAbstractFileByPath` and `getFiles()` (or neither, for a deletion), and the disk bytes, hold bytes and owner are rechecked before retirement. On timeout, a concurrent edit, a hold edit, an owner retirement or a hold view the attempted intent stays durable and the next pass replays it through the same acknowledgement. The inventory-versus-index gate in `scan()` is untouched. No native operation outside visible rename-method intents waits or does a visible lookup. Two design edges are recorded for root (R1-A, R1-B); neither blocks.

Reviewed in `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600` on 2026-10-14. Root HEAD advanced from c19c33e to 911ddc6 during the review; the four intervening commits touch `github.ts`, `github-client.test.ts` and docs only. `obsidian-vault.ts`, `native-vault.test.ts`, `native-transactions.ts` and `session.ts` are byte-identical between c19c33e and HEAD (fingerprints below), and the adapter cases were additionally rerun against a `git archive` of exactly c19c33e. No source, app, device, remote, real vault or subagent was touched. Only `/tmp/vsr-r1/*` and this report were written. The installed Obsidian 1.14.4 bundle was read from disk as a static artifact only.

## What the commit changes

`obsidian-vault.ts` (+39): `hostIndexAgrees(path, next)` requires, for a non-null `next`, a `TFile` from `getAbstractFileByPath` whose `.path` equals the intent path and which is the one and only `getFiles()` entry for that path by identity; for a null `next`, both must be absent. `waitForVisibleRename` polls that predicate for up to 101 checks separated by `indexTick` (default 50 ms, so 5 s), calling `assertActive` each round. Once the index agrees it re-reads the live oid (must equal `next`), re-reads the hold oid when there is a hold (must equal `expected`), rechecks the predicate, and returns. A failed byte check throws immediately; exhaustion throws "did not settle in host index". `finish` invokes the wait only for `applied` results of `rename`-method intents on visible paths, after the existing hold-view block and before `transactions.finish`, and rechecks the hold view afterwards. The `indexTick` is an injectable constructor parameter; `main.ts` uses the default.

`native-vault.test.ts` (+170): harness gains index exclusion/inclusion, index ghosts (entry in `getFiles()` only), wrong-object lookups, owner retirement and an index-tick hook; nine tests cover never-appearing create, late-appearing create, mismatched lookup object, late-disappearing deletion, replay via `recover`, edit during wait, owner retirement during wait, hold view opened during wait, hold edited during wait.

## Evidence from the installed Obsidian bundle (read-only)

`~/Library/Application Support/obsidian/obsidian-1.14.4.asar`, desktop `FileSystemAdapter`:

- `rename(e,t)`: after `fsPromises.rename`, it triggers `"renamed"` only when `this.files[e]` exists (`r?(...this.trigger("renamed",t,e)...):[2]`). A hidden stage path under `.git-vault-sync-*` is not in that cache, so a stage→visible rename emits no adapter event. The index then learns of the new path only through the fs watcher: `onFileChange` is `setTimeout(() => queue(reconcileFile(...)), 0)`, then `lstat`, then `reconcileFileCreation` → `"file-created"`. This is the lag the diagnosis inferred, now confirmed from the artifact, and it is why the acknowledgement has to live at the plugin's rename boundary.
- `Vault.getFiles()` walks the folder tree (`recurseChildren(root)`), while `getAbstractFileByPath` reads `fileMap`. They are two structures, so requiring identity agreement between them, as the commit does, is the right test rather than either alone. `scan()` only consults `getFiles()`.
- `reconcileDeletion` from a watcher event defers removal by 100 ms and re-reconciles. The commit's 5 s bound comfortably covers both paths.

## Scratch verification

Harness: `/tmp/vsr-r1/harness.ts` is the committed harness (lines 1–213 of `native-vault.test.ts`) with absolute imports plus hooks for a null lookup, a non-`TFile` lookup, an arbitrary ghost object and owner revival. `harness-c19.ts` / `harness-parent.ts` point the same harness at `git archive` extractions of c19c33e and its parent 6fb45d3. Engine drive: `/tmp/vsr-r1/r1-engine.test.ts` with a `MemoryVault` subclass that throws the index-lag error with an attempted intent durable.

```sh
cd <root>/plugin && node_modules/.bin/tsx --test /tmp/vsr-r1/r1-adapter.test.ts /tmp/vsr-r1/r1-adapter-c19.test.ts /tmp/vsr-r1/r1-engine.test.ts /tmp/vsr-r1/r1-parent.test.ts
```

Outputs: `/tmp/vsr-r1/r1-adapter-results.txt` (HEAD), `r1-adapter-c19-results.txt` (exact c19c33e), `r1-engine-results.txt`, `r1-parent-results.txt`.

| Case | Result (HEAD and c19c33e) | Meaning |
|---|---|---|
| A1 timeout, then replay through `apply()` | pass | second `apply` with the same intent waits again, applies at tick 3, no new stage written, capture returns next |
| A2 timeout, replay while index still missing | pass | throws again after exactly 100 ticks, visible file not rewritten, intent still attempted, `capture()` still refuses the unindexed file |
| A3 `getFiles()` has the path, lookup null | pass | keeps waiting until lookup agrees |
| A4 lookup returns a non-`TFile` at the path | pass | never acknowledged, durable intent, bytes intact |
| A5 stale `TFile` object at the path during replacement | pass (note R1-A) | acknowledged at tick 0 |
| A6 create timeout, user deletes before replay | pass (note R1-B) | replay reinstalls the file, no evidence record |
| A7 delete timeout, user recreates before replay | pass | user bytes stay live, retained as `interrupted`, hold kept |
| A8 edit during wait, then replay | pass | user bytes stay live, retained as `interrupted`, intent settles |
| A9 hold view opened during wait, closed later | pass | `blocked` while open, repeat apply `blocked`, `applied` after close, hold intact |
| A10 owner retired between index agreement and byte read | pass | attempted intent survives reopen, replay applies |
| A11 text-process and hidden config create/replace/delete | pass | zero ticks, zero visible lookups (harness throws on hidden lookups) |
| A12 visible create under `config/1` policy | pass | waits like legacy |
| A13 `apply()` equal-bytes fast path with no intent | pass (pre-existing) | returns `applied` with zero ticks; `scan()` gate still refuses |
| A14 cancel of a timed-out create | pass | zero ticks, installed bytes retained as `interrupted`, intent cleared |
| A15 real 50 ms timers | pass | gives up after 5.1 s |
| A16 lookup object changes between the two predicate checks | pass | not acknowledged, intent durable |
| ENGINE first apply throws, two replays | pass | sync 1 throws with `Seed.md:pending` and the intent durable; sync 2 authorizes `replay` (not `cancel`) and throws again; sync 3 settles with no hold, no `nativeErrors`, both steps applied, head unchanged |
| ENGINE restart between throw and replay | pass | resumed operation still authorizes replay and settles |
| PARENT 6fb45d3 crash-window control | pass | the A6 reinstall already happens at the parent for a crash after install |
| PARENT 6fb45d3 lag control | pass | parent retires the intent before the index agrees and `capture()` then fails, i.e. the diagnosed failure |

Owned suites: plugin 473/473 at HEAD 911ddc6 and 473/473 on the c19c33e extraction; server 4/4; `tsc --noEmit` clean for plugin (HEAD and c19c33e) and server.

## Findings

### R1-A — note, optional hardening: a stale pre-replacement `TFile` satisfies the predicate

For a replacement (hold rename then stage rename), the predicate accepts any `TFile` at the path with matching identity in both structures. If Obsidian has not yet processed the hold rename, the old entry is still at the visible path and the wait returns at tick 0 (A5). On desktop this window is unlikely: the visible→hold rename's source is in the adapter cache, so `"renamed"` fires inside the adapter's own rename promise, before `adapter.rename` resolves. For creates there is no prior entry, which is the diagnosed case. If root wants the predicate independent of that ordering, compare the `TFile.stat` size and mtime against the adapter stat before acknowledging. Not a defect of this commit.

### R1-B — note for root, pre-existing semantics with a widened window: a timed-out create is reinstalled on replay after a user deletion

A6: the intent times out, the user later deletes the now-indexed file in Obsidian, the next sync replays, and `renameTransaction` treats the absent path as an interrupted install and reinstalls `next` with no recovery record. The PARENT control shows the same outcome at 6fb45d3 for a crash between install and finish; the journal cannot distinguish "never installed" from "installed then deleted" for a create. The commit widens that window from a crash to any index timeout plus the interval to the next sync. Byte-safe (only a deletion is undone) and consistent with R4-6's accepted replay semantics, so no action is required for this commit. If root wants deletion intent preserved, the replay of an attempted create whose stage is gone and whose path is absent could retain `missing` evidence instead of reinstalling; that is a journal-semantics decision, not a fix here.

### R1-C — accepted edges, no action

- A timeout, a mid-wait edit or an owner retirement surface as a thrown sync error, not a per-path `blocked`; the operation step stays `pending` and the next scheduled sync replays it (ENGINE cases). The user sees one failed sync rather than a quarantined path.
- During the wait, `main.ts`'s `assertActive` also throws when a vault rename becomes pending; the intent stays durable and replays. Matches existing policy.
- Each visible rename-method apply now walks `getFiles()` at least once and, on a lagging host, polls at 50 ms; bulk applies on a slow index pay up to one tick per file. Not measured on a device.
- `apply()`'s equal-bytes fast path (A13) still returns `applied` without consulting the index; `scan()`'s gate catches a stale index there as before. Pre-existing, out of scope.
- The harness now returns `null` from `getAbstractFileByPath` for `absentFromIndex` paths, a behavior change for older tests that use `excludeFromIndex`; all 473 still pass.

## Test-coverage remarks

The committed tests cover the brief's cases. Gaps closed only by scratch and worth promoting: replay through `apply()` rather than `recover` (A1), repeated timeout on replay without a rewrite (A2), null lookup with a `getFiles()` entry (A3), zero ticks for text-process, hidden config and cancel paths (A11, A14), and a scoped-policy visible create (A12).

## Reviewed source fingerprints (SHA-256, identical at c19c33e and HEAD 911ddc6)

```text
6dda3ae83b971508f6a0a07d31af7fa18f456ff0f5eb8d22c90b4fdb4dc860e2  plugin/src/git-sync/obsidian-vault.ts
32c08c53c7c0afecdb09ba00a32bfa2a72eaed560d42556b4408ed33591f8c90  plugin/test/native-vault.test.ts
b139c9ba955c901a9f5422d2c6272f5708016ed5709785415943a3bcc3d1645f  plugin/src/git-sync/native-transactions.ts
6f5d4316d9a39c138df9f1c3769c15821e6e29c210045c29091f8c567b0041a8  plugin/src/git-sync/session.ts
```

Prior closed reviews (`native-editor-review-r4.md`) were not reopened; no new cause was found for R3-E or R4-B.
