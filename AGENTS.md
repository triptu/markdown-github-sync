# Maintainer guide

GitHub Vault Sync is an Obsidian plugin that syncs a vault to a private GitHub repository by committing through the GitHub API. It has no server and no local `.git` checkout. This repository, `triptu/markdown-github-sync`, is the plugin's source. Personal details for the maintainer's own setup (vault paths, the vault repository, devices) live in `CLAUDE.local.md`, which git ignores; this repository is public, so keep them out of tracked files.

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
- `plugin/updater/`: the companion **GitHub Vault Sync Updater** plugin. `core.ts` holds the logic and has no Obsidian imports.
- `plugin/test/`: run with `npm test` from `plugin/` (some tests use relative paths).
- `android/`: a native Android notes app (Kotlin, Compose) that edits the same vault. Build and test from `android/` with `./gradlew :app:testDebugUnitTest installDebug` (set `ANDROID_SERIAL` when an emulator is also attached). Two installs coexist on the phone: the debug app (`io.github.triptu.notes.debug`) is for agents and test repos; the release app (`io.github.triptu.notes`, built with `./gradlew :app:assembleRelease`, signed with a key configured in `~/.gradle/gradle.properties`) holds the owner's real vault. Never open, tap, clear or reconfigure the release app, and never connect the debug app to a real vault. Before any `adb shell input`, check `mCurrentFocus` is the debug app. The phone can show up twice in `adb devices` (by IP and by name); pick one with `ANDROID_SERIAL`.
  - `vault/FileVaultStore.kt` writes through the sync module's `VaultFiles`, the one writer of the vault folder, so sync's compare-and-swap and the editor share a lock. Never write the folder directly.
  - `syncing/` connects the app to `android/sync`: `GitHubSync` owns the client, setup, the encrypted token and conflict settling (both versions kept inline between Git conflict markers); `SendEditsWorker` sends edits after the app leaves the screen. Sync copy lives in `syncing/SyncCopy.kt`. `adb logcat -s NotesSync` shows status changes; debug builds also log engine calls and request timings (never paths or note text).
  - Debug builds have "Load sample vault" in settings while sync isn't set up; setting up sync deletes it first. The sample notes are made up; never copy real vault content into the repo.
  - Icons are Phosphor SVGs imported with `android/tools/import-phosphor-icons.sh`.

## Releasing

1. Bump the version in `package.json`, `plugin/package.json`, `plugin/package-lock.json` and `plugin/manifest.json`.
2. Add `docs/releases/<version>.md`.
3. Run `npm run check`.
4. Commit and push.
5. Run `npm run publish-update`. This builds the plugin and force-pushes a single commit to the `updates` branch, containing `latest.json` (the version plus a SHA-256 for each file) and `latest/*`.
6. Run `gh release create <version> dist/github-vault-sync.zip dist/github-vault-sync-updater.zip --latest -F docs/releases/<version>.md`. Publish it as a full release, not a pre-release: the beta in the version number is not a reason to mark it as one, and pre-releases are hidden from "latest release" lookups. New devices install from these zips; existing ones update from the `updates` branch.

Every device with the updater installs the new version within about 6 hours. You can also run the command "Check for GitHub Vault Sync update" from the command palette. If the new version fails to load, the updater restores the old files and never retries that version. To ship a fix, publish a higher version number.

The updater itself never updates automatically, so keep it small and stable. To change it, bump `plugin/updater/manifest.json` and copy `dist/github-vault-sync-updater/*` into `.obsidian/plugins/github-vault-sync-updater/` on one device. Config sync carries it to the other devices once the change is approved under Obsidian settings.

The updater needs no token: it reads `latest.json` and `latest/*` from the public `updates` branch through raw.githubusercontent.com and checks each file's SHA-256. Sync uses a fine-grained PAT with Contents read/write on the vault repository; when it expires, sync shows this in settings.

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

`app.plugins`, `app.setting` and `app.commands` aren't public. Always reach them through guarded `Reflect` calls (see `ui/obsidian-private.ts` and `updater/main.ts`), and degrade gracefully when they're missing.
