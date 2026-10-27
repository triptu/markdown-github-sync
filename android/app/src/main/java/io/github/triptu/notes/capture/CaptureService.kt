package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultStore
import io.github.triptu.notes.vault.sanitizeNoteName
import java.time.LocalDateTime

/** Creates notes: new ones from Home or a folder, this week's note, and notes a `[[link]]` names. */
class CaptureService(
    private val store: VaultStore,
    private val settings: () -> CaptureSettings,
) {
    val newNoteFolder: FolderPath get() = FolderPath(settings().newNoteFolder.trim('/'))

    /**
     * Saves a new note in [folder], named from its first words. While the first words change, the
     * file follows them: [previous] is renamed. Blank text removes [previous]. Returns where it now lives.
     */
    suspend fun saveNewNote(folder: FolderPath, previous: NotePath?, text: String, startedAt: LocalDateTime): NotePath? {
        if (text.isBlank()) {
            previous?.let { store.delete(it) }
            return null
        }
        val path = freePath(folder, ZettelName.of(startedAt, text), previous)
        if (previous != null && previous != path) store.rename(previous, path)
        store.write(path, text)
        return path
    }

    fun weeklyPath(at: LocalDateTime): NotePath = WeeklyNote.pathFor(at, settings())

    /** This week's note, created from the template if it doesn't exist yet. */
    suspend fun ensureWeekly(now: LocalDateTime): NotePath {
        val s = settings()
        val path = WeeklyNote.pathFor(now, s)
        if (!store.exists(path)) store.write(path, newWeeklyNote(path, s, now))
        return path
    }

    /** The note a `[[link]]` to a missing note creates, in the new-note folder. */
    suspend fun createLinked(name: String): NotePath {
        val path = freePath(newNoteFolder, sanitizeNoteName(name).ifEmpty { "Untitled" }, null)
        store.write(path, "")
        return path
    }

    private suspend fun newWeeklyNote(path: NotePath, s: CaptureSettings, now: LocalDateTime): String {
        val templatePath = s.weeklyTemplate.trim('/').takeIf { it.endsWith(NotePath.MD) }?.let(::NotePath)
        val template = templatePath?.let { store.read(it) } ?: return ""
        return WeeklyNote.fromTemplate(template, path.name, now)
    }

    private suspend fun freePath(folder: FolderPath, name: String, mine: NotePath?): NotePath {
        var candidate = folder.note(name)
        var n = 2
        while (candidate != mine && store.exists(candidate)) candidate = folder.note("$name ${n++}")
        return candidate
    }
}
