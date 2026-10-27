package io.github.triptu.notes.sync.internal

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.AsyncFunctionBinding
import com.dokar.quickjs.binding.FunctionBinding
import com.dokar.quickjs.binding.define
import com.dokar.quickjs.evaluate
import io.github.triptu.notes.sync.VaultFiles
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors

/** An error the engine reported, already classified for display. */
internal class EngineException(
    val category: String,
    override val message: String,
    val status: Int?,
    val retryAt: Long?,
) : Exception(message)

/**
 * One QuickJS runtime running the bundled engine on its own thread. Calls are
 * serialized: the engine's session is single-owner by design.
 */
@OptIn(ExperimentalUnsignedTypes::class)
internal class EngineRuntime(
    private val bundle: String,
    private val vault: VaultFiles,
    private val journal: JournalFiles,
    private val http: GitHubHttp,
    private val token: suspend () -> String,
    private val progress: (done: Int, total: Int) -> Unit = { _, _ -> },
    private val log: (String) -> Unit = {},
) : Closeable {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "sync-engine").apply { isDaemon = true } }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val mutex = Mutex()
    private var js: QuickJs? = null
    private val random = SecureRandom()

    /** Calls `__api.call(method, args)`; returns the `ok` value or throws [EngineException]. */
    suspend fun call(method: String, args: Map<String, Any?> = emptyMap()): Any? = mutex.withLock {
        withContext(dispatcher) {
            val runtime = js ?: start().also { js = it }
            val raw = runtime.evaluate<String>("await __api.call(${Json.quote(method)}, ${Json.quote(Json.write(args))})")
            val reply = Json.parse(raw).obj()
            val error = reply["error"]?.obj()
            if (error != null) {
                throw EngineException(
                    category = error.str("category") ?: "other",
                    message = error.str("message") ?: "Sync failed",
                    status = (error["status"] as Double?)?.toInt(),
                    retryAt = (error["retryAt"] as Double?)?.toLong(),
                )
            }
            reply["ok"]
        }
    }

    /** Evaluates raw JavaScript in the engine's runtime (tests and diagnostics); returns its string result. */
    suspend fun evaluate(code: String): String? = mutex.withLock {
        withContext(dispatcher) { (js ?: start().also { js = it }).evaluate<String?>(code) }
    }

    private suspend fun start(): QuickJs {
        val runtime = QuickJs.create(dispatcher)
        runtime.maxStackSize = 4L * 1024 * 1024
        runtime.define("__host") {
            function("digest", sync { args ->
                val algorithm = when (args[0] as String) { "SHA-1" -> "SHA-1"; "SHA-256" -> "SHA-256"; else -> error("Unsupported digest") }
                MessageDigest.getInstance(algorithm).digest(bytes(args[1])).toUByteArray()
            })
            function("utf8Encode", sync { args -> (args[0] as String).toByteArray(Charsets.UTF_8).toUByteArray() })
            function("utf8Decode", sync { args ->
                val input = bytes(args[0])
                if (args[1] == true) {
                    Charsets.UTF_8.newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(input)).toString()
                } else String(input, Charsets.UTF_8)
            })
            function("base64Encode", sync { args -> Base64.getEncoder().encodeToString(bytes(args[0])) })
            function("base64Decode", sync { args -> Base64.getDecoder().decode(args[0] as String).toUByteArray() })
            function("randomBytes", sync { args -> ByteArray((args[0] as Number).toInt()).also(random::nextBytes).toUByteArray() })
            function("log", sync { args -> log(args.joinToString(" ")) })
            function("progress", sync { args -> progress((args[0] as Number).toInt(), (args[1] as Number).toInt()) })
            function("journal", sync { args -> journal.call(args[0] as String, args[1] as String, args[2] as String?) })
            function("vaultList", sync {
                Json.write(vault.list().map { listOf(it.path, it.size, it.modified, it.executable) })
            })
            function("vaultRead", sync { args -> vault.readEntryJson(args[0] as String) })
            function("vaultApply", sync { args ->
                vault.apply(args[0] as String, args[1] as String?, args[2] as String?, args[3] as String?, args[4] == true)
            })
            asyncFunction("sleep", async { args -> delay((args[0] as Number).toLong()) })
            asyncFunction("http", async { args -> withContext(Dispatchers.IO) { http.request(args[0] as String) } })
            asyncFunction("archive", async { args ->
                val reply = withContext(Dispatchers.IO) { http.archive(args[0] as String) }
                listOf(reply.status, Json.write(reply.headers), reply.body.toUByteArray())
            })
            asyncFunction("token", async { token() })
        }
        runtime.evaluate<Any?>(bundle, "sync-engine.js", false)
        return runtime
    }

    override fun close() {
        js?.close()
        js = null
        executor.shutdown()
    }

    private fun bytes(value: Any?): ByteArray = when (value) {
        is UByteArray -> value.asByteArray()
        is ByteArray -> value
        else -> error("Expected bytes, got ${value?.let { it::class.simpleName }}")
    }

    private fun <R> sync(body: (Array<Any?>) -> R) = object : FunctionBinding<R> {
        override fun invoke(args: Array<Any?>): R = body(args)
    }

    private fun <R> async(body: suspend (Array<Any?>) -> R) = object : AsyncFunctionBinding<R> {
        override suspend fun invoke(args: Array<Any?>): R = body(args)
    }
}
