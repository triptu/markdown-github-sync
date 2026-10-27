package io.github.triptu.notes

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.triptu.notes.capture.WeeklyNote
import io.github.triptu.notes.editor.EditorSession
import io.github.triptu.notes.editor.EditorTarget
import io.github.triptu.notes.recents.RecentsFeed
import io.github.triptu.notes.recents.RecentsFeedBuilder
import io.github.triptu.notes.library.VaultTreeModel
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.settings.SampleVault
import io.github.triptu.notes.vault.DeletedNote
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NoteNames
import io.github.triptu.notes.vault.sanitizeNoteName
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

    val vaultTree = VaultTreeModel(graph.index, graph.expandedFolders, viewModelScope)

    val pins: StateFlow<List<Pin>> = graph.settings.pins
    val capture = graph.settings.capture

    val recents: StateFlow<RecentsFeed> = combine(graph.index.snapshot, graph.settings.capture) { snapshot, settings ->
        val templates = settings.weeklyTemplate.substringBeforeLast('/', "").let(::FolderPath)
        RecentsFeedBuilder.build(snapshot, LocalDateTime.now(), ZoneId.systemDefault(), templates.takeUnless { it.isRoot })
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.Eagerly, RecentsFeed.Empty)

    val sampleVaultAvailable: Boolean = SampleVault.Available

    fun openNote(path: NotePath, reveal: String? = null) = push(EditorTarget.Open(path, reveal))

    /** A new note from Home, in the new-note folder. */
    fun newNote(voice: Boolean = false) = push(EditorTarget.New(graph.capture.newNoteFolder, voice))

    /** A new note in a Vault folder. The folder is shown open when the user comes back. */
    fun newNoteIn(folder: FolderPath) {
        vaultTree.reveal(folder, scroll = false)
        push(EditorTarget.New(folder, voice = false))
    }

    fun createFolder(parent: FolderPath, name: String) {
        val clean = sanitizeNoteName(name)
        if (clean.isEmpty()) return
        viewModelScope.launch {
            graph.store.createFolder(parent.child(clean))
            vaultTree.reveal(parent, scroll = false)
        }
    }

    /** Renames a note to [title], keeping a Zettelkasten stamp if it has one. */
    fun renameNote(path: NotePath, title: String) {
        val clean = sanitizeNoteName(title)
        if (clean.isEmpty()) return
        val target = path.renamed(NoteNames.stamp(path.name) + clean)
        if (target == path) return
        viewModelScope.launch { runCatching { graph.store.rename(path, target) } }
    }

    /** The note just deleted, while its Undo is offered. */
    var lastDeleted by mutableStateOf<DeletedNote?>(null)
        private set

    fun deleteNote(path: NotePath) {
        viewModelScope.launch {
            val text = graph.store.read(path) ?: return@launch
            graph.store.delete(path)
            lastDeleted = DeletedNote(path, text)
        }
    }

    /** Deletes the note in the top editor and closes it. */
    fun deleteOpenNote() {
        val top = overlays.lastOrNull() as? Overlay.Editor ?: return
        top.session.delete { removed ->
            back()
            lastDeleted = removed
        }
    }

    fun undoDelete() {
        val note = lastDeleted ?: return
        lastDeleted = null
        viewModelScope.launch { graph.store.write(note.path, note.text) }
    }

    fun dismissUndo() {
        lastDeleted = null
    }

    /** Opens the note a `[[link]]` names, creating it first if it doesn't exist. */
    fun openLink(target: String) {
        val existing = VaultQueries.resolveLink(graph.index.snapshot.value, target)
        if (existing != null) return openNote(existing)
        viewModelScope.launch { openNote(graph.capture.createLinked(target)) }
    }

    /** Opens this week's note with the cursor where writing continues (see [WeeklyNote.writingPosition]). */
    fun openThisWeek() {
        viewModelScope.launch {
            val path = graph.capture.ensureWeekly(LocalDateTime.now())
            val text = graph.store.read(path).orEmpty()
            push(EditorTarget.Open(path, cursorAt = WeeklyNote.writingPosition(text)))
        }
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

    fun openPinnedFolder(folder: FolderPath) = vaultTree.reveal(folder)

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
