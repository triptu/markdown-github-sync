// Byte, identity and path rules shared by the engine. Browser-compatible: only
// Web Crypto, TextEncoder/TextDecoder and atob/btoa are used.
import type { Entry, FileMode, Snapshot } from "./contracts";
import type { Scope } from "./scope";

/** The identity of file content without its bytes. */
export type Ref = Pick<Entry, "oid" | "mode">;
/** A snapshot reduced to identities; what a coherent commit checkpoint stores. */
export type Manifest = Record<string, Ref>;

/** Content failed verification: wrong hash, invalid encoding, path or mode. */
export class IntegrityError extends Error {
  override name = "IntegrityError";
}

/** File dictionaries must never consult Object.prototype, including at port boundaries. */
export function dictionary<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const result: Record<string, T> = Object.create(null);
  for (const [key, value] of entries) result[key] = value;
  return result;
}

export function own<T>(values: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

const OID = /^[0-9a-f]{40}$/;
const CHUNK = 0x8000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

// Native one-call conversions (recent Chromium/Android WebView); feature-detected.
const nativeToBase64: ((this: Uint8Array) => string) | undefined =
  typeof Reflect.get(Uint8Array.prototype, "toBase64") === "function" ? Reflect.get(Uint8Array.prototype, "toBase64") : undefined;
const nativeFromBase64: ((text: string) => Uint8Array<ArrayBuffer>) | undefined =
  typeof Reflect.get(Uint8Array, "fromBase64") === "function" ? Reflect.get(Uint8Array, "fromBase64") : undefined;

/** Portable encoder: bounded `apply` chunks avoid both argument-spread overhead and stack limits. */
export function encodeBase64Portable(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

export function encodeBase64(bytes: Uint8Array): string {
  return nativeToBase64 ? nativeToBase64.call(bytes) : encodeBase64Portable(bytes);
}

/**
 * Decoded byte length of canonical padded base64 without decoding it, or a
 * reason it is not canonical. Canonical means: standard alphabet, length a
 * multiple of 4, at most two trailing `=`, and zero padding bits, which is
 * exactly the set of strings for which `btoa(atob(text)) === text`.
 */
export function base64Length(text: string): number | "invalid" | "noncanonical" {
  if (text.length % 4 !== 0 || !BASE64_SHAPE.test(text)) return "invalid";
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (pad > 0 && (ALPHABET.indexOf(text[text.length - pad - 1]) & (pad === 2 ? 0b1111 : 0b11)) !== 0) return "noncanonical";
  return (text.length / 4) * 3 - pad;
}

/** Decodes base64 already checked by `base64Length`. */
export function decodeCheckedBase64(text: string): Uint8Array<ArrayBuffer> {
  if (nativeFromBase64) return nativeFromBase64(text);
  return decodeBase64Portable(text);
}

/** Portable decoder for base64 already checked by `base64Length`. */
export function decodeBase64Portable(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** Strict decoding: rejects whitespace, URL-safe alphabets and bad padding. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const length = base64Length(text);
  if (length === "invalid") throw new IntegrityError("Invalid base64 data");
  if (length === "noncanonical") throw new IntegrityError("Noncanonical base64 data");
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = decodeCheckedBase64(text); } catch { throw new IntegrityError("Invalid base64 data"); }
  if (bytes.length !== length) throw new IntegrityError("Invalid base64 data");
  return bytes;
}

/** Lets the host render between batches of synchronous per-file work. */
export function yieldToHost(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export function isOid(value: unknown): value is string {
  return typeof value === "string" && OID.test(value);
}

export function isFileMode(value: unknown): value is FileMode {
  return value === "100644" || value === "100755";
}

async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Git's blob object ID: SHA-1 over `blob <length>\0<bytes>`. */
export async function hashBlob(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return sha1Hex(object);
}

/** Stable identifier for engine records (conflicts, previews); not a Git object. */
export async function digestText(text: string): Promise<string> {
  return sha1Hex(new TextEncoder().encode(text));
}

/**
 * Entry objects whose `data` is known to be canonical base64 of bytes hashing
 * to `oid`, with the exact (oid, data) pair that was checked. Only code that
 * just hashed the very bytes it encoded may add to it. Lookups compare the
 * current fields, so mutating a trusted entry voids its trust.
 */
const trustedEntries = new WeakMap<object, { oid: string; data: string }>();

/** Marks an entry whose bytes the caller has just hashed to `entry.oid`. */
export function trustVerifiedEntry<T extends Entry>(entry: T): T {
  trustedEntries.set(entry, { oid: entry.oid, data: entry.data });
  return entry;
}

/** True for an entry whose (oid, data) pair this process verified and has not changed since. */
export function isTrustedEntry(entry: Entry): boolean {
  return isTrustedPair(entry, entry.oid, entry.data);
}

/** True when `holder` was trusted with exactly this (oid, data) pair, whatever its fields say now. */
export function isTrustedPair(holder: unknown, oid: string, data: string): boolean {
  const known = typeof holder === "object" && holder !== null ? trustedEntries.get(holder) : undefined;
  return known !== undefined && known.oid === oid && known.data === data;
}

/** A copy with another mode; keeps trust because the mode is not part of the blob identity. */
export function withMode(entry: Entry, mode: FileMode): Entry {
  const copy: Entry = { oid: entry.oid, mode, data: entry.data };
  return isTrustedEntry(entry) ? trustVerifiedEntry(copy) : copy;
}

export async function entryFromBytes(bytes: Uint8Array, mode: FileMode = "100644"): Promise<Entry> {
  // Encode and start hashing (which copies the bytes synchronously) with no
  // await in between, so both describe the same bytes even if the caller
  // later reuses its buffer.
  const data = encodeBase64(bytes);
  const oid = hashBlob(bytes);
  return trustVerifiedEntry({ oid: await oid, mode, data });
}

export async function entryFromText(text: string, mode: FileMode = "100644"): Promise<Entry> {
  return entryFromBytes(new TextEncoder().encode(text), mode);
}

/** Exact UTF-8 text including any BOM, or null when the bytes are not valid UTF-8. */
export function entryText(entry: Entry): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decodeBase64(entry.data));
  } catch {
    return null;
  }
}

/**
 * Structural validity for a repository/vault-relative path: no traversal,
 * empty or dot segments, backslashes, leading/trailing slashes or control
 * characters. Platform filename restrictions are left to the vault adapter.
 */
export function isValidPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * V1 content scope excludes every hidden segment: `.git`, `.obsidian`
 * (configuration, plugin state, workspaces), `.trash` and other dot paths.
 */
export function isExcludedPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

export function isSyncablePath(path: unknown): path is string {
  return isValidPath(path) && !isExcludedPath(path);
}

/** Key under which two paths name the same file on case/normalization-insensitive filesystems. */
export function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Same content and mode. `null`/`undefined` both mean "absent". */
export function sameEntry(a: Ref | null | undefined, b: Ref | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.oid === b.oid && a.mode === b.mode;
}

export function sameManifest(a: Manifest | Snapshot, b: Manifest | Snapshot): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((path) => sameEntry(own(a, path), own(b, path)));
}

export function toRef(entry: Ref): Ref {
  return { oid: entry.oid, mode: entry.mode };
}

export function toManifest(snapshot: Snapshot | Manifest): Manifest {
  const manifest: Manifest = dictionary();
  for (const [path, entry] of Object.entries(snapshot)) manifest[path] = toRef(entry);
  return manifest;
}

export function hasEntryShape(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const oid: unknown = Object.hasOwn(value, "oid") ? Reflect.get(value, "oid") : undefined;
  const mode: unknown = Object.hasOwn(value, "mode") ? Reflect.get(value, "mode") : undefined;
  const data: unknown = Object.hasOwn(value, "data") ? Reflect.get(value, "data") : undefined;
  return isOid(oid) && isFileMode(mode) && typeof data === "string";
}

/** Throws unless the entry's bytes hash to its oid. */
export async function verifyEntry(path: string, entry: unknown): Promise<Entry> {
  if (!hasEntryShape(entry)) throw new IntegrityError(`Malformed entry for ${path}`);
  if (isTrustedEntry(entry)) return entry;
  if ((await hashBlob(decodeBase64(entry.data))) !== entry.oid) {
    throw new IntegrityError(`Content of ${path} does not match its object ID`);
  }
  return trustVerifiedEntry(entry);
}

/** Validates structure and bytes, then membership in an explicit policy (legacy by default). */
export async function verifySnapshot(snapshot: unknown, label: string, scope?: Pick<Scope, "includes">): Promise<Snapshot> {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new IntegrityError(`${label}: snapshot is not an object`);
  }
  const verified: Snapshot = dictionary();
  let count = 0;
  for (const [path, entry] of Object.entries(snapshot)) {
    if (++count % 256 === 0) await yieldToHost();
    if (!isValidPath(path) || !(scope ? scope.includes(path) : isSyncablePath(path))) throw new IntegrityError(`${label}: unsupported or out-of-scope path ${JSON.stringify(path)}`);
    verified[path] = await verifyEntry(`${label}: ${path}`, entry);
  }
  return verified;
}
