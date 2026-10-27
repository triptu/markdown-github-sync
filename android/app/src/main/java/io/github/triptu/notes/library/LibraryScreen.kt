package io.github.triptu.notes.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.HintsRow
import io.github.triptu.notes.ui.IconButton48
import io.github.triptu.notes.ui.ListRow
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderContents
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.SearchHit

@Composable
fun LibraryScreen(
    location: LibraryLocation,
    contents: FolderContents,
    query: String,
    results: List<SearchHit>,
    pins: List<Pin>,
    onQuery: (String) -> Unit,
    onUp: () -> Unit,
    onHome: () -> Unit,
    onOpenFolder: (FolderPath) -> Unit,
    onOpenNote: (NotePath) -> Unit,
    onTogglePin: (Pin) -> Unit,
    onSettings: () -> Unit,
) {
    val colors = NotesTheme.colors
    val folder = location.folder
    val backLabel = when {
        folder.isRoot -> null
        location.fromPin -> "Home"
        else -> folder.parent?.takeUnless { it.isRoot }?.name ?: "Library"
    }
    Column(Modifier.fillMaxSize()) {
        HintsRow(left = backLabel, right = if (location.fromPin) null else "Home", onLeft = onUp, onRight = onHome)
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            item(key = "title") {
                Row(Modifier.fillMaxWidth().padding(start = PagePadding, end = PagePadding - 12.dp, top = 6.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (folder.isRoot) "Library" else folder.name,
                        style = NotesType.title, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (folder.isRoot) IconButton48(R.drawable.ph_gear_six, "Settings", onSettings, tint = colors.muted)
                }
            }
            item(key = "search") { SearchField(query, onQuery) }
            if (query.isNotBlank()) {
                if (results.isEmpty()) {
                    item(key = "none") {
                        Text("No notes match “${query.trim()}”.", style = NotesType.row, color = colors.muted, modifier = Modifier.padding(horizontal = PagePadding, vertical = 16.dp))
                    }
                }
                items(results, key = { "hit:" + it.path.value }) { hit ->
                    ListRow(
                        icon = R.drawable.ph_file_text,
                        text = hit.path.displayName,
                        subtitle = hit.excerpt.ifBlank { hit.path.folder.value.ifEmpty { null } },
                        highlight = query,
                        onClick = { onOpenNote(hit.path) },
                        onLongClick = { onTogglePin(Pin.Note(hit.path)) },
                        trailing = if (Pin.Note(hit.path) in pins) R.drawable.ph_push_pin else null,
                        trailingDescription = "Pinned",
                        height = 64.dp,
                    )
                }
            } else {
                if (contents.folders.isEmpty() && contents.notes.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            if (folder.isRoot) "No notes yet. Write one from Home." else "This folder is empty.",
                            style = NotesType.row, color = colors.muted,
                            modifier = Modifier.padding(horizontal = PagePadding, vertical = 16.dp),
                        )
                    }
                }
                items(contents.folders, key = { "folder:" + it.value }) { sub ->
                    val pin = Pin.Folder(sub)
                    ListRow(
                        icon = R.drawable.ph_folder_simple,
                        text = sub.name,
                        onClick = { onOpenFolder(sub) },
                        onLongClick = { onTogglePin(pin) },
                        trailing = if (pin in pins) R.drawable.ph_push_pin else null,
                        trailingDescription = "Pinned",
                    )
                }
                items(contents.notes, key = { "note:" + it.value }) { note ->
                    val pin = Pin.Note(note)
                    ListRow(
                        icon = R.drawable.ph_file_text,
                        text = note.displayName,
                        onClick = { onOpenNote(note) },
                        onLongClick = { onTogglePin(pin) },
                        trailing = if (pin in pins) R.drawable.ph_push_pin else null,
                        trailingDescription = "Pinned",
                    )
                }
            }
            item(key = "end") { Box(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun SearchField(query: String, onQuery: (String) -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier
            .padding(horizontal = PagePadding)
            .padding(bottom = 8.dp)
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(colors.raised)
            .padding(start = 18.dp, end = 4.dp),
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
                    if (query.isEmpty()) Text("Search notes", style = NotesType.field, color = colors.muted)
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) IconButton48(R.drawable.ph_x, "Clear search", { onQuery("") }, tint = colors.muted)
    }
}
