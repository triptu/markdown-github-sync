package io.github.triptu.notes.editor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

const val LinkRows = 3
private val RowHeight = 48.dp
private val SheetPadding = 6.dp

/** The suggestions' height, which never changes while they're open, so the text can keep clear of it. */
val LinkSuggestionsHeight = RowHeight * LinkRows + SheetPadding * 2

/** One suggestion row: what it shows and the note name it links to. */
data class LinkChoice(val title: String, val folder: String?, val name: String)

/**
 * Note suggestions for the `[[` being typed, docked above the keyboard. They stay put and keep one
 * height while typing, so only the row texts change; the editor keeps the line being typed above them.
 */
@Composable
fun LinkSuggestions(choices: List<LinkChoice>, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = NotesTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .height(LinkSuggestionsHeight)
            .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
            .background(colors.raised)
            .padding(vertical = SheetPadding, horizontal = PagePadding - 12.dp),
    ) {
        for (choice in choices) {
            SuggestionRow(choice) { onPick(choice.name) }
        }
    }
}

@Composable
private fun SuggestionRow(choice: LinkChoice, onClick: () -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(RowHeight)
            .pressable(onClick, pressColor = colors.sunk),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(choice.title, style = NotesType.row, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (choice.folder != null) {
            Spacer(Modifier.width(8.dp))
            Text(choice.folder, style = NotesType.rowMeta, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
