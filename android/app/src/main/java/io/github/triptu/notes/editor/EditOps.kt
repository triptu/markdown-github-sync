package io.github.triptu.notes.editor

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

/** The `[[query` being typed before the cursor, and where its `[[` starts. */
data class LinkQuery(val start: Int, val query: String)

/** Text edits behind the toolbar and taps. Pure functions of the editor value. */
object EditOps {
    private val TaskPrefix = Regex("""^(\s*)[-*+] \[[ xX]\] ?""")
    private val BulletPrefix = Regex("""^(\s*)([-*+]) """)
    private val HeadingPrefix = Regex("""^(#{1,6}) """)

    fun toggleTask(value: TextFieldValue, task: TaskMark): TextFieldValue {
        val i = task.stateIndex
        if (i >= value.text.length) return value
        val next = if (task.checked) ' ' else 'x'
        return value.copy(text = value.text.replaceRange(i, i + 1, next.toString()))
    }

    /** Makes the cursor's line a task, or a task back into plain text. */
    fun toggleTaskLine(value: TextFieldValue): TextFieldValue = editLine(value) { line ->
        TaskPrefix.find(line)?.let { return@editLine it.groupValues[1] + line.substring(it.range.last + 1) }
        BulletPrefix.find(line)?.let { return@editLine it.groupValues[1] + it.groupValues[2] + " [ ] " + line.substring(it.range.last + 1) }
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        "$indent- [ ] ${line.substring(indent.length)}"
    }

    /** Cycles the cursor's line through `#`, `##`, `###` and plain text. */
    fun cycleHeading(value: TextFieldValue): TextFieldValue = editLine(value) { line ->
        val match = HeadingPrefix.find(line)
        val level = match?.groupValues?.get(1)?.length ?: 0
        val body = match?.let { line.substring(it.range.last + 1) } ?: line
        if (level >= 3) body else "#".repeat(level + 1) + " " + body
    }

    /** Wraps the selection in `[[ ]]`, or opens an empty link at the cursor. */
    fun insertLink(value: TextFieldValue): TextFieldValue {
        val sel = value.selection
        val chosen = value.text.substring(sel.min, sel.max)
        val text = value.text.replaceRange(sel.min, sel.max, "[[$chosen]]")
        val cursor = if (chosen.isEmpty()) sel.min + 2 else sel.min + chosen.length + 4
        return TextFieldValue(text, TextRange(cursor))
    }

    fun insertText(value: TextFieldValue, insert: String): TextFieldValue {
        val sel = value.selection
        val before = value.text.substring(0, sel.min)
        val spacer = if (before.isNotEmpty() && !before.last().isWhitespace()) " " else ""
        val piece = spacer + insert
        return TextFieldValue(value.text.replaceRange(sel.min, sel.max, piece), TextRange(sel.min + piece.length))
    }

    fun linkQuery(value: TextFieldValue): LinkQuery? {
        if (!value.selection.collapsed) return null
        val cursor = value.selection.start
        val lineStart = value.text.lastIndexOf('\n', cursor - 1) + 1
        val before = value.text.substring(lineStart, cursor)
        val open = before.lastIndexOf("[[")
        if (open < 0) return null
        val query = before.substring(open + 2)
        if (query.contains("]]") || query.contains('|') || query.length > 60) return null
        return LinkQuery(lineStart + open, query)
    }

    /** Replaces the `[[query` before the cursor with a finished link to [name]. */
    fun completeLink(value: TextFieldValue, query: LinkQuery, name: String): TextFieldValue {
        val cursor = value.selection.start
        val closeAfter = if (value.text.startsWith("]]", cursor)) cursor + 2 else cursor
        val link = "[[$name]]"
        val text = value.text.replaceRange(query.start, closeAfter, link)
        return TextFieldValue(text, TextRange(query.start + link.length))
    }

    /**
     * Where the cursor goes when the text is replaced from outside: it keeps its place relative to
     * the unchanged start or end of the text, and moves to the edge of the change if it was inside it.
     */
    fun mapSelection(old: String, new: String, selection: TextRange): TextRange {
        var prefix = 0
        val max = minOf(old.length, new.length)
        while (prefix < max && old[prefix] == new[prefix]) prefix++
        var suffix = 0
        while (suffix < max - prefix && old[old.length - 1 - suffix] == new[new.length - 1 - suffix]) suffix++
        fun map(offset: Int): Int = when {
            offset <= prefix -> offset
            offset >= old.length - suffix -> offset + new.length - old.length
            else -> new.length - suffix
        }.coerceIn(0, new.length)
        return TextRange(map(selection.start), map(selection.end))
    }

    private inline fun editLine(value: TextFieldValue, edit: (String) -> String): TextFieldValue {
        val text = value.text
        val cursor = value.selection.start.coerceIn(0, text.length)
        val start = text.lastIndexOf('\n', cursor - 1) + 1
        val end = text.indexOf('\n', cursor).let { if (it < 0) text.length else it }
        val line = text.substring(start, end)
        val edited = edit(line)
        val delta = edited.length - line.length
        val newCursor = (cursor + delta).coerceIn(start, start + edited.length)
        return TextFieldValue(text.replaceRange(start, end, edited), TextRange(newCursor))
    }
}
