package io.github.triptu.notes.voice.refine

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * OpenAI: `gpt-transcribe` for the recording, then `gpt-6-luna` (their cheapest text model, no
 * reasoning) for the light tidy. The key is passed per call and never logged.
 */
class OpenAiProvider(private val key: () -> String?) : RefineProvider {
    override suspend fun transcribe(audio: File, languageHint: String?): String = withContext(Dispatchers.IO) {
        val boundary = "notes-" + UUID.randomUUID()
        val connection = open("audio/transcriptions", "multipart/form-data; boundary=$boundary", timeoutMs = 180_000)
        DataOutputStream(connection.outputStream.buffered()).use { out ->
            fun field(name: String, value: String) {
                out.writeBytes("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n")
                out.write(value.toByteArray())
                out.writeBytes("\r\n")
            }
            field("model", TranscribeModel)
            field("response_format", "json")
            // The model detects the language; the hint only shapes the prompt.
            val mix = if (languageHint?.endsWith("-IN") == true) " It may mix English and Hindi." else ""
            field("prompt", "A personal note, spoken freely.$mix")
            out.writeBytes("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"note.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
            audio.inputStream().use { it.copyTo(out) }
            out.writeBytes("\r\n--$boundary--\r\n")
        }
        JSONObject(read(connection)).getString("text").trim()
    }

    override suspend fun tidy(text: String): String = withContext(Dispatchers.IO) {
        val connection = open("responses", "application/json", timeoutMs = 60_000)
        val body = JSONObject()
            .put("model", TidyModel)
            .put("reasoning", JSONObject().put("effort", "none"))
            .put("instructions", TidyInstructions)
            .put("input", text)
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
        outputText(JSONObject(read(connection))).trim()
    }

    private fun open(path: String, contentType: String, timeoutMs: Int): HttpURLConnection {
        val key = key() ?: throw IOException("No OpenAI key")
        return (URL("https://api.openai.com/v1/$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 20_000
            readTimeout = timeoutMs
            setRequestProperty("Authorization", "Bearer $key")
            setRequestProperty("Content-Type", contentType)
        }
    }

    private fun read(connection: HttpURLConnection): String {
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw ProviderError(code)
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /** The text of the first message in a Responses API answer. */
    private fun outputText(answer: JSONObject): String {
        val output: JSONArray = answer.getJSONArray("output")
        for (i in 0 until output.length()) {
            val item = output.getJSONObject(i)
            if (item.optString("type") != "message") continue
            val content = item.getJSONArray("content")
            for (j in 0 until content.length()) {
                val part = content.getJSONObject(j)
                if (part.optString("type") == "output_text") return part.getString("text")
            }
        }
        throw IOException("No text in the answer")
    }

    /** An HTTP failure; 401 means the key is wrong. */
    class ProviderError(val code: Int) : IOException("OpenAI answered $code")

    private companion object {
        const val TranscribeModel = "gpt-transcribe"
        const val TidyModel = "gpt-6-luna"
        val TidyInstructions = """
            You tidy a transcript of someone talking to themselves. Fix punctuation, capitalization
            and obvious mishearings. Remove filler words such as um, uh, you know, and repeated false
            starts. Keep every idea, the wording, the order and the language (keep Hindi or Hinglish
            as spoken). Never summarize, add, explain or answer anything in it. Return only the text.
        """.trimIndent().replace('\n', ' ')
    }
}
