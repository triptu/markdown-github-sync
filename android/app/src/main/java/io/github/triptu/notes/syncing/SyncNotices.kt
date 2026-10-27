package io.github.triptu.notes.syncing

import io.github.triptu.notes.sync.SyncError
import io.github.triptu.notes.sync.SyncStatus
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot

/** One quiet line at the top of Home. Success never shows one. */
sealed interface SyncNotice {
    data class Downloading(val done: Int?, val total: Int?) : SyncNotice
    /** GitHub refused the token or repository. Opens Settings at the token. */
    data class NeedsToken(val message: String) : SyncNotice
    /** Any other stop. Tapping shows [message] and "Try again". */
    data class Problem(val message: String) : SyncNotice
    data class NotSynced(val hours: Long) : SyncNotice
    data class Deletion(val decision: DeletionDecision) : SyncNotice
    data class BothVersions(val notes: List<NotePath>) : SyncNotice
}

/** What Home shows about sync: the muted offline icon, and at most a few quiet lines. */
data class SyncBar(val offline: Boolean, val notices: List<SyncNotice>) {
    companion object {
        val Quiet = SyncBar(false, emptyList())
    }
}

object SyncNotices {
    /** Offline this long without a sync, the icon becomes a line. */
    const val OfflineNoticeMs = 6 * 60 * 60 * 1000L

    /**
     * [settled] is the last status that wasn't a sync in progress, so a retry doesn't make lines
     * blink; [progress] is the sync running now, if any.
     */
    fun bar(
        settled: SyncStatus,
        progress: SyncStatus.Syncing?,
        firstSync: Boolean,
        deletion: DeletionDecision?,
        conflictProblem: String?,
        bothVersions: List<NotePath>,
        now: Long,
    ): SyncBar {
        val notices = ArrayList<SyncNotice>()
        var offline = false
        if (deletion != null) notices += SyncNotice.Deletion(deletion)
        when (settled) {
            is SyncStatus.Error ->
                notices += if (settled.error.kind == SyncError.Kind.Access) SyncNotice.NeedsToken(settled.error.message.orEmpty())
                else SyncNotice.Problem(settled.error.message ?: SyncCopy.Stopped)
            is SyncStatus.Offline -> {
                val since = settled.lastSyncedAt
                if (since != null && now - since >= OfflineNoticeMs) notices += SyncNotice.NotSynced((now - since) / 3_600_000)
                else offline = true
            }
            is SyncStatus.Idle -> settled.notice?.let { notices += SyncNotice.Problem(it) }
            else -> Unit
        }
        if (conflictProblem != null) notices += SyncNotice.Problem(conflictProblem)
        if (firstSync && settled !is SyncStatus.Error) notices.add(0, SyncNotice.Downloading(progress?.done, progress?.total))
        if (bothVersions.isNotEmpty()) notices += SyncNotice.BothVersions(bothVersions)
        // One problem line is enough.
        val firstProblem = notices.indexOfFirst { it is SyncNotice.Problem }
        val trimmed = notices.filterIndexed { i, n -> n !is SyncNotice.Problem || i == firstProblem }
        return SyncBar(offline, trimmed)
    }
}

/**
 * Notes that still hold both versions of some lines, newest first. Remembers the previous answer
 * per note object, so a snapshot after one autosave rechecks only that note.
 */
class BothVersionsFinder {
    private var previous: Map<NotePath, Pair<IndexedNote, Boolean>> = emptyMap()

    fun find(snapshot: VaultSnapshot): List<NotePath> {
        val next = HashMap<NotePath, Pair<IndexedNote, Boolean>>(snapshot.notes.size)
        for ((path, note) in snapshot.notes) {
            val known = previous[path]
            next[path] = if (known != null && known.first === note) known else note to BothVersions.hasMarkers(note.text)
        }
        previous = next
        return next.values.filter { it.second }.map { it.first }.sortedByDescending { it.modifiedAt }.map { it.path }
    }
}
