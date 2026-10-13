# Cloudflare sync storage

One Worker authenticates requests with a shared bearer secret. A SQLite Durable Object serializes each vault's writes; R2 stores only the client's encrypted base64 envelopes. Object names are opaque client HMACs. The server sees vault/object identifiers, sizes, timestamps and deletion flags, but receives no plaintext file paths or content. All devices holding the token have access to all vaults on this deployment; this is a personal server, not a multi-user permission system.

Use Node 22 LTS or newer:

```sh
npm ci
npx wrangler login
npx wrangler r2 bucket create cipher-vault-sync
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

Supply a randomly generated token of at least 32 characters (for example `openssl rand -hex 32`) at the secret prompt. Copy the resulting `https://cipher-vault-sync.<account>.workers.dev` endpoint and token into each plugin installation. R2 must be enabled on the account. Choose a globally unique bucket name if necessary and update `wrangler.jsonc`. Deployment has not been performed automatically.

For local development put `SYNC_TOKEN=your-long-development-secret-value` in `.dev.vars`, then run `npm run dev`. Use only development credentials over localhost HTTP. Run `npm test` for actual workerd/SQLite/R2 integration tests and `npm run typecheck` for types.

## API

All routes start `/v1/vaults/:vault` and require `Authorization: Bearer <SYNC_TOKEN>`. Vault IDs are 16–128 URL-safe alphanumerics/underscores/hyphens. Object IDs are 64 lowercase hexadecimal characters.

- `GET /heads`: `{heads:[{id,version,deleted,updatedAt}],cursor}`. Complete snapshot, including tombstones. At most 20,000 distinct objects per vault.
- `PUT /objects/:id`: `{base,payload,deleted,operationId}`. `base` must equal the existing object's version, or zero for a new object. Payload is a padded standard base64 encrypted envelope, at most 16 MiB encoded. Tombstones retain an encrypted envelope. Operation IDs are 16–128 URL-safe characters and unique per logical write. Successful response is `{id,version,deleted,updatedAt}`. Versions increase globally within a vault.
- `GET /objects/:id[?version=N]`: metadata plus encrypted `payload`, including for tombstones. Missing object/revision returns 404.
- `GET /history/:id[?before=N]`: `{versions:[metadata],before}` newest first, up to 100 entries. A non-null `before` is the next page cursor.

A stale base returns HTTP 409 `{error:"conflict",head:metadata|null}`. Repeating an operation ID with the identical request returns its original result even if later writes exist; reusing it for different content returns 409 `operation_id_reused`. Clients must inspect the error type. Transient failures return 503 and may be retried with the same operation ID. Invalid input returns 400; limits return 413. Timestamps are server UTC epoch milliseconds.

R2 writes complete before SQLite heads become visible. A crash in between may leave an unreachable R2 blob; it cannot publish a partial revision. History and idempotency records are retained indefinitely. There is no garbage collector, retention policy, quota enforcement beyond the object/payload limits, rate limiter or public signup flow. Storage costs grow with revisions. Do not set R2 expiry rules: they would remove live/history blobs. Back up both Durable Object metadata and R2 if you need a disaster recovery process; this repository does not implement one. The server cannot verify the client's ciphertext is actually encrypted.

Implementation references: [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/), [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/).
