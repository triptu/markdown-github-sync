# Readable Quint checks for GitHub-authoritative vault sync

The Quint model checks a synthetic protocol, not the TypeScript implementation or a real vault. It uses two devices, two files, abstract file contents `0..3`, and commit IDs `0..5`. Every run starts with both devices at the initial commit. There are no credentials, vault paths, or GitHub network requests in the model.

Read [vaultSync.qnt](../../formal/quint/vaultSync.qnt) for protocol actions and safety properties, and [cases.qnt](../../formal/quint/cases.qnt) for the small adversarial schedules. Per-case modules in `formal/quint/models/` instantiate the same protocol with its safeguards enabled or one deliberate mutation.

## Reproduce

Prerequisites: Python 3, Node >=18/npm, and a JDK >=21. Quint is pinned to **0.33.0** by the local package and lockfile. Apalache is pinned to **0.62.1**; the runner validates its JAR SHA-256 before executing it. The supported TLC backend is the TLC bundled in that same pinned JAR. The actual Node/Java versions, input hashes, complete commands, exit codes, timings, and results are recorded in `results.json`.

```sh
# Default: typecheck, 1,000 sampled runs, then finite checking with TLC.
python3 scripts/check-quint.py

# Actual bounded SMT checks, with both a positive and a broken model.
python3 scripts/check-quint.py --backend=apalache --only UnknownRewind NegReplay

# Sampled execution only; this does not establish a formal result.
python3 scripts/check-quint.py --simulate-only

# Any selected case can use the Apalache backend; the timeout is a failure,
# never interpreted as a successful verification.
python3 scripts/check-quint.py --backend=apalache --only Independent --timeout=180
```

On first use the runner installs the locked npm dependencies and downloads the pinned Apalache distribution into `formal/quint/.tools/`. It selects an installed compatible JDK on macOS, or honors a compatible `JAVA_HOME`. It uses an unused loopback port instead of connecting to another thread's checker. Downloads, checker scratch files, and npm dependencies are ignored. Reviewable evidence is saved under `formal/quint/evidence/{tlc,apalache,simulation}/`.

The official [Quint repository](https://github.com/quint-co/quint), [getting-started guide](https://quint.sh/docs/getting-started), and [model-checker guide](https://quint.sh/docs/model-checkers) distinguish simulation from model checking. The installed CLI's `verify --help` documents both supported backends. **TLC does not honor `--max-steps` as a depth bound**: our harness bounds its own turn counter and stutters at the final turn. TLC then enumerates the entire finite harness. Apalache checks only executions up to the explicit `--max-steps` bound. Neither result is a proof for arbitrary devices, files, event schedules, or histories.

## Recorded results

The final default run typechecked all 14 selected modules, sampled 1,000 runs for each positive case, and obtained the expected result for every TLC check: seven positive passes and seven invariant violations from deliberate broken variants. Its unrestricted four-transition `Core` harness reached 26,649 distinct states. The focused positive schedules reached their declared completion witness in every sampled run. See [TLC summary](../../formal/quint/evidence/tlc/summary.md) and its raw logs for the actual finite checks.

The selected [Apalache evidence](../../formal/quint/evidence/apalache/summary.md) additionally checks accepted-publication/response-loss/revert and unknown/force-rewind cases, with replay and uncaptured-newer-draft negative controls. Each result has an explicit transition bound. The runner uses symbolic bounded checking with `random-transitions` disabled.

An earlier unrestricted six-transition TLC run timed out after 180 seconds. Its partial search is **not a pass**. The exploratory log, original model/harness/runner snapshots, and recorded hashes are retained in `formal/quint/evidence/exploratory/`. The final suite uses the smaller four-transition core bound; the longer focused schedules remain checked separately.

## Cases and controls

The case schedule is part of the specification being checked. `Core` permits arbitrary modeled actions up to its short harness bound; the other cases explore only their listed schedule, including nondeterministic choices where indicated. Every intermediate state is checked. Positive scheduled runs also check `completed`, a state assertion at the final turn. The simulator reports `witness` in all 1,000 positive scheduled traces; this prevents an incomplete or disabled schedule from looking like a useful successful simulation.

| case | transitions | behavior checked |
|---|---:|---|
| Core | 4 | Arbitrary interleavings of modeled saves, publications, external edits, rewinds, lost responses, application, decisions, and crashes within the short bound. |
| Independent | 21 | Both devices edit different files and prepare at the same head; either request can win. The loser rereads and publishes the merged tree, and both clients reach that head without conflict. |
| ResponseLoss | 13 | A publication is accepted, its response disappears, and an ordinary later commit reverts its content. Ancestry confirms the publication; apply it once, then follow the revert. No new candidate is created. |
| UnknownRewind | 6 | An accepted request loses its response, then the owner rewinds to its parent. Reconciliation retains the candidate and draft in `held`; the unchanged parent does not authorize replay. |
| ExactPublish | 5 | A candidate's parent is removed by a rewind before processing. Generic fast-forward would resurrect history; exact-parent comparison rejects the delayed request. |
| Application | 8 | Journal, replace one file, crash, save a newer draft on the remaining file, carry and capture it, then advance the whole checkpoint. |
| StaleDecision | 7 | After a conflict decision, either the local draft or remote content changes. Refresh the review and require a fresh decision. |

| broken module | mutation | property that must fail |
|---|---|---|
| NegReplay | Replay a candidate whose success is unknown and absent from current ancestry. | `unknownHeld` |
| NegFastForward | Accept any ancestor of the candidate as the old head. | `exactHead` |
| NegJournal | Start replacement without a durable apply journal. | `journalFirst` |
| NegGuard | Replace despite a newer editor save. | `newerPreserved` |
| NegCapture | Carry a newer draft without capturing its bytes. | `carriedCaptured` |
| NegCheckpoint | Advance the checkpoint after just one file. | `wholeCheckpoint` |
| NegStaleDecision | Apply an old decision against changed local or remote versions. | `scopedDecisions` |

The runner succeeds only when each positive model passes and each broken model produces its expected invariant violation. Parse failures, backend errors, and timeouts are failures of the check, not successful negative controls. For example:

```sh
python3 scripts/check-quint.py --only NegGuard NegCapture NegCheckpoint
python3 scripts/check-quint.py --backend=apalache --only NegReplay
```

Raw verification logs are authoritative. Simulation ITF files and their compact `.txt` renderings are review aids; they are explicitly labeled simulation. Apalache also prints its concrete counterexample in its verification log. TLC emits a concrete invariant counterexample in its verification log.

## Properties and assumptions

`safe` combines exact expected-head comparison, holding unresolved publication outcomes, journaling before replacement, preserving a mismatched newer draft, durable capture of carried drafts, whole-batch checkpoint advancement, decision freshness, checkpoints referencing accepted commits, no resurrection of removed commits, and preservation of the latest editor save.

Some obligations are transition properties: immutable ghost failure flags record when processing accepted a nonmatching head, replacement lacked a journal or guard, an incomplete batch changed its checkpoint, or a stale decision was used. These flags are specification instrumentation, not proposed implementation fields. Structural properties additionally check the actual checkpoint commit status, removed ancestry, saved values, and captured draft membership in recovery. `independentNoConflict` applies only to the restricted independent-edit case; external same-file edits can legitimately cause conflicts elsewhere.

Assumptions and exclusions:

- One already-enrolled repository and branch; repository identity, path identities, and file existence are fixed. No enrollment, rename, delete, path collision, excluded-file behavior, binary writes, symlinks, credentials, rate limits, or permission changes are checked.
- Immutable Git objects and ancestry sets are correct. Publication is an atomic exact-head compare-and-swap; GitHub API behavior is an implementation/testing obligation. External commits can edit or revert abstract bytes; owner rewinds are separate actions.
- A compare-and-replace and its modeled capture/carry bookkeeping are grouped into one action. The journal is durable before that action. `crash` preserves the journal and its accounted paths. This does not cover every crash point between adapter disk writes and journal writes; idempotent recovery and fault-injection tests remain necessary.
- A save is a persisted editor save. Unsaved buffers and writers bypassing the assumed atomic adapter primitive are outside the model.
- All modeled unknown outcomes without confirmation in ancestry are held. There is no automatic exit from held. Explicit recovery, abandonment, and branch adoption are not modeled.
- The latest save can be live, a captured draft, recovery data, or bytes that were ever published. Counting historical publication is intentional for owner rewinds; this is not a backup guarantee for rewritten remote history. Recovery is never pruned in the model.
- At most three editor saves occur. Commit allocation stops at five noninitial objects; that finite guard can bind. No claim about unlimited retries or allocation slack is made. The focused positive schedules use at most three objects and do not exhaust the bound.
- The tree-level stale-decision check holds repository/base/path scope fixed and invalidates a decision when captured local or remote bytes change. It does not establish every implementation conflict-ID scope rule. Byte-identical histories, review refresh ordering, and explicit branch-adoption scopes need code tests.

## Mapping to the implementation

The mapping names correspondence obligations, not a verified refinement between Quint and TypeScript. Implementation files may change while workers integrate; review these methods again before release.

| Quint | implementation | required correspondence |
|---|---|---|
| `save`, `drafts`, `effectiveBase`, `sync` | `SyncSession.#transact`, `#effectiveBase`; pure `reconcile` | Three-way compare against a coherent checkpoint plus carried origins; outgoing changes retain independent remote paths. |
| `candidateState`, `process` | `GitHubRepository.prepare/publish` in `github.ts`; publication journal in `session.ts` | Candidate has exactly the expected parent; GraphQL `updateRefs` uses `beforeOid`, `afterOid`, and `force:false`; operation is durably saved before the request. |
| `loseResponse`, `reconcileUnknown` | `SyncSession.#settle/#resume` | Candidate in ancestry confirms publication. Absence does not prove failure in a rewind-capable repository; retain the operation until explicit recovery. |
| `applying`, `applyFile`, `crash` | `#promote`, `#applySteps`, `StoredState.operation`, `LocalVault.apply` | Durable expected/target/recovery data precede replacement. Retry must recognize already-applied target bytes and leave mismatching newer bytes alone. |
| carried draft and `finish` | `#applySteps` post-application capture and `state.carry`, `state.base` | Recapture and persist the newer bytes before advancing the checkpoint. Carry records the old origin separately from the new draft bytes. |
| `decide`, `publishDecision` | `SyncSession.resolve`, `reconcile.ts` version conflict IDs | Decisions are keyed to the current review and local/remote/base/path scope; changes invalidate them. |
| atomic replacement assumption | `ObsidianVault.apply` in `obsidian-vault.ts` | Markdown replacement uses `vault.process` with expected text comparison. Automatic binary replacement and deletion are blocked where an atomic safe primitive is unavailable. |

At first inspection the core's unknown-outcome path released a candidate when the branch returned to its parent, and changed-path handling retained the origin without recapturing the newer bytes. **The shared core was updated during this task:** the inspected `#settle` now holds every unconfirmed candidate, and `#applySteps` now recaptures and records newer bytes before checkpoint advancement. Those observations narrow the integration gaps; they do not replace running the implementation's regression and crash tests. This worker changed no sync implementation files.

## Liveness and retained TLA+ coverage

No Quint temporal liveness property was verified in this work. The fixed independent-edit schedule's final-state `completed` assertion is bounded convergence for that schedule, not eventual convergence under a fair arbitrary scheduler. `eventuallyConverged` is defined in the protocol module for illustration only; it is not passed to the verifier, and it would be false under permitted infinite stuttering or permanently held unknown outcomes.

Quint 0.33.0 exposes `--temporal`; its official guide documents temporal checking with TLC and partial temporal support with Apalache. That tooling capability is distinct from having supplied and checked a valid fairness-based liveness specification here. A useful future theorem must explicitly constrain rewrites, continuous edits, held-state recovery, network processing, device scheduling, and user decisions.

[reference-tla/](../../formal/quint/reference-tla/) retains a **read-only snapshot of Fable's evidence**, including its model, selected configurations, checker runner, logs, coverage records, summary, and snapshot hashes. It is supplementary evidence from Fable's run, not a newly executed check by this Quint worker. The recorded model SHA-256 is `012811b93c6a7582f8d5f2512b8c06f34241b07404a135838b163fef94cbb81a` and matches the snapshot.

That retained `Liveness` run checked fair quiescent convergence in the **no-rewind** configuration (`MaxEnv=3`, `MaxCommits=6`, two devices/two files), with weak fairness of device steps and aggregate publication processing. Fair device steps include user conflict decisions. Its log reports 2,131,994 distinct states and successful temporal checking. `Neg_UnfairLiveness` retains the failure when fairness is removed. These assumptions allow no-rewind retry behavior that differs from this conservative rewind-capable Quint model; do not transfer that theorem to held outcomes or continuously changing environments.

The retained TLA+ safety runs also explore longer event schedules and invariants Quint has not matched, including no blind overwrite, no unauthored changes, coherent bases, replay uniqueness, candidate sibling ambiguity, explicit branch adoption, and commit-allocation slack. Keep the parent task's canonical TLA+ artifacts and runner when integrating; this snapshot is an evidence archive, not a relocation of its runnable formal suite. Only logs actually copied into this archive are included; the retained aggregate summary mentions additional runs whose artifacts remain in Fable's suite.

## Integration instructions

1. Include `formal/quint/`, `scripts/check-quint.py`, and this document in the parent integration. Do not include ignored tooling or checker scratch output. No git commits were made by this worker.
2. Run the default script and the selected Apalache command above on the integrated tree. Inspect `evidence/*/summary.md` and `results.json`; preserve both passing checks and expected violations.
3. Keep the canonical TLA+ suite and evidence for unmatched safety/liveness coverage. Update the implementation plan to make Quint the readable entry point without deleting that evidence.
4. Run the core's unknown-publication/force-rewind, post-application-save, stale-decision, and crash-restart tests; check actual persisted recovery bytes and operation retention. Model checking here does not establish those code behaviors.
5. Gate any claim on its actual scope: two-device/two-file abstract protocol, bounded schedules, checked properties, and named durability/adapter assumptions. Do not describe the plugin or arbitrary vault sync as formally verified.
