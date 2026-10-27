package io.github.triptu.notes.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptTest {
    @Test
    fun `partials replace each other and the final result is added once`() {
        val t = Transcript()
        val s = t.newSession()
        t.onPartial(s, "the rent")
        t.onPartial(s, "the rent math only")
        assertEquals("", t.committed)
        assertEquals("the rent math only", t.pending)
        t.onFinal(s, "The rent math only works.")
        t.onSessionEnd(s)
        assertEquals("The rent math only works.", t.text)
        assertEquals("", t.pending)
    }

    @Test
    fun `words carry across restarted sessions without loss or doubling`() {
        val t = Transcript()
        val one = t.newSession()
        t.onPartial(one, "first we pack")
        t.onFinal(one, "First we pack the kitchen.")
        t.onSessionEnd(one)
        val two = t.newSession()
        t.onPartial(two, "then")
        t.onPartial(two, "then the books")
        t.onFinal(two, "Then the books.")
        t.onSessionEnd(two)
        assertEquals("First we pack the kitchen. Then the books.", t.text)
    }

    @Test
    fun `a session that ends without a final result keeps its last partial`() {
        val t = Transcript("Call the bank.")
        val s = t.newSession()
        t.onPartial(s, "ask about the")
        t.onPartial(s, "ask about the deposit")
        t.onSessionEnd(s)
        assertEquals("Call the bank. Ask about the deposit", t.text)
    }

    @Test
    fun `late events from an ended session are ignored`() {
        val t = Transcript()
        val one = t.newSession()
        t.onPartial(one, "hello there")
        t.onSessionEnd(one)
        t.onFinal(one, "Hello there.")
        t.onPartial(one, "hello there again")
        val two = t.newSession()
        t.onFinal(two, "General thoughts.")
        assertEquals("Hello there. General thoughts.", t.text)
    }

    @Test
    fun `segments of one long session are each added once`() {
        val t = Transcript()
        val s = t.newSession()
        t.onPartial(s, "one thing")
        t.onFinal(s, "One thing.")
        t.onPartial(s, "another")
        t.onFinal(s, "Another thing.")
        t.onPartial(s, "and a third")
        assertEquals("One thing. Another thing.", t.committed)
        assertEquals("One thing. Another thing. And a third", t.text)
        t.settle()
        assertEquals("One thing. Another thing. And a third", t.committed)
        t.onFinal(s, "And a third.")
        assertEquals("One thing. Another thing. And a third", t.text)
    }

    @Test
    fun `empty finals and partials add nothing`() {
        val t = Transcript()
        val s = t.newSession()
        t.onPartial(s, "")
        t.onFinal(s, "  ")
        t.onSessionEnd(s)
        assertEquals("", t.text)
    }

    @Test
    fun `pieces join into sentences`() {
        assertEquals("Fine. And then", Joiner.join("Fine.", "and then"))
        assertEquals("We went, and then", Joiner.join("We went,", "and then"))
        assertEquals("we went. Then we came back", Joiner.join("we went", "Then we came back"))
        assertEquals("we went to the store", Joiner.join("we went", "to the store"))
        assertEquals("so I think I'm done", Joiner.join("so I think", "I'm done"))
        assertEquals("Start here", Joiner.join("", "start here"))
    }
}
