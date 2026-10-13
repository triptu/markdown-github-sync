# Desktop final acceptance: host index lag after native seed creation

Date: 2026-10-14. Read-only diagnosis of failed run `22e20410-660e-408c-83b1-9f53e9a1e5eb`. No app, device, credential, or remote action was taken here. The failed result and vault remain unchanged.

## Finding

The first production `syncOnce()` applied the seed file through a journaled native **stage-to-visible rename**. The disk file existed with the exact 59 seed bytes, but Obsidian's visible file index had not yet acquired `Seed.md` when production's post-application capture ran. `GitObsidianVault.scan()` correctly refused to infer that an unindexed disk file was safe to scan. This is a production native/host index timing gap, exposed by the helper's immediate first sync; the seed fixture itself is not the cause.

The later CDP read supplied by root found `Seed.md` in `app.vault.getFiles()` with `deleted === false`. That is evidence of eventual index catch-up, **not** a pass for the failed command or proof that the index was current at the earlier capture.

## Evidence and call order

- The installed desktop production `main.js` SHA-256 is `a85020d6205f2efbcf777074e47d896f4acafc69e7385744a48d2e2cfa4ecad5`, matching the pinned build. The failure JSON contains exactly `Visible file missing from host index: Final Acceptance 22e20410-660e-408c-83b1-9f53e9a1e5eb/Seed.md`. No helper state file was written; `preflight` is the helper's generic label for any error before its initial state save, including this post-enrollment sync.
- The helper calls production `session.enroll(...)`, then `plugin.syncOnce()` before its own `getAbstractFileByPath` check (`plugin/test/native/final-acceptance.ts:200-205`). Only production `GitObsidianVault.scan()` emits the observed error (`plugin/src/git-sync/obsidian-vault.ts:515-517`). The helper's own missing-file assertion would have a different message.
- The native journal records a `rename` intent for `Seed.md`, first unattempted, then attempted, then cleared. Production's create path stages bytes and calls `adapter.rename(stage, visiblePath)` (`plugin/src/git-sync/obsidian-vault.ts:228-238`; `:611-618`). It does not wait for the visible host index before finishing the intent (`:146-151`).
- The engine journal saved an apply operation with `Seed.md` pending at 01:18:55.657, then `Seed.md` applied at 01:18:55.665. The seed file's disk mtime is 01:18:55.660 and its exact content is `Final acceptance seed 22e20410-660e-408c-83b1-9f53e9a1e5eb\n`. The failure result was written at 01:18:55.667. Source immediately performs `#capture(..., "post-application capture", false)` after saving the applied step (`plugin/src/git-sync/session.ts:1653-1665`). The error therefore fits that capture, between the applied-step record and result write.
- A later engine record at 01:18:58.705 has `operation: null`, the same seed checkpoint, empty carry/review/pause, and no native intent. This is consistent with a subsequent foreground sync after the index caught up; the scheduler's default event delay is three seconds (`plugin/src/git-sync/scheduler.ts:29-39`). It does not erase the earlier failure.
- The seed's actual bytes and path match the run UUID, and no other visible files appeared in the frozen vault. No evidence points to a malformed fixture, binary/text misclassification, or wrong production bundle.

## Minimal correct fix to implement in a separate change

Keep the inventory-versus-host-index safety check intact. At the **native rename completion boundary**, before `GitObsidianVault` retires an `applied` visible-file intent and returns success, wait for the host index to reflect the expected path state: a `TFile` at the path for a create/replacement, or no indexed file for a deletion. Use a bounded, cancellable observation (host event plus recheck, or short polling) and recheck the native bytes/active owner. If the host never converges, fail with a clear index-lag error and **leave the attempted native intent durable** for safe replay. The already-final path on replay must use the same index acknowledgement; otherwise replay can return `applied` before the index again.

This places acknowledgement where `adapter.rename` is issued, covers both the first attempt and replay, and does not treat a disk-only file as safe input. A fixed delay in the acceptance helper, a swallowed scan error, or deletion of the inventory gate would only hide the race. The helper could separately improve its early-stage label, but that is diagnostic hygiene, not the production fix.

## Verification after a fix

Use a controlled host-index lag test for a visible create: native rename finishes on disk while the fake `getFiles()` omits the path, then adds it; confirm production waits and finishes only after the index agrees. A never-appearing path must leave a durable intent and fail closed. Cover replay and visible deletion similarly. Then rebuild production, pin its new SHA in a **new UUID** helper build, and run a new disposable branch/vault. Preserve this failed result and do not retry UUID `22e20410-660e-408c-83b1-9f53e9a1e5eb`.
