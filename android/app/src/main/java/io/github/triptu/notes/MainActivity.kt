package io.github.triptu.notes

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import io.github.triptu.notes.ui.theme.NotesTheme

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            NotesTheme { AppRoot(vm) }
        }
        // Only a fresh launch: a theme change recreates the activity with the same intent.
        if (savedInstanceState == null) demo(intent)
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        demo(intent)
    }

    /** Debug builds: `adb shell am start ... --es demoSync offline|offline-long|error|access|downloading|off`. */
    private fun demo(intent: android.content.Intent?) {
        if (BuildConfig.DEBUG) intent?.getStringExtra("demoSync")?.let(vm::demoSync)
    }

    override fun onStart() {
        super.onStart()
        vm.refresh()
    }

    override fun onStop() {
        vm.flushEditors()
        super.onStop()
    }
}
