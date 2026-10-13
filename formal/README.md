# Quint protocol verification

The maintained specifications are exclusively Quint. Start with
[the coverage and assumptions document](../docs/verification/quint.md).
Run `python3 scripts/check-quint.py` from the repository root; the legacy
`scripts/check-model.sh` name delegates to that runner.

`quint/ledger.qnt` models publication/cancellation and temporal settlement;
`quint/nativeTxn.qnt` models exact-hash file transactions and termination.
`quint/nativeHandoff.qnt` models durable issue ingestion, path holds, and
independent-path progress. Current implementation and device evidence is linked in
[the integration status](../docs/verification/quint.md#integration); model checks alone do not close runtime findings.
`quint/vaultSync.qnt` and `quint/progress.qnt` retain the content obligations
and conditional content convergence. `quint/durability.qnt` separates
content choice, preimage pinning, journal, replacement, and acknowledgement.
The generated TLA consumed by TLC is a tool output, not another maintained spec.

The handwritten TLA+ baseline and its evidence were retired in this migration.
Git history at `e780b4c` preserves them. No TypeScript refinement proof is claimed.
