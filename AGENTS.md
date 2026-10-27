# Maintainer guide

Gitless Vault Sync is an Obsidian plugin that syncs a vault to a private GitHub repository by committing through the GitHub API. It has no server and no local `.git` checkout. This repository, `triptu/markdown-github-sync`, is the plugin's source. Personal details for the maintainer's own setup (vault paths, the vault repository, devices) live in `CLAUDE.local.md`, which git ignores; this repository is public, so keep them out of tracked files.

## Layout

- `plugin/src/main.ts`: the plugin class. Handles status, error routing, scheduling hooks and commands.
- `plugin/src/git-sync/`: the sync engine.
  - `session.ts` runs one sync.
  - `state.ts` and `store.ts` hold the journal and objects under `.git-vault-sync/`.
  - `reconcile.ts` merges.
  - `github.ts` is the API client.
  - `obsidian-vault.ts` and `native-transactions.ts` write to disk.
  - `hidden-config.ts` covers `.obsidian` settings.
  - `scheduler.ts` decides when syncs run.
- `plugin/src/ui/`: modals and settings. All user-facing wording lives in `ui/copy.ts`.
- `plugin/test/`: run with `npm test` from `plugin/` (some tests use relative paths).
- `site/`: the two static product pages, `notes/` (notes.tushar.ai) and `vaultsync/` (vaultsync.tushar.ai). Each folder is its own Vercel project and deploys on push to `main` when that folder changes. Screens and notes there are made up.
- `android/`: a native Android notes app (Kotlin, Compose) that edits the same vault. Build and test from `android/` with `./gradlew :app:testDebugUnitTest installDebug` (set `ANDROID_SERIAL` when an emulator is also attached). Test the app on an emulator, not the owner's phone: the phone carries only the release app (`io.github.triptu.notes`, built with `./gradlew :app:assembleRelease`, signed with a key configured in `~/.gradle/gradle.properties`) which holds the owner's real vault. Don't install the debug app (`io.github.triptu.notes.debug`) or anything else on the phone, and never open, tap, clear or reconfigure the release app; updating it with `adb install -r` is fine when asked. Never connect the debug app to a real vault. Before any `adb shell input` on an emulator, check `mCurrentFocus` is the debug app. The phone can show up twice in `adb devices` (by IP and by name); pick one with `ANDROID_SERIAL`.
  - `vault/FileVaultStore.kt` writes through the sync module's `VaultFiles`, the one writer of the vault folder, so sync's compare-and-swap and the editor share a lock. Never write the folder directly.
  - `syncing/` connects the app to `android/sync`: `GitHubSync` owns the client, setup, the encrypted token and conflict settling (both versions kept inline between Git conflict markers); `SendEditsWorker` sends edits after the app leaves the screen. Sync copy lives in `syncing/SyncCopy.kt`. `adb logcat -s NotesSync` shows status changes; debug builds also log engine calls and request timings (never paths or note text).
  - Debug builds have "Load sample vault" in settings while sync isn't set up; setting up sync deletes it first. The sample notes are made up; never copy real vault content into the repo.
  - Icons are Phosphor SVGs imported with `android/tools/import-phosphor-icons.sh`.
  - `voice/` is the speaking view. `LiveSpeech` runs Android's recognizer (on-device first); on Android 13+ `MicCapture` owns the mic and feeds it through a pipe as one segmented session, and keeps a WAV for the optional OpenAI refine (`refine/`). `Transcript` stitches results across sessions; drafts live in `files/voice-drafts`, outside the vault. Copy lives in `voice/VoiceCopy.kt`. `adb logcat -s NotesVoice` shows sessions in debug builds.
  - To test speech without talking, put 16 kHz mono 16-bit PCM at the debug app's `cache/voice-test.pcm` (`run-as io.github.triptu.notes.debug`); the debug app plays it instead of the mic. Delete it afterwards. `am start ... --es theme light|dark` forces a theme in debug builds, for screenshots.

## Releasing

1. Bump the version in `package.json`, `plugin/package.json`, `plugin/package-lock.json` and `manifest.json` (at the repository root; there's no other copy), and add the version with its `minAppVersion` to `versions.json`. `npm version <version> --no-git-tag-version`, run at the root and in `plugin/`, covers the package files. Versions are plain `x.y.z`: Obsidian's plugin directory rejects anything else.
2. Add `docs/releases/<version>.md`.
3. Run `npm run check`. It typechecks, lints, tests and builds, and fails if the version fields or `versions.json` disagree.
4. Commit and push.
5. Run `git tag <version> && git push origin <version>`. The tag is the bare version with no `v`.

Pushing the tag runs `.github/workflows/release.yml`. It checks the tag matches `manifest.json`, runs `npm run check`, attests `main.js`, `manifest.json` and `styles.css` with GitHub artifact attestations, and publishes a full release, marked latest, with only those three files and the notes from `docs/releases/<version>.md`.

Obsidian installs updates for every device once a release is published; a new release must have a higher version.

The `updates` branch is frozen at 0.4.1 for devices that still run the retired updater plugin. Don't publish to it.

`npm run lint` runs Obsidian's `eslint-plugin-obsidianmd` recommended config over `plugin/src`, the same checks as the community plugin review. Keep it free of errors. The warnings it still prints are deliberate: the engine uses bare timers and falls back to `.obsidian` because it also runs under Node in tests, copy keeps the plugin's name in capitals, and settings keep `display()` until `minAppVersion` reaches 1.13.

Sync uses a fine-grained PAT with Contents read/write on the vault repository; when it expires, sync shows this in settings.

## Testing on the phone

Test on an Android phone over wireless adb. Use `adb devices` to find its serial and set `ADB_SERIAL` if more than one device is listed. Set `VAULT_DIR` to the vault's folder on the phone (for example `/sdcard/Documents/<vault>`) before running `deploy.sh`.

- `scripts/device/deploy.sh` installs `dist/` directly and restarts Obsidian.
- `node scripts/device/cdp.mjs "$(scripts/device/connect.sh)" scripts/device/<probe>.mjs` evaluates code inside the running app over Chrome DevTools.
  - `ver` reports the versions, status and visible notices.
  - `sched` reports the scheduler state.
  - `err` runs a sync and captures errors.
  - `profile` runs a sync, profiles it and lists long tasks. Write your own probe for anything else.
- Screenshot: `adb exec-out screencap -p > shot.png`. Some phones add a text warning before the PNG data; strip everything before the `\x89PNG` bytes.
- To keep the screen on while testing, run `adb shell svc power stayon true`. Undo it with `svc power stayon false`.

When Android dozes or backgrounds Obsidian, it cuts the network. DNS failures (`UnknownHostException`) then look like "offline", and `document.hidden` is true, so background syncs are skipped by design. Wake the phone before concluding something is broken.

Desktop Obsidian reads plugin files only on load, so reload the app after copying files in.

## Design rules the user cares about

- **Success is quiet, errors surface.**
  - Being offline shows only in the status bar. It becomes a notice after 6 hours without a sync.
  - Access problems open settings.
  - Other problems show one sticky notice, which clears itself when sync recovers.
  - Never add success notices or busy toasts.
- **Copy must sound human:** short and plain, with no internal codes, IDs or jargon. Keep it in `ui/copy.ts`.
- **Stay within Obsidian's design system:** use `Setting` rows and CSS variables, and make sure layouts work on a phone. In the conflict view, most of the space goes to the diff.
- **Prefer less machinery.** Don't add recovery browsers or similar features.
- **Performance matters on the phone.**
  - A no-change sync takes about 3 s, mostly waiting on the network.
  - Avoid reading or hashing the whole vault, avoid synchronous base64 on large data, and avoid serial GitHub round trips.
  - Yield to the UI in long loops.
  - Pushes are debounced: they run after 30 s without typing (at most 2 minutes after the first edit), and immediately when the app goes to the background.

## Private Obsidian APIs

`app.plugins`, `app.setting` and `app.commands` aren't public. Always reach them through guarded `Reflect` calls (see `ui/obsidian-private.ts`), and degrade gracefully when they're missing.
