package io.github.triptu.notes

import android.app.Application
import android.content.Context

class NotesApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this).also { it.start() }
    }
}

val Context.graph: AppGraph get() = (applicationContext as NotesApp).graph
