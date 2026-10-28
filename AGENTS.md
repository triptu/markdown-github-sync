# Maintainer guide

Gitless Vault Sync is an Obsidian plugin that syncs a vault to a GitHub repository by committing through the GitHub API. It has no server and no local `.git` checkout. This repository, `triptu/markdown-github-sync`, is the plugin's source. Personal details for the maintainer's own setup (vault paths, the vault repository, devices) live in `CLAUDE.local.md`, which git ignores; this repository is public, so keep them out of tracked files.

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
- `site/vaultsync/`: the static product page for vaultsync.tushar.ai. It's its own Vercel project and deploys on push to `main` when that folder changes. Screens and notes there are made up.

The Android app, Notes for Android, lives in [triptu/notes](https://github.com/triptu/notes) and consumes this repository's engine (`plugin/src/git-sync`, plus `plugin/src/ui/copy.ts`) as a git submodule, so keep engine changes working under its QuickJS bundle too.

## Working on the code

Requires Node 22 or newer and npm. Run these from the repository root:

```sh
npm run setup     # install dependencies
npm run check     # typecheck, lint, test, build and check release metadata
npm run build     # build the plugin into dist/github-vault-sync/
```

`check` already builds. To try a build, copy `dist/github-vault-sync/` into `<vault>/.obsidian/plugins/` (create `plugins/` if it's missing, and keep the folder name, which is the plugin id). Ask for the vault path if you don't know it; for a throwaway vault, any folder with an empty `.obsidian/` will do. Then the person reloads Obsidian and enables the plugin under Settings → Community plugins. Desktop Obsidian reads plugin files only on load. For a phone, see "Testing on the phone" below.

The README is the plugin's product page; Obsidian's plugin directory shows it. Keep commands and internals out of it. User-facing detail (when sync runs, what doesn't sync, troubleshooting) goes in `docs/guide.md`; anything for working on the code goes here.

## Releasing

1. Bump the version in `package.json`, `plugin/package.json`, `package-lock.json` and `manifest.json` (at the repository root; there's no other copy), and add the version with its `minAppVersion` to `versions.json`. `npm version <version> --no-git-tag-version --workspaces --include-workspace-root`, run at the root, covers the package files. Versions are plain `x.y.z`: Obsidian's plugin directory rejects anything else.
2. Add `docs/releases/<version>.md`.
3. Run `npm run check`. It typechecks, lints, tests and builds, and fails if the version fields or `versions.json` disagree.
4. Commit the bump, but don't push `main` yet.
5. Run `git tag <version> && git push origin <version>`. The tag is the bare version with no `v`. Pushing only the tag uploads the commit without moving `main`.
6. Wait for the Release workflow to publish (`gh run watch`, or `gh release view <version>` until it exists).
7. Push `main`.

Obsidian's plugin directory reads `manifest.json` from `main` and looks for a release with that version, so `main` must move only after the release exists; pushing both together leaves a window in which the directory reports that no release matches the manifest.

Pushing the tag runs `.github/workflows/release.yml`. It checks the tag matches `manifest.json`, runs `npm run check`, attests `main.js`, `manifest.json` and `styles.css` with GitHub artifact attestations, and publishes a full release, marked latest, with only those three files and the notes from `docs/releases/<version>.md`.

Obsidian installs updates for every device once a release is published; a new release must have a higher version.

`npm run lint` runs Obsidian's `eslint-plugin-obsidianmd` recommended config over `plugin/src`, the same checks as the community plugin review. Keep it free of errors. The warnings it still prints are deliberate: the engine uses bare timers and falls back to `.obsidian` because it also runs under Node in tests and in the Android app, copy keeps the plugin's name in capitals, and settings keep `display()` until `minAppVersion` reaches 1.13.

The review installs and builds from the repository root, so `plugin/` is an npm workspace and its one lockfile is the root `package-lock.json`. Without a lockfile at the root the review can't resolve the `obsidian` types and reports every API call as unsafe.

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
