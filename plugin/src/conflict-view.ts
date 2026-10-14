import { diff, splitLines } from "./git-sync/reconcile";

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
      for (let at = from; at < to; at++) rows.push({ kind: "same", text: a[at]! });
      return;
    }
    for (let at = from; at < from + head; at++) rows.push({ kind: "same", text: a[at]! });
    rows.push({ kind: "skip", count: to - from - head - tail });
    for (let at = to - tail; at < to; at++) rows.push({ kind: "same", text: a[at]! });
  };
  let position = 0;
  hunks.forEach((hunk, index) => {
    same(position, hunk.start, index === 0, false);
    // This device first, matching the legend and the order of the choices.
    for (const line of hunk.lines) rows.push({ kind: "mine", text: line });
    for (let at = hunk.start; at < hunk.end; at++) rows.push({ kind: "theirs", text: a[at]! });
    position = hunk.end;
  });
  same(position, a.length, hunks.length === 0, true);
  return rows;
}
