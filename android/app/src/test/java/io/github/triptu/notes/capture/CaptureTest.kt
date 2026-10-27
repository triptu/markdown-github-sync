package io.github.triptu.notes.capture

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDateTime

class WeeklyNoteTest {
    private val settings = CaptureSettings()

    @Test
    fun `weekly path uses the ISO week and its Monday`() {
        val tuesday = LocalDateTime.of(2026, 10, 27, 21, 40)
        assertEquals("journal/2026/weekly/W44 26th Oct, 2026.md", WeeklyNote.pathFor(tuesday, settings).value)
    }

    @Test
    fun `days early in January can belong to the previous ISO year`() {
        val friday = LocalDateTime.of(2027, 1, 1, 9, 0)
        assertEquals("journal/2026/weekly/W53 28th Dec, 2026.md", WeeklyNote.pathFor(friday, settings).value)
    }

    @Test
    fun `Sunday belongs to the week that started on Monday`() {
        val sunday = LocalDateTime.of(2026, 11, 1, 23, 0)
        assertEquals("journal/2026/weekly/W44 26th Oct, 2026.md", WeeklyNote.pathFor(sunday, settings).value)
    }

    @Test
    fun `cursor goes after the last line written in the section, before the next heading`() {
        val note = "# W44\n## Plan\n- [ ] call\n\n## Notes and Ramblings\n\n*09:10*\nfirst thought\n\n## Done\n- x\n"
        val at = WeeklyNote.writingPosition(note)
        assertEquals("first thought", note.substring(0, at).substringAfterLast('\n'))
        assertEquals("\n\n## Done\n- x\n", note.substring(at))
    }

    @Test
    fun `an empty section puts the cursor at the end of its heading, subheadings stay inside`() {
        val empty = "## Notes and Ramblings\n\n## Done\n"
        assertEquals("## Notes and Ramblings".length, WeeklyNote.writingPosition(empty))
        val nested = "## Notes and Ramblings\n### Monday\nran\n## Done\n"
        assertEquals(nested.indexOf("ran") + 3, WeeklyNote.writingPosition(nested))
    }

    @Test
    fun `without the section the cursor goes to the end of the note`() {
        assertEquals("# W44\n\nhello".length, WeeklyNote.writingPosition("# W44\n\nhello\n\n"))
    }

    @Test
    fun `template placeholders are filled`() {
        val now = LocalDateTime.of(2026, 10, 27, 9, 5)
        val result = WeeklyNote.fromTemplate("# {{title}}\n{{date}} {{date:Do MMM}} {{time}}", "W44 26th Oct, 2026", now)
        assertEquals("# W44 26th Oct, 2026\n2026-10-27 27th Oct 09:05", result)
    }
}

class ZettelNameTest {
    private val now = LocalDateTime.of(2026, 10, 27, 9, 41)

    @Test
    fun `name is the hour stamp and the first words`() {
        assertEquals("2026102709 The rent math only works if", ZettelName.of(now, "The rent math only works if one of us stays home"))
    }

    @Test
    fun `markdown and illegal characters are dropped`() {
        assertEquals("2026102709 Ideas for the trip to Pune", ZettelName.of(now, "\n# **Ideas** for the trip: to Pune?"))
        assertEquals("2026102709 call the bank", ZettelName.of(now, "- [ ] call the [[bank]]"))
    }

    @Test
    fun `empty text gives only the stamp`() {
        assertEquals("2026102709", ZettelName.of(now, "  \n "))
    }

    @Test
    fun `long words are capped`() {
        val name = ZettelName.firstWords("a".repeat(80))
        assertEquals(48, name.length)
    }
}
