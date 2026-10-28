# Gitless Vault Sync guide

The [README](../README.md) covers what the plugin is and how to set it up. This page has the details.

## Setting up

- The repository can't be empty, so tick **Add a README file** when you create it. Enter it in settings as `your-name/notes`, with the branch (usually `main`).
- Turn off any other sync plugin (Obsidian Git, Self-hosted LiveSync, Remotely Save) before enabling Gitless Vault Sync.
- The token is a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to only your notes repository: Contents read and write, and Metadata read. The **Create token** link in settings opens this form with the permissions filled in. Obsidian keeps the token in its secret storage.
- Repeat the setup on each device. Don't copy the `.git-vault-sync/` folder between devices.
- If the vault already has a `.git` folder, it's left alone and never synced. Once connected, stop using Git in that folder.

The plugin's page in Obsidian opens with the link `obsidian://show-plugin?id=github-vault-sync`.

### Installing from a release

Instead of the community plugin directory, you can download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/triptu/markdown-github-sync/releases/latest) into `.obsidian/plugins/github-vault-sync/` in your vault.

## When sync runs

Sync runs while Obsidian is open:

- 30 seconds after you stop typing, and at most 2 minutes after the first edit
- when you leave Obsidian, and when you come back
- every 5 minutes

**Sync now** in settings or the command palette runs one immediately.

Successful syncs stay quiet. Being offline shows only in the status bar, and becomes a notice after 6 hours without a sync. A problem with the token or repository opens settings. Other problems show one notice that clears itself once sync recovers.

## Conflicts and review

**Conflicts.** The conflict view shows a line diff of this device's version against GitHub's. You keep either one, keep both, or edit a combined version.

**Changes that wait for review.** Large deletions, and incoming changes to Obsidian settings and plugins, pause until you approve them. The settings folder (`.obsidian`, or whatever you've named it) changes only after you approve.

**Past syncs.** The **Sync history** and **File history** commands list what changed and when. File history previews a note's past versions and restores one.

## What doesn't sync

- this plugin's own folder and local journal (`.git-vault-sync/`)
- workspace layout files and Obsidian's cache
- `.git`, `.trash` and OS files such as `.DS_Store`
- files that look like credentials, such as `.env`, `*.pem` and `*.key`
- anything matched by a `.gitignore` at the vault root

Git LFS, symlinks, submodules and nested `.gitignore` files aren't supported. Neither are two paths that differ only in letter case.

## Troubleshooting

- **"Branch wasn't found, or the repository is empty."** Check the branch name, and make sure the repository has at least one commit.
- **Access denied.** Check that the token has Contents read and write on the repository, and that it hasn't expired. When the token expires, sync stops; updates keep working.
- **Android.** Android pauses Obsidian in the background and cuts its network. Leave Obsidian open until it shows synced before you switch devices.

## Development

Building, testing and releasing are described for coding agents in [AGENTS.md](../AGENTS.md). Release notes are in [releases](releases/).
