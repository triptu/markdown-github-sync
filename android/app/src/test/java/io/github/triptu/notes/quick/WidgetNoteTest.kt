package io.github.triptu.notes.quick

import io.github.triptu.notes.quick.WidgetLine.Gap
import io.github.triptu.notes.quick.WidgetLine.Task
import io.github.triptu.notes.quick.WidgetLine.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetNoteTest {
    private val note = """
        ---
        tags: [weekly]
        ---
        # Week 44

        ## Plan
        - [ ] Call the **plumber**
        - [x] Book [[2026101409 Attention is the real budget|train]] tickets
            - [ ] Pack the *blue* bag
        - Buy milk
        1. First *thing*

        > A quote with `code`
        ---
        ![[photo.png]]
        Plain [link](https://example.com) text
    """.trimIndent()

    @Test
    fun `tasks keep their line, state and indent, other lines lose their markers`() {
        assertEquals(
            listOf(
                Text("Week 44", heading = true, bullet = false, indent = 0),
                Gap,
                Text("Plan", heading = true, bullet = false, indent = 0),
                Task(line = 6, checked = false, text = "Call the plumber", indent = 0),
                Task(line = 7, checked = true, text = "Book train tickets", indent = 0),
                Task(line = 8, checked = false, text = "Pack the blue bag", indent = 1),
                Text("Buy milk", heading = false, bullet = true, indent = 0),
                Text("1. First thing", heading = false, bullet = false, indent = 0),
                Gap,
                Text("A quote with code", heading = false, bullet = false, indent = 0),
                Gap,
                Text("Plain link text", heading = false, bullet = false, indent = 0),
            ),
            WidgetNote.lines(note, title = "Weekly"),
        )
    }

    @Test
    fun `toggling ticks and unticks only that line`() {
        val ticked = WidgetNote.toggle(note, line = 6, wasChecked = false)!!
        assertEquals("- [x] Call the **plumber**", ticked.lines()[6])
        assertEquals(note.lines().filterIndexed { i, _ -> i != 6 }, ticked.lines().filterIndexed { i, _ -> i != 6 })

        val unticked = WidgetNote.toggle(note, line = 7, wasChecked = true)!!
        assertEquals("- [ ] Book [[2026101409 Attention is the real budget|train]] tickets", unticked.lines()[7])

        val nested = WidgetNote.toggle(note, line = 8, wasChecked = false)!!
        assertEquals("    - [x] Pack the *blue* bag", nested.lines()[8])
    }

    @Test
    fun `a toggle drawn from an older version of the note does nothing`() {
        // The task was ticked elsewhere since the widget drew it.
        assertNull(WidgetNote.toggle(note, line = 7, wasChecked = false))
        // The line is no longer a task, or no longer there.
        assertNull(WidgetNote.toggle(note, line = 9, wasChecked = false))
        assertNull(WidgetNote.toggle(note, line = 99, wasChecked = false))
    }

    @Test
    fun `Windows line endings and an empty task survive a toggle`() {
        val crlf = "- [ ] one\r\n- [ ]\r\n"
        assertEquals(listOf(Task(0, false, "one", 0), Task(1, false, "", 0)), WidgetNote.lines(crlf, title = "crlf"))
        assertEquals("- [ ] one\r\n- [x]\r\n", WidgetNote.toggle(crlf, line = 1, wasChecked = false))
    }

    @Test
    fun `tasks inside code fences are only text`() {
        val fenced = "```\n- [ ] not a task\n```\n- [ ] a task"
        assertEquals(
            listOf(Text("- [ ] not a task", heading = false, bullet = false, indent = 0), Task(3, false, "a task", 0)),
            WidgetNote.lines(fenced, title = "fenced"),
        )
    }

    @Test
    fun `a first heading that repeats the widget's title is left out`() {
        val note = "# Todos\n\n## This week\n- [ ] pack"
        assertEquals(
            listOf(Text("This week", heading = true, bullet = false, indent = 0), Task(3, false, "pack", 0)),
            WidgetNote.lines(note, title = "Todos"),
        )
    }
}
