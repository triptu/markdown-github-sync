# Maintainer guide

GitHub Vault Sync is an Obsidian plugin that syncs a vault to a private GitHub repository by committing through the GitHub API. It has no server and no local `.git` checkout. Its one real user syncs the vault `notes` (repository `your-name/notes`) between a Mac and an Android phone. This repository, `triptu/cloud-vault-sync`, is the plugin's source.

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

## Releasing

1. Bump the version in `package.json`, `plugin/package.json`, `plugin/package-lock.json` and `plugin/manifest.json`.
2. Add `docs/releases/<version>.md`.
3. Run `npm run check`.
4. Commit and push.
5. Run `npm run publish-update`. This builds the plugin and force-pushes a single commit to the `updates` branch, containing `latest.json` (the version plus a SHA-256 for each file) and `latest/*`.
6. Run `gh release create <version> dist/github-vault-sync.zip --prerelease -F docs/releases/<version>.md`. This step is only for the record; devices don't read releases.

Every device with the updater installs the new version within about 6 hours. You can also run the command "Check for GitHub Vault Sync update" from the command palette. If the new version fails to load, the updater restores the old files and never retries that version. To ship a fix, publish a higher version number.

The updater itself never updates automatically, so keep it small and stable. To change it, bump `plugin/updater/manifest.json` and copy `dist/github-vault-sync-updater/*` into `.obsidian/plugins/github-vault-sync-updater/` on one device. Config sync carries it to the other devices once the change is approved under Obsidian settings.

The updater reads the token through the sync plugin's `data.json` (`secretId`), from Obsidian's secret storage. The token is a fine-grained PAT. It needs Contents read/write on `your-name/notes` and Contents read on `triptu/cloud-vault-sync`. If the token expires, both sync and updates stop. Sync shows this in settings; the updater fails silently.

## Testing on the phone

The phone is an Android phone on wireless adb. Use `adb devices` to find its serial and set `ADB_SERIAL` if more than one device is listed. The vault is at `/sdcard/Documents/vault`.

- `scripts/device/deploy.sh` installs `dist/` directly and restarts Obsidian.
- `node scripts/device/cdp.mjs "$(scripts/device/connect.sh)" scripts/device/<probe>.mjs` evaluates code inside the running app over Chrome DevTools.
  - `ver` reports the versions, status and visible notices.
  - `sched` reports the scheduler state.
  - `err` runs a sync and captures errors.
  - `profile` runs a sync, profiles it and lists long tasks. Write your own probe for anything else.
- Screenshot: `adb exec-out screencap -p > shot.png`. Some phones add a text warning before the PNG data; strip everything before the `\x89PNG` bytes.
- To keep the screen on while testing, run `adb shell svc power stayon true`. Undo it with `svc power stayon false`.

When Android dozes or backgrounds Obsidian, it cuts the network. DNS failures (`UnknownHostException`) then look like "offline", and `document.hidden` is true, so background syncs are skipped by design. Wake the phone before concluding something is broken.

The desktop vault is `~/vault`. Desktop Obsidian reads plugin files only on load, so reload the app after copying files in.

## Design rules the user cares about

- **Success is quiet, errors surface.**
  - Being offline shows only in the status bar. It becomes a notice after 6 hours without a sync.
  - Access problems open settings.
  - Other problems show one sticky notice, which clears itself when sync recovers.
  - Never add success notices or busy toasts.
- **Copy must sound human:** short and plain, with no internal codes, IDs or jargon. Keep it in `ui/copy.ts`.
- **Stay within Obsidian's design system:** use `Setting` rows and CSS variables, and make sure layouts work on a phone. In the conflict view, most of the space goes to the diff.
- **Prefer less machinery.** The user removed a "local recovery" feature as overengineered. Don't bring back recovery browsers or similar features.
- **Performance matters on the phone.**
  - A no-change sync takes about 3 s, mostly waiting on the network.
  - Avoid reading or hashing the whole vault, avoid synchronous base64 on large data, and avoid serial GitHub round trips.
  - Yield to the UI in long loops.
  - Pushes are debounced: they run after 30 s without typing (at most 2 minutes after the first edit), and immediately when the app goes to the background.

## Private Obsidian APIs

`app.plugins`, `app.setting` and `app.commands` aren't public. Always reach them through guarded `Reflect` calls (see `ui/obsidian-private.ts` and `updater/main.ts`), and degrade gracefully when they're missing.
