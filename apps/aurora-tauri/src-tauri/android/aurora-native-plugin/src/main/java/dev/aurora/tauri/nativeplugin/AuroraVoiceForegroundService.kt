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
import androidx.core.app.NotificationManagerCompat
import java.io.File
import java.io.FileInputStream
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
private const val VOICE_GENERIC_GATEWAY_KEY = "aurora.gateway"
private const val VOICE_GENERIC_BEARER_KEY = "aurora.auth"
private const val VOICE_REMOTE_AUDIO_CONSENT_KEY = "aurora.voice.remote_audio_consent"
private const val THIN_PROFILE_PREFS = "aurora_thin_profile"
private const val THIN_PROFILE_KEY = "aurora.session.android-thin-connection-profile.v1"
private const val VOICE_PACK_PREFS = "aurora_voice_pack_cache"
private const val VOICE_PACK_CATALOG_KEY = "catalog"
private const val VOICE_PACK_ACTIVE_ID_KEY = "active_voice_pack_id"
private const val VOICE_PACK_CACHE_DIR = "aurora_voice_packs"
private val voicePackCatalogFileNameRegex = Regex("[A-Za-z0-9._-]+")
private const val VOICE_PACK_MIN_BYTES = 4L * 1024L
private const val VOICE_PACK_MAX_BYTES = 1L * 1024L * 1024L * 1024L
private const val VOICE_PACK_SHA256_HEX_LENGTH = 64
private val voicePackNativeSupportedTasks = setOf("stt", "asr", "transcription", "vad", "tts", "wakeword", "wake-word", "local-inference", "local_inference", "inference")

private data class VoicePackCatalogEntry(
    val packId: String,
    val packName: String,
    val uri: String,
    val provider: String,
    val language: String,
    val sha256: String,
    val sizeBytes: Long,
    val tasks: List<String>,
    val engineRuntimeRevision: String,
    val supportedOperatingSystems: List<String>,
    val supportedAbis: List<String>,
    val license: String,
    val attributionRequired: Boolean,
    val attributionText: String,
)

data class AuroraVoiceNativeConfig(
    val gateway: String,
    val bearer: String,
    val remoteAudioConsent: Boolean,
)

object AuroraVoiceNativeConfigStore {
    fun isConfigured(context: Context): Boolean = load(context) != null

    /**
     * Stores the native voice route without exposing the bearer to the WebView.
     * The caller must have already resolved the route from the persisted runtime
     * profile and native peer-credential store.
     */
    fun setRoute(context: Context, gateway: String, bearer: String) {
        val validatedGateway = validateGateway(gateway)
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(VOICE_GATEWAY_KEY, encrypt(validatedGateway))
            .putString(VOICE_BEARER_KEY, encrypt(bearer))
            .remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)
            .apply()
    }

    fun clearRoute(context: Context) {
        context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(VOICE_GATEWAY_KEY)
            .remove(VOICE_BEARER_KEY)
            .remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)
            .apply()
    }

    fun load(context: Context): AuroraVoiceNativeConfig? {
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        val gateway = (prefs.getString(VOICE_GATEWAY_KEY, null)
            ?: prefs.getString(VOICE_GENERIC_GATEWAY_KEY, null))?.let(::decrypt) ?: return null
        val bearer = (prefs.getString(VOICE_BEARER_KEY, null)
            ?: prefs.getString(VOICE_GENERIC_BEARER_KEY, null))?.let(::decrypt).orEmpty()
        if (gateway.isBlank()) return null
        val validatedGateway = runCatching { validateGateway(gateway) }.getOrNull() ?: return null
        val remoteAudioConsent = prefs.getString(VOICE_REMOTE_AUDIO_CONSENT_KEY, null)
            ?.let { decrypt(it) }
            ?.toBooleanStrictOrNull()
            ?: false
        return AuroraVoiceNativeConfig(validatedGateway, bearer, remoteAudioConsent)
    }

    fun setRemoteAudioConsent(context: Context, granted: Boolean) {
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(VOICE_REMOTE_AUDIO_CONSENT_KEY, encrypt(granted.toString()))
            .apply()
    }

    private fun validateGateway(value: String): String {
        val gateway = value.trim()
        require(gateway.isNotEmpty() && gateway.length <= 2_048) { "voice_gateway_invalid" }
        val uri = android.net.Uri.parse(gateway)
        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        require(host != null && uri.userInfo == null && uri.fragment == null) { "voice_gateway_invalid" }
        val loopback = host == "127.0.0.1" || host == "localhost"
        require(scheme == "https" || (scheme == "http" && loopback)) { "voice_gateway_invalid" }
        return gateway
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
    packStoreRoot: String? = null,
    sttModelId: String? = null,
    ttsVoiceId: String? = null,
    vadModelId: String? = null,
    kwsModelId: String? = null,
    wakePhraseId: String? = null,
    wakePhraseText: String? = null,
    wakePhraseRevision: String? = null,
) : AuroraPcmIngressBridge, AuroraPcmOutputBridge {
    private var handle: Long = if (packStoreRoot != null && sttModelId != null && ttsVoiceId != null) {
        nativeCreateWithPackSelection(
            gateway,
            bearer,
            remoteAudioConsent,
            packStoreRoot,
            sttModelId,
            ttsVoiceId,
            vadModelId.orEmpty(),
            kwsModelId.orEmpty(),
            wakePhraseId.orEmpty(),
            wakePhraseText.orEmpty(),
            wakePhraseRevision.orEmpty(),
        )
    } else {
        nativeCreate(gateway, bearer, remoteAudioConsent)
    }

    fun start(): Long {
        return start(background = false)
    }

    fun startBackground(): Long {
        return start(background = true)
    }

    private fun start(background: Boolean): Long {
        val current = handle
        return if (current == 0L) 0L else if (background) nativeStartBackground(current) else nativeStart(current)
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
    private external fun nativeCreateWithPackSelection(
        gateway: String,
        bearer: String,
        remoteAudioConsent: Boolean,
        packStoreRoot: String,
        sttModelId: String,
        ttsVoiceId: String,
        vadModelId: String,
        kwsModelId: String,
        wakePhraseId: String,
        wakePhraseText: String,
        wakePhraseRevision: String,
    ): Long
    private external fun nativeStart(handle: Long): Long
    private external fun nativeStartBackground(handle: Long): Long
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
    private val context: Context,
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
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("microphone_permission_missing")
            return false
        }
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
        val backgroundSession = intent?.action == ACTION_START_BACKGROUND ||
            intent?.action == ACTION_START_ASSISTANT
        if (backgroundSession && !isBackgroundVoiceSessionAvailable()) {
            captureError = "background_voice_unavailable"
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
        initializeNativeVoiceSession()
        if (session == null) {
            captureError = "voice_runtime_unavailable"
            stopSelf()
            return START_NOT_STICKY
        }
        if (capture == null) {
            captureError = null
            val nativeSession = session ?: return START_NOT_STICKY
            sessionGeneration = if (backgroundSession) {
                nativeSession.startBackground()
            } else {
                nativeSession.start()
            }
            if (sessionGeneration == 0L) {
                captureError = "voice_runtime_unavailable"
                stopSelf()
                return START_NOT_STICKY
            }
            capture = AuroraAudioCapture(this, nativeSession, { snapshot ->
                captureSnapshot = snapshot
                updateNotification(snapshot)
            }, closeBridgeOnClose = false)
            if (capture?.start() != true) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun isBackgroundVoiceSessionAvailable(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            checkSelfPermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        if (!hasPostNotificationsPermission() || !canPostNotifications()) return false
        return AuroraVoiceNativeConfigStore.isConfigured(this) &&
            isActivePackReady(AuroraSpeechPackTask.STT) &&
            isActivePackReady(AuroraSpeechPackTask.TTS) &&
            isActivePackReady(AuroraSpeechPackTask.VAD) &&
            isActivePackReady(AuroraSpeechPackTask.KWS) &&
            wakePhraseSelection() != null
    }

    private fun hasPostNotificationsPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun canPostNotifications(): Boolean = hasPostNotificationsPermission() && NotificationManagerCompat.from(this).areNotificationsEnabled()

    private fun isActiveCompatiblePackReady(): Boolean {
        return isActivePackReady(AuroraSpeechPackTask.STT) && isActivePackReady(AuroraSpeechPackTask.TTS)
    }

    private fun getActivePackId(): String? =
        getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE).getString(VOICE_PACK_ACTIVE_ID_KEY, null)

    private fun getActivePackId(task: AuroraSpeechPackTask): String? =
        getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE)
            .getString(auroraSpeechPackActiveKey(task), null)

    private fun isActivePackReady(task: AuroraSpeechPackTask): Boolean {
        val active = getActivePackId(task) ?: return false
        val catalog = runCatching { readCatalogEntries() }.getOrElse { emptyList() }
        val entry = catalog.firstOrNull { it.packId == active } ?: return false
        return inferAuroraSpeechPackTask(entry.tasks) == task &&
            isPackMetadataRuntimeCompatible(entry) &&
            isPackInstalled(entry.packId, task)
    }

    private fun readCatalogEntries(): List<VoicePackCatalogEntry> {
        val raw = getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE).getString(VOICE_PACK_CATALOG_KEY, "[]") ?: "[]"
        val parsed = runCatching { org.json.JSONArray(raw) }.getOrElse { org.json.JSONArray() }
        val entries = ArrayList<VoicePackCatalogEntry>(parsed.length())
        for (index in 0 until parsed.length()) {
            val item = parsed.optJSONObject(index) ?: continue
            val packId = item.optString("packId", "").trim()
            val sizeBytes = item.optLong("sizeBytes", -1L)
            val tasks = readJsonStringList(item, "tasks")
            val supportedOperatingSystems = readJsonStringList(item, "supportedOperatingSystems")
            val supportedAbis = readJsonStringList(item, "supportedAbis")
            if (!voicePackCatalogFileNameRegex.matches(packId)) continue
            if (sizeBytes !in VOICE_PACK_MIN_BYTES..VOICE_PACK_MAX_BYTES) continue
            if (tasks.isEmpty() || supportedOperatingSystems.isEmpty() || supportedAbis.isEmpty()) continue
            val uri = item.optString("uri", "").trim()
            if (uri.isBlank()) continue
            val sha256 = item.optString("sha256", "").trim()
            if (!isValidHexSha256(sha256)) continue
            entries.add(
                VoicePackCatalogEntry(
                    packId = packId,
                    packName = item.optString("packName", packId),
                    uri = uri,
                    provider = item.optString("provider", "unknown"),
                    language = item.optString("language", "und"),
                    sha256 = sha256.lowercase(),
                    sizeBytes = sizeBytes,
                    tasks = tasks,
                    engineRuntimeRevision = item.optString("engineRuntimeRevision", ""),
                    supportedOperatingSystems = supportedOperatingSystems,
                    supportedAbis = supportedAbis,
                    license = item.optString("license", ""),
                    attributionRequired = item.optBoolean("attributionRequired", false),
                    attributionText = item.optString("attributionText", ""),
                ),
            )
        }
        return entries
    }

    private fun isPackMetadataRuntimeCompatible(entry: VoicePackCatalogEntry): Boolean {
        val taskSupported = entry.tasks.any { task ->
            voicePackNativeSupportedTasks.any { token -> task.lowercase().contains(token) }
        }
        if (!taskSupported) return false
        val osOk = entry.supportedOperatingSystems.any { os ->
            val normalized = os.lowercase()
            normalized == "android" || normalized == "android-native"
        }
        if (!osOk) return false
        return entry.supportedAbis.any { abi ->
            val normalized = abi.lowercase()
            normalized == "*" || normalized == "all" || Build.SUPPORTED_ABIS.any { device -> device.lowercase() == normalized }
        }
    }

    private fun readJsonStringList(source: org.json.JSONObject, key: String): List<String> {
        val entries = source.optJSONArray(key) ?: return emptyList()
        val out = ArrayList<String>(entries.length())
        for (index in 0 until entries.length()) {
            val value = entries.optString(index, "").trim()
            if (value.isNotBlank()) out.add(value.lowercase())
        }
        return out
    }

    private fun isValidHexSha256(value: String): Boolean =
        value.length == VOICE_PACK_SHA256_HEX_LENGTH && value.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    private fun safePackFileName(packId: String): String =
        packId.lowercase().filter { it.isLetterOrDigit() || it in "._-" }.ifBlank { "pack.bin" }

    private fun isPackDownloaded(packId: String, expectedSha256: String?): Boolean {
        if (!voicePackCatalogFileNameRegex.matches(packId)) return false
        val file = File(filesDir, "$VOICE_PACK_CACHE_DIR/${safePackFileName(packId)}")
        if (!file.exists() || !file.isFile) return false
        val expected = expectedSha256?.trim()?.lowercase().orEmpty()
        if (expected.isBlank()) return true
        val actual = try {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { fis ->
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    val count = fis.read(buffer)
                    if (count <= 0) break
                    digest.update(buffer, 0, count)
                }
            }
            digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        } catch (_: Exception) {
            return false
        }
        return expected == actual
    }

    private fun isPackInstalled(packId: String, task: AuroraSpeechPackTask): Boolean {
        if (!voicePackCatalogFileNameRegex.matches(packId)) return false
        return runCatching { AuroraNativeSpeechPackBridge.resolve(this, packId, task) }.getOrDefault(false)
    }

    private fun wakePhraseSelection(): AuroraWakePhraseSelection? {
        val prefs = getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString(AURORA_WAKE_PHRASE_ID_KEY, null)?.trim().orEmpty()
        val text = prefs.getString(AURORA_WAKE_PHRASE_TEXT_KEY, null)?.trim().orEmpty()
        val revision = prefs.getString(AURORA_WAKE_PHRASE_REVISION_KEY, null)?.trim().orEmpty()
        if (id.isNotBlank() && text.isNotBlank() && revision.isNotBlank()) {
            return AuroraWakePhraseSelection(id, text, revision)
        }
        return wakePhraseSelectionFromRuntimeProfile()
    }

    private fun wakePhraseSelectionFromRuntimeProfile(): AuroraWakePhraseSelection? {
        val raw = getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
            .getString(THIN_PROFILE_KEY, null)
            ?: return null
        val root = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val activeProfileId = root.optString("activeProfileId", "").takeIf { it.isNotBlank() }
        val profile = if (activeProfileId != null) {
            val profileMap = root.optJSONObject("profiles")
            val profileArray = root.optJSONArray("profiles")
            profileMap?.optJSONObject(activeProfileId)
                ?: profileArray?.let { profiles ->
                    (0 until profiles.length())
                        .mapNotNull { index -> profiles.optJSONObject(index) }
                        .firstOrNull { item -> item.optString("id") == activeProfileId }
                }
        } else {
            null
        } ?: root.optJSONObject("activeProfile")
            ?: root.optJSONObject("profile")
            ?: return null
        val selection = profile
            .optJSONObject("localNode")
            ?.optJSONObject("localSpeechSelection")
            ?: profile.optJSONObject("localSpeechSelection")
            ?: return null
        val phrase = selection.optJSONObject("wakePhrase") ?: selection
        val id = phrase.optString("id", phrase.optString("phraseId", "")).trim()
        val text = phrase.optString("text", phrase.optString("phrase", "")).trim()
        val revision = phrase.optString("revision", phrase.optString("phraseRevision", "")).trim()
        return if (id.isNotBlank() && text.isNotBlank() && revision.isNotBlank()) {
            AuroraWakePhraseSelection(id, text, revision)
        } else {
            null
        }
    }

    private fun initializeNativeVoiceSession() {
        if (playback != null) return
        val nativeConfig = AuroraVoiceNativeConfigStore.load(this)
        val sttModelId = getActivePackId(AuroraSpeechPackTask.STT)
        val ttsVoiceId = getActivePackId(AuroraSpeechPackTask.TTS)
        val vadModelId = getActivePackId(AuroraSpeechPackTask.VAD)
        val kwsModelId = getActivePackId(AuroraSpeechPackTask.KWS)
        val wakePhrase = wakePhraseSelection()
        session = nativeConfig?.let {
            if (sttModelId != null && ttsVoiceId != null) {
                AuroraNativeVoiceSessionBridge(
                    it.gateway,
                    it.bearer,
                    it.remoteAudioConsent,
                    auroraSpeechPackStoreRoot(this).path,
                    sttModelId,
                    ttsVoiceId,
                    vadModelId,
                    kwsModelId,
                    wakePhrase?.id,
                    wakePhrase?.text,
                    wakePhrase?.revision,
                )
            } else {
                null
            }
        }
        val nativeSession = session ?: return
        playback = AuroraAudioPlayback(nativeSession, closeBridgeOnClose = false)
        playback?.start()
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
        const val ACTION_START_BACKGROUND = "dev.aurora.tauri.nativeplugin.action.START_BACKGROUND_VOICE"
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
