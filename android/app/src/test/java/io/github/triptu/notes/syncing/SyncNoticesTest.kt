package io.github.triptu.notes.syncing

import io.github.triptu.notes.sync.SyncError
import io.github.triptu.notes.sync.SyncStatus
import io.github.triptu.notes.vault.IndexedNote
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class SyncNoticesTest {
    private val hour = 3_600_000L
    private val now = 100 * hour

    private fun bar(
        settled: SyncStatus,
        progress: SyncStatus.Syncing? = null,
        firstSync: Boolean = false,
        deletion: DeletionDecision? = null,
        problem: String? = null,
        both: List<NotePath> = emptyList(),
    ) = SyncNotices.bar(settled, progress, firstSync, deletion, problem, both, now)

    @Test
    fun `success is quiet`() {
        assertEquals(SyncBar.Quiet, bar(SyncStatus.Idle(now - hour)))
        assertEquals(SyncBar.Quiet, bar(SyncStatus.NotSetUp))
    }

    @Test
    fun `offline is an icon, then a line after six hours`() {
        assertEquals(SyncBar(true, emptyList()), bar(SyncStatus.Offline(now - 5 * hour)))
        assertEquals(SyncBar(false, listOf(SyncNotice.NotSynced(7))), bar(SyncStatus.Offline(now - 7 * hour)))
    }

    @Test
    fun `access problems ask for a token, other errors get one line`() {
        val access = SyncStatus.Error(SyncError(SyncError.Kind.Access, "GitHub rejected this token. It may be mistyped, expired or revoked."))
        assertEquals(listOf(SyncNotice.NeedsToken("GitHub rejected this token. It may be mistyped, expired or revoked.")), bar(access).notices)
        val other = SyncStatus.Error(SyncError(SyncError.Kind.Other, "Sync stopped. Your files are safe."))
        assertEquals(listOf(SyncNotice.Problem("Sync stopped. Your files are safe.")), bar(other, problem = "Rename one").notices)
    }

    @Test
    fun `first sync shows the download, then choices and notes with both versions`() {
        val decision = DeletionDecision("id", "remote", 30)
        val notes = listOf(NotePath("a.md"))
        assertEquals(
            listOf(SyncNotice.Downloading(3, 10), SyncNotice.Deletion(decision), SyncNotice.BothVersions(notes)),
            bar(SyncStatus.NotSetUp, SyncStatus.Syncing(3, 10), firstSync = true, deletion = decision, both = notes).notices,
        )
    }

    @Test
    fun `finder lists notes with markers, newest first, and rechecks only changed notes`() {
        fun note(path: String, text: String, at: Long) = IndexedNote(NotePath(path), at, text.length.toLong(), "", text)
        val conflicted = BothVersions.merge("a\n", "b\n", "c\n")
        val old = note("old.md", conflicted, 1)
        val plain = note("plain.md", "nothing here", 2)
        val finder = BothVersionsFinder()
        val first = VaultSnapshot(mapOf(old.path to old, plain.path to plain), emptySet(), true)
        assertEquals(listOf(NotePath("old.md")), finder.find(first))
        val fresh = note("new.md", conflicted, 3)
        val second = VaultSnapshot(mapOf(old.path to old, plain.path to plain, fresh.path to fresh), emptySet(), true)
        assertEquals(listOf(NotePath("new.md"), NotePath("old.md")), finder.find(second))
        val fixed = note("old.md", "b\n", 4)
        assertEquals(listOf(NotePath("new.md")), finder.find(VaultSnapshot(mapOf(fixed.path to fixed, fresh.path to fresh), emptySet(), true)))
    }
}
