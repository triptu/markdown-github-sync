# Native R2 oversize and retained-hidden port for root UI and engine

Native worker owns `obsidian-vault.ts` and `native-transactions.ts`. No real vault, remote, or device was written. This is the root integration port; it is not a claim of Android acceptance.

## Engine boundary

`capture()`, `scan()` and `pendingIntents()` are read-only. `scan()` returns `{files, unreadable}`; visible files above 8 MiB appear in `unreadable` with path/size/mtime and are omitted from `files`, never represented as a deletion. The engine can progress unrelated paths while holding the unreadable path. `recover({replay, cancel})` is the sole engine-authorized native recovery call. `apply()` refuses a pending intent whose expected/next oid or mode differs from its arguments. The engine must durably save a keep-local choice before listing that intent in `cancel`. A pause/device-identity fence must precede `recover()`. Replaying an id not listed by the engine is forbidden.

Oversize recovery must be included in `recover()` as `NativeIssue.kind === 'oversize'` with `{id,path,sourcePath,size,mtime,expected,next}` and no `found`. It is a durable per-path hold: never ingest oversized bytes into core blobs or auto-merge the path. The engine should acknowledge the id only after a user decision is durably recorded and before applying that path. The choice to acknowledge leaves the original hidden source in place; a new size/mtime raises a fresh issue. A path with a pending intent also needs a cancel authorization to abandon that intent; an ack by itself does not replay or cancel a pending operation. Other paths can continue.

## Root UI calls

`vault.nativeRecoveries()` lists metadata, including oversize records. `await vault.inspectOversize(id)` returns the durable record plus current source size and mtime, without reading the bytes. `await vault.exportOversize(id, destination?)` copies to a private temporary file, checks size and source metadata, then publishes with a no-clobber rename. When omitted, `destination` is generated under `.git-vault-sync-export-<uuid>/`. An explicit destination is accepted only under that dedicated hidden directory. The source remains. The returned hidden path is for the file manager; exporting more than 8 MiB into a visible vault path would block normal capture and is rejected. A concurrent writer with unchanged size/mtime cannot be ruled out by this API. `await vault.acknowledgeOversize(id)` requires current size/mtime to match the durable record, then durably suppresses rediscovery of that source version. Show the path, source path, size, export destination, and the fact that acknowledging does not delete the source. Require an explicit decision before calling ack. The user can inspect the source through the vault's file manager or the exported file.

## Retention and cleanup

All displaced preimages, including clean ones, remain in `.git-vault-sync/<installation>/hold/` and staged files in `stage/`. This can grow without bound while a vault is used. The adapter has no atomic remove-if-hash; a read followed by `remove()` can delete bytes written between the two calls. Do not run automatic cleanup or advertise a storage bound. A safe user workflow is: close editors and other writers, export any source they want to retain, inspect the exported copy, then explicitly remove old hidden files using a user-controlled file manager or a future OS-backed ownership/atomic-delete primitive. `await vault.retainedHiddenSummary()` is read-only and returns total hidden file count/bytes, hold count, stage count, and missing-stat count. The plugin should display these before enabling manual cleanup. An explicit plugin cleanup API needs a separate reviewed design because neither a second read nor a same-host queue closes the external-writer race.

## Limits

Size/mtime is a version hint, not cryptographic proof against a writer preserving both. `DataAdapter.copy()` and rename are not proven crash durable or atomic under Android process death; the source remains untouched if export fails. The UI and engine must not claim fsync, arbitrary external-writer safety, or dirty-editor-buffer safety from the Node tests.
