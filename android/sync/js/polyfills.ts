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
define(globalThis, "queueMicrotask", (callback: () => void): void => { void Promise.resolve().then(callback); });

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
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    const target = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    target.set(host.randomBytes(target.length));
    return array;
  },
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

// ---- URL (absolute http(s) URLs only: archive redirects and history queries) -
class URLSearchParamsPolyfill {
  private entries: [string, string][] = [];
  constructor(init?: string | Record<string, string>) {
    if (typeof init === "string") {
      for (const part of init.replace(/^\?/, "").split("&")) {
        if (!part) continue;
        const [key, value = ""] = part.split("=");
        this.entries.push([decodeURIComponent(key.replace(/\+/g, " ")), decodeURIComponent(value.replace(/\+/g, " "))]);
      }
    } else if (init) for (const [key, value] of Object.entries(init)) this.entries.push([key, String(value)]);
  }
  get(key: string): string | null { return this.entries.find(([k]) => k === key)?.[1] ?? null; }
  set(key: string, value: string): void {
    const index = this.entries.findIndex(([k]) => k === key);
    this.entries = this.entries.filter(([k], i) => k !== key || i === index);
    if (index >= 0) this.entries[index] = [key, String(value)]; else this.entries.push([key, String(value)]);
  }
  append(key: string, value: string): void { this.entries.push([key, String(value)]); }
  toString(): string { return this.entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"); }
}
class URLPolyfill {
  protocol!: string; username!: string; password!: string; hostname!: string; port!: string; pathname!: string; search!: string; hash!: string;
  constructor(input: string, base?: string) {
    const text = String(input);
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(text);
    if (!absolute) {
      if (base === undefined) throw new TypeError(`Invalid URL: ${text}`);
      const root = new URLPolyfill(base);
      const path = text.startsWith("/") ? text : root.pathname.replace(/[^/]*$/, "") + text;
      return new URLPolyfill(`${root.protocol}//${root.host}${path}`);
    }
    const match = /^([a-z][a-z0-9+.-]*:)\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text);
    if (!match) throw new TypeError(`Invalid URL: ${text}`);
    this.protocol = match[1].toLowerCase();
    this.username = match[2] ?? "";
    this.password = match[3] ?? "";
    this.hostname = match[4].toLowerCase();
    this.port = match[5] ?? "";
    this.pathname = match[6] || "/";
    this.search = match[7] && match[7] !== "?" ? match[7] : "";
    this.hash = match[8] ?? "";
  }
  get host(): string { return this.port ? `${this.hostname}:${this.port}` : this.hostname; }
  get origin(): string { return `${this.protocol}//${this.host}`; }
  get searchParams(): URLSearchParamsPolyfill { return new URLSearchParamsPolyfill(this.search); }
  get href(): string {
    const auth = this.username ? `${this.username}${this.password ? `:${this.password}` : ""}@` : "";
    return `${this.protocol}//${auth}${this.host}${this.pathname}${this.search}${this.hash}`;
  }
  toString(): string { return this.href; }
}
define(globalThis, "URL", URLPolyfill);
define(globalThis, "URLSearchParams", URLSearchParamsPolyfill);
