package io.github.triptu.notes.recents

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import io.github.triptu.notes.ui.HomeSide
import io.github.triptu.notes.ui.PageBar
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.Inter
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

private val CardShape = RoundedCornerShape(16.dp)
private val CardTitle = TextStyle(fontFamily = Inter, fontSize = 15.sp, fontWeight = FontWeight.Medium)
private val CardMeta = TextStyle(fontFamily = Inter, fontSize = 13.sp)
private val CardBody = TextStyle(fontFamily = Inter, fontSize = 15.sp, lineHeight = 22.sp)
private const val TaskGlyph = "task"

@Composable
fun RecentsScreen(feed: RecentsFeed, onHome: () -> Unit, onOpen: (RecentCard) -> Unit) {
    val colors = NotesTheme.colors
    Column(Modifier.fillMaxSize()) {
        PageBar("Recents", HomeSide.Start, onHome)
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = PagePadding, end = PagePadding, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (feed.isEmpty) {
                item(key = "empty") {
                    Text("What you write shows up here, newest first.", style = NotesType.row, color = colors.muted)
                }
            }
            for ((i, section) in feed.sections.withIndex()) {
                if (section.label.isNotEmpty()) {
                    item(key = "label:$i:${section.label}") {
                        Text(section.label, style = NotesType.day, color = colors.muted, modifier = Modifier.padding(top = 8.dp))
                    }
                }
                items(section.cards, key = { "card:$i:" + it.path.value }) { card -> Card(card, onOpen) }
            }
        }
    }
}

/** Every card has the same shape: title and time on one line, then up to three lines of text. */
@Composable
private fun Card(card: RecentCard, onOpen: (RecentCard) -> Unit) {
    val colors = NotesTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(colors.raised)
            .pressable({ onOpen(card) }, shape = CardShape, bleed = 16.dp, label = "Open ${card.path.displayName}", pressColor = colors.sunk)
            .padding(vertical = 16.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Text(
                card.path.displayName, style = CardTitle, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).alignByBaseline(),
            )
            Spacer(Modifier.padding(start = 12.dp))
            Text(card.meta, style = CardMeta, color = colors.muted, maxLines = 1, modifier = Modifier.alignByBaseline())
        }
        Spacer(Modifier.height(6.dp))
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
            style = CardBody,
            color = colors.ink2,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            inlineContent = mapOf(
                TaskGlyph to InlineTextContent(Placeholder(1.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
                    PhIcon(glyph, null, 15.dp, colors.muted)
                },
            ),
        )
    }
}
