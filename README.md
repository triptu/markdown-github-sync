# GitHub Vault Sync

An Obsidian plugin that syncs notes through ordinary commits in a private GitHub repository. Runs inside Obsidian on desktop and Android, without a companion Git app or a hosted sync server.

**Beta release: 0.3.0-beta.2.** Simpler setup in your existing vault, customizable dated commit messages, sync history, and a shorter command palette. See [release notes](docs/releases/0.3.0-beta.2.md).

## How it works

Saved device edits remain local drafts until the plugin publishes a commit to GitHub. Each device downloads only committed versions. Independent file edits reconcile automatically, including retries when devices publish concurrently. Overlapping edits that cannot be merged appear in a conflict inbox. Publishing compares the exact expected branch head so a competing device cannot silently replace another device's update.

Sync runs while Obsidian is open: after saved edits, on return to the foreground, and periodically. **Sync now** is also available. Android can suspend Obsidian in the background; leave it open until the status shows content synced before switching devices.

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
2. In **GitHub Vault Sync**, enter your repository (`owner/name` or its GitHub URL), branch and access token. The token needs Contents read/write and Metadata read for that private repository.
3. Expand **Commit messages** if you want to change the device name, message or date format. A preview shows the result. The default uses local device time, like `vault backup Mac (3): 14th Oct, 2026 03:40:04`. `{{device}}`, `{{count}}`, `{{date}}` and the old Git plugin's `{{hostname}}` / `{{numFiles}}` aliases work.
4. Click **Connect**, review the first sync, then **Start syncing**. Existing notes stay in this vault. If it has an ordinary `.git` folder, the plugin keeps that folder under `.git-vault-sync/previous-git/<id>/dot-git`; it no longer runs as a local Git checkout. No force push or Git history rewrite occurs.
5. Use **Sync now**, **Sync status**, **Sync history** or **File history** from the command palette. Automatic sync runs while Obsidian is open. Sync history shows repository commits through this device's last synced version.

Install and connect each device separately. Copy only the three plugin files, not device journals or app-local storage. Android installation uses the same `.obsidian/plugins/github-vault-sync` folder. Recovery tools are available in Sync status and Advanced settings.

The saved Git folder is a snapshot from the switch, not a continuously updated backup. To return to terminal Git later, disable this plugin and reconcile that saved checkout with GitHub and your current notes before enabling another sync tool.

## Conflicts and recovery

The conflict inbox shows the common version, local draft and GitHub version. Available decisions include retaining either version, keeping both, or editing merged Markdown. Decisions are reviewed before publishing.

Each installation has a GitHub receipt ledger. A lost network response is settled by checking that ledger; a cancelled attempt is reconciled against the latest branch and retried. Persistent network or stale-ledger reads remain visibly unsettled and send no replacement publication. History rewrites, repository changes, and unresolved legacy operations require reviewed recovery.

The recovery view exports captured files into a separate hidden folder. Historical restore lets you browse file history or enter a full commit SHA, preview the bytes, and restore them as a saved local draft for normal publication.

Local journal records and immutable objects live under `.git-vault-sync/`. They are excluded from sync. Cleanup retains the latest eight journal checkpoints and every object they reference, including pinned recovery and active operations. The browsable recovery index keeps the latest 20 unpinned records; pinned recovery stays until explicitly discarded. Cleanup removes obsolete checkpoints before their unreferenced objects and can resume after interruption. Run it from local recovery; it also runs periodically after successful sync. Preserve the directory when investigating interrupted or corrupt state. These limits bound historical retention, not total bytes: large pinned recovery can still consume substantial space.

## Boundaries

- Fresh vault setup defaults to configuration scope. Existing visible-only enrollments require reviewed migration. Eligible `.obsidian` settings, themes and plugin files are included; incoming configuration waits for exact-version approval, and new local configuration files require publication consent. Credentials, device journals, workspace files and other excluded paths stay local. A committed root `.gitignore` controls the supported ignore policy; remote excluded files are preserved.
- Maximum file size: 8 MiB. Maximum decoded vault snapshot: 128 MiB. Git LFS pointers, symlinks, submodules and unsafe/colliding paths are rejected when in scope.
- GitHub receives readable file content; this is not end-to-end encrypted sync. Enrollment and sync refuse public or unknown repository visibility. Use a narrowly scoped token; a repository owner can still change visibility outside the plugin.
- The plugin manages GitHub objects directly; it does not maintain a local `.git` checkout. Terminal Git can continue in your separate original checkout.
- Standard visible Markdown editor scenarios were exercised; arbitrary unsaved buffers and third-party editor behavior are not guaranteed. Physical-device failures and hardware power-loss durability are not established by emulator checks.
- Two Android emulator journal writes failed verification and stopped sync before committing the journal. Normal retries and a fresh acceptance run passed without source changes. The cause remains unresolved; preserve the local journal if a verification error recurs. See [storage investigation](docs/verification/android-zero-write-analysis.md).

## Verification

[Quint](formal/README.md) is the sole maintained specification language. The [verification report](docs/verification/quint.md) documents finite safety checks, deliberately broken negative controls, and temporal checks for eventual progress under explicit fairness and quiescence assumptions. The handwritten TLA+ baseline is preserved in Git history at `e780b4c`; TLA generated by the Quint toolchain is compiler output. These separate, bounded models do not prove their composition, arbitrary vault sizes, the TypeScript implementation, or native disk behavior.

[GitHub client evidence](docs/github-client.md), [engine API](docs/engine-api.md), and [Android evidence](docs/verification/android-v2.md) cover separate layers. The current integration check passes 474 plugin tests, typechecking and build; the separate final-bundle acceptance reports document actual desktop and Android runs. Native testing uses Obsidian 1.14.4 on an Android 15 emulator. Physical Android hardware, fine-grained PAT authorization and hardware power-loss durability remain separate, unverified boundaries.

[Interactive design proposal](docs/github-sync-proposal.html) explains the intended architecture. Run `node scripts/export-proposal.mjs` for a portable standalone copy.

The repository retains the [earlier Cloudflare prototype](docs/legacy-cloudflare-prototype.md) and its server code for historical reference. The GitHub plugin does not use that server. [Reverse-engineering findings](research/FINDINGS.md) describe the original investigation of Obsidian Sync; this plugin is an independent implementation.
