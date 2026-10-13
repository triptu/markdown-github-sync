# GitHub-authoritative V1 implementation run

User chose Android first, automatic foreground sync, and a Sync now button. The real vault and its current plugin stay untouched during development. Synthetic repositories and dummy vaults are authorized.

## Done means

An installable Obsidian plugin connects directly to GitHub, enrolls a dummy vault explicitly, preserves remote excluded paths, publishes ordinary commits using exact branch-head comparison, and converges sequential independent edits from two clients automatically. Simultaneous publication currently may require reviewed recovery; general contention-free convergence is not implemented. It exposes conflicts, recoverable captures, historical restore, and clear pending/error states. Credentials never enter vault files. A readable Quint model with executed checks, retained TLA+ coverage where useful, fault-injection tests, live synthetic GitHub integration, and independent correctness reviews have reproducible evidence. Native Android checks are distinguished from physical-device checks.

No claim of universal proof or physical-device reliability follows from finite model checking or emulator results. Existing binary replacement/deletion must remain blocked if the native adapter cannot provide a demonstrated safe write primitive. Automatic text replacement uses Obsidian's atomic process operation; other writers and unsaved editor buffers are explicit boundaries.

## Work and gates

1. Capture current baseline and define shared protocol contracts.
2. Build and check a readable Quint protocol model, including negative controls. Preserve and independently audit the TLA+ model started by Fable; do not claim equivalent verification coverage until demonstrated.
3. Opus builds pure reconciliation and durable sync-session state transitions with fault-injection tests.
4. Sol builds the GitHub object client and exact conditional publication with API boundary tests.
5. Parent builds the Obsidian storage/secret adapter, enrollment, foreground scheduling, conflict and history UI.
6. Integrate, exercise synthetic repository and native dummy vault, review with independent models, and resolve correctness findings.
7. Package, commit, push, and write an evidence report and remaining release limits.

Workers own separate worktrees. The parent integrates finished commits. Rough implementation scope: four core modules, two adapters, settings/changes/history UI, formal model, and test harnesses. No Cloudflare deployment is needed.

## Review checkpoint

Independent reviews found and drove fixes for publication replay after rewind, stale conflict/deletion consent, prototype-key paths, missing recovery captures, carry pruning, native owner overlap, logical modes, and uncertain persistence acknowledgments. The final core fix journals uncertainty before consent-bearing observations, so a failed result save cannot resurrect approval. Core review r6 passed its crash/attempt matrix; the final r7 review accepted the ancestry-error outcome correction.

The full check passes 239 plugin tests and four retained legacy server tests, plugin/server typechecks, and the browser plugin build. These are separate from live native acceptance. Native mode persistence has its own independent scoped pass. Final Android conflict, recovery, binary/deletion holds and current-artifact acceptance passed; see `docs/verification/android-conflict.md`. Seven post-restart automatic checks and 28 conflict/recovery checks passed on the packaged bundle.

Quint provides readable bounded safety checks and negative controls; retained TLA+ adds finite conditional liveness coverage. The runner timeout-verdict issue was corrected and independently reviewed. Fable resumed and verified the retained deep TLA run; Sol and Astra performed subsequent implementation and formal reviews. No model-to-TypeScript refinement proof or physical-phone/power-loss acceptance is claimed.
