package io.github.triptu.notes.recents

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.github.triptu.notes.R
import io.github.triptu.notes.home.PinIcons
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.HomeSide
import io.github.triptu.notes.ui.PageBar
import io.github.triptu.notes.ui.ReadingColumn
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.Inter
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderPath

private val RowTitle = TextStyle(fontFamily = Inter, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
private val RowMeta = TextStyle(fontFamily = Inter, fontSize = 13.sp)
private val RowBody = TextStyle(fontFamily = Inter, fontSize = 14.5.sp, lineHeight = 21.sp)
private val PressShape = RoundedCornerShape(14.dp)
private const val TaskGlyph = "task"

@Composable
fun RecentsScreen(feed: RecentsFeed, weeklyFolder: FolderPath, onHome: () -> Unit, onOpen: (RecentCard) -> Unit) {
    val colors = NotesTheme.colors
    ReadingColumn {
        PageBar("Recents", HomeSide.Start, onHome)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (feed.isEmpty) {
                item(key = "empty") {
                    Text(
                        "What you write shows up here, newest first.", style = NotesType.row, color = colors.muted,
                        modifier = Modifier.padding(horizontal = PagePadding, vertical = 20.dp),
                    )
                }
            }
            for ((i, section) in feed.sections.withIndex()) {
                item(key = "label:$i:${section.label}") {
                    Text(
                        section.label, style = NotesType.day, color = colors.muted,
                        modifier = Modifier.padding(start = PagePadding, end = PagePadding, top = 20.dp, bottom = 4.dp),
                    )
                }
                items(section.cards, key = { "row:$i:" + it.path.value }) { card -> RecentRow(card, weeklyFolder, onOpen) }
            }
        }
    }
}

/** A plain row on the page: icon, title and time on one line, then up to two lines of text. */
@Composable
private fun RecentRow(card: RecentCard, weeklyFolder: FolderPath, onOpen: (RecentCard) -> Unit) {
    val colors = NotesTheme.colors
    val icon = PinIcons.of(Pin.Note(card.path), weeklyFolder)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .pressable({ onOpen(card) }, shape = PressShape, bleed = PagePadding - 8.dp, label = "Open ${card.path.displayName}", pressColor = colors.raised)
            .padding(vertical = 14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        PhIcon(icon, null, 24.dp, colors.muted)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Row(Modifier.fillMaxWidth()) {
                Text(
                    card.path.displayName, style = RowTitle, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).alignByBaseline(),
                )
                Spacer(Modifier.width(12.dp))
                Text(card.meta, style = RowMeta, color = colors.muted, maxLines = 1, modifier = Modifier.alignByBaseline())
            }
            Spacer(Modifier.height(3.dp))
            val text = buildAnnotatedString {
                if (card.task != null) {
                    appendInlineContent(TaskGlyph, "[task]")
                    append(" ")
                }
                append(card.text)
            }
            val glyph = if (card.task == true) R.drawable.ph_check_square else R.drawable.ph_square
            Text(
                text,
                style = RowBody,
                color = colors.ink2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                inlineContent = mapOf(
                    TaskGlyph to InlineTextContent(Placeholder(1.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
                        PhIcon(glyph, null, 14.dp, colors.muted)
                    },
                ),
            )
        }
    }
}
