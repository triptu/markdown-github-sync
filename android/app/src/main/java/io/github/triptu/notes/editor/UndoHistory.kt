package io.github.triptu.notes.editor

import androidx.compose.ui.text.input.TextFieldValue

/**
 * Undo for the editor. Typing within [MergeWindowMs] of the last edit merges into one step
 * (up to [MaxStepMs] long), so undo removes a burst of typing rather than one letter.
 */
class UndoHistory(private val now: () -> Long = System::currentTimeMillis) {
    private val steps = ArrayDeque<TextFieldValue>()
    private var lastRecordAt = 0L
    private var stepStartedAt = 0L

    val canUndo: Boolean get() = steps.isNotEmpty()

    /** Call before replacing [previous] with new text. [force] starts a new step (toolbar actions, taps). */
    fun record(previous: TextFieldValue, force: Boolean = false) {
        val t = now()
        if (force || steps.isEmpty() || t - lastRecordAt > MergeWindowMs || t - stepStartedAt > MaxStepMs) {
            steps.addLast(previous)
            stepStartedAt = t
            if (steps.size > MaxSteps) steps.removeFirst()
        }
        lastRecordAt = t
    }

    fun undo(): TextFieldValue? {
        lastRecordAt = 0L
        return steps.removeLastOrNull()
    }

    private companion object {
        const val MergeWindowMs = 1_000L
        const val MaxStepMs = 4_000L
        const val MaxSteps = 200
    }
}
