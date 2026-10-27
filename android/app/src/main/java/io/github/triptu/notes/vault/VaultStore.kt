package io.github.triptu.notes.vault

import kotlinx.coroutines.flow.SharedFlow

/** A note that was just deleted, kept so the deletion can be undone. */
data class DeletedNote(val path: NotePath, val text: String)

/** What a scan sees on disk: every note with its size and modified time, and every folder. */
data class VaultListing(val notes: List<NoteStat>, val folders: Set<FolderPath>)

data class NoteStat(val path: NotePath, val modifiedAt: Long, val size: Long)

/** A change the store made, or learned about, after it happened on disk. */
sealed interface VaultChange {
    data class Written(val path: NotePath, val text: String, val stat: NoteStat) : VaultChange
    data class Deleted(val path: NotePath) : VaultChange
    data class Renamed(val from: NotePath, val to: NotePath) : VaultChange

    /** Files changed underneath the store (for example a sync). Listeners should rescan. */
    data object External : VaultChange
}

/**
 * A folder of markdown notes. Every app write goes through here, so listeners see it in [changes].
 *
 * Sync plugs in by writing through this interface, or by writing the folder directly and then
 * calling [notifyExternalChange].
 */
interface VaultStore {
    val changes: SharedFlow<VaultChange>

    suspend fun list(): VaultListing

    suspend fun read(path: NotePath): String?

    suspend fun exists(path: NotePath): Boolean

    /** Replaces the note's text atomically: readers see the old text or the new text, never a mix. */
    suspend fun write(path: NotePath, text: String): NoteStat

    /** Fails if [to] already exists. */
    suspend fun rename(from: NotePath, to: NotePath)

    suspend fun delete(path: NotePath)

    /** Creates an empty folder (and any missing parents). */
    suspend fun createFolder(folder: FolderPath)

    suspend fun notifyExternalChange()
}
