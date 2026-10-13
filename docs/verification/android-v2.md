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
