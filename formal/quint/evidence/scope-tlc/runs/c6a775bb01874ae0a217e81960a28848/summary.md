# Scope Quint case results

The canonical current verdict is `../../results.json`.
This generation's case rows alone do not claim an invocation PASS.

| Case | Expected | Observed | States | Depth |
|---|---|---|---:|---:|
| ScopeState | PASS | PASS | 327197 states generated, 66384 distinct states found | 17 |
| ScopeHandoff | PASS | PASS | 54 states generated, 20 distinct states found | 7 |
| NegScopeReview | VIOLATION | VIOLATION | 19 states generated, 19 distinct states found | 3 |
| NegScopeVersion | VIOLATION | VIOLATION | 372 states generated, 215 distinct states found | 5 |
| NegScopeFence | VIOLATION | VIOLATION | 439 states generated, 247 distinct states found | 5 |
| NegScopeRepo | VIOLATION | VIOLATION | 479 states generated, 272 distinct states found | 5 |
| NegScopeInstallation | VIOLATION | VIOLATION | 630 states generated, 323 distinct states found | 5 |
| NegScopeRemote | VIOLATION | VIOLATION | 906 states generated, 416 distinct states found | 6 |
| NegScopeCheckpoint | VIOLATION | VIOLATION | 1024 states generated, 460 distinct states found | 6 |
| NegScopePublication | VIOLATION | VIOLATION | 19 states generated, 19 distinct states found | 3 |
| NegScopeIntersection | VIOLATION | VIOLATION | 648 states generated, 330 distinct states found | 5 |
| NegScopeUnknown | VIOLATION | VIOLATION | 165 states generated, 105 distinct states found | 5 |
| NegScopeOrigin | VIOLATION | VIOLATION | 181 states generated, 113 distinct states found | 5 |
| NegScopeAck | VIOLATION | VIOLATION | 9 states generated, 8 distinct states found | 4 |
| NegScopeNeighbor | VIOLATION | VIOLATION | 7 states generated, 4 distinct states found | 3 |
