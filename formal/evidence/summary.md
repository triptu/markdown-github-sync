# TLC evidence summary

Generated 2026-10-13T12:39:59Z by scripts/check-model.sh
TLC: Version 2.19 of 08 August 2024  (tla2tools.jar sha256 936a262061c9...)
Model SHA-256: 012811b93c6a7582f8d5f2512b8c06f34241b07404a135838b163fef94cbb81a
Runner SHA-256: d5d937c7b0d52c2a158fbee4556c54b5ff66d2ba5663ad489afba175d3d2a22f
Workers: 8; heap: 4g; TLC seed: 1; fingerprint polynomial: 0
Selected runs only; other evidence files may be from earlier invocations.
Java: openjdk version "23.0.2" 2025-01-21
Host: Darwin arm64, 14 cpus

| model | expected | observed | verdict | states generated | distinct | depth | wall time |
|---|---|---|---|---|---|---|---|
| Core | PASS | PASS | OK | 636479 | 266730 | 37 | 4s |
| Rewind | PASS | PASS | OK | 568954 | 241127 | 37 | 4s |
| Probe_OptimisticCheckpoint_Loss | PASS | PASS | OK | 881565 | 395431 | 83 | 3s |
| Liveness | PASS | PASS | OK | 5993694 | 2131994 | 38 | 127s |
| Independent | PASS | PASS | OK | 280518 | 96530 | 35 | 7s |
| Neg_UnfairLiveness | FAIL:Temporal | FAIL:Temporal | OK | 298720 | 139185 | ? | 4s |
| Neg_NoApplyGuard | FAIL:CapturedEditsPreserved | FAIL:CapturedEditsPreserved | OK | 1208 | 965 | 8 | 1s |
| Neg_NoApplyJournal | FAIL:NoUnauthoredChange | FAIL:NoUnauthoredChange | OK | 7826 | 4998 | 10 | 1s |
| Neg_PartialCheckpoint | FAIL:BaseCoherent | FAIL:BaseCoherent | OK | 3427 | 2420 | 9 | 0s |
| Neg_OptimisticCheckpoint | FAIL:CheckpointPublished | FAIL:CheckpointPublished | OK | 45 | 40 | 5 | 0s |
| Neg_ReplayOnUnknown | FAIL:NoReplay | FAIL:NoReplay | OK | 23864 | 12974 | 11 | 1s |
| Neg_ForgetSiblings | FAIL:NoReplay | FAIL:NoReplay | OK | 61344 | 29836 | 13 | 2s |
| Neg_StaleResolution | FAIL:NoBlindOverwrite | FAIL:NoBlindOverwrite | OK | 55536 | 27158 | 13 | 1s |
| Neg_SilentNewDraft | FAIL:NoBlindOverwrite | FAIL:NoBlindOverwrite | OK | 17292 | 9824 | 11 | 1s |
| Neg_DiscardOnUseGitHub | FAIL:CapturedEditsPreserved | FAIL:CapturedEditsPreserved | OK | 18800 | 10378 | 11 | 1s |
| Neg_FastForwardRef | FAIL:NoResurrection | FAIL:NoResurrection | OK | 1882 | 1422 | 8 | 1s |
| Neg_RewindUnknown | FAIL:NoUncertainRetry | FAIL:NoUncertainRetry | OK | 696 | 580 | 7 | 0s |
| Core_Deep | PASS | PASS | OK | 41455831 | 16677072 | 50 | 121s |

Review update: the Neg_PartialCheckpoint row and its log/trace/config hash were
replaced with a targeted rerun after disabling the unrelated NC_NoApplyJournal
control. All other rows are from the full `--deep` invocation above.
Generated 2026-10-13T12:45:49Z by scripts/check-model.sh (`--only Neg_PartialCheckpoint`).
The model and runner hashes are unchanged between these invocations.
