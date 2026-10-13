# Independent composition review R1 — reviewed configuration enrollment and file previews

**Changes requested. No Android, product, or full-replacement approval.** The new factory/UI commit `21a3d18` (main.ts) composes the R3 engine fixes (`46aa75e`) and the native configuration scope (`b65db17`). Four reproducible composition defects strand or corrupt the device on the migration path that this commit exists to deliver. Two further honesty/design gaps and several low observations follow. The R3 engine closures (R3-2, R3-3, R3-5) that this review could exercise through the real plugin class hold; R3-1 and R3-4 were not re-exercised here (engine-internal, covered by the adapted rerun at `/tmp/scope-engine-r3`).

Reviewed root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`, starting at `21a3d18`. During the review HEAD advanced to `01f7b9e`; the only `plugin/src` changes since `21a3d18` are in `native-transactions.ts` and `obsidian-vault.ts` (the native N1/N2/B1 closure, `4da2def`). `main.ts`, `session.ts`, `state.ts` and `github.ts` are byte-identical to `21a3d18`, and every finding below is located in those files. Final reruns were made against `01f7b9e`.

Root was read-only. No real vault, device, remote, source file writes, or subagents. All artifacts are under `/tmp/github-v2-composed-configuration-review-r1/`. The native internals were under separate active review (`/tmp/github-v2-native-scope-review-r1.md`, N1/N2/B1); none of those is duplicated here.

## Method

`harness.ts` bundles the **real plugin class** (`plugin/src/main.ts`) with esbuild against the repository's own Obsidian fixture (`test/fixtures/obsidian-plugin.ts`). Everything except `GitHubRepository` is production code: `SyncSession`, `parseState`, `GitObsidianVault`, `NativeTransactionJournal`, `NativePathPolicy`, `NativeModeStore`, `FileJournalStore` (engine, modes and native journals), `PluginOwnership`. `GitHubRepository` is replaced by the repository's `MemoryRepository` fake, wrapped so each constructed instance has the immutable `scopeRules` the production adapter has (`repo.scopeRules` is switched per call). Its snapshot filter (`view()` applies `scope.includes`) matches production `github.ts:404` (`items.filter(i => scope.includes(i.path))`).

Host files are simulated. Unlike the root's `plugin-safety` harness, hidden files are excluded from `getFiles()` (as Obsidian does), implicit folders exist for `exists`/`stat`/`list`, and hooks allow a journal write fault and a post-read mutation. Tests drive the plugin exactly as the UI does: `previewConfigurationUpgrade()` → `confirm()` (settings "Review configuration sync" → ConfirmModal) → `session.enroll({token})` (EnrollmentModal) → `syncOnce()`; `listConfiguration`/`previewHiddenPublication`/`consentHiddenPublication` and `previewApplyConfiguration`/`applyConfiguration` as `ConfigurationModal` calls them; `statusText` as `describeOutcome` renders it. UI widgets themselves (`Setting`, `Modal` DOM) are fixture stubs, so DOM behavior is not verified; the calls and ordering are read from `main.ts`.

`final-results.log`: **8 pass / 4 fail** out of 12. The four failures are acceptance assertions for findings C0, C0b, C1, C8; they are expected to fail until fixed. Root's own suite, run independently from the working tree: **405/405 pass** (`root-suite.log`).

## Findings

### C0 — High (liveness, durable state corruption): the config/1 re-enrollment preview corrupts engine state for any vault with a hidden local file

Locations: `plugin/src/git-sync/session.ts:1903–1907` (`#survey` captures with `persist=true` under the *new* rules while `prior` is still a visible-only state), `:2093–2098` (`#capture` pins drafts via `#record` and saves), `plugin/src/git-sync/state.ts:847–856` (parser rejects any stored path outside the state's *own* built-in scope); reached from `plugin/src/main.ts:340–343` (`confirm()` → `enableConfigurationScope` → `initializeOwned()` → `rawSession.previewEnrollment()`), and on reload from `main.ts:215` (`parseState` throws → `initialize()` rejects → no session).

Repro: `review.test.ts`, `C0 ACCEPTANCE …` and `C0b detail …`.

1. Legacy (visible-only) enrollment of a vault containing `a.md` plus `.obsidian/app.json` (and in C0 `.obsidian/plugins/foo/data.json`). Every real vault has such files.
2. Settings → "Review configuration sync" → Confirm. `enableConfigurationScope` persists the `scope-enrollment` pause, startup upgrades the native journal, and `confirm()` calls `previewEnrollment()`.
3. `#survey(prior)` derives `rules = config/1` and runs `#capture(prior, "local capture", true, scope)`. The scan now includes hidden files; they are not in the visible-only base, so they are pinned as drafts into a recovery record **of the prior visible-only state** and saved.
4. The very next `#load()` fails: `state: state contains a path outside built-in scope`.

Observed: `confirm()` returns `{kind:"preview"}`, but `enroll()`, `previewEnrollment()`, `sync()` and `status()` all return `corrupt`; `previewConfigurationUpgrade()` throws `Configuration review unavailable: corrupt`. After reload, `initializeOwned` throws `CorruptStateError` at `parseState` and the plugin has **no session at all** (status bar shows the parser message). The durable `scope-enrollment` pause and the upgraded native journal remain. There is no API or UI route to revert the pause or repair the state. Notes, hidden files and all journals are intact; this is a total loss of sync for the device, not data loss.

Why root tests pass: the two new `plugin-safety` migration tests and the engine's own migration test enroll vaults with **no hidden local files**, so the capture pins nothing.

Fix direction: during migration survey, do not persist drafts into a state whose scope cannot hold them (capture with `persist=false` when `rules !== prior.scope.rules`; `enroll` already records `survey.drafts` into the new config/1 state). Alternatively make the parser's built-in check consider the pending enrollment rules. Add a migration test with hidden local files present, and a reload after preview. Consider a parser-level repair path for this exact corruption for devices already affected.

### C8 — High (liveness, multi-device): a visible-only device cannot migrate when the repository's root `.gitignore` ignores any file in its checkpoint; new devices can only enroll visible-only

Locations: `plugin/src/main.ts:216–218` (rules derived only from stored state; a fresh/unenrolled device is always `visible-only`), `plugin/src/git-sync/github.ts:402–404` (config/1 `readCommit` drops `scope.includes`-false paths, including gitignored visible files), `plugin/src/git-sync/session.ts:1909–1916` (re-enrollment verifies the visible-only checkpoint against the config/1 adapter's filtered snapshot and throws `IntegrityError`).

Repro: `review.test.ts`, `C8 ACCEPTANCE …`.

1. Repository already used by a config/1 device: `.gitignore = "drafts/\n"`, `.obsidian/app.json`, `a.md`, `drafts/x.md`.
2. A new device enrolls. `main.ts` constructs a visible-only repository because state is null; the enrollment preview is `download:drafts/x.md` (visible-only ignores `.gitignore`), and sync writes it locally. The base now contains `drafts/x.md`.
3. Settings → "Review configuration sync" → Confirm. `enableConfigurationScope` succeeds, the native journal upgrades, then `previewEnrollment()` reads the checkpoint through the config/1 adapter, which omits `drafts/x.md`; `sameManifest` fails.

Observed: `IntegrityError: Re-enrollment checkpoint differs from its immutable commit` from `confirm()` and from every later "Preview enrollment". State is durably paused `scope-enrollment` (`recovery:1`), the native journal is already config/1, and sync returns `paused` forever. No revert route. This also means the factory never offers fresh config/1 enrollment (the handshake's "Fresh config/1 enrollment is selected before `previewEnrollment()`" is not implemented), so every second device on an Android-first fleet enters through this path.

Fix direction: for the checkpoint verification during migration, read the prior checkpoint with the prior rules (visible-only), or have the config/1 adapter expose the full tree for `readCommit` and let the engine filter (the port already claims the engine filters down). Offer fresh config/1 enrollment for an unenrolled device on a config-capable repository. Add a test with an ignoring `.gitignore` present in the checkpoint.

### C1 — Medium (liveness): a failed native policy upgrade at startup leaves the plugin without a session and without a revert

Locations: `plugin/src/main.ts:170–181` (`initializeOwned` nulls `session`, `rawSession`, journals before any work), `:234–246` (upgrade in the startup path; any throw propagates), `:156` (`initialize().catch(setStatus)`), `:655` ("Save repository and token settings first." when `session` is null), `:324` ("Save settings and enroll this device first.").

Repro: `review.test.ts`, `C1 ACCEPTANCE …`; control `C1b`.

1. Legacy enrollment with `.obsidian/plugins/foo/.gitignore` present (a plugin folder cloned from git; legacy sync tolerates it, `sync` returns `up-to-date`).
2. "Review configuration sync" → Confirm. `enableConfigurationScope` persists the pause **before** any local inventory check. `initializeOwned` → `upgradePolicy` → `assertLocalNamespace` throws `Nested .gitignore is unsupported: .obsidian/plugins/foo/.gitignore`.

Observed: `confirm()` rejects; `plugin.session === null`. Reload: `initialize()` rejects identically; `session` stays null; status bar shows the nested-gitignore message. "Preview enrollment" reports "Save repository and token settings first." and "Review configuration sync" reports "Save settings and enroll this device first." — both misleading. The only recovery is for the user to delete the offending file and reload (C1b confirms that works). The same strand occurs for any `upgradePolicy` or `inventoryLocal` throw (`Local path inventory exceeds 100,000 entries`, invalid path characters, case/Unicode collisions among protected names, untracked stage/hold files).

Fix direction: run the native inventory/namespace preflight in `previewConfigurationUpgrade()` **before** `enableConfigurationScope` persists the pause (the native port says a preview does not substitute for the commit-point check, but it can refuse early). On startup failure of the upgrade, still construct the legacy session paused with an actionable status, or provide a reviewed "cancel configuration enrollment" that clears the `scope-enrollment` pause while the native journal is still legacy. Correct the two misleading button messages when a durable pause exists but initialization failed.

### C3b — Medium (outcome honesty): a configuration CAS race is reported as "0 configuration updates saved. Restart Obsidian to load them."

Locations: `plugin/src/main.ts:764–766`; engine `session.ts:1616–1659` returns `{kind:"applied", paths:[]}` when every step is `changed`.

Repro: `review.test.ts`, `C3 …` part (b): a writer lands after the engine's final capture and before the native CAS read (`reads === 2` hook). Engine result `{"kind":"applied","paths":[]}`; local file keeps the racing bytes; next sync yields `1 decisions needed` with a content conflict for `.obsidian/app.json`; GitHub keeps the incoming version (R3-3 composition **holds**). The Notice, however, says zero updates were saved and tells the user to restart Obsidian, and the modal re-renders with "No configuration updates waiting" (the path moved to carry). The user is not told to open Changes.

Fix direction: when `paths.length < preview.items.length`, say which paths were not applied because they changed and point to Changes; or have the engine return the changed paths alongside `applied`.

### C4 — Medium (design/honesty, composition): an active writer silently reverts an applied configuration update on GitHub

Locations: `plugin/src/main.ts:758` (text warning only); `session.ts:945–951` (consent applies only to new hidden additions; modifications of tracked hidden files publish automatically).

Repro: `review.test.ts`, `C4 …`. After `applyConfiguration` returns `applied` for `.obsidian/app.json`, Obsidian or a plugin flushes its stale in-memory settings (old bytes). The next sync publishes them: status `Content synced · 418281c`, head `app.json` is the **old** version. The other device's reviewed change is reverted without any review on either side, and the two devices can ping-pong. This is the "active plugin/config writer race" the composition cannot prevent without a reload; the UI text acknowledges it but the outcome is silent. Not data loss (history retains both), but the "reviewed apply" guarantee is one write deep.

Fix direction: at minimum report the revert (an applied path changing locally within the same session before any remote change could be flagged as "applied configuration overwritten locally"). Longer term the apply flow needs host-side ordering (disable plugin / reload) that the engine explicitly does not own.

### C6 — Low: enabling configuration scope overwrites an unrelated durable pause

`session.ts:341–355` checks operation/review/holds/nativeErrors but not `state.pause`. Repro `C6`: from a `history-rewritten` pause (no operation) the migration succeeds and the pause becomes `scope-enrollment`; the rewrite detail is gone. Re-enrollment from any pause is the designed recovery, so this is a detail-loss and audit gap rather than a safety fault. Also applies to `duplicate-installation`.

### Low observations (code reading, no repro)

- `main.ts:969`: Changes modal still says "Content sync excludes .obsidian settings, plugins, hidden files …" after config/1 is active, and shows no pointer to the Configuration modal for deferred updates.
- `main.ts:39–47`: `entryPreview` truncates at 16,000 characters; the publication-consent modal says "Check for secrets before publishing" but cannot show the rest of a large `data.json`. Consent remains exact-version bound; the review surface is incomplete.
- `main.ts:124–128`: vault events under dot paths never schedule a sync, so a plugin's `data.json` write is only picked up by the periodic check or a visible edit.
- `main.ts:759`: the apply button is disabled when **any** deferred item is blocked; one blocked `community-plugins.json` holds every other reviewed update (engine returns `blocked` for the batch too).
- N2 (native) composition: `main.ts:238–244`'s callback re-reads the durable pause each call and runs inside the single owner queue; there is no user-reachable revocation route in `main.ts`, so N2 remains a native contract gap rather than a UI-reachable race. Not re-tested after `4da2def`.

## What held

- **Startup policy binding** (`main.ts:216–246`): rules derive from durable state (`scope-enrollment` pause → config/1); `NativePolicyMismatchError` triggers legacy open + `upgradePolicy` only under the durable pause; reopen with the config policy. `C2` (before-write and after-write faults on the native record during upgrade): `confirm()` fails, reload resumes paused `scope-enrollment` with the config repository, the upgrade completes idempotently, and re-enrollment proceeds. No normal sync ran under a mismatched adapter: `sync()` returns `paused` on the `scope-enrollment` pause before any fence or native call.
- **Temporary migration session**: same instance for `previewConfigurationScope`/`enableConfigurationScope` (nonce holds); `confirm` checks `rawSession` identity; root's own test shows a retired instance cannot confirm. `C7`: an automatic sync between preview and confirm makes the enable token `stale` and nothing is persisted.
- **Exact bytes / consent**: hidden additions are not published without consent; `listConfiguration.unpublished` lists them; `previewHiddenPublication.entry` carries the exact bytes; consent publishes exactly that version and leaves unconsented siblings unpublished (exercised in `C3`/`C4` via the `consent` helper; `C0` would exercise it on a migrated vault once C0 is fixed).
- **Deferred apply**: live config is never written by `sync`; `previewApplyConfiguration` items carry `expectedEntry`/`incomingEntry` bytes; a writer between preview and apply yields `stale` (`C3a`); `applyConfiguration` applies the exact reviewed version (`C4` first half); R3-2 fences are in the call path (`session.ts:427–449`).
- **Honest outcome attention** (`main.ts:534–544`): `Checked GitHub · 1 configuration updates pending`, `… · 1 unreadable files · 1 configuration updates pending`, `Changes published · …` (`C5`). `Content synced` only when nothing is outstanding. R3-5 closure holds at the UI.

## Reproduction

From the root `plugin` directory:

```sh
node_modules/.bin/tsx --test /tmp/github-v2-composed-configuration-review-r1/review.test.ts
```

Expected: 8 pass, 4 fail (C0, C0b, C1, C8) until fixed. Scratch imports point at the live root, so source changes alter results. `final-results.log` holds the last run (HEAD `01f7b9e`), `root-suite.log` the independent root suite (405/405), `reviewed-sha256.txt` the hashes of the reviewed files.

## Limits

No Obsidian DOM, Android device, real vault, GitHub network, power loss, or unsaved-editor behavior was exercised. The fake repository's scope filtering mirrors `github.ts:404` by construction, not by running the REST adapter. Native internals (N1/N2/B1 and their fixes in `4da2def`) were not re-reviewed. Quint extension `2038001` is out of scope. No release or Android acceptance claim follows from the passing cases.
