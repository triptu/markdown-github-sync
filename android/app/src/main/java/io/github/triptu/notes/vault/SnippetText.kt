package io.github.triptu.notes.vault

/** Turns a markdown snippet into display text. */
object SnippetText {
    private val Task = Regex("""^\s*[-*+] \[([ xX])\]\s*""")
    private val Prefix = Regex("""^\s*([-*+]|\d+[.)]|>|#{1,6})\s+""")
    private val AliasLink = Regex("""\[\[[^\]|]*\|([^\]]*)]]""")
    private val Link = Regex("""\[\[([^\]]*)]]""")
    private val Emphasis = Regex("""\*\*|__|(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)|`|==""")

    fun taskState(snippet: String): Boolean? = Task.find(snippet)?.let { it.groupValues[1] != " " }

    fun plain(snippet: String): String = snippet
        .replace(Task, "")
        .replace(Prefix, "")
        .replace(AliasLink, "$1")
        .replace(Link, "$1")
        .replace(Emphasis, "")
        .trim()
}
