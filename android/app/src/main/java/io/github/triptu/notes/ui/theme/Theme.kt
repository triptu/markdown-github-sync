package io.github.triptu.notes.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.github.triptu.notes.R

@Immutable
data class NotesColors(
    val bg: Color,
    val raised: Color,
    val sunk: Color,
    val line: Color,
    val ink: Color,
    val ink2: Color,
    val muted: Color,
    val press: Color,
    val solid: Color,
    val onSolid: Color,
    /** The recording dot. */
    val rec: Color,
)

val LightColors = NotesColors(
    bg = Color(0xFFFAFAFA), raised = Color(0xFFF0F0F0), sunk = Color(0xFFE6E6E6), line = Color(0xFFE8E8E8),
    ink = Color(0xFF1A1A1A), ink2 = Color(0xFF555555), muted = Color(0xFF6E6E6E), press = Color(0xFFEBEBEB),
    solid = Color(0xFF1A1A1A), onSolid = Color(0xFFFAFAFA), rec = Color(0xFFC93C32),
)

val DarkColors = NotesColors(
    bg = Color(0xFF171717), raised = Color(0xFF232323), sunk = Color(0xFF2B2B2B), line = Color(0xFF262626),
    ink = Color(0xFFEDEDED), ink2 = Color(0xFFB4B4B4), muted = Color(0xFF8F8F8F), press = Color(0xFF262626),
    solid = Color(0xFFEDEDED), onSolid = Color(0xFF171717), rec = Color(0xFFE5584D),
)

val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_italic, FontWeight.Normal, FontStyle.Italic),
    Font(R.font.inter_semibold_italic, FontWeight.SemiBold, FontStyle.Italic),
)

/** Type sizes from the approved mockup. */
object NotesType {
    val hint = TextStyle(fontFamily = Inter, fontSize = 14.sp)
    val pin = TextStyle(fontFamily = Inter, fontSize = 18.sp, fontWeight = FontWeight.Medium)
    val pinCompact = TextStyle(fontFamily = Inter, fontSize = 17.sp, fontWeight = FontWeight.Medium)
    val row = TextStyle(fontFamily = Inter, fontSize = 16.sp)
    val rowMeta = TextStyle(fontFamily = Inter, fontSize = 14.sp)
    val barTitle = TextStyle(fontFamily = Inter, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
    val title = TextStyle(fontFamily = Inter, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em)
    val field = TextStyle(fontFamily = Inter, fontSize = 16.sp)
    val day = TextStyle(fontFamily = Inter, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    val entryHead = TextStyle(fontFamily = Inter, fontSize = 13.5.sp)
    val entryBody = TextStyle(fontFamily = Inter, fontSize = 15.5.sp, lineHeight = 1.5.em)
    val path = TextStyle(fontFamily = Inter, fontSize = 14.sp)
    val noteTitle = TextStyle(fontFamily = Inter, fontSize = 26.sp, lineHeight = 1.2.em, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em)
    /** No line-height trimming: each heading, task and bullet is its own paragraph and must keep full lines. */
    val noteBody = TextStyle(
        fontFamily = Inter, fontSize = 17.sp, lineHeight = 26.sp,
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Proportional, LineHeightStyle.Trim.None),
    )
    /** Words in the speaking view. */
    val spoken = TextStyle(fontFamily = Inter, fontSize = 22.sp, lineHeight = 1.45.em)
    val section = TextStyle(fontFamily = Inter, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
}

val LocalNotesColors = staticCompositionLocalOf { LightColors }

object NotesTheme {
    val colors: NotesColors
        @Composable get() = LocalNotesColors.current
}

@Composable
fun NotesTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) DarkColors else LightColors
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = colors.ink, onPrimary = colors.bg, background = colors.bg, onBackground = colors.ink,
        surface = colors.bg, onSurface = colors.ink, surfaceContainer = colors.raised, onSurfaceVariant = colors.ink2,
        outline = colors.muted, surfaceContainerLow = colors.raised, surfaceContainerHigh = colors.raised,
    )
    val selection = TextSelectionColors(handleColor = colors.ink, backgroundColor = colors.ink.copy(alpha = 0.18f))
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(LocalNotesColors provides colors, LocalTextSelectionColors provides selection, content = content)
    }
}
