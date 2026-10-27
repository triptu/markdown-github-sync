package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.temporal.TemporalAdjusters

/** Finding this week's note and putting text into one of its sections. Pure functions. */
object WeeklyNote {
    private val HeadingLine = Regex("""^(#{1,6})\s""")
    private val TemplateDate = Regex("""\{\{date(?::([^}]*))?\}\}""")
    private val TemplateTime = Regex("""\{\{time(?::([^}]*))?\}\}""")

    /** The ISO week's note: [CaptureSettings.weeklyFormat] applied to that week's Monday. */
    fun pathFor(now: LocalDateTime, settings: CaptureSettings): NotePath {
        val monday = now.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        val relative = MomentFormat.format(settings.weeklyFormat, monday).trim('/')
        val folder = settings.weeklyFolder.trim('/')
        return NotePath(if (folder.isEmpty()) "$relative${NotePath.MD}" else "$folder/$relative${NotePath.MD}")
    }

    /** Fills Obsidian core template placeholders: `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`. */
    fun fromTemplate(template: String, title: String, now: LocalDateTime): String = template
        .replace("{{title}}", title)
        .replace(TemplateDate) { MomentFormat.format(it.groupValues[1].ifEmpty { "YYYY-MM-DD" }, now) }
        .replace(TemplateTime) { MomentFormat.format(it.groupValues[1].ifEmpty { "HH:mm" }, now) }

    /** A captured entry: a small italic time line, then the text. */
    fun entry(text: String, now: LocalDateTime): String =
        "*${MomentFormat.format("HH:mm", now)}*\n${text.trim()}"

    /**
     * Puts [newBlock] at the end of [section], or replaces [oldBlock] if the note still has it.
     * An empty [newBlock] removes [oldBlock]. A missing section is added at the end of the note.
     */
    fun upsert(note: String, section: String, oldBlock: String?, newBlock: String): String {
        if (oldBlock != null) {
            val at = note.indexOf(oldBlock)
            if (at >= 0) {
                if (newBlock.isNotEmpty()) return note.replaceRange(at, at + oldBlock.length, newBlock)
                return removeBlock(note, at, at + oldBlock.length)
            }
        }
        if (newBlock.isEmpty()) return note
        return insertAtSectionEnd(note, section, newBlock)
    }

    private fun insertAtSectionEnd(note: String, section: String, block: String): String {
        val lines = note.lines().toMutableList()
        if (lines.size == 1 && lines[0].isEmpty()) lines.clear()
        val heading = section.trim()
        val start = lines.indexOfFirst { it.trim() == heading }
        if (start < 0) {
            while (lines.isNotEmpty() && lines.last().isBlank()) lines.removeAt(lines.lastIndex)
            if (lines.isNotEmpty()) lines += ""
            lines += heading
            lines += ""
            lines += block.lines()
            lines += ""
            return lines.joinToString("\n")
        }
        val level = HeadingLine.find(heading)?.groupValues?.get(1)?.length ?: 6
        var end = lines.size
        for (i in start + 1 until lines.size) {
            val other = HeadingLine.find(lines[i])?.groupValues?.get(1)?.length
            if (other != null && other <= level) {
                end = i
                break
            }
        }
        var last = end
        while (last > start + 1 && lines[last - 1].isBlank()) last--
        val insertion = buildList {
            add("")
            addAll(block.lines())
            if (end < lines.size) add("")
        }
        val tail = lines.subList(end, lines.size).toList()
        val result = lines.subList(0, last).toMutableList()
        result += insertion
        result += tail
        if (end >= lines.size) result += ""
        return result.joinToString("\n")
    }

    /** Removes a block and the blank line that [insertAtSectionEnd] put before it. */
    private fun removeBlock(note: String, start: Int, end: Int): String {
        val from = if (start >= 2 && note.startsWith("\n\n", start - 2)) start - 2 else start
        return note.removeRange(from, end)
    }

    fun folderOf(settings: CaptureSettings): FolderPath = FolderPath(settings.weeklyFolder.trim('/'))
}
