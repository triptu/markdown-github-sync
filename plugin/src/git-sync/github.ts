import type { Changes, CommitSnapshot, Entry, LedgerRead, PreparedPublication, Repository, RepositoryIdentity, Snapshot } from "./contracts";
import { ArchiveError, selectArchiveFiles } from "./archive";
import { assertNoNestedGitignore, canonicalFilesystemPath, compileScope, scopeForTree } from "./scope";
import type { Scope, ScopeRules } from "./scope";
import { trustVerifiedEntry } from "./codec";

export interface GitHubRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** JSON serialized request body. */
  body?: string;
}
export interface GitHubResponse { status: number; headers: Record<string, string>; json: unknown }
export interface GitHubBinaryResponse { status: number; headers: Record<string, string>; bytes: Uint8Array }
export interface GitHubTransport {
  request(request: GitHubRequest): Promise<GitHubResponse>;
  /**
   * Optional raw-bytes GET for repository archives. It may follow redirects;
   * if it does not, a 3xx with a `Location` on codeload.github.com is
   * re-requested without the Authorization header.
   */
  requestArchive?(request: GitHubRequest): Promise<GitHubBinaryResponse>;
}
export interface FileHistoryPage {
  at: string;
  entries: { commit: string; message: string; author: string; date: string }[];
  nextPage: number | null;
}
export interface GitHubRepositoryOptions {
  owner: string;
  name: string;
  branch: string;
  transport: GitHubTransport;
  token: () => Promise<string>;
  /**
   * Stable per-installation identity (canonical lowercase UUID), naming the
   * ledger ref `refs/vault-sync/devices/<installation>`. Required: there is no
   * default, because two devices sharing a ledger would void its guarantees.
   */
  installation: string;
  /** Injectable clock for rate-limit scheduling. */
  now?: () => number;
  /** Defaults to the existing visible-only behavior until the engine opts in. */
  scopeRules?: ScopeRules["rules"];
  /** Vault configuration directory; defaults to `.obsidian`. */
  configDir?: string;
  /**
   * Snapshot blob download progress: `(0, total)` before the first download,
   * then once per verified blob. Not called when every blob is already known.
   * Exceptions thrown by the callback are ignored.
   */
  onReadProgress?: (done: number, total: number) => void;
  /**
   * Current local bytes at a repository path, or null when missing or
   * unreadable. Callers may return null without reading when the size differs
   * from `expectedSize` (at most 8 MiB). Bytes are reused only after their Git
   * blob hash matches the tree; a mismatch is an ordinary local edit and the
   * remote version is downloaded. Nothing is ever written locally. A throw
   * fails the read.
   */
  readLocal?: (path: string, expectedSize: number) => Promise<Uint8Array | null>;
}
export class GitHubError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAt?: number) { super(message); this.name = "GitHubError"; }
}
const FILE_LIMIT = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT = 128 * 1024 * 1024;
// Account for retained strings at two bytes/code unit, plus metadata allowances.
// This bounds cache payload accounting, not engine-dependent total heap usage.
const CACHE_LIMIT = 128 * 1024 * 1024;
const CACHE_OBJECT_LIMIT = 4096;
const READ_CONCURRENCY = 4;
const LOCAL_CONCURRENCY = 8;
// Below this many missing blobs, per-blob reads beat downloading the whole archive.
const ARCHIVE_THRESHOLD = 32;
// The zipball carries every blob, including excluded ones; skip it above this tree size.
const ARCHIVE_LIMIT = 256 * 1024 * 1024;
const ARCHIVE_REDIRECTS = 2;
const ENCODED_LIMIT = 4 * Math.ceil(FILE_LIMIT / 3);
const INSTALLATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_OID = "0".repeat(40);
const UPDATE_REFS = "mutation Publish($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }";
const encoder = new TextEncoder();
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GitHubError("Malformed GitHub object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new GitHubError("Malformed GitHub string");
  return value;
}
function oid(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new GitHubError("Invalid Git object identity");
  return result;
}
function label(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new GitHubError("Invalid operation label");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitHubError("Malformed GitHub list");
  return value;
}
function size(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new GitHubError("Invalid blob size");
  return value;
}
function pathParts(path: string): string[] {
  const parts = path.split("/");
  if (path.length > 4096 || parts.some(p => !p || p === "." || p === ".." || /[\\\u0000-\u001f\u007f:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[\ud800-\udfff]/u.test(p))) {
    throw new GitHubError("Unsafe repository path");
  }
  for (const part of parts) {
    const normalized = part.normalize("NFKC");
    if (/[\\/:<>"|?*]/.test(normalized) || normalized === "." || normalized === ".." || /[. ]$/.test(normalized) || (normalized.startsWith(".") && !part.startsWith("."))) throw new GitHubError("Unsafe normalized repository path");
  }
  return parts;
}
function visible(path: string): boolean { return !pathParts(path).some(p => p.startsWith(".")); }
function validatePaths(namespace: Iterable<string>, included: Iterable<string>): void {
  const spellings = new Map<string, string>();
  const collisions = new Set<string>();
  const relevant = new Set<string>();
  for (const path of included) {
    const parts = pathParts(path);
    for (let i = 1; i <= parts.length; i++) relevant.add(parts.slice(0, i).join("/"));
  }
  for (const path of namespace) {
    const parts = pathParts(path);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = canonicalFilesystemPath(prefix);
      const existing = spellings.get(key);
      if (existing === undefined) spellings.set(key, prefix);
      else if (existing !== prefix) collisions.add(key);
    }
  }
  for (const prefix of relevant) {
    const key = canonicalFilesystemPath(prefix);
    const spelling = spellings.get(key);
    if (collisions.has(key) || spelling !== undefined && spelling !== prefix)
      throw new GitHubError("Case or Unicode path collision");
  }
}
export function encodeGitData(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function decode(data: string, wrapped = false): Uint8Array {
  if (data.length > ENCODED_LIMIT + Math.ceil(ENCODED_LIMIT / 60) * 2) throw new GitHubError("Invalid or oversized base64 blob");
  const clean = wrapped ? data.replace(/[\r\n]/g, "") : data;
  if (clean.length > ENCODED_LIMIT || (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))) throw new GitHubError("Invalid or oversized base64 blob");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (bytes.length > FILE_LIMIT || encodeGitData(bytes) !== clean) throw new GitHubError("Invalid or oversized base64 blob");
  return bytes;
}
async function objectOid(type: "blob" | "tree", bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`${type} ${bytes.length}\0`);
  const framed = new Uint8Array(header.length + bytes.length);
  framed.set(header); framed.set(bytes, header.length);
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", framed)), n => n.toString(16).padStart(2, "0")).join("");
}
export function gitBlobOid(bytes: Uint8Array): Promise<string> { return objectOid("blob", bytes); }
function checkLfs(bytes: Uint8Array): void {
  if (new TextDecoder().decode(bytes.subarray(0, 256)).startsWith("version https://git-lfs.github.com/spec/v1")) throw new GitHubError("Git LFS pointers are unsupported in content scope");
}
async function entry(value: unknown): Promise<{ entry: Entry; bytes: Uint8Array }> {
  const item = record(value);
  const hash = oid(item.oid);
  if (item.mode !== "100644" && item.mode !== "100755") throw new GitHubError("Unsupported file mode");
  const data = string(item.data);
  const bytes = decode(data);
  checkLfs(bytes);
  if (await gitBlobOid(bytes) !== hash) throw new GitHubError("Blob hash mismatch");
  return { entry: { oid: hash, mode: item.mode, data }, bytes };
}
interface TreeItem { path: string; mode: string; type: "tree" | "blob" | "commit"; sha: string; size?: number }
interface Commit { oid: string; treeOid: string; parents: string[] }
type CachedObject =
  | { kind: "blob"; data: string; size: number }
  | { kind: "commit"; value: Commit }
  | { kind: "tree"; items: TreeItem[] };
function commit(value: unknown): Commit {
  const item = record(value);
  return { oid: oid(item.sha), treeOid: oid(record(item.tree).sha), parents: list(item.parents).map(p => oid(record(p).sha)) };
}
function sameFiles(a: Snapshot, b: Snapshot): boolean {
  const paths = Object.keys(a);
  return paths.length === Object.keys(b).length && paths.every(path => {
    const left = a[path], right = b[path];
    return right !== undefined && left.oid === right.oid && left.mode === right.mode && left.data === right.data;
  });
}
function terminals(items: TreeItem[]): Map<string, string> {
  return new Map(items.filter(i => i.type !== "tree").map(i => [i.path, `${i.mode}:${i.type}:${i.sha}`]));
}
function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && Array.from(a).every(([key, value]) => b.get(key) === value);
}
async function verifyTree(items: TreeItem[], root: string): Promise<void> {
  const children = new Map<string, TreeItem[]>([["", []]]);
  const directoryOids = new Map(items.filter(i => i.type === "tree").map(i => [i.path, i.sha]));
  for (const item of items) if (item.type === "tree") children.set(item.path, []);
  for (const item of items) {
    const directory = item.path.slice(0, Math.max(0, item.path.lastIndexOf("/")));
    const siblings = children.get(directory);
    if (!siblings) throw new GitHubError("Missing parent directory in Git tree");
    siblings.push(item);
  }
  for (const [directory, entries] of children) {
    const rows = entries.map(item => {
      const name = item.path.slice(directory ? directory.length + 1 : 0);
      const sort = encoder.encode(name + (item.type === "tree" ? "/" : ""));
      const prefix = encoder.encode(`${item.mode === "040000" ? "40000" : item.mode} ${name}\0`);
      const bytes = new Uint8Array(prefix.length + 20); bytes.set(prefix);
      bytes.set(Uint8Array.from(item.sha.match(/../g) ?? [], hex => parseInt(hex, 16)), prefix.length);
      return { sort, bytes };
    });
    rows.sort((a, b) => {
      for (let i = 0; i < Math.min(a.sort.length, b.sort.length); i++) if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i];
      return a.sort.length - b.sort.length;
    });
    const body = new Uint8Array(rows.reduce((sum, row) => sum + row.bytes.length, 0));
    let offset = 0;
    for (const row of rows) { body.set(row.bytes, offset); offset += row.bytes.length; }
    const expected = directory ? directoryOids.get(directory) : root;
    if (await objectOid("tree", body) !== expected) throw new GitHubError("Tree hash mismatch");
  }
}

/** Runs `work` at most `width` at a time; on any failure, starts no more and rejects after in-flight work settles. */
async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      try { await work(items[next++]); }
      catch (error) { failure ??= { error }; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/** GitHub.com repository adapter. See docs/github-client.md for transport and failure semantics. */
export class GitHubRepository implements Repository {
  private readonly base: string;
  private readonly now: () => number;
  private readonly ledger: string;
  private readonly ruleVersion: ScopeRules["rules"];
  private readonly configDir: string;
  private readonly cache = new Map<string, { object: CachedObject; cost: number }>();
  private readonly scopeCache = new Map<string, Scope>();
  private cacheCost = 0;
  /**
   * Verified blobs of the two most recent distinct complete snapshots (by
   * tree), outside the LRU so a snapshot larger than CACHE_LIMIT does not
   * thrash on every poll, and so alternating head and checkpoint reads (an
   * undecided conflict) reuse both. Bounded by 2 x SNAPSHOT_LIMIT decoded
   * bytes; it shares string instances with the LRU and with the snapshots
   * the caller already holds. Strings are immutable and every returned Entry
   * is a fresh object.
   */
  private retained: { tree: string; blobs: Map<string, { data: string; size: number }> }[] = [];
  /**
   * Unverified candidate blob bodies offered by the engine (base64, keyed by
   * claimed oid). Used only for blobs a snapshot is missing, and only after
   * their bytes hash to the tree's oid. Replaced by each offer.
   */
  private offered = new Map<string, string>();
  constructor(private readonly options: GitHubRepositoryOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(options.owner) || !/^[A-Za-z0-9_.-]+$/.test(options.name) || options.name === "." || options.name === "..") throw new GitHubError("Invalid repository coordinates");
    if (!options.branch || options.branch === "@" || /[\s~^:?*\[\\\u0000-\u001f\u007f]/.test(options.branch) || options.branch.includes("..") || options.branch.includes("@{") || options.branch.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".lock") || p.endsWith("."))) throw new GitHubError("Invalid branch name");
    if (typeof options.installation !== "string" || !INSTALLATION.test(options.installation)) throw new GitHubError("Invalid installation identity");
    if (options.scopeRules !== undefined && options.scopeRules !== "visible-only" && options.scopeRules !== "config/1") throw new GitHubError("Invalid scope rule version");
    this.ruleVersion = options.scopeRules ?? "visible-only";
    this.configDir = options.configDir ?? ".obsidian";
    this.ledger = `refs/vault-sync/devices/${options.installation}`;
    this.base = `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}`;
    this.now = options.now ?? Date.now;
  }
  private cached(kind: CachedObject["kind"], hash: string): CachedObject | undefined {
    const key = `${kind}:${hash}`, found = this.cache.get(key);
    if (!found) return undefined;
    this.cache.delete(key);
    this.cache.set(key, found);
    return found.object;
  }
  private remember(hash: string, object: CachedObject): void {
    const key = `${object.kind}:${hash}`;
    let cost = 256 + 2 * key.length;
    switch (object.kind) {
      case "blob": cost += 2 * object.data.length; break;
      case "commit": cost += 2 * (object.value.oid.length + object.value.treeOid.length) + object.value.parents.length * (80 + 16); break;
      case "tree": cost += object.items.reduce((sum, item) => sum + 256 + 2 * (item.path.length + item.mode.length + item.type.length + item.sha.length), 0); break;
    }
    const existing = this.cache.get(key);
    if (existing) { this.cache.delete(key); this.cacheCost -= existing.cost; }
    if (cost > CACHE_LIMIT) return;
    while (this.cacheCost + cost > CACHE_LIMIT || this.cache.size >= CACHE_OBJECT_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const evicted = this.cache.get(oldest.value);
      if (evicted) this.cacheCost -= evicted.cost;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { object, cost });
    this.cacheCost += cost;
  }
  private async credential(): Promise<string> {
    let token: string;
    try { token = await this.options.token(); } catch { throw new GitHubError("GitHub credential unavailable"); }
    if (!token || /[\r\n]/.test(token)) throw new GitHubError("GitHub credential unavailable");
    return token;
  }
  private headers(token: string): Record<string, string> {
    return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  }
  /** Throws on rate limits and non-2xx statuses (3xx too unless `redirect`); returns lowercased headers. */
  private check(response: { status: number; headers: Record<string, string>; json?: unknown }, redirect = false): Map<string, string> {
    if (!Number.isInteger(response.status)) throw new GitHubError("Malformed GitHub HTTP status");
    const headers = new Map(Object.entries(record(response.headers)).map(([key, value]) => [key.toLowerCase(), string(value)]));
    const retry = headers.get("retry-after");
    const reset = headers.get("x-ratelimit-reset");
    const graphqlRateLimited = typeof response.json === "object" && response.json !== null && "errors" in response.json && Array.isArray(response.json.errors) && response.json.errors.some(error => typeof error === "object" && error !== null && "type" in error && error.type === "RATE_LIMITED");
    if (response.status === 429 || ((response.status === 403 || graphqlRateLimited) && (retry !== undefined || headers.get("x-ratelimit-remaining") === "0" || graphqlRateLimited))) {
      const dates = [this.now() + 60_000];
      if (retry !== undefined) {
        const seconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
        const time = Number.isFinite(seconds) ? this.now() + seconds * 1000 : Date.parse(retry);
        if (Number.isFinite(time)) dates.push(time);
      }
      if (reset !== undefined && /^\d+$/.test(reset) && Number.isFinite(Number(reset) * 1000)) dates.push(Number(reset) * 1000);
      throw new GitHubError("GitHub rate limit; schedule a later attempt", response.status, Math.max(...dates));
    }
    if ((response.status < 200 || response.status >= 300) && !(redirect && response.status >= 300 && response.status < 400)) throw new GitHubError(`GitHub API request rejected (HTTP ${response.status})`, response.status);
    return headers;
  }
  private async request(url: string, method: "GET" | "POST" = "GET", body?: unknown, extra: Record<string, string> = {}): Promise<GitHubResponse> {
    const token = await this.credential();
    let response: GitHubResponse;
    try {
      response = await this.options.transport.request({ url, method, headers: { ...this.headers(token), "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new GitHubError("GitHub transport failed; request outcome may be unknown"); }
    this.check(response);
    return response;
  }
  /**
   * The zipball of an exact commit. GitHub answers with a redirect to a
   * short-lived codeload.github.com URL that carries its own authorization,
   * so a redirect is followed without the token and only to that host.
   */
  private async archive(commitOid: string): Promise<Uint8Array> {
    const transport = this.options.transport;
    if (!transport.requestArchive) throw new ArchiveError("Archive transport unavailable");
    let url = `${this.base}/zipball/${oid(commitOid)}`;
    let headers = this.headers(await this.credential());
    for (let hop = 0; ; hop++) {
      let response: GitHubBinaryResponse;
      try { response = await transport.requestArchive({ url, method: "GET", headers }); }
      catch { throw new ArchiveError("GitHub archive transport failed"); }
      const lowered = this.check(response, true);
      if (response.status >= 300) {
        const location = lowered.get("location");
        let next: URL;
        try { next = new URL(location ?? "", url); } catch { throw new ArchiveError("Invalid GitHub archive redirect"); }
        if (hop >= ARCHIVE_REDIRECTS || next.protocol !== "https:" || next.hostname !== "codeload.github.com" || next.username || next.password) throw new ArchiveError("Unexpected GitHub archive redirect");
        url = next.href; headers = { Accept: "application/zip" };
        continue;
      }
      if (!(response.bytes instanceof Uint8Array)) throw new ArchiveError("Malformed GitHub archive response");
      if (response.bytes.length > ARCHIVE_LIMIT) throw new ArchiveError("GitHub archive size limit exceeded");
      return response.bytes;
    }
  }
  private async rest(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    return (await this.request(this.base + path, method, body)).json;
  }
  async identity(): Promise<RepositoryIdentity> {
    const repo = record(await this.rest(""));
    if (repo.private !== true) throw new GitHubError("Sync requires a private GitHub repository; public or unknown visibility is refused");
    const id = string(repo.node_id), owner = string(record(repo.owner).login), name = string(repo.name);
    if (!id || owner.toLowerCase() !== this.options.owner.toLowerCase() || name.toLowerCase() !== this.options.name.toLowerCase()) throw new GitHubError("Repository identity mismatch");
    return { id, owner, name, branch: this.options.branch };
  }
  /**
   * Read-only reachability check: the token can read the private repository
   * and the configured branch exists. Two GETs, no blobs, no mutations. It
   * cannot establish Contents write permission; only a publication does.
   */
  async checkAccess(): Promise<void> {
    await this.identity();
    await this.headOid();
  }
  async history(input: { path?: string; at?: string; page?: number }): Promise<FileHistoryPage> {
    if (input.path !== undefined) {
      if (!input.path) throw new GitHubError("Choose a vault file for history");
      pathParts(input.path);
      if (this.ruleVersion === "visible-only" && !visible(input.path)) throw new GitHubError("Choose a visible vault file for history");
    }
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || (page > 1 && !input.at))
      throw new GitHubError("Invalid history page");
    const pinned = input.at === undefined ? undefined : oid(input.at);
    await this.identity();
    const at = pinned ?? await this.headOid();
    if (input.path !== undefined && this.ruleVersion === "config/1" && !(await this.scopeFor(at)).includes(input.path))
      throw new GitHubError("File is outside the commit's scope");
    const query = new URLSearchParams({ sha: at, per_page: "30", page: String(page) });
    if (input.path !== undefined) query.set("path", input.path);
    const rows = list(await this.rest(`/commits?${query}`));
    if (rows.length > 30) throw new GitHubError("Oversized history page");
    const entries = rows.map(value => {
      const row = record(value), commit = record(row.commit), author = record(commit.author);
      const date = string(author.date);
      if (!Number.isFinite(Date.parse(date))) throw new GitHubError("Invalid history date");
      return { commit: oid(row.sha), message: string(commit.message).slice(0, 4000), author: string(author.name).slice(0, 256), date };
    });
    return { at, entries, nextPage: entries.length === 30 ? page + 1 : null };
  }
  private async headOid(): Promise<string> {
    let ref: Record<string, unknown>;
    const url = `${this.base}/git/ref/heads/${this.options.branch.split("/").map(encodeURIComponent).join("/")}?fresh=${globalThis.crypto.randomUUID()}`;
    try { ref = record((await this.request(url, "GET", undefined, { "Cache-Control": "no-cache", Pragma: "no-cache" })).json); }
    catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) throw new GitHubError("Unsupported enrollment: branch missing or repository empty/unborn", error.status);
      throw error;
    }
    const object = record(ref.object);
    if (ref.ref !== `refs/heads/${this.options.branch}` || object.type !== "commit") throw new GitHubError("Unexpected branch reference");
    return oid(object.sha);
  }
  async head(): Promise<CommitSnapshot> { return this.readCommit(await this.headOid()); }
  private async getCommit(hash: string, refresh = false): Promise<Commit> {
    oid(hash);
    const cached = refresh ? undefined : this.cached("commit", hash);
    if (cached?.kind === "commit") return cached.value;
    const value = commit(await this.rest(`/git/commits/${hash}`));
    if (value.oid !== hash) throw new GitHubError("Commit identity mismatch");
    this.remember(hash, { kind: "commit", value });
    return value;
  }
  private async tree(hash: string): Promise<TreeItem[]> {
    oid(hash);
    const cached = this.cached("tree", hash);
    if (cached?.kind === "tree") return cached.items;
    const value = record(await this.rest(`/git/trees/${hash}?recursive=1`));
    if (value.truncated === true) throw new GitHubError("Unsupported repository: recursive Git tree truncated; enrollment blocked");
    if (value.truncated !== false || oid(value.sha) !== hash) throw new GitHubError("Malformed or mismatched Git tree");
    const raw = list(value.tree);
    if (raw.length > 100_000) throw new GitHubError("Git tree entry limit exceeded");
    const seen = new Set<string>();
    const items: TreeItem[] = raw.map(value => {
      const item = record(value), path = string(item.path), mode = string(item.mode), sha = oid(item.sha);
      pathParts(path);
      if (seen.has(path)) throw new GitHubError("Duplicate Git tree path");
      seen.add(path);
      if (item.type !== "blob" && item.type !== "tree" && item.type !== "commit") throw new GitHubError("Invalid tree object type");
      if (!(item.type === "tree" && mode === "040000" || item.type === "blob" && ["100644", "100755", "120000"].includes(mode) || item.type === "commit" && mode === "160000")) throw new GitHubError("Invalid tree object mode");
      return { path, mode, sha, type: item.type, ...(item.type === "blob" ? { size: size(item.size) } : {}) };
    });
    await verifyTree(items, hash);
    this.remember(hash, { kind: "tree", items });
    return items;
  }
  private knownBlob(hash: string, length: number): string | undefined {
    const cached = this.cached("blob", hash);
    let known: { data: string; size: number } | undefined = cached?.kind === "blob" ? cached : undefined;
    for (const snapshot of this.retained) known ??= snapshot.blobs.get(hash);
    if (known === undefined) return undefined;
    if (known.size !== length) throw new GitHubError("Blob identity or size mismatch");
    return known.data;
  }
  private async blob(hash: string, length: number): Promise<string> {
    return this.knownBlob(hash, length) ?? this.fetchBlob(hash, length);
  }
  private async fetchBlob(hash: string, length: number): Promise<string> {
    const blob = record(await this.rest(`/git/blobs/${hash}`));
    if (oid(blob.sha) !== hash || blob.encoding !== "base64" || size(blob.size) !== length) throw new GitHubError("Blob identity or size mismatch");
    const bytes = decode(string(blob.content), true);
    if (bytes.length !== length) throw new GitHubError("Blob decoded size mismatch");
    checkLfs(bytes);
    if (await gitBlobOid(bytes) !== hash) throw new GitHubError("Blob hash mismatch");
    const data = encodeGitData(bytes);
    this.remember(hash, { kind: "blob", size: length, data });
    return data;
  }
  private async scopeForItems(treeOid: string, items: TreeItem[]): Promise<Scope> {
    if (this.ruleVersion === "config/1") assertNoNestedGitignore(items.map(item => item.path));
    const cached = this.scopeCache.get(treeOid);
    if (cached) return cached;
    const scope = await scopeForTree(items, async hash => {
      const rootIgnore = items.find(item => item.path === ".gitignore");
      if (!rootIgnore || rootIgnore.mode !== "100644" && rootIgnore.mode !== "100755" || rootIgnore.size === undefined)
        throw new GitHubError("Unsupported root .gitignore entry");
      return decode(await this.blob(hash, size(rootIgnore.size)));
    }, this.configDir, this.ruleVersion);
    if (this.scopeCache.size >= 256) {
      const oldest = this.scopeCache.keys().next();
      if (!oldest.done) this.scopeCache.delete(oldest.value);
    }
    this.scopeCache.set(treeOid, scope);
    return scope;
  }
  /** The policy of this exact commit, including its pinned root `.gitignore`. */
  async scopeFor(commitOid: string): Promise<Scope> {
    const value = await this.getCommit(commitOid);
    const items = await this.tree(value.treeOid);
    return this.scopeForItems(value.treeOid, items);
  }
  /** Verified text for the engine's local transaction-scope freeze. */
  async readRootGitignore(commitOid: string): Promise<string | null> {
    const value = await this.getCommit(commitOid);
    const items = await this.tree(value.treeOid);
    await this.scopeForItems(value.treeOid, items);
    if (this.ruleVersion === "visible-only") return null;
    const rootIgnore = items.find(item => item.path === ".gitignore");
    return rootIgnore ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decode(await this.blob(rootIgnore.sha, size(rootIgnore.size)))) : null;
  }
  private async snapshot(value: Commit, items: TreeItem[], requestedRules = this.ruleVersion): Promise<CommitSnapshot> {
    const scope = requestedRules === this.ruleVersion
      ? await this.scopeForItems(value.treeOid, items)
      : await compileScope({ rules: "visible-only", configDir: this.configDir, gitignore: null }, null);
    const included = items.filter(i => i.type !== "tree" && scope.includes(i.path));
    validatePaths(items.map(i => i.path), included.map(i => i.path));
    let total = 0;
    for (const item of included) {
      if (item.type !== "blob" || item.mode !== "100644" && item.mode !== "100755") throw new GitHubError("Symlink or submodule unsupported in content scope");
      const length = size(item.size);
      total += length;
      if (length > FILE_LIMIT || total > SNAPSHOT_LIMIT) throw new GitHubError("Decoded snapshot size limit exceeded");
    }
    const sizes = new Map<string, number>();
    for (const item of included) {
      const length = size(item.size), known = sizes.get(item.sha);
      if (known !== undefined && known !== length) throw new GitHubError("Blob identity or size mismatch");
      sizes.set(item.sha, length);
    }
    const blobs = new Map<string, string>();
    const missing: [string, number][] = [];
    for (const [hash, length] of sizes) {
      const known = this.knownBlob(hash, length);
      if (known === undefined) missing.push([hash, length]); else blobs.set(hash, known);
    }
    const paths = new Map<string, string[]>();
    for (const item of included) paths.set(item.sha, [...paths.get(item.sha) ?? [], item.path]);
    const unknown = await this.reuseOffered(missing, blobs);
    const remote = await this.reuseLocal(unknown, paths, blobs);
    await this.download(value.oid, items, remote, paths, blobs);
    const files: Snapshot = Object.create(null);
    for (const item of included) {
      if (item.mode !== "100644" && item.mode !== "100755") throw new GitHubError("Unsupported file mode");
      const data = blobs.get(item.sha);
      if (data === undefined) throw new GitHubError("Blob read incomplete");
      // Every value in `blobs` was decoded canonically and hashed to `item.sha`.
      files[item.path] = trustVerifiedEntry({ oid: item.sha, mode: item.mode, data });
    }
    const retained = new Map(Array.from(sizes, ([hash, length]) => [hash, { data: blobs.get(hash) ?? "", size: length }]));
    this.retained = [{ tree: value.treeOid, blobs: retained }, ...this.retained.filter(item => item.tree !== value.treeOid)].slice(0, 2);
    return { oid: value.oid, treeOid: value.treeOid, files };
  }
  /**
   * Offers blob bodies the caller already holds (local files, journal blobs),
   * so a snapshot read can skip downloading them. Nothing is trusted: an
   * offered body is used only for a blob a snapshot is missing, and only once
   * its decoded bytes match the tree's size and Git blob hash.
   */
  offerKnownBlobs(blobs: Iterable<{ oid: string; data: string }>): void {
    const offered = new Map<string, string>();
    for (const blob of blobs) if (typeof blob?.oid === "string" && typeof blob.data === "string") offered.set(blob.oid, blob.data);
    this.offered = offered;
  }
  /** Accepts offered bodies that hash to missing blobs; returns the blobs still missing. */
  private async reuseOffered(missing: [string, number][], into: Map<string, string>): Promise<[string, number][]> {
    if (missing.length === 0 || this.offered.size === 0) return missing;
    const remaining: [string, number][] = [];
    for (const [hash, length] of missing) {
      const data = this.offered.get(hash);
      let bytes: Uint8Array | null = null;
      if (data !== undefined) {
        try { bytes = decode(data); } catch { bytes = null; }
      }
      if (bytes === null || !(await this.accept(hash, length, bytes, into))) remaining.push([hash, length]);
    }
    return remaining;
  }
  /** Reuses local files whose bytes hash to a missing blob; returns the blobs still missing. */
  private async reuseLocal(missing: [string, number][], paths: Map<string, string[]>, into: Map<string, string>): Promise<[string, number][]> {
    const readLocal = this.options.readLocal;
    if (!readLocal || missing.length === 0) return missing;
    const remaining: [string, number][] = [];
    await pool(missing, LOCAL_CONCURRENCY, async ([hash, length]) => {
      for (const path of paths.get(hash) ?? []) {
        const bytes = await readLocal(path, length);
        if (bytes instanceof Uint8Array && await this.accept(hash, length, bytes, into)) return;
      }
      remaining.push([hash, length]);
    });
    return remaining;
  }
  /** Records `bytes` when they are exactly the blob; false for any mismatch. */
  private async accept(hash: string, length: number, bytes: Uint8Array, into: Map<string, string>): Promise<boolean> {
    if (bytes.length !== length) return false;
    // Encode before awaiting the hash (which copies synchronously): both see the same bytes.
    const data = encodeGitData(bytes);
    if (await gitBlobOid(bytes) !== hash) return false;
    checkLfs(bytes);
    this.remember(hash, { kind: "blob", size: length, data });
    into.set(hash, data);
    return true;
  }
  /**
   * Fetches missing blobs: from the commit's zipball when many are missing,
   * then per blob for anything the archive lacked or got wrong. Malformed,
   * oversized or 5xx archives fall back; auth failures, other 4xx statuses and
   * rate limits propagate.
   */
  private async download(commitOid: string, items: TreeItem[], missing: [string, number][], paths: Map<string, string[]>, into: Map<string, string>): Promise<void> {
    if (missing.length === 0) return;
    let done = 0;
    this.progress(0, missing.length);
    const treeBytes = items.reduce((sum, item) => sum + (item.size ?? 0), 0);
    if (this.options.transport.requestArchive && missing.length >= ARCHIVE_THRESHOLD && treeBytes <= ARCHIVE_LIMIT) {
      const wanted = new Map<string, number>();
      for (const [hash, length] of missing) for (const path of paths.get(hash) ?? []) wanted.set(path, length);
      let files: Map<string, Uint8Array> | undefined;
      try { files = selectArchiveFiles(await this.archive(commitOid), wanted); }
      catch (error) {
        const unavailable = error instanceof GitHubError && error.retryAt === undefined && error.status !== undefined && error.status >= 500;
        if (!(error instanceof ArchiveError || unavailable)) throw error;
      }
      if (files) {
        const remaining: [string, number][] = [];
        for (const [hash, length] of missing) {
          let found = false;
          for (const path of paths.get(hash) ?? []) {
            const bytes = files.get(path);
            if (bytes && await this.accept(hash, length, bytes, into)) { found = true; break; }
          }
          if (found) this.progress(++done, missing.length); else remaining.push([hash, length]);
        }
        missing = remaining;
      }
    }
    const total = done + missing.length;
    await pool(missing, READ_CONCURRENCY, async ([hash, length]) => {
      into.set(hash, await this.fetchBlob(hash, length));
      this.progress(++done, total);
    });
  }
  private progress(done: number, total: number): void {
    try { this.options.onReadProgress?.(done, total); } catch { /* Display only. */ }
  }
  private async read(hash: string, rules = this.ruleVersion): Promise<CommitSnapshot> {
    const value = await this.getCommit(hash);
    const items = await this.tree(value.treeOid);
    const result = await this.snapshot(value, items, rules);
    // Blobs of a large snapshot can push its own commit and tree out of the LRU.
    this.remember(hash, { kind: "commit", value });
    this.remember(value.treeOid, { kind: "tree", items });
    return result;
  }
  readCommit(hash: string): Promise<CommitSnapshot> { return this.read(hash); }
  async readCommitForScope(hash: string, rules: ScopeRules["rules"]): Promise<CommitSnapshot> {
    if (rules !== "visible-only" && rules !== this.ruleVersion) throw new GitHubError("Unsupported historical scope read");
    return this.read(hash, rules);
  }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    oid(ancestor); oid(descendant);
    if (ancestor === descendant) { await this.getCommit(ancestor); return true; }
    const value = record(await this.rest(`/compare/${ancestor}...${descendant}?per_page=1`));
    if (oid(record(value.base_commit).sha) !== ancestor || (value.status !== "ahead" && value.status !== "behind" && value.status !== "diverged" && value.status !== "identical")) throw new GitHubError("Uncertain GitHub ancestry result");
    const mergeBase = oid(record(value.merge_base_commit).sha);
    if (value.status === "ahead" || value.status === "identical") {
      if (mergeBase !== ancestor || (value.status === "identical" && ancestor !== descendant)) throw new GitHubError("Inconsistent GitHub ancestry result");
      return true;
    }
    if (mergeBase === ancestor) throw new GitHubError("Inconsistent GitHub ancestry result");
    return false;
  }
  ledgerRef(): string { return this.ledger; }
  async prepare(parent: CommitSnapshot, changes: Changes, message: string, ledger: { anchor: string | null; operation: string }): Promise<PreparedPublication> {
    const anchor = ledger.anchor === null ? null : oid(ledger.anchor);
    const operation = label(ledger.operation);
    const value = await this.getCommit(parent.oid);
    if (value.treeOid !== parent.treeOid) throw new GitHubError("Parent tree identity mismatch");
    const items = await this.tree(value.treeOid);
    const actual = await this.snapshot(value, items);
    if (!sameFiles(actual.files, parent.files)) throw new GitHubError("Parent snapshot mismatch");
    const parentScope = await this.scopeForItems(value.treeOid, items);
    const checked = new Map<string, Entry | null>();
    const files: Snapshot = Object.assign(Object.create(null), actual.files);
    for (const [path, next] of Object.entries(changes)) {
      pathParts(path);
      if (!parentScope.includes(path)) throw new GitHubError("Change outside parent commit scope");
      if (next === null) { delete files[path]; checked.set(path, null); }
      else { const verified = await entry(next); files[path] = verified.entry; checked.set(path, verified.entry); }
    }
    let candidateScope = parentScope;
    if (this.ruleVersion === "config/1") {
      const rootIgnore = checked.get(".gitignore");
      const ignoreText = rootIgnore === undefined ? await this.readRootGitignore(value.oid) :
        rootIgnore === null ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decode(rootIgnore.data));
      const ignoreOid = rootIgnore === undefined ? parentScope.rules.gitignore : rootIgnore?.oid ?? null;
      candidateScope = await compileScope({ rules: "config/1", configDir: this.configDir, gitignore: ignoreOid }, ignoreText);
      for (const path of checked.keys()) if (!candidateScope.includes(path))
        throw new GitHubError("Change excluded by candidate .gitignore");
      assertNoNestedGitignore(Array.from(new Set([...items.map(item => item.path), ...checked.keys()])));
    }
    const expected = terminals(items);
    for (const [path, next] of checked) {
      if (next === null) expected.delete(path);
      else expected.set(path, `${next.mode}:blob:${next.oid}`);
    }
    const finalPaths = Array.from(expected.keys());
    const occupiedParentDirs = new Set<string>();
    for (const item of items) if (item.type !== "tree") {
      for (let slash = item.path.indexOf("/"); slash >= 0; slash = item.path.indexOf("/", slash + 1))
        occupiedParentDirs.add(item.path.slice(0, slash));
    }
    const preservedEmptyTrees = items.filter(item => item.type === "tree" && !occupiedParentDirs.has(item.path)).map(item => item.path);
    const newlyIncluded = finalPaths.filter(path => candidateScope.includes(path));
    validatePaths([...preservedEmptyTrees, ...finalPaths], [...Object.keys(files), ...newlyIncluded]);
    for (const path of finalPaths) for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
      if (expected.has(path.slice(0, slash))) throw new GitHubError("File/directory path collision");
    }
    let total = 0;
    for (const file of Object.values(files)) { total += decode(file.data).length; if (total > SNAPSHOT_LIMIT) throw new GitHubError("Decoded snapshot size limit exceeded"); }
    if (typeof message !== "string" || !message.trim()) throw new GitHubError("Commit message is required");
    const edits: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const [path, next] of checked) {
      if (next === null) {
        if (actual.files[path]) edits.push({ path, mode: actual.files[path].mode, type: "blob", sha: null });
      } else {
        const blob = record(await this.rest("/git/blobs", "POST", { content: next.data, encoding: "base64" }));
        if (oid(blob.sha) !== next.oid) throw new GitHubError("Uploaded blob hash mismatch");
        this.remember(next.oid, { kind: "blob", data: next.data, size: decode(next.data).length });
        edits.push({ path, mode: next.mode, type: "blob", sha: next.oid });
      }
    }
    // GitHub rejects an empty tree edit list; an unchanged candidate (a fence) reuses the parent tree.
    const treeOid = edits.length === 0 ? value.treeOid : oid(record(await this.rest("/git/trees", "POST", { base_tree: value.treeOid, tree: edits })).sha);
    const candidateItems = await this.tree(treeOid);
    const sharedDirs = new Set<string>();
    const addAncestors = (path: string): void => {
      for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
        sharedDirs.add(path.slice(0, slash));
    };
    for (const item of items) if (item.type !== "tree" && parentScope.includes(item.path)) addAncestors(item.path);
    for (const path of checked.keys()) addAncestors(path);
    const excluded = (entries: TreeItem[]) => new Map(entries.filter(item =>
      !parentScope.includes(item.path) && (item.type !== "tree" || !sharedDirs.has(item.path)))
      .map(item => [item.path, `${item.mode}:${item.type}:${item.sha}`]));
    if (!sameMap(excluded(items), excluded(candidateItems))) throw new GitHubError("Prepared tree changed excluded repository paths");
    if (!sameMap(expected, terminals(candidateItems))) throw new GitHubError("Prepared tree does not preserve requested and excluded paths");
    const candidateFiles = (await this.snapshot({ oid: "", treeOid, parents: [] }, candidateItems)).files;
    const created = await this.createCommit(message, treeOid, [value.oid]);
    // The receipt keeps every candidate reachable from the ledger, even after a branch rewind.
    const receiptMessage = `vault-sync receipt/1\n\nop: ${operation}\ninstallation: ${this.options.installation}\nparent: ${value.oid}\ncandidate: ${created}\nstatus: accepted\n`;
    const receipt = await this.createCommit(receiptMessage, treeOid, anchor === null ? [created] : [anchor, created]);
    return { oid: created, treeOid, files: candidateFiles, receipt };
  }
  async createSeal(input: { anchor: string | null; parent: string; operation: string }): Promise<string> {
    const anchor = input.anchor === null ? null : oid(input.anchor);
    const operation = label(input.operation);
    const parent = await this.getCommit(input.parent);
    const message = `vault-sync seal/1\n\nop: ${operation}\ninstallation: ${this.options.installation}\nparent: ${parent.oid}\nstatus: cancelled\n`;
    return this.createCommit(message, parent.treeOid, anchor === null ? [] : [anchor]);
  }
  /** Creates a commit and independently rereads it; returns its identity. */
  private async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const created = commit(await this.rest("/git/commits", "POST", { message, tree, parents }));
    const same = (value: Commit) => value.treeOid === tree && value.parents.length === parents.length && value.parents.every((item, index) => item === parents[index]);
    if (!same(created)) throw new GitHubError("Created commit parent or tree mismatch");
    if (!same(await this.getCommit(created.oid, true))) throw new GitHubError("Prepared commit identity mismatch");
    return created.oid;
  }
  private async updateRefs(updates: { name: string; beforeOid: string; afterOid: string }[], clientMutationId: string): Promise<"acknowledged" | "unconfirmed"> {
    const identity = await this.identity();
    const response = record((await this.request("https://api.github.com/graphql", "POST", {
      query: UPDATE_REFS,
      variables: { input: { repositoryId: identity.id, clientMutationId, refUpdates: updates.map(update => ({ ...update, force: false })) } },
    })).json);
    // Errors carry no typed verdict (a stale CAS is a generic error), so they prove nothing.
    if (response.errors !== undefined) return "unconfirmed";
    const data = response.data;
    if (typeof data !== "object" || data === null || !("updateRefs" in data)) return "unconfirmed";
    const mutation = data.updateRefs;
    return typeof mutation === "object" && mutation !== null && "clientMutationId" in mutation && mutation.clientMutationId === clientMutationId ? "acknowledged" : "unconfirmed";
  }
  async publish(input: { parent: string; candidate: string; anchor: string | null; receipt: string }): Promise<"acknowledged" | "unconfirmed"> {
    const parent = oid(input.parent), candidate = oid(input.candidate), receipt = oid(input.receipt);
    const anchor = input.anchor === null ? null : oid(input.anchor);
    const prepared = await this.getCommit(candidate);
    if (prepared.parents.length !== 1 || prepared.parents[0] !== parent || candidate === parent) throw new GitHubError("Candidate must have exactly the expected head as parent");
    const proof = await this.getCommit(receipt);
    const parents = anchor === null ? [candidate] : [anchor, candidate];
    if (proof.treeOid !== prepared.treeOid || proof.parents.length !== parents.length || proof.parents.some((item, index) => item !== parents[index])) throw new GitHubError("Receipt must record exactly the anchor and candidate");
    return this.updateRefs([
      { name: `refs/heads/${this.options.branch}`, beforeOid: parent, afterOid: candidate },
      { name: this.ledger, beforeOid: anchor ?? ZERO_OID, afterOid: receipt },
    ], receipt);
  }
  async seal(input: { anchor: string | null; seal: string }): Promise<void> {
    const seal = oid(input.seal), anchor = input.anchor === null ? null : oid(input.anchor);
    const value = await this.getCommit(seal);
    if (value.parents.length !== (anchor === null ? 0 : 1) || (anchor !== null && value.parents[0] !== anchor)) throw new GitHubError("Seal must extend exactly the anchor");
    await this.updateRefs([{ name: this.ledger, beforeOid: anchor ?? ZERO_OID, afterOid: seal }], seal);
  }
  /**
   * Exact-ref REST read with a unique URL and `no-cache`, so no HTTP cache can
   * answer it. GraphQL `Repository.ref` returns null for existing refs outside
   * `refs/heads`/`refs/tags`, so it is never used here. 404 means "not
   * observed", which the engine never treats as proof of nonpublication; only
   * the ledger CAS (receipt or seal) decides. Malformed answers throw.
   */
  async readLedger(): Promise<LedgerRead> {
    const url = `${this.base}/git/ref/${this.ledger.slice("refs/".length).split("/").map(encodeURIComponent).join("/")}?fresh=${globalThis.crypto.randomUUID()}`;
    let response: GitHubResponse;
    try { response = await this.request(url, "GET", undefined, { "Cache-Control": "no-cache", Pragma: "no-cache" }); }
    catch (error) {
      if (error instanceof GitHubError && error.status === 404 && error.retryAt === undefined) return { kind: "absent" };
      throw error;
    }
    // A prefix match answers with a list; it must not contain the exact ref.
    if (Array.isArray(response.json)) {
      if (response.json.some(item => record(item).ref === this.ledger)) throw new GitHubError("Ambiguous ledger read");
      return { kind: "absent" };
    }
    const ref = record(response.json), object = record(ref.object);
    if (ref.ref !== this.ledger) throw new GitHubError("Ledger read returned another ref");
    if (object.type !== "commit") throw new GitHubError("Ledger ref does not point to a commit");
    return { kind: "present", value: oid(object.sha) };
  }
}
