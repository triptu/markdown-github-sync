package io.github.triptu.notes.syncing

import android.net.Uri
import io.github.triptu.notes.sync.EnrollmentPreview

/** Every sentence the app shows about GitHub sync, in one place. Short and plain, no codes. */
object SyncCopy {
    const val Section = "GitHub sync"
    const val Intro = "Keep these notes in a private GitHub repository, the one your Obsidian vault syncs with."
    const val SetupTitle = "Sync with GitHub"
    const val Repository = "Repository"
    const val RepositoryPlaceholder = "owner/name"
    const val Branch = "Branch"
    const val Token = "Token"
    const val TokenPlaceholder = "github_pat_…"
    const val TokenSaved = "Saved on this phone"
    const val CreateToken = "Create token"
    const val TokenHint = "A fine-grained token that can read and write this repository's contents. It stays on this phone, encrypted."
    const val Connect = "Connect"
    const val Checking = "Checking access…"
    const val StartSyncing = "Start syncing"
    const val Cancel = "Cancel"
    const val NotNow = "Not now"
    const val SaveToken = "Save token"
    const val TokenUpdated = "Token saved."
    const val StopSyncing = "Stop syncing on this phone"
    const val StopSyncingHint = "Notes stay on this phone. The token is removed."
    const val StopSyncingConfirm = "Stop syncing?"
    const val StopSyncingBody = "Notes stay on this phone, and nothing changes on GitHub. You can connect again later."
    const val Stop = "Stop syncing"
    const val TryAgain = "Try again"
    const val Starting = "Getting ready…"

    const val EnterRepository = "Enter the repository as owner/name."
    const val EnterBranch = "Enter a branch name."
    const val EnterToken = "Paste a token."
    const val Offline = "Can't reach GitHub. Check your connection."
    const val Stopped = "Sync stopped. Your notes are safe."

    fun downloading(done: Int?, total: Int?): String =
        if (done != null && total != null && total > 0) "Downloading notes… $done of $total" else "Downloading notes…"

    fun connected(target: SyncTarget): String = target.name

    fun notSyncedFor(hours: Long): String = "Not synced for ${if (hours < 48) "$hours hours" else "${hours / 24} days"}. Notes are saved on this phone."

    fun bothVersions(count: Int): String = if (count == 1) "1 note has both versions" else "$count notes have both versions"

    const val AccessLine = "Sync needs a new token"

    fun lastSynced(at: Long?, now: Long): String {
        if (at == null) return "Not synced yet"
        val minutes = (now - at) / 60_000
        return when {
            minutes < 1 -> "Synced just now"
            minutes < 60 -> "Synced $minutes min ago"
            minutes < 48 * 60 -> "Synced ${minutes / 60} h ago"
            else -> "Synced ${minutes / (24 * 60)} days ago"
        }
    }

    /** What enrolling will do, one short line per kind of change. */
    fun summary(preview: EnrollmentPreview): List<String> {
        val counts = preview.items.groupingBy { it.second }.eachCount()
        fun notes(n: Int) = if (n == 1) "1 note" else "$n notes"
        fun files(n: Int) = if (n == 1) "1 file" else "$n files"
        return buildList {
            counts["download"]?.let { add("${notes(it)} will come from GitHub.") }
            counts["upload"]?.let { add("${notes(it)} from this phone will be added to GitHub.") }
            counts["update-local"]?.let { add("${notes(it)} here will be updated from GitHub.") }
            counts["conflict"]?.let { add("${notes(it)} differ here and on GitHub. Each will keep both versions.") }
            val deletions = (counts["review-local-deletion"] ?: 0) + (counts["review-remote-deletion"] ?: 0)
            if (deletions > 0) add("${notes(deletions)} deleted on one side will be checked after setup.")
            val skipped = (counts["unreadable"] ?: 0) + (counts["native-pending"] ?: 0)
            if (skipped > 0) add("${files(skipped)} over 8 MB will stay as they are.")
            if (isEmpty()) add("This phone and GitHub already match.")
        }
    }

    /** One line and two choices for a bulk deletion waiting for a decision. */
    data class DeletionChoice(val text: String, val keepSide: String, val otherSide: String)

    /** [mine] keeps this phone's side, [otherSide] keeps GitHub's. */
    fun deletion(direction: String?, count: Int): DeletionChoice {
        val notes = if (count == 1) "1 note was" else "$count notes were"
        return if (direction == "local") {
            DeletionChoice("$notes deleted on this phone.", keepSide = "Delete on GitHub too", otherSide = "Bring them back")
        } else {
            DeletionChoice("$notes deleted on GitHub.", keepSide = "Keep them here", otherSide = "Delete here too")
        }
    }

    fun collision(paths: List<String>): String {
        val names = paths.take(2).joinToString(" and ") { "“${it.substringAfterLast('/').removeSuffix(".md")}”" }
        return "$names differ only in capital letters. Rename one to keep syncing."
    }

    fun needsChoice(path: String): String = "“${path.substringAfterLast('/')}” couldn't be synced. Open it on a computer to check it."

    /** GitHub's fine-grained token form, prefilled as the Obsidian plugin does: Contents write, Metadata read. */
    fun tokenCreationUrl(owner: String?): Uri = Uri.parse("https://github.com/settings/personal-access-tokens/new").buildUpon()
        .appendQueryParameter("name", "Notes on Android")
        .appendQueryParameter("description", "Sync my notes with GitHub")
        .appendQueryParameter("contents", "write")
        .appendQueryParameter("metadata", "read")
        .apply { if (!owner.isNullOrBlank()) appendQueryParameter("target_name", owner) }
        .build()

    // Images in the editor.
    const val ImageLoading = "Loading image…"
    const val ImageOffline = "Image not available offline"
    const val ImageMissing = "Image not found"
    const val ImageUnsupported = "Can't show this image here"
}
