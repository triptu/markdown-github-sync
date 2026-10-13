import { DurableObject } from 'cloudflare:workers';

export interface Env { VAULTS: DurableObjectNamespace<Vault>; BLOBS: R2Bucket; SYNC_TOKEN: string }
type Row = { id: string; version: number; deleted: number; updatedAt: number; blob: string };
const MAX_PAYLOAD = 16 * 1024 * 1024; // Encoded envelope; deliberately bounded below Worker memory limits.
const MAX_BODY = MAX_PAYLOAD + 4096;
const MAX_OBJECTS = 20_000;
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers }); }
function head(row: Row) { return { id: row.id, version: row.version, deleted: !!row.deleted, updatedAt: row.updatedAt }; }
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function authorized(request: Request, token: string) {
  if (!token || token.length < 32) return false;
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 1024) return false;
  const a = new TextEncoder().encode(await digest(supplied));
  const b = new TextEncoder().encode(await digest(`Bearer ${token}`));
  return crypto.subtle.timingSafeEqual(a, b);
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new HttpError(413, 'request_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'missing_body');
  const decoder = new TextDecoder(); let size = 0; let result = '';
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'request_too_large'); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      ...headers, 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type',
    }});
    if (!env.SYNC_TOKEN || env.SYNC_TOKEN.length < 32) return json({ error: 'server_token_not_configured' }, 503);
    if (!await authorized(request, env.SYNC_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    const match = /^\/v1\/vaults\/([A-Za-z0-9_-]{16,128})(\/.*)$/.exec(url.pathname);
    if (!match) return json({ error: 'not_found' }, 404);
    url.pathname = match[2];
    return env.VAULTS.get(env.VAULTS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;

export class Vault extends DurableObject<Env> {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS revisions (
      version INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, deleted INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, blob TEXT NOT NULL, operationId TEXT NOT NULL UNIQUE, digest TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS revisions_id ON revisions(id, version);
    CREATE TABLE IF NOT EXISTS heads (id TEXT PRIMARY KEY, version INTEGER NOT NULL);`);
  }
  private row(id: string, version?: number): Row | undefined {
    return this.ctx.storage.sql.exec<Row>(version === undefined
      ? 'SELECT r.* FROM revisions r JOIN heads h ON r.version=h.version WHERE h.id=?'
      : 'SELECT * FROM revisions WHERE id=? AND version=?', ... (version === undefined ? [id] : [id, version])).toArray()[0];
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/heads') {
        const rows = this.ctx.storage.sql.exec<Row>('SELECT r.* FROM heads h JOIN revisions r ON h.version=r.version ORDER BY r.version').toArray();
        return json({ heads: rows.map(head), cursor: rows.at(-1)?.version ?? 0 });
      }
      const match = /^\/(objects|history)\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!match) return json({ error: 'not_found' }, 404);
      const [, resource, id] = match;
      if (resource === 'history' && request.method === 'GET') {
        const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(before) || before < 1) return json({ error: 'invalid_version' }, 400);
        const rows = this.ctx.storage.sql.exec<Row>('SELECT * FROM revisions WHERE id=? AND version<? ORDER BY version DESC LIMIT 100', id, before).toArray();
        return json({ versions: rows.map(head), before: rows.length === 100 ? rows.at(-1)!.version : null });
      }
      if (resource === 'objects' && request.method === 'GET') {
        const rawVersion = url.searchParams.get('version');
        const version = rawVersion === null ? undefined : Number(rawVersion);
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) return json({ error: 'invalid_version' }, 400);
        const row = this.row(id, version);
        if (!row) return json({ error: 'not_found' }, 404);
        const object = await this.env.BLOBS.get(row.blob);
        if (!object) return json({ error: 'blob_unavailable' }, 503);
        return json({ ...head(row), payload: await object.text() });
      }
      if (resource === 'objects' && request.method === 'PUT') {
        const body = await boundedBody(request);
        // An explicit queue serializes R2 awaits without blockConcurrencyWhile's 30-second timeout.
        const operation = this.writes.then(() => this.put(id, body));
        this.writes = operation.catch(() => undefined);
        return await operation;
      }
      return json({ error: 'method_not_allowed' }, 405);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'storage_unavailable' }, 503);
    }
  }
  private async put(id: string, body: string): Promise<Response> {
    let data: { base: number; payload: string; deleted: boolean; operationId: string };
    try { data = JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!data || !Number.isSafeInteger(data.base) || data.base < 0 || typeof data.deleted !== 'boolean'
      || typeof data.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.operationId)
      || typeof data.payload !== 'string' || data.payload.length < 4 || data.payload.length > MAX_PAYLOAD
      || data.payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.payload)) return json({ error: 'invalid_object' }, 400);
    const checksum = await digest(JSON.stringify([id, data.base, data.deleted, data.payload]));
    const prior = this.ctx.storage.sql.exec<Row & { digest: string }>('SELECT * FROM revisions WHERE operationId=?', data.operationId).toArray()[0];
    if (prior) return prior.digest === checksum ? json(head(prior)) : json({ error: 'operation_id_reused' }, 409);
    const current = this.row(id);
    if ((current?.version ?? 0) !== data.base) return json({ error: 'conflict', head: current ? head(current) : null }, 409);
    if (!current && this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM heads').one().count >= MAX_OBJECTS)
      return json({ error: 'vault_object_limit' }, 413);
    // Unique keys keep an interrupted R2 upload from overwriting any committed revision.
    const blob = `${this.ctx.id.toString()}/${crypto.randomUUID()}`;
    await this.env.BLOBS.put(blob, data.payload, { httpMetadata: { contentType: 'application/octet-stream' } });
    const updatedAt = Date.now();
    const row = this.ctx.storage.transactionSync(() => {
      const created = this.ctx.storage.sql.exec<Row>('INSERT INTO revisions(id,deleted,updatedAt,blob,operationId,digest) VALUES(?,?,?,?,?,?) RETURNING *', id, Number(data.deleted), updatedAt, blob, data.operationId, checksum).one();
      this.ctx.storage.sql.exec('INSERT INTO heads(id,version) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version', id, created.version);
      return created;
    });
    return json(head(row));
  }
}
