package io.github.triptu.notes.vault

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import java.io.File

data class IndexedNote(
    val path: NotePath,
    val modifiedAt: Long,
    val size: Long,
    /** The most recently changed paragraph, for Recents. */
    val snippet: String,
    val text: String,
)

/**
 * Everything the index knows at one moment. Identity equality on purpose: comparing whole vaults
 * on every emission would cost more than it saves.
 */
class VaultSnapshot(
    val notes: Map<NotePath, IndexedNote>,
    val folders: Set<FolderPath>,
    /** False while showing the on-disk cache from the last run, before the first rescan finishes. */
    val isFresh: Boolean,
) {
    companion object {
        val Empty = VaultSnapshot(emptyMap(), emptySet(), isFresh = false)
    }
}

/**
 * In-memory index of the vault, used by Library, search and Recents.
 *
 * Starts from a cache file so the first frame has data, then rescans: listing is cheap (stat only)
 * and only files whose size or modified time changed are read again.
 */
class VaultIndex(
    private val store: VaultStore,
    private val cacheFile: File,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _snapshot = MutableStateFlow(VaultSnapshot.Empty)
    val snapshot: StateFlow<VaultSnapshot> = _snapshot.asStateFlow()
    private val mutex = Mutex()

    fun start() {
        scope.launch {
            mutex.withLock {
                val cached = withContext(io) { IndexCache.read(cacheFile) }
                if (cached != null && !_snapshot.value.isFresh) _snapshot.value = cached
            }
            refresh()
        }
        scope.launch {
            store.changes.collect { change ->
                when (change) {
                    is VaultChange.Written -> applyWrite(change)
                    is VaultChange.Deleted -> update { notes, folders -> notes.remove(change.path); folders }
                    is VaultChange.Renamed -> update { notes, folders ->
                        notes.remove(change.from)?.let { notes[change.to] = it.copy(path = change.to) }
                        folders
                    }
                    VaultChange.External -> refresh()
                }
            }
        }
    }

    /** Rescans the folder and re-reads only what changed. */
    suspend fun refresh() = mutex.withLock {
        val listing = store.list()
        val previous = _snapshot.value.notes
        val next = HashMap<NotePath, IndexedNote>(listing.notes.size)
        var reads = 0
        for (stat in listing.notes) {
            val old = previous[stat.path]
            if (old != null && old.modifiedAt == stat.modifiedAt && old.size == stat.size) {
                next[stat.path] = old
                continue
            }
            val text = store.read(stat.path) ?: continue
            next[stat.path] = IndexedNote(stat.path, stat.modifiedAt, stat.size, RecentSnippet.of(old?.text, text), text)
            if (++reads % 50 == 0) yield()
        }
        val folders = listing.folders + listing.notes.mapNotNull { it.path.folder.takeUnless(FolderPath::isRoot) }
        publish(VaultSnapshot(next, folders, isFresh = true))
    }

    private suspend fun applyWrite(change: VaultChange.Written) = update { notes, folders ->
        val old = notes[change.path]
        notes[change.path] = IndexedNote(
            change.path, change.stat.modifiedAt, change.stat.size, RecentSnippet.of(old?.text, change.text), change.text,
        )
        var folder = change.path.folder
        val withParents = folders.toMutableSet()
        while (!folder.isRoot) {
            withParents += folder
            folder = folder.parent ?: break
        }
        withParents
    }

    private suspend fun update(edit: (MutableMap<NotePath, IndexedNote>, Set<FolderPath>) -> Set<FolderPath>) =
        mutex.withLock {
            val current = _snapshot.value
            val notes = HashMap(current.notes)
            val folders = edit(notes, current.folders)
            publish(VaultSnapshot(notes, folders, current.isFresh))
        }

    private var cacheWrite: Job? = null

    /** Publishes at once; writes the cache a little later so a burst of autosaves writes it once. */
    private fun publish(snapshot: VaultSnapshot) {
        _snapshot.value = snapshot
        cacheWrite?.cancel()
        cacheWrite = scope.launch {
            delay(CacheWriteDelayMs)
            withContext(io) { IndexCache.write(cacheFile, _snapshot.value) }
        }
    }

    private companion object {
        const val CacheWriteDelayMs = 2_000L
    }
}
