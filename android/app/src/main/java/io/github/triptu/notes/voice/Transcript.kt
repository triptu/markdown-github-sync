package io.github.triptu.notes.voice

/**
 * The words heard so far, stitched across recognizer sessions.
 *
 * The recognizer stops after a pause, so listening runs as a chain of sessions. Each event names
 * its session. Within a session, partial results replace each other; a final result (or a segment,
 * when the recognizer splits one long session) is added once. When a session ends without a final
 * result, its last partial is kept, so no words are lost. Events for a session that already ended
 * are ignored, so no words are added twice.
 */
class Transcript(initial: String = "") {
    /** Words the recognizer settled on. */
    var committed: String = initial.trim()
        private set

    private val pendingBySession = LinkedHashMap<Int, String>()
    private val ended = HashSet<Int>()
    private var lastSession = 0

    /** Words still being recognized, shown muted. */
    val pending: String get() = pendingBySession.values.filter { it.isNotBlank() }.joinToString(" ") { it.trim() }

    /** Everything heard: what a draft or Save keeps. */
    val text: String get() = Joiner.join(committed, pending)

    /** The separator drawn between [committed] and [pending]. */
    val pendingSeparator: String get() = if (committed.isEmpty() || pending.isEmpty()) "" else " "

    fun newSession(): Int = ++lastSession

    fun onPartial(session: Int, text: String) {
        if (session in ended) return
        pendingBySession[session] = text
    }

    /** A final result, or one segment of a long session. Clears the session's partial. */
    fun onFinal(session: Int, text: String) {
        if (session in ended) return
        pendingBySession.remove(session)
        committed = Joiner.join(committed, text)
    }

    /** The session is over: a partial that never got its final result is kept as heard. */
    fun onSessionEnd(session: Int) {
        if (!ended.add(session)) return
        pendingBySession.remove(session)?.let { committed = Joiner.join(committed, it) }
    }

    /** Ends every open session, keeping their partials. Used when listening stops for good. */
    fun settle() {
        pendingBySession.keys.toList().forEach(::onSessionEnd)
    }
}

/** Joins recognized pieces into sentences. Pure functions. */
object Joiner {
    private const val Terminal = ".!?…"
    private const val Soft = ",;:-–—"

    /**
     * Joins [next] after [prev] with one space. A piece after a sentence end starts with a capital.
     * A capitalized piece after unpunctuated text is a new sentence, so [prev] gets a full stop;
     * "I" and its contractions don't count as a new sentence.
     */
    fun join(prev: String, next: String): String {
        val a = prev.trimEnd()
        val b = next.trim()
        if (b.isEmpty()) return a
        if (a.isEmpty()) return capitalize(b)
        val last = a.last()
        return when {
            last in Terminal -> "$a ${capitalize(b)}"
            last in Soft -> "$a $b"
            startsSentence(b) -> "$a. $b"
            else -> "$a $b"
        }
    }

    private fun startsSentence(piece: String): Boolean {
        val first = piece.first()
        if (!first.isUpperCase()) return false
        val word = piece.takeWhile { !it.isWhitespace() }
        return !(word == "I" || word.startsWith("I'") || word.startsWith("I’"))
    }

    fun capitalize(piece: String): String =
        if (piece.isEmpty() || !piece[0].isLowerCase()) piece else piece[0].uppercaseChar() + piece.substring(1)
}
