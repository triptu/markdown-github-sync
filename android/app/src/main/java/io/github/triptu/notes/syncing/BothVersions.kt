package io.github.triptu.notes.syncing

/**
 * Settles a note edited here and on GitHub at the same time without asking: lines only one side
 * changed are merged, and where both changed the same lines, both versions stay in the note
 * between Git's conflict markers, which Obsidian and other editors read as a conflict:
 *
 * ```
 * <<<<<<< This phone
 * the line as edited here
 *
 * =======
 * the line as edited on GitHub
 * >>>>>>> GitHub
 * ```
 *
 * A blank line goes before `=======` so Markdown doesn't read it as a heading underline.
 */
object BothVersions {
    const val Mine = "<<<<<<< This phone"
    const val Divider = "======="
    const val Theirs = ">>>>>>> GitHub"

    private val StartMarker = Regex("""(?m)^<<<<<<< """)
    private val EndMarker = Regex("""(?m)^>>>>>>> """)

    /** True if [text] still holds both versions of some lines. */
    fun hasMarkers(text: String): Boolean = text.contains("<<<<<<< ") && StartMarker.containsMatchIn(text) && EndMarker.containsMatchIn(text)

    /** [base] is the last version both sides agreed on; null when each side created the note on its own. */
    fun merge(base: String?, local: String, remote: String): String {
        if (local == remote) return local
        val mine = splitLines(local)
        val theirs = splitLines(remote)
        val out = StringBuilder()
        if (base == null) {
            // No common ancestor: keep shared lines once, and both versions of the rest.
            val hunks = diff(mine, theirs) ?: return block(out, mine, theirs).toString()
            var position = 0
            for (hunk in hunks) {
                mine.subList(position, hunk.start).forEach(out::append)
                block(out, mine.subList(hunk.start, hunk.end), hunk.lines)
                position = hunk.end
            }
            mine.subList(position, mine.size).forEach(out::append)
            return out.toString()
        }
        val lines = splitLines(base)
        val localHunks = diff(lines, mine)
        val remoteHunks = diff(lines, theirs)
        if (localHunks == null || remoteHunks == null) return block(out, mine, theirs).toString()
        val all = (localHunks.map { it to 0 } + remoteHunks.map { it to 1 })
            .sortedWith(compareBy({ it.first.start }, { it.first.end }))
        var position = 0
        var at = 0
        while (at < all.size) {
            val group = mutableListOf(all[at])
            var end = all[at].first.end
            var next = at + 1
            // Closed intervals, as the engine merges: touching edits from both sides collide.
            while (next < all.size && all[next].first.start <= end) {
                group += all[next]
                end = maxOf(end, all[next].first.end)
                next++
            }
            val start = group.first().first.start
            val sides = group.map { it.second }.toSet()
            val same = group.size == 2 && group[0].first == group[1].first
            if (sides.size == 1 || same) {
                for ((hunk, _) in if (same) group.take(1) else group) {
                    lines.subList(position, hunk.start).forEach(out::append)
                    hunk.lines.forEach(out::append)
                    position = hunk.end
                }
            } else {
                lines.subList(position, start).forEach(out::append)
                val here = apply(lines, start, end, group.filter { it.second == 0 }.map { it.first })
                val there = apply(lines, start, end, group.filter { it.second == 1 }.map { it.first })
                if (here == there) here.forEach(out::append) else block(out, here, there)
                position = end
            }
            at = next
        }
        lines.subList(position, lines.size).forEach(out::append)
        return out.toString()
    }

    /** One side's version of `base[start, end)`. */
    private fun apply(base: List<String>, start: Int, end: Int, hunks: List<Hunk>): List<String> {
        val result = ArrayList<String>()
        var position = start
        for (hunk in hunks) {
            result += base.subList(position, hunk.start)
            result += hunk.lines
            position = hunk.end
        }
        result += base.subList(position, end)
        return result
    }

    private fun block(out: StringBuilder, here: List<String>, there: List<String>): StringBuilder {
        if (out.isNotEmpty() && out.last() != '\n') out.append('\n')
        out.append(Mine).append('\n')
        appendLines(out, here)
        val previous = out.lineBefore()
        if (previous.isNotBlank()) out.append('\n')
        out.append(Divider).append('\n')
        appendLines(out, there)
        out.append(Theirs).append('\n')
        return out
    }

    private fun appendLines(out: StringBuilder, lines: List<String>) {
        lines.forEach(out::append)
        if (lines.isNotEmpty() && !lines.last().endsWith("\n")) out.append('\n')
    }

    /** The last full line of [this], which ends with a newline. */
    private fun StringBuilder.lineBefore(): String {
        val end = length - 1
        val start = lastIndexOf("\n", end - 1) + 1
        return substring(start, end)
    }

    /** Lines keep their terminators, so a missing final newline survives. */
    internal fun splitLines(text: String): List<String> {
        val lines = ArrayList<String>()
        var start = 0
        for (i in text.indices) {
            if (text[i] == '\n') {
                lines += text.substring(start, i + 1)
                start = i + 1
            }
        }
        if (start < text.length) lines += text.substring(start)
        return lines
    }

    /** `a[start, end)` is replaced by [lines]. */
    internal data class Hunk(val start: Int, val end: Int, val lines: List<String>)

    private const val MaxEdits = 20_000

    /** Myers diff from [a] to [b] as replaced ranges of [a]; null past [MaxEdits]. */
    internal fun diff(a: List<String>, b: List<String>): List<Hunk>? {
        val n = a.size
        val m = b.size
        val max = n + m
        val offset = max + 1
        val v = IntArray(2 * max + 3)
        val trace = ArrayList<IntArray>()
        var found = -1
        var d = 0
        while (d <= minOf(max, MaxEdits) && found < 0) {
            var k = -d
            while (k <= d) {
                var x = if (d == 0) 0 else if (k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1])) v[offset + k + 1] else v[offset + k - 1] + 1
                var y = x - k
                while (x < n && y < m && a[x] == b[y]) {
                    x++
                    y++
                }
                v[offset + k] = x
                if (x >= n && y >= m) found = d
                k += 2
            }
            trace += v.copyOfRange(offset - d, offset + d + 1)
            d++
        }
        if (found < 0) return null

        val matches = ArrayList<IntArray>()
        var x = n
        var y = m
        for (step in found downTo 1) {
            val previous = trace[step - 1]
            fun at(k: Int) = previous[k + step - 1]
            val k = x - y
            val priorK = if (k == -step || (k != step && at(k - 1) < at(k + 1))) k + 1 else k - 1
            val priorX = at(priorK)
            val priorY = priorX - priorK
            while (x > priorX && y > priorY) matches += intArrayOf(--x, --y)
            x = priorX
            y = priorY
        }
        while (x > 0 && y > 0) matches += intArrayOf(--x, --y)
        matches.reverse()

        val hunks = ArrayList<Hunk>()
        var ai = 0
        var bi = 0
        for (match in matches + listOf(intArrayOf(n, m))) {
            if (match[0] > ai || match[1] > bi) hunks += Hunk(ai, match[0], b.subList(bi, match[1]))
            ai = match[0] + 1
            bi = match[1] + 1
        }
        return hunks
    }
}
