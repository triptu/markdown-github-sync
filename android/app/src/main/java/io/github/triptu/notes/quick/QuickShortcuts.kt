package io.github.triptu.notes.quick

import android.content.Context
import android.content.Intent
import androidx.annotation.DrawableRes
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import io.github.triptu.notes.MainActivity
import io.github.triptu.notes.R

/** One app-icon long-press shortcut. */
data class ShortcutSpec(val id: String, val label: String, val action: QuickAction, @param:DrawableRes val icon: Int)

/** The app icon's long-press shortcuts. Dynamic, so they point at whichever build (debug or release) is installed. */
object QuickShortcuts {
    val all = listOf(
        ShortcutSpec("new-note", QuickCopy.NewNote, QuickAction.NewNote, R.drawable.shortcut_new_note),
        ShortcutSpec("voice-note", QuickCopy.VoiceNote, QuickAction.Voice, R.drawable.shortcut_voice_note),
        ShortcutSpec("this-week", QuickCopy.ThisWeek, QuickAction.ThisWeek, R.drawable.shortcut_this_week),
    )

    /** Publishes the shortcuts if the launcher doesn't already have these ones. Call while on screen. */
    fun publish(context: Context) {
        val current = ShortcutManagerCompat.getDynamicShortcuts(context).map { it.id to it.shortLabel.toString() }
        if (current == all.map { it.id to it.label }) return
        val infos = all.mapIndexed { rank, spec ->
            ShortcutInfoCompat.Builder(context, spec.id)
                .setShortLabel(spec.label)
                .setLongLabel(spec.label)
                .setIcon(IconCompat.createWithResource(context, spec.icon))
                .setIntent(QuickLaunch.intent(context, spec.action))
                .setRank(rank)
                .build()
        }
        ShortcutManagerCompat.setDynamicShortcuts(context, infos)
    }
}

/** Intents that open [MainActivity] and run a [QuickAction]. */
object QuickLaunch {
    fun intent(context: Context, action: QuickAction): Intent =
        Intent(QuickAction.actionOf(action)).setClass(context, MainActivity::class.java).apply {
            QuickAction.pathOf(action)?.let { putExtra(QuickAction.PathExtra, it) }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    fun read(intent: Intent?): QuickAction? {
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
        return QuickAction.parse(intent.action, intent.getStringExtra(QuickAction.PathExtra))
    }
}
