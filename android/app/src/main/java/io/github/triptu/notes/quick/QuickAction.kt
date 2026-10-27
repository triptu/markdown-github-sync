package io.github.triptu.notes.quick

import io.github.triptu.notes.vault.NotePath

/** Something the app does as soon as it opens from outside: a widget, the tile or a shortcut. */
sealed interface QuickAction {
    /** The editor on a new note in the new-note folder, keyboard up. */
    data object NewNote : QuickAction

    /** The speaking view; Save makes a new note in the new-note folder. */
    data object Voice : QuickAction

    /** This week's note, created from the template if missing. */
    data object ThisWeek : QuickAction

    data class OpenNote(val path: NotePath) : QuickAction

    /** How an action travels in an intent: an action string and, for a note, its path. Pure, for tests. */
    companion object {
        private const val Prefix = "io.github.triptu.notes.action."
        const val NewNoteAction = Prefix + "NEW_NOTE"
        const val VoiceAction = Prefix + "VOICE_NOTE"
        const val ThisWeekAction = Prefix + "THIS_WEEK"
        const val OpenNoteAction = Prefix + "OPEN_NOTE"
        const val PathExtra = "path"

        fun actionOf(action: QuickAction): String = when (action) {
            NewNote -> NewNoteAction
            Voice -> VoiceAction
            ThisWeek -> ThisWeekAction
            is OpenNote -> OpenNoteAction
        }

        fun pathOf(action: QuickAction): String? = (action as? OpenNote)?.path?.value

        fun parse(action: String?, path: String?): QuickAction? = when (action) {
            NewNoteAction -> NewNote
            VoiceAction -> Voice
            ThisWeekAction -> ThisWeek
            OpenNoteAction -> path?.let { runCatching { OpenNote(NotePath(it)) }.getOrNull() }
            else -> null
        }
    }
}
