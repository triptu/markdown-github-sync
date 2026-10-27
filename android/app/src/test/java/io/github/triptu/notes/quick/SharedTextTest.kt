package io.github.triptu.notes.quick

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime

class SharedTextTest {
    private val now = LocalDateTime.of(2026, 10, 27, 9, 30)

    @Test
    fun `a link with a page title becomes a markdown link named after the title`() {
        val shared = SharedText.of("https://example.com/slow-mornings", "Slow mornings, and why they work")!!
        assertEquals("[Slow mornings, and why they work](https://example.com/slow-mornings)", shared.body)
        assertEquals("2026102709 Slow mornings, and why they work", shared.noteName(now))
    }

    @Test
    fun `a title line before the link counts as the title`() {
        val shared = SharedText.of("Walking as thinking - https://example.com/walk", null)!!
        assertEquals("[Walking as thinking](https://example.com/walk)", shared.body)
        assertEquals(SharedText.of("Walking as thinking\nhttps://example.com/walk", ""), shared)
    }

    @Test
    fun `brackets in the title and parentheses in the link can't break the link`() {
        val shared = SharedText.of("https://en.example.org/wiki/Lake_(water)", "Lake [water]")!!
        assertEquals("""[Lake \[water\]](https://en.example.org/wiki/Lake_%28water%29)""", shared.body)
        assertEquals("2026102709 Lake water", shared.noteName(now))
    }

    @Test
    fun `a bare link is kept as is and the note is named after the site`() {
        val shared = SharedText.of("  https://www.example.com/a/b?c=1 ", null)!!
        assertEquals("https://www.example.com/a/b?c=1", shared.body)
        assertEquals("2026102709 example.com", shared.noteName(now))
    }

    @Test
    fun `plain text is kept and named from its first words`() {
        val text = "Friction is a design material.\nUse it on purpose, see https://example.com for more."
        val shared = SharedText.of(text, "Ignored subject")!!
        assertEquals(text, shared.body)
        assertEquals("2026102709 Friction is a design material", shared.noteName(now))
    }

    @Test
    fun `nothing to save is no share`() {
        assertNull(SharedText.of("  \n ", "Title"))
        assertNull(SharedText.of(null, null))
    }

    @Test
    fun `appending adds a blank line before the piece`() {
        assertEquals("- [ ] eggs\n\nnew line\n", SharedText.append("- [ ] eggs\n\n\n", "new line"))
        assertEquals("# Ideas\n\n[Site](https://example.com)\n", SharedText.append("# Ideas", "[Site](https://example.com)"))
        assertEquals("first\n", SharedText.append("", "first"))
        assertEquals("first\n", SharedText.append(null, "first"))
    }
}
