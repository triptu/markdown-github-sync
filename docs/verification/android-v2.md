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
