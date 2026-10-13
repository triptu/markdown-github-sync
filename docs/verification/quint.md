# Quint-only protocol checks

Quint is the sole maintained specification language. Handwritten `VaultSync.tla`, `MCIndependent.tla`, their configurations/evidence, and the `reference-tla` duplicate are retired; Git history at `e780b4c` preserves them. `scripts/check-model.sh` delegates to the Quint runner. Generated TLA is transient compiler output, never a second authored specification.

The selected contract is Opus design §§2–6, with the parent's choice to retain one confirmation for genuine branch rewrites. These are **finite synthetic model checks, not a TypeScript refinement proof**. The ledger, content reconciliation, consent persistence, and native transaction models are separate abstractions; their composition has not been proved.

## Reproduce and evidence

Requires a POSIX host, Python 3, Node/npm, and Java 21+. Quint **0.33.0** is lockfile-pinned. Apalache **0.62.1** is checksum-pinned before execution; its JAR supplies TLC.

```sh
python3 scripts/test-check-quint.py
python3 scripts/check-quint.py --timeout 240
# Equivalent compatibility entry point:
scripts/check-model.sh --timeout 240
# Genuine temporal checks (TLC only):
python3 scripts/check-quint.py --only Ledger LedgerDiverged NegLedgerUnfair NativeReplace NativeDelete NativeCreate NativeText NativeHandoff LiveIndependent LiveConflict NegUnfair
# Bounded SMT checks, not temporal verification:
python3 scripts/check-quint.py --backend apalache --only UnknownRewind NegReplay
# Sampling is not model checking:
python3 scripts/check-quint.py --simulate-only --only Core Application
```

The default run typechecks each model, samples up to 10,000 executions of safety cases with seed `0x123456`, and invokes TLC. Temporal cases go directly to TLC. Every negative must violate its specified property; a parse error, timeout, signal, wrong violation class, missing temporal-check evidence, or unexpected exit fails. Apalache/simulation temporal requests are rejected before execution. A sampling miss is not relabeled as a detected bug.

The runner locks each evidence directory, clears selected stale artifacts, marks the invocation incomplete before checking, hashes inputs before execution, and rejects changed inputs. `results.json` records selected cases, full-suite status, properties, bounds, commands, versions, source hashes, timings, exits, and verdicts. Unselected leftover logs are not results of the current invocation. Raw logs are authoritative; simulation ITF traces are labeled separately. See the [TLC summary](../../formal/quint/evidence/tlc/summary.md), [TLC manifest](../../formal/quint/evidence/tlc/results.json), and [Apalache summary](../../formal/quint/evidence/apalache/summary.md).

The current full TLC run completed with **56/56 expected outcomes**: 24 positive passes and 32 detected negative controls. Nine positive and two negative cases check genuine conditional temporal properties; 45 safety cases also produced their expected sampled outcomes. Seven runner regressions and the two selected bounded Apalache checks passed. All 70 model and runner input hashes match both completed manifests. Exact state counts and interpretation are in the [execution record](quint-review.md#current-formal-fix-run).

## Temporal support investigated and exercised

The [pinned builtin documentation](https://github.com/quint-co/quint/blob/v0.33.0/docs/content/docs/builtin.md) defines `always`, `eventually`, and `weakFair(action, variables)`. The [pinned CLI](https://github.com/quint-co/quint/blob/v0.33.0/quint/src/cliCommands.ts) recommends TLC and warns that Apalache temporal support is experimental. Installed `verify --help` exposes `--temporal`; the TLC backend emits `PROPERTY q_temporalProps`. Installed-source excerpts and SHA-256 are in [toolchain evidence](../../formal/quint/evidence/toolchain/temporal-support.txt).

The runner actually invokes these properties through TLC. Fairness is the antecedent of a checked temporal implication, not a finite completion deadline. Ledger, native, and content-progress graphs have **no turn cutoff**. A finite graph contains infinite behaviors; TLC checks those behaviors using fingerprint-based enumeration, not a deductive all-sizes proof. `completed`/`witness` assertions in scenario harnesses remain bounded safety checks and are never described as liveness.

## Ledger contract and temporal obligation

[ledger.qnt](../../formal/quint/ledger.qnt) models two installations, one live publication per installation, immutable candidate/receipt/seal identities, persistence before dispatch, durable acceptance/cancellation settlement, queued late delivery, crashes, restart, outages, branch rewinds, and monotonic first-parent ledger ancestry. Receipt identity is a fixed function of its candidate operation; its first-parent lineage is the saved ledger anchor. Actual Git commit serialization, second-parent parsing, and receipt metadata validation are implementation boundaries, not checked byte encodings. A seal shares that anchor. All responses are treated as unconfirmed; fresh ledger reads decide the result. The validated-ack optimization is omitted. Queued requests eventually receive server service under the stated fairness assumption; request drops and repeated transport retries are not modeled. Lost responses and delayed requests are modeled.

Publication atomically compares both branch parent and ledger anchor, then moves both. A seal compares the same saved anchor and moves only the ledger. `receipt` means accepted; a recorded `seal` means cancelled; the anchor means undecided. Neither errors, absent receipts, nor branch ancestry yields rejection. Receipt and seal cannot both win. Advanced anchors fence delayed old requests permanently within the checked history; receipts remain reachable across branch rewind. Settlement saves the verdict and the new durable anchor together. Accepted intents are consumed and cannot be republished.

Bounds: three total operation identities (installation 0 can retry once; installation 1 has one attempt), two environment faults shared among crash/outage/rewind, and immutable ledger nodes. `quiet` disables future faults and restores network service. Weak fairness of each client and server implies:

```text
always(quiet => eventually(all recorded operations have a final verdict))
```

This is **per-operation settlement**, not eventual publication of every dirty edit under unlimited adverse races. The finite allocation can prevent preparing another attempt after cancellation. The three-round per-sync counter/reschedule transition is represented, but the three-operation domain does not exercise three cancellations for one installation. Backoff timing, unbounded attempts, ledger GC, and full ledger/content/native composition are not verified. The model does not assume that fair service alone makes publication defeat sealing on some future attempt.

`LedgerPublishWins` and `LedgerSealWins` separately exercise both orders, crash/restart before settlement, receipt/seal exclusion, a later operation, branch rewind, and delayed delivery after the old anchor is permanently fenced. Their 16-step witnesses establish scenario coverage; the `Ledger` temporal property is independent of those schedules. `NegLedgerUnfair` supplies the infinite-stuttering negative.

`LedgerDiverged` permits an out-of-contract foreign ledger value. It checks that a client records divergence and stops automatic mutation, and that fair recovery eventually yields a verdict including divergence. It intentionally does not assert ledger ancestry preservation after tampering. Normal safety excludes ledger deletion/rewind, copied installations, and malicious exact receipt substitution. Reviewed re-anchoring, absent-ref initialization races, and duplicate-installation diagnostics remain implementation obligations.

Ledger negative controls: `NegLedgerAbsent` infers cancellation from anchor/absence; `NegLedgerSplit` separates branch and receipt effects; `NegLedgerAnchor` ignores the saved publication anchor; `NegSealAnchor` seals the current value instead of the saved anchor; `NegLedgerJournal` forgets durable identity after a crash; `NegLedgerReplay` prepares another publication for an accepted intent. Each must fail its named invariant.

## Native transaction contract

[nativeTxn.qnt](../../formal/quint/nativeTxn.qnt) models one path and exact abstract hashes: expected E, target N, absent, a partial stage/text write, a newer writer value, and a byte value representing a legitimate prefix. Separate transitions persist the intent, write an incomplete stage, finish/verify the stage, atomically displace the path into a nonexisting hold, verify hold bytes, install with a no-clobber rename, recheck/preserve hold bytes, complete, roll back, or report a conflict. Crashes clear volatile verification and retain completed disk operations. E and N are pinned before the intent.

`NativeReplace`, `NativeDelete`, and `NativeCreate` cover rename transactions. A newer write before displacement is restored or preserved; a recreated destination is never clobbered; a held-file write after verification is rechecked and retained. `NativeText` treats any recovered value other than E/N as interrupted, retaining E/N/current. Prefix resemblance never licenses replacement. Up to two writer/crash events occur; after quiescence and weakly fair worker steps the transaction terminates as applied, changed, or interrupted. This is actual conditional temporal termination, not a claim every interference must end at N.

`NegNativeClobber`, `NegNativeRehash`, and `NegPrefixGuess` respectively break no-clobber installation, discard a changed hold without capture, and overwrite a legitimate prefix as if it were a torn write. They fail exactness or latest-writer preservation.

Assumptions: exact object IDs stand for collision-free hashes; stage/hold are private paths on the same volume; rename is atomic and refuses existing destinations; completed syscalls survive process death; durable recovery capture is atomic at the modeled boundary. Power loss/fsync ordering, external writes through an fd after hold removal, orphan-scan integration, mode bits, multi-path rename/collision handling, real Obsidian TFile/cache behavior, and the native worker's exact journal format are **not proved**. The model tracks the latest injected external write and pinned E/N, not every historical overwrite by an external writer.

## Native issue handoff after independent review

The independent native review `/tmp/github-v2-native-review-r1.md` found that interrupted process bytes could enter ordinary merge/publication and displaced/orphan bytes could remain hidden. That verdict described the implementation before root commit `1b74eab`. The root integration now ingests native issues before acknowledgment, and its reported plugin regression exercises the torn-note and retry paths (254 plugin tests and four legacy server tests passed). That integration evidence addresses the reproduced path; oversized native evidence, a subsequent independent review, and platform crash acceptance remain open.

[nativeHandoff.qnt](../../formal/quint/nativeHandoff.qnt) models the handoff boundary. A durable attempted flag precedes the native effect. Interrupted, displaced, and orphan outputs create native-owned evidence with issue identity, kind, expected bytes, intended next bytes, found bytes, and a hold. Fetch copies that record into volatile memory; a crash clears the fetched copy. Engine ingestion atomically persists a separate complete record before acknowledgment. Acknowledgment disposes the native record, so the post-acknowledgment invariant requires the engine's exact found bytes and other fields. The issue path cannot automatically publish. A later edit does not clear the issue. A reviewed choice reads the engine record, pins its preimage, and applies only against the exact current expected bytes. One independent path can publish while the issue remains unresolved.

The graph has one issue path, one independent path, three issue kinds, four content values (with an unset sentinel), one later edit, and at most two crashes. With weak fairness of the automatic worker after faults stop, the issue is eventually durably ingested and the other path publishes. Human review is not assumed fair for that obligation. `NegTornPublish` collapses an issue into ordinary changed bytes and reaches automatic publication; `NegIssueAck` acknowledges before durable ingestion; `NegIssueBytes` persists a hold but drops the found bytes; `NegIssueEdit` clears a hold on a new edit; `NegAttemptFlag` executes without the durable attempt flag. Each must fail its named safety invariant.

This is a boundary model, not a byte-level native proof: the integer values represent exact bytes, issue creation/recovery capture is abstract, issue enumeration and durable engine saves are assumed atomic, and only one issue instance is allocated. It does not prove the engine's actual scan/merge/candidate construction excludes held paths, compose the issue model with native syscalls or ledger publication, or validate storage retention and orphan discovery on disk. The root's torn-note regression is implementation evidence for the reproduced path; oversized evidence and platform acceptance remain outside this model.

## Content-version consent and content reconciliation

[durability.qnt](../../formal/quint/durability.qnt) separates capture/pinning, volatile UI choice, durable approval, operation preparation, guarded replacement, durable acknowledgement/capture, checkpoint, and restart. Consent is exact local/remote content; a byte-identical remote head change and an event/self-echo do not revoke it. Expected preimages are retained before a durable choice is consumed. The old durable observation-incarnation marker is gone. A crash clears volatile UI state, not an already persisted content choice. `ConsentVersions` checks identical bytes at a new head, event echoes around multiple paths, restart, and completion without renewed consent. It is a 14-step safety witness.

`NegVolatileObservation` keeps its historical test name but now removes **preimage pinning**, not an incarnation marker. `NegApprovalScope` ignores changed content. `NegNativeGuard` bypasses the exact expected-byte comparison; `NegAccountCapture` acknowledges a newer carried value before capturing it. This graph has two paths, initial local value 1, remote value 3, one later save of 2, and one remote-head advance; TLC explores it without a turn cutoff.

[vaultSync.qnt](../../formal/quint/vaultSync.qnt) retains the content reconciliation obligations migrated from TLA. It has two devices/files, byte values `0..3`, three saves, and five noninitial commit slots. Its publication result abstracts a **validated receipt or seal**, rather than claiming an API error establishes rejection. Its receipt status confirms acceptance even after branch rewind; `UnknownRewind` checks that behavior. `Adoption` represents the parent's one explicit confirmation for rewritten history, retaining recovery and carried origins before a fresh conflict review. It is an atomic abstraction, not a native transaction proof.

The [case harness](../../formal/quint/cases.qnt) checks an arbitrary five-transition Core prefix and focused schedules of 5–21 transitions. `--max-steps` does not bound TLC; the Core/scenario turn counters do. Apalache only checks its explicit transition bound. [progress.qnt](../../formal/quint/progress.qnt) checks fair quiescent content convergence with at most two saves, reliable terminal publication outcomes, no external Git publication/revert, no response loss/crash/rewind, and either disjoint or conflicting files. User conflict decisions are fair client actions. It also checks allocation slack and strict current-ancestry provenance. These content results do not prove a refinement from the lower-level ledger network model.

## Old obligations and intentionally changed guarantees

| Old obligation/control | Quint check and executed domain | Difference or remaining gap |
|---|---|---|
| `TypeOK` | Quint static types plus `typeOK` in protocol safety | Fixed keys and identities; no arbitrary paths. |
| `CommitBoundSlack` | `nextCommit <= 5` in every progress harness | No slack claim in Core/general safety; its five-slot guard can bind. |
| `CheckpointPublished` | Current ancestry assertion in progress; `NegOptimistic` violates accepted-checkpoint safety | Rewind-capable safety uses accepted-history status, as the old rewind variant did. |
| `CheckpointEverPublished` | `checkpointPublished` in protocol `safe` | Checks accepted status; transiently removed checkpoints are allowed around owner rewind. |
| `LiveIsCommittedOrOwn`, `...Ever` | `liveCommittedOrOwn` in `safe` | Per-file ever-published provenance in rewind-capable safety; strict per-file current-ancestry provenance additionally checked in progress. |
| `BaseCoherent` | Structural `baseCoherent`; `wholeCheckpoint`; `NegCheckpoint` | The primitive remains atomic at the protocol level; the separate durability model splits persistence boundaries. |
| `CapturedEditsPreserved`, `...Ever` | `latestSavePreserved`, `carriedCaptured`; `NegGuard`, `NegCapture`, `NegDiscardRemote`; durability preservation | Ever-publication is permitted after rewind. Recovery is not pruned; only latest saves are promised. |
| `NoBlindOverwrite` | Path-scoped durable `seen`, `noBlindOverwrite`, `scopedDecisions`; `NegSilentDraft`, `NegStaleDecision` | Content-version and base scope; a byte-identical new head does not revoke consent. No repo re-enrollment. |
| `NoUnauthoredChange` | Own-authored values and `noUnauthoredChange`; `NegUnauthored` reconstructs unjournaled half-apply, crash, remote revert, then false local publication | Abstract immutable bytes and single-file save ownership; no executable refinement. |
| `NoReplay` | Structural introduced-value uniqueness over device commits in current ancestry; `NegReplayUnique` | One live operation per device; all retries reuse identities. `NegLedgerReplay` checks a consumed draft cannot become a second publication. |
| `NoResurrection` | Removed commits disjoint from current ancestry; exact-head comparison; `ExactPublish`, `NegFastForward` | Ledger graph separately checks atomic branch-plus-ledger CAS, permanent fences, and receipt retention across rewinds. |
| `NoUncertainRetry` | `unknownHeld`; `UnknownRewind`, `NegReplay`, `NegLedgerAbsent` | Validated receipt/seal settlement supersedes permanent hold; receipt absence remains undecided. |
| `HeldHasCandidates` | `candidateRetained` while awaiting settlement; durable ledger journal and one active operation | Permanent unknown-publication hold is retired; out-of-contract divergence still pauses. |
| `NeverResolving` / `Independent` | `independentNoConflict` in schedule and fair unrestricted `LiveIndependent` | Two events versus the old three-event environment; stronger temporal coverage than the original Quint fixed schedule, smaller event budget than old TLA. |
| `Convergence` / `Liveness` | Actual TLC temporal checks in `LiveConflict` and `LiveIndependent` | Two editor saves, reliable responses, no external Git edits or crashes/rewind; the retired no-rewind retry/sibling theorem is not reproduced under the selected ledger contract; per-operation settlement is checked separately in `Ledger`. |
| `Neg_UnfairLiveness` | `NegUnfair`, actual temporal counterexample | A finite witness is not substituted. |
| `Neg_ForgetSiblings` | Superseded by one live operation and immutable identities; `NegReplay`, `NegReplayUnique`, and ledger race controls cover retry/replay hazards | No concurrently live sibling candidates are permitted. The ledger graph includes delayed old attempts during a later operation. |
| `Neg_NoApplyJournal` | `NegJournal` and structural `NegUnauthored` | Separate ordering and end-to-end provenance controls. |
| `Neg_DiscardOnUseGitHub` | `UseRemote` and `NegDiscardRemote` | Recovery bytes retained before remote choice replaces local content. |
| `Probe_OptimisticCheckpoint_Loss` | `ProbeOptimisticLoss` checks latest-save preservation despite optimistic checkpoint mutation | Focused response-loss/revert schedule only; it is not permission for optimistic checkpointing. |
| Explicit branch `Adopt` confirmation | `Adoption` retains recovery and carried origin, then requires conflict review | Baseline abstract adoption is atomic; native crash-safe adoption is not modeled. |
| `Rewind` safety suite | Core prefix plus `UnknownRewind`, `ExactPublish`, `Adoption`, and ledger graphs | No equally deep unrestricted replacement; current bounds are below. |
| `Neg_FastForwardRef`, `Neg_NoApplyGuard`, `Neg_OptimisticCheckpoint`, `Neg_PartialCheckpoint` | `NegFastForward`, `NegGuard`, `NegOptimistic`, `NegCheckpoint` respectively | Named safety counterexamples, not progress checks. |
| `Neg_ReplayOnUnknown`, `Neg_RewindUnknown`, `Neg_SilentNewDraft`, `Neg_StaleResolution` | `NegReplay`, `NegReplayUnique`, `NegSilentDraft`, `NegStaleDecision` | Rewind acceptance now comes from the receipt; old permanent-hold behavior is intentionally retired. |
| `Core_Deep` | No equal-size replacement claim | Old four-event unrestricted exploration is not reproduced; new Core cuts off at five transitions. Progress has two-event arbitrary interleavings. |


Retired guarantees/policies: permanent hold on ordinary uncertain publication is replaced by same-anchor sealing and automatic settlement; event/incarnation-based consent revocation is replaced by exact content versions; ordinary single-path creation/deletion needs no standing consent hold; byte-identical recreation deliberately remains the same version. Old no-replay, captured-byte preservation, exact publication comparison, and whole-checkpoint obligations remain. No unsafe absence-to-nonpublication rule is inherited.

The original unrestricted deep TLA search is not claimed as reproduced: Core stops after five transitions, content progress has two saves, ledger has three operations/two faults, and native transactions have one path/two interference events, and issue handoff has one issue/one edit/two crashes. Arbitrary operation counts, arbitrary files/devices, bulk-deletion thresholds, migration `/2 → /3`, and the final composed implementation are quantified remaining gaps, not silently skipped checks.

## Integration

Integration update after the original formal run: root commit `1b74eab` wires native issue ingestion and includes the plugin-level torn-note regression. That regression holds the truncated note for a decision, leaves its GitHub version unchanged, permits unrelated edits to publish, and restores full bytes after an explicit choice. The root reported 254 passing plugin tests and four passing legacy server tests. Oversized native evidence, subsequent independent review, and actual platform crash acceptance remain open.

The parent supplied `github-ledger-probe.json` with six live API successes. This worker read the result and probe source but did not rerun network experiments. That supports the selected API assumptions; it does not establish engine correctness or fine-grained PAT acceptance.

The original native review's FAIL verdict is historical. Root commit `1b74eab` and its reported 254 plugin plus four server test results address the reproduced torn-note path. Oversized native evidence, a new independent native review, and native platform crash acceptance are still pending. These Quint checks do not establish TypeScript refinement or composed full-sync safety. Legacy `--quick`/`--deep` flags are intentionally unsupported.
