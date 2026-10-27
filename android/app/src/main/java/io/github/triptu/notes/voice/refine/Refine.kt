package io.github.triptu.notes.voice.refine

import java.io.File

/** A cloud service that turns a recording into text, and can tidy that text. */
interface RefineProvider {
    /** The recording's words. [languageHint] is a BCP 47 tag such as "en-IN", or null. Throws on failure. */
    suspend fun transcribe(audio: File, languageHint: String?): String

    /** The same words with punctuation fixed and filler words dropped. Throws on failure. */
    suspend fun tidy(text: String): String
}

/** Rules for swapping saved words for refined ones. Pure functions. */
object RefineRules {
    /**
     * [current] with the dictated words [original] replaced by [refined], or null when the words
     * aren't there exactly once: someone edited them since, so theirs stay.
     */
    fun replaceDictated(current: String, original: String, refined: String): String? {
        if (original.isBlank() || refined.isBlank()) return null
        val at = current.indexOf(original)
        if (at < 0 || current.indexOf(original, at + 1) >= 0) return null
        return current.replaceRange(at, at + original.length, refined)
    }

    /**
     * Whether a tidied text is a light edit of [raw]: tidying drops filler words and fixes
     * punctuation, so a much shorter or longer answer means it rewrote something.
     */
    fun isLightEdit(raw: String, tidied: String): Boolean {
        val a = words(raw)
        val b = words(tidied)
        if (b == 0) return a == 0
        return b >= a * 0.6 && b <= a * 1.15 + 2
    }

    private fun words(text: String) = text.split(Regex("\\s+")).count { it.isNotEmpty() }

    /** Recordings bigger than this aren't sent (the transcription service takes up to 25 MB). */
    const val MaxUploadBytes = 24L * 1024 * 1024
}
