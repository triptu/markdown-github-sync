package io.github.triptu.notes.quick

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.triptu.notes.R
import io.github.triptu.notes.graph
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.ListRow
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderPath
import kotlinx.coroutines.launch
import java.time.LocalDateTime

/**
 * The share sheet's target for text and links. Shows what was shared and saves it as a new note,
 * or adds it to the end of a picked note. Closes quietly once saved.
 */
class ShareActivity : ComponentActivity() {
    private var picking by mutableStateOf(false)
    private var failed by mutableStateOf(false)
    private var saving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val shared = intent.takeIf { it.action == Intent.ACTION_SEND }?.let {
            SharedText.of(it.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(), it.getStringExtra(Intent.EXTRA_SUBJECT) ?: it.getStringExtra(Intent.EXTRA_TITLE))
        } ?: return finish()
        val graph = graph
        setContent {
            val pins by graph.settings.pins.collectAsStateWithLifecycle()
            val snapshot by graph.index.snapshot.collectAsStateWithLifecycle()
            val capture by graph.settings.capture.collectAsStateWithLifecycle()
            NotesTheme {
                BackHandler(enabled = picking) { picking = false }
                BottomSheet(onDismiss = ::finish) {
                    Text(
                        shared.body, style = NotesType.row, color = NotesTheme.colors.ink2, maxLines = 5, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .padding(horizontal = PagePadding, vertical = 8.dp)
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(NotesTheme.colors.raised)
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                    )
                    if (failed) {
                        Text(QuickCopy.CouldNotSave, style = NotesType.rowMeta, color = NotesTheme.colors.rec, modifier = Modifier.padding(horizontal = PagePadding, vertical = 4.dp))
                    }
                    if (picking) {
                        SheetLabel(QuickCopy.AddToNote.removeSuffix("…"))
                        NotePicker(pins, snapshot, FolderPath(capture.weeklyFolder.trim('/'))) { addTo(it, shared) }
                    } else {
                        ListRow(R.drawable.ph_note_pencil, QuickCopy.NewNote, { newNote(shared) }, height = 52.dp)
                        ListRow(R.drawable.ph_file_text, QuickCopy.AddToNote, { picking = true }, height = 52.dp)
                    }
                }
            }
        }
    }

    private fun newNote(shared: SharedText) = save { graph.capture.createNote(shared.noteName(LocalDateTime.now()), shared.body + "\n") }

    private fun addTo(pin: Pin, shared: SharedText) = save {
        val path = when (pin) {
            is Pin.Note -> pin.path
            else -> graph.capture.ensureWeekly(LocalDateTime.now())
        }
        graph.store.update(path) { SharedText.append(it, shared.body) }
    }

    /** Saves on the app's scope, so leaving the sheet can't cut a write short, then closes. */
    private fun save(write: suspend () -> Unit) {
        if (saving) return
        saving = true
        failed = false
        graph.mainScope.launch {
            val ok = runCatching { write() }.isSuccess
            saving = false
            if (ok) finish() else failed = true
        }
    }
}
