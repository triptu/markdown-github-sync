package io.github.triptu.notes.quick

import android.content.SharedPreferences
import androidx.core.content.edit
import io.github.triptu.notes.capture.CaptureService
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultChange
import io.github.triptu.notes.vault.VaultStore
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.onEach
import java.time.LocalDateTime

/** What a pinned-note widget shows. */
sealed interface NoteWidgetState {
    /** Added but no note picked yet. */
    data object NotSet : NoteWidgetState

    /** The note was moved or deleted outside the app. */
    data object Gone : NoteWidgetState

    /** This week's note doesn't exist yet. */
    data object WeekNotStarted : NoteWidgetState

    data class Shown(val pin: Pin, val title: String, val lines: List<WidgetLine>) : NoteWidgetState
}

/**
 * The pinned-note widgets' side of the app: which note each one shows, what it shows, and task
 * toggles. Every write goes through [VaultStore], so sync's lock and its push triggers apply.
 */
class NoteWidgets(
    private val prefs: SharedPreferences,
    private val store: VaultStore,
    private val capture: CaptureService,
) {
    private val _revision = MutableStateFlow(0L)

    /** Bumped when a shown note may have changed; open widget sessions reload on it. */
    val revision: StateFlow<Long> = _revision.asStateFlow()

    fun pinOf(widgetId: Int): Pin? = prefs.getString(key(widgetId), null)?.let(Pin::decode)

    fun setPin(widgetId: Int, pin: Pin) {
        prefs.edit { putString(key(widgetId), Pin.encode(pin)) }
        _revision.value++
    }

    fun forget(widgetIds: IntArray) = prefs.edit { widgetIds.forEach { remove(key(it)) } }

    private fun pins(): List<Pin> = prefs.all.filterKeys { it.startsWith(KeyPrefix) }.values.mapNotNull { (it as? String)?.let(Pin::decode) }

    private fun pathOf(pin: Pin): NotePath? = when (pin) {
        is Pin.Note -> pin.path
        Pin.ThisWeek -> capture.weeklyPath(LocalDateTime.now())
        is Pin.Folder -> null
    }

    suspend fun load(widgetId: Int): NoteWidgetState {
        val pin = pinOf(widgetId) ?: return NoteWidgetState.NotSet
        val path = pathOf(pin) ?: return NoteWidgetState.Gone
        val text = store.read(path)
            ?: return if (pin == Pin.ThisWeek) NoteWidgetState.WeekNotStarted else NoteWidgetState.Gone
        val title = if (pin == Pin.ThisWeek) QuickCopy.ThisWeek else path.displayName
        return NoteWidgetState.Shown(pin, title, WidgetNote.lines(text))
    }

    /** Ticks or unticks the task on [line], if the note still has it in the state the widget showed. */
    suspend fun toggle(widgetId: Int, line: Int, wasChecked: Boolean) {
        val path = pinOf(widgetId)?.let(::pathOf) ?: return
        store.update(path) { text -> text?.let { WidgetNote.toggle(it, line, wasChecked) } }
        _revision.value++
    }

    /**
     * Follows the vault: re-points widgets whose note the app renamed, and calls [refresh] shortly
     * after a shown note changes (an edit in the app, a widget toggle or a sync).
     */
    @OptIn(FlowPreview::class)
    suspend fun follow(refresh: suspend () -> Unit) {
        store.changes
            .onEach { if (it is VaultChange.Renamed) repoint(it.from, it.to) }
            .filter(::touchesAWidget)
            .onEach { _revision.value++ }
            .debounce(RefreshDelayMs)
            .collect { refresh() }
    }

    private fun touchesAWidget(change: VaultChange): Boolean {
        val pins = pins()
        if (pins.isEmpty()) return false
        val paths = pins.mapNotNull(::pathOf).toSet()
        return when (change) {
            VaultChange.External -> true
            is VaultChange.Written -> change.path in paths
            is VaultChange.Deleted -> change.path in paths
            is VaultChange.Renamed -> change.to in paths || change.from in paths
        }
    }

    private fun repoint(from: NotePath, to: NotePath) {
        val moved = prefs.all.filter { (k, v) -> k.startsWith(KeyPrefix) && v == Pin.encode(Pin.Note(from)) }.keys
        if (moved.isNotEmpty()) prefs.edit { moved.forEach { putString(it, Pin.encode(Pin.Note(to))) } }
    }

    private companion object {
        const val KeyPrefix = "pin."
        const val RefreshDelayMs = 400L

        fun key(widgetId: Int) = "$KeyPrefix$widgetId"
    }
}
