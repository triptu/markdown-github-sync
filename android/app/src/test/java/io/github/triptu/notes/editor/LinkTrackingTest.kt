package io.github.triptu.notes.editor

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultQueries
import io.github.triptu.notes.vault.VaultSnapshot

class LinkTrackingTest {
    private fun v(text: String, caret: Int = text.length) = TextFieldValue(text, TextRange(caret))

    @Test
    fun `opens only when the second bracket is typed`() {
        assertEquals(4, EditOps.trackLink(v("see ["), v("see [["), null))
        assertNull(EditOps.trackLink(v("see [[x"), v("see [[x", 6), null)) // moving into an old [[ doesn't open
    }

    @Test
    fun `stays open while typing and closes on brackets, line breaks, deletion or leaving`() {
        assertEquals(4, EditOps.trackLink(v("see [[ra"), v("see [[ran"), 4))
        assertNull(EditOps.trackLink(v("see [[ran]"), v("see [[ran]]"), 4))
        assertNull(EditOps.trackLink(v("see [[ran"), v("see [[ran\n"), 4))
        assertNull(EditOps.trackLink(v("see [["), v("see ["), 4))
        assertNull(EditOps.trackLink(v("see [[ran"), v("see [[ran", 2), 4))
    }

    @Test
    fun `completion reuses a closing pair that is already there`() {
        val value = v("see [[ra]] now", 8)
        val done = EditOps.completeLink(value, LinkQuery(4, "ra"), "2026030820 Rent is a vote for a life")
        assertEquals("see [[2026030820 Rent is a vote for a life]] now", done.text)
        assertEquals(TextRange(44), done.selection)
    }

    @Test
    fun `suggestions match titles without the stamp, best match first, and flag shared titles`() {
        fun note(path: String, at: Long) = NotePath(path).let { it to IndexedNote(it, at, 0, "", "") }
        val snapshot = VaultSnapshot(
            mapOf(
                note("Zettelkasten/2026101409 Attention is the real budget.md", 1),
                note("Writing/What the lake taught me.md", 2),
                note("Work/Pay attention.md", 3),
                note("Ideas.md", 4),
                note("Work/Ideas.md", 5),
            ),
            emptySet(), isFresh = true,
        )
        val hits = VaultQueries.linkSuggestions(snapshot, "att", exclude = null)
        assertEquals(listOf("Attention is the real budget", "Pay attention"), hits.map { it.path.displayName })
        val ideas = VaultQueries.linkSuggestions(snapshot, "ide", exclude = null)
        assertEquals(listOf(true, true), ideas.map { it.showFolder })
    }
}
