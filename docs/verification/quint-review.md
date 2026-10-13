# Independent Quint review — 2026-10-13

The checked finite protocol model is accepted within its stated bounds. One actionable runner bug remains: timeout/error exits can be misclassified as successful negative controls. It did not affect this review's actual checker results, which exited normally. This is not implementation approval, an implementation refinement proof, a filesystem durability proof, or a Quint liveness result.

Review was confined to the supplied scratch tree. No agents, commits, core edits, real vaults, or remote repositories were used. The only authored project file is this report; the authorized runner regenerated its evidence. Temporary mutation/reproduction files were kept under `/tmp`. Existing uncommitted engine changes belong to separate work and are not validated by these formal results.

## Executed checks and provenance

Actually ran, each with the runner's default 180-second per-command timeout:

```sh
python3 scripts/check-quint.py
python3 scripts/check-quint.py --backend=apalache --only UnknownRewind NegReplay
```

Both runner invocations exited 0. The default run completed 14 typechecks, 1,000 sampled executions for each of seven positive cases, and all 14 TLC checks: seven passes and seven expected invariant violations. Each of the six focused positive simulations reported exactly `witness was witnessed in 1000 trace(s) out of 1000 explored`. Negative simulations stopped on their counterexamples, rather than claiming 1,000 passing samples. Positive checker exits were 0; negative checker exits were 1. No reviewed checker result was a timeout.

Default TLC positive distinct-state counts were Core **26,649**, Independent **41**, ResponseLoss **15**, UnknownRewind **8**, ExactPublish **7**, Application **10**, and StaleDecision **13**. Core generated 53,198 states. TLC search depth includes harness/terminal states and should not be substituted for the protocol transition bound.

The selected Apalache rerun typechecked both modules, sampled UnknownRewind 1,000 times with 1,000 witnesses, and obtained UnknownRewind PASS and NegReplay VIOLATION at six transitions. Verification took 11.22 and 10.31 seconds respectively. Inspected installed Quint code: its CLI defaults `random-transitions` to false and maps that option to Apalache `search.simulation`; these were symbolic bounded checks.

Evidence: [TLC summary](../../formal/quint/evidence/tlc/summary.md), [TLC metadata](../../formal/quint/evidence/tlc/results.json), [Apalache summary](../../formal/quint/evidence/apalache/summary.md), and [Apalache metadata](../../formal/quint/evidence/apalache/results.json). Metadata timestamps are `2026-10-13T13:06:52Z` and `2026-10-13T13:07:37Z` respectively. Raw per-case verification logs are the verdict authority.

The author's earlier Apalache metadata recorded two positive checks (ResponseLoss and UnknownRewind) and two controls (NegReplay and NegCapture), all expected results. I inspected that metadata before rerunning; I independently reran only the requested UnknownRewind/NegReplay pair. The runner overwrites backend-wide `results.json` and `summary.md` on a selected run; the current Apalache summary therefore describes this two-case review run, while ResponseLoss/NegCapture raw logs remain from the author's run. The earlier metadata SHA-256 was `8a15f125c90995906ff9d8f5934bc82db48f3e809598eb7ec2be8c7d5a5be9ca` (temporary copy `/tmp/quint-review-prior-apalache-results.json`). Do not describe all four Apalache checks as independently rerun here.

## Finding: reject timeout/error exits before recognizing negative controls (P2)

Location: [runner](../../scripts/check-quint.py), lines 176 and 200, with timeout handling at lines 51–58.

Both classifiers accept **any nonzero exit** when the collected output contains the expected diagnostic. `run()` returns exit 124 on timeout but retains preceding output. Consequently, output containing `Invariant violated` or (for verification) `found a counterexample` followed by a hang is recorded as `VIOLATION`, `valid: true`, even after `RUNNER TIMEOUT: no verification verdict.` is appended. Other abnormal exits with a prior diagnostic have the same classification problem. This contradicts the document's explicit claim that timeouts and backend errors fail the check.

I reproduced this using the real runner's process-group timeout implementation and a harmless local subprocess; no model or runner file was changed:

```python
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("r", "scripts/check-quint.py")
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
code, output = r.run(
    [sys.executable, "-u", "-c",
     'import time; print("Invariant violated"); time.sleep(5)'],
    dict(os.environ), timeout=1)
observed = ("PASS" if code == 0 and "[ok]" in output else
            "VIOLATION" if code != 0 and
            ("Invariant violated" in output or "found a counterexample" in output)
            else "ERROR")
print(code, repr(output), observed, observed == "VIOLATION")
```

Observed: exit `124`, output `'Invariant violated\n\nRUNNER TIMEOUT: no verification verdict.\n'`, classification `VIOLATION`, accepted-control boolean `True`. This is a classification reproduction, not a claim that a checker hung during the actual suite.

Required correction: reject timeout, signal, and other unexpected failure exits before parsing verdict markers; require the supported normal counterexample exit (1 for these pinned runs) and its diagnostic. Apply this to both simulation and verification. Add a focused check using a diagnostic-then-timeout child so this failure cannot recur. The current suite's normal exit-1 counterexamples remain valid evidence; the runner's general fail-closed claim is not yet valid. Per the review's ownership boundary, I did not edit the runner.

## Abstraction, ghosts, negative controls, and completion

Core permits arbitrary modeled actions for **four transitions only**. Focused Independent is **21 transitions** in its specified schedule, exploring either first publication winner. Other focused bounds are ResponseLoss 13, UnknownRewind 6, ExactPublish 5, Application 8, and StaleDecision 7. Those longer schedules do not turn Core into unrestricted exploration at those depths. There are two devices, two fixed files, values 0–3, at most three editor saves, and six commit IDs including the initial object. Allocation guards and schedule restrictions are part of the checked specification.

The monotone `failures` set records transition obligations rather than an independent implementation monitor. `exactHead`, `journalFirst`, `newerPreserved`, `wholeCheckpoint`, and `scopedDecisions` test event conditions against pre/post transition data. `unknownHeld` is weaker: it is the absence of the flag explicitly emitted by the replay mutation, not a structural theorem that every possible unknown-outcome transition preserves every candidate field. The positive UnknownRewind witness independently requires phase `held` and no extra allocation; source inspection confirms the normal hold updates only phase/event. These properties are useful checks of the supplied action definitions, not automatic guarantees against arbitrary future transition edits.

I inspected control endpoints in the raw TLC logs and compact simulation traces:

- NegReplay, transition 6: the accepted-then-rewound candidate is replaced with candidate 2; `unknown-replayed` is set. The selected Apalache log independently supplies a counterexample.
- NegFastForward, transition 5: head 0 accepts candidate 2 whose parent was commit 1, setting `not-exact-head` and resurrecting removed ancestry.
- NegJournal, transition 4: file 1 is replaced with `journal=false`, setting `replacement-before-journal`.
- NegGuard, transition 7: the newer local value 1 is overwritten with 3, setting `newer-draft-overwritten`.
- NegCapture, transition 7: value 1 remains live and drafted with carry origin 0, but recovery contains only 0. `carriedCaptured` fails structurally; this control does not depend on a failure flag.
- NegCheckpoint, transition 4: checkpoint becomes 2 with only file 1 accounted, setting `partial-checkpoint`. This mutation does not also disable the journal.
- NegStaleDecision, transition 6: an old decision constructs a new candidate after reviewed bytes change, setting `stale-decision-used`. The positive schedule includes both the local-change and remote-change alternatives.

Each control checks its selected property, not uniqueness of that violation among all safety properties. The replay control catches preparation of a replay, before proving any second publication actually reaches the remote head. The no-journal control fails at the first replacement, before the scheduled crash. Neither endpoint should be described as a full post-crash data-loss demonstration.

`completed` is `(turn < completionTurn) or witness`; it catches a wrong final state but cannot alone establish that a final state is reached. Quint's installed TLC adapter passes `-deadlock` (`dist/src/tlc.js:127`), disabling deadlock errors. The runner supplements the invariant with all-sampled-traces witness checking. That is an explicit sampled nonvacuity check, not exhaustive deadlock freedom or a temporal theorem.

I tested that distinction in `/tmp/quint-review-completion` using copies of the same model. Replacing Independent's turn-20 `finish` with `stutter` advanced to an incomplete final state: simulation exited 1 with `Invariant violated`. Replacing that action with an already-accounted `applyFile(0, 0)` disabled the last transition: the simulator exited 0 but reported zero witnesses out of 1,000, which the runner's nonvacuity condition rejects. The real focused runs all produced 1,000/1,000 witnesses. Inspection of both Independent winner branches and the two StaleDecision alternatives found no disabled terminal path in these small schedules. The declared finite results stand; they do not promise general eventual completion.

## Implementation correspondence and retained limits

The important divergence is explicit in the inspected sources. Quint `receive` returns a definitively rejected request to `idle` (`vaultSync.qnt:126–135`); Independent then rereads/merges and retries. The inspected engine calls `#settle` for every non-accepted publication result (`session.ts:559–566`), and `#settle` holds any candidate not found in current ancestry (`session.ts:614–622`). Its loser therefore does not implement this modeled automatic retry. Independent demonstrates bounded convergence of the modeled definite-rejection protocol, not of the current core. The document already disclaims refinement; adding this particular distinction to its mapping would make that boundary clearer, but it is not a newly discovered implementation blocker in this review.

Durability is deliberately atomic: `applyFile` groups compare/replace, capture/carry bookkeeping, and path accounting in one action. With a journal, `crash` preserves that state. The reviewed model cannot distinguish intermediate filesystem writes, failed flushes, journal persistence ordering within the action, or actual restart behavior. `finish` also does not implement the engine's final recapture loop; the Application schedule places its newer save before the remaining file's apply. Its result does not establish preservation/carry recapture for every save arriving after a path has already been accounted. The engine's observed recapture and carry-origin changes are separate uncommitted implementation work, not evidence supplied by Quint.

Preservation intentionally permits latest-save bytes in live/draft/recovery or **ever-published** values, including removed history; recovery is never pruned. This is byte-preservation in the declared abstraction, not per-path backup/recoverability of every historical save. Decision checks compare modeled bytes with fixed repository/base/path scope; equal-byte generation changes and full approval-token identity are excluded. These declared limits are not additional findings against bounded acceptance.

No Quint temporal liveness was checked. `eventuallyConverged` is defined but never passed to the verifier. Holds have no modeled automatic recovery; arbitrary stuttering is allowed. The canonical [formal/REVIEW.md](../../formal/REVIEW.md) records separate TLA+ safety/liveness work, including fairness, quiescence, no-rewind assumptions, and the unfair-liveness control. I read that review but did not rerun its suite or transfer its liveness theorem to Quint. Keep the canonical TLA+ artifacts; Quint's reference snapshot is an archive, not replacement coverage.

## Pinned inputs

Quint **0.33.0**, Apalache **0.62.1**, Node **v23.6.0**, OpenJDK **23.0.2** on Darwin arm64. TLC was the implementation bundled in the checksum-verified Apalache JAR; logs identify it as `TLC2 Version 2026.10.13.130534`. Its fingerprinting is finite probabilistic exploration, not a mathematical universal proof. Simulation seed was `0x123456`; TLC selected its own logged seeds/fingerprint polynomials. All model, harness, wrapper, runner, lockfile, config, and primary-document hashes below were unchanged from review start through completion.

SHA-256 manifest (paths relative to this scratch root):

```text
573c85370263bf5261e35d8e7e3090ff16f9667efc31ee4f841ddbe728173179  docs/verification/quint.md
ca1cdb5c852e6b1fa7eb099faf2d61cd466e6919b879c42f29eb5995d684f167  formal/REVIEW.md
880c0b2b72354816f12e9a9755829f2907071e9a181ffea1937954c23d54739d  formal/quint/.tools/apalache-dist-0.62.1/apalache/lib/apalache.jar
b64ce066504ed0b9e713f58a1cef71a663bd681aa284ee3307a8409acd5bbc10  formal/quint/cases.qnt
b3fad847b0ee6cd68411123f468ac1413ab6cf7baa1246b26329e1cac094da8f  formal/quint/evidence/apalache/results.json
ff58b687c2c08481d88a5aa5f11ce921d6282757b547c64036331cebfa565c7d  formal/quint/evidence/tlc/results.json
6df5d9daa70b567a655addc7cb6ebb70ff99e9804a33c3d010671e569138f1cd  formal/quint/models/Application.qnt
65a17692152dc36e2de62ce88986dc715a768a9742fdb6b51d9edbb66ab63460  formal/quint/models/Core.qnt
ce047f095bae9c0940e1c33855728ed931103ff898368569899a0e1c921c3340  formal/quint/models/ExactPublish.qnt
4cafa5aa624a3414765ae30a17aaada3ff1281466c8435b04d6fd9e3abe8e49b  formal/quint/models/Independent.qnt
d222d6d3153f5a1ce14d7f01913b1f4d1d771d1c0a22b4bca150d18eb278ff2c  formal/quint/models/NegCapture.qnt
f979baf098808dce098f8010716e58e6b975294240c9efe1ecfba317c25d7eb9  formal/quint/models/NegCheckpoint.qnt
f18ab02c819cd5cd76c2357a94e45b539bfc00843d03e48281992482fe3e561b  formal/quint/models/NegFastForward.qnt
af18bc12eda4490aaf4479810cd93ad29012125fe577b5c6b08447b109f69c19  formal/quint/models/NegGuard.qnt
ade2447869d62e69d8b3de9ab69449bfc19ae4f270bb4b27fb2d9802e8304856  formal/quint/models/NegJournal.qnt
c883e5a0e07623c9b51e53eba7971858866f7e5246b5aacdd18b8bc94d7aa086  formal/quint/models/NegReplay.qnt
0cfa7f1ddba4a1577a1a5b1490aea5f452f6cf353c6c4ea21ccdecc48df571fe  formal/quint/models/NegStaleDecision.qnt
1bc283256d779f746afb44c99ff90c20ba871e424bf7835fff379d5f7408f7f7  formal/quint/models/ResponseLoss.qnt
61b9e69fb2b2509f18548f20eaf6c4ab031e17e1fb5d13599a46010d27a6b6c0  formal/quint/models/StaleDecision.qnt
27d3e5e714be14ba8ddf53785717bd15223aeb0fbc7aeac65aa67463cacef6ac  formal/quint/models/UnknownRewind.qnt
21afe5a0c91896b3f5c3b4af610e11275280c065fe9dda18e1b0dc2ea0576f3a  formal/quint/node_modules/@informalsystems/quint/dist/src/apalache.js
952a50a28932282528b5c9b86ac5542405d85da4f80876aabe8cb8c7d5a6d0e8  formal/quint/node_modules/@informalsystems/quint/dist/src/cli.js
30d69d445952c1ff928923155b2caf6a1955243efe21420c467a0fd5bb0179ec  formal/quint/node_modules/@informalsystems/quint/dist/src/tlc.js
1e6424ee53efce1575262cb1b8f6d1f878bbecabe6d442df98dcc512879c21f2  formal/quint/package-lock.json
cef7b24458a17299872ef7da84233ec954bf19e4653a9173fa3aefed93b9773e  formal/quint/tlc-config.json
e3c93ab5a2dcb673278f26a9405d888cc74190fa9c521d7cac5ffcb563ee28d1  formal/quint/vaultSync.qnt
ea7360daaf01123e45cd2f13bbe2bfc7bb434bdf2a73ed0d78ea8b2b593c910b  plugin/src/git-sync/session.ts
20561cd92536cc723ec5cacb7ac746852460403c278c26cf98252b7d52b4e530  scripts/check-quint.py
```

## Runner correction and independent follow-up

The parent replaced both verdict expressions with a classifier that accepts only exit 0 for a successful check and exit 1 with the expected diagnostic for a counterexample. Timeout 124, signals and other error exits now produce `ERROR`. `scripts/test-check-quint.py` exercises the actual diagnostic-then-timeout subprocess as well as normal and abnormal exits. The evidence-log ignore rule was also corrected so raw checker logs are included in Git while downloaded tools and scratch output remain excluded.

Independent task `github-v1-quint-review-r2` (Sol) reran all three runner tests and the original timeout reproduction, checked a 56-case classifier matrix, both production call sites, and Git ignore behavior. It reported scoped PASS with no new findings. The parent then completed the full default suite with all seven positive TLC checks and all seven expected negative controls. The model itself was unchanged. Earlier hashes above remain the provenance of the first review; regenerated metadata records the corrected runner's hash.
