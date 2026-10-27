package io.github.triptu.notes.sync.internal

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

/** Git's blob id: SHA-1 over `blob <length>\0<bytes>`. */
internal fun gitBlobOid(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-1")
    digest.update("blob ${bytes.size}\u0000".toByteArray(Charsets.US_ASCII))
    digest.update(bytes)
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/** Temporary files carry this suffix and a hidden name, so no scan or listing ever includes them. */
internal const val TEMP_SUFFIX = ".sync-tmp"

/**
 * Resolves a slash-separated relative path below `root`, refusing anything
 * that could escape it or that a filesystem would reinterpret.
 */
internal fun resolveBelow(root: File, path: String): File {
    require(path.isNotEmpty() && path.length <= 4096) { "Invalid path" }
    val parts = path.split('/')
    for (part in parts) {
        require(part.isNotEmpty() && part != "." && part != "..") { "Invalid path: $path" }
        require(part.none { it == '\\' || it == '\u0000' || it < ' ' || it == '\u007f' }) { "Invalid path: $path" }
    }
    val file = File(root, parts.joinToString(File.separator))
    val base = root.canonicalPath
    require(file.canonicalPath.startsWith(base + File.separator)) { "Path escapes its folder: $path" }
    return file
}

/** Writes `bytes` to a sibling temporary file, syncs it, then renames it over `target`. */
internal fun atomicWrite(target: File, bytes: ByteArray, executable: Boolean? = null) {
    val temp = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}$TEMP_SUFFIX")
    try {
        FileOutputStream(temp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        if (executable != null) temp.setExecutable(executable, true)
        try {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: AtomicMoveNotSupportedException) {
            error("This storage cannot replace files atomically")
        }
        syncDirectory(target.parentFile)
    } finally {
        temp.delete()
    }
}

/** Best effort: makes a rename or delete in `directory` durable where the platform allows it. */
internal fun syncDirectory(directory: File?) {
    if (directory == null) return
    try {
        FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) }
    } catch (_: Exception) {
        // Not supported on every platform; the file contents themselves were synced.
    }
}

/** Removes temporary files an interrupted write left behind. */
internal fun removeStaleTemporaries(root: File) {
    root.walkTopDown().filter { it.isFile && it.name.startsWith(".") && it.name.endsWith(TEMP_SUFFIX) }.forEach { it.delete() }
}
