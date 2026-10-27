package io.github.triptu.notes.syncing

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.QuietButton
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.NotePath

/** The muted cloud-slash between Home's side labels while GitHub can't be reached. */
@Composable
fun OfflineMark(visible: Boolean) {
    if (!visible) return
    PhIcon(R.drawable.ph_cloud_slash, "Offline. Notes are saved on this phone.", 18.dp, NotesTheme.colors.muted)
}

/** Home's quiet lines about sync. Nothing at all while sync is fine. */
@Composable
fun SyncLines(
    notices: List<SyncNotice>,
    onFixToken: () -> Unit,
    onRetry: () -> Unit,
    onOpenNote: (NotePath) -> Unit,
    onDeletion: (keepThisPhone: Boolean) -> Unit,
) {
    if (notices.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        for (notice in notices) {
            when (notice) {
                is SyncNotice.Downloading -> Line(SyncCopy.downloading(notice.done, notice.total))
                is SyncNotice.NeedsToken -> Line(SyncCopy.AccessLine, onClick = onFixToken, chevron = true)
                is SyncNotice.NotSynced -> Line(SyncCopy.notSyncedFor(notice.hours), onClick = onRetry)
                is SyncNotice.Problem -> ProblemLine(notice.message, onRetry)
                is SyncNotice.Deletion -> DeletionLine(notice.decision, onDeletion)
                is SyncNotice.BothVersions -> BothVersionsLine(notice.notes, onOpenNote)
            }
        }
    }
}

@Composable
private fun Line(text: String, onClick: (() -> Unit)? = null, chevron: Boolean = false) {
    val colors = NotesTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .padding(horizontal = PagePadding - 10.dp)
            .then(if (onClick != null) Modifier.pressable(onClick, bleed = 10.dp, shape = RoundedCornerShape(12.dp), label = text) else Modifier.padding(horizontal = 10.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = NotesType.rowMeta, color = colors.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (chevron) {
            Spacer(Modifier.width(4.dp))
            PhIcon(R.drawable.ph_caret_right, null, 14.dp, colors.muted)
        }
    }
}

/** "Notes aren't syncing"; tapping shows the plain reason and "Try again". */
@Composable
private fun ProblemLine(message: String, onRetry: () -> Unit) {
    val colors = NotesTheme.colors
    var open by remember(message) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        Line(SyncCopy.NotSyncing, onClick = { open = !open }, chevron = !open)
        if (open) {
            Text(message, style = NotesType.rowMeta, color = colors.muted, modifier = Modifier.padding(horizontal = PagePadding))
            Box(Modifier.padding(start = PagePadding)) {
                QuietButton(SyncCopy.TryAgain, { open = false; onRetry() })
            }
        }
    }
}

@Composable
private fun DeletionLine(decision: DeletionDecision, onDeletion: (Boolean) -> Unit) {
    val choice = SyncCopy.deletion(decision.direction, decision.count)
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadding)) {
        Text(choice.text, style = NotesType.rowMeta, color = NotesTheme.colors.ink2, modifier = Modifier.padding(top = 10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            QuietButton(choice.keepSide, { onDeletion(true) })
            QuietButton(choice.otherSide, { onDeletion(false) })
        }
    }
}

/** "1 note has both versions" opens it; with several, a menu lists them. */
@Composable
private fun BothVersionsLine(notes: List<NotePath>, onOpenNote: (NotePath) -> Unit) {
    val colors = NotesTheme.colors
    var menu by remember { mutableStateOf(false) }
    Box {
        Line(SyncCopy.bothVersions(notes.size), onClick = { if (notes.size == 1) onOpenNote(notes[0]) else menu = true }, chevron = true)
        DropdownMenu(menu, { menu = false }, containerColor = colors.raised, shape = RoundedCornerShape(14.dp)) {
            for (path in notes) {
                DropdownMenuItem(
                    text = { Text(path.displayName, style = NotesType.row, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = { menu = false; onOpenNote(path) },
                )
            }
        }
    }
}
