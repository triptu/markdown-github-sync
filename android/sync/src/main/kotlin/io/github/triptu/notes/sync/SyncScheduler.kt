package io.github.triptu.notes.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

/**
 * When syncs run; the plugin's ForegroundScheduler policy. One sync at a
 * time. Edits wait for 30 s without typing, at most 2 minutes after the first
 * unsynced edit. Leaving the app sends waiting edits at once. While the app
 * is open it syncs every 5 minutes, and soon after returning to it. Failures
 * back off from 5 s to 5 minutes, or until GitHub's rate-limit reset.
 */
class SyncScheduler internal constructor(
    private val scope: CoroutineScope,
    private val run: suspend () -> Unit,
    private val onError: (Throwable) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private var visible = false
    private var stopped = false
    private var running = false
    private var pending = false
    private var failures = 0
    private var retryAfter = 0L
    private var editedSince: Long? = null
    private var timer: Job? = null
    private var current: CompletableDeferred<Unit>? = null
    private var followUp: CompletableDeferred<Unit>? = null

    @Synchronized
    fun foreground() {
        visible = true
        schedule(FOREGROUND_DELAY)
    }

    /** Leaving the app: send waiting edits now, before the system may suspend it. */
    @Synchronized
    fun background() {
        if (editedSince != null && !stopped) scope.launch { now() }
        visible = false
        timer?.cancel()
        timer = null
    }

    @Synchronized
    fun edited(quiet: Long = QUIET, maxWait: Long = MAX_WAIT) {
        val at = clock()
        val since = editedSince ?: at.also { editedSince = it }
        schedule(max(0, min(quiet, since + maxWait - at)))
    }

    @Synchronized
    fun schedule(delayMillis: Long = RETRY_DELAY) {
        if (stopped || !visible) return
        if (running) {
            pending = true
            return
        }
        timer?.cancel()
        val wait = max(delayMillis, retryAfter - clock())
        timer = scope.launch {
            delay(wait)
            execute(manual = false)
        }
    }

    /**
     * Runs a sync now. During a running sync it waits for that one and then
     * runs once more, so a decision recorded mid-sync is applied right away.
     */
    suspend fun now() {
        val follow = synchronized(this) {
            val active = current ?: return@synchronized null
            followUp ?: CompletableDeferred<Unit>().also { next ->
                followUp = next
                scope.launch {
                    active.await()
                    synchronized(this@SyncScheduler) { followUp = null }
                    try { execute(manual = true) } finally { next.complete(Unit) }
                }
            }
        }
        if (follow != null) follow.await() else execute(manual = true)
    }

    fun stop() = synchronized(this) {
        stopped = true
        timer?.cancel()
        timer = null
    }

    private suspend fun execute(manual: Boolean) {
        val done: CompletableDeferred<Unit>
        synchronized(this) {
            if (stopped || running || (!manual && !visible)) return
            // A sync the user asked for tries now; only automatic ones wait out the backoff.
            if (!manual && clock() < retryAfter) {
                schedule()
                return
            }
            timer?.cancel()
            timer = null
            running = true
            pending = false
            editedSince = null
            done = CompletableDeferred()
            current = done
        }
        try {
            run()
            synchronized(this) {
                failures = 0
                retryAfter = 0
            }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            synchronized(this) {
                failures++
                retryAfter = clock() + min(MAX_BACKOFF, BASE_BACKOFF shl min(failures - 1, 6))
                val retryAt = (error as? SyncError)?.retryAt
                if (retryAt != null) retryAfter = max(retryAfter, retryAt)
            }
            onError(error)
        } finally {
            synchronized(this) {
                running = false
                current = null
                done.complete(Unit)
                // Edits made during the run keep their typing pause rather than syncing right after.
                if (editedSince != null) edited() else schedule(if (pending) RETRY_DELAY else PERIOD)
            }
        }
    }

    /** Asks for another run soon, e.g. when the engine was waiting on another device. */
    internal fun requestFollowUp() = synchronized(this) { pending = true }

    companion object {
        const val QUIET = 30_000L
        const val MAX_WAIT = 120_000L
        const val PERIOD = 300_000L
        const val RETRY_DELAY = 3_000L
        const val FOREGROUND_DELAY = 1_000L
        const val BASE_BACKOFF = 5_000L
        const val MAX_BACKOFF = 300_000L
    }
}
