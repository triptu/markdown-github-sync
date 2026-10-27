package io.github.triptu.notes.home

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

class ResurfaceTest {
    private val zone = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 10, 28)
    private val body = "The first hour should go to one thing that matters, before anyone asks for anything."
    private val rules = ResurfaceRules(
        weeklyFolder = FolderPath("journal"),
        templateFolders = setOf(FolderPath("templates")),
        zettelFolder = FolderPath("Zettelkasten"),
        pinned = emptySet(),
    )

    private fun note(path: String, untouchedDays: Long, text: String = body): IndexedNote {
        val modified = today.minusDays(untouchedDays).atStartOfDay(zone).toInstant().toEpochMilli()
        return IndexedNote(NotePath(path), modified, text.length.toLong(), "", text)
    }

    private fun vault(vararg notes: IndexedNote) = notes.associateBy { it.path }

    private fun shown(
        notes: Map<NotePath, IndexedNote>,
        on: LocalDate = today,
        rules: ResurfaceRules = this.rules,
        remembered: ResurfaceDay? = null,
    ): Pair<String, String>? {
        val day = Resurface.today(notes, on, zone, rules, remembered) ?: return null
        val pick = day.pick ?: return null
        return pick.path.value to HomeCopy.ago(Resurface.show(pick, notes.getValue(pick.path), on).ago)
    }

    @Test
    fun `a note stamped a year ago comes first, then a month ago, then an older Zettelkasten note`() {
        val yearAgo = note("Writing/2025102607 Mornings belong to one thing.md", 300)
        val monthAgo = note("Writing/2026092708 Walking as thinking.md", 30)
        val older = note("Zettelkasten/2026030820 Rent is a vote for a life.md", 200)
        assertEquals(yearAgo.path.value to "A year ago", shown(vault(yearAgo, monthAgo, older)))
        assertEquals(monthAgo.path.value to "A month ago", shown(vault(monthAgo, older)))
        assertEquals(older.path.value to "From March", shown(vault(older)))
    }

    @Test
    fun `a year ago means within three days of the date, read from the name stamp`() {
        assertNull(shown(vault(note("Writing/2025102407 Four days early.md", 300))))
        assertNull(shown(vault(note("Writing/2025110107 Four days late.md", 300))))
        val edge = note("Writing/2025103107 Three days late.md", 300)
        assertEquals(edge.path.value to "A year ago", shown(vault(edge)))
    }

    @Test
    fun `without a stamp, the note is dated by when it last changed`() {
        val retro = note("Work/Retro notes Q3.md", 366)
        assertEquals(retro.path.value to "A year ago", shown(vault(retro)))
        assertNull(shown(vault(note("Work/Plan.md", 200))))
    }

    @Test
    fun `a note touched this week is not resurfaced, however old its stamp`() {
        assertNull(shown(vault(note("Writing/2025102607 Mornings belong to one thing.md", 2))))
    }

    @Test
    fun `the fallback takes Zettelkasten and fleeting notes left alone for a month`() {
        val fleeting = note("Inbox/idea.md", 45, "---\ntags:\n  - fleeting\n---\n$body")
        val inlineTag = note("Inbox/other.md", 45, "---\ntags: [reading, fleeting]\n---\n$body")
        assertEquals(fleeting.path.value to "From September", shown(vault(fleeting)))
        assertEquals(inlineTag.path.value to "From September", shown(vault(inlineTag)))
        assertNull(shown(vault(note("Inbox/plain.md", 45))))
        assertNull(shown(vault(note("Inbox/tagged.md", 45, "---\ntags: [reading]\n---\nfleeting thoughts about $body"))))
        assertNull(shown(vault(note("Zettelkasten/2026091123 The second draft.md", 20))))
        assertEquals("From November 2025", HomeCopy.ago(Resurface.show(Pick(fleeting.path, LocalDate.of(2025, 11, 2)), fleeting, today).ago))
    }

    @Test
    fun `weekly notes, templates, pinned and near-empty notes never come back`() {
        val weekly = note("journal/2025/weekly/W44 27th Oct, 2025.md", 366)
        val template = note("templates/Zettelkasten Template.md", 366)
        val pinned = note("Zettelkasten/2025102607 Pinned.md", 366)
        val empty = note("Zettelkasten/2025102608 Empty.md", 366, "---\ntags:\n  - fleeting\n---\n# Empty\n\nLinks: [[a]], [[b]]\n")
        val withPin = rules.copy(pinned = setOf(pinned.path))
        assertNull(shown(vault(weekly, template, pinned, empty), rules = withPin))
    }

    @Test
    fun `the pick holds all day whatever order the vault lists in, and moves on over the days`() {
        val notes = (1..12).map { note("Zettelkasten/20250${(it % 9) + 1}1008 Idea $it.md", 60) }
        val forward = vault(*notes.toTypedArray())
        val backward = vault(*notes.reversed().toTypedArray())
        assertEquals(shown(forward), shown(backward))
        val week = (0L..6L).map { shown(forward, on = today.plusDays(it)) }.toSet()
        assertTrue("picks over a week: $week", week.size > 2)
    }

    @Test
    fun `today's note stays after it's edited, and a put-away day stays empty until tomorrow`() {
        val kept = note("Zettelkasten/2026030820 Rent is a vote for a life.md", 0)
        val other = note("Zettelkasten/2026051406 Walking as thinking.md", 90)
        val notes = vault(kept, other)
        val remembered = ResurfaceDay(today, Pick(kept.path, LocalDate.of(2026, 3, 8)))
        assertEquals(kept.path.value to "From March", shown(notes, remembered = remembered))
        assertEquals(other.path.value to "From May", shown(notes, on = today.plusDays(1), remembered = remembered))

        val putAway = ResurfaceDay(today, null)
        assertEquals(putAway, Resurface.today(notes, today, zone, rules, putAway))
        assertEquals(other.path.value to "From May", shown(notes, on = today.plusDays(1), remembered = putAway))
    }

    @Test
    fun `pinning today's note swaps it for another`() {
        val kept = note("Zettelkasten/2026030820 Rent is a vote for a life.md", 60)
        val other = note("Zettelkasten/2026051406 Walking as thinking.md", 90)
        val remembered = ResurfaceDay(today, Pick(kept.path, LocalDate.of(2026, 3, 8)))
        assertEquals(other.path.value to "From May", shown(vault(kept, other), rules = rules.copy(pinned = setOf(kept.path)), remembered = remembered))
    }

    @Test
    fun `the row shows the first line of prose as plain text, past frontmatter and the title heading`() {
        val text = "---\ndate: 2025-10-26\ntags:\n  - fleeting\n---\n# Mornings\n\nThe first hour goes to **one thing**, see [[Walden]].\n\nMore later."
        val mornings = note("Zettelkasten/2025102607 Mornings.md", 300, text)
        val pick = Resurface.today(vault(mornings), today, zone, rules, null)!!.pick!!
        assertEquals("The first hour goes to one thing, see Walden.", Resurface.show(pick, mornings, today).text)
    }

    @Test
    fun `the remembered day round trips through its stored form`() {
        val picked = ResurfaceDay(today, Pick(NotePath("Zettelkasten/2025102607 Mornings.md"), LocalDate.of(2025, 10, 26)))
        val putAway = ResurfaceDay(today, null)
        assertEquals(picked, ResurfaceDay.decode(picked.encode()))
        assertEquals(putAway, ResurfaceDay.decode(putAway.encode()))
        assertNull(ResurfaceDay.decode("not a day"))
        assertNotEquals(picked.encode(), putAway.encode())
    }
}
