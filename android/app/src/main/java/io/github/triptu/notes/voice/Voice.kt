package io.github.triptu.notes.voice

import android.content.Context
import android.util.Log
import io.github.triptu.notes.BuildConfig
import io.github.triptu.notes.capture.CaptureService
import io.github.triptu.notes.settings.SettingsStore
import io.github.triptu.notes.syncing.TokenVault
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultStore
import io.github.triptu.notes.voice.refine.OpenAiProvider
import io.github.triptu.notes.voice.refine.RefineProvider
import io.github.triptu.notes.voice.refine.RefineRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDateTime

data class VoiceSettings(
    /** BCP 47 tag such as "en-IN"; empty means the phone's default. */
    val language: String = "",
    /** After the cloud transcript, also tidy filler words and punctuation. */
    val tidy: Boolean = true,
)

/** Speaking notes: the draft, the OpenAI key, and the cloud refine that runs after Save. */
class Voice(
    context: Context,
    private val store: VaultStore,
    private val capture: CaptureService,
    private val settings: SettingsStore,
    private val scope: CoroutineScope,
) {
    val drafts = DraftStore(File(context.filesDir, "voice-drafts"))
    val audioDir = File(context.cacheDir, "voice")
    private val keys = TokenVault(File(context.noBackupFilesDir, "openai-key"), alias = "openai-key")
    private val provider: RefineProvider = OpenAiProvider { keys.read() }

    private val _draft = MutableStateFlow<Pair<String, VoiceDraft>?>(null)
    /** The unsaved words Home offers to keep, with their recording's id. */
    val draft: StateFlow<Pair<String, VoiceDraft>?> = _draft.asStateFlow()

    private val _hasKey = MutableStateFlow(false)
    val hasKey: StateFlow<Boolean> = _hasKey.asStateFlow()

    private val _keyRefused = MutableStateFlow(false)
    /** OpenAI turned the key down at the last refine. */
    val keyRefused: StateFlow<Boolean> = _keyRefused.asStateFlow()

    init {
        scope.launch(DraftStore.Io) {
            _hasKey.value = keys.read() != null
            // Recordings left by a refine the app didn't live to finish.
            audioDir.listFiles()?.forEach { it.delete() }
            _draft.value = drafts.newest()
        }
    }

    /** Drops recording [id]'s draft, then shows the next one, if any. */
    fun dropDraft(id: String) {
        if (_draft.value?.first == id) _draft.value = null
        scope.launch(DraftStore.Io) {
            drafts.clear(id)
            _draft.value = drafts.newest()
        }
    }

    /** Keeps recording [id]'s words as a draft and shows it. */
    fun keepDraft(id: String, draft: VoiceDraft) {
        scope.launch(DraftStore.Io) {
            drafts.save(id, draft)
            _draft.value = drafts.newest()
        }
    }

    fun saveKey(key: String) {
        scope.launch(DraftStore.Io) {
            keys.write(key.trim())
            _hasKey.value = true
            _keyRefused.value = false
        }
    }

    fun removeKey() {
        scope.launch(DraftStore.Io) {
            keys.clear()
            _hasKey.value = false
            _keyRefused.value = false
        }
    }

    /** Whether Save should keep the recording for [refine]. */
    val refining: Boolean get() = _hasKey.value

    /**
     * Sends [audio] to the provider and swaps [original] in the note for the result, if the
     * words are still there untouched. [locate] finds the note once the words are saved. A new
     * note ([newNote]) is renamed from its refined first words. The recording is always deleted.
     */
    fun refine(audio: File, original: String, newNote: Pair<FolderPath, LocalDateTime>?, locate: suspend () -> NotePath?) {
        scope.launch {
            try {
                if (!_hasKey.value || original.isBlank() || audio.length() > RefineRules.MaxUploadBytes) return@launch
                val voice = settings.voice.value
                var refined = provider.transcribe(audio, voice.language.ifEmpty { null })
                if (voice.tidy && refined.isNotBlank()) {
                    val tidied = runCatching { provider.tidy(refined) }.getOrNull()
                    if (tidied != null && RefineRules.isLightEdit(refined, tidied)) refined = tidied
                }
                log("refined: ${original.length} to ${refined.length} characters")
                if (refined.isBlank() || refined == original) return@launch
                val path = withContext(kotlinx.coroutines.Dispatchers.Main) { locate() } ?: return@launch
                val current = store.read(path) ?: return@launch
                val next = RefineRules.replaceDictated(current, original, refined) ?: return@launch log("kept the edited text")
                if (newNote != null && current == original) capture.saveNewNote(newNote.first, path, next, newNote.second) else store.write(path, next)
            } catch (e: OpenAiProvider.ProviderError) {
                if (e.code == 401) _keyRefused.value = true
                log("refine failed: ${e.code}")
            } catch (e: Exception) {
                log("refine failed: ${e.javaClass.simpleName}")
            } finally {
                audio.delete()
            }
        }
    }

    private fun log(line: String) {
        if (BuildConfig.DEBUG) Log.d("NotesVoice", line)
    }
}
