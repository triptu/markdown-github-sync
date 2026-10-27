package io.github.triptu.notes.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
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

/** Past this many pins, rows get a little tighter, as in the mockup. */
private const val CompactPinCount = 6

@Composable
fun HomeScreen(
    pins: List<Pin>,
    weeklyFolder: FolderPath,
    onLibrary: () -> Unit,
    onRecents: () -> Unit,
    onPin: (Pin) -> Unit,
    onUnpin: (Pin) -> Unit,
    onCompose: () -> Unit,
    onVoice: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        HintsRow(left = "Library", right = "Recents", onLeft = onLibrary, onRight = onRecents)
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val compact = pins.size > CompactPinCount
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(vertical = 8.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                if (pins.isEmpty()) {
                    Text(
                        "Long-press a note or folder in Library to pin it here.",
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
                                text = { Text("Unpin", style = NotesType.row, color = NotesTheme.colors.ink) },
                                leadingIcon = { PhIcon(R.drawable.ph_push_pin, null, 20.dp, NotesTheme.colors.ink2) },
                                onClick = { menu = false; onUnpin(pin) },
                            )
                        }
                    }
                }
            }
        }
        Composer(onCompose, onVoice)
    }
}

private val Pin.label: String
    get() = when (this) {
        is Pin.Note -> path.displayName
        is Pin.Folder -> path.name
        Pin.ThisWeek -> "This week"
    }

/** The "New note" pill with the round mic button. */
@Composable
private fun Composer(onCompose: () -> Unit, onVoice: () -> Unit) {
    val colors = NotesTheme.colors
    Row(
        Modifier
            .padding(start = 16.dp, end = 16.dp, bottom = 8.dp)
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(colors.raised)
            .pressable(onCompose, shape = RoundedCornerShape(28.dp), bleed = 0.dp, label = "New note", pressColor = colors.sunk)
            .padding(start = 22.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("New note", style = NotesType.row, color = colors.muted, modifier = Modifier.weight(1f))
        Box(
            Modifier.size(48.dp).clip(CircleShape).background(colors.solid).pressable(onVoice, shape = CircleShape, bleed = 0.dp, label = "Speak a note", pressColor = colors.ink2),
            contentAlignment = Alignment.Center,
        ) {
            PhIcon(R.drawable.ph_microphone, "Speak a note", 22.dp, colors.onSolid)
        }
    }
}
