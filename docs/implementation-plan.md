# GitHub-authoritative V1 implementation run

User chose Android first, automatic foreground sync, and a Sync now button. The real vault and its current plugin stay untouched during development. Synthetic repositories and dummy vaults are authorized.

## Done means

An installable Obsidian plugin connects directly to GitHub, enrolls a dummy vault explicitly, preserves remote excluded paths, publishes ordinary commits using exact branch-head comparison, and converges independent edits from two clients automatically. It exposes conflicts, recoverable captures, historical restore, and clear pending/error states. Credentials never enter vault files. A TLA+ model, fault-injection tests, live synthetic GitHub integration, and independent correctness reviews have reproducible evidence. Native Android checks are distinguished from physical-device checks.

No claim of universal proof or physical-device reliability follows from finite model checking or emulator results. Existing binary replacement/deletion must remain blocked if the native adapter cannot provide a demonstrated safe write primitive. Automatic text replacement uses Obsidian's atomic process operation; other writers and unsaved editor buffers are explicit boundaries.

## Work and gates

1. Capture current baseline and define shared protocol contracts.
2. Fable builds and checks a small TLA+ protocol model, including negative controls.
3. Opus builds pure reconciliation and durable sync-session state transitions with fault-injection tests.
4. Sol builds the GitHub object client and exact conditional publication with API boundary tests.
5. Parent builds the Obsidian storage/secret adapter, enrollment, foreground scheduling, conflict and history UI.
6. Integrate, exercise synthetic repository and native dummy vault, review with independent models, and resolve correctness findings.
7. Package, commit, push, and write an evidence report and remaining release limits.

Workers own separate worktrees. The parent integrates finished commits. Rough implementation scope: four core modules, two adapters, settings/changes/history UI, formal model, and test harnesses. No Cloudflare deployment is needed.
