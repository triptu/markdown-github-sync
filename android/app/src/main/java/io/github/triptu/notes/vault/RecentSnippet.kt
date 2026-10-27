package io.github.triptu.notes.vault

/**
 * Picks the bit of a note worth showing in a feed: the paragraph that changed most recently.
 *
 * Lines are compared between the old and new text. The last changed line wins. If it sits in a
 * list, the line alone is the snippet (a ticked checkbox, not the whole list); otherwise its whole
 * paragraph is. Without an old text, the last paragraph that has words is used.
 */
object RecentSnippet {
    private const val MaxLength = 400
    private val ListLine = Regex("""^\s*([-*+]|\d+[.)])\s""")
    private val TimeLine = Regex("""^\s*[*_]?\d{1,2}:\d{2}( ?[ap]m)?[*_]?\s*$""", RegexOption.IGNORE_CASE)
    private val Heading = Regex("""^\s*#{1,6}\s""")
    private val FrontmatterFence = "---"

    fun of(old: String?, new: String): String {
        val lines = bodyLines(new)
        if (lines.isEmpty()) return ""
        val changed = if (old == null) null else lastChangedLine(bodyLines(old), lines)
        val snippet = changed?.let { snippetAround(lines, it) }
        return (snippet?.takeIf { it.isNotBlank() } ?: lastParagraph(lines)).take(MaxLength)
    }

    private fun bodyLines(text: String): List<String> {
        val lines = text.lines()
        if (lines.firstOrNull()?.trim() != FrontmatterFence) return lines
        val end = lines.drop(1).indexOfFirst { it.trim() == FrontmatterFence }
        return if (end < 0) lines else lines.drop(end + 2)
    }

    /** Index in [new] of the last line that isn't in the same place in [old], scanning from both ends. */
    private fun lastChangedLine(old: List<String>, new: List<String>): Int? {
        var prefix = 0
        while (prefix < old.size && prefix < new.size && old[prefix] == new[prefix]) prefix++
        var suffix = 0
        while (suffix < old.size - prefix && suffix < new.size - prefix &&
            old[old.size - 1 - suffix] == new[new.size - 1 - suffix]
        ) suffix++
        val lastNew = new.size - 1 - suffix
        if (lastNew < prefix) return null // Only deletions: nothing new to show.
        for (i in lastNew downTo prefix) if (isContent(new[i])) return i
        return null
    }

    private fun isContent(line: String) =
        line.isNotBlank() && !Heading.containsMatchIn(line) && !TimeLine.matches(line) && line.trim() != "- [ ]"

    private fun snippetAround(lines: List<String>, index: Int): String {
        if (ListLine.containsMatchIn(lines[index])) return lines[index].trim()
        var start = index
        while (start > 0 && lines[start - 1].isNotBlank() && !Heading.containsMatchIn(lines[start - 1])) start--
        var end = index
        while (end < lines.size - 1 && lines[end + 1].isNotBlank() && !Heading.containsMatchIn(lines[end + 1])) end++
        return lines.subList(start, end + 1).filter(::isContent).joinToString(" ") { it.trim() }
    }

    private fun lastParagraph(lines: List<String>): String {
        val last = lines.indexOfLast(::isContent)
        return if (last < 0) "" else snippetAround(lines, last)
    }
}
