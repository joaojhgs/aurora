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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "AuroraAudioSpike"
private const val SAMPLE_RATE = 16_000
private const val CHANNEL_COUNT = 1
private const val QUEUE_CAPACITY_CHUNKS = 8
private const val MAX_CHUNK_SAMPLES = 4_096
private const val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_RECOGNITION
private const val CAPTURE_POLL_INTERVAL_MS = 250L
private const val CAPTURE_POLL_ATTEMPTS = 20

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

    fun resetStats() {
        val current = handle
        if (current != 0L) {
            nativeResetStats(current)
        }
    }

    fun shutdown() {
        val current = handle
        if (current != 0L) {
            nativeClose(current)
        }
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
    private external fun nativeResetStats(handle: Long)
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
    private val completed = CountDownLatch(1)
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
        recorder = try {
            AudioRecord.Builder()
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
        } catch (error: RuntimeException) {
            running.set(false)
            Log.w(TAG, "capture result ok=false reason=recorder-create")
            return false
        }

        worker.start()
        handler = Handler(worker.looper)
        handler?.post { readLoop(frameCapacity) }
        return true
    }

    private fun readLoop(frameCapacity: Int) {
        val currentRecorder = recorder ?: run {
            completed.countDown()
            return
        }
        val buffer = ShortArray(frameCapacity)
        var recordingStarted = false
        try {
            currentRecorder.startRecording()
            recordingStarted = true
            while (running.get()) {
                val read = try {
                    currentRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                } catch (error: RuntimeException) {
                    running.set(false)
                    AudioRecord.ERROR_INVALID_OPERATION
                }
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
        } catch (error: RuntimeException) {
            running.set(false)
        } finally {
            if (recordingStarted) {
                try {
                    currentRecorder.stop()
                } catch (error: RuntimeException) {
                    // Stop can throw if Android already tore the recorder down.
                }
            }
            completed.countDown()
        }
    }

    override fun close() {
        running.set(false)
        bridge.shutdown()
        try {
            recorder?.stop()
        } catch (error: RuntimeException) {
            // This is only to unblock a pending read; the read loop owns final stop.
        }
        val completedBeforeFree = try {
            !worker.isAlive || completed.await(2, TimeUnit.SECONDS)
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        handler?.removeCallbacksAndMessages(null)
        if (completedBeforeFree) {
            bridge.close()
        } else {
            Log.w(TAG, "capture close incomplete; native state retained")
        }
        try {
            recorder?.release()
        } catch (error: RuntimeException) {
            // Release failure is non-recoverable in this bounded spike.
        }
        recorder = null
        worker.quitSafely()
        try {
            worker.join(1_000)
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}

class MainActivity : Activity() {
    private var capture: AndroidAudioCapture? = null
    private var bridge: NativeAudioBridge? = null
    private lateinit var mainHandler: Handler

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mainHandler = Handler(mainLooper)
        val nativeBridge = NativeAudioBridge()
        bridge = nativeBridge
        runSyntheticSmoke(nativeBridge)
        nativeBridge.resetStats()
        val captureBaseline = nativeBridge.stats()

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            val manager = getSystemService(AudioManager::class.java)
            val candidate = AndroidAudioCapture(manager, nativeBridge)
            if (candidate.start()) {
                capture = candidate
                pollCaptureResult(nativeBridge, captureBaseline, CAPTURE_POLL_ATTEMPTS)
            } else {
                Log.i(TAG, "capture result ok=false reason=start")
                candidate.close()
            }
        } else {
            Log.i(TAG, "capture result ok=false reason=permission")
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

    private fun pollCaptureResult(
        nativeBridge: NativeAudioBridge,
        baseline: AudioStats,
        attemptsRemaining: Int,
    ) {
        val stats = nativeBridge.stats()
        val acceptedDelta = stats.acceptedChunks - baseline.acceptedChunks
        val sampleDelta = stats.acceptedSamples - baseline.acceptedSamples
        if (acceptedDelta > 0 && sampleDelta > 0) {
            Log.i(
                TAG,
                "capture result ok=true acceptedDelta=$acceptedDelta samplesDelta=$sampleDelta dropped=${stats.droppedChunks}",
            )
            capture?.close()
            capture = null
            return
        }
        if (attemptsRemaining <= 0) {
            Log.i(
                TAG,
                "capture result ok=false acceptedDelta=$acceptedDelta samplesDelta=$sampleDelta dropped=${stats.droppedChunks}",
            )
            capture?.close()
            capture = null
            return
        }
        mainHandler.postDelayed(
            { pollCaptureResult(nativeBridge, baseline, attemptsRemaining - 1) },
            CAPTURE_POLL_INTERVAL_MS,
        )
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        val activeCapture = capture
        activeCapture?.close()
        capture = null
        if (activeCapture == null) {
            bridge?.close()
        }
        bridge = null
        super.onDestroy()
    }
}
