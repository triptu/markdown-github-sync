package io.github.triptu.notes.quick

import io.github.triptu.notes.vault.NotePath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickActionTest {
    @Test
    fun `each app shortcut opens what its label says`() {
        assertEquals(
            listOf("New note" to QuickAction.NewNote, "Voice note" to QuickAction.Voice, "This week" to QuickAction.ThisWeek),
            QuickShortcuts.all.map { it.label to it.action },
        )
        for (spec in QuickShortcuts.all) {
            val action = QuickAction.actionOf(spec.action)
            assertEquals(spec.action, QuickAction.parse(action, QuickAction.pathOf(spec.action)))
            // Launchers cut short labels past about 10 characters.
            assertTrue(spec.label, spec.label.length <= 10)
        }
        assertEquals(QuickShortcuts.all.size, QuickShortcuts.all.map { it.id }.toSet().size)
    }

    @Test
    fun `a note action carries its path`() {
        val open = QuickAction.OpenNote(NotePath("Work/Retro notes Q3.md"))
        assertEquals("Work/Retro notes Q3.md", QuickAction.pathOf(open))
        assertEquals(open, QuickAction.parse(QuickAction.actionOf(open), QuickAction.pathOf(open)))
    }

    @Test
    fun `other intents and broken paths run nothing`() {
        assertNull(QuickAction.parse("android.intent.action.MAIN", null))
        assertNull(QuickAction.parse(null, null))
        assertNull(QuickAction.parse(QuickAction.OpenNoteAction, null))
        assertNull(QuickAction.parse(QuickAction.OpenNoteAction, "/etc/passwd"))
        assertNull(QuickAction.parse(QuickAction.OpenNoteAction, "Work"))
    }
}
