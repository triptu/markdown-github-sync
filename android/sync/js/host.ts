// Functions the Kotlin host defines on `globalThis.__host` before this bundle
// runs (see EngineRuntime.kt). Bytes cross the boundary as Uint8Array; larger
// structured values cross as JSON strings.
export interface Host {
  digest(algorithm: string, bytes: Uint8Array): Uint8Array;
  utf8Encode(text: string): Uint8Array;
  /** Throws when `fatal` and the bytes are not valid UTF-8. Never strips a BOM. */
  utf8Decode(bytes: Uint8Array, fatal: boolean): string;
  base64Encode(bytes: Uint8Array): string;
  /** Strict standard alphabet with padding; throws on anything else. */
  base64Decode(text: string): Uint8Array;
  randomBytes(count: number): Uint8Array;
  log(message: string): void;
  sleep(milliseconds: number): Promise<void>;
  /** JSON request in, JSON `{ status, headers, body }` out (body is text). */
  http(request: string): Promise<string>;
  /** Raw bytes GET that follows redirects: `[status, headersJson, bytes]`. */
  archive(request: string): Promise<[number, string, Uint8Array]>;
  token(): Promise<string>;
  progress(done: number, total: number): void;
  /** Journal directory operations, paths relative to the journal root. */
  journal(operation: "exists" | "mkdir" | "read" | "write" | "rename" | "list" | "remove", path: string, argument: string | null): string;
  /** JSON `[[path, size, mtime, executable], ...]` for every file outside hidden directories. */
  vaultList(): string;
  /** JSON `{ data, oid, size, mtime }`, `{ oversize: size }`, or `null` when missing. */
  vaultRead(path: string): string;
  /** Compare-and-swap; returns `applied`, `changed` or `blocked:<reason>`. */
  vaultApply(path: string, expectedOid: string | null, nextData: string | null, nextOid: string | null, executable: boolean): string;
}

export const host: Host = Reflect.get(globalThis, "__host");
if (typeof host !== "object" || host === null) throw new Error("The sync host is missing.");

/** A Uint8Array that owns its whole buffer, so the host sees exactly these bytes. */
export function exact(bytes: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
}
