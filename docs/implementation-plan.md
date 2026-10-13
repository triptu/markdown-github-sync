# GitHub-authoritative V1 implementation run

User chose Android first, automatic foreground sync, and a Sync now button. The real vault and its current plugin stay untouched during development. Synthetic repositories and dummy vaults are authorized.

## Done means

The original beta milestone was an installable plugin connecting directly to GitHub, enrolling a dummy vault explicitly, preserving remote excluded paths, and converging sequential independent edits. Its simultaneous publication and native file-operation limitations are superseded by the full replacement continuation below. Credentials stay outside vault files. Formal models, fault injection, live synthetic GitHub tests, and independent correctness reviews provide separate evidence; native Android checks remain distinct from physical-device checks.

No claim of universal proof or physical-device reliability follows from finite model checking or emulator results. Existing binary replacement/deletion must remain blocked if the native adapter cannot provide a demonstrated safe write primitive. Automatic text replacement uses Obsidian's atomic process operation; other writers and unsaved editor buffers are explicit boundaries.

## Work and gates

1. Capture current baseline and define shared protocol contracts.
2. Build and check a readable Quint protocol model, including negative controls. The beta retained a TLA+ baseline; the full replacement migration retires it to Git history and records changed coverage explicitly.
3. Opus builds pure reconciliation and durable sync-session state transitions with fault-injection tests.
4. Sol builds the GitHub object client and exact conditional publication with API boundary tests.
5. Parent builds the Obsidian storage/secret adapter, enrollment, foreground scheduling, conflict and history UI.
6. Integrate, exercise synthetic repository and native dummy vault, review with independent models, and resolve correctness findings.
7. Package, commit, push, and write an evidence report and remaining release limits.

Workers own separate worktrees. The parent integrates finished commits. Rough implementation scope: four core modules, two adapters, settings/changes/history UI, formal model, and test harnesses. No Cloudflare deployment is needed.

## Review checkpoint

Independent reviews found and drove fixes for publication replay after rewind, stale conflict/deletion consent, prototype-key paths, missing recovery captures, carry pruning, native owner overlap, logical modes, and uncertain persistence acknowledgments. The final core fix journals uncertainty before consent-bearing observations, so a failed result save cannot resurrect approval. Core review r6 passed its crash/attempt matrix; the final r7 review accepted the ancestry-error outcome correction.

The full check passes 239 plugin tests and four retained legacy server tests, plugin/server typechecks, and the browser plugin build. These are separate from live native acceptance. Native mode persistence has its own independent scoped pass. Final Android conflict, recovery, binary/deletion holds and current-artifact acceptance passed; see `docs/verification/android-conflict.md`. Seven post-restart automatic checks and 28 conflict/recovery checks passed on the packaged bundle.

The beta used bounded Quint safety checks plus a retained TLA+ baseline. The current Quint-only models add conditional temporal checks and retire the handwritten baseline. The original deep unrestricted TLA exploration has no equal-size replacement claim; the current bounds and remaining obligations are listed in `docs/verification/quint.md`. No model-to-TypeScript refinement proof or physical-phone/power-loss acceptance is claimed.

## Full replacement continuation

The 0.2.0 beta is a baseline, not completion of the requested replacement. The next release must pass these observable gates:

- Two clients editing different files from the same checkpoint converge automatically after simultaneous publication, lost responses and restarts; accepted-then-rewound operations never silently replay.
- Ordinary nonconflicting note deletions, renames, attachment creates and replacements converge without permanent holds or routine manual approval. Edit/delete conflicts retain both versions and require a decision. Interrupted file operations preserve every captured newer version and recover automatically where the durable evidence is conclusive.
- Android and desktop setup can validate a selected private repository and credentials, enroll safely, and migrate a copy of an existing Git-backed vault without touching the original checkout or leaving competing sync enabled.
- History is browsable by file and date/message; restore previews bytes and creates a new committed change. Recovery storage has a safe, restartable retention/cleanup policy that never prunes unresolved drafts or in-flight operation evidence.
- Quint is the only maintained authored protocol specification. Unique TLA+ safety and conditional progress obligations move to Quint-authored checks; old source is recoverable in Git history. Backend-generated TLA is permitted, duplicate hand-maintained specifications are not.
- New fault-injection regressions, independent protocol review, live private-repository races, desktop test-vault and Android emulator acceptance pass on the packaged artifact. Physical-phone acceptance is a separately recorded gate requiring the user's device; never claim an emulator proves it.

Work is approximately seven units: publication protocol, native file transactions, Quint migration, history, onboarding/migration, journal cleanup, and combined acceptance. Protocol uncertainty is tackled first with independent Opus and Fable designs; an Astra worker migrates formal verification in an isolated worktree. The parent owns user flows and integration. No real-vault mutations are authorized by this test plan; dummy-vault experiments continue under the user's existing authorization.

The baseline is tag `0.2.0-beta.1`, commit `e780b4c`: 239 plugin tests, four legacy server tests, and documented native acceptance. Improvements must remove beta limitations through implemented behavior, not by weakening or hiding the claims.

## Configuration integration checkpoint

The native configuration policy, reviewed legacy journal upgrade, engine scope migration, and configuration review screens are integrated in `21a3d18` with engine fixes in `46aa75e`. Startup derives scope from durable enrollment state; legacy vaults need a reviewed pause and fresh enrollment. New hidden-file publication previews and deferred incoming configuration show saved contents and bind approval to the exact versions. Successful sync statuses show remaining unreadable, held, or deferred work.

Root validation: 398/398 plugin tests, TypeScript, build, and diff checks pass. Independent native and composed-workflow reviews remain active, along with expanded Quint models. The new factory and UI still require dedicated integration and final Android/desktop acceptance. Earlier device evidence applies to its recorded bundle hash only. No release or full-replacement completion is claimed.

## Current assembled-build checkpoint (14 October 2026)

The integrated source at `697bdb5` passed 437 tests, TypeScript and build. At `e8fdd3e`, Fable reproduced 438 passing tests after the added parallel-blob interruption regression. The parallel journal review found no blocking issue; the native editor review closed R3-E at the adapter boundary. Real FileView acceptance remains a distinct device gate.

Quint scope review R3 is closed, including evidence freshness and independent identity-fence negative controls. The writing-host review R4 closed configuration-apply R3-C1 but found the same stale-writer risk in history restore (R4-C1). The fix includes consideration of previously unguarded configuration restores, rather than treating that behavior as outside scope.

Android configuration acceptance is running on production SHA `2a1f0ecb9679e8bf4e7cd5c635f69d1f773e29af3a4e9cb6c7e9abf0c82bb93f`. Its pre-state failure is retained, and a separate resumed record allows only pending unpublished configuration additions. Root reviewed revision 1 → 2 through the production UI. Finish the full restart checks, restore-fix review, real FileView race, final packaged desktop/Android acceptance, and release. No personal-vault changes or full-replacement approval.

## Acceptance checkpoint after editor R3

The assembled source passed 454 plugin tests and four retained server tests, typechecks, and build; production bundle SHA is `99a17cfe451358c7ffea159638e4e428d9e9eb4ef74af4f97f0b8bb28ac3ec16`. Journal deduplication review R2 found no blocking issue. Restore review R5 closed the writing-host and unguarded-restore findings, but found a pre-publication stale flush can silently cancel the intended restore; that finding is being fixed before final acceptance.

Android's configuration restart run preserved the stale local configuration across restart, then stopped on a zero-byte temporary journal write. Its original failed result is retained. A normal production Sync now retry published the unrelated note and retained the settings hold. The empty write's cause remains unexplained; readback correctly prevented committing it. Object-read deduplication does not claim to fix that failure.

Three editor probes exposed harness assumptions rather than proving the intended race. R1 could not open an extensionless hold as Markdown; R2 explicitly opened it but Obsidian closed the view; R3 observed that closure before the synthetic draft could save, before the second rename. Their failed results and host census remain in `docs/verification`. They are not native safety passes. A read-only assessment will identify the representative visible-editor test and retain the unsaved-buffer limitation.

Final acceptance is being prepared for the installed production plugin on the isolated desktop profile and Android lab. No real-vault changes, competing-plugin removal, or finished replacement claim.


## Final replacement beta checkpoint — 14 October 2026

The 0.3.0-beta.1 package contains the self-contained GitHub replacement and uses the same production main.js (dc3984a2…d103) as the final desktop and Android content acceptance and Android configuration acceptance. Each run passed 21 checks, with separate final-byte readback. Root exercised configuration consent/application/guard approval and a saved Markdown edit through Android UI; desktop and history restore coverage is API-driven as recorded in the reports.

The source review rounds for native index acknowledgement and restore consent closed. The authored formal specification is Quint only, with the existing reviewed finite model evidence retained. The final runtime suite passed 474 plugin tests, four legacy-server tests, both typechecks and build.

Two emulator journal writes failed readback verification and stopped safely. Their unchanged-code retries and fresh passing runs do not erase the failures or prove their cause. The independent storage analysis found no reproduced plugin defect; the parent records its lower-storage attribution as unproven. This remains a beta limitation, along with physical-phone, hardware power-loss and fine-grained PAT acceptance. See docs/releases/0.3.0-beta.1.md for the package scope and cutover steps. The real vault/repository and existing plugin were not changed.
