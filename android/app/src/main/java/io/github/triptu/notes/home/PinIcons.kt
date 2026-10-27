package io.github.triptu.notes.home

import androidx.annotation.DrawableRes
import io.github.triptu.notes.R
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.vault.FolderPath

/** Picks a pin's icon from its name, so Home reads at a glance without the user choosing icons. */
object PinIcons {
    private val ByKeyword: List<Pair<Regex, Int>> = listOf(
        Regex("todo|task|checklist", RegexOption.IGNORE_CASE) to R.drawable.ph_check_square,
        Regex("idea", RegexOption.IGNORE_CASE) to R.drawable.ph_lightbulb,
        Regex("read|book", RegexOption.IGNORE_CASE) to R.drawable.ph_books,
        Regex("work|meeting|project", RegexOption.IGNORE_CASE) to R.drawable.ph_briefcase,
        Regex("grocer|shopping|buy", RegexOption.IGNORE_CASE) to R.drawable.ph_shopping_cart_simple,
        Regex("trip|travel|flight", RegexOption.IGNORE_CASE) to R.drawable.ph_airplane_tilt,
        Regex("blog|draft|writ|essay", RegexOption.IGNORE_CASE) to R.drawable.ph_pen_nib,
        Regex("tell|ask|talk", RegexOption.IGNORE_CASE) to R.drawable.ph_chat_circle_text,
        Regex("journal|diary|log", RegexOption.IGNORE_CASE) to R.drawable.ph_notebook,
    )
    private val WeeklyName = Regex("""^W\d{1,2}\b""")

    @DrawableRes
    fun of(pin: Pin, weeklyFolder: FolderPath): Int = when (pin) {
        is Pin.Folder -> R.drawable.ph_folder_simple
        Pin.ThisWeek -> R.drawable.ph_calendar_blank
        is Pin.Note -> when {
            WeeklyName.containsMatchIn(pin.path.name) || pin.path.folder.isWithin(weeklyFolder) && !weeklyFolder.isRoot -> R.drawable.ph_calendar_blank
            else -> ByKeyword.firstOrNull { it.first.containsMatchIn(pin.path.name) }?.second ?: R.drawable.ph_file_text
        }
    }
}
