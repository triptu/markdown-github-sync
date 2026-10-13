# Independent composition review R2 — host-bound configuration guards, review outcomes, scope migration repairs

**Changes requested on C4. No Android, DOM, product, or full-replacement approval claimed.** The three fix commits (`b09625a`, `f120dfe`, `0aba5a0`) close C0, C8, C1, C3b and C6 as composed through the real plugin class: the root's own adapted Fable suite reruns 12/12 here, and the root suite, typecheck and build pass independently. The C4 full-host-restart challenge is **confirmed as a reproducible silent revert** (two reproductions below). One Low settings/native-binding gap and three Low UI observations follow.

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`, started at `0aba5a0`. HEAD advanced to `26f3d5c` during the review; the only `plugin/src` change since `0aba5a0` is a DOM-only `<details>` wrapper around the unpublished-files list in `main.ts:783–787` (commit `0d00275`), which no finding depends on. `reviewed-sha256.txt` records the working-tree hashes; `main.ts` at `0aba5a0` hashes `519c7073…`, at HEAD `2f08d509…`. Engine files are byte-identical between the two.

Root was read-only: no source edits, device, remote, real vault, or subagents. Artifacts live under `/tmp/github-v2-composed-configuration-review-r2/`. Native N1/N2/B1 (`4da2def`) and the Quint review were not re-examined.

## Method

`harness.ts` is the R1 composition harness (real `main.ts` bundled against the repository's Obsidian fixture; everything but `GitHubRepository` is production code; hidden files are absent from `getFiles()` as in Obsidian) with one addition: `restartHost()` replaces the simulated `App` object while keeping the vault files, journals and localStorage. That is what a full Obsidian restart or an Android process death gives the plugin: `hostLifetimeId(app)` (`ownership.ts:31`) is a Symbol property on the App object, so a new App yields a new id while a plugin reload (`host.create(true)` on the same App) keeps it.

`review.test.ts`: **11 pass / 2 fail** out of 13, stable across four runs (`run1–4.log`). The two failures are the acceptance assertions for C4 (R2-C4a, R2-C4b). Independent root evidence from the working tree: `root-suite.log` 415/415, `tsc.log` exit 0, `build.log` exit 0 (output to the gitignored `dist/`), `root-closure-rerun.log` 12/12 for `/tmp/github-v2-composition-root-closure/review.test.ts`.

## Findings

### C4-R (High, reviewed-apply guarantee; silent overwrite on GitHub): a full host restart retires the post-apply guard regardless of what is on disk, republishing a stale same-host overwrite

Locations: `plugin/src/git-sync/session.ts:1760–1762` (`#guardActive`: a guard whose host id differs from the current session's is inactive), `:1007–1012` (`#transact` deletes every inactive guard before planning, without comparing the local version to `guard.applied`), `:329` and `:392/:407` (listing and preview also skip inactive guards, so the UI shows nothing), `plugin/src/main.ts:764` (the apply Notice instructs "Restart Obsidian to load them"). Root test `plugin/test/git-session.test.ts:2853–2889` asserts this exact behavior as intended (`session("host-2")` → `synced`, head = "another stale flush").

Repro: `review.test.ts` `R2-C4a` and `R2-C4b`.

1. Legacy enrollment → reviewed migration → `.obsidian/app.json` published (old) → remote update (new) → `applyConfiguration` returns `applied`; disk holds the new bytes; the guard records host H1.
2. Before the user quits, Obsidian or a plugin flushes stale in-memory settings over the file (old bytes). In R2-C4a no sync runs in between (the quit-time flush; the device may be offline or automatic sync paused). In R2-C4b a sync does run under H1 and correctly reports `Checked GitHub · 1 held files pending` with head unchanged.
3. Full restart: new App (host H2), same files. `initialize()` → `syncOnce()`.

Observed in both: `Content synced · 418281c`; head `app.json` is the **old** version; `listConfiguration().guarded` is `[]`; no attention, no Notice, no conflict. In R2-C4b the engine had already observed and durably held the unreviewed version and still discards that evidence on the host change. The other device's reviewed apply is reverted without review on either side, and the two devices can ping-pong exactly as in R1-C4, now one restart deep instead of one write deep. The apply Notice itself tells the user to restart, which is the trigger.

Control `R2-C4c`: restart with the applied bytes still on disk retires the guard cleanly and a genuine post-restart edit publishes; that path should keep working.

Decision requested in the brief: **the guard must not retire on host change alone.** Recommended rule: when the current session's host id differs from the guard's, retire the guard only if the first observed local version under the new host equals `guard.applied` (or the consented version); otherwise keep it held (rebinding its host id to the current host so the same-host logic continues) until exact-version consent. This preserves R2-C4c and closes R2-C4a/b. The same deletion-on-host-change applies to the guard rebuilt by crash recovery (`session.ts:1711`, `operation.hostLifetimeId`), so a crash mid-apply followed by a restart on a new host sees its guard dropped in the same transaction; that variant was not separately reproduced. The root test at `git-session.test.ts:2887–2889` would need its final assertion inverted.

Evidence limits: whether Obsidian itself rewrites `app.json` at quit, and which plugins flush `data.json` in `onunload` or on a debounce, was not verified on a device. The composed sequence requires only that one such write lands after apply and before the next sync, which the status text already acknowledges can happen.

### S2 — Low (startup liveness, narrow): the first-enrollment configuration toggle can be flipped after the native journal is bound when startup failed before the journal opened

Locations: `plugin/src/main.ts:484–486` (the "Initial scope is already bound" guard keys on `this.nativeJournal`, which is null whenever `initializeOwned` threw before `NativeTransactionJournal.open`), `:226–231` (an unenrolled device derives its native policy from `settings.configuration`), `:244` (a `NativePolicyMismatchError` without a `scope-enrollment` pause propagates).

Repro: `review.test.ts` `R2-S2`. Settings saved with configuration off (legacy journal persisted on open, `native-transactions.ts:209`), then a startup that fails at the secret-storage check, then the toggle is flipped and saved: the save is accepted and `settings.configuration` becomes true; the next startup fails with `Native transaction journal policy does not match this vault.` and no session. Recovery exists: the toggle stays enabled because `session` is null, flipping it back and retrying reconnects (asserted). The normal path (journal open) is refused correctly with the bound-scope message (asserted). Low because it needs a prior startup failure; the mismatch message does not say which toggle to revert.

### Low observations (code reading plus logs; no acceptance assertion)

- `main.ts:684–697` "Review configuration sync" is always shown. On a device that is already config/1 (for example fresh enrollment with the new toggle) it fails with the native-internal message `Native policy upgrade requires a legacy journal and a config policy.` (`R2-S1` log) because `journal.previewPolicyUpgrade` runs before `previewConfigurationScope` would have returned `already-enabled`.
- `main.ts:552–556` renders guarded paths as `N held files pending`, indistinguishable from native holds, and the status-bar click opens Changes; the guard is only actionable in the Configuration modal. `inspect()` does list the path under `pending` (`R2-C4d` log), so Changes is not blank, but it does not say the file is held for configuration review.
- After a guarded consent publishes, a later same-host flush of a different version is held again (`R2-C4d` tail: `1 held files pending`, head keeps the consented version). This is the design working; recorded so the behavior is on file.

## What held

- **C0** (preview is read-only under the new scope; poisoned legacy records load only under the durable pause) and **C8** (`readCommitForScope` through the fake and the real adapter's `snapshot(…, "visible-only")`, `github.ts:402–430`): root closure suite 12/12 rerun here; a fresh config/1 device on an ignoring `.gitignore` repository enrolls without downloading the ignored path and defers the live config (`R2-S1`).
- **C1**: native preflight before the pause (closure suite C1/C1b).
- **C3b**: the CAS race returns `{kind:"review-needed", applied:[], changed:[".obsidian/app.json"]}`; the next sync is a content conflict in Changes and head keeps the reviewed version (`R2-C3b`). `main.ts:832–837` opens Changes with a Notice naming both counts.
- **C6**: a `history-rewritten` pause survives the review attempt, which reports `Resolve the existing pause first: …` (`R2-C6`).
- **C4 same host**: stale flush held while notes sync; plugin reload keeps the guard; `listConfiguration().guarded` carries path, exact local Ref and `unreadable`; preview returns the exact bytes or `null` for deletion; consent is exact-version bound (a different flush after consent stays held, `R2-C4f`); consent recorded before a reload publishes after it; a token from a retired session is `stale` on its replacement (`R2-C4e`); deletion needs explicit consent (`R2-C4g`); an oversize flush is guarded and `unreadable`, never treated as a deletion (`R2-C4h`).
- **Settings schema**: format-2 data without `configuration` parses as visible-only; a null `loadData()` defaults to config/1; a non-boolean is rejected (`R2-S1`). Enrolled legacy devices derive rules from state, not settings (`main.ts:227–229`).
- **Host id source**: both the normal and the migration `SyncSession` receive `hostLifetimeId(this.app)` (`main.ts:271`, `:344`), the same value given to `GitObsidianVault`.
- **Hidden-file fixture**: this harness and the root's `plugin-safety.test.ts:128` both drop dot paths from `getFiles()`; `obsidian-vault.ts:495` only consults `getFiles()` for visible paths, so the earlier fixture weakness does not mask hidden-file behavior.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test /tmp/github-v2-composed-configuration-review-r2/review.test.ts
```

Expected: 11 pass, 2 fail (R2-C4a, R2-C4b) until the guard retirement rule changes. Scratch imports point at the live root.

## Limits

No Obsidian DOM, Android device, real vault, GitHub network, power loss, or quit-time write ordering was exercised; the C4 reproduction assumes one stale write lands after apply and before the next sync. The fake repository's scope reads mirror `github.ts` by construction. Native internals and Quint are out of scope. No release, Android, or product acceptance follows from the passing cases.
