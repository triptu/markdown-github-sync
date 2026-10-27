package io.github.triptu.notes.sync

import io.github.triptu.notes.sync.internal.Json
import io.github.triptu.notes.sync.internal.list
import io.github.triptu.notes.sync.internal.obj
import io.github.triptu.notes.sync.internal.str
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Base64

/**
 * Plays "another device" against a real GitHub repository through the REST
 * API: creates a throwaway branch, commits to it, reads files back, and
 * deletes every ref it or the clients under test created.
 */
class GitHubLab(val owner: String, val repository: String, private val token: String) {
    private val http = OkHttpClient()
    private val base = "https://api.github.com/repos/$owner/$repository"
    private val refs = mutableListOf<String>()

    fun call(method: String, path: String, body: Any? = null, accept: String = "application/vnd.github+json"): Pair<Int, ByteArray> {
        val request = Request.Builder().url(if (path.startsWith("https://")) path else base + path)
            .header("Authorization", "Bearer $token")
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .method(method, body?.let { Json.write(it).toRequestBody("application/json".toMediaType()) })
            .build()
        http.newCall(request).execute().use { return it.code to it.body.bytes() }
    }

    private fun json(method: String, path: String, body: Any? = null): Map<String, Any?> {
        val (status, bytes) = call(method, path, body)
        check(status in 200..299) { "$method $path -> $status ${bytes.toString(Charsets.UTF_8).take(300)}" }
        return Json.parse(bytes.toString(Charsets.UTF_8)).obj()
    }

    /** A new branch whose single commit holds exactly `files`. */
    fun createBranch(name: String, files: Map<String, ByteArray>): String {
        val tree = files.map { (path, bytes) ->
            val blob = json("POST", "/git/blobs", mapOf("content" to Base64.getEncoder().encodeToString(bytes), "encoding" to "base64"))
            mapOf("path" to path, "mode" to "100644", "type" to "blob", "sha" to blob.str("sha"))
        }
        val treeSha = json("POST", "/git/trees", mapOf("tree" to tree)).str("sha")
        val commit = json("POST", "/git/commits", mapOf("message" to "Test fixture", "tree" to treeSha, "parents" to emptyList<String>())).str("sha")!!
        json("POST", "/git/refs", mapOf("ref" to "refs/heads/$name", "sha" to commit))
        refs.add("heads/$name")
        return commit
    }

    fun head(branch: String): String = json("GET", "/git/ref/heads/$branch?fresh=${System.nanoTime()}").obj()["object"].obj().str("sha")!!

    /** Commits `changes` (null deletes) on top of the branch, as another device would. */
    fun commit(branch: String, changes: Map<String, ByteArray?>, message: String = "Edit from another device"): String {
        val parent = head(branch)
        val baseTree = json("GET", "/git/commits/$parent")["tree"].obj().str("sha")
        val tree = changes.map { (path, bytes) ->
            if (bytes == null) mapOf("path" to path, "mode" to "100644", "type" to "blob", "sha" to null)
            else mapOf("path" to path, "mode" to "100644", "type" to "blob", "content" to bytes.toString(Charsets.UTF_8))
        }
        val treeSha = json("POST", "/git/trees", mapOf("base_tree" to baseTree, "tree" to tree)).str("sha")
        val commit = json("POST", "/git/commits", mapOf("message" to message, "tree" to treeSha, "parents" to listOf(parent))).str("sha")!!
        json("PATCH", "/git/refs/heads/$branch", mapOf("sha" to commit, "force" to false))
        return commit
    }

    /** Every file path at the branch head. */
    fun paths(branch: String): Set<String> {
        val tree = json("GET", "/git/trees/${head(branch)}?recursive=1")
        return tree["tree"].list().map { it.obj() }.filter { it["type"] == "blob" }.map { it.str("path")!! }.toSet()
    }

    fun read(branch: String, path: String): String? {
        val (status, bytes) = call("GET", "/contents/$path?ref=$branch", accept = "application/vnd.github.raw+json")
        return if (status == 200) bytes.toString(Charsets.UTF_8) else null
    }

    fun forgetLater(ref: String) { refs.add(ref) }

    /** Deletes the branches and device ledgers this lab created or was told about. */
    fun cleanUp() {
        for (ref in refs) call("DELETE", "/git/refs/$ref")
        refs.clear()
    }
}
