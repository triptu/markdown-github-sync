package io.github.triptu.notes.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.R
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

/** Horizontal padding of every page, from the mockup. */
val PagePadding = 20.dp

@Composable
fun PhIcon(@DrawableRes icon: Int, contentDescription: String?, size: Dp = 24.dp, tint: Color = NotesTheme.colors.ink2, modifier: Modifier = Modifier) {
    Icon(painterResource(icon), contentDescription, modifier.size(size), tint = tint)
}

/** A press background shaped like the row, reaching 12dp past the text column like the mockup. */
@Composable
fun Modifier.pressable(
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    shape: RoundedCornerShape = RoundedCornerShape(14.dp),
    bleed: Dp = 12.dp,
    label: String? = null,
    pressColor: Color = NotesTheme.colors.press,
    selected: Boolean = false,
): Modifier {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val haptics = LocalHapticFeedback.current
    return this
        .clip(shape)
        .background(if (pressed || selected) pressColor else Color.Transparent)
        .combinedClickable(
            interactionSource = interaction,
            indication = null,
            role = Role.Button,
            onClickLabel = label,
            onLongClick = onLongClick?.let { { haptics.performHapticFeedback(HapticFeedbackType.LongPress); it() } },
            onClick = onClick,
        )
        .padding(horizontal = bleed)
}

/** Small tappable labels naming the neighbouring pages ("‹ Vault", "Recents ›"), with [center] between them. */
@Composable
fun HintsRow(
    left: String?,
    right: String?,
    onLeft: () -> Unit,
    onRight: () -> Unit,
    modifier: Modifier = Modifier,
    center: @Composable () -> Unit = {},
) {
    Box(modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.Center) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = PagePadding - 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (left != null) Hint(left, R.drawable.ph_caret_left, iconFirst = true, onClick = onLeft) else Spacer(Modifier.width(1.dp))
            if (right != null) Hint(right, R.drawable.ph_caret_right, iconFirst = false, onClick = onRight)
        }
        center()
    }
}

/** The one solid button style: a full-width pill. [busy] keeps it in place but inert. */
@Composable
fun PillButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val colors = NotesTheme.colors
    val shape = RoundedCornerShape(24.dp)
    Box(
        modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(shape)
            .background(if (enabled) colors.solid else colors.sunk)
            .pressable({ if (enabled) onClick() }, shape = shape, bleed = 0.dp, label = text, pressColor = colors.ink2),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = NotesType.row.copy(fontWeight = FontWeight.Medium), color = if (enabled) colors.onSolid else colors.muted)
    }
}

/** A text-only button, for the second choice next to a [PillButton] or in a quiet line. */
@Composable
fun QuietButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = NotesTheme.colors.ink) {
    Box(
        modifier.height(44.dp).pressable(onClick, shape = RoundedCornerShape(12.dp), bleed = 10.dp, label = text),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = NotesType.rowMeta.copy(fontWeight = FontWeight.Medium), color = color)
    }
}

@Composable
private fun Hint(label: String, @DrawableRes icon: Int, iconFirst: Boolean, onClick: () -> Unit) {
    val muted = NotesTheme.colors.muted
    Row(
        Modifier.height(48.dp).pressable(onClick, bleed = 8.dp, shape = RoundedCornerShape(12.dp), label = label),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (iconFirst) PhIcon(icon, null, 15.dp, muted)
        Text(label, style = NotesType.hint, color = muted)
        if (!iconFirst) PhIcon(icon, null, 15.dp, muted)
    }
}

/** Which edge of a side page leads back to Home. */
enum class HomeSide { Start, End }

/**
 * The fixed top bar of a side page: its title, and a chevron toward Home on the side Home is on.
 * [actions] sit next to the chevron.
 */
@Composable
fun PageBar(title: String, homeSide: HomeSide, onHome: () -> Unit, actions: @Composable () -> Unit = {}) {
    val colors = NotesTheme.colors
    // 44dp targets around 22dp icons: start/end padding keeps the icons on the 20dp page margin.
    val edge = PagePadding - (BarTarget - BarIcon) / 2
    Row(
        Modifier.fillMaxWidth().height(48.dp).padding(start = if (homeSide == HomeSide.Start) edge else PagePadding, end = edge),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (homeSide == HomeSide.Start) IconButton48(R.drawable.ph_caret_left, "Back to Home", onHome, tint = colors.muted, size = BarTarget)
        Text(
            title, style = NotesType.barTitle, color = colors.ink, maxLines = 1,
            modifier = Modifier.weight(1f).padding(start = if (homeSide == HomeSide.Start) 4.dp else 0.dp),
        )
        actions()
        if (homeSide == HomeSide.End) IconButton48(R.drawable.ph_caret_right, "Back to Home", onHome, tint = colors.muted, size = BarTarget)
    }
}

/** Touch target and icon size for buttons in a [PageBar]. */
val BarTarget = 44.dp
val BarIcon = 22.dp

/** One list row: icon and name, optional second line and trailing icon. */
@Composable
fun ListRow(
    @DrawableRes icon: Int,
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    subtitle: String? = null,
    /** Text inside [subtitle] to emphasise, such as a search match. */
    highlight: String? = null,
    @DrawableRes trailing: Int? = null,
    trailingDescription: String? = null,
    height: Dp = 56.dp,
    textStyle: TextStyle = NotesType.row,
    iconTint: Color = NotesTheme.colors.ink2,
    gap: Dp = 16.dp,
    selected: Boolean = false,
) {
    val colors = NotesTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = height)
            .padding(horizontal = PagePadding - 12.dp)
            .pressable(onClick, onLongClick, selected = selected),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PhIcon(icon, null, 24.dp, iconTint)
        Spacer(Modifier.width(gap))
        Column(Modifier.weight(1f).padding(vertical = if (subtitle != null) 10.dp else 0.dp)) {
            Text(text, style = textStyle, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) {
                Text(emphasise(subtitle, highlight, colors.ink), style = NotesType.rowMeta, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
            }
        }
        if (trailing != null) {
            Box(Modifier.padding(start = 12.dp)) { PhIcon(trailing, trailingDescription, 18.dp, colors.muted) }
        }
    }
}

/** A small round icon button with a 48dp target. */
@Composable
fun IconButton48(
    @DrawableRes icon: Int,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = NotesTheme.colors.ink2,
    enabled: Boolean = true,
    size: Dp = 48.dp,
) {
    Box(
        modifier
            .size(size)
            .pressable(onClick = { if (enabled) onClick() }, shape = RoundedCornerShape(size / 2), bleed = 0.dp, label = description),
        contentAlignment = Alignment.Center,
    ) {
        PhIcon(icon, description, 22.dp, if (enabled) tint else tint.copy(alpha = 0.35f))
    }
}

private fun emphasise(text: String, part: String?, color: Color): AnnotatedString {
    val q = part?.trim().orEmpty()
    val at = if (q.isEmpty()) -1 else text.indexOf(q, ignoreCase = true)
    if (at < 0) return AnnotatedString(text)
    return buildAnnotatedString {
        append(text)
        addStyle(SpanStyle(color = color, fontWeight = FontWeight.Medium), at, at + q.length)
    }
}
