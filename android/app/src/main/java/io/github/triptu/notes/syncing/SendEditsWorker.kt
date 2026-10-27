package io.github.triptu.notes.syncing

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.triptu.notes.graph
import io.github.triptu.notes.sync.SyncStatus

/**
 * Sends edits made just before the app left the screen, even if Android stops the app first.
 * It runs in the app's process through the same [io.github.triptu.notes.sync.SyncClient], whose
 * scheduler allows one sync at a time: if the app's own background sync is still running, this
 * waits for it and runs again only if edits arrived since or it failed.
 */
class SendEditsWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val client = applicationContext.graph.sync.awaitClient() ?: return Result.success()
        return when (client.sendWaitingEdits()) {
            is SyncStatus.Offline -> Result.retry()
            else -> Result.success()
        }
    }

    companion object {
        private const val Name = "send-edits"

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SendEditsWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            // A run already going re-checks for edits when it ends; a queued one simply waits its turn.
            WorkManager.getInstance(context).enqueueUniqueWork(Name, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(Name)
        }
    }
}
