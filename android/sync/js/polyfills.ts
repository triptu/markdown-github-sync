// Web APIs the engine uses that QuickJS lacks. Heavy work (hashing, UTF-8,
// base64) goes to the host's native code. Must be imported before the engine:
// codec.ts feature-detects Uint8Array base64 support when it loads.
import { exact, host } from "./host";

const define = (target: object, name: string, value: unknown): void => {
  if (Reflect.get(target, name) === undefined)
    Object.defineProperty(target, name, { value, writable: true, configurable: true });
};

// ---- Timers and microtasks -------------------------------------------------
let nextTimer = 1;
const cancelled = new Set<number>();
define(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]): number => {
  const id = nextTimer++;
  void host.sleep(Math.max(0, Number(milliseconds) || 0)).then(() => {
    if (!cancelled.delete(id)) callback(...args);
  });
  return id;
});
define(globalThis, "clearTimeout", (id: number): void => { if (typeof id === "number" && id < nextTimer) cancelled.add(id); });

// ---- Text ------------------------------------------------------------------
class TextEncoderPolyfill {
  readonly encoding = "utf-8";
  encode(text = ""): Uint8Array { return host.utf8Encode(String(text)); }
}
class TextDecoderPolyfill {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`Unsupported encoding: ${label}`);
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return "";
    let text: string;
    try { text = host.utf8Decode(exact(input), this.fatal); }
    catch { throw new TypeError("The encoded data was not valid utf-8"); }
    return !this.ignoreBOM && text.startsWith("﻿") ? text.slice(1) : text;
  }
}
define(globalThis, "TextEncoder", TextEncoderPolyfill);
define(globalThis, "TextDecoder", TextDecoderPolyfill);

// ---- Base64 ----------------------------------------------------------------
define(Uint8Array.prototype, "toBase64", function (this: Uint8Array): string { return host.base64Encode(exact(this)); });
define(Uint8Array, "fromBase64", (text: string): Uint8Array => {
  if (typeof text !== "string") throw new TypeError("Expected a base64 string");
  return host.base64Decode(text);
});
const latin1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) throw new Error("Invalid character");
    bytes[i] = code;
  }
  return bytes;
};
define(globalThis, "btoa", (text: string): string => host.base64Encode(latin1(String(text))));
define(globalThis, "atob", (text: string): string => {
  const bytes = host.base64Decode(String(text).replace(/[\t\n\f\r ]/g, ""));
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
});

// ---- Crypto ----------------------------------------------------------------
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const cryptoPolyfill = {
  randomUUID(): string {
    const bytes = host.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = hex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
  subtle: {
    async digest(algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name !== "SHA-1" && name !== "SHA-256") throw new Error(`Unsupported digest: ${name}`);
      return exact(host.digest(name, exact(data))).buffer as ArrayBuffer;
    },
  },
};
define(globalThis, "crypto", cryptoPolyfill);

// ---- structuredClone (plain data only, which is all the engine clones) ------
function clone(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(clone(item, seen));
    return out;
  }
  if (value instanceof Map || value instanceof Set) throw new Error("structuredClone: unsupported type");
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = clone(Reflect.get(value, key), seen);
  return out;
}
define(globalThis, "structuredClone", (value: unknown) => clone(value));

// ---- URL: only what github.ts reads. Absolute URLs only; anything else throws,
// which the engine treats as an unusable archive redirect. ----------------------
class URLSearchParamsPolyfill {
  private entries: [string, string][];
  constructor(init: Record<string, string> = {}) { this.entries = Object.entries(init).map(([k, v]) => [k, String(v)]); }
  set(key: string, value: string): void {
    this.entries = this.entries.filter(([k]) => k !== key);
    this.entries.push([key, String(value)]);
  }
  toString(): string { return this.entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"); }
}
class URLPolyfill {
  readonly protocol: string; readonly username: string; readonly password: string; readonly hostname: string; readonly href: string;
  constructor(input: string) {
    const href = String(input);
    const match = /^([a-z][a-z0-9+.-]*:)\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::\d+)?(?:[/?#].*)?$/i.exec(href);
    if (!match) throw new TypeError(`Invalid URL: ${href}`);
    this.protocol = match[1].toLowerCase();
    this.username = match[2] ?? "";
    this.password = match[3] ?? "";
    this.hostname = match[4].toLowerCase();
    this.href = href;
  }
}
define(globalThis, "URL", URLPolyfill);
define(globalThis, "URLSearchParams", URLSearchParamsPolyfill);

