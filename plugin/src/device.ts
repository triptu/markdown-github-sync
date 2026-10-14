/** This device's sync identity, kept in Obsidian's per-vault local storage (never synced). */
export const installationKey = "github-vault-sync-installation-v2";

/** Canonical lowercase UUID, the form `crypto.randomUUID()` writes and GitHubRepository requires. */
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const damagedIdentity = "This device's sync identity is damaged. Reinstall the plugin's data or contact support before syncing again.";

export interface DeviceStorage {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}

/**
 * Reads this device's installation id. A missing id is null, or with `create`
 * a fresh one that is saved first. A stored value that isn't a canonical id
 * throws, so a damaged identity never names journals or ledger refs.
 * `nonString: "missing"` treats a stored non-string value as missing, for
 * callers that only read and never relied on it.
 */
export function installationId(storage: DeviceStorage, options: { create: true; nonString?: "missing" }): string;
export function installationId(storage: DeviceStorage, options: { create: boolean; nonString?: "missing" }): string | null;
export function installationId(storage: DeviceStorage, { create, nonString }: { create: boolean; nonString?: "missing" }): string | null {
  let value: unknown = storage.loadLocalStorage(installationKey);
  if (nonString === "missing" && typeof value !== "string") value = null;
  if (value === null || value === undefined) {
    if (!create) return null;
    value = crypto.randomUUID();
    storage.saveLocalStorage(installationKey, value);
  }
  if (typeof value !== "string" || !CANONICAL.test(value)) throw new Error(damagedIdentity);
  return value;
}
