package io.github.triptu.notes.quick

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.home.PinIcons
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.IconButton48
import io.github.triptu.notes.ui.ListRow
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.VaultQueries
import io.github.triptu.notes.vault.VaultSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A sheet at the bottom of the screen, over a dimmed backdrop. Tapping the backdrop dismisses it. */
@Composable
fun BottomSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val colors = NotesTheme.colors
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.32f))
            .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onDismiss)
            .windowInsetsPadding(WindowInsets.statusBars),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                .background(colors.bg)
                .clickable(remember { MutableInteractionSource() }, indication = null) {}
                .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                .padding(top = 12.dp, bottom = 8.dp),
            content = content,
        )
    }
}

/** A small grey label above a group of rows. */
@Composable
fun SheetLabel(text: String) {
    Text(
        text, style = NotesType.section, color = NotesTheme.colors.muted,
        modifier = Modifier.padding(horizontal = PagePadding, vertical = 8.dp),
    )
}

/**
 * Picks a note: pinned notes first (This week always among them), then a search over the vault.
 * Folders aren't offered.
 */
@Composable
fun NotePicker(pins: List<Pin>, snapshot: VaultSnapshot, weeklyFolder: FolderPath, onPick: (Pin) -> Unit) {
    val colors = NotesTheme.colors
    var query by rememberSaveable { mutableStateOf("") }
    val choices = remember(pins) { pins.filter { it !is Pin.Folder }.let { if (Pin.ThisWeek in it) it else it + Pin.ThisWeek } }
    val hits by produceState(emptyList<Pin.Note>(), query, snapshot) {
        value = withContext(Dispatchers.Default) { VaultQueries.search(snapshot, query).take(MaxHits).map { Pin.Note(it.path) } }
    }
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
        if (query.isBlank()) {
            item { SheetLabel(QuickCopy.Pinned) }
            items(choices, key = Pin::encode) { pin -> PinRow(pin, weeklyFolder, onPick) }
        } else if (hits.isEmpty()) {
            item {
                Text(QuickCopy.NoMatches, style = NotesType.row, color = colors.muted, modifier = Modifier.padding(horizontal = PagePadding, vertical = 16.dp))
            }
        } else {
            items(hits, key = Pin::encode) { pin -> PinRow(pin, weeklyFolder, onPick) }
        }
    }
    SearchBox(query) { query = it }
}

@Composable
private fun PinRow(pin: Pin, weeklyFolder: FolderPath, onPick: (Pin) -> Unit) {
    val (label, folder) = when (pin) {
        is Pin.Note -> pin.path.displayName to pin.path.folder.value.ifEmpty { null }
        else -> QuickCopy.ThisWeek to null
    }
    ListRow(PinIcons.of(pin, weeklyFolder), label, { onPick(pin) }, subtitle = folder, height = 52.dp)
}

@Composable
private fun SearchBox(query: String, onQuery: (String) -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier
            .padding(horizontal = PagePadding - 4.dp, vertical = 8.dp)
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(colors.raised)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PhIcon(R.drawable.ph_magnifying_glass, null, 20.dp, colors.muted)
        BasicTextField(
            value = query,
            onValueChange = onQuery,
            singleLine = true,
            textStyle = NotesType.field.copy(color = colors.ink),
            cursorBrush = SolidColor(colors.ink),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text(QuickCopy.SearchNotes, style = NotesType.field, color = colors.muted)
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) IconButton48(R.drawable.ph_x, "Clear search", { onQuery("") }, tint = colors.muted)
    }
}

private const val MaxHits = 40
