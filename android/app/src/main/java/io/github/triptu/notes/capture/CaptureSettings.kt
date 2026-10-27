package io.github.triptu.notes.capture

data class CaptureSettings(
    /** Folder for new notes from Home, named `YYYYMMDDHH <first words>`. */
    val newNoteFolder: String = "Zettelkasten",
    /** Folder holding weekly notes, used by the This week pin. */
    val weeklyFolder: String = "journal",
    /** moment.js format of a weekly note's path inside [weeklyFolder], applied to the week's Monday. */
    val weeklyFormat: String = "GGGG/[weekly]/[W]WW Do MMM, GGGG",
    /** Note used to create a missing weekly note. Empty means start from an empty note. */
    val weeklyTemplate: String = "templates/Weekly Template.md",
)
