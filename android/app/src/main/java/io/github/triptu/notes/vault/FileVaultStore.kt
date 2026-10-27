package io.github.triptu.notes.vault

import io.github.triptu.notes.sync.VaultFiles
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * [VaultStore] over a plain folder. Hidden entries (`.obsidian`, `.git`, temp files) are ignored.
 *
 * Every write goes through the sync layer's [VaultFiles]: its lock is the one sync takes for its
 * compare-and-swap, so a sync never replaces an edit saved in the same instant. It is created on
 * first use, off the main thread, because creating it sweeps the folder for stale temporary files.
 */
class FileVaultStore(
    private val vault: Lazy<VaultFiles>,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : VaultStore {
    constructor(root: File, io: CoroutineDispatcher = Dispatchers.IO) : this(lazy { VaultFiles(root) }, io)

    private val files: VaultFiles get() = vault.value
    private val root: File get() = files.root
    private val _changes = MutableSharedFlow<VaultChange>(extraBufferCapacity = 64)
    override val changes: SharedFlow<VaultChange> = _changes.asSharedFlow()

    private fun fileOf(path: NotePath) = File(root, path.value)

    override suspend fun list(): VaultListing = withContext(io) {
        val notes = ArrayList<NoteStat>()
        val folders = HashSet<FolderPath>()
        fun walk(dir: File, folder: FolderPath) {
            val children = dir.listFiles() ?: return
            for (child in children) {
                if (child.name.startsWith(".")) continue
                if (child.isDirectory) {
                    val sub = folder.child(child.name)
                    folders += sub
                    walk(child, sub)
                } else if (child.name.endsWith(NotePath.MD)) {
                    notes += NoteStat(folder.note(child.name.removeSuffix(NotePath.MD)), child.lastModified(), child.length())
                }
            }
        }
        root.mkdirs()
        walk(root, FolderPath.Root)
        VaultListing(notes, folders)
    }

    override suspend fun read(path: NotePath): String? = withContext(io) { files.readText(path.value) }

    override suspend fun exists(path: NotePath): Boolean = withContext(io) { fileOf(path).isFile }

    override suspend fun write(path: NotePath, text: String): NoteStat {
        val stat = withContext(io) {
            refusalsAsIo { files.writeText(path.value, text) }
            val target = fileOf(path)
            NoteStat(path, target.lastModified(), target.length())
        }
        _changes.emit(VaultChange.Written(path, text, stat))
        return stat
    }

    override suspend fun update(path: NotePath, change: (String?) -> String?): String? {
        val (text, stat) = withContext(io) {
            val text = refusalsAsIo { files.updateText(path.value, change) } ?: return@withContext null to null
            val target = fileOf(path)
            text to NoteStat(path, target.lastModified(), target.length())
        }
        if (text != null && stat != null) _changes.emit(VaultChange.Written(path, text, stat))
        return text
    }

    override suspend fun rename(from: NotePath, to: NotePath) {
        if (from == to) return
        withContext(io) { refusalsAsIo { files.move(from.value, to.value) } }
        _changes.emit(VaultChange.Renamed(from, to))
    }

    override suspend fun delete(path: NotePath) {
        withContext(io) { files.delete(path.value) }
        _changes.emit(VaultChange.Deleted(path))
    }

    override suspend fun createFolder(folder: FolderPath) {
        if (folder.isRoot) return
        withContext(io) { refusalsAsIo { files.createFolder(folder.value) } }
        _changes.emit(VaultChange.External)
    }

    override suspend fun notifyExternalChange() {
        _changes.emit(VaultChange.External)
    }

    /** [VaultFiles] reports refusals (the target exists, a file is in the way) as state errors. */
    private inline fun <T> refusalsAsIo(body: () -> T): T =
        try {
            body()
        } catch (e: IllegalStateException) {
            throw IOException(e.message, e)
        } catch (e: IllegalArgumentException) {
            throw IOException(e.message, e)
        }
}
