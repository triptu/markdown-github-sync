# Quint check evidence

Quint 0.33.0; Apalache 0.62.1; openjdk version "23.0.2" 2025-01-21.

Simulation is sampling, not proof. Apalache checks only the listed transition bound.
TLC enumerates the finite harness: its turn counter stops at that bound; --max-steps itself does not bound TLC.
Core explores arbitrary modeled actions for four transitions; other cases restrict schedules.

| case | check | bound | expected | observed | seconds |
|---|---|---:|---|---|---:|
| UnknownRewind | simulation | 6 | PASS | PASS | 1.25 |
| UnknownRewind | apalache | 6 | PASS | PASS | 11.22 |
| NegReplay | simulation | 6 | VIOLATION | VIOLATION | 0.76 |
| NegReplay | apalache | 6 | VIOLATION | VIOLATION | 10.31 |
