# Independent restore consent review R7 — fix `59f841c`

**PASS. R6-A and R6-B are closed for both guard kinds. Consent to bytes that are already the checkpoint is now consumed on the next sync with no commit, and the moved-head re-consent hold on a restore now survives an Obsidian restart. Retirement of a guard on a new host is unchanged wherever no re-consent is pending (five retirement shapes identical pre- and post-fix). Consent authorizes nothing beyond its exact bytes, head and scope: a settled consent plus a same-path remote move publishes nothing, a stale-head consent stays held until re-consent, and a same-path remote change still ends in a conflict decision. No gate from R2 to R6 is reopened. R6-C stays theoretical and the R6-6 post-publication listing stays cosmetic; neither is material. No Android, DOM, product or device claim.**

Reviewed commit: `59f841c7fc991e83439efa32e565391934e854bd` ("Consume settled guard consent and retain restart review": `plugin/src/git-sync/session.ts` +6/−4, `plugin/test/configuration-restore-guard.test.ts` +66/−7). Parent `c6dd3d5`; its `session.ts` and test file are byte-identical to the tree R6 reviewed (`9c2fd0db…`, `50f48b02…`), so the R6 logs are a valid pre-fix baseline and the pre-fix tree used here (`prefix/`, `git archive c6dd3d5`, root `node_modules` symlinked) matches it. HEAD advanced during the review from `59f841c` to `6fb45d3` (one docs-only commit, `docs/verification/desktop-index-diagnosis.md`); `plugin/src` and the reviewed test file are byte-identical at both (`reviewed-sha256.txt`: `session.ts` = `6f5d4316…`). Root read-only on my side: no source, device, remote or real-vault writes, no subagents. Uncommitted edits to `plugin/src/git-sync/obsidian-vault.ts` and `plugin/test/native-vault.test.ts` appeared in the working tree at 01:26–01:27 from the separate desktop-index worker, after every root run below (01:23); they are not mine, were not reviewed, and do not touch the reviewed files. Artifacts: `/tmp/github-v2-restore-consent-review-r7/`.

## What the fix does

- `#transact` `session.ts:1018`: the consent-consumption test drops the `state.base.commit !== guard.consent.head` conjunct. A consent is consumed (`applied = consent.version; consent = null`) as soon as the checkpoint holds the consented bytes, whether or not a commit was needed. Closes R6-A.
- `#transact` `:1034`: `needsReconsent` is computed once (observation known, consent for exactly the local bytes, head or scope digest moved) and applied to the new-host retirement arm `:1038`: a first observation equal to `applied` no longer retires the old host's guard when re-consent is pending. The `authorized` arm is unchanged. Closes R6-B.
- Three root regressions per guard kind: consent to already-published bytes settles without a commit; moved-head direct restore stays held after a restart before and after the first sync; the crash-resume re-consent hold is now carried through a restart to `host-3`. All eight fail on the pre-fix tree (`root-regression-prefix.log`).

## Evidence

| Run | Result |
|---|---|
| Root `test/configuration-restore-guard.test.ts` at `59f841c` | 22/22 (`root-regression.log`) |
| Same file (HEAD copy) against pre-fix `c6dd3d5` | 14 pass / 8 fail: the 6 new cases and the 2 extended resume cases (`root-regression-prefix.log`) |
| Root suite `tsx --test test/*.test.ts` at `59f841c`, clean tree | 464/464 (`root-suite.log`); `tsc --noEmit` exit 0 (`tsc.log`) |
| Frozen R6 `restore-baseline-r6.test.mts` at HEAD (unmodified) | 30/30 (`r6-frozen-head.log`); R6-1b ×2 now pass; R6-2, R6-2c, R6-3 restart lines now show the hold retained |
| Frozen R5 `restore-guard-r5.test.mts` at HEAD (unmodified) | 16/16 (`r5-frozen-head.log`) |
| R7 `restore-consent-r7.test.mts` (25 cases, real engine, root fakes) at HEAD | 25/25, two identical runs (`r7-head-run1.log`, `r7-head-run2.log`, log lines byte-identical) |
| Same file against pre-fix `c6dd3d5` | 18 pass / 7 fail (`r7-prefix-run1.log`): R7-1 ×2 (R6-A), R7-6 ×2 and R7-6b ×2 (R6-B), R7-8 (R6-A on a new host). Every other case is identical pre- and post-fix |

## Findings

### R6-A (R6 Low) — CLOSED, both guard kinds

- R7-1: direct restore, stale pre-restore flush held, consent to the editor's bytes. Next sync: `up-to-date`, branch head unchanged (no commit), `applied` = the consented bytes, `consent = null`, `guarded: []`, preview `missing`. A later genuine edit is still held. Pre-fix: listed with a live preview after the same sync.
- R7-2 (consumption cannot over-authorize): consent for bytes already at the checkpoint, then another device moves the same path to a third value before the sync. HEAD: consent consumed, `guarded: []`, GitHub keeps the third value, nothing published; the incoming live-configuration change is deferred for the user's apply as designed, so local keeps the consented bytes, and a re-flush of those bytes is neither held nor published. Pre-fix: same bytes on both sides, but listed forever with the consent retained.
- R7-3: consent to a held deletion (`version: null`) publishes the deletion and is consumed on the following sync (`applied: null`, `guarded: []`). Identical pre-fix (the commit moved, so the old conjunct held too).
- R7-8: the consent is consumed on a new host while the path is unreadable there; the guard is retained and listed as unreadable, and once readable again the path settles with no publish.
- R6-11 / R6-11b (frozen): the pre-existing apply-guard shape of the same class (another device publishes the bytes the user later types and consents to) now clears on the next sync instead of two syncs after an unrelated remote commit.

### R6-B (R6 Low) — CLOSED, both guard kinds

- R7-6: direct restore, head moves on another path, Obsidian restart. Host-2's first sync keeps the guard, rebinds it to host-2, lists the path and offers a re-consent preview; GitHub keeps the pre-restore bytes. A flush of the pre-restore bytes on host-2 is held, not accepted (the R5-N1 closure also holds on the new host). Consent to that flush settles the guard (`applied` = the flushed bytes, `consent = null`, `guarded: []`). Pre-fix: host-2's first sync retired the guard and published the restore with no re-consent.
- R7-6b: re-consent on host-2, publication, restart to host-3 before the settling sync: the consent is consumed (checkpoint has the bytes) and the guard retires. No stuck guard after the hold is honoured.
- Frozen R6-2, R6-2c (both kinds) now log `restore published without re-consent: false`, `guard retired: false`, `re-consent hold survived restart: true`; R6-3 host-3 logs `restart retired the guard and published without re-consent: false`.

Retirement is unchanged where no re-consent is pending (R7-5, identical pre- and post-fix):
- R7-5a: apply guard, restart observes the applied bytes, head unmoved: retired.
- R7-5b: apply guard, restart, head moved on another path, no consent: retired, nothing published. The new `!needsReconsent` term is false without a consent, so a moved head alone never blocks retirement.
- R7-5c: direct restore, no sync, head unmoved, restart: `authorized`, retired, the reviewed restore publishes (R5-8b policy).
- R7-5d: restore published on host-1, restart before the settling sync: consent consumed, guard retired, `guarded: []`.
- R7-5e: pending consent for a held edit at the unmoved head, restart: `authorized`, retired, the edit publishes.

### Head and scope binding intact

- R7-4: a consent for a genuine edit recorded at head H; another device moves the head before the sync. The consent does not publish (`head` unchanged, path still listed), the re-consent preview binds the new head, and only the fresh consent publishes; the guard then settles with `applied` = the edit. Identical pre-fix.
- The scope digest is derived from the head commit, so it cannot move independently in this harness; the `consent.scope === headScope.digest` conjunct is unchanged in `authorized` `:1033` and is the same term `needsConfigurationReconsent` `:2543` tests, so the two cannot disagree.
- Host identity: the guard still rebinds to the observing host on the first non-retiring observation (`:1043`, R7-6 `hostLifetimeId: host-2`), and the `authorized` retirement arm is byte-identical.

### Behaviour change noted, not a finding — same-path remote change after a restart

R7-7 / frozen R6-2b: direct restore, another device changes the restored path, Obsidian restart. Pre-fix the first sync on host-2 retired the guard and went straight to `needs-decision | conflicts: [path]`. At HEAD it is held for re-consent first (same as the same-lifetime path, which was already held pre-fix), and the sync after re-consent reaches the same `needs-decision` on the path; GitHub keeps the remote bytes and the vault keeps the restore at every step, in both lifetimes and both guard kinds. The re-consent preview does not show the remote bytes (fields: `head`, `scopeDigest`, `applied`, `version`, `entry`), but since conflict planning follows the consent, nothing is overwritten on the strength of that preview. This makes the restart path consistent with the same-lifetime path at the cost of one extra consent step. The R6 note that an "untouched" hold lets a later consent publish over a same-path remote change did not reproduce for the restore shape; the base entry for the held path is not advanced here (`base[path]: null` in the R7-7 log) and the conflict is still planned.

### R6-C (R6 Low, theoretical) — not material, unchanged

Frozen R6-5 at HEAD still logs `held for re-consent: true` then `hold erased by the flush: true`: a restore whose write landed but whose response was lost, observed already installed on a new host, keeps the old host's `applied = expected` by design (R2-C4c), so a flush of the pre-restore bytes on the new host clears the hold with `up-to-date`. That flush needs a process that still holds the pre-restore bytes in memory, which a freshly started Obsidian that loaded the restored bytes from disk does not; it requires a second process on the same vault, out of scope since R2. Bytes-safe (GitHub keeps bytes the user already had). Not reopened.

### R6-6 (R6 recorded) — cosmetic, unchanged

Frozen R6-6 at HEAD: between the restore's publication and the next sync the path is listed and the preview returns `preview` (consent head is the pre-publication commit, so the re-consent predicate is true). A consent recorded in that window is consumed on the next sync with no effect (`guard.consent: null`, `guarded: []`). Not material. If the worker wants it gone, consuming the consent after `state.base` advances in the publishing sync (`:1134`) would close it; not required for this gate.

### Recorded only

- Incoming remote changes to a live configuration path are deferred for the user's apply, so after R7-2 the vault keeps the consented bytes while GitHub holds the third value until the user applies; pre-existing design, exercised by the fixture itself.
- The desktop-index worker's uncommitted edits (`obsidian-vault.ts`, `native-vault.test.ts`) landed after all root runs and were not reviewed.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test test/configuration-restore-guard.test.ts                                         # 22/22
node_modules/.bin/tsx --test /tmp/github-v2-restore-baseline-review-r6/restore-baseline-r6.test.mts            # 30/30
node_modules/.bin/tsx --test /tmp/github-v2-restore-writing-host-review-r5/restore-guard-r5.test.mts           # 16/16
node_modules/.bin/tsx --test /tmp/github-v2-restore-consent-review-r7/restore-consent-r7.test.mts              # 25/25
R7_PLUGIN=/tmp/github-v2-restore-consent-review-r7/prefix/plugin \
  node_modules/.bin/tsx --test /tmp/github-v2-restore-consent-review-r7/restore-consent-r7.test.mts            # pre-fix c6dd3d5: 18 pass, 7 fail
(cd /tmp/github-v2-restore-consent-review-r7/prefix/plugin && node_modules/.bin/tsx --test test/configuration-restore-guard.head.test.ts)  # HEAD regressions vs pre-fix: 14 pass, 8 fail
grep -E "^R7-(2|5|7)" /tmp/github-v2-restore-consent-review-r7/r7-head-run1.log                                # consumption safety, retirement, same-path lines
```

## Limits

No Obsidian DOM, Android device, real vault, GitHub network or power loss was exercised. Restarts are modelled as a new `SyncSession` with a new `hostLifetimeId` over the same store and vault; process death as in R5/R6 (faulted saves). Whether Obsidian flushes a hidden configuration file after a restore on a device was not verified, as in R2 through R6. The scope-digest half of the consent binding was reasoned from the code, not driven, because the harness cannot move the scope without moving the head. No fix shape was applied anywhere.
