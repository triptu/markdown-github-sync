import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
const token = 'test-token-with-at-least-32-characters';
const vault = 'test-vault-1234567890';
const id = 'a'.repeat(64);
const payload = btoa('opaque encrypted envelope');
const url = (suffix, name = vault) => `https://sync.test/v1/vaults/${name}${suffix}`;
function request(suffix, init = {}, name = vault) {
  return mf.dispatchFetch(url(suffix, name), { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers }});
}
function put(objectId, base, operationId, deleted = false, content = payload) {
  return request(`/objects/${objectId}`, { method: 'PUT', body: JSON.stringify({ base, operationId, deleted, payload: content }) });
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "sync", modules: true, scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-02-01', bindings: { SYNC_TOKEN: token },
    durableObjects: { VAULTS: { className: 'Vault', useSQLite: true } }, r2Buckets: ['BLOBS'] }] }));
  await mf.ready;
});
after(async () => { await mf?.dispose(); });

test('rejects unauthenticated requests and accepts CORS preflight', async () => {
  assert.equal((await mf.dispatchFetch(url('/heads'))).status, 401);
  assert.equal((await mf.dispatchFetch(url('/heads'), { method: 'OPTIONS' })).status, 204);
});
test('CAS serializes simultaneous writes, supports durable retry, history, tombstones and vault isolation', async () => {
  const [a, b] = await Promise.all([put(id, 0, 'operation-00000001'), put(id, 0, 'operation-00000002')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? 'operation-00000001' : 'operation-00000002';
  const initial = await (a.status === 200 ? a : b).json();
  assert.equal(initial.version, 1);
  assert.equal((await put(id, 0, winner)).status, 200);
  assert.equal((await put(id, 0, winner, false, btoa('changed'))).status, 409);
  const stored = await (await request(`/objects/${id}`)).json();
  assert.equal(stored.payload, payload);
  const deleted = await (await put(id, initial.version, 'operation-00000003', true)).json();
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.version, 2);
  const retry = await (await put(id, 0, winner)).json();
  assert.equal(retry.version, 1); // Retry returns original result even after later commits.
  const old = await (await request(`/objects/${id}?version=1`)).json();
  assert.equal(old.deleted, false);
  const history = await (await request(`/history/${id}`)).json();
  assert.deepEqual(history.versions.map(v => v.version), [2, 1]);
  const heads = await (await request('/heads')).json();
  assert.equal(heads.heads.length, 1);
  assert.equal(heads.cursor, 2);
  assert.equal(heads.heads[0].deleted, true);
  const other = await (await request('/heads', {}, 'another-vault-123456')).json();
  assert.deepEqual(other.heads, []);
});
test('validates metadata, versions and encoded payload', async () => {
  assert.equal((await put('b'.repeat(64), -1, 'operation-00000004')).status, 400);
  assert.equal((await put('b'.repeat(64), 0, 'short')).status, 400);
  assert.equal((await put('b'.repeat(64), 0, 'operation-00000005', false, 'plaintext!')).status, 400);
  assert.equal((await request(`/objects/${id}?version=NaN`)).status, 400);
  assert.equal((await request(`/objects/${'f'.repeat(64)}`)).status, 404);
});
