package io.github.triptu.notes.library

import io.github.triptu.notes.vault.FolderContents
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.SearchHit
import io.github.triptu.notes.vault.VaultIndex
import io.github.triptu.notes.vault.VaultQueries
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn

/** Where the Library is, and what it shows there. */
data class LibraryLocation(
    val folder: FolderPath,
    /** Opened from a pinned folder on Home, so back returns to Home instead of climbing folders. */
    val fromPin: Boolean,
)

@OptIn(FlowPreview::class)
class LibraryModel(index: VaultIndex, scope: CoroutineScope) {
    private val _location = MutableStateFlow(LibraryLocation(FolderPath.Root, fromPin = false))
    val location: StateFlow<LibraryLocation> = _location.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    val contents: StateFlow<FolderContents> = combine(index.snapshot, _location) { snapshot, location ->
        VaultQueries.contents(snapshot, location.folder)
    }.flowOn(Dispatchers.Default).stateIn(scope, SharingStarted.Eagerly, FolderContents(emptyList(), emptyList()))

    val results: StateFlow<List<SearchHit>> = combine(index.snapshot, _query.debounce(SearchDebounceMs)) { snapshot, q ->
        VaultQueries.search(snapshot, q)
    }.flowOn(Dispatchers.Default).stateIn(scope, SharingStarted.Eagerly, emptyList())

    fun setQuery(q: String) {
        _query.value = q
    }

    fun open(folder: FolderPath) {
        _location.value = LibraryLocation(folder, fromPin = false)
    }

    fun openFromPin(folder: FolderPath) {
        _query.value = ""
        _location.value = LibraryLocation(folder, fromPin = true)
    }

    /** Goes up one folder. Returns false when there's nowhere further up inside the Library. */
    fun up(): Boolean {
        val here = _location.value
        if (here.fromPin || here.folder.isRoot) return false
        _location.value = here.copy(folder = here.folder.parent ?: FolderPath.Root)
        return true
    }

    fun reset() {
        _location.value = LibraryLocation(FolderPath.Root, fromPin = false)
    }

    private companion object {
        const val SearchDebounceMs = 120L
    }
}
