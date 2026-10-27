package io.github.triptu.notes

import android.app.Application
import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class NotesApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this).also { it.start() }
        // Sync soon after the app comes back, and send waiting edits as it leaves the screen.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = graph.sync.onForeground()
            override fun onStop(owner: LifecycleOwner) = graph.sync.onBackground()
        })
    }
}

val Context.graph: AppGraph get() = (applicationContext as NotesApp).graph
