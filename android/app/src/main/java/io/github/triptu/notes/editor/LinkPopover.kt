package io.github.triptu.notes.editor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

private val PopoverWidth = 280.dp
private val PopoverShape = RoundedCornerShape(28.dp)
private val RowHeight = 48.dp

/**
 * Note suggestions for the `[[` being typed. Sits just above the line being typed, left-aligned to
 * the `[[`, and drops below the line only when there's no room above. It never takes focus, so
 * the keyboard stays up, and it never moves the text.
 */
@Composable
fun LinkPopover(session: EditorSession, query: LinkQuery, layout: TextLayoutResult, fieldTopInWindow: Int) {
    val colors = NotesTheme.colors
    val density = LocalDensity.current
    val suggestions = remember(query.query, session.path) { session.linkSuggestions(query) }
    val typed = query.query.trim()
    if (suggestions.isEmpty() && typed.isEmpty()) return

    val caret = session.value.selection.start.coerceAtMost(layout.layoutInput.text.length)
    val caretLine = layout.getLineForOffset(caret)
    val openLine = layout.getLineForOffset(query.start)
    val x = if (openLine == caretLine) layout.getHorizontalPosition(query.start, usePrimaryDirection = true) else layout.getLineLeft(caretLine)
    // Room above the caret line (below the top bar) and below it (above the keyboard), in window px.
    val topLimit = WindowInsets.statusBars.getTop(density) + with(density) { 48.dp.roundToPx() }
    val bottomLimit = LocalWindowInfo.current.containerSize.height - WindowInsets.ime.getBottom(density)
    val gap = with(density) { 6.dp.roundToPx() }
    val rowPx = with(density) { RowHeight.roundToPx() }
    val chrome = with(density) { 8.dp.roundToPx() }
    val lineTop = fieldTopInWindow + layout.getLineTop(caretLine).toInt()
    val lineBottom = fieldTopInWindow + layout.getLineBottom(caretLine).toInt()
    val rowsAbove = (lineTop - gap - topLimit - chrome) / rowPx
    val rowsBelow = (bottomLimit - lineBottom - gap - chrome) / rowPx
    val wanted = suggestions.size.coerceAtLeast(1)
    val above = rowsAbove >= wanted || (rowsBelow < wanted && rowsAbove >= rowsBelow)
    val rows = minOf(wanted, if (above) rowsAbove else rowsBelow).coerceAtLeast(1)
    val height = rows * rowPx + chrome
    val position = FixedPosition(
        x = x.toInt(),
        top = if (above) lineTop - gap - height else lineBottom + gap,
    )

    Popup(
        popupPositionProvider = position,
        onDismissRequest = session::dismissLink,
        properties = PopupProperties(focusable = false, dismissOnClickOutside = true),
    ) {
        Column(
            Modifier
                .width(PopoverWidth)
                .shadow(8.dp, PopoverShape)
                .clip(PopoverShape)
                .background(colors.raised)
                .padding(vertical = 4.dp),
        ) {
            if (suggestions.isEmpty()) {
                SuggestionRow("Create “$typed”", null) { session.completeLink(query, typed) }
            }
            for (s in suggestions.take(rows)) {
                SuggestionRow(s.path.displayName, s.path.folder.value.takeIf { s.showFolder && it.isNotEmpty() }) {
                    session.completeLink(query, s.path.name)
                }
            }
        }
    }
}

@Composable
private fun SuggestionRow(title: String, folder: String?, onClick: () -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(RowHeight)
            .padding(horizontal = 4.dp)
            .pressable(onClick, shape = RoundedCornerShape(24.dp), bleed = 16.dp, pressColor = colors.sunk),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = NotesType.row, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (folder != null) {
            Spacer(Modifier.width(8.dp))
            Text(folder, style = NotesType.rowMeta, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Puts the popover at a window position worked out from the caret line. */
private data class FixedPosition(val x: Int, val top: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val left = (anchorBounds.left + x).coerceIn(0, (windowSize.width - popupContentSize.width).coerceAtLeast(0))
        return IntOffset(left, top)
    }
}
