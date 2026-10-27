package io.github.triptu.notes.sync

import io.github.triptu.notes.sync.internal.gitBlobOid
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

class VaultFilesTest {
    private val dir = Files.createTempDirectory("vault-files").toFile()
    private val vault = VaultFiles(File(dir, "vault"))

    @After
    fun tearDown() { dir.deleteRecursively() }

    private fun oid(text: String) = gitBlobOid(text.toByteArray())
    private fun data(text: String) = Base64.getEncoder().encodeToString(text.toByteArray())

    @Test
    fun applyIsCompareAndSwap() {
        assertEquals("applied", vault.apply("a/b.md", null, data("one"), oid("one"), false))
        assertEquals("one", vault.readText("a/b.md"))
        // The user edited the file after sync captured it: nothing is written.
        vault.writeText("a/b.md", "user edit")
        assertEquals("changed", vault.apply("a/b.md", oid("one"), data("two"), oid("two"), false))
        assertEquals("user edit", vault.readText("a/b.md"))
        // Creating over an existing file is also a change.
        assertEquals("changed", vault.apply("a/b.md", null, data("two"), oid("two"), false))
        // Already at the target: idempotent replay after a crash.
        assertEquals("applied", vault.apply("a/b.md", oid("one"), data("user edit"), oid("user edit"), false))
        assertEquals("applied", vault.apply("a/b.md", oid("user edit"), null, null, false))
        assertFalse(File(vault.root, "a").exists())
        assertEquals("applied", vault.apply("a/b.md", oid("user edit"), null, null, false))
        assertEquals(listOf("a/b.md"), vault.takeSyncedPaths())
    }

    @Test
    fun applyRejectsBytesThatDoNotMatchTheirId() {
        val error = runCatching { vault.apply("x.md", null, data("one"), oid("two"), false) }.exceptionOrNull()
        assertTrue("$error", error is IllegalArgumentException)
        assertEquals(null, vault.readText("x.md"))
    }

    @Test
    fun foldersAndFilesInTheWayBlock() {
        vault.writeText("folder/note.md", "x")
        assertTrue(vault.apply("folder", null, data("y"), oid("y"), false).startsWith("blocked:"))
        vault.writeText("file.md", "x")
        assertTrue(vault.apply("file.md/child.md", null, data("y"), oid("y"), false).startsWith("blocked:"))
    }

    @Test
    fun pathsCannotEscapeTheVault() {
        for (bad in listOf("../outside.md", "/abs.md", "a//b.md", "a/./b.md", "a\\b.md", "")) {
            assertTrue(bad, runCatching { vault.writeText(bad, "x") }.isFailure)
        }
        assertFalse(File(dir, "outside.md").exists())
    }

    @Test
    fun listingSkipsHiddenFoldersAndTemporaries() {
        vault.writeText("note.md", "x")
        vault.writeText(".obsidian/app.json", "{}")
        File(vault.root, ".note.md.123.sync-tmp").writeText("partial")
        vault.writeText(".gitignore", "*.tmp\n")
        assertEquals(setOf("note.md", ".gitignore"), vault.list().map { it.path }.toSet())
        // A new instance clears temporaries an interrupted write left behind.
        VaultFiles(vault.root)
        assertFalse(File(vault.root, ".note.md.123.sync-tmp").exists())
    }

    @Test
    fun appWritesNotifyAndKeepTheExecutableBit() {
        var changes = 0
        vault.onLocalChange = { changes++ }
        assertEquals("applied", vault.apply("run.sh", null, data("#!/bin/sh\n"), oid("#!/bin/sh\n"), true))
        assertTrue(vault.list().single().executable)
        vault.writeText("run.sh", "#!/bin/sh\necho hi\n")
        assertTrue(vault.list().single().executable)
        vault.move("run.sh", "bin/run.sh")
        assertTrue(vault.delete("bin/run.sh"))
        assertEquals(3, changes)
    }
}
