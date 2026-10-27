package io.github.triptu.notes.sync

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Offline behavior of SyncClient around a broken engine and bad configuration. */
class SyncClientTest {
    private val dir = Files.createTempDirectory("sync-client").toFile()

    @After
    fun tearDown() { dir.deleteRecursively() }

    private fun config(extensions: Set<String> = SyncConfig.DEFAULT_ON_DEMAND) =
        SyncConfig(owner = "owner", repository = "repo", deviceName = "Test", onDemandExtensions = extensions)

    @Test
    fun aBrokenEngineBecomesAPlainErrorInsteadOfACrash() = runBlocking {
        val client = SyncClient(File(dir, "sync"), File(dir, "vault"), config(), { null }, engineScript = "throw new Error('bundle failed to load')")
        val status = withTimeout(10_000) { client.status.first { it is SyncStatus.Error } } as SyncStatus.Error
        assertEquals(SyncError.Kind.Other, status.error.kind)
        assertEquals("Sync stopped. Your files are safe.", status.error.message)
        assertTrue(status.error.detail!!.contains("bundle failed to load"))
        val thrown = runCatching { client.refresh() }.exceptionOrNull()
        assertTrue("$thrown", thrown is SyncError && thrown.message == "Sync stopped. Your files are safe.")
        client.close()
    }

    @Test
    fun noNetworkIsReportedAsOffline() = runBlocking {
        // Every request goes through a proxy nothing listens on, as with airplane mode on.
        val saved = listOf("https.proxyHost", "https.proxyPort").associateWith { System.getProperty(it) }
        System.setProperty("https.proxyHost", "127.0.0.1")
        System.setProperty("https.proxyPort", "9")
        try {
            val script = File(System.getProperty("syncEngineBundle")!!).readText()
            val client = SyncClient(File(dir, "sync"), File(dir, "vault"), config(), { "github_pat_test" }, engineScript = script)
            val error = runCatching { client.checkAccess() }.exceptionOrNull()
            assertTrue("$error", error is SyncError && error.kind == SyncError.Kind.Offline)
            val attachment = runCatching { client.fetchAttachment("media/photo.png") }.exceptionOrNull()
            assertTrue("$attachment", attachment is SyncError && attachment.kind == SyncError.Kind.Offline)
            client.close()
        } finally {
            saved.forEach { (key, value) -> if (value == null) System.clearProperty(key) else System.setProperty(key, value) }
        }
    }

    @Test
    fun onDemandExtensionsAreValidated() {
        for (bad in listOf(".png", "PNG", "", "a-b", "x".repeat(17))) {
            assertTrue(bad, runCatching { config(setOf(bad)) }.exceptionOrNull() is IllegalArgumentException)
        }
        config(setOf("png", "mp4"))
    }
}
