package io.github.triptu.notes.sync

/** Where and how this device syncs. */
data class SyncConfig(
    val owner: String,
    val repository: String,
    val branch: String = "main",
    /** Shown in commit messages, e.g. "Pixel 9". */
    val deviceName: String,
    /**
     * Files with these extensions stay on GitHub and are fetched on demand
     * with [SyncClient.fetchAttachment]. Lowercase, without the dot.
     */
    val onDemandExtensions: Set<String> = DEFAULT_ON_DEMAND,
) {
    init {
        for (extension in onDemandExtensions)
            require(EXTENSION.matches(extension)) { "Invalid on-demand extension \"$extension\": use lowercase letters and digits, without the dot" }
    }

    companion object {
        private val EXTENSION = Regex("^[a-z0-9]{1,16}$")

        val DEFAULT_ON_DEMAND: Set<String> = setOf(
            "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "tif", "tiff", "ico",
            "pdf",
            "mp3", "m4a", "wav", "ogg", "flac", "aac", "opus", "3gp",
            "mp4", "mov", "webm", "mkv", "avi", "ogv",
            "zip", "7z", "gz", "tar", "rar",
            "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
            "ttf", "otf", "woff", "woff2",
        )
    }
}

/** Supplies the GitHub token, or null when none is saved. */
fun interface TokenProvider {
    suspend fun token(): String?
}

/** What the UI shows. Errors and conflicts stay until a later sync clears them. */
sealed interface SyncStatus {
    /** No repository connected yet, or enrollment not confirmed. */
    data object NotSetUp : SyncStatus
    data class Idle(val lastSyncedAt: Long?, val notice: String? = null) : SyncStatus
    /** `done`/`total` while downloading files, else null. */
    data class Syncing(val done: Int? = null, val total: Int? = null) : SyncStatus
    /** GitHub can't be reached; sync retries on its own. */
    data class Offline(val lastSyncedAt: Long?) : SyncStatus
    data class Conflict(val conflicts: List<SyncConflict>, val message: String) : SyncStatus
    data class Error(val error: SyncError) : SyncStatus
}

/** A failure in a category the UI can act on. `message` is plain and human. */
class SyncError(
    val kind: Kind,
    message: String,
    val retryAt: Long? = null,
    /** Technical cause for logs and bug reports; never shown to the user. */
    val detail: String? = null,
) : Exception(message) {
    enum class Kind {
        /** No connection, or GitHub is down or rate limiting. Retries automatically. */
        Offline,
        /** The token or repository access is wrong. Send the user to settings. */
        Access,
        /** Files changed both here and on GitHub; the user must choose. */
        Conflict,
        Other,
    }

    override fun toString(): String = "SyncError($kind, $message)"
}

/** One version of a file in a conflict. `text` is null for binary content. */
data class FileVersion(val oid: String, val text: String?)

data class SyncConflict(
    val id: String,
    /**
     * `content` (both edited the same lines), `add-add`, `local-deleted-remote-edited`,
     * `local-edited-remote-deleted`, `collision` (names differing only in case) or `bulk-deletion`.
     */
    val kind: String,
    /** The file, or the first of `paths` for collisions and bulk deletions. */
    val path: String,
    val paths: List<String>,
    /** Choices the engine accepts: `mine`, `remote`, `both`, `edit`. */
    val choices: List<String>,
    /** Where "both" keeps this device's copy. */
    val sibling: String?,
    /**
     * For `bulk-deletion`: `local` when this device deleted the files, `remote`
     * when GitHub did. `mine` keeps this device's side, `remote` GitHub's.
     */
    val direction: String? = null,
    val base: FileVersion?,
    val local: FileVersion?,
    val remote: FileVersion?,
)

sealed interface Resolution {
    data object Mine : Resolution
    data object Theirs : Resolution
    /** Keep both: GitHub's at the path, this device's at [SyncConflict.sibling]. */
    data object Both : Resolution
    data class Edited(val text: String) : Resolution
}

data class EnrollmentPreview(
    /** Pass to [SyncClient.enroll]. */
    val token: String,
    val commit: String,
    /** True when re-enrolling after a pause. */
    val reenrollment: Boolean,
    /** `download`, `upload`, `update-local`, `conflict`, `unreadable`, `review-local-deletion`, ... */
    val items: List<Pair<String, String>>,
    val unchanged: Int,
)

sealed interface EnrollResult {
    data object Enrolled : EnrollResult
    data object AlreadyEnrolled : EnrollResult
    /** Something changed since the preview; show this one and ask again. */
    data class Stale(val preview: EnrollmentPreview) : EnrollResult
}
