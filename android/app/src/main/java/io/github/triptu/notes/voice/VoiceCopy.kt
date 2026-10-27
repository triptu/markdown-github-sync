package io.github.triptu.notes.voice

import java.util.Locale

/** Every sentence the app shows about speaking notes, in one place. Short and plain. */
object VoiceCopy {
    const val Close = "Close"
    const val Pause = "Pause"
    const val Resume = "Resume"
    const val Save = "Save"
    const val Type = "Type"
    const val StartTalking = "Start talking"
    const val Paused = "Paused"

    const val MicReason = "To write down what you say, Notes needs the microphone."
    const val AllowMic = "Allow microphone"

    fun problem(problem: SpeechProblem): String = when (problem) {
        SpeechProblem.NoRecognizer -> "This phone has no speech recognition."
        SpeechProblem.Language -> "This language isn't ready on this phone yet. It may still be downloading, or pick another in Settings."
        SpeechProblem.Microphone -> "Can't use the microphone right now."
        SpeechProblem.Permission -> MicReason
        SpeechProblem.Offline -> "Speech recognition needs the internet on this phone."
        SpeechProblem.Interrupted -> "Paused for another app."
        SpeechProblem.Failing -> "Speech recognition stopped working. Try again in a moment."
    }

    fun unsaved(elapsedMs: Long) = "Unsaved recording, ${clock(elapsedMs)}"
    const val Keep = "Keep"
    const val Discard = "Discard"

    fun clock(ms: Long): String {
        val seconds = ms / 1000
        return "%d:%02d".format(Locale.ROOT, seconds / 60, seconds % 60)
    }

    // Settings
    const val Section = "Speaking"
    const val Language = "Language"
    const val PhoneDefault = "Phone default"
    const val LanguageHint = "Recognized on this phone. Nothing is sent anywhere unless you add a key below."
    const val Downloading = "downloads first"
    const val Key = "OpenAI key"
    const val KeyPlaceholder = "sk-…"
    const val KeySaved = "Saved on this phone"
    const val KeyHint = "Optional. After you save a spoken note, its recording is sent to OpenAI for a more accurate transcript, " +
        "which replaces the words if you haven't changed them. The recording is deleted after. The key stays on this phone, encrypted."
    const val SaveKey = "Save key"
    const val RemoveKey = "Remove key"
    const val Tidy = "Tidy the text"
    const val TidyHint = "Also asks OpenAI to fix punctuation and drop filler words like “um”. It never rewrites what you said."
    const val KeyRefused = "OpenAI didn't accept this key."
}
