# Quint migration verification record

Historical implementation self-check of the original Quint migration in `/tmp/vault-sync-quint-v2`, branch `implement/quint-only-v2`, baseline `e780b4c`. Its original evidence and verdicts below predate root integration commit `1b74eab` and the independent Quint review `/tmp/github-v2-quint-review-r1.md`. The current formal-fix run and updated bounds are recorded below.

## Selected design

The full `/tmp/github-v2-design-opus-r1.md` was read after the parent selected §§2–6. The parent's one-confirmation branch-rewrite policy overrides the document's automatic-adoption recommendation. The implemented specifications reflect per-device append-only ledgers, atomic branch/receipt CAS, same-anchor cancellation seals, persist-before-dispatch identities, content-version consent, and exact-hash native transactions. Receipt absence and API errors never establish nonpublication.

The earlier conservative permanent-hold progress models were removed after selection. The old event/incarnation observation marker was also removed. Content choices now require pinned exact preimages and matching expected/next bytes; byte-identical recreation or an event does not revoke consent. The `NegVolatileObservation` name remains as a historical alias for the missing-preimage negative control.

## Authored models and evidence

- `ledger.qnt`: full finite graph, three operations/two fault events; genuine fair conditional settlement; a separate foreign-ledger domain reaches divergence and stops writing. Focused race schedules additionally exercise both winners, restart, a later operation, rewind, and stale delivery.
- `nativeTxn.qnt`: full finite graphs for replace/delete/create/text interruption; genuine fair conditional termination; exact hashes, pinned versions, no-clobber install, held-writer recheck, and conflict outcomes.
- `nativeHandoff.qnt`: durable attempt/issue-ingestion/acknowledgement boundaries, issue-path exclusion until an exact-content reviewed choice, independent-path progress, and four negative controls for the native review findings.
- `durability.qnt`: content-consent/persistence boundaries; no event-incarnation marker. The fixed `ConsentVersions` schedule covers identical bytes at another head, echoes, restart, and multi-path completion.
- `vaultSync.qnt` / `cases.qnt` / `progress.qnt`: migrated content/provenance/replay/checkpoint obligations, an arbitrary five-step Core prefix, focused scenarios, and fair content convergence over two saves with reliable terminal publication outcomes.

The canonical [coverage map](quint.md) names every old obligation/control, retired guarantees, exact bounds, and unproved composition. The models do not prove TypeScript correctness or unlimited retry convergence. Ledger settlement does not imply a publication must eventually beat every cancellation race; the three-round scheduling cap is represented but not reached by the three-operation domain. Native assumptions still require confirmation against the native worker and real platform tests.

## Historical native review verdict before integration

The full independent `/tmp/github-v2-native-review-r1.md` found an F1 torn-write → ordinary-change → merge/publication counterexample and an F2 displaced/orphan discovery gap in the earlier implementation. The original handoff model detected the collapsed-change mutation. Root commit `1b74eab` subsequently wired issue ingestion before acknowledgment; its reported 254 plugin and four server tests include the torn-note and retry regressions. The older **FAIL / not ready** verdict belongs to the preintegration revision. Oversized native evidence, a new independent review, and platform crash acceptance remain open. Provenance is recorded in `formal/quint/evidence/toolchain/native-review.txt`.

## Original executed results

The original frozen full TLC invocation completed on 2026-10-13 at 15:53:10 UTC: **55/55 expected results**, comprising 24 positive passes and 31 detected negative controls. Nine positives check genuine conditional temporal properties; two negatives produce temporal counterexamples. The 44 non-temporal cases also produced their expected sampled outcomes (15 passes, 29 violations). Those counts and the table below describe the original model; the current manifest reflects the revised handoff and new negative control.

The original selected Apalache invocation completed at 15:44:30 UTC: `UnknownRewind` passed and `NegReplay` produced its expected invariant violation, each at six transitions. This was a two-case bounded check, not the full suite or temporal evidence. All six original runner regressions passed. The migration commit preserves that original evidence; the working tree now contains the refreshed run below.

| Positive domain | Distinct TLC states | Scope |
|---|---:|---|
| Native issue handoff | 6,172 | One issue, one other path, one edit, two crashes; no turn cutoff |
| Ledger | 67,664 | Three operations, two faults; no turn cutoff |
| Foreign ledger divergence | 147,148 | Same bounds plus foreign ref mutation |
| Native replace / delete / create / text | 444 / 180 / 152 / 80 | One path, two interference events; no turn cutoff |
| Durable consent/application | 1,756 | Two paths, one later save, one remote-head advance; no turn cutoff |
| Independent / conflicting content progress | 6,214 / 29,146 | Two saves, fair clients/server, reliable responses |
| Core | 274,016 | Arbitrary modeled actions through five transitions |

These state counts describe the enumerated abstractions; they do not measure implementation coverage or extend the bounds listed in the coverage map.

## Current formal-fix run

After independent Quint review R1, the handoff model separates durable native evidence, a volatile fetch copy, and durable engine evidence. Each record contains kind, issue ID, expected value, intended next value, found value, and hold status. The engine persists the complete fetched record atomically before acknowledgment, and acknowledgment erases native evidence. `ackBacked` then requires the engine record's exact modeled bytes and fields. The new `NegIssueBytes` mutation retains the engine hold while dropping the found value; TLC finds a counterexample after acknowledgment with native evidence absent, engine `hold = TRUE`, and engine `found = -1`. Review choices read the engine copy. This is still one issue with finite abstract byte values and assumed atomic save/capture, not a proof of the TypeScript storage path.

The full TLC run completed at 2026-10-13 16:17:59 UTC with **56/56 expected results**: 24 positive passes, 32 negative violations, nine positive temporal checks, and two temporal counterexamples. The 45 safety cases also produced their expected sampled outcomes (15 passes, 30 violations). `NativeHandoff` enumerated 5,332 distinct states in its revised graph. The 56 TLC checks and safety samples consumed 479.52 seconds of recorded subprocess time. `NativeReplace` now correctly records **1,359 generated / 444 distinct** states from TLC's final complete line. The seven runner regressions passed.

The selected Apalache run completed at 16:18:45 UTC: `UnknownRewind` passed and `NegReplay` violated its named invariant, both with six-step bounds. Its 38.16 seconds of recorded subprocess time includes sampling and checking. Both manifests report `PASS`, and an independent SHA-256 comparison found zero mismatches across all 70 listed inputs in each manifest. The [TLC manifest](../../formal/quint/evidence/tlc/results.json), [new negative trace](../../formal/quint/evidence/tlc/NegIssueBytes.verify.log), and [Apalache manifest](../../formal/quint/evidence/apalache/results.json) are the execution record for this revision.

Root commit `1b74eab` and its reported 254 passing plugin tests plus four server tests address the original torn-note implementation path. Oversized native evidence, a subsequent independent native review, and platform crash acceptance remain pending. These separate finite models do not establish composed TypeScript or full-sync safety.

## Runner checks

The original six regressions covered normal/abnormal exits, a real diagnostic-then-timeout subprocess, temporal-versus-safety diagnostic separation, invalid model names/timeouts, and refusal of temporal checking through simulation or Apalache. A seventh checks comma-grouped generated-state counts and chooses the final complete TLC line. `formal/quint/evidence/toolchain/runner-regressions.txt` records the current seven-test run.

The runner checks each negative's named invariant alone, or its named temporal property alongside safety. A safety failure cannot satisfy a temporal negative: the actual TLC `q_temporalProps` diagnostic is required. Success requires a normal CLI exit and complete TLC result; temporal success also requires temporal-check output. Signals, partial output, timeout, assertions, and deadlocks fail closed.

Source hashes are captured before execution and compared afterward. A directory lock prevents concurrent evidence replacement. An actual second runner was rejected during checking and left the in-progress manifest unchanged; `concurrent-runner.txt` records that test. Separate Apalache/TLC output directories can run concurrently. Final manifests state full-suite versus selected coverage; only their listed results belong to that invocation.

## Corrected findings

- Own editor saves count as observed content, while observation is path-scoped; identical bytes observed elsewhere cannot authorize a blind overwrite.
- A persisted acknowledgement records the value accounted for at that boundary. A later unrelated editor save does not retroactively invalidate it.
- Local approval relies on pinned exact preimages. It no longer requires a historical observation-incarnation record.
- Ledger ancestry follows each immutable object's saved parent, not the current ledger value. A mutation that ignores an old anchor must not silently inherit newer ledger history.
- Delayed publication after a seal is checked even after a later receipt and branch rewind. Both CAS conditions are necessary.
- Native cleanup rechecks and retains changed hold bytes. A legitimate prefix is never classified as a torn write that may be replaced.
- macOS's `/usr/bin/java` launcher is not a JDK directory; a compatible JDK is resolved before starting the backend.
- The pinned TLC emits `Temporal property q_temporalProps was violated`; the runner uses that concrete diagnostic and refuses an invariant violation as a substitute.

## Toolchain and provenance

Quint 0.33.0 `verify --help`, builtin `weakFair`, CLI temporal-backend warning, and TLC property-config generation were read and then exercised. Local excerpts/hashes are retained in `formal/quint/evidence/toolchain/`; pinned primary-source links are in the coverage document. Generated TLA remains a transient tool artifact. No handwritten TLA or `.cfg` is retained in the Git index.

The parent supplied six successful live API checks, read but not rerun here. SHA-256 of the files read in the parent checkout:

```text
20fe9ea459976625c3824699181052028043283b3ec6555d650ec293b1b7d269  scripts/probe-github-ledger.mjs
68a5bcfa38f09d57344ec62e64c6ba8274c86433be64b3d0a142b89f9b35343e  docs/verification/github-ledger-probe.json
```

API probes, finite model checks, implementation tests, Android beta acceptance, and native platform gates remain separate evidence.
