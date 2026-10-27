package io.github.triptu.notes.editor

/** A `- [ ]` task. [markerStart] is the bullet, [markerEnd] is just after the space following `]`. */
data class TaskMark(val markerStart: Int, val markerEnd: Int, val checked: Boolean, val lineEnd: Int) {
    /** Index of the character inside the brackets. */
    val stateIndex: Int get() = markerStart + 3
}

/** A `[[target|label]]` link. [labelStart] to [labelEnd] is the text shown when the syntax is hidden. */
data class LinkMark(val start: Int, val end: Int, val labelStart: Int, val labelEnd: Int, val target: String)

data class HeadingMark(val lineStart: Int, val lineEnd: Int, val level: Int, val markerEnd: Int)

data class BulletMark(val index: Int, val lineEnd: Int)

enum class InlineKind { Bold, Italic, BoldItalic, Code }

/** Inline emphasis: [start] to [end] includes the markers, which are [marker] characters long on each side. */
data class InlineMark(val kind: InlineKind, val start: Int, val end: Int, val marker: Int)

data class LineRange(val start: Int, val end: Int)

data class ParsedMarkdown(
    val headings: List<HeadingMark>,
    val tasks: List<TaskMark>,
    val bullets: List<BulletMark>,
    val links: List<LinkMark>,
    val inline: List<InlineMark>,
    val quotes: List<LineRange>,
    val frontmatter: LineRange?,
    /** `<<<<<<< `, `=======` and `>>>>>>> ` lines around both versions of lines edited on two devices. */
    val conflictMarkers: List<LineRange> = emptyList(),
    /** `![](path)` and `![[file]]` embeds, drawn below their line. */
    val images: List<ImageMark> = emptyList(),
)

/** An embedded image: [lineStart]..[lineEnd] is its line, [target] the path or name as written. */
data class ImageMark(val start: Int, val end: Int, val lineStart: Int, val lineEnd: Int, val target: String, val wiki: Boolean)

/** Line-by-line parse of the Obsidian markdown the editor styles. Not a full CommonMark parser. */
object MarkdownParser {
    private val Heading = Regex("""^(#{1,6}) """)
    private val Task = Regex("""^(\s*)[-*+] \[([ xX])\](?: |$)""")
    private val Bullet = Regex("""^(\s*)[-*+] """)
    private val Quote = Regex("""^\s*> ?""")
    private val Image = Regex("""!\[\[([^\[\]\n]+?)]]|!\[[^\]\n]*]\(([^)\n]+)\)""")
    private val ImageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "svg")

    private fun isConflictMarker(line: String) = line.startsWith("<<<<<<< ") || line == "=======" || line.startsWith(">>>>>>> ")

    /** True if [target] names a picture (embeds of notes or PDFs aren't drawn). */
    fun isImage(target: String): Boolean = target.substringAfterLast('.', "").lowercase() in ImageExtensions

    private val Link = Regex("""\[\[([^\[\]\n]+?)]]""")
    private val Code = Regex("""`[^`\n]+`""")
    private val BoldItalic = Regex("""(?<![*\\])\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*(?!\*)""")
    private val Bold = Regex("""(?<![*\\])\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*(?!\*)|(?<![_\w])__(?=\S)(.+?)(?<=\S)__(?![_\w])""")
    private val Italic = Regex("""(?<![*\\\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])|(?<![_\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![_\w])""")

    fun parse(text: String): ParsedMarkdown {
        val headings = ArrayList<HeadingMark>()
        val tasks = ArrayList<TaskMark>()
        val bullets = ArrayList<BulletMark>()
        val links = ArrayList<LinkMark>()
        val inline = ArrayList<InlineMark>()
        val quotes = ArrayList<LineRange>()
        val frontmatter = frontmatterRange(text)
        val markers = ArrayList<LineRange>()
        val images = ArrayList<ImageMark>()

        var lineStart = frontmatter?.end?.let { (it + 1).coerceAtMost(text.length) } ?: 0
        var inFence = false
        while (lineStart <= text.length) {
            val newline = text.indexOf('\n', lineStart)
            val lineEnd = if (newline < 0) text.length else newline
            val line = text.substring(lineStart, lineEnd)
            if (line.trimStart().startsWith("```")) {
                inFence = !inFence
            } else if (!inFence && isConflictMarker(line)) {
                markers += LineRange(lineStart, lineEnd)
            } else if (!inFence) {
                parseLine(line, lineStart, lineEnd, headings, tasks, bullets, quotes)
                parseInline(line, lineStart, links, inline)
                for (m in Image.findAll(line)) {
                    val wiki = m.groupValues[1].isNotEmpty()
                    val raw = if (wiki) m.groupValues[1].substringBefore('|') else m.groupValues[2].trim().removePrefix("<").substringBefore('>').substringBefore(" \"")
                    val target = (if (wiki) raw else runCatching { java.net.URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8") }.getOrDefault(raw)).trim()
                    if (target.isNotEmpty()) images += ImageMark(lineStart + m.range.first, lineStart + m.range.last + 1, lineStart, lineEnd, target, wiki)
                }
            }
            if (newline < 0) break
            lineStart = newline + 1
        }
        return ParsedMarkdown(headings, tasks, bullets, links, inline, quotes, frontmatter, markers, images)
    }

    private fun frontmatterRange(text: String): LineRange? {
        if (!text.startsWith("---\n")) return null
        val close = text.indexOf("\n---", 3)
        if (close < 0) return null
        val end = close + 4
        if (end < text.length && text[end] != '\n') return null
        return LineRange(0, end)
    }

    private fun parseLine(
        line: String, start: Int, end: Int,
        headings: MutableList<HeadingMark>, tasks: MutableList<TaskMark>, bullets: MutableList<BulletMark>, quotes: MutableList<LineRange>,
    ) {
        Heading.find(line)?.let {
            headings += HeadingMark(start, end, it.groupValues[1].length, start + it.range.last + 1)
            return
        }
        Task.find(line)?.let {
            val bullet = start + it.groupValues[1].length
            tasks += TaskMark(bullet, (start + it.range.last + 1).coerceAtMost(end), it.groupValues[2] != " ", end)
            return
        }
        Bullet.find(line)?.let {
            bullets += BulletMark(start + it.groupValues[1].length, end)
            return
        }
        if (Quote.containsMatchIn(line)) quotes += LineRange(start, end)
    }

    private fun parseInline(line: String, offset: Int, links: MutableList<LinkMark>, inline: MutableList<InlineMark>) {
        val taken = ArrayList<IntRange>()
        fun free(range: IntRange) = taken.none { it.first <= range.last && range.first <= it.last }

        for (m in Code.findAll(line)) {
            taken += m.range
            inline += InlineMark(InlineKind.Code, offset + m.range.first, offset + m.range.last + 1, 1)
        }
        for (m in Link.findAll(line)) {
            // `![[file]]` embeds a file; the editor draws it instead of linking.
            if (!free(m.range) || (m.range.first > 0 && line[m.range.first - 1] == '!')) continue
            taken += m.range
            val inner = m.groupValues[1]
            val pipe = inner.indexOf('|')
            val innerStart = offset + m.range.first + 2
            val labelStart = if (pipe >= 0) innerStart + pipe + 1 else innerStart
            val target = if (pipe >= 0) inner.substring(0, pipe) else inner
            links += LinkMark(offset + m.range.first, offset + m.range.last + 1, labelStart, offset + m.range.last - 1, target.trim())
        }
        for ((regex, kind, marker) in listOf(Triple(BoldItalic, InlineKind.BoldItalic, 3), Triple(Bold, InlineKind.Bold, 2), Triple(Italic, InlineKind.Italic, 1))) {
            for (m in regex.findAll(line)) {
                if (!free(m.range)) continue
                taken += m.range
                inline += InlineMark(kind, offset + m.range.first, offset + m.range.last + 1, marker)
            }
        }
    }
}
