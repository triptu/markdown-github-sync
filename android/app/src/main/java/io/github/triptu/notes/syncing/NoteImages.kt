package io.github.triptu.notes.syncing

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import io.github.triptu.notes.sync.SyncError
import io.github.triptu.notes.sync.VaultFiles
import io.github.triptu.notes.vault.NotePath
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** What the editor draws for one `![](…)` or `![[…]]` embed. */
sealed interface ImageState {
    data object Loading : ImageState
    data class Ready(val bitmap: Bitmap) : ImageState
    /** A plain label instead of the picture. */
    data class Unavailable(val label: String) : ImageState
}

/**
 * Pictures embedded in notes. Images normally stay on GitHub (sync leaves them there), so they
 * are downloaded on first view through [GitHubSync.attachment], which keeps a disk cache; decoded
 * bitmaps are kept in memory, sized for the screen.
 */
class NoteImages(
    private val files: Lazy<VaultFiles>,
    private val sync: GitHubSync,
    private val maxWidth: Int,
) {
    private val memory = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }

    /** Loads [target] as written in [note]. Never throws. */
    suspend fun load(note: NotePath?, target: String, wiki: Boolean): ImageState = withContext(Dispatchers.IO) {
        try {
            val path = resolve(note, target, wiki) ?: return@withContext ImageState.Unavailable(SyncCopy.ImageMissing)
            memory.get(path)?.let { return@withContext ImageState.Ready(it) }
            val local = File(files.value.root, path).takeIf { it.isFile && !sync.isOnDemand(path) }
            val file = local ?: sync.attachment(path)
            val bitmap = decode(file) ?: return@withContext ImageState.Unavailable(SyncCopy.ImageUnsupported)
            memory.put(path, bitmap)
            ImageState.Ready(bitmap)
        } catch (e: SyncError) {
            ImageState.Unavailable(if (e.kind == SyncError.Kind.Offline) SyncCopy.ImageOffline else SyncCopy.ImageMissing)
        } catch (e: Exception) {
            ImageState.Unavailable(SyncCopy.ImageMissing)
        }
    }

    /**
     * Obsidian's rules, simply: a path with a folder is tried next to the note, then from the
     * vault root; a bare `![[name]]` is found by name, here first, then on GitHub.
     */
    private suspend fun resolve(note: NotePath?, target: String, wiki: Boolean): String? {
        val clean = target.trim().removePrefix("/").removePrefix("./")
        if (clean.isEmpty() || clean.contains("://")) return null
        val folder = note?.folder?.value.orEmpty()
        val candidates = listOfNotNull(if (folder.isNotEmpty()) normalize("$folder/$clean") else null, normalize(clean)).distinct()
        val local = files.value
        candidates.firstOrNull { File(local.root, it).isFile }?.let { return it }
        val remote = if (sync.target.value != null) sync.remotePaths() else emptyList()
        candidates.firstOrNull { it in remote }?.let { return it }
        if (!wiki && clean.contains('/')) return candidates.last()
        // By name: the shortest path wins, as in Obsidian.
        val name = clean.substringAfterLast('/')
        val byName = (local.list().map { it.path } + remote).filter { it == name || it.endsWith("/$name") }
        return byName.minByOrNull { it.count { c -> c == '/' } }
    }

    private fun normalize(path: String): String? {
        val parts = ArrayList<String>()
        for (part in path.split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> parts.removeLastOrNull() ?: return null
                else -> parts += part
            }
        }
        return parts.joinToString("/").ifEmpty { null }
    }

    private fun decode(file: File): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
