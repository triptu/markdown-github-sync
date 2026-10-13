# GitHub repository adapter

`plugin/src/git-sync/github.ts` implements the fixed `Repository` contract for GitHub.com. The client has no Node, Obsidian, Git CLI, filesystem, persistence or logging dependency. It requires browser `crypto.subtle` (SHA-1), `TextEncoder`, `TextDecoder`, `atob` and `btoa`.

```ts
import { GitHubRepository } from "../plugin/src/git-sync/github";

const repository = new GitHubRepository({
  owner: "example-owner",
  name: "example-repository",
  branch: "main",
  token: async () => secretStorage.getSecret(secretId),
  transport: {
    async request({ url, method, headers, body }) {
      const response = await fetch(url, { method, headers, body });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      return { status: response.status, headers: responseHeaders, json: await response.json() };
    }
  }
});
```

The token callback must resolve a nonempty credential. It runs once per request; the adapter stores the callback, not a token. Transport bodies are JSON strings; response JSON is `unknown` and parsed at the boundary. The transport must keep credentials, request headers, request bodies and raw exception messages out of logs and durable storage. The client emits static sanitized errors and does not forward GitHub's response messages or callback/transport exception text. A host using Obsidian's HTTP APIs can implement the same transport instead of `fetch`.

`identity()` returns GitHub's stable repository `node_id` plus canonical owner/name and configured branch. A renamed or transferred repository that no longer matches the configured coordinates blocks until explicitly reconfigured. Empty/unborn repositories and missing branches produce an unsupported-enrollment error; this adapter cannot create enrollment branches.

## Snapshot and object validation

`head()` pins the current branch commit once, then `readCommit(oid)` obtains immutable commit, tree and blob objects. Each returned file is an `Entry` containing canonical full base64 data, Git blob SHA-1 and mode `100644` or `100755`. No text decoding/reencoding changes file bytes.

Content scope includes files whose path components never begin with a literal dot. Hidden directories and their entire descendants are excluded. Hidden symlinks and submodules are preserved, while visible symlinks/submodules, unsupported modes, and Git LFS pointer bytes block the snapshot. LFS detection conservatively rejects blobs beginning with the version marker rather than following LFS URLs.

Paths reject traversal, empty components, absolute names, backslashes, controls, invalid Unicode surrogates, Windows reserved names/characters, trailing periods/spaces, and unsafe compatibility-normalized components. Visible paths and directory prefixes must have distinct compatibility-normalized case-folded spellings. File/directory collisions block preparation. Snapshots use objects with null prototypes, allowing ordinary safe names such as `__proto__` without prototype mutation.

Limits are fixed at 8 MiB per decoded visible file and 128 MiB per decoded visible snapshot. Tree-declared sizes are checked before downloads, and actual decoded bytes must match. Changed files and the entire resulting snapshot are checked before uploads. Blob downloads/uploads are sequential within each operation. The client retains the full snapshot required by the contract; the limits are decoded-byte limits, not a promise of 128 MiB peak heap usage. Base64, JSON, decoded buffers and hashing increase peak memory. Callers should serialize repository operations except explicit publisher race tests.

Recursive trees marked `truncated` block safely with an explicit enrollment error. There is no partial-tree acceptance or fallback walk. Trees exceeding 100,000 entries also block. The adapter recomputes every listed directory's Git tree SHA-1 from sorted UTF-8 names, modes and child object IDs, including excluded objects. Every downloaded or changed blob is verified using `SHA1("blob " + byteLength + NUL + bytes)`. Uploaded blob responses must return that same hash.

Commit responses must report the requested SHA; tree and parent references are parsed and checked. Preparation checks the create response and independently rereads the candidate commit, requiring exactly the intended tree and sole parent. Arbitrary commit byte hashes are **not** reconstructed: REST's normalized date fields lose original timezone information, and signature verification payloads do not contain signed commit bytes. Blob and tree identities are verified cryptographically; commit identity and ancestry rely on GitHub's authenticated immutable-object APIs. The client does not claim independent commit-signature verification.

## Preparation and exact publication

`prepare(parent, changes, message)` rereads the parent's immutable objects and requires every supplied parent file to match the verified snapshot. Every changed `Entry` is validated against its supplied hash and mode before the first upload. A nonexistent deletion is a no-op. It creates blobs, then a tree with `base_tree: parent.treeOid`, then a single-parent commit. The new tree's full terminal entries must match the intended changes; all excluded entries, including excluded directory objects, must remain unchanged. The returned snapshot is the prepared candidate. Preparation never changes a ref. Failed preparation may leave unreachable immutable objects on GitHub.

`publish(expectedHead, candidate)` first requires the candidate's sole parent to equal `expectedHead`. It uses only GraphQL `updateRefs` with repository node ID, fully qualified branch name, exact `beforeOid`, `afterOid`, and `force: false`. GitHub documents this atomic exact-value check in [the GraphQL Git reference](https://docs.github.com/en/graphql/reference/git). There is no REST fast-forward publication fallback.

A validated mutation acknowledgment returns `accepted`. On GraphQL errors, malformed acknowledgments, HTTP rejection or transport loss, the client rereads the branch and compares ancestry:

- Current head equals candidate, or candidate is its verified GitHub ancestor: `accepted`. This records historical acceptance, even if a later commit reverted its content; the sync engine still must reconcile the later head.
- Candidate was not accepted and the observed head differs from the expected head: `head-moved`.
- Expected head remains and GitHub explicitly rejected the request: `rejected` with a static message.
- Expected head remains after an ambiguous request, or reread/ancestry cannot establish an outcome: `unknown`.

These outcomes report observed evidence, not a guarantee against a concurrent writer moving the branch again afterward. A publication that was accepted and then removed by a force rewrite may remain unknowable from current history. Recovery must retain its journal and candidate bytes. Never automatically replay an `unknown` operation.

`isAncestor(a, b)` uses GitHub's compare endpoint pinned to both commit IDs, checks its base/merge-base identities and status, and throws on malformed/inconsistent results or API failures. Equal IDs are checked for existence before returning true. Uncertainty is never treated as false.

## Errors and scheduling

`GitHubError` exposes optional HTTP `status` and `retryAt` (epoch milliseconds). HTTP 429, primary exhaustion, `Retry-After`, and GraphQL `RATE_LIMITED` produce a schedulable error. The retry time respects valid `Retry-After` seconds/date and rate reset headers, with a conservative minimum of one minute. Header names are case insensitive. Ordinary permission/API failures are clear HTTP errors. There are no internal retry loops or busy waits. Rate limits encountered during ambiguous publication recovery propagate as schedulable errors so the host retains the unresolved operation.

REST object semantics and limits were checked against GitHub's official [blobs](https://docs.github.com/en/rest/git/blobs), [trees](https://docs.github.com/en/rest/git/trees), [commits](https://docs.github.com/en/rest/git/commits), [compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits), and [rate-limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) documentation.

## Verification

Install and run the scoped checks from the repository root:

```sh
npm ci --prefix plugin
plugin/node_modules/.bin/tsx --test plugin/test/github-client.test.ts
npm run typecheck --prefix plugin
```

The test transport generates independently hashed Git trees and blobs. Tests exercise unknown JSON, API errors, rate limits, hostile names, canonical collisions, hash mismatches, scope preservation, mode changes, size limits, parent/object tampering, independent publishers, lost responses (including subsequent commits/reverts), and uncertainty. A real 4,320,889-byte base64 fixture covers large-payload validation without regex stack overflow.

The optional live harness is hard-coded to `your-name/vault-sync-test` and accepts no repository argument:

```sh
plugin/node_modules/.bin/tsx scripts/github-integration.ts
```

It obtains the existing `gh` token via a subprocess into memory, creates a uniquely named synthetic branch, and leaves that branch for inspection. It never updates the repository's default branch. It prepares and verifies a UTF-8/BOM/CRLF note, a 4,320,889-byte random binary, a small arbitrary binary, and an executable; verifies hidden file/symlink/submodule preservation; races two independent clients; rejects a stale publisher after an intentional force rewind of only its unique branch; injects loss after a successful mutation; and verifies deletion and ancestry. Its output contains only test evidence, not credentials. The forced REST ref update exists only in the isolated test harness, never in production publication.

This exercises existing `gh` credentials on GitHub.com. Fine-grained PAT authorization, rulesets, real mobile memory/network behavior and local vault mutation remain separate verification gates.

### Recorded live evidence — 13 October 2026

Final implementation: 39/39 scoped tests passed; plugin typechecking and separate strict harness typechecking passed. The final live run made 131 requests and completed successfully on branch [`github-client-2026-10-13T12-11-45-008Z-d14e1f3a`](https://github.com/your-name/vault-sync-test/tree/github-client-2026-10-13T12-11-45-008Z-d14e1f3a):

- Seed: `c9766f40a5f018b211edf9310a00eef0cca43f22`.
- Verified note/binary/mode roundtrip: [`4f326d0b0eecc55f7da22a8d2853b4cd7ab7d4e7`](https://github.com/your-name/vault-sync-test/commit/4f326d0b0eecc55f7da22a8d2853b4cd7ab7d4e7). Random binary: 4,320,889 bytes. Three excluded terminal entries retained: executable hidden blob, symlink, submodule.
- Independent-client race candidates: `a05dc0304ecd43060ee2824798a7a3b14efeb8d2` and `61bc225c7fba72b0fd698c512e896ed7490d6151`. First accepted; second returned `head-moved`, including on stale retry.
- Forced-rewind candidate: `c09162aa076f997a1eb052b98bab807c30abb699`. After rewinding the unique branch to the roundtrip commit, exact publication returned `head-moved`; reread remained at `4f326d0b0eecc55f7da22a8d2853b4cd7ab7d4e7`. Removed race history was not resurrected.
- Successful mutation followed by injected lost response: [`cfcc5755a5383e326d0bda15c2f28ebae56bb996`](https://github.com/your-name/vault-sync-test/commit/cfcc5755a5383e326d0bda15c2f28ebae56bb996). Client recovered `accepted`; another client confirmed the same head and the requested binary deletion. Forward ancestry returned true; reverse ancestry returned false.
- Synthetic repository default branch before/after: `9471df028e8fbf9d34c9d5528a66d45211ba5b2f`, unchanged.

The first live attempt exposed a large-base64 regex stack overflow. The implementation now uses nonrecursive character validation with explicit encoded-length/padding checks; the multi-megabyte regression test and two subsequent successful live runs cover the correction. The initial seed branch and successful fixture branches remain isolated in the authorized synthetic repository for inspection. No API calls targeted the real vault repository.
