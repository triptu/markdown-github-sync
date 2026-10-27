package io.github.triptu.notes.vault

data class FolderContents(val folders: List<FolderPath>, val notes: List<NotePath>)

data class SearchHit(val path: NotePath, val excerpt: String)

/** A `[[` suggestion. [showFolder] when another note has the same title. */
data class LinkSuggestion(val path: NotePath, val showFolder: Boolean)

/** Read-only questions about a [VaultSnapshot]. Pure, so they run off the main thread and test easily. */
object VaultQueries {
    private const val ExcerptLead = 24
    private const val ExcerptLength = 160
    private const val MaxHits = 100

    fun contents(snapshot: VaultSnapshot, folder: FolderPath): FolderContents {
        val folders = snapshot.folders.filter { it.parent == folder }.sortedBy { it.name.lowercase() }
        val notes = snapshot.notes.keys.filter { it.folder == folder }.sortedBy { it.name.lowercase() }
        return FolderContents(folders, notes)
    }

    /** Case-insensitive search over titles and text. Title matches rank first, then newest. */
    fun search(snapshot: VaultSnapshot, rawQuery: String): List<SearchHit> {
        val query = rawQuery.trim()
        if (query.isEmpty()) return emptyList()
        val titleHits = ArrayList<IndexedNote>()
        val textHits = ArrayList<Pair<IndexedNote, Int>>()
        for (note in snapshot.notes.values) {
            if (note.path.name.contains(query, ignoreCase = true)) {
                titleHits += note
            } else {
                val at = note.text.indexOf(query, ignoreCase = true)
                if (at >= 0) textHits += note to at
            }
        }
        val titles = titleHits.sortedByDescending { it.modifiedAt }.map { SearchHit(it.path, SnippetText.plain(firstLine(it.text))) }
        val texts = textHits.sortedByDescending { it.first.modifiedAt }.map { (note, at) -> SearchHit(note.path, excerpt(note.text, at)) }
        return (titles + texts).take(MaxHits)
    }

    /** Finds the note a `[[wikilink]]` points at: an exact path, else a file name match (shortest path wins). */
    fun resolveLink(snapshot: VaultSnapshot, target: String): NotePath? {
        val clean = target.substringBefore('#').substringBefore('|').trim().removeSuffix(NotePath.MD)
        if (clean.isEmpty()) return null
        if (clean.contains('/')) {
            snapshot.notes.keys.firstOrNull { it.value.equals("$clean${NotePath.MD}", ignoreCase = true) }?.let { return it }
        }
        val name = clean.substringAfterLast('/')
        return snapshot.notes.keys.filter { it.name.equals(name, ignoreCase = true) }.minByOrNull { it.value.length }
    }

    /**
     * Notes for `[[` autocomplete, matched on the title people see (no stamp): titles starting
     * with the query, then titles with a word starting with it, then titles containing it.
     * Ties go to the most recently edited. An empty query lists recent notes.
     */
    fun linkSuggestions(snapshot: VaultSnapshot, query: String, exclude: NotePath?, limit: Int = 4): List<LinkSuggestion> {
        val q = query.trim().lowercase()
        val ranked = snapshot.notes.values.asSequence()
            .filter { it.path != exclude }
            .mapNotNull { note -> matchRank(note.path.displayName.lowercase(), q)?.let { note to it } }
            .sortedWith(compareBy<Pair<IndexedNote, Int>> { it.second }.thenByDescending { it.first.modifiedAt })
            .take(limit)
            .map { it.first.path }
            .toList()
        if (ranked.isEmpty()) return emptyList()
        val wanted = ranked.mapTo(HashSet()) { it.displayName.lowercase() }
        val counts = HashMap<String, Int>()
        for (path in snapshot.notes.keys) {
            val title = path.displayName.lowercase()
            if (title in wanted) counts[title] = (counts[title] ?: 0) + 1
        }
        return ranked.map { LinkSuggestion(it, showFolder = (counts[it.displayName.lowercase()] ?: 0) > 1) }
    }

    private val WordStart = Regex("""[^\p{L}\p{N}]+""")

    private fun matchRank(title: String, q: String): Int? = when {
        q.isEmpty() -> 0
        title.startsWith(q) -> 0
        title.split(WordStart).any { it.startsWith(q) } -> 1
        title.contains(q) -> 2
        else -> null
    }

    private fun firstLine(text: String): String =
        text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() && it != "---" && !it.startsWith("#") }.orEmpty()

    /** A one-line excerpt that starts just before the match, so the match is visible. */
    private fun excerpt(text: String, at: Int): String {
        val lineStart = text.lastIndexOf('\n', at - 1) + 1
        var start = maxOf(lineStart, at - ExcerptLead)
        if (start > lineStart) start = text.indexOf(' ', start).let { if (it in start until at) it + 1 else start }
        val end = (at + ExcerptLength).coerceAtMost(text.length)
        val body = SnippetText.plain(text.substring(start, end).replace(Regex("\\s+"), " "))
        return (if (start > lineStart) "…" else "") + body
    }
}
