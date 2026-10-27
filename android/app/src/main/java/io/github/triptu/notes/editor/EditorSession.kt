package io.github.triptu.notes.editor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import io.github.triptu.notes.capture.CaptureService
import io.github.triptu.notes.capture.ZettelName
import io.github.triptu.notes.vault.DeletedNote
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.LinkSuggestion
import io.github.triptu.notes.vault.NoteNames
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultChange
import io.github.triptu.notes.vault.VaultIndex
import io.github.triptu.notes.vault.VaultQueries
import io.github.triptu.notes.vault.VaultStore
import io.github.triptu.notes.vault.sanitizeNoteName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.LocalDateTime

/** What the editor was opened for. */
sealed interface EditorTarget {
    /**
     * [reveal] is a bit of the note to scroll to, such as the snippet a Recents card showed.
     * [cursorAt] puts the cursor there and opens the keyboard, as the This week pin does.
     */
    data class Open(val path: NotePath, val reveal: String? = null, val cursorAt: Int? = null) : EditorTarget

    /** A new note in [folder], named `YYYYMMDDHH <first words>`. [voice] starts dictation. */
    data class New(val folder: FolderPath, val voice: Boolean) : EditorTarget
}

/**
 * One open editor: the text, where it saves, undo, and debounced atomic autosave.
 * Lives in the activity's ViewModel so it survives rotation and theme changes. [parentScope] must
 * run on the main thread, since the session's Compose state is written from its coroutines.
 */
class EditorSession(
    val target: EditorTarget,
    private val store: VaultStore,
    private val index: VaultIndex,
    private val capture: CaptureService,
    parentScope: CoroutineScope,
    private val now: () -> LocalDateTime = LocalDateTime::now,
) {
    private val scope = CoroutineScope(parentScope.coroutineContext + SupervisorJob(parentScope.coroutineContext[Job]))
    private val saveLock = Mutex()
    private val undo = UndoHistory()
    private val startedAt = now()
    private var pendingSave: Job? = null
    private var savedText: String? = null

    /** The note on disk this editor writes, once it has one. */
    var path: NotePath? by mutableStateOf((target as? EditorTarget.Open)?.path)
        private set

    var value by mutableStateOf(TextFieldValue(""))
        private set
    var loaded by mutableStateOf(target is EditorTarget.New)
        private set
    var canUndo by mutableStateOf(false)
        private set
    var canRedo by mutableStateOf(false)
        private set

    /** Where the `[[` of the link being typed starts, while the suggestion popover is open. */
    var linkStart: Int? by mutableStateOf(null)
        private set
    var parsed by mutableStateOf(MarkdownParser.parse(""))
        private set
    var deleted by mutableStateOf(false)
        private set

    /** Where to scroll once the note is shown, from [EditorTarget.Open.reveal]. Cleared once used. */
    var revealAt: Int? by mutableStateOf(null)
        private set
    private var revealPending = (target as? EditorTarget.Open)?.let { it.reveal != null || it.cursorAt != null } == true

    val isNew: Boolean get() = target is EditorTarget.New

    /** The folder shown in the top bar. */
    val folder: FolderPath? get() = path?.folder ?: (target as? EditorTarget.New)?.folder

    /** The note's name as shown in the title. A new note shows the name its first words will give it. */
    val title: String
        get() = if (isNew) NoteNames.display(path?.name ?: ZettelName.of(startedAt, value.text)) else path?.displayName.orEmpty()

    init {
        if (target is EditorTarget.Open) load(target.path)
        scope.launch { followDisk() }
    }

    /** Keeps the open note in step with changes made outside this editor, such as a sync. */
    private suspend fun followDisk() {
        store.changes.collect { change ->
            val mine = path ?: return@collect
            when (change) {
                is VaultChange.Written -> if (change.path == mine) onDiskText(change.text)
                is VaultChange.Renamed -> if (change.from == mine) path = change.to
                VaultChange.External -> store.read(mine)?.let(::onDiskText)
                is VaultChange.Deleted -> Unit
            }
        }
    }

    /**
     * Without unsaved edits, shows the new text in place and keeps the cursor near where it was.
     * With unsaved edits, keeps the user's text and saves it over the change; sync's
     * compare-and-swap is what notices the conflict.
     */
    private fun onDiskText(disk: String) {
        if (!loaded || disk == savedText) return
        if (disk == value.text) {
            savedText = disk
            return
        }
        if (value.text != savedText) {
            savedText = disk
            scheduleSave()
            return
        }
        value = TextFieldValue(disk, EditOps.mapSelection(value.text, disk, value.selection))
        parsed = MarkdownParser.parse(disk)
        savedText = disk
        undo.clear()
        linkStart = null
        syncUndoState()
    }

    private fun load(path: NotePath) {
        // The index holds every note's text in memory, so most opens draw at once.
        index.snapshot.value.notes[path]?.text?.let(::setLoaded)
        scope.launch {
            val text = store.read(path) ?: ""
            if (!loaded || (savedText != text && value.text == savedText)) setLoaded(text)
        }
    }

    private fun setLoaded(text: String) {
        val cursorAt = (target as? EditorTarget.Open)?.cursorAt?.coerceIn(0, text.length)
        if (revealPending) revealAt = cursorAt ?: findReveal(text)
        savedText = text
        value = TextFieldValue(text, TextRange(cursorAt ?: 0))
        parsed = MarkdownParser.parse(text)
        loaded = true
    }

    fun revealDone() {
        revealPending = false
        revealAt = null
    }

    /** Finds the start of the reveal snippet. Snippets join a paragraph's lines, so try short keys too. */
    private fun findReveal(text: String): Int? {
        val reveal = (target as? EditorTarget.Open)?.reveal?.trim() ?: return null
        for (length in intArrayOf(40, 20, 10)) {
            val key = reveal.take(length)
            if (key.length < 3) break
            val at = text.indexOf(key)
            if (at >= 0) return at
        }
        return null
    }

    fun onValueChange(next: TextFieldValue, newUndoStep: Boolean = false) {
        val textChanged = next.text != value.text
        linkStart = EditOps.trackLink(value, next, linkStart)
        if (textChanged) {
            undo.record(value, force = newUndoStep)
            parsed = MarkdownParser.parse(next.text)
        }
        value = next
        if (textChanged) {
            syncUndoState()
            scheduleSave()
        }
    }

    fun undo() = restore(undo.undo(value))

    fun redo() = restore(undo.redo(value))

    private fun restore(to: TextFieldValue?) {
        if (to == null) return
        value = to
        parsed = MarkdownParser.parse(to.text)
        linkStart = null
        syncUndoState()
        scheduleSave()
    }

    private fun syncUndoState() {
        canUndo = undo.canUndo
        canRedo = undo.canRedo
    }

    /** Closes the link popover until another `[[` is typed. */
    fun dismissLink() {
        linkStart = null
    }

    val linkQuery: LinkQuery? get() = linkStart?.let { EditOps.linkQuery(value, it) }

    fun linkSuggestions(query: LinkQuery): List<LinkSuggestion> =
        VaultQueries.linkSuggestions(index.snapshot.value, query.query, exclude = path)

    /** Finishes the link being typed as `[[name]]` and closes the popover. */
    fun completeLink(query: LinkQuery, name: String) {
        onValueChange(EditOps.completeLink(value, query, name), newUndoStep = true)
        linkStart = null
    }

    fun toggleTask(task: TaskMark) = onValueChange(EditOps.toggleTask(value, task), newUndoStep = true)

    /** Renames an existing note. Returns false and keeps the old name if the new one is taken or empty. */
    suspend fun rename(newTitle: String): Boolean {
        val current = path ?: return false
        // The title shows the name without its stamp; the file keeps the stamp.
        val shown = sanitizeNoteName(newTitle)
        if (shown.isEmpty()) return false
        val name = NoteNames.stamp(current.name) + shown
        if (name == current.name) return true
        return try {
            flush()
            val renamed = current.renamed(name)
            store.rename(current, renamed)
            path = renamed
            true
        } catch (e: IOException) {
            false
        }
    }

    /** Deletes the note and hands back what was deleted, so it can be restored. */
    fun delete(onDone: (DeletedNote?) -> Unit) {
        scope.launch {
            pendingSave?.cancel()
            val removed = saveLock.withLock {
                deleted = true
                path?.let { store.delete(it); DeletedNote(it, value.text) }
            }
            onDone(removed)
        }
    }

    private fun scheduleSave() {
        pendingSave?.cancel()
        pendingSave = scope.launch {
            delay(SaveDebounceMs)
            save()
        }
    }

    /** Saves now if anything changed. Safe to call any time; survives the editor closing. */
    suspend fun flush() {
        pendingSave?.cancel()
        withContext(NonCancellable) { save() }
    }

    private suspend fun save() = saveLock.withLock {
        if (!loaded || deleted) return@withLock
        val text = value.text
        if (text == savedText) return@withLock
        val target = target
        if (target is EditorTarget.New) {
            path = capture.saveNewNote(target.folder, path, text, startedAt)
        } else {
            path?.let { store.write(it, text) }
        }
        savedText = text
    }

    /** Saves and stops. The final save runs on [finalScope] so leaving the screen can't cancel it. */
    fun close(finalScope: CoroutineScope) {
        finalScope.launch { flush() }.invokeOnCompletion { scope.cancel() }
    }

    private companion object {
        const val SaveDebounceMs = 600L
    }
}
