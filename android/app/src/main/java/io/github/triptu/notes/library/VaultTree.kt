package io.github.triptu.notes.library

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot

/** One visible row of the Vault tree. */
sealed interface TreeRow {
    val depth: Int
    val key: String

    data class Folder(val path: FolderPath, override val depth: Int, val expanded: Boolean) : TreeRow {
        override val key: String get() = "folder:${path.value}"
    }

    data class Note(val path: NotePath, override val depth: Int) : TreeRow {
        override val key: String get() = "note:${path.value}"
    }
}

/** Flattens the vault into the rows the Vault screen shows: folders first, then notes, open folders expanded in place. */
object VaultTree {
    fun rows(snapshot: VaultSnapshot, expanded: Set<FolderPath>): List<TreeRow> {
        val foldersIn = snapshot.folders.groupBy { it.parent ?: FolderPath.Root }
            .mapValues { (_, list) -> list.sortedWith(compareBy(NaturalOrder) { it.name }) }
        val notesIn = snapshot.notes.keys.groupBy { it.folder }
            .mapValues { (_, list) -> list.sortedWith(compareBy(NaturalOrder) { it.name }) }
        val out = ArrayList<TreeRow>()
        fun add(folder: FolderPath, depth: Int) {
            for (sub in foldersIn[folder].orEmpty()) {
                val open = sub in expanded
                out += TreeRow.Folder(sub, depth, open)
                if (open) add(sub, depth + 1)
            }
            for (note in notesIn[folder].orEmpty()) out += TreeRow.Note(note, depth)
        }
        add(FolderPath.Root, 0)
        return out
    }

    /** Case-insensitive, with runs of digits compared as numbers: "Note 7" before "Note 10". */
    val NaturalOrder: Comparator<String> = Comparator { a, b ->
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            if (a[i].isDigit() && b[j].isDigit()) {
                val si = i
                val sj = j
                while (i < a.length && a[i].isDigit()) i++
                while (j < b.length && b[j].isDigit()) j++
                val na = a.substring(si, i).trimStart('0')
                val nb = b.substring(sj, j).trimStart('0')
                if (na.length != nb.length) return@Comparator na.length - nb.length
                val c = na.compareTo(nb)
                if (c != 0) return@Comparator c
            } else {
                val c = a[i].lowercaseChar().compareTo(b[j].lowercaseChar())
                if (c != 0) return@Comparator c
                i++
                j++
            }
        }
        (a.length - i) - (b.length - j)
    }

    /** The folder and every folder above it, so it can be shown expanded. */
    fun withAncestors(folder: FolderPath): Set<FolderPath> {
        val all = HashSet<FolderPath>()
        var f: FolderPath? = folder
        while (f != null && !f.isRoot) {
            all += f
            f = f.parent
        }
        return all
    }
}
