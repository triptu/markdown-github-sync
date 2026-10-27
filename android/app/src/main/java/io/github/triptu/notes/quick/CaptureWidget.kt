package io.github.triptu.notes.quick

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import io.github.triptu.notes.R

/**
 * The slim capture bar: "New note" opens the editor on a new note with the keyboard up; the mic
 * opens the speaking view. 2x1 to 4x1. Colors follow the system's light or dark theme.
 */
class CaptureWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(Narrow, Wide))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { CaptureBar(context) }
    }

    private companion object {
        val Narrow = DpSize(100.dp, 48.dp)
        val Wide = DpSize(180.dp, 48.dp)
    }
}

class CaptureWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = CaptureWidget()
}

@Composable
private fun CaptureBar(context: Context) {
    val wide = LocalSize.current.width >= 180.dp
    Row(
        GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .cornerRadius(android.R.dimen.system_app_widget_background_radius)
            .background(WidgetColors.bg)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            GlanceModifier
                .defaultWeight()
                .fillMaxHeight()
                .cornerRadius(24.dp)
                .clickable(actionStartActivity(QuickLaunch.intent(context, QuickAction.NewNote)))
                .semantics { contentDescription = QuickCopy.WriteNewNote }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = if (wide) Alignment.Start else Alignment.CenterHorizontally,
        ) {
            WidgetIcon(R.drawable.ph_note_pencil, WidgetColors.ink2, 22)
            if (wide) {
                Spacer(GlanceModifier.width(12.dp))
                Text(QuickCopy.NewNote, style = TextStyle(color = WidgetColors.muted, fontSize = 16.sp), maxLines = 1)
            }
        }
        Box(
            GlanceModifier
                .size(48.dp)
                .cornerRadius(24.dp)
                .background(WidgetColors.raised)
                .clickable(actionStartActivity(QuickLaunch.intent(context, QuickAction.Voice)))
                .semantics { contentDescription = QuickCopy.SpeakNewNote },
            contentAlignment = Alignment.Center,
        ) {
            WidgetIcon(R.drawable.ph_microphone, WidgetColors.ink, 22)
        }
    }
}

@Composable
internal fun WidgetIcon(icon: Int, tint: ColorProvider, sizeDp: Int) {
    Image(ImageProvider(icon), contentDescription = null, colorFilter = ColorFilter.tint(tint), modifier = GlanceModifier.size(sizeDp.dp))
}

/** The app's neutral palette as widget colors; each resolves to light or dark with the system. */
internal object WidgetColors {
    val bg = ColorProvider(R.color.quick_bg)
    val raised = ColorProvider(R.color.quick_raised)
    val ink = ColorProvider(R.color.quick_ink)
    val ink2 = ColorProvider(R.color.quick_ink2)
    val muted = ColorProvider(R.color.quick_muted)
}

