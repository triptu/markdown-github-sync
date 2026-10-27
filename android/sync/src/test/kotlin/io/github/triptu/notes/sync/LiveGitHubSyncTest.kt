package io.github.triptu.notes.sync

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/**
 * The real engine bundle, in QuickJS on the JVM, against a real private
 * GitHub repository. Runs only when GH_TOKEN is set; the repository comes
 * from SYNC_TEST_REPO (default triptu/vault-sync-api-lab-20261013). Every
 * branch and device ledger a test creates is deleted afterwards.
 */
class LiveGitHubSyncTest {
    private val token: String? = System.getenv("GH_TOKEN")?.takeIf { it.isNotBlank() }
    private val repo = (System.getenv("SYNC_TEST_REPO") ?: "triptu/vault-sync-api-lab-20261013").split('/')
    private lateinit var lab: GitHubLab
    private val branch = "android-sync-test-${UUID.randomUUID().toString().take(8)}"
    private val dir = Files.createTempDirectory("live-sync").toFile()
    private val clients = mutableListOf<Pair<SyncClient, File>>()
    private val script = File(System.getProperty("syncEngineBundle")!!).readText()

    private val photo = ByteArray(300) { (it * 7).toByte() }.also { it[0] = 0x89.toByte(); it[1] = 'P'.code.toByte() }
    private val fixture = mapOf(
        "notes/a.md" to "# A\n\nline one\nline two\nline three\n",
        "notes/b.md" to "# B\n\nfirst\n",
        "Daily/2026-10-27.md" to "- made-up test note\n",
    ).mapValues { it.value.toByteArray() } + mapOf(
        "media/photo.png" to photo,
        "docs/paper.pdf" to "%PDF-1.7 made up".toByteArray(),
        ".obsidian/app.json" to "{\"theme\":\"dark\"}".toByteArray(),
    )

    @Before
    fun setUp() {
        assumeTrue("GH_TOKEN not set; skipping live GitHub tests", token != null)
        lab = GitHubLab(repo[0], repo[1], token!!)
        lab.createBranch(branch, fixture)
    }

    @After
    fun tearDown() {
        for ((client, storage) in clients) {
            client.close()
            File(storage, "installation-id").takeIf { it.isFile }?.let { lab.forgetLater("vault-sync/devices/${it.readText().trim()}") }
        }
        if (::lab.isInitialized) lab.cleanUp()
        dir.deleteRecursively()
    }

    private fun device(name: String): SyncClient {
        val storage = File(dir, "$name/sync")
        val client = SyncClient(
            storageDir = storage,
            vaultDir = File(dir, "$name/vault"),
            config = SyncConfig(owner = repo[0], repository = repo[1], branch = branch, deviceName = "Test $name"),
            tokens = { token },
            engineScript = script,
        )
        clients.add(client to storage)
        return client
    }

    private fun SyncClient.text(path: String) = vault.readText(path)

    private suspend fun SyncClient.join(): EnrollmentPreview {
        val preview = previewEnrollment()
        assertEquals(EnrollResult.Enrolled, enroll(preview.token))
        val status = syncNow()
        assertTrue("first sync: $status", status is SyncStatus.Idle)
        return preview
    }

    @Test
    fun enrollsAnEmptyFolderWithNotesOnly() = runBlocking {
        val a = device("a")
        assertEquals(SyncStatus.NotSetUp, a.refresh())
        val preview = a.join()
        assertEquals(
            listOf("Daily/2026-10-27.md" to "download", "notes/a.md" to "download", "notes/b.md" to "download"),
            preview.items.sortedBy { it.first },
        )
        assertEquals(setOf("Daily/2026-10-27.md", "notes/a.md", "notes/b.md"), a.vault.list().map { it.path }.toSet())
        assertEquals("# B\n\nfirst\n", a.text("notes/b.md"))
        assertFalse(File(a.vault.root, ".obsidian").exists())
    }

    @Test
    fun publishesLocalEditsAndKeepsAttachments() = runBlocking {
        val a = device("a")
        a.join()
        a.vault.writeText("notes/b.md", "# B\n\nfirst\nadded on the phone\n")
        a.vault.writeText("notes/new.md", "brand new\n")
        a.vault.delete("Daily/2026-10-27.md")
        assertTrue(a.syncNow() is SyncStatus.Idle)
        assertEquals("# B\n\nfirst\nadded on the phone\n", lab.read(branch, "notes/b.md"))
        assertEquals("brand new\n", lab.read(branch, "notes/new.md"))
        val paths = lab.paths(branch)
        assertFalse("Daily/2026-10-27.md" in paths)
        assertTrue("attachments and settings are not deleted: $paths",
            paths.containsAll(listOf("media/photo.png", "docs/paper.pdf", ".obsidian/app.json")))
    }

    @Test
    fun appliesRemoteEdits() = runBlocking {
        val a = device("a")
        a.join()
        lab.commit(branch, mapOf("notes/b.md" to "# B\n\nedited on desktop\n".toByteArray(), "notes/c.md" to "from desktop\n".toByteArray(),
            "media/second.jpg" to "jpeg bytes".toByteArray()))
        assertTrue(a.syncNow() is SyncStatus.Idle)
        assertEquals("# B\n\nedited on desktop\n", a.text("notes/b.md"))
        assertEquals("from desktop\n", a.text("notes/c.md"))
        assertEquals(null, a.text("media/second.jpg"))
    }

    @Test
    fun mergesConcurrentEditsToDifferentLines() = runBlocking {
        val a = device("a")
        a.join()
        a.vault.writeText("notes/a.md", "# A\n\nline one (phone)\nline two\nline three\n")
        lab.commit(branch, mapOf("notes/a.md" to "# A\n\nline one\nline two\nline three (desktop)\n".toByteArray()))
        val status = a.syncNow()
        assertTrue("$status", status is SyncStatus.Idle)
        val merged = "# A\n\nline one (phone)\nline two\nline three (desktop)\n"
        assertEquals(merged, a.text("notes/a.md"))
        assertEquals(merged, lab.read(branch, "notes/a.md"))
    }

    @Test
    fun surfacesSameLineConflictsAndResolvesThem() = runBlocking {
        val a = device("a")
        a.join()
        a.vault.writeText("notes/a.md", "# A\n\nline one (phone)\nline two\nline three\n")
        lab.commit(branch, mapOf("notes/a.md" to "# A\n\nline one (desktop)\nline two\nline three\n".toByteArray()))
        val status = a.syncNow()
        assertTrue("$status", status is SyncStatus.Conflict)
        val conflict = (status as SyncStatus.Conflict).conflicts.single()
        assertEquals("notes/a.md", conflict.path)
        assertEquals("# A\n\nline one (phone)\nline two\nline three\n", conflict.local?.text)
        assertEquals("# A\n\nline one (desktop)\nline two\nline three\n", conflict.remote?.text)
        assertEquals("# A\n\nline one (phone)\nline two\nline three\n", a.text("notes/a.md"))
        a.resolve(conflict.id, Resolution.Edited("# A\n\nline one (both)\nline two\nline three\n"))
        assertTrue(a.syncNow() is SyncStatus.Idle)
        assertEquals("# A\n\nline one (both)\nline two\nline three\n", lab.read(branch, "notes/a.md"))
        assertEquals("# A\n\nline one (both)\nline two\nline three\n", a.text("notes/a.md"))
    }

    @Test
    fun fetchesAttachmentsOnDemand() = runBlocking {
        val a = device("a")
        a.join()
        assertTrue(a.isOnDemand("media/photo.png"))
        assertFalse(a.isOnDemand("notes/a.md"))
        val file = a.fetchAttachment("media/photo.png")
        assertArrayEquals(photo, file.readBytes())
        assertFalse("not placed in the vault", File(a.vault.root, "media/photo.png").exists())
        val missing = runCatching { a.fetchAttachment("media/missing.png") }.exceptionOrNull()
        assertTrue("$missing", missing is SyncError && missing.kind == SyncError.Kind.Other)
    }

    @Test
    fun twoPhonesConverge() = runBlocking {
        val a = device("a")
        val b = device("b")
        a.join()
        b.join()
        a.vault.writeText("notes/from-a.md", "hello from a\n")
        assertTrue(a.syncNow() is SyncStatus.Idle)
        b.vault.writeText("notes/from-b.md", "hello from b\n")
        assertTrue(b.syncNow() is SyncStatus.Idle)
        assertTrue(a.syncNow() is SyncStatus.Idle)
        assertEquals("hello from b\n", a.text("notes/from-b.md"))
        assertEquals("hello from a\n", b.text("notes/from-a.md"))
    }

    @Test
    fun keepsTheEnrolledOnDemandListUntilSetUpAgain() = runBlocking {
        val first = device("a")
        first.join()
        first.close()
        // The app now asks for a different list: sync must keep working with the enrolled one.
        val storage = File(dir, "a/sync")
        val reopened = SyncClient(storage, File(dir, "a/vault"),
            SyncConfig(owner = repo[0], repository = repo[1], branch = branch, deviceName = "Test a", onDemandExtensions = setOf("pdf")),
            tokens = { token }, engineScript = script)
        clients.add(reopened to storage)
        val status = reopened.syncNow()
        assertTrue("$status", status is SyncStatus.Idle)
        assertTrue(reopened.onDemandChangePending)
        assertTrue("png" in reopened.onDemandExtensions)
        assertEquals(null, reopened.text("media/photo.png"))
        val refused = runCatching { reopened.previewEnrollment() }.exceptionOrNull()
        assertEquals("Sync is already set up on this device.", refused?.message)
    }

    @Test
    fun reportsAccessProblems() = runBlocking {
        val client = SyncClient(File(dir, "bad/sync"), File(dir, "bad/vault"),
            SyncConfig(owner = repo[0], repository = repo[1], branch = branch, deviceName = "Bad"),
            tokens = { "github_pat_not_a_real_token" }, engineScript = script)
        val error = runCatching { client.checkAccess() }.exceptionOrNull()
        client.close()
        assertTrue("$error", error is SyncError && error.kind == SyncError.Kind.Access)
    }

    @Test
    fun measuresNoChangeSync() = runBlocking {
        val a = device("a")
        a.join()
        repeat(2) { a.syncNow() } // Warm up the JIT and the engine's caches.
        val times = (1..5).map {
            val start = System.nanoTime()
            assertTrue(a.syncNow() is SyncStatus.Idle)
            (System.nanoTime() - start) / 1_000_000
        }
        println("No-change sync on JVM (ms): $times, median ${times.sorted()[2]}")
    }
}
