# Scope foundation/client independent safety review R2

**Verdict: changes requested. The original F1 and F3 repros are closed; the original F2 read/new-file repros are closed, but candidate-scope transitions still violate the pre-POST collision gate. A further nested-ignore alias privacy defect and a directory-rename regression are reproduced below. This is not whole-product approval.**

Requested/reviewed HEAD: `1854236fdfd05b7996d9f2a32edf72b3d8c891d9`, including privacy commit `dafc016`. Root: `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`. Read the full `docs/verification/scope-foundation-review-r1.md` and `/tmp/github-v2-scope-privacy-port.md`. During review the shared checkout advanced to `158479129857c35b87140fea16b3e69755400fbf`; the three production modules and their three official test files have an empty diff from requested HEAD. Line numbers below apply to those unchanged modules.

No repository edits, remote requests, device access, real-vault access, or subagents. All new fixtures, test sources and logs are in `/tmp/github-v2-scope-r2/`, plus this requested report. Every client POST below is a call to the in-memory fixture transport, never GitHub. Actual filesystem and Git-oracle tests use disposable synthetic directories under that scratch path.

## R2-F1 — HIGH / P1: nested `.GITIGNORE` bypasses the unsupported-nested-policy gate and permits ignored bytes to upload

**Locations:** `plugin/src/git-sync/scope.ts:73–81` (exact-spelling nested-ignore detection), consumers `hidden-config.ts:54–55` and `github.ts:371`, `:463`.

The new built-in deny canonicalization does not cover the policy-control filename. `isNestedGitignore` still recognizes only a literal `/.gitignore` suffix.

On this host's case-insensitive filesystem, create:

```text
.obsidian/plugins/custom/.GITIGNORE     data.json\n
.obsidian/plugins/custom/data.json      SYNTHETIC_NESTED_PRIVATE
```

The probe verifies that `.GITIGNORE` and `.gitignore` stat to the **same inode**. An isolated real `git check-ignore --no-index --verbose` with case-sensitive pattern matching, Unicode precomposition disabled, and system/global excludes disabled returns status 0 and:

```text
.obsidian/plugins/custom/.gitignore:1:data.json    .obsidian/plugins/custom/data.json
```

Using real directory enumeration/stat/read operations behind the adapter, production `HiddenConfigPort.scan` accepts the inventory and reads the ignored file. A production client using a verified synthetic tree with those same paths also accepts `head()`. Updating the already-tracked `data.json` then succeeds through `prepare` and sends the exact `SYNTHETIC_NESTED_NEW` base64 bytes in a `/git/blobs` POST. The test records:

```json
{"sameInode":true,"scanRejected":false,"protectedRead":true,"readRejected":false,"prepareRejected":false,"secretPosted":true}
```

This does not ask to implement nested-ignore support: nested policy is explicitly unsupported and must block activation/capture/upload. An alias of that unsupported control file is currently silently accepted. The reproduction is independent of consent for new hidden files because the data path is already tracked. It does not claim that pending engine/native wiring uploads a real vault.

**Fix direction:** recognize filesystem-canonical aliases when rejecting unsupported nested control files, without making user pattern matching case-insensitive. Audit root control-file aliases under the same filename-identity rule as a related boundary; this report's executed finding is the nested case, not an asserted root-alias integration failure.

**Reproduce:**

```sh
TMPDIR=/tmp/github-v2-scope-r2 plugin/node_modules/.bin/tsx --test --test-name-pattern='NEW nested' /tmp/github-v2-scope-r2/review.test.ts
```

The safety assertion fails after logging all three independently observed behaviors. This finding is present in current source; it is not claimed to have been introduced by the privacy patch.

## R2-F2 — MEDIUM / P2: stale parent directories reject valid case/Unicode directory renames

**Location:** `plugin/src/git-sync/github.ts:471`.

`prepare` merges every parent tree directory into the proposed namespace even when all terminals beneath that directory are deleted. The collision validator therefore compares a new directory spelling against an old spelling that will not exist in the candidate.

Minimal accepted parent:

```text
Folder/note.md    UNCHANGED
```

Requested changes:

```text
Folder/note.md    delete
folder/note.md    UNCHANGED
```

There is no excluded file or surviving old path. The expected candidate has exactly one terminal and one directory spelling. Current `prepare` raises `GitHubError: Case or Unicode path collision` at line 471 before a POST. Independent acceptance tests also fail for `café/note.md` → `café/note.md` (NFC → NFD directory) and `.obsidian/snippets/Custom/theme.css` → `.obsidian/snippets/custom/theme.css`.

Controls for a case-only **file** rename and an ordinary directory rename both pass. To establish regression attribution, the same five rename acceptance cases were rerun against the unmodified pre-privacy `github.ts` obtained with `git show dafc016^:plugin/src/git-sync/github.ts`, copied only into scratch with imports redirected to the live scope/contracts. **All five pass with that prior client implementation; only two pass with the current one.** This isolates the changed client validation; it is not a claim of running the complete old product.

**Fix direction:** validate directories actually retained in the proposed tree, plus ancestors of final terminals and any genuinely preserved empty trees. Do not carry removed parent directory spellings into the final collision namespace. Preserve excluded entries and legitimate collision rejection.

**Reproduce:**

```sh
TMPDIR=/tmp/github-v2-scope-r2 plugin/node_modules/.bin/tsx --test --test-name-pattern='legitimate rename' /tmp/github-v2-scope-r2/review.test.ts
TMPDIR=/tmp/github-v2-scope-r2 plugin/node_modules/.bin/tsx --test --test-name-pattern='legitimate rename' /tmp/github-v2-scope-r2/before-privacy.test.ts
```

## R2-F3 — MEDIUM / P2: newly unignored aliases reach POST before collision rejection

**Locations:** `plugin/src/git-sync/github.ts:460–462`, `:471`, `:483–491`, `:504`.

The candidate scope is compiled but used only to check explicitly changed paths. The included paths passed into the pre-upload validator come from the **parent** included snapshot plus explicit edits (`Object.keys(files)`). Entries made newly eligible solely by a `.gitignore` change are missing from that set.

Parent tree:

```text
.gitignore                                  excludes both paths below
.obsidian/plugins/custom/Data.json          PRIVATE_A
.obsidian/plugins/custom/data.json          PRIVATE_B
note.md                                     safe
```

The parent is correctly accepted as an excluded-only alias namespace. Replacing `.gitignore` with an empty file should make the proposed alias collision fail before any POST. Instead the production client sends:

1. `/git/blobs` POST for the empty `.gitignore`;
2. `/git/trees` POST creating the proposed tree;
3. only then rejects during the candidate snapshot collision check.

The acceptance assertion requires zero POSTs and sees two. **No private file content is uploaded in this reproduction, and no candidate commit, receipt, or branch publication is produced.** This is a remaining pre-POST validation gap, not a demonstrated secret leak. It means the privacy-port note's general pre-POST guarantee is broader than the implementation.

**Fix direction:** derive validation relevance from the proposed full namespace and candidate scope, in addition to any required parent/changed relevance. Validate newly eligible paths and their ancestors before uploading objects.

**Reproduce:**

```sh
TMPDIR=/tmp/github-v2-scope-r2 plugin/node_modules/.bin/tsx --test --test-name-pattern='newly unignored' /tmp/github-v2-scope-r2/review.test.ts
```

## Independent closure evidence and passing controls

- **Original F1 closed:** real isolated Git confirms both noninitial-BOM negation and embedded-NUL patterns ignore the target. Current `compileScope`, `scopeForTree`, and transaction freeze reject with `ScopeError`. Repeated `scopeFor`, `readRootGitignore`, and `head` calls reject without fetching the hidden blob. Same-transaction ignore update plus a changed already-tracked hidden secret rejects with **zero POSTs**. Cache reuse does not bypass rejection.
- **Accepted exact bytes retained:** a leading UTF-8 BOM and CRLF ignore pattern agrees with Git, retains the exact policy OID and returned bytes, works in executable root-ignore mode, and never fetches the excluded blob.
- **Original F2 closed for read and explicit addition:** fourteen independent cases cover seven alias shapes through both remote read and prepare: terminal case, ancestor case, NFC/NFD, NFKC compatibility, expanding case fold (`straße`/`STRASSE`), excluded-file/included-directory, and excluded-directory/included-file. Reads reject before included or excluded payload GETs; prepares reject before every POST. The candidate-scope transition gap is separately documented above.
- **Original F3 closed:** 41 aliases spanning self plugin, every competing-plugin ID, workspace/cache, journal/export, trash/OS metadata and secret filename/extension families classify denied. Client reads omit their bytes and attempts to update them fail before POST. NFKC compatibility and long-s aliases are included as policy cases, without claiming that all such spellings are host filesystem aliases.
- **Physical proof for F3:** five real case aliases—self plugin, competing plugin, workspace, cache and credentials—resolve to the same inodes. The real-directory adapter's scan reads only safe `app.json`, with **zero reads of protected files**.
- Reserved case/NFKC configuration-directory aliases are rejected by both scope compilation and hidden-port construction. Ordinary custom configuration directories remain accepted.
- First eligible hidden insertion works with absent ancestors and with an excluded-only configuration directory. Ignored file content and executable mode are preserved exactly without downloading it.
- Excluded-only file **and ancestor-directory** aliases remain readable and retain their exact excluded entries during an unrelated visible edit.
- User ignore patterns remain case-sensitive. Nearby legitimate names such as `github-vault-sync-extra`, `tokenizer.json`, `cacheable.json`, and `private.key.css` remain eligible.

## Verification results, provenance and boundaries

- Official focused tests: **95/95 pass**, independently rerun. Log: `/tmp/github-v2-scope-r2/official.txt`.
- Plugin TypeScript: **`tsc --noEmit` passes**, exit 0. Log: `/tmp/github-v2-scope-r2/typecheck.txt`.
- Independent current-source acceptance suite: **31 tests, 26 pass / 5 fail**. Three failures are directory-rename variants, one is the late collision gate, and one is the nested alias privacy case. Log: `/tmp/github-v2-scope-r2/review-results.txt`.
- Prior-client rename comparison: **5/5 pass**. Log: `/tmp/github-v2-scope-r2/before-privacy-results.txt`.

The scratch `fixture.ts` is copied unchanged from the R1 extracted fixture and still imports the root production client. Production hashing/tree verification executes normally. `review.test.ts` uses new safety acceptance assertions; it does not count R1 assertions of defect presence as successes or modify the prior reports/tests. Only the explicitly named before-privacy comparison uses a scratch historical client implementation.

Full current-suite rerun, from the requested root:

```sh
TMPDIR=/tmp/github-v2-scope-r2 plugin/node_modules/.bin/tsx --test plugin/test/scope.test.ts plugin/test/hidden-config.test.ts plugin/test/github-client.test.ts
TMPDIR=/tmp/github-v2-scope-r2 plugin/node_modules/.bin/tsx --test /tmp/github-v2-scope-r2/review.test.ts
(cd plugin && ./node_modules/.bin/tsc --noEmit)
```

The independent suite intentionally exits 1 until the five safety/behavior assertions pass. Physical tests require a case-insensitive filesystem and passed that prerequisite here; they do not silently skip it elsewhere. Git pattern checks are local real-Git oracles, not predictions of a remote service. The fixture creates and verifies Git tree object identities, but no live GitHub behavior or native configuration apply operation was exercised.

Embedded NUL and any noninitial BOM are now intentionally unsupported, rejected inputs; nested ignore semantics remain unsupported and should fail closed, including the demonstrated filename alias. The canonicalization policy is conservative NFKC plus case folding, not a proof of every filesystem's complete identity rules. Engine/native configuration integration, combined visible/hidden budgets, checkpoint transitions, consent, configuration apply/defer/reload behavior, and platform-specific end-to-end effects remain out of scope and pending separate review. Nothing here approves production scope wiring or the whole product.

Reviewed production SHA-256:

```text
scope.ts          ad5250856e4cedd80cc8b9d9d3c5ec8435cb4fc1e6f7e96d2898be04a95f10e8
hidden-config.ts  3d2a8fb57a2c4784bc6e3f34bc924cb632a3516651c5540077fd0a6df528855b
github.ts         8218f31dcb69efdeaa3e87b1f2c5e976352d85c77d43648480da4f3e7ae84066
```
