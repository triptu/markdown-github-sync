package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultStore
import io.github.triptu.notes.vault.sanitizeNoteName
import java.io.IOException
import java.time.LocalDateTime

/** Creates notes: new ones from Home or a folder, this week's note, and notes a `[[link]]` names. */
class CaptureService(
    private val store: VaultStore,
    private val settings: () -> CaptureSettings,
) {
    val newNoteFolder: FolderPath get() = FolderPath(settings().newNoteFolder.trim('/'))

    /**
     * How a new note started at [startedAt] begins: the new-note template, filled, ending in a line
     * break so the note's text starts below it. Empty without a template or when its note is missing.
     */
    suspend fun newNoteStart(startedAt: LocalDateTime): String {
        val template = readTemplate(settings().newNoteTemplate) ?: return ""
        val filled = NoteTemplate.fill(template, ZettelName.stamp(startedAt), startedAt)
        return if (filled.isEmpty() || filled.endsWith('\n')) filled else "$filled\n"
    }

    /** Creates a new note in [folder] holding [text] after the new-note template. Nothing for blank text. */
    suspend fun createNewNote(folder: FolderPath, text: String, startedAt: LocalDateTime): NotePath? {
        val start = newNoteStart(startedAt)
        return saveNewNote(folder, null, start + text, startedAt, start)
    }

    /**
     * Saves a new note in [folder], named from its first words. [text] is the whole note and begins
     * with [start], the filled template it was created with. While the first words change, the file
     * follows them: [previous] is renamed. Nothing past [start] removes [previous]. Returns where it now lives.
     */
    suspend fun saveNewNote(folder: FolderPath, previous: NotePath?, text: String, startedAt: LocalDateTime, start: String = ""): NotePath? {
        val body = text.removePrefix(start)
        if (body.isBlank()) {
            previous?.let { store.delete(it) }
            return null
        }
        val path = freePath(folder, ZettelName.of(startedAt, body), previous)
        if (previous != null && previous != path) store.rename(previous, path)
        store.write(path, text)
        return path
    }

    /** A new note named [name] in the new-note folder, numbered if that name is taken. */
    suspend fun createNote(name: String, text: String): NotePath {
        val path = freePath(newNoteFolder, sanitizeNoteName(name).ifEmpty { "Untitled" }, null)
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
        val template = readTemplate(s.weeklyTemplate) ?: return ""
        return WeeklyNote.fromTemplate(template, path.name, now, s)
    }

    /** A template note's text, or null when the setting is empty, isn't a vault path, or the note is missing. */
    private suspend fun readTemplate(setting: String): String? {
        val raw = setting.trim().trim('/')
        if (raw.isEmpty()) return null
        return try {
            store.read(NotePath(if (raw.endsWith(NotePath.MD)) raw else raw + NotePath.MD))
        } catch (e: IllegalArgumentException) {
            null
        } catch (e: IOException) {
            null
        }
    }

    private suspend fun freePath(folder: FolderPath, name: String, mine: NotePath?): NotePath {
        var candidate = folder.note(name)
        var n = 2
        while (candidate != mine && store.exists(candidate)) candidate = folder.note("$name ${n++}")
        return candidate
    }
}
