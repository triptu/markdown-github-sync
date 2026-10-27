package io.github.triptu.notes.capture

import io.github.triptu.notes.vault.sanitizeNoteName
import java.time.LocalDateTime

/** Names new notes `YYYYMMDDHH <first words of the note>`. */
object ZettelName {
    private const val MaxWords = 6
    private const val MaxChars = 48
    private val Markup = Regex("""^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]]\s+)?|>\s+|\d+[.)]\s+)""")
    private val Inline = Regex("""\*\*|__|[*_`~=]|\[\[|]]""")

    fun stamp(now: LocalDateTime): String = MomentFormat.format("YYYYMMDDHH", now)

    fun of(now: LocalDateTime, text: String): String {
        val words = firstWords(text)
        return if (words.isEmpty()) stamp(now) else "${stamp(now)} $words"
    }

    /** The first words after any frontmatter, without markdown, at most [MaxWords] and [MaxChars]. */
    fun firstWords(text: String): String {
        val line = withoutFrontmatter(text).lineSequence().map { it.replace(Markup, "").replace(Inline, "").trim() }.firstOrNull { it.isNotEmpty() }
            ?: return ""
        val words = sanitizeNoteName(line).split(' ').filter { it.isNotEmpty() }.take(MaxWords)
        val joined = StringBuilder()
        for (word in words) {
            val next = if (joined.isEmpty()) word else " $word"
            if (joined.length + next.length > MaxChars) {
                if (joined.isEmpty()) joined.append(word.take(MaxChars))
                break
            }
            joined.append(next)
        }
        return joined.toString().trimEnd(',', ';', '.', '!', '?', '-')
    }

    private fun withoutFrontmatter(text: String): String {
        val lines = text.lines()
        if (lines.firstOrNull()?.trimEnd() != "---") return text
        val close = lines.drop(1).indexOfFirst { it.trimEnd() == "---" }
        return if (close < 0) text else lines.drop(close + 2).joinToString("\n")
    }
}
