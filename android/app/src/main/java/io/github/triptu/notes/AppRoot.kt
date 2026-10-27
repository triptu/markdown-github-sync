package io.github.triptu.notes

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesType
import kotlinx.coroutines.delay
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.triptu.notes.editor.EditorScreen
import io.github.triptu.notes.home.HomeScreen
import io.github.triptu.notes.recents.RecentsScreen
import io.github.triptu.notes.library.VaultScreen
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.settings.SettingsScreen
import io.github.triptu.notes.settings.SetupScreen
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.voice.VoiceScreen
import android.speech.SpeechRecognizer
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch

private object Pages {
    const val Vault = 0
    const val Home = 1
    const val Recents = 2
    const val Count = 3
}

@Composable
fun AppRoot(vm: MainViewModel) {
    val colors = NotesTheme.colors
    val pager = rememberPagerState(initialPage = Pages.Home) { Pages.Count }
    val scope = rememberCoroutineScope()
    fun go(page: Int) {
        scope.launch { pager.animateScrollToPage(page) }
    }

    val pins by vm.pins.collectAsStateWithLifecycle()
    val capture by vm.capture.collectAsStateWithLifecycle()
    val rows by vm.vaultTree.rows.collectAsStateWithLifecycle()
    val scrollTo by vm.vaultTree.scrollTo.collectAsStateWithLifecycle()
    val query by vm.vaultTree.query.collectAsStateWithLifecycle()
    val results by vm.vaultTree.results.collectAsStateWithLifecycle()
    val recents by vm.recents.collectAsStateWithLifecycle()
    val syncBar by vm.syncBar.collectAsStateWithLifecycle()
    val sampleVaultAvailable by vm.sampleVaultAvailable.collectAsStateWithLifecycle()
    val voiceDraft by vm.voiceDraft.collectAsStateWithLifecycle()
    val resurfaced by vm.resurfaced.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val canSpeak = remember { SpeechRecognizer.isRecognitionAvailable(context) || SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }

    // Back closes overlays first, then returns from a side page to Home. On Home it exits.
    BackHandler(enabled = vm.overlays.isEmpty() && pager.currentPage != Pages.Home) { go(Pages.Home) }
    BackHandler(enabled = vm.overlays.isNotEmpty()) { vm.back() }

    Box(Modifier.fillMaxSize().background(colors.bg)) {
        HorizontalPager(
            state = pager,
            beyondViewportPageCount = 1,
            modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
        ) { page ->
            when (page) {
                Pages.Vault -> VaultScreen(
                    rows = rows,
                    scrollTo = scrollTo,
                    onScrolled = vm.vaultTree::scrolled,
                    query = query,
                    results = results,
                    pins = pins,
                    onQuery = vm.vaultTree::setQuery,
                    onHome = { go(Pages.Home) },
                    onToggleFolder = vm.vaultTree::toggle,
                    onOpenNote = vm::openNote,
                    onTogglePin = vm::togglePin,
                    onSettings = vm::openSettings,
                    onNewNoteIn = vm::newNoteIn,
                    onNewFolder = vm::createFolder,
                    onRename = vm::renameNote,
                    onDelete = vm::deleteNote,
                )
                Pages.Home -> HomeScreen(
                    pins = pins,
                    weeklyFolder = FolderPath(capture.weeklyFolder.trim('/')),
                    onVault = { go(Pages.Vault) },
                    onRecents = { go(Pages.Recents) },
                    onPin = { pin ->
                        when (pin) {
                            is Pin.Note -> vm.openNote(pin.path)
                            Pin.ThisWeek -> vm.openThisWeek()
                            is Pin.Folder -> {
                                vm.openPinnedFolder(pin.path)
                                go(Pages.Vault)
                            }
                        }
                    },
                    onUnpin = vm::togglePin,
                    onCompose = { vm.newNote() },
                    onVoice = vm::speakNewNote,
                    voiceDraft = voiceDraft?.second,
                    onKeepDraft = vm::keepDraft,
                    onDiscardDraft = vm::discardDraft,
                    syncBar = syncBar,
                    onFixToken = { vm.openSettings(focusToken = true) },
                    onRetrySync = vm.sync::retry,
                    onOpenBothVersions = vm::openBothVersions,
                    onDeletion = vm.sync::decideDeletion,
                    resurfaced = resurfaced,
                    onResurfaced = { vm.openNote(it) },
                    onPutAway = vm::putAwayResurfaced,
                )
                else -> RecentsScreen(recents, FolderPath(capture.weeklyFolder.trim('/')), onHome = { go(Pages.Home) }, onOpen = { vm.openNote(it.path, reveal = it.source) })
            }
        }

        val top = vm.overlays.lastOrNull()
        AnimatedContent(
            targetState = top,
            transitionSpec = {
                (fadeIn(tween(160)) + slideInHorizontally(tween(200)) { it / 12 }) togetherWith fadeOut(tween(120))
            },
            contentKey = { overlay ->
                when (overlay) {
                    is Overlay.Editor -> System.identityHashCode(overlay.session)
                    is Overlay.Settings -> "settings"
                    is Overlay.Voice -> System.identityHashCode(overlay.session)
                    Overlay.Setup -> "setup"
                    null -> "none"
                }
            },
            label = "overlay",
        ) { overlay ->
            when (overlay) {
                is Overlay.Editor -> {
                    val path = overlay.session.path
                    EditorScreen(
                        session = overlay.session,
                        isPinned = path != null && Pin.Note(path) in pins,
                        onBack = { vm.back() },
                        onTogglePin = { path?.let { vm.togglePin(Pin.Note(it)) } },
                        onOpenLink = vm::openLink,
                        onDelete = vm::deleteOpenNote,
                        images = vm.graph.images,
                        onSpeak = if (canSpeak) ({ vm.speakInto(overlay.session) }) else null,
                    )
                }
                is Overlay.Settings -> SettingsScreen(
                    capture = capture,
                    onCapture = vm.graph.settings::updateCapture,
                    sync = vm.sync,
                    focusToken = overlay.focusToken,
                    sampleVaultAvailable = sampleVaultAvailable,
                    voice = vm.graph.voice,
                    voiceSettings = vm.graph.settings.voice,
                    onVoiceSettings = vm.graph.settings::updateVoice,
                    onLoadSampleVault = vm::loadSampleVault,
                    onBack = { vm.back() },
                )
                Overlay.Setup -> SetupScreen(vm.sync, onDone = vm::finishSetup)
                is Overlay.Voice -> VoiceScreen(overlay.session, onClose = vm::dismissVoice, onSave = vm::saveVoice, onType = vm::typeVoice)
                null -> Box(Modifier.fillMaxSize())
            }
        }

        vm.lastDeleted?.let { deleted ->
            UndoBar(
                text = "Deleted “${deleted.path.displayName}”",
                onUndo = vm::undoDelete,
                onTimeout = vm::dismissUndo,
                modifier = Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing),
            )
        }
    }
}

/** A short-lived bar offering Undo. It goes away on its own after a few seconds. */
@Composable
private fun UndoBar(text: String, onUndo: () -> Unit, onTimeout: () -> Unit, modifier: Modifier = Modifier) {
    val colors = NotesTheme.colors
    LaunchedEffect(text) {
        delay(UndoMs)
        onTimeout()
    }
    Row(
        modifier
            .padding(start = 16.dp, end = 16.dp, bottom = 80.dp)
            .fillMaxWidth()
            .height(52.dp)
            .shadow(6.dp, RoundedCornerShape(16.dp))
            .clip(RoundedCornerShape(16.dp))
            .background(colors.solid)
            .padding(start = 18.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = NotesType.row, color = colors.onSolid, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Box(
            Modifier.height(44.dp).pressable(onUndo, shape = RoundedCornerShape(12.dp), bleed = 14.dp, label = "Undo delete", pressColor = colors.ink2),
            contentAlignment = Alignment.Center,
        ) {
            Text("Undo", style = NotesType.row.copy(fontWeight = FontWeight.SemiBold), color = colors.onSolid)
        }
    }
}

private const val UndoMs = 5_000L
