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
import io.github.triptu.notes.lately.LatelyScreen
import io.github.triptu.notes.library.LibraryScreen
import io.github.triptu.notes.settings.Pin
import io.github.triptu.notes.settings.SettingsScreen
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.vault.FolderPath
import kotlinx.coroutines.launch

private object Pages {
    const val Library = 0
    const val Home = 1
    const val Lately = 2
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
    val location by vm.library.location.collectAsStateWithLifecycle()
    val contents by vm.library.contents.collectAsStateWithLifecycle()
    val query by vm.library.query.collectAsStateWithLifecycle()
    val results by vm.library.results.collectAsStateWithLifecycle()
    val lately by vm.lately.collectAsStateWithLifecycle()

    // Back closes overlays first, then leaves a folder or side page for Home. On Home it exits.
    BackHandler(enabled = vm.overlays.isEmpty() && pager.currentPage != Pages.Home) {
        if (pager.currentPage == Pages.Library && vm.library.up()) return@BackHandler
        go(Pages.Home)
        if (location.fromPin) vm.library.reset()
    }
    BackHandler(enabled = vm.overlays.isNotEmpty()) { vm.back() }

    Box(Modifier.fillMaxSize().background(colors.bg)) {
        HorizontalPager(
            state = pager,
            beyondViewportPageCount = 1,
            modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing),
        ) { page ->
            when (page) {
                Pages.Library -> LibraryScreen(
                    location = location,
                    contents = contents,
                    query = query,
                    results = results,
                    pins = pins,
                    onQuery = vm.library::setQuery,
                    onUp = {
                        if (location.fromPin) {
                            go(Pages.Home)
                            vm.library.reset()
                        } else {
                            vm.library.up()
                        }
                    },
                    onHome = { go(Pages.Home) },
                    onOpenFolder = vm.library::open,
                    onOpenNote = vm::openNote,
                    onTogglePin = vm::togglePin,
                    onSettings = vm::openSettings,
                )
                Pages.Home -> HomeScreen(
                    pins = pins,
                    weeklyFolder = FolderPath(capture.weeklyFolder.trim('/')),
                    onLibrary = { go(Pages.Library) },
                    onLately = { go(Pages.Lately) },
                    onPin = { pin ->
                        when (pin) {
                            is Pin.Note -> vm.openNote(pin.path)
                            Pin.ThisWeek -> vm.openThisWeek()
                            is Pin.Folder -> {
                                vm.openPinnedFolder(pin.path)
                                go(Pages.Library)
                            }
                        }
                    },
                    onUnpin = vm::togglePin,
                    onCompose = { vm.capture() },
                    onVoice = { vm.capture(voice = true) },
                )
                else -> LatelyScreen(lately, onHome = { go(Pages.Home) }, onOpen = vm::openNote)
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
