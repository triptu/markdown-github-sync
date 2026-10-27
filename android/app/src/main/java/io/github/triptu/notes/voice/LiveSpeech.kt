package io.github.triptu.notes.voice

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import io.github.triptu.notes.BuildConfig
import java.io.File

/** Why listening stopped on its own. */
enum class SpeechProblem { NoRecognizer, Language, Microphone, Permission, Offline, Interrupted, Failing }

/**
 * Live transcription with Android's recognizer, preferring the on-device one. Listening runs as a
 * chain of recognizer sessions, restarted as each one ends, until [pause] or [release].
 *
 * On Android 13 and later the app owns the microphone ([MicCapture]) and feeds the recognizer
 * through a pipe, asking for one segmented session: no audio is lost between sessions, the
 * waveform shows the real level, and the audio can be kept for the cloud refine. Earlier, the
 * recognizer listens itself and nothing is recorded.
 *
 * Every callback runs on the main thread.
 */
class LiveSpeech(
    private val context: Context,
    private val language: String?,
    recordTo: File?,
    private val events: Events,
) {
    interface Events {
        fun onPartial(session: Int, text: String)
        fun onFinal(session: Int, text: String)
        fun onSessionEnd(session: Int)
        fun onLevel(level: Float)
        fun onProblem(problem: SpeechProblem)
    }

    private val main = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(AudioManager::class.java)
    private var mic: MicCapture? = if (Build.VERSION.SDK_INT >= 33) {
        val test = File(context.cacheDir, "voice-test.pcm").takeIf { BuildConfig.DEBUG && it.isFile }
        MicCapture(recordTo, test) { level -> main.post { events.onLevel(level) } }
    } else {
        null
    }
    private var onDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    private var recognizer: SpeechRecognizer? = null
    private var session = 0
    private var sessionOpen = false
    private var sessionStartedAt = 0L
    private var heardInSession = false
    private var quickFailures = 0
    private var languageRejected = false
    private var downloadAsked = false
    private var pipe: ParcelFileDescriptor? = null

    /** True between [start] and [pause]. */
    var listening = false
        private set

    val recordsAudio: Boolean get() = mic != null

    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener({ change ->
            // A call or another app took the audio: stop listening and keep the words.
            if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                if (listening) {
                    pause()
                    events.onProblem(SpeechProblem.Interrupted)
                }
            }
        }, main)
        .build()

    fun start() {
        if (listening) return
        if (!SpeechRecognizer.isRecognitionAvailable(context) && !onDevice) {
            events.onProblem(SpeechProblem.NoRecognizer)
            return
        }
        // Each start tries the on-device recognizer again: a model may have finished downloading.
        val preferOnDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        if (preferOnDevice != onDevice) {
            onDevice = preferOnDevice
            recognizer?.destroy()
            recognizer = null
        }
        languageRejected = false
        audio.requestAudioFocus(focus)
        mic?.let { m ->
            if (!m.start()) {
                // The app can't open the mic (another app holds it): let the recognizer try.
                m.release()
                mic = null
            }
        }
        listening = true
        quickFailures = 0
        if (!sessionOpen) listen()
    }

    /** Stops listening. Words still being recognized arrive as the session ends. */
    fun pause() {
        if (!listening) return
        listening = false
        audio.abandonAudioFocusRequest(focus)
        val m = mic
        if (m != null) {
            // Closing the pipe ends the recognizer's session with its last words.
            Thread { m.stop() }.start()
        } else {
            recognizer?.stopListening()
        }
        val ending = session
        main.postDelayed({ if (sessionOpen && session == ending && !listening) { recognizer?.cancel(); endSession() } }, EndTimeoutMs)
    }

    /** Stops for good. Returns the recording, if one was made. */
    fun release(): File? {
        listening = false
        audio.abandonAudioFocusRequest(focus)
        main.removeCallbacksAndMessages(null)
        if (sessionOpen) endSession()
        recognizer?.destroy()
        recognizer = null
        return mic?.release().also { mic = null }
    }

    private fun recognizer(): SpeechRecognizer = recognizer ?: (
        if (onDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
    ).also {
        it.setRecognitionListener(Listener())
        recognizer = it
    }

    private fun listen() {
        if (!listening) return
        session++
        sessionOpen = true
        heardInSession = false
        sessionStartedAt = SystemClock.elapsedRealtime()
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Ask the recognizer to wait out thinking pauses; many ignore it, so sessions restart anyway.
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4_000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3_000L)
        if (!language.isNullOrEmpty() && !languageRejected) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        if (Build.VERSION.SDK_INT >= 33) {
            intent.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY)
        }
        val m = mic
        if (m != null && Build.VERSION.SDK_INT >= 33) {
            val read = m.openPipe()
            pipe?.close()
            pipe = read
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, read)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, MicCapture.SampleRate)
                .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
        }
        log("session $session: ${if (onDevice) "on-device" else "default"} recognizer, ${if (m != null) "app mic" else "recognizer mic"}, language ${if (languageRejected) "default" else language ?: "default"}")
        recognizer().startListening(intent)
    }

    private fun endSession() {
        if (!sessionOpen) return
        sessionOpen = false
        pipe?.close()
        pipe = null
        events.onSessionEnd(session)
    }

    /** The session ended: start the next one, unless listening stopped or sessions keep failing at once. */
    private fun next(error: Int?) {
        val quick = SystemClock.elapsedRealtime() - sessionStartedAt < QuickFailureMs && !heardInSession
        endSession()
        if (!listening) return
        quickFailures = if (quick && error != null && error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) quickFailures + 1 else 0
        if (quickFailures >= MaxQuickFailures) {
            pause()
            events.onProblem(SpeechProblem.Failing)
            return
        }
        val delay = if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || quickFailures > 0) 300L * quickFailures.coerceAtLeast(1) else 0L
        main.postDelayed({ if (listening && !sessionOpen) listen() }, delay)
    }

    private fun words(results: Bundle?): String? =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private inner class Listener : RecognitionListener {
        private fun current(): Boolean = sessionOpen

        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit
        override fun onEndOfSpeech() = Unit

        override fun onRmsChanged(rmsdB: Float) {
            // Only when the recognizer owns the mic; otherwise MicCapture reports the level.
            if (mic == null) events.onLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
        }

        override fun onPartialResults(partialResults: Bundle?) {
            if (!current()) return
            val text = words(partialResults) ?: return
            if (text.isNotBlank()) heardInSession = true
            events.onPartial(session, text)
        }

        override fun onSegmentResults(segmentResults: Bundle) {
            if (!current()) return
            val text = words(segmentResults) ?: return
            if (text.isNotBlank()) heardInSession = true
            events.onFinal(session, text)
        }

        override fun onEndOfSegmentedSession() {
            if (!current()) return
            log("session $session: segmented session ended")
            next(null)
        }

        override fun onResults(results: Bundle?) {
            if (!current()) return
            words(results)?.let { events.onFinal(session, it) }
            next(null)
        }

        override fun onError(error: Int) {
            if (!current()) return
            log("session $session: error $error")
            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    endSession()
                    pause()
                    events.onProblem(SpeechProblem.Permission)
                }
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> {
                    // The model isn't on the phone: ask for it once, then fall back to the phone's
                    // default language, then to the default recognizer, then stop.
                    if (onDevice && !downloadAsked) {
                        downloadAsked = true
                        VoiceLanguages.download(context, language ?: java.util.Locale.getDefault().toLanguageTag())
                    }
                    when {
                        !language.isNullOrEmpty() && !languageRejected -> languageRejected = true
                        onDevice -> {
                            onDevice = false
                            recognizer?.destroy()
                            recognizer = null
                        }
                        else -> {
                            endSession()
                            pause()
                            events.onProblem(SpeechProblem.Language)
                            return
                        }
                    }
                    next(null)
                }
                SpeechRecognizer.ERROR_AUDIO -> {
                    endSession()
                    pause()
                    events.onProblem(SpeechProblem.Microphone)
                }
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> {
                    if (onDevice) next(error) else {
                        endSession()
                        pause()
                        events.onProblem(SpeechProblem.Offline)
                    }
                }
                else -> next(error)
            }
        }
    }

    private fun log(line: String) {
        if (BuildConfig.DEBUG) Log.d(Tag, line)
    }

    private companion object {
        const val Tag = "NotesVoice"
        const val EndTimeoutMs = 6_000L
        const val QuickFailureMs = 1_500L
        const val MaxQuickFailures = 4
    }
}
