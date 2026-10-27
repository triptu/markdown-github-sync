package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.NotePath
import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.temporal.TemporalAdjusters

/** This week's note: where it lives, how it starts, and where writing in it begins. Pure functions. */
object WeeklyNote {
    /** The section the cursor goes to when This week opens, if the note has it. */
    const val WritingSection = "## Notes and Ramblings"

    private val HeadingLine = Regex("""^(#{1,6})\s""")

    /** The Monday that starts [now]'s ISO week, at [now]'s time of day. */
    fun weekStart(now: LocalDateTime): LocalDateTime = now.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

    /** The ISO week's note: [CaptureSettings.weeklyFormat] applied to that week's Monday. */
    fun pathFor(now: LocalDateTime, settings: CaptureSettings): NotePath {
        val relative = MomentFormat.format(settings.weeklyFormat, weekStart(now)).trim('/')
        val folder = settings.weeklyFolder.trim('/')
        return NotePath(if (folder.isEmpty()) "$relative${NotePath.MD}" else "$folder/$relative${NotePath.MD}")
    }

    /**
     * Fills a weekly template as Periodic Notes does: `{{date}}` is the week's Monday, with offsets
     * applied before formatting, and without a format it gives the weekly note's own format.
     */
    fun fromTemplate(template: String, title: String, now: LocalDateTime, settings: CaptureSettings): String =
        NoteTemplate.fill(template, title, weekStart(now), dateFormat = settings.weeklyFormat, now = now)

    /**
     * Where to put the cursor: the end of the last line written in [section] (or the end of its
     * heading if it's empty), before the next heading of the same or higher level. Without the
     * section, the end of the note.
     */
    fun writingPosition(note: String, section: String = WritingSection): Int {
        val lines = note.split('\n')
        val starts = IntArray(lines.size)
        var offset = 0
        for (i in lines.indices) {
            starts[i] = offset
            offset += lines[i].length + 1
        }
        val heading = lines.indexOfFirst { it.trim() == section.trim() }
        if (heading < 0) return note.trimEnd().length
        val level = HeadingLine.find(section.trim())?.groupValues?.get(1)?.length ?: 6
        var end = lines.size
        for (i in heading + 1 until lines.size) {
            val other = HeadingLine.find(lines[i])?.groupValues?.get(1)?.length
            if (other != null && other <= level) {
                end = i
                break
            }
        }
        var last = end - 1
        while (last > heading && lines[last].isBlank()) last--
        return starts[last] + lines[last].length
    }
}
