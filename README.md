# GitHub Vault Sync

An Obsidian plugin that syncs a vault through ordinary commits in a private GitHub repository, on desktop and Android. There's no server and no local Git checkout: the plugin talks to the GitHub API directly.

Maintainers and agents: start with [AGENTS.md](AGENTS.md). Release notes are in [docs/releases](docs/releases/).

## How it works

Each device keeps a local journal under `.git-vault-sync/` (excluded from sync) and commits its changes to GitHub. Sync runs while Obsidian is open: 30 seconds after you stop typing (at most 2 minutes after the first edit), when you leave Obsidian, when you come back, and every five minutes. **Sync now** runs one immediately.

Edits to different files, or to different parts of the same note, merge automatically. Overlapping edits become conflicts: the conflict view shows a line diff of this device's version against GitHub's, and you keep either, keep both, or edit a combined version. Large deletions and incoming changes to Obsidian settings and plugins wait for your review. Successful syncs stay quiet; being offline shows only in the status bar, and other problems show one notice that clears itself once sync recovers.

**File history** lets you preview a note's past versions and restore one as a local edit that syncs normally.

## Install

Requires Node 22+, npm and zip to build, and Obsidian 1.11.4+.

```sh
npm run setup
npm run check
npm run package
```

1. Copy `main.js`, `manifest.json` and `styles.css` from `dist/github-vault-sync/` into `<vault>/.obsidian/plugins/github-vault-sync/` and enable **GitHub Vault Sync**. Turn off any other sync plugin first.
2. In its settings, paste a fine-grained GitHub token with Contents read/write and Metadata read on the vault's private repository. Repository and branch are filled from the vault's `.git` folder when present (that folder is set aside under `.git-vault-sync/previous-git/`).
3. Click **Connect**, review the first sync, then **Start syncing**.

Set up each device separately; copy only the plugin files, never `.git-vault-sync/`.

For automatic updates, also copy `dist/github-vault-sync-updater/` to `.obsidian/plugins/github-vault-sync-updater/` and enable **GitHub Vault Sync Updater**. It installs new versions from this repository's `updates` branch with the same token, so the token also needs Contents read on this repository.

## Limits

- Files up to 8 MiB; vaults up to 128 MiB. Git LFS, symlinks, submodules and colliding paths aren't supported.
- GitHub can read your notes; this isn't end-to-end encrypted. Sync refuses public repositories.
- `.obsidian` settings, themes and plugins sync with review; workspace files, credentials and the journal stay local. A root `.gitignore` excludes paths.
- Android suspends Obsidian in the background, so leave it open until it shows synced before switching devices.
