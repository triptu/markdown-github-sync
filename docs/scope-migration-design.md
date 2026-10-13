> Proposal from the design review, not an implemented capability or permission policy. Root integration decisions below supersede conflicting recommendations in this proposal.
>
> Configuration application will be explicitly reviewed, with editor-safe reload behavior verified on the real host before enabling it. New hidden files require exact-version consent; root `.gitignore` remains a sync control file even if a pattern matches it. A new local ignore rule must immediately restrict uploads in that same transaction. Unsupported nested ignore rules must be surfaced before scope activation. Scope changes must retain pending operations, unreadable paths and recovery holds without turning exclusion into deletion. These requirements are not complete yet.
>
> The user's existing authorization permits read-only inspection of the real repository and synthetic experiments. Section 10's suggested permission requirements do not override that authorization. Real-vault migration and retirement are not being performed during development.

# GitHub v2: scope, selective `.obsidian` sync and fresh-vault migration (design r1)

Design sub-agent output. No repository, code, remote or device mutations were made. Inputs: `docs/implementation-plan.md`, `plugin/src/git-sync/{codec,contracts,github,obsidian-vault,state,session,reconcile,native-modes,native-transactions,ownership}.ts`, `plugin/src/{main,settings}.ts`, `docs/github-client.md`, `docs/verification/{android-native,android-rename-primitive,quint}.md`, and a read-only name/size inventory of `~/vault` (no note or secret values were read or printed).

## 0. Summary of the recommendation

1. Replace the hard-coded "every dotted segment is excluded" predicate with a **per-commit `Scope`** derived deterministically from three inputs: built-in deny rules, built-in allow rules, and the **committed root `.gitignore` blob of that commit**. Scope is therefore identical on every device for the same commit and never depends on local state or settings.
2. Use the `ignore` npm package (kaelzhang/node-ignore) for gitignore semantics, pinned, `ignoreCase: false`, with a committed conformance fixture generated from `git check-ignore` on the dev machine against the real vault's path inventory. No hand-rolled pattern matcher.
3. **Ignored means out of scope, even if the remote tree tracks the path** (deliberate deviation from Git). Out-of-scope paths are *preserved*: never written, deleted, or published on either side. Absence is never interpreted as deletion for a path that is not in scope on both the parent commit and the local capture.
4. Hidden paths are captured by a new **`HiddenConfigPort`** (adapter listing + stat cache), applied **only** through the already Android-verified rename transaction (no `TFile`, no `vault.process`), and **live-configuration files are applied in a deferred phase** ("Apply configuration and reload") recorded in durable state as `deferred`, which the planner treats like a hold: never published, never re-downloaded, never counted as a local edit.
5. New hidden local files (notably any plugin `data.json`) are **never auto-published**; they need one exact-version consent, after which they are remote-tracked and in scope like Git-tracked files. Exclusion is expressed by editing `.gitignore` (a synced file), never by device-local rules.
6. Migration is **fresh vault + enrollment + download**, with a read-only preflight report, and a separate, explicitly confirmed **retirement publication** that removes `obsidian-git` from `community-plugins.json` and deletes its plugin directory from the repository through the normal ledger-protected publish path. The original checkout is never opened or touched.
7. State format moves to `github-vault-sync/4`; existing `/3` enrollments migrate with `scope.rules = "visible-only"` and keep working unchanged until the user turns on configuration sync.

## 1. Facts from the real vault that drive the design (names/sizes only)

| Fact | Value |
|---|---|
| Tracked files | 657 total: 578 outside `.obsidian` (464 `.md`, 108 `.png`, 3 `.pdf`, 2 `.base`, `.gitignore`), 79 under `.obsidian` |
| Largest tracked file | 4,320,889 bytes (content); largest hidden 1,976,404 bytes (`terminal/main.js`) |
| Working tree size | content ≈ 47.8 MB, `.obsidian` ≈ 6.2 MB, both under the 8 MiB/file and 128 MiB/snapshot limits |
| Root `.gitignore` patterns | `.obsidian/cache`, `.trash/`, `.DS_Store`, `.obsidian/workspace`, `.obsidian/workspace.json`, `.idea`, `.smart-connections`, `.obsidian/workspace-mobile.json`, `.obsidian/todoist-token`, `.obsidian/plugins/vikalp/data.json` |
| Nested `.gitignore` files | none; `.gitattributes` none |
| `.git/info/exclude` | one entry: `.obsidian/plugins/obsidian-git/obsidian_askpass.sh`, which is nevertheless **tracked** (tracked-but-ignored case exists in the wild) |
| Ignored present files | `.obsidian/.DS_Store`, `todoist-token`, `workspace.json`, `workspace-mobile.json` (and `vikalp/data.json` is untracked) |
| Tracked `.obsidian` layout | 18 root `*.json` (incl. `community-plugins.json`, `core-plugins.json`, `hotkeys.json`, `appearance.json`, `workspaces.json`), 8 plugin dirs (`manifest.json`, `main.js`, `styles.css`, `data.json`, plus `vikalp/rules/*.yaml`, `vikalp/notes/*.json`, `vikalp/rules/.builtin-rules.json` which has a dotted filename inside the config dir), 2 themes |
| `community-plugins.json` | lists `obsidian-git` plus two plugins whose directories are not tracked |
| Checkout status | clean, 0 untracked visible files |

Consequences: the real `.gitignore` is small and plain, but exercises directory patterns, exact-file patterns, a trailing-slash rule and a pattern that would match visible content (`.DS_Store` anywhere). The repo has a tracked-but-ignored file, a dotted filename inside an allowed hidden directory, and a competing sync plugin both as files and as an enabled id.

## 2. Scope model

### 2.1 Definitions

```ts
// plugin/src/git-sync/scope.ts
export type HiddenClass =
  | "content"        // visible path (no dotted segment)
  | "config-inert"   // hidden, in scope, safe to apply immediately (manifest.json, main.js, styles.css, themes, snippets, .gitignore, rules/*.yaml …)
  | "config-live"    // hidden, in scope, read by Obsidian/plugins into memory: <configDir>/*.json, plugins/*/data.json
  | "ignored"        // matched by the committed root .gitignore (after allow/deny)
  | "denied"         // built-in deny: never in scope regardless of gitignore or tracking
  | "outside";       // hidden but not under an allow rule (e.g. .trash, .smart-connections, .foo)

export interface ScopeRules {
  rules: "visible-only" | "config/1";   // "visible-only" = legacy /3 behaviour
  configDir: string;                     // ".obsidian" for the committed tree; must equal app.vault.configDir locally
  gitignore: string | null;              // blob oid of root .gitignore in the commit, or null
}

export interface Scope {
  readonly rules: ScopeRules;
  readonly digest: string;               // sha1 of JSON(rules + builtin rule version); stored with the checkpoint
  classify(path: string): HiddenClass;
  includes(path: string): boolean;       // content | config-inert | config-live
  isLive(path: string): boolean;         // config-live
  /** New local hidden path policy; see 2.4. */
  newHiddenPolicy(path: string): "auto" | "consent";
}

export function compileScope(rules: ScopeRules, gitignoreText: string | null): Scope;
export function scopeForTree(items: {path: string; type: string; sha: string}[], readBlob: (oid) => Promise<Uint8Array>, configDir: string, rules: ScopeRules["rules"]): Promise<Scope>;
```

Scope is a pure function of `(rules, configDir, gitignore bytes)`. It is computed **per commit**: the GitHub adapter resolves the `.gitignore` entry of the commit tree, fetches that blob (cached by oid), and compiles. Two commits with the same `.gitignore` oid share a compiled scope (cache by `digest`).

### 2.2 Built-in rules (version `config/1`)

Order of evaluation for a structurally valid path: deny → allow → gitignore → class.

**Deny (never in scope, both directions, even if remote-tracked):**
- `.git/**`, `.git-vault-sync/**`, `.git-vault-sync-export-*/**`, `.trash/**`
- `<configDir>/workspace.json`, `<configDir>/workspace-mobile.json`, `<configDir>/workspace/**`, `<configDir>/cache/**`
- `<configDir>/plugins/github-vault-sync/**` (self: `data.json` holds `secretId`, device name, settings; `main.js` is the running bundle)
- `<configDir>/plugins/{obsidian-git,obsidian-livesync,remotely-save,remotely-sync,cloud-vault-sync}/**` (competing sync plugins; the same id list as `assertSingleWriter`)
- any segment equal to `.DS_Store`, `Thumbs.db`, `desktop.ini`
- any path with a segment other than the first that begins with `.` and is **not** inside `<configDir>/` (e.g. `notes/.hidden.md` remains excluded as today)

**Allow (eligible, subject to gitignore):**
- every visible path (no dotted segment) — unchanged content scope
- `.gitignore` (root only)
- `<configDir>/**` (dotted filenames inside it are allowed, e.g. `vikalp/rules/.builtin-rules.json`)

**Gitignore:** only the root `.gitignore` blob of the commit being described. Nested `.gitignore` files, `.gitattributes`, `.git/info/exclude` and global excludes are not applied (nested files are ordinary content and preflight warns if the tree contains any).

**Class assignment for allowed, unignored hidden paths:** `<configDir>/*.json` and `<configDir>/plugins/*/data.json` → `config-live`; everything else → `config-inert`.

### 2.3 Exact tracked-file semantics (differences from Git stated explicitly)

| Situation | Git | This design |
|---|---|---|
| Untracked file matching `.gitignore` | not added | not captured, not published, not listed |
| Tracked file matching `.gitignore` | stays tracked; edits and deletions committed | **out of scope**: never modified, deleted or published by any device; remote entry preserved byte-exact by `prepare`'s exclusion check; local file left alone. Preflight/Changes lists it under "tracked but ignored" with a "remove from repository" action (a normal consented publication). |
| Pattern added that newly matches a tracked path | nothing happens until `git rm --cached` | path leaves scope at the first checkpoint whose `.gitignore` carries the rule; nothing is deleted anywhere; see 2.5 |
| Pattern removed | untracked file becomes addable | path re-enters scope; classification per 2.5 |
| Directory pattern `.trash/` | ignores directory and descendants | identical (file paths under it match; `ignore` checks parent directories) |
| Negation `!pattern`, `**`, anchoring, escapes | spec 2.22 | delegated to `ignore`, same spec |
| Case sensitivity | `core.ignorecase` (true on macOS/Windows clones) | **always case-sensitive** (`ignoreCase: false`) so every device computes the same scope; a pattern `Foo` does not exclude `foo` |
| `.gitignore` itself | tracked content | in scope (`config-inert`), synced like any file; a local edit publishes under the **parent's** scope and takes effect at the next checkpoint |

Rationale for the deviation on tracked-but-ignored: the only reason a user ignores an already-committed file is that it should not have been committed (typically a secret). Continuing to publish it would reproduce the leak; Git's behaviour is a trap here and the user's `.gitignore` comment shows the intent.

### 2.4 New local hidden files

A hidden path present locally, in scope by rules, but **absent from the remote checkpoint tree**:

- `newHiddenPolicy(path) = "auto"` for `.gitignore`, `<configDir>/*.json` except `community-plugins.json`/`core-plugins*.json`, `<configDir>/plugins/*/{manifest.json,main.js,styles.css}`, `<configDir>/themes/**`, `<configDir>/snippets/**`.
- `"consent"` for everything else, notably `<configDir>/plugins/*/data.json`, any other file inside a plugin directory, `community-plugins.json`, `core-plugins*.json`. These appear in Changes under "Unpublished configuration files" with two actions: **Publish** (records `hiddenConsent[path] = {oid, mode}`; the next plan includes the path only if the live oid still equals the consented oid) and **Exclude** (appends an exact-path line to the local `.gitignore`, which is itself a normal synced edit). There is no device-local skip list, so scope never diverges across devices.
- Once published the path is remote-tracked and in scope with no further consent. Consent is one-shot and exact-version, consistent with the engine's existing consent model.

Why `community-plugins.json` and `core-plugins*.json` are "consent" even though they are core config: on a fresh vault they are the files whose first publication could re-enable a competing sync plugin or flip core features on every device.

### 2.5 Scope stability and scope changes

- **The scope used for a plan is the scope of the remote head commit.** `base`, `local` and `remote` snapshots are all filtered by that one scope before `reconcile`. Scope digest and the resolved hidden path list are stored with the checkpoint (`StoredState.scope`).
- A scope change can only take effect at a **checkpoint transition in a settled state**: `operation === null`, no `publication-unknown`, no pending native recoveries. If the head's scope digest differs from `state.scope.digest` while an operation is open, the operation finishes under its own recorded scope first (the operation record carries `scopeDigest`). This keeps scope changes from bypassing holds or the ledger.
- **Paths leaving scope** (present in `state.base.files` or `state.carry` but excluded by the head scope): removed from the filtered `base`/`carry`/`local`/`remote` views; **no step of any kind is planned**; their `holds` entries are kept and surfaced as "held file is now excluded by .gitignore: resolve or export"; their `deferred` entries are dropped (nothing was written; the remote version remains preserved); their `hiddenConsent` entries are dropped.
- **Paths entering scope** (in scope under the head scope, absent from the stored checkpoint manifest): classified exactly like enrollment survey items with `old = null`: remote-only → `download` (inert) or `deferred` (live); local-only → `upload` if `auto`, else consent list; both present and equal → unchanged; both present and different → `add-add` conflict (existing kind, existing choices). No base is reconstructed for re-entering paths (recorded limit; see §9 option).
- Legacy `/3` states carry `scope.rules = "visible-only"` whose compiled scope is today's predicate. Switching the setting `syncConfiguration` on does not change scope by itself; the next sync treats the head's `config/1` scope as a scope change under the rules above (all tracked hidden paths "enter scope"), so a long-running desktop enrollment adopts configuration sync without re-enrolling.

### 2.6 Library choice and conformance

- Dependency: `ignore` (kaelzhang/node-ignore), pure JavaScript, no runtime dependencies, browser-safe, ships TypeScript types, implements the gitignore spec and is validated upstream against real `git check-ignore` fixtures. Pin an exact version; bundle via esbuild as today. Use `ignore({ ignoreCase: false, allowRelativePaths: false })`, feed only forward-slash relative paths (our `isValidPath` already guarantees no leading `/`, `./`, `..`).
- `.gitignore` bytes must be valid UTF-8 and ≤ 64 KiB; otherwise the commit's scope **fails closed to `visible-only` with a pause** `scope-unreadable` (new `PauseReason`), never to "ignore nothing".
- Conformance fixture: `plugin/test/fixtures/gitignore-conformance.json` generated by a dev-machine script (`scripts/gitignore-fixture.mjs`) that runs `git check-ignore --no-index -v` over a path list in a temporary repo with the given `.gitignore` text. Inputs committed to the fixture: the real vault's `.gitignore` text (contains only patterns and comments, no secrets), the 79 tracked hidden paths and 5 ignored/untracked hidden paths by name, plus a synthetic matrix (negation, `**`, anchored, trailing slash, escaped `#`/`!`, trailing spaces, case variants). The test asserts `Scope.classify` agrees with Git on every row except the documented deviations (tracked-but-ignored, case). Node-ignore's own suite is not re-run.

## 3. Types and module changes

### 3.1 `contracts.ts`

```ts
export interface CommitSnapshot {
  oid: string; treeOid: string;
  files: Snapshot;             // in-scope entries per THIS commit's scope
  scope: ScopeRules;           // digest-able description; adapter also exposes compiled Scope via scopeFor()
}
export interface Repository {
  // unchanged: identity, head, readCommit, isAncestor, ledgerRef, createSeal, publish, seal, readLedger
  scopeFor(commit: string): Promise<Scope>;
  prepare(parent, changes, message, ledger, allowance?: { retire: string[] }): Promise<PreparedPublication>;
  history(input: { path; at?; page? }): Promise<FileHistoryPage>;   // accepts any in-scope path
}
export interface LocalVault {
  capture(scope: Scope): Promise<Snapshot>;      // visible via TFile index + hidden via HiddenConfigPort
  apply(path, expected, next, options?: { hidden: boolean }): Promise<ApplyResult>;
  recover?; acknowledgeRecovery?;
}
```

`prepare` validates every change path with `parentScope.includes(path)` or `allowance.retire.includes(path)`; the retire allowance is accepted only for paths that are remote-tracked **and** classified `denied` by the competing-plugin rule or `ignored`. The existing "excluded entries unchanged" tree comparison becomes "entries outside (scope ∪ retire) unchanged".

### 3.2 `codec.ts`

- Keep `isValidPath`. Replace uses of `isExcludedPath/isSyncablePath` with `isStorablePath(path) = isValidPath(path) && !builtinDenied(path)` for state parsing (state must be able to hold hidden paths), and with `scope.includes(path)` at every runtime boundary (`verifySnapshot(snapshot, label, scope)`).
- Export `foldPath` unchanged; collision validation in `github.ts` runs over all in-scope paths (not just visible).

### 3.3 `state.ts` → `STATE_FORMAT = "github-vault-sync/4"`

```ts
export interface StoredScope {
  digest: string;
  rules: ScopeRules;                         // of the checkpoint commit
  hidden: string[];                          // sorted in-scope hidden paths at the checkpoint (diagnostics + stability checks)
}
export interface StoredState {
  …existing…,
  scope: StoredScope;
  /** Live-config versions accepted from GitHub but not yet written locally: path -> { expected: local Ref at deferral, next: remote Ref, commit } */
  deferred: Record<string, { expected: Ref | null; next: Ref | null; commit: string }>;
  /** One-shot exact-version consent to publish a new local hidden file. */
  hiddenConsent: Record<string, Ref>;
}
export type PauseReason = …existing… | "scope-unreadable" | "config-dir-mismatch";
export type RecoveryReason = …existing… | "configuration" | "retirement";
PublishOperation / ApplyOperation gain `scopeDigest: string`.
```

Migration `/3 → /4`: `scope = { digest: digest("visible-only"), rules: { rules: "visible-only", configDir: ".obsidian", gitignore: null }, hidden: [] }`, `deferred = {}`, `hiddenConsent = {}`. The parser's `path()` check becomes `isStorablePath`, so a `/4` state may contain hidden paths; a `/3` state that somehow contains one still fails as corrupt.

Invariants (parser-enforced where possible, tests otherwise):
- `deferred` keys ∩ `holds` keys = ∅; `deferred` keys ∩ `carry` keys = ∅.
- Every `deferred[p].next` and `hiddenConsent[p]` is a `Ref` whose blob is pinned in `blobs`/recovery (`referencedBlobs` extended).
- `deferred[p].expected` equals the local version captured when the deferral was recorded; `applyConfiguration` is a CAS against it.

### 3.4 `github.ts`

- `tree()` keeps full validation of every item (hidden items already validated structurally today) and now records `gitignoreOid` (root `.gitignore` blob) in the cached tree.
- `scopeFor(commit)`: tree → gitignore blob (≤ 64 KiB, UTF-8) → `compileScope`; cache by gitignore oid.
- `snapshot()` filters with `scope.includes`; symlink/submodule/LFS/mode checks apply to **in-scope** entries (today "visible"); size limits unchanged (8 MiB/file, 128 MiB/snapshot, now including hidden in-scope bytes).
- `prepare()` as in 3.1; `history()` accepts in-scope paths.
- Expected cost on the real repo shape: one more blob GET per distinct `.gitignore` oid; 79 more blob GETs on first enrollment (≈ 6.2 MB), then zero for unchanged polls.

### 3.5 `obsidian-vault.ts` and new `hidden-config.ts`

```ts
// plugin/src/git-sync/hidden-config.ts
export class HiddenConfigPort {
  constructor(adapter: DataAdapter, configDir: string, assertActive: () => void) {}
  /** Recursive adapter.list under configDir plus root .gitignore; skips denied prefixes before descending. */
  list(scope: Scope): Promise<string[]>;
  /** adapter.stat-based cache: {mtime,size} -> oid; rehash only when stat changes or on first run. */
  entry(path: string, mode: FileMode): Promise<Entry>;
  mkdirs(path: string): Promise<void>;        // adapter.mkdir, never vault.createFolder
}
```

`GitObsidianVault`:
- `capture(scope)`: visible part unchanged (TFile index); hidden part via `HiddenConfigPort` (only when `scope.rules.rules === "config/1"`). Case/Unicode collision check runs over the union. Throws a `config-dir-mismatch` condition if `app.vault.configDir !== scope.rules.configDir` (session turns it into a pause; content sync continues under `visible-only` only if root decides so, see §9).
- `apply(path, expected, next, {hidden:true})`: `safePath` uses `scope.includes`; **method is always `rename`** (the text-process method needs a `TFile`, which hidden paths do not have); `openView` is skipped (no views on hidden files); folder creation uses `mkdirs`. The rename transaction already uses adapter-only operations (`exists/readBinary/writeBinary/rename`), the hidden `hold/stage` directories, and is the primitive verified on the Android emulator for 8 MiB moves. Nothing new is needed in `native-transactions.ts` except accepting hidden intent paths (its `tracked` regex concerns only its own hold/stage names).
- Recovery scan unchanged. `NativeIssue.path` may now be hidden; `#ingest` validation uses `isStorablePath`.
- Oversize hidden files (> 8 MiB) are skipped at capture with a listed warning, not an error, so one large plugin bundle cannot stall note sync (decision for root, §9).

Local hidden changes produce **no vault events** (`vault.on` is TFile-based; `raw` is desktop-only). Detection is by capture at each scheduled sync; the stat cache keeps that to ~80 `stat` calls per cycle. `main.ts`'s `changed()` filter stays as is.

### 3.6 `session.ts`

New/changed surface:

```ts
previewMigration(): Promise<MigrationPreview | Unavailable>;      // read-only: identity, head scope, classification table (§5)
applyConfiguration(input: { token: string }): Promise<ApplyConfigurationOutcome>;   // CAS-applies every `deferred` entry via vault.apply(hidden)
listConfiguration(): Promise<{ deferred: …; unpublished: …; trackedIgnored: …; competing: … }>;
consentHidden(input: { path: string; oid: string }): Promise<DecisionOutcome>;
previewRetirement(): Promise<RetirementPreview | Unavailable>;    // files to delete + community-plugins.json edit, exact bytes previewed
retire(input: { token: string }): Promise<RetireOutcome>;          // PublishOperation with allowance.retire, reason "retirement"
```

Planning changes inside `sync()`:
1. `head = readHead()`, `scope = repository.scopeFor(head.oid)`.
2. Settled-state check for scope change (§2.5); otherwise filter with `state.scope`.
3. `local = vault.capture(scope)`; apply `hiddenConsent` filter: local-only hidden paths with `newHiddenPolicy = consent` and no matching consent are removed from `local` before `reconcile` and reported in `listConfiguration().unpublished`.
4. `reconcile` as today with `holds ∪ deferredAsHolds` (deferred paths excluded from automatic planning exactly like holds; implemented by passing them in the `holds` map with a distinct marker, or by pre-filtering all three snapshots — prefer pre-filtering plus a post-check that `outgoing`/`incoming` never names a deferred path).
5. Incoming steps for `config-live` paths are **not executed**; they are converted into `deferred[path] = { expected: localRef, next: remoteRef, commit: head.oid }` within the same durable save, and the operation completes. The checkpoint still advances to the head because the checkpoint invariant is "every path is either applied or recorded as deferred/held/carried". (Setting `configApply = "automatic"` executes them immediately instead; default manual.)
6. `applyConfiguration` runs under the owner queue, requires a settled state, CAS-applies each deferred entry (`expected` → `next`) with the hidden rename transaction, moves `changed` results into `carry` (local edit wins, reviewed next sync), `interrupted/displaced` into holds via existing `#ingest`, and clears successful entries. Then the UI issues the reload (§4).

### 3.7 `settings.ts` → `format: 3`

```ts
syncConfiguration: boolean;             // default true for new installs; migrated /2 settings get false
configApply: "manual" | "automatic";    // default "manual"
```

Settings never affect scope on the remote; `syncConfiguration=false` means the device compiles `visible-only` locally and ignores hidden paths entirely (they remain preserved on the remote).

### 3.8 `main.ts`

- Settings: "Sync vault configuration (.obsidian)" toggle, apply mode, and a **Migration** section (preflight → fresh-vault enrollment → retirement).
- Changes modal: "Configuration" group listing deferred changes with **Apply and reload**, unpublished hidden files with Publish/Exclude, tracked-but-ignored and competing-plugin files with "Remove from repository" (opens retirement preview).
- `assertSingleWriter` unchanged, still evaluated before every sync against the **local** `community-plugins.json`.

## 4. Android configuration apply and reload gating

Risks named plainly:
- Obsidian reads `<configDir>/*.json` at startup and serialises its in-memory copy back when a setting changes; plugins do the same with `data.json` via `saveData`. A byte-exact write we make can be silently overwritten later by stale in-memory state. The result is not data loss (the overwritten version stays in GitHub history) but config ping-pong between devices.
- Obsidian mobile has no file watcher for the config directory; nothing we write takes effect until reload.
- Writing `community-plugins.json` can enable plugins at next startup; writing `main.js` of a running plugin is inert until reload.
- Our own plugin must never write its own directory (denied).

Gating:
1. `config-inert` paths apply immediately (rename transaction). They are harmless until reload.
2. `config-live` paths are deferred (§3.6). The "Apply and reload" action: run `applyConfiguration()`; on success call the public command `app:reload` ("Reload app without saving"), which exists on mobile and desktop and specifically avoids serialising workspace/config state over our writes. Verify the command id on the emulator in the acceptance run; fall back to a notice "Restart Obsidian to apply" if absent. Warn in the dialog that unsaved editor text in the last ~2 seconds may be lost (Obsidian autosaves notes; the command skips workspace save).
3. If a local `config-live` file changed between deferral and apply (user changed a setting on the phone), the CAS reports `changed`; the path moves to `carry` and the next sync shows a normal content conflict with both versions. No silent overwrite in either direction.
4. Restore of a `config-live` path through history goes through the same deferral, never a direct write.
5. Capture never blocks on config: a pending deferred set does not stop note sync, because deferred paths are excluded from planning rather than holding the operation open.

Auth/config reload: credentials remain in `SecretStorage` keyed by `secretId` in our own `data.json` (denied path), so a reload or configuration apply can never change which token is used; the repository binding check in `saveConfiguration` is unchanged.

## 5. Fresh-vault migration (Android-first) retaining the original

Preconditions enforced: plugin refuses `.git` in the vault root (unchanged) and refuses to sync when a competing sync plugin is enabled locally (unchanged). The original checkout is never selected as the vault; the plugin cannot reach it.

Flow:
1. **Create a fresh empty vault** in Obsidian (user action; the plugin cannot create vaults). Install the plugin into it (manual copy or BRAT); enter owner/repo/branch/token.
2. **Validate** (read-only): `identity()` (private repository required), `repo.permissions.push === true` from the repository JSON, head readable, ledger ref read works, token has no `\r\n`. Report the remaining rate-limit budget.
3. **Preflight report** (`previewMigration`, read-only): counts and the per-path classification table for the head: content files; hidden in scope (inert/live); ignored; denied (competing sync dirs, workspace files, self); tracked-but-ignored; oversize or unsupported entries (symlink/submodule/LFS); nested `.gitignore` present; `configDir` mismatch; `community-plugins.json` contains denied ids. Totals versus limits. The report is the gate: enrollment is offered only if no blocking row exists (truncated tree, oversize visible file, symlink in scope, config-dir mismatch when configuration sync is on).
4. **Enroll** the empty vault (existing enrollment preview: everything is `download`). Content applies through native transactions as today; hidden inert files apply through the rename transaction; hidden live files land in `deferred`. The first `Apply and reload` then brings over `app.json`, hotkeys, appearance, plugin `data.json`. Because `community-plugins.json` is `config-live` and lists `obsidian-git`, its deferred apply is **refused** (blocked with reason) until retirement; all other config applies. The user enables plugins in the fresh vault from the downloaded `main.js` files after reload (one-time manual step; the preflight lists the ids to enable).
5. **Retire competing sync** (explicit confirmation, recommended after the first successful two-way sync from the new vault): one `PublishOperation` with `allowance.retire` whose changes are: `community-plugins.json` = remote version minus denied ids (bytes previewed), delete `<configDir>/plugins/obsidian-git/**` (5 tracked files including the tracked-but-ignored `obsidian_askpass.sh`). It goes through `prepare → receipt → publish → ledger settle` like every publication; preimages are recorded in recovery with reason `retirement`. After it lands, the deferred `community-plugins.json` re-plans against the new head and can apply.
6. **Original checkout**: untouched by the plugin. If the user later pulls there, obsidian-git's files disappear and it stops running after reload; that is the intended end state and the checkout remains a full rollback copy of history. Document this in the wizard.
7. **Second device** (desktop): fresh vault, same flow; or an existing `/3` enrollment turning configuration sync on (§2.5).

## 6. Acceptance gates (observable, implementation-independent)

Unit/integration (plugin test suite, fakes already exist in `git-fakes.ts`):
1. Gitignore conformance fixture (§2.6) passes row-for-row; deviations listed in the fixture are asserted as deviations.
2. Determinism: two `Scope` instances from the same `(rules, gitignore bytes)` classify a 10k-path random corpus identically; `digest` stable across process restarts.
3. Deny rules dominate: with an empty `.gitignore`, `workspace.json`, `.git-vault-sync/**`, self plugin dir, competing plugin dirs, `.DS_Store` never appear in `capture`, `readCommit().files`, `outgoing`, `incoming`, or any `StoredState` manifest, even when the fake remote tree tracks them.
4. Leaving scope never deletes: property test over random base/local/remote and a `.gitignore` that newly matches k paths → zero steps and zero outgoing entries for those k paths; remote tree entries preserved byte-exact by `prepare`.
5. Entering scope classification equals the enrollment survey classification with `old = null`; add-add conflict offered when both sides differ.
6. New hidden `data.json` is never in `outgoing` without `hiddenConsent` for its exact oid; a changed oid after consent returns to the unpublished list.
7. Deferred semantics: `config-live` incoming never writes; `deferred ∩ (holds ∪ carry) = ∅`; `applyConfiguration` CAS: `changed` → carry, `interrupted` → hold with pinned bytes, success clears; a crash injected between vault write and state save leaves bytes recoverable (fault-injection harness as for other operations).
8. Scope change while an operation is open or publication is unknown is not applied; the operation's `scopeDigest` governs; holds on leaving paths persist.
9. `prepare` rejects a change outside scope unless listed in `allowance.retire` and remote-tracked and denied/ignored; the retirement path removes exactly the previewed entries and nothing else.
10. `/3 → /4` migration: every existing session test passes with `rules = "visible-only"`; a migrated state enabling configuration sync adopts hidden paths without re-enrollment.
11. Quint (`formal/quint`): add a scope partition to `vaultSync.qnt` with obligations `NoOutOfScopeStep`, `LeavingScopeNoDeletion`, `DeferredNeverPublishedNorOverwritten`; negative controls `NegAbsentAsDeletion` (treats out-of-scope absence as deletion) and `NegDeferredPublish` must fail. Recorded in `docs/verification/quint.md` with bounds.

Live synthetic repository (new branch in the existing lab repo, never the real repo):
12. Fixture repo mirroring the real vault's **shape**: same `.gitignore` text, same 79 hidden tracked paths and 578 content paths with synthetic bytes. Fresh-vault enrollment downloads the expected in-scope set exactly (hidden list equals the fixture's expected list); independent read-back of hashes.
13. Retirement publication removes the 5 plugin files and the id; a second client converges; the stale candidate after a forced rewind on the lab branch is rejected (existing harness).
14. `.gitignore` edit race: device A ignores a path while device B edits it; neither device deletes; B's edit is preserved locally and on remote the preserved version is unchanged; un-ignoring produces an add-add decision.

Android emulator (packaged artifact, synthetic vault):
15. Fresh-vault migration end to end: preflight report renders; enrollment of the mirror fixture completes; `Apply and reload` executes `app:reload`; a changed `appearance.json` is visibly in effect after reload (screenshot); hidden files hashed on disk equal the fixture.
16. Local config edit on the phone (toggle a core setting) is captured on the next cycle and published; a desktop change to the same file while deferred yields `changed` → conflict, no overwrite.
17. One measured cycle with the 6.2 MB hidden set: stat-cache capture time recorded as a single observation, not a benchmark.
18. Competing-plugin refusal still fires if `obsidian-git` is enabled locally.

Separately recorded, not claimed by the above: physical phone, power loss, Obsidian versions other than the tested one.

## 7. Minimal complete implementation plan (ordered units)

| # | Unit | Files | Tests |
|---|---|---|---|
| 1 | `scope.ts` + `ignore` dependency + conformance fixture + generator script | `plugin/src/git-sync/scope.ts`, `scripts/gitignore-fixture.mjs`, `plugin/test/scope.test.ts`, `plugin/test/fixtures/gitignore-conformance.json` | gates 1–3 |
| 2 | Contracts/codec/state `/4` plumbing and migration | `contracts.ts`, `codec.ts`, `state.ts`, existing state tests | gate 10 |
| 3 | GitHub adapter per-commit scope, retire allowance, in-scope history | `github.ts`, `github-client.test.ts`, live harness branch | gates 9, 12–14 |
| 4 | Hidden config port + rename-only hidden apply | `hidden-config.ts`, `obsidian-vault.ts`, `native-vault.test.ts` | gate 7 (vault part) |
| 5 | Session: scope transitions, consent, deferred, applyConfiguration, retirement, migration preview | `session.ts`, `reconcile.ts` (post-check only), `git-session.test.ts` | gates 4–8 |
| 6 | Settings `format 3`, UI (migration wizard, configuration group, apply-and-reload) | `settings.ts`, `main.ts`, `plugin-safety.test.ts` | gate 18 |
| 7 | Quint scope/deferred obligations and docs | `formal/quint/*.qnt`, `docs/verification/quint.md`, `docs/engine-api.md`, `docs/github-client.md` | gate 11 |
| 8 | Live synthetic and Android acceptance, evidence files | `docs/verification/*` | gates 12–18 |

Units 1–2 unblock 3–5, which can proceed in parallel worktrees; 6 depends on 5; 7 can start after 2.

## 8. Supported limits to state in the release notes

- Only the root `.gitignore` is honoured; nested `.gitignore`, `.gitattributes`, `.git/info/exclude` and global excludes are not. Patterns are case-sensitive on every platform.
- Tracked files that match `.gitignore` are not synced (deviation from Git); they can be removed from the repository through a consented publication.
- A path that leaves and re-enters scope has no remembered base; concurrent edits on both sides become an add-add decision.
- Workspace layout, cache, trash, this plugin's own files and other sync plugins' files are never synced.
- Configuration changes that Obsidian or plugins hold in memory are applied only via "Apply and reload"; automatic mode is opt-in and may cause config ping-pong (never byte loss).
- Local configuration edits are detected on the next scheduled sync, not by file events.
- Hidden files over 8 MiB are skipped and listed, not synced.
- Plugin enablement on a fresh device is a manual one-time step; the plugin never calls Obsidian's internal plugin loader.
- The vault's configuration directory must be `.obsidian` on every device for configuration sync; otherwise configuration sync is disabled on that device.
- Emulator evidence is not physical-phone evidence; nothing here proves power-loss behaviour.

## 9. Decisions root should make (no user permission needed)

1. **Default for `configApply`**: recommend `manual` (Android-first; no config watcher on mobile). Alternative `automatic` with documented ping-pong risk.
2. **Behaviour on `configDir` mismatch**: pause the device (`config-dir-mismatch`) versus silently fall back to `visible-only` with a persistent notice. Recommend pause: silent partial sync hides the problem.
3. **Oversize hidden file (> 8 MiB)**: skip-and-list (recommended) versus pause.
4. **Deferred paths implementation**: pass as pseudo-holds into `reconcile` versus pre-filter plus post-check. Recommend pre-filter plus post-check to keep `reconcile`'s hold semantics untouched.
5. **Re-entry base memory**: whether to keep a `parked: Record<path, Ref|null>` for paths leaving scope so re-entry can three-way merge. Recommend deferring to a later release; record as limit.
6. **Retirement timing in the wizard**: offer immediately after first successful sync (recommended) versus only from the Changes modal.
7. **Scope of the live lab**: reuse `vault-sync-test` with a mirror fixture branch (recommended) versus a new lab repository.
8. **`newHiddenPolicy` auto list**: whether `hotkeys.json`/`appearance.json`-class files are `auto` (recommended) or all core json require consent on first publication.
9. Whether `/3` migrated states default `syncConfiguration=false` (recommended, since turning it on changes what the device writes) or `true`.

## 10. Items that do need the user's permission (not for root to decide)

- Any API call against `your-name/notes` (even read-only preflight) and, later, the real retirement publication.
- Installing the plugin into, or enrolling, a fresh vault created from the real repository on the user's devices.
- Adding the `ignore` runtime dependency is a normal engineering choice, but the user asked for a self-contained plugin; it is bundled and dependency-free, so no permission is needed, but call it out in the release notes.
