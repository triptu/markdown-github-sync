package io.github.triptu.notes.library

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import io.github.triptu.notes.vault.FolderPath
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Which Vault folders are open, kept across restarts in DataStore. */
class ExpandedFolders(private val store: DataStore<Preferences>, private val scope: CoroutineScope) {
    private val key = stringSetPreferencesKey("expanded")
    private val _expanded = MutableStateFlow<Set<FolderPath>>(emptySet())
    val expanded: StateFlow<Set<FolderPath>> = _expanded.asStateFlow()

    /** False until the saved set has been read, so the tree doesn't jump when it arrives. */
    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    init {
        scope.launch {
            val saved = store.data.first()[key].orEmpty().mapNotNullTo(HashSet()) { runCatching { FolderPath(it) }.getOrNull() }
            // Anything opened before the saved set loaded stays open too.
            _expanded.value = _expanded.value + saved
            _loaded.value = true
        }
    }

    fun toggle(folder: FolderPath) = set(if (folder in _expanded.value) _expanded.value - folder else _expanded.value + folder)

    fun open(folders: Set<FolderPath>) = set(_expanded.value + folders)

    fun set(folders: Set<FolderPath>) {
        if (folders == _expanded.value) return
        _expanded.value = folders
        scope.launch { store.edit { it[key] = folders.mapTo(HashSet()) { f -> f.value } } }
    }
}
