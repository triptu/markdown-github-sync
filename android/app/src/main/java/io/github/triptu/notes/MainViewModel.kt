package io.github.triptu.notes

import android.app.Application
import androidx.compose.runtime.mutableStateListOf
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.triptu.notes.capture.CaptureDestination
import io.github.triptu.notes.editor.EditorSession
import io.github.triptu.notes.editor.EditorTarget
import io.github.triptu.notes.lately.LatelyFeed
import io.github.triptu.notes.lately.LatelyFeedBuilder
import io.github.triptu.notes.library.LibraryModel
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.settings.SampleVault
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultQueries
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.ZoneId

/** A screen drawn over the pager. */
sealed interface Overlay {
    data class Editor(val session: EditorSession) : Overlay
    data object Settings : Overlay
}

/** Navigation and screen state for the one activity. */
class MainViewModel(app: Application) : AndroidViewModel(app) {
    val graph = app.graph

    val overlays = mutableStateListOf<Overlay>()

    val library = LibraryModel(graph.index, viewModelScope)

    val pins: StateFlow<List<Pin>> = graph.settings.pins
    val capture = graph.settings.capture

    val lately: StateFlow<LatelyFeed> = combine(graph.index.snapshot, graph.settings.capture) { snapshot, settings ->
        val templates = settings.weeklyTemplate.substringBeforeLast('/', "").let(::FolderPath)
        LatelyFeedBuilder.build(snapshot, LocalDateTime.now(), ZoneId.systemDefault(), templates.takeUnless { it.isRoot })
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.Eagerly, LatelyFeed.Empty)

    val sampleVaultAvailable: Boolean = SampleVault.Available

    fun openNote(path: NotePath) = push(EditorTarget.Open(path))

    fun capture(destination: CaptureDestination = capture.value.defaultDestination, voice: Boolean = false) =
        push(EditorTarget.Capture(destination, voice))

    /** Opens the note a `[[link]]` names, creating it first if it doesn't exist. */
    fun openLink(target: String) {
        val existing = VaultQueries.resolveLink(graph.index.snapshot.value, target)
        if (existing != null) return openNote(existing)
        viewModelScope.launch { openNote(graph.capture.createLinked(target)) }
    }

    fun openThisWeek() {
        viewModelScope.launch { openNote(graph.capture.ensureWeekly(LocalDateTime.now())) }
    }

    fun openSettings() {
        overlays += Overlay.Settings
    }

    /** Closes the top overlay. Returns false if there was none. */
    fun back(): Boolean {
        val top = overlays.removeLastOrNull() ?: return false
        if (top is Overlay.Editor) top.session.close(graph.mainScope)
        return true
    }

    fun togglePin(pin: Pin) = graph.settings.togglePin(pin)

    fun isPinned(pin: Pin) = pin in pins.value

    fun openPinnedFolder(folder: FolderPath) = library.openFromPin(folder)

    fun loadSampleVault() {
        viewModelScope.launch { SampleVault.load(getApplication(), graph) }
    }

    fun refresh() {
        viewModelScope.launch { graph.index.refresh() }
    }

    /** Saves every open editor, for when the app goes to the background. */
    fun flushEditors() {
        overlays.filterIsInstance<Overlay.Editor>().forEach { graph.mainScope.launch { it.session.flush() } }
    }

    private fun push(target: EditorTarget) {
        overlays += Overlay.Editor(EditorSession(target, graph.store, graph.index, graph.capture, viewModelScope))
    }

    override fun onCleared() {
        overlays.filterIsInstance<Overlay.Editor>().forEach { it.session.close(graph.mainScope) }
    }
}
