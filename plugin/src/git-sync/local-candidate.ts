interface LocalFiles {
  stat(path: string): Promise<{ type: string; size: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

/** A read-only download hint. The repository verifies the returned bytes against GitHub's blob ID. */
export async function readLocalCandidate(files: LocalFiles, path: string, expectedSize: number): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 8 * 1024 * 1024) return null;
  try {
    const stat = await files.stat(path);
    if (!stat || stat.type !== "file" || stat.size !== expectedSize) return null;
    const bytes = new Uint8Array(await files.readBinary(path));
    return bytes.byteLength === expectedSize ? bytes : null;
  } catch {
    // A missing, unreadable, or concurrently replaced local file is simply not a download source.
    return null;
  }
}
