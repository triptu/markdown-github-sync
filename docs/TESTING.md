# Validation

The current plugin talks directly to GitHub. No Cloudflare deployment or setup code is involved. The retained `server/` tests cover the earlier prototype only.

Run `npm run check` for plugin/server typechecks, tests, and the plugin build. Run the Quint checks documented in [formal/README.md](../formal/README.md) separately. Neither establishes native Obsidian behavior. Device evidence must identify the installed `main.js` SHA-256, Obsidian version, platform, and result file; a later build does not inherit an earlier device pass.

## Disposable-vault acceptance

Use a private synthetic repository and separate test vaults. Never point an acceptance helper at the original vault or its repository. Preserve failed results and use a fresh run identifier for a retry.

1. Install the built plugin on desktop and Android. Configure the private repository, existing branch and Obsidian SecretStorage credential. Review enrollment; verify it refuses a local `.git` checkout and competing sync plugins. Enroll each installation separately without copying journals or device identifiers.
2. With automatic sync enabled, save different notes on two devices from the same checkpoint. Verify GitHub commits contain both edits and both vaults converge. Repeat with concurrent publication and after returning from the background. Background delivery is not promised.
3. Test note creation, replacement, folder rename, attachment creation and replacement, and one-sided deletion. Verify exact bytes on GitHub and the receiving device. Close views before binary replacement or deletion; an open view must hold the affected path while unrelated files progress.
4. Make overlapping edits and an edit-versus-deletion conflict. Verify both versions remain recoverable, inspect the conflict UI, and resolve through the production controls. Change a version after preview and confirm stale approval is rejected.
5. Exercise a naturally opened Markdown note with clean, dirty-unsaved and saved editor state. Plain UTF-8 fixtures must exercise `Vault.process`; a fixture containing control bytes exercises the binary transaction instead. Record host merge behavior separately from the guarantee for saved bytes.
6. Interrupt network requests and restart Obsidian during publication and native application. Verify receipts settle ambiguous publication, durable recovery preserves captured versions, and retries converge. Injected adapter failures and actual process termination are separate evidence.
7. Browse history, preview an older note or attachment, and restore it as a local draft. Verify the subsequent commit contains the chosen bytes without rewriting Git history. Test a local edit after preview and a remote-head change before publication.
8. Review incoming configuration through the production UI. Verify unapplied settings stay deferred, a stale write by a still-running plugin stays held across restart, and unrelated notes continue syncing. Test configuration restore and fresh consent after GitHub changes. New hidden additions require their own publication approval.
9. Exercise unreadable/oversized files, wrong credentials, unavailable GitHub, and invalid scope. Verify affected data is preserved and the status explains outstanding work. Export recovery without clobbering visible content; cleanup must preserve active and pinned evidence.
10. Re-run the relevant acceptance on the exact packaged bundle. Compare checksums, keep the result artifacts, and record any untested platform or authorization type before rollout.

## Evidence and limits

See [implementation gates](implementation-plan.md), [Android V2 results](verification/android-v2.md), [editor host assessment](verification/editor-host-evidence-assessment-r4.md), and [Quint verification](verification/quint.md). Earlier failures remain failures even when a later retry succeeds.

The native adapter compares saved bytes and retains recovery evidence. It does not own Obsidian's unsaved buffers or third-party editor state. Source inspection of Obsidian 1.14.4 finds Markdown merging on external modification, while Canvas and Bases use different host behavior; real-host tests must distinguish those paths. Emulator and process-restart checks do not establish physical-phone storage behavior or hardware power-loss durability.
