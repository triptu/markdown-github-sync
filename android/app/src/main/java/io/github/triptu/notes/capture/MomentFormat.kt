package io.github.triptu.notes.capture

import java.time.LocalDateTime
import java.time.format.TextStyle
import java.time.temporal.IsoFields
import java.util.Locale

/**
 * The subset of moment.js formatting that Obsidian vaults use for note names.
 * Text in `[brackets]` is literal. Unknown letters pass through unchanged, as in moment.
 */
object MomentFormat {
    // Longest tokens first so "GGGG" wins over "GG".
    private val Tokens = listOf(
        "GGGG", "gggg", "YYYY", "MMMM", "dddd", "GG", "gg", "YY", "MMM", "MM", "Do", "DD", "WW", "ww",
        "ddd", "HH", "hh", "mm", "ss", "M", "D", "W", "w", "H", "h", "A", "a",
    )

    fun format(pattern: String, at: LocalDateTime, locale: Locale = Locale.ENGLISH): String {
        val out = StringBuilder()
        var i = 0
        while (i < pattern.length) {
            if (pattern[i] == '[') {
                val close = pattern.indexOf(']', i + 1)
                if (close > 0) {
                    out.append(pattern, i + 1, close)
                    i = close + 1
                    continue
                }
            }
            val token = Tokens.firstOrNull { pattern.startsWith(it, i) }
            if (token == null) {
                out.append(pattern[i])
                i++
            } else {
                out.append(render(token, at, locale))
                i += token.length
            }
        }
        return out.toString()
    }

    private fun render(token: String, at: LocalDateTime, locale: Locale): String {
        // moment's locale weeks (gggg, ww) follow the vault's week start. This vault's weeks start
        // on Monday and its weekly notes are named by ISO week, so locale weeks are ISO weeks here.
        return when (token) {
            "GGGG", "gggg" -> at.get(IsoFields.WEEK_BASED_YEAR).toString()
            "GG", "gg" -> two(at.get(IsoFields.WEEK_BASED_YEAR) % 100)
            "WW", "ww" -> two(at.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR))
            "W", "w" -> at.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR).toString()
            "YYYY" -> at.year.toString()
            "YY" -> two(at.year % 100)
            "MMMM" -> at.month.getDisplayName(TextStyle.FULL, locale)
            "MMM" -> at.month.getDisplayName(TextStyle.SHORT, locale)
            "MM" -> two(at.monthValue)
            "M" -> at.monthValue.toString()
            "Do" -> ordinal(at.dayOfMonth)
            "DD" -> two(at.dayOfMonth)
            "D" -> at.dayOfMonth.toString()
            "dddd" -> at.dayOfWeek.getDisplayName(TextStyle.FULL, locale)
            "ddd" -> at.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)
            "HH" -> two(at.hour)
            "H" -> at.hour.toString()
            "hh" -> two(twelve(at.hour))
            "h" -> twelve(at.hour).toString()
            "mm" -> two(at.minute)
            "ss" -> two(at.second)
            "A" -> if (at.hour < 12) "AM" else "PM"
            "a" -> if (at.hour < 12) "am" else "pm"
            else -> token
        }
    }

    private fun two(n: Int) = n.toString().padStart(2, '0')

    private fun twelve(hour: Int) = if (hour % 12 == 0) 12 else hour % 12

    fun ordinal(n: Int): String {
        val suffix = if (n % 100 in 11..13) "th" else when (n % 10) {
            1 -> "st"
            2 -> "nd"
            3 -> "rd"
            else -> "th"
        }
        return "$n$suffix"
    }
}
