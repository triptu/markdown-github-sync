package io.github.triptu.notes.vault

/** Turns markdown into plain prose for previews: no markers, links shown as their titles. */
object SnippetText {
    private val Task = Regex("""^\s*[-*+] \[([ xX])\]\s*""")
    private val Prefix = Regex("""(^|\n)\s*([-*+]|\d+[.)]|>|#{1,6})\s+""")
    private val Link = Regex("""\[\[([^\]|]*)(?:\|([^\]]*))?]]""")
    private val MarkdownLink = Regex("""\[([^\]]*)]\([^)]*\)""")
    private val Emphasis = Regex("""\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)|`|==|~~""")
    private val Space = Regex("""\s+""")

    fun taskState(snippet: String): Boolean? = Task.find(snippet)?.let { it.groupValues[1] != " " }

    fun plain(snippet: String): String = snippet
        .replace(Task, "")
        .replace(Prefix, "$1")
        .replace(Link) { m -> m.groupValues[2].ifEmpty { linkTitle(m.groupValues[1]) } }
        .replace(MarkdownLink, "$1")
        .replace(Emphasis, "")
        .replace(Space, " ")
        .trim()

    /** `folder/2026101409 Attention is the real budget#Heading` shows as "Attention is the real budget". */
    private fun linkTitle(target: String): String =
        NoteNames.display(target.substringBefore('#').substringAfterLast('/').removeSuffix(NotePath.MD).trim())

    /** True for lines that only hold links or a `Label:` with links, such as "Links: [[a]], [[b]]". */
    fun isOnlyLinks(line: String): Boolean {
        if (!Link.containsMatchIn(line)) return false
        val rest = line.replace(Link, "").replace(Regex("""^\s*([-*+]\s+)?[\p{L} ]{1,24}:"""), "")
        return rest.none { it.isLetterOrDigit() }
    }
}
