package io.github.triptu.notes.editor

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import io.github.triptu.notes.capture.CaptureService
import io.github.triptu.notes.capture.CaptureSettings
import io.github.triptu.notes.vault.FileVaultStore
import io.github.triptu.notes.vault.FolderPath
import java.time.LocalDateTime
import io.github.triptu.notes.vault.NotePath
import io.github.triptu.notes.vault.VaultIndex
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class EditorSessionTest {
    @get:Rule val temp = TemporaryFolder()

    private val path = NotePath("Todos.md")

    private fun TestScope.open(text: String): Triple<EditorSession, FileVaultStore, File> {
        val root = temp.newFolder("vault")
        File(root, path.value).writeText(text)
        val store = FileVaultStore(root, Dispatchers.Unconfined)
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val index = VaultIndex(store, File(temp.root, "index"), scope, Dispatchers.Unconfined)
        val session = EditorSession(EditorTarget.Open(path), store, index, CaptureService(store) { CaptureSettings() }, scope)
        advanceUntilIdle()
        return Triple(session, store, root)
    }

    @Test
    fun `an outside change reloads in place when nothing is unsaved`() = runTest {
        val (session, store, root) = open("milk\neggs\n")
        session.onValueChange(session.value.copy(selection = TextRange(7))) // after "eg"
        File(root, path.value).writeText("bread\nmilk\neggs\n")
        store.notifyExternalChange()
        advanceUntilIdle()
        assertEquals("bread\nmilk\neggs\n", session.value.text)
        assertEquals(TextRange(13), session.value.selection)
        session.close(CoroutineScope(Dispatchers.Unconfined))
    }

    @Test
    fun `an outside change while edits are unsaved merges both, and the merge is saved`() = runTest {
        val (session, store, root) = open("milk\neggs\nrice\n")
        session.onValueChange(TextFieldValue("milk\neggs\nrice\ntea\n", TextRange(17)))
        File(root, path.value).writeText("oat milk\neggs\nrice\n")
        store.notifyExternalChange()
        advanceUntilIdle()
        assertEquals("oat milk\neggs\nrice\ntea\n", session.value.text)
        assertEquals(TextRange(21), session.value.selection)
        assertEquals("oat milk\neggs\nrice\ntea\n", File(root, path.value).readText())
        session.close(CoroutineScope(Dispatchers.Unconfined))
    }

    @Test
    fun `an outside change to the line being edited keeps both versions`() = runTest {
        val (session, store, root) = open("milk\n")
        session.onValueChange(TextFieldValue("milk and tea\n", TextRange(12)))
        File(root, path.value).writeText("milk and coffee\n")
        store.notifyExternalChange()
        advanceUntilIdle()
        val both = "<<<<<<< This phone\nmilk and tea\n\n=======\nmilk and coffee\n>>>>>>> GitHub\n"
        assertEquals(both, session.value.text)
        assertEquals(both, File(root, path.value).readText())
        session.close(CoroutineScope(Dispatchers.Unconfined))
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class NewNoteTest {
    @get:Rule val temp = TemporaryFolder()

    @Test
    fun `a new note in a folder is named by the hour and its first words, following them as they change`() = runTest {
        val root = temp.newFolder("vault")
        val store = FileVaultStore(root, Dispatchers.Unconfined)
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val index = VaultIndex(store, File(temp.root, "index"), scope, Dispatchers.Unconfined)
        val session = EditorSession(
            EditorTarget.New(FolderPath("Writing"), voice = false), store, index,
            CaptureService(store) { CaptureSettings() }, scope, now = { LocalDateTime.of(2026, 10, 27, 9, 41) },
        )
        session.onValueChange(TextFieldValue("Draft about"))
        advanceUntilIdle()
        session.onValueChange(TextFieldValue("Draft about rivers"))
        advanceUntilIdle()
        assertEquals(listOf("2026102709 Draft about rivers.md"), File(root, "Writing").list()!!.toList())
        assertEquals("Draft about rivers", session.title)
        session.close(CoroutineScope(Dispatchers.Unconfined))
    }
}

class MapSelectionTest {
    @Test
    fun `cursor keeps its place around an outside edit`() {
        assertEquals(TextRange(2), EditOps.mapSelection("abcdef", "abXXcdef", TextRange(2)))
        assertEquals(TextRange(7), EditOps.mapSelection("abcdef", "abXXcdef", TextRange(5)))
        assertEquals(TextRange(3), EditOps.mapSelection("abcdef", "abXf", TextRange(4)))
    }
}
