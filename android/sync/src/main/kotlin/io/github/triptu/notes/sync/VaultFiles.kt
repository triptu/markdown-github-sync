package io.github.triptu.notes.sync

import io.github.triptu.notes.sync.internal.TEMP_SUFFIX
import io.github.triptu.notes.sync.internal.atomicWrite
import io.github.triptu.notes.sync.internal.gitBlobOid
import io.github.triptu.notes.sync.internal.removeStaleTemporaries
import io.github.triptu.notes.sync.internal.resolveBelow
import io.github.triptu.notes.sync.internal.syncDirectory
import java.io.File
import java.util.Base64
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The app's private copy of the vault, a plain folder. The app must make
 * every change through this class: sync replaces a file only if it still
 * holds the exact bytes sync expects, and that check and the replacement
 * happen under the same lock as the app's writes. Writes are atomic
 * (temporary file plus rename), so readers never see a partial file.
 */
class VaultFiles(val root: File) {
    private val lock = ReentrantLock()

    /** Called after each app write or delete (not after sync's own writes). */
    @Volatile
    internal var onLocalChange: (() -> Unit)? = null

    /** Paths sync wrote or deleted since the last call to [takeSyncedPaths]. */
    private val synced = LinkedHashSet<String>()

    init {
        root.mkdirs()
        require(root.isDirectory) { "Vault folder is unavailable: $root" }
        removeStaleTemporaries(root)
    }

    /** UTF-8 text of a note, or null when it does not exist. */
    fun readText(path: String): String? {
        val file = resolveBelow(root, path)
        return if (file.isFile) file.readText(Charsets.UTF_8) else null
    }

    fun readBytes(path: String): ByteArray? {
        val file = resolveBelow(root, path)
        return if (file.isFile) file.readBytes() else null
    }

    /** Creates or replaces a file atomically, keeping its executable bit. */
    fun writeText(path: String, text: String) = writeBytes(path, text.toByteArray(Charsets.UTF_8))

    fun writeBytes(path: String, bytes: ByteArray) {
        lock.withLock {
            val file = resolveBelow(root, path)
            ensureParents(file)?.let { error(it) }
            check(!file.isDirectory) { "A folder already exists at $path" }
            atomicWrite(file, bytes, executable = file.isFile && file.canExecute())
        }
        onLocalChange?.invoke()
    }

    /** Deletes a file; returns false when it did not exist. */
    fun delete(path: String): Boolean {
        val deleted = lock.withLock {
            val file = resolveBelow(root, path)
            file.isFile && file.delete().also { if (it) { syncDirectory(file.parentFile); pruneEmptyParents(file) } }
        }
        if (deleted) onLocalChange?.invoke()
        return deleted
    }

    /** Moves a file; refuses to replace an existing one. */
    fun move(from: String, to: String) {
        lock.withLock {
            val source = resolveBelow(root, from)
            val target = resolveBelow(root, to)
            check(source.isFile) { "No file at $from" }
            check(!target.exists()) { "Something already exists at $to" }
            ensureParents(target)?.let { error(it) }
            check(source.renameTo(target)) { "Could not move $from" }
            syncDirectory(source.parentFile)
            syncDirectory(target.parentFile)
            pruneEmptyParents(source)
        }
        onLocalChange?.invoke()
    }

    /** Creates a folder and any missing parents. Sync ignores empty folders. */
    fun createFolder(path: String) {
        lock.withLock {
            val folder = resolveBelow(root, path)
            ensureParents(File(folder, "x"))?.let { error(it) }
        }
    }

    /** Every file outside hidden folders: what the app can show, and what sync scans. */
    fun list(): List<VaultEntry> {
        val result = ArrayList<VaultEntry>()
        val base = root.absolutePath.length + 1
        fun walk(directory: File) {
            val children = directory.listFiles() ?: return
            for (child in children) {
                if (child.isDirectory) {
                    if (!child.name.startsWith(".")) walk(child)
                } else if (child.isFile && !(child.name.startsWith(".") && child.name.endsWith(TEMP_SUFFIX))) {
                    val path = child.absolutePath.substring(base).replace(File.separatorChar, '/')
                    result.add(VaultEntry(path, child.length(), child.lastModified(), child.canExecute()))
                }
            }
        }
        walk(root)
        return result
    }

    internal fun takeSyncedPaths(): List<String> = lock.withLock { synced.toList().also { synced.clear() } }

    /** `{ data, oid, size, mtime }` as JSON, `{ oversize }` past the limit, or `null` when missing. */
    internal fun readEntryJson(path: String): String {
        val file = resolveBelow(root, path)
        if (!file.isFile) return "null"
        val size = file.length()
        if (size > FILE_LIMIT) return """{"oversize":$size}"""
        val mtime = file.lastModified()
        val bytes = file.readBytes()
        if (bytes.size > FILE_LIMIT) return """{"oversize":${bytes.size}}"""
        val data = Base64.getEncoder().encodeToString(bytes)
        // A concurrent atomic replace changes the mtime; report the stat taken before the read.
        return """{"data":"$data","oid":"${gitBlobOid(bytes)}","size":${bytes.size},"mtime":$mtime}"""
    }

    /**
     * The engine's compare-and-swap: replace `path`, which must hold the blob
     * `expectedOid` (null: must be absent), by `nextData` (null: delete).
     * Returns `applied`, `changed` (nothing written) or `blocked:<reason>`.
     */
    internal fun apply(path: String, expectedOid: String?, nextData: String?, nextOid: String?, executable: Boolean): String {
        val next = nextData?.let { Base64.getDecoder().decode(it) }
        if (next != null) {
            require(next.size <= FILE_LIMIT) { "Invalid incoming bytes: $path" }
            require(gitBlobOid(next) == nextOid) { "Incoming bytes do not match their id: $path" }
        }
        return lock.withLock {
            val file = resolveBelow(root, path)
            if (file.isDirectory) return@withLock "blocked:A folder is in the way of $path"
            val current = if (file.isFile) gitBlobOid(file.readBytes()) else null
            when {
                next != null && current == nextOid -> {
                    if (file.canExecute() != executable) file.setExecutable(executable, true)
                    "applied"
                }
                next == null && current == null -> "applied"
                current != expectedOid -> "changed"
                next != null -> {
                    ensureParents(file)?.let { return@withLock "blocked:$it" }
                    atomicWrite(file, next, executable)
                    synced.add(path)
                    "applied"
                }
                else -> {
                    if (!file.delete()) return@withLock "blocked:Could not delete $path"
                    syncDirectory(file.parentFile)
                    pruneEmptyParents(file)
                    synced.add(path)
                    "applied"
                }
            }
        }
    }

    /** Creates missing parent folders; returns a reason when a file is in the way. */
    private fun ensureParents(file: File): String? {
        val parent = file.parentFile ?: return null
        if (parent.isDirectory) return null
        var cursor: File? = parent
        while (cursor != null && cursor != root) {
            if (cursor.isFile) return "A file is in the way of folder ${cursor.name}"
            cursor = cursor.parentFile
        }
        if (!parent.mkdirs() && !parent.isDirectory) return "Could not create folder for ${file.name}"
        return null
    }

    private fun pruneEmptyParents(file: File) {
        var cursor = file.parentFile
        while (cursor != null && cursor != root && cursor.isDirectory && (cursor.list()?.isEmpty() == true)) {
            if (!cursor.delete()) break
            cursor = cursor.parentFile
        }
    }

    internal companion object {
        const val FILE_LIMIT = 8 * 1024 * 1024
    }
}

data class VaultEntry(val path: String, val size: Long, val modified: Long, val executable: Boolean)
