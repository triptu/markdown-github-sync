package io.github.triptu.notes.settings

import android.content.Context
import android.content.res.AssetManager
import io.github.triptu.notes.AppGraph
import io.github.triptu.notes.vault.FolderPath
import io.github.triptu.notes.vault.NotePath
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

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
        graph.index.refresh()
        graph.settings.setPins(
            listOf(
                Pin.Note(NotePath("Todos.md")),
                Pin.ThisWeek,
                Pin.Note(NotePath("Ideas to build.md")),
                Pin.Note(NotePath("Reading list.md")),
                Pin.Folder(FolderPath("Writing")),
            ),
        )
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
