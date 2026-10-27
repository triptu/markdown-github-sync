package io.github.triptu.notes.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {
    @Test
    fun `image embeds are found, decoded, and not treated as links`() {
        val text = "View:\n![a hill](media/my%20hills.png)\n![[sunset.png|300]]\nsee [[Ideas]]\n"
        val parsed = MarkdownParser.parse(text)
        assertEquals(listOf("media/my hills.png" to false, "sunset.png" to true), parsed.images.map { it.target to it.wiki })
        assertEquals(listOf("Ideas"), parsed.links.map { it.target })
        val second = parsed.images[1]
        assertEquals("![[sunset.png|300]]", text.substring(second.start, second.end))
        assertTrue(MarkdownParser.isImage("sunset.PNG"))
        assertFalse(MarkdownParser.isImage("paper.pdf"))
    }

    @Test
    fun `conflict markers are their own lines, not quotes`() {
        val text = "a\n<<<<<<< This phone\nmine\n\n=======\ntheirs\n>>>>>>> GitHub\n"
        val parsed = MarkdownParser.parse(text)
        assertEquals(listOf("<<<<<<< This phone", "=======", ">>>>>>> GitHub"), parsed.conflictMarkers.map { text.substring(it.start, it.end) })
        assertTrue(parsed.quotes.isEmpty())
    }
}
