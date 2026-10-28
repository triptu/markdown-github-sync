package io.github.triptu.notes.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import io.github.triptu.notes.R
import io.github.triptu.notes.capture.CaptureSettings
import io.github.triptu.notes.capture.WeeklyNote
import io.github.triptu.notes.syncing.GitHubSync
import io.github.triptu.notes.ui.IconButton48
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.ReadingColumn
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.voice.Voice
import io.github.triptu.notes.voice.VoiceSettings
import kotlinx.coroutines.flow.StateFlow
import java.time.LocalDateTime

@Composable
fun SettingsScreen(
    capture: CaptureSettings,
    onCapture: ((CaptureSettings) -> CaptureSettings) -> Unit,
    sync: GitHubSync,
    focusToken: Boolean,
    sampleVaultAvailable: Boolean,
    onLoadSampleVault: () -> Unit,
    onBack: () -> Unit,
    voice: Voice? = null,
    voiceSettings: StateFlow<VoiceSettings>? = null,
    onVoiceSettings: ((VoiceSettings) -> VoiceSettings) -> Unit = {},
) {
    val colors = NotesTheme.colors
    ReadingColumn(
        Modifier
            .background(colors.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
    ) {
        Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = PagePadding - 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton48(R.drawable.ph_arrow_left, "Back", onBack)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = PagePadding)) {
            Text("Settings", style = NotesType.title, color = colors.ink, modifier = Modifier.padding(top = 6.dp))

            SyncSection(sync, focusToken)

            Section("New note")
            Field("Folder", capture.newNoteFolder) { v -> onCapture { it.copy(newNoteFolder = v) } }
            Hint("Named by the hour and the first words, like “2026102709 Call the bank”.")
            Field("Template", capture.newNoteTemplate) { v -> onCapture { it.copy(newNoteTemplate = v) } }
            Hint("New notes start with this note's text, if it exists. Leave empty to start blank.")

            if (voice != null && voiceSettings != null) VoiceSettingsSection(voice, voiceSettings, onVoiceSettings)

            Section("This week")
            Field("Folder", capture.weeklyFolder) { v -> onCapture { it.copy(weeklyFolder = v) } }
            Field("Name format", capture.weeklyFormat) { v -> onCapture { it.copy(weeklyFormat = v) } }
            Hint("Same format as Obsidian's Periodic Notes. This week: ${runCatching { WeeklyNote.pathFor(LocalDateTime.now(), capture).value }.getOrDefault("–")}")
            Field("Template", capture.weeklyTemplate) { v -> onCapture { it.copy(weeklyTemplate = v) } }
            Hint("Used when this week's note doesn't exist yet. The This week pin opens it at the end of “Notes and Ramblings”.")

            if (sampleVaultAvailable) {
                Section("Testing")
                var loaded by remember { mutableStateOf(false) }
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).pressable({ onLoadSampleVault(); loaded = true }, bleed = 0.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(if (loaded) "Sample vault loaded" else "Load sample vault", style = NotesType.row, color = colors.ink)
                        Text("Adds about 40 made-up notes and pins. Debug builds only.", style = NotesType.rowMeta, color = colors.muted)
                    }
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
internal fun Section(text: String) {
    // Heavier than the field labels under it, with more room above than between its fields.
    Text(text, style = NotesType.row.copy(fontWeight = FontWeight.SemiBold), color = NotesTheme.colors.ink, modifier = Modifier.padding(top = 32.dp, bottom = 4.dp))
}

@Composable
internal fun Label(text: String) {
    Text(text, style = NotesType.rowMeta, color = NotesTheme.colors.ink2, modifier = Modifier.padding(top = 6.dp, bottom = 6.dp))
}

@Composable
internal fun Hint(text: String) {
    Text(text, style = NotesType.rowMeta, color = NotesTheme.colors.muted, modifier = Modifier.padding(bottom = 6.dp))
}

/** A labelled text field that saves as you type. */
@Composable
internal fun Field(
    label: String,
    value: String,
    placeholder: String = "",
    secret: Boolean = false,
    focus: FocusRequester? = null,
    modifier: Modifier = Modifier,
    onChange: (String) -> Unit,
) {
    val colors = NotesTheme.colors
    Label(label)
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = NotesType.field.copy(color = colors.ink),
        cursorBrush = SolidColor(colors.ink),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)
        else KeyboardOptions(autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty() && placeholder.isNotEmpty()) Text(placeholder, style = NotesType.field, color = colors.muted)
                inner()
            }
        },
        modifier = modifier
            .fillMaxWidth()
            .then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.raised)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    )
}
