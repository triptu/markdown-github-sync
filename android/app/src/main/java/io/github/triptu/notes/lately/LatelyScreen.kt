package io.github.triptu.notes.lately

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.ui.HintsRow
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.TaskBox
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.NotePath

@Composable
fun LatelyScreen(feed: LatelyFeed, onHome: () -> Unit, onOpen: (NotePath) -> Unit) {
    val colors = NotesTheme.colors
    Column(Modifier.fillMaxSize()) {
        HintsRow(left = "Home", right = null, onLeft = onHome, onRight = {})
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            item(key = "title") {
                Text("Lately", style = NotesType.title, color = colors.ink, modifier = Modifier.padding(start = PagePadding, end = PagePadding, top = 6.dp, bottom = 14.dp))
            }
            if (feed.isEmpty) {
                item(key = "empty") {
                    Text("What you write shows up here, newest first.", style = NotesType.row, color = colors.muted, modifier = Modifier.padding(horizontal = PagePadding))
                }
            }
            group("Today", feed.today, onOpen)
            feed.yearAgo?.let { old ->
                item(key = "yearAgo") { YearAgoCard(old, onOpen) }
            }
            group("Earlier", feed.earlier, onOpen)
            item(key = "end") { Spacer(Modifier.height(24.dp)) }
        }
    }
}

private fun LazyListScope.group(label: String, entries: List<LatelyEntry>, onOpen: (NotePath) -> Unit) {
    if (entries.isEmpty()) return
    item(key = "day:$label") {
        Text(label, style = NotesType.day, color = NotesTheme.colors.muted, modifier = Modifier.padding(start = PagePadding, end = PagePadding, top = 10.dp))
    }
    itemsIndexed(entries, key = { _, e -> "$label:${e.path.value}" }) { i, entry ->
        if (i > 0) HorizontalDivider(Modifier.padding(horizontal = PagePadding), thickness = 1.dp, color = NotesTheme.colors.line)
        Entry(entry, onOpen)
    }
}

@Composable
private fun Entry(entry: LatelyEntry, onOpen: (NotePath) -> Unit) {
    val colors = NotesTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = PagePadding - 12.dp)
            .pressable({ onOpen(entry.path) }, label = "Open ${entry.path.name}")
            .padding(top = 14.dp, bottom = 16.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(entry.path.name, style = NotesType.entryHead.copy(fontWeight = FontWeight.Medium), color = colors.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text(entry.time, style = NotesType.entryHead, color = colors.muted, modifier = Modifier.padding(start = 12.dp))
        }
        Row(verticalAlignment = Alignment.Top) {
            if (entry.task != null) {
                TaskBox(entry.task, Modifier.padding(top = 3.dp))
                Spacer(Modifier.size(10.dp))
            }
            Text(
                entry.text,
                style = NotesType.entryBody.copy(textDecoration = if (entry.task == true) TextDecoration.LineThrough else null),
                color = if (entry.task == true) colors.muted else colors.ink,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun YearAgoCard(old: Resurfaced, onOpen: (NotePath) -> Unit) {
    val colors = NotesTheme.colors
    Column(
        Modifier
            .padding(horizontal = PagePadding)
            .padding(top = 6.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.raised)
            .pressable({ onOpen(old.path) }, shape = RoundedCornerShape(16.dp), bleed = 16.dp, label = "Open ${old.path.name}", pressColor = colors.sunk)
            .padding(top = 14.dp, bottom = 16.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(old.label, style = NotesType.entryHead.copy(fontWeight = FontWeight.Medium), color = colors.ink2, modifier = Modifier.weight(1f))
            PhIcon(R.drawable.ph_clock_counter_clockwise, null, 16.dp, colors.muted)
        }
        Text(old.text, style = NotesType.entryBody, color = colors.ink, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}
