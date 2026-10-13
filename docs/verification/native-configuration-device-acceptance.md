# Current production Android configuration gate

This is a new, disposable Android run. It does not reuse or modify `plugin/test/native/configuration-restart-acceptance.ts`, its branch, its vault, or any failed result. The helper invokes the **installed production** `github-vault-sync` plugin for enrollment, sync, configuration inventory, history, and restore. Its bundled GitHub client is only for synthetic fixture publication and readback. Root owns all device, production UI, GitHub, and loopback server actions.

## Build and bootstrap

The fixed physical vault is `/storage/emulated/0/Documents/Vault Sync Config Lab` (ADB may show `/sdcard/Documents/Vault Sync Config Lab`). The helper checks the Android adapter's `basePath`, not `getBasePath()`, before its first vault write. It refuses every other vault, including the existing Android labs.

From the repository root, build against the current production artifact:

```bash
node scripts/build-native-configuration-device.mjs dc3984a2da5298d8e3a651c19b8702f0999f901e6809ec2d8cc7f64e7a83d103
```

The build verifies that exact SHA-256 and writes `dist/native-configuration-device/<UUID>/{main.js,manifest.json,run.json}`. It does not build or modify production. The manifest names a new `newnative-config-<UUID>` branch. Root then creates that one private synthetic branch and starts a one-use, five-minute loopback provisioner:

```bash
node scripts/native-configuration-device-bootstrap.mjs create dist/native-configuration-device/<UUID>/run.json
node scripts/native-configuration-device-bootstrap.mjs serve dist/native-configuration-device/<UUID>/run.json
adb reverse tcp:37922 tcp:37922
```

The bootstrap verifies `your-name/vault-sync-test` is private. It never logs the credential. The helper accepts it once at `127.0.0.1:37922`, saves it only to Obsidian SecretStorage as `git-sync-config-<UUID>-android`, and saves that secret identifier in production settings. Do not copy the credential into a vault file or evidence.

Root creates the new empty vault, installs the current production `dist/github-vault-sync` files under `.obsidian/plugins/github-vault-sync/`, and installs this run's helper under `.obsidian/plugins/git-sync-native-config-device/`. Verify the installed production `main.js` SHA-256, fully restart Obsidian so the loaded production instance matches those bytes, and enable both plugins. Never install the helper in a pre-existing acceptance vault.

## Manual stage commands

Invoke **Git Sync Configuration Device Acceptance: Run next disposable Android configuration stage** from the command palette once per stage. Read `.native-config-device/<UUID>/progress.json` and the immutable `stage-*.json` files. A pending UI or restart stage stays pending and reports `waitFor`; it does not fail after an observer timeout. A `result.json` with `completed: false` is immutable: preserve the vault and branch, then build a new UUID for a retry.

1. First command checks the physical vault and production hash, provisions a fresh `config/1` enrollment, downloads the exact seed, creates `.obsidian/plugins/vault-sync-config-fixture/data.json` revision 1, and verifies that the new hidden file is held. Stage: `await-hidden-consent`.
2. In the **production** Configuration sync UI, preview and allow publication of **only that fixture path**. The UI itself calls production sync. Invoke the helper again. It confirms exact revision 1 on GitHub, publishes revision 2 plus an unrelated visible note as a synthetic remote fixture, then invokes production sync. It verifies revision 2 is deferred, revision 1 remains local, and the unrelated note downloads. Stage: `await-ui-apply`.
3. In the **production** Configuration sync UI, review and apply the one incoming revision 2. Invoke the helper **before restarting**. It confirms the UI applied exact bytes, writes a simulated stale revision 3 through the Android vault adapter, invokes production sync, and verifies revision 3 is guarded while GitHub retains revision 2. Stage: `await-restart`.
4. Fully force-stop and reopen Obsidian on the same vault; invoke the helper. It checks the host lifetime changed, the stale bytes survived, and production still guards the path. It publishes a separate local visible note through production while the previously incoming note remains exact. It records an exact guarded-publication preview. Stage: `await-guard-consent`.
5. In the **production** Configuration sync UI, review the guarded fixture and approve revision 3. Invoke the helper. It confirms exact revision 3 was published and both unrelated notes remain. It uses production file history and restore APIs to restore revision 2 from the fixture commit, publishes that restore as a new commit, writes revision 3 again as a simulated stale source, and verifies a **new source guard** holds it while GitHub retains restored revision 2. Stage: `complete`; `result.json` has `sourceGuardHeld: true`.

The final local fixture deliberately remains revision 3 under a guard; GitHub's final version is revision 2. This is the expected safe state for the source-guard check. Root should independently read the result, installed production SHA, local fixture and note bytes, GitHub head, and relevant production UI screens. The helper's JSON records API and byte checks; root's screen observation is the evidence for the taps.
