# Quint check evidence

Quint 0.33.0; Apalache 0.62.1; openjdk version "23.0.2" 2025-01-21.

Simulation is sampling, not proof. Apalache checks only the listed transition bound.
TLC enumerates each finite graph; only scenario/Core harnesses have a turn cutoff. --max-steps does not bound TLC.
Core explores arbitrary modeled actions for five transitions; scenario cases restrict schedules.
Ledger, native, progress, and durability graphs have no transition cutoff; temporal properties are identified in results.json.
Null bounds mean no transition cutoff; the state space still has finite data/event budgets.
Invocation status: PASS; unchanged inputs: True; full suite: True.

| case | check | bound | expected | observed | seconds |
|---|---|---:|---|---|---:|
| NativeHandoff | tlc | None | PASS | PASS | 14.26 |
| NegTornPublish | simulation | 16 | VIOLATION | VIOLATION | 1.66 |
| NegTornPublish | tlc | None | VIOLATION | VIOLATION | 19.54 |
| NegIssueAck | simulation | 16 | VIOLATION | VIOLATION | 1.93 |
| NegIssueAck | tlc | None | VIOLATION | VIOLATION | 6.31 |
| NegIssueEdit | simulation | 16 | VIOLATION | VIOLATION | 1.54 |
| NegIssueEdit | tlc | None | VIOLATION | VIOLATION | 5.05 |
| NegAttemptFlag | simulation | 16 | VIOLATION | VIOLATION | 0.6 |
| NegAttemptFlag | tlc | None | VIOLATION | VIOLATION | 6.21 |
| LedgerDiverged | tlc | None | PASS | PASS | 21.17 |
| ConsentVersions | simulation | 14 | PASS | PASS | 6.67 |
| ConsentVersions | tlc | 14 | PASS | PASS | 6.03 |
| LedgerPublishWins | simulation | 16 | PASS | PASS | 8.54 |
| LedgerPublishWins | tlc | 16 | PASS | PASS | 4.53 |
| LedgerSealWins | simulation | 16 | PASS | PASS | 12.03 |
| LedgerSealWins | tlc | 16 | PASS | PASS | 4.78 |
| NativeReplace | tlc | None | PASS | PASS | 4.0 |
| NativeDelete | tlc | None | PASS | PASS | 3.82 |
| NativeCreate | tlc | None | PASS | PASS | 4.03 |
| NativeText | tlc | None | PASS | PASS | 4.06 |
| NegNativeClobber | simulation | 15 | VIOLATION | VIOLATION | 0.51 |
| NegNativeClobber | tlc | None | VIOLATION | VIOLATION | 3.87 |
| NegNativeRehash | simulation | 15 | VIOLATION | VIOLATION | 0.46 |
| NegNativeRehash | tlc | None | VIOLATION | VIOLATION | 3.82 |
| NegPrefixGuess | simulation | 15 | VIOLATION | VIOLATION | 0.42 |
| NegPrefixGuess | tlc | None | VIOLATION | VIOLATION | 3.98 |
| Ledger | tlc | None | PASS | PASS | 10.02 |
| NegLedgerUnfair | tlc | None | VIOLATION | VIOLATION | 7.26 |
| NegLedgerAbsent | simulation | 20 | VIOLATION | VIOLATION | 0.66 |
| NegLedgerAbsent | tlc | None | VIOLATION | VIOLATION | 4.39 |
| NegLedgerSplit | simulation | 20 | VIOLATION | VIOLATION | 0.66 |
| NegLedgerSplit | tlc | None | VIOLATION | VIOLATION | 4.35 |
| NegLedgerAnchor | simulation | 20 | VIOLATION | VIOLATION | 0.7 |
| NegLedgerAnchor | tlc | None | VIOLATION | VIOLATION | 4.3 |
| NegSealAnchor | simulation | 20 | VIOLATION | VIOLATION | 0.65 |
| NegSealAnchor | tlc | None | VIOLATION | VIOLATION | 4.34 |
| NegLedgerJournal | simulation | 20 | VIOLATION | VIOLATION | 0.65 |
| NegLedgerJournal | tlc | None | VIOLATION | VIOLATION | 4.44 |
| NegLedgerReplay | simulation | 20 | VIOLATION | VIOLATION | 0.71 |
| NegLedgerReplay | tlc | None | VIOLATION | VIOLATION | 4.34 |
| Adoption | simulation | 10 | PASS | PASS | 15.27 |
| Adoption | tlc | 10 | PASS | PASS | 5.73 |
| ProbeOptimisticLoss | simulation | 13 | PASS | PASS | 14.12 |
| ProbeOptimisticLoss | tlc | 13 | PASS | PASS | 5.7 |
| UseRemote | simulation | 8 | PASS | PASS | 14.5 |
| UseRemote | tlc | 8 | PASS | PASS | 5.58 |
| SilentDraft | simulation | 9 | PASS | PASS | 14.91 |
| SilentDraft | tlc | 9 | PASS | PASS | 5.69 |
| NegDiscardRemote | simulation | 8 | VIOLATION | VIOLATION | 1.13 |
| NegDiscardRemote | tlc | 8 | VIOLATION | VIOLATION | 5.51 |
| NegSilentDraft | simulation | 9 | VIOLATION | VIOLATION | 1.43 |
| NegSilentDraft | tlc | 9 | VIOLATION | VIOLATION | 5.96 |
| NegReplayUnique | simulation | 7 | VIOLATION | VIOLATION | 1.15 |
| NegReplayUnique | tlc | 7 | VIOLATION | VIOLATION | 5.54 |
| NegUnauthored | simulation | 7 | VIOLATION | VIOLATION | 1.17 |
| NegUnauthored | tlc | 7 | VIOLATION | VIOLATION | 5.75 |
| NegOptimistic | simulation | 13 | VIOLATION | VIOLATION | 1.15 |
| NegOptimistic | tlc | 13 | VIOLATION | VIOLATION | 5.58 |
| Durability | simulation | 15 | PASS | PASS | 4.94 |
| Durability | tlc | None | PASS | PASS | 3.98 |
| NegVolatileObservation | simulation | 15 | VIOLATION | VIOLATION | 0.45 |
| NegVolatileObservation | tlc | None | VIOLATION | VIOLATION | 3.98 |
| NegApprovalScope | simulation | 15 | VIOLATION | VIOLATION | 0.47 |
| NegApprovalScope | tlc | None | VIOLATION | VIOLATION | 4.06 |
| NegNativeGuard | simulation | 15 | VIOLATION | VIOLATION | 3.03 |
| NegNativeGuard | tlc | None | VIOLATION | VIOLATION | 3.96 |
| NegAccountCapture | simulation | 15 | VIOLATION | VIOLATION | 0.54 |
| NegAccountCapture | tlc | None | VIOLATION | VIOLATION | 3.93 |
| LiveIndependent | tlc | None | PASS | PASS | 5.89 |
| LiveConflict | tlc | None | PASS | PASS | 9.01 |
| NegUnfair | tlc | None | VIOLATION | VIOLATION | 5.64 |
| Core | simulation | 5 | PASS | PASS | 8.95 |
| Core | tlc | 5 | PASS | PASS | 9.93 |
| Independent | simulation | 21 | PASS | PASS | 39.72 |
| Independent | tlc | 21 | PASS | PASS | 5.6 |
| ResponseLoss | simulation | 13 | PASS | PASS | 20.04 |
| ResponseLoss | tlc | 13 | PASS | PASS | 5.5 |
| UnknownRewind | simulation | 6 | PASS | PASS | 10.02 |
| UnknownRewind | tlc | 6 | PASS | PASS | 5.52 |
| ExactPublish | simulation | 5 | PASS | PASS | 9.26 |
| ExactPublish | tlc | 5 | PASS | PASS | 5.74 |
| Application | simulation | 8 | PASS | PASS | 12.87 |
| Application | tlc | 8 | PASS | PASS | 5.48 |
| StaleDecision | simulation | 7 | PASS | PASS | 12.22 |
| StaleDecision | tlc | 7 | PASS | PASS | 5.55 |
| NegReplay | simulation | 6 | VIOLATION | VIOLATION | 1.16 |
| NegReplay | tlc | 6 | VIOLATION | VIOLATION | 9.27 |
| NegFastForward | simulation | 5 | VIOLATION | VIOLATION | 1.13 |
| NegFastForward | tlc | 5 | VIOLATION | VIOLATION | 5.44 |
| NegJournal | simulation | 8 | VIOLATION | VIOLATION | 1.1 |
| NegJournal | tlc | 8 | VIOLATION | VIOLATION | 5.58 |
| NegGuard | simulation | 8 | VIOLATION | VIOLATION | 1.4 |
| NegGuard | tlc | 8 | VIOLATION | VIOLATION | 6.03 |
| NegCapture | simulation | 8 | VIOLATION | VIOLATION | 1.2 |
| NegCapture | tlc | 8 | VIOLATION | VIOLATION | 5.57 |
| NegCheckpoint | simulation | 8 | VIOLATION | VIOLATION | 1.23 |
| NegCheckpoint | tlc | 8 | VIOLATION | VIOLATION | 5.51 |
| NegStaleDecision | simulation | 7 | VIOLATION | VIOLATION | 1.07 |
| NegStaleDecision | tlc | 7 | VIOLATION | VIOLATION | 5.31 |
