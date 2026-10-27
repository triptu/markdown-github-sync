package io.github.triptu.notes.vault

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException

/** Binary cache of the index so launch can show the vault before rescanning it. */
internal object IndexCache {
    private const val Version = 1

    fun read(file: File): VaultSnapshot? {
        if (!file.isFile) return null
        return try {
            DataInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
                if (input.readInt() != Version) return null
                val folderCount = input.readInt()
                val folders = HashSet<FolderPath>(folderCount)
                repeat(folderCount) { folders += FolderPath(input.readString()) }
                val noteCount = input.readInt()
                val notes = HashMap<NotePath, IndexedNote>(noteCount)
                repeat(noteCount) {
                    val path = NotePath(input.readString())
                    notes[path] = IndexedNote(path, input.readLong(), input.readLong(), input.readString(), input.readString())
                }
                VaultSnapshot(notes, folders, isFresh = false)
            }
        } catch (e: IOException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    fun write(file: File, snapshot: VaultSnapshot) {
        val temp = File(file.parentFile, "${file.name}.tmp")
        DataOutputStream(BufferedOutputStream(FileOutputStream(temp))).use { out ->
            out.writeInt(Version)
            out.writeInt(snapshot.folders.size)
            snapshot.folders.forEach { out.writeString(it.value) }
            out.writeInt(snapshot.notes.size)
            snapshot.notes.values.forEach { note ->
                out.writeString(note.path.value)
                out.writeLong(note.modifiedAt)
                out.writeLong(note.size)
                out.writeString(note.snippet)
                out.writeString(note.text)
            }
        }
        if (!temp.renameTo(file)) temp.delete()
    }

    private fun DataOutputStream.writeString(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        writeInt(bytes.size)
        write(bytes)
    }

    private fun DataInputStream.readString(): String {
        val bytes = ByteArray(readInt())
        readFully(bytes)
        return String(bytes, Charsets.UTF_8)
    }
}
