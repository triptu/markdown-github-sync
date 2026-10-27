package io.github.triptu.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.editor.EditorSession
import io.github.triptu.notes.voice.VoiceSession
import kotlinx.coroutines.CoroutineScope

/** A screen opened over the list surface (Home, Vault, Recents). */
sealed interface Overlay {
    data class Editor(val session: EditorSession) : Overlay
    /** [focusToken]: opened because GitHub refused the token. */
    data class Settings(val focusToken: Boolean = false) : Overlay
    /** First run: connect GitHub sync, or skip. */
    data object Setup : Overlay

    /** The speaking view. */
    data class Voice(val session: VoiceSession) : Overlay
}

/** How the window is divided. [Two] shows the open note beside the list, as on a desktop. */
enum class Panes {
    One, Two;

    companion object {
        // Unfolded foldables are 775dp to 850dp wide at their default zoom, which the "expanded" class
        // (840dp) misses; the "medium" class starts at 600dp, well above any cover screen. The height
        // keeps a phone held sideways on one pane.
        val MinWidth = 600.dp
        val MinHeight = 480.dp

        fun of(width: Dp, height: Dp): Panes = if (width >= MinWidth && height >= MinHeight) Two else One
    }
}

/**
 * The screens stacked over the list, bottom to top, and how they land in the window's panes.
 * Editors removed from the stack are closed, saving what they hold, on [finalScope].
 */
class Overlays(private val finalScope: CoroutineScope) : MutableList<Overlay> by mutableStateListOf() {
    var panes by mutableStateOf(Panes.One)

    /** The note shown beside the list. Null in one pane, where a note covers the list like any other screen. */
    val note: Overlay.Editor?
        get() = if (panes == Panes.Two) lastOrNull { it is Overlay.Editor } as Overlay.Editor? else null

    /** The screen covering the list, if any. In two panes a note never covers it. */
    val cover: Overlay?
        get() = lastOrNull()?.takeUnless { panes == Panes.Two && it is Overlay.Editor }

    /** A note opened from the list. Beside the list it takes the open note's place; over the list it stacks. */
    fun show(note: Overlay.Editor) {
        if (panes == Panes.Two) filterIsInstance<Overlay.Editor>().forEach(::close)
        add(note)
    }

    fun close(overlay: Overlay) {
        if (!remove(overlay)) return
        if (overlay is Overlay.Editor) overlay.session.close(finalScope)
    }
}
