# Desktop automatic sync: stale mutable branch head

## Observed run

Fresh desktop production acceptance run `6ba74e17-f7ff-40e9-a145-82c7049ddcf1` passed enrollment and seed, then failed foreground automatic convergence. Its status was `Paused: Checkpoint 3b6c2b9f189dad729bfb7580edaa638f1383da6e is not an ancestor of head 3ae60d4cb789eb0596a42cc459b1f7eda9ba701d`.

Root independently checked the branch graph: `3b6c2b9f...` is the production commit of the local file and has parent `3ae60d4c...`; `3ae60d4c...` is the helper's remote fixture commit with seed parent `f4e10...`; actual branch head was `3b6c2b9f...`. Thus the ancestry guard correctly paused for the *head value it was given*, but that head value was older than the branch head root observed.

The source path `session.ts` calls `repository.head()` before its ancestry guard. `GitHubRepository.headOid()` used a fixed `/git/ref/heads/<branch>` URL with no cache directives. By contrast, `readLedger()` already uses a unique query nonce and `Cache-Control: no-cache` / `Pragma: no-cache` for another mutable ref. The repository's own object cache is keyed by immutable commit/tree/blob SHA, so it is not the source of this old branch ref.

Root's read-only observation at `/tmp/github-v2-desktop-head-cache-observation.json` found an old-URL response Date of 20:02:32 and a fresh-URL response Date of 20:02:46, both returning actual head `3b6c2b9f...`; both advertised `Cache-Control: private, max-age=60, s-maxage=60`. The responses were captured after the pause and do not capture an old and fresh request returning different SHAs simultaneously. HTTP caching is the best-supported cause from the fixed URL, cacheable response, and observed old Date, but that narrower direct comparison is unavailable.

## Change

`headOid()` now reads the branch ref with a unique URL plus no-cache request headers, matching the existing mutable ledger read. It retains ref identity, object type, SHA, missing/unborn branch, and ancestry checks. History's unpinned head read uses the same path. No retry, delay, or rewind bypass was added.

A focused transport test first failed by returning an obsolete SHA from a URL cache after the branch advanced. After the change it sees the advanced head, proves ancestry, checks two distinct URLs, and checks both no-cache headers. `npm run typecheck` and `npm test` passed (474/474).

## Scope and next proof

This change is source and test only. No production bundle was built or installed here, and no app, vault, device, or remote was touched by this worker. Root should build/pin a new production bundle, run a fresh disposable-vault acceptance UUID, and verify the installed SHA and automatic convergence. The previous UUID should remain preserved as failed evidence.
