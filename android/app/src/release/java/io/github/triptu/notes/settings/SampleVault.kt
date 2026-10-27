package io.github.triptu.notes.settings

import android.content.Context
import io.github.triptu.notes.AppGraph

/** Release builds ship no sample vault. */
object SampleVault {
    const val Available = false

    @Suppress("UNUSED_PARAMETER")
    suspend fun load(context: Context, graph: AppGraph) = Unit
}
