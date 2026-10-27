package io.github.triptu.notes.voice.refine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RefineRulesTest {
    @Test
    fun `refined words replace the dictated ones only while they are untouched`() {
        val note = "Intro.\nso um we pack the kitchen first\nEnd."
        val original = "so um we pack the kitchen first"
        assertEquals("Intro.\nSo we pack the kitchen first.\nEnd.", RefineRules.replaceDictated(note, original, "So we pack the kitchen first."))
        assertNull(RefineRules.replaceDictated(note.replace("kitchen", "garage"), original, "So we pack the kitchen first."))
        assertNull(RefineRules.replaceDictated("$original $original", original, "x"))
    }

    @Test
    fun `a tidy that rewrites too much is not used`() {
        assertEquals(true, RefineRules.isLightEdit("um so we uh pack the kitchen first", "So we pack the kitchen first."))
        assertEquals(false, RefineRules.isLightEdit("um so we uh pack the kitchen first and then the books and the plants", "Packing plan."))
    }
}
