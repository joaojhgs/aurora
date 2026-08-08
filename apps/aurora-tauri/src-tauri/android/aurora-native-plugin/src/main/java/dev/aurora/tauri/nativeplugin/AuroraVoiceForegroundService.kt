package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import java.util.concurrent.atomic.AtomicBoolean

private const val AURORA_VOICE_CHANNEL_ID = "aurora_voice_capture"
private const val AURORA_VOICE_NOTIFICATION_ID = 4203
private const val SAMPLE_RATE_HZ = 16_000
private const val CHANNEL_COUNT = 1
private const val QUEUE_CAPACITY_CHUNKS = 8
private const val MAX_CHUNK_SAMPLES = 4_096
private const val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_RECOGNITION

data class AuroraVoiceCaptureSnapshot(
    val captureActive: Boolean,
    val sampleRateHz: Int,
    val acceptedChunks: Long,
    val acceptedSamples: Long,
    val droppedChunks: Long,
    val discontinuities: Long,
    val queuedChunks: Long,
    val errorCode: String?,
)

/** JNI handle for the bounded Rust-owned PCM ingress queue. */
private class AuroraNativeAudioBridge : AutoCloseable {
    private var handle: Long = nativeCreate(QUEUE_CAPACITY_CHUNKS, MAX_CHUNK_SAMPLES)

    fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        if (current == 0L || sampleCount !in 1..samples.size) return -1
        return nativePushPcm(current, samples, sampleCount, sequence)
    }

    fun drainOne(): Int {
        val current = handle
        return if (current == 0L) 0 else nativeDrainOne(current)
    }

    fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    fun stats(): LongArray {
        val current = handle
        return if (current == 0L) LongArray(6) { 0 } else nativeStats(current)
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
    private external fun nativePushPcm(handle: Long, samples: ShortArray, sampleCount: Int, sequence: Long): Int
    private external fun nativeDrainOne(handle: Long): Int
    private external fun nativeDrainPcm(handle: Long): ShortArray
    private external fun nativeStats(handle: Long): LongArray
    private external fun nativeClose(handle: Long)
    private external fun nativeFree(handle: Long)

    companion object {
        init {
            System.loadLibrary("aurora_tauri_lib")
        }
    }
}

/** JNI handle for the bounded Rust-native TTS playback queue. */
private class AuroraNativeAudioOutputBridge : AutoCloseable {
    private var handle: Long = nativeCreate(16)

    fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    override fun close() {
        val current = handle
        if (current != 0L) {
            nativeClose(current)
            nativeFree(current)
            handle = 0L
        }
    }

    private external fun nativeCreate(capacityChunks: Int): Long
    private external fun nativeDrainPcm(handle: Long): ShortArray
    private external fun nativeClose(handle: Long)
    private external fun nativeFree(handle: Long)

    companion object {
        init {
            System.loadLibrary("aurora_tauri_lib")
        }
    }
}

private class AuroraAudioCapture(
    private val bridge: AuroraNativeAudioBridge,
    private val onSnapshot: (AuroraVoiceCaptureSnapshot) -> Unit,
) : AutoCloseable {
    private val running = AtomicBoolean(false)
    private val worker = HandlerThread("aurora-audio-capture")
    private var handler: Handler? = null
    private var recorder: AudioRecord? = null
    private var sequence = 0L
    private var errorCode: String? = null

    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return true
        val minimumBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimumBuffer <= 0) {
            fail("audio_record_buffer_unavailable")
            return false
        }
        return try {
            val frameCapacity = minOf(MAX_CHUNK_SAMPLES, maxOf(minimumBuffer / 2, SAMPLE_RATE_HZ / 10))
            val byteCapacity = maxOf(minimumBuffer, frameCapacity * 2)
            recorder = AudioRecord.Builder()
                .setAudioSource(AUDIO_SOURCE)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE_HZ)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(byteCapacity)
                .build()
            worker.start()
            handler = Handler(worker.looper)
            handler?.post { readLoop(frameCapacity) }
            true
        } catch (_: RuntimeException) {
            fail("audio_record_initialization_failed")
            false
        }
    }

    private fun readLoop(frameCapacity: Int) {
        val currentRecorder = recorder ?: run {
            fail("audio_record_missing")
            return
        }
        val buffer = ShortArray(frameCapacity)
        try {
            currentRecorder.startRecording()
            publishSnapshot()
            while (running.get()) {
                val read = currentRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                when {
                    read > 0 -> {
                        val result = bridge.pushPcm(buffer, read, sequence++)
                        if (result == 1) bridge.drainOne()
                        if (result == 2) {
                            fail("audio_queue_closed")
                            break
                        }
                        publishSnapshot()
                    }
                    read == AudioRecord.ERROR_INVALID_OPERATION -> {
                        fail("audio_record_invalid_operation")
                        break
                    }
                    read == AudioRecord.ERROR_BAD_VALUE -> {
                        fail("audio_record_bad_value")
                        break
                    }
                }
            }
        } catch (_: RuntimeException) {
            fail("audio_record_read_failed")
        } finally {
            runCatching { currentRecorder.stop() }
            publishSnapshot()
        }
    }

    private fun fail(code: String) {
        errorCode = code
        running.set(false)
        publishSnapshot()
    }

    private fun publishSnapshot() {
        val stats = bridge.stats()
        onSnapshot(
            AuroraVoiceCaptureSnapshot(
                captureActive = running.get() && errorCode == null,
                sampleRateHz = SAMPLE_RATE_HZ,
                acceptedChunks = stats.getOrElse(0) { 0 },
                acceptedSamples = stats.getOrElse(1) { 0 },
                droppedChunks = stats.getOrElse(2) { 0 },
                discontinuities = stats.getOrElse(3) { 0 },
                queuedChunks = stats.getOrElse(4) { 0 },
                errorCode = errorCode,
            ),
        )
    }

    override fun close() {
        running.set(false)
        handler?.removeCallbacksAndMessages(null)
        runCatching { recorder?.stop() }
        worker.quitSafely()
        if (worker.state != Thread.State.NEW) {
            runCatching { worker.join() }
        }
        recorder?.release()
        recorder = null
        bridge.close()
        publishSnapshot()
    }
}

class AuroraVoiceForegroundService : Service() {
    private var capture: AuroraAudioCapture? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                captureError = when (change) {
                    AudioManager.AUDIOFOCUS_LOSS -> "audio_focus_lost"
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "audio_focus_interrupted"
                    else -> "audio_focus_ducked"
                }
                capture?.close()
                capture = null
                captureSnapshot = emptySnapshot(captureError)
                updateNotification(captureSnapshot)
                if (change == AudioManager.AUDIOFOCUS_LOSS) stopSelf()
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                // A foreground session never restarts the microphone implicitly
                // after a call/media interruption; the user must tap Start again.
                captureError = "audio_focus_released_restart_required"
                captureSnapshot = emptySnapshot(captureError)
                updateNotification(captureSnapshot)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        running = true
        audioManager = getSystemService(AudioManager::class.java)
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        startForeground(AURORA_VOICE_NOTIFICATION_ID, foregroundNotification("Starting microphone…"))
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            captureError = "microphone_permission_missing"
            stopSelf()
            return START_NOT_STICKY
        }
        if (!requestAudioFocus()) {
            captureError = "audio_focus_unavailable"
            stopSelf()
            return START_NOT_STICKY
        }
        if (capture == null) {
            captureError = null
            capture = AuroraAudioCapture(AuroraNativeAudioBridge()) { snapshot ->
                captureSnapshot = snapshot
                updateNotification(snapshot)
            }
            if (capture?.start() != true) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        capture?.close()
        capture = null
        abandonAudioFocus()
        audioFocusRequest = null
        audioManager = null
        running = false
        captureSnapshot = emptySnapshot(captureError)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= TRIM_MEMORY_COMPLETE) {
            captureError = "service_memory_pressure"
            stopSelf()
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // An explicitly started foreground session is allowed to outlive the
        // launcher task. Process death and platform memory policy still stop it.
        super.onTaskRemoved(rootIntent)
    }

    private fun requestAudioFocus(): Boolean {
        val manager = audioManager ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(audioFocusListener)
                .build()
            audioFocusRequest = request
            return manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        @Suppress("DEPRECATION")
        return manager.requestAudioFocus(
            audioFocusListener,
            AudioManager.STREAM_VOICE_CALL,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
        ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonAudioFocus() {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { manager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(audioFocusListener)
        }
    }

    private fun updateNotification(snapshot: AuroraVoiceCaptureSnapshot) {
        if (!running) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(AURORA_VOICE_NOTIFICATION_ID, foregroundNotification(
            if (snapshot.captureActive) "Microphone is active. Tap Stop to end." else "Voice controls are unavailable.",
        ))
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            AURORA_VOICE_CHANNEL_ID,
            "Aurora voice capture",
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = "Shows when Aurora is using the microphone in the foreground."
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun foregroundNotification(text: String): Notification {
        val stopIntent = Intent(this, AuroraVoiceForegroundService::class.java).apply { action = ACTION_STOP }
        val stopPendingIntent = PendingIntent.getService(
            this,
            4204,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, AURORA_VOICE_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Aurora voice controls")
            .setContentText(text)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stopPendingIntent).build())
            .build()
    }

    companion object {
        const val ACTION_STOP = "dev.aurora.tauri.nativeplugin.action.STOP_VOICE_CAPTURE"

        @Volatile
        var running: Boolean = false
            private set

        @Volatile
        var captureError: String? = null
            private set

        @Volatile
        var captureSnapshot: AuroraVoiceCaptureSnapshot = emptySnapshot(null)
            private set

        fun emptySnapshot(errorCode: String?) = AuroraVoiceCaptureSnapshot(
            captureActive = false,
            sampleRateHz = SAMPLE_RATE_HZ,
            acceptedChunks = 0,
            acceptedSamples = 0,
            droppedChunks = 0,
            discontinuities = 0,
            queuedChunks = 0,
            errorCode = errorCode,
        )
    }
}
