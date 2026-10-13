# Independent native configuration review R1

**Changes requested: one reproducible native export defect and one commit-point gate gap.** An additional native/index safety limitation is independently reproduced below and explicitly predates this patch. No full product or Android replacement approval.

Reviewed commit: `b65db17475668b63c60329e99ca04f22e6a6c1fe`. The three native source files are byte-identical to native worker commit `93e28911632cae8ee651eaed884d8f7c3c404570`. Read the exact parent-to-commit diff, `/tmp/github-v2-native-scope-port.md`, `docs/verification/engine-native-review-r3.md`, and both copies of the native oversize R3 port. Privacy policy/4 and `b4d70c4` are included.

Review writes were confined to `/tmp/github-v2-native-scope-review-r1`, this report, and disposable test directories. No root source edits, device, remote, real-vault operations, or subagents. Root advanced to `46aa75e` and concurrently edited `main.ts`; those changes are not part of the tested snapshot. The three native source hashes remained unchanged. Pending factory/UI wiring is not a finding. None of the five engine R3 findings is duplicated here.

## New native findings

### N1 — P2: an allowed `.gitignore` export permanently blocks subsequent scoped operations

Locations: `plugin/src/git-sync/obsidian-vault.ts:25–30`, `:429–447`; `plugin/src/git-sync/native-path-policy.ts:65–67`.

Repro: `plugin/test/review-findings.test.ts`, `ACCEPTANCE successful original-name gitignore export must not poison scoped scans`.

1. With an explicit config policy, replace root `.gitignore` through production `GitObsidianVault.apply`; its preimage is retained in a tracked hold.
2. Grow that hold beyond 8 MiB and recover, creating a real native oversize issue.
3. Export it to `.git-vault-sync-export-<uuid>/.gitignore`, preserving its original name.
4. Export returns success and preserves both source and copy. Reopen native and mode journals and scan with the actual current root-ignore scope.

Actual: `UnsupportedNestedGitignoreError: Nested .gitignore is unsupported: .git-vault-sync-export-<uuid>/.gitignore`. Future config scans and namespace-checked applies remain blocked while that copy exists. The export is excluded from publication, but the mandatory all-names control check still sees it.

Cause: `safeExportPath` validates the suffix in the vault-root policy, which admits the special root `.gitignore`. In its actual exported location it is a prohibited nested control. Ordinary allowed configuration suffixes work; this is specifically the root control's relocation.

Fix: reject this destination before copying, or choose a safe non-control export filename. Preserve full-inventory nested-control rejection and retained sources; do not fix this by deleting holds or weakening ignored-directory checks. A successful export should be followed by a reopen/scan acceptance check. No data-loss claim: both copies survive.

### N2 — P2 contract gap: policy upgrade checks its review callback only before the asynchronous inventory

Location: `plugin/src/git-sync/native-transactions.ts:223–242`.

Repro: `plugin/test/review-findings.test.ts`, `ACCEPTANCE upgrade revalidates durable reviewed pause after asynchronous inventory`.

The test uses production `FileJournalStore` for separate engine-gate and native records. The callback reads a durably saved reviewed pause. During the awaited root name inventory, a fault hook durably revokes that pause. Upgrade then succeeds, and reopening the native store shows `policy.rules === "config/1"`. The callback ran **once**. The acceptance assertion expecting the legacy durable binding fails.

`inventoryLocal` receives only `this.trusted`, which checks native write uncertainty, not the caller's review/ownership gate. No callback is invoked between the end of this potentially large inventory and the binding save.

Fix: revalidate the caller's durable review/active-ownership callback after inventory and immediately before starting the binding commit, while preserving exclusive ownership through the save. Recheck the no-intent/no-issue condition at that boundary if interleaving native state changes are possible.

**Boundary:** this is an injected gate invalidation, not evidence that a correctly held single-engine operation queue routinely changes its own pause during upgrade. The required caller queue still matters; a late callback is not a replacement for serialization or an atomic cross-journal transaction. I did not review the in-progress factory or establish a user-reachable revocation route there. The precise native guarantee currently provided is “gate checked before inventory,” not “gate rechecked at commit.”

## Existing native/index limitation, not introduced by this commit

### B1 — P2 safety boundary: eligible disk files omitted by `getFiles()` become inferred deletions even though full inventory found them

Locations in the new code: `plugin/src/git-sync/obsidian-vault.ts:495–513`.

Repros: `review-findings.test.ts`'s scoped-capture case and `review-index-composition.test.ts`'s three-journal session case. `review-prior-index.test.ts` repeats the session case with the **parent commit's native vault implementation** and legacy scope; it fails identically. This is not charged as a new configuration regression.

The new check rejects a host-index entry missing from adapter inventory, but not the reverse. With 20 enrolled visible files physically present, the test host temporarily omits one from `getFiles()` while `adapter.list` still returns it. Scoped scan returns neither its bytes nor an unreadable record. Production `SyncSession`, `GitObsidianVault`, `NativeTransactionJournal`, `NativeModeStore`, and all three production file journals then compose with a synthetic repository: sync returns `synced, published:true` and removes that path from the remote snapshot while its original local disk bytes remain. Twenty files keep this one-path omission below the bulk/empty-capture guards.

The adapter-index mismatch is injected; this review does not establish when or how often Obsidian Android exhibits it. The native contract assumes a complete, synchronized `getFiles()` index. Full filesystem inventory now provides evidence to reject this mismatch instead of interpreting it as deletion. A focused fix could fail capture for an eligible visible inventory file absent from the index, or capture it safely through the adapter. No claim that unsaved editor text was deleted: the repro concerns a real disk file omitted by the host index.

## Independently verified evidence

All production code in the scratch snapshot was exported from `b65db17`, with the installed root dependencies symlinked read-only. The added harness bundles the actual native adapter against the repository's Obsidian fixture. Host files and no-clobber rename are simulated; **native, mode, and engine journal implementations are production code**. The session composition uses a synthetic repository, never GitHub.

- Existing native-vault and native-transactions tests: **67/67 pass** (`focused.log`).
- Expanded existing native-vault/native-transactions/native-modes/hidden-config/scope tests: **93/93 pass** (`focused-expanded.log`).
- All original plugin tests at the frozen SHA, excluding added review files: **392/392 pass**, zero skips (`full-suite.log`). This is the independently measured count; it differs from both the worker's 372 and the anticipated 389. It is not a claim about the concurrently changing root after engine fixes.
- Additional production-native safety compositions: **12/12 pass**, zero skips (`safety.log`).
- New-finding and current-index acceptance assertions: **0 pass / 4 fail** (`findings.log`): N1, N2, and two B1 assertions. These are failing acceptance tests, not passing tests that merely assert a defect exists.
- Parent-native B1 isolation: **0 pass / 1 fail** (`prior-index.log`).
- TypeScript check passed in the frozen scratch plugin with the review tests present (`typecheck.log`). Native commit `git diff --check` passed.

Passing evidence covers:

1. Explicit configured policy for hidden apply; legacy default and missing legacy binding; typed mismatch on foreign-config and legacy fallback opens. A foreign config binding cannot be upgraded by reopening as legacy. Fresh configured open refuses untracked holds without deleting them.
2. Upgrade before-record-write and after-record-rename interruptions. The old instance becomes uncertain; reopen selects the actually durable binding. Existing journal records, tracked held bytes, nonempty acknowledged-oversize state, and nonempty superseded-ID history survive. The old superseded ID remains rejected. No new journal namespace is substituted.
3. Existing tests reject absent review permission, active intents, outstanding recovery issues, denied historical paths, and untracked physical stage files before upgrade.
4. Hidden create/replace/delete recovery after real simulated displacement/install boundaries, with production durable mode storage. Replacement/deletion holds survive; executable mode survives reopen. Hidden operations call the adapter transaction path and never `vault.process` or hidden `TFile` lookup.
5. An authorized historical native intent remains parseable/replayable under the built-in config policy even when a current transaction scope ignores that path. Scoped scan reads none of those ignored bytes. Engine consent/intersection/quarantine/ledger authorization remains the caller's responsibility; this test does not authorize replay merely because a native path is admitted.
6. Full names inventory includes ignored/denied names; nested controls and canonical root/nested aliases fail before bytes; included/excluded path and directory aliases block capture/apply; replay rejects an alias introduced after a crash. Existing combined hidden+visible 128-MiB limit test passes.
7. Config oversize pending replay/cancel and held-source supersession tests pass. Sources remain retained. Export rejects native-journal, self-plugin, workspace, and foreign-hidden-root suffixes. N1 is the remaining root-control suffix exception.

## Host configuration writer and reload boundary

A disk writer arriving **after displacement but before installation** is exercised: native returns interrupted evidence, preserves the arriving host save at its original path, and retains the old preimage. Reopen preserves the issue. This is a disk transaction safety check.

A separate control lets an in-memory host configuration writer save its stale state **after** native apply has returned `applied`. That write replaces the installed disk bytes, and the next native scan correctly observes it as current local data. Native does not own or flush the host's in-memory settings object, suspend arbitrary plugin writers, or reload configuration. Likewise, an unsaved configuration value that never reached disk cannot be captured or protected by the disk CAS. Calling `vault.process` for a hidden pseudo-`TFile` would not establish such ownership and is correctly avoided.

Thus these passes establish guarded disk transactions, not safe application/reload of every running plugin or Obsidian setting. Any eventual host reload requires its own reviewed ordering and host evidence; no automatic reload or extra approval flow was added or recommended here. Existing unsaved-editor, Android rename durability, physical power-loss, and unbounded retained-storage limits remain. No previous ledger or oversize fence is relaxed, and no hidden-source cleanup is authorized by this review.

## Reproduction

From `/tmp/github-v2-native-scope-review-r1/plugin`:

```sh
node_modules/.bin/tsx --test test/native-vault.test.ts test/native-transactions.test.ts test/native-modes.test.ts test/hidden-config.test.ts test/scope.test.ts
node_modules/.bin/tsx --test test/review-safety.test.ts
node_modules/.bin/tsx --test test/review-findings.test.ts test/review-index-composition.test.ts
node_modules/.bin/tsx --test test/review-prior-index.test.ts
```

First two commands pass; last two intentionally fail until the documented boundaries are addressed. The scratch source is frozen, so root fixes will not silently change these results. `native.diff` holds the reviewed native source diff. `obsidian-vault-before.ts` and the scratch `review-vault-before.ts` preserve the parent-native implementation used to isolate B1.

Reviewed SHA-256:

```text
native-path-policy.ts  521d2b59317b391223011aa084e87f0be886b4b52e4db5df8a5598af9461f0db
native-transactions.ts 31a03891c66dfdd4cfd188c856b5887a9ecb82bb5394a6a2c9cec2547137bcdb
obsidian-vault.ts      31a8e7aa4cc82b5439b4d3d90f1fc06b5bd081d02063b0e039e54bc874cf37f1
```
