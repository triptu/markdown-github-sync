# Gitless Vault Sync

Sync your Obsidian vault through ordinary commits in a private GitHub repository, on desktop and mobile. No server, no local Git. The plugin talks to the GitHub API directly, and your history is plain Git you can browse on GitHub.

[Website](https://vaultsync.tushar.ai/) · [Install in Obsidian](https://community.obsidian.md/plugins/github-vault-sync) · [Latest release](https://github.com/triptu/markdown-github-sync/releases/latest) · [Guide](docs/guide.md)

[![A forty-second film of the plugin in Obsidian. Click to watch it on vaultsync.tushar.ai.](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/site/vaultsync/poster.jpg)](https://vaultsync.tushar.ai/)

Writing on Android? [Notes for Android](https://notes.tushar.ai/) ([source](https://github.com/triptu/notes)) edits the same vault and syncs through the same engine.

## What it does

**Connect a repository and forget about it.** Syncs run after you pause typing and when you leave Obsidian. Successful syncs stay quiet. Problems show once, and clear themselves when sync recovers.

![The plugin's settings in Obsidian, connected to a repository and showing the last sync time, automatic sync, settings sync and history](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/settings.png)

**Edits merge on their own.** Changes to different files, or different parts of the same note, combine without asking. Overlapping edits open a conflict view with a diff, where you keep either side, both, or a combined version.

![The conflict view for one note, with this device's paragraph in green and GitHub's in blue, and buttons to keep either, keep both, or edit and combine](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/conflict.png)

**Every version of every note.** File history lists a note's past versions from all your devices, previews one and restores it as a new change.

![File history for a note, listing its versions by device and time, with one version previewed and a Restore this version button](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/file-history.png)

**Obsidian settings sync too.** Themes, hotkeys and plugins follow your notes, with a review step before they change on another device.

![The review step for settings arriving from another device, listing Appearance and Hotkeys with an Apply 2 updates button](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/settings-review.png)

## Install

In Obsidian, open Settings → Community plugins → Browse and search for **Gitless Vault Sync**. You can also open it from the [plugin directory](https://community.obsidian.md/plugins/github-vault-sync) or with the link `obsidian://show-plugin?id=github-vault-sync`.

## Set up

1. Create a private repository on GitHub with **Add a README file** ticked, so it isn't empty.
2. Turn off any other sync plugin, then enable Gitless Vault Sync and enter the repository and branch in its settings.
3. Click **Create token** in settings. It opens GitHub's fine-grained token form with the permissions filled in: Contents read and write, and Metadata read, for just that repository. Paste the token back into settings.
4. Click **Connect**, look over what the first sync will do, then **Start syncing**.

Repeat on each device. The [guide](docs/guide.md) covers when sync runs, what doesn't sync, review, troubleshooting and development.

## Limits

- It's in beta.
- GitHub only, and only private repositories. GitHub can read your notes; they aren't end-to-end encrypted.
- Files up to 8 MiB each, vaults up to 128 MiB in total.
- Needs Obsidian 1.11.4 or newer.

## Privacy and network use

- The plugin connects only to GitHub: `api.github.com` (REST and GraphQL) for the repository, and `codeload.github.com` to download a commit's files in one go.
- `github.com` is only opened in your browser, when you click the link to create a token or to view a commit. The plugin makes no requests to it.
- Your token stays in Obsidian's secret storage on each device and is sent only to GitHub.
- It uploads your notes and the Obsidian settings that sync to the repository you choose. It reads only files inside the vault, and keeps its journal in `.git-vault-sync/` there.
- It uses base64 (`atob` and `btoa`) only because GitHub's API sends and receives file contents as base64. Nothing is hidden or obfuscated; the code is open source.
- It writes to the clipboard only when you tap **Copy link** next to the token field, and never reads it.
- No telemetry, analytics or ads. It's free and open source.
