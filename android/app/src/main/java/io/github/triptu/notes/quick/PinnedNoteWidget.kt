package io.github.triptu.notes.quick

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.itemsIndexed
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import io.github.triptu.notes.R
import io.github.triptu.notes.graph
import io.github.triptu.notes.settings.Pin
import kotlinx.coroutines.flow.map

/**
 * A note on the home screen: its title, then its lines, with tasks that tick in place. Picked
 * when the widget is added ([WidgetSetupActivity]); "This week" follows the current week.
 */
class PinnedNoteWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val widgets = context.graph.noteWidgets
        val widgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val initial = widgets.load(widgetId)
        provideContent {
            val state by remember { widgets.revision.map { widgets.load(widgetId) } }.collectAsState(initial)
            PinnedNote(context, widgetId, state)
        }
    }

    companion object {
        suspend fun refreshAll(context: Context) = PinnedNoteWidget().updateAll(context)
    }
}

class PinnedNoteWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = PinnedNoteWidget()

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        context.graph.noteWidgets.forget(appWidgetIds)
    }
}

/** A tap on a task: tick or untick it in the note, then redraw. */
class ToggleTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val line = parameters[Line] ?: return
        val wasChecked = parameters[WasChecked] ?: return
        val widgetId = GlanceAppWidgetManager(context).getAppWidgetId(glanceId)
        context.graph.noteWidgets.toggle(widgetId, line, wasChecked)
        PinnedNoteWidget().update(context, glanceId)
    }

    companion object {
        val Line = ActionParameters.Key<Int>("line")
        val WasChecked = ActionParameters.Key<Boolean>("checked")
    }
}

@Composable
private fun PinnedNote(context: Context, widgetId: Int, state: NoteWidgetState) {
    val pickAnother = actionStartActivity(
        Intent(context, WidgetSetupActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    Column(
        GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .cornerRadius(android.R.dimen.system_app_widget_background_radius)
            .background(WidgetColors.bg),
    ) {
        when (state) {
            NoteWidgetState.NotSet -> Message(QuickCopy.PickNote, pickAnother)
            NoteWidgetState.Gone -> Message(QuickCopy.NoteGone, pickAnother)
            NoteWidgetState.WeekNotStarted -> {
                val open = actionStartActivity(QuickLaunch.intent(context, QuickAction.ThisWeek))
                Title(QuickCopy.ThisWeek, open)
                Message(QuickCopy.NoNoteThisWeek, open)
            }
            is NoteWidgetState.Shown -> {
                val action = when (val pin = state.pin) {
                    is Pin.Note -> QuickAction.OpenNote(pin.path)
                    else -> QuickAction.ThisWeek
                }
                val open = actionStartActivity(QuickLaunch.intent(context, action))
                Title(state.title, open)
                if (state.lines.isEmpty()) Message(QuickCopy.EmptyNote, open) else Lines(state.lines, open)
            }
        }
    }
}

@Composable
private fun Title(title: String, open: Action) {
    Row(
        GlanceModifier.fillMaxWidth().height(52.dp).clickable(open).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = TextStyle(color = WidgetColors.ink, fontSize = 16.sp, fontWeight = FontWeight.Medium), maxLines = 1)
    }
}

@Composable
private fun Message(text: String, action: Action) {
    Text(
        text,
        style = TextStyle(color = WidgetColors.muted, fontSize = 14.sp),
        modifier = GlanceModifier.fillMaxSize().clickable(action).padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun Lines(lines: List<WidgetLine>, open: Action) {
    LazyColumn(GlanceModifier.fillMaxSize()) {
        itemsIndexed(lines, itemId = { index, _ -> index.toLong() }) { _, line ->
            when (line) {
                is WidgetLine.Task -> TaskRow(line)
                is WidgetLine.Text -> TextRow(line, open)
                WidgetLine.Gap -> Spacer(GlanceModifier.height(8.dp))
            }
        }
        item { Spacer(GlanceModifier.height(10.dp)) }
    }
}

@Composable
private fun TaskRow(task: WidgetLine.Task) {
    val toggle = actionRunCallback<ToggleTaskAction>(
        actionParametersOf(ToggleTaskAction.Line to task.line, ToggleTaskAction.WasChecked to task.checked),
    )
    // 12dp above and below a 20sp line keeps each task a 44dp+ target.
    Row(
        GlanceModifier
            .fillMaxWidth()
            .clickable(toggle)
            .semantics { contentDescription = "${if (task.checked) QuickCopy.MarkNotDone else QuickCopy.MarkDone}: ${task.text}" }
            .padding(start = 16.dp + IndentStep * task.indent, end = 16.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            ImageProvider(if (task.checked) R.drawable.widget_task_done else R.drawable.widget_task_open),
            contentDescription = null,
            modifier = GlanceModifier.size(18.dp),
        )
        Spacer(GlanceModifier.width(12.dp))
        Text(task.text, style = TextStyle(color = if (task.checked) WidgetColors.muted else WidgetColors.ink, fontSize = 15.sp))
    }
}

@Composable
private fun TextRow(line: WidgetLine.Text, open: Action) {
    val style = if (line.heading) {
        TextStyle(color = WidgetColors.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    } else {
        TextStyle(color = WidgetColors.ink2, fontSize = 15.sp)
    }
    Text(
        if (line.bullet) "•  ${line.text}" else line.text,
        style = style,
        modifier = GlanceModifier
            .fillMaxWidth()
            .clickable(open)
            .padding(start = 16.dp + IndentStep * line.indent, end = 16.dp, top = if (line.heading) 6.dp else 3.dp, bottom = 3.dp),
    )
}

private val IndentStep = 18.dp
