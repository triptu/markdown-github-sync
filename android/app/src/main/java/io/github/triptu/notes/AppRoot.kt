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
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.vault.FolderPath
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
                    onCompose = { vm.capture() },
                    onVoice = { vm.capture(voice = true) },
                )
                else -> RecentsScreen(recents, onHome = { go(Pages.Home) }, onOpen = { vm.openNote(it.path, reveal = it.source) })
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
                    Overlay.Settings -> "settings"
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
                    )
                }
                Overlay.Settings -> SettingsScreen(
                    capture = capture,
                    onCapture = vm.graph.settings::updateCapture,
                    sampleVaultAvailable = vm.sampleVaultAvailable,
                    onLoadSampleVault = vm::loadSampleVault,
                    onBack = { vm.back() },
                )
                null -> Box(Modifier.fillMaxSize())
            }
        }
    }
}
