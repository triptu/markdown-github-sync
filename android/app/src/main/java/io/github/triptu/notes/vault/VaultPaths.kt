package io.github.triptu.notes.vault

/** A note's path relative to the vault root, with `/` separators, always ending in `.md`. */
@JvmInline
value class NotePath(val value: String) : Comparable<NotePath> {
    init {
        require(value.endsWith(MD) && !value.startsWith("/")) { "Not a note path: $value" }
    }

    /** File name without `.md`. This is the note's title. */
    val name: String get() = value.substringAfterLast('/').removeSuffix(MD)

    /** The name to show people: [name] without a leading `YYYYMMDDHH ` stamp. */
    val displayName: String get() = NoteNames.display(name)

    val folder: FolderPath get() = FolderPath(value.substringBeforeLast('/', ""))

    fun renamed(newName: String): NotePath = folder.note(newName)

    override fun compareTo(other: NotePath): Int = value.compareTo(other.value, ignoreCase = true)

    override fun toString(): String = value

    companion object {
        const val MD = ".md"
    }
}

/** A folder's path relative to the vault root. The root is the empty string. */
@JvmInline
value class FolderPath(val value: String) {
    init {
        require(!value.startsWith("/") && !value.endsWith("/")) { "Not a folder path: $value" }
    }

    val isRoot: Boolean get() = value.isEmpty()

    val name: String get() = value.substringAfterLast('/')

    val parent: FolderPath? get() = if (isRoot) null else FolderPath(value.substringBeforeLast('/', ""))

    fun child(name: String): FolderPath = FolderPath(if (isRoot) name else "$value/$name")

    fun note(name: String): NotePath = NotePath(if (isRoot) "$name${NotePath.MD}" else "$value/$name${NotePath.MD}")

    /** True if this folder is [other] or sits anywhere below it. */
    fun isWithin(other: FolderPath): Boolean =
        other.isRoot || value == other.value || value.startsWith(other.value + "/")

    override fun toString(): String = value

    companion object {
        val Root = FolderPath("")
    }
}

/** Zettelkasten names start with a `YYYYMMDDHH ` stamp. It stays on disk and is hidden on screen. */
object NoteNames {
    private val Stamp = Regex("""^\d{10} (?=\S)""")

    fun display(name: String): String = name.replaceFirst(Stamp, "")

    /** The stamp with its trailing space, or "" if the name has none. */
    fun stamp(name: String): String = Stamp.find(name)?.value.orEmpty()
}

/** Characters that can't appear in a note name on Android, Obsidian's link syntax, or other platforms. */
private val IllegalNameChars = Regex("""[\\/:*?"<>|#^\[\]]""")

fun sanitizeNoteName(raw: String): String =
    raw.replace(IllegalNameChars, " ").replace(Regex("\\s+"), " ").trim().trimEnd('.')
