package io.github.triptu.notes.library

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

/** The Vault screen: a tree of the vault with remembered open folders, and a flat search. */
@OptIn(FlowPreview::class)
class VaultTreeModel(index: VaultIndex, private val expanded: ExpandedFolders, scope: CoroutineScope) {
    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    /** A folder the screen should scroll to the top, once. */
    private val _scrollTo = MutableStateFlow<FolderPath?>(null)
    val scrollTo: StateFlow<FolderPath?> = _scrollTo.asStateFlow()

    val rows: StateFlow<List<TreeRow>> = combine(index.snapshot, expanded.expanded, expanded.loaded) { snapshot, open, loaded ->
        if (loaded) VaultTree.rows(snapshot, open) else emptyList()
    }.flowOn(Dispatchers.Default).stateIn(scope, SharingStarted.Eagerly, emptyList())

    val results: StateFlow<List<SearchHit>> = combine(index.snapshot, _query.debounce(SearchDebounceMs)) { snapshot, q ->
        VaultQueries.search(snapshot, q)
    }.flowOn(Dispatchers.Default).stateIn(scope, SharingStarted.Eagerly, emptyList())

    fun setQuery(q: String) {
        _query.value = q
    }

    fun toggle(folder: FolderPath) = expanded.toggle(folder)

    /** Opens [folder] and the folders above it, and (with [scroll]) asks the screen to bring it to the top. */
    fun reveal(folder: FolderPath, scroll: Boolean = true) {
        expanded.open(VaultTree.withAncestors(folder))
        if (scroll) {
            _query.value = ""
            _scrollTo.value = folder
        }
    }

    fun scrolled() {
        _scrollTo.value = null
    }

    private companion object {
        const val SearchDebounceMs = 120L
    }
}
