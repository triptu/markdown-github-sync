package io.github.triptu.notes.settings

import android.content.Context
import android.content.res.AssetManager
import io.github.triptu.notes.AppGraph
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDateTime

/** Debug builds only: copies a made-up vault into the app's vault folder for testing and screenshots. */
object SampleVault {
    const val Available = true
    private const val AssetRoot = "sample-vault"
    private const val TimesFile = "sample-times.tsv"

    suspend fun load(context: Context, graph: AppGraph) {
        withContext(Dispatchers.IO) {
            val assets = context.assets
            val minutesAgo = assets.open("$AssetRoot/$TimesFile").bufferedReader().readLines()
                .mapNotNull { line -> line.split('\t').takeIf { it.size == 2 }?.let { it[0] to it[1].trim().toLong() } }
                .toMap()
            val now = System.currentTimeMillis()
            copy(assets, AssetRoot, graph.vaultRoot) { relative, file ->
                minutesAgo[relative]?.let { file.setLastModified(now - it * 60_000) }
            }
        }
        val thisWeek = graph.capture.weeklyPath(LocalDateTime.now())
        graph.index.refresh()
        graph.settings.setPins(
            listOf(
                Pin.Note(NotePath("Todos.md")),
                Pin.Note(latestWeekly(graph, thisWeek)),
                Pin.Note(NotePath("Ideas to build.md")),
                Pin.Note(NotePath("Reading list.md")),
                Pin.Folder(FolderPath("Writing")),
            ),
        )
    }

    /** This week's note if the sample has it, else the newest sample weekly note. */
    private suspend fun latestWeekly(graph: AppGraph, thisWeek: NotePath): NotePath {
        if (graph.store.exists(thisWeek)) return thisWeek
        return graph.store.list().notes.map { it.path }.filter { it.folder.value.endsWith("weekly") }.maxByOrNull { it.value } ?: thisWeek
    }

    private fun copy(assets: AssetManager, assetPath: String, target: File, relative: String = "", onFile: (String, File) -> Unit) {
        val children = assets.list(assetPath).orEmpty()
        if (children.isEmpty()) {
            if (relative.endsWith(NotePath.MD)) {
                val file = File(target, relative)
                file.parentFile?.mkdirs()
                assets.open(assetPath).use { input -> file.outputStream().use { input.copyTo(it) } }
                onFile(relative, file)
            }
            return
        }
        for (child in children) {
            copy(assets, "$assetPath/$child", target, if (relative.isEmpty()) child else "$relative/$child", onFile)
        }
    }
}
