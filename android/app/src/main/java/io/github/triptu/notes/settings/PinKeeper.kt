package io.github.triptu.notes.settings

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot

/**
 * Keeps pins pointing at things that exist when the vault changes underneath the app.
 *
 * A pinned note that disappeared follows a note that appeared with the same text (a rename).
 * A pinned folder that disappeared follows a folder that appeared holding the same note names.
 * Anything else that disappeared is unpinned, so Home never shows a dead row.
 */
object PinKeeper {
    fun reconcile(pins: List<Pin>, previous: VaultSnapshot, current: VaultSnapshot): List<Pin> = pins.mapNotNull { pin ->
        when (pin) {
            is Pin.Note -> if (pin.path in current.notes) pin else movedNote(pin.path, previous, current)?.let(Pin::Note)
            is Pin.Folder -> if (pin.path in current.folders) pin else movedFolder(pin.path, previous, current)?.let(Pin::Folder)
        }
    }.distinct()

    private fun movedNote(path: NotePath, previous: VaultSnapshot, current: VaultSnapshot): NotePath? {
        val text = previous.notes[path]?.text ?: return null
        return current.notes.values.singleOrNull { it.path !in previous.notes && it.text == text }?.path
    }

    private fun movedFolder(path: FolderPath, previous: VaultSnapshot, current: VaultSnapshot): FolderPath? {
        val names = noteNamesIn(path, previous)
        if (names.isEmpty()) return null
        return current.folders.singleOrNull { it !in previous.folders && noteNamesIn(it, current) == names }
    }

    private fun noteNamesIn(folder: FolderPath, snapshot: VaultSnapshot): Set<String> =
        snapshot.notes.keys.filter { it.folder == folder }.mapTo(HashSet()) { it.name }
}
