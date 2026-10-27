package io.github.triptu.notes

import android.content.Context
import io.github.triptu.notes.capture.CaptureService
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import io.github.triptu.notes.library.ExpandedFolders
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.settings.PinKeeper
import io.github.triptu.notes.settings.SettingsStore
import io.github.triptu.notes.vault.FileVaultStore
import io.github.triptu.notes.vault.VaultChange
import io.github.triptu.notes.vault.VaultIndex
import io.github.triptu.notes.vault.VaultSnapshot
import io.github.triptu.notes.vault.VaultStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

/** The app's long-lived objects, wired by hand. */
class AppGraph(context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Outlives any screen. Final editor saves run here, on the main thread like the editor's state. */
    val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val vaultRoot = File(context.filesDir, "vault")
    val store: VaultStore = FileVaultStore(vaultRoot)
    val index = VaultIndex(store, File(context.cacheDir, "vault-index.bin"), scope)
    val settings = SettingsStore(context.getSharedPreferences("settings", Context.MODE_PRIVATE))
    val capture = CaptureService(store) { settings.capture.value }
    val expandedFolders = ExpandedFolders(
        PreferenceDataStoreFactory.create(scope = scope) { context.preferencesDataStoreFile("library") },
        scope,
    )

    fun start() {
        index.start()
        scope.launch { keepPinsAlive() }
        scope.launch {
            store.changes.collect { change ->
                if (change is VaultChange.Renamed) settings.onNoteRenamed(change.from, change.to)
            }
        }
    }

    /**
     * Re-points or drops pins, and the Library's open folders, whenever a fresh snapshot shows
     * their note or folder gone.
     */
    private suspend fun keepPinsAlive() {
        var previous: VaultSnapshot = VaultSnapshot.Empty
        index.snapshot.collect { current ->
            if (current.isFresh) {
                val pins = settings.pins.value
                val kept = PinKeeper.reconcile(pins, previous, current)
                if (kept != pins) settings.setPins(kept)
                val open = expandedFolders.expanded.value
                val stillOpen = PinKeeper.reconcile(open.map(Pin::Folder), previous, current)
                    .filterIsInstance<Pin.Folder>().mapTo(HashSet()) { it.path }
                if (stillOpen != open) expandedFolders.set(stillOpen)
            }
            previous = current
        }
    }
}
