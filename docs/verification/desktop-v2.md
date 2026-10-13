# Desktop V2 acceptance

The installed plugin passed 21 checks in official Obsidian 1.14.4 using a disposable macOS profile. Run `e92821d4-95d8-49e7-9243-e8ec0eb2e2ea` pinned production SHA-256 `dc3984a2da5298d8e3a651c19b8702f0999f901e6809ec2d8cc7f64e7a83d103`.

The [result](desktop-v2-final-result.json) covers private-repository enrollment, foreground automatic convergence of independent local and remote edits, a full application restart, saved-file publication, conflict retention and resolution, binary replacement, deletion, history preview, and historical restore as a new commit. The final state was idle with no pending changes. [Independent readback](desktop-v2-final-readback.json) compared all eight final GitHub blobs against native disk bytes at commit `9e06405295ab1f22e48893ebf35baaa0658ab017` and checked the installed bundle hash.

## What was driven

The acceptance helper called the loaded production plugin and session APIs. The ordinary saved-edit fixture was written through the filesystem; it was not typed through the desktop editor UI. Conflict and restore were exercised through production APIs, not modal clicks. No desktop UI usability pass is claimed. The helper bundled a GitHub client only to create and inspect synthetic remote fixtures; enrollment, scheduling, sync, decisions, history, and restore used the installed plugin.

The isolated application used `/tmp/github-vault-sync-desktop-v2-1791919653/profile` and its sibling `Vault Sync Lab`. No personal vault or original profile was modified. After verification the test application was stopped before the separate Android run.

## Earlier failed runs

- [First run](desktop-v2-final-first-result.json): host index lag after native seed creation. The [diagnosis](desktop-index-diagnosis.md) led to durable index acknowledgement at the native completion boundary.
- [Second run](desktop-v2-final-second-result.json): automatic convergence failed while the plugin observed an obsolete mutable branch head. The actual GitHub graph retained the correct commit chain. The [cache diagnosis](desktop-head-cache-diagnosis.md) led to unique, no-cache branch-head reads; the ancestry safety check was retained.

Both failed vaults and profiles were preserved under the corresponding `-failed-22e20410` and `-failed-6ba74e17` paths. Neither failure was relabelled a pass. The passing run used a new vault, profile, branch, and run UUID.

## Remaining scope

This visible-file run does not establish configuration UI/restart behavior, physical Android storage, hardware power-loss durability, fine-grained-token authorization, or arbitrary third-party editor buffers. Configuration has separate tests and device evidence. The native index acknowledgement change also has a separately tracked independent review.
