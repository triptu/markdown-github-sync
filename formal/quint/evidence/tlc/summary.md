# Quint check evidence

Quint 0.33.0; Apalache 0.62.1; openjdk version "23.0.2" 2025-01-21.

Simulation is sampling, not proof. Apalache checks only the listed transition bound.
TLC enumerates the finite harness: its turn counter stops at that bound; --max-steps itself does not bound TLC.
Core explores arbitrary modeled actions for four transitions; other cases restrict schedules.

| case | check | bound | expected | observed | seconds |
|---|---|---:|---|---|---:|
| Core | simulation | 4 | PASS | PASS | 1.21 |
| Core | tlc | 4 | PASS | PASS | 5.28 |
| Independent | simulation | 21 | PASS | PASS | 2.87 |
| Independent | tlc | 21 | PASS | PASS | 4.71 |
| ResponseLoss | simulation | 13 | PASS | PASS | 2.01 |
| ResponseLoss | tlc | 13 | PASS | PASS | 4.71 |
| UnknownRewind | simulation | 6 | PASS | PASS | 1.39 |
| UnknownRewind | tlc | 6 | PASS | PASS | 4.77 |
| ExactPublish | simulation | 5 | PASS | PASS | 1.24 |
| ExactPublish | tlc | 5 | PASS | PASS | 4.76 |
| Application | simulation | 8 | PASS | PASS | 1.47 |
| Application | tlc | 8 | PASS | PASS | 4.73 |
| StaleDecision | simulation | 7 | PASS | PASS | 1.44 |
| StaleDecision | tlc | 7 | PASS | PASS | 4.75 |
| NegReplay | simulation | 6 | VIOLATION | VIOLATION | 0.77 |
| NegReplay | tlc | 6 | VIOLATION | VIOLATION | 4.75 |
| NegFastForward | simulation | 5 | VIOLATION | VIOLATION | 0.78 |
| NegFastForward | tlc | 5 | VIOLATION | VIOLATION | 4.73 |
| NegJournal | simulation | 8 | VIOLATION | VIOLATION | 0.77 |
| NegJournal | tlc | 8 | VIOLATION | VIOLATION | 4.79 |
| NegGuard | simulation | 8 | VIOLATION | VIOLATION | 0.77 |
| NegGuard | tlc | 8 | VIOLATION | VIOLATION | 4.75 |
| NegCapture | simulation | 8 | VIOLATION | VIOLATION | 0.78 |
| NegCapture | tlc | 8 | VIOLATION | VIOLATION | 4.83 |
| NegCheckpoint | simulation | 8 | VIOLATION | VIOLATION | 0.8 |
| NegCheckpoint | tlc | 8 | VIOLATION | VIOLATION | 4.64 |
| NegStaleDecision | simulation | 7 | VIOLATION | VIOLATION | 0.79 |
| NegStaleDecision | tlc | 7 | VIOLATION | VIOLATION | 4.78 |
