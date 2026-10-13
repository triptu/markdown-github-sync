# Android zero-byte journal temp write: source/host analysis

2026-10-14. Research sub-agent, source and host artifacts only. No device, remote, emulator, real-vault, or repository writes were made. Repository at `99a90af`, production bundle `dc3984a2…d103`, Obsidian Android 1.14.4 (`/tmp/Obsidian-1.14.4.apk`, extracted to `/tmp/rea-obsidian-apk-1.14.4`, dex dumped with `build-tools/37.0.0/dexdump`).

## Parent assessment for release

The source investigation found no reproduced plugin defect and recommends preserving the existing stop-before-rename integrity check. Its categorical storage-layer attribution below is the reviewer's inference, **not a demonstrated root cause**: no native write trace or lower-filesystem comparison was captured at failure time. The defensible release finding is narrower: two emulator writes failed verification, the plugin stopped, unchanged-code retries and the fresh full configuration run passed, and the cause remains unresolved. A beta release retains this known limitation; neither the source audit nor passing probes prove that a physical phone cannot encounter it.

## Verdict

**No defect was found in the plugin store, its wiring, or the shipped Obsidian Android write path that could produce a resolved write followed by an empty file.** The two zero-byte temp files are a fail-closed detection of a transient storage-layer loss (FUSE-backed `/storage/emulated/0`), not a plugin logic error. The evidence does **not** support a production source change before release. The recommended actions are a narrow diagnostic that captures native-layer evidence on the next occurrence, plus retention of the existing fail-closed behavior.

What is established:

| Fact | Evidence |
|---|---|
| Both failures are the same plugin check: `files.write(temp)` resolved, `files.read(temp)` returned something other than the text, so `put()` threw before any rename. | `plugin/src/git-sync/store.ts:74-77` |
| Failure 1: engine **record** temp, sequence 226, 37 834 bytes, after force-stop/reopen. Failure 2: engine **object** temp `743a5ad0…`, 80 bytes, during first enrollment of a fresh installation. | `docs/verification/android-v2-configuration-restart-result.json`; `android-v2-configuration-current-first-result.json`; preserved copy `/tmp/github-v2-android-journal-write-failure/bd925ad5…/records/000000000226-…tmp` (0 bytes) |
| The 80-byte payload is exact: SHA-256 `743a5ad0…` of the base64 of `[\n  "github-vault-sync",\n  "git-sync-native-config-device"\n]`. Plain ASCII, no comma, no newline. | `/tmp/github-v2-zero-write-payload.txt` |
| Payload size, content, and parallelism are ruled out: 20 sequential and 100 four-parallel write/read/rename/read probes with the identical payload passed; the enrollment retry wrote the same object path (new UUID) and three more files successfully with unchanged code. | `docs/verification/android-v2-configuration-io-{sequential,parallel}.json`, `android-v2-configuration-current-enrollment-retry.json` |
| Neither failure was the first adapter write of the process. In failure 1 the helper had already written its own state file and the note through the same adapter before the failing sync. In failure 2 Obsidian had written plugin `data.json` via `saveConfiguration` before enrollment. | `plugin/test/native/configuration-restart-acceptance.ts:526-541`; `configuration-device-acceptance.ts:176-190` |
| Fresh run `194e2540` on the same bundle passed 21/21 including UI consent, restart, and guard. | Root's report |

## The write path, end to end (all serial)

1. **Plugin.** `FileJournalStore.put` → `files.write(temp, text)` → `files.read(temp)` → compare → `files.rename`. `files` is `owner.fence(app.vault.adapter)`, a thin proxy that only checks ownership (`plugin/src/main.ts:223-224`, `ownership.ts:130-141`). Object writes run through `mapObjects` with at most 4 in flight (`store.ts:27-41`), but see step 2.
2. **Obsidian adapter (`_6`, `CapacitorAdapter`).** Every `write`, `read`, `stat`, `rename`, `mkdir` is wrapped in `this.queue(fn)` which is a single promise chain (`promise.then(fn, fn)`). So the plugin's 4-way parallelism collapses to strictly serial native calls. `write` is: `await this.fs.write(fullPath, text)`; optional `setTimes`; `finally reconcileInternalFile(path)` (stat only). `read` is `await this.fs.read(fullPath)`. (app.js offsets 2756057, 2755453, 2767432.)
3. **Obsidian fs wrapper (`j6`).** Android uses `new j6("EXTERNAL_STORAGE")`; paths are relative to `/storage/emulated/0`. `write` = `fk.writeFile({directory, path, data, encoding:"utf8"})`; `read` = `fk.readFile({…, encoding:"utf8"}).data`; `exists` = `stat` success; `rename` = `fk.rename`. `q6` only remaps "does not exist" errors to `ENOENT` and rethrows everything else. (app.js 2744908, 2746080-2747495, 3945196.)
4. **Capacitor bridge.** JSON over `androidBridge.postMessage`; results routed by unique `callbackId`. Native plugin methods execute on one `HandlerThread("CapacitorPlugins")` (`com.getcapacitor.k`, dex line 937149). Serial again.
5. **Shipped native `FilesystemPlugin.writeFile`** (stock @capacitor/filesystem with Obsidian additions `startWatch`, `setTimes`, `watchAndStatAll`; none touch write). Decompiled from the APK:
   - `writeFile`: rejects `NO_PATH`/`NO_DATA`; resolves directory `EXTERNAL_STORAGE` → `Environment.getExternalStorageDirectory()`; checks parent exists; calls `saveFile`.
   - `saveFile` → implementation `d.t(file, data, UTF_8, append=false)`: `new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, false), UTF_8)); writer.write(data); writer.close();` No fsync. Any `IOException` from write or close propagates to `saveFile`'s catch → `call.reject("FILE_NOTCREATED")`, which would have surfaced as a thrown error from `files.write`, not as a verification mismatch.
   - After a successful write, because `EXTERNAL_STORAGE` is a public directory, `MediaScannerConnection.scanFile(context, [absPath], null, null)` is invoked. This is asynchronous and read-only. Then `call.resolve({uri})`.
   - `readFile` → `d.p` → `new FileInputStream(file)`, read to end, decode UTF-8. A 0-byte file returns `""`.
   - `rename` → `_copy(doRename=true)` → `d.d`: deletes an existing destination file, then `File.renameTo`; throws if `renameTo` returns false. Never truncates the source.
   - The FileObserver (`v`, mask 0x7CC: ATTRIB|CLOSE_WRITE|MOVED_FROM|MOVED_TO|CREATE|DELETE|DELETE_SELF) only forwards `change` events to JS, which schedules a `reconcileFile` (stat/readdir). No write.
   - `appendFile` is `writeFile` with `append=true`; `writeBinaryInternal` writes `data:""` only for binaries ≥ 5 MiB, which is not this path.

Conclusion from the code: between the plugin's `write` resolving and its `read`, nothing in the plugin, Obsidian's JS, or the shipped native plugin opens the temp path again, and nothing writes an empty string to it. The only truncating open is the `FileOutputStream(file, false)` of the write itself. For Java to return normally from `write`+`close` while the file ends up 0 bytes, the loss has to occur below `libcore` (`IoBridge.write` loops until all bytes are accepted and throws on any errno), i.e. in the FUSE/MediaProvider layer that backs `/storage/emulated/0`, or in the guest page cache/block layer of the emulator. The source analysis cannot distinguish those; the diagnostic below can.

## Hypotheses examined and their status

| Hypothesis | Status |
|---|---|
| Concurrent plugin writes to the same object (pre-dedupe) | Ruled out. Temp names carry a fresh UUID; c169a2e dedupes per record; Obsidian's queue serializes anyway. |
| Large string / bridge message size | Ruled out. 80 bytes failed; 37 834 bytes failed; 100 probes of 80 bytes and the retry's 2 626-byte record passed. |
| Empty `data` reaching native | Ruled out. The temp name's hash is computed from the same `data` string that is passed to `write` (`store.ts:85-87`); native rejects `null` data and would write `""` only if JS sent `""`. |
| Base64-looking text decoded as binary | Ruled out. `encoding:"utf8"` selects the text branch (`d.t` branch at 0x0000; `d.k` maps "utf8" → UTF_8). |
| Native exception swallowed | Ruled out by bytecode. `saveFile` catches and rejects with `FILE_NOTCREATED`; the plugin would have seen a thrown write error. |
| `rename`, `copy`, `remove`, FileObserver, or media scan truncating the temp | Ruled out by bytecode; none open the file for writing. |
| First write after process start | Not supported. Both processes had completed adapter writes before the failing one. |
| Fresh directory (objects/ just created) | Not a common factor. Failure 1 wrote into a `records/` directory holding 225 records. |
| Emulator crash or snapshot restore | No evidence. `emu-crash-37.2.12.db` is dated Oct 12; the failures are Oct 14 00:4x and 01:5x. |
| FUSE/MediaProvider or guest block-layer transient loss | **Remaining candidate.** Consistent with every observation (resolved write, empty readback, file still empty minutes later, non-reproducible under 120 identical probes, same code path succeeding immediately after). Not proven. |

## Narrow runtime diagnostic for root (hidden synthetic folder only)

Goal: on the next occurrence, capture whether bytes reached the lower filesystem, and what the native layers logged. Preserve the failed vault as already done. Run only in a hidden folder such as `.native-io-probe-<uuid>/` inside the disposable lab vault; never in a real vault.

1. **Instrument, do not alter, the production write.** Wrap `app.vault.adapter.fs.write`, `fs.read`, and `fs.stat` (the `j6` instance) in the debugger session so each call records: path, `data.length`, start/end timestamps, the resolved `uri`, and immediately after `write` resolves, an extra `fk.stat` (`size`, `mtime`) on the same path taken **before** the plugin's own `read`. Keep a ring buffer of the last 50 entries. The wrapper must rethrow unchanged. This is the same shape as root's `recordIO` capture, plus the post-write `stat`.
2. **On mismatch, snapshot both views of the path.** From the host, immediately run:
   ```
   adb shell ls -l '/storage/emulated/0/Documents/<vault>/<temp>'
   adb shell ls -l '/data/media/0/Documents/<vault>/<temp>'
   adb shell stat '/data/media/0/Documents/<vault>/<temp>'
   ```
   If the lower path (`/data/media/0`) holds the bytes while the FUSE path shows 0, the loss is FUSE page-cache coherence. If both are 0, the write never reached the lower file. Also capture `adb shell cat /proc/mounts | grep -E 'fuse|emulated'` once for the mount options.
3. **Capture native logs around the event.** Keep `adb logcat -v time -b main,system` running into a file during acceptance runs, and on failure extract ±30 s for tags `FuseDaemon`, `MediaProvider`, `Capacitor`, `Capacitor/Plugin`, `chromium`, `Obsidian`. Also `adb shell dmesg | tail -200` for `fuse` or I/O errors. The plugin logs `File '<abs>' saved!` at debug level and `Creating file … failed` at error level; the absence of the error line confirms the native layer reported success.
4. **Stress the realistic shape, not just the payload.** Loop N=500: `mkdir` a fresh subfolder, `write` the 80-byte payload to `<hash>.json.<uuid>.tmp`, `stat`, `read`, `rename` to `<hash>.json`, `read`, then a 37 834-byte text write with the same sequence, with ~50–300 ms idle gaps and occasional `app.vault.adapter.list` calls, matching the plugin's cadence. Record the post-write `stat.size` for each. This is cheap and runs under the same FUSE mount; it either reproduces (then step 2 decides) or raises the no-repro count.
5. **Add one restart boundary case.** Because failure 1 followed a force-stop/reopen, run 10 iterations of force-stop → launch → wait for vault load → run 20 iterations of step 4. Neither failure is proven to be restart-related, so treat this as coverage, not a hypothesis.

## Plugin-side recommendation

- **Keep the fail-closed check exactly as shipped.** `put()` verifies before rename and after rename, never renames an unverified temp, and the latest committed record is untouched; the repo test "an acknowledged empty record-temp write fails closed before rename" (`plugin/test/journal-store.test.ts:352-367`) covers this and should stay.
- **Do not add an automatic retry now.** A silent retry would convert an unexplained storage loss into an invisible event. If, after step 2 evidence, the cause is shown to be FUSE-side and bounded, the acceptable change is a single retry to a *new* temp name that records a durable `nativeErrors`-style entry naming the empty temp path, keeps the empty temp as evidence, and surfaces a warning in status. That change needs a test asserting the diagnostic entry and the retained temp, and it should wait for the device evidence.
- **Optional, low-risk improvement for diagnosability (not a fix):** on verification failure, include in the thrown message the temp path and the observed readback length (`store.ts:76-77`). Today the message cannot tell an empty readback from a corrupted one. This is a one-line change plus a test assertion on the message; it does not alter control flow.

## What this analysis does not establish

It does not prove the FUSE/MediaProvider layer is the cause; it shows that every other layer visible in source and shipped bytecode is incapable of producing the observed state. It did not read emulator or device logs. It did not run the APK or REA's JADX provider (unavailable); decompilation used dexdump bytecode, which is exact but less readable. Physical-phone storage (f2fs via FUSE on real MediaProvider builds) was not examined.
