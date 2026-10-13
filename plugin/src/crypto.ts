export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function base64ToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Error("Invalid base64");
  const raw = atob(text);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export function generateSecret(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}
export function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\\\x00-\x1f\x7f:]/.test(path) &&
    path
      .split("/")
      .every(
        (p) => p.length > 0 && p !== "." && p !== ".." && !p.startsWith("."),
      )
  );
}
export function equalBytes(
  a: Uint8Array | null,
  b: Uint8Array | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.length === b.length && a.every((v, i) => v === b[i]);
}
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function contentHash(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}
export interface PlainObject {
  path: string;
  content: string | null;
  mtime: number;
  deleted: boolean;
}
export class VaultCrypto {
  private constructor(
    private vault: string,
    private encryption: CryptoKey,
    private naming: CryptoKey,
  ) {}
  static async create(vault: string, secret: string): Promise<VaultCrypto> {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(vault))
      throw new Error("Invalid vault ID");
    const raw = base64ToBytes(secret);
    if (raw.length !== 32)
      throw new Error("Sync secret must contain 32 random bytes");
    const key = await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const derive = (
      info: string,
      algorithm: AesKeyGenParams | HmacImportParams,
      usage: KeyUsage[],
    ) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode(vault),
          info: encoder.encode(info),
        },
        key,
        algorithm,
        false,
        usage,
      );
    return new VaultCrypto(
      vault,
      await derive(
        "open-vault-sync/encryption/v1",
        { name: "AES-GCM", length: 256 },
        ["encrypt", "decrypt"],
      ),
      await derive(
        "open-vault-sync/naming/v1",
        { name: "HMAC", hash: "SHA-256", length: 256 },
        ["sign"],
      ),
    );
  }
  async id(path: string): Promise<string> {
    if (!validPath(path)) throw new Error("Unsafe or excluded path");
    return hex(
      await crypto.subtle.sign("HMAC", this.naming, encoder.encode(path)),
    );
  }
  private aad(id: string): Uint8Array {
    return encoder.encode(
      JSON.stringify(["open-vault-sync", 1, this.vault, id]),
    );
  }
  async seal(id: string, object: PlainObject): Promise<string> {
    if ((await this.id(object.path)) !== id)
      throw new Error("Object path mismatch");
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: this.aad(id) as BufferSource,
        },
        this.encryption,
        encoder.encode(JSON.stringify(object)),
      ),
    );
    const result = new Uint8Array(13 + encrypted.length);
    result[0] = 1;
    result.set(nonce, 1);
    result.set(encrypted, 13);
    return bytesToBase64(result);
  }
  async open(
    id: string,
    payload: string,
    deleted: boolean,
  ): Promise<PlainObject> {
    if (payload.length > 16 * 1024 * 1024)
      throw new Error("Remote payload exceeds limit");
    const bytes = base64ToBytes(payload);
    if (bytes.length < 30 || bytes[0] !== 1)
      throw new Error("Unsupported encrypted payload");
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(1, 13) as BufferSource,
        additionalData: this.aad(id) as BufferSource,
      },
      this.encryption,
      bytes.subarray(13) as BufferSource,
    );
    const object = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plain),
    ) as PlainObject;
    if (
      typeof object.path !== "string" ||
      !validPath(object.path) ||
      object.deleted !== deleted ||
      !Number.isFinite(object.mtime) ||
      object.mtime < 0 ||
      (await this.id(object.path)) !== id ||
      (deleted ? object.content !== null : typeof object.content !== "string")
    )
      throw new Error("Invalid encrypted object");
    if (
      object.content !== null &&
      base64ToBytes(object.content).length > MAX_FILE_BYTES
    )
      throw new Error("File exceeds size limit");
    return object;
  }
}
