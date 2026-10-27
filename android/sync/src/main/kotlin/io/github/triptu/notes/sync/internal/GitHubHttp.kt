package io.github.triptu.notes.sync.internal

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

/** The engine's HTTP ports over OkHttp. Requests go only to GitHub's API. */
internal class GitHubHttp(
    private val client: OkHttpClient = defaultClient(),
    /** Larger archives are abandoned; the engine then reads blobs one by one. */
    private val archiveLimit: Long = 48L * 1024 * 1024,
) {
    class Reply(val status: Int, val headers: Map<String, String>, val body: ByteArray)

    /** `{ url, method, headers, body? }` in, `{ status, headers, body }` out (body as text). */
    suspend fun request(json: String): String {
        val reply = execute(build(json), limit = 64L * 1024 * 1024)
        return Json.write(mapOf("status" to reply.status, "headers" to reply.headers, "body" to reply.body.toString(Charsets.UTF_8)))
    }

    /** Raw bytes; follows redirects (OkHttp drops Authorization when the host changes). */
    suspend fun archive(json: String): Reply = execute(build(json), archiveLimit)

    suspend fun get(url: String, headers: Map<String, String>, limit: Long): Reply {
        val builder = Request.Builder().url(checkedUrl(url)).get()
        headers.forEach { (k, v) -> builder.header(k, v) }
        return execute(builder.build(), limit)
    }

    private fun build(json: String): Request {
        val spec = Json.parse(json).obj()
        val method = spec.str("method") ?: "GET"
        val builder = Request.Builder().url(checkedUrl(spec.str("url")!!))
        spec["headers"]?.obj()?.forEach { (k, v) -> builder.header(k, v as String) }
        val body = spec.str("body")
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post((body ?: "").toRequestBody("application/json".toMediaType()))
            else -> error("Unsupported method $method")
        }
        return builder.build()
    }

    private fun checkedUrl(url: String): String {
        val parsed = url.toHttpUrl()
        require(parsed.isHttps && parsed.host == "api.github.com") { "Refusing a request outside api.github.com" }
        return url
    }

    private suspend fun execute(request: Request, limit: Long): Reply = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
            override fun onResponse(call: Call, response: Response) {
                val reply = try {
                    response.use { Reply(it.code, flatten(it.headers), readLimited(it, limit)) }
                } catch (e: Throwable) {
                    continuation.resumeWithException(e)
                    return
                }
                continuation.resume(reply) { _, _, _ -> }
            }
        })
    }

    private fun readLimited(response: Response, limit: Long): ByteArray {
        val body = response.body
        if (body.contentLength() > limit) throw IOException("Response exceeds ${limit / (1024 * 1024)} MiB")
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        body.byteStream().use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                out.write(buffer, 0, read)
                if (out.size() > limit) throw IOException("Response exceeds ${limit / (1024 * 1024)} MiB")
            }
        }
        return out.toByteArray()
    }

    private fun flatten(headers: Headers): Map<String, String> =
        headers.names().associate { it.lowercase() to headers.values(it).joinToString(", ") }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(5, TimeUnit.MINUTES)
            .build()
    }
}
