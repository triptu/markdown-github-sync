package io.github.triptu.notes.voice

import android.content.Context
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.triptu.notes.editor.EditorSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.time.LocalDateTime

/** What the speaking view shows. */
sealed interface VoiceState {
    /** Waiting for the microphone permission. [denied]: the user said no. */
    data class NeedsPermission(val denied: Boolean) : VoiceState
    data object Listening : VoiceState
    /** Not listening. [problem] says why, when the user didn't pause. */
    data class Paused(val problem: SpeechProblem? = null) : VoiceState
}

/**
 * One visit to the speaking view: the words heard, the clock, the waveform, and the draft that keeps
 * the words safe until they're saved. [editor] is the note the editor's mic was tapped in, if any.
 * Lives in the ViewModel, on the main thread.
 */
class VoiceSession(
    val target: VoiceTarget,
    val editor: EditorSession?,
    private val context: Context,
    private val language: String?,
    private val record: Boolean,
    private val drafts: DraftStore,
    private val scope: CoroutineScope,
    audioDir: File,
) {
    val startedAt: LocalDateTime = LocalDateTime.now()

    /** Names this recording's draft file. */
    val id: String = "%013d".format(System.currentTimeMillis())
    private val transcript = Transcript()
    private val audioFile = File(audioDir, "voice-${System.currentTimeMillis()}.wav")
    private var speech: LiveSpeech? = null
    private var runningSince = 0L
    private var draftJob: Job? = null
    private var ticker: Job? = null
    /** After [finish], the caller owns the words: no more draft saves. */
    private var finished = false

    var state: VoiceState by mutableStateOf(VoiceState.NeedsPermission(denied = false))
        private set
    var committed by mutableStateOf("")
        private set
    var pending by mutableStateOf("")
        private set
    var separator by mutableStateOf("")
        private set

    /** Time spent listening, not counting pauses. */
    var elapsedMs by mutableLongStateOf(0L)
        private set
    private var elapsedBefore = 0L

    /** The last [Bars] levels, newest last, 0..1. */
    val levels = mutableStateListOf<Float>().apply { repeat(Bars) { add(0f) } }
    private var peak by mutableFloatStateOf(0f)
    private var levelCount = 0

    val text: String get() = transcript.text

    private val events = object : LiveSpeech.Events {
        override fun onPartial(session: Int, text: String) = changed { transcript.onPartial(session, text) }
        override fun onFinal(session: Int, text: String) = changed { transcript.onFinal(session, text) }
        override fun onSessionEnd(session: Int) = changed { transcript.onSessionEnd(session) }

        override fun onLevel(level: Float) {
            peak = maxOf(peak, level)
            // Three 20 ms readings per bar: the waveform moves about 16 bars a second.
            if (++levelCount % 3 != 0) return
            levels.removeAt(0)
            levels.add(peak)
            peak = 0f
        }

        override fun onProblem(problem: SpeechProblem) {
            stopClock()
            state = VoiceState.Paused(problem)
            saveDraftNow()
        }
    }

    /** Called with the permission answer; starts listening when granted. */
    fun permission(granted: Boolean) {
        if (granted) resume() else state = VoiceState.NeedsPermission(denied = true)
    }

    fun resume() {
        val s = speech ?: LiveSpeech(context, language, audioFile.takeIf { record }, events).also { speech = it }
        s.start()
        if (!s.listening) return
        state = VoiceState.Listening
        runningSince = SystemClock.elapsedRealtime()
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                elapsedMs = elapsedBefore + SystemClock.elapsedRealtime() - runningSince
                delay(250)
            }
        }
    }

    fun pause() {
        if (state != VoiceState.Listening) return
        speech?.pause()
        stopClock()
        state = VoiceState.Paused()
        for (i in levels.indices) levels[i] = 0f
        saveDraftNow()
    }

    /** Stops for good and hands back the words and, when one was made, the recording. */
    fun finish(): Pair<String, File?> {
        finished = true
        stopClock()
        val audio = speech?.release()
        draftJob?.cancel()
        speech = null
        transcript.settle()
        return transcript.text to audio
    }

    fun draft(): VoiceDraft = VoiceDraft(target, transcript.text, elapsedMs)

    private fun stopClock() {
        if (ticker == null) return
        ticker?.cancel()
        ticker = null
        elapsedBefore += SystemClock.elapsedRealtime() - runningSince
        elapsedMs = elapsedBefore
    }

    private inline fun changed(update: () -> Unit) {
        update()
        committed = transcript.committed
        pending = transcript.pending
        separator = transcript.pendingSeparator
        // Keep the words safe within a second of hearing them.
        if (!finished && draftJob?.isActive != true) {
            draftJob = scope.launch {
                delay(1_000)
                saveDraftNow()
            }
        }
    }

    private fun saveDraftNow() {
        if (finished) return
        val draft = draft()
        scope.launch(DraftStore.Io) { drafts.save(id, draft) }
    }

    companion object {
        const val Bars = 36
    }
}
