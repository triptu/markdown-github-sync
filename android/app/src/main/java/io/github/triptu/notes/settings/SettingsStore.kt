package io.github.triptu.notes.settings

import android.content.SharedPreferences
import androidx.core.content.edit
import io.github.triptu.notes.capture.CaptureSettings
import io.github.triptu.notes.vault.NotePath
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * App settings in SharedPreferences. Read once at startup (small and fast), so Home can draw its
 * pins on the first frame without touching the vault.
 */
class SettingsStore(private val prefs: SharedPreferences) {
    private val _pins = MutableStateFlow(readPins())
    val pins: StateFlow<List<Pin>> = _pins.asStateFlow()

    private val _capture = MutableStateFlow(readCapture())
    val capture: StateFlow<CaptureSettings> = _capture.asStateFlow()

    /** True while the debug sample vault fills the vault folder; setting up sync clears it. */
    val sampleVaultLoaded: Boolean get() = prefs.getBoolean(Keys.SampleVault, false)

    fun setSampleVaultLoaded(loaded: Boolean) = prefs.edit { putBoolean(Keys.SampleVault, loaded) }

    /** Back to a fresh install's pins: just This week. */
    fun resetPins() {
        _pins.value = listOf(Pin.ThisWeek)
        prefs.edit { remove(Keys.Pins) }
    }

    fun isPinned(pin: Pin): Boolean = pin in _pins.value

    fun togglePin(pin: Pin) = setPins(if (isPinned(pin)) _pins.value - pin else _pins.value + pin)

    fun setPins(pins: List<Pin>) {
        val distinct = pins.distinct()
        _pins.value = distinct
        prefs.edit { putString(Keys.Pins, distinct.joinToString("\n", transform = Pin::encode)) }
    }

    fun onNoteRenamed(from: NotePath, to: NotePath) {
        if (_pins.value.none { it == Pin.Note(from) }) return
        setPins(_pins.value.map { if (it == Pin.Note(from)) Pin.Note(to) else it })
    }

    fun updateCapture(edit: (CaptureSettings) -> CaptureSettings) {
        _capture.update(edit)
        val c = _capture.value
        prefs.edit {
            putString(Keys.NewNoteFolder, c.newNoteFolder)
            putString(Keys.WeeklyFolder, c.weeklyFolder)
            putString(Keys.WeeklyFormat, c.weeklyFormat)
            putString(Keys.WeeklyTemplate, c.weeklyTemplate)
        }
    }

    /** Before the user has pinned anything, Home shows this week's note. */
    private fun readPins(): List<Pin> {
        val stored = prefs.getString(Keys.Pins, null) ?: return listOf(Pin.ThisWeek)
        return stored.lines().mapNotNull(Pin::decode)
    }

    private fun readCapture(): CaptureSettings {
        val d = CaptureSettings()
        return CaptureSettings(
            newNoteFolder = prefs.getString(Keys.NewNoteFolder, null) ?: d.newNoteFolder,
            weeklyFolder = prefs.getString(Keys.WeeklyFolder, null) ?: d.weeklyFolder,
            weeklyFormat = prefs.getString(Keys.WeeklyFormat, null) ?: d.weeklyFormat,
            weeklyTemplate = prefs.getString(Keys.WeeklyTemplate, null) ?: d.weeklyTemplate,
        )
    }

    private object Keys {
        const val Pins = "pins"
        const val SampleVault = "sampleVault"
        const val NewNoteFolder = "capture.newNoteFolder"
        const val WeeklyFolder = "capture.weeklyFolder"
        const val WeeklyFormat = "capture.weeklyFormat"
        const val WeeklyTemplate = "capture.weeklyTemplate"
    }
}
