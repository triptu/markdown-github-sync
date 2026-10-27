package io.github.triptu.notes.editor

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.ParagraphStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import io.github.triptu.notes.ui.theme.NotesColors

/**
 * Styles markdown in place, like Obsidian's live preview. Markup is hidden (drawn tiny and
 * transparent) except where the cursor is, so the text and its offsets never change.
 * Hidden task markers keep their width: the editor draws a checkbox over them.
 */
class LivePreview(
    private val parsed: ParsedMarkdown,
    private val selection: TextRange,
    private val colors: NotesColors,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        // Replacements keep the length, so offsets map one to one.
        val chars = raw.toCharArray()
        val b = AnnotatedString.Builder()
        val spans = ArrayList<Triple<SpanStyle, Int, Int>>()
        val paragraphs = ArrayList<Triple<ParagraphStyle, Int, Int>>()
        fun span(style: SpanStyle, start: Int, end: Int) {
            if (start < end) spans += Triple(style, start, end.coerceAtMost(raw.length))
        }
        fun hide(start: Int, end: Int) = span(Hidden, start, end)

        parsed.frontmatter?.let { span(SpanStyle(color = colors.muted, fontSize = 14.sp), it.start, it.end) }

        for (h in parsed.headings) {
            span(SpanStyle(fontSize = HeadingSizes[h.level - 1], fontWeight = FontWeight.SemiBold), h.lineStart, h.lineEnd)
            paragraphs += Triple(ParagraphStyle(lineHeight = HeadingLineHeights[h.level - 1]), h.lineStart, h.lineEnd)
            if (!touches(h.lineStart, h.lineEnd)) hide(h.lineStart, h.markerEnd)
            else span(SpanStyle(color = colors.muted), h.lineStart, h.markerEnd)
        }
        for (t in parsed.tasks) {
            if (touches(t.markerStart, t.markerEnd - 1)) {
                span(SpanStyle(color = colors.muted), t.markerStart, t.markerEnd)
            } else {
                span(SpanStyle(color = Color.Transparent), t.markerStart, t.markerEnd)
            }
            if (t.checked) span(SpanStyle(color = colors.muted, textDecoration = TextDecoration.LineThrough), t.markerEnd, t.lineEnd)
        }
        for (bullet in parsed.bullets) {
            if (!touches(bullet.index, bullet.index + 1)) chars[bullet.index] = '•'
            span(SpanStyle(color = colors.muted), bullet.index, bullet.index + 1)
        }
        for (q in parsed.quotes) span(SpanStyle(color = colors.ink2, fontStyle = FontStyle.Italic), q.start, q.end)
        for (i in parsed.inline) {
            val style = when (i.kind) {
                InlineKind.Bold -> SpanStyle(fontWeight = FontWeight.SemiBold)
                InlineKind.Italic -> SpanStyle(fontStyle = FontStyle.Italic)
                InlineKind.BoldItalic -> SpanStyle(fontWeight = FontWeight.SemiBold, fontStyle = FontStyle.Italic)
                InlineKind.Code -> SpanStyle(background = colors.raised)
            }
            span(style, i.start, i.end)
            if (touches(i.start, i.end)) {
                span(SpanStyle(color = colors.muted), i.start, i.start + i.marker)
                span(SpanStyle(color = colors.muted), i.end - i.marker, i.end)
            } else if (i.kind != InlineKind.Code) {
                hide(i.start, i.start + i.marker)
                hide(i.end - i.marker, i.end)
            }
        }
        for (l in parsed.links) {
            span(SpanStyle(textDecoration = TextDecoration.Underline), l.labelStart, l.labelEnd)
            if (touches(l.start, l.end)) {
                span(SpanStyle(color = colors.muted), l.start, l.labelStart)
                span(SpanStyle(color = colors.muted), l.labelEnd, l.end)
            } else {
                hide(l.start, l.labelStart)
                hide(l.labelEnd, l.end)
            }
        }

        b.append(String(chars))
        paragraphs.forEach { (style, s, e) -> b.addStyle(style, s, e) }
        spans.forEach { (style, s, e) -> b.addStyle(style, s, e) }
        return TransformedText(b.toAnnotatedString(), OffsetMapping.Identity)
    }

    /** True if the cursor or selection touches [start]..[end], edges included. */
    private fun touches(start: Int, end: Int): Boolean = selection.min <= end && selection.max >= start

    override fun equals(other: Any?): Boolean =
        other is LivePreview && other.parsed == parsed && other.selection == selection && other.colors == colors

    override fun hashCode(): Int = 31 * (31 * parsed.hashCode() + selection.hashCode()) + colors.hashCode()

    companion object {
        private val Hidden = SpanStyle(color = Color.Transparent, fontSize = 1.sp, letterSpacing = 0.sp)
        private val HeadingSizes = listOf(24.sp, 21.sp, 19.sp, 17.sp, 17.sp, 17.sp)
        private val HeadingLineHeights = listOf(34.sp, 30.sp, 28.sp, 26.sp, 26.sp, 26.sp)
    }
}
