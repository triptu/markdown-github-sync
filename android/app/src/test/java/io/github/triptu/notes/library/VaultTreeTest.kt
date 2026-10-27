package io.github.triptu.notes.library

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class VaultTreeTest {
    private val snapshot = run {
        val notes = listOf("Todos.md", "journal/2026/weekly/W44.md", "journal/Index.md", "Writing/Draft.md").map(::NotePath)
        val folders = setOf("journal", "journal/2026", "journal/2026/weekly", "Writing", "Empty").map(::FolderPath).toSet()
        VaultSnapshot(notes.associateWith { IndexedNote(it, 0, 0, "", "") }, folders, isFresh = true)
    }

    private fun List<TreeRow>.describe() = map {
        when (it) {
            is TreeRow.Folder -> "  ".repeat(it.depth) + (if (it.expanded) "v " else "> ") + it.path.name
            is TreeRow.Note -> "  ".repeat(it.depth) + it.path.name
        }
    }

    @Test
    fun `closed folders hide their contents, open ones nest in place`() {
        assertEquals(listOf("> Empty", "> journal", "> Writing", "Todos"), VaultTree.rows(snapshot, emptySet()).describe())
        val open = VaultTree.withAncestors(FolderPath("journal/2026/weekly"))
        assertEquals(
            listOf("> Empty", "v journal", "  v 2026", "    v weekly", "      W44", "  Index", "> Writing", "Todos"),
            VaultTree.rows(snapshot, open).describe(),
        )
    }
}
