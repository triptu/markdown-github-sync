package io.github.triptu.notes.voice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import io.github.triptu.notes.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.coroutines.resume

/** A language the on-device recognizer knows. [installed]: ready now; otherwise it downloads first. */
data class LanguageOption(val tag: String, val installed: Boolean) {
    val label: String get() = Locale.forLanguageTag(tag).getDisplayName(Locale.ENGLISH)
}

/** Which languages this phone recognizes on-device, and getting one downloaded. */
object VoiceLanguages {
    /** English and Hindi variants first (the ones that matter here), then nothing else, to keep the list short. */
    private fun relevant(tag: String) = tag.startsWith("en") || tag.startsWith("hi")

    suspend fun onDevice(context: Context): List<LanguageOption> {
        if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) return emptyList()
        val support = withContext(Dispatchers.Main) {
            val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            try {
                withTimeoutOrNull(4_000) {
                    suspendCancellableCoroutine<RecognitionSupport?> { done ->
                        recognizer.checkRecognitionSupport(intent(null), context.mainExecutor, object : RecognitionSupportCallback {
                            override fun onSupportResult(recognitionSupport: RecognitionSupport) {
                                if (done.isActive) done.resume(recognitionSupport)
                            }

                            override fun onError(error: Int) {
                                if (done.isActive) done.resume(null)
                            }
                        })
                    }
                }
            } finally {
                recognizer.destroy()
            }
        } ?: return emptyList()
        val installed = support.installedOnDeviceLanguages.toSet()
        val all = (support.installedOnDeviceLanguages + support.pendingOnDeviceLanguages + support.supportedOnDeviceLanguages).distinct()
        if (BuildConfig.DEBUG) {
            Log.d("NotesVoice", "on-device installed=${support.installedOnDeviceLanguages} pending=${support.pendingOnDeviceLanguages} supported=${support.supportedOnDeviceLanguages.size} online=${support.onlineLanguages.size}")
        }
        return all.filter(::relevant).sortedWith(compareBy({ !it.startsWith("en") }, { it })).map { LanguageOption(it, it in installed) }
    }

    /** Asks the on-device recognizer to fetch [tag]'s model in the background. */
    fun download(context: Context, tag: String) {
        if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) return
        val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        try {
            recognizer.triggerModelDownload(intent(tag))
        } catch (e: Exception) {
            // Not offered by this recognizer: recognition falls back to the phone's default language.
        } finally {
            recognizer.destroy()
        }
    }

    private fun intent(tag: String?) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .apply { if (tag != null) putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag) }
}
