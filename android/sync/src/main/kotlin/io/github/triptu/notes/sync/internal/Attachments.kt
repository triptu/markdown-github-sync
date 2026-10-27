package io.github.triptu.notes.sync.internal

import java.io.File
import java.net.URLEncoder

/**
 * Read-only, on-demand files (images, PDFs) at the branch head, cached by
 * blob id. Every download is checked against GitHub's blob id before use.
 */
internal class Attachments(
    private val directory: File,
    private val http: GitHubHttp,
    private val owner: String,
    private val repository: String,
    private val branch: String,
    private val token: suspend () -> String,
    private val cacheLimit: Long = 256L * 1024 * 1024,
) {
    init {
        directory.mkdirs()
    }

    class Failure(message: String, val status: Int?) : Exception(message)

    suspend fun fetch(path: String): File {
        resolveBelow(directory, path) // Same path rules as the vault.
        val base = "https://api.github.com/repos/${encode(owner)}/${encode(repository)}"
        val headers = mapOf("Authorization" to "Bearer ${token()}", "X-GitHub-Api-Version" to "2022-11-28")
        val encodedPath = path.split('/').joinToString("/") { encode(it) }
        val listing = http.get("$base/contents/$encodedPath?ref=${encode(branch)}", headers + ("Accept" to "application/vnd.github.object+json"), 8L * 1024 * 1024)
        if (listing.status != 200) throw Failure(failureMessage(listing.status, path), listing.status)
        val info = Json.parse(listing.body.toString(Charsets.UTF_8)).obj()
        if (info["type"] != "file") throw Failure("$path is not a file on GitHub", null)
        val sha = info.str("sha")?.takeIf { it.matches(Regex("^[0-9a-f]{40}$")) } ?: throw Failure("GitHub returned a malformed file", null)
        val size = (info["size"] as Double).toLong()
        val cached = File(directory, sha)
        if (cached.isFile && cached.length() == size) {
            cached.setLastModified(System.currentTimeMillis())
            return cached
        }
        val blob = http.get("$base/git/blobs/$sha", headers + ("Accept" to "application/vnd.github.raw+json"), 100L * 1024 * 1024)
        if (blob.status != 200) throw Failure(failureMessage(blob.status, path), blob.status)
        if (blob.body.size.toLong() != size || gitBlobOid(blob.body) != sha) throw Failure("Download of $path was corrupted", null)
        atomicWrite(cached, blob.body)
        trim(keep = cached)
        return cached
    }

    private fun trim(keep: File) {
        val files = directory.listFiles().orEmpty().filter { it.isFile && it != keep }.sortedBy { it.lastModified() }
        var total = files.sumOf { it.length() } + keep.length()
        for (file in files) {
            if (total <= cacheLimit) break
            total -= file.length()
            file.delete()
        }
    }

    private fun failureMessage(status: Int, path: String) = when (status) {
        404 -> "$path isn't on GitHub"
        401, 403 -> "GitHub denied access to $path"
        else -> "GitHub didn't send $path (HTTP $status)"
    }

    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
