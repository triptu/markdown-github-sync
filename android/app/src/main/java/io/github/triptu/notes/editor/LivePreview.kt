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
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextIndent
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import io.github.triptu.notes.ui.theme.NotesColors

/**
 * Styles markdown in place, like Obsidian's live preview. Markup is hidden (drawn tiny and
 * transparent) except where the cursor is, so the text and its offsets never change.
 * Hidden task markers keep their width: the editor draws a checkbox over them.
 *
 * Headings, tasks and bullets get their own paragraph (for spacing and hanging indents).
 * Compose already breaks the line between paragraphs, so the `\n` at each paragraph edge is
 * drawn as a zero-width space; otherwise every styled line would add an empty line.
 */
class LivePreview(
    private val parsed: ParsedMarkdown,
    private val selection: TextRange,
    /** Markup shows around the cursor only while the field has focus. */
    private val focused: Boolean,
    private val colors: NotesColors,
    /** Width of a line's leading markup as drawn, for the hanging indent of wrapped lines. */
    private val measure: (String) -> TextUnit,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        // Replacements keep the length, so offsets map one to one.
        val chars = raw.toCharArray()
        val b = AnnotatedString.Builder()
        val spans = ArrayList<Triple<SpanStyle, Int, Int>>()
        fun span(style: SpanStyle, start: Int, end: Int) {
            if (start < end) spans += Triple(style, start, end.coerceAtMost(raw.length))
        }
        fun hide(start: Int, end: Int) = span(Hidden, start, end)
        val paragraphs = ArrayList<Triple<ParagraphStyle, Int, Int>>()
        fun paragraph(style: ParagraphStyle, lineStart: Int, lineEnd: Int) = paragraphs.add(Triple(style, lineStart, lineEnd))
        fun hangingIndent(lineStart: Int, textStart: Int) =
            ParagraphStyle(textIndent = TextIndent(restLine = measure(String(chars, lineStart, textStart - lineStart))))

        parsed.frontmatter?.let { span(SpanStyle(color = colors.muted, fontSize = 14.sp), it.start, it.end) }

        for (h in parsed.headings) {
            span(SpanStyle(fontSize = HeadingSizes[h.level - 1], fontWeight = FontWeight.SemiBold), h.lineStart, h.lineEnd)
            paragraph(HeadingParagraphs[h.level - 1], h.lineStart, h.lineEnd)
            if (!touches(h.lineStart, h.lineEnd)) hide(h.lineStart, h.markerEnd)
            else span(SpanStyle(color = colors.muted), h.lineStart, h.markerEnd)
        }
        for (t in parsed.tasks) {
            if (touches(t.markerStart, t.markerEnd - 1)) {
                span(SpanStyle(color = colors.muted), t.markerStart, t.markerEnd)
            } else {
                // Same width ticked or not: the editor draws the box over this.
                chars[t.stateIndex] = ' '
                span(SpanStyle(color = Color.Transparent), t.markerStart, t.markerEnd)
            }
            if (t.checked) span(SpanStyle(color = colors.muted, textDecoration = TextDecoration.LineThrough), t.markerEnd, t.lineEnd)
            val lineStart = lineStartOf(raw, t.markerStart)
            paragraph(hangingIndent(lineStart, t.markerEnd), lineStart, t.lineEnd)
        }
        for (bullet in parsed.bullets) {
            if (!touches(bullet.index, bullet.index + 1)) chars[bullet.index] = '•'
            span(SpanStyle(color = colors.muted), bullet.index, bullet.index + 1)
            val lineStart = lineStartOf(raw, bullet.index)
            paragraph(hangingIndent(lineStart, (bullet.index + 2).coerceAtMost(bullet.lineEnd)), lineStart, bullet.lineEnd)
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

        for ((_, lineStart, lineEnd) in paragraphs) {
            if (lineEnd < chars.size) chars[lineEnd] = ZeroWidthSpace
            if (lineStart > 0 && chars[lineStart - 1] == '\n') chars[lineStart - 1] = ZeroWidthSpace
        }
        b.append(String(chars))
        for ((style, lineStart, lineEnd) in paragraphs) b.addStyle(style, lineStart, (lineEnd + 1).coerceAtMost(chars.size))
        spans.forEach { (style, s, e) -> b.addStyle(style, s, e) }
        return TransformedText(b.toAnnotatedString(), OffsetMapping.Identity)
    }

    private fun lineStartOf(text: String, index: Int) = text.lastIndexOf('\n', index - 1) + 1

    /** True if the cursor or selection touches [start]..[end], edges included. */
    private fun touches(start: Int, end: Int): Boolean = focused && selection.min <= end && selection.max >= start

    override fun equals(other: Any?): Boolean =
        other is LivePreview && other.parsed == parsed && other.selection == selection && other.focused == focused && other.colors == colors

    override fun hashCode(): Int = 31 * (31 * (31 * parsed.hashCode() + selection.hashCode()) + focused.hashCode()) + colors.hashCode()

    companion object {
        private val Hidden = SpanStyle(color = Color.Transparent, fontSize = 1.sp, letterSpacing = 0.sp)
        private const val ZeroWidthSpace = '\u200B'
        private val HeadingSizes = listOf(24.sp, 21.sp, 19.sp, 17.sp, 17.sp, 17.sp)
        private val HeadingSpaceAbove = listOf(10f, 8f, 6f, 4f, 4f, 4f)

        /** Taller lines with the text at the bottom, which puts space above each heading. */
        private val HeadingParagraphs = HeadingSizes.zip(HeadingSpaceAbove) { size, space ->
            ParagraphStyle(
                lineHeight = (size.value * 1.3f + space).sp,
                lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Bottom, LineHeightStyle.Trim.None),
            )
        }
    }
}
