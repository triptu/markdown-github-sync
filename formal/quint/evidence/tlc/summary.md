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
| NativeHandoff | tlc | None | PASS | PASS | 3.97 |
| NegTornPublish | simulation | 16 | VIOLATION | VIOLATION | 0.33 |
| NegTornPublish | tlc | None | VIOLATION | VIOLATION | 3.76 |
| NegIssueAck | simulation | 16 | VIOLATION | VIOLATION | 0.33 |
| NegIssueAck | tlc | None | VIOLATION | VIOLATION | 3.75 |
| NegIssueBytes | simulation | 16 | VIOLATION | VIOLATION | 0.34 |
| NegIssueBytes | tlc | None | VIOLATION | VIOLATION | 3.77 |
| NegIssueEdit | simulation | 16 | VIOLATION | VIOLATION | 1.06 |
| NegIssueEdit | tlc | None | VIOLATION | VIOLATION | 3.82 |
| NegAttemptFlag | simulation | 16 | VIOLATION | VIOLATION | 0.34 |
| NegAttemptFlag | tlc | None | VIOLATION | VIOLATION | 3.77 |
| LedgerDiverged | tlc | None | PASS | PASS | 14.91 |
| ConsentVersions | simulation | 14 | PASS | PASS | 3.88 |
| ConsentVersions | tlc | 14 | PASS | PASS | 3.82 |
| LedgerPublishWins | simulation | 16 | PASS | PASS | 7.4 |
| LedgerPublishWins | tlc | 16 | PASS | PASS | 4.29 |
| LedgerSealWins | simulation | 16 | PASS | PASS | 9.41 |
| LedgerSealWins | tlc | 16 | PASS | PASS | 4.22 |
| NativeReplace | tlc | None | PASS | PASS | 3.73 |
| NativeDelete | tlc | None | PASS | PASS | 3.71 |
| NativeCreate | tlc | None | PASS | PASS | 3.7 |
| NativeText | tlc | None | PASS | PASS | 3.7 |
| NegNativeClobber | simulation | 15 | VIOLATION | VIOLATION | 0.36 |
| NegNativeClobber | tlc | None | VIOLATION | VIOLATION | 3.69 |
| NegNativeRehash | simulation | 15 | VIOLATION | VIOLATION | 0.42 |
| NegNativeRehash | tlc | None | VIOLATION | VIOLATION | 3.69 |
| NegPrefixGuess | simulation | 15 | VIOLATION | VIOLATION | 0.35 |
| NegPrefixGuess | tlc | None | VIOLATION | VIOLATION | 3.68 |
| Ledger | tlc | None | PASS | PASS | 9.14 |
| NegLedgerUnfair | tlc | None | VIOLATION | VIOLATION | 6.61 |
| NegLedgerAbsent | simulation | 20 | VIOLATION | VIOLATION | 0.55 |
| NegLedgerAbsent | tlc | None | VIOLATION | VIOLATION | 4.12 |
| NegLedgerSplit | simulation | 20 | VIOLATION | VIOLATION | 0.55 |
| NegLedgerSplit | tlc | None | VIOLATION | VIOLATION | 4.13 |
| NegLedgerAnchor | simulation | 20 | VIOLATION | VIOLATION | 0.56 |
| NegLedgerAnchor | tlc | None | VIOLATION | VIOLATION | 4.16 |
| NegSealAnchor | simulation | 20 | VIOLATION | VIOLATION | 0.58 |
| NegSealAnchor | tlc | None | VIOLATION | VIOLATION | 4.18 |
| NegLedgerJournal | simulation | 20 | VIOLATION | VIOLATION | 0.57 |
| NegLedgerJournal | tlc | None | VIOLATION | VIOLATION | 4.13 |
| NegLedgerReplay | simulation | 20 | VIOLATION | VIOLATION | 0.56 |
| NegLedgerReplay | tlc | None | VIOLATION | VIOLATION | 4.22 |
| Adoption | simulation | 10 | PASS | PASS | 13.65 |
| Adoption | tlc | 10 | PASS | PASS | 5.25 |
| ProbeOptimisticLoss | simulation | 13 | PASS | PASS | 12.54 |
| ProbeOptimisticLoss | tlc | 13 | PASS | PASS | 5.28 |
| UseRemote | simulation | 8 | PASS | PASS | 12.13 |
| UseRemote | tlc | 8 | PASS | PASS | 5.26 |
| SilentDraft | simulation | 9 | PASS | PASS | 12.68 |
| SilentDraft | tlc | 9 | PASS | PASS | 5.27 |
| NegDiscardRemote | simulation | 8 | VIOLATION | VIOLATION | 1.02 |
| NegDiscardRemote | tlc | 8 | VIOLATION | VIOLATION | 5.28 |
| NegSilentDraft | simulation | 9 | VIOLATION | VIOLATION | 1.03 |
| NegSilentDraft | tlc | 9 | VIOLATION | VIOLATION | 5.25 |
| NegReplayUnique | simulation | 7 | VIOLATION | VIOLATION | 1.03 |
| NegReplayUnique | tlc | 7 | VIOLATION | VIOLATION | 5.28 |
| NegUnauthored | simulation | 7 | VIOLATION | VIOLATION | 1.02 |
| NegUnauthored | tlc | 7 | VIOLATION | VIOLATION | 5.29 |
| NegOptimistic | simulation | 13 | VIOLATION | VIOLATION | 1.05 |
| NegOptimistic | tlc | 13 | VIOLATION | VIOLATION | 5.36 |
| Durability | simulation | 15 | PASS | PASS | 4.53 |
| Durability | tlc | None | PASS | PASS | 3.82 |
| NegVolatileObservation | simulation | 15 | VIOLATION | VIOLATION | 0.37 |
| NegVolatileObservation | tlc | None | VIOLATION | VIOLATION | 3.8 |
| NegApprovalScope | simulation | 15 | VIOLATION | VIOLATION | 0.41 |
| NegApprovalScope | tlc | None | VIOLATION | VIOLATION | 3.83 |
| NegNativeGuard | simulation | 15 | VIOLATION | VIOLATION | 2.83 |
| NegNativeGuard | tlc | None | VIOLATION | VIOLATION | 3.83 |
| NegAccountCapture | simulation | 15 | VIOLATION | VIOLATION | 0.46 |
| NegAccountCapture | tlc | None | VIOLATION | VIOLATION | 3.83 |
| LiveIndependent | tlc | None | PASS | PASS | 5.57 |
| LiveConflict | tlc | None | PASS | PASS | 8.34 |
| NegUnfair | tlc | None | VIOLATION | VIOLATION | 5.31 |
| Core | simulation | 5 | PASS | PASS | 8.37 |
| Core | tlc | 5 | PASS | PASS | 8.78 |
| Independent | simulation | 21 | PASS | PASS | 34.25 |
| Independent | tlc | 21 | PASS | PASS | 5.38 |
| ResponseLoss | simulation | 13 | PASS | PASS | 18.35 |
| ResponseLoss | tlc | 13 | PASS | PASS | 5.27 |
| UnknownRewind | simulation | 6 | PASS | PASS | 8.53 |
| UnknownRewind | tlc | 6 | PASS | PASS | 5.26 |
| ExactPublish | simulation | 5 | PASS | PASS | 7.48 |
| ExactPublish | tlc | 5 | PASS | PASS | 5.33 |
| Application | simulation | 8 | PASS | PASS | 11.55 |
| Application | tlc | 8 | PASS | PASS | 5.31 |
| StaleDecision | simulation | 7 | PASS | PASS | 11.01 |
| StaleDecision | tlc | 7 | PASS | PASS | 5.31 |
| NegReplay | simulation | 6 | VIOLATION | VIOLATION | 1.06 |
| NegReplay | tlc | 6 | VIOLATION | VIOLATION | 5.3 |
| NegFastForward | simulation | 5 | VIOLATION | VIOLATION | 1.12 |
| NegFastForward | tlc | 5 | VIOLATION | VIOLATION | 5.39 |
| NegJournal | simulation | 8 | VIOLATION | VIOLATION | 1.06 |
| NegJournal | tlc | 8 | VIOLATION | VIOLATION | 5.25 |
| NegGuard | simulation | 8 | VIOLATION | VIOLATION | 1.03 |
| NegGuard | tlc | 8 | VIOLATION | VIOLATION | 5.2 |
| NegCapture | simulation | 8 | VIOLATION | VIOLATION | 1.03 |
| NegCapture | tlc | 8 | VIOLATION | VIOLATION | 5.3 |
| NegCheckpoint | simulation | 8 | VIOLATION | VIOLATION | 1.06 |
| NegCheckpoint | tlc | 8 | VIOLATION | VIOLATION | 5.3 |
| NegStaleDecision | simulation | 7 | VIOLATION | VIOLATION | 1.06 |
| NegStaleDecision | tlc | 7 | VIOLATION | VIOLATION | 5.32 |
