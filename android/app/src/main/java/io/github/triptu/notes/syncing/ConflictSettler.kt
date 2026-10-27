package io.github.triptu.notes.syncing

import io.github.triptu.notes.sync.Resolution
import io.github.triptu.notes.sync.SyncConflict
import io.github.triptu.notes.sync.SyncError

/**
 * The user's rule for conflicts: never block on a dialog. A note edited on both sides keeps both
 * versions inline ([BothVersions]); an edit beats a deletion; other files keep both copies. Only
 * a bulk deletion waits for a choice, and names differing in case wait for a rename.
 */
class ConflictSettler {
    /** What still needs the person after settling. */
    data class Left(val deletion: DeletionDecision?, val problem: String?)

    /** Conflicts already resolved, so a sync reporting them again before applying isn't resolved twice. */
    private val settled = HashSet<String>()

    fun reset() = settled.clear()

    suspend fun settle(conflicts: List<SyncConflict>, resolve: suspend (conflictId: String, Resolution) -> Unit): Left {
        var deletion: DeletionDecision? = null
        var problem: String? = null
        for (conflict in conflicts) {
            if (conflict.id in settled) continue
            val resolution: Resolution? = when (conflict.kind) {
                "content", "add-add" -> {
                    val mine = conflict.local?.text
                    val theirs = conflict.remote?.text
                    when {
                        mine != null && theirs != null && "edit" in conflict.choices ->
                            Resolution.Edited(BothVersions.merge(conflict.base?.text, mine, theirs))
                        "both" in conflict.choices -> Resolution.Both
                        else -> null
                    }
                }
                "local-deleted-remote-edited" -> Resolution.Theirs
                "local-edited-remote-deleted" -> Resolution.Mine
                "bulk-deletion" -> {
                    deletion = deletion ?: DeletionDecision(conflict.id, conflict.direction, conflict.paths.size)
                    null
                }
                "collision" -> {
                    problem = problem ?: SyncCopy.collision(conflict.paths)
                    null
                }
                else -> null
            }
            if (resolution == null) {
                if (conflict.kind != "bulk-deletion" && conflict.kind != "collision") problem = problem ?: SyncCopy.needsChoice(conflict.path)
                continue
            }
            try {
                resolve(conflict.id, resolution)
                settled += conflict.id
            } catch (e: SyncError) {
                // Not recorded: the next report of this conflict tries again.
            }
        }
        return Left(deletion, problem)
    }
}
