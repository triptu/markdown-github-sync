# GitHub-native Obsidian sync — original proposal

> **Implementation status (14 October 2026):** This document records the original design. The [current visual architecture](architecture.html) separates implemented behavior, reviewed code, model checks and build-specific Android evidence. The integrated production source passed 437 tests, typechecking and build; a later journal regression passed its focused suite. Quint scope review is closed. Current Android configuration/restart acceptance, final writing-host review, real editor-race acceptance and packaging remain open. This is not approval to replace the real vault.

Status: design and isolated API experiments, 13 October 2026. Not a released plugin. The existing Cloudflare prototype is not approved for a real vault.

## Recommendation

Build one Obsidian plugin that publishes ordinary commits directly to your private GitHub repository and downloads committed snapshots. No Cloudflare service, external Git app, shell, or local Git database is required. Use GitHub's commit API instead of reimplementing Git's packfile and transport protocols.

An edit is first a **local draft**. It becomes shared truth only when GitHub accepts a commit on `main`. “Saved locally,” “Waiting for connection,” “Needs your decision,” and “Published to GitHub” must be distinct states. Do not display “Synced” merely because the file was saved or a request was sent.

The plugin owns synchronization in the active vault. Other clients can still publish ordinary commits to GitHub from separate checkouts. Running another Git/sync writer in the same active vault is outside the supported model. The user wants to remove Obsidian Git after replacement verification; this proposal does not remove it now.

## Grounded in your vault

Read-only inspection found 577 visible content files, totaling 47,796,592 bytes (47.8 MB decimal): 464 Markdown notes, 108 PNGs, three PDFs, and two `.base` files. The largest content file is 4,320,889 bytes. The local worktree was clean and its HEAD matched GitHub `main` during inspection.

The remote snapshot has 657 blobs including configuration, totaling 53,965,302 bytes. It includes 79 tracked `.obsidian` files and one executable-mode shell script under a hidden path (outside V1 content scope). No current-tree symlinks or submodules were found. These figures describe the current snapshot, not total historical Git storage. A mobile workspace exists; it does not identify the phone's OS or model.

This is a plausible API-client workload. It is not evidence of adequate mobile memory, latency, or background execution. First download is roughly 48 MB of content; routine sync should transfer changed blobs, with bounded concurrency, cached object IDs, and resumable checkpoints.

## Alternatives

| Design | What runs on the phone | Strength | Cost / decision |
| --- | --- | --- | --- |
| **GitHub API client — recommended** | Snapshot cache, draft journal, merge planner, GitHub HTTP requests | Smallest remote protocol; real GitHub commits; exact expected-head publication | GitHub-specific, no local Git CLI history or arbitrary branches; local safety still substantial work |
| Full JavaScript Git | `isomorphic-git`, object database, index, fetch/merge/push, filesystem adapter | Actual local Git repository and offline commits; portable remotes | More memory/storage and Git state to recover; use if full local Git becomes a requirement |
| GitHub plus Cloudflare relay | Plugin and custom synchronization service | Potential notifications or specialized queues | Two systems to operate; a relay cannot bypass GitHub commitment as authority; unjustified for this vault |

Obsidian Git already uses `isomorphic-git` on mobile and documents mobile limitations. Simply choosing the same library would not establish improved reliability. The differentiator is narrow scope, durable operations, conservative application of remote changes, and usable conflict decisions. See its [mobile documentation](https://github.com/Vinzent03/obsidian-git/blob/master/docs/Getting%20Started.md).

## One synchronization transaction

1. Capture saved local changes against the last fully applied commit. Preserve immutable copies and hashes in a durable local journal. Unsaved editor keystrokes are not yet a snapshot.
2. Read GitHub `main` once to obtain commit **H**. Read its tree and changed blobs by immutable IDs. Reject incomplete/truncated listings and unexpected paths or object modes. Never fetch each file from moving `main`.
3. Compare **base / local draft / H**. A file changed on one side is straightforward. Changes on both sides require merging or a decision. V1 previews proposed text merges; binaries, delete-versus-edit, path collisions, and structured-file conflicts require explicit choices.
4. Prepare the complete intended change set, preserving untouched repository files. Resolve all conflicts in that batch before publishing it. A decision is tied to the exact base, local snapshot, and remote commit; a changed input invalidates the decision.
5. Upload immutable blobs, construct a tree on H's tree preserving untouched entries, and create one multi-file commit C with parent H through the REST Git Database API. Verify generated object identities before publication; durably record C and its operation journal. Publish with GraphQL `updateRefs(beforeOid: H, afterOid: C, force: false)`. If the head has moved, reread, reconcile, and retry with backoff. Uploading objects does not make them the authoritative branch version. Never force the ref or fall back to a weaker fast-forward-only check.
6. Once the resulting commit is known, apply its contents locally through a recoverable journal. Check that each live file still matches the captured version before replacement. Preserve any new edits made during the request as a new draft; do not overwrite them with the older submitted snapshot.
7. Advance the coherent commit checkpoint only after every path in the batch is accounted for: applied, already equal, or preserved as an explicitly captured newer draft relative to C. Application progress lives in the journal, not a partially rewritten base manifest. A crash resumes or rolls back local journaled work; it must never turn an interrupted download into outgoing deletion intents. Rolling back a local application cannot undo a GitHub commit already accepted.

For download-only work, steps 5 is unnecessary: apply the verified remote commit with the same local safeguards. During conflicts, the local editor remains usable, but the affected publication batch is paused. This deliberately avoids per-file baseline complexity in V1.

`updateRefs.beforeOid` checks the exact previous branch value. REST non-force ref updates only require fast-forward ancestry: after someone rewinds a branch, they can accept a candidate that silently brings removed history back. [GitHub ref mutation](https://docs.github.com/en/graphql/reference/git), [REST refs](https://docs.github.com/en/rest/git/refs).

The simpler alternative, `createCommitOnBranch(expectedHeadOid)`, combines object creation and publication. It passed our synthetic tests, but requires all changed bytes in one request and has no explicit file-mode field. Choose one production write path. The bounded-upload REST-plus-GraphQL path is preferred; its fine-grained PAT and repository-rule compatibility remains a gate. REST-created commits are unsigned unless we add signing; signed-commit/PR requirements must be detected, not bypassed. [GitHub commit mutation](https://docs.github.com/en/graphql/reference/commits).

## What conflict resolution should feel like

The status opens one Changes view: pending files, last confirmed GitHub commit, and conflicts needing attention. A note conflict shows the common version, your saved draft, the GitHub version, and the proposed result. Choose **Use mine**, **Use GitHub**, **Keep both**, or **Edit result**. Nothing is published merely by opening the view.

“Use mine” changes only the conflicted file/hunks, not the whole remote snapshot. “Keep both” creates a new explicitly named note and previews the filename and link implications. Both inputs remain available in recovery history even after choosing one. We do not inject conflict markers into ordinary notes or silently generate siblings on every retry.

Deletion-versus-edit asks whether to keep the edited note or accept the deletion. Image/PDF conflicts show both versions and sizes; they are not text-merged. `.base` conflicts are treated as structured files, with explicit choice in V1. A rename is a reviewed path change, not a reason to trust every missing path as a deletion.

Restore means “make this historical content a new commit.” It never rewinds `main` or erases later history.

## Safety constraints that determine the architecture

- **Absence is not deletion intent.** Startup scans, partial access, changed scope, and missing state cannot authorize removal. V1 requires review of deletions, including bulk changes. Track actual local delete events as candidates, then verify and review the change set.
- **New devices enroll explicitly.** A copied plugin configuration is not a valid local checkpoint. Bind the local journal to an installation identity outside synced configuration; on missing, mismatched, or unverifiable identity, enter onboarding. Still preview nonempty-vault differences rather than assuming identity alone proves safety.
- **Recover first, mutate second.** Persist original bytes and intended operations before replacement; verify journal writes and recovery on actual devices. Pin active base, draft, conflict, and recovery blobs so cache eviction cannot remove them. Storage unavailability or corruption blocks mutation. Obsidian does not give a blanket atomic compare-and-swap for arbitrary filesystem writers. In particular, a binary edit between the last read and replacement can escape both the check and the backup. Until a safe adapter/writer strategy is demonstrated, V1 must hold binary replacements/deletions for a controlled apply workflow rather than claim automatic safety. Captured snapshots are the preservation contract, not every keystroke ever typed by an uncontrolled writer.
- **History movement is checked.** If the last known commit is no longer an ancestor, the branch is deleted, or repository identity changes, pause for explicit recovery. Never interpret a reset as a normal mass update. Exact-head checks do not by themselves prevent an owner from rewriting history later.
- **Uncertain network outcomes reconcile.** A lost publication response is “publication unknown.” Record candidate C, parent H, immutable bytes/hashes/modes, decisions, and operation ID before moving the ref. If current head D descends from C, publication succeeded even if D has since reverted some of C's content. Recover C's local transaction, retain newer drafts, then reconcile D; never replay C just because D differs. Inconclusive ancestry remains unknown and paused. `clientMutationId` is not assumed to be a server-side idempotency key.
- **Credentials stay out of vault files.** Use a repository-scoped fine-grained PAT and Obsidian SecretStorage (requires a compatible Obsidian version). Store only the secret's identifier in settings. Verify actual mobile storage behavior; do not call this OS-keychain protection without evidence. Existing tracked plugin config requires separate inspection and explicit migration, not merely a new `.gitignore`.
- **Scope is consistent and conservative.** Notes/attachments first. Preserve excluded files on GitHub unchanged. Do not automatically delete existing `.obsidian` files from the repository. Exclude `.git`, credentials, caches, recovery journals, plugin runtime state, and workspaces; selected configuration sync is a later explicit allowlist.
- **Respect storage and API limits.** Preflight file sizes and the encoded batch, honor retry headers and rate limits, fail clearly rather than silently skip files or split a supposedly atomic batch. Tree traversal must handle truncation. Symlinks, submodules, LFS, and unsupported modes are rejected when in scope; do not flatten them into ordinary files.

GitHub stores readable repository content, as your existing repository already does. This does not retain the old prototype's end-to-end encryption. Native Obsidian Sync protocol compatibility is no longer the goal.

Delete events are only candidates: bind them to a path generation and captured hash, invalidate them after recreation, and suppress events caused by journal replay. V1 reviews all deletions. A history-rewrite recovery preserves drafts relative to the old checkpoint and previews adopting the new branch; it must not use an older merge ancestor to accidentally resurrect intentionally removed content. “Content synced” always states configuration coverage separately.

## Proposed implementation boundaries

User flow: connect repository → preview enrollment → download a committed snapshot → edit offline → review/publish → resolve if necessary → see confirmed commit. No branch-management or Git-terminal UI in V1.

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `SyncSession` | One operation at a time; enrollment, journal state machine, recovery, checkpoint | Ad hoc file writes outside the journal |
| `GitHubRepository` | Immutable commit/tree/blob reads, ancestry, conditional commit publication, uncertain-result lookup | Local vault state, merge policy |
| `VaultJournal` | Captured bytes, preimages, device identity binding, guarded apply, durable recovery | Deciding which side wins a conflict |
| `Reconcile` | Pure three-way comparison, conflict records, validated resolutions and publish plan | Network or filesystem I/O |
| Obsidian UI/adapter | Settings, native requests, status, changes/history/conflict views, editor-aware file access | A second synchronization engine |

Sketch, not implemented:

```text
SessionState = Unenrolled | Ready(appliedCommit) | Draft(journalId)
             | Resolving(planId, conflicts) | Publishing(operationId)
             | PublicationUnknown(operationId) | Applying(journalId)
             | Paused(reason)

session.inspect() -> Snapshot of state and user-visible changes
session.enroll(repo, branch, approvedPreview) -> Outcome
session.sync() -> UpToDate | Published(commit) | NeedsDecision | Paused
session.resolve(planId, conflictId, resolution) -> UpdatedPlan | StalePlan
session.restore(path, historicalCommit) -> ReviewedDraft

repository.publish(expectedHead, immutablePlan, operationId)
  -> Accepted(commit) | HeadMoved | OutcomeUnknown | Rejected(reason)
journal.apply(verifiedCommit, expectedLocalSnapshot)
  -> Applied | NewLocalEdits | RecoverableInterruption
```

Uncommitted drafts, accepted remote commits, and fully applied local commits are different types/states. The baseline is a coherent commit, not a mutable per-file list copied between devices.

## Isolated evidence already collected

Created [a private synthetic test repository](https://github.com/your-name/vault-sync-test) and a local dummy vault. No personal note content was copied into it. Tests used the GitHub API through `gh`, not the final Obsidian transport.

| Experiment | Observed result |
| --- | --- |
| Note plus 4,321,024-byte binary in one commit | Accepted; downloaded binary matched byte for byte |
| Two simultaneous publishers with the same expected head | Exactly one accepted; stale publisher rejected |
| 120 small files in one commit | Accepted; this is a tested batch, not a maximum-size claim |
| Rename represented as add plus delete | Accepted in one commit |
| Repeat old-head request after successful commit | Rejected; application-level lost-response reconciliation still needs implementation |
| REST objects + exact GraphQL ref update | One of two competing candidates published; old-head retry errored without moving the head. GitHub returned a generic error for the stale contender, so classify outcomes by rereading state rather than matching error text |
| Object fidelity on preferred path | Unicode, CRLF, BOM bytes checked before publication; executable mode preserved |

Evidence commits: [`2fa8e5f`](https://github.com/your-name/vault-sync-test/commit/2fa8e5f44767ef82aa35d0a9f1721281bfcb857c), [`2560c67`](https://github.com/your-name/vault-sync-test/commit/2560c67f17a0a517ab20c0ade812ea395b774617), [`696ac60`](https://github.com/your-name/vault-sync-test/commit/696ac60ffecf88a3b43d066701d88f032e60e275), [`dad461a`](https://github.com/your-name/vault-sync-test/commit/dad461a1fe3a61268aefb205b9f837ac51b02e01).

Preferred-path evidence: [`9471df0`](https://github.com/your-name/vault-sync-test/commit/9471df028e8fbf9d34c9d5528a66d45211ba5b2f). Tests used existing `gh` authentication, not a newly issued fine-grained PAT, and did not test branch protection policies or a forced rollback race against GitHub.

The previous Fable safety review found real destructive active-vault behavior in the Cloudflare prototype. Nothing in this API experiment makes that old engine safe. Keep its tests as regression scenarios; replace its authority/baseline model rather than transplanting it.

## Delivery and migration gates

1. **Mobile feasibility:** run requestUrl, SecretStorage, bounded attachment downloads/uploads, durable journal storage, and resume after app termination in a dummy native vault. Establish the actual phone OS/model before claiming support. A simulator alone is insufficient evidence of background behavior.
2. **Safety engine:** inject crashes before/after every publication and local-write boundary. Verify stale clone enrollment, missing files, conflicting edits, delete-versus-edit, case-only rename, concurrent editing, low disk, corrupt state, revoked token, rate limits, lost responses, and remote force-push/deletion. Assert recoverable bytes, not just status codes.
3. **Usable V1:** manual sync, status, change preview, conflict decisions, historical restore, foreground/resume syncing. Add optional coalesced automatic commits only after manual mode passes. No promise of continuous syncing while a phone suspends Obsidian.
4. **Rehearsal:** use synthetic fixtures matching your size/file mix, then a disposable private rehearsal snapshot if explicitly chosen. Demonstrate two-device convergence and recovery. Keep an independent backup/export in addition to the live GitHub branch.
5. **Cutover:** preserve the original vault and Git checkout as rollback material. Enroll a fresh plugin-owned vault from the accepted GitHub commit; review any late local changes. Disable the old plugin before the new one writes, verify notes and attachments on both devices, then remove the old plugin. Do not leave a stale `.git` directory inviting accidental terminal operations in the new active vault.

Reusable from v0.1: project packaging, some Obsidian UI/adapter experience, and adversarial test cases. Retire the Worker/DO/R2 service, shared-token protocol, encrypted revision format, per-file remote heads, automatic tombstones, and silent sibling-conflict workflow from the recommended product path. Do not delete the prototype during this proposal stage.

## Sources and remaining uncertainty

- [Obsidian requestUrl](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl) documents requests without browser CORS restrictions; actual mobile buffering/resume remains to be tested.
- [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) is a centralized secret store, not a documented isolation boundary between plugins.
- [GitHub Git trees](https://docs.github.com/en/rest/git/trees) documents recursive-tree truncation; the client must detect it.
- [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) require backoff and restrained polling/content creation.
- [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) remains the alternative if actual local Git is needed. Its existence is not a mobile reliability proof.

Unresolved release choices: durable mobile journal backend, validated payload/memory ceilings, exact foreground polling and auto-commit cadence, selected configuration sync, and authentication onboarding polish. None requires a Cloudflare service by default.
