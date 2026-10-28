# Gitless Vault Sync

Sync your Obsidian vault with a private GitHub repository, on desktop and mobile. No server, no Git on your device.

[Install in Obsidian](https://community.obsidian.md/plugins/github-vault-sync) · [Website](https://vaultsync.tushar.ai/) · [Guide](docs/guide.md)

[![A short film of the plugin in Obsidian: typing in a note, an edit arriving from a phone, resolving a conflict and restoring an old version. Click to watch it.](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/site/vaultsync/poster.jpg)](https://vaultsync.tushar.ai/)

Your notes stay in a repository you own, with history you can browse on GitHub.

## What you get

![The plugin's settings in Obsidian, connected to a repository and showing the last sync time, automatic sync, Obsidian settings sync and history](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/settings.png)

**Sync runs on its own.** It runs after you pause typing and when you leave Obsidian.

![The conflict view for one note, with this device's paragraph in green and GitHub's in blue, and buttons to keep either, keep both, or edit and combine](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/conflict.png)

**Edits merge on their own.** Changes to different files, or to separate parts of a note, combine without asking. When they clash, you pick this device's version, GitHub's, both as two notes, or a combination you edit.

![File history for a note, listing its versions by device and time, with one version previewed and a Restore this version button](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/file-history.png)

**Every note keeps its history.** File history lists a note's past versions from all your devices. Preview one and restore it as a new change.

![The review step for settings arriving from another device, listing Appearance and Hotkeys with an Apply 2 updates button](https://raw.githubusercontent.com/triptu/markdown-github-sync/main/docs/images/settings-review.png)

**Themes, hotkeys and plugins sync too.** You review them before they change on another device.

[Notes for Android](https://notes.tushar.ai/) edits and syncs the same vault on an Android phone.

## Install

In Obsidian, go to Settings → Community plugins → Browse and search for Gitless Vault Sync, or open its [plugin page](https://community.obsidian.md/plugins/github-vault-sync). Create one private repository on GitHub with "Add a README file" ticked. Then, on each device:

1. Turn off any other sync plugin, then enter the repository in this plugin's settings.
2. Click Create token. GitHub's token form opens with the permissions filled in (Contents read and write). Pick just that repository on the form, and paste the token back into settings.
3. Click Connect, look over what the first sync will do, and click Start syncing.

The [guide](docs/guide.md) covers what doesn't sync and troubleshooting.

## Privacy

The plugin connects only to GitHub. GitHub can read your notes; they aren't end-to-end encrypted. It sends no telemetry. The [guide](docs/guide.md#privacy-and-network-use) lists every host and folder it touches.
