package io.github.triptu.notes.syncing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BothVersionsTest {
    @Test
    fun `same-line edits keep both versions between markers, other edits merge`() {
        val base = "# Plan\n\nbuy milk\nwalk\nread\n"
        val phone = "# Plan (phone)\n\nbuy oat milk\nwalk\nread\n"
        val github = "# Plan\n\nbuy milk and eggs\nwalk\nread a book\n"
        assertEquals(
            "# Plan (phone)\n\n" +
                "<<<<<<< This phone\nbuy oat milk\n\n=======\nbuy milk and eggs\n>>>>>>> GitHub\n" +
                "walk\nread a book\n",
            BothVersions.merge(base, phone, github),
        )
    }

    @Test
    fun `a side that deleted the lines shows as an empty version`() {
        val merged = BothVersions.merge("a\nb\nc\n", "a\nc\n", "a\nB\nc\n")
        assertEquals("a\n<<<<<<< This phone\n\n=======\nB\n>>>>>>> GitHub\nc\n", merged)
    }

    @Test
    fun `a missing final newline doesn't glue a marker to the text`() {
        val merged = BothVersions.merge("one", "one here", "one there")
        assertEquals("<<<<<<< This phone\none here\n\n=======\none there\n>>>>>>> GitHub\n", merged)
    }

    @Test
    fun `notes created on both sides share their common lines`() {
        val merged = BothVersions.merge(null, "# Trip\n\npack light\nbook train\n", "# Trip\n\npack warm\nbook train\n")
        assertEquals("# Trip\n\n<<<<<<< This phone\npack light\n\n=======\npack warm\n>>>>>>> GitHub\nbook train\n", merged)
    }

    @Test
    fun `identical edits on both sides merge cleanly`() {
        assertEquals("x\nY\nz\n", BothVersions.merge("x\ny\nz\n", "x\nY\nz\n", "x\nY\nz\n"))
        assertEquals("same", BothVersions.merge("old", "same", "same"))
    }

    @Test
    fun `finds notes that still have both versions`() {
        assertTrue(BothVersions.hasMarkers(BothVersions.merge("a\n", "b\n", "c\n")))
        assertFalse(BothVersions.hasMarkers("a <<<<<<< not at a line start\n>>>>>>> GitHub\n"))
        assertFalse(BothVersions.hasMarkers("plain note\n"))
    }
}
