package io.github.triptu.notes.sync

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/**
 * The packaged engine asset running in QuickJS on a phone. The live part
 * needs a token: `-Pandroid.testInstrumentationRunnerArguments.ghToken=...`.
 */
@RunWith(AndroidJUnit4::class)
class DeviceSyncTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val args = InstrumentationRegistry.getArguments()

    @Test
    fun syncsAgainstGitHubOnTheDevice(): Unit = runBlocking {
        val script = readEngineScript(context)
        assertTrue(script.length > 100_000)
        val token = args.getString("ghToken")
        assumeTrue("no ghToken argument", !token.isNullOrBlank())
        val repo = (args.getString("syncTestRepo") ?: "triptu/vault-sync-api-lab-20261013").split('/')
        val lab = GitHubLab(repo[0], repo[1], token!!)
        val branch = "android-sync-device-${UUID.randomUUID().toString().take(8)}"
        val root = File(context.filesDir, "device-sync-test").also { it.deleteRecursively() }
        lab.createBranch(branch, mapOf(
            "notes/a.md" to "# A\n\nmade-up note\n".toByteArray(),
            "media/photo.png" to byteArrayOf(1, 2, 3),
        ))
        val client = SyncClient(File(root, "sync"), File(root, "vault"),
            SyncConfig(owner = repo[0], repository = repo[1], branch = branch, deviceName = "Device test"),
            tokens = { token }, engineScript = script)
        try {
            val started = System.nanoTime()
            val preview = client.previewEnrollment()
            assertEquals(EnrollResult.Enrolled, client.enroll(preview.token))
            assertTrue(client.syncNow() is SyncStatus.Idle)
            Log.i(TAG, "First enrollment and sync: ${(System.nanoTime() - started) / 1_000_000} ms")
            assertEquals("# A\n\nmade-up note\n", client.vault.readText("notes/a.md"))

            client.vault.writeText("notes/a.md", "# A\n\nedited on the phone\n")
            lab.commit(branch, mapOf("notes/b.md" to "from desktop\n".toByteArray()))
            assertTrue(client.syncNow() is SyncStatus.Idle)
            assertEquals("# A\n\nedited on the phone\n", lab.read(branch, "notes/a.md"))
            assertEquals("from desktop\n", client.vault.readText("notes/b.md"))
            assertTrue("media/photo.png" in lab.paths(branch))
            assertEquals(3, client.fetchAttachment("media/photo.png").length())

            repeat(2) { client.syncNow() }
            val times = (1..5).map {
                val start = System.nanoTime()
                assertTrue(client.syncNow() is SyncStatus.Idle)
                (System.nanoTime() - start) / 1_000_000
            }
            Log.i(TAG, "No-change sync on device (ms): $times, median ${times.sorted()[2]}")
        } finally {
            val installation = File(root, "sync/installation-id").readText().trim()
            client.close()
            lab.forgetLater("vault-sync/devices/$installation")
            lab.cleanUp()
            root.deleteRecursively()
        }
    }

    private companion object {
        const val TAG = "DeviceSyncTest"
    }
}
