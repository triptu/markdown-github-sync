package io.github.triptu.notes.voice

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import java.io.File

/** Where spoken words go when they're saved. */
sealed interface VoiceTarget {
    /** A new note in [folder], named like a typed new note. */
    data class NewNote(val folder: FolderPath) : VoiceTarget

    /** Into [path] at [cursor], from the editor's mic. */
    data class IntoNote(val path: NotePath, val cursor: Int) : VoiceTarget
}

/** Words heard but not saved yet, kept so a call, the app closing or X never loses them. */
data class VoiceDraft(val target: VoiceTarget, val text: String, val elapsedMs: Long) {
    fun encode(): String {
        val (kind, place, cursor) = when (target) {
            is VoiceTarget.NewNote -> Triple("new", target.folder.value, 0)
            is VoiceTarget.IntoNote -> Triple("into", target.path.value, target.cursor)
        }
        return "$Version\n$kind\n$place\n$cursor\n$elapsedMs\n$text"
    }

    companion object {
        private const val Version = "voice-draft 1"

        /** Null for anything that isn't a whole draft. */
        fun decode(raw: String): VoiceDraft? {
            val parts = raw.split('\n', limit = 6)
            if (parts.size < 6 || parts[0] != Version) return null
            val cursor = parts[3].toIntOrNull() ?: return null
            val elapsed = parts[4].toLongOrNull() ?: return null
            val target = when (parts[1]) {
                "new" -> VoiceTarget.NewNote(FolderPath(parts[2]))
                "into" -> parts[2].takeIf { it.endsWith(NotePath.MD) }?.let { VoiceTarget.IntoNote(NotePath(it), cursor) } ?: return null
                else -> return null
            }
            return VoiceDraft(target, parts[5], elapsed)
        }
    }
}

/**
 * Drafts, one file per recording, in a folder outside the vault so they never sync. Writes are
 * atomic. Each recording has its own file, so a new recording never overwrites an older draft.
 */
class DraftStore(private val dir: File) {
    /** The newest draft with words, and its id. */
    @Synchronized
    fun newest(): Pair<String, VoiceDraft>? {
        val files = dir.listFiles { f -> f.isFile && !f.name.startsWith(".") } ?: return null
        for (file in files.sortedByDescending { it.name }) {
            val draft = try { VoiceDraft.decode(file.readText()) } catch (e: Exception) { null }
            if (draft != null && draft.text.isNotBlank()) return file.name to draft
            file.delete()
        }
        return null
    }

    /** Keeps [draft] as recording [id], or clears it when it has no words. */
    @Synchronized
    fun save(id: String, draft: VoiceDraft) {
        if (draft.text.isBlank()) return clear(id)
        dir.mkdirs()
        val file = File(dir, id)
        val temp = File(dir, ".$id.tmp")
        temp.writeText(draft.encode())
        if (!temp.renameTo(file)) {
            file.delete()
            temp.renameTo(file)
        }
    }

    @Synchronized
    fun clear(id: String) {
        File(dir, id).delete()
    }

    companion object {
        /** Draft writes run here, one at a time and in order, so a late save can't undo a clear. */
        val Io = kotlinx.coroutines.Dispatchers.IO.limitedParallelism(1)
    }
}
