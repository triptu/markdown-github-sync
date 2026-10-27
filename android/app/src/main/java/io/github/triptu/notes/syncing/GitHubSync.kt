package io.github.triptu.notes.syncing

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import io.github.triptu.notes.settings.SettingsStore
import io.github.triptu.notes.sync.EnrollResult
import io.github.triptu.notes.sync.EnrollmentPreview
import io.github.triptu.notes.sync.Resolution
import io.github.triptu.notes.sync.SyncClient
import io.github.triptu.notes.sync.SyncConfig
import io.github.triptu.notes.sync.SyncConflict
import io.github.triptu.notes.sync.SyncError
import io.github.triptu.notes.sync.SyncStatus
import io.github.triptu.notes.sync.VaultFiles
import io.github.triptu.notes.sync.readEngineScript
import io.github.triptu.notes.vault.VaultChange
import io.github.triptu.notes.vault.VaultStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

/** Where the setup form is. Shared by the first-run screen and Settings. */
sealed interface SetupState {
    data object Idle : SetupState
    data object Checking : SetupState
    data class Failed(val message: String) : SetupState
    /** The phone already has notes: what setting up will do, waiting for "Start syncing". */
    data class Review(val lines: List<String>) : SetupState
    data object Starting : SetupState
    data class Downloading(val done: Int?, val total: Int?) : SetupState
    data object Done : SetupState
}

/** Replacing the token in Settings. */
sealed interface TokenState {
    data object Idle : TokenState
    data object Checking : TokenState
    data object Saved : TokenState
    data class Failed(val message: String) : TokenState
}

/** Many notes deleted on one side, waiting for the person to confirm. */
data class DeletionDecision(val conflictId: String, val direction: String?, val count: Int)

/**
 * The app's side of GitHub sync: owns the [SyncClient] once sync is set up, runs setup, keeps the
 * UI in step with what sync changed, and settles conflicts without asking (see [settle]).
 */
class GitHubSync(
    private val context: Context,
    private val files: Lazy<VaultFiles>,
    private val store: VaultStore,
    private val settings: SettingsStore,
    private val scope: CoroutineScope,
) {
    private val prefs = SyncPrefs(context.getSharedPreferences("sync", Context.MODE_PRIVATE))
    private val tokens = TokenVault(File(context.noBackupFilesDir, "github-token"))
    private val storageDir = File(context.noBackupFilesDir, "sync")
    private val engine: String by lazy { readEngineScript(context) }
    private val io = Dispatchers.IO
    private val mutex = Mutex()
    private val ready = CompletableDeferred<Unit>()

    private val _client = MutableStateFlow<SyncClient?>(null)
    private val _target = MutableStateFlow(prefs.target)

    /** Set while sync is set up. */
    val target: StateFlow<SyncTarget?> = _target.asStateFlow()

    @OptIn(ExperimentalCoroutinesApi::class)
    val status: StateFlow<SyncStatus> = _client
        .flatMapLatest { it?.status ?: flowOf(SyncStatus.NotSetUp) }
        .stateIn(scope, SharingStarted.Eagerly, SyncStatus.NotSetUp)

    private val _setup = MutableStateFlow<SetupState>(SetupState.Idle)
    val setup: StateFlow<SetupState> = _setup.asStateFlow()

    private val _token = MutableStateFlow<TokenState>(TokenState.Idle)
    val tokenState: StateFlow<TokenState> = _token.asStateFlow()

    private val _deletion = MutableStateFlow<DeletionDecision?>(null)
    val deletion: StateFlow<DeletionDecision?> = _deletion.asStateFlow()

    /** A conflict the app can't settle on its own, such as two names differing only in case. */
    private val _conflictProblem = MutableStateFlow<String?>(null)
    val conflictProblem: StateFlow<String?> = _conflictProblem.asStateFlow()

    /** From setup until the first sync finishes: Home shows the download. */
    private val _firstSync = MutableStateFlow(false)
    val firstSync: StateFlow<Boolean> = _firstSync.asStateFlow()

    val setupOffered: Boolean get() = prefs.setupOffered

    fun markSetupOffered() {
        prefs.setupOffered = true
    }

    @Volatile private var foreground = false
    @Volatile private var trialToken: String? = null
    private var candidate: Candidate? = null
    private var clientJobs: Job? = null
    private val settled = HashSet<String>()

    private class Candidate(val client: SyncClient, val target: SyncTarget, val token: String, val preview: EnrollmentPreview)

    fun start() {
        scope.launch(io) {
            try {
                val target = prefs.target
                if (target != null && tokens.read() != null) activate(newClient(target))
                else if (target != null) _target.value = null
            } finally {
                ready.complete(Unit)
            }
        }
        // An edit saved after the app left the screen (a late autosave) still has to reach GitHub.
        scope.launch {
            store.changes.collect { change ->
                if (!foreground && change !is VaultChange.External && _client.value != null) SendEditsWorker.enqueue(context)
            }
        }
    }

    /** The client once startup has opened it, or null when sync isn't set up. For background work. */
    suspend fun awaitClient(): SyncClient? {
        ready.await()
        return _client.value
    }

    fun onForeground() {
        Log.i(Tag, "foreground, client=${_client.value != null}")
        foreground = true
        _client.value?.onForeground()
    }

    /** Sends waiting edits now, and asks WorkManager to finish the job if the system stops the app. */
    fun onBackground() {
        foreground = false
        val client = _client.value ?: return
        val waiting = client.hasWaitingEdits
        Log.i(Tag, "background, waiting edits=$waiting")
        client.onBackground()
        if (waiting) SendEditsWorker.enqueue(context)
    }

    fun retry() {
        val client = _client.value ?: return
        scope.launch { client.syncNow() }
    }

    // ---- Setup ------------------------------------------------------------------

    /** Checks access, then previews. An empty phone (only downloads) starts syncing at once. */
    fun connect(repository: String, branch: String, token: String) {
        scope.launch(io) { mutex.withLock { connectLocked(repository, branch, token) } }
    }

    fun startSyncing() {
        scope.launch(io) { mutex.withLock { enrollLocked() } }
    }

    fun cancelSetup() {
        scope.launch(io) {
            mutex.withLock {
                dropCandidate()
                _setup.value = SetupState.Idle
            }
        }
    }

    private suspend fun connectLocked(repositoryText: String, branchText: String, tokenText: String) {
        if (_client.value != null) return
        val repository = SyncTarget.parseRepository(repositoryText) ?: return fail(SyncCopy.EnterRepository)
        val branch = branchText.trim().ifEmpty { "main" }
        if (!SyncTarget.isValidBranch(branch)) return fail("“$branch” isn't a valid branch name.")
        val token = tokenText.trim().ifEmpty { return fail(SyncCopy.EnterToken) }
        _setup.value = SetupState.Checking
        dropCandidate()
        // Nothing is enrolled yet, so any records here are from an unfinished setup.
        storageDir.deleteRecursively()
        val target = SyncTarget(repository.first, repository.second, branch)
        trialToken = token
        val client = newClient(target)
        try {
            client.checkAccess()
            if (settings.sampleVaultLoaded) clearSampleVault()
            val preview = client.previewEnrollment()
            candidate = Candidate(client, target, token, preview)
            if (preview.items.all { it.second == "download" }) enrollLocked()
            else _setup.value = SetupState.Review(SyncCopy.summary(preview))
        } catch (e: SyncError) {
            client.close()
            trialToken = null
            fail(message(e))
        }
    }

    private suspend fun enrollLocked() {
        val pending = candidate ?: return
        _setup.value = SetupState.Starting
        try {
            val result = pending.client.enroll(pending.preview.token)
            if (result is EnrollResult.Stale) {
                candidate = Candidate(pending.client, pending.target, pending.token, result.preview)
                _setup.value = SetupState.Review(SyncCopy.summary(result.preview))
                return
            }
        } catch (e: SyncError) {
            fail(message(e))
            return
        }
        tokens.write(pending.token)
        trialToken = null
        prefs.target = pending.target
        prefs.setupOffered = true
        _target.value = pending.target
        candidate = null
        _firstSync.value = true
        _setup.value = SetupState.Downloading(null, null)
        activate(pending.client)
        scope.launch { pending.client.syncNow() }
    }

    private fun dropCandidate() {
        candidate?.client?.close()
        candidate = null
        trialToken = null
    }

    private fun fail(message: String) {
        _setup.value = SetupState.Failed(message)
    }

    /** The debug sample vault must never reach a real repository. */
    private suspend fun clearSampleVault() {
        val vault = files.value
        for (entry in vault.list()) vault.delete(entry.path)
        vault.root.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }?.forEach { it.deleteRecursively() }
        settings.setSampleVaultLoaded(false)
        settings.resetPins()
        store.notifyExternalChange()
    }

    /** Replaces the token after checking it can reach the repository. */
    fun saveToken(text: String) {
        scope.launch(io) {
            mutex.withLock {
                val client = _client.value ?: return@withLock
                val token = text.trim()
                if (token.isEmpty()) {
                    _token.value = TokenState.Failed(SyncCopy.EnterToken)
                    return@withLock
                }
                _token.value = TokenState.Checking
                trialToken = token
                try {
                    client.checkAccess()
                    tokens.write(token)
                    _token.value = TokenState.Saved
                    scope.launch { client.syncNow() }
                } catch (e: SyncError) {
                    _token.value = TokenState.Failed(message(e))
                } finally {
                    trialToken = null
                }
            }
        }
    }

    fun clearTokenState() {
        _token.value = TokenState.Idle
    }

    /** Stops syncing: forgets the repository, the token and sync's records. Notes stay. */
    fun disconnect() {
        scope.launch(io) {
            mutex.withLock {
                clientJobs?.cancel()
                _client.value?.close()
                _client.value = null
                dropCandidate()
                SendEditsWorker.cancel(context)
                storageDir.deleteRecursively()
                tokens.clear()
                prefs.target = null
                _target.value = null
                _setup.value = SetupState.Idle
                _token.value = TokenState.Idle
                _deletion.value = null
                _conflictProblem.value = null
                _firstSync.value = false
                settled.clear()
            }
        }
    }

    // ---- While syncing ------------------------------------------------------------

    private fun newClient(target: SyncTarget) = SyncClient(
        storageDir = storageDir,
        vault = files.value,
        config = SyncConfig(owner = target.owner, repository = target.repository, branch = target.branch, deviceName = deviceName()),
        tokens = { trialToken ?: tokens.read() },
        engineScript = engine,
        log = { Log.d(Tag, it) },
    )

    private fun activate(client: SyncClient) {
        clientJobs?.cancel()
        _client.value = client
        clientJobs = scope.launch {
            // Sync's writes bypass the store: tell the index and open editors to look again.
            launch { client.vaultChanges.collect { store.notifyExternalChange() } }
            launch { client.status.collect { onStatus(client, it) } }
        }
        if (foreground) client.onForeground()
    }

    private suspend fun onStatus(client: SyncClient, status: SyncStatus) {
        Log.i(Tag, if (status is SyncStatus.Error) "status: Error(${status.error.kind}, ${status.error.detail})" else "status: $status")
        if (status is SyncStatus.Conflict) settle(client, status.conflicts)
        if (status is SyncStatus.Idle) {
            _deletion.value = null
            _conflictProblem.value = null
            _firstSync.value = false
        }
        val setup = _setup.value
        if (setup is SetupState.Downloading || setup is SetupState.Starting) {
            _setup.value = when (status) {
                is SyncStatus.Syncing -> SetupState.Downloading(status.done, status.total)
                is SyncStatus.Idle, is SyncStatus.Error, is SyncStatus.Offline -> SetupState.Done
                else -> setup
            }
        }
    }

    /**
     * The user's rule for conflicts: never block on a dialog. A note edited on both sides keeps
     * both versions inline ([BothVersions]); an edit beats a deletion; other files keep both copies.
     * Only a bulk deletion waits for a choice, and names differing in case wait for a rename.
     */
    private suspend fun settle(client: SyncClient, conflicts: List<SyncConflict>) {
        var deletion: DeletionDecision? = null
        var problem: String? = null
        for (conflict in conflicts) {
            if (conflict.id in settled) continue
            val resolution: Resolution? = when (conflict.kind) {
                "content", "add-add" -> {
                    val mine = conflict.local?.text
                    val theirs = conflict.remote?.text
                    when {
                        mine != null && theirs != null && "edit" in conflict.choices ->
                            Resolution.Edited(BothVersions.merge(conflict.base?.text, mine, theirs))
                        "both" in conflict.choices -> Resolution.Both
                        else -> null
                    }
                }
                "local-deleted-remote-edited" -> Resolution.Theirs
                "local-edited-remote-deleted" -> Resolution.Mine
                "bulk-deletion" -> {
                    deletion = deletion ?: DeletionDecision(conflict.id, conflict.direction, conflict.paths.size)
                    null
                }
                "collision" -> {
                    problem = problem ?: SyncCopy.collision(conflict.paths)
                    null
                }
                else -> null
            }
            if (resolution == null) {
                if (conflict.kind != "bulk-deletion" && conflict.kind != "collision") problem = problem ?: SyncCopy.needsChoice(conflict.path)
                continue
            }
            settled += conflict.id
            try {
                client.resolve(conflict.id, resolution)
            } catch (e: SyncError) {
                // Stale or refused: the next sync reports it again with a new id.
            }
        }
        _deletion.value = deletion
        _conflictProblem.value = problem
    }

    /** [keepThisPhone]: this phone's side of the deletion; otherwise GitHub's. */
    fun decideDeletion(keepThisPhone: Boolean) {
        val decision = _deletion.value ?: return
        val client = _client.value ?: return
        _deletion.value = null
        scope.launch {
            try {
                client.resolve(decision.conflictId, if (keepThisPhone) Resolution.Mine else Resolution.Theirs)
            } catch (e: SyncError) {
                // The next sync asks again.
            }
        }
    }

    /** True for images and other files sync leaves on GitHub. */
    fun isOnDemand(path: String): Boolean = _client.value?.isOnDemand(path) == true

    /** Downloads an on-demand file (cached). Throws [SyncError]. */
    suspend fun attachment(path: String): File {
        val client = _client.value ?: throw SyncError(SyncError.Kind.Other, "Sync isn't set up")
        return client.fetchAttachment(path)
    }

    @Volatile private var remoteListing: Pair<Long, List<String>>? = null

    /** Every path on GitHub, at most five minutes old. Throws [SyncError]. */
    suspend fun remotePaths(): List<String> {
        remoteListing?.let { (at, paths) -> if (System.currentTimeMillis() - at < 5 * 60_000) return paths }
        val client = _client.value ?: throw SyncError(SyncError.Kind.Other, "Sync isn't set up")
        return client.remotePaths().also { remoteListing = System.currentTimeMillis() to it }
    }

    private fun deviceName(): String =
        Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    companion object {
        private const val Tag = "NotesSync"

        fun message(error: SyncError): String = when (error.kind) {
            SyncError.Kind.Offline -> SyncCopy.Offline
            else -> error.message ?: SyncCopy.Stopped
        }
    }
}
