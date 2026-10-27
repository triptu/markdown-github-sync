import { diff, splitLines } from "./git-sync/reconcile";
import { entryText } from "./git-sync/codec";
import type { Entry } from "./git-sync/contracts";

export type DiffRow =
  | { kind: "same" | "mine" | "theirs"; text: string }
  | { kind: "skip"; count: number };

/** Unchanged lines kept around each change so the reader can place it. */
const CONTEXT = 2;

/**
 * Line rows from `theirs` (GitHub) to `mine` (this device): "mine" rows exist
 * only here, "theirs" rows only on GitHub. Long unchanged runs collapse to a
 * skip row. Null when the texts differ too much to diff cheaply.
 */
export function diffRows(mine: string, theirs: string): DiffRow[] | null {
  const a = splitLines(theirs);
  const hunks = diff(a, splitLines(mine));
  if (!hunks) return null;
  const rows: DiffRow[] = [];
  const same = (from: number, to: number, first: boolean, last: boolean) => {
    const head = first ? 0 : CONTEXT;
    const tail = last ? 0 : CONTEXT;
    if (to - from <= head + tail + 1) {
      for (let at = from; at < to; at++) rows.push({ kind: "same", text: a[at] });
      return;
    }
    for (let at = from; at < from + head; at++) rows.push({ kind: "same", text: a[at] });
    rows.push({ kind: "skip", count: to - from - head - tail });
    for (let at = to - tail; at < to; at++) rows.push({ kind: "same", text: a[at] });
  };
  let position = 0;
  hunks.forEach((hunk, index) => {
    same(position, hunk.start, index === 0, false);
    // This device first, matching the legend and the order of the choices.
    for (const line of hunk.lines) rows.push({ kind: "mine", text: line });
    for (let at = hunk.start; at < hunk.end; at++) rows.push({ kind: "theirs", text: a[at] });
    position = hunk.end;
  });
  same(position, a.length, hunks.length === 0, true);
  return rows;
}

/** Markdown with each differing block from both sides, labelled, for "Edit and combine". */
export function combinedDraft(local: Entry | null, remote: Entry | null): string | null {
  const mine = local ? entryText(local) : null;
  const theirs = remote ? entryText(remote) : null;
  if (mine === null || theirs === null) return null;
  const a = splitLines(theirs);
  const hunks = diff(a, splitLines(mine));
  if (!hunks) return null;
  const out: string[] = [];
  let position = 0;
  for (const hunk of hunks) {
    out.push(...a.slice(position, hunk.start));
    const gh = a.slice(hunk.start, hunk.end);
    if (!gh.length) out.push(...hunk.lines);
    else if (!hunk.lines.length) out.push(...gh);
    else out.push(...hunk.lines, ...gh);
    position = hunk.end;
  }
  out.push(...a.slice(position));
  // A side's last line may lack a newline; keep lines from running together.
  return out.map((line, at) => at < out.length - 1 && !line.endsWith("\n") ? `${line}\n` : line).join("");
}
