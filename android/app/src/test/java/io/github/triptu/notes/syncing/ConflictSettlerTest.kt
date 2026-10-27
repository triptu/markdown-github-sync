package io.github.triptu.notes.syncing

import io.github.triptu.notes.sync.FileVersion
import io.github.triptu.notes.sync.Resolution
import io.github.triptu.notes.sync.SyncConflict
import io.github.triptu.notes.sync.SyncError
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class ConflictSettlerTest {
    private fun content(id: String) = SyncConflict(
        id = id, kind = "content", path = "a.md", paths = listOf("a.md"), choices = listOf("mine", "remote", "both", "edit"),
        sibling = null, base = FileVersion("b", "x\n"), local = FileVersion("l", "here\n"), remote = FileVersion("r", "there\n"),
    )

    @Test
    fun `same-line edits are resolved with both versions inline`() = runBlocking {
        val calls = mutableListOf<Pair<String, Resolution>>()
        ConflictSettler().settle(listOf(content("c1"))) { id, r -> calls += id to r }
        assertEquals(listOf("c1" to Resolution.Edited(BothVersions.merge("x\n", "here\n", "there\n"))), calls)
    }

    @Test
    fun `a failed resolve is tried again on the next report, a successful one is not`() = runBlocking {
        val settler = ConflictSettler()
        var attempts = 0
        settler.settle(listOf(content("c1"))) { _, _ -> attempts++; throw SyncError(SyncError.Kind.Offline, "offline") }
        settler.settle(listOf(content("c1"))) { _, _ -> attempts++ }
        settler.settle(listOf(content("c1"))) { _, _ -> attempts++ }
        assertEquals(2, attempts)
    }

    @Test
    fun `bulk deletions wait for a choice`() = runBlocking {
        val bulk = SyncConflict("d1", "bulk-deletion", "a.md", listOf("a.md", "b.md"), listOf("mine", "remote"), sibling = null, base = null, local = null, remote = null, direction = "remote")
        val left = ConflictSettler().settle(listOf(bulk)) { _, _ -> error("must not resolve") }
        assertEquals(DeletionDecision("d1", "remote", 2), left.deletion)
    }
}
