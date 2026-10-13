# Live V2 client and engine acceptance

The updated `scripts/github-integration.ts` uses the production GitHub client and sync session against the hard-coded private synthetic repository `your-name/vault-sync-test`. It never targets the real vault repository. It checks note/binary round trips, preservation of excluded tree entries, atomic publication races, rewind rejection, response loss, two sessions editing different files, and session reconstruction after an accepted response is lost. The local vault and serialized durable store are in-memory test ports; this is not native filesystem or process-kill acceptance.

## Current result

**PASS** after the REST ledger fix (`caaa411`) and engine integration (`ae497b4`), recorded in `github-client-live-v2.json`. Both production sync sessions concurrently edited different files from the same checkpoint and converged automatically. A publication response was then lost and subsequent requests blocked; reconstructing the session from its serialized store settled the accepted receipt without creating another commit. The other device received the draft.

The run also passed a 4,320,889-byte attachment round trip, exact byte/mode checks, preservation of three excluded entries, competing client publications, forced-rewind rejection, and response-loss receipt recovery. All writes targeted a unique synthetic branch; a separate read after the engine test confirmed the lab default branch remained unchanged. The real vault repository was not used.

These checks use real GitHub APIs and production client/engine code with in-memory local vault/store ports. They do not replace Android filesystem, editor or process-kill acceptance. The full plugin suite still has two history-restore crash regressions under repair.

## Historical counterexample found on 2026-10-13

The first atomic publication succeeded. GitHub echoed its receipt ID, but the production GraphQL `Repository.ref(qualifiedName: ...)` query returned null for the custom device ref. A separate REST exact-ref lookup returned the accepted receipt. Repeating GraphQL after the REST read still returned null. The harness correctly stopped at its first acceptance assertion; none of the later V2 convergence gates are claimed passed.

- Ref: `refs/vault-sync/devices/3b6bb8f4-d513-444a-941d-38a17f317694`
- Receipt: `6a3944f43c80eaed13abac87dcd5427b482c8006`
- Accepted branch commit: `62cd0efe9002fc86a1d4c41ab5fd13fb1352799f`
- GraphQL evidence: `github-custom-ref-read.jsonl`
- REST evidence: `github-custom-ref-rest.json`

The client fix replaced the GraphQL ledger lookup with an exact REST ref lookup. Missing/stale responses must still never prove nonpublication: the conditional receipt/seal protocol decides that. The corrected harness has now completed successfully. The earlier API primitive probe used REST reads, explaining why that narrower check passed.

Run from repository root:

```sh
plugin/node_modules/.bin/tsx scripts/github-integration.ts
```

The revised harness type-checks. The initial failed run is retained above as evidence of the API mismatch; the current successful run is recorded separately. No secret is printed or written to these evidence files.
