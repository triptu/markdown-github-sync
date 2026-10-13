# Review: c169a2e "Deduplicate verified journal objects within each record" (r2)

Scope: `plugin/src/git-sync/store.ts` and `plugin/test/journal-store.test.ts` at commit c169a2e only. HEAD at review time was
edb77de (a docs-only commit on top); `git diff c169a2e edb77de` touches no source or test file, so the working tree run is the
reviewed code. Method: read the diff and the full store, ran tsc and the focused suite in place, wrote adversarial scratch tests
in `/tmp/jr2/scratch/adversarial.test.ts` against the unmodified production `FileJournalStore`, and ran the pre-existing exact-journal
bench and empty-temp repro scripts (both load the `/tmp` copies into memory). No source, device, remote, vault, or `/tmp` journal
edits; both journal copies have no file newer than their 00:41/00:45 capture times. No subagents.

One untracked file, `plugin/test/native/editor-race-retention-r3.ts` (mtime 00:58), appeared in the tree during this review. It is
not mine and is outside scope; I did not read or run it.

## Verdict

**No blocking findings. Safe to keep.** The change does exactly what the latency doc proposed: a per-`pack()` and per-`unpack()`
promise map, nothing retained across operations or across retained records. One non-blocking diagnostics nit carried over from r1.

This commit does **not** address the Android zero-byte record-temp write failure
(`docs/verification/android-v2-configuration-restart-result.json`, "Recovery write verification failed. Sync stopped."). It only
reduces repeated object reads. The readback gate that stopped that failure is unchanged and still fails closed (S8 below, repo test
"an acknowledged empty record-temp write fails closed before rename", and the exact-journal repro).

## Checks run

| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `test/journal-store.test.ts` | 21/21, three consecutive runs |
| `/tmp/jr2/scratch/adversarial.test.ts` (S1–S8) | 8/8, three consecutive runs, zero unhandled rejections |
| `/tmp/github-v2-android-journal-bench-r2.ts` at delay 0 against the shipped store | native load 9 object reads; native compact (8 retained) 64 reads; native changed save 9 exists + 9 reads; engine load 38 reads; engine changed save 38 exists + 38 reads |
| `/tmp/github-v2-record-empty-write-repro-r2.ts` against the shipped store on the exact write-failure copy | `Recovery write verification failed. Sync stopped.`, latest committed stays 225, one new zero-byte temp, no record 226 |

The full suite was not repeated; r1 ran it at 24f68f7 and this diff touches only the store and its own test file.

## What the diff changes (confirmed by reading)

- `packObject(data, pending)` factors the body-keyed digest+`put` promise out of the `blobs` branch. `pack()` now threads one
  `pending` map through the whole record, so nested `Entry.data` strings and `blobs` entries that share bytes share one `put`.
  Same body means same SHA-256 path, so sharing the promise is exactly the pre-existing per-table semantics widened to the record.
- `unpack()` gains a hash-keyed `pending` map of read+checksum promises, created by default parameter at each top-level call.
  `loadRecord()` calls `this.unpack(state)` once per load; `compact()` calls `this.unpack(state)` once per retained record. Each
  call gets a fresh map, so there is no cache across loads, saves, compactions, or between the 8 retained records.
- Every returned value is awaited before it is placed in a result (`result.push(await ...)`, `result[key] = await ...`,
  `bytes: await ...`, `journalBlob: await ...`). Returning the shared promise from an `async` function adopts it. No `Promise`
  object can reach `JSON.stringify` or the loaded tree (S1 checks the record text and the `typeof` of loaded values).
- `mapObjects` now rethrows the first `Error` instance, else the first failure. The drain (`Promise.all` over workers that stop
  claiming after the first failure but finish in-flight work) is unchanged.
- `serialize()` queue, both `assertHead()` calls, `put()` write/readback/rename/readback, and compaction's
  verify-everything-before-removing-anything order are untouched.

## Adversarial scratch results (`/tmp/jr2/scratch/adversarial.test.ts`)

| Case | Probe | Result |
|---|---|---|
| S1 | One record with 9 references to 3 bodies through `Entry.data`, `blobs`, and nested arrays | 3 objects committed; record text has 9 hex `journalBlob` refs, no promise text; load reads 3 objects and round-trips exactly; second load and a reopened store read 3 again (no cross-op cache) |
| S2 | 10 saves of that record, then `compact()` | 2 records removed, 0 objects removed, 24 object reads = 8 retained records × 3 distinct hashes; adapter peak ≤ 4 |
| S3 | 12 oids sharing one body + 6 distinct, shared object corrupted, slow reads, two queued loads | First load rejects with an `Error` matching /checksum/ with adapter in-flight = 0; the corrupt object is read once per load (not once per worker); the queued load runs after the drain and reads it again; no unhandled rejection |
| S4 | Shared object deleted while compaction reads retained record 5 | Rejects with the missing-object error after 5 record reads; zero `remove` calls; file set unchanged apart from my own deletion |
| S5 | First shared-object rename fails with EIO on a record that references that body 4 times | Save rejects, no record written, drained; retry on the same instance commits the object exactly once and round-trips |
| S6 | Worker failures `[undefined, Error]`, `[undefined]`, `[string, Error]`, `[undefined, string]` | Rejection reason is the `Error`, `undefined`, the `Error`, `undefined` respectively; all four drain to in-flight 0 after 4 started writes, and a queued save then succeeds |
| S7 | 8 random-latency seeds saving the S1 record | Identical record filename across all seeds; exact load; peak ≤ 4 |
| S8 | Acknowledged empty record-temp write, then retry on the same instance | Rejects with "Recovery write verification failed"; no record rename; a fresh store loads the prior state; the retry commits sequence 2 and `compact()` removes the one empty temp |

## Findings

### F1 (non-blocking, diagnostics, unchanged from r1): a later non-`Error` failure can still be masked
`store.ts:39` prefers the first `Error` instance, which fixes the r1 case (`undefined` then `ENOSPC`). A later failure that is a
non-`Error` value (a thrown string, for example) is still hidden behind an earlier `undefined` (S6 case 4). Atomicity and drain are
unaffected. Only worth changing if adapters are known to throw non-`Error` values; `failures.find(f => f !== undefined) ?? failures[0]`
would cover it.

### Notes, no action required
- The per-record `unpack` map holds references to the same body strings that go into the returned tree, so it adds no copies.
  In `compact()` the map is dropped with each record.
- The `peak` assertions in the new native tests are 1 because `Entry.data` references are unpacked serially; the 4-worker bound
  applies only to `blobs` tables, as before. The latency doc's remark that overlapping distinct nested references would need a
  shared global limit still stands and is not attempted here.
- `docs/verification/android-apply-latency-r2.md` describes the 160→64 figure as a synthetic call-count projection on a copied
  journal and says so twice. The shipped store reproduces those exact counts (table above). No device speed claim is made there or
  here; the doc's own retry evidence shows the 240 ms per-call regime was run-dependent.
- Repo tests already cover the per-record freshness (`native Entry.data verifies 64 unique objects across 160 retained
  references`), corruption blocking compaction before deletion (`native compaction rechecks a shared object in every retained
  record before deleting`), the `Error` preference with drain, and the zero-byte record temp. The scratch cases above add the
  shared-rejection, mixed `blobs`+`Entry.data`, missing-object, failed-then-retried shared write, and same-instance retry angles.
