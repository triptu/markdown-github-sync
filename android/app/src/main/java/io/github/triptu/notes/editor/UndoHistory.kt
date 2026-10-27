package io.github.triptu.notes.editor

import androidx.compose.ui.text.input.TextFieldValue

/**
 * Undo and redo for the editor. Typing within [MergeWindowMs] of the last edit merges into one step
 * (up to [MaxStepMs] long), so undo removes a burst of typing rather than one letter.
 */
class UndoHistory(private val now: () -> Long = System::currentTimeMillis) {
    private val steps = ArrayDeque<TextFieldValue>()
    private val redoSteps = ArrayDeque<TextFieldValue>()
    private var lastRecordAt = 0L
    private var stepStartedAt = 0L

    val canUndo: Boolean get() = steps.isNotEmpty()
    val canRedo: Boolean get() = redoSteps.isNotEmpty()

    /** Call before replacing [previous] with new text. [force] starts a new step (taps, completions). */
    fun record(previous: TextFieldValue, force: Boolean = false) {
        val t = now()
        if (force || steps.isEmpty() || t - lastRecordAt > MergeWindowMs || t - stepStartedAt > MaxStepMs) {
            steps.addLast(previous)
            stepStartedAt = t
            if (steps.size > MaxSteps) steps.removeFirst()
        }
        lastRecordAt = t
        redoSteps.clear()
    }

    fun clear() {
        steps.clear()
        redoSteps.clear()
        lastRecordAt = 0L
    }

    /** Returns the text before the last step, remembering [current] for redo. */
    fun undo(current: TextFieldValue): TextFieldValue? {
        val previous = steps.removeLastOrNull() ?: return null
        redoSteps.addLast(current)
        lastRecordAt = 0L
        return previous
    }

    fun redo(current: TextFieldValue): TextFieldValue? {
        val next = redoSteps.removeLastOrNull() ?: return null
        steps.addLast(current)
        lastRecordAt = 0L
        return next
    }

    private companion object {
        const val MergeWindowMs = 1_000L
        const val MaxStepMs = 4_000L
        const val MaxSteps = 200
    }
}
