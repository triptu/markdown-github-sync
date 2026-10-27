package io.github.triptu.notes.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Owns the microphone while the speaking view listens. Audio goes three ways: to the recognizer
 * through a pipe (so recognizer restarts never miss audio: chunks wait in memory until the next
 * pipe opens), to an optional WAV file for the cloud refine, and to a level for the waveform.
 */
class MicCapture(
    private val wav: File?,
    /** Debug builds only: 16 kHz mono 16-bit PCM played in real time instead of the mic, for testing. */
    private val testPcm: File? = null,
    private val onLevel: (Float) -> Unit,
) {
    private var record: AudioRecord? = null
    private var reader: Thread? = null
    private var writer: Thread? = null
    private val chunks = LinkedBlockingDeque<ByteArray>()
    @Volatile private var sink: OutputStream? = null
    @Volatile private var running = false
    private var file: RandomAccessFile? = null
    private var pcmBytes = 0L
    private val fileLock = Any()

    /** Starts the mic. Returns false if it can't be opened (in use, or no permission). */
    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(): Boolean {
        if (running) return true
        if (testPcm != null) return startTestSource(testPcm)
        val minBuffer = AudioRecord.getMinBufferSize(SampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuffer, ChunkBytes * 8))
        } catch (e: Exception) {
            return false
        }
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            return false
        }
        try {
            r.startRecording()
        } catch (e: Exception) {
            r.release()
            return false
        }
        openWav()
        record = r
        running = true
        reader = Thread({ readLoop { buffer -> r.read(buffer, 0, buffer.size) } }, "mic-read").apply { start() }
        if (writer == null) writer = Thread(::writeLoop, "mic-pipe").apply { isDaemon = true; start() }
        return true
    }

    private var testOffset = 0L

    /** Reads [pcm] at real-time pace, then silence, as if someone spoke it into the mic. */
    private fun startTestSource(pcm: File): Boolean {
        openWav()
        running = true
        val input = java.io.RandomAccessFile(pcm, "r").apply { seek(testOffset) }
        reader = Thread({
            var next = android.os.SystemClock.elapsedRealtime()
            readLoop { buffer ->
                next += 20
                val wait = next - android.os.SystemClock.elapsedRealtime()
                if (wait > 0) Thread.sleep(wait)
                val n = input.read(buffer)
                if (n > 0) {
                    testOffset += n
                    n
                } else {
                    buffer.fill(0)
                    buffer.size
                }
            }
            input.close()
        }, "mic-test").apply { start() }
        if (writer == null) writer = Thread(::writeLoop, "mic-pipe").apply { isDaemon = true; start() }
        return true
    }

    private fun openWav() {
        if (wav == null || file != null) return
        wav.parentFile?.mkdirs()
        synchronized(fileLock) {
            file = RandomAccessFile(wav, "rw").apply {
                setLength(0)
                write(ByteArray(WavHeaderBytes))
            }
            pcmBytes = 0
        }
    }

    /** Stops the mic. Audio already captured still reaches the open pipe, which then closes. */
    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        reader?.join(500)
        reader = null
        record?.let {
            try { it.stop() } catch (_: Exception) {}
            it.release()
        }
        record = null
        writeWavHeader()
        // A second of silence after the last words: the recognizer only settles words once it
        // hears a pause, and drops what it hasn't settled when the pipe closes.
        repeat(TrailingSilenceChunks) { chunks.addLast(ByteArray(ChunkBytes)) }
        // Let queued audio drain into the pipe, then close it so the recognizer finishes.
        val deadline = System.currentTimeMillis() + 3_000
        while (chunks.isNotEmpty() && sink != null && System.currentTimeMillis() < deadline) Thread.sleep(10)
        chunks.clear()
        closePipe()
    }

    /** A new pipe for the next recognizer session. Audio held since the last one flows into it first. */
    fun openPipe(): ParcelFileDescriptor {
        val (read, write) = ParcelFileDescriptor.createPipe()
        closePipe()
        sink = ParcelFileDescriptor.AutoCloseOutputStream(write)
        return read
    }

    fun closePipe() {
        val s = sink
        sink = null
        try { s?.close() } catch (_: IOException) {}
    }

    /** Finishes the WAV file and stops everything. */
    @Synchronized
    fun release(): File? {
        stop()
        writer?.interrupt()
        writer = null
        synchronized(fileLock) {
            try { file?.close() } catch (_: IOException) {}
            file = null
        }
        return wav?.takeIf { pcmBytes > 0 && it.isFile }
    }

    private fun readLoop(read: (ByteArray) -> Int) {
        val buffer = ByteArray(ChunkBytes)
        while (running) {
            val n = read(buffer)
            if (n <= 0) {
                if (n < 0) Thread.sleep(10)
                continue
            }
            val chunk = buffer.copyOf(n)
            chunks.addLast(chunk)
            while (chunks.size > MaxHeldChunks) chunks.pollFirst()
            synchronized(fileLock) {
                file?.let {
                    it.write(chunk)
                    pcmBytes += n
                }
            }
            onLevel(level(chunk, n))
        }
    }

    private fun writeLoop() {
        while (!Thread.currentThread().isInterrupted) {
            val chunk = try {
                chunks.pollFirst(100, TimeUnit.MILLISECONDS) ?: continue
            } catch (e: InterruptedException) {
                return
            }
            var sent = false
            while (!sent && !Thread.currentThread().isInterrupted) {
                val s = sink
                if (s == null) {
                    // Between recognizer sessions: hold the audio for the next pipe.
                    chunks.addFirst(chunk)
                    try { Thread.sleep(15) } catch (e: InterruptedException) { return }
                    break
                }
                try {
                    s.write(chunk)
                    sent = true
                } catch (e: IOException) {
                    if (sink === s) sink = null
                }
            }
        }
    }

    private fun writeWavHeader(): Unit = synchronized(fileLock) {
        val f = file ?: return
        val dataBytes = pcmBytes
        val header = java.nio.ByteBuffer.allocate(WavHeaderBytes).order(java.nio.ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt((36 + dataBytes).toInt()); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1)
            putInt(SampleRate); putInt(SampleRate * 2); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(dataBytes.toInt())
        }.array()
        val at = f.filePointer
        f.seek(0)
        f.write(header)
        f.seek(at)
    }

    /** 0..1 from the chunk's loudness: about -50 dB is silence, -10 dB is loud speech. */
    private fun level(chunk: ByteArray, n: Int): Float {
        var sum = 0.0
        var i = 0
        while (i + 1 < n) {
            val sample = (chunk[i].toInt() and 0xFF) or (chunk[i + 1].toInt() shl 8)
            sum += sample.toDouble() * sample
            i += 2
        }
        val rms = sqrt(sum / maxOf(1, n / 2))
        val db = 20 * log10(maxOf(rms, 1.0) / 32768.0)
        return ((db + 50) / 40).toFloat().coerceIn(0f, 1f)
    }

    companion object {
        const val SampleRate = 16_000
        /** 20 ms of 16-bit mono audio. */
        private const val ChunkBytes = SampleRate / 50 * 2
        /** Up to 30 s of audio waits for a pipe. */
        private const val MaxHeldChunks = 1_500
        private const val WavHeaderBytes = 44
        private const val TrailingSilenceChunks = 50
    }
}
