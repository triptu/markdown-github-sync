package io.github.triptu.notes.vault

data class FolderContents(val folders: List<FolderPath>, val notes: List<NotePath>)

data class SearchHit(val path: NotePath, val excerpt: String)

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

    /** Note names for `[[` autocomplete: names starting with the query first, then names containing it. */
    fun linkSuggestions(snapshot: VaultSnapshot, query: String, limit: Int = 5): List<NotePath> {
        val q = query.trim()
        val all = snapshot.notes.values.asSequence()
        val matching = if (q.isEmpty()) all else all.filter { it.path.name.contains(q, ignoreCase = true) }
        return matching
            .sortedWith(compareBy<IndexedNote> { !it.path.name.startsWith(q, ignoreCase = true) }.thenByDescending { it.modifiedAt })
            .take(limit)
            .map { it.path }
            .toList()
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
