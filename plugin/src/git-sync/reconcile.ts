// Pure three-way reconciliation of one coherent base, the captured local
// snapshot and one remote commit. No I/O; hashing is the only async work.
import type { Changes, Entry, Snapshot } from "./contracts";
import { dictionary, digestText, entryFromText, entryText, foldPath, isSyncablePath, sameEntry } from "./codec";

export type ChoiceKind = "mine" | "remote" | "both" | "edit";
/** A user decision. `edit` carries the exact replacement content. */
export type Choice = { kind: "mine" } | { kind: "remote" } | { kind: "both" } | { kind: "edit"; entry: Entry };

export type VersionConflictKind =
  | "content" // both sides edited, not safely mergeable
  | "add-add" // both sides created the path with different content
  | "local-deleted-remote-edited"
  | "local-edited-remote-deleted"
  | "local-deletion" // only this device removed it: needs review
  | "remote-deletion"; // only GitHub removed it: needs review

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

export type Conflict = VersionConflict | CollisionConflict;

/** One guarded local mutation: replace `expected` (null = absent) by `next` (null = delete). */
export interface ApplyStep {
  path: string;
  expected: Entry | null;
  next: Entry | null;
  /** Reviewed mutations retain their original merge base for fresh review after revocation. */
  consent: { kind: "automatic" } | { kind: "reviewed"; base: Entry | null };
}

export interface ReconcileInput {
  base: Snapshot;
  local: Snapshot;
  remote: Snapshot;
  decisions: Readonly<Record<string, Choice>>;
  /** Bind conflict IDs to a particular head and review generation. */
  reviewScope?: string;
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
      resolved: VersionConflict[];
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

export async function reconcile(input: ReconcileInput): Promise<Plan> {
  const base = dictionary(Object.entries(input.base));
  const local = dictionary(Object.entries(input.local));
  const remote = dictionary(Object.entries(input.remote));
  const decisions = dictionary(Object.entries(input.decisions));
  const paths = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
  const occupied = new Set(paths.map(foldPath));
  const target: Snapshot = dictionary();
  const unresolved: Conflict[] = [];
  const resolved: VersionConflict[] = [];
  const merged: string[] = [];

  for (const path of paths) {
    const b = base[path] ?? null;
    const l = local[path] ?? null;
    const r = remote[path] ?? null;
    let kind: VersionConflictKind | null = null;
    let result: Entry | null = null;

    if (sameEntry(l, r)) result = l;
    else if (sameEntry(l, b)) {
      if (r) result = r;
      else kind = "remote-deletion";
    } else if (sameEntry(r, b)) {
      if (l) result = l;
      else kind = "local-deletion";
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
      if (choice.kind === "mine") result = l;
      else if (choice.kind === "remote") result = r;
      else if (choice.kind === "edit") result = choice.entry;
      else {
        // "both": GitHub's version keeps the path; this device's moves aside.
        result = r;
        if (conflict.sibling && l) target[conflict.sibling] = l;
      }
    }
    if (result) target[path] = result;
  }

  if (unresolved.length > 0) return { kind: "needs-decision", conflicts: unresolved, merged };

  const collisions = await findCollisions(target);
  if (collisions.length > 0) return { kind: "needs-decision", conflicts: collisions, merged };

  const outgoing: Changes = dictionary();
  for (const path of new Set([...Object.keys(remote), ...Object.keys(target)])) {
    if (!sameEntry(remote[path], target[path])) outgoing[path] = target[path] ?? null;
  }
  const incoming: ApplyStep[] = [];
  for (const path of new Set([...Object.keys(local), ...Object.keys(target)])) {
    if (!sameEntry(local[path], target[path])) {
      const conflict = resolved.find((item) => item.path === path || item.sibling === path);
      incoming.push({
        path,
        expected: local[path] ?? null,
        next: target[path] ?? null,
        consent: conflict
          ? { kind: "reviewed", base: conflict.path === path ? conflict.base : null }
          : { kind: "automatic" },
      });
    }
  }
  return { kind: "ready", target, outgoing, incoming: orderSteps(incoming), merged, resolved };
}

async function versionConflict(
  input: Omit<VersionConflict, "id" | "choices" | "sibling">,
  occupied: ReadonlySet<string>,
  reviewScope: string,
): Promise<VersionConflict> {
  const { kind, path, base, local, remote } = input;
  const version = (entry: Entry | null) => (entry ? `${entry.mode}:${entry.oid}` : "absent");
  const id = await digestText(JSON.stringify(["conflict/2", reviewScope, kind, path, version(base), version(local), version(remote)]));
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
