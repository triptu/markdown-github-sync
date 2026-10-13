// Pure three-way reconciliation of one coherent base, the captured local
// snapshot and one remote commit. No I/O; hashing is the only async work.
import type { Changes, Entry, Snapshot } from "./contracts";
import { dictionary, digestText, entryFromText, entryText, foldPath, isSyncablePath, sameEntry } from "./codec";

export type ChoiceKind = "mine" | "remote" | "both" | "edit" | "expected" | "next" | "found";
/**
 * A user decision. `edit` carries the exact replacement content. `expected`,
 * `next` and `found` pick a version recorded by a native hold.
 */
export type Choice =
  | { kind: "mine" }
  | { kind: "remote" }
  | { kind: "both" }
  | { kind: "edit"; entry: Entry }
  | { kind: "expected" }
  | { kind: "next" }
  | { kind: "found" };

export type VersionConflictKind =
  | "content" // both sides edited, not safely mergeable
  | "add-add" // both sides created the path with different content
  | "local-deleted-remote-edited"
  | "local-edited-remote-deleted"
  /** Retired: emitted only by format /2 and parsed for migration. One-sided deletions are automatic. */
  | "local-deletion"
  /** Retired: see `local-deletion`. */
  | "remote-deletion";

/** A decision tied to exact versions; `id` changes whenever any version changes. */
export interface VersionConflict {
  kind: VersionConflictKind;
  id: string;
  path: string;
  base: Entry | null;
  local: Entry | null;
  remote: Entry | null;
  choices: ChoiceKind[];
  /** Where "both" keeps this device's version; GitHub's stays at `path`. */
  sibling: string | null;
}

/** Paths that would name the same file on a case-insensitive filesystem. Fixed by renaming. */
export interface CollisionConflict {
  kind: "collision";
  id: string;
  paths: string[];
}

/**
 * One confirmation for a plan deleting at least `bulkThreshold(base)` paths
 * originating on one side. `mine` keeps this device's side (local: publish the
 * deletions; remote: keep and republish the files); `remote` keeps GitHub's.
 * The id binds the guard scope (head and local manifest) and the exact path set.
 */
export interface BulkDeletionConflict {
  kind: "bulk-deletion";
  id: string;
  direction: "local" | "remote";
  paths: string[];
  choices: ["mine", "remote"];
}

/** Retained hidden bytes too large to ingest; only the vault holds them. */
export interface OversizeEvidence {
  id: string;
  sourcePath: string;
  size: number;
  mtime: number | null;
}

/** Durable evidence for one path from the vault's native transactions. */
export interface NativeHold {
  id: string;
  kind: "interrupted" | "displaced" | "oversize";
  /** The path's effective base when the hold was created; fixed for its lifetime. */
  base: Entry | null;
  expected: Entry | null;
  next: Entry | null;
  found: Entry | null;
  oversize: OversizeEvidence[];
}

export type NativeConflictKind = "interrupted-write" | "displaced-write" | "oversize-write";

/**
 * A path held by native evidence: never merged or resolved automatically. The
 * id binds every version, so any later change asks again.
 */
export interface NativeConflict {
  kind: NativeConflictKind;
  id: string;
  path: string;
  /** The path's effective base when the hold was created. */
  base: Entry | null;
  /** The current live bytes. */
  local: Entry | null;
  remote: Entry | null;
  expected: Entry | null;
  next: Entry | null;
  /** Null for `oversize-write`: those bytes stay in the vault (see `oversize`). */
  found: Entry | null;
  /** Retained oversized evidence; inspect or export it through the vault. */
  oversize: OversizeEvidence[];
  choices: ChoiceKind[];
}

export type Conflict = VersionConflict | CollisionConflict | BulkDeletionConflict | NativeConflict;

/** One guarded local mutation: replace `expected` (null = absent) by `next` (null = delete). */
export interface ApplyStep {
  path: string;
  expected: Entry | null;
  next: Entry | null;
  /** Conflict id when the step implements a user decision; consent is the exact (expected, next) pair. */
  decision: string | null;
}

export interface ReconcileInput {
  base: Snapshot;
  local: Snapshot;
  remote: Snapshot;
  decisions: Readonly<Record<string, Choice>>;
  /** Optionally binds version-conflict IDs to a scope; by default they bind to exact versions only. */
  reviewScope?: string;
  /** Binds bulk-deletion IDs; callers pass the head and local manifest identity. */
  guardScope?: string;
  /** Native holds by path. Held paths are excluded from automatic planning. */
  holds?: Readonly<Record<string, NativeHold>>;
  /**
   * Paths whose local bytes are unknown (unreadable or quarantined): never
   * published, deleted or written; the target keeps the remote version.
   */
  untouched?: readonly string[];
}

export type Plan =
  | { kind: "needs-decision"; conflicts: Conflict[]; merged: string[] }
  | {
      kind: "ready";
      target: Snapshot;
      /** Changes to publish relative to the remote commit. */
      outgoing: Changes;
      /** Local mutations, creations first, deletions last. */
      incoming: ApplyStep[];
      /** Paths combined automatically by the text merge. */
      merged: string[];
      /** Every resolved conflict, for the operation record. */
      resolved: Array<VersionConflict | BulkDeletionConflict | NativeConflict>;
      /** Undecided native holds; their paths keep GitHub's version and are not touched locally. */
      held: NativeConflict[];
    };

const CHOICES: Record<VersionConflictKind, ChoiceKind[]> = {
  content: ["mine", "remote", "both", "edit"],
  "add-add": ["mine", "remote", "both", "edit"],
  "local-deleted-remote-edited": ["mine", "remote", "edit"],
  "local-edited-remote-deleted": ["mine", "remote", "edit"],
  "local-deletion": ["mine", "remote"],
  "remote-deletion": ["mine", "remote"],
};

export function choicesFor(kind: VersionConflictKind): ChoiceKind[] {
  return CHOICES[kind];
}

/** Deleting at least this many paths from one side in one plan needs one confirmation. */
export function bulkThreshold(baseCount: number): number {
  return Math.max(25, Math.ceil(baseCount * 0.2));
}

/**
 * Unique pure renames on one side: the side deleted `from` and added `to` with
 * exactly `from`'s base bytes, and no other deleted or added path shares them.
 */
function pureRenames(base: Snapshot, side: Snapshot, other: Snapshot): Map<string, string> {
  const deleted = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  const key = (entry: Entry) => `${entry.mode}:${entry.oid}`;
  for (const [path, entry] of Object.entries(base)) {
    if (!Object.hasOwn(side, path)) deleted.set(key(entry), [...(deleted.get(key(entry)) ?? []), path]);
  }
  for (const [path, entry] of Object.entries(side)) {
    if (!Object.hasOwn(base, path) && !Object.hasOwn(other, path)) added.set(key(entry), [...(added.get(key(entry)) ?? []), path]);
  }
  const renames = new Map<string, string>();
  for (const [version, from] of deleted) {
    const to = added.get(version);
    if (from.length === 1 && to?.length === 1) renames.set(from[0]!, to[0]!);
  }
  return renames;
}

export async function reconcile(input: ReconcileInput): Promise<Plan> {
  const base = dictionary(Object.entries(input.base));
  const local = dictionary(Object.entries(input.local));
  const remote = dictionary(Object.entries(input.remote));
  const decisions = dictionary(Object.entries(input.decisions));
  const paths = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
  const occupied = new Set(paths.map(foldPath));
  const target: Snapshot = dictionary();
  const unresolved: Conflict[] = [];
  const resolved: Array<VersionConflict | BulkDeletionConflict | NativeConflict> = [];
  const merged: string[] = [];
  const decided = new Map<string, string>();
  const holds = dictionary(Object.entries(input.holds ?? {}));
  const held: NativeConflict[] = [];
  const untouched = new Set<string>(input.untouched ?? []);
  // Pure rename on one side against an edit of the old path on the other: the
  // edit moves to the new name. Anything ambiguous stays an ordinary conflict.
  const moved = new Map<string, Entry | null>();
  for (const [side, other, sideIsLocal] of [[local, remote, true], [remote, local, false]] as const) {
    for (const [from, to] of pureRenames(base, side, other)) {
      const edited = other[from];
      if (!edited || sameEntry(edited, base[from]) || Object.hasOwn(base, to) || moved.has(from) || moved.has(to) || holds[from] || holds[to] || untouched.has(from) || untouched.has(to)) continue;
      // The renaming side holds base bytes at `to`; the editing side's version wins there.
      if (!sameEntry(sideIsLocal ? local[to] : remote[to], base[from])) continue;
      moved.set(from, null);
      moved.set(to, edited);
    }
  }
  const automaticDeletions = { local: [] as string[], remote: [] as string[] };

  for (const path of paths) {
    const b = base[path] ?? null;
    const l = local[path] ?? null;
    const r = remote[path] ?? null;
    let kind: VersionConflictKind | null = null;
    let result: Entry | null = null;

    if (untouched.has(path)) {
      if (r) target[path] = r;
      continue;
    }
    const hold = holds[path];
    if (hold) {
      const conflict = await nativeConflict(path, hold, l, r);
      const choice = decisions[conflict.id];
      if (!choice || !conflict.choices.includes(choice.kind)) {
        held.push(conflict);
        untouched.add(path);
        if (r) target[path] = r;
        continue;
      }
      resolved.push(conflict);
      decided.set(path, conflict.id);
      const chosen = choice.kind === "mine" ? l : choice.kind === "remote" ? r : choice.kind === "expected" ? hold.expected
        : choice.kind === "next" ? hold.next : choice.kind === "found" ? hold.found : choice.kind === "edit" ? choice.entry : null;
      if (chosen) target[path] = chosen;
      continue;
    }
    if (moved.has(path)) result = moved.get(path) ?? null;
    else if (sameEntry(l, r)) result = l;
    else if (sameEntry(l, b)) {
      result = r;
      if (!r) automaticDeletions.remote.push(path);
    } else if (sameEntry(r, b)) {
      result = l;
      if (!l) automaticDeletions.local.push(path);
    } else if (!l) kind = "local-deleted-remote-edited";
    else if (!r) kind = "local-edited-remote-deleted";
    else if (!b) kind = "add-add";
    else {
      result = await mergeText({ path, base: b, local: l, remote: r });
      if (result) merged.push(path);
      else kind = "content";
    }

    if (kind) {
      const conflict = await versionConflict({ kind, path, base: b, local: l, remote: r }, occupied, input.reviewScope ?? "");
      const choice = decisions[conflict.id];
      if (!choice || !conflict.choices.includes(choice.kind)) {
        unresolved.push(conflict);
        continue;
      }
      resolved.push(conflict);
      decided.set(path, conflict.id);
      if (choice.kind === "mine") result = l;
      else if (choice.kind === "remote") result = r;
      else if (choice.kind === "edit") result = choice.entry;
      else {
        // "both": GitHub's version keeps the path; this device's moves aside.
        result = r;
        if (conflict.sibling && l) {
          target[conflict.sibling] = l;
          decided.set(conflict.sibling, conflict.id);
        }
      }
    }
    if (result) target[path] = result;
  }

  // Deletions whose exact bytes reappear at a new path on the same side are moves.
  const relocated = (side: Snapshot) => new Set(Object.entries(side).filter(([path]) => !Object.hasOwn(base, path)).map(([, entry]) => `${entry.mode}:${entry.oid}`));
  const threshold = bulkThreshold(Object.keys(base).length);
  for (const direction of ["local", "remote"] as const) {
    const side = direction === "local" ? local : remote;
    const additions = relocated(side);
    const deleted = automaticDeletions[direction].filter((path) => !additions.has(`${base[path]!.mode}:${base[path]!.oid}`));
    if (deleted.length < threshold && !vanishedFolder(side, untouched, deleted)) continue;
    const pathsDeleted = automaticDeletions[direction];
    const id = await digestText(JSON.stringify(["bulk-deletion/1", input.guardScope ?? "", direction, pathsDeleted.map((path) => [path, base[path]!.mode, base[path]!.oid])]));
    const conflict: BulkDeletionConflict = { kind: "bulk-deletion", id, direction, paths: pathsDeleted, choices: ["mine", "remote"] };
    const choice = decisions[id];
    if (!choice || (choice.kind !== "mine" && choice.kind !== "remote")) {
      unresolved.push(conflict);
      continue;
    }
    resolved.push(conflict);
    for (const path of pathsDeleted) {
      decided.set(path, id);
      // Keeping the non-deleting side restores its bytes (equal to the base).
      const keep = direction === "local" ? (choice.kind === "remote" ? remote[path] : null) : (choice.kind === "mine" ? local[path] : null);
      if (keep) target[path] = keep;
      else delete target[path];
    }
  }

  if (unresolved.length > 0) return { kind: "needs-decision", conflicts: [...unresolved, ...held], merged };

  const collisions = await findCollisions(target);
  if (collisions.length > 0) return { kind: "needs-decision", conflicts: collisions, merged };

  const outgoing: Changes = dictionary();
  for (const path of new Set([...Object.keys(remote), ...Object.keys(target)])) {
    if (!sameEntry(remote[path], target[path])) outgoing[path] = target[path] ?? null;
  }
  const incoming: ApplyStep[] = [];
  for (const path of new Set([...Object.keys(local), ...Object.keys(target)])) {
    if (!untouched.has(path) && !sameEntry(local[path], target[path])) {
      incoming.push({ path, expected: local[path] ?? null, next: target[path] ?? null, decision: decided.get(path) ?? null });
    }
  }
  return { kind: "ready", target, outgoing, incoming: orderSteps(incoming), merged, resolved, held };
}

/** Files a whole vanished top-level folder must have lost (not moved) to need one confirmation. */
export const FOLDER_DELETION_MINIMUM = 3;

/**
 * A top-level folder of the base that has no file left on `side`, with at
 * least FOLDER_DELETION_MINIMUM of its files deleted rather than moved: a
 * legitimate folder deletion, or unmounted storage. Either way, one review.
 */
function vanishedFolder(side: Snapshot, kept: ReadonlySet<string>, deleted: readonly string[]): boolean {
  const top = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : null);
  const remaining = new Set([...Object.keys(side), ...kept].map(top));
  const counts = new Map<string, number>();
  for (const path of deleted) {
    const folder = top(path);
    if (folder !== null && !remaining.has(folder)) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= FOLDER_DELETION_MINIMUM);
}

const NATIVE_CHOICES: ChoiceKind[] = ["mine", "expected", "next", "found", "remote", "edit"];

export function nativeChoices(hold: { found: object | null }): ChoiceKind[] {
  return NATIVE_CHOICES.filter((choice) => choice !== "found" || hold.found !== null);
}

/**
 * The id binds the hold's own base (fixed at ingestion, so checkpoint
 * advances never invalidate a recorded decision), the live and remote
 * versions, every recorded version and the oversize evidence.
 */
async function nativeConflict(path: string, hold: NativeHold, local: Entry | null, remote: Entry | null): Promise<NativeConflict> {
  const version = (entry: Entry | null) => (entry ? `${entry.mode}:${entry.oid}` : "absent");
  const kind: NativeConflictKind = hold.kind === "interrupted" ? "interrupted-write" : hold.kind === "displaced" ? "displaced-write" : "oversize-write";
  const evidence = hold.oversize.map((item) => [item.id, item.sourcePath, item.size, item.mtime]);
  const id = await digestText(JSON.stringify(["native/2", hold.id, kind, path, ...[hold.base, local, remote, hold.expected, hold.next, hold.found].map(version), evidence]));
  return { kind, id, path, base: hold.base, local, remote, expected: hold.expected, next: hold.next, found: hold.found, oversize: hold.oversize, choices: nativeChoices(hold) };
}

async function versionConflict(
  input: Omit<VersionConflict, "id" | "choices" | "sibling">,
  occupied: ReadonlySet<string>,
  reviewScope: string,
): Promise<VersionConflict> {
  const { kind, path, base, local, remote } = input;
  const version = (entry: Entry | null) => (entry ? `${entry.mode}:${entry.oid}` : "absent");
  const id = await digestText(JSON.stringify(["conflict/3", reviewScope, kind, path, version(base), version(local), version(remote)]));
  // "Keep both" is offered only when its sibling name is free on every side.
  const proposed = local && remote ? siblingPath(path, local.oid) : null;
  const sibling = proposed && isSyncablePath(proposed) && !occupied.has(foldPath(proposed)) ? proposed : null;
  const choices = CHOICES[kind].filter((choice) => choice !== "both" || sibling !== null);
  return { kind, id, path, base, local, remote, choices, sibling };
}

/** `notes/Plan.md` → `notes/Plan (conflict 1a2b3c4).md`, deterministic for the local version. */
export function siblingPath(path: string, localOid: string): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${path.slice(0, slash + 1)}${stem} (conflict ${localOid.slice(0, 7)})${extension}`;
}

async function findCollisions(target: Snapshot): Promise<CollisionConflict[]> {
  const groups = new Map<string, string[]>();
  for (const path of Object.keys(target)) {
    const key = foldPath(path);
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  const conflicts: CollisionConflict[] = [];
  for (const paths of groups.values()) {
    if (paths.length < 2) continue;
    paths.sort();
    const id = await digestText(JSON.stringify(["collision/1", ...paths.map((path) => [path, target[path]?.oid])]));
    conflicts.push({ kind: "collision", id, paths });
  }
  return conflicts;
}

/**
 * Creations and replacements before deletions, so "keep both" and similar
 * moves never pass through a state where neither copy exists. A deletion that
 * frees a case/normalization-folded name for a creation goes first.
 */
function orderSteps(steps: ApplyStep[]): ApplyStep[] {
  const created = new Set(steps.filter((step) => step.next).map((step) => foldPath(step.path)));
  const rank = (step: ApplyStep) => (step.next ? 1 : created.has(foldPath(step.path)) ? 0 : 2);
  return [...steps].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Line-based three-way text merge for Markdown.

/** Most edits a side may contain before the merge declines (bounds memory). */
const MAX_EDITS = 2000;

interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/**
 * Merges Markdown only when every changed region of one side is separated by
 * at least one unchanged line from every changed region of the other side.
 * Identical edits on both sides merge. Anything else returns null.
 */
export async function mergeText(input: { path: string; base: Entry; local: Entry; remote: Entry }): Promise<Entry | null> {
  const { path, base, local, remote } = input;
  if (!path.toLowerCase().endsWith(".md")) return null;
  const mode = local.mode === base.mode ? remote.mode : remote.mode === base.mode || remote.mode === local.mode ? local.mode : null;
  if (!mode) return null;
  const [b, l, r] = [entryText(base), entryText(local), entryText(remote)];
  if (b === null || l === null || r === null) return null;
  const baseLines = splitLines(b);
  const localHunks = diff(baseLines, splitLines(l));
  const remoteHunks = diff(baseLines, splitLines(r));
  if (!localHunks || !remoteHunks) return null;
  const lines = mergeHunks(baseLines, localHunks, remoteHunks);
  return lines ? entryFromText(lines.join(""), mode) : null;
}

/** Lines keep their terminators so CRLF, missing final newline and BOM survive exactly. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "\n") {
      lines.push(text.slice(start, at + 1));
      start = at + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function mergeHunks(base: string[], local: Hunk[], remote: Hunk[]): string[] | null {
  const all = [...local.map((hunk) => ({ hunk, side: 0 })), ...remote.map((hunk) => ({ hunk, side: 1 }))].sort(
    (a, b) => a.hunk.start - b.hunk.start || a.hunk.end - b.hunk.end,
  );
  const out: string[] = [];
  let position = 0;
  for (let at = 0; at < all.length; ) {
    const group = [all[at]!];
    let end = all[at]!.hunk.end;
    let next = at + 1;
    // Closed intervals: touching or same-point insertions from both sides conflict.
    while (next < all.length && all[next]!.hunk.start <= end) {
      group.push(all[next]!);
      end = Math.max(end, all[next]!.hunk.end);
      next++;
    }
    const sides = new Set(group.map((item) => item.side));
    let hunks = group.map((item) => item.hunk);
    if (sides.size > 1) {
      if (group.length !== 2 || !sameHunk(hunks[0]!, hunks[1]!)) return null;
      hunks = [hunks[0]!];
    }
    for (const hunk of hunks) {
      out.push(...base.slice(position, hunk.start), ...hunk.lines);
      position = hunk.end;
    }
    at = next;
  }
  out.push(...base.slice(position));
  return out;
}

function sameHunk(a: Hunk, b: Hunk): boolean {
  return a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((line, at) => line === b.lines[at]);
}

/** Myers diff from `a` to `b` as replaced ranges of `a`; null past MAX_EDITS. */
export function diff(a: string[], b: string[]): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDITS) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return null;

  // Walk back collecting matched pairs.
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d - 1]!;
    const at = (k: number) => previous[k + d - 1]!;
    const k = x - y;
    const priorK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const priorX = at(priorK);
    const priorY = priorX - priorK;
    while (x > priorX && y > priorY) matches.push([--x, --y]);
    x = priorX;
    y = priorY;
  }
  while (x > 0 && y > 0) matches.push([--x, --y]);
  matches.reverse();

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [n, m] as [number, number]]) {
    if (ma > ai || mb > bi) hunks.push({ start: ai, end: ma, lines: b.slice(bi, mb) });
    ai = ma + 1;
    bi = mb + 1;
  }
  return hunks;
}
