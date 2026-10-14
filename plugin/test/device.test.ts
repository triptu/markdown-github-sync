import { test } from "node:test";
import assert from "node:assert/strict";
import { damagedIdentity, installationId, installationKey } from "../src/device";

const storage = (value?: unknown) => {
  const saved = new Map<string, unknown>(value === undefined ? [] : [[installationKey, value]]);
  return { saved, loadLocalStorage: (key: string) => saved.get(key) ?? null, saveLocalStorage: (key: string, next: unknown) => { saved.set(key, next); } };
};
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("returns a stored canonical id unchanged", () => {
  assert.equal(installationId(storage(ID), { create: true }), ID);
  assert.equal(installationId(storage(ID), { create: false }), ID);
});

test("a missing id is null, or created and saved once with create", () => {
  assert.equal(installationId(storage(), { create: false }), null);
  const store = storage();
  const created = installationId(store, { create: true });
  assert.match(created, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(store.saved.get(installationKey), created);
  assert.equal(installationId(store, { create: true }), created);
});

test("a damaged id throws instead of naming journals or ledger refs", () => {
  for (const value of [42, { id: ID }, "not-a-uuid", ID.toUpperCase(), "-".repeat(36)]) {
    assert.throws(() => installationId(storage(value), { create: true }), { message: damagedIdentity });
    assert.throws(() => installationId(storage(value), { create: false }), { message: damagedIdentity });
  }
});

test("nonString: missing reads a non-string value as absent, but a malformed string still throws", () => {
  assert.equal(installationId(storage(42), { create: false, nonString: "missing" }), null);
  assert.throws(() => installationId(storage("not-a-uuid"), { create: false, nonString: "missing" }), { message: damagedIdentity });
});
