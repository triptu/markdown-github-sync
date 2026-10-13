import ignore from "ignore";
import { digestText, hashBlob, isOid, isValidPath } from "./codec";

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

const BUILTIN_VERSION = "scope-policy/4";
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

/** Canonical filesystem identity used for built-in protection and tree collisions. */
export function canonicalFilesystemPath(path: string): string {
  return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

const canonicalSet = (values: Iterable<string>): Set<string> =>
  new Set(Array.from(values, canonicalFilesystemPath));
const CANONICAL_COMPETING_SYNC_PLUGINS = canonicalSet(COMPETING_SYNC_PLUGINS);
const CANONICAL_OS_METADATA = canonicalSet(OS_METADATA);
const CANONICAL_SECRET_NAMES = canonicalSet(SECRET_NAMES);
const RESERVED_CONFIG_DIRS = new Set([".git", ".git-vault-sync", ".gitignore", ".trash", ".ds_store", ".env"]);

export function assertValidConfigDir(configDir: string): void {
  if (!isValidPath(configDir) || configDir.includes("/") || !configDir.startsWith("."))
    throw new ScopeError("Invalid configuration directory");
  const canonical = canonicalFilesystemPath(configDir);
  if (!isValidPath(canonical) || canonical.includes("/") || RESERVED_CONFIG_DIRS.has(canonical) ||
    canonical.startsWith(".git-vault-sync-export-")) throw new ScopeError("Invalid configuration directory");
}

function assertSupportedGitignorePath(path: string): void {
  const canonical = canonicalFilesystemPath(path);
  if (canonical === ".gitignore" && path !== ".gitignore")
    throw new ScopeError(`Root .gitignore alias is unsupported: ${path}`);
  if (canonical.endsWith("/.gitignore")) throw new UnsupportedNestedGitignoreError(path);
}

/** Reject nested controls and ambiguous root aliases in the full path inventory. */
export function assertNoNestedGitignore(paths: Iterable<string>): void {
  for (const path of paths) {
    if (!isValidPath(path)) throw new ScopeError(`Invalid tree path: ${JSON.stringify(path)}`);
    assertSupportedGitignorePath(path);
  }
}

function denied(path: string, configDir: string): boolean {
  const segments = path.split("/").map(canonicalFilesystemPath);
  const canonicalConfigDir = canonicalFilesystemPath(configDir);
  if (segments.some((part) => part === ".git" || part === ".git-vault-sync" ||
    part.startsWith(".git-vault-sync-export-") || part === ".trash" || CANONICAL_OS_METADATA.has(part))) return true;
  // .obsidian remains a reserved vault location even if a device uses a
  // different configured directory and pauses configuration sync.
  if (segments[0] !== canonicalConfigDir && segments[0] !== ".obsidian") return false;
  if (segments.length === 1) return true;
  const [, first, second] = segments;
  if (first === "workspace" || first === "workspace.json" || first === "workspace-mobile.json" || first === "cache") return true;
  if (first === "plugins" && (second === "github-vault-sync" || CANONICAL_COMPETING_SYNC_PLUGINS.has(second))) return true;
  if (segments.slice(1).some((part) => CANONICAL_SECRET_NAMES.has(part) || part === ".env" ||
    part.startsWith(".env.") || /\.(?:pem|p12|pfx|key)$/.test(part))) return true;
  // `plugins/<id>/data.json` is eligible when already tracked, but a new local
  // file there still requires exact-version consent, regardless of plugin id.
  return false;
}

async function validateRules(rules: ScopeRules, text: string | null): Promise<Readonly<ScopeRules>> {
  if (rules.rules !== "visible-only" && rules.rules !== "config/1") throw new ScopeError("Unknown scope rule version");
  assertValidConfigDir(rules.configDir);
  if (rules.rules === "visible-only") {
    if (rules.gitignore !== null || text !== null) throw new ScopeError("Legacy visible-only scope cannot use .gitignore");
  } else {
    if (rules.gitignore !== null && !isOid(rules.gitignore)) throw new ScopeError("Invalid .gitignore object ID");
    if ((rules.gitignore === null) !== (text === null)) throw new ScopeError(".gitignore object ID and text disagree");
    if (text !== null) {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_GITIGNORE_BYTES) throw new ScopeError(".gitignore exceeds 64 KiB");
      if (await hashBlob(bytes) !== rules.gitignore) throw new ScopeError(".gitignore bytes do not match the object ID");
      // ignore@7 strips a BOM from every pattern, unlike Git. Git also stops
      // matching at NUL. Accept neither ambiguity until the parser agrees.
      if (text.includes("\0") || text.indexOf("\ufeff", text.startsWith("\ufeff") ? 1 : 0) !== -1)
        throw new ScopeError("Unsupported .gitignore encoding");
    }
  }
  return Object.freeze({ rules: rules.rules, configDir: rules.configDir, gitignore: rules.gitignore });
}

/** Compile a pure per-commit policy. The caller must pause on ScopeError. */
export async function compileScope(rules: ScopeRules, gitignoreText: string | null): Promise<Scope> {
  const frozenRules = await validateRules(rules, gitignoreText);
  const matcher = ignore({ ignoreCase: false, allowRelativePaths: false });
  if (gitignoreText !== null) matcher.add(gitignoreText);
  const digest = await digestText(JSON.stringify([BUILTIN_VERSION, frozenRules]));
  const classify = (path: string): HiddenClass => {
    if (!isValidPath(path)) return "denied";
    if (frozenRules.rules === "config/1") assertSupportedGitignorePath(path);
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
export async function freezeTransactionScope(parent: Scope, remote: Scope, localGitignoreText: string | null): Promise<TransactionScope> {
  if (parent.rules.rules !== remote.rules.rules || parent.rules.configDir !== remote.rules.configDir)
    throw new ScopeError("Transaction scope versions do not agree");
  const localOid = localGitignoreText === null ? null : await hashBlob(new TextEncoder().encode(localGitignoreText));
  const local = await compileScope({ ...parent.rules, gitignore: localOid }, localGitignoreText);
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
