package io.github.triptu.notes.quick

/**
 * Every sentence the widgets, the tile, the share sheet and the app shortcuts show. Short and plain.
 * Labels the system reads from XML (the tile, the widget picker) are in `res/values/strings.xml`.
 */
object QuickCopy {
    const val NewNote = "New note"
    const val VoiceNote = "Voice note"
    const val ThisWeek = "This week"
    const val WriteNewNote = "Write a new note"
    const val SpeakNewNote = "Speak a new note"

    // Picking a note, for the pinned-note widget and for "Add to a note…".
    const val PickNote = "Pick a note"
    const val Pinned = "Pinned"
    const val SearchNotes = "Search notes"
    const val NoMatches = "No notes match"

    // The pinned-note widget.
    const val EmptyNote = "Nothing here yet"
    const val NoNoteThisWeek = "No note this week yet. Tap to start it."
    const val NoteGone = "This note was moved or deleted. Tap to pick another."
    const val MarkDone = "Mark done"
    const val MarkNotDone = "Mark not done"

    // The share sheet.
    const val AddToNote = "Add to a note…"
    const val CouldNotSave = "Couldn't save. Try again."
}
