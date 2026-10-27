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
    fun `text goes at the end of the section, before the next heading`() {
        val note = """
            # W44
            ## Plan
            - [ ] call the bank

            ## Notes and Ramblings

            *09:10*
            first thought

            ## Done
            - nothing yet
        """.trimIndent()
        val result = WeeklyNote.upsert(note, "## Notes and Ramblings", null, "*21:40*\nsecond thought")
        assertEquals(
            """
            # W44
            ## Plan
            - [ ] call the bank

            ## Notes and Ramblings

            *09:10*
            first thought

            *21:40*
            second thought

            ## Done
            - nothing yet
            """.trimIndent(),
            result,
        )
    }

    @Test
    fun `an empty section at the end of the note gets the text`() {
        val result = WeeklyNote.upsert("## Plan\n\n## Notes and Ramblings\n", "## Notes and Ramblings", null, "*08:00*\nhello")
        assertEquals("## Plan\n\n## Notes and Ramblings\n\n*08:00*\nhello\n", result)
    }

    @Test
    fun `subheadings stay inside the section`() {
        val note = "## Notes and Ramblings\n### Monday\nran\n## Done\n"
        val result = WeeklyNote.upsert(note, "## Notes and Ramblings", null, "x")
        assertEquals("## Notes and Ramblings\n### Monday\nran\n\nx\n\n## Done\n", result)
    }

    @Test
    fun `a missing section is added at the end`() {
        val result = WeeklyNote.upsert("# W44\n\n## Plan\n", "## Notes and Ramblings", null, "x")
        assertEquals("# W44\n\n## Plan\n\n## Notes and Ramblings\n\nx\n", result)
    }

    @Test
    fun `editing a capture replaces its block, and clearing it removes the block`() {
        val note = "## Notes and Ramblings\n\n## Done\n"
        val first = WeeklyNote.upsert(note, "## Notes and Ramblings", null, "*10:00*\nhel")
        val second = WeeklyNote.upsert(first, "## Notes and Ramblings", "*10:00*\nhel", "*10:00*\nhello there")
        assertEquals("## Notes and Ramblings\n\n*10:00*\nhello there\n\n## Done\n", second)
        val cleared = WeeklyNote.upsert(second, "## Notes and Ramblings", "*10:00*\nhello there", "")
        assertEquals(note, cleared)
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
