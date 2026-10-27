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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import io.github.triptu.notes.sync.SyncError
import io.github.triptu.notes.sync.SyncStatus
import io.github.triptu.notes.syncing.SetupState
import io.github.triptu.notes.syncing.BothVersions
import io.github.triptu.notes.syncing.BothVersionsFinder
import io.github.triptu.notes.syncing.DeletionDecision
import io.github.triptu.notes.syncing.SyncBar
import io.github.triptu.notes.syncing.SyncNotice
import io.github.triptu.notes.syncing.SyncNotices
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDateTime
import java.time.ZoneId

/** A screen drawn over the pager. */
sealed interface Overlay {
    data class Editor(val session: EditorSession) : Overlay
    /** [focusToken]: opened because GitHub refused the token. */
    data class Settings(val focusToken: Boolean = false) : Overlay
    /** First run: connect GitHub sync, or skip. */
    data object Setup : Overlay
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

    val sync = graph.sync

    /** The debug sample vault, offered only while sync isn't set up. */
    val sampleVaultAvailable: StateFlow<Boolean> = sync.target.map { SampleVault.Available && it == null }
        .stateIn(viewModelScope, SharingStarted.Eagerly, SampleVault.Available && sync.target.value == null)

    private val bothVersions: StateFlow<List<NotePath>> = BothVersionsFinder().let { finder ->
        graph.index.snapshot.map { finder.find(it) }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    }

    /** The last status that wasn't a sync in progress, so lines don't blink while a retry runs. */
    private val settledStatus: StateFlow<SyncStatus> = sync.status.filter { it !is SyncStatus.Syncing }
        .stateIn(viewModelScope, SharingStarted.Eagerly, sync.status.value.takeIf { it !is SyncStatus.Syncing } ?: SyncStatus.NotSetUp)

    private val minutes = flow {
        while (true) {
            emit(System.currentTimeMillis())
            delay(60_000)
        }
    }

    val syncBar: StateFlow<SyncBar> = combine(
        listOf(sync.status, settledStatus, sync.firstSync, sync.deletion, sync.conflictProblem, bothVersions, minutes),
    ) { values ->
        @Suppress("UNCHECKED_CAST")
        SyncNotices.bar(
            settled = values[1] as SyncStatus,
            progress = values[0] as? SyncStatus.Syncing,
            firstSync = values[2] as Boolean,
            deletion = values[3] as DeletionDecision?,
            conflictProblem = values[4] as String?,
            bothVersions = values[5] as List<NotePath>,
            now = values[6] as Long,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SyncBar.Quiet)

    init {
        if (!sync.setupOffered && sync.target.value == null) overlays += Overlay.Setup
        // GitHub refused the token: open Settings at the token field once, if nothing else is open.
        viewModelScope.launch {
            var shown = false
            syncBar.collect { bar ->
                val needsToken = bar.notices.any { it is SyncNotice.NeedsToken }
                if (needsToken && !shown && overlays.isEmpty()) {
                    shown = true
                    openSettings(focusToken = true)
                }
                if (!needsToken) shown = false
            }
        }
    }

    /** Debug builds only: made-up sync states for screenshots. */
    fun demoSync(kind: String) {
        val now = System.currentTimeMillis()
        when (kind) {
            "offline" -> sync.demo(SyncStatus.Offline(now - 3_600_000))
            "offline-long" -> sync.demo(SyncStatus.Offline(now - 9 * 3_600_000))
            "error" -> sync.demo(SyncStatus.Error(SyncError(SyncError.Kind.Other, "Some updates from GitHub couldn't be saved because those files changed here. Sync will try again.")))
            "access" -> sync.demo(SyncStatus.Error(SyncError(SyncError.Kind.Access, "GitHub rejected this token. It may be mistyped, expired or revoked.")))
            "downloading" -> {
                sync.demo(SyncStatus.Syncing(12, 44), firstSync = true, setup = SetupState.Downloading(12, 44))
                if (Overlay.Setup !in overlays) overlays += Overlay.Setup
            }
            else -> sync.demo(null, setup = SetupState.Idle)
        }
    }

    fun finishSetup() {
        sync.markSetupOffered()
        overlays.remove(Overlay.Setup)
    }

    /** A note that holds both versions of some lines: open it at the first one. */
    fun openBothVersions(path: NotePath) = openNote(path, reveal = BothVersions.Mine)

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

    fun openSettings(focusToken: Boolean = false) {
        overlays.removeAll { it is Overlay.Settings }
        overlays += Overlay.Settings(focusToken)
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
