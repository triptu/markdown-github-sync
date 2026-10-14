# GitHub Vault Sync

An Obsidian plugin that syncs notes through ordinary commits in a private GitHub repository. Runs inside Obsidian on desktop and Android, without a companion Git app or a hosted sync server.

**Beta release: 0.3.0-beta.7.** See [release notes](docs/releases/). Maintainers and agents: start with [AGENTS.md](AGENTS.md).

## How it works

Saved device edits remain local drafts until the plugin publishes a commit to GitHub. Each device downloads only committed versions. Independent file edits reconcile automatically, including retries when devices publish concurrently. Overlapping edits that cannot be merged appear in a conflict inbox. Publishing compares the exact expected branch head so a competing device cannot silently replace another device's update.

Sync runs while Obsidian is open: 30 seconds after you stop typing (at most 2 minutes after the first edit), when you leave Obsidian, on return to the foreground, and every five minutes. **Sync now** is also available. Android can suspend Obsidian in the background; leave it open until the status shows content synced before switching devices.

The plugin journals recovery data locally before applying changes. Markdown replacement uses Obsidian's atomic text operation. Attachment replacements and deletions use recoverable staged file operations. Ordinary nonconflicting changes apply automatically. Conflicts, bulk deletions, unexpected bytes, and open views that would be retargeted stop the affected operation for review.

## Build and install in a test vault

Requires Node 22 or newer, npm and zip. Obsidian 1.11.4 or newer is required for SecretStorage.

```sh
npm run setup
npm run check
npm run package
```

Copy `main.js`, `manifest.json` and `styles.css` from `dist/github-vault-sync/` into `<test-vault>/.obsidian/plugins/github-vault-sync/`. The archive is `dist/github-vault-sync.zip`. Enable community plugins and **GitHub Vault Sync**.

1. Open your existing vault and turn off the old sync plugin in **Settings → Community plugins**.
2. Open **GitHub Vault Sync**. The repository and current upstream branch are filled from this vault's `.git` folder when available. Paste your access token into the masked field; access is checked automatically. The token needs Contents read/write and Metadata read for that private repository. Use **Copy link** to create a token in your browser.
3. Expand **Commit messages** if you want to change the device name, message or date format. A preview shows the result. The default uses local device time, like `vault backup Mac (3): 14th Oct, 2026 03:40:04`. `{{device}}`, `{{count}}`, `{{date}}` and the old Git plugin's `{{hostname}}` / `{{numFiles}}` aliases work.
4. Click **Connect**, review the first sync, then **Start syncing**. Existing notes stay in this vault. If it has an ordinary `.git` folder, the plugin keeps that folder under `.git-vault-sync/previous-git/<id>/dot-git`; it no longer runs as a local Git checkout. No force push or Git history rewrite occurs.
5. Use **Sync now**, **Sync status**, **Sync history** or **File history** from the command palette. Automatic sync runs while Obsidian is open. Sync history shows repository commits through this device's last synced version.

Install and connect each device separately. Copy only the three plugin files, not device journals or app-local storage. Android installation uses the same `.obsidian/plugins/github-vault-sync` folder.

For automatic updates, also install `dist/github-vault-sync-updater/` as `.obsidian/plugins/github-vault-sync-updater/` and enable **GitHub Vault Sync Updater**. It reads new versions from this repository's `updates` branch with the same token, so the token also needs Contents read on this repository. See [AGENTS.md](AGENTS.md#releasing).

The saved Git folder is a snapshot from the switch, not a continuously updated backup. To return to terminal Git later, disable this plugin and reconcile that saved checkout with GitHub and your current notes before enabling another sync tool.

Once connected, settings shows the current sync status and anything waiting on a decision. **Sync now** uploads and downloads in one operation. Successful syncs stay quiet; being offline shows only in the status bar, and other problems show one notice that clears itself once sync recovers. To replace a token, paste it under Advanced; it is checked before replacing the working token.

Downloads reuse local files after verifying their Git blob hashes, including after a restart. Large initial downloads use a ZIP of the exact GitHub commit, checked against its tree; small changes fetch only missing blobs. An unchanged head needs no file downloads. ZIP extraction happens in memory, never over your notes. Files omitted or transformed by Git archive attributes are fetched separately when needed.

## Conflicts and recovery

Conflicts appear in settings and in **Sync status**. The conflict view shows a line diff of this device's version against GitHub's; keep either, keep both, or edit a combined version.

Each installation has a GitHub receipt ledger. A lost network response is settled by checking that ledger; a cancelled attempt is reconciled against the latest branch and retried. Persistent network or stale-ledger reads remain visibly unsettled and send no replacement publication. History rewrites, repository changes, and unresolved legacy operations require reviewed recovery.

**File history** lets you browse a note's past versions, preview one, and restore it as a local edit that syncs normally.

Local journal records and objects live under `.git-vault-sync/` and are excluded from sync. Safety copies of replaced or deleted files are released once safely on GitHub and expire after 30 days; cleanup runs quietly after successful syncs. Preserve the directory when investigating interrupted or corrupt state.

## Boundaries

- Fresh vault setup defaults to configuration scope. Existing visible-only enrollments require reviewed migration. Eligible `.obsidian` settings, themes and plugin files are included; incoming configuration waits for exact-version approval, and new local configuration files require publication consent. Credentials, device journals, workspace files and other excluded paths stay local. A committed root `.gitignore` controls the supported ignore policy; remote excluded files are preserved.
- Maximum file size: 8 MiB. Maximum decoded vault snapshot: 128 MiB. Git LFS pointers, symlinks, submodules and unsafe/colliding paths are rejected when in scope.
- GitHub receives readable file content; this is not end-to-end encrypted sync. Enrollment and sync refuse public or unknown repository visibility. Use a narrowly scoped token; a repository owner can still change visibility outside the plugin.
- The plugin manages GitHub objects directly; it does not maintain a local `.git` checkout. Terminal Git can continue in your separate original checkout.
- Standard visible Markdown editor scenarios were exercised; arbitrary unsaved buffers and third-party editor behavior are not guaranteed. Physical-device failures and hardware power-loss durability are not established by emulator checks.
- Two Android emulator journal writes failed verification and stopped sync before committing the journal. Normal retries and a fresh acceptance run passed without source changes. The cause remains unresolved; preserve the local journal if a verification error recurs. See [storage investigation](docs/verification/android-zero-write-analysis.md).

## Verification

[Quint](formal/README.md) is the sole maintained specification language. The [verification report](docs/verification/quint.md) documents finite safety checks, deliberately broken negative controls, and temporal checks for eventual progress under explicit fairness and quiescence assumptions. The handwritten TLA+ baseline is preserved in Git history at `e780b4c`; TLA generated by the Quint toolchain is compiler output. These separate, bounded models do not prove their composition, arbitrary vault sizes, the TypeScript implementation, or native disk behavior.

[GitHub client evidence](docs/github-client.md), [engine API](docs/engine-api.md), and [Android evidence](docs/verification/android-v2.md) cover separate layers. The current integration check passes 564 plugin tests, typechecking and build; the separate final-bundle acceptance reports document actual desktop and Android runs. Native testing uses Obsidian 1.14.4 on an Android 15 emulator. Physical Android hardware, fine-grained PAT authorization and hardware power-loss durability remain separate, unverified boundaries.

[Interactive design proposal](docs/github-sync-proposal.html) explains the intended architecture. Run `node scripts/export-proposal.mjs` for a portable standalone copy.

The repository retains the [earlier Cloudflare prototype](docs/legacy-cloudflare-prototype.md) and its server code for historical reference. The GitHub plugin does not use that server. [Reverse-engineering findings](research/FINDINGS.md) describe the original investigation of Obsidian Sync; this plugin is an independent implementation.
