# Scope Quint evidence

Status: PASS; Quint 0.33.0, Apalache 0.62.1, openjdk version "23.0.2" 2025-01-21.

TLC explored the finite reachable graph; `--max-steps=0` is not a transition cutoff.
Temporal checks use weak fairness, not a bounded deadline. Source hashes, exact commands, seeds, bounds and logs are in results.json.

| Case | Expected | Observed | States | Depth |
|---|---|---|---:|---:|
| ScopeState | PASS | PASS | 37281 states generated, 8204 distinct states found | 15 |
| ScopeHandoff | PASS | PASS | 54 states generated, 20 distinct states found | 7 |
| NegScopeReview | VIOLATION | VIOLATION | 18 states generated, 18 distinct states found | 3 |
| NegScopeVersion | VIOLATION | VIOLATION | 328 states generated, 179 distinct states found | 5 |
| NegScopeFence | VIOLATION | VIOLATION | 366 states generated, 205 distinct states found | 5 |
| NegScopePublication | VIOLATION | VIOLATION | 18 states generated, 18 distinct states found | 3 |
| NegScopeIntersection | VIOLATION | VIOLATION | 493 states generated, 245 distinct states found | 5 |
| NegScopeUnknown | VIOLATION | VIOLATION | 170 states generated, 100 distinct states found | 5 |
| NegScopeOrigin | VIOLATION | VIOLATION | 171 states generated, 103 distinct states found | 5 |
| NegScopeAck | VIOLATION | VIOLATION | 11 states generated, 8 distinct states found | 4 |
| NegScopeNeighbor | VIOLATION | VIOLATION | 7 states generated, 4 distinct states found | 3 |
