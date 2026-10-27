package io.github.triptu.notes.vault

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** [VaultStore] over a plain folder. Hidden entries (`.obsidian`, `.git`, temp files) are ignored. */
class FileVaultStore(
    private val root: File,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : VaultStore {
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

    override suspend fun read(path: NotePath): String? = withContext(io) {
        val file = fileOf(path)
        if (file.isFile) file.readText() else null
    }

    override suspend fun exists(path: NotePath): Boolean = withContext(io) { fileOf(path).isFile }

    override suspend fun write(path: NotePath, text: String): NoteStat {
        val stat = withContext(io) {
            val target = fileOf(path)
            val dir = target.parentFile ?: throw IOException("No parent for $path")
            dir.mkdirs()
            val temp = File(dir, ".${target.name}.${System.nanoTime()}.tmp")
            try {
                FileOutputStream(temp).use { out ->
                    out.write(text.toByteArray(Charsets.UTF_8))
                    out.fd.sync()
                }
                Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } finally {
                temp.delete()
            }
            NoteStat(path, target.lastModified(), target.length())
        }
        _changes.emit(VaultChange.Written(path, text, stat))
        return stat
    }

    override suspend fun rename(from: NotePath, to: NotePath) {
        if (from == to) return
        withContext(io) {
            val source = fileOf(from)
            val target = fileOf(to)
            if (target.exists()) throw IOException("$to already exists")
            target.parentFile?.mkdirs()
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
        }
        _changes.emit(VaultChange.Renamed(from, to))
    }

    override suspend fun delete(path: NotePath) {
        withContext(io) { fileOf(path).delete() }
        _changes.emit(VaultChange.Deleted(path))
    }

    override suspend fun createFolder(folder: FolderPath) {
        withContext(io) { File(root, folder.value).mkdirs() }
        _changes.emit(VaultChange.External)
    }

    override suspend fun notifyExternalChange() {
        _changes.emit(VaultChange.External)
    }
}
