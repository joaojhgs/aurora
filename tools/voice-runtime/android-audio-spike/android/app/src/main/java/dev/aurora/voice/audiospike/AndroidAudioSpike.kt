package dev.aurora.voice.audiospike

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "AuroraAudioSpike"
private const val SAMPLE_RATE = 16_000
private const val CHANNEL_COUNT = 1
private const val QUEUE_CAPACITY_CHUNKS = 8
private const val MAX_CHUNK_SAMPLES = 4_096
private const val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_RECOGNITION

data class AudioStats(
    val acceptedChunks: Long,
    val acceptedSamples: Long,
    val droppedChunks: Long,
    val discontinuities: Long,
    val queuedChunks: Long,
    val closed: Boolean,
)

class NativeAudioBridge : AutoCloseable {
    private var handle: Long = nativeCreate(QUEUE_CAPACITY_CHUNKS, MAX_CHUNK_SAMPLES)

    fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        if (current == 0L) return 2
        require(sampleCount in 1..samples.size) { "invalid sample count" }
        return nativePushPcm(current, samples, sampleCount, sequence)
    }

    fun drainOne(): Int {
        val current = handle
        if (current == 0L) return 0
        return nativeDrainOne(current)
    }

    fun stats(): AudioStats {
        val current = handle
        if (current == 0L) {
            return AudioStats(0, 0, 0, 0, 0, true)
        }
        val raw = nativeStats(current)
        return AudioStats(
            acceptedChunks = raw[0],
            acceptedSamples = raw[1],
            droppedChunks = raw[2],
            discontinuities = raw[3],
            queuedChunks = raw[4],
            closed = raw[5] != 0L,
        )
    }

    override fun close() {
        val current = handle
        if (current != 0L) {
            nativeClose(current)
            nativeFree(current)
            handle = 0L
        }
    }

    private external fun nativeCreate(capacityChunks: Int, maxChunkSamples: Int): Long
    private external fun nativePushPcm(
        handle: Long,
        samples: ShortArray,
        sampleCount: Int,
        sequence: Long,
    ): Int
    private external fun nativeDrainOne(handle: Long): Int
    private external fun nativeStats(handle: Long): LongArray
    private external fun nativeClose(handle: Long)
    private external fun nativeFree(handle: Long)

    companion object {
        init {
            System.loadLibrary("aurora_android_audio_jni")
        }
    }
}

class AndroidAudioCapture(
    private val audioManager: AudioManager,
    private val bridge: NativeAudioBridge,
    private val sampleRate: Int = SAMPLE_RATE,
) : AutoCloseable {
    private val running = AtomicBoolean(false)
    private val worker = HandlerThread("aurora-audio-capture")
    private var handler: Handler? = null
    private var recorder: AudioRecord? = null
    private var sequence = 0L

    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return true

        audioManager.mode = AudioManager.MODE_NORMAL
        val minBufferSize = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBufferSize <= 0) {
            running.set(false)
            return false
        }

        val frameCapacity = minOf(MAX_CHUNK_SAMPLES, maxOf(minBufferSize / 2, sampleRate / 10))
        val byteCapacity = maxOf(minBufferSize, frameCapacity * 2)
        recorder = AudioRecord.Builder()
            .setAudioSource(AUDIO_SOURCE)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(byteCapacity)
            .build()

        worker.start()
        handler = Handler(worker.looper)
        handler?.post { readLoop(frameCapacity) }
        return true
    }

    private fun readLoop(frameCapacity: Int) {
        val currentRecorder = recorder ?: return
        val buffer = ShortArray(frameCapacity)
        currentRecorder.startRecording()
        while (running.get()) {
            val read = currentRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
            if (read > 0) {
                val chunk = buffer.copyOf(read)
                val result = bridge.pushPcm(chunk, read, sequence++)
                if (result == 1) {
                    bridge.drainOne()
                } else if (result == 2) {
                    running.set(false)
                }
            } else if (read == AudioRecord.ERROR_INVALID_OPERATION) {
                running.set(false)
            }
        }
        currentRecorder.stop()
    }

    override fun close() {
        running.set(false)
        handler?.removeCallbacksAndMessages(null)
        recorder?.release()
        recorder = null
        bridge.close()
        worker.quitSafely()
    }
}

class MainActivity : Activity() {
    private var capture: AndroidAudioCapture? = null
    private var bridge: NativeAudioBridge? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val nativeBridge = NativeAudioBridge()
        bridge = nativeBridge
        runSyntheticSmoke(nativeBridge)

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            val manager = getSystemService(AudioManager::class.java)
            capture = AndroidAudioCapture(manager, nativeBridge)
            capture?.start()
        }
    }

    private fun runSyntheticSmoke(nativeBridge: NativeAudioBridge) {
        val chunk = ShortArray(160) { index -> (index % 31).toShort() }
        val first = nativeBridge.pushPcm(chunk, chunk.size, 0)
        val second = nativeBridge.pushPcm(chunk, chunk.size, 1)
        val stats = nativeBridge.stats()
        val ok = first == 0 && second == 0 && stats.acceptedChunks >= 2
        Log.i(
            TAG,
            "synthetic result ok=$ok accepted=${stats.acceptedChunks} dropped=${stats.droppedChunks} queued=${stats.queuedChunks}",
        )
    }

    override fun onDestroy() {
        capture?.close()
        capture = null
        bridge?.close()
        bridge = null
        super.onDestroy()
    }
}
