package io.github.triptu.notes.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.ui.theme.NotesColors
import io.github.triptu.notes.ui.theme.NotesTheme

/** Size of a task checkbox, from the mockup. */
val TaskBoxSize = 18.dp

/** Draws the mockup's checkbox: a muted outline, or a filled box with a tick. */
fun DrawScope.drawTaskBox(topLeft: Offset, checked: Boolean, colors: NotesColors) {
    val side = TaskBoxSize.toPx()
    val radius = CornerRadius(5.dp.toPx())
    if (checked) {
        drawRoundRect(colors.ink2, topLeft, Size(side, side), radius)
        val tick = Path().apply {
            moveTo(topLeft.x + side * 0.27f, topLeft.y + side * 0.52f)
            lineTo(topLeft.x + side * 0.44f, topLeft.y + side * 0.69f)
            lineTo(topLeft.x + side * 0.74f, topLeft.y + side * 0.34f)
        }
        drawPath(tick, colors.bg, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    } else {
        val stroke = 1.6.dp.toPx()
        drawRoundRect(
            colors.muted, Offset(topLeft.x + stroke / 2, topLeft.y + stroke / 2), Size(side - stroke, side - stroke),
            CornerRadius(radius.x - stroke / 2), style = Stroke(stroke),
        )
    }
}

@Composable
fun TaskBox(checked: Boolean, modifier: Modifier = Modifier) {
    val colors = NotesTheme.colors
    Canvas(modifier.size(TaskBoxSize)) { drawTaskBox(Offset.Zero, checked, colors) }
}
