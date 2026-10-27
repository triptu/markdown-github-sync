package io.github.triptu.notes.quick

import io.github.triptu.notes.capture.ZettelName
import java.net.URI
import java.time.LocalDateTime

/**
 * Text another app shared. [body] is what goes into the note; [title] names a new note: the page
 * title for a shared link, else null (the note is named from [body]'s first words).
 */
data class SharedText(val body: String, val title: String?, val url: String?) {
    /** A new note's name: `YYYYMMDDHH <first words>`, from the page title, else the text, else the link's site. */
    fun noteName(now: LocalDateTime): String {
        val words = when {
            title != null -> title
            url != null && body == url -> host(url)
            else -> body
        }
        return ZettelName.of(now, words)
    }

    companion object {
        private val Url = Regex("""https?://\S+""")
        private val TitleTrail = Regex("""[\s\-–—:|]+$""")
        private const val MaxTitle = 200

        /**
         * Reads a share. A lone link with a page title (the share's subject, or one line of text
         * before the link) becomes `[title](url)`. Anything else is kept as it came. Null when empty.
         */
        fun of(text: String?, subject: String?): SharedText? {
            val trimmed = text?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            val urls = Url.findAll(trimmed).toList()
            val link = urls.singleOrNull()?.takeIf { it.range.last == trimmed.lastIndex } ?: return SharedText(trimmed, null, null)
            val url = link.value
            val before = trimmed.substring(0, link.range.first).replace(TitleTrail, "").trim()
            if (before.contains('\n') || before.length > MaxTitle) return SharedText(trimmed, null, null)
            val title = subject?.trim()?.takeIf { it.isNotEmpty() && it != url && !it.contains('\n') } ?: before.ifEmpty { null }
            if (title == null) return SharedText(url, null, url)
            return SharedText("[${escape(title)}](${escapeUrl(url)})", title, url)
        }

        /** [existing] with [piece] added at the end after a blank line. */
        fun append(existing: String?, piece: String): String {
            val base = existing.orEmpty().trimEnd('\n', '\r')
            return if (base.isBlank()) "$piece\n" else "$base\n\n$piece\n"
        }

        private fun escape(title: String) = title.replace("[", "\\[").replace("]", "\\]")

        private fun escapeUrl(url: String) = url.replace("(", "%28").replace(")", "%29")

        private fun host(url: String): String =
            runCatching { URI(url).host }.getOrNull()?.removePrefix("www.") ?: url
    }
}
