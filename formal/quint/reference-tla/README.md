# TLA+ baseline for GitHub-authoritative vault sync

This directory retains the bounded TLA+/TLC protocol baseline. The separate
`formal/quint/` work is the preferred readable specification and is not part of
this commit; this work does not replace or modify it. The baseline explores the design in
[the proposal](../docs/github-sync-proposal.md), with the differences below.
It is **not an implementation refinement proof or a universal data-loss proof**.
No real vault, GitHub repository, native adapter, or mobile device is exercised.

## Reproduce the evidence

```bash
scripts/check-model.sh                         # safety, liveness, and controls
scripts/check-model.sh --quick                 # omit temporal checks
scripts/check-model.sh --deep                  # also check Core with MaxEnv = 4
scripts/check-model.sh --only Neg_ForgetSiblings
```

Java 11+ is required; the evidence records the actual Java version. The runner
fetches `tlaplus/tlaplus` release **v1.7.4** and verifies the entire jar against
SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
The downloaded jar and TLC scratch files are ignored by Git. The default is
eight workers, 4 GB heap, seed 1, fingerprint polynomial 0. `TLC_WORKERS`,
`TLC_HEAP`, `TLA_TOOLS_DIR`, `TLC_METADIR`, and `TLC_EVIDENCE_DIR` override these
settings. Run one invocation per evidence/scratch directory.

[The evidence summary](evidence/summary.md) records measured state counts,
depths, elapsed whole seconds, host, tool versions, and model/runner hashes.
Each configuration has a hash and complete TLC output. A partial `--only` run
replaces the summary with only that selection; unrelated older logs are not new
results. Negative traces preserve multiline values; the `.tlc.txt` logs are the
complete source of evidence. Parallel workers can change counterexample choice
and stopping counts. These are measurements, not performance benchmarks.

The runner requires both the expected diagnostic and the matching TLC exit
code: 0 for success, 12 for an invariant violation, 13 for a temporal violation.
A misspelled selection, parse failure, or unexpected violation fails the run.
TLC uses fingerprints; its reported collision estimates remain in the logs.

## Finite abstraction

- Two devices, two always-present files, one branch, and an external writer.
  Deletes, renames, new files, paths, modes, and byte encodings are absent.
- Every local save creates a fresh abstract value. External writes can create a
  fresh value or revert to a historical value. Same-byte saves with a new local
  generation are not represented.
- Commit objects contain a parent, tree, author, and publication status. Only
  `Process` changes a candidate into an accepted branch commit. A positive ref
  update requires `head = candidate.parent`; uploading/creating the candidate
  does not publish it.
- `MaxEnv = 3` bounds **all saves, external commits, crashes, response losses,
  slow-request timeouts, and rewinds together**, not three of each. `Core_Deep`
  raises that total to four. Protocol steps are unbounded. `CommitBoundSlack`
  checks a free commit slot in the configurations that list it; the probe and
  targeted controls do not all check this invariant.
- Device state is durable by definition. A positive crash during publication
  loses response knowledge; a crash during apply preserves the entire batch.
  `ApplyFile` is atomic. There are no intermediate flush/write failure states.
- Guarded apply compares live content with the captured draft or coherent base.
  If it differs, the model leaves live content untouched and captures a newer
  draft. A decision flag prevents that draft silently overwriting an unseen
  incoming change on the next sync.
- Conflict decisions reference a captured local value and remote commit.
  `Reusable` requires both to match exactly. A save after capture remains a
  later edit; it does not silently alter the bytes of the approved candidate.
  This is not a check of UI approval tokens or local path generations.

The ordinary phase flow is Idle -> Resolving/Publishing/Applying -> Idle.
Unknown publication reconciles **all** candidate IDs, including prior retries.
Rejected siblings do not establish that the whole operation failed.

### Rewinds and uncertainty

`Rewind` enables owner resets to ancestors. A missing candidate in current
ancestry cannot prove it was never accepted. Therefore, with `AllowRewind`, an
Unknown operation with no candidate confirmed in ancestry becomes **Held**, even
if the head equals the expected parent. Its candidates, drafts, and checkpoint
are retained. Held has no automatic exit in this baseline. Explicit recovery
and rechecking a later accepted result are outside its availability claim.
A request already in flight may still complete while the device is held.

In the **no-rewind** configurations only, an unchanged head permits another
candidate on the same parent, retaining every candidate ID. If head has moved
and none is an ancestor, the operation can restart. This optimization depends on
the no-rewind assumption and must not be copied into a repository where rewrites
are possible. The proposal's general rule remains to hold inconclusive outcomes.

A checkpoint removed by a known rewind produces Paused; explicit `Adopt` preserves
local copies and establishes the new base. Adoption is one atomic model action,
not a verified crash-safe implementation of recovery.

## Checked properties and their limits

The `.cfg` files are authoritative about which properties each run checks.

- `CheckpointPublished`: checkpoint belongs to current head's ancestry.
  `LiveIsCommittedOrOwn`: live content comes from that history or its own user.
  Rewind configurations use weaker **ever-published** variants. The latter
  permits content whose commit has since been removed.
- `BaseCoherent`: outside Applying, live content is the checkpoint value or an
  own-authored value. It does not establish that every such value has been
  explicitly journaled against that checkpoint.
- `CapturedEditsPreserved`: **only the latest local save per device/file** is
  in current branch history, live, the single draft slot, or recovery. A newer
  user save supersedes the obligation for the previous save. This is weaker
  than retaining all captured originals. The rewind variant counts a value
  that **was once on main**, even if no recoverable copy remains now.
- `NoUnauthoredChange` and `NoBlindOverwrite` flag candidate construction with
  foreign-authored output or a parent value never seen by that device. They
  are checked at construction, including rejected candidates. `seenBy` is a
  historical set, not a version-bound approval certificate.
- `NoReplay`: no two device commits in the **current branch ancestry** introduce
  the same abstract value. It is not a lifetime exactly-once theorem across
  removed branches. `NoResurrection` prevents removed commit IDs returning to
  ancestry; it does not prohibit recreating equivalent content under a new ID.
- `NoUncertainRetry` checks that an Unknown operation does not create another
  candidate in the rewind-capable model. `HeldHasCandidates` checks that a held
  operation keeps candidate IDs. The transition rules retain the rest of its
  journal as well; these two invariants alone are not a complete journal proof.
- `NeverResolving` checks that d1 editing only f1 and d2 editing only f2 never
  need a conflict decision, with the external writer disabled.

### Quiescent liveness

`Convergence == [](quiescent => <>Converged)` means that after the environment
explicitly stops, eventually both devices are Idle at the branch head with its
content and no drafts. Its assumptions are:

1. No rewinds, no held operations, fixed devices/files, and the finite bounds.
2. After `GoQuiescent`, no saves, external commits, crashes, losses, or new slow
   request timeouts. Previously sent requests and lost responses still recover.
3. Weak fairness of each `DeviceStep(d)` and of the aggregate GitHub `Process`
   action. Device steps include conflict decisions, so fair user decisions are
   assumed, as are eventual process execution and device progress.

There is **no fairness on `GoQuiescent`**: this theorem does not say the
uncontrolled environment eventually stops, or that sync converges during
continuous edits. Safety has no fairness assumption. Temporal checks disable
symmetry; safety configurations use device/file symmetry. Deadlock checking is
disabled because terminal quiescence and intentional holds are legal; safety
passes alone are not evidence of availability.

## Configurations and controls

`Core` and `Core_Deep` check the normal safety properties; `Rewind` checks the
weaker historical variants plus rewind/hold safety. `Liveness` checks convergence
and a listed subset of safety; `Independent` checks convergence and disjoint-file
behavior. `Probe_OptimisticCheckpoint_Loss` checks only latest-save preservation
when checkpoint-on-send is enabled. Its passing result is bounded evidence of
redundant protection, not proof that optimistic checkpoints are safe.

The controls deliberately break one mechanism and must produce these diagnostics:

- `Neg_NoApplyGuard`: `CapturedEditsPreserved`.
- `Neg_NoApplyJournal`: `NoUnauthoredChange` after interrupted partial apply.
- `Neg_PartialCheckpoint`: `BaseCoherent`.
- `Neg_OptimisticCheckpoint`: `CheckpointPublished`.
- `Neg_ReplayOnUnknown` and `Neg_ForgetSiblings`: `NoReplay`.
- `Neg_StaleResolution` and `Neg_SilentNewDraft`: `NoBlindOverwrite`.
- `Neg_DiscardOnUseGitHub`: `CapturedEditsPreserved`.
- `Neg_FastForwardRef`: `NoResurrection`.
- `Neg_RewindUnknown`: `NoUncertainRetry`; this demonstrates the hold policy for
  a rewind-capable repository, without requiring an actual rewind first.
- `Neg_UnfairLiveness`: a temporal counterexample when fairness is removed.

Each safety control checks its **selected target invariant**, not every other
property. It does not establish that this is the only or weakest failure.
Action-coverage files show which actions the positive Core, Rewind, and
Independent runs exercised; they do not establish coverage of every combination
of faults. Deep exploration adds one environment event, not unbounded assurance.

The traces motivate keeping all sibling candidates after an unknown outcome,
flagging edits found during incoming apply for a new decision, guarding live
replacement, and keeping a coherent batch checkpoint. They are examples within
this abstraction; implementation tests must reproduce the relevant behaviors.

## Outstanding correspondence obligations

The following gaps are intentionally explicit so this useful baseline cannot be
mistaken for validation of the engine or the stronger journal contract:

- **Originals, newer carry, and incoming bytes.** `draft` is a single slot per
  path and may be replaced. `target` is a commit pointer into an always-readable
  object store, not locally retained incoming bytes. A save after `ApplyFile`
  but before `Finish` can remain live without a new explicit carry capture.
  There is no invariant requiring original snapshots, later carry generations,
  and incoming bytes to be durable before every checkpoint. Implement and verify
  that stronger obligation separately; this model's preservation predicate
  cannot discharge it.
- **Unknown acceptance.** The held policy is conservative. Mapping real HTTP
  outcomes, unavailable ancestry, candidate storage, and rewrite recovery to it
  remains work. Exact-head CAS is assumed, not checked against GitHub's API.
- **Approvals.** This model binds reuse to a remote commit/local abstract value;
  it does not prove engine conflict IDs bind path, base, incoming version, local
  generation, and chosen result, nor validate identical-byte ABA saves.
- **Paths.** Files are model values; prototype-key paths, traversal, Unicode/case
  collisions, and object-map hazards cannot occur here.
- **Storage and restart.** No torn writes, quota failures, corrupt journals,
  unavailable incoming objects, separate checkpoint flush, concurrent process,
  native binary replacement, or recovery-cache eviction is represented.
- **Reported engine counterexamples.** The task reports uncertainty replay,
  stale approvals, prototype paths, missing carry capture, and target recovery
  reproductions in `/tmp/git-sync-readonly-review`. Those are implementation
  findings supplied to this review, not reproduced or resolved by running TLC.
  A green model does not rebut any of them. No refinement relation or trace
  correspondence with the engine has been established.

The readable Quint work can express the stronger journal and approval rules.
The TLA baseline remains useful independent evidence for its narrower declared
scope. Neither artifact on its own establishes safety of a real vault.
