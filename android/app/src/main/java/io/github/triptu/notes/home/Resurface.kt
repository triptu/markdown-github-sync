package io.github.triptu.notes.home

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.SnippetText
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** How long ago an old note is from, as Home words it. */
sealed interface Ago {
    data object Year : Ago
    data object Month : Ago
    /** [showYear] for a month before this year. */
    data class From(val month: YearMonth, val showYear: Boolean) : Ago
}

/** Home's old note for the day: [about] is the date the note is from. */
data class Pick(val path: NotePath, val about: LocalDate)

/**
 * The old note chosen on [day], or null once it was put away for the day. Remembered so the
 * note stays put after you open and edit it, which would otherwise make it look recent.
 */
data class ResurfaceDay(val day: LocalDate, val pick: Pick?) {
    fun encode(): String = listOfNotNull(day.toString(), pick?.about?.toString(), pick?.path?.value).joinToString("\t")

    companion object {
        fun decode(line: String): ResurfaceDay? = runCatching {
            val parts = line.split('\t')
            val pick = if (parts.size == 3) Pick(NotePath(parts[2]), LocalDate.parse(parts[1])) else null
            ResurfaceDay(LocalDate.parse(parts[0]), pick)
        }.getOrNull()
    }
}

/** What Home shows: the note, how long ago it's from, and its first line as plain text. */
data class Resurfaced(val path: NotePath, val ago: Ago, val text: String)

/** Notes that never come back on Home. */
data class ResurfaceRules(
    val weeklyFolder: FolderPath,
    val templateFolders: Set<FolderPath>,
    val zettelFolder: FolderPath,
    val pinned: Set<NotePath>,
)

/**
 * Picks one old note a day for Home. In order of preference:
 * 1. a note from about a year ago, then about a month ago (± [WindowDays]), by the `YYYYMMDD`
 *    stamp in its name, else when it last changed, and left alone for [RestDays];
 * 2. else a Zettelkasten or `fleeting` note left alone for [ForgottenDays].
 * Never weekly notes, templates, pinned notes or near-empty ones. Within a tier the pick is a
 * hash of the day and the path, so it holds all day and changes tomorrow.
 */
object Resurface {
    const val WindowDays = 3L
    const val RestDays = 7L
    const val ForgottenDays = 30L
    private const val MinLetters = 40

    private val StampName = Regex("""^(\d{4})(\d{2})(\d{2})""")
    private val Heading = Regex("""^\s*#{1,6}\s""")
    private val FleetingTag = Regex("""(?m)^(?:tags:.*[\s\[,'"]|\s*-\s+['"]?)#?fleeting['"]?\s*(?:[,\]].*)?$""")

    /** The remembered day while its note is still there, else a fresh pick, or null with nothing to pick. */
    fun today(notes: Map<NotePath, IndexedNote>, today: LocalDate, zone: ZoneId, rules: ResurfaceRules, remembered: ResurfaceDay?): ResurfaceDay? {
        if (remembered?.day == today) {
            val kept = remembered.pick
            if (kept == null || (kept.path in notes && kept.path !in rules.pinned)) return remembered
        }
        return pick(notes.values, today, zone, rules)?.let { ResurfaceDay(today, it) }
    }

    private fun pick(notes: Collection<IndexedNote>, today: LocalDate, zone: ZoneId, rules: ResurfaceRules): Pick? {
        val eligible = notes.filter { !excluded(it.path, rules) }
        fun restedFor(note: IndexedNote, days: Long) = !modifiedOn(note, zone).isAfter(today.minusDays(days))
        val tiers = sequenceOf<(IndexedNote) -> Boolean>(
            { restedFor(it, RestDays) && ago(dateOf(it, zone), today) == Ago.Year },
            { restedFor(it, RestDays) && ago(dateOf(it, zone), today) == Ago.Month },
            { restedFor(it, ForgottenDays) && (it.path.folder.isWithin(rules.zettelFolder) || isFleeting(it.text)) },
        )
        val note = tiers.firstNotNullOfOrNull { tier ->
            eligible.filter(tier).sortedBy { dayHash(today, it.path) }.firstOrNull { hasSubstance(it.text) }
        } ?: return null
        return Pick(note.path, dateOf(note, zone))
    }

    private fun ago(about: LocalDate, today: LocalDate): Ago {
        fun near(target: LocalDate) = ChronoUnit.DAYS.between(about, target) in -WindowDays..WindowDays
        return when {
            near(today.minusYears(1)) -> Ago.Year
            near(today.minusMonths(1)) -> Ago.Month
            else -> Ago.From(YearMonth.from(about), showYear = about.year != today.year)
        }
    }

    fun show(pick: Pick, note: IndexedNote, today: LocalDate): Resurfaced =
        Resurfaced(pick.path, ago(pick.about, today), SnippetText.plain(firstLine(note.text)))

    /** The date a note is from: the stamp in its name when it has one, else when it last changed. */
    private fun dateOf(note: IndexedNote, zone: ZoneId): LocalDate {
        StampName.find(note.path.name)?.let { m ->
            runCatching { return LocalDate.of(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt()) }
        }
        return modifiedOn(note, zone)
    }

    private fun isFleeting(text: String): Boolean = split(text).first?.joinToString("\n")?.let(FleetingTag::containsMatchIn) == true

    private fun excluded(path: NotePath, rules: ResurfaceRules): Boolean =
        path in rules.pinned ||
            (!rules.weeklyFolder.isRoot && path.folder.isWithin(rules.weeklyFolder)) ||
            rules.templateFolders.any { !it.isRoot && path.folder.isWithin(it) }

    private fun modifiedOn(note: IndexedNote, zone: ZoneId): LocalDate = Instant.ofEpochMilli(note.modifiedAt).atZone(zone).toLocalDate()

    /** A well-mixed hash, so neighbouring days don't pick neighbouring notes. */
    private fun dayHash(day: LocalDate, path: NotePath): Long {
        var x = path.value.hashCode().toLong() * -0x61c8864680b583ebL + day.toEpochDay()
        x = (x xor (x ushr 30)) * -0x40a7b892e31b1a47L
        x = (x xor (x ushr 27)) * -0x6b2fb644ecceee15L
        return x xor (x ushr 31)
    }

    /** The frontmatter's lines, or null without any, and the lines after it. */
    private fun split(text: String): Pair<List<String>?, List<String>> {
        val lines = text.lines()
        if (lines.first().trim() != "---") return null to lines
        val end = lines.drop(1).indexOfFirst { it.trim() == "---" }
        return if (end < 0) null to lines else lines.subList(1, end + 1) to lines.drop(end + 2)
    }

    private fun isProse(line: String) = !Heading.containsMatchIn(line) && !SnippetText.isOnlyLinks(line) && line.any { it.isLetter() }

    private fun hasSubstance(text: String): Boolean = split(text).second.filter(::isProse).sumOf { line -> line.count { it.isLetter() } } >= MinLetters

    private fun firstLine(text: String): String = split(text).second.firstOrNull(::isProse)?.trim().orEmpty()
}
