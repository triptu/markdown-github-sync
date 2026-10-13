# Independent engine/native review R3

**Changes requested. No full product or Android replacement approval.** E2-1, E2-2, E2-4 and E2-5 pass the exercised safety/recovery cases. E2-3's ordinary transitions and journal crash schedules now pass, but a mixed valid/malformed recovery result can still strand the obsolete oversize hold (R3-1). Three independent configuration-engine defects and one outcome-honesty concern follow.

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`, starting at `1854236fdfd05b7996d9f2a32edf72b3d8c891d9` (native `d5cc192`, engine `1854236`, privacy `dafc016`). During review HEAD advanced to `158479129857c35b87140fea16b3e69755400fbf`; that change contains only documentation/audit updates. Reviewed source is unchanged. Root was read-only; no device, remote, real vault, or subagents. Tests use synthetic in-memory host files. All new persistent artifacts are under `/tmp/github-v2-engine-r3/`, plus this requested report.

Read the entire `docs/verification/engine-native-review-r2.md`, `docs/verification/native-oversize-r3-port.md`, `/tmp/github-v2-scope-engine-port.md` including the factory handshake, and `docs/verification/android-v2.md`. This is engine/native composition review, not the separate scope/privacy review. The new native configuration port is intentionally not wired or modified here.

## Findings

### R3-1 — Medium: mixed recovery validation acknowledges away the replacement needed to retire an obsolete oversize hold

Locations: `plugin/src/git-sync/session.ts:1675`, `:1684`, `:1714–1737`; native superseded-ID rejection at `native-transactions.ts:375`.

Repro: `/tmp/github-v2-engine-r3/supersession-regression.test.ts`, `ACCEPTANCE valid supersession survives a transient malformed neighboring issue`.

1. Use production SyncSession, GitObsidianVault, NativeTransactionJournal, NativeModeStore and FileJournalStore for all journals. Pull binary E→N, then grow the retained hidden E source beyond 8 MiB, producing a durable oversize hold.
2. Replace that hidden source with readable bytes. Native recovery atomically supersedes the old oversized ID with a valid byte issue.
3. For this one recovery call, append a malformed issue for **another** path (`other.md`, hash/data mismatch) at the recovery boundary. Production native recovery still runs normally.
4. The engine correctly declines to treat the mixed issue list as authoritative. However, it still ingests and acknowledges the valid replacement, while retaining the obsolete oversized ID in its hold.
5. Remove the injection and reopen both journals. Native issues are now empty. Engine has both IDs and stale oversize metadata. Choose `expected` on the fresh conflict.

Actual: `blocked`, reason `Native recovery acknowledgement did not complete; retry synchronization`. Three additional full reopen/sync attempts remain blocked. Newly edited `other.md` cannot publish once this decision is pending. The old ID is durably superseded in native state, so retrying its acknowledgement can never succeed. The readable replacement is pinned in the engine; this is a liveness failure, not lost bytes or erroneous publication.

The original E2-3 missing/shrunken-source defect is fixed for a fully valid issue set. This is a remaining interaction between its fix and F5 malformed-neighbor isolation. It is a boundary fault-injection case, **not** evidence that the production native parser routinely generates malformed issues.

Fix direction: when replacement evidence cannot yet authorize retirement, preserve enough evidence/authority to perform that retirement on a later clean recovery. Do not acknowledge away the sole replacement required for it. Persist the relationship or defer that replacement's acknowledgement while retaining unrelated progress. Test mixed validation, engine/native save-before/save-after, recovery without the malformed neighbor, and restart.

### R3-2 — Medium: direct configuration application bypasses repository and installation fences

Locations: `session.ts:390–435`. Compare sync's checks at `:517–557` and restore's identity/ledger checks.

Repros: `configuration.test.ts`, both `ACCEPTANCE direct configuration must respect … fence` cases (`identity`, `installation`).

1. Enroll config/1 and sync an incoming `.obsidian/appearance.json` into deferred state; the local path is absent.
2. Either change the repository identity returned by the port, or create a session over the same durable state using device ledger B instead of enrolled ledger A.
3. Call `previewApplyConfiguration()` and `applyConfiguration({token})` directly, without an intervening `sync()`.

Both return `{kind:'applied', paths:['.obsidian/appearance.json']}` and write the configuration bytes. Neither checks `repository.identity()` or binds/verifies `ledgerRef()` before the native mutation. A previously recorded pause is honored, but a newly changed identity or installation is not discovered by this API.

This is an engine API defect independent of UI wiring. Reproductions use production SyncSession with the configuration-capable MemoryVault/MemoryRepository and MemoryStore, because the fresh native config port is not yet integrated. No claim of a currently exposed Android UI path.

Fix direction: gate this mutation using the same identity, pause, installation and authorized recovery rules as the other mutation entry points, then revalidate the reviewed configuration against any updated evidence. Keep the preview read-only.

### R3-3 — Medium, safety: configuration CAS rejection drops the original base and publishes a conflicting local version without review

Locations: `session.ts:1591–1604`, contrasted with the pre-apply changed branch at `:1583–1587` and ordinary apply carry construction at `:1495` onward.

Repro: `configuration.test.ts`, `ACCEPTANCE config CAS rejection preserves absent origin for add-add review`.

1. Remote adds `.obsidian/appearance.json = {"theme":"moonstone"}`; local is absent. Sync defers it and advances the checkpoint.
2. Approve the exact configuration preview.
3. After the engine's final capture but before the vault CAS, create `local racing draft` at that path. The adapter correctly returns `changed`, with no overwrite.
4. Restart the engine and sync.

Actual: configuration application returns `{kind:'applied', paths:[]}`. The following sync returns `synced, published:true`; GitHub's current configuration is replaced with `local racing draft` without an add/add decision. The local edit survives, and the remote version remains in history/recovery, so this is not destruction of every copy.

Cause: when the engine itself sees changed bytes before calling apply, it sets `carry[path] = step.expected`. When the CAS reports the same change later, it marks the step changed but drops deferred state and clears the operation without that carry. The never-installed remote value becomes the merge base. This contradicts the already passing earlier-edit case.

Fix direction: preserve the original expected ref for native `changed` results before clearing the operation, with the same durable carry semantics used for changes observed before apply. Add both absent-preimage and existing-preimage races, and crash/reopen between result and completion saves.

### R3-4 — Medium, liveness: editing deferred configuration before approval cannot reach the conflict review that the API prescribes

Locations: `session.ts:407`, `:882–901`.

Repro: `configuration.test.ts`, `ACCEPTANCE local edit while config deferred can be reviewed after sync`.

After the same remote-add/defer setup, create a local version before approving configuration. Preview is blocked with `Local configuration changed since it was deferred; sync to review the conflict`. Across two new sessions, sync returns `up-to-date`, offers no conflict, and preview remains blocked. The deferred expected version never changes; every deferred path is excluded from reconcile, even when its live local bytes differ. Neither current version is destroyed, but the advertised review route does not work.

Fix direction: when deferred local content changes, preserve its original expected version and expose a conflict through the review flow, while continuing to defer any eventual configuration write until explicit approval. Do not merely adopt the remote checkpoint as its origin.

### R3-5 — Outcome honesty, not an E2-1 safety failure: unreadable held work can say “Content synced”

Evidence: `acceptance.test.ts`, `E2-1 safety: unreadable hold expires old mine choice, preserves remote and original base, inspect is read-only`; `session.ts:963–990`; `plugin/src/main.ts:471–476`.

With an oversize native hold and an oversized visible file, sync returns `up-to-date` while the durable hold and unreadable file remain. The current main outcome formatter renders that as `Content synced · <commit>`. The unsafe mine decision expires, the remote path survives, the original hold base survives, and a fresh decision appears once the file is readable. These are safety passes. The concern is that the result presented to the user hides unresolved/unsupported content.

Fix direction: carry held/unreadable status into the outcome or consult it when rendering completion. Do not reintroduce an unsafe decision merely to obtain `needs-decision`.

## Independently verified safety and recovery

`final-safety-results.txt`: **91 passing safety/control tests, 0 failures, 4 explicitly skipped nonapplicable schedules** (95 enumerated). Four skip combinations concern byte-replacement acknowledgement boundaries for an oversized-to-larger-oversized transition, which produces no byte acknowledgement at that stage. They are not claimed as exercised crash boundaries.

`final-findings-results.txt`: **4 configuration controls pass, 5 safety/liveness acceptance assertions fail**. Those failures comprise R3-1, R3-2's two fence variants, R3-3 and R3-4. A failing assertion here is evidence of an open defect; it is not a “passing defect-presence test.” R3-5 is an observed outcome accompanying a passing safety test.

Coverage includes:

- **E2-1:** a previously recorded mine choice expires when visible bytes become unreadable; no wrong publication/deletion, persistent hold, unchanged held origin, and read-only inspect. Readable-again content requires a fresh decision. The held origin is compared to the hold's actual pre-test base, not the old native preimage: the binary pull had already advanced the checkpoint before the hidden file became oversized.
- **E2-2:** replay and cancel with oversized visible content return normally, retain pending intent and hidden preimage, and publish unrelated edits across two host/session restarts. Subsequent readable and missing visible-source transitions settle the pending intent and expose review; fresh decisions converge.
- **E2-3 normal transitions:** hidden source becomes readable, missing, or a different oversized version; stale choice expires, original hold base survives, readable replacement is pinned, old native ID rejects acknowledgement, and a fresh decision converges. Both journals are reopened after faults before record write and after final-record rename; readable/missing replacements additionally exercise native acknowledgement and engine acknowledgement-clear boundaries.
- **After-ack supersession:** acknowledged source changes to the old preimage, different readable bytes, or absence; fresh evidence is surfaced. A missing acknowledged source that reappears also requires review. Additional schedules change the source after native oversize acknowledgement but before/after engine acknowledgement-clear durability, and after publication has produced a persisted approved apply operation but before native apply begins. Old approval does not install over the new evidence.
- **Unchanged oversize control:** export retains the source and stays excluded from scans; failed decision save cannot acknowledge; stable source settles after durable review; native ack and engine-clear crashes are retryable. Re-acknowledgement of an actually acknowledged current ID is idempotent. A changed source during acknowledgement or failure before native ack durability blocks before publication.
- **E2-4/E2-5:** original production-composition resumed-delete/unreadable-origin and resumed-apply/quarantine safety probes pass. Unknown bytes are not inferred absent and quarantine prevents resumed writes. Config recovery controls likewise retain local edits/origins for unreadable and newly quarantined paths before apply, with authorization-save-before/after controls.
- **Earlier guarantees retained in exercised cases:** first returned native conflict works with one decision; seven keep/cancel schedules plus four real-two-journal schedules; duplicate/identity/ordinary-pause nonmutation; hidden late writer preservation and exact pinning; open-view attempt/queued-displacement backout; visible oversize unrelated progress; read exceptions prevent publication; bulk folder deletion guard; ordinary malformed evidence isolation; unknown-scope global block; stable oversize export/ack.
- **Restore:** all 15 earlier three-journal restore schedules pass, including authorization, native intent, text before/after, mode save, operation-clear, rename boundaries, newer local draft, and historical-source mismatch.
- **Ledger/fencing:** all nine adapted protocol cases pass, including production REST+Session+native stale/lost receipt cases and legacy fence/delivery/rewind schedules. This uses synthetic HTTP responses and MemoryRepository; no live GitHub call.

The initial unmodified R2 rerun was **45 pass / 9 fail**. Four failures were old tests deliberately asserting the now-fixed oversize defects. Five were a stale scratch fixture: it changed `/4` state to format `/2` without removing the new `scope`, `deferred`, `hiddenConsent`, `reentry` fields, so strict parsing correctly rejected it. The R3 copy removes those fields during the downgrade and all five legacy cases pass. No production parser was weakened. The copied prior-safety suite excludes the four obsolete defect assertions and replaces them with affirmative acceptance tests.

The root independently reported 365 plugin tests and typecheck passing. That result is attributed to root and is not substituted for this review's independent composition evidence.

## Reproduction commands

Run from the root's `plugin` directory:

```sh
node_modules/.bin/tsx --test /tmp/github-v2-engine-r3/acceptance.test.ts /tmp/github-v2-engine-r3/protocol.test.ts /tmp/github-v2-engine-r3/resume-acceptance.test.ts /tmp/github-v2-engine-r3/prior-safety.test.ts /tmp/github-v2-engine-r3/two-journals.test.ts /tmp/github-v2-engine-r3/restore.test.ts
node_modules/.bin/tsx --test /tmp/github-v2-engine-r3/supersession-regression.test.ts /tmp/github-v2-engine-r3/configuration.test.ts
```

The first command should pass; the second should exit 1 until the findings are fixed. Scratch imports point to the live root, so later source changes affect results. `harness.ts` bundles production GitObsidianVault against the existing Obsidian fixture, with real native/engine/mode journal implementations over map-backed JournalFiles and no-clobber rename. Configuration-specific tests intentionally use the existing MemoryVault; no unintegrated native port is represented as verified.

## Limits and integration notes

The factory handshake remains required: construct the normal repository from the persisted enrollment mode; use a temporary config/1 session for migration preview/enable only; preserve the durable `scope-enrollment` marker across a settings-save crash; keep the preview/enable session instance for its nonce. I did not wire or validate the root UI factory.

The configuration and hidden-publication preview APIs currently expose refs/OIDs rather than exact reviewable contents. Root's requested read-only exact-content preview and UI integration are pending work, separate from R3-2–R3-4. Their absence is not counted here as an additional engine data-safety finding.

Android evidence in `android-v2.md` covers the earlier bundle `0ef19cb3…`, normal operation and two actual full-process kills after native displacement/install. It does not prove this revision, configuration integration, unsaved editor buffers, power loss, or a physical device. Earlier stale-view and unbounded hidden-retention limits remain. No full replacement approval follows from these tests.

Reviewed source SHA-256:

```text
session.ts              555da4a27cfdf13733d7ac061b6b75a49fd8affd9f3638cfe31093f16334cd98
reconcile.ts            e8a5a49b3e418c9fc19f34c7b65db65c49d9de9cbcaa62b3c31ae9a6aeafdb6d
state.ts                faf233b675e02f12ba39ec34222fc9674ca3502be84c369402549d326c1d3229
contracts.ts            56b0bb793ec78c8828b77ad951b6671bc8d71fb2435ff3722ea405391a87c077
github.ts               8218f31dcb69efdeaa3e87b1f2c5e976352d85c77d43648480da4f3e7ae84066
obsidian-vault.ts       5e428be11a839dc96874512dc878b6a6333f12bb7b7a4ae54fcad72b03f9e999
native-transactions.ts  76710222154ea23dacdcc1119b982abbe8e5d6c6c9402f928d1c010c03b75c8e
```
