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
