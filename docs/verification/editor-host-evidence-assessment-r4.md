# Editor host-evidence assessment, round 4 (read-only)

Date: 2026-10-14. Root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600` at `a23c77e`, clean tree. No source, device, remote, vault, or repository writes. Only this file and a read-only extraction of the locally shipped Obsidian 1.14.4 bundle under `/tmp/obsidian-1.14.4-asar/` (extractor at `/tmp/asar-tools/`) were written.

## Verdict in four sentences

The three Android probes (R1, R2, R3) never exercised the path a Markdown editor takes in production: every fixture carries a `\u000b` byte, which forces the binary rename transaction, while a normal note is applied through Obsidian's `vault.process`. The state the probes tried to hold (a Markdown view bound to an extensionless file under `.git-vault-sync/.../hold/`) is one the host actively tears down: any reconcile of a dot-prefixed path is treated as a deletion, the view is closed, and a dirty buffer on a deleted file is discarded by the host without a write. That artificial loss is not reachable from the normal visible editor path, and the rename path's remaining R3-E window cannot be entered through the UI. The one representative real-host test still missing is the production text path against a real `MarkdownView` on Android in three states (clean, dirty-unsaved, saved), which is cheap and decides the safety claim that matters.

## 1. What R1, R2, R3 actually established

### 1.1 The probes exercised the binary path, not the editor path

All three probes build their fixture as `"...original <id>\n\u000b"` and `"...incoming <id>\n\u000b"` (`plugin/test/native/editor-race-acceptance.ts:76-81`, `editor-race-retention-r3.ts:75-77`). Production selects the method at `plugin/src/git-sync/obsidian-vault.ts:605-607`:

```ts
const method = visible(path) && expected && next
  && exactText(decodeBase64(expected.data)) !== null && exactText(decodeBase64(next.data)) !== null
  ? "text-process" : "rename";
```

`exactText` (`obsidian-vault.ts:33-38`) rejects `\x00-\x08 \x0b \x0c \x0e-\x1f \x7f` and non-UTF-8. Tab, LF, CR, BOM and all printable Unicode pass. The vertical tab in the fixture is the only reason a `.md` file took the hold/stage rename route. So the probes measured the transaction that production uses for images, PDFs, audio, video, and the rare `.md` with control bytes. They measured nothing about `textTransaction` (`obsidian-vault.ts:242-301`), which is the path for every ordinary note.

The docs already say this is the intended split: "Automatic text replacement uses Obsidian's atomic process operation; other writers and unsaved editor buffers are explicit boundaries" (`docs/implementation-plan.md:9`); "notes stay on `process` and are never renamed while open" (quoted in `docs/verification/native-review-r1.md:28`).

### 1.2 Why each probe failed, from the host source

Obsidian 1.14.4 bundle: `~/Library/Application Support/obsidian/obsidian-1.14.4.asar`, SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`, `app.js` 3,942,126 bytes. Offsets below are character offsets into that `app.js`. The same bundle contains both the desktop filesystem adapter and the Capacitor adapter (two `process`, `write`, `rename`, `reconcileFile` implementations; 30 `isAndroidApp` branches), so the view, vault, and reconcile logic cited here is the shared core, not desktop-only code. Device confirmation is still required for anything stated as Android behavior.

- **R1** ("Obsidian did not open a real Markdown FileView", `viewType: "empty"`). `WorkspaceLeaf.openFile` (@1571713) picks the view type from `viewRegistry.getTypeByExtension(file.extension)`; the retargeted `TFile` has extension `""`, so no type resolves, and the leaf shows the "unsupported file type" notice or hands off to the OS. This is a harness assumption, not a plugin behavior.

- **R2** (explicit `setViewState({type:"markdown", state:{file: hold}})` bound the view, but it was gone by the time apply returned). `FileSystemAdapter.rename` and the Capacitor `rename` (@555085, @1352818) emit `"renamed"` unconditionally when the source was indexed, so the `TFile` is retargeted to the hidden hold. This matches the earlier device observation in `docs/verification/android-rename-primitive.md:14`: "Obsidian emits a rename to that path, followed by a delete event for the hidden file." The delete comes from `reconcileFile` (@560835 desktop, @1356309 Capacitor): its first step is `if (Al(path)) return reconcileDeletion(...)`, and `Al` (@543574) is true when any path segment starts with `.`. The vault then triggers `"delete"`, and `FileView.onDelete` (@1535063) on a view whose `allowNoFile` is false (the `FileView` default, and `MarkdownView` does not override it) navigates back or opens an empty view. That is exactly the `"empty"` leaf in the R3 census.

- **R3** (view bound, draft set, `requestSave()` called, hold stayed at the original hash, leaf empty before the stage-to-visible rename). `TextFileView.requestSave` (@2807433) sets `dirty` and debounces `save` by 2,000 ms. When the host's delete lands first, the leaf is unloaded and `onUnloadFile` calls `save(true)`, which returns immediately on `file.deleted` without writing and without a backup (`save` body @2807433: `if(!n||n.deleted)return`). If the debounced save had fired first, `vault.modify` would have written the draft into the hold and the write's own `reconcileInternalFile` would then have triggered the same deletion. Either ordering ends with the view closed; only the first ordering drops the draft, and that is the host's deleted-file policy, identical to deleting any note from outside Obsidian while it is being edited.

`MarkdownView` (`L8`, @3086187-3099685) extends `TextFileView` (`Q4`) directly and overrides none of `onModify`, `loadFileInternal`, `save`, or `isPlaintext`.

### 1.3 Evidence scope, stated plainly

- The R1-R3 JSON files are evidence that the harness premise was wrong. They are not evidence for or against the production editor path, and should stay filed as "harness assumption" records, as `docs/implementation-plan.md:66` already does.
- They do contain one reusable host fact: a `FileView` bound to a `TFile` that the host removes from its index is closed, and an unsaved `TextFileView` buffer on that file is not flushed. This is relevant only to the rename path and only if a view can bind the hold, which the next section rules out for UI-driven opens.
- Nothing in the three runs touched `vault.process`, three-way merge, the 2 s autosave window on a visible note, or any real typing. The sentence "unsavedBufferGuaranteeProven: false" in the R3 result is correct and should stay.

## 2. Is the hidden-view loss reachable from the normal visible editor path?

Production has four shapes of apply for a path a user might have open.

**(a) Ordinary note, expected and next both exact text: `text-process`.** `textTransaction` calls `app.vault.process(file, fn)`; `fn` returns the text unchanged unless it equals `expected`, then verifies by hashing the file afterwards. No rename, no stage, no hold, the `TFile` never moves, and no hidden file ever holds editor bytes. On the host side (`Vault.process` @1425360 region, adapter `process` @550422/@1347923):

- `process` increments `file.saving`, runs the adapter's read-modify-write inside the adapter's single promise queue, sets the content cache from the result, and the adapter's post-write reconcile triggers `"modify"`.
- `TextFileView.onModify` ignores the event only while the view's own save is in flight. Otherwise `loadFileInternal(file, false)` reads the new text and, if the view is dirty and the buffer differs from the last saved text and `isPlaintext` is true, replaces the buffer with `e2(lastSaved, buffer, disk)` (@2679090: diff-match-patch `patch_make(lastSaved→buffer)` applied to `disk`) and shows the notice `“{{file}}” has been modified externally`. `dirty` stays true, so the already scheduled 2 s save then persists the merged text through `vault.modify`.
- Net effect for a Markdown view: a clean view simply shows the incoming text; a dirty view shows incoming plus the user's unsaved hunks, and that merge becomes the next local edit the engine captures and publishes. No side is dropped by the plugin.
- Residual ordering inside the adapter queue: if the editor's save captured its buffer and is waiting on `adapter.promise` when the plugin's `process` is enqueued ahead of it, the editor's `modify` lands after the install and writes the stale buffer over the incoming text. `textTransaction` then reads back `after !== next` and, because `fn` matched, retains the live bytes as `interrupted` (`obsidian-vault.ts:291-296`); the engine ingests the issue and holds the path (`session.ts:1302-1304`). The user's bytes are on disk, the incoming bytes are in the remote and in the journal. Opposite ordering yields `changed`. Neither ordering loses bytes; this is the R4-8 shape already covered in Node.
- Canvas and Bases views set `isPlaintext=false` (@3423805, @3135728). For them the host does not merge: a dirty buffer is replaced by the disk text. That is host policy for every external writer, including Obsidian Sync, and is a true "unsaved buffer within the 2 s window" limitation to document, not something the plugin can intercept.

**(b) Visible binary or non-text replacement: `rename`.** `apply` refuses to begin when a `FileView` is bound (`obsidian-vault.ts:608-609`), rechecks before and after the hold rename and rolls the hold back with `clearAttempt` if a view appeared (`:168-185`), and `finish` withholds the journal finish while any view is bound to the hold (`:122-133`, reviewed in `native-editor-review-r4.md`). The R3-E window is the gap between the post-hold check and the stage-to-visible rename. To enter it from the UI, a `FileView` must bind the hold `TFile` during that gap. `openFile` on the retargeted `TFile` cannot (no extension, see R1). `openFile` on the visible path during the gap resolves nothing, because the only `TFile` is at the hold and the visible path is absent until the install rename. A view that bound before the hold rename is caught by the post-rename check. The only way in is `setViewState` with the hold path from plugin code, which is what R2 and R3 did, and the host then deletes that `TFile` on the next reconcile. Furthermore, the files that take this path in practice (images, PDF, audio, video) open in views with no editable buffer; only an `.md` with control bytes could put a `MarkdownView` here.

**(c) Visible deletion: `rename` with no stage.** Same open-view refusal before `begin` and after the hold rename. There is no second rename, so no R3-E window. An open view yields `blocked` with "Close the open view before replacing or deleting ...", which the engine records as a held path.

**(d) Hidden configuration paths.** No `TFile`, no views. Out of scope here.

Conclusion: the loss scenario the probes constructed is reachable only by a plugin deliberately binding a Markdown view to the hidden hold path, and even then the host closes it. On the normal visible editor path the plugin never moves the note, uses the host's merge-aware write, and the only unsaved-buffer behavior in play is the host's own 2 s autosave policy.

## 3. What the plugin can promise, and what no plugin can

**Saved-edits guarantee (claimable, and what the Android test should pin).** Bytes that are on disk when apply runs are never replaced without an exact compare: `process` compares inside the host's queue; the rename path compares before the hold rename, retains the hold, and reads back after install; any mismatch becomes `changed`, `interrupted`, or `displaced` with the live bytes retained in the journal. A late write over an installed file is caught by read-back or the next hidden scan and retained, never discarded. Rename-method dispatch is refused while a `FileView` is bound, and finish is withheld while a view is bound to the hold.

**Unsaved-buffer guarantee (not claimable by any plugin).** Unsaved text lives in host memory, in `TextFileView` subclasses the plugin does not own, and in third-party views (Excalidraw, Kanban, and similar) with their own save policies. The plugin cannot read, flush, lock, or veto those buffers; it only sees what the host writes. What it can do it already does: use `vault.process` so the host's merge path runs, and never rename a note's `TFile` while a view is bound. The honest statement is the existing one in `docs/engine-api.md:48` and `docs/implementation-plan.md:9`, plus one addition: for Markdown views the host three-way merges unsaved text on external modify; for non-plaintext text views (canvas, bases) the host replaces it; both are host behavior inside its 2 s autosave window.

## 4. The minimally representative real-host test

One disposable helper, same scaffolding as R3 (`scripts/build-native-editor-race.mjs` pattern; lab vault "Vault Sync Lab"; production plugin disabled; isolated journal; bundled current `GitObsidianVault`; census and result JSON). Fixtures must be plain UTF-8 text with no control bytes so production selects `text-process`. Open the note with `leaf.openFile(file)` so the view is the host's natural `MarkdownView`, and assert `view instanceof MarkdownView && view.file === file && file.path === path` before and after each apply. Assert after every case that `.git-vault-sync/<run>/hold` and `/stage` are empty and `pendingIntents()` is empty, which proves the text path was taken.

- **T1 clean view.** Original has lines L1..L5. Incoming changes L1. Apply. Expect `applied`; disk equals incoming immediately; within a bounded wait `view.getViewData()` equals incoming; `TFile.path` unchanged.
- **T2 dirty unsaved buffer, non-overlapping.** Open, then `editor.replaceRange("draft\n", {line:5,ch:0})` and do not wait (well under the 2 s debounce). Apply incoming that changes L1. Expect `applied`; disk equals incoming immediately (the CAS matched the on-disk preimage); within about 3 s `view.getViewData()` contains both the incoming L1 and the draft line, and disk equals that merged text once the debounced save lands; a `vault.capture()` then shows the merged bytes as the new local version. This is the host merge, observed on the real device, and the exact behavior the engine relies on to publish rather than lose the draft.
- **T3 saved edit before apply.** Set the draft, wait until disk equals the draft (bounded, 4 s), then apply with the original as `expected`. Expect `changed`; disk and view unchanged; nothing retained. This is the saved-edits guarantee at the host boundary and the case the engine turns into a decision.
- **T4 (record only, do not gate) overlapping dirty hunk.** Same as T2 but the draft edits L1 as well. Record what `patch_apply` produced and whether the draft hunk survived. This is host merge policy; the result belongs in the limits section, not in a pass/fail check.

Checks to carry over from R3: installed production SHA as provenance, production plugin disabled, UUID fixture names unused, R1-R3 result files byte-identical before and after.

What this run establishes if it passes: on the real Android host, the production text path with a real `MarkdownView` in clean, dirty-unsaved, and saved states never loses on-disk bytes, and the host merges an unsaved Markdown buffer instead of discarding it. What it does not establish and must say so: the sub-millisecond in-flight-save ordering (kept as the Node `interrupted` case), non-plaintext views, third-party views, power loss, and physical storage providers.

## 5. What not to do

- No timeout tuning. R3's 2 s debounce, 10 s poll, and 5 s TFile wait were not causal; the host removes any dot-path `TFile` on reconcile regardless of timing.
- No native redesign. The rename path's guards match the only files that take it, and R3-E is not enterable from the UI. The existing `finish` withhold already reports a view that somehow binds the hold.
- No further hidden-hold editor probes. R1-R3 have exhausted that premise; a fourth run would reproduce section 1.2.
- Do not promise unsaved-buffer protection for canvas, bases, or third-party views. Document the host's 2 s window and its merge-versus-replace split instead.

## 6. Source fingerprints and locations

Repository (HEAD `a23c77e`):

```text
plugin/src/git-sync/obsidian-vault.ts        method selection :605-609; textTransaction :242-301; rename guards :168-185; heldViewBlock/finish :122-133
plugin/src/git-sync/native-transactions.ts    hold/stage naming :298-299 (`<root>/hold/<uuid>`, no extension)
plugin/test/native/editor-race-acceptance.ts  fixtures :76-81 (\u000b), explicit setViewState :205-214
plugin/test/native/editor-race-retention-r3.ts fixtures :75-77, hook :241-262, requestSave :253
docs/verification/android-v2-editor-race-{first,r2,r3}-result.json  as read
docs/verification/android-rename-primitive.md:14  earlier device observation of rename-then-delete for the hidden path
```

Obsidian 1.14.4 `app.js` (extracted read-only; character offsets):

```text
@543574   Al(path): true when any segment starts with "."
@555085   desktop adapter rename: unconditional "renamed" trigger
@1352818  Capacitor adapter rename: same
@560835   desktop reconcileFile: Al(path) -> reconcileDeletion
@1356309  Capacitor reconcileFile: same
@1420955  Vault raw handler: "modified" keeps cache while file.saving; "renamed" retargets TFile; "file-removed" -> "delete"
@1425360  Vault.modify / Vault.process: file.saving++ around the queued adapter op
@550422   desktop adapter write; @1347923 Capacitor adapter write (both inside the adapter queue)
@1535063  FileView.onRename (title only), onDelete (navigate back / open(null)), canAcceptExtension default false
@1571713  WorkspaceLeaf.openFile: view type from file.extension
@2679090  e2(base, ours, theirs): diff-match-patch patch_make + patch_apply
@2807433  TextFileView: requestSave (2000 ms debounce), save (returns on file.deleted), onModify, loadFileInternal (merge when dirty && isPlaintext)
@3086187  MarkdownView extends TextFileView; no override of the above; isPlaintext stays true
@3423805  Canvas view isPlaintext=false; @3135728 Bases view isPlaintext=false
i18n.js   msgFileChanged: "“{{file}}” has been modified externally"
```
