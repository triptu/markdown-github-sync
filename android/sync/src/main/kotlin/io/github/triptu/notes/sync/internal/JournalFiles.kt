package io.github.triptu.notes.sync.internal

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * File operations behind the engine's FileJournalStore, rooted in app-private
 * storage outside the vault. The store itself writes each record to a
 * temporary name, reads it back and renames it; `write` syncs the bytes to
 * disk and `rename` is atomic, so a crash leaves either the old or the new
 * record, never a torn one.
 */
internal class JournalFiles(private val root: File) {
    init {
        root.mkdirs()
        require(root.isDirectory) { "Journal folder is unavailable: $root" }
    }

    fun call(operation: String, path: String, argument: String?): String = when (operation) {
        "exists" -> resolveBelow(root, path).exists().toString()
        "mkdir" -> {
            val dir = resolveBelow(root, path)
            check(dir.mkdir() || dir.isDirectory) { "Could not create journal folder" }
            syncDirectory(dir.parentFile)
            ""
        }
        "read" -> resolveBelow(root, path).readText(Charsets.UTF_8)
        "write" -> {
            FileOutputStream(resolveBelow(root, path)).use { out ->
                out.write(requireNotNull(argument).toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            ""
        }
        "rename" -> {
            val from = resolveBelow(root, path)
            val to = resolveBelow(root, requireNotNull(argument))
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            syncDirectory(to.parentFile)
            ""
        }
        "list" -> {
            val children = resolveBelow(root, path).listFiles().orEmpty().sortedBy { it.name }
            Json.write(mapOf(
                "files" to children.filter { it.isFile }.map { "$path/${it.name}" },
                "folders" to children.filter { it.isDirectory }.map { "$path/${it.name}" },
            ))
        }
        "remove" -> {
            val file = resolveBelow(root, path)
            check(!file.exists() || file.delete()) { "Could not remove journal file" }
            ""
        }
        else -> error("Unknown journal operation: $operation")
    }
}
