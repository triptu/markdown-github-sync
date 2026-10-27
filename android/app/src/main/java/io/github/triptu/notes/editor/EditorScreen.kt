package io.github.triptu.notes.editor

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.text.rememberTextMeasurer
import io.github.triptu.notes.R
import io.github.triptu.notes.capture.CaptureDestination
import io.github.triptu.notes.ui.IconButton48
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.TaskBoxSize
import io.github.triptu.notes.ui.drawTaskBox
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import kotlinx.coroutines.launch

@Composable
fun EditorScreen(
    session: EditorSession,
    isPinned: Boolean,
    onBack: () -> Unit,
    onTogglePin: () -> Unit,
    onOpenLink: (String) -> Unit,
) {
    val colors = NotesTheme.colors
    val bodyFocus = remember { FocusRequester() }
    val speech = rememberSpeechInput { spoken -> session.onValueChange(EditOps.insertText(session.value, spoken), newUndoStep = true) }

    LaunchedEffect(session) {
        val capture = session.target as? EditorTarget.Capture ?: return@LaunchedEffect
        bodyFocus.requestFocus()
        if (capture.voice) speech?.invoke()
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
    ) {
        TopBar(session, isPinned, onBack, onTogglePin)
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = PagePadding),
        ) {
            Title(session, onDone = { bodyFocus.requestFocus() })
            if (session.loaded) Body(session, bodyFocus, onOpenLink)
            // Tapping the empty space under the text puts the cursor at the end.
            Spacer(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 240.dp)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                        session.onValueChange(session.value.copy(selection = TextRange(session.value.text.length)))
                        bodyFocus.requestFocus()
                    },
            )
        }
        val query = EditOps.linkQuery(session.value)
        if (query != null) LinkSuggestions(session, query)
        Toolbar(session, speech)
    }
}

@Composable
private fun TopBar(session: EditorSession, isPinned: Boolean, onBack: () -> Unit, onTogglePin: () -> Unit) {
    val colors = NotesTheme.colors
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().height(48.dp).padding(horizontal = PagePadding - 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton48(R.drawable.ph_arrow_left, "Back", onBack)
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            val destination = session.destination
            if (destination != null) {
                DestinationChip(destination, session::switchDestination)
            } else {
                Text(
                    session.path?.folder?.value.orEmpty(),
                    style = NotesType.path, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Box {
            IconButton48(R.drawable.ph_dots_three_vertical, "More", { menu = true })
            DropdownMenu(menu, { menu = false }, containerColor = colors.raised, shape = RoundedCornerShape(14.dp)) {
                if (!session.isCapture) {
                    MenuItem(if (isPinned) "Unpin from Home" else "Pin to Home", R.drawable.ph_push_pin) { menu = false; onTogglePin() }
                }
                MenuItem(if (session.destination == CaptureDestination.ThisWeek) "Discard" else "Delete note", R.drawable.ph_trash) {
                    menu = false
                    confirmDelete = true
                }
            }
        }
    }
    if (confirmDelete) {
        val discard = session.destination == CaptureDestination.ThisWeek
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = colors.bg,
            title = { Text(if (discard) "Discard this entry?" else "Delete “${session.title}”?", style = NotesType.row.copy(fontWeight = FontWeight.SemiBold), color = colors.ink) },
            text = {
                Text(
                    if (discard) "It will be removed from this week's note." else "The note is deleted from this phone's vault.",
                    style = NotesType.rowMeta, color = colors.ink2,
                )
            },
            confirmButton = {
                TextButton({ confirmDelete = false; session.delete(onBack) }) { Text(if (discard) "Discard" else "Delete", color = colors.ink) }
            },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("Keep", color = colors.ink2) } },
        )
    }
}

@Composable
private fun MenuItem(label: String, icon: Int, onClick: () -> Unit) {
    val colors = NotesTheme.colors
    DropdownMenuItem(
        text = { Text(label, style = NotesType.row, color = colors.ink) },
        leadingIcon = { PhIcon(icon, null, 20.dp, colors.ink2) },
        onClick = onClick,
    )
}

/** Where a new capture goes. Tapping it offers the other destination. */
@Composable
private fun DestinationChip(destination: CaptureDestination, onPick: (CaptureDestination) -> Unit) {
    val colors = NotesTheme.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .height(48.dp)
                .pressable({ open = true }, shape = RoundedCornerShape(24.dp), bleed = 14.dp, label = "Change where this saves"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text("Saves to ${destination.label}", style = NotesType.path, color = colors.ink2)
            PhIcon(R.drawable.ph_caret_down, null, 14.dp, colors.ink2)
        }
        DropdownMenu(open, { open = false }, containerColor = colors.raised, shape = RoundedCornerShape(14.dp)) {
            for (d in CaptureDestination.entries) {
                DropdownMenuItem(
                    text = {
                        val current = d == destination
                        Text(d.label, style = NotesType.row.copy(fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal), color = colors.ink)
                    },
                    leadingIcon = { PhIcon(if (d == CaptureDestination.NewNote) R.drawable.ph_file_text else R.drawable.ph_calendar_blank, null, 20.dp, colors.ink2) },
                    onClick = { open = false; onPick(d) },
                )
            }
        }
    }
}

val CaptureDestination.label: String
    get() = when (this) {
        CaptureDestination.NewNote -> "New note"
        CaptureDestination.ThisWeek -> "This week"
    }

@Composable
private fun Title(session: EditorSession, onDone: () -> Unit) {
    val colors = NotesTheme.colors
    val style = NotesType.noteTitle
    val modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 14.dp)
    if (session.isCapture) {
        val saved = session.path != null || session.destination == CaptureDestination.ThisWeek
        Text(session.title, style = style, color = if (saved) colors.ink else colors.muted, modifier = modifier)
        return
    }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var editing by remember(session.path) { mutableStateOf(TextFieldValue(session.title)) }
    var focused by remember { mutableStateOf(false) }
    fun commit() {
        scope.launch {
            if (!session.rename(editing.text)) editing = TextFieldValue(session.title)
        }
    }
    BasicTextField(
        value = editing,
        onValueChange = { editing = it.copy(text = it.text.replace("\n", "")) },
        textStyle = style.copy(color = colors.ink),
        cursorBrush = SolidColor(colors.ink),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
        keyboardActions = KeyboardActions(onNext = { focus.clearFocus(); onDone() }),
        modifier = modifier.onFocusChanged {
            if (focused && !it.isFocused) commit()
            focused = it.isFocused
        },
    )
}

@Composable
private fun Body(session: EditorSession, focus: FocusRequester, onOpenLink: (String) -> Unit) {
    val colors = NotesTheme.colors
    val density = LocalDensity.current
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var focused by remember { mutableStateOf(false) }
    val current by rememberUpdatedState(session.value)
    val parsed by rememberUpdatedState(session.parsed)
    val openLink by rememberUpdatedState(onOpenLink)
    val boxSide = with(density) { TaskBoxSize.toPx() }
    val slop = with(density) { 14.dp.toPx() }
    val xHeightCenter = with(density) { 6.sp.toPx() }
    val measurer = rememberTextMeasurer()
    val indentOf = remember(measurer, density) {
        val cache = HashMap<String, TextUnit>()
        val style = NotesType.noteBody
        val measure: (String) -> TextUnit = { prefix ->
            cache.getOrPut(prefix) { with(density) { measurer.measure(prefix, style).size.width.toSp() } }
        }
        measure
    }

    fun boxTopLeft(l: TextLayoutResult, task: TaskMark): Offset {
        val line = l.getLineForOffset(task.markerStart)
        val x = l.getHorizontalPosition(task.markerStart, usePrimaryDirection = true)
        // Centre on the lowercase letters, which sit just above the baseline.
        val centerY = l.getLineBaseline(line) - xHeightCenter
        return Offset(x, centerY - boxSide / 2f)
    }

    fun revealed(task: TaskMark) = focused && current.selection.min <= task.markerEnd - 1 && current.selection.max >= task.markerStart

    BasicTextField(
        value = session.value,
        onValueChange = { session.onValueChange(it) },
        textStyle = NotesType.noteBody.copy(color = colors.ink),
        cursorBrush = SolidColor(colors.ink),
        visualTransformation = LivePreview(session.parsed, session.value.selection, focused, colors, indentOf),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        onTextLayout = { layout = it },
        modifier = Modifier
            .fillMaxWidth()
            .focusRequester(focus)
            .onFocusChanged { focused = it.isFocused }
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    val l = layout ?: return@awaitEachGesture
                    val p = down.position
                    val task = parsed.tasks.firstOrNull { t ->
                        if (revealed(t)) return@firstOrNull false
                        val tl = boxTopLeft(l, t)
                        p.x in (tl.x - slop)..(tl.x + boxSide + slop) && p.y in (tl.y - slop)..(tl.y + boxSide + slop)
                    }
                    val offset = l.getOffsetForPosition(p)
                    val link = if (task == null) parsed.links.firstOrNull { k ->
                        offset in k.labelStart until k.labelEnd && !(focused && current.selection.min <= k.end && current.selection.max >= k.start)
                    } else null
                    if (task == null && link == null) return@awaitEachGesture
                    down.consume()
                    val up = waitForUpOrCancellation(PointerEventPass.Initial) ?: return@awaitEachGesture
                    up.consume()
                    when {
                        task != null -> session.toggleTask(task)
                        link != null -> openLink(link.target)
                    }
                }
            }
            .drawWithContent {
                drawContent()
                val l = layout ?: return@drawWithContent
                for (task in parsed.tasks) {
                    if (task.markerStart >= l.layoutInput.text.length || revealed(task)) continue
                    drawTaskBox(boxTopLeft(l, task), task.checked, colors)
                }
            },
    )
}

@Composable
private fun LinkSuggestions(session: EditorSession, query: LinkQuery) {
    val colors = NotesTheme.colors
    val suggestions = remember(query.query, session.path) { session.linkSuggestions(query) }
    val showCreate = query.query.isNotBlank() && suggestions.none { it.name.equals(query.query.trim(), ignoreCase = true) }
    if (suggestions.isEmpty() && !showCreate) return
    Column(Modifier.fillMaxWidth().background(colors.raised).padding(vertical = 4.dp)) {
        for (path in suggestions) {
            SuggestionRow(path.displayName, path.folder.value.ifEmpty { null }) {
                session.onValueChange(EditOps.completeLink(session.value, query, path.name), newUndoStep = true)
            }
        }
        if (showCreate) {
            SuggestionRow("Link to new note “${query.query.trim()}”", null) {
                session.onValueChange(EditOps.completeLink(session.value, query, query.query.trim()), newUndoStep = true)
            }
        }
    }
}

@Composable
private fun SuggestionRow(name: String, folder: String?, onClick: () -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier.fillMaxWidth().height(48.dp).padding(horizontal = PagePadding - 12.dp).pressable(onClick, pressColor = colors.sunk),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, style = NotesType.row, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (folder != null) {
            Spacer(Modifier.width(10.dp))
            Text(folder, style = NotesType.rowMeta, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun Toolbar(session: EditorSession, speech: (() -> Unit)?) {
    Row(
        Modifier.fillMaxWidth().height(48.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton48(R.drawable.ph_check_square, "Checkbox", { session.onValueChange(EditOps.toggleTaskLine(session.value), newUndoStep = true) })
        IconButton48(R.drawable.ph_brackets_square, "Link to a note", { session.onValueChange(EditOps.insertLink(session.value), newUndoStep = true) })
        IconButton48(R.drawable.ph_text_h, "Heading", { session.onValueChange(EditOps.cycleHeading(session.value), newUndoStep = true) })
        if (speech != null) IconButton48(R.drawable.ph_microphone, "Speak", speech)
        IconButton48(R.drawable.ph_arrow_u_up_left, "Undo", session::undo, enabled = session.canUndo)
    }
}

/** Android's speech input, if the phone has it. Returns null when it doesn't. */
@Composable
private fun rememberSpeechInput(onText: (String) -> Unit): (() -> Unit)? {
    val context = LocalContext.current
    val intent = remember {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    }
    val available = remember { intent.resolveActivity(context.packageManager) != null }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let(onText)
    }
    return if (available) ({ launcher.launch(intent) }) else null
}
