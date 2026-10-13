import { unzipSync } from "fflate";

export class ArchiveError extends Error {
  constructor(message: string) { super(message); this.name = "ArchiveError"; }
}
const ENTRY_LIMIT = 200_000;

/**
 * Selects `wanted` repository paths from an in-memory GitHub zipball. Nothing
 * is written anywhere: entries are matched by exact name below the single
 * top-level directory GitHub adds, so no entry name is ever resolved as a
 * filesystem path. Only stored or deflated entries whose declared sizes
 * equal the wanted size are read, into a buffer of exactly that size, which
 * bounds expansion by the caller's wanted sizes. A wanted path that is absent
 * or resized (as export-ignore or export-subst can do), or uses another
 * compression method, is simply not returned; the caller
 * verifies every returned byte against the tree. Entries outside the single
 * root, repeated wanted paths and unreadable archives throw ArchiveError.
 */
export function selectArchiveFiles(zip: Uint8Array, wanted: ReadonlyMap<string, number>): Map<string, Uint8Array> {
  let root: string | undefined, entries = 0, failure: ArchiveError | undefined;
  const seen = new Set<string>();
  const filter = ({ name, size: stored, originalSize, compression }: { name: string; size: number; originalSize: number; compression: number }): boolean => {
    if (failure) return false;
    if (++entries > ENTRY_LIMIT) { failure = new ArchiveError("Archive entry limit exceeded"); return false; }
    root ??= name.slice(0, name.indexOf("/") + 1);
    if (!root || !name.startsWith(root)) { failure = new ArchiveError("Archive entry outside its root directory"); return false; }
    const path = name.slice(root.length), size = wanted.get(path);
    if (size === undefined) return false;
    if (seen.has(path)) { failure = new ArchiveError("Duplicate archive path"); return false; }
    seen.add(path);
    // Stored entries are copied at their compressed size, so it must match too;
    // other methods are skipped and fall back to single blob reads.
    return originalSize === size && (compression === 8 || compression === 0 && stored === size);
  };
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(zip, { filter }); }
  catch { throw new ArchiveError("Unreadable archive"); }
  if (failure) throw failure;
  const result = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) result.set(name.slice(root?.length ?? 0), bytes);
  return result;
}
