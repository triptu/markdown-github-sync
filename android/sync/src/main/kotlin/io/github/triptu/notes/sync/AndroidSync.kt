package io.github.triptu.notes.sync

import android.content.Context

/** The engine bundle this module packages as an asset. */
fun readEngineScript(context: Context): String =
    context.assets.open("sync-engine.js").use { it.readBytes().toString(Charsets.UTF_8) }
