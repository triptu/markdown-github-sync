package io.github.triptu.notes

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.triptu.notes.quick.QuickLaunch
import io.github.triptu.notes.quick.QuickShortcuts
import io.github.triptu.notes.ui.theme.NotesTheme

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    /** Debug builds: `am start ... --es theme light|dark` draws the app in that theme, for screenshots. */
    private var forcedDark by mutableStateOf<Boolean?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        readThemeOverride(intent)
        // Recreated after a rotation or process death: the action already ran.
        if (savedInstanceState == null) QuickLaunch.read(intent)?.let(vm::runQuick)
        setContent {
            NotesTheme(dark = forcedDark ?: isSystemInDarkTheme()) { AppRoot(vm) }
        }
        QuickShortcuts.publish(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readThemeOverride(intent)
        QuickLaunch.read(intent)?.let(vm::runQuick)
    }

    private fun readThemeOverride(intent: Intent?) {
        if (!BuildConfig.DEBUG) return
        val dark = when (intent?.getStringExtra("theme")) {
            "dark" -> true
            "light" -> false
            else -> return
        }
        forcedDark = dark
        val bars = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        enableEdgeToEdge(bars, bars)
    }

    override fun onStart() {
        super.onStart()
        vm.refresh()
    }

    override fun onStop() {
        vm.pauseVoice()
        vm.flushEditors()
        super.onStop()
    }
}
