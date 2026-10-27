package io.github.triptu.notes.recents

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.SnippetText
import io.github.triptu.notes.vault.VaultSnapshot
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/** One card: a note, when it changed, and plain text from the change. */
data class RecentCard(
    val path: NotePath,
    val meta: String,
    val text: String,
    /** Null unless the snippet is one task line; then whether it's ticked. */
    val task: Boolean?,
    /** The raw snippet, so the editor can scroll to it. */
    val source: String,
)

data class RecentSection(val label: String, val cards: List<RecentCard>)

data class RecentsFeed(val sections: List<RecentSection>) {
    val isEmpty: Boolean get() = sections.isEmpty()

    companion object {
        val Empty = RecentsFeed(emptyList())
    }
}

/**
 * Builds Recents: one card per note, newest change first, in sections (Today, Yesterday, this
 * week's weekdays, then dates).
 */
object RecentsFeedBuilder {
    private const val MaxCards = 40
    private const val WindowDays = 60L
    private val TimeOfDay = DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)
    private val DayFormat = DateTimeFormatter.ofPattern("EEEE", Locale.ENGLISH)
    private val DateFormat = DateTimeFormatter.ofPattern("d MMMM", Locale.ENGLISH)
    private val DateWithYear = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH)

    fun build(snapshot: VaultSnapshot, now: LocalDateTime, zone: ZoneId, hidden: FolderPath?): RecentsFeed {
        val today = now.toLocalDate()
        val notes = snapshot.notes.values.filter { note ->
            note.snippet.isNotBlank() && (hidden == null || hidden.isRoot || !note.path.folder.isWithin(hidden))
        }
        val recent = notes
            .map { it to Instant.ofEpochMilli(it.modifiedAt).atZone(zone).toLocalDateTime() }
            .filter { (_, at) -> !at.toLocalDate().isBefore(today.minusDays(WindowDays)) && !at.isAfter(now.plusMinutes(5)) }
            .sortedByDescending { (_, at) -> at }
            .take(MaxCards)
        val sections = recent
            .groupBy { (_, at) -> sectionLabel(at.toLocalDate(), today) }
            .map { (label, items) -> RecentSection(label, items.map { (note, at) -> card(note, relativeTime(at, now)) }) }
        return RecentsFeed(sections)
    }

    /**
     * "now", "24m", "2h" today; before today the section heading already names the day, so the
     * row shows the time of day ("18:20").
     */
    fun relativeTime(at: LocalDateTime, now: LocalDateTime): String {
        val minutes = ChronoUnit.MINUTES.between(at, now).coerceAtLeast(0)
        return when {
            at.toLocalDate() == now.toLocalDate() && minutes < 1 -> "now"
            at.toLocalDate() == now.toLocalDate() && minutes < 60 -> "${minutes}m"
            at.toLocalDate() == now.toLocalDate() -> "${minutes / 60}h"
            else -> TimeOfDay.format(at)
        }
    }

    private fun sectionLabel(day: LocalDate, today: LocalDate): String {
        val daysAgo = ChronoUnit.DAYS.between(day, today)
        return when {
            daysAgo == 0L -> "Today"
            daysAgo == 1L -> "Yesterday"
            daysAgo < today.dayOfWeek.value -> DayFormat.format(day) // Earlier this week (weeks start Monday).
            day.year == today.year -> DateFormat.format(day)
            else -> DateWithYear.format(day)
        }
    }

    private fun card(note: IndexedNote, meta: String): RecentCard =
        RecentCard(note.path, meta, SnippetText.plain(note.snippet), SnippetText.taskState(note.snippet), note.snippet)
}
