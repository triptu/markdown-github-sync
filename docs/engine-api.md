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
| `dictionary(entries?)`, `own(values, key)` | Construct a null-prototype dictionary and read an own entry only. Verified snapshots, manifests, plans, recovery exports, and dictionaries passed to the store use null prototypes. |

## `reconcile.ts` (pure)

`reconcile({ base, local, remote, decisions, reviewScope? })` returns either `{ kind: "needs-decision", conflicts, merged }` or `{ kind: "ready", target, outgoing, incoming, merged, resolved }`.

- A change made on only one side is taken automatically. Equal changes converge.
- Both sides edited the same Markdown file (`.md`): it is merged line by line only if each changed region is separated from the other side's changes by at least one unchanged line, and all three versions are valid UTF-8. Otherwise the result is a `content` conflict. Line endings, BOM and a missing final newline are preserved byte-exact.
- Every deletion needs a decision, in both directions: `local-deletion`, `remote-deletion`, `local-deleted-remote-edited`, `local-edited-remote-deleted`. Other conflict kinds are `add-add` and `content`. If paths collide when case and Unicode normalization are ignored, the result is a `collision` with no in-app choice. The user renames one file and syncs again.
- `VersionConflict.id` hashes `reviewScope`, the kind, the path, and the exact base, local, and remote versions. `SyncSession` supplies the remote commit and a durable review generation as the scope. Any observed change to the head or local manifest invalidates all approvals and creates a new generation. Every enrolled capture performs local invalidation, including `inspect`, restore previews, enrollment surveys, and publication recovery previews. A successful restore invalidates approvals durably before writing, including when its response is lost. A recreated file followed by a second observed deletion therefore requires a new approval.
- Direct callers that retain decisions across captures supply their own `reviewScope`. The default empty scope is suitable only for one review of fixed inputs. Input dictionaries are copied using their own enumerable keys.
- Choices are `mine`, `remote`, `both` and `edit` (with an exact `Entry`). `both` keeps GitHub's version at the path and this device's version at `sibling`: `Name (conflict <local oid7>).ext`. It is offered only when that name is unused on every side and passes the same scope and path-length validation as stored paths. Otherwise `sibling` is `null`, and the remaining choices still work.
- `incoming` lists guarded local steps with `consent: {kind: "automatic"}` or `{kind: "reviewed", base: Entry | null}`. Every mutation produced by a conflict choice, including a `both` sibling, is reviewed. `base` retains the original conflict base. A sibling's base is absence. Creations and replacements run first, then deletions. A deletion that frees a folded name runs before the creation that needs it.
- Also exported: `mergeText`, `diff`, `splitLines`, `siblingPath`, `choicesFor`.

## `session.ts`: `new SyncSession({ repository, vault, store, deviceName?, now? })`

Durable transactions are serialized: a call queues behind the one in progress. `notifyLocalChange()` increments the session’s local event generation synchronously, before joining that queue. Active transactions see forwarded events across await boundaries. Any thrown error leaves the durable state consistent, so it is safe to call `sync()` again.

| Method | Network | Vault writes | Result |
| --- | --- | --- | --- |
| `status()` | no | no | `SessionStatus` without `pending` |
| `inspect()` | no | no (captures) | `SessionStatus` plus `pending` changes relative to the checkpoint |
| `notifyLocalChange()` | no | no | `invalidated` or unavailable. Immediately retires review and operation approval for active transactions; its queued result confirms durable invalidation. Includes cycles that return to identical captured bytes. |
| `previewEnrollment()` | yes | no | `EnrollmentPreview` (`token`, `items[{path, action}]`, `unchanged`, `reenrollment`), `already-enrolled` or `corrupt` |
| `enroll({ token })` | yes | **none** | `enrolled`, `stale` (with a fresh preview), `already-enrolled` or `corrupt` |
| `sync()` | yes | guarded | `SyncOutcome` (below) |
| `resolve({ conflictId, choice })` | no | no | `recorded`, `stale` or `invalid`. `choice.edit.data` is base64. |
| `keepLocal({ path })` | no | no | For a blocked step: keep this device's file. It is published by a later sync. |
| `previewRestore({ path, commit })` | yes | no | `RestorePreview` (historical and current `Entry`) or a refusal: `not-in-history`, `missing`, `invalid-path`, `busy`, `paused` |
| `restore({ token, path, commit })` | yes | one guarded write | `restored`, `unchanged`, `stale` or `blocked`. The result is a local draft; `sync()` publishes it as a new commit. |
| `previewPublicationRecovery()` | yes | no (captures) | A `PublicationRecoveryPreview`, `missing`, `reachable`, `paused`, or an unavailable outcome |
| `recoverPublication({ token })` | yes | **none** | `released{pause}`, `stale`, or a recovery refusal. Archives the reviewed candidate and current local bytes before requiring re-enrollment. |
| `listRecovery()`, `exportRecovery({ id })`, `discardRecovery({ id })` | no | no | Recovery summaries, exact bytes as a `Snapshot`, or removal (refused while an operation uses the record) |

`SyncOutcome` is one of:

- `unenrolled`
- `corrupt{detail}`
- `paused{pause}`
- `up-to-date{commit}`
- `synced{commit, published, carried}`
- `needs-decision{conflicts, merged}`
- `blocked{commit, steps[{path, reason}]}`
- `publication-unknown{operationId, parent, candidate, head}`: the candidate is not confirmed reachable. The operation remains held.
- `rejected{message}` and `contended` remain in the public union for compatibility. Current publication handling returns `publication-unknown` whenever reachability is unconfirmed, including a rejected or head-moved classification.

`SessionStatus.phase` is one of `idle`, `local-changes`, `needs-decision`, `publication-unknown`, `applying`, `blocked` or `paused`.

### Enrollment

`enroll` writes only the durable state. The checkpoint becomes the previewed head, and a per-path *carry* records what each local file descends from. The first `sync()` then downloads, uploads and asks for decisions through the normal guarded path. Preview actions:

- `download`
- `upload`
- `conflict` (an `add-add` decision)
- `update-local`, `review-local-deletion` and `review-remote-deletion`: only when re-enrolling after a pause. Local files are classified against the old checkpoint, so content removed by a rewrite is offered as a remote deletion and never silently re-uploaded.

The token covers the repository identity, head, old checkpoint, full local manifest, and the session’s local event generation. Forwarded events invalidate it even when the bytes return to the reviewed manifest. Preview tokens belong to one session instance; a restart requires a fresh preview.

Enrollment returns `already-enrolled` while any operation is active, including during a repository identity pause. Enrollment cannot erase an uncertain publication. If the original repository identity is restored while an operation is held, `sync()` resumes that operation.

### One sync transaction

1. Load state, then check the repository identity. A mismatch pauses with `repository-changed`.
2. Resume any persisted operation (see below).
3. Durably mark a pending observation before reading the head when review or operation consent is live. Read the head and verify all bytes. Record the consent result and clear the marker in one save. If the checkpoint is not an ancestor of the head, pause with `history-rewritten`.
4. Capture the vault and verify it. Every enrolled capture archives previously unarchived local drafts in pinned recovery and invalidates any review whose local manifest changed before returning. Inspection and previews can therefore save durable state without writing vault files.
5. Verify the checkpoint against its immutable commit, reusing the head when identical. Recover a missing legacy `__proto__` baseline from that commit before classifying deletions. Other manifest differences pause with `base-mismatch`. Build the effective base from the checkpoint plus carry, using bytes from local, remote, or stored blobs.
6. Validate the review head, captured local manifest, and local event generation before reusing decisions. Events observed before capture retire old approvals; events during capture, checkpoint verification, or reconciliation restart the review from a new capture. Prune approvals that no longer match current conflicts. The durable review includes approved conflicts so other unresolved paths cannot resurrect an invalidated approval. Status and sync outcomes show only unresolved conflicts.
7. Save recovery records of every local draft, every preimage the steps may overwrite, and every intended incoming version. Incoming bytes are pinned for the active operation and available through `exportRecovery`. If nothing goes out, save an `apply` operation for the head. Otherwise `prepare` the candidate, require its files to equal the planned target exactly, and save a `publish` operation (parent, candidate, target, steps) **before** `publish(parent, candidate)`. Recheck the local event generation after preparation and after the durable operation save, immediately before publication dispatch. If it changed, clear the unsent operation durably and reconcile again without the old approvals. Apply-only operations receive the same check before starting vault writes. A candidate already dispatched to the repository retains the normal reachability settlement rules; later events cannot cancel its in-flight publication.
8. Anything other than `accepted` is settled from the branch:
   - Head equals the candidate, or the candidate is its ancestor: published, even if later commits reverted the content.
   - Otherwise: return `publication-unknown` and retain the operation. An unchanged parent, a sibling descendant, an unrelated rewind, or a missing candidate cannot prove nonpublication. The engine prepares and publishes no further candidates while held.
   - An ancestry lookup that throws leaves the operation in place as `publication-unknown`.
   - A candidate is never re-published after it is known to have landed.
9. Apply the steps with `LocalVault.apply(path, expected, next)`. When resuming after a restart, the vault is captured again and the target commit is read again first. Each dispatch consumes forwarded events and checks the operation's durable approval.
   - Any forwarded local event revokes the operation's approval, including an unrelated change or a same-byte recreation. A captured manifest change also revokes approval. An adapter CAS result of `changed` independently proves a local change. Before dispatching each CAS with live consent, the engine saves a pending observation; afterward it saves the step result, updated local manifest or revocation, and settled observation together. A failed result save therefore leaves either the pending marker or the recorded result. Revocation survives review clearing, publication promotion, failure before persistence, save response loss, and restart.
   - A pending or blocked reviewed step that still needs a write and has revoked approval is accounted for as `revoked`, without a vault dispatch. Its live bytes remain intact. Automatic steps can continue.
   - Current equals `next`: the step counts as applied.
   - Current differs from `expected`: the step is `changed`. The newer edit is kept and carried, with its own base, into the next reconcile, so it merges or conflicts instead of overwriting GitHub's change.
   - `blocked`: the operation is held. Captures at resume and after application preserve newer drafts before the blocked return. Each later `sync()` makes exactly one more attempt, nothing else is published, and `keepLocal` or a manual change releases it.
10. Recapture the vault after application. Save the exact newer draft bytes in pinned recovery records before advancing the checkpoint. Carry records the draft origin separately from its captured bytes. A revoked reviewed step uses its original conflict base as its carry origin. This lets the next reconcile request a fresh decision for a deletion or conflicting replacement, even if the bytes returned to the approved snapshot. Pin origin references before any intermediate save can prune blobs, then persist the carry with the new checkpoint. Edits to other paths during application are captured too. Only after every step is accounted for and newer drafts are durable does the checkpoint advance. Then clear decisions and review.

### Approval for durable local steps

State stores `observation: "settled" | "pending"`. Before a head read, enrolled vault capture, or local CAS that can disprove live consent, the engine durably saves `pending`. The port is called only after that save resolves. The result and its effect on consent are saved together with `settled`; CAS results also record the completed step and update the expected local manifest. Events received during the attempt save are checked again before a reviewed CAS dispatch.

Loading an unresolved observation retires the review and decisions and revokes operation approval before further effects. The loader preserves captured local conflict versions and edited replacements in recovery, then durably settles that revocation. This is deliberately conservative: a pending save whose acknowledgement was lost can require fresh review even if the port was never called. Failure before the attempt save lands cannot dispatch the observation. Failure before the result save lands cannot restore approval, even when the observed bytes later return to their prior values. Observations without live review or valid operation approval need no consent marker.

An operation stores `approval: {kind: "valid", local: Manifest}` or `{kind: "revoked"}` independently of the current review. The valid manifest starts with the captured local snapshot. A completed engine write updates that manifest at its path. Revocation applies to every remaining reviewed step, regardless of which path changed, and cannot become valid again within that operation.

Resume and each local dispatch enforce revocation. A file already equal to the intended target counts as applied without a write. Completed or already dispatched writes retain their results. Publication settlement still follows branch reachability, and a revoked local step cannot cause an accepted candidate to be published again.

After all steps are accounted for, the engine advances the checkpoint with carried drafts and clears the operation. A direct application can return `synced` with revoked paths in `carried`. The next sync produces a fresh review. A resumed application continues into reconciliation in the same sync. Automatic adapter blocks retain the existing `blocked` and `keepLocal` workflow.

A save that throws does not advance the in-memory generation trusted by later loads. Queued event notifications therefore revoke a pending operation even when its save landed and its acknowledgement was lost. A notification whose save landed also protects a fresh session after restart. A save failure before persistence requires another successful save before restart can rely on that notification.

### Other local decisions

`resolve` checks the local event generation before recording a choice and after saving it. An intervening event returns `stale` and retires the approval durably. Restore tokens include the local event generation and session identity; `restore` checks again after its preservation save, before dispatching the guarded vault write. Same-byte cycles therefore require a fresh preview. Once a vault write or repository publication has been dispatched, later events cannot cancel that in-flight operation; CAS and post-application capture preserve newer drafts.

`keepLocal` expresses the intent to retain the live file of a blocked step, without binding approval to captured bytes. The next application capture preserves its current bytes as a draft. Recovery listing, export, and discard operate on immutable record IDs rather than approval tokens.

### Reviewed publication recovery

`previewPublicationRecovery()` returns a token, the operation ID, the parent, the candidate, the current head, and three exact snapshots: `candidateFiles`, `headFiles`, and `localFiles`. The candidate must match its recorded immutable commit and target manifest. A reachable candidate returns `reachable`; normal sync can settle it.

`recoverPublication({ token })` rechecks the repository identity, head, operation, captured local manifest, and local event generation. A changed review returns `stale`. A successful review archives the entire candidate and current local snapshot in pinned recovery records. It clears the operation and pauses with `history-rewritten`, requiring a new enrollment preview. No GitHub ref or vault file changes.

The captured local versions become the origins for re-enrollment. Differences from the live head are then offered as local updates or reviewed remote deletions. Abandoned content is not automatically replayed. Restoring an archived draft later remains an explicit user action. Recovery requires access to the recorded candidate; an unavailable object leaves the operation held.

## Durable state (`state.ts`)

Format `github-vault-sync/2`, saved whole through `DurableStore.save`. It contains:

- observation state `settled` or `pending`
- repository identity
- checkpoint `{commit, tree, files: Manifest}`
- carry
- at most one operation, with incoming preservation `{kind: "captured", recoveryId}` or `{kind: "legacy"}`
- operation approval `{kind: "valid", local: Manifest}` or `{kind: "revoked"}`
- step consent `{kind: "automatic"}` or `{kind: "reviewed", base: Ref | null}`, with status `pending`, `applied`, `changed`, `blocked`, `kept`, or `revoked`
- pause
- review `{head, scope, local: Manifest, conflicts}`
- decisions
- recovery records
- content-addressed `blobs` (oid → base64)
- an id counter

`parseState` rejects any unknown or missing key, an invalid path, oid, mode or enum, duplicate steps or records, a step preimage missing from its recovery record, and any captured incoming step missing from its incoming recovery record or target manifest. Approval and consent metadata also have exact keys. Deletions require reviewed consent. A revoked step requires reviewed consent and revoked operation approval. Every referenced conflict origin must have verified local bytes. It also re-hashes every blob and requires every referenced blob to be present. Rejection yields `corrupt`, and every method then refuses to mutate. The root must move the bad state aside explicitly before enrolling again.

Recovery reasons are `sync`, `enrollment`, `restore`, `incoming`, `carried`, `publication-recovery`, `conflict-edit`, and `migration`. Edited conflict replacements are archived when recorded, so invalidating approval cannot discard their bytes. Previous reviewed local versions are also archived before review replacement.

Recovery records are immutable. A record stays pinned while any of its bytes might exist only on this device. Unpinned records, whose bytes are in an old or new checkpoint on GitHub, are pruned beyond the newest 20. Pinned records stay until `discardRecovery`.

### Migration from older state

Older `/2` records without `observation` cannot prove whether a consent-invalidating observation finished. They migrate as unresolved: review and decisions are retired, operation approval is revoked, and reviewed local versions and edited replacements are archived. Completed steps, carry, incoming recovery, publication identity, and reachability settlement remain intact. This also applies to older `/2` records that already contain operation approval and step consent metadata. A missing marker never grants permission to replay a publication or a reviewed local write.

`parseState` accepts legacy state and returns `/2`. Legacy review and approvals are discarded because their scope cannot be proven. Captured local conflict versions and edited replacements are retained in pinned `migration` recovery records. Their timestamp is the epoch because the legacy state has no capture timestamp.

Legacy operations retain their publication identity and completed steps, with incoming preservation marked `legacy` and operation approval revoked. Before a legacy apply operation resumes, the engine reads its immutable target, verifies it, and saves incoming step bytes as pinned recovery.

Older operations in either format that lack approval and step consent metadata migrate with revoked approval. Every step is classified as reviewed because its consent source cannot be proven. Existing review and decisions are retired, with captured local versions and edited replacements archived in pinned `migration` records. A deletion's conservative conflict origin is its expected preimage. A replacement's origin is absence, so an existing local file conflicts with the target before replacement. Completed steps remain completed.

Uncertain publication remains held until the candidate is reachable or explicitly abandoned after review. Revocation does not assert nonpublication or permit replay. Missing required preimages or corrupt blobs still yield `corrupt`. The state format remains `/2`; stores must preserve the observation, operation, and step fields.

Surviving own JSON keys, including `__proto__`, are retained. Sync and re-enrollment compare the checkpoint with its immutable commit to repair a previously omitted `__proto__` baseline. An absent saved key alone never authorizes deletion. Bytes or operations already removed from old state cannot be reconstructed from the latest state; older journal records and immutable history remain evidence for reviewed recovery.

## Root UI changes

The root UI handles `SyncOutcome.kind === "publication-unknown"` in every exhaustive outcome switch, including `plugin/src/main.ts`'s outcome formatter. The UI displays the held operation and offers a fresh `previewPublicationRecovery()` before calling `recoverPublication({ token })`. A successful `released` outcome leads to the existing enrollment preview. The scheduler retains its normal polling cadence while held and does not treat `head-moved` as permission to retry publication.

The recovery browser accepts the new reasons above and can export the original, incoming, carried, or edited version. Callers use `Object.keys`, `Object.entries`, or `own` for file dictionaries; inherited methods such as `hasOwnProperty` are unavailable. A store or test fixture that validates state formats accepts `/2` and preserves legacy journal records.

## Requirements on the root's ports

- Both repository and vault snapshots retain every own path, including `__proto__`, `constructor`, and `toString`. The adapters use null-prototype dictionaries or own-key construction before returning snapshots.
- `LocalVault.capture()` returns only in-scope paths with correct oids. It reports a stable mode for a file the engine wrote. An adapter that cannot store the executable bit either durably preserves logical modes for existing and new files or rejects unsupported `100755` entries before enrollment, publication, and application.
- The root calls `notifyLocalChange()` immediately in each observed create, modify, delete, and rename event handler, before queueing or awaiting other work. Calling it exposes the event generation synchronously to an active sync; awaiting its result confirms durable review and operation invalidation for restart. Do not defer the call behind the scheduler or active sync. A notification retires approvals even if a later capture has identical bytes. The vault port itself has no generation or event feed; the session cannot detect events that the root does not forward.
- `LocalVault.apply(path, expected, next)` is compare-and-swap:
  - `expected: null` means exclusive create.
  - `next: null` means move to trash.
  - It returns `changed` if the file is not exactly `expected`.
  - Markdown replacement should use the atomic `vault.process`.
  - Existing binary replacement and deletion should return `blocked` until a safe primitive is demonstrated.
- `Repository.publish` must use the exact `beforeOid`. The engine never needs a force update. `isAncestor` should throw rather than guess when it is unsure.
- `DurableStore.save` must be durable when it resolves. It receives the whole state, including the observation marker, operation approval, step consent, and pinned blobs for local drafts, preimages, incoming versions, and conflict origins. A save may land and then throw. The store must retain the saved revocation fields when loading that record.

## Known limits

- Reachability cannot distinguish a never-published candidate from one published and then removed by a rewind. The engine holds both cases. Reviewed abandonment preserves bytes and requires re-enrollment.
- Without a forwarded vault event, changes and reversals that occur entirely between captures are indistinguishable from unchanged inputs. Review invalidation covers observed head and local changes and forwarded events; it cannot identify an unobserved file incarnation from its bytes.
- Observations with live consent add durable saves before dispatch and when recording the result; storage failures can require fresh review even without a content change.
- Every sync verifies every byte of the head and the capture. This is simple and safe but costs O(vault size) hashing.
- Edits made outside the CAS window by other writers, and unsaved editor buffers, are outside the engine's guarantee. Captured snapshots are the preservation contract.
