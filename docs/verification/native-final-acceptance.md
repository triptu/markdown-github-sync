# Final production acceptance harness

This helper runs **inside official Obsidian** as a separate community plugin. It calls the **loaded, installed `github-vault-sync` plugin instance** for enrollment, automatic scheduling, `syncOnce`, conflict decisions, file history, and restore. The helper bundles `GitHubRepository` and codec code only to publish and inspect synthetic GitHub fixtures; those bundled classes are not evidence that the installed production engine works. Root must independently observe any claimed UI interaction.

The helper performs no action on load. Root invokes **Git Sync Final Acceptance: Run next disposable final acceptance stage** in the command palette. It writes stage and result JSON under `.native-final-acceptance/<run UUID>/` inside each vault. Any failed result is final for that UUID; retain the vault and GitHub branch and build a new run for a retry. Do not relabel a failed result as a pass.

## Fixed vault boundary

- Desktop: `/tmp/github-vault-sync-desktop-v2-1791919653/Vault Sync Lab` with the isolated `../profile`, official Obsidian 1.14.4.
- Android: **new** `/sdcard/Documents/Vault Sync Final Lab`, official Obsidian. The older `/sdcard/Documents/Vault Sync Lab` is refused and must remain untouched.
- Both vaults must have no existing visible files before their first helper command. Existing `.obsidian` files may remain. The production plugin must be unconfigured and unenrolled. The helper fails closed on an unknown vault path, a different installed bundle hash, a public/wrong repository, an unexpected enrollment preview, or pre-existing visible files.
- The only remote target is the private `your-name/vault-sync-test` repository, on a new `native-final-<UUID>` branch. Run the devices **sequentially**, desktop first, then Android. Never use `your-name/notes`.

The desktop adapter supplies `getBasePath()`; the observed Android Capacitor adapter supplies `basePath`, exactly `/storage/emulated/0/Documents/Vault Sync Final Lab`. The helper checks that canonical Android path, which ADB also exposes through `/sdcard`. Unknown paths are refused. This adapter difference was inspected before starting Android acceptance; the corrected helper uses a fresh run UUID.

## Build and branch setup

From the repository root, use the exact current production bundle SHA-256 (the build verifies it). The tested build command for the current artifact is:

```bash
shasum -a 256 dist/github-vault-sync/main.js
node scripts/build-native-final-acceptance.mjs a85020d6205f2efbcf777074e47d896f4acafc69e7385744a48d2e2cfa4ecad5
```

The build prints a fresh UUID and writes `dist/native-final-acceptance/<UUID>/{main.js,manifest.json,run.json}`. If production dist changes, use its **new** SHA in the build command; never reuse a bundle whose embedded SHA differs. The build does not rebuild production dist. For the helper prepared in this repository, the UUID is `22e20410-660e-408c-83b1-9f53e9a1e5eb` and the run manifest is `dist/native-final-acceptance/22e20410-660e-408c-83b1-9f53e9a1e5eb/run.json`.

Root creates the branch once, using the run manifest printed by the build:

```bash
node scripts/native-final-bootstrap.mjs create dist/native-final-acceptance/<UUID>/run.json
```

This writes the seed commit SHA into **that run manifest only**. It does not overwrite `docs/verification/native-lab-config.json` or any Android vault file. The bootstrap checks private repository identity and uses `gh auth token` without printing it.

## Install and provision each device

Root installs the current `dist/github-vault-sync` production files in the chosen disposable vault's `.obsidian/plugins/github-vault-sync/`, and the run-specific helper `main.js` and `manifest.json` in `.obsidian/plugins/git-sync-native-final/`. Verify the installed production `main.js` SHA-256 equals the run manifest. Fully restart Obsidian after replacing production files so the **loaded** instance matches those bytes. Do not install or update either plugin in the old Android vault.

For each device, root starts a separate one-use provisioner before the first helper command:

```bash
node scripts/native-final-bootstrap.mjs serve dist/native-final-acceptance/<UUID>/run.json desktop
# On Android use: ... serve dist/native-final-acceptance/<UUID>/run.json android
```

For Android, root also maps the emulator's `127.0.0.1:37921` to the host provisioner with `adb reverse tcp:37921 tcp:37921` before invoking the command. The server binds host loopback, allows one matching `/bootstrap/<UUID>/<device>` request, expires after five minutes, and never logs the token. The helper stores it in Obsidian SecretStorage under `git-sync-final-<UUID>-<device>`; production settings contain only this secret identifier. Do not copy a token into a settings file or evidence.

## Stage sequence for each device

1. **First command:** exact physical vault path and installed production hash are checked, then the helper provisions SecretStorage, saves visible-only production settings, reviews the exact download-only enrollment preview, enrolls, and syncs the seed. It directly publishes one remote fixture and creates a distinct local fixture. Production automatic foreground sync must converge both without `syncNow`. The helper writes `<device>-await-restart.json`.
2. **Full app restart:** root force-stops/reopens the actual app, with the same vault and plugins. Invoke the helper command again. It checks a new host lifetime, persisted checkpoint, exact local bytes, and exact remote bytes; then pauses automatic sync and creates a visible `<device>-editor.md` note. It writes `<device>-await-editor.json`.
3. **Visible editor save:** root opens that note in Obsidian and replaces its entire text with `Edited and saved in Obsidian for final acceptance <UUID>.` followed by one newline. Wait for the native file to save, then invoke the helper command. It verifies the saved native bytes and calls production `syncOnce`; GitHub must contain those exact bytes. The helper records `controlled`. Its JSON proves saved bytes and publication; root's separate screen observation supports any editor UI claim. Do not use the prior extensionless hidden FileView probe as a substitute.
4. **Controlled production API run:** invoke the command again. The helper downloads remote text and binary fixtures, syncs independent local/remote edits in one ordinary nonconflicting round, captures a same-file conflict, records a reviewed exact merge, syncs it, applies a remote binary replacement and deletion, reads production file history, previews and restores the original historical version, and publishes that restored version as a new commit. It restores the original automatic setting and writes `<device>-result.json` with `completed: true` only after all checks pass.

All fixture paths include the fresh UUID and device. Intermediate commits and check names are in stage JSON. `phase: local-changes` alone is not treated as failure: an unapproved local hidden addition can produce it. The acceptance checks exact fixture bytes, commit identity, no active conflict/block/pause, and the relevant production API outcomes. The helper does not claim to have exercised production UI conflict or restore controls; root may inspect those separately.

## Independent acceptance readback

Root should compare the installed production hash, result UUID and branch, exact local Markdown and binary bytes, and GitHub head contents. Confirm deleted file absence, restored historical bytes at the new head, and no unexpected extra apply commit. Save independent observations outside the vault before disabling the helper. A `completed: true` result from one device does not imply the other device passed. Preserve the entire failed vault, stage JSON, and branch if any step fails; do not rerun that UUID.
