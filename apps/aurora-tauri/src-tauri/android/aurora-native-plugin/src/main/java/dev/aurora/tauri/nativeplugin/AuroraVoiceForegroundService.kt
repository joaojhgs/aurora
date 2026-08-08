package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val AURORA_VOICE_CHANNEL_ID = "aurora_voice_capture"
private const val AURORA_VOICE_NOTIFICATION_ID = 4203
private const val SAMPLE_RATE_HZ = 16_000
private const val CHANNEL_COUNT = 1
private const val QUEUE_CAPACITY_CHUNKS = 8
private const val MAX_CHUNK_SAMPLES = 4_096
private const val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_RECOGNITION
private const val VOICE_SECURE_STORAGE_PREFS = "aurora_secure_storage"
private const val VOICE_SECURE_STORAGE_KEY_ALIAS = "aurora_secure_storage_v1"
private const val VOICE_SECURE_STORAGE_KEYSTORE = "AndroidKeyStore"
private const val VOICE_SECURE_STORAGE_TRANSFORMATION = "AES/GCM/NoPadding"
private const val VOICE_SECURE_STORAGE_TAG_BITS = 128
private const val VOICE_GATEWAY_KEY = "aurora.voice.gateway"
private const val VOICE_BEARER_KEY = "aurora.voice.bearer"
private const val VOICE_REMOTE_AUDIO_CONSENT_KEY = "aurora.voice.remote_audio_consent"

data class AuroraVoiceNativeConfig(
    val gateway: String,
    val bearer: String,
    val remoteAudioConsent: Boolean,
)

object AuroraVoiceNativeConfigStore {
    fun load(context: Context): AuroraVoiceNativeConfig? {
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        val gateway = prefs.getString(VOICE_GATEWAY_KEY, null)?.let(::decrypt) ?: return null
        val bearer = prefs.getString(VOICE_BEARER_KEY, null)?.let(::decrypt).orEmpty()
        if (gateway.isBlank()) return null
        val uri = runCatching { android.net.Uri.parse(gateway) }.getOrNull() ?: return null
        val loopback = uri.host == "127.0.0.1" || uri.host == "localhost" || uri.host == "::1"
        if (uri.scheme != "https" && !(uri.scheme == "http" && loopback)) return null
        val remoteAudioConsent = prefs.getString(VOICE_REMOTE_AUDIO_CONSENT_KEY, null)
            ?.let { decrypt(it) }
            ?.toBooleanStrictOrNull()
            ?: false
        return AuroraVoiceNativeConfig(gateway, bearer, remoteAudioConsent)
    }

    fun setRemoteAudioConsent(context: Context, granted: Boolean) {
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(VOICE_REMOTE_AUDIO_CONSENT_KEY, encrypt(granted.toString()))
            .apply()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(VOICE_SECURE_STORAGE_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secureStorageKey())
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return JSONObject()
            .put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .toString()
    }

    private fun decrypt(encoded: String): String? = runCatching {
        val payload = JSONObject(encoded)
        val iv = Base64.decode(payload.getString("iv"), Base64.NO_WRAP)
        val ciphertext = Base64.decode(payload.getString("ciphertext"), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(VOICE_SECURE_STORAGE_TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            secureStorageKey(),
            GCMParameterSpec(VOICE_SECURE_STORAGE_TAG_BITS, iv),
        )
        String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }.getOrNull()

    private fun secureStorageKey(): SecretKey {
        val keyStore = KeyStore.getInstance(VOICE_SECURE_STORAGE_KEYSTORE).apply { load(null) }
        (keyStore.getKey(VOICE_SECURE_STORAGE_KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val keyGenerator = javax.crypto.KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, VOICE_SECURE_STORAGE_KEYSTORE)
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                VOICE_SECURE_STORAGE_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return keyGenerator.generateKey()
    }
}

private interface AuroraPcmIngressBridge : AutoCloseable {
    fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int
    fun drainOne(): Int
    fun stats(): LongArray
}

private interface AuroraPcmOutputBridge : AutoCloseable {
    fun drainPcm(): ShortArray
    fun acknowledgeDrained()
}

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
private class AuroraNativeAudioBridge : AuroraPcmIngressBridge {
    private var handle: Long = nativeCreate(QUEUE_CAPACITY_CHUNKS, MAX_CHUNK_SAMPLES)

    override fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        if (current == 0L || sampleCount !in 1..samples.size) return -1
        return nativePushPcm(current, samples, sampleCount, sequence)
    }

    override fun drainOne(): Int {
        val current = handle
        return if (current == 0L) 0 else nativeDrainOne(current)
    }

    fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    override fun stats(): LongArray {
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
private class AuroraNativeAudioOutputBridge : AuroraPcmOutputBridge {
    private var handle: Long = nativeCreate(16)

    override fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    override fun acknowledgeDrained() {
        val current = handle
        if (current != 0L) nativeAcknowledgeDrained(current)
    }

    fun queuedChunks(): Long {
        val current = handle
        return if (current == 0L) 0L else nativeStats(current).getOrElse(0) { 0L }
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
    private external fun nativeAcknowledgeDrained(handle: Long)
    private external fun nativeStats(handle: Long): LongArray
    private external fun nativeClose(handle: Long)
    private external fun nativeFree(handle: Long)

    companion object {
        init {
            System.loadLibrary("aurora_tauri_lib")
        }
    }
}

/** JNI bridge for the shared Rust VoiceRuntime session executor. */
private class AuroraNativeVoiceSessionBridge(
    gateway: String,
    bearer: String,
    remoteAudioConsent: Boolean,
) : AuroraPcmIngressBridge, AuroraPcmOutputBridge {
    private var handle: Long = nativeCreate(gateway, bearer, remoteAudioConsent)

    fun start(): Long {
        val current = handle
        return if (current == 0L) 0L else nativeStart(current)
    }

    fun finish(generation: Long): Int {
        val current = handle
        return if (current == 0L) -1 else nativeFinish(current, generation)
    }

    fun cancel(generation: Long): Int {
        val current = handle
        return if (current == 0L) -1 else nativeCancel(current, generation)
    }

    override fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        if (current == 0L || sampleCount !in 1..samples.size) return -1
        return nativePushPcm(current, samples, sampleCount, sequence)
    }

    override fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    override fun acknowledgeDrained() {
        val current = handle
        if (current != 0L) nativeAcknowledgeDrained(current)
    }

    override fun stats(): LongArray {
        val current = handle
        return if (current == 0L) LongArray(11) else nativeStats(current)
    }

    override fun drainOne(): Int = drainPcm().size

    override fun close() {
        val current = handle
        if (current != 0L) {
            nativeClose(current)
            nativeFree(current)
            handle = 0L
        }
    }

    private external fun nativeCreate(gateway: String, bearer: String, remoteAudioConsent: Boolean): Long
    private external fun nativeStart(handle: Long): Long
    private external fun nativeFinish(handle: Long, generation: Long): Int
    private external fun nativeCancel(handle: Long, generation: Long): Int
    private external fun nativePushPcm(handle: Long, samples: ShortArray, sampleCount: Int, sequence: Long): Int
    private external fun nativeDrainPcm(handle: Long): ShortArray
    private external fun nativeAcknowledgeDrained(handle: Long)
    private external fun nativeStats(handle: Long): LongArray
    private external fun nativeClose(handle: Long)
    private external fun nativeFree(handle: Long)

    companion object {
        init {
            System.loadLibrary("aurora_tauri_lib")
        }
    }
}

/** Native AudioTrack host for Rust-owned TTS chunks; no WebView audio path is used. */
private class AuroraAudioPlayback(
    private val bridge: AuroraPcmOutputBridge,
    private val closeBridgeOnClose: Boolean = true,
) : AutoCloseable {
    private val running = AtomicBoolean(false)
    private val worker = HandlerThread("aurora-audio-playback")
    private var handler: Handler? = null
    private var track: AudioTrack? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        worker.start()
        handler = Handler(worker.looper)
        handler?.post { playbackLoop() }
    }

    private fun playbackLoop() {
        val currentTrack = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE_HZ)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(SAMPLE_RATE_HZ * 2 / 2)
                .build()
        } catch (_: RuntimeException) {
            running.set(false)
            return
        }
        track = currentTrack
        try {
            currentTrack.play()
            while (running.get()) {
                val samples = bridge.drainPcm()
                if (samples.isEmpty()) {
                    Thread.sleep(10L)
                    continue
                }
                currentTrack.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
                bridge.acknowledgeDrained()
            }
        } catch (_: RuntimeException) {
            running.set(false)
        } finally {
            runCatching { currentTrack.stop() }
            currentTrack.release()
            track = null
        }
    }

    override fun close() {
        running.set(false)
        handler?.removeCallbacksAndMessages(null)
        worker.quitSafely()
        if (worker.state != Thread.State.NEW) {
            runCatching { worker.join() }
        }
        if (closeBridgeOnClose) bridge.close()
    }
}

private class AuroraAudioCapture(
    private val bridge: AuroraPcmIngressBridge,
    private val onSnapshot: (AuroraVoiceCaptureSnapshot) -> Unit,
    private val closeBridgeOnClose: Boolean = true,
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
        if (closeBridgeOnClose) bridge.close()
        publishSnapshot()
    }
}

class AuroraVoiceForegroundService : Service() {
    private var capture: AuroraAudioCapture? = null
    private var playback: AuroraAudioPlayback? = null
    private var session: AuroraNativeVoiceSessionBridge? = null
    private var sessionGeneration: Long = 0L
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private val finishHandler = Handler(Looper.getMainLooper())

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
                stopNativeSession()
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
        val nativeConfig = AuroraVoiceNativeConfigStore.load(this)
        session = nativeConfig?.let {
            AuroraNativeVoiceSessionBridge(it.gateway, it.bearer, it.remoteAudioConsent)
        }
        playback = if (session != null) {
            AuroraAudioPlayback(session!!, closeBridgeOnClose = false)
        } else {
            AuroraAudioPlayback(AuroraNativeAudioOutputBridge())
        }
        playback?.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_FINISH) {
            finishNativeSession()
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
            session?.let { nativeSession ->
                sessionGeneration = nativeSession.start()
                if (sessionGeneration == 0L) {
                    captureError = "voice_runtime_unavailable"
                    stopSelf()
                    return START_NOT_STICKY
                }
            }
            val ingress = session ?: AuroraNativeAudioBridge()
            capture = AuroraAudioCapture(ingress, { snapshot ->
                captureSnapshot = snapshot
                updateNotification(snapshot)
            }, closeBridgeOnClose = session == null)
            if (capture?.start() != true) stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        finishHandler.removeCallbacksAndMessages(null)
        capture?.close()
        capture = null
        stopNativeSession()
        playback?.close()
        playback = null
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

    private fun stopNativeSession() {
        val nativeSession = session ?: return
        if (sessionGeneration != 0L) {
            nativeSession.cancel(sessionGeneration)
        }
        sessionGeneration = 0L
        nativeSession.close()
        session = null
    }

    private fun finishNativeSession() {
        val nativeSession = session ?: return
        if (sessionGeneration != 0L) {
            nativeSession.finish(sessionGeneration)
        }
        capture?.close()
        capture = null
        sessionGeneration = 0L
        awaitFinishedSession()
    }

    private fun awaitFinishedSession() {
        val nativeSession = session ?: run {
            stopSelf()
            return
        }
        val stats = nativeSession.stats()
        val active = stats.getOrElse(5) { 0L } != 0L
        val queuedOutput = stats.getOrElse(10) { 0L }
        if (active || queuedOutput > 0L) {
            finishHandler.postDelayed({ awaitFinishedSession() }, 100L)
            return
        }
        stopSelf()
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
        const val ACTION_FINISH = "dev.aurora.tauri.nativeplugin.action.FINISH_VOICE_CAPTURE"
        const val ACTION_START_ASSISTANT = "dev.aurora.tauri.nativeplugin.action.START_ASSISTANT_VOICE"

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
