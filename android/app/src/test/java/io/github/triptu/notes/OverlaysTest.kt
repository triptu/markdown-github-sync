package io.github.triptu.notes

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.capture.CaptureService
import io.github.triptu.notes.capture.CaptureSettings
import io.github.triptu.notes.editor.EditorSession
import io.github.triptu.notes.editor.EditorTarget
import io.github.triptu.notes.vault.FileVaultStore
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
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class OverlaysTest {
    @get:Rule val temp = TemporaryFolder()

    @Test
    fun `a cover screen or a phone held sideways gets one pane, an unfolded screen two`() {
        assertEquals(Panes.One, Panes.of(width = 443.dp, height = 940.dp))
        assertEquals(Panes.Two, Panes.of(width = 775.dp, height = 931.dp))
        assertEquals(Panes.Two, Panes.of(width = 852.dp, height = 883.dp))
        assertEquals(Panes.One, Panes.of(width = 891.dp, height = 411.dp))
    }

    @Test
    fun `beside the list a note takes the open note's place, and the replaced note is saved`() = runTest {
        val vault = Vault(this)
        val overlays = Overlays(CoroutineScope(Dispatchers.Unconfined))
        overlays.panes = Panes.Two
        val a = vault.open("A.md", "milk\n")
        val b = vault.open("B.md", "")
        overlays.show(a)
        a.session.onValueChange(TextFieldValue("milk\neggs\n", TextRange(10)))
        overlays.show(b)
        assertEquals(listOf<Overlay>(b), overlays.toList())
        assertEquals("milk\neggs\n", File(vault.root, "A.md").readText())
        overlays.close(b)
    }

    @Test
    fun `over the list a note stacks on the open one, so Back returns there`() = runTest {
        val vault = Vault(this)
        val overlays = Overlays(CoroutineScope(Dispatchers.Unconfined))
        val a = vault.open("A.md", "")
        val b = vault.open("B.md", "")
        overlays.show(a)
        overlays.show(b)
        assertEquals(listOf<Overlay>(a, b), overlays.toList())
        overlays.close(b)
        overlays.close(a)
    }

    @Test
    fun `in two panes the note sits beside the list and only other screens cover it`() = runTest {
        val vault = Vault(this)
        val overlays = Overlays(CoroutineScope(Dispatchers.Unconfined))
        overlays.panes = Panes.Two
        assertNull(overlays.note)
        assertNull(overlays.cover)
        val a = vault.open("A.md", "")
        overlays.show(a)
        assertEquals(a, overlays.note)
        assertNull(overlays.cover)
        overlays += Overlay.Settings()
        assertEquals(a, overlays.note)
        assertEquals(Overlay.Settings(), overlays.cover)
        overlays.close(a)
    }

    @Test
    fun `in one pane the note covers the list like any other screen`() = runTest {
        val vault = Vault(this)
        val overlays = Overlays(CoroutineScope(Dispatchers.Unconfined))
        val a = vault.open("A.md", "")
        overlays.show(a)
        assertNull(overlays.note)
        assertEquals(a, overlays.cover)
        overlays.close(a)
    }

    private inner class Vault(private val test: TestScope) {
        val root: File = temp.newFolder("vault")
        private val store = FileVaultStore(root, Dispatchers.Unconfined)

        fun open(name: String, text: String): Overlay.Editor {
            File(root, name).writeText(text)
            val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(test.testScheduler))
            val index = VaultIndex(store, File(temp.root, "index-$name"), scope, Dispatchers.Unconfined)
            val session = EditorSession(EditorTarget.Open(NotePath(name)), store, index, CaptureService(store) { CaptureSettings() }, scope)
            test.advanceUntilIdle()
            return Overlay.Editor(session)
        }
    }
}
