# GitHub Vault Sync

An Obsidian plugin that syncs notes through ordinary commits in a private GitHub repository. Runs inside Obsidian on desktop and Android, without a companion Git app or a hosted sync server.

**Current development build: final acceptance in progress.** The last published release is `0.2.0-beta.1`; this checkout contains the replacement work described below. Use a separate test vault until the current release gates close. See [Android acceptance](docs/verification/android-v2.md), [configuration review](docs/verification/configuration-restart-review-r3.md), and [Quint verification](docs/verification/quint.md). Keep your original Git-backed vault as the recovery baseline.

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

1. Use a fresh test vault outside another sync service. Keep your original Git checkout as a rollback copy. The plugin refuses a vault containing `.git` or a detected competing sync plugin.
2. In settings, enter the GitHub owner, repository and existing branch.
3. Create a fine-grained GitHub token scoped to that repository with Contents read/write and Metadata read. Select it through Obsidian's secret control. The plugin stores a secret identifier in its settings, not the token itself.
4. Save settings, acknowledge that this plugin owns syncing in this vault, then preview enrollment. Review the proposed actions before confirming.
5. Open **Changes and status** to inspect pending edits and conflicts. Use **Sync now** or leave automatic sync enabled.

Install and enroll each device separately. Do not copy device journal files or app-local storage between devices. Plugin installation on Android currently requires copying the three build files into the vault's hidden `.obsidian/plugins` folder; ordinary syncing then happens entirely inside Obsidian.

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
- Unsaved editor buffers, external writers, physical-device failures and hardware power-loss durability are not established by emulator checks.

## Verification

[Quint](formal/README.md) is the sole maintained specification language. The [verification report](docs/verification/quint.md) documents finite safety checks, deliberately broken negative controls, and temporal checks for eventual progress under explicit fairness and quiescence assumptions. The handwritten TLA+ baseline is preserved in Git history at `e780b4c`; TLA generated by the Quint toolchain is compiler output. These separate, bounded models do not prove their composition, arbitrary vault sizes, the TypeScript implementation, or native disk behavior.

[GitHub client evidence](docs/github-client.md), [engine API](docs/engine-api.md), and [Android evidence](docs/verification/android-v2.md) cover separate layers. The current integration check passes 458 plugin tests, typechecking and build; this does not replace final-bundle device acceptance. Native testing uses Obsidian 1.14.4 on an Android 15 emulator. Physical Android hardware, fine-grained PAT authorization and hardware power-loss durability remain separate, unverified boundaries.

[Interactive design proposal](docs/github-sync-proposal.html) explains the intended architecture. Run `node scripts/export-proposal.mjs` for a portable standalone copy.

The repository retains the [earlier Cloudflare prototype](docs/legacy-cloudflare-prototype.md) and its server code for historical reference. The GitHub plugin does not use that server. [Reverse-engineering findings](research/FINDINGS.md) describe the original investigation of Obsidian Sync; this plugin is an independent implementation.
