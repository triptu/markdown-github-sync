package io.github.triptu.notes.lately

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

data class LatelyEntry(
    val path: NotePath,
    val time: String,
    val text: String,
    /** The snippet is one task line: null if not a task, else whether it's ticked. */
    val task: Boolean?,
)

data class Resurfaced(val path: NotePath, val label: String, val text: String)

data class LatelyFeed(val today: List<LatelyEntry>, val earlier: List<LatelyEntry>, val yearAgo: Resurfaced?) {
    val isEmpty: Boolean get() = today.isEmpty() && earlier.isEmpty() && yearAgo == null

    companion object {
        val Empty = LatelyFeed(emptyList(), emptyList(), null)
    }
}

/** Builds the Lately feed: what was written recently, newest first, and maybe one note from a year ago. */
object LatelyFeedBuilder {
    private const val MaxEntries = 40
    private const val EarlierDays = 45L
    private const val YearAgoWindowDays = 3L
    private val TimeFormat = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    private val DayFormat = DateTimeFormatter.ofPattern("EEE", Locale.ENGLISH)
    private val DateFormat = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
    private val StampName = Regex("""^(\d{4})(\d{2})(\d{2})""")
    private val WeeklyName = Regex("""(\d{1,2})(?:st|nd|rd|th) ([A-Z][a-z]{2}),? (\d{4})""")
    private val Months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun build(snapshot: VaultSnapshot, now: LocalDateTime, zone: ZoneId, hidden: FolderPath?): LatelyFeed {
        val today = now.toLocalDate()
        val earliest = today.minusDays(EarlierDays)
        val notes = snapshot.notes.values.filter { note ->
            note.snippet.isNotBlank() && (hidden == null || hidden.isRoot || !note.path.folder.isWithin(hidden))
        }
        val recent = notes
            .map { it to Instant.ofEpochMilli(it.modifiedAt).atZone(zone).toLocalDateTime() }
            .filter { (_, at) -> !at.toLocalDate().isBefore(earliest) && !at.isAfter(now.plusMinutes(5)) }
            .sortedByDescending { (_, at) -> at }
            .take(MaxEntries)
        val (todays, older) = recent.partition { (_, at) -> at.toLocalDate() == today }
        return LatelyFeed(
            today = todays.map { (note, at) -> entry(note, TimeFormat.format(at).lowercase(Locale.ENGLISH)) },
            earlier = older.map { (note, at) -> entry(note, earlierLabel(at.toLocalDate(), today)) },
            yearAgo = yearAgo(notes, today, zone),
        )
    }

    private fun earlierLabel(day: LocalDate, today: LocalDate): String = when {
        day == today.minusDays(1) -> "Yesterday"
        ChronoUnit.DAYS.between(day, today) < 7 -> DayFormat.format(day)
        else -> DateFormat.format(day)
    }

    private fun entry(note: IndexedNote, time: String): LatelyEntry {
        val task = SnippetText.taskState(note.snippet)
        return LatelyEntry(note.path, time, SnippetText.plain(note.snippet), task)
    }

    /** One note dated about a year ago, chosen the same way all day so it doesn't flicker. */
    private fun yearAgo(notes: List<IndexedNote>, today: LocalDate, zone: ZoneId): Resurfaced? {
        val target = today.minusYears(1)
        val candidates = notes.filter { note ->
            val date = dateOf(note, zone)
            val days = ChronoUnit.DAYS.between(date, target)
            days in -YearAgoWindowDays..YearAgoWindowDays || (isWeekly(note) && days in 0L..6L)
        }.sortedBy { it.path.value }
        if (candidates.isEmpty()) return null
        val pick = candidates[Math.floorMod(today.toEpochDay(), candidates.size.toLong()).toInt()]
        val folder = pick.path.folder.value.substringBefore('/').ifEmpty { "your notes" }
        return Resurfaced(pick.path, "A year ago, in ${folder.replaceFirstChar { it.uppercase() }}", SnippetText.plain(pick.snippet))
    }

    private fun isWeekly(note: IndexedNote) = WeeklyName.containsMatchIn(note.path.name)

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

/** Turns a markdown snippet into display text. */
object SnippetText {
    private val Task = Regex("""^\s*[-*+] \[([ xX])\]\s*""")
    private val Prefix = Regex("""^\s*([-*+]|\d+[.)]|>|#{1,6})\s+""")
    private val AliasLink = Regex("""\[\[[^\]|]*\|([^\]]*)]]""")
    private val Link = Regex("""\[\[([^\]]*)]]""")
    private val Emphasis = Regex("""\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)|`|==""")

    fun taskState(snippet: String): Boolean? = Task.find(snippet)?.let { it.groupValues[1] != " " }

    fun plain(snippet: String): String = snippet
        .replace(Task, "")
        .replace(Prefix, "")
        .replace(AliasLink, "$1")
        .replace(Link, "$1")
        .replace(Emphasis, "")
        .trim()
}
