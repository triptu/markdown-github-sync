package io.github.triptu.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import io.github.triptu.notes.ui.theme.NotesTheme
import io.github.triptu.notes.ui.theme.NotesType

/** Asks for a name (new folder, renaming a note). The field is focused with the text selected. */
@Composable
fun NameDialog(title: String, initial: String, confirm: String, onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    val colors = NotesTheme.colors
    var value by remember { mutableStateOf(TextFieldValue(initial, TextRange(0, initial.length))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val done = { if (value.text.isNotBlank()) onConfirm(value.text.trim()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.bg,
        title = { Text(title, style = NotesType.row.copy(fontWeight = FontWeight.SemiBold), color = colors.ink) },
        text = {
            BasicTextField(
                value = value,
                onValueChange = { value = it.copy(text = it.text.replace("\n", "")) },
                singleLine = true,
                textStyle = NotesType.field.copy(color = colors.ink),
                cursorBrush = SolidColor(colors.ink),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { done() }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focus)
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.raised)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            )
        },
        confirmButton = { TextButton(onClick = done, enabled = value.text.isNotBlank()) { Text(confirm, color = colors.ink) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = colors.ink2) } },
    )
}
