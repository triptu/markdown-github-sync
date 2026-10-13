# Native editor-race review, round 4 (independent, read-only)

**Scoped verdict for c0ef284 "Keep native rename intent pending for open hold views": R3-E is closed at the adapter boundary.** The install-rename race no longer returns `applied` with a silently retargeted editor. The old `TFile` view that binds the hidden hold keeps the attempted intent pending under every schedule I could construct (replay, cancel, repeated apply, restart, power loss mid-retention, dirty hold, dirty hold plus edited live path, absent path for both delete and interrupted install). No schedule lost or downgraded bytes, no dirty view was closed or reloaded, and no hold was removed. Through the engine, the block is path-scoped: unrelated notes keep applying and publishing while the view is open. One integrated behavior is worth a decision but is not a defect of this commit (R4-B below). Device acceptance of the real `FileView` rename queue remains root's, as briefed.

Reviewed in `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600` on 2026-10-14. Root HEAD advanced from c0ef284 to 3bc9ae9 during the review. `obsidian-vault.ts`, `native-transactions.ts` and `contracts.ts` are byte-identical to c0ef284 at HEAD. `session.ts` changed by 7 lines in 697bdb5 (configuration replay preimage guard), which does not touch `#recoverNative`'s stuck-intent or quarantine handling; the engine drive below ran at 697bdb5. No source, device, remote, real vault or subagents. Only `/tmp/vsr/r4-*` and this report were written.

## What the commit changes

`obsidian-vault.ts`: `heldViewBlock(intent)` returns a `blocked` result when the intent has a hold, the path is visible, and a `FileView` is bound to the hold path. `finish` consults it before `transactions.finish` for every non-blocked result, so the intent stays durable and attempted. `cancelIntent` returns early on it, and `finishCancel` rechecks it after every evidence retention and before the cancel save. Nothing closes, reloads or writes to a view; the block only withholds the journal finish.

## Evidence

Scratch harness: `/tmp/vsr/r3-harness.ts` (unchanged from R3) bundles the production `GitObsidianVault` against `test/fixtures/obsidian.ts` with the real `NativeTransactionJournal` over map-backed files with no-clobber rename and a queued-rename hook. Cases: `/tmp/vsr/r4-repro.test.ts` (adapter, 11 cases) and `/tmp/vsr/r4-engine.test.ts` (engine drive with a `MemoryVault` subclass that mirrors the new block). Output: `/tmp/vsr/r4-results.txt`.

```sh
cd <root>/plugin && node_modules/.bin/tsx --test /tmp/vsr/r4-repro.test.ts /tmp/vsr/r4-engine.test.ts
```

| Case | Result | Meaning |
|---|---|---|
| R3-E (R3 suite re-run) | now fails on `applied` vs `blocked` | the R3 residual repro no longer reproduces |
| R4-1 install race | pass | `blocked`; attempted intent; next installed exactly; old bytes in hold; repeated apply/replay/cancel are no-ops with zero journal writes; a different next for the same path is refused |
| R4-2 unrelated intent same recover | pass | the sibling intent settles; only the held one stays pending |
| R4-3 replay after close, dirty hold | pass | next stays live; every dirty version retained as `displaced`; hold never removed |
| R4-4 cancel after close, dirty hold | pass | live is not rewritten; dirty bytes and the expected preimage both retained |
| R4-5 delete intent, path absent, view on hold | pass | replay and cancel both leave the hold and the absent path untouched; cancel after close restores exactly |
| R4-6 interrupted install, path absent, view on hold | pass | replay installs next, intent waits, settles after close with the hold intact |
| R4-7 hold and installed path both edited, cancel after close | pass | live edit retained as `interrupted`, hold edit as `displaced`, live untouched |
| R4-8 editor save into hold between inspection and finish | pass | the newer bytes are picked up on the next pass, never lost |
| R4-9 power loss during retention in a blocked pass | pass | restart converges; one retained issue, exact bytes |
| R4-10 hold file removed out of band, view still bound | pass (note) | blocked until the view closes, then applies |
| R4-11 view opened after finish | pass | the pre-existing post-finish residual still surfaces edits as `displaced` |
| ENGINE without/with dirty hold | pass | see R4-A and R4-B |

Owned suites at HEAD: `native-vault`, `native-transactions`, `native-modes`, `journal-store` 98/98 (the brief's 82 was before this commit's additions).

## Findings

### R4-A — verified: the block is path-scoped through the engine

`session.ts` `#recoverNative` records a still-pending intent as a `nativeErrors` entry with a path. `#quarantined` scopes it; only path-null errors become the global `native-error` outcome. In the engine drive, the first sync returns `blocked` with `n.md:blocked` and `other.md:applied` in the same operation. While the view stays open, a new remote commit to a third note is applied and a local edit to another note is published; the branch head keeps the remote's `n.md` throughout and never receives the quarantined path's old bytes as a carried edit.

### R4-B — note for root, not a defect of c0ef284: after the view closes the engine cancels rather than replays

Sequence observed in `/tmp/vsr/r4-results.txt`: sync 2 authorizes replay (blocked, intent stuck, path quarantined); sync 3 onward authorizes cancel, because `#recoverNative` refuses replay for a quarantined path and the operation has already completed with the step marked `changed`. When the view closes, cancel settles backward: the installed next bytes stay live, the expected preimage (and any dirty hold bytes) are retained as `displaced`, and the path becomes a `needs-decision` hold. The disk already equals the remote, so the user is asked to decide a conflict the replay path in the commit's own tests would have closed as `applied`. Byte-safe and consistent with the existing "anything still pending was refused by the vault: hold its path" rule, but the commit's test narrative ("replay after close → applied") does not describe the integrated outcome. If root wants replay-after-close, the engine must keep authorizing replay for an intent whose stuck reason is an open view; that is engine scope.

### R4-C — accepted design edges, no action needed

- A view bound to a hold whose hidden file was removed out of band stays blocked until the view closes (R4-10). Liveness depends on the user, matching the message.
- The gate recognizes `FileView` subclasses only, as before. Non-`FileView` consumers of a `TFile` are outside the gate, unchanged from R2/R3.
- The hold view check in `finish` is a point-in-time read; a view opened after `transactions.finish` is the pre-existing post-finish residual (R4-11), already surfaced as `displaced` by the hidden scan.

## Remaining gate

Device acceptance with the real Obsidian `FileView` and the adapter's rename queue (does a queued stage→path rename retarget a view's `TFile` to the hold, and does the editor flush its buffer to the hold path). Root owns this; nothing here claims it.

## Reviewed source fingerprints (SHA-256, root HEAD 3bc9ae9; native files identical at c0ef284)

```text
4ebf6eb10419ee3993142abbf030d55bec689368755903f308853dc216465622  obsidian-vault.ts
b139c9ba955c901a9f5422d2c6272f5708016ed5709785415943a3bcc3d1645f  native-transactions.ts
e669baa3755967e6ef392fbcdeca39a65d1a9c00e507c443c8811d22de70409a  session.ts
```
