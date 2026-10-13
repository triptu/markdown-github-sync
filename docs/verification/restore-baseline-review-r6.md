# Independent restore baseline review R6 — fix `2a013d4`

**R5-N1 is closed for both guard kinds, including the two compositions R5 could only describe (the sync after the restore fails before publishing; the native replay host flushes before its publication). The restore guard now names the bytes this host wrote, and the moved-head re-consent hold survives a plugin reload and a stale flush on the writing host. No wrong publish, silent loss, crash or persistence fault was found at HEAD. Two gaps remain, both Low and both bytes-safe: (R6-A) consenting to the held stale bytes never consumes the consent, so the path stays listed under `guarded` with a live preview until two syncs after an unrelated remote commit; (R6-B) the moved-head re-consent hold the worker chose to keep does not survive an Obsidian restart, because the new-host retirement branch does not apply the same re-consent test, so the reviewed restore publishes without re-consent after a restart (it was held pre-fix). One theoretical R5-N1 shape is recorded for the installed-at-startup path (R6-C). No gate from R2–R5 is reopened. No Android, DOM, product or device claim.**

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`. Fix commit `2a013d42ce05c8ad4baa175ef7b21a84a4f7af98` ("Hold stale configuration flushes around history restore": `plugin/src/git-sync/session.ts` +18/−3, `plugin/test/configuration-restore-guard.test.ts` +56). HEAD advanced during the review from `2a013d4` to `abe2293` (native final-acceptance harness, docs); `plugin/src` and the reviewed test file are byte-identical from `2a013d4` to `abe2293` (`reviewed-sha256.txt`: `session.ts` = `9c2fd0db…`). Pre-fix comparisons use `a23c77e` (parent of the fix; its `session.ts` is byte-identical to R5's reviewed `2315ef7`). Root read-only: no source, device, remote or real-vault writes, no subagents; `git status` clean before and after. Artifacts: `/tmp/github-v2-restore-baseline-review-r6/` (pre-fix tree under `prefix/` with the root's `node_modules` symlinked; `restore-baseline-r6.test.mts`, 30 cases, real engine, root fakes).

## What the fix does

- `restore()` `session.ts:804` sets `guard.applied = toRef(preview.historical)` when this session's write returned `applied`; `#resumeRestore` `:1315` does the same only when the guard is already on this host (an installed restore observed at startup on a new host keeps the old host's `applied`, R2-C4c).
- `needsConfigurationReconsent` `:2541` returns true when a consent exists for exactly the local bytes but its head or scope digest no longer matches. It is applied in `#transact` `:1043` (do not skip the hold just because local equals `applied`), in `listConfiguration` `:333` and in `#guardedConfigurationPreview` `:417`, so the moved-head hold stays visible and re-consentable. It is not applied in the new-host retirement branch `:1035` (R6-B).
- Compared with R5's two-line candidate: same `applied` update, plus the re-consent predicate that keeps R5-6 held instead of publishing on a moved head.

## Evidence

| Run | Result |
|---|---|
| Root `test/configuration-restore-guard.test.ts` at HEAD | 16/16 (`root-regression.log`) |
| Root suite `tsx --test test/*.test.ts` at HEAD | 458/458 (`root-suite.log`); `tsc --noEmit` exit 0 (`tsc.log`) |
| Frozen R5 `restore-guard-r5.test.mts` at HEAD (unmodified) | 16/16 (`r5-frozen-head.log`); R5-N1 ×2 and R5-6 ×2 now pass |
| Frozen R4 session + composed at HEAD | 16/16 (`r4-frozen-head.log`) |
| Frozen R3 session + composed at HEAD | 17/17 (`r3-frozen-head.log`) |
| R6 `restore-baseline-r6.test.mts` at HEAD | 28 pass / 2 fail, two identical runs (`r6-head-final.log`, `r6-head-final2.log`); the 2 failures are R6-1b (both guard kinds) = finding R6-A |
| Same file against pre-fix `a23c77e` | 15 pass / 15 fail (`r6-prefix-final.log`): R6-1, R6-1b, R6-3, R6-6, R6-9, R6-10, R6-11b, R6-12 fail pre-fix (R5-N1 family, closed by the fix); R6-2/2c/3-restart and R6-5 are logged, not asserted, and differ pre-fix as described below |

## Findings

### R5-N1 (R5 Low) — CLOSED, both guard kinds

- R6-1: direct restore, editor flushes the pre-restore bytes before any sync. HEAD: `up-to-date | head: new | guarded: [path]`; pre-fix: silent `up-to-date` with no hold. When the restored bytes return to disk they publish under the original consent; the post-publication stale flush is still held (R4 contract).
- R6-10: same with a JSON round trip and a plugin reload between the restore and the flush; the persisted guard carries `applied = restored` and the hold survives.
- R6-12: the sync right after the restore fails before head is readable (`headFault`), the flush lands in the gap, the next sync holds. Pre-fix: silently accepted.
- R6-9 (R4-B composition): blocked restore on host-1 with a durable native intent; host-2's first sync replays it through the real fake adapter while GitHub is unreachable (replay happens before the head read), then host-2's editor flushes the preimage. HEAD: held; pre-fix: `guarded: []`, silently accepted. This is the pre-publication flush on the replaying host that R5 could not reach.
- R6-7: an apply guard holding a user edit, then a restore over it, then a re-flush of the held edit: held, then the restored bytes publish.
- R6-8: a restore write that returns `changed` leaves `applied` at the pre-restore bytes with no consent (R5-O2 unchanged, nothing claims bytes that never landed).

R5-6 at HEAD (R6-3): the hold for re-consent survives a plugin reload on the same host and a stale flush on that host; the fresh consent publishes and the later flush is held (the worker's regression covers the same path). Pre-fix the flush erased the hold.

### R6-A (Low; new resolution path; conservative) — consenting to the held stale bytes never clears the listing

Repro: `restore-baseline-r6.test.mts` R6-1b (both guard kinds), fails at HEAD. Direct restore, pre-restore bytes flushed before publication, held (R6-1). The user resolves the hold the way the listing invites: `previewGuardedConfigurationPublication` → `consentGuardedConfigurationPublication` for the editor's bytes. The sync reports `up-to-date` (GitHub already has those bytes), but `listConfiguration().guarded` keeps the path and the preview keeps returning `preview` on every later call:

```
R6-1b true after consent: up-to-date | head: new configuration | local: new configuration | guard: {applied: OLD, consent: {version: NEW, head: H1}} | guarded: [".obsidian/appearance.json"]
```

Cause: the only place a consent is consumed is `#transact` `:1018`, which requires `state.base.commit !== guard.consent.head` and `base.files[path] == consent.version`. A consent whose bytes already equal the base never produces a new commit, so the condition never fires; `applied` stays at the restored bytes and `listConfiguration` `:333` (`!sameEntry(entry, guard.applied)`) keeps listing. It self-heals two syncs after any unrelated remote commit (R6-11b: `one sync after unrelated remote commit: guarded: [path]`, `two syncs after: guarded: []`, consent cleared, `applied` advanced). Meanwhile a later genuine edit is still held and re-consentable (R6-11b "later edit": `head: new | guarded: [path]`), so nothing publishes without consent.

The class is pre-existing (R6-11: an apply guard, another device publishes THIRD, the user types the same THIRD locally, consent → listed forever, identical pre-fix), but before this fix the restore scenario never reached it because the stale flush was silently accepted. With the fix it is the ordinary outcome of the new hold when the user sides with the editor.

Fix shape (not applied, not reviewed): consume the consent whenever the consented bytes are the base bytes, independent of the commit, e.g. in `#transact` `:1018` drop the `state.base.commit !== guard.consent.head` conjunct, or additionally after `authorized` when `sameRef(state.base.files[path], guard.consent.version)` set `applied = consent.version; consent = null`. R6-1b and R6-11/R6-11b are the regression.

### R6-B (Low; policy consistency; bytes-safe) — the moved-head re-consent hold does not survive an Obsidian restart

The worker kept HEAD's R5-6 behaviour (a moved head invalidates the restore's consent; the restore is held until re-consent) and extended it to the direct path (R6-2c: host-1 syncs after the head moved → `head: new | guarded: [path]`). The new-host retirement branch `#transact` `:1035` still retires the guard when the first observation equals `applied` or is authorized, without the re-consent test. Since `applied` is now the restored bytes, a restart that observes the restored bytes retires the guard and the restore publishes through ordinary reconciliation:

```
R6-2c true host-1 sync after head move: synced | head: new configuration | local: old configuration | guarded: [".obsidian/appearance.json"]
R6-2c true host-2 sync:                 synced | head: old configuration | local: old configuration | guard: null | guarded: []
```

Same for the direct restore with no sync before the restart (R6-2) and for the R5-6 crash-resume hold once the restored bytes are back on disk (R6-3 host-3). Pre-fix all three stayed held for re-consent on the new host (`r6-prefix-final.log`: `R6-2 … published without re-consent: false`, `guard retired: false`, `R6-2c … survived restart: true`).

Not a wrong publish: the bytes are the user's reviewed restore, and a same-path remote change still reaches conflict planning (R6-2b: `needs-decision | conflicts: [path]`, head keeps the remote bytes, local keeps the restore). It is the worker's chosen policy failing to hold across a restart, so the moved-head hold is only as durable as the current Obsidian lifetime. Either outcome is defensible (the candidate published R5-6 outright); what is inconsistent is held-on-reload but published-on-restart. If the hold is meant to be kept, the retirement test at `:1035` needs `&& !needsConfigurationReconsent(guard, observed.entry, head.oid, headScope.digest)` on the `sameEntry` arm; R6-2, R6-2c and R6-3 (restart step) are the regression. If publication after a restart is acceptable, document it and the R5-6 hold becomes a same-lifetime convenience only.

### R6-C (Low; theoretical; recorded) — installed-at-startup on a new host keeps `applied = expected`

R6-5: host-1's restore write landed and the response was lost; Obsidian restarts (host-2) with the restored bytes on disk while the head moved. By design (R2-C4c) the resume keeps the old host's guard, so `applied` stays at the pre-restore bytes; the first sync rebinds it to host-2 and holds for re-consent. A flush of the pre-restore bytes on host-2 then clears the hold the R5-N1 way (`up-to-date | guarded: []`). Host-2 is a new lifetime that loaded the restored bytes from disk, so it has no pre-restore bytes to flush; this needs a second process on the same vault, which is out of scope. Identical pre-fix. Recorded only.

### Recorded only, outside this gate

- R6-6: right after the restore publishes and until the next sync, the path is listed under `guarded` and `previewGuardedConfigurationPublication` returns `preview` (consent head is the pre-publication commit, so `needsConfigurationReconsent` is true); a consent recorded there is harmless and the next sync clears the listing. Pre-fix the same window existed for the pre-fix reason (`applied` not yet advanced). Cosmetic. The pre-publication spurious listing R5 noted is gone (`guarded before publish: []`).
- R6-4: write landed, final save lost, and the editor flushes the pre-restore bytes before the same-host reload resumes: the resumed restore re-writes the historical bytes over the flush (second `apply`), publishes, and later flushes are held. Designed resume behaviour; no loss, but the editor's flush is overridden by the pending operation rather than held.
- The held path's `untouched` treatment (`reconcile.ts:231`) advances base to the remote version while leaving local untouched; a later consent therefore publishes the consented bytes over a same-path remote change without a conflict decision. Pre-existing R2 consent design, unchanged by this fix.
- `abe2293`, `194fc26`, `2393cda` (native final-acceptance harness, docs) landed during the review and were not reviewed.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test test/configuration-restore-guard.test.ts                                        # 16/16
node_modules/.bin/tsx --test /tmp/github-v2-restore-writing-host-review-r5/restore-guard-r5.test.mts          # 16/16
node_modules/.bin/tsx --test /tmp/github-v2-restore-baseline-review-r6/restore-baseline-r6.test.mts           # 28 pass, 2 fail: R6-1b ×2 (R6-A)
R6_PLUGIN=/tmp/github-v2-restore-baseline-review-r6/prefix/plugin \
  node_modules/.bin/tsx --test /tmp/github-v2-restore-baseline-review-r6/restore-baseline-r6.test.mts       # pre-fix a23c77e: 15 pass, 15 fail
grep -E "^R6-(2|2c|3|5)" /tmp/github-v2-restore-baseline-review-r6/r6-head-final.log                        # R6-B / R6-C log lines
```

## Limits

No Obsidian DOM, Android device, real vault, GitHub network or power loss was exercised. Process death is simulated by throwing after a journal save, after the fake's apply, or after the fake's native intent record; publication gaps use the fake's head fault (a publish fault is retried inside the same sync by the engine, so it does not open a gap). Whether and when Obsidian flushes a hidden configuration file after a restore was not verified on a device; as in R2 through R5, R5-N1 and its closure assume such a flush can occur before the restore's first publication. The fix shapes above were not applied anywhere.
