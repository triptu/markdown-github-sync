package io.github.triptu.notes.capture

import java.time.DayOfWeek
import java.time.LocalDateTime
import java.time.temporal.ChronoField

/**
 * Fills template placeholders the way Obsidian's Templates and the Periodic Notes plugin do:
 * - `{{date}}`, `{{date:FORMAT}}`, `{{date+7d:FORMAT}}`, `{{date-1w}}`: [date] moved by the offset,
 *   then formatted with moment.js tokens (default [dateFormat]). Units are moment's short ones:
 *   y, Q, M (month), w, d, h, m (minute), s. Periodic Notes takes no long forms like `days`.
 * - `{{time}}`: the current time as `HH:mm`. `{{time:FORMAT}}` and offsets work like `{{date}}`.
 * - `{{title}}`: [title].
 * - `{{monday:FORMAT}}` … `{{sunday:FORMAT}}`: that day of [date]'s week, weeks starting Monday.
 * Anything else, such as an unknown unit, is left as it is.
 */
object NoteTemplate {
    private val DateOrTime = Regex(
        """\{\{\s*(date|time)\s*(?:([+-]\d+)([a-zA-Z]))?\s*(?::(.*?))?\}\}""",
        RegexOption.IGNORE_CASE,
    )
    private val Title = Regex("""\{\{\s*title\s*\}\}""", RegexOption.IGNORE_CASE)
    private val Weekday = Regex(
        """\{\{\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*:(.*?)\}\}""",
        RegexOption.IGNORE_CASE,
    )

    fun fill(
        template: String,
        title: String,
        date: LocalDateTime,
        dateFormat: String = "YYYY-MM-DD",
        now: LocalDateTime = date,
    ): String = template
        .replace(DateOrTime) { m ->
            val (kind, amount, unit, format) = m.destructured
            val at = if (amount.isEmpty()) date else shift(date, amount.toLong(), unit) ?: return@replace m.value
            when {
                format.isNotBlank() -> MomentFormat.format(format.trim(), at)
                kind.equals("time", ignoreCase = true) && amount.isEmpty() -> MomentFormat.format("HH:mm", now)
                else -> MomentFormat.format(dateFormat, at)
            }
        }
        .replace(Title) { title }
        .replace(Weekday) { m ->
            val day = DayOfWeek.valueOf(m.groupValues[1].uppercase())
            MomentFormat.format(m.groupValues[2].trim(), date.with(ChronoField.DAY_OF_WEEK, day.value.toLong()))
        }

    /** moment's `add(amount, unit)` for its one-letter units. Case matters only for M (month) and m (minute). */
    private fun shift(at: LocalDateTime, amount: Long, unit: String): LocalDateTime? = when (unit) {
        "M" -> at.plusMonths(amount)
        "m" -> at.plusMinutes(amount)
        else -> when (unit.lowercase()) {
            "y" -> at.plusYears(amount)
            "q" -> at.plusMonths(amount * 3)
            "w" -> at.plusWeeks(amount)
            "d" -> at.plusDays(amount)
            "h" -> at.plusHours(amount)
            "s" -> at.plusSeconds(amount)
            else -> null
        }
    }
}
