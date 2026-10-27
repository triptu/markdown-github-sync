package io.github.triptu.notes.vault

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class FileVaultStoreTest {
    @get:Rule val temp = TemporaryFolder()

    @Test
    fun `write is readable, creates folders and leaves no temp files`() = runTest {
        val root = temp.newFolder("vault")
        val store = FileVaultStore(root, Dispatchers.Unconfined)
        val path = NotePath("Zettelkasten/2026102709 First.md")
        store.write(path, "hello")
        store.write(path, "hello again")
        assertEquals("hello again", store.read(path))
        assertEquals(listOf("2026102709 First.md"), File(root, "Zettelkasten").list()!!.toList())
    }

    @Test
    fun `list skips hidden folders and non-markdown files`() = runTest {
        val root = temp.newFolder("vault")
        File(root, ".obsidian").mkdirs()
        File(root, ".obsidian/app.md").writeText("x")
        File(root, "Writing").mkdirs()
        File(root, "Writing/draft.md").writeText("x")
        File(root, "Writing/photo.png").writeText("x")
        File(root, "Empty").mkdirs()
        val listing = FileVaultStore(root, Dispatchers.Unconfined).list()
        assertEquals(listOf(NotePath("Writing/draft.md")), listing.notes.map { it.path })
        assertEquals(setOf(FolderPath("Writing"), FolderPath("Empty")), listing.folders)
    }

    @Test
    fun `rename refuses to overwrite`() = runTest {
        val store = FileVaultStore(temp.newFolder("vault"), Dispatchers.Unconfined)
        store.write(NotePath("a.md"), "a")
        store.write(NotePath("b.md"), "b")
        val failed = runCatching { store.rename(NotePath("a.md"), NotePath("b.md")) }.isFailure
        assertTrue(failed)
        assertEquals("b", store.read(NotePath("b.md")))
        store.rename(NotePath("a.md"), NotePath("c.md"))
        assertNull(store.read(NotePath("a.md")))
        assertEquals("a", store.read(NotePath("c.md")))
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class VaultIndexTest {
    @get:Rule val temp = TemporaryFolder()

    @Test
    fun `index follows writes and external edits, and survives a restart from cache`() = runTest {
        val root = temp.newFolder("vault")
        val cache = File(temp.root, "index.cache")
        File(root, "Todos.md").writeText("- [ ] milk\n- [ ] eggs\n")
        val store = FileVaultStore(root, Dispatchers.Unconfined)
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val index = VaultIndex(store, cache, scope, Dispatchers.Unconfined)
        index.start()
        index.refresh()
        assertEquals(setOf(NotePath("Todos.md")), index.snapshot.value.notes.keys)

        store.write(NotePath("Todos.md"), "- [x] milk\n- [ ] eggs\n")
        assertEquals("- [x] milk", index.snapshot.value.notes.getValue(NotePath("Todos.md")).snippet)

        File(root, "Work").mkdirs()
        File(root, "Work/log.md").writeText("shipped the thing")
        store.notifyExternalChange()
        assertEquals("shipped the thing", index.snapshot.value.notes.getValue(NotePath("Work/log.md")).text)
        assertTrue(FolderPath("Work") in index.snapshot.value.folders)

        testScheduler.advanceUntilIdle()
        scope.cancel()
        assertTrue(cache.isFile)
        val restarted = IndexCache.read(cache)!!
        assertFalse(restarted.isFresh)
        assertEquals(index.snapshot.value.notes, restarted.notes)
    }

    @Test
    fun `search ranks title matches first and is case insensitive`() = runTest {
        val root = temp.newFolder("vault")
        File(root, "Reading list.md").writeText("Walden\nMiddlemarch")
        File(root, "Ideas.md").writeText("a reading lamp for the balcony")
        val store = FileVaultStore(root, Dispatchers.Unconfined)
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val index = VaultIndex(store, File(temp.root, "c"), scope, Dispatchers.Unconfined)
        index.refresh()
        val hits = VaultQueries.search(index.snapshot.first { it.isFresh }, "READING")
        assertEquals(listOf("Reading list", "Ideas"), hits.map { it.path.name })
        assertEquals(NotePath("Ideas.md"), VaultQueries.resolveLink(index.snapshot.value, "ideas"))
        scope.cancel()
    }
}

class RecentSnippetTest {
    @Test
    fun `new note shows its last paragraph`() {
        assertEquals("second para", RecentSnippet.of(null, "# Title\n\nfirst para\n\nsecond para\n"))
    }

    @Test
    fun `new note prefers prose over a trailing list`() {
        assertEquals("went well", RecentSnippet.of(null, "## Notes\n\nwent well\n\n## Done\n- 1-1\n"))
        assertEquals("- [ ] eggs", RecentSnippet.of(null, "- [ ] milk\n- [ ] eggs\n"))
        assertEquals("- [ ] send notes", RecentSnippet.of(null, "Follow-ups:\n- [ ] send notes\n"))
    }

    @Test
    fun `link-only lines are skipped and links read as titles`() {
        val note = "Rent decides the days.\n\nLinks: [[Zettelkasten/2026030820 Rent is a vote for a life]], [[Walden|the book]]\n"
        assertEquals("Rent decides the days.", RecentSnippet.of(null, note))
        assertEquals(
            "see Rent is a vote for a life and the book, soon",
            SnippetText.plain("- see [[2026030820 Rent is a vote for a life]] and **[[Walden|the book]]**,\n  soon"),
        )
    }

    @Test
    fun `edit in the middle shows that paragraph, not the last`() {
        val old = "one\n\ntwo\n\nthree"
        val new = "one\n\ntwo, now longer\nand wrapped\n\nthree"
        assertEquals("two, now longer and wrapped", RecentSnippet.of(old, new))
    }

    @Test
    fun `time lines and headings are skipped`() {
        val old = "## Notes and Ramblings\n"
        val new = "## Notes and Ramblings\n\n*21:40*\nwalked to the lake\n"
        assertEquals("walked to the lake", RecentSnippet.of(old, new))
    }
}
