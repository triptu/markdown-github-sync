# Independent restore writing-host review R5 — fix `2315ef7`

**R4-C1 is closed, and the previously recorded R4-E (restore of a live configuration path that never had a guard) is closed with it. A history restore written on a host other than the guard's host now rebinds the guard to the writing host on all three paths (direct restore before the first sync, crash-resume, native replay), a guard is made durable with the restore record before any write, and an already-installed observation on a new host still retires the old host's guard. The frozen R4 session and composed cases that failed at `697bdb5` pass at HEAD, as do the frozen R3 and R2 suites and the 12 new regressions. One gap of the same family remains open and is pre-existing, bytes-safe and not conservative (Low): a stale flush on the writing host that lands *before* the restore is published is accepted silently, because the restore guard's `applied` is the pre-restore version, so the reviewed restore is lost with `up-to-date` and no hold; the same mechanism erases the re-consent hold when the restore was held because the head moved. A two-line candidate closes it in a scratch copy with every suite green. Three new conservative spurious-hold cases of the R4-O1 class are recorded (Low). No Android, DOM, product, or full-replacement approval claimed; no device claims.**

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`. Fix commit `2315ef75f0483dd5f1ffce70b2b57ff3594ab987` (`session.ts` +42, `test/configuration-restore-guard.test.ts` +213). HEAD advanced during the review from `9f12a8a` to `0ef931c` (docs, `store.ts` object deduplication, journal-store tests, Android editor-race helpers). `session.ts`, `state.ts`, `scope.ts`, `obsidian-vault.ts`, `main.ts`, `git-fakes.ts` and the new regression file are byte-identical from `2315ef7` to `0ef931c` (`reviewed-sha256.txt`, `session.ts` = `a5909076…`). Pre-fix comparisons use `4e6128f` (the parent of the fix). Root was read-only: no source, device, remote or real-vault writes, no subagents; `git status` clean before and after. Artifacts: `/tmp/github-v2-restore-writing-host-review-r5/` (pre-fix tree under `prefix/`, candidate under `candidate/`, both with the root's `node_modules` symlinked).

## Evidence

| Run | Result |
|---|---|
| Frozen R4 `session-boundaries-r4.test.mts` (11, unmodified) at HEAD | 11/11, two runs; R4-A, R4-B, R4-C now pass (`r4-head-run2.log`; first run inline) |
| Frozen R4 `composed-r4.test.ts` (5, real plugin class, real native adapter and journals) at HEAD | 5/5, two runs; R4-A/B/C composed now pass |
| Frozen R3 `session-boundaries.test.ts` + `composed.test.ts` (17, unmodified) at HEAD | 17/17 |
| Root `test/configuration-restore-guard.test.ts` (12 new regressions) at HEAD | 12/12 |
| Worker logs `/tmp/plugin-root-suite-commit.log`, `/tmp/r2r3-review-commit.log`, `/tmp/r4-review-commit.log` | 450/450, 30/30, 16/16 as stated (not rerun as a full suite; the frozen R3/R4 parts were rerun above) |
| R5 `restore-guard-r5.test.mts` (16 cases, real engine, root fakes) at HEAD | 12 pass / 4 fail, two runs (`r5-head-final.log`, `r5-head2-final.log`); the 4 failures are R5-N1 (two guard kinds) and R5-6 (two guard kinds), one finding |
| Same file against pre-fix `4e6128f` (`r5-prefix-final.log`) | 7 pass / 9 fail: R5-N1 ×2 and R5-6 (existing guard) fail there too (pre-existing); R5-4, R5-5, R5-8, R5-10, R5-O1 and R5-6 (new guard) fail only pre-fix (fix effective) |
| Candidate (HEAD copy + `candidate-session.diff`, +2 lines) | R5 16/16; root regression file 12/12; frozen R4 session 11/11 and composed 5/5 (path-rewritten copy `candidate-r4/`); frozen R3 17/17 (`candidate-r3/`); candidate root suite 454/454 (`candidate-root-suite.log`; HEAD has 4 more tests than the fix commit from `c169a2e` and journal-store work); `tsc --noEmit` exit 0 |

The frozen suites were run in place and unmodified except for the candidate copies, where only the plugin path and temp-bundle directory were rewritten by `sed`.

## Findings

### R4-C1 (R4 Medium) — CLOSED

Code: `restore()` `session.ts:800` sets `guard.hostLifetimeId = this.#hostLifetimeId` when this session's `vault.apply` returned `applied`, before setting consent. `#resumeRestore` `:1287–1306` tracks `writtenNow` (true only when this session's write returned `applied`) and rebinds the host only then; an `installed` observed at entry keeps the old host (bytes were on disk at startup, R2-C4c). `#recoverNative` `:1821–1852` collects authorized restore intents whose path carries a guard or is live, captures the preimage, and unless `next` is already visible makes the guard durable on the current host before `vault.recover`.

Verified beyond the root tests:
- Frozen R4-A (crash after the restore record), R4-B (native rename transaction dies after `path → hold`, replayed by host-2 through the real adapter), R4-C (direct restore on host-2 before its first sync) pass at session and composed level; both guard kinds end on host-2, the stale flush on host-2 is held with `1 held files pending`, and `applied` advances to the restored version after publication. All three still fail against the pre-fix tree.
- R4-D control unchanged. R4-H/I/J (configuration apply, `4fc0466`) unchanged.
- R5-9: host-1's quit flush reverted its apply before host-2 started; host-2's restore preview shows the reverted bytes, restore returns `unchanged`, the first sync holds the reverted bytes against host-1's guard rebound to host-2 (R2 design, unaffected).
- R5-10: blocked restore replayed on the same Obsidian lifetime after a plugin reload: guard stays on host-1, restore publishes, later stale flush held. Fails pre-fix (no guard, stale flush published).
- Consent validity (R5-6, HEAD): a restore record on host-1, crash, another device moves the head, host-2 resumes and writes. The guard is on host-2, the restored bytes are held for re-consent (`guarded: [".obsidian/appearance.json"]`), GitHub keeps `new`. No retirement and no silent publish on the first sync. See R5-N1 for what happens to that hold next.

### R4-E (R4 recorded) — CLOSED

`#ensureRestoreGuard` `:1793` installs `{host: current, applied: step.expected, consent: null}` for a live configuration path with no guard, saved together with the restore record (`:793–794`) and again on resume (`:1270`) for older journals; `#recoverNative` also installs it before a replay of an unguarded live path. Verified:
- R5-8: direct restore, write landed, response lost (`applyFault after`, non-native path); plugin reload on the same host resumes, sets consent on the retained host-1 guard, publishes, and holds the stale flush. Pre-fix: the stale flush published `new` with `synced`.
- R5-8b: same loss, Obsidian restarted (new host id) observes the restore at startup: guard retired by design, restore publishes.
- R5-4: restore of a live path the user had deleted locally (expected `null`): guard `{applied: null}`; after publication a stale recreate is held. Pre-fix: the recreate published. Side observation below.
- R5-5: path unreadable through the whole resumed restore on host-2: the operation is dropped, the guard (rebound to host-2, no consent) is retained, and once readable the replayed bytes are held, not published. Pre-fix: the replayed restore published without consent.
- Root regressions "native replay guards a missing visible path before restoring from its hold" and "unknown pre-replay bytes retain the guard" pass; R4-J (deletion step whose path is already gone) unchanged. A restore cannot target a deletion: `#restorePreview` returns `missing` when the path is absent in the historical commit, so `step.next` is always non-null.

### R5-N1 (Low; pre-existing; bytes-safe; both guard kinds) — OPEN: a stale flush before publication silently reverts the reviewed restore

Locations: `#ensureRestoreGuard` `:1799` stamps `applied: step.expected`; `restore()` `:800–801` and `#resumeRestore` `:1306–1309` never move `applied` to the bytes this host wrote, only `consent`. `#transact` `:1039` skips any observation equal to `guard.applied`, and `:1014` advances `applied` to the consent version only after the restore has been published. For a pre-existing apply guard the same holds, since its `applied` is the apply's bytes, which are the pre-restore bytes.

Sequence: host-1 restores a live configuration path from history (write lands, consent recorded). Before the restore is published (the sync right after the restore fails, is contended, or the editor flushes first), Obsidian flushes its in-memory pre-restore bytes over the path. The next sync observes bytes equal to `applied`, treats the path as untouched, reports `up-to-date`, and GitHub keeps the pre-restore version. No hold, `listConfiguration().guarded = []`, the guard keeps a consent for bytes that are no longer on disk. The user's reviewed restore is gone without a signal.

Repro: `restore-guard-r5.test.mts` R5-N1 (existing and new guard), HEAD log `R5-N1 true sync after pre-publish stale flush: up-to-date | head: new configuration | local: new configuration | guarded: []`. Identical at `4e6128f`.

Second manifestation, R5-6: the resumed restore on host-2 was correctly held for re-consent because the head moved (above). A stale flush on host-2 then clears that hold the same way: `R5-6 true after stale flush: up-to-date | head: new configuration | guarded: []`. The hold for the user's decision vanishes and the restore is resolved by the editor rather than by the user. Pre-existing for an existing guard; for an unguarded path the pre-fix tree published the restore outright, so the fix improved the first sync and inherited this second step.

Not a wrong publish: GitHub never receives bytes the user did not have before. It is, however, the one remaining way a stale live-configuration flush on the writing host undoes a reviewed restore, and it is not conservative (no hold, no listing). For a reviewed apply the equivalent flush is always held because the apply guard names the bytes the plugin wrote.

Fix shape, verified as `candidate-session.diff` (+2 against HEAD `session.ts`, applied to a copy under the artifacts directory only):
- `restore()` after rebinding the host: `guard.applied = toRef(preview.historical)`; this host wrote those bytes.
- `#resumeRestore`: `if (installed && guard && step.next && guard.hostLifetimeId === this.#hostLifetimeId) guard.applied = step.next;` before setting consent. A guard still on another host (installed observed at startup) keeps its old `applied` and retires through `authorized` as today.

With the candidate: R5-N1 holds the pre-publication flush for both guard kinds; R5-6 publishes the resumed restore on the first sync even though the head moved (the same-path case still reaches ordinary conflict planning) and holds the later flush; the already-installed retirement, R4-D, R4-H/I/J, the frozen R2/R3/R4 suites, the 12 regressions and the root suite are unchanged. Whether a moved head should keep holding the restore for re-consent (HEAD) or let it publish (candidate) is the worker's call; the candidate removes the exact-head binding only for the restore's own bytes, and the hold in HEAD is in any case erased by the next flush.

### R5-O1, R5-O2, R5-O3 (Low, conservative) — a restore guard that outlives a restore that never landed holds the next edit

The guard made durable by `#ensureRestoreGuard` is never removed when the restore does not land, so an unguarded live path now carries `{applied: expected, consent: null}` after:
- R5-O2: `restore()` whose compare-and-swap returns `changed` (user edited during the write): restore reports `stale`, the user's edit is then held (`guarded: [".obsidian/appearance.json"]`, `up-to-date`) until consent. Pre-fix: published.
- R5-O3: a blocked restore whose replay stays refused (view still open): path quarantined, operation dropped, intent cancelled on the following sync, bytes back at `expected`; a later genuine edit is held. Pre-fix: published.
- R5-O1: the restore twin of R4-O1. Host-1's restore left a native intent, the user edited the preimage to a third value, host-2 syncs: `#recoverNative` installs the guard for the unguarded path before replay, the replay does nothing (not attempted), the third value is held. Pre-fix: published. For a pre-existing guard the behaviour is unchanged.

In every case the hold is visible in `listConfiguration().guarded`, consent publishes the bytes and advances `applied` (R5-11), and no bytes are published silently. Same class as R4-O1, which the brief accepts. Optional narrowing: in `restore()` delete the guard this call created when the write returns `changed`; in `#recoverNative` skip the restore ensure when the observation is known, non-null and equals neither `expected` nor `next`.

### Recorded only, outside this gate

- R5-4: a live configuration path that is absent on GitHub and restored from history is classified as a new hidden addition after the restore (`unconsented` at `:1044–1050`) and sits in `listConfiguration().unpublished` until hidden-publication consent, then publishes. Pre-existing policy, identical pre-fix; the new guard adds the stale-recreate hold after publication.
- R5-7: note restores and inert configuration restores (`.obsidian/snippets/…`) under `config/1` create no guard and publish as ordinary drafts; the root regression covers the visible-only scope.
- A newly restored path is listed under `guarded` before its first publish because `applied` (`expected`) differs from the restored bytes, even though consent is present. Cosmetic; the candidate above also removes it.
- The `#capture` in the restore replay branch re-reads scope for each `#ensureRestoreGuard` call (`#scopeFor` is not cached); correctness unaffected.
- `c169a2e` (`store.ts` deduplication), the journal-store tests and the Android editor-race helpers landed during the review and were not reviewed, per the brief.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test /tmp/github-v2-configuration-writing-host-review-r4/session-boundaries-r4.test.mts   # 11/11 at HEAD
node_modules/.bin/tsx --test /tmp/github-v2-configuration-writing-host-review-r4/composed-r4.test.ts          # 5/5 at HEAD
node_modules/.bin/tsx --test /tmp/github-v2-configuration-restart-review-r3/session-boundaries.test.ts /tmp/github-v2-configuration-restart-review-r3/composed.test.ts   # 17/17
node_modules/.bin/tsx --test test/configuration-restore-guard.test.ts                                        # 12/12
node_modules/.bin/tsx --test /tmp/github-v2-restore-writing-host-review-r5/restore-guard-r5.test.mts          # 12 pass, 4 fail: R5-N1 ×2, R5-6 ×2
R5_PLUGIN=/tmp/github-v2-restore-writing-host-review-r5/prefix/plugin \
  node_modules/.bin/tsx --test /tmp/github-v2-restore-writing-host-review-r5/restore-guard-r5.test.mts      # pre-fix 4e6128f: 7 pass, 9 fail
R5_PLUGIN=/tmp/github-v2-restore-writing-host-review-r5/candidate/plugin \
  node_modules/.bin/tsx --test /tmp/github-v2-restore-writing-host-review-r5/restore-guard-r5.test.mts      # candidate: 16/16
```

## Limits

No Obsidian DOM, Android device, real vault, GitHub network or power loss was exercised; the production device (old SHA `2a1f0`) was not touched. Process death is simulated by throwing after a journal save or after the fake's native intent record; the composed R4 cases drive the real native adapter and journals through the frozen R4 harness. Whether and when Obsidian flushes a hidden configuration file after a restore was not verified on a device; R2 through R4 made the same assumption, and R5-N1 depends on such a flush occurring before the restore's first publication. The candidate diff was run only under the artifacts directory and is a shape, not a reviewed change.
