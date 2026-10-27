package io.github.triptu.notes.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.triptu.notes.R
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.PillButton
import io.github.triptu.notes.ui.QuietButton
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType
import io.github.triptu.notes.voice.LanguageOption
import io.github.triptu.notes.voice.Voice
import io.github.triptu.notes.voice.VoiceCopy
import io.github.triptu.notes.voice.VoiceLanguages
import io.github.triptu.notes.voice.VoiceSettings
import kotlinx.coroutines.flow.StateFlow
import java.util.Locale

/** Speaking: the recognition language, and the optional OpenAI key for better transcripts. */
@Composable
internal fun VoiceSettingsSection(voice: Voice, settings: StateFlow<VoiceSettings>, onChange: ((VoiceSettings) -> VoiceSettings) -> Unit) {
    val colors = NotesTheme.colors
    val context = LocalContext.current
    val current by settings.collectAsStateWithLifecycle()
    Section(VoiceCopy.Section)

    var options by remember { mutableStateOf<List<LanguageOption>>(emptyList()) }
    LaunchedEffect(Unit) { options = VoiceLanguages.onDevice(context) }
    var menu by remember { mutableStateOf(false) }
    val chosen = current.language
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).pressable({ menu = true }, bleed = 0.dp, label = VoiceCopy.Language).padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(VoiceCopy.Language, style = NotesType.row, color = colors.ink)
                Text(
                    if (chosen.isEmpty()) VoiceCopy.PhoneDefault else Locale.forLanguageTag(chosen).getDisplayName(Locale.ENGLISH),
                    style = NotesType.rowMeta, color = colors.muted,
                )
            }
            PhIcon(R.drawable.ph_caret_down, null, 18.dp, colors.muted)
        }
        DropdownMenu(menu, { menu = false }, containerColor = colors.raised, shape = RoundedCornerShape(14.dp)) {
            DropdownMenuItem(
                text = { Text(VoiceCopy.PhoneDefault, style = NotesType.row, color = colors.ink) },
                onClick = { menu = false; onChange { it.copy(language = "") } },
            )
            for (option in options) {
                DropdownMenuItem(
                    text = {
                        Text(
                            if (option.installed) option.label else "${option.label} · ${VoiceCopy.Downloading}",
                            style = NotesType.row, color = colors.ink,
                        )
                    },
                    onClick = {
                        menu = false
                        if (!option.installed) VoiceLanguages.download(context, option.tag)
                        onChange { it.copy(language = option.tag) }
                    },
                )
            }
        }
    }
    Hint(VoiceCopy.LanguageHint)

    val hasKey by voice.hasKey.collectAsStateWithLifecycle()
    val refused by voice.keyRefused.collectAsStateWithLifecycle()
    var key by rememberSaveable { mutableStateOf("") }
    Field(VoiceCopy.Key, key, placeholder = if (hasKey) VoiceCopy.KeySaved else VoiceCopy.KeyPlaceholder, secret = true) { key = it }
    if (refused) Text(VoiceCopy.KeyRefused, style = NotesType.rowMeta, color = colors.ink, modifier = Modifier.padding(bottom = 6.dp))
    Hint(VoiceCopy.KeyHint)
    if (key.isNotBlank()) {
        PillButton(VoiceCopy.SaveKey, { voice.saveKey(key); key = "" }, modifier = Modifier.padding(top = 4.dp))
    } else if (hasKey) {
        QuietButton(VoiceCopy.RemoveKey, voice::removeKey, color = colors.ink2)
    }
    if (hasKey) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(top = 8.dp).pressable({ onChange { it.copy(tidy = !it.tidy) } }, bleed = 0.dp, label = VoiceCopy.Tidy).padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = 12.dp)) {
                Text(VoiceCopy.Tidy, style = NotesType.row, color = colors.ink)
                Text(VoiceCopy.TidyHint, style = NotesType.rowMeta, color = colors.muted)
            }
            Switch(
                checked = current.tidy,
                onCheckedChange = { on -> onChange { it.copy(tidy = on) } },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = colors.onSolid, checkedTrackColor = colors.solid,
                    uncheckedThumbColor = colors.muted, uncheckedTrackColor = colors.sunk, uncheckedBorderColor = colors.muted,
                ),
            )
        }
    }
}
