package io.github.triptu.notes.quick

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import io.github.triptu.notes.graph
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.vault.FolderPath
import kotlinx.coroutines.launch

/** Picks the note a pinned-note widget shows, when it's added and when it's reconfigured. */
class WidgetSetupActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        setResult(RESULT_CANCELED, result(widgetId))
        val graph = graph
        setContent {
            val pins by graph.settings.pins.collectAsStateWithLifecycle()
            val snapshot by graph.index.snapshot.collectAsStateWithLifecycle()
            val capture by graph.settings.capture.collectAsStateWithLifecycle()
            NotesTheme {
                BottomSheet(onDismiss = ::finish) {
                    Text(QuickCopy.PickNote, style = NotesType.barTitle, color = NotesTheme.colors.ink, modifier = Modifier.padding(horizontal = PagePadding, vertical = 8.dp))
                    NotePicker(pins, snapshot, FolderPath(capture.weeklyFolder.trim('/'))) { pick(widgetId, it) }
                }
            }
        }
    }

    private fun pick(widgetId: Int, pin: Pin) {
        graph.noteWidgets.setPin(widgetId, pin)
        lifecycleScope.launch {
            val glanceId = GlanceAppWidgetManager(this@WidgetSetupActivity).getGlanceIdBy(widgetId)
            PinnedNoteWidget().update(this@WidgetSetupActivity, glanceId)
            setResult(RESULT_OK, result(widgetId))
            finish()
        }
    }

    private fun result(widgetId: Int) = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
}
