package io.github.triptu.notes.sync

import io.github.triptu.notes.sync.internal.Attachments
import io.github.triptu.notes.sync.internal.EngineException
import io.github.triptu.notes.sync.internal.EngineRuntime
import io.github.triptu.notes.sync.internal.GitHubHttp
import io.github.triptu.notes.sync.internal.JournalFiles
import io.github.triptu.notes.sync.internal.atomicWrite
import io.github.triptu.notes.sync.internal.list
import io.github.triptu.notes.sync.internal.obj
import io.github.triptu.notes.sync.internal.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.File
import java.util.UUID

/**
 * Syncs one vault folder with one GitHub repository, running the Obsidian
 * plugin's engine in QuickJS. Create one per vault and keep it for the app's
 * lifetime. All suspend functions are safe to call from the main thread.
 *
 * Lifecycle: call [onForeground]/[onBackground] from the app's lifecycle;
 * edits made through [vault] schedule syncs on their own.
 */
class SyncClient(
    /** App-private folder for this vault's journal, attachment cache and device id. */
    storageDir: File,
    /**
     * The app's private copy of the vault. Share one instance between the app
     * and the client, so the app's writes and sync's take the same lock.
     */
    val vault: VaultFiles,
    private val config: SyncConfig,
    private val tokens: TokenProvider,
    /** The bundled engine: `context.assets.open("sync-engine.js")`, see [readEngineScript]. */
    engineScript: String,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Diagnostics: one line per engine call and GitHub request. Never shown to the user. */
    private val log: (String) -> Unit = {},
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = GitHubHttp()
    private val lastSyncedFile = File(storageDir, "last-synced")
    private val installationId: String = installationId(storageDir)
    /**
     * The on-demand list is part of the engine's scope, so it may change only
     * at (re-)enrollment: the list enrollment used is stored and kept until then.
     */
    private val onDemandFile = File(storageDir, "on-demand-extensions")
    private val requestedOnDemand = config.onDemandExtensions.sorted()
    @Volatile private var onDemand: List<String> =
        onDemandFile.takeIf { it.isFile }?.readLines()?.filter { it.isNotBlank() }?.sorted() ?: requestedOnDemand

    /** Extensions this device currently leaves on GitHub. */
    val onDemandExtensions: List<String> get() = onDemand

    /** True when [SyncConfig.onDemandExtensions] differs from the enrolled list; set up sync again to adopt it. */
    val onDemandChangePending: Boolean get() = onDemand != requestedOnDemand

    private val engine = EngineRuntime(
        bundle = engineScript,
        vault = vault,
        journal = JournalFiles(File(storageDir, "journal")),
        http = http,
        token = { token() },
        progress = { done, total -> _status.value = SyncStatus.Syncing(done, total) },
        log = log,
    )
    private val attachments = Attachments(File(storageDir, "attachments"), http, config.owner, config.repository, config.branch, { token() })

    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.NotSetUp)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    private val _vaultChanges = MutableSharedFlow<List<String>>(extraBufferCapacity = 16)
    /** Paths sync created, replaced or deleted in [vault]; reload any that are open. */
    val vaultChanges: SharedFlow<List<String>> = _vaultChanges.asSharedFlow()

    private var lastSyncedAt: Long? = lastSyncedFile.takeIf { it.isFile }?.readText()?.trim()?.toLongOrNull()
    @Volatile private var opened = false
    @Volatile private var deviceName = config.deviceName
    private var openedDeviceName = deviceName
    @Volatile private var enrolled = false

    val scheduler = SyncScheduler(scope, run = { runSync() }, onError = { report(it) }, clock = clock)

    private val onLocalChange: () -> Unit = { if (enrolled) scheduler.edited() }

    init {
        vault.onLocalChange = onLocalChange
        scope.launch {
            try { refresh() } catch (error: kotlinx.coroutines.CancellationException) { throw error } catch (error: Throwable) { report(error) }
        }
    }

    // ---- Lifecycle ------------------------------------------------------------

    /** The app is visible: sync soon, then every 5 minutes. */
    fun onForeground() = scheduler.foreground()

    /** The app left the screen: send waiting edits now. */
    fun onBackground() = scheduler.background()

    /** Names this device in commit messages from the next sync on. */
    fun setDeviceName(name: String) {
        deviceName = name
    }

    /** Call after edits made outside [vault]'s write methods (normally not needed). */
    fun onEdited() = scheduler.edited()

    /** True when app edits are waiting for their sync. */
    val hasWaitingEdits: Boolean get() = scheduler.hasWaitingEdits

    /**
     * For background work: makes sure edits made so far reach GitHub. Waits for
     * a running sync and runs another only if it failed or edits arrived since.
     * Returns the resulting status.
     */
    suspend fun sendWaitingEdits(): SyncStatus {
        scheduler.flush()
        return status.value
    }

    // ---- Setup ----------------------------------------------------------------

    /** Reads engine state (no network) and publishes it to [status]. */
    suspend fun refresh(): SyncStatus = guard {
        val value = engine.call("status").obj()
        enrolled = value["kind"] == "enrolled"
        if (enrolled && !onDemandFile.isFile) persistOnDemand()
        statusFrom(value).also { _status.value = it }
    }

    /** Checks the token can read the repository and the branch exists. */
    suspend fun checkAccess() = guard { engine.call("checkAccess"); Unit }

    /** What enrolling would do to this device's files. Changes nothing. */
    suspend fun previewEnrollment(): EnrollmentPreview = guard {
        var value = engine.call("previewEnrollment").obj()
        if (value["kind"] == "preview" && onDemand != requestedOnDemand) {
            // Setting up (again) is when a new on-demand list takes effect.
            onDemand = requestedOnDemand
            opened = false
            ensureOpen()
            value = engine.call("previewEnrollment").obj()
        }
        if (value["kind"] != "preview") throw unavailable(value)
        preview(value)
    }

    /** Confirms a preview. The first sync afterwards downloads and uploads. */
    suspend fun enroll(previewToken: String): EnrollResult = guard {
        val value = engine.call("enroll", mapOf("token" to previewToken)).obj()
        when (value["kind"]) {
            "enrolled" -> { enrolled = true; persistOnDemand(); EnrollResult.Enrolled }
            "already-enrolled" -> { enrolled = true; EnrollResult.AlreadyEnrolled }
            "stale" -> EnrollResult.Stale(preview(value["preview"].obj()))
            else -> throw unavailable(value)
        }
    }

    // ---- Sync -----------------------------------------------------------------

    /**
     * Syncs now (or right after a running sync) and returns the resulting
     * status. Failures are reported in the status, not thrown.
     */
    suspend fun syncNow(): SyncStatus {
        scheduler.now()
        return status.value
    }

    /** Conflicts waiting for a choice, from the last sync. */
    suspend fun conflicts(): List<SyncConflict> = guard {
        engine.call("status").obj()["conflicts"]?.list().orEmpty().map { conflict(it.obj()) }
    }

    /** Records a choice; the next sync (started here) applies it. */
    suspend fun resolve(conflictId: String, resolution: Resolution) {
        val choice: Any = when (resolution) {
            Resolution.Mine -> "mine"
            Resolution.Theirs -> "remote"
            Resolution.Both -> "both"
            is Resolution.Edited -> mapOf("edit" to resolution.text)
        }
        val value = guard { engine.call("resolve", mapOf("conflictId" to conflictId, "choice" to choice)).obj() }
        when (value["kind"]) {
            "recorded" -> scope.launch { scheduler.now() }
            "stale" -> throw SyncError(SyncError.Kind.Conflict, "This conflict changed. Review it again.")
            "invalid" -> throw SyncError(SyncError.Kind.Other, value.str("reason") ?: "That choice isn't available.")
            else -> throw unavailable(value)
        }
    }

    // ---- Attachments ------------------------------------------------------------

    /** True for files kept on GitHub and fetched with [fetchAttachment]. */
    fun isOnDemand(path: String): Boolean {
        val name = path.substringAfterLast('/')
        val dot = name.lastIndexOf('.')
        return dot > 0 && name.substring(dot + 1).lowercase() in onDemand
    }

    /** Downloads one on-demand file at the branch head (cached); read-only. */
    suspend fun fetchAttachment(path: String): File = withContext(Dispatchers.IO) {
        try {
            attachments.fetch(path)
        } catch (error: Attachments.Failure) {
            throw SyncError(if (error.status == 401 || error.status == 403) SyncError.Kind.Access else SyncError.Kind.Other, error.message ?: "Download failed")
        } catch (error: java.io.IOException) {
            throw SyncError(SyncError.Kind.Offline, "Couldn't reach GitHub. Check your connection.")
        }
    }

    /** Every file path on GitHub at the branch head (one request), to find embeds by name. */
    suspend fun remotePaths(): List<String> = withContext(Dispatchers.IO) {
        try {
            attachments.paths()
        } catch (error: Attachments.Failure) {
            throw SyncError(if (error.status == 401 || error.status == 403) SyncError.Kind.Access else SyncError.Kind.Other, error.message ?: "Listing failed")
        } catch (error: java.io.IOException) {
            throw SyncError(SyncError.Kind.Offline, "Couldn't reach GitHub. Check your connection.")
        }
    }

    override fun close() {
        if (vault.onLocalChange === onLocalChange) vault.onLocalChange = null
        scheduler.stop()
        scope.cancel()
        engine.close()
    }

    // ---- Internals --------------------------------------------------------------

    private suspend fun ensureOpen() {
        if (opened) return
        engine.call("open", mapOf(
            "owner" to config.owner,
            "name" to config.repository,
            "branch" to config.branch,
            "deviceName" to deviceName,
            "installationId" to installationId,
            "excludedExtensions" to onDemand,
        ))
        openedDeviceName = deviceName
        opened = true
    }

    private suspend fun token(): String = tokens.token() ?: throw IllegalStateException("No token is saved.")

    private suspend fun <T> guard(body: suspend () -> T): T {
        try {
            ensureOpen()
            return body()
        } catch (error: EngineException) {
            throw SyncError(kind(error.category), error.message, error.retryAt, error.detail)
        } catch (error: SyncError) {
            throw error
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: Throwable) {
            // A broken bundle, a QuickJS failure or malformed engine output.
            throw SyncError(SyncError.Kind.Other, STOPPED, detail = error.toString())
        }
    }

    private fun persistOnDemand() {
        try { atomicWrite(onDemandFile, onDemand.joinToString("\n").toByteArray()) } catch (_: Exception) { /* Retried at the next refresh. */ }
    }

    private suspend fun runSync() {
        _status.value = SyncStatus.Syncing()
        // The engine takes the device name when it opens; opening again is cheap and offline.
        if (opened && openedDeviceName != deviceName) opened = false
        val outcome = try {
            guard { engine.call("sync").obj() }
        } finally {
            val changed = vault.takeSyncedPaths()
            if (changed.isNotEmpty()) _vaultChanges.tryEmit(changed)
        }
        val attention = outcome.str("attention")
        _status.value = when (outcome["kind"]) {
            "paused", "corrupt", "blocked", "native-error" -> SyncStatus.Error(problem(outcome))
            "unenrolled" -> { enrolled = false; SyncStatus.NotSetUp }
            "up-to-date", "synced" -> {
                enrolled = true
                markSynced()
                SyncStatus.Idle(lastSyncedAt, attention)
            }
            "needs-decision" -> SyncStatus.Conflict(outcome["conflicts"].list().map { conflict(it.obj()) },
                attention ?: "Some files changed both here and on GitHub. Choose which version to keep.")
            "contended", "settling" -> {
                scheduler.requestFollowUp()
                SyncStatus.Idle(lastSyncedAt)
            }
            else -> SyncStatus.Error(SyncError(SyncError.Kind.Other, STOPPED, detail = outcome.str("kind")))
        }
    }

    private fun report(error: Throwable) {
        val problem = error as? SyncError ?: SyncError(SyncError.Kind.Other, STOPPED, detail = error.toString())
        _status.value = when (problem.kind) {
            SyncError.Kind.Offline -> SyncStatus.Offline(lastSyncedAt)
            else -> SyncStatus.Error(problem)
        }
    }

    private fun markSynced() {
        val at = clock()
        lastSyncedAt = at
        try { atomicWrite(lastSyncedFile, at.toString().toByteArray()) } catch (_: Exception) { /* Display only. */ }
    }

    private fun statusFrom(value: Map<String, Any?>): SyncStatus = when (value["kind"]) {
        "enrolled" -> {
            val conflicts = value["conflicts"]?.list().orEmpty().map { conflict(it.obj()) }
            if (value["pause"] != null) SyncStatus.Error(problem(value))
            else if (conflicts.isNotEmpty()) SyncStatus.Conflict(conflicts, "Some files changed both here and on GitHub. Choose which version to keep.")
            else SyncStatus.Idle(lastSyncedAt)
        }
        "corrupt" -> SyncStatus.Error(problem(value))
        else -> SyncStatus.NotSetUp
    }

    private fun unavailable(value: Map<String, Any?>): SyncError = when (value["kind"]) {
        "unenrolled" -> SyncError(SyncError.Kind.Other, "Sync isn't set up on this device yet.")
        "already-enrolled" -> SyncError(SyncError.Kind.Other, "Sync is already set up on this device.")
        "busy" -> SyncError(SyncError.Kind.Other, "Sync is busy. Try again in a moment.")
        "corrupt", "paused" -> problem(value)
        else -> SyncError(SyncError.Kind.Other, "Sync can't do that right now.", detail = value.str("kind"))
    }

    /** Plain wording for states that stop sync; the engine's own words go to `detail`. */
    private fun problem(value: Map<String, Any?>): SyncError {
        val pause = value["pause"]?.obj()
        val message = when {
            value["kind"] == "corrupt" -> "Sync's records on this device are damaged. Set up sync again to continue."
            value["kind"] == "blocked" -> "Some updates from GitHub couldn't be saved because those files changed here. Sync will try again."
            value["kind"] == "native-error" -> "A file couldn't be saved, so sync stopped."
            else -> when (pause?.str("reason")) {
                "repository-changed" -> "The GitHub repository was replaced. Set up sync again to continue."
                "history-rewritten" -> "The history on GitHub was rewritten. Set up sync again to continue."
                "duplicate-installation", "ledger-diverged" -> "Another copy of this app is syncing as this device. Set up sync again to continue."
                "scope-unreadable" -> "The repository's ignore file can't be used. Fix it on GitHub, then sync again."
                else -> "Sync is paused. Set up sync again to continue."
            }
        }
        return SyncError(SyncError.Kind.Other, message, detail = pause?.str("detail") ?: value.str("detail") ?: value.str("kind"))
    }

    private fun kind(category: String) = when (category) {
        "offline" -> SyncError.Kind.Offline
        "access" -> SyncError.Kind.Access
        else -> SyncError.Kind.Other
    }

    private fun preview(value: Map<String, Any?>) = EnrollmentPreview(
        token = value.str("token")!!,
        commit = value.str("commit")!!,
        reenrollment = value["reenrollment"] == true,
        items = value["items"].list().map { val item = it.obj(); item.str("path")!! to item.str("action")!! },
        unchanged = (value["unchanged"] as Double).toInt(),
    )

    private fun conflict(value: Map<String, Any?>): SyncConflict {
        fun version(key: String) = value[key]?.obj()?.let { FileVersion(it.str("oid")!!, it.str("text")) }
        val paths = value["paths"]?.list()?.map { it as String } ?: listOfNotNull(value.str("path"))
        return SyncConflict(
            id = value.str("id")!!,
            kind = value.str("kind")!!,
            path = value.str("path") ?: paths.firstOrNull().orEmpty(),
            paths = paths,
            choices = value["choices"]?.list()?.map { it as String }
                ?: if (value["kind"] == "bulk-deletion") listOf("mine", "remote") else emptyList(),
            sibling = value.str("sibling"),
            direction = value.str("direction"),
            base = version("base"),
            local = version("local"),
            remote = version("remote"),
        )
    }

    companion object {
        private fun installationId(storageDir: File): String {
            storageDir.mkdirs()
            val file = File(storageDir, "installation-id")
            file.takeIf { it.isFile }?.readText()?.trim()?.let { if (it.matches(UUID_PATTERN)) return it }
            val id = UUID.randomUUID().toString()
            atomicWrite(file, id.toByteArray())
            return id
        }

        private const val STOPPED = "Sync stopped. Your files are safe."
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    }
}
