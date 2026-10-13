# Android v2 normal-operation acceptance

2026-10-13. Obsidian 1.14.4, Android 15 emulator `emulator-5554`, disposable **Vault Sync Lab**. Private synthetic repository `your-name/vault-sync-test`, branch `native-android-1791894436601`. The personal vault was not used.

Installed production bundle SHA-256: `0ef19cb3cc466f2480054f13744e7c49a1677b215dc7afee657aa83ece1812ed`. This is the pre-configuration integration build from root `7ff604c`, not the eventual release artifact. The acceptance helper injects the actual built production hash and refuses other vaults, repositories, branches or settings.

## Observed behavior

- Eight initial checks: Android created one file while the fixture published a different file to GitHub. Production automatic foreground sync converged both without Sync now.
- The parent force-stopped and reopened Obsidian after convergence. Seven checks confirmed the checkpoint, both local files and both committed files survived.
- Twenty-five conflict/recovery checks passed: overlapping edits held the local bytes for a decision; the reviewed merge reached both GitHub and Android; an ordinary binary replacement and note deletion then applied automatically with no extra GitHub commit. Preimage and incoming recovery exports matched the exact original and replacement bytes.
- The parent independently read four files from Android and GitHub, compared their exact expected bytes, checked the remote deleted path was absent, matched the installed bundle hash, and checked automatic syncing was restored after the controlled test.

Raw evidence: `android-v2-auto-stage.json`, `android-v2-auto-result.json`, `android-v2-progress.json`, `android-v2-result.json`, `android-v2-independent.json`. The initial eight-check progress was superseded by the main-run progress; the stage records the initial convergence commit. The helper source contains the assertions.

## Limits and release blockers

This is actual native Obsidian plus live GitHub, but the helper drives production plugin APIs rather than tapping the conflict UI. The restart occurred after convergence, not during an interrupted file operation. It does not establish power-loss durability, arbitrary editor-buffer behavior, physical-phone behavior, or the new configuration feature.

Independent review [engine-native-review-r2.md](engine-native-review-r2.md) found five remaining oversized-file/quarantine recovery defects, including a wrong remote deletion when unreadable bytes were mistaken for absence. They are release blockers despite these passing normal-operation checks. This document is not full replacement approval. Run final artifact acceptance again after fixes and configuration integration.

## Process-kill follow-up

The same production bundle then passed two separate full-process Android force-stop cases, driven by `plugin/test/native/crash-acceptance.ts` as committed in `efb40a0`:

1. After `adapter.rename(original, hold)` completed, before control returned to production recovery: original bytes were in the hidden hold and the visible path was absent. The parent killed the app, reopened it, and the production session installed the intended replacement.
2. After `adapter.rename(stage, original)` completed, before control returned to production completion: the replacement was visible but the durable operation was unfinished. The parent killed/reopened the app and the session settled the operation.

Each run passed five setup assertions and eight post-restart assertions. Exact replacement bytes, idle checkpoint, no unresolved conflicts/pending work, no extra remote commit, and durable recovery preimage were checked. The parent independently compared both replacement files on Android and GitHub and verified automatic sync was restored. The crash helper was disabled after completion; the app was left stopped.

Evidence: `android-v2-crash-{displace,install}-{boundary,result}.json` and `android-v2-crash-independent.json`. These tests inject a pause after the actual completed native rename and kill the whole app; they do not simulate a torn filesystem rename, power loss, or an unsaved editor race. The original normal-operation run used no interruption inside an operation; these follow-up cases extend that coverage. Open review findings remain blockers.

Future harness runs namespace their evidence by the production bundle hash, so a previous artifact's success cannot silently skip a new artifact's acceptance.

## Current integration build rerun

The same normal-operation harness was rerun after native scope/index fixes at `4da2def`, production SHA-256 `00e4fd325a596fc01f964e66c90e1744ebba74498d59f4a8cd189fbbf9929fb2`. Eight initial automatic-pair checks, seven post-force-stop restart checks, and 25 controlled conflict/binary/deletion/recovery-export checks passed. The parent separately compared four exact files on Android and GitHub, verified both sides of the deletion, the installed hash, no extra apply commit, and restored automatic syncing. The helper was disabled and the lab app stopped afterward.

Raw evidence is `android-v2-current-{auto-stage,auto-result,result,independent}.json`. This rerun exercised legacy visible-file mode through the new factory/native code. It does not yet cover the new configuration review UI or policy migration on Android. The process-kill boundaries above still apply only to the older recorded artifact and must be rerun on the release bundle. Independent composed workflow and Quint reviews remain pending.

The `00e4fd325a59…` build subsequently passed both process-kill boundaries again: five setup and eight recovery checks per boundary. The parent independently compared both replacement binaries on Android and GitHub, verified the installed hash and automatic setting, then disabled the crash helper and stopped the lab app. Evidence: `android-v2-current-crash-{displace,install}-{await-kill,result}.json` and `android-v2-current-crash-independent.json`. Later configuration preflight/first-enrollment/UI changes are not present in this tested bundle; final configuration and packaged-artifact acceptance remain open.


## Configuration UI acceptance checkpoint (2026-10-14)

Production SHA `2b38871ad3c8cfa91bd3c0c12cfa70271e61ae9ad3578d2aba84ff9cf6972fee`, Android 15 emulator, Obsidian 1.14.4, disposable Vault Sync Lab. Root opened the production command palette and Configuration sync modal, expanded both incoming rows, inspected the expected and committed versions, and tapped **Apply reviewed updates**. The helper confirmed both exact file versions, cleared deferred state and cleared application preview. Migration and stale/new hidden publication consent checks also passed.

The run is **not a full acceptance pass**: it stopped after UI apply because its blanket unchanged-local-hidden assertion included `.obsidian/workspace-mobile.json`, which Obsidian changes while navigating. The preserved [failed result](android-v2-configuration-result.json) records this boundary; it must not be relabeled PASS. The same-host stale-write/consent stages had not run. A subsequent final-bundle restart test must establish them independently. The UI apply was also significantly slow; a separate journal/Android bridge latency investigation is open. This bundle predates the restart guard fix. No real vault was modified.

## Configuration restart run — guarded write passed, storage failure stops acceptance

Production SHA `2a1f0ecb9679e8bf4e7cd5c635f69d1f773e29af3a4e9cb6c7e9abf0c82bb93f`, run `e38695b2-639f-4bca-a880-78bff693ac02`. The initial pre-state prerequisite mistakenly rejected unapproved configuration additions; its result remains unchanged. An explicit resumed namespace permits only those additions and retains the original failure archive.

Root expanded the production review UI and inspected revision 1 → 2, then tapped Apply. The application took longer than the helper's two-minute observation window; after the UI cleared incoming updates, root resumed the disposable helper's observer through the debugger in the same host. This did not bypass the production UI apply.

The helper confirmed a synthetic stale revision stayed local, the GitHub head stayed unchanged, and those protections survived a full force-stop/reopen with a different host lifetime. The next step, unrelated-note convergence, stopped with `Recovery write verification failed. Sync stopped.` A read-only pull found a zero-byte temporary engine journal record at sequence 226; it was never committed as the latest record. The full result is [retained here](android-v2-configuration-restart-result.json). Automatic sync remains paused. No success is claimed for the complete scenario.

The preserved journal is in `/tmp/github-v2-android-journal-write-failure`. Free emulator storage was 3.9 GiB; no storage-full explanation is established. Root is investigating with record IO metadata and an ordinary Sync now retry, preserving the failed result.

An ordinary production **Sync now** retry then succeeded with `Changes published · 1 held files pending`. Independent ADB and GitHub reads at `713fa085846bc77152fd39de0a604238efd90cee` confirmed local configuration revision 3 was still held, GitHub retained reviewed revision 2, and the unrelated note's revision 2 matched on both sides. [Exact readback](android-v2-configuration-restart-retry.json). This successful retry does not erase the unexplained zero-byte write or turn the original run into a pass.
