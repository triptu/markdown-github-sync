# Review: 24f68f7 "Verify journal objects with bounded parallel I/O" (r1)

Scope: `plugin/src/git-sync/store.ts` and `plugin/test/journal-store.test.ts` at commit 24f68f7 only.
Method: exported the commit with `git archive` to `/tmp/jr1`, ran tsc and the suites there, and wrote adversarial tests
in `/tmp/jr1/scratch/` against the production `FileJournalStore`. No source edits, no device, remote, vault, or subagents.

## Verdict

**No blocking findings. The change is safe to keep.** Two non-blocking items below (one diagnostics defect, one
in-repo coverage gap). No device performance claim is made or implied by this review.

## Baseline at the commit

| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `test/journal-store.test.ts` | 16/16, stable over 5 consecutive runs |
| full `test/*.test.ts` | 427/427 |

## What the code does (confirmed by reading)

- `mapObjects` runs at most 4 workers over `Object.entries(...)`. Each worker claims the next index synchronously,
  so no index is processed twice. Results are stored by index, so enumeration order is preserved regardless of
  completion order.
- A failure stops new claims (`failures.length === 0` guard) but workers already inside `await operation(...)` finish.
  `Promise.all` therefore resolves only after every started call settled; then the first failure is rethrown.
- `pack` dedupes by body string via a per-table `pending` map. Path is `objects/<sha256(body)>.json`, so
  same-path is exactly same-body (barring a SHA-256 collision, which `put()` would surface as "corrupt").
  The map lives inside one `pack` call, so there is no cross-operation cache.
- Outer `serialize()` queue, both `assertHead()` calls, `put()` exists/read/write/verify/rename/verify, and the final
  record commit are unchanged and still strictly ordered around the parallel section.
- `unpack`'s `blobs` branch cannot see nested `blobs` tables from a production record, because `pack` rejects
  non-string blob values, so the 4-worker bound is not multiplied by recursion.
- `compact()` reuses `unpack` and so also benefits, still serial across the 8 retained records.

## Adversarial scratch results (`/tmp/jr1/scratch/adversarial.test.ts`, 10/10 pass)

| Case | What it probes | Result |
|---|---|---|
| A | Tick sweep over all 71 adapter boundaries of a save whose state has 6 existing + 10 new blobs, 3 duplicate bodies, and a `files.*.data` entry sharing bytes with a blob | Every boundary leaves exactly the prior or the new complete state (70 prior, 2 new). Adapter in-flight count is 0 after rejection. Every `objects/<h>.json` body hashes to `h`. No duplicate sequence numbers. A reopened store can save and compact afterwards with no `.tmp` debris. |
| B | Random adapter latency, 6 seeds | Record file name identical across all orderings. Repeat save of the same state writes nothing. Loaded JSON is byte-identical to input (key order, including integer-like keys). |
| C | 40 seeds, random latency, injected failure on the Nth object `exists`/`read`/`write`/`rename` | Rejection only after in-flight = 0; no adapter call after the rejection settles; objects content-consistent; load returns prior or new state; zero unhandled rejections. |
| D | 20 oids with one body whose single `rename` fails | One rejection, no record, no object, retry succeeds with exactly one object commit. |
| E | Non-string value mid-table on save; forged non-hex reference and missing object on load | Rejects with the existing messages, drained, no record written. |
| F | `blobs` = `{}`, `null`, array, string, user key literally named `journalBlob`, nested `blobs` inside arrays and objects, `files.data` sharing bytes with `blobs` | Exact round trip for every case. |
| G | 400 blobs | Object peak concurrency is 4 on load and at most 4 on save. Adapter calls: 407 per load, 817 per changed save, so every object is still re-read on every operation (no cross-op cache). |
| H | Stale writer with a 50-blob state | Zero object writes; fewer than 10 adapter calls before "Stale journal writer". |
| I | Failed save after 6 new-object commits | 8 orphan objects + 1 temp file remain; `compact()` removes all of them and the baseline still loads. |

Memory: at most 4 object bodies are in flight beyond the fully materialized state, which already held every body
before this change. The dedupe map holds promises resolving to 64-char hashes, not bodies.

## Findings

### F1 (non-blocking, diagnostics): earliest failure wins and can mask a real error
`store.ts:39` rethrows `failures[0]`, the failure that happened first in time. If that value is `undefined`
(the case the repo's own test deliberately exercises) and a concurrent worker then fails with a real `Error`
such as ENOSPC, the real error is discarded and the save rejects with `undefined`. Reproduced in
`/tmp/jr1/scratch/mask.ts` (prints "rejection reason: undefined (real ENOSPC error masked)").
Atomicity is unaffected; only the surfaced reason degrades, and it degrades precisely when the disk is failing.
Suggested fix: prefer the first `Error` instance (or any non-`undefined` failure), e.g.
`throw failures.find(f => f instanceof Error) ?? failures[0]`, or wrap in an `AggregateError`.
Related nit: with several concurrent failures the reported message is nondeterministic.

### F2 (non-blocking, coverage): the in-repo interruption sweeps never cross the parallel path
Both `each interrupted persistence boundary ...` and `cleanup after every failed append ...` use the `original`/
`updated` fixtures, which have no `blobs` table, so the new `mapObjects` code is not swept boundary-by-boundary in
the repo. Scratch case A does this and passes, so there is no defect, but the regression guard is missing.
Suggested fix: add a fixture with a `blobs` table (including a duplicate body and a `files.*.data` entry that
shares bytes with a blob) to those two sweeps.

### Notes, no action required
- The diagnosis doc models 8 workers; the commit ships 4. That is the conservative choice the doc itself allows
  under memory pressure. Worth one sentence in the doc so the numbers are not read as the shipped setting.
- Pre-existing, unchanged by this commit: when the record rename succeeds and the post-commit verification read
  fails, the save rejects although the record is committed (2 of 71 boundaries in case A). The existing matrix
  already accepts "prior or new".
- The new in-repo tests depend on `setTimeout` ordering (1 ms vs 10 ms) for `peak > 1`. They were stable over
  5 runs here; the workers reach `rename` in lockstep through microtasks, so this is unlikely to flake.

## Interruption matrix coverage summary

| Boundary class | In-repo | Scratch |
|---|---|---|
| Directory prepare, head list/read | existing sweeps | A, C |
| Existing object `exists`/`read` compare (parallel) | corruption test only | A, C |
| New object `write`/verify `read`/`rename`/verify `read` (parallel) | one drain test | A (every tick), C (random), D (dedupe path) |
| Record `put` after parallel section | existing sweeps | A |
| Load `read` + checksum (parallel) | corruption test | E, G |
| Cleanup after failed parallel save | none | I |

## Follow-up

The repository now includes a persistence-boundary sweep with 16 blob entries, duplicate bodies, and bytes shared with a file entry. All 17 journal tests pass. The shipped worker limit is four; the latency diagnosis compares four and eight workers as synthetic models, not device measurements. Error selection remains a nonblocking diagnostics limitation: concurrent failures may report an earlier non-Error rejection instead of a later Error.
