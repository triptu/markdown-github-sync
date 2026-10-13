import ignore from "ignore";
import { hashBlob, isOid, isValidPath } from "./codec";

export type HiddenClass = "content" | "config-inert" | "config-live" | "ignored" | "denied" | "outside";

export interface ScopeRules {
  rules: "visible-only" | "config/1";
  configDir: string;
  /** Object ID of the committed root .gitignore, or null when absent. */
  gitignore: string | null;
}

export interface Scope {
  readonly rules: Readonly<ScopeRules>;
  /** SHA-1 of the built-in policy version and the canonical ScopeRules JSON. */
  readonly digest: string;
  classify(path: string): HiddenClass;
  includes(path: string): boolean;
  isLive(path: string): boolean;
  /** Applies only to a local hidden file absent from the remote checkpoint. */
  newHiddenPolicy(path: string): "auto" | "consent";
}

export interface TransactionScope {
  /** Intersection of parent, remote and local scopes; exclusion by any one wins. */
  includes(path: string): boolean;
  classify(path: string): HiddenClass;
}

export class ScopeError extends Error {
  override name = "ScopeError";
}

export class UnsupportedNestedGitignoreError extends ScopeError {
  override name = "UnsupportedNestedGitignoreError";
  constructor(readonly path: string) {
    super(`Nested .gitignore is unsupported: ${path}`);
  }
}

const BUILTIN_VERSION = "scope-policy/2";
const MAX_GITIGNORE_BYTES = 64 * 1024;
const COMPETING_SYNC_PLUGINS = new Set([
  "obsidian-git", "obsidian-livesync", "remotely-save", "remotely-sync", "cloud-vault-sync",
]);
const OS_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SECRET_NAMES = new Set([
  "todoist-token", "token", "token.json", "tokens.json", "secret", "secret.json",
  "secrets.json", "credentials", "credentials.json", "auth-token", "auth-token.json",
  "id_rsa", "id_ed25519",
]);

function sha1(bytes: Uint8Array): string {
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(length - 4, (bytes.length * 8) >>> 0);
  const words = new Uint32Array(80);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const n = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (n << 1) | (n >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const next = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = next;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

function blobOid(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return sha1(object);
}

function isNestedGitignore(path: string): boolean {
  return path !== ".gitignore" && path.endsWith("/.gitignore");
}

/** Run over the full remote tree and the full local path inventory before config/1 activation. */
export function assertNoNestedGitignore(paths: Iterable<string>): void {
  for (const path of paths) {
    if (!isValidPath(path)) throw new ScopeError(`Invalid tree path: ${JSON.stringify(path)}`);
    if (isNestedGitignore(path)) throw new UnsupportedNestedGitignoreError(path);
  }
}

function denied(path: string, configDir: string): boolean {
  const segments = path.split("/");
  if (segments.some((part) => part === ".git" || part === ".git-vault-sync" ||
    part.startsWith(".git-vault-sync-export-") || part === ".trash" || OS_METADATA.has(part))) return true;
  // .obsidian remains a reserved vault location even if a device uses a
  // different configured directory and pauses configuration sync.
  if (segments[0] !== configDir && segments[0] !== ".obsidian") return false;
  if (segments.length === 1) return true;
  const [, first, second] = segments;
  if (first === "workspace" || first === "workspace.json" || first === "workspace-mobile.json" || first === "cache") return true;
  if (first === "plugins" && (second === "github-vault-sync" || COMPETING_SYNC_PLUGINS.has(second))) return true;
  if (segments.slice(1).some((part) => SECRET_NAMES.has(part) || part === ".env" ||
    part.startsWith(".env.") || /\.(?:pem|p12|pfx|key)$/.test(part))) return true;
  // `plugins/<id>/data.json` is eligible when already tracked, but a new local
  // file there still requires exact-version consent, regardless of plugin id.
  return false;
}

function validateRules(rules: ScopeRules, text: string | null): Readonly<ScopeRules> {
  if (rules.rules !== "visible-only" && rules.rules !== "config/1") throw new ScopeError("Unknown scope rule version");
  if (!isValidPath(rules.configDir) || rules.configDir.includes("/") ||
    !rules.configDir.startsWith(".") ||
    [".git", ".git-vault-sync", ".gitignore", ".trash", ".DS_Store", ".env"].includes(rules.configDir) ||
    rules.configDir.startsWith(".git-vault-sync-export-")) throw new ScopeError("Invalid configuration directory");
  if (rules.rules === "visible-only") {
    if (rules.gitignore !== null || text !== null) throw new ScopeError("Legacy visible-only scope cannot use .gitignore");
  } else {
    if (rules.gitignore !== null && !isOid(rules.gitignore)) throw new ScopeError("Invalid .gitignore object ID");
    if ((rules.gitignore === null) !== (text === null)) throw new ScopeError(".gitignore object ID and text disagree");
    if (text !== null) {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_GITIGNORE_BYTES) throw new ScopeError(".gitignore exceeds 64 KiB");
      if (blobOid(bytes) !== rules.gitignore) throw new ScopeError(".gitignore bytes do not match the object ID");
    }
  }
  return Object.freeze({ rules: rules.rules, configDir: rules.configDir, gitignore: rules.gitignore });
}

/** Compile a pure per-commit policy. The caller must pause on ScopeError. */
export function compileScope(rules: ScopeRules, gitignoreText: string | null): Scope {
  const frozenRules = validateRules(rules, gitignoreText);
  const matcher = ignore({ ignoreCase: false, allowRelativePaths: false });
  if (gitignoreText !== null) matcher.add(gitignoreText);
  const digest = sha1(new TextEncoder().encode(JSON.stringify([BUILTIN_VERSION, frozenRules])));
  const classify = (path: string): HiddenClass => {
    if (!isValidPath(path)) return "denied";
    if (frozenRules.rules === "config/1" && isNestedGitignore(path)) throw new UnsupportedNestedGitignoreError(path);
    if (denied(path, frozenRules.configDir)) return "denied";
    if (frozenRules.rules === "visible-only") {
      return path.split("/").some((segment) => segment.startsWith(".")) ? "outside" : "content";
    }
    const inConfig = path.startsWith(`${frozenRules.configDir}/`);
    const hidden = path.split("/").some((segment) => segment.startsWith("."));
    if (hidden && path !== ".gitignore" && !inConfig) return "outside";
    if (path !== ".gitignore" && matcher.ignores(path)) return "ignored";
    if (!hidden) return "content";
    if (inConfig) {
      const relative = path.slice(frozenRules.configDir.length + 1).split("/");
      if ((relative.length === 1 && relative[0].endsWith(".json")) ||
        (relative.length === 3 && relative[0] === "plugins" && relative[2] === "data.json")) return "config-live";
    }
    return "config-inert";
  };
  const scope: Scope = {
    rules: frozenRules,
    digest,
    classify,
    includes: (path) => ["content", "config-inert", "config-live"].includes(classify(path)),
    isLive: (path) => classify(path) === "config-live",
    newHiddenPolicy: (path) => path === ".gitignore" && classify(path) === "config-inert" ? "auto" :
      classify(path) === "content" ? "auto" : "consent",
  };
  return Object.freeze(scope);
}

/** Resolve root .gitignore from a full tree; malformed or nested rules block activation. */
export async function scopeForTree(
  items: readonly { path: string; type: string; sha: string }[],
  readBlob: (oid: string) => Promise<Uint8Array>,
  configDir: string,
  ruleVersion: ScopeRules["rules"],
): Promise<Scope> {
  if (ruleVersion === "config/1") assertNoNestedGitignore(items.map((item) => item.path));
  if (ruleVersion === "visible-only") return compileScope({ rules: ruleVersion, configDir, gitignore: null }, null);
  const matches = items.filter((item) => item.path === ".gitignore");
  if (matches.length > 1) throw new ScopeError("Duplicate root .gitignore entry");
  const entry = matches[0];
  if (!entry) return compileScope({ rules: ruleVersion, configDir, gitignore: null }, null);
  if (entry.type !== "blob" || !isOid(entry.sha)) throw new ScopeError("Invalid root .gitignore tree entry");
  const bytes = await readBlob(entry.sha);
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_GITIGNORE_BYTES) throw new ScopeError("Unreadable root .gitignore");
  if ((await hashBlob(bytes)) !== entry.sha) throw new ScopeError("Root .gitignore object ID mismatch");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ScopeError("Root .gitignore is not valid UTF-8"); }
  return compileScope({ rules: ruleVersion, configDir, gitignore: entry.sha }, text);
}

/** Local text is compiled separately so a new ignore rule blocks its own transaction's upload. */
export function freezeTransactionScope(parent: Scope, remote: Scope, localGitignoreText: string | null): TransactionScope {
  if (parent.rules.rules !== remote.rules.rules || parent.rules.configDir !== remote.rules.configDir)
    throw new ScopeError("Transaction scope versions do not agree");
  const localOid = localGitignoreText === null ? null : blobOid(new TextEncoder().encode(localGitignoreText));
  const local = compileScope({ ...parent.rules, gitignore: localOid }, localGitignoreText);
  const classify = (path: string): HiddenClass => {
    const classes = [parent.classify(path), remote.classify(path), local.classify(path)];
    if (classes.includes("denied")) return "denied";
    if (classes.includes("outside")) return "outside";
    if (classes.includes("ignored")) return "ignored";
    return classes[0];
  };
  return Object.freeze({
    classify,
    includes: (path: string) => ["content", "config-inert", "config-live"].includes(classify(path)),
  });
}
