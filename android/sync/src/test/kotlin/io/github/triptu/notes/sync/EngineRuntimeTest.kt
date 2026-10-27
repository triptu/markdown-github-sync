package io.github.triptu.notes.sync

import io.github.triptu.notes.sync.internal.EngineException
import io.github.triptu.notes.sync.internal.EngineRuntime
import io.github.triptu.notes.sync.internal.GitHubHttp
import io.github.triptu.notes.sync.internal.JournalFiles
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** The bundle loads in QuickJS and its polyfills agree with Web platform behavior. */
class EngineRuntimeTest {
    private val dir = Files.createTempDirectory("engine-runtime").toFile()
    private val runtime = EngineRuntime(
        bundle = File(System.getProperty("syncEngineBundle")!!).readText(),
        vault = VaultFiles(File(dir, "vault")),
        journal = JournalFiles(File(dir, "journal")),
        http = GitHubHttp(),
        token = { "unused" },
    )

    @After
    fun tearDown() {
        runtime.close()
        dir.deleteRecursively()
    }

    private fun js(code: String): String? = runBlocking { runtime.evaluate(code) }

    @Test
    fun hashesMatchGit() {
        // `printf 'hello\n' | git hash-object --stdin`
        val oid = js("""
            const bytes = new TextEncoder().encode("hello\n");
            const header = new TextEncoder().encode("blob " + bytes.length + "\0");
            const all = new Uint8Array(header.length + bytes.length); all.set(header); all.set(bytes, header.length);
            Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", all.subarray(0))), b => b.toString(16).padStart(2, "0")).join("")
        """.trimIndent())
        assertEquals("ce013625030ba8dba906f756967f9e9ca394464a", oid)
        val sha256 = js("""Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1,2,3,4]).subarray(1, 3))), b => b.toString(16).padStart(2, "0")).join("")""")
        // SHA-256 of bytes [2, 3]: only the view, not its whole buffer.
        assertEquals(java.security.MessageDigest.getInstance("SHA-256").digest(byteArrayOf(2, 3)).joinToString("") { "%02x".format(it) }, sha256)
    }

    @Test
    fun textAndBase64BehaveLikeBrowsers() {
        assertEquals("﻿hé", js("""new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array([0xEF,0xBB,0xBF,0x68,0xC3,0xA9]))"""))
        assertEquals("hé", js("""new TextDecoder().decode(new Uint8Array([0xEF,0xBB,0xBF,0x68,0xC3,0xA9]))"""))
        assertEquals("TypeError", js("""try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xC3])); "none" } catch (e) { e.name }"""))
        assertEquals("AAEC/w==", js("""new Uint8Array([0, 1, 2, 255]).toBase64()"""))
        assertEquals("0,1,2,255", js("""Array.from(Uint8Array.fromBase64("AAEC/w==")).join()"""))
        assertEquals("bad", js("""try { Uint8Array.fromBase64("@@@@"); "ok" } catch { "bad" }"""))
        assertEquals("bad", js("""try { __host.journal("read", "missing.json", null); "ok" } catch { "bad" }"""))
    }

    @Test
    fun timersUuidsAndUrls() {
        assertEquals("b,a", js("""const order = []; await new Promise(r => { setTimeout(() => { order.push("a"); r(); }, 20); setTimeout(() => order.push("b"), 1); }); order.join()"""))
        assertEquals("cancelled", js("""let fired = false; const id = setTimeout(() => { fired = true; }, 5); clearTimeout(id); await new Promise(r => setTimeout(r, 30)); fired ? "fired" : "cancelled""""))
        assertTrue(js("crypto.randomUUID()")!!.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")))
        assertEquals("https://codeload.github.com/o/r/zip/abc codeload.github.com", js("""const u = new URL("https://codeload.github.com/o/r/zip/abc", "https://api.github.com/x"); u.href + " " + u.hostname"""))
        assertEquals("1,true", js("""const c = structuredClone({ a: [1, { b: true }] }); [c.a[0], c.a[1].b].join()"""))
    }

    @Test
    fun callsBeforeOpenReportAPlainError() {
        try {
            runBlocking { runtime.call("status") }
            fail("expected an error")
        } catch (error: EngineException) {
            assertEquals("other", error.category)
            assertEquals("Sync is not set up on this device.", error.message)
        }
    }
}
