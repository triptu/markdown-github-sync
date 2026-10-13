# Quint check evidence

Quint 0.33.0; Apalache 0.62.1; openjdk version "23.0.2" 2025-01-21.

Simulation is sampling, not proof. Apalache checks only the listed transition bound.
TLC enumerates each finite graph; only scenario/Core harnesses have a turn cutoff. --max-steps does not bound TLC.
Core explores arbitrary modeled actions for five transitions; scenario cases restrict schedules.
Ledger, native, progress, and durability graphs have no transition cutoff; temporal properties are identified in results.json.
Null bounds mean no transition cutoff; the state space still has finite data/event budgets.
Invocation status: PASS; unchanged inputs: True; full suite: False.

| case | check | bound | expected | observed | seconds |
|---|---|---:|---|---|---:|
| UnknownRewind | simulation | 6 | PASS | PASS | 45.83 |
| UnknownRewind | apalache | 6 | PASS | PASS | 23.19 |
| NegReplay | simulation | 6 | VIOLATION | VIOLATION | 1.91 |
| NegReplay | apalache | 6 | VIOLATION | VIOLATION | 19.78 |
