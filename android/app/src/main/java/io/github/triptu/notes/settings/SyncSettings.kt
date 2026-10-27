package io.github.triptu.notes.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.triptu.notes.R
import io.github.triptu.notes.sync.SyncError
import io.github.triptu.notes.sync.SyncStatus
import io.github.triptu.notes.syncing.GitHubSync
import io.github.triptu.notes.syncing.SetupState
import io.github.triptu.notes.syncing.SyncCopy
import io.github.triptu.notes.syncing.SyncTarget
import io.github.triptu.notes.syncing.TokenState
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.PillButton
import io.github.triptu.notes.ui.QuietButton
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

/** The GitHub section of Settings: the setup form, or the connected repository and its token. */
@Composable
internal fun SyncSection(sync: GitHubSync, focusToken: Boolean) {
    val colors = NotesTheme.colors
    val target by sync.target.collectAsStateWithLifecycle()
    Section(SyncCopy.Section)
    val connected = target
    if (connected == null) {
        Hint(SyncCopy.Intro)
        SetupForm(sync)
        return
    }
    val status by sync.status.collectAsStateWithLifecycle()
    val tokenState by sync.tokenState.collectAsStateWithLifecycle()
    Text(SyncCopy.connected(connected), style = NotesType.row, color = colors.ink)
    Text("Branch ${connected.branch} · ${statusLine(status)}", style = NotesType.rowMeta, color = colors.muted, modifier = Modifier.padding(top = 2.dp))

    val accessProblem = (status as? SyncStatus.Error)?.error?.takeIf { it.kind == SyncError.Kind.Access }?.message
    if (accessProblem != null) {
        Text(accessProblem, style = NotesType.rowMeta, color = colors.ink, modifier = Modifier.padding(top = 14.dp))
    }
    var token by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(focusToken) { if (focusToken) focus.requestFocus() }
    LaunchedEffect(tokenState) { if (tokenState == TokenState.Saved) token = "" }
    Spacer(Modifier.height(6.dp))
    Field(SyncCopy.Token, token, placeholder = SyncCopy.TokenSaved, secret = true, focus = focus) {
        token = it
        sync.clearTokenState()
    }
    CreateTokenLink(connected.owner)
    when (val t = tokenState) {
        is TokenState.Failed -> Text(t.message, style = NotesType.rowMeta, color = colors.ink, modifier = Modifier.padding(bottom = 8.dp))
        TokenState.Saved -> Text(SyncCopy.TokenUpdated, style = NotesType.rowMeta, color = colors.muted, modifier = Modifier.padding(bottom = 8.dp))
        else -> Unit
    }
    if (token.isNotBlank()) {
        val checking = tokenState == TokenState.Checking
        PillButton(if (checking) SyncCopy.Checking else SyncCopy.SaveToken, { sync.saveToken(token) }, enabled = !checking, modifier = Modifier.padding(top = 4.dp))
    }

    var confirm by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(top = 12.dp).heightIn(min = 56.dp).pressable({ confirm = true }, bleed = 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(SyncCopy.StopSyncing, style = NotesType.row, color = colors.ink)
            Text(SyncCopy.StopSyncingHint, style = NotesType.rowMeta, color = colors.muted)
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            containerColor = colors.raised,
            title = { Text(SyncCopy.StopSyncingConfirm, style = NotesType.barTitle, color = colors.ink) },
            text = { Text(SyncCopy.StopSyncingBody, style = NotesType.row, color = colors.ink2) },
            confirmButton = { TextButton({ confirm = false; sync.disconnect() }) { Text(SyncCopy.Stop, color = colors.ink) } },
            dismissButton = { TextButton({ confirm = false }) { Text(SyncCopy.Cancel, color = colors.ink2) } },
        )
    }
}

private fun statusLine(status: SyncStatus): String = when (status) {
    is SyncStatus.Idle -> SyncCopy.lastSynced(status.lastSyncedAt, System.currentTimeMillis())
    is SyncStatus.Offline -> "Offline · " + SyncCopy.lastSynced(status.lastSyncedAt, System.currentTimeMillis()).replaceFirstChar { it.lowercase() }
    is SyncStatus.Syncing, is SyncStatus.Conflict -> "Syncing…"
    is SyncStatus.Error -> SyncCopy.NotSyncing
    SyncStatus.NotSetUp -> "Getting ready…"
}

/** Repository, branch and token, then a preview or the first download. */
@Composable
internal fun SetupForm(sync: GitHubSync) {
    val colors = NotesTheme.colors
    val setup by sync.setup.collectAsStateWithLifecycle()
    var repository by rememberSaveable { mutableStateOf("") }
    var branch by rememberSaveable { mutableStateOf("main") }
    var token by rememberSaveable { mutableStateOf("") }
    when (val s = setup) {
        is SetupState.Review -> {
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (line in s.lines) Text(line, style = NotesType.row, color = colors.ink)
            }
            Spacer(Modifier.height(20.dp))
            PillButton(SyncCopy.StartSyncing, sync::startSyncing)
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { QuietButton(SyncCopy.Cancel, sync::cancelSetup, color = colors.ink2) }
        }
        SetupState.Starting, is SetupState.Downloading -> {
            val downloading = s as? SetupState.Downloading
            Text(
                if (downloading == null) SyncCopy.Starting else SyncCopy.downloading(downloading.done, downloading.total),
                style = NotesType.row, color = colors.ink, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp),
            )
            val fraction = downloading?.let { d -> if (d.done != null && d.total != null && d.total > 0) d.done.toFloat() / d.total else null }
            if (fraction != null) {
                LinearProgressIndicator(progress = { fraction }, color = colors.ink, trackColor = colors.sunk, strokeCap = StrokeCap.Round, gapSize = 0.dp, drawStopIndicator = {}, modifier = Modifier.fillMaxWidth())
            } else {
                LinearProgressIndicator(color = colors.ink, trackColor = colors.sunk, strokeCap = StrokeCap.Round, gapSize = 0.dp, modifier = Modifier.fillMaxWidth())
            }
        }
        else -> {
            Field(SyncCopy.Repository, repository, placeholder = SyncCopy.RepositoryPlaceholder) { repository = it }
            Field(SyncCopy.Branch, branch) { branch = it }
            Field(SyncCopy.Token, token, placeholder = SyncCopy.TokenPlaceholder, secret = true) { token = it }
            CreateTokenLink(SyncTarget.parseRepository(repository)?.first ?: repository.substringBefore('/').trim().takeIf { '/' in repository })
            Hint(SyncCopy.TokenHint)
            Spacer(Modifier.height(14.dp))
            val checking = s == SetupState.Checking
            PillButton(if (checking) SyncCopy.Checking else SyncCopy.Connect, { sync.connect(repository, branch, token) }, enabled = !checking)
            if (s is SetupState.Failed) Text(s.message, style = NotesType.rowMeta, color = colors.ink, modifier = Modifier.padding(top = 12.dp))
        }
    }
}

/** Opens GitHub's fine-grained token form, prefilled with the permissions sync needs. */
@Composable
private fun CreateTokenLink(owner: String?) {
    val colors = NotesTheme.colors
    val uri = LocalUriHandler.current
    Row(
        Modifier.heightIn(min = 40.dp).pressable({ uri.openUri(SyncCopy.tokenCreationUrl(owner).toString()) }, bleed = 0.dp, shape = RoundedCornerShape(10.dp), label = SyncCopy.CreateToken),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(SyncCopy.CreateToken, style = NotesType.rowMeta, color = colors.ink)
        PhIcon(R.drawable.ph_arrow_square_out, null, 16.dp, colors.ink2)
    }
}

/** First run: connect to GitHub now, or later from Settings. */
@Composable
fun SetupScreen(sync: GitHubSync, onDone: () -> Unit) {
    val colors = NotesTheme.colors
    val setup by sync.setup.collectAsStateWithLifecycle()
    LaunchedEffect(setup) { if (setup == SetupState.Done) onDone() }
    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
    ) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = PagePadding)) {
            Spacer(Modifier.height(40.dp))
            Text(SyncCopy.SetupTitle, style = NotesType.title, color = colors.ink, modifier = Modifier.padding(bottom = 8.dp))
            Hint(SyncCopy.Intro)
            Spacer(Modifier.height(8.dp))
            SetupForm(sync)
            Spacer(Modifier.height(24.dp))
        }
        val busy = setup == SetupState.Starting || setup is SetupState.Downloading
        Box(Modifier.fillMaxWidth().padding(bottom = 8.dp), contentAlignment = Alignment.Center) {
            QuietButton(if (busy) SyncCopy.Continue else SyncCopy.NotNow, onDone, color = colors.ink2)
        }
    }
}
