package io.github.triptu.notes

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.triptu.notes.capture.WeeklyNote
import io.github.triptu.notes.editor.EditorSession
import io.github.triptu.notes.editor.EditorTarget
import io.github.triptu.notes.home.Resurface
import io.github.triptu.notes.home.ResurfaceDay
import io.github.triptu.notes.home.ResurfaceRules
import io.github.triptu.notes.home.Resurfaced
import io.github.triptu.notes.quick.QuickAction
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
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import io.github.triptu.notes.sync.SyncStatus
import io.github.triptu.notes.syncing.BothVersions
import io.github.triptu.notes.syncing.BothVersionsFinder
import io.github.triptu.notes.syncing.DeletionDecision
import io.github.triptu.notes.syncing.SyncBar
import io.github.triptu.notes.syncing.SyncNotice
import io.github.triptu.notes.syncing.SyncNotices
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import io.github.triptu.notes.voice.VoiceDraft
import io.github.triptu.notes.voice.VoiceSession
import io.github.triptu.notes.voice.VoiceTarget
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/** Navigation and screen state for the one activity. */
class MainViewModel(app: Application) : AndroidViewModel(app) {
    val graph = app.graph

    val overlays = Overlays(graph.mainScope)

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

    /** Home's old note for today, from the index in memory: no file is read. */
    val resurfaced: StateFlow<Resurfaced?> = combine(
        graph.index.snapshot,
        graph.settings.capture,
        pins,
        graph.settings.resurfaceDay,
        minutes.map { LocalDate.now() }.distinctUntilChanged(),
    ) { snapshot, settings, pins, remembered, today ->
        val rules = ResurfaceRules(
            weeklyFolder = FolderPath(settings.weeklyFolder.trim('/')),
            templateFolders = setOf(settings.newNoteTemplate, settings.weeklyTemplate).mapTo(HashSet()) { FolderPath(it.trim('/').substringBeforeLast('/', "")) },
            zettelFolder = FolderPath(settings.newNoteFolder.trim('/')),
            pinned = pins.filterIsInstance<Pin.Note>().mapTo(HashSet()) { it.path },
        )
        val day = Resurface.today(snapshot.notes, today, ZoneId.systemDefault(), rules, remembered)
        day?.let(graph.settings::setResurfaceDay)
        day?.pick?.let { pick -> snapshot.notes[pick.path]?.let { Resurface.show(pick, it, today) } }
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** "Not today": Home shows no old note until tomorrow. */
    fun putAwayResurfaced() = graph.settings.setResurfaceDay(ResurfaceDay(LocalDate.now(), null))

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

    fun finishSetup() {
        sync.markSetupOffered()
        overlays.remove(Overlay.Setup)
    }

    /** A note that holds both versions of some lines: open it at the first one. */
    fun openBothVersions(path: NotePath) = openNote(path, reveal = BothVersions.Mine)

    fun openNote(path: NotePath, reveal: String? = null) = show(EditorTarget.Open(path, reveal))

    /** A new note from Home, in the new-note folder. */
    fun newNote() = show(EditorTarget.New(graph.capture.newNoteFolder))

    /** A new note in a Vault folder. The folder is shown open when the user comes back. */
    fun newNoteIn(folder: FolderPath) {
        vaultTree.reveal(folder, scroll = false)
        show(EditorTarget.New(folder))
    }

    /** An action from a widget, the tile, a shortcut or the share sheet. An open speaking view keeps its words as a draft. */
    fun runQuick(action: QuickAction) {
        if (action == QuickAction.Voice && overlays.lastOrNull() is Overlay.Voice) return
        if (overlays.lastOrNull() is Overlay.Voice) dismissVoice()
        // A new note left blank on top is reused by New note and closed by anything else.
        val blank = (overlays.lastOrNull() as? Overlay.Editor)?.session?.takeIf { it.isNew && it.value.text.isBlank() }
        if (blank != null && action != QuickAction.NewNote) back()
        when (action) {
            QuickAction.NewNote -> if (blank != null) blank.requestKeyboard() else newNote()
            QuickAction.Voice -> speakNewNote()
            QuickAction.ThisWeek -> openThisWeek()
            is QuickAction.OpenNote -> openNote(action.path)
        }
    }

    // ---- Speaking ----------------------------------------------------------------

    /** Unsaved words from an earlier recording, offered on Home. */
    val voiceDraft: StateFlow<Pair<String, VoiceDraft>?> = graph.voice.draft

    /** Home's mic: Save makes a new note in the new-note folder. */
    fun speakNewNote() = openVoice(VoiceTarget.NewNote(graph.capture.newNoteFolder), editor = null)

    /** The editor's mic: Save adds the words at that note's cursor. */
    fun speakInto(editor: EditorSession) {
        val target = editor.path?.let { VoiceTarget.IntoNote(it, editor.value.selection.min) }
            ?: VoiceTarget.NewNote(editor.folder ?: graph.capture.newNoteFolder)
        openVoice(target, editor)
    }

    private fun openVoice(target: VoiceTarget, editor: EditorSession?) {
        if (overlays.any { it is Overlay.Voice }) return
        val voice = graph.voice
        overlays += Overlay.Voice(
            VoiceSession(
                target = target,
                editor = editor,
                context = getApplication(),
                language = graph.settings.voice.value.language.ifEmpty { null },
                record = voice.refining,
                drafts = voice.drafts,
                scope = viewModelScope,
                audioDir = voice.audioDir,
            ),
        )
    }

    /** Save: the words go to their note, then the cloud refine runs if a key is set. */
    fun saveVoice() {
        val session = closeVoice() ?: return
        val (text, audio) = session.finish()
        graph.voice.dropDraft(session.id)
        if (text.isBlank()) {
            audio?.delete()
            return
        }
        val editor = session.editor
        if (editor != null) {
            editor.insertSpoken(text)
            refineOrDrop(audio, text, newNote = null) { editor.flush(); editor.path }
            return
        }
        val folder = (session.target as? VoiceTarget.NewNote)?.folder ?: graph.capture.newNoteFolder
        val saved = graph.mainScope.async { graph.capture.createNewNote(folder, text, session.startedAt) }
        refineOrDrop(audio, text, newNote = folder to session.startedAt) { saved.await() }
    }

    /** Type: the editor opens with the words so far, keyboard up. */
    fun typeVoice() {
        val session = closeVoice() ?: return
        val (text, audio) = session.finish()
        audio?.delete()
        graph.voice.dropDraft(session.id)
        val editor = session.editor
        if (editor != null) {
            editor.insertSpoken(text)
            editor.requestKeyboard()
            return
        }
        val folder = (session.target as? VoiceTarget.NewNote)?.folder ?: graph.capture.newNoteFolder
        show(EditorTarget.New(folder, text))
    }

    /** X, Back, or the app closing the view: the words are kept as a draft for Home to offer. */
    fun dismissVoice() {
        val session = closeVoice() ?: return
        session.finish().second?.delete()
        graph.voice.keepDraft(session.id, session.draft())
    }

    /** The app left the screen: stop listening and keep the words. The view stays, paused. */
    fun pauseVoice() {
        (overlays.lastOrNull() as? Overlay.Voice)?.session?.pause()
    }

    /** Keep on Home's draft line: the words open in the editor, like Type. */
    fun keepDraft() {
        val (id, draft) = voiceDraft.value ?: return
        graph.voice.dropDraft(id)
        when (val target = draft.target) {
            is VoiceTarget.NewNote -> show(EditorTarget.New(target.folder, draft.text))
            is VoiceTarget.IntoNote -> viewModelScope.launch {
                if (graph.store.exists(target.path)) {
                    show(EditorTarget.Open(target.path, cursorAt = target.cursor, insert = draft.text))
                } else {
                    show(EditorTarget.New(graph.capture.newNoteFolder, draft.text))
                }
            }
        }
    }

    fun discardDraft() {
        voiceDraft.value?.let { graph.voice.dropDraft(it.first) }
    }

    private fun closeVoice(): VoiceSession? {
        val top = overlays.lastOrNull() as? Overlay.Voice ?: return null
        overlays.remove(top)
        return top.session
    }

    private fun refineOrDrop(audio: java.io.File?, text: String, newNote: Pair<FolderPath, LocalDateTime>?, locate: suspend () -> NotePath?) {
        if (audio == null) return
        if (!graph.voice.refining) {
            audio.delete()
            return
        }
        graph.voice.refine(audio, text, newNote, locate)
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

    /** Opens the note a `[[link]]` names over the one holding the link, creating it first if it doesn't exist. */
    fun openLink(target: String) {
        val existing = VaultQueries.resolveLink(graph.index.snapshot.value, target)
        if (existing != null) return push(EditorTarget.Open(existing))
        viewModelScope.launch { push(EditorTarget.Open(graph.capture.createLinked(target))) }
    }

    /** Opens this week's note with the cursor where writing continues (see [WeeklyNote.writingPosition]). */
    fun openThisWeek() {
        viewModelScope.launch {
            val path = graph.capture.ensureWeekly(LocalDateTime.now())
            val text = graph.store.read(path).orEmpty()
            show(EditorTarget.Open(path, cursorAt = WeeklyNote.writingPosition(text)))
        }
    }

    fun openSettings(focusToken: Boolean = false) {
        overlays.removeAll { it is Overlay.Settings }
        overlays += Overlay.Settings(focusToken)
    }

    /** Closes the top overlay. Returns false if there was none. */
    fun back(): Boolean {
        if (overlays.lastOrNull() is Overlay.Voice) {
            dismissVoice()
            return true
        }
        val top = overlays.lastOrNull() ?: return false
        overlays.close(top)
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

    /** A note opened from the list, a widget or the speaking view: see [Overlays.show]. */
    private fun show(target: EditorTarget) = overlays.show(Overlay.Editor(session(target)))

    /** A note opened from inside another stacks over it, so Back returns there. */
    private fun push(target: EditorTarget) {
        overlays += Overlay.Editor(session(target))
    }

    private fun session(target: EditorTarget) = EditorSession(target, graph.store, graph.index, graph.capture, viewModelScope)

    override fun onCleared() {
        overlays.filterIsInstance<Overlay.Voice>().forEach { voice ->
            voice.session.finish().second?.delete()
            graph.voice.keepDraft(voice.session.id, voice.session.draft())
        }
        overlays.filterIsInstance<Overlay.Editor>().forEach { it.session.close(graph.mainScope) }
    }
}
