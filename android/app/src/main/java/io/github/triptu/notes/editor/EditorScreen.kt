package io.github.triptu.notes.editor

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.draw.clip
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
import androidx.compose.foundation.ScrollState
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.positionInWindow
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

@OptIn(ExperimentalFoundationApi::class)
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

    val scroll = rememberScrollState()

    // Back closes the link popover before it closes the note.
    BackHandler(enabled = session.linkStart != null) { session.dismissLink() }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
    ) {
        TopBar(session, isPinned, onBack, onTogglePin)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // Keeps the line being typed above the floating mic.
            val margin = with(LocalDensity.current) { (MicSize + MicMargin * 2).toPx() }
            val keepClearOfMic = remember(margin) { KeepClearBringIntoView(margin) }
            CompositionLocalProvider(LocalBringIntoViewSpec provides keepClearOfMic) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(scroll)
                        .padding(horizontal = PagePadding),
                ) {
                    Title(session, onDone = { bodyFocus.requestFocus() })
                    if (session.loaded) Body(session, bodyFocus, onOpenLink, scroll)
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
            }
            if (speech != null) {
                FloatingMic(speech, Modifier.align(Alignment.BottomEnd).padding(end = MicMargin, bottom = MicMargin))
            }
        }
    }
}

private val MicSize = 56.dp
private val MicMargin = 16.dp

/** Scrolls just enough to show the cursor, keeping [bottomMargin] px clear at the bottom. */
@OptIn(ExperimentalFoundationApi::class)
private class KeepClearBringIntoView(private val bottomMargin: Float) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val visibleBottom = containerSize - bottomMargin
        return when {
            offset < 0f -> offset
            offset + size > visibleBottom -> minOf(offset, offset + size - visibleBottom)
            else -> 0f
        }
    }
}

/** The Home mic, floating: 56dp circle, solid ink. */
@Composable
private fun FloatingMic(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = NotesTheme.colors
    Box(
        modifier
            .size(MicSize)
            .clip(CircleShape)
            .background(colors.solid)
            .pressable(onClick, shape = CircleShape, bleed = 0.dp, label = "Speak", pressColor = colors.ink2),
        contentAlignment = Alignment.Center,
    ) {
        PhIcon(R.drawable.ph_microphone, "Speak", 24.dp, colors.onSolid)
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
        UndoButton(session)
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

/** Undo, with redo on long-press. Its slot is always there so the bar never shifts. */
@Composable
private fun UndoButton(session: EditorSession) {
    val colors = NotesTheme.colors
    val visible = session.canUndo || session.canRedo
    Box(
        Modifier
            .size(48.dp)
            .then(
                if (visible) {
                    Modifier.pressable(
                        onClick = session::undo,
                        onLongClick = session::redo,
                        shape = CircleShape,
                        bleed = 0.dp,
                        label = "Undo",
                    )
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (visible) {
            PhIcon(R.drawable.ph_arrow_u_up_left, "Undo, long-press to redo", 22.dp, if (session.canUndo) colors.ink2 else colors.muted)
        }
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
private fun Body(session: EditorSession, focus: FocusRequester, onOpenLink: (String) -> Unit, scroll: ScrollState) {
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

    var fieldTop by remember { mutableStateOf(0) }
    var fieldTopInContent by remember { mutableStateOf(0) }
    // Opened from a Recents card: scroll so that card's text sits near the top.
    val revealAt = session.revealAt
    val revealLayout = layout
    val revealMargin = with(density) { 96.dp.roundToPx() }
    LaunchedEffect(revealAt, revealLayout != null) {
        if (revealAt == null || revealLayout == null) return@LaunchedEffect
        val line = revealLayout.getLineForOffset(revealAt.coerceAtMost(revealLayout.layoutInput.text.length))
        scroll.scrollTo((fieldTopInContent + revealLayout.getLineTop(line).toInt() - revealMargin).coerceAtLeast(0))
        session.revealDone()
    }
    Box(
        Modifier.onGloballyPositioned {
            fieldTop = it.positionInWindow().y.toInt()
            fieldTopInContent = it.positionInParent().y.toInt()
        },
    ) {
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
            .onFocusChanged {
                focused = it.isFocused
                if (!it.isFocused) session.dismissLink()
            }
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
    val query = session.linkQuery
    val l = layout
    if (query != null && l != null && focused) LinkPopover(session, query, l, fieldTop)
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
