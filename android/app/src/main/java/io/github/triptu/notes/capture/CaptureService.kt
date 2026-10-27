package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultStore
import io.github.triptu.notes.vault.sanitizeNoteName
import java.time.LocalDateTime

/** Writes captured text to its destination. Each call is idempotent for the same inputs. */
class CaptureService(
    private val store: VaultStore,
    private val settings: () -> CaptureSettings,
) {
    /**
     * Saves a new note named from its first words. While the first words change, the file follows
     * them: [previous] is renamed. Blank text removes [previous]. Returns where the note now lives.
     */
    suspend fun saveNewNote(previous: NotePath?, text: String, startedAt: LocalDateTime): NotePath? {
        if (text.isBlank()) {
            previous?.let { store.delete(it) }
            return null
        }
        val folder = FolderPath(settings().newNoteFolder.trim('/'))
        val wanted = ZettelName.of(startedAt, text)
        val path = freePath(folder, wanted, previous)
        if (previous != null && previous != path) store.rename(previous, path)
        store.write(path, text)
        return path
    }

    /**
     * Puts the text in this week's note, as one entry in the configured section. [previousBlock] is
     * the entry this capture wrote last time, so edits replace it rather than adding another.
     * Returns the entry now in the note, or null if there is none.
     */
    suspend fun saveToWeekly(previousBlock: String?, text: String, startedAt: LocalDateTime): String? {
        val s = settings()
        val path = WeeklyNote.pathFor(startedAt, s)
        val block = if (text.isBlank()) "" else WeeklyNote.entry(text, startedAt)
        val existing = store.read(path)
        if (existing == null && block.isEmpty()) return null
        val base = existing ?: newWeeklyNote(path, s, startedAt)
        val updated = WeeklyNote.upsert(base, s.weeklySection, previousBlock, block)
        if (updated != existing) store.write(path, updated)
        return block.ifEmpty { null }
    }

    fun weeklyPath(at: LocalDateTime): NotePath = WeeklyNote.pathFor(at, settings())

    /** The note a `[[link]]` to a missing note creates, in the new-note folder. */
    suspend fun createLinked(name: String): NotePath {
        val folder = FolderPath(settings().newNoteFolder.trim('/'))
        val path = freePath(folder, sanitizeNoteName(name).ifEmpty { "Untitled" }, null)
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
