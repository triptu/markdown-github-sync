# Scope foundation/client independent safety review R1

**Verdict: changes requested for three reproduced defects. This is a scoped review, not approval of the full product or Android replacement.**

Reviewed starting HEAD `3f33c760938774046591c49da2c74896ee78d10d` at `~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600`. The shared root advanced to `c12a04c88b1098feed63ed669b2cbe1de98aea16` during the review; all three reviewed production modules and their three official test files are unchanged from the requested HEAD (`git diff 3f33c76 HEAD -- <six paths>` empty). Line references below apply to that source.

No root edits, remote requests, device access, real-vault access, or subagents. Scratch files only under `/tmp/github-v2-scope-r1/` and this report. The fixture transport records requests in memory; every “POST” below means the production client called that synthetic transport, never GitHub. Filesystem proof uses a new synthetic directory in `/tmp` and deletes only that directory afterward.

## F1 — HIGH privacy: accepted ignore encodings can include and upload a path that Git ignores

**Locations:** `plugin/src/git-sync/scope.ts:94–107` (validation/compiler), `:158–160` (UTF-8 decode); `plugin/src/git-sync/github.ts:444–451` (candidate gate).

Two concrete inputs are silently accepted with semantics different from isolated `git check-ignore --no-index`, with case-sensitive matching and system/global excludes disabled. Let `p = .obsidian/plugins/custom/data.json`:

1. `p + "\n\ufeff!" + p + "\n"`: the second line starts with U+FEFF, not `!`. Git keeps `p` ignored. Pinned `ignore@7.0.12` strips a BOM at the beginning of *each* parsed pattern (`node_modules/ignore/index.js:1081–1084`), turns that second line into a negation, and the compiled production scope includes `p`.
2. `p + "\0garbage\n"`: this is valid UTF-8, so the decoder accepts it. Git treats the pattern up to the NUL as `p` and ignores the file; the production scope includes it.

These are not merely diagnostic mismatches. In `evidence.test.ts`, start with `p` already tracked and an empty root ignore, then add either pattern and change `p` in the same transaction. Both production `freezeTransactionScope` and `GitHubRepository.prepare` admit the path. The latter sends the exact new synthetic secret's base64 bytes in `/git/blobs` POST and returns a prepared candidate containing them. The branch remains unchanged, as expected for prepare; privacy protection is already bypassed at blob upload. Using an already-tracked file removes new-hidden consent from the explanation.

**Reproduce:**

```sh
cd ~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600
plugin/node_modules/.bin/tsx --test --test-name-pattern='oracle' /tmp/github-v2-scope-r1/probe.test.ts
plugin/node_modules/.bin/tsx --test --test-name-pattern='allows ignored hidden bytes' /tmp/github-v2-scope-r1/evidence.test.ts
```

The oracle command has two failing acceptance assertions. The second command has two passing *defect-presence* assertions and prints `syntheticSecretBlobPosted:true` for each. A normal leading UTF-8 BOM is a passing control and retains its exact byte hash.

**Fix direction:** reject these unsupported ambiguous inputs with `ScopeError` before activation, capture, or upload, or provide Git-conformant parsing verified against the real Git oracle. Do not strip all BOMs or reinterpret malformed encoding silently. Preserve the original bytes for the policy OID. Extend conformance coverage to noninitial U+FEFF and embedded NUL, and rerun the same-transaction no-upload test. This is an implementation gap in the accepted-input boundary, not an intentionally unsupported input that currently fails closed.

## F2 — HIGH preservation risk: excluded paths disappear from collision validation

**Locations:** `plugin/src/git-sync/github.ts:393–394` and `:454–462`.

The client checks canonical case/Unicode collisions only among included paths. Ignored or denied entries still exist in the full Git tree but are removed before `validatePaths`. `prepare` again validates only the included `files`; its check across all final terminals only detects exact-spelling file/directory collisions.

Repro repository:

```text
.gitignore                                 .obsidian/plugins/custom/Data.json\n
.obsidian/plugins/custom/Data.json         SYNTHETIC_PRIVATE (ignored)
```

Adding `.obsidian/plugins/custom/data.json` succeeds: the client uploads its blob, creates the candidate and receipt, preserves `Data.json` exactly in Git, and returns the lowercase path as in scope. `readCommit` also accepts a tree containing both spellings and reads the lowercase blob. Both are valid, independently hashed Git trees. The existing excluded-terminal equality check passes because it is byte-exact in Git's namespace.

On a case-insensitive filesystem, these names identify one local file; admitting the included spelling cannot satisfy the promise that the excluded path remains untouched. The review demonstrates the invalid client acceptance and blob upload, not an actual native overwrite: configuration application is intentionally deferred and unwired. This extends the client's already-existing cross-platform canonical-collision policy, rather than asking for case-insensitive `.gitignore` matching.

**Reproduce:**

```sh
plugin/node_modules/.bin/tsx --test --test-name-pattern='aliases|alias preserved' /tmp/github-v2-scope-r1/probe.test.ts
plugin/node_modules/.bin/tsx --test --test-name-pattern='cross-scope aliases' /tmp/github-v2-scope-r1/evidence.test.ts
```

Both acceptance tests fail with “Missing expected rejection.” The evidence test succeeds in preparing both spellings and retains the ignored entry's exact OID, proving why terminal equality alone is insufficient.

**Fix direction:** check included paths and their ancestors for canonical collisions against the full verified namespace, including excluded terminals and directories; perform the equivalent check against the proposed full namespace before any blob POST. Reject collisions that intersect an included/changed path without downloading excluded blob content. Continue matching Git patterns case-sensitively. Cover ignored/included file aliases, ancestor aliases, and normalized Unicode aliases.

## F3 — HIGH privacy: a case alias bypasses the reserved self-plugin deny even with no second spelling in the tree

**Locations:** `plugin/src/git-sync/scope.ts:65–77`; consumer `plugin/src/git-sync/hidden-config.ts:58–68`.

The built-in privacy deny uses literal case-sensitive comparisons for reserved plugin IDs, directory names and secret names. The path `.obsidian/plugins/GITHUB-VAULT-SYNC/data.json` classifies as `config-live`; the equivalent lowercase path is `denied`.

The scratch test creates only the uppercase plugin directory on this host's case-insensitive filesystem, writes `SYNTHETIC_DEVICE_BINDING`, and verifies that reading/statting the lowercase reserved path reaches the **same inode**. Through a structurally valid adapter listing, the actual `HiddenConfigPort.scan` reads and returns that file's exact bytes. A separate production GitHub client test accepts and downloads this same uppercase path from a synthetic remote tree. No duplicate spelling needs to exist, so F2's full-tree collision check alone cannot fix this.

A renamed/case-variant self directory on such a device is still the protected self location. New-hidden consent is intentionally owned by the future engine, but cannot replace a built-in *never-sync* deny; the client also admits an already-tracked alias. This finding does not assert that current Android production wiring uploads the device binding.

**Reproduce:**

```sh
plugin/node_modules/.bin/tsx --test --test-name-pattern='protected self alias' /tmp/github-v2-scope-r1/probe.test.ts
plugin/node_modules/.bin/tsx --test --test-name-pattern='reserved self alias' /tmp/github-v2-scope-r1/evidence.test.ts
```

The first acceptance test fails because the snapshot contains the self alias. The second prints `sameInode:true,readProtectedBytes:true` and asserts the exact returned synthetic bytes. The physical-inode test requires a case-insensitive filesystem; the scope/client admission is platform-independent.

**Fix direction:** reserve canonical aliases of protected locations and names before applying the case-sensitive user matcher. Use a consistent filesystem-safety canonicalization policy for built-in denies and configuration-directory validation. Also test the competing-plugin, workspace, cache, journal/export and secret-name families with aliases. Do not change user `.gitignore` matching to case-insensitive.

## Verified controls and boundaries

- Independently ran all official `scope`, `hidden-config`, and `github-client` tests: **85/85 pass**. This includes first configuration insertion beneath absent and excluded-only `.obsidian` ancestors and refusal of forged excluded-terminal modifications. The first-config regression fixed through `3f33c76` did not reproduce.
- Scratch `probe.test.ts`: **7 cases, 2 pass / 5 fail**. The five failures are safety acceptance assertions exposing the three findings above (two encoding cases, two collision routes, one self-alias read). The UTF-16LE-without-BOM probe agrees with Git and is **not a finding**.
- Scratch `evidence.test.ts`: **10/10 pass**, consisting of **four assertions of defect presence** and six safety controls. Do not count all ten as safety acceptance.
- Root ignore invalid UTF-8, symlink mode, directory entry and >64-KiB content all fail repeatedly across `scopeFor`, `readRootGitignore`, and snapshot reads. Repeated calls do not turn an earlier policy error into an accepted cached scope, download the unrelated hidden fixture bytes, or POST objects.
- A leading UTF-8 BOM is handled correctly, the exact text is returned, executable root-ignore mode is supported, and the ignored fixture blob is never requested. Outgoing invalid UTF-8 is refused before any POST.
- Reviewed immutable scope/rules, per-tree scope caching, shared Web Crypto hashing, exact excluded-terminal preservation, root-ignore self-exclusion override, legacy visible-only default, fresh hidden-byte hashing despite unchanged stats, validated adapter children, stat-before-oversize reads, and nested-ignore refusal including denied remote/config descendants. No additional reproducible defect found in those controls.
- Full local nested-ignore inventory outside the configuration port, parent/remote/local intersection integration, exact-version new-hidden consent, **all** incoming configuration application/defer/reload handling, and the combined visible+hidden 128-MiB budget remain engine/native/UI integration responsibilities. Their absence is not relabeled as a foundation defect. This review gives no permission or completion claim for production scope wiring.
- Did not duplicate the five oversized-file engine findings in `/tmp/github-v2-engine-review-r2.md`. No remote behavior, Android execution, or native configuration overwrite was claimed from synthetic client tests.

## Evidence and rerun

All scratch imports point directly at production modules in the shared checkout. `/tmp/github-v2-scope-r1/fixture.ts` is the unchanged in-memory fixture prefix extracted from `plugin/test/github-client.test.ts`, with absolute imports and exports added; it does not replace scope, client, hashing, or hidden-port implementation.

```sh
cd ~/.t3/scratch/2026-10-13-reverse-engineer-anything-figure-out-d62b7600
plugin/node_modules/.bin/tsx --test plugin/test/scope.test.ts plugin/test/hidden-config.test.ts plugin/test/github-client.test.ts
plugin/node_modules/.bin/tsx --test /tmp/github-v2-scope-r1/probe.test.ts
plugin/node_modules/.bin/tsx --test /tmp/github-v2-scope-r1/evidence.test.ts
```

Saved output: `official.txt`, `probe-results.txt`, and `evidence-results.txt` in `/tmp/github-v2-scope-r1/`. The probe command should exit 1 until these acceptance failures are fixed. Evidence tests currently assert the defective outcome and should be converted/reversed when implementing fixes. Scratch tests follow the live checkout, so source changes can change their results.

SHA-256 of reviewed production files:

```text
scope.ts          ccf12843a3aee77102f993eef3325bcbc50320d00c079c220420c12b2f0cf556
hidden-config.ts  fe19ddb76ba373dcfc4f1f7a18933860ac8591742d0a170f60105d44ad5d912e
github.ts         bdea2f70b4eed1e164647e501b2c578843797203af5eaa4eddaacb8e5c0bd459
```
