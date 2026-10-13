# GitHub sync engine API

Engine modules under `plugin/src/git-sync/`. They depend only on `contracts.ts`, Web Crypto, `TextEncoder`/`TextDecoder`, `atob`/`btoa` and `structuredClone`. They have no Node or Obsidian runtime imports. The root wraps `SyncSession` with the GitHub `Repository`, an Obsidian `LocalVault` and a `DurableStore`.

## `codec.ts`

| Export | Purpose |
| --- | --- |
| `encodeBase64(bytes)`, `decodeBase64(text)` | Exact byte transport for `Entry.data`. Decoding is strict: whitespace, URL-safe alphabets and bad padding throw `IntegrityError`. |
| `hashBlob(bytes)` | Git blob SHA-1 (`blob <n>\0` + bytes). This is the `Entry.oid` contract. |
| `entryFromBytes(bytes, mode?)`, `entryFromText(text, mode?)` | Build a verified `Entry`. |
| `entryText(entry)` | Exact UTF-8 text, including any BOM, or `null` if the bytes are not valid UTF-8. |
| `isValidPath`, `isExcludedPath`, `isSyncablePath` | Structural path safety and V1 scope. Any hidden segment (`.git`, `.obsidian`, `.trash`, …) is out of scope. |
| `foldPath(path)` | NFC plus lowercase key used to detect case- and normalization-insensitive collisions. |
| `sameEntry`, `sameManifest` | Semantic equality: oid and mode, never the base64 text. |
| `verifyEntry`, `verifySnapshot` | Check every path is in scope and every entry's bytes hash to its oid. They throw `IntegrityError`. |
| `toRef`, `toManifest`, `Ref`, `Manifest` | Identity-only forms used for checkpoints and stored state. |

## `reconcile.ts` (pure)

`reconcile({ base, local, remote, decisions })` returns either `{ kind: "needs-decision", conflicts, merged }` or `{ kind: "ready", target, outgoing, incoming, merged, resolved }`.

- A change made on only one side is taken automatically. Equal changes converge.
- Both sides edited the same Markdown file (`.md`): it is merged line by line only if each changed region is separated from the other side's changes by at least one unchanged line, and all three versions are valid UTF-8. Otherwise the result is a `content` conflict. Line endings, BOM and a missing final newline are preserved byte-exact.
- Every deletion needs a decision, in both directions: `local-deletion`, `remote-deletion`, `local-deleted-remote-edited`, `local-edited-remote-deleted`. Other conflict kinds are `add-add` and `content`. If paths collide when case and Unicode normalization are ignored, the result is a `collision` with no in-app choice. The user renames one file and syncs again.
- `VersionConflict.id` hashes the kind, path and the exact base/local/remote versions. A decision applies only to the identical versions.
- Choices are `mine`, `remote`, `both` and `edit` (with an exact `Entry`). `both` keeps GitHub's version at the path and this device's version at `sibling`: `Name (conflict <local oid7>).ext`. It is offered only when that name is unused on every side.
- `incoming` lists guarded local steps. Creations and replacements run first, then deletions. A deletion that frees a folded name runs before the creation that needs it.
- Also exported: `mergeText`, `diff`, `splitLines`, `siblingPath`, `choicesFor`.

## `session.ts`: `new SyncSession({ repository, vault, store, deviceName?, now? })`

All methods are serialized: a call queues behind the one in progress. Any thrown error leaves the durable state consistent, so it is safe to call `sync()` again.

| Method | Network | Vault writes | Result |
| --- | --- | --- | --- |
| `status()` | no | no | `SessionStatus` without `pending` |
| `inspect()` | no | no (captures) | `SessionStatus` plus `pending` changes relative to the checkpoint |
| `previewEnrollment()` | yes | no | `EnrollmentPreview` (`token`, `items[{path, action}]`, `unchanged`, `reenrollment`), `already-enrolled` or `corrupt` |
| `enroll({ token })` | yes | **none** | `enrolled`, `stale` (with a fresh preview), `already-enrolled` or `corrupt` |
| `sync()` | yes | guarded | `SyncOutcome` (below) |
| `resolve({ conflictId, choice })` | no | no | `recorded`, `stale` or `invalid`. `choice.edit.data` is base64. |
| `keepLocal({ path })` | no | no | For a blocked step: keep this device's file. It is published by a later sync. |
| `previewRestore({ path, commit })` | yes | no | `RestorePreview` (historical and current `Entry`) or a refusal: `not-in-history`, `missing`, `invalid-path`, `busy`, `paused` |
| `restore({ token, path, commit })` | yes | one guarded write | `restored`, `unchanged`, `stale` or `blocked`. The result is a local draft; `sync()` publishes it as a new commit. |
| `listRecovery()`, `exportRecovery({ id })`, `discardRecovery({ id })` | no | no | Recovery summaries, exact bytes as a `Snapshot`, or removal (refused while an operation uses the record) |

`SyncOutcome` is one of:

- `unenrolled`
- `corrupt{detail}`
- `paused{pause}`
- `up-to-date{commit}`
- `synced{commit, published, carried}`
- `needs-decision{conflicts, merged}`
- `blocked{commit, steps[{path, reason}]}`
- `rejected{message}`
- `contended`: the branch moved three times in one call

`SessionStatus.phase` is one of `idle`, `local-changes`, `needs-decision`, `publication-unknown`, `applying`, `blocked` or `paused`.

### Enrollment

`enroll` writes only the durable state. The checkpoint becomes the previewed head, and a per-path *carry* records what each local file descends from. The first `sync()` then downloads, uploads and asks for decisions through the normal guarded path. Preview actions:

- `download`
- `upload`
- `conflict` (an `add-add` decision)
- `update-local`, `review-local-deletion` and `review-remote-deletion`: only when re-enrolling after a pause. Local files are classified against the old checkpoint, so content removed by a rewrite is offered as a remote deletion and never silently re-uploaded.

The token covers the repository identity, head, old checkpoint and the full local manifest. Any change returns `stale`.

### One sync transaction

1. Load state, then check the repository identity. A mismatch pauses with `repository-changed`.
2. Resume any persisted operation (see below).
3. Read the head and verify all bytes. If the checkpoint is not an ancestor of the head, pause with `history-rewritten`.
4. Capture the vault and verify it.
5. Build the effective base: checkpoint plus carry. Its bytes come from local, remote or stored blobs, and the checkpoint commit is fetched only if some bytes are missing. If the stored manifest differs from that commit, pause with `base-mismatch`.
6. Reconcile with the recorded decisions. Any open decision pauses the whole batch and is saved as `review`.
7. Save a recovery record of every local draft and every preimage the steps may overwrite. If nothing goes out, save an `apply` operation for the head. Otherwise `prepare` the candidate, require its files to equal the planned target exactly, and save a `publish` operation (parent, candidate, target, steps) **before** `publish(parent, candidate)`.
8. Anything other than `accepted` is settled from the branch:
   - Head equals the candidate, or the candidate is its ancestor: published, even if later commits reverted the content.
   - Head equals the parent, or descends from the parent without the candidate: not published. The operation is dropped and the batch re-planned.
   - Anything else: pause with `history-rewritten`.
   - An ancestry lookup that throws leaves the operation in place as `publication-unknown`.
   - A candidate is never re-published after it is known to have landed.
9. Apply the steps with `LocalVault.apply(path, expected, next)`. When resuming after a restart, the vault is captured again and the target commit is read again first.
   - Current equals `next`: the step counts as applied.
   - Current differs from `expected`: the step is `changed`. The newer edit is kept and carried, with its own base, into the next reconcile, so it merges or conflicts instead of overwriting GitHub's change.
   - `blocked`: the operation is held. Each later `sync()` makes exactly one more attempt, nothing else is published, and `keepLocal` or a manual change releases it.
10. Only after every step is accounted for, advance the checkpoint to the target commit. Then clear decisions and review, and set carry from the changed and kept steps.

## Durable state (`state.ts`)

Format `github-vault-sync/1`, saved whole through `DurableStore.save`. It contains:

- repository identity
- checkpoint `{commit, tree, files: Manifest}`
- carry
- at most one operation
- pause
- review
- decisions
- recovery records
- content-addressed `blobs` (oid → base64)
- an id counter

`parseState` rejects any unknown or missing key, an invalid path, oid, mode or enum, duplicate steps or records, and a step preimage missing from its recovery record. It also re-hashes every blob and requires every referenced blob to be present. Rejection yields `corrupt`, and every method then refuses to mutate. The root must move the bad state aside explicitly before enrolling again.

Recovery records are immutable. A record stays pinned while any of its bytes might exist only on this device. Unpinned records, whose bytes are in an old or new checkpoint on GitHub, are pruned beyond the newest 20. Pinned records stay until `discardRecovery`.

## Requirements on the root's ports

- `LocalVault.capture()` returns only in-scope paths with correct oids. It must report a stable **mode** for a file the engine wrote: an adapter that cannot store the executable bit must keep the applied mode, or `100755` files will appear as local mode changes and be republished.
- `LocalVault.apply(path, expected, next)` is compare-and-swap:
  - `expected: null` means exclusive create.
  - `next: null` means move to trash.
  - It returns `changed` if the file is not exactly `expected`.
  - Markdown replacement should use the atomic `vault.process`.
  - Existing binary replacement and deletion should return `blocked` until a safe primitive is demonstrated.
- `Repository.publish` must use the exact `beforeOid`. The engine never needs a force update. `isAncestor` should throw rather than guess when it is unsure.
- `DurableStore.save` must be durable when it resolves. It receives the whole state, including pinned blobs (local drafts, preimages, conflict versions).

## Known limits

- Suppose a lost publication response is followed by someone force-resetting the branch back to exactly the candidate's parent. The engine then treats the candidate as unpublished and re-plans from the live vault. This case is indistinguishable without reflog access.
- Every sync verifies every byte of the head and the capture. This is simple and safe but costs O(vault size) hashing.
- Edits made outside the CAS window by other writers, and unsaved editor buffers, are outside the engine's guarantee. Captured snapshots are the preservation contract.
