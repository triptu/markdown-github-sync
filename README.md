# GitHub Vault Sync

An Obsidian plugin that syncs a vault through ordinary commits in a private GitHub repository, on desktop and mobile. There's no server and no local Git checkout. The plugin talks to the GitHub API directly. A small companion plugin, GitHub Vault Sync Updater, keeps it up to date.

## What it does and its limits

- Each device commits its changes to your repository. The history is plain Git, so you can browse it on GitHub.
- Edits to different files, or to different parts of the same note, merge automatically. Overlapping edits become conflicts that you resolve in Obsidian.
- Obsidian settings, themes and plugins sync too, with a review step before they change on another device.
- **File history** lets you preview a note's past versions and restore one.

Limits:

- It's in beta.
- It works only with GitHub, and only with private repositories. GitHub can read your notes; they aren't end-to-end encrypted.
- Files up to 8 MiB each, and vaults up to 128 MiB in total.
- Git LFS, symlinks, submodules and nested `.gitignore` files aren't supported. Neither are two paths that differ only in letter case.
- Requires Obsidian 1.11.4 or newer.

## Install

Download `github-vault-sync.zip` and `github-vault-sync-updater.zip` from the [latest release](https://github.com/triptu/markdown-github-sync/releases/latest). Unzip both into your vault's `.obsidian/plugins/` folder. On a phone, copy the two unzipped folders over USB or any file manager.

With the GitHub CLI, from inside your vault folder:

```sh
mkdir -p .obsidian/plugins && cd .obsidian/plugins \
  && gh release download -R triptu/markdown-github-sync -p '*.zip' --clobber \
  && unzip -oq github-vault-sync.zip && unzip -oq github-vault-sync-updater.zip && rm github-vault-sync*.zip
```

From then on the updater keeps the plugin current. It checks about every 6 hours. You can also run **Check for GitHub Vault Sync update** from the command palette. If a new version fails to load, the updater puts the old one back.

## Set up

1. Create a private repository on GitHub, for example `your-name/notes`. It can't be empty, so tick **Add a README file** when you create it.
2. In Obsidian, go to Settings → Community plugins. Turn off any other sync plugin (Obsidian Git, Self-hosted LiveSync, Remotely Save). Then enable **GitHub Vault Sync** and **GitHub Vault Sync Updater**.
3. In GitHub Vault Sync's settings, enter the repository as `your-name/notes` and the branch (usually `main`).
4. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new). The **Create token** link in settings opens this form with the permissions filled in. Give it access to only your notes repository, with:
   - Contents: read and write
   - Metadata: read

   Paste the token into settings. Obsidian keeps it in its secret storage. The updater needs no token; it reads releases from this public repository.
5. Click **Connect**, look over what the first sync will do, then click **Start syncing**.

Repeat this on each device. Don't copy the `.git-vault-sync/` folder between devices.

If the vault already has a `.git` folder, it's left alone and never synced. Once connected, stop using Git in that folder.

## How sync behaves

Sync runs while Obsidian is open:

- 30 seconds after you stop typing, and at most 2 minutes after the first edit
- when you leave Obsidian, and when you come back
- every 5 minutes

**Sync now** in settings or the command palette runs one immediately.

Successful syncs stay quiet. Being offline shows only in the status bar, and becomes a notice after 6 hours without a sync. A problem with the token or repository opens settings. Other problems show one notice that clears itself once sync recovers.

**Conflicts.** The conflict view shows a line diff of this device's version against GitHub's. You keep either one, keep both, or edit a combined version.

**Changes that wait for review.** Large deletions, and incoming changes to Obsidian settings and plugins, pause until you approve them.

**What doesn't sync:**

- this plugin's own folder and local journal (`.git-vault-sync/`)
- workspace layout files and Obsidian's cache
- `.git`, `.trash` and OS files such as `.DS_Store`
- files that look like credentials, such as `.env`, `*.pem` and `*.key`
- anything matched by a `.gitignore` at the vault root

## Troubleshooting

- **"Branch wasn't found, or the repository is empty."** Check the branch name, and make sure the repository has at least one commit.
- **Access denied.** Check that the token has Contents read and write on the repository, and that it hasn't expired. When the token expires, sync stops; updates keep working.
- **"Sync only works with a private repository."** Make the repository private.
- **Android.** Android pauses Obsidian in the background and cuts its network. Leave Obsidian open until it shows synced before you switch devices.
- **Past syncs.** The **Sync history** and **File history** commands list what changed and when.

## Development

Requires Node 22 or newer, npm and `zip`.

```sh
npm run setup     # install dependencies
npm run check     # typecheck, test and build
npm run package   # build both plugins and their zips into dist/
```

The built plugins are in `dist/github-vault-sync/` and `dist/github-vault-sync-updater/`. Copy each folder into `<vault>/.obsidian/plugins/` and reload Obsidian.

Maintainer notes, release steps and design rules are in [AGENTS.md](AGENTS.md). Release notes are in [docs/releases](docs/releases/).

## License

MIT. See [LICENSE](LICENSE).
