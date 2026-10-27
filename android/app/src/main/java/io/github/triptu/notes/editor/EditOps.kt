package io.github.triptu.notes.editor

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

/** The `[[query` being typed before the cursor, and where its `[[` starts. */
data class LinkQuery(val start: Int, val query: String)

/** Text edits behind taps and link completion. Pure functions of the editor value. */
object EditOps {
    fun toggleTask(value: TextFieldValue, task: TaskMark): TextFieldValue {
        val i = task.stateIndex
        if (i >= value.text.length) return value
        val next = if (task.checked) ' ' else 'x'
        return value.copy(text = value.text.replaceRange(i, i + 1, next.toString()))
    }

    fun insertText(value: TextFieldValue, insert: String): TextFieldValue {
        val sel = value.selection
        val before = value.text.substring(0, sel.min)
        val spacer = if (before.isNotEmpty() && !before.last().isWhitespace()) " " else ""
        val piece = spacer + insert
        return TextFieldValue(value.text.replaceRange(sel.min, sel.max, piece), TextRange(sel.min + piece.length))
    }

    /**
     * Where the open link's `[[` is after an edit, or null when its suggestions should close.
     * It opens only when `[[` was just typed before the cursor, and closes when the cursor is moved
     * without typing, the `[[` is deleted, or `]]` or a line break is typed.
     */
    fun trackLink(old: TextFieldValue, new: TextFieldValue, openAt: Int?): Int? {
        if (!new.selection.collapsed) return null
        val caret = new.selection.start
        val typed = new.text.length - old.text.length
        val justOpened = typed > 0 && caret >= 2 && caret - typed >= 0 &&
            new.text.startsWith("[[", caret - 2) &&
            new.text.removeRange(caret - typed, caret) == old.text
        if (justOpened) return caret - 2
        val start = openAt ?: return null
        if (new.text == old.text && new.selection != old.selection) return null
        if (caret < start + 2 || !new.text.startsWith("[[", start)) return null
        val query = new.text.substring(start + 2, caret)
        if (query.contains("]]") || query.contains("[[") || query.contains('\n')) return null
        return start
    }

    fun linkQuery(value: TextFieldValue, start: Int): LinkQuery =
        LinkQuery(start, value.text.substring(start + 2, value.selection.start.coerceAtLeast(start + 2)))

    /** Replaces the `[[query` before the cursor with `[[name]]`, reusing a `]]` already after it. */
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
}
