package io.github.triptu.notes.settings

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class PinKeeperTest {
    private fun snapshot(vararg notes: Pair<String, String>): VaultSnapshot {
        val map = notes.associate { (path, text) -> NotePath(path) to IndexedNote(NotePath(path), 0, 0, "", text) }
        val folders = map.keys.map { it.folder }.filterNot { it.isRoot }.toSet()
        return VaultSnapshot(map, folders, isFresh = true)
    }

    @Test
    fun `renamed note and folder keep their pins, deleted ones are dropped`() {
        val before = snapshot("Todos.md" to "milk", "Writing/a.md" to "a", "Work/log.md" to "log", "Old.md" to "old")
        val after = snapshot("Tasks.md" to "milk", "Drafts/a.md" to "a", "Work/log.md" to "log")
        val pins = listOf(
            Pin.Note(NotePath("Todos.md")),
            Pin.Folder(FolderPath("Writing")),
            Pin.Note(NotePath("Old.md")),
            Pin.Folder(FolderPath("Work")),
            Pin.ThisWeek,
        )
        assertEquals(
            listOf(Pin.Note(NotePath("Tasks.md")), Pin.Folder(FolderPath("Drafts")), Pin.Folder(FolderPath("Work")), Pin.ThisWeek),
            PinKeeper.reconcile(pins, before, after),
        )
    }

    @Test
    fun `pins round trip through their stored form and stay typed`() {
        val pins = listOf(Pin.Note(NotePath("Writing.md")), Pin.Folder(FolderPath("Writing")), Pin.ThisWeek)
        assertEquals(pins, pins.map(Pin::encode).map(Pin::decode))
    }
}
