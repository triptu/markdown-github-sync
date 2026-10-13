import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Bundle the actual client source rather than a reimplementation of its protocol.
const bundle = await build({ stdin: { contents: "export * from './engine'; export * from './crypto';", resolveDir: new URL('../../plugin/src/', import.meta.url).pathname }, bundle: true, format: 'esm', platform: 'node', write: false });
const { SyncEngine, VaultCrypto, generateSecret, equalBytes, base64ToBytes } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const encode = value => new TextEncoder().encode(value);
const decode = value => new TextDecoder().decode(value);
class MemoryVault {
  files = new Map(); state;
  edit(path, content) { this.files.set(path, { data: typeof content === 'string' ? encode(content) : content.slice(), mtime: Date.now() }); }
  text(path) { return decode(this.files.get(path).data); }
  async list() { return [...this.files.keys()]; }
  async read(path) { const file = this.files.get(path); return file ? { ...file, data: file.data.slice() } : null; }
  async write(path, data, mtime, expected) {
    if (!equalBytes(this.files.get(path)?.data ?? null, expected)) return false;
    this.files.set(path, {data: data.slice(),mtime}); return true;
  }
  async remove(path, expected) {
    if (!equalBytes(this.files.get(path)?.data ?? null, expected)) return false;
    this.files.delete(path); return true;
  }
}
test('real encrypted client engines converge through Cloudflare storage, preserve conflicts and recover history', async () => {
  const token = 'integration-token-at-least-32-characters';
  const vaultId = 'integration-vault-12345';
  const secret = generateSecret();
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{name:'integration',modules:true,
    scriptPath:new URL('../dist/index.js',import.meta.url).pathname,compatibilityDate:'2026-02-01',
    bindings:{SYNC_TOKEN:token},durableObjects:{VAULTS:{className:'Vault',useSQLite:true}},r2Buckets:['BLOBS']}] }));
  try {
    await mf.ready;
    const call = async (path, body) => {
      const response = await mf.dispatchFetch(`https://sync.test/v1/vaults/${vaultId}${path}`, {
        method: body ? 'PUT' : 'GET', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        ...(body ? {body:JSON.stringify(body)} : {})
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error),{status:response.status});
      return result;
    };
    const transport = {
      heads:() => call('/heads'),
      get:(id,version) => call(`/objects/${id}${version === undefined ? '' : `?version=${version}`}`),
      put:(id,input) => call(`/objects/${id}`,input)
    };
    const client = (port, saved = port.state, key = secret) => new SyncEngine({vaultId,secret:key,port,transport,state:saved,saveState:async state => {port.state=structuredClone(state);}});
    const laptop = new MemoryVault(); const phone = new MemoryVault();
    laptop.edit('Notes/hello.md','hello laptop'); laptop.edit('Notes/keep.md','keep me'); laptop.edit('files/photo.bin',new Uint8Array([0,255,3,128]));
    const a=client(laptop); const b=client(phone);
    assert.equal((await a.sync()).uploaded,3);
    assert.equal((await b.sync()).downloaded,3);
    assert.equal(phone.text('Notes/hello.md'),'hello laptop');
    assert.deepEqual(phone.files.get('files/photo.bin').data,new Uint8Array([0,255,3,128]));
    phone.edit('Notes/hello.md','phone update');
    assert.equal((await b.sync()).uploaded,1);
    await a.sync(); assert.equal(laptop.text('Notes/hello.md'),'phone update');

    // Offline divergent edits retain the losing edit in a normal synced sibling.
    laptop.edit('Notes/hello.md','laptop divergent'); phone.edit('Notes/hello.md','phone divergent');
    await a.sync();
    assert.equal((await b.sync()).conflicts,1);
    assert.equal(phone.text('Notes/hello.md'),'laptop divergent');
    const conflict = [...phone.files.keys()].find(path => path.includes('(conflict '));
    assert.ok(conflict); assert.equal(phone.text(conflict),'phone divergent');
    await b.sync(); await a.sync(); assert.equal(laptop.text(conflict),'phone divergent');

    laptop.files.delete('Notes/keep.md');
    assert.equal((await a.sync()).uploaded,1); await b.sync();
    assert.equal(phone.files.has('Notes/keep.md'),false);
    // A new device with no baseline learns retained tombstones and current content.
    const rejoin = new MemoryVault(); await client(rejoin).sync();
    assert.equal(rejoin.files.has('Notes/keep.md'),false);
    assert.equal(rejoin.text('Notes/hello.md'),'laptop divergent');
    assert.equal(rejoin.text(conflict),'phone divergent');
    // Rejoining with stale local content preserves it before applying a tombstone.
    const stale = new MemoryVault(); stale.edit('Notes/keep.md','offline stale copy');
    assert.equal((await client(stale).sync()).conflicts,1);
    assert.equal(stale.files.has('Notes/keep.md'),false);
    assert.ok([...stale.files.keys()].some(path => path.includes('keep (conflict ') && stale.text(path)==='offline stale copy'));

    const crypt = await VaultCrypto.create(vaultId,secret);
    const id = await crypt.id('Notes/hello.md');
    const history = await call(`/history/${id}`);
    assert.equal(history.versions.length,3);
    const originalHead = history.versions.at(-1);
    const original = await transport.get(id,originalHead.version);
    assert.equal(original.payload.includes('hello laptop'),false);
    const decrypted = await crypt.open(id,original.payload,original.deleted);
    assert.equal(decode(base64ToBytes(decrypted.content)),'hello laptop');
    // Authenticated decryption fails before any writes when a new device has the wrong key.
    const wrong = new MemoryVault(); wrong.edit('unrelated.md','do not touch');
    await assert.rejects(client(wrong,undefined,generateSecret()).sync());
    assert.deepEqual([...wrong.files.keys()],['unrelated.md']);
    // A client restored from its persisted baseline remains a no-op when converged.
    assert.deepEqual(await client(phone).sync(),{uploaded:0,downloaded:0,conflicts:0,deferred:0});
  } finally { await mf.dispose(); }
});
