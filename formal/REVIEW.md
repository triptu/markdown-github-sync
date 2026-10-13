# Independent review, 2026-10-13

Accepted as a bounded TLA+ protocol baseline, with the corrections below. This
is not approval of the implementation, a refinement proof, or a universal claim
that vault data cannot be lost. Changes are confined to `formal/` and
`scripts/check-model.sh` in `/tmp/vault-sync-formal`. No agents were spawned and
no real vault or remote repository was accessed. The separate Quint work was
not modified.

## Corrections made during review

1. **Unknown acceptance with possible rewinds.** The previous `Reconcile`
   could retry or abandon an operation based on absence from current ancestry,
   including an unchanged expected head. The revised rewind configuration holds
   such an operation and preserves its candidates/draft/checkpoint. There is no
   automatic exit from Held in this baseline. `Neg_RewindUnknown` catches a
   retry when that hold is disabled. No-rewind models retain the more permissive
   retry optimization under their explicit no-rewrite assumption.
2. **Decision identity.** Reuse now requires the same reviewed remote commit,
   not merely equal remote content, and the same captured local value. This does
   not establish the stronger engine approval-token/path-generation contract.
3. **Crash coverage.** Positive application crashes now explicitly occur while
   preserving durable application state. Previously that branch was enabled
   only with the broken-journal control. This remains an atomic durability
   abstraction, not a flush/restart test.
4. **Control isolation and liveness.** `Neg_PartialCheckpoint` accidentally
   enabled both partial checkpoints and forgotten apply journals. The final
   configuration enables only partial checkpoints and still fails
   `BaseCoherent`, without a crash in its counterexample. Added an unfair
   liveness control, which reaches quiescence and then stutters without finishing
   application. It demonstrates why fairness is necessary.
5. **Evidence runner.** Unknown/disabled model selections and a missing `--only`
   value now fail instead of permitting an empty successful run. Verdicts check
   TLC's exit status as well as its diagnostic; missing depth/count data on a
   JVM failure no longer aborts parsing before reporting the failure. Traces
   preserve multiline values. Source/config hashes, fixed seed/polynomial, and
   additional action coverage make the evidence easier to reproduce and inspect.
6. **Claims.** Replaced the report's "every control violates exactly the target
   and nothing weaker" claim: controls check selected invariants. Clarified
   latest-save versus every-captured-original preservation, historical versus
   recoverable content under rewind, current-ancestry replay, conditional
   liveness, deadlock-check exclusions, and missing implementation correspondence.

## Executed checks

Ran `scripts/check-model.sh --deep` with the pinned TLA+ v1.7.4 jar, OpenJDK
23.0.2, eight workers, and a 4 GB heap on Darwin arm64. All 18 configurations
produced their expected outcomes. After isolating the partial-checkpoint
control, reran that configuration through the same runner and replaced its
row/log/trace/hash; the evidence summary records that provenance. The model and
runner were unchanged between these runs.

Measured positive/probe results (distinct states; elapsed whole seconds):

- Core: **266,730; 4 s**.
- Rewind: **241,127; 4 s**.
- Optimistic-checkpoint preservation probe: **395,431; 3 s**.
- Quiescent liveness: **2,131,994; 127 s**.
- Independent-file liveness: **96,530; 7 s**.
- Deep safety: **16,677,072; 121 s**, 41,455,831 generated states, depth 50.

All **12 negative controls** produced their expected violations (11 invariant
controls and one temporal control). The isolated partial-checkpoint rerun
reported 3,427 generated / 2,420 distinct states, search depth 9, and less than
one measured whole second. Counts and search depth for a counterexample run are
not necessarily its trace length. The unfair liveness log does not report a
complete search depth; the summary leaves it unknown.

Also checked `bash -n`, argument rejection, and an invalid JVM heap setting. The
last case reported a mismatch and exited 1, rather than treating absent model
output as success. Verified the cached jar digest and the model, runner, and
configuration hashes against the final evidence. The raw TLC logs retain
fingerprint collision estimates; these are finite probabilistic model-checker
results rather than mathematical proofs over all systems and all bounds.

## Counterexamples inspected

- [Forgotten siblings](evidence/Neg_ForgetSiblings.tlc.txt): candidate 1 is
  accepted, an external commit reverts its content, sibling 2 is rejected, and
  forgetting both IDs allows the same draft to be published again over the
  revert. The final branch contains two introductions of value 1.
- [Forgotten apply journal](evidence/Neg_NoApplyJournal.tlc.txt): an external
  value is partially applied, a crash forgets the batch, and that downloaded
  value is then constructed as a device-authored outgoing change.
- [Stale resolution](evidence/Neg_StaleResolution.tlc.txt): a decision about
  remote value 2 survives rejection, is reused against remote value 3, and
  constructs a candidate overwriting content the device has not reviewed.
- [Fast-forward update](evidence/Neg_FastForwardRef.tlc.txt): an owner removes
  commit 1; accepting a candidate descended from it resurrects commit 1. An
  exact expected-head update rejects this publication.
- [Unfair convergence](evidence/Neg_UnfairLiveness.tlc.txt): after quiescence
  and accepted publication, application never finishes because the execution
  stutters. This is not excluded without the fairness assumption.

## Remaining limits

The full scope is in [README.md](README.md). The most consequential gaps are:

- A single draft slot and an always-available commit tree do not prove durable
  preservation of captured originals, newer carry generations, and incoming
  bytes before checkpointing. A late save after per-file apply can remain live
  without explicit carry capture at `Finish`.
- Rewind preservation permits "was once committed"; it does not prove a copy
  remains recoverable. `NoReplay` only concerns current ancestry.
- Liveness excludes rewinds/holds, assumes quiescence and weakly fair device,
  user-decision, and GitHub-processing steps, and makes no claim under continuous
  edits or permanent unavailability.
- No byte-level journal, native storage, path handling, approval-token schema,
  same-byte generation race, or implementation refinement relation is checked.
- The root engine reproductions for uncertainty replay, stale approvals,
  prototype paths, missing carry, and target recovery are reported inputs to
  this review. They were not rerun or fixed here. Passing TLA checks do not
  contradict those findings.

This commit is useful baseline evidence for the declared abstraction. The
stronger proposed protocol and actual engine still need their own checks.
