package io.github.triptu.notes.home

import java.time.format.TextStyle
import java.util.Locale

/** Every sentence Home shows, in one place. Short and plain. */
object HomeCopy {
    const val NoPins = "Long-press a note or folder in Vault to pin it here."
    const val Unpin = "Unpin"
    const val NewNote = "New note"
    const val SpeakNote = "Speak a note"
    const val NotToday = "Not today"

    /** "A year ago", "A month ago", "From March", or "From March 2025" before this year. */
    fun ago(ago: Ago): String = when (ago) {
        Ago.Year -> "A year ago"
        Ago.Month -> "A month ago"
        is Ago.From -> {
            val month = ago.month.month.getDisplayName(TextStyle.FULL, Locale.ENGLISH)
            if (ago.showYear) "From $month ${ago.month.year}" else "From $month"
        }
    }
}
