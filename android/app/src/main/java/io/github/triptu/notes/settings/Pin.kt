package io.github.triptu.notes.settings

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath

/** Something shown on Home. Notes and folders are separate kinds so a path can't be read as the wrong one. */
sealed interface Pin {
    data class Note(val path: NotePath) : Pin
    data class Folder(val path: FolderPath) : Pin

    /** Whichever note is this ISO week's, per the weekly note settings. Created on open if missing. */
    data object ThisWeek : Pin

    companion object {
        private const val NotePrefix = "note:"
        private const val FolderPrefix = "folder:"
        private const val ThisWeekKey = "this-week"

        fun encode(pin: Pin): String = when (pin) {
            is Note -> NotePrefix + pin.path.value
            is Folder -> FolderPrefix + pin.path.value
            ThisWeek -> ThisWeekKey
        }

        fun decode(line: String): Pin? = runCatching {
            when {
                line.startsWith(NotePrefix) -> Note(NotePath(line.removePrefix(NotePrefix)))
                line.startsWith(FolderPrefix) -> Folder(FolderPath(line.removePrefix(FolderPrefix)))
                line == ThisWeekKey -> ThisWeek
                else -> null
            }
        }.getOrNull()
    }
}
