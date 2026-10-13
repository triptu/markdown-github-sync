# Cloud Vault Sync

A self-hosted Obsidian community plugin for encrypted note and attachment sync across desktop and mobile, with a Cloudflare Worker, SQLite Durable Object and R2 backend. This is an independent implementation, not a client for Obsidian's paid service. Version 0.1.0 is tested in automated simulations and Cloudflare's local runtime; it has not yet been exercised inside desktop Obsidian or on a physical phone.

[Interactive architecture walkthrough](docs/architecture.html) — download and open in a browser to explore the sync flow, conflicts and project status.

## What works

- Initial union of files from each device; edits and attachments up to 8 MiB per file.
- Offline edits, deletion tombstones and rename reconciliation (upload new path, delete old path).
- Concurrent edits preserved in separate conflict files. Those copies sync on the next pass.
- AES-256-GCM encryption of content, paths and file timestamps. A generated random key stays on your devices. HKDF separates encryption and HMAC naming keys; paths become opaque HMAC object IDs.
- Optimistic revision checks, authenticated downloads, restart reconciliation, and rollback/missing-history checks against each device's saved baseline.
- Remote revision history with recovery into a separate file, and local recovery copies before replacement or deletion.
- Sync after local changes, every 30 seconds while open, on app startup and on return to the foreground.

Hidden paths—including `.obsidian`, `.trash`, `.git`, and the local recovery folder—are excluded. Settings/plugins, empty folders, selective sync, automatic text merge, delta compression, background mobile services and collaborative editing are not implemented. Use this on a copied vault first, with Obsidian Sync/iCloud/other sync disabled for that vault. Keep independent backups.

## Build

Use Node 22 LTS or newer, npm and zip:

```sh
npm run setup
npm run check
npm run package
```

The installable files are in `dist/cloud-vault-sync/`; the transfer archive is `dist/cloud-vault-sync.zip`. The plugin bundle uses Obsidian's mobile-compatible APIs and Web Crypto, with no Node runtime imports.

## Host on Cloudflare

See [server/README.md](server/README.md) for the API and operations details. From this repository:

```sh
cd server
npx wrangler login
npx wrangler r2 bucket create cipher-vault-sync
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

Generate a private token with `openssl rand -hex 32` and enter it at the secret prompt. Enable R2 in your Cloudflare account. Copy the deployed HTTPS Worker origin. This uses Wrangler's checked configuration directly; Alchemy is optional and not required. No infrastructure has been deployed by this project build.

## First laptop

1. Close any other sync tool for a copied/test vault.
2. Copy `dist/cloud-vault-sync/main.js` and `manifest.json` into `<vault>/.obsidian/plugins/cloud-vault-sync/`.
3. Reload Obsidian, allow community plugins, and enable **Cloud Vault Sync**.
4. Open its settings. Enter the Worker URL and server access token. Click **Generate** to create the vault ID and encryption key, then **Save**.
5. Click **Sync now**. Check the status for errors, then enable **Automatic sync**.
6. Open **Show setup code**. Transfer this code privately to the other devices. It contains both the access token and decryption key.

## Other laptops and phones

Install the same plugin files in the other vault's `.obsidian/plugins/cloud-vault-sync/` directory and enable it. Choose **Import setup code**, paste the first device's code, then **Sync now** and enable automatic sync. Use an empty vault for the simplest first download; existing files are unioned and differing files receive conflict copies.

On Android, a file manager or USB transfer can copy the folder into the local vault. On iOS, transfer the plugin folder into the vault in Obsidian's Files container; a desktop-to-Files transfer can be needed to access the hidden `.obsidian` directory. Community plugin installation on mobile is a manual step for this unpublished plugin. Keep the app open until its sync finishes before switching devices. Mobile OSes suspend Obsidian in the background.

Never generate a fresh encryption key for an existing remote vault. Keep the setup code in a password manager: losing all copies of the key makes remote files unrecoverable. Local plugin `data.json` stores credentials and baseline state in plaintext, protected only by the device's own filesystem security. Transfer the setup code, not `data.json`, to another device.

## Conflicts and recovery

A conflicting local edit becomes `Note (conflict <uuid>).md` before the remote revision is applied. Review both files and merge manually. Edit-versus-delete preserves the edited bytes in a conflict file; local deletion versus a newer remote edit restores the remote edit. Missing local files are uploaded as deletions only when the device has previously synchronized them.

Use **Cloud Vault Sync: Browse file history** from the command palette, or **Browse history** in settings. Enter the original vault-relative path (also works for deleted files), load versions and recover one as a new file. Local pre-replacement copies live in `.cloud-vault-sync-recovery/`, outside normal sync; remote deletions also go through Obsidian's local trash. Remove recovery copies manually only after checking your backups.

Obsidian offers atomic processing for text files, but no atomic compare-and-swap for binary replacement or trash. Byte comparisons and backups reduce risk; a simultaneous external attachment write or a write in the small pre-trash window can still race. Avoid editing attachments in another app during sync. Case-only and Unicode-normalization path collisions are rejected, including old tombstones; use names that differ beyond case/normalization. A case-only rename cannot reuse a tombstoned path in this version.

## Limits and operations

This is a personal server with one bearer token granting access to every vault on that deployment. The server can observe opaque object IDs, revision counts, encrypted sizes, server timestamps and deletion flags. It cannot recover file contents or names from the stored envelopes without your key. A compromised server can omit data or replay old ciphertext to a fresh client; encryption is not a complete malicious-server rollback defense. Devices with an existing baseline reject version regression and missing known objects.

Full inventories and full file revisions are used. Changed remote revisions are downloaded twice: an authentication preflight, then a bounded-memory apply pass. There is a 20,000-object limit per vault, including tombstones. Files larger than 8 MiB stop the pass with an error; move them outside the vault to continue. Remote history and idempotency records are retained indefinitely, so storage and request costs grow with use. There is no retention/garbage collection, key rotation wizard, multi-user ACL, rate limiter, or automated disaster recovery. Do not configure R2 expiry rules. The service requires both its Durable Object metadata and R2 data to recover from a server loss.

## Investigation and validation

[research/FINDINGS.md](research/FINDINGS.md) explains the inspected Obsidian 1.14.4 behavior, evidence hashes and source locations, and separates observations from design choices. REA's retained analysis was partial because of memory/time limits; the focused shipped-source inspection supplied the sync findings. Proprietary Obsidian artifacts are excluded from source control and the plugin package.

Tests cover offline reconciliation, conflicts, authentication/tampering, deletion, in-flight edits, persistence failure, server isolation, idempotent retries, and concurrent revision checks. See [docs/TESTING.md](docs/TESTING.md) for the device acceptance checklist and remaining verification boundaries.
