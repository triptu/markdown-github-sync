package io.github.triptu.notes.quick

import io.github.triptu.notes.vault.SnippetText

/** One line of a note as the pinned-note widget shows it. [line] is its index in the note, for toggling. */
sealed interface WidgetLine {
    data class Task(val line: Int, val checked: Boolean, val text: String, val indent: Int) : WidgetLine
    data class Text(val text: String, val heading: Boolean, val bullet: Boolean, val indent: Int) : WidgetLine

    /** A blank line or a rule, shown as a little space. Never two in a row. */
    data object Gap : WidgetLine
}

/** A note's text turned into widget lines, and task toggles back into note text. Pure functions. */
object WidgetNote {
    private const val MaxLines = 300
    private const val MaxIndent = 3
    private val Task = Regex("""^(\s*)[-*+] \[([ xX])\](?: (.*)|$)""")
    private val Heading = Regex("""^#{1,6} (.*)""")
    private val Bullet = Regex("""^(\s*)[-*+] (.*)""")
    private val Ordered = Regex("""^(\s*)(\d+[.)] .*)""")
    private val Quote = Regex("""^\s*>\s?(.*)""")
    private val Rule = Regex("""^\s*([-*_])(\s*\1){2,}\s*$""")
    private val ImageOnly = Regex("""^\s*(!\[\[[^\]]*]]|!\[[^\]]*]\([^)]*\))\s*$""")
    private val Fence = Regex("""^\s*(```|~~~)""")

    /** A first heading that only repeats [title] is left out; the widget already shows the title. */
    fun lines(note: String, title: String): List<WidgetLine> {
        val raw = note.split('\n').map { it.removeSuffix("\r") }
        val out = ArrayList<WidgetLine>()
        fun gap() {
            if (out.isNotEmpty() && out.last() != WidgetLine.Gap) out += WidgetLine.Gap
        }
        var i = frontmatterEnd(raw)
        var inFence = false
        while (i < raw.size && out.size < MaxLines) {
            val line = raw[i]
            val index = i++
            if (Fence.containsMatchIn(line)) {
                inFence = !inFence
                continue
            }
            if (inFence) {
                if (line.isNotBlank()) out += WidgetLine.Text(line.trimEnd(), heading = false, bullet = false, indent = 0)
                continue
            }
            if (line.isBlank() || Rule.matches(line)) {
                gap()
                continue
            }
            if (isConflictMarker(line) || ImageOnly.matches(line)) continue
            Task.find(line)?.let {
                out += WidgetLine.Task(index, it.groupValues[2] != " ", plain(it.groupValues[3]), indent(it.groupValues[1]))
                continue
            }
            Heading.find(line)?.let {
                out += WidgetLine.Text(plain(it.groupValues[1]), heading = true, bullet = false, indent = 0)
                continue
            }
            Bullet.find(line)?.let {
                out += WidgetLine.Text(plain(it.groupValues[2]), heading = false, bullet = true, indent = indent(it.groupValues[1]))
                continue
            }
            Ordered.find(line)?.let {
                // Keep the number; strip only the inline markup after it.
                val (number, rest) = it.groupValues[2].split(' ', limit = 2).let { p -> p[0] to p.getOrElse(1) { "" } }
                out += WidgetLine.Text("$number ${plain(rest)}", heading = false, bullet = false, indent = indent(it.groupValues[1]))
                continue
            }
            val text = Quote.find(line)?.groupValues?.get(1) ?: line
            out += WidgetLine.Text(plain(text), heading = false, bullet = false, indent = 0)
        }
        val first = out.firstOrNull()
        if (first is WidgetLine.Text && first.heading && first.text.trim().equals(title.trim(), ignoreCase = true)) {
            out.removeAt(0)
            if (out.firstOrNull() == WidgetLine.Gap) out.removeAt(0)
        }
        if (out.lastOrNull() == WidgetLine.Gap) out.removeAt(out.lastIndex)
        return out
    }

    /**
     * The note with the task on [line] ticked or unticked. Null when that line is no longer a task
     * in the state the widget showed ([wasChecked]), because the note changed since it was drawn.
     */
    fun toggle(note: String, line: Int, wasChecked: Boolean): String? {
        val lines = note.split('\n').toMutableList()
        val target = lines.getOrNull(line) ?: return null
        val match = Task.find(target) ?: return null
        if ((match.groupValues[2] != " ") != wasChecked) return null
        val state = match.groups[2]!!.range.first
        lines[line] = target.replaceRange(state, state + 1, if (wasChecked) " " else "x")
        return lines.joinToString("\n")
    }

    /** The index of the first line after YAML frontmatter, or 0 when there is none. */
    private fun frontmatterEnd(lines: List<String>): Int {
        if (lines.firstOrNull()?.trim() != "---") return 0
        val close = (1 until lines.size).firstOrNull { lines[it].trim() == "---" } ?: return 0
        return close + 1
    }

    private fun isConflictMarker(line: String) = line.startsWith("<<<<<<< ") || line == "=======" || line.startsWith(">>>>>>> ")

    private fun plain(text: String) = SnippetText.plain(text)

    private fun indent(lead: String): Int {
        val width = lead.sumOf { if (it == '\t') 4 else 1 }
        return ((width + 2) / 4).coerceAtMost(MaxIndent)
    }
}
