# Validation

Run `npm run check` for TypeScript validation, plugin tests, real Cloudflare workerd tests, and the plugin build. Server deployment shape is checked with `cd server && npx wrangler deploy --dry-run`. These checks do not prove native Obsidian UI or mobile filesystem behavior.

Before using a real vault, run this acceptance pass on a disposable vault on each target platform:

1. Install and enable the plugin; configure the deployed HTTPS Worker on laptop A. Add a note, nested note, Canvas file and binary attachment. Sync with an empty laptop B and phone vault using the same private setup code. Verify bytes and links.
2. Edit offline on both laptops, reconnect and sync twice. Verify both conflicting versions survive. Check conflict copies reach the phone.
3. Delete an already-synced file on one device; confirm the others remove it. Edit the same file offline on a second device before receiving deletion and confirm the edit survives in a conflict copy.
4. Rename a folder, sync twice, and confirm new paths and old-path tombstones settle. Try case-only conflicting names and confirm the pass stops instead of overwriting.
5. Disable networking during upload. Restart the plugin, reconnect and verify convergence. Repeat while downloading.
6. Enter the wrong token/key on a fresh test vault. Confirm it fails without modifying local files.
7. Recover both an older note and an attachment through history. Confirm recovery creates new files and leaves the current revision intact. Inspect local recovery copies and trash.
8. Background the phone, edit on a laptop, then foreground Obsidian. Confirm it catches up. Do not expect background delivery.
9. Check plugin status after an oversized file, server error, and invalid configuration. Resolve the cause and sync again.

Known native API limit: text changes use `Vault.process`; binary writes and deletion have comparison guards plus backups but cannot provide fully atomic compare-and-swap. Physical iOS/Android and live desktop verification remain unperformed in this environment.
