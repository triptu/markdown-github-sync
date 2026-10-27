package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.FileVaultStore
import io.github.triptu.notes.vault.FolderPath
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
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
    fun `template dates are the week's Monday, and a bare date uses the weekly format`() {
        val now = LocalDateTime.of(2026, 10, 27, 9, 5)
        val result = WeeklyNote.fromTemplate("# {{title}}\n{{date}} {{date:Do MMM}} {{time}}", "W44 26th Oct, 2026", now, settings)
        assertEquals("# W44 26th Oct, 2026\n2026/weekly/W44 26th Oct, 2026 26th Oct 09:05", result)
    }

    @Test
    fun `date offsets move the week before formatting, like Periodic Notes`() {
        val template = "[[journal/{{date-1w:GGGG/[weekly]/[W]ww Do MMM, GGGG}}|⬅]] | {{date:Do MMM}} - {{date+7d:Do MMM}} | " +
            "[[journal/{{date+1w:GGGG/[weekly]/[W]ww Do MMM, GGGG}}|➡]]\n## Plan\n"
        val wednesday = LocalDateTime.of(2026, 10, 28, 18, 30)
        assertEquals(
            "[[journal/2026/weekly/W43 19th Oct, 2026|⬅]] | 26th Oct - 2nd Nov | [[journal/2026/weekly/W45 2nd Nov, 2026|➡]]\n## Plan\n",
            WeeklyNote.fromTemplate(template, "W44 26th Oct, 2026", wednesday, settings),
        )
    }

    @Test
    fun `offsets cross the ISO year, and unknown units are left as written`() {
        val monday = LocalDateTime.of(2026, 12, 28, 8, 0)
        assertEquals(
            "2027/W01 4th Jan {{date+1x:Do}}",
            WeeklyNote.fromTemplate("{{date+1w:GGGG/[W]ww Do MMM}} {{date+1x:Do}}", "", monday, settings),
        )
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
    fun `frontmatter is skipped, the name comes from the words below it`() {
        val note = "---\ndate:\ntags:\n  - fleeting\n---\nRivers carve slowly\n"
        assertEquals("2026102709 Rivers carve slowly", ZettelName.of(now, note))
        assertEquals("2026102709", ZettelName.of(now, "---\ndate:\ntags:\n  - fleeting\n---\n"))
    }

    @Test
    fun `long words are capped`() {
        val name = ZettelName.firstWords("a".repeat(80))
        assertEquals(48, name.length)
    }
}

class NewNoteTemplateTest {
    @get:Rule val temp = TemporaryFolder()

    private val startedAt = LocalDateTime.of(2026, 10, 28, 9, 41)
    private val template = "---\ndate:\ntags:\n  - fleeting\n---\n"

    private fun capture(settings: CaptureSettings = CaptureSettings()): Pair<File, CaptureService> {
        val root = temp.newFolder()
        return root to CaptureService(FileVaultStore(root, Dispatchers.Unconfined)) { settings }
    }

    private fun File.writeNote(path: String, text: String) = File(this, path).apply { parentFile!!.mkdirs() }.writeText(text)

    @Test
    fun `a new note starts with the template and is named from the words below it`() = runTest {
        val (root, capture) = capture()
        root.writeNote("templates/Zettelkasten Template.md", template)
        assertEquals(template, capture.newNoteStart(startedAt))

        val path = capture.createNewNote(FolderPath("Zettelkasten"), "Rivers carve slowly", startedAt)
        assertEquals("Zettelkasten/2026102809 Rivers carve slowly.md", path?.value)
        assertEquals(template + "Rivers carve slowly", File(root, path!!.value).readText())
    }

    @Test
    fun `a template without a final line break still puts the text below it`() = runTest {
        val (root, capture) = capture()
        root.writeNote("templates/Zettelkasten Template.md", "---\ntags: []\n---")
        assertEquals("---\ntags: []\n---\n", capture.newNoteStart(startedAt))
    }

    @Test
    fun `nothing past the template is not saved, and clearing a saved note removes it`() = runTest {
        val (root, capture) = capture()
        root.writeNote("templates/Zettelkasten Template.md", template)
        val folder = FolderPath("Zettelkasten")
        assertNull(capture.createNewNote(folder, "  \n", startedAt))
        assertFalse(File(root, "Zettelkasten").exists())

        val start = capture.newNoteStart(startedAt)
        val saved = capture.saveNewNote(folder, null, start + "Draft", startedAt, start)
        assertNull(capture.saveNewNote(folder, saved, start, startedAt, start))
        assertEquals(emptyList<String>(), File(root, "Zettelkasten").list().orEmpty().toList())
    }

    @Test
    fun `a missing template or an empty setting means a blank start`() = runTest {
        assertEquals("", capture().second.newNoteStart(startedAt))
        val (root, empty) = capture(CaptureSettings(newNoteTemplate = ""))
        root.writeNote("templates/Zettelkasten Template.md", template)
        assertEquals("", empty.newNoteStart(startedAt))
    }
}
