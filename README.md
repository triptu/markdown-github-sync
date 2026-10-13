# GitHub Vault Sync

An Obsidian plugin that syncs notes through ordinary commits in a private GitHub repository. Runs inside Obsidian on desktop and Android, without a companion Git app or a hosted sync server.

**0.2.0-beta.1 — tested on Android emulator; ready for a separate test vault.** The current bundle passed automatic sync across restart, conflict resolution, held binary/deletion checks, and recovery export against a private synthetic GitHub repository. Independent core and native persistence reviews passed within their stated scope. See the [native acceptance record](docs/verification/android-conflict.md). Your existing Git-backed vault should remain the recovery baseline during adoption; this beta does not yet provide automatic application of incoming deletions or existing binary replacements.

## How it works

Saved device edits remain local drafts until the plugin publishes a commit to GitHub. Each device downloads only committed versions. Independent file edits reconcile automatically when publications do not race; overlapping edits appear in a conflict inbox. Simultaneous publication can pause for reviewed recovery, as described below. Publishing compares the exact expected branch head so a competing device cannot silently replace another device's update.

Sync runs while Obsidian is open: after saved edits, on return to the foreground, and periodically. **Sync now** is also available. Android can suspend Obsidian in the background; leave it open until the status shows content synced before switching devices.

The plugin journals recovery data locally before applying changes. Markdown replacement uses Obsidian's atomic text operation. Existing binary replacements and incoming deletions are held because the native API does not expose an atomic compare-and-replace/delete operation. These holds require review; they are not silently applied.

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

An uncertain publication, including some competing-device publication races, pauses sync rather than replaying a possibly accepted commit. The status view offers a reviewed recovery flow that archives the candidate and local draft before fresh enrollment. Sequential independent-file edits converge automatically; simultaneous publishing may require this recovery step.

The recovery view exports captured files into a separate hidden folder. Historical restore accepts a vault-relative path and a full GitHub commit SHA, previews the result, and restores it as a local draft that can then be committed normally.

Local journal records and immutable objects live under `.git-vault-sync/`. They are excluded from sync. Physical journal files currently remain indefinitely, but the browsable recovery index keeps only the latest 20 unpinned records; pinned recovery stays until explicitly discarded. Storage usage grows with edits; there is no garbage collector yet. Preserve that directory when investigating interrupted or corrupt state.

## Boundaries

- Hidden path components, including `.obsidian`, `.git` and `.trash`, are excluded. The remote copies of excluded paths are preserved.
- Maximum file size: 8 MiB. Maximum decoded vault snapshot: 128 MiB. Git LFS pointers, symlinks, submodules and unsafe/colliding paths are rejected when in scope.
- GitHub receives readable file content; this is not end-to-end encrypted sync. Enrollment and sync refuse public or unknown repository visibility. Use a narrowly scoped token; a repository owner can still change visibility outside the plugin.
- The plugin manages GitHub objects directly; it does not maintain a local `.git` checkout. Terminal Git can continue in your separate original checkout.
- Unsaved editor buffers, external writers, physical-device failures and hardware power-loss durability are not established by emulator checks.

## Verification

[Quint](formal/quint/) provides the readable specification with executed bounded checks and negative controls; its [verification report](docs/verification/quint.md) lists the bounds and coverage gaps. Quint liveness and refinement of the implementation are not proven. The retained [TLA+ baseline](formal/README.md) has executed finite safety and conditional liveness checks, deliberate negative controls, and an [independent audit](formal/REVIEW.md). These checks describe their abstractions and assumptions; they are not a proof of the TypeScript implementation.

[GitHub client evidence](docs/github-client.md), [engine API](docs/engine-api.md), and [Android evidence](docs/verification/android-native.md) document separate layers of testing. The final check passed 239 plugin tests, four retained legacy server tests, typechecking and the build. Native acceptance used Obsidian 1.14.4 on Android 15. Physical Android hardware, fine-grained PAT authorization and hardware power-loss durability remain untested.

[Interactive design proposal](docs/github-sync-proposal.html) explains the intended architecture. Run `node scripts/export-proposal.mjs` for a portable standalone copy.

The repository retains the [earlier Cloudflare prototype](docs/legacy-cloudflare-prototype.md) and its server code for historical reference. The GitHub plugin does not use that server. [Reverse-engineering findings](research/FINDINGS.md) describe the original investigation of Obsidian Sync; this plugin is an independent implementation.
