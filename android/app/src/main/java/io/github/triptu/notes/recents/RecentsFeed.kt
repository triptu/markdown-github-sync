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

/** One card: a note, when it changed (or "A year ago · Journal"), and plain text from the change. */
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
 * week's weekdays, then dates). At most one note from about a year ago follows Today's cards.
 */
object RecentsFeedBuilder {
    private const val MaxCards = 40
    private const val WindowDays = 60L
    private const val YearAgoWindowDays = 3L
    private val TimeFormat = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    private val DayFormat = DateTimeFormatter.ofPattern("EEEE", Locale.ENGLISH)
    private val DateFormat = DateTimeFormatter.ofPattern("d MMMM", Locale.ENGLISH)
    private val DateWithYear = DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH)
    private val StampName = Regex("""^(\d{4})(\d{2})(\d{2})""")
    private val WeeklyName = Regex("""(\d{1,2})(?:st|nd|rd|th) ([A-Z][a-z]{2}),? (\d{4})""")
    private val Months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

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
            .map { (label, items) -> RecentSection(label, items.map { (note, at) -> card(note, TimeFormat.format(at).lowercase(Locale.ENGLISH)) }) }
            .toMutableList()
        yearAgo(notes, today, zone)?.let { old ->
            val afterToday = if (sections.firstOrNull()?.label == "Today") 1 else 0
            sections.add(afterToday, RecentSection("", listOf(old)))
        }
        return RecentsFeed(sections)
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

    /** One note dated about a year ago, chosen the same way all day so it doesn't flicker. */
    private fun yearAgo(notes: List<IndexedNote>, today: LocalDate, zone: ZoneId): RecentCard? {
        val target = today.minusYears(1)
        val candidates = notes.filter { note ->
            val days = ChronoUnit.DAYS.between(dateOf(note, zone), target)
            days in -YearAgoWindowDays..YearAgoWindowDays || (WeeklyName.containsMatchIn(note.path.name) && days in 0L..6L)
        }.sortedBy { it.path.value }
        if (candidates.isEmpty()) return null
        val pick = candidates[Math.floorMod(today.toEpochDay(), candidates.size.toLong()).toInt()]
        val folder = pick.path.folder.value.substringBefore('/').ifEmpty { "your notes" }.replaceFirstChar { it.uppercase() }
        return card(pick, "A year ago · $folder")
    }

    /** The date a note is about: from its name when it has one, else when it was last changed. */
    fun dateOf(note: IndexedNote, zone: ZoneId): LocalDate {
        val name = note.path.name
        StampName.find(name)?.let { m ->
            runCatching { return LocalDate.of(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt()) }
        }
        WeeklyName.find(name)?.let { m ->
            val month = Months.indexOf(m.groupValues[2])
            if (month >= 0) runCatching { return LocalDate.of(m.groupValues[3].toInt(), month + 1, m.groupValues[1].toInt()) }
        }
        return Instant.ofEpochMilli(note.modifiedAt).atZone(zone).toLocalDate()
    }
}
