# Independent Quint scope review R1

Changes requested: two P2 findings in evidence handling and independent-fence coverage. The committed checks themselves reproduce: **2 positive TLC passes and 9 invariant counterexamples**. These are target contracts; this review makes no implementation-refinement or release-approval claim.

Reviewed commit: `20380013d7c665ed16fd083cc0cf48bb9d9ded06` (worker `7e7191a` scope extension). Root was read-only. Snapshot, additional Quint probes, logs and scripts are under `/tmp/github-v2-quint-scope-review-r1`. Existing pinned `node_modules` and `.tools` were reused; Java selected with `/usr/libexec/java_home -v '21+'` was OpenJDK 23.0.2. No authored TLA, subagents, device, external service or real vault was used. Model-checker servers used loopback only.

## Findings

### Q1 — P2: failed invocations leave stale successful evidence

Locations: `formal/quint/check-scope.py:68–90`, `:95–101`.

The runner checks tool existence/version, JAR hash and Java before invalidating the old manifest. Starting with the independently reproduced PASS evidence, run the scratch checker with `QUINT_BIN` pointing to a nonexistent executable. It exits 1, but `results.json` is byte-for-byte unchanged with `status: PASS`, and `summary.md` still says PASS. This is a stale evidence problem, **not** a false-success process exit.

A second fault probe makes typechecking fail. The new manifest correctly says FAIL, but the corresponding old `ScopeState.verify.log` survives byte-for-byte and still contains the previous `[ok]` result. The failure branch skips verification without clearing its old artifact. An interrupted invocation likewise need not refresh the old summary.

Repro: `python3 /tmp/github-v2-quint-scope-review-r1/probe-runner.py`; inspect `runner-probes.json`, fields `preflightFailure` and `typecheckFailure`. The preflight uses a real subprocess; the typecheck failure is injected at the runner's `run` boundary. Root evidence is never used as an output directory.

Requested change: give each invocation an explicit incomplete/failure state before fallible preflight, invalidate the summary consistently, and clear or isolate selected case artifacts before typechecking. Preserve historical evidence explicitly if desired, rather than leaving it presented as the output of the failed invocation. The new runner has no evidence-directory lock either; concurrent invocations should be isolated or serialized before making an invocation-wide freshness guarantee.

### Q2 — P2 verification gap: the repository and installation fences are indistinguishable

Locations: `formal/quint/scopeState.qnt:73–75`, `:102–110`; `formal/quint/models/NegScopeFence.qnt:2`.

`changeFence` always sets both `repo` and `installation` false together. They begin equal and no transition separates them. Reviews copy both together. Thus the model cannot distinguish an implementation that checks only one fence from the specified two-fence gate.

Repro: scratch mutants `DropRepo` and `DropInstallation` remove only the corresponding apply guard, leaving the safety predicate and bad-fence observation intact. **Both pass safety and temporal checks with exactly the original 37,281 generated / 8,204 distinct states.** `NegScopeFence` only removes the entire combined guard; its counterexample does not show sensitivity to either missing fence independently.

To confirm the cause, `SplitFencesPositive` changes the environment action to invalidate either fence independently. The intact model passes. `SplitFencesNoRepo` and `SplitFencesNoInstallation` each produce an invariant counterexample. All are Quint source probes, verified with the same pinned TLC backend, under `probes/`.

Requested change: let repository identity and installation binding change independently and add focused controls for each guard. Alternatively, narrow the claim to a single combined validity flag, but that would not establish the requested independent identity/ledger fences.

## Additional bound that must remain explicit

The remote version is fixed at `1` throughout the original model. The checkpoint changes only in `receive`, before a review can exist (`review` requires `deferred`). Consequently, removing both `s.remote == s.review.remote` and `s.checkpoint == s.review.checkpoint` from the apply guard also passes with the original graph counts (`DropRemoteCheckpoint`). `NegScopeVersion` removes the whole guard expression, including unknown/conflict/fence protection; its committed trace witnesses a changed **local** observation, not a changed remote version or checkpoint.

This is consistent with the single-remote-addition bound, but the phrases “exact local/remote versions and checkpoint” and “exact version guard” must not be read as evidence that all three freshness dimensions are exercised. A scratch action allowing one post-review remote/checkpoint advance yields `ChangingRemotePositive: PASS` and `ChangingRemoteNoGuard: VIOLATION`. Expand the environment/controls if remote/checkpoint staleness is intended to be verified here; otherwise document that those values remain fixed after review. This is a coverage limit, not a discovered production defect.

## Independently verified results

The unmodified commit snapshot was rerun with:

```sh
JAVA_HOME="$(/usr/libexec/java_home -v '21+')" \
  python3 /tmp/github-v2-quint-scope-review-r1/snapshot/formal/quint/check-scope.py
```

- `ScopeState`: safety and conditional temporal PASS; **37,281 generated, 8,204 distinct, depth 15**.
- `ScopeHandoff`: safety and conditional temporal PASS; **54 generated, 20 distinct, depth 7**.
- All nine supplied `NegScope*` cases: expected `q_inv` invariant violation, exit 1; none was credited for a timeout, deadlock or unrelated failure.
- All **16** scope-manifest input hashes match the reviewed files and the independent-run manifest. For all 11 committed cases, raw log exits, final counts, depths and seeds match their manifest entries. Positive complete-graph counts reproduce exactly. Some negative-prefix counts differ between runs with two workers and fresh seeds; their committed manifest counts accurately describe the committed logs and are not complete-graph sizes.
- The old evidence has **56 TLC results plus 45 simulations**, and **2 Apalache results plus 2 simulations**. All **70** source hashes in each historical manifest still match. The extension commit changes no old evidence path. All **261** old TLC/Apalache evidence files retain their before-review hashes; those suites were not rerun or overwritten.
- The original runner's **7/7** regressions pass from scratch. They import `scripts/check-quint.py`, so they are not regression tests for the new `check-scope.py`.
- Eleven direct probes of the new verdict classifier correctly distinguish normal invariant violations from wrong invariant names, deadlock, temporal failure, assertion failure, backend failure, UNKNOWN, incomplete success markers, absent temporal evidence, timeout and killed-process output. A replay probe changing an input during execution correctly yields FAIL with `inputsUnchanged: false`.

Audit details: `evidence-audit.json`; independent scope logs and manifest: `snapshot/formal/quint/evidence/scope-tlc/`; runner probes: `runner-probes.json`.

## Nonvacuity and transition-to-claim fit

Seven independent reachability probes check the negation of a desired state as an invariant. All seven obtain actual TLC counterexamples, witnessing:

1. Successful reviewed configuration application.
2. Unknown local content while configuration remains deferred.
3. A CAS race with the original absent origin retained.
4. Quiescent, consented hidden publication still pending.
5. Quiescent deferred local conflict offer still pending.
6. Quiescent recovered handoff acknowledgment still pending.
7. Acknowledgment after durable replacement ingestion and supersession.

Thus the positive models are not globally frozen and the temporal antecedents have reachable pending work. Removing the conflict-before-apply guard independently produces a **temporal** counterexample (`DropConflictGuard.log`): application consumes the deferred state without ever offering the promised conflict. The probe script's generic classifier labels this ERROR because it only recognizes invariant counterexamples; the raw TLC log explicitly reports `Temporal property q_temporalProps was violated.` This probe is not part of the nine required safety-negative outcomes.

Within the stated finite abstraction:

- Unknown `-2` and absent `-1` are distinct. Review cannot read unknown content; guarded apply cannot overwrite it. Automatic configuration publication is disabled by construction in the positive model. There is no scanner to establish that a real missing observation was classified correctly.
- CAS rejection invalidates the saved review and preserves the absent origin. `NegScopeOrigin` exercises that path. All origins start absent; existing-byte origins and longer merge histories are outside this extension.
- Hidden consent is an exact equality to the abstract local byte version, with a possible later local change. Parent, head and local scope can each independently become false. Their semantics are validated-inclusion assumptions, not pattern parsing, names, modes, inventory or upload behavior.
- Direct reviewed application is a separate action from receive/publication. A changed local configuration requires a conflict offer. The model proves no eventual direct application or ability to refresh every stale review; its progress claim is narrower.
- Handoff separates recovery, neighbor isolation, replacement save, old-authority supersession and acknowledgment. Crash/restart preserves all modeled records; atomic durable saves and fixed exact issue identities are assumptions. Acknowledgment before both saves and neighbor-induced replacement loss are detected. There is no modeled partial disk write, replacement-byte mutation, second issue identity, retained-byte cleanup or host recovery parser.
- Weak fairness applies to worker actions after a `quiet` state prevents further modeled disturbance. It is neither a bounded deadline nor a guarantee through perpetual edits/crashes. The factorized modules do not prove their composition with each other or with existing ledger/native models.

## Runtime boundary and reproduction

Read `/tmp/github-v2-engine-scope-r3-port.md` and `/tmp/github-v2-native-scope-review-r1.md` for the implementation context. Root commit `46aa75e` supplies engine fixes, but no runtime implementation was tested in this review. These models do **not** close native **N1** (exported nested `.gitignore`), **N2** (late policy-upgrade review gate), or pre-existing **B1** (eligible disk file omitted from host index becoming a deletion). N1 needs name/pattern behavior, N2 needs the upgrade commit boundary, and B1 needs the capture/index classification boundary; none is represented here. Nor do the models establish the correctness of the engine fixes just because they implement analogous target rules.

To reproduce the additional model probes:

```sh
python3 /tmp/github-v2-quint-scope-review-r1/probe-models.py
python3 /tmp/github-v2-quint-scope-review-r1/probe-independent-guards.py
python3 /tmp/github-v2-quint-scope-review-r1/probe-runner.py
python3 /tmp/github-v2-quint-scope-review-r1/audit-evidence.py
```

The review leaves the root source, models, docs and evidence untouched. All intentional model mutations are disposable Quint files under the review scratch directory; no second authored TLA specification was introduced.
