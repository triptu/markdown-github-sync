# Native Android conflict acceptance

## Scope and artifact

- Obsidian 1.14.4 on the Android 15 `lb_pixel_35` emulator; disposable vault **only** at `/sdcard/Documents/Vault Sync Lab`.
- Private test repository **only**: `your-name/vault-sync-test`, branch `native-android-1791894436601`.
- Final installed production `main.js` SHA-256: `3d076efb958be8cc672a6e76f754af171d9bdf13ed9c94fae2c05a6941dae4ea` (read back from the device). The native helper refuses to run unless this exact hash, vault name, repository, branch, and SecretStorage credential reference match.
- Source: `plugin/test/native/conflict-acceptance.ts`; build: `node scripts/build-native-conflict.mjs`. The helper loaded the installed production plugin through Obsidian's plugin manager. It used its own GitHub client only to create fresh remote fixture commits and read them back. The credential stayed in Obsidian SecretStorage.

## Final-build results

The helper first created a fresh pair under `Native Automatic Acceptance 0161cb96-3c93-49d5-aa04-7107ad072813`: one file through the native vault and one on GitHub. With automatic sync enabled and without calling Sync now, both files converged at commit `4c8d17538da2e67adb9d7e34f80002cfb9be88c8`. I force-stopped and reopened Obsidian. The helper then read the enrolled checkpoint, both native files, and both GitHub blobs again; all seven recorded post-restart checks passed in [the automatic result](android-conflict-final-auto-result.json). The pre-restart progress reported eight passed checks, including automatic convergence.

The controlled conflict run used new fixture paths under `Native Conflict Acceptance b65a6c04-a396-441e-bcce-238c6cb1c95a`. It paused automatic sync temporarily and restored the prior `automatic: true` setting at the end. All 28 checks passed in [the conflict result](android-conflict-final-result.json):

1. Different Android and GitHub edits to the same line appeared in the production Changes inbox. The Android bytes stayed unchanged while awaiting review. [Inbox](android-conflict-final-inbox.png) · [review](android-conflict-final-review.png).
2. The helper recorded a reviewed merged-note decision through the production session. The native note and GitHub blob at accepted commit `af210b42756744690e64ff92f22b195b53e72feb` both contained exactly `Reviewed and accepted exact merged bytes.\n`.
3. A later GitHub commit `8758d8add87665d3e7fb3a2dfa70f1b8b00463e6` changed an existing binary and removed an existing note. The deletion required explicit review. After accepting that deletion, the production Changes screen held **both** the binary replacement and native deletion. Both local files retained their original bytes. [Blocked screen](android-conflict-final-blocked.png).
4. Production recovery records held the original binary and deleted-note preimage, plus the incoming binary. `exportRecoveryCopy` wrote separate hidden exports; the helper read their bytes back and matched both versions exactly.

A separate host-side `gh api` readback checked the automatic pair, accepted merged note, incoming binary, and absence of the deleted note directly from GitHub blobs and trees. It also confirmed the branch head was `8758d8add87665d3e7fb3a2dfa70f1b8b00463e6` at verification time. The production bundle hash and `automatic: true` setting were read back from the device after the run.

An earlier run against installed r6 SHA-256 `ec5bdc4733965108546c160d85cdc65e0d6bcde282f549d9f403d8255b2fb646` also passed its 27 checks: [r6 result](android-conflict-r6-result.json), [inbox](android-conflict-r6-inbox.png), [review](android-conflict-r6-review.png), [blocked screen](android-conflict-r6-blocked.png). It is superseded by the final-build run above.

These are emulator runs. They do not cover a physical Android device, arbitrary OS interruption during a file write, or a fine-grained GitHub PAT. The final build's ancestry-lookup failure path is covered by core tests, not by this native scenario.
