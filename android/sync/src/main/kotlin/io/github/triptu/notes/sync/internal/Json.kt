package io.github.triptu.notes.sync.internal

/**
 * Minimal JSON for the engine boundary: objects become `Map<String, Any?>`,
 * arrays `List<Any?>`, numbers `Double`. android.jar's org.json is not
 * available in local JVM tests, and this keeps the module dependency-free.
 */
internal object Json {
    fun parse(text: String): Any? = Parser(text).run {
        val value = value()
        skip()
        require(at == text.length) { "Trailing JSON content" }
        value
    }

    fun write(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> quote(out, value)
            is Boolean -> out.append(value)
            is Int, is Long -> out.append(value.toString())
            is Number -> {
                val d = value.toDouble()
                require(d.isFinite()) { "Non-finite number" }
                if (d == Math.rint(d) && kotlin.math.abs(d) < 1e15) out.append(d.toLong()) else out.append(d)
            }
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (!first) out.append(',')
                    first = false
                    quote(out, key as String)
                    out.append(':')
                    write(out, item)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (item in value) {
                    if (!first) out.append(',')
                    first = false
                    write(out, item)
                }
                out.append(']')
            }
            else -> error("Unsupported JSON value: ${value::class}")
        }
    }

    fun quote(text: String): String = StringBuilder().also { quote(it, text) }.toString()

    private fun quote(out: StringBuilder, text: String) {
        out.append('"')
        for (c in text) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                // Escaped so the text is also a valid JavaScript string literal.
                ' ', ' ' -> out.append("\\u").append(String.format("%04x", c.code))
                else -> if (c < ' ') out.append("\\u").append(String.format("%04x", c.code)) else out.append(c)
            }
        }
        out.append('"')
    }

    private class Parser(val text: String) {
        var at = 0

        fun skip() {
            while (at < text.length && text[at].isWhitespace()) at++
        }

        fun value(): Any? {
            skip()
            require(at < text.length) { "Unexpected end of JSON" }
            return when (val c = text[at]) {
                '{' -> obj()
                '[' -> array()
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) number() else error("Unexpected JSON character '$c'")
            }
        }

        fun literal(word: String, value: Any?): Any? {
            require(text.startsWith(word, at)) { "Invalid JSON literal" }
            at += word.length
            return value
        }

        fun number(): Double {
            val start = at
            while (at < text.length && (text[at].isDigit() || text[at] in "+-.eE")) at++
            return text.substring(start, at).toDouble()
        }

        fun string(): String {
            at++
            val out = StringBuilder()
            while (true) {
                require(at < text.length) { "Unterminated JSON string" }
                val c = text[at++]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        when (val e = text[at++]) {
                            '"', '\\', '/' -> out.append(e)
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000c')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                out.append(text.substring(at, at + 4).toInt(16).toChar())
                                at += 4
                            }
                            else -> error("Invalid JSON escape")
                        }
                    }
                    else -> out.append(c)
                }
            }
        }

        fun obj(): Map<String, Any?> {
            at++
            val out = LinkedHashMap<String, Any?>()
            skip()
            if (text[at] == '}') { at++; return out }
            while (true) {
                skip()
                val key = string()
                skip()
                require(text[at++] == ':') { "Expected ':' in JSON" }
                out[key] = value()
                skip()
                when (text[at++]) {
                    ',' -> continue
                    '}' -> return out
                    else -> error("Expected ',' or '}' in JSON")
                }
            }
        }

        fun array(): List<Any?> {
            at++
            val out = ArrayList<Any?>()
            skip()
            if (text[at] == ']') { at++; return out }
            while (true) {
                out.add(value())
                skip()
                when (text[at++]) {
                    ',' -> continue
                    ']' -> return out
                    else -> error("Expected ',' or ']' in JSON")
                }
            }
        }
    }
}

@Suppress("UNCHECKED_CAST")
internal fun Any?.obj(): Map<String, Any?> = this as Map<String, Any?>

@Suppress("UNCHECKED_CAST")
internal fun Any?.list(): List<Any?> = this as List<Any?>

internal fun Map<String, Any?>.str(key: String): String? = this[key] as String?
