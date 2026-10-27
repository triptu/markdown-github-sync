package io.github.triptu.notes.library

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.gestures.scrollBy
import dev.chrisbanes.haze.HazeInput
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.blur.HazeBlurStyle
import dev.chrisbanes.haze.blur.HazeColorEffect
import dev.chrisbanes.haze.blur.hazeBlur
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.HomeSide
import io.github.triptu.notes.ui.PageBar
import io.github.triptu.notes.ui.IconButton48
import io.github.triptu.notes.ui.ListRow
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.SearchHit

private val IndentPerLevel = 20.dp
private val SearchHeight = 48.dp
private val SearchGap = 8.dp
private val ChevronSlot = 20.dp
private const val ExpandMs = 150

/** Items above the tree rows in the list: the title and the search field. */
private const val HeaderItems = 1

@Composable
fun VaultScreen(
    rows: List<TreeRow>,
    scrollTo: FolderPath?,
    onScrolled: () -> Unit,
    query: String,
    results: List<SearchHit>,
    pins: List<Pin>,
    onQuery: (String) -> Unit,
    onHome: () -> Unit,
    onToggleFolder: (FolderPath) -> Unit,
    onOpenNote: (NotePath) -> Unit,
    onTogglePin: (Pin) -> Unit,
    onSettings: () -> Unit,
) {
    val colors = NotesTheme.colors
    // One list, so the search field keeps focus. The tree's scroll position is saved when a
    // search starts and restored when it's cleared.
    val state = rememberLazyListState()
    var treePosition by remember { mutableStateOf(0 to 0) }
    val searching = query.isNotBlank()
    val search: (String) -> Unit = { next ->
        if (!searching && next.isNotBlank()) treePosition = state.firstVisibleItemIndex to state.firstVisibleItemScrollOffset
        onQuery(next)
    }
    LaunchedEffect(searching) {
        if (!searching) state.scrollToItem(treePosition.first, treePosition.second)
    }
    val pillSpace = with(LocalDensity.current) { (SearchHeight + SearchGap).toPx() }
    LaunchedEffect(scrollTo, rows) {
        val target = scrollTo ?: return@LaunchedEffect
        val index = rows.indexOfFirst { it is TreeRow.Folder && it.path == target }
        if (index < 0) return@LaunchedEffect
        state.scrollToItem(index + HeaderItems)
        state.scrollBy(-pillSpace) // Keep the folder clear of the floating search pill.
        onScrolled()
    }

    val haze = rememberHazeState()
    Column(Modifier.fillMaxSize()) {
        PageBar("Vault", HomeSide.End, onHome) {
            IconButton48(R.drawable.ph_gear_six, "Settings", onSettings, tint = colors.muted)
        }
        Box(Modifier.fillMaxSize()) {
            LazyColumn(state = state, modifier = Modifier.fillMaxSize().hazeSource(haze)) {
                // Room for the search pill, which floats over the list.
                item(key = "searchSpace") { Spacer(Modifier.height(SearchHeight + SearchGap)) }
                if (searching) {
                    results(results, pins, query, onOpenNote, onTogglePin)
                } else {
                    tree(rows, pins, onToggleFolder, onOpenNote, onTogglePin)
                }
                item(key = "end") { Box(Modifier.height(24.dp)) }
            }
            // Pinned under the bar; the list scrolls beneath it.
            SearchField(query, search, haze)
        }
    }
}

private fun LazyListScope.tree(
    rows: List<TreeRow>,
    pins: List<Pin>,
    onToggleFolder: (FolderPath) -> Unit,
    onOpenNote: (NotePath) -> Unit,
    onTogglePin: (Pin) -> Unit,
) {
    if (rows.isEmpty()) {
        item(key = "empty") {
            Text(
                "No notes yet. Write one from Home.", style = NotesType.row, color = NotesTheme.colors.muted,
                modifier = Modifier.padding(horizontal = PagePadding, vertical = 16.dp),
            )
        }
    }
    items(rows, key = { it.key }) { row ->
        val itemModifier = Modifier.animateItem(
            fadeInSpec = tween(ExpandMs),
            placementSpec = tween(ExpandMs),
            fadeOutSpec = tween(ExpandMs / 2),
        )
        when (row) {
            is TreeRow.Folder -> {
                val pin = Pin.Folder(row.path)
                TreeItem(
                    depth = row.depth, folderExpanded = row.expanded, icon = R.drawable.ph_folder_simple,
                    text = row.path.name, pinned = pin in pins,
                    onClick = { onToggleFolder(row.path) }, onLongClick = { onTogglePin(pin) }, modifier = itemModifier,
                )
            }
            is TreeRow.Note -> {
                val pin = Pin.Note(row.path)
                TreeItem(
                    depth = row.depth, folderExpanded = null, icon = R.drawable.ph_file_text,
                    text = row.path.displayName, pinned = pin in pins,
                    onClick = { onOpenNote(row.path) }, onLongClick = { onTogglePin(pin) }, modifier = itemModifier,
                )
            }
        }
    }
}

private fun LazyListScope.results(
    results: List<SearchHit>,
    pins: List<Pin>,
    query: String,
    onOpenNote: (NotePath) -> Unit,
    onTogglePin: (Pin) -> Unit,
) {
    if (results.isEmpty()) {
        item(key = "none") {
            Text(
                "No notes match “${query.trim()}”.", style = NotesType.row, color = NotesTheme.colors.muted,
                modifier = Modifier.padding(horizontal = PagePadding, vertical = 16.dp),
            )
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
}

/** A tree row. [folderExpanded] is null for notes, which keep the chevron's space so icons line up per level. */
@Composable
private fun TreeItem(
    depth: Int,
    folderExpanded: Boolean?,
    icon: Int,
    text: String,
    pinned: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = NotesTheme.colors
    val turn by animateFloatAsState(if (folderExpanded == true) 90f else 0f, tween(ExpandMs), label = "chevron")
    Row(
        modifier
            .fillMaxWidth()
            .height(52.dp)
            .padding(horizontal = PagePadding - 12.dp)
            .pressable(onClick, onLongClick, bleed = 12.dp, label = if (folderExpanded == null) "Open $text" else if (folderExpanded) "Close $text" else "Open folder $text"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.width(IndentPerLevel * depth))
        Box(Modifier.width(ChevronSlot), contentAlignment = Alignment.CenterStart) {
            if (folderExpanded != null) PhIcon(R.drawable.ph_caret_right, null, 14.dp, colors.muted, Modifier.rotate(turn))
        }
        PhIcon(icon, null, 22.dp, colors.ink2)
        Spacer(Modifier.width(14.dp))
        Text(text, style = NotesType.row, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (pinned) Box(Modifier.padding(start = 12.dp)) { PhIcon(R.drawable.ph_push_pin, "Pinned", 18.dp, colors.muted) }
    }
}

/** The search pill: a blurred, tinted view of the list behind it. */
@Composable
private fun SearchField(query: String, onQuery: (String) -> Unit, haze: HazeState, modifier: Modifier = Modifier) {
    val colors = NotesTheme.colors
    val dark = isSystemInDarkTheme()
    val shape = RoundedCornerShape(24.dp)
    val blur = remember(colors) {
        HazeBlurStyle {
            blurRadius(24.dp)
            backgroundColor(colors.bg)
            colorEffects(listOf(HazeColorEffect.tint(colors.raised.copy(alpha = 0.82f))))
            noiseFactor(0f)
        }
    }
    Row(
        modifier
            .padding(horizontal = PagePadding)
            .fillMaxWidth()
            .height(SearchHeight)
            .clip(shape)
            .hazeBlur(HazeInput.Sources(haze), blur)
            .then(if (dark) Modifier.border(1.dp, Color.White.copy(alpha = 0.07f), shape) else Modifier)
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
        else Spacer(Modifier.size(0.dp))
    }
}
