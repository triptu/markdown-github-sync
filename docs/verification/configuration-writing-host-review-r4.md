# Independent configuration writing-host review R4 — R3-C1 fix `4fc0466`, missing-preimage fix `697bdb5`

**R3-C1 is closed for the reviewed configuration apply, including native replay from a held or unreadable preimage, through the real plugin class and the real native adapter. One finding of the same class remains open (Medium): the *restore* operation, the other reviewed write, never names the host that performed its write. A restore resumed, replayed, or started on a new host leaves the guard on the old host; the restore's own consent makes the first sync retire the guard, and a later stale flush on the writing host republishes the pre-restore bytes with `Content synced`. Pre-existing, not a regression. A fix of the same shape as `4fc0466` was verified in a throwaway copy: all R4 cases pass and the root suite stays green. No Android, DOM, product, or full-replacement approval claimed.**

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`. Started at HEAD `697bdb5`; HEAD advanced during the review to `e8fdd3e` (`3bc9ae9`, `885a24e`, `6383753`, `e8fdd3e`: two docs, one journal-store test, the native acceptance helper and its build script). `plugin/src/git-sync/session.ts`, `obsidian-vault.ts`, `state.ts`, and `main.ts` are byte-identical across that range (`reviewed-sha256.txt`). Every suite below was rerun with HEAD pinned at `e8fdd3e` before and after (`final-rerun-head-*.txt`). One uncommitted root change, `README.md`, is not mine and was not touched.

Root was read-only from this review: no source, device, remote, real-vault writes, no subagents. Artifacts: `/tmp/github-v2-configuration-writing-host-review-r4/`. The pre-fix tree (`24f68f7`) and a candidate-fix copy of HEAD live under that directory only; the root's `node_modules` is symlinked into them.

## Evidence

| Run | Result |
|---|---|
| Frozen R3 `session-boundaries.test.ts` (12 cases, unmodified, in place) | 12/12, four runs (`frozen-session-boundaries-run1..3.log`, `-final.log`); B1, B2, B3b now pass |
| Frozen R3 `composed.test.ts` (5 cases, unmodified) | 5/5, four runs; R3-C1 log now reads `after stale flush on the writing host: Checked GitHub · 1 held files pending \| head: {"theme":"new"}` |
| Original R2 `review.test.ts` (13 cases) | 13/13 (`original-13-final.log`) |
| Root suite `tsx --test test/*.test.ts` | 437/437 at `697bdb5` (`root-suite.log`), 438/438 at `e8fdd3e` (`root-suite-final.log`; +1 from `885a24e`) |
| `tsc --noEmit` | exit 0 (`tsc.log`) |
| R4 session-level `session-boundaries-r4.test.mts` (11 cases, real engine, root fakes) at HEAD | 8 pass / 3 fail, four runs; the 3 failures are R4-C1 (A, B, C) |
| Same file against the pre-fix tree `24f68f7` (`r4-session-prefix-run1.log`) | 6 pass / 5 fail: R4-A/B/C fail there too (pre-existing); R4-H and R4-I fail only pre-fix (fix confirmed effective) |
| R4 composed `composed-r4.test.ts` through the real plugin class, real native adapter and journals (5 cases) | 2 pass / 3 fail, four runs; failures are R4-C1 composed; controls R4-D and R4-R3C1 pass |
| Candidate fix (HEAD copy + `candidate-session.diff`) | R4 session 11/11, R4 composed 5/5, candidate root suite 438/438, `tsc` exit 0 |

The R3 harness was copied with only its temp-bundle path changed (`harness.ts` hash in `reviewed-sha256.txt`).

## Findings

### R3-C1 (R3 Medium) — CLOSED

Code: `session.ts:1754` stamps the guard with `this.#hostLifetimeId` when this session's `vault.apply` returns `applied`; `:1724` and `:1738` go through `#restoreConfigurationGuard` (`:1772`), which keeps an existing guard whose `applied` already equals `step.next` and otherwise stamps `operation.hostLifetimeId` (bytes were on disk when this host started). `#recoverNative` (`:1813–1829`) makes a current-host guard durable before `vault.recover` for every authorized configuration replay unless `next` is already visible, so a replay that writes under this host cannot later be re-attributed to the recording host by `:1738`.

Verified beyond the root tests:
- Frozen B1/B2/B3b and composed R3-C1 pass unchanged; B3 control (write landed on the old host, only the step save lost) still retires.
- R4-H: step 1 applied on host-1 then stale-flushed at quit, step 2 blocked with a native intent, host-2 replays step 2. Both guards end on host-2, step 1 held, a host-2 stale flush over step 2 held, listing shows both paths. Fails pre-fix (step 2 guard missing).
- R4-I: native write landed on host-1 with the response lost, quit-time flush restores the preimage, host-2 replays and rewrites. Guard on host-2, stale host-2 flush held. Fails pre-fix.
- R4-J: reviewed deletion whose path is already gone at replay: no guard created, deletion retires, head null.
- R4-R3C1 composed: the reviewed apply's real native rename transaction dies right after `path → hold`; the restart replays it through the real adapter and `1 held files pending` follows the stale flush.
- Consent loss (R4-F3): a guard with unpublished consent and a pending configuration step on the same path are not co-reachable. With consent recorded and a newer remote pushed, `previewApplyConfiguration` returns no items (the path is held, not deferred) and the sync leaves the consent intact. The pre-replay stamp at `:1825` writes `consent: null`, but no path can reach it while carrying a consent.

### R4-C1 (Medium, reviewed-restore guarantee; silent overwrite on GitHub) — OPEN: a restore written on a host other than the guard's host is retired by its own consent

Locations: `session.ts:793–797` (`restore()` sets `guard.consent` after this session's `vault.apply`, never `guard.hostLifetimeId`); `:1278–1298` (`#resumeRestore` treats "observed `next`" and "wrote `next` now" alike and sets only `consent`); `#recoverNative` `:1813` (the pre-replay guard covers `operation.kind === "configuration"` only, so a replayed restore intent writes under the new host with the guard still on the old one). In the same sync, `#transact` `:1022–1028` sees a different host and `authorized` (the restore's consent at the current head and scope) and deletes the guard.

Sequence: a configuration path carries a guard from a reviewed apply on H1. A restore of a historical version becomes durable, and its write lands on H2: after a crash between the restore record and the write (A), after a native rename transaction died mid-way and is replayed by H2's first sync (B), or because the user restores from File history on H2 before H2's first sync (C; `main.ts:1323` calls `syncNow()` right after). H2's Obsidian loaded the pre-restore bytes at startup. The first sync publishes the restore and retires the guard. Any later stale flush of the pre-restore bytes on H2 publishes with `Content synced`, no held count, `listConfiguration().guarded` = `[]`. GitHub ends at the bytes the user just restored away from.

Repro (all stable, four runs): `session-boundaries-r4.test.mts` R4-A, R4-B, R4-C; `composed-r4.test.ts` R4-A (process dies after the journal rename that commits the restore record), R4-B (real native rename transaction dies after `path → hold`; the hold and nine native records survive; the restart replays through the real adapter), R4-C. Log excerpt: `R4-B composed after restart sync: Content synced · 418281c | local: {"theme":"old"} | head: {"theme":"old"} | guarded: []`, then `after stale flush on the writing host: Content synced · bdba383 | head: {"theme":"new"} | guarded: []`.

Controls: R4-D (same host; session and composed) holds the stale flush with `1 held files pending` and publishes only after consent.

This is pre-existing: the same three cases fail against `24f68f7`. It is the restore-shaped twin of R3-C1 and was outside the `4fc0466` gate, which touched only the configuration apply.

Fix shape, verified in `candidate-session.diff` (+21/−0 against HEAD `session.ts`, applied to a copy under the artifacts directory only):
- `:795` in `restore()`: set `guard.hostLifetimeId = this.#hostLifetimeId` before setting consent; this session performed the write.
- `#resumeRestore`: track `writtenNow` (true only when this session's `vault.apply` returned `applied`) and rebind the guard host only then. An `installed` observed at entry keeps the old host (bytes were on disk at startup, R2-C4c design).
- `#recoverNative`: for an authorized restore replay whose path already carries a guard, rebind the guard host to the current host before `vault.recover` unless `next` is already visible; do not create a guard (restore of an unguarded path stays the existing design, see below).

Expected and observed with the candidate: R4-A/B/C pass at session and composed level with the guard on host-2 and `applied` advancing to the restored version after publish; R4-D unchanged; frozen R3 and R2 suites unchanged; candidate root suite 438/438; `tsc` clean. Root ownership of the actual change and its tests is unchanged by this note.

### R4-O1 (Low, conservative) — the pre-replay guard can hold a path that was never written

`:1819–1829` stamps `{applied: step.next, host: current}` before replay whenever `next` is not visible, including when the live bytes are a third value (user edit of the preimage). No replay path installs `next` from a third value (`obsidian-vault.ts` `renameTransaction` and `textTransaction` return `changed` or preserve `interrupted`), so the guard then names bytes that never landed. R4-F: host-1's apply left a native intent, the user edited the preimage, host-2 syncs. HEAD: `up-to-date`, path listed as guarded with `applied` = the never-written `next`, one consent step, then the `needs-decision` conflict. Pre-fix: `needs-decision` immediately. R4-F2 (vault refuses the replay): path quarantined either way; the stamped guard outlives the quarantine with `applied` = `next` while the file still holds `expected`. No silent publish and no consent loss in either case; the cost is a spurious "held" entry and an extra consent. Optional narrowing: skip the stamp when the observation is `known`, non-null, and equals neither `expected` nor `next`.

### Recorded only, outside this gate

- R4-E: restore of a configuration path that never had a guard (the path became a genuine local edit, then was restored from history). The restore writes under Obsidian with no guard, the restore publishes, and a stale flush of the pre-restore bytes publishes next (`R4-E after stale flush: synced`). The `restore()` comment binds the guard only `if (guard)`; this is the pre-existing "restore stages a local draft" design, not a host-attribution defect, and identical pre-fix.
- The `authorized` check in `#recoverNative` reads `this.#unreadable` before this session's first capture, so a fresh session authorizes replay of a path that a later capture reports unreadable; the root test "unreadable pre-replay configuration stays guarded" depends on this ordering. The guard is still stamped (observation `unknown`), so it is conservative.
- Status bar text and the Changes modal "Review configuration" button were not exercised. `c0ef284` (native rename intent for open hold views) and the store/editor work of the other reviewers were not re-reviewed, per the brief.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test /tmp/github-v2-configuration-restart-review-r3/session-boundaries.test.ts        # 12/12
node_modules/.bin/tsx --test /tmp/github-v2-configuration-restart-review-r3/composed.test.ts                  # 5/5
node_modules/.bin/tsx --test /tmp/github-v2-configuration-writing-host-review-r4/session-boundaries-r4.test.mts   # 8 pass, 3 fail: R4-A R4-B R4-C
node_modules/.bin/tsx --test /tmp/github-v2-configuration-writing-host-review-r4/composed-r4.test.ts          # 2 pass, 3 fail: R4-A R4-B R4-C composed
R4_PLUGIN=/tmp/github-v2-configuration-writing-host-review-r4/prefix/plugin \
  node_modules/.bin/tsx --test /tmp/github-v2-configuration-writing-host-review-r4/session-boundaries-r4.test.mts   # pre-fix: 6 pass, 5 fail
R4_PLUGIN=/tmp/github-v2-configuration-writing-host-review-r4/candidate/plugin \
  node_modules/.bin/tsx --test /tmp/github-v2-configuration-writing-host-review-r4/session-boundaries-r4.test.mts   # candidate: 11/11
```

## Limits

No Obsidian DOM, Android device, real vault, GitHub network, or power loss was exercised. Process death is simulated by throwing after a journal rename or after the native `path → hold` rename; the blocked restore in R4-B (session) uses the fake vault's `refuse` intent, while composed R4-B drives the real adapter's rename transaction and its journal. Whether Obsidian flushes a hidden configuration file after a resumed restore on the new host was not verified on a device; R2 and R3 made the same assumption. The candidate diff was run only under the artifacts directory and is a shape, not a reviewed change. Native internals, Quint, and the acceptance helper were not re-examined.
