package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
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
import android.os.PowerManager
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.app.NotificationManagerCompat
import dev.aurora.desktop.R
import java.io.FileDescriptor
import java.io.PrintWriter
import java.net.URI
import java.security.KeyStore
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

private const val AURORA_RUNTIME_CHANNEL_ID = "aurora_voice_capture"
private const val AURORA_RUNTIME_NOTIFICATION_ID = 4203
private const val SAMPLE_RATE_HZ = 16_000
private const val CHANNEL_COUNT = 1
private const val QUEUE_CAPACITY_CHUNKS = 8
private const val MAX_CHUNK_SAMPLES = 4_096
private const val VOICE_CAPTURE_FRAME_SAMPLES = SAMPLE_RATE_HZ / 10
// Android emulators and headless devices can expose an AudioTrack sink that
// accepts construction/play but never makes blocking writes return. Bound the
// host write so a stalled sink is reported to the Rust runtime as a playback
// failure instead of leaving the assistant turn in "speaking" indefinitely.
private const val VOICE_PLAYBACK_WRITE_TIMEOUT_MILLIS = 2_000L
private const val VOICE_RECOVERABLE_ERROR_REARM_DELAY_MILLIS = 2_500L
// Debug-only deterministic ingress expires 120 seconds after its last explicit
// harness heartbeat, restoring live capture if the harness exits unexpectedly.
private const val VOICE_LIVE_TEST_INGRESS_MAX_HOLD_MILLIS = 120_000L
private const val VOICE_STATS_RUNTIME_ACTIVE_INDEX = 5
private const val VOICE_STATS_RUNTIME_PHASE_INDEX = 6
private const val VOICE_STATS_SESSION_GENERATION_INDEX = 7
private const val VOICE_STATS_COMPLETED_TURNS_INDEX = 8
private const val VOICE_STATS_FAILED_TURNS_INDEX = 9
private const val VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX = 10
private const val VOICE_STATS_LAST_ERROR_INDEX = 11
private const val VOICE_RUNTIME_INIT_STACK_SIZE_BYTES = 16L * 1024L * 1024L
private val AUDIO_SOURCE_FALLBACKS = intArrayOf(
    MediaRecorder.AudioSource.VOICE_RECOGNITION,
    MediaRecorder.AudioSource.MIC,
)
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
private const val VOICE_SERVICE_PREFS = "aurora_voice_foreground_service_state"
private const val VOICE_BACKGROUND_SESSION_REQUESTED_KEY = "background_session_requested"
private const val VOICE_BACKGROUND_STOPPED_BY_USER_KEY = "background_stopped_by_user"
private const val THIN_PROFILE_PREFS = "aurora_thin_profile"
private const val THIN_PROFILE_KEY = "aurora.session.android-thin-connection-profile.v1"
private const val VOICE_PACK_PREFS = "aurora_voice_pack_cache"
private const val VOICE_PACK_CATALOG_KEY = "catalog"
private val voicePackCatalogIdRegex = Regex("[A-Za-z0-9._:-]+")
private const val VOICE_PACK_MIN_BYTES = 4L * 1024L
private const val VOICE_PACK_SHA256_HEX_LENGTH = 64

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
    val modelFamily: String,
    val requiresReferenceAudio: Boolean,
    val referenceAudioMode: String,
)

data class AuroraVoiceNativeConfig(
    val gateway: String,
    val bearer: String,
    val remoteAudioConsent: Boolean,
    val assistantRouteMode: String,
    val preferredStablePeerId: String?,
)

private data class AuroraVoiceRouteProfile(
    val mode: String,
    val preferredStablePeerId: String?,
)

object AuroraVoiceNativeConfigStore {
    fun isConfigured(context: Context): Boolean = load(context) != null

    fun hasAssistantRoute(context: Context): Boolean =
        load(context)?.assistantRouteMode?.let { it != "local-only" } == true

    /**
     * Stores the native voice route without exposing the bearer to the WebView.
     * The caller must have already resolved the route from the persisted runtime
     * profile and native peer-credential store.
     */
    fun setRoute(context: Context, gateway: String, bearer: String) {
        val validatedGateway = validateGateway(gateway)
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        val currentGateway = (prefs.getString(VOICE_GATEWAY_KEY, null)
            ?: prefs.getString(VOICE_GENERIC_GATEWAY_KEY, null))?.let(::decrypt)
        val currentBearer = (prefs.getString(VOICE_BEARER_KEY, null)
            ?: prefs.getString(VOICE_GENERIC_BEARER_KEY, null))?.let(::decrypt).orEmpty()
        val routeChanged = currentGateway != validatedGateway || currentBearer != bearer
        prefs.edit()
            .putString(VOICE_GATEWAY_KEY, encrypt(validatedGateway))
            .putString(VOICE_BEARER_KEY, encrypt(bearer))
            .apply {
                if (routeChanged) remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)
            }
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
        val routeProfile = activeVoiceRouteProfile(context) ?: return localOnlyConfig()
        if (routeProfile.mode == "webrtc-only") {
            return AuroraVoiceNativeConfig(
                gateway = "",
                bearer = "",
                remoteAudioConsent = false,
                assistantRouteMode = routeProfile.mode,
                preferredStablePeerId = routeProfile.preferredStablePeerId,
            )
        }
        val prefs = context.getSharedPreferences(VOICE_SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)
        val gateway = (prefs.getString(VOICE_GATEWAY_KEY, null)
            ?: prefs.getString(VOICE_GENERIC_GATEWAY_KEY, null))?.let(::decrypt)
            ?: return routeFallbackConfig(routeProfile)
        val bearer = (prefs.getString(VOICE_BEARER_KEY, null)
            ?: prefs.getString(VOICE_GENERIC_BEARER_KEY, null))?.let(::decrypt).orEmpty()
        if (gateway.isBlank()) return routeFallbackConfig(routeProfile)
        val validatedGateway = runCatching { validateGateway(gateway) }.getOrNull()
            ?: return routeFallbackConfig(routeProfile)
        val remoteAudioConsent = prefs.getString(VOICE_REMOTE_AUDIO_CONSENT_KEY, null)
            ?.let { decrypt(it) }
            ?.toBooleanStrictOrNull()
            ?: false
        return AuroraVoiceNativeConfig(
            validatedGateway,
            bearer,
            remoteAudioConsent,
            routeProfile.mode,
            routeProfile.preferredStablePeerId,
        )
    }

    private fun routeFallbackConfig(routeProfile: AuroraVoiceRouteProfile): AuroraVoiceNativeConfig =
        if (routeProfile.mode == "webrtc-preferred" && routeProfile.preferredStablePeerId != null) {
            AuroraVoiceNativeConfig(
                gateway = "",
                bearer = "",
                remoteAudioConsent = false,
                assistantRouteMode = "webrtc-only",
                preferredStablePeerId = routeProfile.preferredStablePeerId,
            )
        } else {
            localOnlyConfig()
        }

    private fun localOnlyConfig(): AuroraVoiceNativeConfig = AuroraVoiceNativeConfig(
        gateway = "",
        bearer = "",
        remoteAudioConsent = false,
        assistantRouteMode = "local-only",
        preferredStablePeerId = null,
    )

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

    private fun activeVoiceRouteProfile(context: Context): AuroraVoiceRouteProfile? {
        val raw = context.getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
            .getString(THIN_PROFILE_KEY, null)
            ?: return null
        val root = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val profile = activeProfile(root) ?: return null
        val home = profile.optJSONObject("homeConnection")
        val mode = home?.optString("mode")?.takeIf { it.isNotBlank() }
            ?: profile.optString("mode").takeIf { it.isNotBlank() }
            ?: return null
        if (mode !in setOf("http-only", "webrtc-preferred", "webrtc-only")) return null
        val homeWebRtc = home?.optJSONObject("webrtcProfile")
        val profileWebRtc = profile.optJSONObject("webrtcProfile")
        val peerId = home?.optString("homePeerId")?.takeIf { it.isNotBlank() }
            ?: homeWebRtc?.optString("expectedStablePeerId")?.takeIf { it.isNotBlank() }
            ?: profileWebRtc?.optString("expectedStablePeerId")?.takeIf { it.isNotBlank() }
        if (mode == "webrtc-only" && peerId == null) return null
        return AuroraVoiceRouteProfile(mode, peerId)
    }

    private fun activeProfile(root: JSONObject): JSONObject? {
        val activeProfileId = root.optString("activeProfileId", "").takeIf { it.isNotBlank() }
        val byId = activeProfileId?.let { profileId ->
            val profileMap = root.optJSONObject("profiles")
            val profileArray = root.optJSONArray("profiles")
            profileMap?.optJSONObject(profileId)
                ?: profileArray?.let { profiles ->
                    (0 until profiles.length())
                        .mapNotNull { index -> profiles.optJSONObject(index) }
                        .firstOrNull { item -> item.optString("id") == profileId }
                }
        }
        return byId ?: root.optJSONObject("activeProfile") ?: root.optJSONObject("profile")
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
    fun stats(): LongArray
}

private interface AuroraPcmOutputBridge : AutoCloseable {
    fun drainPcm(): ShortArray
    fun acknowledgeDrained()
    fun failPlayback(errorCode: String)
}

data class AuroraVoiceCaptureSnapshot(
    val captureActive: Boolean,
    val microphoneSignalDetected: Boolean,
    val microphoneSilenced: Boolean,
    val sampleRateHz: Int,
    val acceptedChunks: Long,
    val acceptedSamples: Long,
    val droppedChunks: Long,
    val discontinuities: Long,
    val queuedChunks: Long,
    val runtimeActive: Boolean,
    val runtimePhase: String,
    val sessionGeneration: Long,
    val completedTurns: Long,
    val failedTurns: Long,
    val queuedOutputChunks: Long,
    val errorCode: String?,
)

private fun auroraVoiceRuntimePhase(value: Long): String = when (value) {
    0L -> "idle"
    1L -> "starting"
    2L -> "listening"
    3L -> "processing"
    4L -> "speaking"
    5L -> "stopping"
    6L -> "faulted"
    7L -> "waiting-for-wake"
    8L -> "transcribing"
    9L -> "waiting-for-response"
    10L -> "preparing-speech"
    else -> "unknown"
}

private fun auroraVoiceRuntimeError(value: Long): String? = when (value) {
    0L -> null
    1L -> "cancelled"
    2L -> "assistant_unavailable"
    3L -> "transcription_failed"
    4L -> "tts_failed"
    5L -> "playback_failed"
    6L -> "audio_overloaded"
    7L -> "voice_state_invalid"
    8L -> "wake_not_detected"
    9L -> "speech_not_detected"
    10L -> "speech_timeout"
    else -> "turn_failed"
}

private fun isRecoverableBackgroundTurn(errorCode: String?): Boolean = when (errorCode) {
    null,
    "assistant_unavailable",
    "wake_not_detected",
    "speech_not_detected",
    "speech_timeout" -> true
    else -> false
}

private fun voiceRuntimeAcceptsMicrophoneInput(stats: LongArray): Boolean {
    if (stats.getOrElse(VOICE_STATS_RUNTIME_ACTIVE_INDEX) { 0L } == 0L) return false
    return when (stats.getOrElse(VOICE_STATS_RUNTIME_PHASE_INDEX) { 0L }) {
        1L, 2L, 7L -> true
        else -> false
    }
}

/** JNI handle for the bounded Rust-owned PCM ingress queue. */
private class AuroraNativeAudioBridge : AuroraPcmIngressBridge {
    private var handle: Long = nativeCreate(QUEUE_CAPACITY_CHUNKS, MAX_CHUNK_SAMPLES)

    override fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        if (current == 0L || sampleCount !in 1..samples.size) return -1
        return nativePushPcm(current, samples, sampleCount, sequence)
    }

    fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    override fun stats(): LongArray {
        val current = handle
        return if (current == 0L) LongArray(12) { 0 } else nativeStats(current)
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

    override fun failPlayback(errorCode: String) {
        val current = handle
        if (current != 0L) nativeFailPlayback(current, errorCode)
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
    private external fun nativeFailPlayback(handle: Long, errorCode: String)
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
    assistantRouteMode: String,
    preferredStablePeerId: String?,
    packStoreRoot: String? = null,
    sttModelId: String? = null,
    ttsVoiceId: String? = null,
    vadModelId: String? = null,
    kwsModelId: String? = null,
    wakePhraseId: String? = null,
    wakePhraseText: String? = null,
    wakePhraseRevision: String? = null,
    ttsReference: AuroraTtsReferenceSelection? = null,
) : AuroraPcmIngressBridge, AuroraPcmOutputBridge {
    private var handle: Long = if (packStoreRoot != null && sttModelId != null && ttsVoiceId != null) {
        nativeCreateWithPackSelection(
            gateway,
            bearer,
            remoteAudioConsent,
            assistantRouteMode,
            preferredStablePeerId.orEmpty(),
            packStoreRoot,
            sttModelId,
            ttsVoiceId,
            vadModelId.orEmpty(),
            kwsModelId.orEmpty(),
            wakePhraseId.orEmpty(),
            wakePhraseText.orEmpty(),
            wakePhraseRevision.orEmpty(),
            ttsReference?.sampleRateHz ?: 0,
            ttsReference?.samples ?: FloatArray(0),
            ttsReference?.text.orEmpty(),
            ttsReference?.revision.orEmpty(),
        )
    } else {
        nativeCreate(
            gateway,
            bearer,
            remoteAudioConsent,
            assistantRouteMode,
            preferredStablePeerId.orEmpty(),
        )
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

    fun takeFocusedTranscript(): String? {
        val current = handle
        return if (current == 0L) null else nativeTakeFocusedTranscript(current)
    }

    fun takeBackgroundResultJson(): String? {
        val current = handle
        return if (current == 0L) null else nativeTakeBackgroundResult(current)
    }

    fun persistBackgroundTurn(
        appConfigDir: String,
        scope: AuroraNativeLocalDataScope,
        newConversationId: String,
        userMessageId: String,
        userContentEnvelopeJson: String,
        assistantMessageId: String?,
        assistantContentEnvelopeJson: String?,
        createdAtMs: Long,
        completedAtMs: Long,
    ): String? = nativePersistBackgroundTurn(
        appConfigDir,
        scope.profileId,
        scope.localNodeId,
        newConversationId,
        userMessageId,
        userContentEnvelopeJson,
        assistantMessageId.orEmpty(),
        assistantContentEnvelopeJson.orEmpty(),
        createdAtMs,
        completedAtMs,
    )

    fun cancel(generation: Long): Int {
        val current = handle
        return if (current == 0L) -1 else nativeCancel(current, generation)
    }

    override fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        if (current == 0L || sampleCount !in 1..samples.size) return -1
        return nativePushPcm(current, samples, sampleCount, sequence)
    }

    fun clearIngress(): Boolean {
        val current = handle
        return current != 0L && nativeClearIngress(current) == 0
    }

    override fun drainPcm(): ShortArray {
        val current = handle
        return if (current == 0L) ShortArray(0) else nativeDrainPcm(current)
    }

    override fun acknowledgeDrained() {
        val current = handle
        if (current != 0L) nativeAcknowledgeDrained(current)
    }

    override fun failPlayback(errorCode: String) {
        val current = handle
        if (current != 0L) nativeFailPlayback(current, errorCode)
    }

    override fun stats(): LongArray {
        val current = handle
        return if (current == 0L) LongArray(11) else nativeStats(current)
    }

    override fun close() {
        val current = handle
        if (current != 0L) {
            nativeClose(current)
            nativeFree(current)
            handle = 0L
        }
    }

    private external fun nativeCreate(
        gateway: String,
        bearer: String,
        remoteAudioConsent: Boolean,
        assistantRouteMode: String,
        preferredStablePeerId: String,
    ): Long
    private external fun nativeCreateWithPackSelection(
        gateway: String,
        bearer: String,
        remoteAudioConsent: Boolean,
        assistantRouteMode: String,
        preferredStablePeerId: String,
        packStoreRoot: String,
        sttModelId: String,
        ttsVoiceId: String,
        vadModelId: String,
        kwsModelId: String,
        wakePhraseId: String,
        wakePhraseText: String,
        wakePhraseRevision: String,
        ttsReferenceSampleRateHz: Int,
        ttsReferenceSamples: FloatArray,
        ttsReferenceText: String,
        ttsReferenceRevision: String,
    ): Long
    private external fun nativeStart(handle: Long): Long
    private external fun nativeStartBackground(handle: Long): Long
    private external fun nativeFinish(handle: Long, generation: Long): Int
    private external fun nativeTakeFocusedTranscript(handle: Long): String?
    private external fun nativeTakeBackgroundResult(handle: Long): String?
    private external fun nativePersistBackgroundTurn(
        appConfigDir: String,
        profileId: String,
        localNodeId: String,
        newConversationId: String,
        userMessageId: String,
        userContentEnvelopeJson: String,
        assistantMessageId: String,
        assistantContentEnvelopeJson: String,
        createdAtMs: Long,
        completedAtMs: Long,
    ): String?
    private external fun nativeCancel(handle: Long, generation: Long): Int
    private external fun nativePushPcm(handle: Long, samples: ShortArray, sampleCount: Int, sequence: Long): Int
    private external fun nativeClearIngress(handle: Long): Int
    private external fun nativeDrainPcm(handle: Long): ShortArray
    private external fun nativeAcknowledgeDrained(handle: Long)
    private external fun nativeFailPlayback(handle: Long, errorCode: String)
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
            bridge.failPlayback("android_audio_track_write_failed")
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
                if (!writeChunkBounded(currentTrack, samples)) {
                    if (running.get()) {
                        bridge.failPlayback("android_audio_track_write_failed")
                    }
                    running.set(false)
                    break
                }
                bridge.acknowledgeDrained()
            }
        } catch (_: RuntimeException) {
            if (running.get()) {
                bridge.failPlayback("android_audio_track_write_failed")
            }
            running.set(false)
        } catch (_: InterruptedException) {
            if (running.get()) {
                bridge.failPlayback("android_audio_track_write_failed")
            }
            running.set(false)
            Thread.currentThread().interrupt()
        } finally {
            runCatching { currentTrack.stop() }
            currentTrack.release()
            track = null
        }
    }

    private fun writeChunkBounded(currentTrack: AudioTrack, samples: ShortArray): Boolean {
        var offset = 0
        var lastProgressMillis = SystemClock.elapsedRealtime()
        while (running.get() && offset < samples.size) {
            val written = currentTrack.write(
                samples,
                offset,
                samples.size - offset,
                AudioTrack.WRITE_NON_BLOCKING,
            )
            if (written > 0) {
                offset += written
                lastProgressMillis = SystemClock.elapsedRealtime()
                continue
            }
            if (written < 0) return false
            if (SystemClock.elapsedRealtime() - lastProgressMillis >= VOICE_PLAYBACK_WRITE_TIMEOUT_MILLIS) {
                return false
            }
            Thread.sleep(10L)
        }
        return offset == samples.size
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

private enum class LiveTestIngressLeaseState {
    AVAILABLE,
    OWNED,
    RELEASED,
}

private class AuroraAudioCapture(
    private val context: Context,
    private val bridge: AuroraPcmIngressBridge,
    private val onSnapshot: (AuroraVoiceCaptureSnapshot) -> Unit,
    private val closeBridgeOnClose: Boolean = true,
    liveTestIngressInitiallyArmed: Boolean = false,
) : AutoCloseable {
    private val running = AtomicBoolean(false)
    private val sequenceGuard = Any()
    private val worker = HandlerThread("aurora-audio-capture")
    private var handler: Handler? = null
    private var recorder: AudioRecord? = null
    private var sequence = 0L
    private var errorCode: String? = null

    private var liveTestIngressLeaseState = LiveTestIngressLeaseState.AVAILABLE
    private var liveTestIngressLeaseUntilMillis = 0L
    private var liveTestIngressCompletedTurnsAtArm = 0L

    @Volatile
    private var microphoneSignalDetected = false

    @Volatile
    private var microphoneSilenced = false

    init {
        if (liveTestIngressInitiallyArmed) {
            synchronized(sequenceGuard) {
                acquireOrRenewLiveTestIngressLocked()
            }
        }
    }

    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return true
        worker.start()
        handler = Handler(worker.looper)
        if (handler?.post { openAndReadLoop() } != true) {
            fail("audio_record_initialization_failed")
            return false
        }
        return true
    }

    private fun openAndReadLoop() {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("microphone_permission_missing")
            return
        }
        val minimumBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimumBuffer <= 0) {
            fail("audio_record_buffer_unavailable")
            return
        }
        val frameCapacity = VOICE_CAPTURE_FRAME_SAMPLES
        val byteCapacity = maxOf(minimumBuffer, frameCapacity * 2)
        val initializedRecorder = buildInitializedAudioRecord(byteCapacity)
        if (initializedRecorder == null) {
            fail("audio_record_initialization_failed")
            return
        }
        recorder = initializedRecorder
        readLoop(frameCapacity)
    }

    private fun buildInitializedAudioRecord(byteCapacity: Int): AudioRecord? {
        for (source in AUDIO_SOURCE_FALLBACKS) {
            val candidate = try {
                val audioRecordBuilder = AudioRecord.Builder()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioRecordBuilder.setContext(context)
                }
                audioRecordBuilder
                    .setAudioSource(source)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(SAMPLE_RATE_HZ)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build(),
                    )
                    .setBufferSizeInBytes(byteCapacity)
                    .build()
            } catch (_: RuntimeException) {
                null
            }
            val readyCandidate = candidate ?: continue
            if (readyCandidate.state != AudioRecord.STATE_INITIALIZED) {
                readyCandidate.release()
                continue
            }
            val started = try {
                readyCandidate.startRecording()
                readyCandidate.recordingState == AudioRecord.RECORDSTATE_RECORDING
            } catch (_: RuntimeException) {
                false
            }
            if (started) return readyCandidate
            runCatching { readyCandidate.stop() }
            readyCandidate.release()
        }
        return null
    }

    private fun readLoop(frameCapacity: Int) {
        val currentRecorder = recorder ?: run {
            fail("audio_record_missing")
            return
        }
        val buffer = ShortArray(frameCapacity)
        try {
            publishSnapshot()
            while (running.get()) {
                val read = currentRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                when {
                    read > 0 -> {
                        microphoneSilenced = clientSilenced(currentRecorder)
                        if (microphoneSilenced) {
                            publishSnapshot()
                            continue
                        }
                        if (!microphoneSignalDetected) {
                            for (index in 0 until read) {
                                if (buffer[index].toInt() != 0) {
                                    microphoneSignalDetected = true
                                    break
                                }
                            }
                        }
                        val result = pushMicrophonePcm(buffer, read)
                        when (result) {
                            null -> {
                                publishSnapshot()
                                continue
                            }
                            0 -> Unit
                            1 -> {
                                fail("audio_queue_overloaded")
                                break
                            }
                            2 -> {
                                fail("audio_queue_closed")
                                break
                            }
                            else -> {
                                fail("audio_frame_rejected")
                                break
                            }
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

    private fun clientSilenced(currentRecorder: AudioRecord): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runCatching {
                currentRecorder.activeRecordingConfiguration?.isClientSilenced == true
            }.getOrDefault(false)
        } else {
            false
        }

    /**
     * Injects one bounded frame through the exact production Rust ingress queue.
     * The Android plugin exposes this only for debuggable packages so live tests
     * can prove KWS/VAD/STT/TTS deterministically while AudioRecord is verified
     * independently above.
     */
    fun injectPcmForTest(samples: ShortArray): Int {
        val result = synchronized(sequenceGuard) {
            if (!running.get() || samples.isEmpty() || samples.size > VOICE_CAPTURE_FRAME_SAMPLES) {
                return@synchronized -1
            }
            val stats = bridge.stats()
            if (!voiceRuntimeAcceptsMicrophoneInput(stats)) return@synchronized -1

            // Admission and ownership change under the same lock as AudioRecord
            // pushes, so no live frame can splice into deterministic PCM.
            if (!acquireOrRenewLiveTestIngressLocked()) return@synchronized -1
            val pushResult = pushSequencedPcmLocked(samples, samples.size)
            // Keep ownership on rejection while the caller handles the failure;
            // completion, close, or the monotonic cap still restores live input.
            pushResult
        }
        publishSnapshot()
        return result
    }

    /**
     * A debuggable live check verifies AudioRecord signal independently, then
     * owns ingress across recoverable background re-arms until a turn completes.
     * The monotonic cap restores production capture if the check exits early.
     */
    fun armLiveTestIngressForTest(): Boolean {
        val armed = synchronized(sequenceGuard) {
            if (!running.get()) return@synchronized false
            acquireOrRenewLiveTestIngressLocked()
        }
        if (!armed) publishSnapshot()
        return armed
    }

    private fun acquireOrRenewLiveTestIngressLocked(): Boolean {
        val stats = bridge.stats()
        val completedTurns = stats.getOrElse(VOICE_STATS_COMPLETED_TURNS_INDEX) { 0L }
        when (liveTestIngressLeaseState) {
            LiveTestIngressLeaseState.AVAILABLE -> {
                liveTestIngressCompletedTurnsAtArm = completedTurns
            }
            LiveTestIngressLeaseState.OWNED -> {
                if (!liveTestOwnsIngressLocked(stats)) return false
            }
            LiveTestIngressLeaseState.RELEASED -> return false
        }
        liveTestIngressLeaseState = LiveTestIngressLeaseState.OWNED
        liveTestIngressLeaseUntilMillis =
            SystemClock.elapsedRealtime() + VOICE_LIVE_TEST_INGRESS_MAX_HOLD_MILLIS
        return true
    }

    private fun liveTestOwnsIngressLocked(stats: LongArray): Boolean {
        if (liveTestIngressLeaseState != LiveTestIngressLeaseState.OWNED) return false
        val ownsIngress = SystemClock.elapsedRealtime() < liveTestIngressLeaseUntilMillis &&
            stats.getOrElse(VOICE_STATS_COMPLETED_TURNS_INDEX) { 0L } <=
            liveTestIngressCompletedTurnsAtArm
        if (!ownsIngress) {
            liveTestIngressLeaseUntilMillis = 0L
            liveTestIngressLeaseState = LiveTestIngressLeaseState.RELEASED
        }
        return ownsIngress
    }

    private fun pushMicrophonePcm(samples: ShortArray, sampleCount: Int): Int? =
        synchronized(sequenceGuard) {
            val runtimeStats = bridge.stats()
            if (liveTestOwnsIngressLocked(runtimeStats)) return@synchronized null
            if (!voiceRuntimeAcceptsMicrophoneInput(runtimeStats)) return@synchronized null
            pushSequencedPcmLocked(samples, sampleCount)
        }

    private fun pushSequencedPcmLocked(samples: ShortArray, sampleCount: Int): Int {
        val currentSequence = sequence
        val result = bridge.pushPcm(samples, sampleCount, currentSequence)
        if (result == 0) sequence = currentSequence + 1L
        return result
    }

    private fun fail(code: String) {
        errorCode = code
        running.set(false)
        publishSnapshot()
    }

    private fun publishSnapshot(stats: LongArray = bridge.stats()) {
        onSnapshot(
            AuroraVoiceCaptureSnapshot(
                captureActive = running.get() && errorCode == null,
                microphoneSignalDetected = microphoneSignalDetected,
                microphoneSilenced = microphoneSilenced,
                sampleRateHz = SAMPLE_RATE_HZ,
                acceptedChunks = stats.getOrElse(0) { 0 },
                acceptedSamples = stats.getOrElse(1) { 0 },
                droppedChunks = stats.getOrElse(2) { 0 },
                discontinuities = stats.getOrElse(3) { 0 },
                queuedChunks = stats.getOrElse(4) { 0 },
                runtimeActive = stats.getOrElse(VOICE_STATS_RUNTIME_ACTIVE_INDEX) { 0 } != 0L,
                runtimePhase = auroraVoiceRuntimePhase(stats.getOrElse(VOICE_STATS_RUNTIME_PHASE_INDEX) { 0 }),
                sessionGeneration = stats.getOrElse(VOICE_STATS_SESSION_GENERATION_INDEX) { 0 },
                completedTurns = stats.getOrElse(VOICE_STATS_COMPLETED_TURNS_INDEX) { 0 },
                failedTurns = stats.getOrElse(VOICE_STATS_FAILED_TURNS_INDEX) { 0 },
                queuedOutputChunks = stats.getOrElse(VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX) { 0 },
                errorCode = errorCode
                    ?: auroraVoiceRuntimeError(stats.getOrElse(VOICE_STATS_LAST_ERROR_INDEX) { 0 }),
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
        synchronized(sequenceGuard) {
            liveTestIngressLeaseUntilMillis = 0L
            liveTestIngressLeaseState = LiveTestIngressLeaseState.RELEASED
        }
        if (closeBridgeOnClose) bridge.close()
        publishSnapshot()
    }
}

/**
 * Why one Aurora foreground service instance is currently alive.
 *
 * Aurora keeps exactly one runtime service and exactly one entry in the
 * notification shade. Every subsystem that needs the process kept awake
 * acquires its own reason and releases it when it is finished; the service
 * starts on the first acquisition and stops after the last release.
 */
enum class AuroraRuntimeForegroundReason(val id: String) {
    /** Microphone capture and the local speech session that consumes it. */
    VOICE("voice"),

    /** A held connection to one of the user's other devices. */
    DEVICE_LINK("device_link"),
}

/**
 * Reference-counted foreground reasons shared by voice capture and held device
 * connections.
 *
 * The ledger is process-scoped and every mutation is serialised, so several
 * subsystems may acquire and release concurrently without either losing a hold
 * or leaving the service running with nothing to do. Counts are clamped at zero
 * so an unbalanced release can never drive the ledger negative and strand the
 * service in the shade.
 */
object AuroraRuntimeForegroundLedger {
    private val guard = Any()
    private val counts = HashMap<AuroraRuntimeForegroundReason, Int>()

    /** Increments [reason] and returns the number of holds now outstanding for it. */
    fun acquire(reason: AuroraRuntimeForegroundReason): Int = synchronized(guard) {
        val next = (counts[reason] ?: 0) + 1
        counts[reason] = next
        next
    }

    /**
     * Takes the first hold on [reason] and reports whether this call took it.
     * Used by singleton reasons such as voice capture, where repeated start
     * commands describe the same one session rather than a second holder.
     */
    fun acquireOnce(reason: AuroraRuntimeForegroundReason): Boolean = synchronized(guard) {
        if ((counts[reason] ?: 0) > 0) return@synchronized false
        counts[reason] = 1
        true
    }

    /** Decrements [reason] and returns the number of holds still outstanding for it. */
    fun release(reason: AuroraRuntimeForegroundReason): Int = synchronized(guard) {
        val next = (counts[reason] ?: 0) - 1
        if (next <= 0) {
            counts.remove(reason)
            0
        } else {
            counts[reason] = next
            next
        }
    }

    /** Drops every outstanding hold on [reason] at once. */
    fun clear(reason: AuroraRuntimeForegroundReason): Unit = synchronized(guard) {
        counts.remove(reason)
        Unit
    }

    fun holds(reason: AuroraRuntimeForegroundReason): Int = synchronized(guard) { counts[reason] ?: 0 }

    fun isHeld(reason: AuroraRuntimeForegroundReason): Boolean = holds(reason) > 0

    /** The reasons with at least one outstanding hold, in declaration order. */
    fun activeReasons(): Set<AuroraRuntimeForegroundReason> = synchronized(guard) {
        AuroraRuntimeForegroundReason.values().filterTo(LinkedHashSet()) { (counts[it] ?: 0) > 0 }
    }

    fun anyHeld(): Boolean = synchronized(guard) { counts.values.any { it > 0 } }
}

class AuroraRuntimeForegroundService : Service() {
    private var capture: AuroraAudioCapture? = null
    private var playback: AuroraAudioPlayback? = null
    private var session: AuroraNativeVoiceSessionBridge? = null
    private var sessionGeneration: Long = 0L
    private val wakeLockGuard = Any()

    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private val finishHandler = Handler(Looper.getMainLooper())
    private val initializationInFlight = AtomicBoolean(false)
    private var pendingAssistantStartId: Int? = null
    private val lastNotificationText = AtomicReference<String?>(null)
    private val nativeLifecycleExecutor = ThreadPoolExecutor(
        0,
        1,
        5L,
        TimeUnit.SECONDS,
        LinkedBlockingQueue<Runnable>(),
        ThreadFactory { runnable ->
            Thread(
                null,
                runnable,
                "aurora-voice-runtime-lifecycle",
                VOICE_RUNTIME_INIT_STACK_SIZE_BYTES,
            )
        },
    )

    @Volatile
    private var initializationGeneration = 0L

    @Volatile
    private var destroyed = false

    @Volatile
    private var backgroundWakeLock: PowerManager.WakeLock? = null

    @Volatile
    private var backgroundSessionRearmEnabled = false

    @Volatile
    private var resumeBackgroundAfterFocusedTurn = false

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val durableBackgroundSession = backgroundSessionRequested()
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                if (durableBackgroundSession) {
                    return@OnAudioFocusChangeListener
                }
                captureError = "audio_focus_lost"
                releaseNativeVoiceResourcesAsync()
                captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)
                updateNotification(captureSnapshot)
                stopAfterTerminalFailure()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                if (durableBackgroundSession) {
                    return@OnAudioFocusChangeListener
                }
                captureError = when (change) {
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "audio_focus_interrupted"
                    else -> "audio_focus_ducked"
                }
                clearBackgroundSessionPersistence()
                invalidateNativeVoiceInitialization()
                releaseNativeVoiceResourcesAsync()
                captureSnapshot = emptySnapshot(captureError)
                updateNotification(captureSnapshot)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (durableBackgroundSession) return@OnAudioFocusChangeListener
                // A foreground session never restarts the microphone implicitly
                // after a call/media interruption; the user must tap Start again.
                captureError = "audio_focus_released_restart_required"
                captureSnapshot = emptySnapshot(captureError)
                updateNotification(captureSnapshot)
            }
        }
    }

    /**
     * Exposes only the live, non-sensitive service state needed by the adb
     * background harness. Android 13 omits the foreground-service type mask
     * from some ActivityManager dumps, while `dumpsys activity service` calls
     * this standard Service hook directly.
     */
    override fun dump(fd: FileDescriptor, writer: PrintWriter, args: Array<String>) {
        super.dump(fd, writer, args)
        val reasons = AuroraRuntimeForegroundLedger.activeReasons()
        writer.println("aurora.runtime.running=$running")
        writer.println("aurora.runtime.foregroundReasons=${reasons.joinToString(",") { it.id }}")
        writer.println(
            "aurora.runtime.foregroundServiceTypeMask=" +
                foregroundServiceTypes(reasons).toString(16).padStart(8, '0'),
        )
    }

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
        destroyed = false
        running = true
        audioManager = getSystemService(AudioManager::class.java)
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_SYNC_REASONS) {
            syncForegroundReasons(startId)
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_STOP_BY_USER) {
            if (backgroundSessionActive || backgroundSessionRequested()) {
                markBackgroundStoppedByUser(this)
            }
            stopAfterTerminalFailure()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_STOP) {
            stopAfterTerminalFailure()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_FINISH) {
            if (session == null) {
                stopAfterTerminalFailure(startId)
            } else {
                finishNativeSession()
            }
            return START_NOT_STICKY
        }
        val persistedBackgroundRequest = backgroundSessionRequested()
        val explicitBackgroundStart = intent?.action == ACTION_START_BACKGROUND
        if (explicitBackgroundStart && backgroundStoppedByUser(this)) {
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        val stickyRestart = intent == null && persistedBackgroundRequest
        if (intent == null && !stickyRestart) {
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        if (intent != null && !explicitBackgroundStart &&
            persistedBackgroundRequest && !backgroundSessionActive
        ) {
            // An explicit non-background start after process recreation supersedes
            // a stale sticky request (for example after an Android force-stop).
            clearBackgroundSessionPersistence()
        }
        val durableBackgroundSession = explicitBackgroundStart || stickyRestart ||
            (backgroundSessionActive && backgroundSessionRequested())
        // ACTION_START_ASSISTANT is already an explicit Android assistant
        // invocation. It must capture that utterance immediately; only an
        // explicit or restored durable listener waits for Aurora's wake word.
        val backgroundSession = durableBackgroundSession
        running = true
        AuroraRuntimeForegroundLedger.acquireOnce(AuroraRuntimeForegroundReason.VOICE)
        enterForeground("Preparing voice…")
        if (backgroundSession && !isBackgroundVoiceSessionAvailable()) {
            captureError = "background_voice_unavailable"
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            captureError = "microphone_permission_missing"
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        if (capture != null || session != null || initializationInFlight.get()) {
            if (intent?.action == ACTION_START_ASSISTANT) {
                // Android may deliver a new assistant invocation while the
                // previous focused turn is still tearing down. Preserve the
                // latest invocation and start it once the serialized native
                // lifecycle queue has released the previous session.
                if (backgroundSessionActive && backgroundSessionRequested()) {
                    resumeBackgroundAfterFocusedTurn = true
                }
                pendingAssistantStartId = startId
                invalidateNativeVoiceInitialization()
                releaseNativeVoiceResourcesAsync()
                resumePendingAssistantStart()
                return serviceRestartMode()
            }
            if (explicitBackgroundStart && !backgroundSessionActive) {
                // Reject the competing mode change without tearing down the
                // foreground session that already owns the microphone.
                return serviceRestartMode()
            }
            if (explicitBackgroundStart && !enableDurableBackgroundSession()) {
                captureError = "background_wake_lock_unavailable"
                stopAfterTerminalFailure(startId)
                return START_NOT_STICKY
            }
            return serviceRestartMode()
        }
        return startNativeVoiceSession(backgroundSession, durableBackgroundSession, startId)
    }

    private fun startNativeVoiceSession(
        backgroundSession: Boolean,
        durableBackgroundSession: Boolean,
        startId: Int,
    ): Int {
        if (!backgroundSession) clearFocusedTranscriptResult()
        backgroundSessionActive = backgroundSession
        backgroundSessionRearmEnabled = durableBackgroundSession
        if (backgroundSession) resumeBackgroundAfterFocusedTurn = false
        captureError = null
        captureSnapshot = emptySnapshot(null)
        // Each native session owns a fresh state stream. Force its first
        // snapshot through even when the previous session ended on identical
        // notification text.
        lastNotificationText.set(null)
        // Audio focus arbitrates playback; it is not authority to record from
        // the microphone. Some OEMs deny exclusive focus while AudioRecord is
        // still valid, so focus is best-effort and capture proves availability.
        requestAudioFocus(durableBackgroundSession)
        if (durableBackgroundSession && !enableDurableBackgroundSession()) {
            captureError = "background_wake_lock_unavailable"
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        beginNativeVoiceInitialization(backgroundSession, startId)
        return serviceRestartMode()
    }

    private fun resumePendingAssistantStart() {
        val startId = pendingAssistantStartId ?: return
        if (destroyed) {
            pendingAssistantStartId = null
            return
        }
        if (capture != null || session != null || initializationInFlight.get()) return
        pendingAssistantStartId = null
        startNativeVoiceSession(
            backgroundSession = false,
            durableBackgroundSession = false,
            startId = startId,
        )
    }

    private fun isBackgroundVoiceSessionAvailable(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            checkSelfPermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        // A denied notification permission degrades the shade entry and is
        // reported as such; it never blocks or ends a session the user asked
        // for, so readiness does not depend on canPostNotifications().
        notificationsSuppressed = !canPostNotifications()
        val catalog = runCatching { readCatalogEntries() }.getOrElse { emptyList() }
        val installedPackIds = recordedInstalledPackIds()
        val referenceSelectionReady = ttsReferenceSelection() != null
        return isActivePackReady(AuroraSpeechPackTask.STT, catalog, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.TTS, catalog, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.VAD, catalog, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.KWS, catalog, installedPackIds, referenceSelectionReady) &&
            wakePhraseSelection() != null
    }

    private fun hasPostNotificationsPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun canPostNotifications(): Boolean = hasPostNotificationsPermission() && NotificationManagerCompat.from(this).areNotificationsEnabled()

    private fun getActivePackId(task: AuroraSpeechPackTask): String? =
        getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE)
            .getString(auroraSpeechPackActiveKey(task), null)

    /**
     * Cheap service preflight based on the completed-install record. The native
     * session constructor remains authoritative and verifies bindings and hashes
     * before any selected model is used.
     */
    private fun isActivePackReady(
        task: AuroraSpeechPackTask,
        catalog: List<VoicePackCatalogEntry>,
        installedPackIds: Set<String>,
        referenceSelectionReady: Boolean,
    ): Boolean {
        val active = getActivePackId(task) ?: return false
        val entry = catalog.firstOrNull { it.packId == active } ?: return false
        return inferAuroraSpeechPackTask(entry.tasks) == task &&
            isPackMetadataRuntimeCompatible(entry) &&
            entry.packId in installedPackIds &&
            (task != AuroraSpeechPackTask.TTS ||
                !auroraTtsReferenceRequired(
                    task,
                    entry.modelFamily,
                    entry.requiresReferenceAudio,
                    entry.referenceAudioMode,
                ) ||
                referenceSelectionReady)
    }

    private fun recordedInstalledPackIds(): Set<String> = runCatching {
        AuroraNativeSpeechPackBridge.installedPackIds(this)
    }.getOrNull().orEmpty()

    private fun readCatalogEntries(): List<VoicePackCatalogEntry> {
        val raw = readCatalogRaw()
        val parsed = runCatching { org.json.JSONArray(raw) }.getOrElse { org.json.JSONArray() }
        val entries = ArrayList<VoicePackCatalogEntry>(parsed.length())
        for (index in 0 until parsed.length()) {
            val item = parsed.optJSONObject(index) ?: continue
            val packId = item.optString("packId", "").trim()
            val sizeBytes = item.optLong("sizeBytes", -1L)
            val tasks = readJsonStringList(item, "tasks")
            val supportedOperatingSystems = readJsonStringList(item, "supportedOperatingSystems")
            val supportedAbis = readJsonStringList(item, "supportedAbis")
            if (!voicePackCatalogIdRegex.matches(packId)) continue
            if (sizeBytes !in VOICE_PACK_MIN_BYTES..AURORA_SPEECH_PACK_MAX_ARCHIVE_BYTES) continue
            if (tasks.isEmpty() || supportedOperatingSystems.isEmpty() || supportedAbis.isEmpty()) continue
            val uri = item.optString("uri", "").trim()
            if (!isValidVoicePackUri(uri)) continue
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
                    modelFamily = item.optString("modelFamily", item.optString("model_family", "")).trim().lowercase(),
                    requiresReferenceAudio = item.optBoolean(
                        "requiresReferenceAudio",
                        item.optBoolean("referenceAudioRequired", item.optBoolean("requiresReference", false)),
                    ),
                    referenceAudioMode = auroraVoicePackReferenceAudioMode(item),
                ),
            )
        }
        return entries
    }

    private fun readCatalogRaw(): String {
        val stored = getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE)
            .getString(VOICE_PACK_CATALOG_KEY, null)
            ?.trim()
        if (!stored.isNullOrBlank() && stored != "[]") return stored
        return runCatching { AuroraNativeSpeechPackBridge.embeddedCatalogJson() }.getOrDefault("[]")
    }

    private fun isPackMetadataRuntimeCompatible(entry: VoicePackCatalogEntry): Boolean {
        if (inferAuroraSpeechPackTask(entry.tasks) == null) return false
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

    private fun isValidVoicePackUri(value: String): Boolean = runCatching {
        val uri = URI(value.trim())
        uri.scheme?.lowercase() == "https" &&
            !uri.host.isNullOrBlank() &&
            uri.userInfo == null &&
            uri.fragment == null
    }.getOrDefault(false)

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

    private fun activeRuntimeProfileSelection(): JSONObject? {
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
        return profile
            .optJSONObject("localNode")
            ?.optJSONObject("localSpeechSelection")
            ?: profile.optJSONObject("localSpeechSelection")
    }

    private fun ttsReferenceSelection(): AuroraTtsReferenceSelection? {
        val prefs = getSharedPreferences(AURORA_TTS_REFERENCE_PREFS, Context.MODE_PRIVATE)
        val stored = auroraTtsReferenceSelectionOrNull(
            prefs.getString(AURORA_TTS_REFERENCE_ID_KEY, null)?.trim().orEmpty(),
            prefs.getString(AURORA_TTS_REFERENCE_AUDIO_URI_KEY, null)?.trim().orEmpty(),
            prefs.getString(AURORA_TTS_REFERENCE_TEXT_KEY, null)?.trim().orEmpty(),
            prefs.getString(AURORA_TTS_REFERENCE_REVISION_KEY, null)?.trim().orEmpty(),
            prefs.getInt(AURORA_TTS_REFERENCE_SAMPLE_RATE_HZ_KEY, 0),
            parseReferenceSamples(prefs.getString(AURORA_TTS_REFERENCE_SAMPLES_KEY, "[]")),
        )
        if (stored != null) return stored
        val reference = activeRuntimeProfileSelection()
            ?.let { selection ->
                selection.optJSONObject("ttsReference")
                    ?: selection.optJSONObject("referenceVoice")
                    ?: selection.optJSONObject("voiceSample")
            }
            ?: return null
        return auroraTtsReferenceSelectionOrNull(
            reference.optString("id", reference.optString("referenceId", reference.optString("sampleId", ""))).trim(),
            reference.optString("audioUri", reference.optString("uri", "")).trim(),
            reference.optString("text", reference.optString("referenceText", "")).trim(),
            reference.optString("revision", reference.optString("sampleRevision", "")).trim(),
            reference.optInt("sampleRateHz", reference.optInt("sample_rate_hz", 0)),
            parseReferenceSamples(reference.optJSONArray("samples") ?: reference.optJSONArray("referenceSamples")),
        )
    }

    private fun parseReferenceSamples(raw: String?): FloatArray =
        parseReferenceSamples(runCatching { org.json.JSONArray(raw ?: "[]") }.getOrNull())

    private fun parseReferenceSamples(array: org.json.JSONArray?): FloatArray {
        if (array == null || array.length() == 0) return FloatArray(0)
        val samples = FloatArray(array.length())
        for (index in 0 until array.length()) {
            val value = array.optDouble(index, Double.NaN)
            if (!value.isFinite() || value < -1.0 || value > 1.0) return FloatArray(0)
            samples[index] = value.toFloat()
        }
        return samples
    }

    private fun beginNativeVoiceInitialization(backgroundSession: Boolean, startId: Int) {
        if (!initializationInFlight.compareAndSet(false, true)) return
        val generation = ++initializationGeneration
        val initialization = Runnable {
            val nativeSession = runCatching {
                createNativeVoiceSession(backgroundSession)
            }.getOrNull()
            if (destroyed || generation != initializationGeneration) {
                closeNativeResources(null, null, nativeSession, 0L)
                completeNativeVoiceInitialization()
                return@Runnable
            }
            val startedGeneration = nativeSession?.let {
                runCatching {
                    if (backgroundSession) it.startBackground() else it.start()
                }.getOrDefault(0L)
            } ?: 0L
            val sessionToAttach = nativeSession?.takeIf { startedGeneration != 0L }
            if (nativeSession != null && sessionToAttach == null) {
                closeNativeResources(null, null, nativeSession, 0L)
            }
            val posted = finishHandler.post {
                attachNativeVoiceSession(sessionToAttach, startedGeneration, startId, generation)
            }
            if (!posted) {
                closeNativeResources(null, null, sessionToAttach, startedGeneration)
                completeNativeVoiceInitialization()
            }
        }
        try {
            nativeLifecycleExecutor.execute(initialization)
        } catch (_: RejectedExecutionException) {
            // Native construction can block and must never fall back to Android's main thread.
            initializationInFlight.set(false)
            captureError = "voice_runtime_unavailable"
            stopAfterTerminalFailure(startId)
        }
    }

    private fun createNativeVoiceSession(backgroundSession: Boolean): AuroraNativeVoiceSessionBridge? {
        val nativeConfig = AuroraVoiceNativeConfigStore.load(this) ?: return null
        val sttModelId = getActivePackId(AuroraSpeechPackTask.STT)
        val ttsVoiceId = getActivePackId(AuroraSpeechPackTask.TTS)
        val vadModelId = getActivePackId(AuroraSpeechPackTask.VAD)
        val kwsModelId = getActivePackId(AuroraSpeechPackTask.KWS)
        val wakePhrase = wakePhraseSelection()
        val ttsReference = ttsReferenceSelection()
        val catalog = runCatching { readCatalogEntries() }.getOrElse { emptyList() }
        val installedPackIds = recordedInstalledPackIds()
        val referenceSelectionReady = ttsReference != null
        val sttReady = isActivePackReady(
            AuroraSpeechPackTask.STT,
            catalog,
            installedPackIds,
            referenceSelectionReady,
        )
        val ttsReady = isActivePackReady(
            AuroraSpeechPackTask.TTS,
            catalog,
            installedPackIds,
            referenceSelectionReady,
        )
        val vadReady = isActivePackReady(
            AuroraSpeechPackTask.VAD,
            catalog,
            installedPackIds,
            referenceSelectionReady,
        )
        val kwsReady = isActivePackReady(
            AuroraSpeechPackTask.KWS,
            catalog,
            installedPackIds,
            referenceSelectionReady,
        )
        val backgroundPacksReady = vadReady && kwsReady && wakePhrase != null
        if (sttModelId != null && ttsVoiceId != null && sttReady && ttsReady &&
            (!backgroundSession || backgroundPacksReady)
        ) {
            return AuroraNativeVoiceSessionBridge(
                nativeConfig.gateway,
                nativeConfig.bearer,
                nativeConfig.remoteAudioConsent,
                nativeConfig.assistantRouteMode,
                nativeConfig.preferredStablePeerId,
                auroraSpeechPackStoreRoot(this).path,
                sttModelId,
                ttsVoiceId,
                vadModelId?.takeIf { backgroundPacksReady },
                kwsModelId?.takeIf { backgroundPacksReady },
                wakePhrase?.id?.takeIf { backgroundPacksReady },
                wakePhrase?.text?.takeIf { backgroundPacksReady },
                wakePhrase?.revision?.takeIf { backgroundPacksReady },
                ttsReference,
            )
        }
        return null
    }

    private fun attachNativeVoiceSession(
        nativeSession: AuroraNativeVoiceSessionBridge?,
        startedGeneration: Long,
        startId: Int,
        generation: Long,
    ) {
        if (destroyed || generation != initializationGeneration) {
            closeOrphanNativeSessionAsync(nativeSession, startedGeneration)
            completeNativeVoiceInitialization()
            return
        }
        completeNativeVoiceInitialization()
        if (nativeSession == null) {
            captureError = "voice_runtime_unavailable"
            stopAfterTerminalFailure(startId)
            return
        }
        if (startedGeneration == 0L) {
            closeOrphanNativeSessionAsync(nativeSession, 0L)
            captureError = "voice_runtime_unavailable"
            stopAfterTerminalFailure(startId)
            return
        }
        session = nativeSession
        sessionGeneration = startedGeneration
        captureError = null
        playback = AuroraAudioPlayback(nativeSession, closeBridgeOnClose = false).also { it.start() }
        lateinit var audioCapture: AuroraAudioCapture
        synchronized(liveTestIngressArmGuard) {
            val initiallyArmed = pendingLiveTestIngressArm
            pendingLiveTestIngressArm = false
            audioCapture = AuroraAudioCapture(this, nativeSession, captureCallback@{ snapshot ->
                if (destroyed || capture !== audioCapture || session !== nativeSession) return@captureCallback
                captureSnapshot = snapshot
                updateNotification(snapshot)
                if (!snapshot.captureActive && snapshot.errorCode != null && !destroyed) {
                    captureError = snapshot.errorCode
                    stopAfterTerminalFailure()
                }
            }, closeBridgeOnClose = false, liveTestIngressInitiallyArmed = initiallyArmed)
            capture = audioCapture
        }
        if (!audioCapture.start()) {
            stopAfterTerminalFailure(startId)
        } else if (backgroundSessionActive) {
            awaitFinishedSession()
        }
    }

    private fun invalidateNativeVoiceInitialization() {
        initializationGeneration += 1L
    }

    private fun completeNativeVoiceInitialization() {
        initializationInFlight.set(false)
        if (Looper.myLooper() == Looper.getMainLooper()) {
            resumePendingAssistantStart()
        } else {
            finishHandler.post { resumePendingAssistantStart() }
        }
    }

    override fun onDestroy() {
        destroyed = true
        pendingAssistantStartId = null
        if (activeInstance === this) activeInstance = null
        AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.VOICE)
        releaseBackgroundWakeLock()
        backgroundSessionActive = false
        backgroundSessionRearmEnabled = false
        resumeBackgroundAfterFocusedTurn = false
        invalidateNativeVoiceInitialization()
        running = false
        finishHandler.removeCallbacksAndMessages(null)
        releaseNativeVoiceResourcesAsync()
        abandonAudioFocus()
        audioFocusRequest = null
        audioManager = null
        captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // A durable hands-free session outlives the launcher task and retains
        // only the restart intent Android needs for START_STICKY recreation.
        // Foreground push-to-talk and assistant invocations remain non-sticky.
        if (!backgroundSessionRequested()) {
            stopAfterTerminalFailure()
            return
        }
        super.onTaskRemoved(rootIntent)
    }

    private fun requestAudioFocus(durableBackgroundSession: Boolean): Boolean {
        val manager = audioManager ?: return false
        val focusGain = if (durableBackgroundSession) {
            AudioManager.AUDIOFOCUS_GAIN
        } else {
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(focusGain)
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
            focusGain,
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

    private fun releaseNativeVoiceResourcesAsync() {
        backgroundSessionActive = false
        backgroundSessionRearmEnabled = false
        val captureToClose = capture
        val playbackToClose = playback
        val nativeSession = session
        val generationToCancel = sessionGeneration
        capture = null
        playback = null
        session = null
        sessionGeneration = 0L
        captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)
        abandonAudioFocus()
        audioFocusRequest = null
        if (captureToClose == null && playbackToClose == null && nativeSession == null) return
        try {
            nativeLifecycleExecutor.execute {
                closeNativeResources(captureToClose, playbackToClose, nativeSession, generationToCancel)
            }
        } catch (_: RejectedExecutionException) {
            // Teardown may block in AudioRecord/JNI, so failing visibly is safer than a main-thread close.
            captureError = "voice_runtime_shutdown_failed"
        }
    }

    private fun closeOrphanNativeSessionAsync(
        nativeSession: AuroraNativeVoiceSessionBridge?,
        generationToCancel: Long,
    ) {
        if (nativeSession == null) return
        try {
            nativeLifecycleExecutor.execute {
                closeNativeResources(null, null, nativeSession, generationToCancel)
            }
        } catch (_: RejectedExecutionException) {
            // The service reports the leak risk; it does not block the main thread as a recovery path.
            captureError = "voice_runtime_shutdown_failed"
        }
    }

    private fun closeNativeResources(
        captureToClose: AuroraAudioCapture?,
        playbackToClose: AuroraAudioPlayback?,
        nativeSession: AuroraNativeVoiceSessionBridge?,
        generationToCancel: Long,
    ) {
        var closeFailed = runCatching { captureToClose?.close() }.isFailure
        if (nativeSession != null && generationToCancel != 0L) {
            closeFailed = runCatching { nativeSession.cancel(generationToCancel) }
                .fold(onSuccess = { it != 0 }, onFailure = { true }) || closeFailed
        }
        closeFailed = runCatching { playbackToClose?.close() }.isFailure || closeFailed
        closeFailed = runCatching { nativeSession?.close() }.isFailure || closeFailed
        if (closeFailed) captureError = "voice_runtime_shutdown_failed"
    }

    private fun finishNativeSession() {
        val nativeSession = session ?: return
        if (!resumeBackgroundAfterFocusedTurn) {
            clearBackgroundSessionPersistence()
        }
        backgroundSessionActive = false
        backgroundSessionRearmEnabled = false
        val captureToClose = capture
        val generationToFinish = sessionGeneration
        capture = null
        sessionGeneration = 0L
        captureSnapshot = captureSnapshot.copy(
            captureActive = false,
            runtimeActive = true,
            runtimePhase = "processing",
            sessionGeneration = generationToFinish,
            errorCode = null,
        )
        updateNotification(captureSnapshot)
        try {
            nativeLifecycleExecutor.execute {
                val finishFailed = generationToFinish == 0L || runCatching {
                    nativeSession.finish(generationToFinish)
                }.fold(onSuccess = { it != 0 }, onFailure = { true })
                val captureCloseFailed = runCatching { captureToClose?.close() }.isFailure
                finishHandler.post {
                    if (session !== nativeSession) {
                        resumePendingAssistantStart()
                        return@post
                    }
                    if (captureCloseFailed || finishFailed) {
                        captureError = "voice_runtime_shutdown_failed"
                    }
                    if (finishFailed) stopSelf() else awaitFinishedSession(nativeSession)
                }
            }
        } catch (_: RejectedExecutionException) {
            // Finish can enter native inference and must never run on Android's main thread.
            captureError = "voice_runtime_shutdown_failed"
            stopSelf()
        }
    }

    private fun awaitFinishedSession() {
        val nativeSession = session ?: run {
            stopAfterTerminalFailure()
            return
        }
        awaitFinishedSession(nativeSession)
    }

    private fun awaitFinishedSession(nativeSession: AuroraNativeVoiceSessionBridge) {
        if (destroyed) return
        if (session !== nativeSession) {
            resumePendingAssistantStart()
            return
        }
        try {
            nativeLifecycleExecutor.execute {
                val stats = runCatching { nativeSession.stats() }.getOrNull()
                finishHandler.post { handleFinishedSessionStats(nativeSession, stats) }
            }
        } catch (_: RejectedExecutionException) {
            // JNI status reads share the teardown queue so close/free cannot race them.
            captureError = "voice_runtime_shutdown_failed"
            stopAfterTerminalFailure()
        }
    }

    private fun handleFinishedSessionStats(
        nativeSession: AuroraNativeVoiceSessionBridge,
        stats: LongArray?,
    ) {
        if (destroyed || session !== nativeSession) return
        if (stats == null) {
            captureError = "voice_runtime_shutdown_failed"
            stopAfterTerminalFailure()
            return
        }
        val active = stats.getOrElse(VOICE_STATS_RUNTIME_ACTIVE_INDEX) { 0L } != 0L
        val queuedOutput = stats.getOrElse(VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX) { 0L }
        if (active || queuedOutput > 0L) {
            finishHandler.postDelayed({ awaitFinishedSession(nativeSession) }, 100L)
            return
        }
        if (!backgroundSessionActive) {
            nativeSession.takeFocusedTranscript()
                ?.trim()
                ?.takeIf { transcript -> transcript.isNotEmpty() }
                ?.let(::storeFocusedTranscriptResult)
        } else {
            nativeSession.takeBackgroundResultJson()
                ?.trim()
                ?.takeIf { result -> result.isNotEmpty() }
                ?.let { result -> persistBackgroundTurnResultAsync(nativeSession, result) }
        }
        val errorCode = auroraVoiceRuntimeError(
            stats.getOrElse(VOICE_STATS_LAST_ERROR_INDEX) { 0L },
        )
        if (
            backgroundSessionRearmEnabled &&
            backgroundSessionActive &&
            capture != null &&
            isRecoverableBackgroundTurn(errorCode)
        ) {
            if (errorCode != null) {
                captureError = errorCode
                captureSnapshot = terminalSnapshot(captureSnapshot, stats, errorCode)
                updateNotification(captureSnapshot)
                finishHandler.postDelayed(
                    { rearmBackgroundSession(nativeSession, stats) },
                    VOICE_RECOVERABLE_ERROR_REARM_DELAY_MILLIS,
                )
            } else {
                rearmBackgroundSession(nativeSession, stats)
            }
            return
        }
        captureError = captureError ?: errorCode
        captureSnapshot = terminalSnapshot(captureSnapshot, stats, captureError)
        stopAfterTerminalFailure()
    }

    private fun persistBackgroundTurnResultAsync(
        nativeSession: AuroraNativeVoiceSessionBridge,
        resultJson: String,
    ) {
        try {
            nativeLifecycleExecutor.execute {
                val enriched = persistBackgroundTurnResult(nativeSession, resultJson)
                finishHandler.post { storeBackgroundTurnResult(enriched) }
            }
        } catch (_: RejectedExecutionException) {
            storeBackgroundTurnResult(
                markBackgroundTurnPersistence(
                    resultJson,
                    conversationId = null,
                    persistenceErrorCode = "native_voice_persistence_unavailable",
                ),
            )
        }
    }

    private fun persistBackgroundTurnResult(
        nativeSession: AuroraNativeVoiceSessionBridge,
        resultJson: String,
    ): String {
        val result = runCatching { JSONObject(resultJson) }.getOrNull()
            ?: return markBackgroundTurnPersistence(
                resultJson,
                conversationId = null,
                persistenceErrorCode = "native_voice_result_invalid",
            )
        val transcript = result.optString("transcript", "").trim()
        val scope = AuroraNativeLocalDataContext.activeScope(this)
        if (transcript.isEmpty()) {
            return markBackgroundTurnPersistence(
                resultJson,
                conversationId = null,
                persistenceErrorCode = "native_voice_result_invalid",
            )
        }
        if (scope == null) {
            return markBackgroundTurnPersistence(
                resultJson,
                conversationId = null,
                persistenceErrorCode = "native_voice_persistence_scope_unavailable",
            )
        }
        val assistantText = if (result.isNull("assistantText")) {
            null
        } else {
            result.optString("assistantText", "").trim().takeIf { it.isNotEmpty() }
        }
        val createdAtMs = System.currentTimeMillis().coerceAtLeast(0L)
        val userMessageId = AuroraNativeLocalDataContext.newMessageId("user")
        val assistantMessageId = assistantText?.let {
            AuroraNativeLocalDataContext.newMessageId("assistant")
        }
        val persistedJson = try {
            val userEnvelope = AuroraLocalDataEnvelopeCrypto.encryptMessageText(
                this,
                scope,
                userMessageId,
                transcript,
            )
            val assistantEnvelope = assistantText?.let { text ->
                AuroraLocalDataEnvelopeCrypto.encryptMessageText(
                    this,
                    scope,
                    requireNotNull(assistantMessageId),
                    text,
                )
            }
            nativeSession.persistBackgroundTurn(
                appConfigDir = applicationInfo.dataDir,
                scope = scope,
                newConversationId = AuroraNativeLocalDataContext.newConversationId(),
                userMessageId = userMessageId,
                userContentEnvelopeJson = userEnvelope.toString(),
                assistantMessageId = assistantMessageId,
                assistantContentEnvelopeJson = assistantEnvelope?.toString(),
                createdAtMs = createdAtMs,
                completedAtMs = System.currentTimeMillis().coerceAtLeast(createdAtMs),
            )
        } catch (_: Exception) {
            return markBackgroundTurnPersistence(
                resultJson,
                conversationId = null,
                persistenceErrorCode = "native_voice_persistence_failed",
            )
        }
        val persisted = persistedJson?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (persisted?.optBoolean("ok", false) != true) {
            return markBackgroundTurnPersistence(
                resultJson,
                conversationId = null,
                persistenceErrorCode = persisted
                    ?.optString("errorCode", "native_voice_persistence_failed")
                    ?.takeIf { it.isNotEmpty() }
                    ?: "native_voice_persistence_failed",
            )
        }
        val conversationId = persisted.optString("conversationId", "").takeIf { it.isNotEmpty() }
            ?: return markBackgroundTurnPersistence(
                resultJson,
                conversationId = null,
                persistenceErrorCode = "native_voice_persistence_failed",
            )
        return markBackgroundTurnPersistence(
            resultJson,
            conversationId = conversationId,
            persistenceErrorCode = null,
        )
    }

    private fun markBackgroundTurnPersistence(
        resultJson: String,
        conversationId: String?,
        persistenceErrorCode: String?,
    ): String {
        val result = runCatching { JSONObject(resultJson) }.getOrElse { JSONObject() }
        result.put("persisted", conversationId != null)
        result.put(
            "conversationId",
            conversationId ?: JSONObject.NULL,
        )
        result.put(
            "persistenceErrorCode",
            persistenceErrorCode ?: JSONObject.NULL,
        )
        return result.toString()
    }

    private fun rearmBackgroundSession(
        nativeSession: AuroraNativeVoiceSessionBridge,
        stats: LongArray,
    ) {
        sessionGeneration = 0L
        captureSnapshot = captureSnapshot.copy(
            runtimeActive = false,
            runtimePhase = auroraVoiceRuntimePhase(
                stats.getOrElse(VOICE_STATS_RUNTIME_PHASE_INDEX) { 0L },
            ),
            completedTurns = stats.getOrElse(VOICE_STATS_COMPLETED_TURNS_INDEX) {
                captureSnapshot.completedTurns
            },
            failedTurns = stats.getOrElse(VOICE_STATS_FAILED_TURNS_INDEX) {
                captureSnapshot.failedTurns
            },
            queuedOutputChunks = stats.getOrElse(VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX) { 0L },
            errorCode = auroraVoiceRuntimeError(
                stats.getOrElse(VOICE_STATS_LAST_ERROR_INDEX) { 0L },
            ),
        )
        updateNotification(captureSnapshot)
        try {
            nativeLifecycleExecutor.execute {
                val restartedGeneration = if (
                    !destroyed &&
                    backgroundSessionRearmEnabled &&
                    backgroundSessionActive &&
                    session === nativeSession
                ) {
                    runCatching {
                        if (nativeSession.clearIngress()) nativeSession.startBackground() else 0L
                    }.getOrDefault(0L)
                } else {
                    0L
                }
                val posted = finishHandler.post {
                    handleBackgroundSessionRestart(nativeSession, restartedGeneration)
                }
                if (!posted && restartedGeneration != 0L) {
                    runCatching { nativeSession.cancel(restartedGeneration) }
                    captureError = "voice_runtime_shutdown_failed"
                    stopAfterTerminalFailure()
                }
            }
        } catch (_: RejectedExecutionException) {
            captureError = "voice_runtime_unavailable"
            stopAfterTerminalFailure()
        }
    }

    private fun handleBackgroundSessionRestart(
        nativeSession: AuroraNativeVoiceSessionBridge,
        restartedGeneration: Long,
    ) {
        if (
            destroyed ||
            !backgroundSessionRearmEnabled ||
            !backgroundSessionActive ||
            session !== nativeSession
        ) return
        if (restartedGeneration == 0L) {
            captureError = "voice_runtime_unavailable"
            captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)
            stopAfterTerminalFailure()
            return
        }
        sessionGeneration = restartedGeneration
        captureError = null
        captureSnapshot = captureSnapshot.copy(
            runtimeActive = true,
            // nativeStartBackground returns after allocating the generation;
            // AudioCapture publishes "starting" only when native stats expose
            // the same PCM-acceptance gate used by injectPcmForTest.
            runtimePhase = "idle",
            sessionGeneration = restartedGeneration,
            errorCode = null,
        )
        updateNotification(captureSnapshot)
        awaitFinishedSession()
    }

    private fun terminalSnapshot(
        current: AuroraVoiceCaptureSnapshot,
        stats: LongArray?,
        errorCode: String?,
    ) = current.copy(
        captureActive = false,
        acceptedChunks = stats?.getOrElse(0) { current.acceptedChunks } ?: current.acceptedChunks,
        acceptedSamples = stats?.getOrElse(1) { current.acceptedSamples } ?: current.acceptedSamples,
        droppedChunks = stats?.getOrElse(2) { current.droppedChunks } ?: current.droppedChunks,
        discontinuities = stats?.getOrElse(3) { current.discontinuities } ?: current.discontinuities,
        queuedChunks = stats?.getOrElse(4) { 0L } ?: 0L,
        runtimeActive = false,
        runtimePhase = stats?.let {
            auroraVoiceRuntimePhase(it.getOrElse(VOICE_STATS_RUNTIME_PHASE_INDEX) { 0L })
        } ?: if (errorCode != null) "faulted" else "idle",
        sessionGeneration = stats?.getOrElse(VOICE_STATS_SESSION_GENERATION_INDEX) {
            0L
        } ?: 0L,
        completedTurns = stats?.getOrElse(VOICE_STATS_COMPLETED_TURNS_INDEX) {
            current.completedTurns
        } ?: current.completedTurns,
        failedTurns = stats?.getOrElse(VOICE_STATS_FAILED_TURNS_INDEX) {
            current.failedTurns
        } ?: current.failedTurns,
        queuedOutputChunks = stats?.getOrElse(VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX) {
            0L
        } ?: 0L,
        errorCode = errorCode ?: stats?.let {
            auroraVoiceRuntimeError(it.getOrElse(VOICE_STATS_LAST_ERROR_INDEX) { 0 })
        } ?: current.errorCode,
    )

    private fun updateNotification(snapshot: AuroraVoiceCaptureSnapshot) {
        if (!running) return
        notificationsSuppressed = !canPostNotifications()
        // The one Aurora entry cannot reach the shade when the user has turned
        // notifications off. The session keeps running and the degraded state
        // is reported through the status surface instead.
        if (notificationsSuppressed) {
            lastNotificationText.set(null)
            return
        }
        val text = notificationTextFor(AuroraRuntimeForegroundLedger.activeReasons(), snapshot)
        if (lastNotificationText.get() == text) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(AURORA_RUNTIME_NOTIFICATION_ID, foregroundNotification(text))
        lastNotificationText.set(text)
    }

    /**
     * The single Aurora notification describes the whole set of reasons the
     * service is alive, so voice and a held device connection never produce two
     * entries in the shade.
     */
    private fun notificationTextFor(
        reasons: Set<AuroraRuntimeForegroundReason>,
        snapshot: AuroraVoiceCaptureSnapshot,
    ): String {
        val voice = AuroraRuntimeForegroundReason.VOICE in reasons
        val deviceLink = AuroraRuntimeForegroundReason.DEVICE_LINK in reasons
        val voiceText = when {
            snapshot.errorCode != null || snapshot.runtimePhase == "faulted" ->
                notificationErrorTextFor(snapshot.errorCode)
            snapshot.microphoneSilenced ->
                "Another app is using the microphone. Aurora will resume automatically."
            snapshot.runtimePhase == "waiting-for-wake" -> {
                val wakePhrase = notificationWakePhrase()
                "Say “$wakePhrase” to begin. Tap Stop to end."
            }
            snapshot.runtimePhase == "listening" && backgroundSessionActive ->
                "Aurora heard you. Keep speaking."
            snapshot.runtimePhase == "listening" -> "Listening. Tap again when finished."
            snapshot.runtimePhase == "transcribing" && backgroundSessionActive ->
                "Understanding what you said… Tap Stop to end."
            snapshot.runtimePhase == "transcribing" -> "Understanding what you said…"
            snapshot.runtimePhase == "waiting-for-response" && backgroundSessionActive ->
                "Aurora is thinking… Tap Stop to end."
            snapshot.runtimePhase == "waiting-for-response" -> "Aurora is thinking…"
            snapshot.runtimePhase == "preparing-speech" && backgroundSessionActive ->
                "Preparing the answer to speak… Tap Stop to end."
            snapshot.runtimePhase == "preparing-speech" -> "Preparing the answer to speak…"
            snapshot.runtimePhase == "processing" && backgroundSessionActive ->
                "Working on your request. Tap Stop to end."
            snapshot.runtimePhase == "processing" -> "Aurora is working…"
            snapshot.runtimePhase == "speaking" -> "Aurora is speaking. Tap Stop to end."
            snapshot.runtimePhase == "starting" || !snapshot.captureActive -> "Preparing voice…"
            else -> "Microphone is active. Tap Stop to end."
        }
        return when {
            voice && deviceLink -> "$voiceText Other devices stay connected."
            voice -> voiceText
            deviceLink -> "Your other devices stay connected."
            else -> "Aurora is finishing up."
        }
    }

    private fun notificationErrorTextFor(errorCode: String?): String = when (errorCode) {
        "assistant_unavailable" -> "I couldn’t reach your computer. I’ll keep listening."
        "wake_not_detected" -> "I didn’t catch the wake phrase. Listening again."
        "speech_not_detected" -> "I didn’t hear a request. Listening again."
        "speech_timeout" -> "I stopped listening after the pause. Listening again."
        else -> "Voice needs attention. Open Aurora to try again."
    }

    private fun notificationWakePhrase(): String {
        val phrase = wakePhraseSelection()?.text?.trim().orEmpty()
        return if (
            phrase.length in 1..48 && phrase.none { character -> character.isISOControl() }
        ) {
            phrase
        } else {
            "Aurora"
        }
    }

    /**
     * Enters or refreshes the foreground state with the service types the
     * current reasons actually justify. The microphone type is claimed only
     * once its permission is granted, so the connected-device type alone keeps
     * the service legal while voice is still being checked or torn down.
     */
    private fun enterForeground(text: String) {
        lastNotificationText.set(text)
        val notification = foregroundNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val requestedTypes = foregroundServiceTypes(AuroraRuntimeForegroundLedger.activeReasons())
            try {
                startForeground(AURORA_RUNTIME_NOTIFICATION_ID, notification, requestedTypes)
            } catch (error: SecurityException) {
                // A device-link foreground-service policy mismatch must never
                // crash voice capture or the app. Drop only that persistence
                // reason and retain a legal microphone foreground service when
                // one is active. The manifest/preflight gate normally prevents
                // this branch; it is a final guard for vendor policy drift.
                AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.DEVICE_LINK)
                val microphoneType = if (
                    AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                ) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                } else {
                    0
                }
                if (microphoneType == 0) {
                    running = false
                    stopSelf()
                    return
                }
                startForeground(AURORA_RUNTIME_NOTIFICATION_ID, notification, microphoneType)
            }
        } else {
            startForeground(AURORA_RUNTIME_NOTIFICATION_ID, notification)
        }
        notificationsSuppressed = !canPostNotifications()
    }

    private fun foregroundServiceTypes(reasons: Set<AuroraRuntimeForegroundReason>): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        var types = 0
        if (AuroraRuntimeForegroundReason.VOICE in reasons &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        ) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (AuroraRuntimeForegroundReason.DEVICE_LINK in reasons) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        }
        if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        return types
    }

    /**
     * Brings the single notification and the declared service types back in
     * line with the reason ledger, and releases the service once nothing holds
     * it any more.
     */
    private fun syncForegroundReasons(startId: Int? = null) {
        val reasons = AuroraRuntimeForegroundLedger.activeReasons()
        if (reasons.isNotEmpty()) {
            running = true
            enterForeground(notificationTextFor(reasons, captureSnapshot))
            return
        }
        if (capture != null || session != null || initializationInFlight.get()) return
        // A start command must reach the foreground before the service may stop,
        // even when the reason that started it was released first.
        runCatching { enterForeground(notificationTextFor(reasons, captureSnapshot)) }
        stopForegroundAndRemoveNotification()
        if (startId == null) stopSelf() else stopSelfResult(startId)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            AURORA_RUNTIME_CHANNEL_ID,
            "Aurora",
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = "Shows when Aurora is listening or keeping your other devices connected."
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun foregroundNotification(text: String): Notification {
        val stopIntent = Intent(this, AuroraRuntimeForegroundService::class.java).apply {
            action = ACTION_STOP_BY_USER
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            4204,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, AURORA_RUNTIME_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setSmallIcon(R.drawable.ic_aurora_notification)
            .setContentTitle("Aurora")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(0xFF1F6F68.toInt())
        packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            builder.setContentIntent(
                PendingIntent.getActivity(
                    this,
                    4205,
                    launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
        }
        // Stop ends the microphone session, so it is offered only while one is
        // the reason Aurora is running.
        if (AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE)) {
            builder.addAction(Notification.Action.Builder(null, "Stop", stopPendingIntent).build())
        }
        return builder.build()
    }

    private fun backgroundSessionRequested(): Boolean =
        getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
            .getBoolean(VOICE_BACKGROUND_SESSION_REQUESTED_KEY, false)

    private fun persistBackgroundSessionRequested(requested: Boolean): Boolean {
        val prefs = getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
        return prefs.edit()
            .apply {
                if (requested) {
                    putBoolean(VOICE_BACKGROUND_SESSION_REQUESTED_KEY, true)
                } else {
                    remove(VOICE_BACKGROUND_SESSION_REQUESTED_KEY)
                }
            }
            .commit()
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireBackgroundWakeLock(): Boolean {
        synchronized(wakeLockGuard) {
            if (backgroundWakeLock?.isHeld == true) return true
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
            val wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "$packageName:aurora_voice_background",
            )
            wakeLock.setReferenceCounted(false)
            if (runCatching { wakeLock.acquire() }.isFailure) return false
            backgroundWakeLock = wakeLock
            return true
        }
    }

    private fun releaseBackgroundWakeLock() {
        synchronized(wakeLockGuard) {
            backgroundWakeLock?.let { wakeLock ->
                if (wakeLock.isHeld) {
                    runCatching { wakeLock.release() }
                }
            }
            backgroundWakeLock = null
        }
    }

    private fun clearBackgroundSessionPersistence() {
        persistBackgroundSessionRequested(false)
        releaseBackgroundWakeLock()
    }

    private fun enableDurableBackgroundSession(): Boolean {
        if (!acquireBackgroundWakeLock()) return false
        if (persistBackgroundSessionRequested(true)) return true
        releaseBackgroundWakeLock()
        return false
    }

    private fun serviceRestartMode(): Int =
        if (backgroundSessionRequested()) START_STICKY else START_NOT_STICKY

    private fun restartDurableBackgroundAfterFocusedTurn(): Boolean {
        if (
            !resumeBackgroundAfterFocusedTurn ||
            pendingAssistantStartId != null ||
            !backgroundSessionRequested() ||
            backgroundStoppedByUser(this)
        ) {
            return false
        }
        resumeBackgroundAfterFocusedTurn = false
        backgroundSessionActive = false
        backgroundSessionRearmEnabled = false
        invalidateNativeVoiceInitialization()
        releaseNativeVoiceResourcesAsync()
        captureError = null
        captureSnapshot = emptySnapshot(null)
        updateNotification(captureSnapshot)
        return try {
            nativeLifecycleExecutor.execute {
                finishHandler.post {
                    if (
                        destroyed ||
                        !backgroundSessionRequested() ||
                        backgroundStoppedByUser(this)
                    ) {
                        stopAfterTerminalFailure()
                        return@post
                    }
                    val intent = Intent(this, AuroraRuntimeForegroundService::class.java).apply {
                        action = ACTION_START_BACKGROUND
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(intent)
                    } else {
                        startService(intent)
                    }
                }
            }
            true
        } catch (_: RejectedExecutionException) {
            captureError = "voice_runtime_shutdown_failed"
            false
        }
    }

    /**
     * Ends the voice reason for keeping the service alive. The service itself
     * only stops once nothing else holds it, so a held device connection keeps
     * the one Aurora entry in place instead of Aurora gaining a second one.
     */
    private fun stopAfterTerminalFailure(startId: Int? = null) {
        if (restartDurableBackgroundAfterFocusedTurn()) return
        pendingAssistantStartId = null
        clearBackgroundSessionPersistence()
        backgroundSessionActive = false
        backgroundSessionRearmEnabled = false
        resumeBackgroundAfterFocusedTurn = false
        invalidateNativeVoiceInitialization()
        releaseNativeVoiceResourcesAsync()
        AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.VOICE)
        val remaining = AuroraRuntimeForegroundLedger.activeReasons()
        if (remaining.isNotEmpty()) {
            lastNotificationText.set(null)
            enterForeground(notificationTextFor(remaining, captureSnapshot))
            return
        }
        stopForegroundAndRemoveNotification()
        if (startId == null) stopSelf() else stopSelfResult(startId)
    }

    private fun stopForegroundAndRemoveNotification() {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        }
        runCatching {
            getSystemService(NotificationManager::class.java).cancel(AURORA_RUNTIME_NOTIFICATION_ID)
        }
        lastNotificationText.set(null)
    }

    companion object {
        const val ACTION_STOP = "dev.aurora.tauri.nativeplugin.action.STOP_VOICE_CAPTURE"
        const val ACTION_STOP_BY_USER = "dev.aurora.tauri.nativeplugin.action.STOP_BACKGROUND_VOICE_BY_USER"
        const val ACTION_FINISH = "dev.aurora.tauri.nativeplugin.action.FINISH_VOICE_CAPTURE"
        const val ACTION_START_BACKGROUND = "dev.aurora.tauri.nativeplugin.action.START_BACKGROUND_VOICE"
        const val ACTION_START_ASSISTANT = "dev.aurora.tauri.nativeplugin.action.START_ASSISTANT_VOICE"
        const val ACTION_SYNC_REASONS = "dev.aurora.tauri.nativeplugin.action.SYNC_FOREGROUND_REASONS"

        @Volatile
        var running: Boolean = false
            private set

        /**
         * True while Aurora is running but its one shade entry cannot be shown
         * because the user turned notifications off. Sessions keep running; the
         * degraded state is surfaced to the product instead of ending them.
         */
        @Volatile
        var notificationsSuppressed: Boolean = false
            private set

        /**
         * Takes a hold on the one Aurora foreground service for a connected
         * device, starting it if this is the first reason. Every hold must be
         * matched by exactly one [releaseDeviceLink].
         */
        fun holdDeviceLink(context: Context) {
            AuroraRuntimeForegroundLedger.acquire(AuroraRuntimeForegroundReason.DEVICE_LINK)
            val intent = Intent(context, AuroraRuntimeForegroundService::class.java).apply {
                action = ACTION_SYNC_REASONS
            }
            val started = runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }.isSuccess
            if (!started) {
                AuroraRuntimeForegroundLedger.release(AuroraRuntimeForegroundReason.DEVICE_LINK)
            }
        }

        /** Drops one connected-device hold, stopping the service if it was the last reason. */
        fun releaseDeviceLink(context: Context) {
            AuroraRuntimeForegroundLedger.release(AuroraRuntimeForegroundReason.DEVICE_LINK)
            if (!running) return
            context.startService(
                Intent(context, AuroraRuntimeForegroundService::class.java).apply {
                    action = ACTION_SYNC_REASONS
                },
            )
        }

        /** The reasons currently keeping the one Aurora service alive. */
        fun activeForegroundReasonIds(): List<String> =
            AuroraRuntimeForegroundLedger.activeReasons().map { it.id }

        /** Whether a focused or durable native voice session currently holds the service. */
        fun foregroundVoiceSessionActive(): Boolean =
            AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE)

        fun backgroundStoppedByUser(context: Context): Boolean =
            context.getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
                .getBoolean(VOICE_BACKGROUND_STOPPED_BY_USER_KEY, false)

        fun clearBackgroundStoppedByUser(context: Context) {
            context.getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(VOICE_BACKGROUND_STOPPED_BY_USER_KEY)
                .apply()
        }

        private val focusedTranscriptResult = AtomicReference<String?>(null)
        private val backgroundTurnResults = ConcurrentLinkedQueue<String>()

        private fun clearFocusedTranscriptResult() {
            focusedTranscriptResult.set(null)
        }

        private fun storeFocusedTranscriptResult(transcript: String) {
            focusedTranscriptResult.set(transcript)
        }

        fun takeFocusedTranscriptResult(): String? = focusedTranscriptResult.getAndSet(null)

        private fun storeBackgroundTurnResult(resultJson: String) {
            backgroundTurnResults.add(resultJson)
            while (backgroundTurnResults.size > 8) {
                backgroundTurnResults.poll()
            }
        }

        fun takeBackgroundTurnResult(): String? = backgroundTurnResults.poll()

        private fun markBackgroundStoppedByUser(context: Context) {
            context.getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(VOICE_BACKGROUND_STOPPED_BY_USER_KEY, true)
                .apply()
        }

        @Volatile
        var captureError: String? = null
            private set

        @Volatile
        var captureSnapshot: AuroraVoiceCaptureSnapshot = emptySnapshot(null)
            private set

        @Volatile
        var backgroundSessionActive: Boolean = false
            private set

        @Volatile
        private var activeInstance: AuroraRuntimeForegroundService? = null

        private val liveTestIngressArmGuard = Any()
        private var pendingLiveTestIngressArm = false

        fun armPcmIngressForTest(): Boolean = synchronized(liveTestIngressArmGuard) {
            val activeCapture = activeInstance?.capture
            if (activeCapture != null) return@synchronized activeCapture.armLiveTestIngressForTest()
            pendingLiveTestIngressArm = true
            true
        }

        fun injectPcmForTest(samples: ShortArray): Int =
            activeInstance?.capture?.injectPcmForTest(samples) ?: -1

        fun emptySnapshot(errorCode: String?) = AuroraVoiceCaptureSnapshot(
            captureActive = false,
            microphoneSignalDetected = false,
            microphoneSilenced = false,
            sampleRateHz = SAMPLE_RATE_HZ,
            acceptedChunks = 0,
            acceptedSamples = 0,
            droppedChunks = 0,
            discontinuities = 0,
            queuedChunks = 0,
            runtimeActive = false,
            runtimePhase = "idle",
            sessionGeneration = 0,
            completedTurns = 0,
            failedTurns = 0,
            queuedOutputChunks = 0,
            errorCode = errorCode,
        )
    }
}
