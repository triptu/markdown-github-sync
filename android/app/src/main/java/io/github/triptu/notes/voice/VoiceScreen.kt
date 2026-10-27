package io.github.triptu.notes.voice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import io.github.triptu.notes.R
import io.github.triptu.notes.ui.IconButton48
import io.github.triptu.notes.ui.PagePadding
import io.github.triptu.notes.ui.PhIcon
import io.github.triptu.notes.ui.QuietButton
import io.github.triptu.notes.ui.pressable
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

/** The full-screen speaking view: the words as they come, a waveform, and Pause, Save and Type. */
@Composable
fun VoiceScreen(session: VoiceSession, onClose: () -> Unit, onSave: () -> Unit, onType: () -> Unit) {
    val colors = NotesTheme.colors
    val context = LocalContext.current
    val state = session.state
    val listening = state == VoiceState.Listening

    var asks by remember { mutableIntStateOf(0) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        session.permission(granted)
        // Asked twice and refused: Android won't show the question again, so open the app's settings.
        if (!granted && asks > 1) {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
        }
    }
    LaunchedEffect(session) {
        if (session.state is VoiceState.NeedsPermission) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                session.permission(true)
            } else {
                asks++
                ask.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    // Long rambles shouldn't be cut off by the screen going dark.
    val view = LocalView.current
    DisposableEffect(listening) {
        view.keepScreenOn = listening
        onDispose { view.keepScreenOn = false }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = PagePadding - 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton48(R.drawable.ph_x, VoiceCopy.Close, onClose)
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                if (state !is VoiceState.NeedsPermission) Clock(session.elapsedMs, listening)
            }
            Spacer(Modifier.size(48.dp))
        }

        val scroll = rememberScrollState()
        LaunchedEffect(session.committed, session.pending) { scroll.animateScrollTo(scroll.maxValue) }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(horizontal = PagePadding)) {
            Spacer(Modifier.height(18.dp))
            when {
                state is VoiceState.NeedsPermission -> {
                    Text(VoiceCopy.MicReason, style = NotesType.row, color = colors.ink2)
                    if (state.denied) {
                        Box(Modifier.padding(top = 4.dp)) {
                            QuietButton(VoiceCopy.AllowMic, { asks++; ask.launch(Manifest.permission.RECORD_AUDIO) })
                        }
                    }
                }
                session.committed.isEmpty() && session.pending.isEmpty() ->
                    Text(if (listening) VoiceCopy.StartTalking else VoiceCopy.Paused, style = NotesType.spoken, color = colors.muted)
                else -> Text(
                    buildAnnotatedString {
                        append(session.committed)
                        append(session.separator)
                        withStyle(SpanStyle(color = colors.muted)) { append(session.pending) }
                    },
                    style = NotesType.spoken,
                    color = colors.ink,
                )
            }
            val problem = (state as? VoiceState.Paused)?.problem
            if (problem != null) {
                Text(VoiceCopy.problem(problem), style = NotesType.rowMeta, color = colors.muted, modifier = Modifier.padding(top = 16.dp))
            }
            Spacer(Modifier.height(24.dp))
        }

        Waveform(session.levels, active = listening, modifier = Modifier.fillMaxWidth().height(40.dp))
        Spacer(Modifier.height(28.dp))
        Row(
            Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                if (listening) {
                    SideButton(R.drawable.ph_pause, VoiceCopy.Pause, session::pause)
                } else {
                    SideButton(R.drawable.ph_microphone, VoiceCopy.Resume, { if (state is VoiceState.NeedsPermission) { asks++; ask.launch(Manifest.permission.RECORD_AUDIO) } else session.resume() })
                }
            }
            SaveButton(onSave)
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                SideButton(R.drawable.ph_keyboard, VoiceCopy.Type, onType)
            }
        }
    }
}

/** A red dot and the time listened. The dot goes grey while paused. */
@Composable
private fun Clock(elapsedMs: Long, listening: Boolean) {
    val colors = NotesTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (listening) colors.rec else colors.muted))
        Text(VoiceCopy.clock(elapsedMs), style = NotesType.path, color = colors.muted)
    }
}

/** Bars from the microphone's level, newest on the right. Flat while paused. */
@Composable
private fun Waveform(levels: List<Float>, active: Boolean, modifier: Modifier = Modifier) {
    val color = if (active) NotesTheme.colors.ink2 else NotesTheme.colors.muted
    Canvas(modifier) {
        val bar = 3.dp.toPx()
        val gap = 3.dp.toPx()
        val count = levels.size
        val total = count * bar + (count - 1) * gap
        var x = (size.width - total) / 2
        val min = 5.dp.toPx()
        for (level in levels) {
            val h = if (active) min + (size.height - min) * level else min
            drawRoundRect(color, Offset(x, (size.height - h) / 2), Size(bar, h), CornerRadius(bar))
            x += bar + gap
        }
    }
}

@Composable
private fun SideButton(@DrawableRes icon: Int, label: String, onClick: () -> Unit) {
    val colors = NotesTheme.colors
    Column(
        Modifier.widthIn(min = 72.dp).height(64.dp).pressable(onClick, shape = RoundedCornerShape(16.dp), bleed = 0.dp, label = label),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { PhIcon(icon, null, 24.dp, colors.ink2) }
        Spacer(Modifier.height(2.dp))
        Text(label, style = NotesType.hint.copy(fontSize = 12.5.sp), color = colors.muted)
    }
}

@Composable
private fun SaveButton(onSave: () -> Unit) {
    val colors = NotesTheme.colors
    Column(
        Modifier.width(96.dp).pressable(onSave, shape = RoundedCornerShape(20.dp), bleed = 0.dp, label = VoiceCopy.Save),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(72.dp).clip(CircleShape).background(colors.solid), contentAlignment = Alignment.Center) {
            PhIcon(R.drawable.ph_check, null, 30.dp, colors.onSolid)
        }
        Spacer(Modifier.height(6.dp))
        Text(VoiceCopy.Save, style = NotesType.hint.copy(fontSize = 13.sp, fontWeight = FontWeight.Medium), color = colors.ink)
    }
}
