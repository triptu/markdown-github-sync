import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const repo = 'your-name/vault-sync-test';
function api(path, body, method = body ? 'POST' : 'GET') {
  try {
    return JSON.parse(execFileSync('gh', ['api', path, '--method', method, ...(body ? ['--input', '-'] : [])], { encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, stdio: ['pipe','pipe','pipe'] }));
  } catch (error) {
    if (path === 'graphql' && typeof error.stdout === 'string') {
      const result = JSON.parse(error.stdout);
      if (Array.isArray(result.errors)) return result;
    }
    throw error;
  }
}
const metadata = api(`repos/${repo}`);
assert.equal(metadata.full_name, repo); assert.equal(metadata.private, true);
const unique = randomUUID();
const branch = `refs/heads/v2-ledger-proof-${unique}`, ledger = `refs/vault-sync/devices/proof-${unique}`;
const baseline = api(`repos/${repo}/git/ref/heads/${metadata.default_branch}`).object.sha;
const tree = api(`repos/${repo}/git/commits/${baseline}`).tree.sha;
const commit = (message, parents) => api(`repos/${repo}/git/commits`, {message, tree, parents}).sha;
const ref = name => api(`repos/${repo}/git/ref/${name.slice(5)}`).object.sha;
const zero = '0'.repeat(40);
const update = updates => api('graphql', {query: 'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }', variables: {input: {repositoryId: metadata.node_id, refUpdates: updates}}});
const change = (name, beforeOid, afterOid) => ({name, beforeOid, afterOid, force: false});
const checks = [];
const check = (name, fn) => {fn(); checks.push({name, pass: true});};
api(`repos/${repo}/git/refs`, {ref: branch, sha: baseline});
const anchor = commit('Synthetic device ledger anchor', [baseline]);
const init = update([change(ledger, zero, anchor)]);
check('custom ledger namespace can be created with absent-ref CAS', () => {assert.equal(init.errors, undefined); assert.equal(ref(ledger), anchor);});
const first = commit('Synthetic branch publication A', [baseline]);
const firstReceipt = commit('Synthetic accepted receipt A', [anchor, first]);
const accepted = update([change(branch, baseline, first), change(ledger, anchor, firstReceipt)]);
check('branch and receipt advance together', () => {assert.equal(accepted.errors, undefined); assert.equal(ref(branch), first); assert.equal(ref(ledger), firstReceipt);});
const stale = commit('Synthetic stale publication', [baseline]);
const staleReceipt = commit('Synthetic rejected receipt', [firstReceipt, stale]);
const rejected = update([change(branch, baseline, stale), change(ledger, firstReceipt, staleReceipt)]);
check('branch CAS failure leaves ledger unchanged', () => {assert.ok(rejected.errors?.length); assert.equal(ref(branch), first); assert.equal(ref(ledger), firstReceipt);});
const seal = commit('Synthetic cancellation seal', [firstReceipt]);
const sealed = update([change(ledger, firstReceipt, seal)]);
const late = commit('Synthetic late publication', [first]);
const lateReceipt = commit('Synthetic delayed accepted receipt', [firstReceipt, late]);
const delayed = update([change(branch, first, late), change(ledger, firstReceipt, lateReceipt)]);
check('cancellation seal rejects delayed publication without changing branch', () => {assert.equal(sealed.errors, undefined); assert.ok(delayed.errors?.length); assert.equal(ref(branch), first); assert.equal(ref(ledger), seal);});
const secondReceipt = commit('Synthetic accepted receipt B after seal', [seal, late]);
const second = update([change(branch, first, late), change(ledger, seal, secondReceipt)]);
const losingSeal = commit('Synthetic late cancellation', [seal]);
const lostSeal = update([change(ledger, seal, losingSeal)]);
check('publication winner prevents late cancellation', () => {assert.equal(second.errors, undefined); assert.ok(lostSeal.errors?.length); assert.equal(ref(ledger), secondReceipt); assert.equal(ref(branch), late);});
api(`repos/${repo}/git/${branch}`, {sha: baseline, force: true}, 'PATCH');
check('branch rewind leaves accepted receipt reachable', () => {assert.equal(ref(branch), baseline); assert.equal(ref(ledger), secondReceipt);});
const result = {completed: true, repo, branch, ledger, baseline, finalReceipt: secondReceipt, checks, scope: 'Live GitHub API semantics only; synthetic free-plan private repository, existing gh credential. Not engine implementation or fine-grained PAT acceptance.'};
await writeFile('docs/verification/github-ledger-probe.json', JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result, null, 2));
