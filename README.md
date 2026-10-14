# GitHub Vault Sync

An Obsidian plugin that syncs a vault through ordinary commits in a private GitHub repository, on desktop and Android. There's no server and no local Git checkout: the plugin talks to the GitHub API directly.

Maintainers and agents: start with [AGENTS.md](AGENTS.md). Release notes are in [docs/releases](docs/releases/).

## How it works

Each device keeps a local journal under `.git-vault-sync/` (excluded from sync) and commits its changes to GitHub. Sync runs while Obsidian is open: 30 seconds after you stop typing (at most 2 minutes after the first edit), when you leave Obsidian, when you come back, and every five minutes. **Sync now** runs one immediately.

Edits to different files, or to different parts of the same note, merge automatically. Overlapping edits become conflicts: the conflict view shows a line diff of this device's version against GitHub's, and you keep either, keep both, or edit a combined version. Large deletions and incoming changes to Obsidian settings and plugins wait for your review. Successful syncs stay quiet; being offline shows only in the status bar, and other problems show one notice that clears itself once sync recovers.

**File history** lets you preview a note's past versions and restore one as a local edit that syncs normally.

## Add a device

With `gh` logged in, download the newest release into the vault. On a Mac, Obsidian lists its vault paths in `~/Library/Application Support/obsidian/obsidian.json`.

```sh
vault=~/path/to/vault   # change to yours
tag=$(gh release list -R triptu/cloud-vault-sync -L 1 --json tagName --jq '.[0].tagName')
mkdir -p "$vault/.obsidian/plugins" && cd "$vault/.obsidian/plugins" \
  && gh release download "$tag" -R triptu/cloud-vault-sync -p '*.zip' --clobber \
  && unzip -oq github-vault-sync.zip && unzip -oq github-vault-sync-updater.zip && rm github-vault-sync*.zip
```

Or download both zips from the [latest release](https://github.com/triptu/cloud-vault-sync/releases) and unzip them into `.obsidian/plugins/`. On a phone, copy the two folders over USB. From then on the updater keeps the device current.

## Connect

Requires Obsidian 1.11.4+. These steps happen in Obsidian and need you: an agent can install the files but can't create the token or click Connect.

1. Enable **GitHub Vault Sync** and **GitHub Vault Sync Updater** in Settings → Community plugins. Turn off any other sync plugin first.
2. In GitHub Vault Sync's settings, enter the repository and branch, and paste a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) with Contents read/write and Metadata read on the vault's repository, plus Contents read on this one (for updates). A `.git` folder in the vault is left alone and never synced; once connected, stop using Git there.
3. Click **Connect**, review the first sync, then **Start syncing**.

Set up each device separately; never copy `.git-vault-sync/` between devices.

## Build from source

Requires Node 22+, npm and zip.

```sh
npm run setup
npm run check
npm run package
```

The plugins are in `dist/github-vault-sync/` and `dist/github-vault-sync-updater/`; copy each folder into `<vault>/.obsidian/plugins/`.

## Limits

- Files up to 8 MiB; vaults up to 128 MiB. Git LFS, symlinks, submodules and colliding paths aren't supported.
- GitHub can read your notes; this isn't end-to-end encrypted. Sync refuses public repositories.
- `.obsidian` settings, themes and plugins sync with review; workspace files, credentials and the journal stay local. A root `.gitignore` excludes paths.
- Android suspends Obsidian in the background, so leave it open until it shows synced before switching devices.
