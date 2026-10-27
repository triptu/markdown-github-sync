package io.github.triptu.notes.voice

import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class VoiceDraftTest {
    @get:Rule val temp = TemporaryFolder()

    private fun store() = DraftStore(File(temp.root, "drafts"))

    @Test
    fun `a draft survives the app restarting, with line breaks and its target`() {
        val draft = VoiceDraft(VoiceTarget.IntoNote(NotePath("Work/Plan.md"), 42), "First line.\nSecond line, still mine.", 42_000)
        store().save("0001", draft)
        assertEquals("0001" to draft, store().newest())
        val fresh = VoiceDraft(VoiceTarget.NewNote(FolderPath("Zettelkasten")), "Call the bank.", 5_000)
        store().save("0002", fresh)
        assertEquals("0002" to fresh, store().newest())
    }

    @Test
    fun `a new recording never overwrites an older draft`() {
        val s = store()
        val older = VoiceDraft(VoiceTarget.NewNote(FolderPath("Zettelkasten")), "older words", 1_000)
        s.save("0001", older)
        s.save("0002", VoiceDraft(VoiceTarget.NewNote(FolderPath("Zettelkasten")), "newer words", 2_000))
        s.clear("0002")
        assertEquals("0001" to older, s.newest())
    }

    @Test
    fun `words heard but not final yet are kept in the draft`() {
        val t = Transcript()
        val s = t.newSession()
        t.onFinal(s, "Pack the kitchen.")
        t.onPartial(s, "then the books")
        // The app is killed here: the draft holds everything heard so far.
        store().save("0001", VoiceDraft(VoiceTarget.NewNote(FolderPath.Root), t.text, 9_000))
        assertEquals("Pack the kitchen. Then the books", store().newest()?.second?.text)
    }

    @Test
    fun `blank drafts and damaged files are not offered`() {
        val s = store()
        s.save("0001", VoiceDraft(VoiceTarget.NewNote(FolderPath.Root), "   ", 1_000))
        assertNull(s.newest())
        File(temp.root, "drafts").mkdirs()
        File(temp.root, "drafts/0002").writeText("voice-draft 1\ninto\nnot-a-note\n0\n5")
        assertNull(s.newest())
        assertNull(VoiceDraft.decode("something else"))
    }
}
