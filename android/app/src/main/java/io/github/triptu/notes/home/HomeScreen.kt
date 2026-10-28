package io.github.triptu.notes.home

import androidx.compose.foundation.background
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.DpOffset
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.QuietButton
import io.github.triptu.notes.ui.ReadingColumn
import io.github.triptu.notes.voice.VoiceCopy
import io.github.triptu.notes.voice.VoiceDraft
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.HintsRow
import io.github.triptu.notes.ui.ListRow
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.syncing.OfflineMark
import io.github.triptu.notes.syncing.SyncBar
import io.github.triptu.notes.syncing.SyncLines

/** Past this many pins, rows get a little tighter, as in the mockup. */
private const val CompactPinCount = 6

@Composable
fun HomeScreen(
    pins: List<Pin>,
    weeklyFolder: FolderPath,
    onVault: () -> Unit,
    onRecents: () -> Unit,
    onPin: (Pin) -> Unit,
    onUnpin: (Pin) -> Unit,
    onCompose: () -> Unit,
    onVoice: () -> Unit,
    syncBar: SyncBar = SyncBar.Quiet,
    onFixToken: () -> Unit = {},
    onRetrySync: () -> Unit = {},
    onOpenBothVersions: (NotePath) -> Unit = {},
    onDeletion: (Boolean) -> Unit = {},
    voiceDraft: VoiceDraft? = null,
    onKeepDraft: () -> Unit = {},
    onDiscardDraft: () -> Unit = {},
    resurfaced: Resurfaced? = null,
    onResurfaced: (NotePath) -> Unit = {},
    onPutAway: () -> Unit = {},
) {
    ReadingColumn {
        HintsRow(left = "Vault", right = "Recents", onLeft = onVault, onRight = onRecents) { OfflineMark(syncBar.offline) }
        // Pins are centred on the space between the side labels and the composer, which never changes
        // size. Sync lines, the old note and an unsaved recording lie over its edges, so pins move only
        // when one of them would cover a pin.
        var aboveHeight by remember { mutableIntStateOf(0) }
        var belowHeight by remember { mutableIntStateOf(0) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Pins(pins, weeklyFolder, onPin, onUnpin, clearTop = aboveHeight, clearBottom = belowHeight)
            Box(Modifier.fillMaxWidth().background(NotesTheme.colors.bg).onSizeChanged { aboveHeight = it.height }) {
                SyncLines(syncBar.notices, onFixToken, onRetrySync, onOpenBothVersions, onDeletion)
            }
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(NotesTheme.colors.bg).onSizeChanged { belowHeight = it.height },
            ) {
                Slot(resurfaced) { ResurfaceLine(it, onResurfaced, onPutAway) }
                Slot(voiceDraft) { DraftLine(it, onKeepDraft, onDiscardDraft) }
            }
        }
        Composer(onCompose, onVoice)
    }
}

/** Shows [content] for [value], and keeps the last value on screen while it fades out. */
@Composable
private fun <T : Any> ColumnScope.Slot(value: T?, content: @Composable (T) -> Unit) {
    var last by remember { mutableStateOf(value) }
    if (value != null) last = value
    AnimatedVisibility(
        visible = value != null,
        enter = fadeIn(tween(160)) + expandVertically(tween(200), expandFrom = Alignment.Top),
        exit = fadeOut(tween(120)) + shrinkVertically(tween(200), shrinkTowards = Alignment.Top),
    ) {
        last?.let { content(it) }
    }
}

@Composable
private fun Pins(
    pins: List<Pin>,
    weeklyFolder: FolderPath,
    onPin: (Pin) -> Unit,
    onUnpin: (Pin) -> Unit,
    clearTop: Int,
    clearBottom: Int,
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact = pins.size > CompactPinCount
        val viewport = constraints.maxHeight
        val gap = with(LocalDensity.current) { PinsGap.roundToPx() }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Column(
                Modifier.fillMaxWidth().layout { measurable, constraints ->
                    val list = measurable.measure(constraints)
                    val top = clearTop + gap
                    val bottom = clearBottom + gap
                    val height = maxOf(viewport, top + list.height + bottom)
                    val y = ((viewport - list.height) / 2).coerceIn(top, height - bottom - list.height)
                    layout(list.width, height) { list.place(0, y) }
                },
            ) {
                if (pins.isEmpty()) {
                    Text(
                        HomeCopy.NoPins,
                        style = NotesType.row,
                        color = NotesTheme.colors.muted,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 40.dp),
                    )
                }
                for (pin in pins) {
                    // Long-press offers Unpin; the row stays highlighted while the menu is open.
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        ListRow(
                            icon = PinIcons.of(pin, weeklyFolder),
                            text = pin.label,
                            onClick = { onPin(pin) },
                            onLongClick = { menu = true },
                            height = if (compact) 54.dp else 60.dp,
                            textStyle = if (compact) NotesType.pinCompact else NotesType.pin,
                            iconTint = NotesTheme.colors.muted,
                            gap = 18.dp,
                            selected = menu,
                        )
                        DropdownMenu(
                            menu, { menu = false },
                            offset = DpOffset(PagePadding, 0.dp),
                            containerColor = NotesTheme.colors.raised,
                            shape = RoundedCornerShape(14.dp),
                        ) {
                            DropdownMenuItem(
                                text = { Text(HomeCopy.Unpin, style = NotesType.row, color = NotesTheme.colors.ink) },
                                leadingIcon = { PhIcon(R.drawable.ph_push_pin, null, 20.dp, NotesTheme.colors.ink2) },
                                onClick = { menu = false; onUnpin(pin) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Space kept between the pins and the lines lying over the edges of their area. */
private val PinsGap = 8.dp

private val Pin.label: String
    get() = when (this) {
        is Pin.Note -> path.displayName
        is Pin.Folder -> path.name
        Pin.ThisWeek -> "This week"
    }

/**
 * One old note above the composer: "A year ago", its title, and its first line. Long-press offers
 * Not today.
 */
@Composable
private fun ResurfaceLine(note: Resurfaced, onOpen: (NotePath) -> Unit, onPutAway: () -> Unit) {
    val colors = NotesTheme.colors
    var menu by remember { mutableStateOf(false) }
    Box(Modifier.padding(bottom = 8.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp)
                .pressable({ onOpen(note.path) }, { menu = true }, bleed = PagePadding - 8.dp, label = "Open ${note.path.displayName}", pressColor = colors.raised, selected = menu)
                .padding(vertical = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            PhIcon(R.drawable.ph_clock_counter_clockwise, null, 20.dp, colors.muted, Modifier.padding(top = 1.dp))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row {
                    Text(
                        note.path.displayName, style = NotesType.rowMeta.copy(fontWeight = FontWeight.Medium), color = colors.ink2,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).alignByBaseline(),
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(HomeCopy.ago(note.ago), style = NotesType.rowMeta, color = colors.muted, maxLines = 1, modifier = Modifier.alignByBaseline())
                }
                if (note.text.isNotEmpty()) {
                    Text(note.text, style = NotesType.rowMeta, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                }
            }
        }
        DropdownMenu(
            menu, { menu = false },
            offset = DpOffset(PagePadding, 0.dp),
            containerColor = colors.raised,
            shape = RoundedCornerShape(14.dp),
        ) {
            DropdownMenuItem(
                text = { Text(HomeCopy.NotToday, style = NotesType.row, color = colors.ink) },
                leadingIcon = { PhIcon(R.drawable.ph_x, null, 20.dp, colors.ink2) },
                onClick = { menu = false; onPutAway() },
            )
        }
    }
}

/** "Unsaved recording, 0:42" with Keep and Discard, above the composer. */
@Composable
private fun DraftLine(draft: VoiceDraft, onKeep: () -> Unit, onDiscard: () -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = PagePadding, end = PagePadding - 10.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Lines up with the old note's clock icon and text above it.
        PhIcon(R.drawable.ph_microphone, null, 20.dp, colors.muted)
        Spacer(Modifier.width(14.dp))
        Text(VoiceCopy.unsaved(draft.elapsedMs), style = NotesType.rowMeta, color = colors.ink2, modifier = Modifier.weight(1f))
        QuietButton(VoiceCopy.Keep, onKeep)
        Spacer(Modifier.width(4.dp))
        QuietButton(VoiceCopy.Discard, onDiscard, color = colors.ink2)
    }
}

/** The "New note" pill with the round mic button. The home-screen widget draws the same bar. */
@Composable
private fun Composer(onCompose: () -> Unit, onVoice: () -> Unit) {
    val colors = NotesTheme.colors
    val pill = RoundedCornerShape(ComposerHeight / 2)
    Row(
        Modifier
            .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)
            .fillMaxWidth()
            .height(ComposerHeight)
            .clip(pill)
            .background(colors.raised)
            .pressable(onCompose, shape = pill, bleed = 0.dp, label = HomeCopy.NewNote, pressColor = colors.sunk)
            .padding(start = (ComposerHeight - ComposerIcon) / 2, end = MicInset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PhIcon(R.drawable.ph_note_pencil, null, ComposerIcon, colors.ink2)
        Spacer(Modifier.width(12.dp))
        Text(HomeCopy.NewNote, style = NotesType.row, color = colors.muted, modifier = Modifier.weight(1f))
        Box(
            Modifier.size(ComposerHeight - MicInset * 2).clip(CircleShape).background(colors.solid).pressable(onVoice, shape = CircleShape, bleed = 0.dp, label = HomeCopy.SpeakNote, pressColor = colors.ink2),
            contentAlignment = Alignment.Center,
        ) {
            PhIcon(R.drawable.ph_microphone, HomeCopy.SpeakNote, ComposerIcon, colors.onSolid)
        }
    }
}

private val ComposerHeight = 56.dp
private val ComposerIcon = 22.dp
/** The mic's gap to the pill's top, bottom and end. */
private val MicInset = 6.dp
