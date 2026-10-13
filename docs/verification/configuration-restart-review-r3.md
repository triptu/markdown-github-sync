# Independent configuration-restart review R3 — C4-R fix `07d835d`, S2/already-enabled fix `8658ac5`

**C4-R as reported in R2 is closed. S2 and the already-enabled message are closed. One new finding inside the same reviewed-apply gate is open (Medium): when the apply's vault write lands on the *new* host (resume after a crash or a blocked step), the guard is still attributed to the reviewing host and is retired in the same sync, so a later stale flush on the writing host republishes silently. No Android, DOM, product, or full-replacement approval claimed.**

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`. Started at HEAD `afdb5a5`; HEAD advanced during the review to `ed0683e` (concurrent commits `f51a312`, `ade2a99`, `f01818f`, `ed0683e`). `plugin/src/git-sync/session.ts` and both reviewed test files are byte-identical across that range; `plugin/src/main.ts` gained only a DOM-only "Review configuration" button in the Changes modal (`main.ts:955–959`, commit `f51a312`). Every suite below was rerun once more with HEAD pinned at `ed0683e` before and after the run (`final-rerun-head.txt`). `reviewed-sha256.txt` records the hashes. An untracked file `scripts/build-native-configuration-restart.mjs` appeared in the root during the review; it is not mine and was not touched.

Root was read-only from this review: no source, device, remote, real-vault writes, no subagents. Artifacts: `/tmp/github-v2-configuration-restart-review-r3/`.

## Evidence

| Run | Result |
|---|---|
| Original R2 `review.test.ts` (13 cases, unmodified, in place) | 13/13 pass, four runs (`original-13-run1..3.log`, `original-13-final.log`); R2-C4a and R2-C4b assert head keeps the incoming version, so these are real passes |
| Root suite `tsx --test test/*.test.ts` | 424/424 (`root-suite.log`, `root-suite-final.log`); prior 415 + 8 tests in `07d835d` + 1 in `8658ac5` |
| `test/git-session.test.ts` alone | 152/152 |
| `tsc --noEmit` | exit 0 (`tsc.log`) |
| R3 session-level boundaries `session-boundaries.test.ts` (12 cases) | 9 pass / 3 fail, stable over four runs; the 3 failures are the new finding (B1, B2, B3b) |
| R3 composed `composed.test.ts` through the real plugin class (5 cases) | 4 pass / 1 fail, stable; the failure is the composed reproduction of the new finding (R3-C1). `composed-run1.log` shows two failures from my own harness mistakes (fault landed before the journal rename; S2b control re-ran startup under the same injected failure); fixed in run 2 and later |

The R2 harness was copied to the R3 directory with only its temp-bundle path changed (`harness.ts` hash in `reviewed-sha256.txt`).

## Findings

### C4-R (R2 High) — CLOSED

Code: `session.ts:1007–1036`. The host-change branch now deletes a guard only when the first observed local version under the new host is `known` and equals `guard.applied`, or is exactly the consented version at the consented head and scope digest; otherwise the guard is rebound to the current host and the path is held. Guards for paths outside the frozen transaction are rebound without evaluation and kept. `#guardActive` is gone; listing (`:328`), preview (`:406`), consent (`:390`), restore (`:794`, `:1295`) no longer skip old-host guards, so a quit-time flush is visible and consentable before the first new-host sync. Consent now archives the consented bytes (`:391`) so the guard's `consent.version` oid is a referenced blob (`state.ts:652`, `:898`); without that, a pre-sync consent would have produced a state that fails to parse.

Verified beyond test names:
- R2-C4a/b pass with head unchanged, guard listed, host rebound; R2-C4c control still retires and a genuine edit publishes.
- Root test at `git-session.test.ts:2853–2893` has its final assertion inverted as R2 requested (`up-to-date`, head keeps the consented version, guard rebound to `host-2`).
- B4/B4b/B4c: pre-sync consent on the new host leaves loadable state (a fresh session is `enrolled`, not `corrupt`), publishes exactly, deletion consent needs no bytes, and a different flush after consent stays held.
- B5/B5b/B5c: a null guard host met by an identified host, an identified guard met by a null-host session, and a crash-recovered operation with no host id all take the conservative path (stale held and rebound; applied bytes retire).
- B6: held across two restarts; publishes only after consent on the latest host.
- B7: unreadable at the first new-host sync is rebound and stays held after it becomes readable, whatever the bytes (same-host rule thereafter).

### R3-C1 (Medium, reviewed-apply guarantee; silent overwrite on GitHub) — OPEN: a resumed apply binds its guard to the reviewing host, not the host that performed the write

Locations: `session.ts:1772–1774` (`#setConfigurationGuard` always stamps `operation.hostLifetimeId`), used at `:1724` (rebuild of already-applied steps), `:1738` (pending step found already at `next`), and `:1754` (the vault write performed *now* by *this* session); `:1025–1029` then retires the guard in the same `#transact` because the host differs and the observed bytes equal `applied`. `#resume` (`:1243–1247`) runs before `#transact` in the same `sync()`.

Sequence: reviewed apply becomes durable on host H1 (`:523–524`), then H1 goes away before the vault write (process death in that window, or a step that returned `blocked` and persists across the restart). H2 starts; Obsidian loads the old bytes into memory. The plugin's first sync resumes the operation, writes the reviewed bytes on H2, stamps the guard with H1, and the same transact retires it. Any later stale flush on H2 (the host whose memory still holds the old bytes, the exact case the same-host guard exists for) publishes with `Content synced`, no held count, `listConfiguration().guarded` = `[]`.

Repro (all stable): `session-boundaries.test.ts` B1 (crash after the operation record save), B2 (`blocked` on H1, released on H2), B3b (write landed on H1, step save lost, quit-time flush, H2 re-applies then flushes); `composed.test.ts` R3-C1 through the real plugin class with the process dying right after the journal rename that commits the operation record. Log excerpt: `R3-C1 after restart sync: Content synced · e1974f8 | local: {"theme":"new"}`, `guarded after resume: []`, `after stale flush on the writing host: Content synced · 418281c | head: {"theme":"old"}`.

Control B3 passes: write landed on H1 and only the step save was lost; H2 started with the applied bytes on disk, so retiring is the R2-C4c design and a later H2 edit publishes.

This is not a regression from the pre-fix code (it retired on any host change), and the root test added in `07d835d` ("a restored old-host guard holds a stale flush after crash recovery on a new host") covers only the write-on-old-host variant. It is the crash-recovery variant R2 named as "not separately reproduced", now reproduced. Fix shape: at `:1754` stamp the guard with `this.#hostLifetimeId` (the write happened under this host); keep `operation.hostLifetimeId` at `:1724` and `:1738` (bytes were on disk when this host started). Expected: B1/B2/B3b/R3-C1 pass; the existing crash-recovery tests unchanged. Realistic triggers in the real adapter: the crash window between the operation record commit and the write; blocked results that persist across restarts (`obsidian-vault.ts:575` oversize native recovery pending, `:580` a different pending native transaction, `:599` journal unavailable). The open-view block (`:199–212`) applies to visible paths only and so does not reach hidden configuration files.

### S2 (R2 Low, failed-startup toggle bypass) — CLOSED

Code: `main.ts:488–495` consults the on-disk native journal for the installation when the toggle changes with no repository binding, in addition to the in-memory `nativeJournal`. Verified: R3-S2a (prior bound journal, startup fails at secret storage, flip refused with the bound-scope message, `settings.configuration` unchanged, recovery starts `visible-only`); R3-S2b control (first-ever startup fails before any journal, flip accepted, later startup is `config/1`, so there is no false refusal); R3-S2c duplicates S2a and only records the native journal path (it does not corrupt the journal despite its name). Root test `plugin-safety.test.ts` "startup failure cannot bypass the durable initial scope binding" covers the same path. Missing-identity boundary: with no installation id in localStorage the check falls back to the in-memory journal, and startup mints a fresh id (`main.ts:207–210`) whose journal cannot pre-exist, so no policy mismatch can follow; a non-string id makes `repositoryBinding()` throw `Invalid device identity.` A corrupt journal file would make `load()` throw and the save fail closed; not exercised.

### Already-enabled message (R2 Low S1 observation) — CLOSED

`main.ts:339–341` returns "Configuration sync is already enabled. Use Review configuration sync in the command palette…" before the native preview runs. Verified for a fresh `config/1` enrollment and for a migrated device (R3-S1); the R2-S1 log line now shows this message instead of the native-internal one. R2-C6 still reports `Resolve the existing pause first` for a paused legacy device, so the pause ordering is unchanged.

### Out of this gate, recorded only

- Status bar still renders guarded paths as `N held files pending` (`main.ts:552–556`), unchanged. The Changes modal gained a "Review configuration" button (`main.ts:955–959`, `f51a312`), DOM only, not exercised here.
- `afdb5a5` touches only the native acceptance helper `plugin/test/native/configuration-acceptance.ts`; not run here.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test /tmp/github-v2-composed-configuration-review-r2/review.test.ts      # 13/13
node_modules/.bin/tsx --test /tmp/github-v2-configuration-restart-review-r3/session-boundaries.test.ts   # 9 pass, 3 fail: B1 B2 B3b
node_modules/.bin/tsx --test /tmp/github-v2-configuration-restart-review-r3/composed.test.ts     # 4 pass, 1 fail: R3-C1
```

## Limits

No Obsidian DOM, Android device, real vault, GitHub network, or power loss was exercised. The crash in R3-C1 is simulated by throwing after the journal rename; the blocked path in B2 uses the fake vault's `refuse` intent. Whether Obsidian or a plugin flushes a hidden configuration file after a resumed write on the new host was not verified on a device; R2 made the same assumption for C4-R. Native internals, Quint, and the acceptance helper were not re-examined.
