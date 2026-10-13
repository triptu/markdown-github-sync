# Scope Quint evidence

Status: PASS.

TLC explored finite reachable graphs; `--max-steps=0` is not a transition cutoff.
Temporal checks use weak fairness, not a bounded deadline.
Commands, source hashes, seeds, bounds and raw logs are recorded in results.json.

| Case | Expected | Observed | States | Depth |
|---|---|---|---:|---:|
| ScopeState | PASS | PASS | 327197 states generated, 66384 distinct states found | 17 |
| ScopeHandoff | PASS | PASS | 54 states generated, 20 distinct states found | 7 |
| NegScopeReview | VIOLATION | VIOLATION | 19 states generated, 19 distinct states found | 3 |
| NegScopeVersion | VIOLATION | VIOLATION | 383 states generated, 217 distinct states found | 5 |
| NegScopeFence | VIOLATION | VIOLATION | 428 states generated, 243 distinct states found | 5 |
| NegScopeRepo | VIOLATION | VIOLATION | 466 states generated, 268 distinct states found | 5 |
| NegScopeInstallation | VIOLATION | VIOLATION | 630 states generated, 323 distinct states found | 5 |
| NegScopeRemote | VIOLATION | VIOLATION | 939 states generated, 423 distinct states found | 6 |
| NegScopeCheckpoint | VIOLATION | VIOLATION | 995 states generated, 446 distinct states found | 6 |
| NegScopePublication | VIOLATION | VIOLATION | 19 states generated, 19 distinct states found | 3 |
| NegScopeIntersection | VIOLATION | VIOLATION | 615 states generated, 312 distinct states found | 5 |
| NegScopeUnknown | VIOLATION | VIOLATION | 172 states generated, 111 distinct states found | 5 |
| NegScopeOrigin | VIOLATION | VIOLATION | 175 states generated, 101 distinct states found | 5 |
| NegScopeAck | VIOLATION | VIOLATION | 11 states generated, 8 distinct states found | 4 |
| NegScopeNeighbor | VIOLATION | VIOLATION | 7 states generated, 4 distinct states found | 3 |
