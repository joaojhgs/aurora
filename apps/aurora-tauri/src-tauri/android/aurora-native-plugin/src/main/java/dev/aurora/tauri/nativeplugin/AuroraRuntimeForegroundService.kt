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
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
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
import kotlin.math.roundToInt
import org.json.JSONObject

private const val AURORA_RUNTIME_CHANNEL_ID = "aurora_voice_capture"
private const val AURORA_RUNTIME_NOTIFICATION_ID = 4203
private const val MAX_VISIBLE_NOTIFICATION_PEERS = 3
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
private const val TRANSCRIPTION_INTERVAL_MAX_MILLIS = 25_000L
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

data class AuroraNotificationPeer(
    val peerId: String,
    val displayName: String,
    val roundTripTimeMs: Double?,
)

private data class AuroraVoiceRouteProfile(
    val mode: String,
    val preferredStablePeerId: String?,
)

object AuroraVoiceNativeConfigStore {
    /** Returns the selected confirmed profile's local STT pack binding, if present. */
    fun localSttPackId(confirmedProfileDocumentJson: String): String? {
        val root = runCatching { JSONObject(confirmedProfileDocumentJson) }.getOrNull() ?: return null
        val profile = activeProfile(root) ?: return null
        return profile.optJSONObject("localNode")
            ?.optJSONObject("localSpeechSelection")
            ?.optJSONObject("stt")
            ?.optString("packId")
            ?.takeIf { it.isNotBlank() && it != "null" }
    }

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

    fun load(
        context: Context,
        confirmedProfileDocumentJson: String? = null,
    ): AuroraVoiceNativeConfig? {
        val routeProfile = activeVoiceRouteProfile(context, confirmedProfileDocumentJson)
            ?: return if (confirmedProfileDocumentJson == null) localOnlyConfig() else null
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

    private fun activeVoiceRouteProfile(
        context: Context,
        confirmedProfileDocumentJson: String? = null,
    ): AuroraVoiceRouteProfile? {
        val root = if (confirmedProfileDocumentJson != null) {
            runCatching { JSONObject(confirmedProfileDocumentJson) }.getOrNull() ?: return null
        } else {
            val raw = context.getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
                .getString(THIN_PROFILE_KEY, null)
                ?: return null
            runCatching { JSONObject(raw) }.getOrNull() ?: return null
        }
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

object AuroraNativePlaybackCountersBridge {
    fun enabled(): Boolean = nativeEnabled()

    fun recordAudioTrackPlayCall() {
        if (enabled()) nativeRecordAudioTrackPlayCall()
    }

    fun recordAudioTrackWrittenSamples(sampleCount: Int) {
        if (sampleCount > 0 && enabled()) nativeRecordAudioTrackWrittenSamples(sampleCount.toLong())
    }

    fun snapshotForLiveTest(): LongArray? = if (enabled()) nativeSnapshot() else null

    private external fun nativeEnabled(): Boolean
    private external fun nativeRecordAudioTrackPlayCall()
    private external fun nativeRecordAudioTrackWrittenSamples(sampleCount: Long)
    private external fun nativeSnapshot(): LongArray?

    init {
        System.loadLibrary("aurora_tauri_lib")
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
    speechStagesJson: String? = null,
) : AuroraPcmIngressBridge, AuroraPcmOutputBridge {
    private var handle: Long = if (packStoreRoot != null) {
        nativeCreateWithPackSelection(
            gateway,
            bearer,
            remoteAudioConsent,
            assistantRouteMode,
            preferredStablePeerId.orEmpty(),
            packStoreRoot,
            sttModelId.orEmpty(),
            ttsVoiceId.orEmpty(),
            vadModelId.orEmpty(),
            kwsModelId.orEmpty(),
            wakePhraseId.orEmpty(),
            wakePhraseText.orEmpty(),
            wakePhraseRevision.orEmpty(),
            ttsReference?.sampleRateHz ?: 0,
            ttsReference?.samples ?: FloatArray(0),
            ttsReference?.text.orEmpty(),
            ttsReference?.revision.orEmpty(),
            speechStagesJson.orEmpty(),
        )
    } else {
        nativeCreate(
            gateway,
            bearer,
            remoteAudioConsent,
            assistantRouteMode,
            preferredStablePeerId.orEmpty(),
            speechStagesJson.orEmpty(),
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
        observationToken: String,
        generation: Long,
        transcriptPlaintext: String,
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
        observationToken,
        generation,
        transcriptPlaintext,
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
        speechStagesJson: String,
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
        speechStagesJson: String,
    ): Long
    private external fun nativeStart(handle: Long): Long
    private external fun nativeStartBackground(handle: Long): Long
    private external fun nativeFinish(handle: Long, generation: Long): Int
    private external fun nativeTakeFocusedTranscript(handle: Long): String?
    private external fun nativeTakeBackgroundResult(handle: Long): String?
    private external fun nativePersistBackgroundTurn(
        appConfigDir: String,
        observationToken: String,
        generation: Long,
        transcriptPlaintext: String,
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
            AuroraNativePlaybackCountersBridge.recordAudioTrackPlayCall()
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
                AuroraNativePlaybackCountersBridge.recordAudioTrackWrittenSamples(written)
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

/** JNI bridge for the STT-only archive capture path. */
private class AuroraNativeTranscriptionSessionBridge(
    gateway: String,
    bearer: String,
    remoteAudioConsent: Boolean,
    packStoreRoot: String?,
    sttModelId: String?,
    speechStagesJson: String,
) : AuroraPcmIngressBridge {
    private var handle: Long = nativeCreate(
        gateway,
        bearer,
        remoteAudioConsent,
        packStoreRoot.orEmpty(),
        sttModelId.orEmpty(),
        speechStagesJson,
        QUEUE_CAPACITY_CHUNKS,
        MAX_CHUNK_SAMPLES,
    )

    override fun pushPcm(samples: ShortArray, sampleCount: Int, sequence: Long): Int {
        val current = handle
        return if (current == 0L || sampleCount !in 1..samples.size) -1
        else nativePushPcm(current, samples, sampleCount, sequence)
    }

    override fun stats(): LongArray = if (handle == 0L) LongArray(0) else nativeStats(handle)

    fun start(admissionToken: String, backgroundEligible: Boolean): Long =
        if (handle == 0L) 0L else nativeStart(handle, admissionToken, backgroundEligible)

    fun finish(generation: Long): Int = if (handle == 0L) -1 else nativeFinish(handle, generation)

    fun cancel(generation: Long): Int = if (handle == 0L) -1 else nativeCancel(handle, generation)

    fun takeTranscript(): String? = if (handle == 0L) null else nativeTakeTranscript(handle)

    fun appendEncrypted(
        token: String,
        generation: Long,
        segmentId: String,
        sequence: Long,
        startMs: Long,
        endMs: Long,
        envelopeJson: String,
        microphonePermissionGranted: Boolean,
    ): Int = nativeAppendEncryptedResult(
        token,
        generation,
        segmentId,
        sequence,
        startMs,
        endMs,
        envelopeJson,
        microphonePermissionGranted,
    )

    fun endCaptureInterval(token: String, generation: Long): Int =
        nativeEndCaptureInterval(token, generation)

    fun finalize(token: String, lifecycle: String, reason: String): Int =
        nativeFinalize(token, lifecycle, reason)

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
        packStoreRoot: String,
        sttModelId: String,
        speechStagesJson: String,
        ingressCapacityChunks: Int,
        maxChunkSamples: Int,
    ): Long
    private external fun nativePushPcm(handle: Long, samples: ShortArray, sampleCount: Int, sequence: Long): Int
    private external fun nativeStart(handle: Long, admissionToken: String, backgroundEligible: Boolean): Long
    private external fun nativeFinish(handle: Long, generation: Long): Int
    private external fun nativeCancel(handle: Long, generation: Long): Int
    private external fun nativeTakeTranscript(handle: Long): String?
    private external fun nativeStats(handle: Long): LongArray
    private external fun nativeAppendEncryptedResult(
        token: String,
        generation: Long,
        segmentId: String,
        sequence: Long,
        startMs: Long,
        endMs: Long,
        envelopeJson: String,
        microphonePermissionGranted: Boolean,
    ): Int
    private external fun nativeEndCaptureInterval(token: String, generation: Long): Int
    private external fun nativeFinalize(token: String, lifecycle: String, reason: String): Int
    private external fun nativeClose(handle: Long)
    private external fun nativeFree(handle: Long)

    companion object {
        init { System.loadLibrary("aurora_tauri_lib") }

        @JvmStatic
        external fun nativeAdmit(mode: String): String?

        @JvmStatic
        external fun nativeFinalizeAdmission(token: String, lifecycle: String, reason: String): Int
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
    private val onCaptureStarted: (() -> Unit)? = null,
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
        onCaptureStarted?.invoke()
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

    /** Native transcription owns the same microphone without assistant or TTS work. */
    TRANSCRIPTION("transcription"),

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
    private data class PendingTranscriptionResources(
        val token: String,
        val session: AuroraNativeTranscriptionSessionBridge,
        val generation: Long,
    )

    private var capture: AuroraAudioCapture? = null
    private var playback: AuroraAudioPlayback? = null
    private var session: AuroraNativeVoiceSessionBridge? = null
    private var transcriptionCapture: AuroraAudioCapture? = null
    private var transcriptionSession: AuroraNativeTranscriptionSessionBridge? = null
    private var transcriptionToken: String? = null
    private var transcriptionProfileId: String? = null
    private var transcriptionLocalNodeId: String? = null
    private var transcriptionSessionId: String? = null
    private var transcriptionMode: String? = null
    private var transcriptionSequence = 0L
    private var transcriptionGeneration = 0L
    @Volatile
    private var transcriptionCaptureStartedAtMs = 0L
    @Volatile
    private var transcriptionCaptureStartedElapsedMs = 0L
    private var transcriptionIntervalFinishRequested = false
    @Volatile private var transcriptionIntervalEpoch = 0L
    private var transcriptionReservationEpoch: Long? = null
    private var transcriptionPollRunnable: Runnable? = null
    private val transcriptionInitializationInFlight = AtomicBoolean(false)
    private var transcriptionState = "idle"
    private var transcriptionReason: String? = null
    private var transcriptionPolicyJson: String? = null
    private var transcriptionProfileDocumentJson: String? = null
    private var transcriptionProfileGeneration = 0L
    private var transcriptionCaptureProfileGeneration: Long? = null
    private val pendingTranscriptionResources = AtomicReference<PendingTranscriptionResources?>(null)
    @Volatile private var transcriptionArchiveFinalizedByStartFailure = false
    @Volatile private var transcriptionStopRequested: Pair<String, String>? = null
    private var transcriptionArchiveAvailable = false
    private var transcriptionSttAvailable = false
    private var sessionGeneration: Long = 0L
    private val wakeLockGuard = Any()

    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private val finishHandler = Handler(Looper.getMainLooper())
    private val initializationInFlight = AtomicBoolean(false)
    private val profileChangeDrainWaiters = mutableListOf<(Boolean) -> Unit>()
    private var profileChangeDrainInFlight = false
    private var pendingAssistantStartId: Int? = null
    @Volatile private var speechStagesJson: String? = null
    @Volatile private var confirmedProfileDocumentJson: String? = null
    @Volatile private var admittedSttPackId: String? = null
    @Volatile private var admittedTtsPackId: String? = null
    @Volatile private var admittedVadPackId: String? = null
    @Volatile private var admittedKwsPackId: String? = null
    private val lastNotificationFingerprint = AtomicReference<String?>(null)
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
        val action = intent?.action
        val restoringBackground = action == ACTION_RESTORE_BACKGROUND
        if ((action == ACTION_START_ASSISTANT || action == ACTION_START_BACKGROUND || restoringBackground) &&
            transcriptionOwnsOrReservesMicrophone()
        ) {
            // Reject before updating persisted voice configuration or taking a
            // voice lease. The active transcription/device-link owners remain
            // untouched and the status stays explicit for the caller.
            captureError = "microphone_busy"
            updateNotification(captureSnapshot)
            return START_NOT_STICKY
        }
        if (action == ACTION_SYNC_BACKGROUND_TRANSCRIPTION) {
            val policy = intent.getStringExtra(EXTRA_TRANSCRIPTION_POLICY_JSON)
            val profile = intent.getStringExtra(EXTRA_TRANSCRIPTION_PROFILE_DOCUMENT_JSON)
            val generation = intent.getLongExtra(EXTRA_TRANSCRIPTION_PROFILE_GENERATION, -1L)
            if (policy.isNullOrBlank() || profile.isNullOrBlank() || generation < 0L) {
                transcriptionState = "failed"
                transcriptionReason = "policy_unavailable"
                return START_NOT_STICKY
            }
            val saved = getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(TRANSCRIPTION_POLICY_JSON_KEY, policy)
                .putString(TRANSCRIPTION_PROFILE_DOCUMENT_JSON_KEY, profile)
                .putLong(TRANSCRIPTION_PROFILE_GENERATION_KEY, generation)
                .commit()
            if (!saved) {
                transcriptionState = "failed"
                transcriptionReason = "policy_unavailable"
                return START_NOT_STICKY
            }
            transcriptionPolicyJson = policy
            transcriptionProfileDocumentJson = profile
            transcriptionProfileGeneration = generation
            val backgroundPolicy = runCatching { JSONObject(policy).getJSONObject("backgroundTranscription") }.getOrNull()
            val enabled = backgroundPolicy?.optBoolean("enabled", false) == true
            val ambient = backgroundPolicy?.optBoolean("ambient", false) == true
            if (AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)) {
                val activeMode = transcriptionMode
                val modeStillEnabled = enabled && when (activeMode) {
                    "ambient" -> ambient
                    "notification" -> backgroundPolicy?.optBoolean("notification", false) == true && !ambient
                    else -> false
                }
                val profileChanged = transcriptionCaptureProfileGeneration?.let { it != generation } == true
                if (profileChanged || !modeStillEnabled) {
                    stopTranscription(
                        "interrupted",
                        if (profileChanged) "profile_changed" else "policy_disabled",
                    )
                } else {
                    syncForegroundReasons(startId)
                }
            } else if (enabled && ambient) {
                if (!getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                        .getBoolean(TRANSCRIPTION_USER_STOPPED_KEY, false)
                ) startTranscription("ambient", startId)
            } else if (enabled && backgroundPolicy?.optBoolean("notification", false) == true) {
                if (AuroraRuntimeForegroundLedger.activeReasons().isNotEmpty()) {
                    syncForegroundReasons(startId)
                } else {
                    publishManualTranscriptionNotification(startId)
                }
            } else if (AuroraRuntimeForegroundLedger.activeReasons().isNotEmpty()) {
                syncForegroundReasons(startId)
            } else {
                NotificationManagerCompat.from(this).cancel(AURORA_RUNTIME_NOTIFICATION_ID)
                stopSelfResult(startId)
            }
            return START_NOT_STICKY
        }
        if (action == ACTION_START_TRANSCRIPTION_NOTIFICATION) {
            startTranscription("notification", startId)
            return START_NOT_STICKY
        }
        if (action == ACTION_STOP_TRANSCRIPTION) {
            stopTranscription("completed", "user_stop")
            return START_NOT_STICKY
        }
        if (action == null && getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .getBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, false)
        ) {
            loadPersistedTranscriptionPolicy()
            startTranscription("ambient", startId)
            return START_NOT_STICKY
        }
        if (action == ACTION_SYNC_REASONS) {
            syncForegroundReasons(startId)
            return START_NOT_STICKY
        }
        if (profileChangeBlocked && (action == null ||
                action == ACTION_START_BACKGROUND ||
                restoringBackground ||
                action == ACTION_START_ASSISTANT)
        ) {
            pendingAssistantStartId = null
            AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.VOICE)
            captureError = "profile_changed"
            val reasons = AuroraRuntimeForegroundLedger.activeReasons()
            runCatching { enterForeground(notificationTextFor(reasons, captureSnapshot)) }
            if (reasons.isEmpty()) stopForegroundAndRemoveNotification()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_STOP_BY_USER) {
            if (AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)) {
                stopTranscription("completed", "user_stop")
                return START_NOT_STICKY
            }
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
        if (intent != null && (intent.action == ACTION_START_ASSISTANT || intent.action == ACTION_START_BACKGROUND)) {
            speechStagesJson = intent.getStringExtra(EXTRA_SPEECH_STAGES_JSON)
            confirmedProfileDocumentJson = intent.getStringExtra(EXTRA_PROFILE_DOCUMENT_JSON)
            admittedSttPackId = intent.getStringExtra(EXTRA_STT_PACK_ID)
            admittedTtsPackId = intent.getStringExtra(EXTRA_TTS_PACK_ID)
            admittedVadPackId = intent.getStringExtra(EXTRA_VAD_PACK_ID)
            admittedKwsPackId = intent.getStringExtra(EXTRA_KWS_PACK_ID)
            if (confirmedProfileDocumentJson.isNullOrBlank()) {
                stopAfterTerminalFailure(startId)
                return START_NOT_STICKY
            }
            getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(VOICE_SPEECH_STAGES_JSON_KEY, speechStagesJson)
                .putString(VOICE_CONFIRMED_PROFILE_DOCUMENT_JSON_KEY, confirmedProfileDocumentJson)
                .putString(VOICE_STT_PACK_ID_KEY, admittedSttPackId)
                .putString(VOICE_TTS_PACK_ID_KEY, admittedTtsPackId)
                .putString(VOICE_VAD_PACK_ID_KEY, admittedVadPackId)
                .putString(VOICE_KWS_PACK_ID_KEY, admittedKwsPackId)
                .commit()
        } else if (intent == null || restoringBackground) {
            val prefs = getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
            speechStagesJson = prefs.getString(VOICE_SPEECH_STAGES_JSON_KEY, null)
            confirmedProfileDocumentJson = prefs.getString(VOICE_CONFIRMED_PROFILE_DOCUMENT_JSON_KEY, null)
            admittedSttPackId = prefs.getString(VOICE_STT_PACK_ID_KEY, null)
            admittedTtsPackId = prefs.getString(VOICE_TTS_PACK_ID_KEY, null)
            admittedVadPackId = prefs.getString(VOICE_VAD_PACK_ID_KEY, null)
            admittedKwsPackId = prefs.getString(VOICE_KWS_PACK_ID_KEY, null)
            if (restoringBackground) {
                val restoreIntent = intent
                confirmedProfileDocumentJson = restoreIntent?.getStringExtra(EXTRA_PROFILE_DOCUMENT_JSON)
                    ?.takeIf { it.isNotBlank() }
                if (confirmedProfileDocumentJson.isNullOrBlank()) {
                    stopAfterTerminalFailure(startId)
                    return START_NOT_STICKY
                }
                if (restoreIntent?.hasExtra(EXTRA_STT_PACK_ID) == true) {
                    admittedSttPackId = restoreIntent.getStringExtra(EXTRA_STT_PACK_ID)
                }
                if (restoreIntent?.hasExtra(EXTRA_TTS_PACK_ID) == true) {
                    admittedTtsPackId = restoreIntent.getStringExtra(EXTRA_TTS_PACK_ID)
                }
                if (restoreIntent?.hasExtra(EXTRA_VAD_PACK_ID) == true) {
                    admittedVadPackId = restoreIntent.getStringExtra(EXTRA_VAD_PACK_ID)
                }
                if (restoreIntent?.hasExtra(EXTRA_KWS_PACK_ID) == true) {
                    admittedKwsPackId = restoreIntent.getStringExtra(EXTRA_KWS_PACK_ID)
                }
                prefs.edit()
                    .putString(VOICE_CONFIRMED_PROFILE_DOCUMENT_JSON_KEY, confirmedProfileDocumentJson)
                    .putString(VOICE_STT_PACK_ID_KEY, admittedSttPackId)
                    .putString(VOICE_TTS_PACK_ID_KEY, admittedTtsPackId)
                    .putString(VOICE_VAD_PACK_ID_KEY, admittedVadPackId)
                    .putString(VOICE_KWS_PACK_ID_KEY, admittedKwsPackId)
                    .commit()
            }
            if (confirmedProfileDocumentJson.isNullOrBlank()) {
                stopAfterTerminalFailure(startId)
                return START_NOT_STICKY
            }
        }
        val persistedBackgroundRequest = backgroundSessionRequested()
        val explicitBackgroundStart = intent?.action == ACTION_START_BACKGROUND
        val backgroundRestoreStart = restoringBackground
        if (explicitBackgroundStart && backgroundStoppedByUser(this)) {
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        if (backgroundRestoreStart && (!persistedBackgroundRequest || backgroundStoppedByUser(this))) {
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        val stickyRestart = (intent == null || backgroundRestoreStart) && persistedBackgroundRequest
        if (intent == null && !stickyRestart) {
            stopAfterTerminalFailure(startId)
            return START_NOT_STICKY
        }
        if (intent != null && !explicitBackgroundStart &&
            !backgroundRestoreStart &&
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
        lastNotificationFingerprint.set(null)
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

    private fun canStartNotificationTranscription(): Boolean {
        if (AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) ||
            AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION) ||
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) return false
        val policy = getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
            .getString(TRANSCRIPTION_POLICY_JSON_KEY, null)
            ?.let { runCatching { JSONObject(it).getJSONObject("backgroundTranscription") }.getOrNull() }
            ?: return false
        return policy.optBoolean("enabled", false) &&
            policy.optBoolean("notification", false) &&
            !policy.optBoolean("ambient", false)
    }

    private fun manualTranscriptionNotificationEnabled(): Boolean {
        val policy = getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
            .getString(TRANSCRIPTION_POLICY_JSON_KEY, null)
            ?.let { runCatching { JSONObject(it).getJSONObject("backgroundTranscription") }.getOrNull() }
            ?: return false
        return policy.optBoolean("enabled", false) &&
            policy.optBoolean("notification", false) &&
            !policy.optBoolean("ambient", false)
    }

    private fun publishManualTranscriptionNotification(startId: Int?) {
        transcriptionState = "idle"
        if (!canPostNotifications()) {
            setPersistedTranscriptionReason("notification_permission_missing")
            if (startId == null) stopSelf() else stopSelfResult(startId)
            return
        }
        val posted = runCatching {
            NotificationManagerCompat.from(this).notify(
                AURORA_RUNTIME_NOTIFICATION_ID,
                foregroundNotification("Transcript recording is ready. Tap Start to begin."),
            )
        }.isSuccess
        val reason = if (posted) null else "notification_unavailable"
        transcriptionReason = reason
        setPersistedTranscriptionReason(reason)
        if (startId == null) stopSelf() else stopSelfResult(startId)
    }

    private fun setPersistedTranscriptionReason(reason: String?) {
        getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
            .edit()
            .apply {
                if (reason == null) remove(TRANSCRIPTION_REASON_KEY)
                else putString(TRANSCRIPTION_REASON_KEY, reason)
            }
            .apply()
    }

    private fun loadPersistedTranscriptionPolicy() {
        val preferences = getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
        transcriptionPolicyJson = preferences.getString(TRANSCRIPTION_POLICY_JSON_KEY, null)
        transcriptionProfileDocumentJson = preferences.getString(TRANSCRIPTION_PROFILE_DOCUMENT_JSON_KEY, null)
        transcriptionProfileGeneration = preferences.getLong(TRANSCRIPTION_PROFILE_GENERATION_KEY, 0L)
    }

    private fun transcriptionOwnsOrReservesMicrophone(): Boolean =
        AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION) ||
            transcriptionCapture != null || transcriptionSession != null ||
            transcriptionState in setOf("starting", "listening", "transcribing")

    private fun voiceOwnsOrReservesMicrophone(): Boolean =
        AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) ||
            initializationInFlight.get() || pendingAssistantStartId != null ||
            capture != null || session != null

    private fun startTranscription(mode: String, startId: Int) {
        if (mode !in setOf("ambient", "notification")) return
        if (transcriptionSession != null || transcriptionCapture != null ||
            AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
        ) return
        if (voiceOwnsOrReservesMicrophone()) {
            transcriptionState = "failed"
            transcriptionReason = "microphone_busy"
            updateNotification(captureSnapshot)
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            transcriptionState = "failed"
            transcriptionReason = "microphone_permission_missing"
            updateNotification(captureSnapshot)
            return
        }
        if (!canPostNotifications()) {
            transcriptionState = "idle"
            transcriptionReason = "notification_permission_missing"
            setPersistedTranscriptionReason(transcriptionReason)
            if (AuroraRuntimeForegroundLedger.activeReasons().isNotEmpty()) syncForegroundReasons(startId)
            else stopSelfResult(startId)
            return
        }
        val policyJson = transcriptionPolicyJson ?: getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
            .getString(TRANSCRIPTION_POLICY_JSON_KEY, null)
        val policy = policyJson?.let { runCatching { JSONObject(it).getJSONObject("backgroundTranscription") }.getOrNull() }
        if (policy?.optBoolean("enabled", false) != true ||
            (mode == "ambient" && !policy.optBoolean("ambient", false)) ||
            (mode == "notification" && (!policy.optBoolean("notification", false) || policy.optBoolean("ambient", false)))
        ) {
            transcriptionState = "failed"
            transcriptionReason = "policy_disabled"
            updateNotification(captureSnapshot)
            return
        }
        val manifestReady = packageManager.checkPermission(
            Manifest.permission.FOREGROUND_SERVICE,
            packageName,
        ) == PackageManager.PERMISSION_GRANTED &&
            (Build.VERSION.SDK_INT < 34 || packageManager.checkPermission(
                Manifest.permission.FOREGROUND_SERVICE_MICROPHONE,
                packageName,
            ) == PackageManager.PERMISSION_GRANTED)
        if (!manifestReady) {
            transcriptionState = "failed"
            transcriptionReason = "foreground_service_unavailable"
            updateNotification(captureSnapshot)
            return
        }
        if (!AuroraRuntimeForegroundLedger.acquireOnce(AuroraRuntimeForegroundReason.TRANSCRIPTION)) return
        if (!transcriptionInitializationInFlight.compareAndSet(false, true)) {
            AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.TRANSCRIPTION)
            transcriptionState = "failed"
            transcriptionReason = "microphone_busy"
            updateNotification(captureSnapshot)
            return
        }
        running = true
        transcriptionMode = mode
        transcriptionState = "starting"
        transcriptionReason = null
        transcriptionSequence = 0L
        transcriptionStopRequested = null
        cancelTranscriptionPoll()
        val intervalEpoch = ++transcriptionIntervalEpoch
        transcriptionReservationEpoch = intervalEpoch
        if (mode == "ambient") {
            getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, true)
                .apply()
        }
        val promoted = runCatching {
            enterForeground(notificationTextFor(AuroraRuntimeForegroundLedger.activeReasons(), captureSnapshot))
        }.getOrDefault(false)
        if (!promoted) {
            failTranscription("foreground_service_unavailable", null, null, startId)
            return
        }
        setPersistedTranscriptionReason(null)
        updateNotification(captureSnapshot)
        val setup = Runnable {
            if (destroyed) {
                transcriptionInitializationInFlight.set(false)
                return@Runnable
            }
            if (intervalEpoch != transcriptionIntervalEpoch || transcriptionStopRequested != null ||
                profileChangeBlocked
            ) {
                finishHandler.post {
                    settleUnadmittedTranscriptionStart(startId, intervalEpoch, "capture_aborted")
                }
                return@Runnable
            }
            val admissionJson = AuroraNativeTranscriptionSessionBridge.nativeAdmit(mode)
            val admission = admissionJson?.let { runCatching { JSONObject(it) }.getOrNull() }
            if (admission == null) {
                finishHandler.post {
                    settleUnadmittedTranscriptionStart(startId, intervalEpoch, "archive_unavailable")
                }
                return@Runnable
            }
            val token = admission.optString("token").takeIf { it.length == 64 }
            val profileId = admission.optString("profileId").takeIf { it.isNotBlank() }
            val localNodeId = admission.optString("localNodeId").takeIf { it.isNotBlank() }
            val sessionId = admission.optString("sessionId").takeIf { it.isNotBlank() }
            val capturedProfileGeneration = admission.optLong("profileGeneration", -1L)
            val profileDocument = admission.optString("confirmedProfileDocumentJson").takeIf { it.isNotBlank() }
            val stagesJson = admission.optString("speechStagesJson").takeIf { it.isNotBlank() }
            if (token == null || profileId == null || localNodeId == null || sessionId == null ||
                capturedProfileGeneration < 0L || profileDocument == null || stagesJson == null
            ) {
                val retainedToken = token?.takeUnless {
                    AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                        it, "failed", "admission_invalid",
                    ) == 0
                }
                finishHandler.post {
                    settleUnadmittedTranscriptionStart(
                        startId, intervalEpoch, "archive_unavailable", retainedToken,
                    )
                }
                return@Runnable
            }
            if (intervalEpoch != transcriptionIntervalEpoch || transcriptionStopRequested != null ||
                profileChangeBlocked || destroyed
            ) {
                val terminal = transcriptionStopRequested
                    ?: if (profileChangeBlocked) "interrupted" to "profile_changed"
                    else "interrupted" to "capture_aborted"
                val retainedToken = token.takeUnless {
                    AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                        it, terminal.first, terminal.second,
                    ) == 0
                }
                finishHandler.post {
                    settleUnadmittedTranscriptionStart(
                        startId, intervalEpoch, terminal.second, retainedToken,
                    )
                }
                return@Runnable
            }
            val nativeConfig = AuroraVoiceNativeConfigStore.load(this, profileDocument)
            if (nativeConfig == null) {
                val terminal = transcriptionStopRequested ?: ("failed" to "profile_unavailable")
                val retainedToken = token.takeUnless {
                    AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                        it, terminal.first, terminal.second,
                    ) == 0
                }
                finishHandler.post {
                    settleUnadmittedTranscriptionStart(
                        startId, intervalEpoch, "profile_unavailable", retainedToken,
                    )
                }
                return@Runnable
            }
            val provider = admission.optString("preferredProvider")
            val modelId = admission.optString("preferredModelId").takeIf { it.isNotBlank() && it != "null" }
            val profileBoundSttModelId = AuroraVoiceNativeConfigStore.localSttPackId(profileDocument)
            val sttModelId = if (provider == "local") {
                modelId ?: profileBoundSttModelId
            } else {
                profileBoundSttModelId
            }
            val packRoot = if (sttModelId != null) auroraSpeechPackStoreRoot(this).path else null
            val nativeSession = runCatching {
                AuroraNativeTranscriptionSessionBridge(
                    nativeConfig.gateway,
                    nativeConfig.bearer,
                    nativeConfig.remoteAudioConsent,
                    packRoot,
                    sttModelId,
                    stagesJson,
                )
            }.getOrNull()
            if (nativeSession == null) {
                val terminal = transcriptionStopRequested ?: ("failed" to "stt_unavailable")
                val retainedToken = token.takeUnless {
                    AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                        it, terminal.first, terminal.second,
                    ) == 0
                }
                finishHandler.post {
                    settleUnadmittedTranscriptionStart(
                        startId, intervalEpoch, "stt_unavailable", retainedToken,
                    )
                }
                return@Runnable
            }
            val pendingResources = PendingTranscriptionResources(token, nativeSession, 0L)
            pendingTranscriptionResources.set(pendingResources)
            val generation = nativeSession.start(token, backgroundEligible = true)
            if (generation <= 0L) {
                nativeSession.close()
                var retainedToken: String? = null
                if (generation == 0L) {
                    if (AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                            token, "failed", "capture_start_failed",
                        ) != 0
                    ) {
                        retainedToken = token
                    }
                }
                pendingTranscriptionResources.compareAndSet(pendingResources, null)
                transcriptionArchiveFinalizedByStartFailure = generation < 0L
                finishHandler.post {
                    if (destroyed) return@post
                    settleUnadmittedTranscriptionStart(
                        startId, intervalEpoch, "capture_start_failed", retainedToken,
                    )
                }
                return@Runnable
            }
            val startedResources = pendingResources.copy(generation = generation)
            pendingTranscriptionResources.set(startedResources)
            transcriptionArchiveFinalizedByStartFailure = false
            finishHandler.post {
                if (destroyed) {
                    transcriptionInitializationInFlight.set(false)
                    return@post
                }
                if (intervalEpoch != transcriptionIntervalEpoch || transcriptionStopRequested != null ||
                    profileChangeBlocked ||
                    !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
                ) {
                    transcriptionState = "transcribing"
                    val terminal = transcriptionStopRequested
                        ?: if (profileChangeBlocked) "interrupted" to "profile_changed"
                        else "interrupted" to "capture_aborted"
                    try {
                        nativeLifecycleExecutor.execute {
                            runCatching { nativeSession.cancel(generation) }
                            runCatching { nativeSession.endCaptureInterval(token, generation) }
                            runCatching { nativeSession.close() }
                            val finalized = AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                                token, terminal.first, terminal.second,
                            ) == 0
                            val posted = finishHandler.post {
                                if (transcriptionReservationEpoch == intervalEpoch) {
                                    pendingTranscriptionResources.compareAndSet(startedResources, null)
                                    transcriptionState = if (finalized && terminal.first == "completed") "completed" else "failed"
                                    transcriptionReason = if (finalized && terminal.first == "completed") null
                                    else if (finalized) terminal.second else "archive_finalize_failed"
                                    if (!finalized) {
                                        transcriptionToken = token
                                        transcriptionArchiveAvailable = false
                                    }
                                    setPersistedTranscriptionReason(transcriptionReason)
                                    updateNotification(captureSnapshot)
                                    transcriptionInitializationInFlight.set(false)
                                    if (finalized) releaseTranscriptionReason(startId, intervalEpoch)
                                }
                            }
                            if (!posted) transcriptionInitializationInFlight.set(false)
                        }
                    } catch (_: RejectedExecutionException) {
                        transcriptionInitializationInFlight.set(false)
                        transcriptionState = "failed"
                        transcriptionReason = "native_runtime_unavailable"
                        transcriptionArchiveAvailable = false
                        updateNotification(captureSnapshot)
                    }
                    return@post
                }
                pendingTranscriptionResources.compareAndSet(startedResources, null)
                transcriptionToken = token
                transcriptionProfileId = profileId
                transcriptionLocalNodeId = localNodeId
                transcriptionSessionId = sessionId
                transcriptionCaptureProfileGeneration = capturedProfileGeneration
                transcriptionGeneration = generation
                transcriptionSession = nativeSession
                transcriptionArchiveAvailable = true
                transcriptionSttAvailable = true
                transcriptionInitializationInFlight.set(false)
                val audioCapture = AuroraAudioCapture(this, nativeSession, { snapshot ->
                    captureSnapshot = snapshot
                    updateNotification(snapshot)
                }, closeBridgeOnClose = false, onCaptureStarted = {
                    transcriptionCaptureStartedAtMs = System.currentTimeMillis().coerceAtLeast(0L)
                    transcriptionCaptureStartedElapsedMs = SystemClock.elapsedRealtime()
                })
                transcriptionCapture = audioCapture
                if (!audioCapture.start()) {
                    stopTranscription("failed", "microphone_start_failed")
                    return@post
                }
                transcriptionIntervalFinishRequested = false
                transcriptionState = "listening"
                transcriptionReason = null
                updateNotification(captureSnapshot)
                pollTranscription(startId)
            }
        }
        try {
            nativeLifecycleExecutor.execute(setup)
        } catch (_: RejectedExecutionException) {
            transcriptionInitializationInFlight.set(false)
            failTranscription("native_runtime_unavailable", null, null, startId, intervalEpoch)
        }
    }

    private fun pollTranscription(startId: Int) {
        // Interval startup/rearm owns the native generation until its result is
        // published back to this handler. Do not attach a poll to the prior
        // generation while that ownership is in flight; the settle callback
        // will schedule the poll for the actual generation.
        if (transcriptionInitializationInFlight.get()) return
        if (transcriptionPollRunnable != null) return
        val expectedSession = transcriptionSession ?: return
        val expectedGeneration = transcriptionGeneration
        val expectedEpoch = transcriptionIntervalEpoch
        lateinit var poll: Runnable
        poll = Runnable {
            if (transcriptionPollRunnable !== poll) return@Runnable
            transcriptionPollRunnable = null
            if (transcriptionSession !== expectedSession ||
                transcriptionGeneration != expectedGeneration ||
                transcriptionIntervalEpoch != expectedEpoch
            ) return@Runnable
            val nativeSession = expectedSession
            val stats = nativeSession.stats()
            if (stats.getOrElse(7) { 0L } != expectedGeneration) return@Runnable
            val phase = stats.getOrElse(6) { 0L }
            if (phase == 4L) {
                val token = transcriptionToken ?: return@Runnable
                val generation = transcriptionGeneration
                val transcript = nativeSession.takeTranscript()
                val startMs = stats.getOrElse(12) { transcriptionCaptureStartedAtMs }
                    .coerceAtLeast(transcriptionCaptureStartedAtMs)
                val endMs = stats.getOrElse(13) { System.currentTimeMillis() }
                    .coerceAtLeast(startMs)
                if (transcript.isNullOrBlank()) {
                    val ended = nativeSession.endCaptureInterval(token, generation) == 0
                    transcriptionCapture?.close()
                    transcriptionCapture = null
                    if (!ended) {
                        stopTranscription("failed", "capture_interval_end_failed")
                    } else if (transcriptionStopRequested != null) {
                        finishTranscriptionSession(startId)
                    } else {
                        restartTranscriptionInterval(startId)
                    }
                    return@Runnable
                }
                transcriptionState = "transcribing"
                updateNotification(captureSnapshot)
                val segmentId = java.util.UUID.randomUUID().toString()
                val profileId = transcriptionProfileId ?: return@Runnable
                val localNodeId = transcriptionLocalNodeId ?: return@Runnable
                transcriptionCapture?.close()
                transcriptionCapture = null
                val envelope = runCatching {
                    val envelope = AuroraLocalDataEnvelopeCrypto.encryptTranscriptText(
                        this,
                        profileId,
                        localNodeId,
                        segmentId,
                        transcript,
                    )
                    envelope.toString()
                }.getOrNull()
                if (envelope == null) {
                    stopTranscription("failed", "archive_write_failed")
                    return@Runnable
                }
                val permissionGranted =
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                val appendResult = nativeSession.appendEncrypted(
                    token,
                    generation,
                    segmentId,
                    transcriptionSequence,
                    startMs,
                    endMs,
                    envelope,
                    permissionGranted,
                )
                if (appendResult == -2) {
                    transcriptionStopRequested = "interrupted" to "microphone_permission_revoked"
                    finishTranscriptionSession(startId, archiveAlreadyFinalized = true)
                    return@Runnable
                }
                if (appendResult != 0 || nativeSession.endCaptureInterval(token, generation) != 0) {
                    stopTranscription("failed", "archive_write_failed")
                    return@Runnable
                }
                transcriptionSequence += 1
                if (transcriptionStopRequested != null) {
                    finishTranscriptionSession(startId)
                    return@Runnable
                }
                restartTranscriptionInterval(startId)
                return@Runnable
            }
            if (phase == 5L) {
                val reason = if (stats.getOrElse(11) { 0L } == 1L) "user_cancelled" else "transcription_failed"
                if (transcriptionGeneration > 0L) {
                    nativeSession.endCaptureInterval(transcriptionToken.orEmpty(), transcriptionGeneration)
                }
                if (transcriptionStopRequested == null) transcriptionStopRequested = "failed" to reason
                finishTranscriptionSession(startId)
                return@Runnable
            }
            if (phase == 2L && !transcriptionIntervalFinishRequested &&
                SystemClock.elapsedRealtime() - transcriptionCaptureStartedElapsedMs >= TRANSCRIPTION_INTERVAL_MAX_MILLIS
            ) {
                transcriptionIntervalFinishRequested = true
                nativeSession.finish(transcriptionGeneration)
            }
            transcriptionState = when (phase) {
                1L, 2L -> "listening"
                3L -> "transcribing"
                else -> "starting"
            }
            updateNotification(captureSnapshot)
            pollTranscription(startId)
        }
        transcriptionPollRunnable = poll
        finishHandler.postDelayed(poll, TRANSCRIPTION_POLL_MS)
    }

    private fun cancelTranscriptionPoll() {
        transcriptionPollRunnable?.let(finishHandler::removeCallbacks)
        transcriptionPollRunnable = null
    }

    private fun settleUnadmittedTranscriptionStart(
        startId: Int,
        reservationEpoch: Long,
        fallbackReason: String,
        retainedToken: String? = null,
    ) {
        if (transcriptionReservationEpoch != reservationEpoch) return
        if (retainedToken != null) {
            transcriptionToken = retainedToken
            transcriptionArchiveAvailable = false
            transcriptionInitializationInFlight.set(false)
            transcriptionState = "failed"
            transcriptionReason = "archive_finalize_failed"
            setPersistedTranscriptionReason(transcriptionReason)
            updateNotification(captureSnapshot)
            return
        }
        val terminal = transcriptionStopRequested
            ?: if (profileChangeBlocked) "interrupted" to "profile_changed"
            else "failed" to fallbackReason
        transcriptionInitializationInFlight.set(false)
        transcriptionState = if (terminal.first == "completed") "completed" else "failed"
        transcriptionReason = terminal.second.takeIf { terminal.first != "completed" }
        setPersistedTranscriptionReason(transcriptionReason)
        releaseTranscriptionReason(startId, reservationEpoch)
    }

    private fun restartTranscriptionInterval(startId: Int) {
        val token = transcriptionToken ?: return stopTranscription("failed", "admission_unavailable")
        val nativeSession = transcriptionSession ?: return stopTranscription("failed", "stt_unavailable")
        if (!transcriptionInitializationInFlight.compareAndSet(false, true)) {
            return stopTranscription("failed", "native_runtime_unavailable")
        }
        cancelTranscriptionPoll()
        val intervalEpoch = ++transcriptionIntervalEpoch
        transcriptionState = "starting"
        val restart = Runnable {
            if (destroyed) {
                transcriptionInitializationInFlight.set(false)
                return@Runnable
            }
            val generation = nativeSession.start(token, backgroundEligible = true)
            if (generation <= 0L) {
                transcriptionArchiveFinalizedByStartFailure = generation < 0L
                finishHandler.post {
                    if (destroyed) return@post
                    transcriptionInitializationInFlight.set(false)
                    if (transcriptionStopRequested == null) {
                        transcriptionStopRequested = "interrupted" to "policy_or_profile_changed"
                    }
                    finishTranscriptionSession(startId, archiveAlreadyFinalized = generation < 0L)
                }
                return@Runnable
            }
            transcriptionArchiveFinalizedByStartFailure = false
            finishHandler.post {
                if (destroyed) {
                    transcriptionInitializationInFlight.set(false)
                    return@post
                }
                transcriptionGeneration = generation
                if (intervalEpoch != transcriptionIntervalEpoch || transcriptionStopRequested != null ||
                    profileChangeBlocked ||
                    !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
                ) {
                    nativeSession.cancel(generation)
                    nativeSession.endCaptureInterval(token, generation)
                    transcriptionInitializationInFlight.set(false)
                    if (transcriptionStopRequested == null) {
                        transcriptionStopRequested = if (profileChangeBlocked) {
                            "interrupted" to "profile_changed"
                        } else {
                            "interrupted" to "capture_aborted"
                        }
                    }
                    pollTranscription(startId)
                    return@post
                }
                val audioCapture = AuroraAudioCapture(this, nativeSession, { snapshot ->
                    captureSnapshot = snapshot
                    updateNotification(snapshot)
                }, closeBridgeOnClose = false, onCaptureStarted = {
                    transcriptionCaptureStartedAtMs = System.currentTimeMillis().coerceAtLeast(0L)
                    transcriptionCaptureStartedElapsedMs = SystemClock.elapsedRealtime()
                })
                transcriptionCapture = audioCapture
                if (!audioCapture.start()) {
                    transcriptionInitializationInFlight.set(false)
                    stopTranscription("failed", "microphone_start_failed")
                } else {
                    transcriptionInitializationInFlight.set(false)
                    transcriptionState = "listening"
                    transcriptionIntervalFinishRequested = false
                    updateNotification(captureSnapshot)
                    pollTranscription(startId)
                }
            }
        }
        runCatching { nativeLifecycleExecutor.execute(restart) }
            .onFailure {
                transcriptionInitializationInFlight.set(false)
                stopTranscription("failed", "native_runtime_unavailable")
            }
    }

    private fun stopTranscription(lifecycle: String, reason: String) {
        if (lifecycle == "completed" && reason == "user_stop") {
            getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(TRANSCRIPTION_USER_STOPPED_KEY, true)
                .putBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, false)
                .commit()
        }
        transcriptionIntervalEpoch += 1
        cancelTranscriptionPoll()
        transcriptionStopRequested = lifecycle to reason
        if (transcriptionSession == null && transcriptionToken == null) {
            transcriptionState = if (lifecycle == "completed") "completed" else "failed"
            transcriptionReason = reason.takeIf { lifecycle != "completed" }
            setPersistedTranscriptionReason(transcriptionReason)
            updateNotification(captureSnapshot)
            if (!transcriptionInitializationInFlight.get()) {
                releaseTranscriptionReason(null, transcriptionReservationEpoch)
            }
            return
        }
        transcriptionState = "transcribing"
        val nativeSession = transcriptionSession
        val generation = transcriptionGeneration
        val gracefulUserStop = lifecycle == "completed" && reason == "user_stop"
        if (nativeSession != null && generation > 0L) {
            val phase = nativeSession.stats().getOrElse(6) { 0L }
            if (gracefulUserStop && (phase == 1L || phase == 2L)) {
                nativeSession.finish(generation)
            } else if (!gracefulUserStop && phase !in setOf(0L, 4L, 5L)) {
                nativeSession.cancel(generation)
            }
        }
        transcriptionCapture?.close()
        transcriptionCapture = null
        if (nativeSession == null) finishTranscriptionSession(null)
        else pollTranscription(0)
    }

    private fun finishTranscriptionSession(startId: Int?, archiveAlreadyFinalized: Boolean = false) {
        transcriptionIntervalEpoch += 1
        cancelTranscriptionPoll()
        val token = transcriptionToken
        val session = transcriptionSession
        val terminal = transcriptionStopRequested ?: ("completed" to "input_ended")
        if (token != null && !archiveAlreadyFinalized) {
            val finalized = session?.finalize(token, terminal.first, terminal.second)
                ?: AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(token, terminal.first, terminal.second)
            if (finalized != 0) {
                transcriptionState = "failed"
                transcriptionReason = "archive_finalize_failed"
                transcriptionArchiveAvailable = false
                updateNotification(captureSnapshot)
                return
            }
        }
        session?.close()
        transcriptionSession = null
        transcriptionToken = null
        transcriptionProfileId = null
        transcriptionLocalNodeId = null
        transcriptionSessionId = null
        transcriptionMode = null
        transcriptionCaptureProfileGeneration = null
        transcriptionGeneration = 0L
        transcriptionIntervalFinishRequested = false
        transcriptionStopRequested = null
        transcriptionState = if (terminal.first == "completed") "completed" else "failed"
        transcriptionReason = terminal.second.takeIf { terminal.first != "completed" }
        setPersistedTranscriptionReason(transcriptionReason)
        if (terminal.second == "user_stop" || terminal.second == "user_cancelled") {
            getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(TRANSCRIPTION_USER_STOPPED_KEY, true)
                .putBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, false)
                .apply()
        }
        releaseTranscriptionReason(startId)
    }

    private fun failTranscription(
        reason: String,
        token: String?,
        session: AuroraNativeTranscriptionSessionBridge?,
        startId: Int?,
        reservationEpoch: Long? = transcriptionReservationEpoch,
    ) {
        transcriptionIntervalEpoch += 1
        cancelTranscriptionPoll()
        token?.let { value ->
            val result = session?.finalize(value, "failed", reason)
                ?: AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(value, "failed", reason)
            if (result != 0) {
                transcriptionState = "failed"
                transcriptionReason = "archive_finalize_failed"
                transcriptionArchiveAvailable = false
                return
            }
        }
        session?.close()
        transcriptionState = "failed"
        transcriptionReason = reason
        setPersistedTranscriptionReason(reason)
        transcriptionArchiveAvailable = token != null
        if (reservationEpoch != null) transcriptionInitializationInFlight.set(false)
        releaseTranscriptionReason(startId, reservationEpoch)
    }

    private fun releaseTranscriptionReason(
        startId: Int?,
        reservationEpoch: Long? = transcriptionReservationEpoch,
    ) {
        if (reservationEpoch != null && transcriptionReservationEpoch != reservationEpoch) return
        if (reservationEpoch != null) transcriptionReservationEpoch = null
        AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.TRANSCRIPTION)
        if (transcriptionMode == "ambient" && transcriptionStopRequested?.second == "user_cancelled") {
            getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, false)
                .apply()
        }
        val reasons = AuroraRuntimeForegroundLedger.activeReasons()
        if (reasons.isEmpty()) {
            stopForegroundAndRemoveNotification()
            if (manualTranscriptionNotificationEnabled()) {
                publishManualTranscriptionNotification(startId)
            } else if (startId == null) {
                stopSelf()
            } else {
                stopSelfResult(startId)
            }
        } else {
            syncForegroundReasons(startId)
        }
    }

    private fun createNativeVoiceSession(backgroundSession: Boolean): AuroraNativeVoiceSessionBridge? {
        val profileDocument = confirmedProfileDocumentJson?.takeIf { it.isNotBlank() } ?: return null
        val nativeConfig = AuroraVoiceNativeConfigStore.load(this, profileDocument) ?: return null
        val sttModelId = admittedSttPackId
        val ttsVoiceId = admittedTtsPackId
        val vadModelId = admittedVadPackId
        val kwsModelId = admittedKwsPackId
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
        if (!backgroundSession || backgroundPacksReady) {
            val localSttReady = sttModelId != null && sttReady
            val localTtsReady = ttsVoiceId != null && ttsReady
            val localPackSelectionReady = if (speechStagesJson == null) {
                localSttReady && localTtsReady
            } else {
                localSttReady || localTtsReady || backgroundPacksReady
            }
            return AuroraNativeVoiceSessionBridge(
                nativeConfig.gateway,
                nativeConfig.bearer,
                nativeConfig.remoteAudioConsent,
                nativeConfig.assistantRouteMode,
                nativeConfig.preferredStablePeerId,
                auroraSpeechPackStoreRoot(this).path.takeIf { localPackSelectionReady },
                sttModelId?.takeIf { sttReady },
                ttsVoiceId?.takeIf { ttsReady },
                vadModelId?.takeIf { backgroundPacksReady },
                kwsModelId?.takeIf { backgroundPacksReady },
                wakePhrase?.id?.takeIf { backgroundPacksReady },
                wakePhrase?.text?.takeIf { backgroundPacksReady },
                wakePhrase?.revision?.takeIf { backgroundPacksReady },
                ttsReference,
                speechStagesJson,
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
        profileChangeDrainInFlight = false
        val profileChangeWaiters = profileChangeDrainWaiters.toList()
        profileChangeDrainWaiters.clear()
        profileChangeWaiters.forEach { waiter -> waiter(false) }
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
        releaseNativeTranscriptionResourcesOnDestroy()
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

    private fun releaseNativeTranscriptionResourcesOnDestroy() {
        transcriptionIntervalEpoch += 1L
        cancelTranscriptionPoll()
        val captureToClose = transcriptionCapture
        val nativeSession = transcriptionSession
        val token = transcriptionToken
        transcriptionCapture = null
        transcriptionSession = null
        transcriptionToken = null
        transcriptionProfileId = null
        transcriptionLocalNodeId = null
        transcriptionSessionId = null
        transcriptionMode = null
        transcriptionCaptureProfileGeneration = null
        transcriptionGeneration = 0L
        transcriptionArchiveAvailable = false
        transcriptionSttAvailable = false
        try {
            nativeLifecycleExecutor.execute {
                val pending = pendingTranscriptionResources.getAndSet(null)
                val sessionToClose = nativeSession ?: pending?.session
                val tokenToFinalize = token ?: pending?.token
                val actualGeneration = runCatching {
                    sessionToClose?.stats()?.getOrElse(7) { 0L } ?: 0L
                }.getOrDefault(0L).takeIf { it > 0L }
                    ?: pending?.generation?.takeIf { it > 0L }
                    ?: 0L
                val alreadyFinalized = transcriptionArchiveFinalizedByStartFailure
                runCatching { captureToClose?.close() }
                if (actualGeneration > 0L) runCatching { sessionToClose?.cancel(actualGeneration) }
                runCatching { sessionToClose?.close() }
                var archiveFinalized = tokenToFinalize == null || alreadyFinalized
                if (tokenToFinalize != null && !alreadyFinalized) {
                    if (actualGeneration > 0L) {
                        runCatching { sessionToClose?.endCaptureInterval(tokenToFinalize, actualGeneration) }
                    }
                    archiveFinalized = runCatching {
                        AuroraNativeTranscriptionSessionBridge.nativeFinalizeAdmission(
                            tokenToFinalize,
                            "interrupted",
                            "service_stopped",
                        ) == 0
                    }.getOrDefault(false)
                }
                transcriptionArchiveAvailable = false
                if (tokenToFinalize != null && !archiveFinalized) {
                    transcriptionState = "failed"
                    transcriptionReason = "archive_finalize_failed"
                    setPersistedTranscriptionReason(transcriptionReason)
                } else if (tokenToFinalize != null) {
                    transcriptionState = "failed"
                    transcriptionReason = "service_stopped"
                    setPersistedTranscriptionReason(transcriptionReason)
                }
                AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.TRANSCRIPTION)
            }
        } catch (_: RejectedExecutionException) {
            transcriptionState = "failed"
            transcriptionReason = "voice_runtime_shutdown_failed"
            transcriptionArchiveAvailable = false
            setPersistedTranscriptionReason(transcriptionReason)
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
    ): Boolean {
        var closeFailed = runCatching { captureToClose?.close() }.isFailure
        if (nativeSession != null && generationToCancel != 0L) {
            closeFailed = runCatching { nativeSession.cancel(generationToCancel) }
                .fold(onSuccess = { it != 0 }, onFailure = { true }) || closeFailed
        }
        closeFailed = runCatching { playbackToClose?.close() }.isFailure || closeFailed
        closeFailed = runCatching { nativeSession?.close() }.isFailure || closeFailed
        if (closeFailed) captureError = "voice_runtime_shutdown_failed"
        return !closeFailed
    }

    private fun drainVoiceForProfileChange(onComplete: (Boolean) -> Unit) {
        if (Looper.myLooper() != Looper.getMainLooper() || destroyed) {
            onComplete(false)
            return
        }
        profileChangeDrainWaiters += onComplete
        if (profileChangeDrainInFlight) return
        profileChangeDrainInFlight = true

        fun finishDrain(released: Boolean) {
            profileChangeDrainInFlight = false
            val waiters = profileChangeDrainWaiters.toList()
            profileChangeDrainWaiters.clear()
            waiters.forEach { waiter -> waiter(released) }
        }

        invalidateNativeVoiceInitialization()
        profileChangeBlocked = true
        pendingAssistantStartId = null
        resumeBackgroundAfterFocusedTurn = false
        backgroundSessionRearmEnabled = false
        clearBackgroundSessionPersistence()
        backgroundSessionActive = false
        AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.VOICE)
        val transcriptionOwned = transcriptionReservationEpoch != null ||
            transcriptionInitializationInFlight.get() ||
            pendingTranscriptionResources.get() != null ||
            transcriptionCapture != null || transcriptionSession != null || transcriptionToken != null ||
            AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
        val transcriptionDrainDeadline =
            SystemClock.elapsedRealtime() + PROFILE_CHANGE_TRANSCRIPTION_DRAIN_TIMEOUT_MS
        if (transcriptionOwned) stopTranscription("interrupted", "profile_changed")
        captureSnapshot = emptySnapshot(null)
        if (AuroraRuntimeForegroundLedger.activeReasons().isEmpty()) {
            stopForegroundAndRemoveNotification()
        } else {
            updateNotification(captureSnapshot)
        }

        fun drainAfterInitialization() {
            if (destroyed) {
                finishDrain(false)
                return
            }
            if (initializationInFlight.get()) {
                val posted = finishHandler.postDelayed(
                    { drainAfterInitialization() }, PROFILE_CHANGE_DRAIN_POLL_MS,
                )
                if (!posted) finishDrain(false)
                return
            }

            val captureToClose = capture
            val playbackToClose = playback
            val nativeSession = session
            val generationToCancel = sessionGeneration
            capture = null
            playback = null
            session = null
            sessionGeneration = 0L
            abandonAudioFocus()
            audioFocusRequest = null

            if (captureToClose == null && playbackToClose == null && nativeSession == null) {
                val released =
                    !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) &&
                        captureError != "voice_runtime_shutdown_failed"
                if (released) captureError = null
                finishDrain(released)
                return
            }
            try {
                nativeLifecycleExecutor.execute {
                    val closed = closeNativeResources(
                        captureToClose,
                        playbackToClose,
                        nativeSession,
                        generationToCancel,
                    )
                    finishHandler.post {
                        val released = closed &&
                            !destroyed &&
                            capture == null &&
                            playback == null &&
                            session == null &&
                            !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE)
                        if (released) captureError = null
                        finishDrain(released)
                    }
                }
            } catch (_: RejectedExecutionException) {
                captureError = "voice_runtime_shutdown_failed"
                finishDrain(false)
            }
        }

        fun drainTranscriptionBeforeVoice() {
            if (destroyed) {
                finishDrain(false)
                return
            }
            val stillOwned = transcriptionReservationEpoch != null ||
                transcriptionInitializationInFlight.get() ||
                pendingTranscriptionResources.get() != null ||
                transcriptionCapture != null || transcriptionSession != null || transcriptionToken != null ||
                AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
            if (!stillOwned) {
                drainAfterInitialization()
                return
            }
            if (SystemClock.elapsedRealtime() >= transcriptionDrainDeadline) {
                finishDrain(false)
                return
            }
            val posted = finishHandler.postDelayed(
                { drainTranscriptionBeforeVoice() }, PROFILE_CHANGE_DRAIN_POLL_MS,
            )
            if (!posted) finishDrain(false)
        }

        drainTranscriptionBeforeVoice()
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
                observationToken = result.optString("observationToken", ""),
                generation = result.optLong("generation", 0L).coerceAtLeast(0L),
                transcriptPlaintext = transcript,
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
            lastNotificationFingerprint.set(null)
            return
        }
        val text = notificationTextFor(AuroraRuntimeForegroundLedger.activeReasons(), snapshot)
        val fingerprint = notificationFingerprint(text, connectedPeers.get())
        if (lastNotificationFingerprint.get() == fingerprint) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(AURORA_RUNTIME_NOTIFICATION_ID, foregroundNotification(text))
        lastNotificationFingerprint.set(fingerprint)
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
        val transcription = AuroraRuntimeForegroundReason.TRANSCRIPTION in reasons
        val deviceLink = AuroraRuntimeForegroundReason.DEVICE_LINK in reasons
        if (transcription) {
            val message = when (transcriptionState) {
                "starting" -> "Starting transcript recording…"
                "transcribing" -> "Saving a transcript on this device. Tap Stop to end."
                else -> "Transcribing speech on this device. Tap Stop to end."
            }
            return if (deviceLink) "$message Connected to ${connectedPeers.get().size} devices." else message
        }
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
            voice -> voiceText
            deviceLink -> "Connected devices are available."
            else -> "Aurora is finishing up."
        }
    }

    private fun notificationFingerprint(
        text: String,
        peers: List<AuroraNotificationPeer>,
    ): String = buildString {
        append(text)
        peers.forEach { peer ->
            append('|')
            append(peer.peerId)
            append(':')
            append(peer.displayName)
            append(':')
            append(notificationPeerLatencyText(peer.roundTripTimeMs))
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
    private fun enterForeground(text: String): Boolean {
        lastNotificationFingerprint.set(notificationFingerprint(text, connectedPeers.get()))
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
                    (AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) ||
                        AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)) &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                ) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                } else {
                    0
                }
                if (microphoneType == 0) {
                    running = false
                    stopSelf()
                    return false
                }
                startForeground(AURORA_RUNTIME_NOTIFICATION_ID, notification, microphoneType)
            }
        } else {
            startForeground(AURORA_RUNTIME_NOTIFICATION_ID, notification)
        }
        notificationsSuppressed = !canPostNotifications()
        return true
    }

    private fun foregroundServiceTypes(reasons: Set<AuroraRuntimeForegroundReason>): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        var types = 0
        if ((AuroraRuntimeForegroundReason.VOICE in reasons ||
                AuroraRuntimeForegroundReason.TRANSCRIPTION in reasons) &&
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
        if (profileChangeDrainInFlight) return
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
        val transcriptionOnly = AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION) &&
            !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE)
        val stopIntent = Intent(this, AuroraRuntimeForegroundService::class.java).apply {
            action = if (transcriptionOnly) ACTION_STOP_TRANSCRIPTION else ACTION_STOP_BY_USER
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            4204,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val peers = connectedPeers.get()
        val collapsedView = notificationCollapsedView(text, peers)
        val expandedView = notificationExpandedView(text, peers)
        val builder = NotificationCompat.Builder(this, AURORA_RUNTIME_CHANNEL_ID)
        builder
            .setSmallIcon(R.drawable.ic_aurora_notification)
            .setContentTitle("Aurora")
            .setContentText(text)
            .setSubText(notificationPeerSummary(peers.size).takeIf { peers.isNotEmpty() })
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(0xFF1F6F68.toInt())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(collapsedView)
            .setCustomBigContentView(expandedView)
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
        if (AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) ||
            AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
        ) {
            builder.addAction(0, "Stop", stopPendingIntent)
        } else if (canStartNotificationTranscription()) {
            val startIntent = Intent(this, AuroraRuntimeForegroundService::class.java).apply {
                action = ACTION_START_TRANSCRIPTION_NOTIFICATION
            }
            val startPendingIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PendingIntent.getForegroundService(
                    this,
                    4206,
                    startIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            } else {
                PendingIntent.getService(
                    this,
                    4206,
                    startIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            builder.addAction(
                0,
                "Start transcription",
                startPendingIntent,
            )
        }
        return builder.build()
    }

    private fun notificationCollapsedView(
        voiceText: String,
        peers: List<AuroraNotificationPeer>,
    ): RemoteViews = RemoteViews(
        packageName,
        R.layout.aurora_runtime_notification_collapsed,
    ).apply {
        setTextViewText(R.id.aurora_notification_voice_state, voiceText)
        setTextViewText(R.id.aurora_notification_peer_summary, notificationPeerSummary(peers.size))
        setViewVisibility(
            R.id.aurora_notification_peer_summary,
            if (peers.isEmpty()) View.GONE else View.VISIBLE,
        )
    }

    private fun notificationExpandedView(
        voiceText: String,
        peers: List<AuroraNotificationPeer>,
    ): RemoteViews = RemoteViews(
        packageName,
        R.layout.aurora_runtime_notification_expanded,
    ).apply {
        val voiceActive = AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE)
        setTextViewText(
            R.id.aurora_notification_voice_state,
            if (voiceActive) voiceText else "Voice is off.",
        )
        setTextViewText(
            R.id.aurora_notification_peers_heading,
            notificationPeerSummary(peers.size),
        )
        setViewVisibility(
            R.id.aurora_notification_no_peers,
            if (peers.isEmpty()) View.VISIBLE else View.GONE,
        )
        val rows = listOf(
            Triple(
                R.id.aurora_notification_peer_row_1,
                R.id.aurora_notification_peer_name_1,
                R.id.aurora_notification_peer_latency_1,
            ),
            Triple(
                R.id.aurora_notification_peer_row_2,
                R.id.aurora_notification_peer_name_2,
                R.id.aurora_notification_peer_latency_2,
            ),
            Triple(
                R.id.aurora_notification_peer_row_3,
                R.id.aurora_notification_peer_name_3,
                R.id.aurora_notification_peer_latency_3,
            ),
        )
        rows.forEachIndexed { index, (rowId, nameId, latencyId) ->
            val peer = peers.getOrNull(index)
            setViewVisibility(rowId, if (peer == null) View.GONE else View.VISIBLE)
            if (peer != null) {
                setTextViewText(nameId, peer.displayName)
                setTextViewText(latencyId, notificationPeerLatencyText(peer.roundTripTimeMs))
            }
        }
        val hiddenPeers = (peers.size - MAX_VISIBLE_NOTIFICATION_PEERS).coerceAtLeast(0)
        setTextViewText(R.id.aurora_notification_more_peers, "+$hiddenPeers more")
        setViewVisibility(
            R.id.aurora_notification_more_peers,
            if (hiddenPeers > 0) View.VISIBLE else View.GONE,
        )
    }

    private fun notificationPeerSummary(peerCount: Int): String = when (peerCount) {
        0 -> "No devices connected"
        1 -> "1 device connected"
        else -> "$peerCount devices connected"
    }

    private fun notificationPeerLatencyText(roundTripTimeMs: Double?): String =
        if (roundTripTimeMs != null && roundTripTimeMs.isFinite() && roundTripTimeMs > 0.0) {
            "${roundTripTimeMs.roundToInt()} ms"
        } else {
            "Connected"
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
            lastNotificationFingerprint.set(null)
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
        lastNotificationFingerprint.set(null)
    }

    companion object {
        private const val PROFILE_CHANGE_DRAIN_POLL_MS = 25L
        private const val PROFILE_CHANGE_TRANSCRIPTION_DRAIN_TIMEOUT_MS = 15_000L
        private const val TRANSCRIPTION_POLL_MS = 250L

        const val ACTION_STOP = "dev.aurora.tauri.nativeplugin.action.STOP_VOICE_CAPTURE"
        const val ACTION_STOP_BY_USER = "dev.aurora.tauri.nativeplugin.action.STOP_BACKGROUND_VOICE_BY_USER"
        const val ACTION_FINISH = "dev.aurora.tauri.nativeplugin.action.FINISH_VOICE_CAPTURE"
        const val ACTION_START_BACKGROUND = "dev.aurora.tauri.nativeplugin.action.START_BACKGROUND_VOICE"
        const val ACTION_RESTORE_BACKGROUND = "dev.aurora.tauri.nativeplugin.action.RESTORE_BACKGROUND_VOICE"
        const val ACTION_START_ASSISTANT = "dev.aurora.tauri.nativeplugin.action.START_ASSISTANT_VOICE"
        const val ACTION_SYNC_BACKGROUND_TRANSCRIPTION = "dev.aurora.tauri.nativeplugin.action.SYNC_BACKGROUND_TRANSCRIPTION"
        const val ACTION_START_TRANSCRIPTION_NOTIFICATION = "dev.aurora.tauri.nativeplugin.action.START_TRANSCRIPTION_NOTIFICATION"
        const val ACTION_STOP_TRANSCRIPTION = "dev.aurora.tauri.nativeplugin.action.STOP_TRANSCRIPTION"
        const val ACTION_SYNC_REASONS = "dev.aurora.tauri.nativeplugin.action.SYNC_FOREGROUND_REASONS"
        const val EXTRA_SPEECH_STAGES_JSON = "dev.aurora.tauri.nativeplugin.extra.SPEECH_STAGES_JSON"
        const val EXTRA_PROFILE_DOCUMENT_JSON = "dev.aurora.tauri.nativeplugin.extra.CONFIRMED_PROFILE_DOCUMENT_JSON"
        const val EXTRA_STT_PACK_ID = "dev.aurora.tauri.nativeplugin.extra.ADMITTED_STT_PACK_ID"
        const val EXTRA_TTS_PACK_ID = "dev.aurora.tauri.nativeplugin.extra.ADMITTED_TTS_PACK_ID"
        const val EXTRA_VAD_PACK_ID = "dev.aurora.tauri.nativeplugin.extra.ADMITTED_VAD_PACK_ID"
        const val EXTRA_KWS_PACK_ID = "dev.aurora.tauri.nativeplugin.extra.ADMITTED_KWS_PACK_ID"
        const val EXTRA_TRANSCRIPTION_POLICY_JSON = "dev.aurora.tauri.nativeplugin.extra.TRANSCRIPTION_POLICY_JSON"
        const val EXTRA_TRANSCRIPTION_PROFILE_DOCUMENT_JSON = "dev.aurora.tauri.nativeplugin.extra.TRANSCRIPTION_PROFILE_DOCUMENT_JSON"
        const val EXTRA_TRANSCRIPTION_PROFILE_GENERATION = "dev.aurora.tauri.nativeplugin.extra.TRANSCRIPTION_PROFILE_GENERATION"
        private const val VOICE_SPEECH_STAGES_JSON_KEY = "speech_stages_json"
        private const val VOICE_CONFIRMED_PROFILE_DOCUMENT_JSON_KEY = "confirmed_profile_document_json"
        private const val VOICE_STT_PACK_ID_KEY = "admitted_stt_pack_id"
        private const val VOICE_TTS_PACK_ID_KEY = "admitted_tts_pack_id"
        private const val VOICE_VAD_PACK_ID_KEY = "admitted_vad_pack_id"
        private const val VOICE_KWS_PACK_ID_KEY = "admitted_kws_pack_id"
        private const val TRANSCRIPTION_PREFS = "aurora_transcription_service"
        private const val TRANSCRIPTION_POLICY_JSON_KEY = "policy_json"
        private const val TRANSCRIPTION_PROFILE_DOCUMENT_JSON_KEY = "profile_document_json"
        private const val TRANSCRIPTION_PROFILE_GENERATION_KEY = "profile_generation"
        private const val TRANSCRIPTION_RESTORE_AMBIENT_KEY = "restore_ambient"
        private const val TRANSCRIPTION_USER_STOPPED_KEY = "user_stopped"
        private const val MICROPHONE_PERMISSION_REQUESTED_KEY = "microphone_permission_requested"
        private const val TRANSCRIPTION_REASON_KEY = "last_reason"

        private val connectedPeers = AtomicReference<List<AuroraNotificationPeer>>(emptyList())

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

        fun updateConnectedPeers(context: Context, peers: List<AuroraNotificationPeer>) {
            val seenPeerIds = HashSet<String>()
            val normalized = peers.mapNotNull { peer ->
                val peerId = peer.peerId.trim()
                if (peerId.isEmpty() || !seenPeerIds.add(peerId)) {
                    return@mapNotNull null
                }
                val displayName = peer.displayName
                    .trim()
                    .filterNot { character -> character.isISOControl() }
                    .take(64)
                    .ifEmpty { "Connected device" }
                AuroraNotificationPeer(
                    peerId = peerId,
                    displayName = displayName,
                    roundTripTimeMs = peer.roundTripTimeMs
                        ?.takeIf { value -> value.isFinite() && value > 0.0 },
                )
            }
            connectedPeers.set(normalized)
            val instance = activeInstance
            if (instance != null) {
                instance.finishHandler.post {
                    if (activeInstance === instance && running) {
                        instance.updateNotification(captureSnapshot)
                    }
                }
            } else if (running) {
                runCatching {
                    context.startService(
                        Intent(context, AuroraRuntimeForegroundService::class.java).apply {
                            action = ACTION_SYNC_REASONS
                        },
                    )
                }
            }
        }

        fun connectedPeerCount(): Int = connectedPeers.get().size

        /** Persists only the Root-confirmed snapshot and asks the service to revalidate it natively. */
        fun syncBackgroundTranscription(
            context: Context,
            policyJson: String,
            confirmedProfileDocumentJson: String,
            profileGeneration: Long,
        ): JSONObject? {
            if (policyJson.length !in 1..262_144 ||
                confirmedProfileDocumentJson.length !in 1..131_072 || profileGeneration < 0L
            ) return null
            val policy = runCatching { JSONObject(policyJson).getJSONObject("backgroundTranscription") }.getOrNull()
                ?: return null
            val preferences = context.getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
            val previousPolicy = preferences.getString(TRANSCRIPTION_POLICY_JSON_KEY, null)
                ?.let { runCatching { JSONObject(it).getJSONObject("backgroundTranscription") }.getOrNull() }
            val enabled = policy.optBoolean("enabled", false)
            val ambient = policy.optBoolean("ambient", false)
            val explicitAmbientEnable = enabled && ambient &&
                (previousPolicy?.optBoolean("enabled", false) != true ||
                    previousPolicy?.optBoolean("ambient", false) != true)
            val editor = preferences
                .edit()
                .putString(TRANSCRIPTION_POLICY_JSON_KEY, policyJson)
                .putString(TRANSCRIPTION_PROFILE_DOCUMENT_JSON_KEY, confirmedProfileDocumentJson)
                .putLong(TRANSCRIPTION_PROFILE_GENERATION_KEY, profileGeneration)
            val manualEnabled = policy.optBoolean("enabled", false) &&
                policy.optBoolean("notification", false) && !policy.optBoolean("ambient", false)
            if (manualEnabled && !notificationPermissionAvailable(context)) {
                editor.putString(TRANSCRIPTION_REASON_KEY, "notification_permission_missing")
            } else {
                editor.remove(TRANSCRIPTION_REASON_KEY)
            }
            if (!enabled || !ambient) {
                editor.putBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, false)
            } else {
                editor.putBoolean(TRANSCRIPTION_RESTORE_AMBIENT_KEY, true)
                if (explicitAmbientEnable) {
                    editor.putBoolean(TRANSCRIPTION_USER_STOPPED_KEY, false)
                }
            }
            if (!editor.commit()) return null
            val intent = Intent(context, AuroraRuntimeForegroundService::class.java).apply {
                action = ACTION_SYNC_BACKGROUND_TRANSCRIPTION
                putExtra(EXTRA_TRANSCRIPTION_POLICY_JSON, policyJson)
                putExtra(EXTRA_TRANSCRIPTION_PROFILE_DOCUMENT_JSON, confirmedProfileDocumentJson)
                putExtra(EXTRA_TRANSCRIPTION_PROFILE_GENERATION, profileGeneration)
            }
            val started = runCatching { context.startService(intent) }.isSuccess
            if (!started) return null
            return transcriptionStatus(context)
        }

        fun transcriptionStatus(context: Context): JSONObject {
            val instance = activeInstance
            val preferences = context.getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
            val policy = preferences.getString(TRANSCRIPTION_POLICY_JSON_KEY, null)
                ?.let { runCatching { JSONObject(it).getJSONObject("backgroundTranscription") }.getOrNull() }
            val microphone = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            val manifestReady = context.packageManager.checkPermission(
                Manifest.permission.FOREGROUND_SERVICE,
                context.packageName,
            ) == PackageManager.PERMISSION_GRANTED &&
                (Build.VERSION.SDK_INT < 34 || context.packageManager.checkPermission(
                    Manifest.permission.FOREGROUND_SERVICE_MICROPHONE,
                    context.packageName,
                ) == PackageManager.PERMISSION_GRANTED)
            val state = instance?.transcriptionState ?: "idle"
            val mode = instance?.takeIf {
                it.transcriptionState in setOf("starting", "listening", "transcribing") &&
                    it.transcriptionToken != null && it.transcriptionSession != null
            }?.transcriptionMode
            val permission = when {
                microphone -> "granted"
                preferences.getBoolean(MICROPHONE_PERMISSION_REQUESTED_KEY, false) -> "denied"
                else -> "not_requested"
            }
            val capability = when {
                !manifestReady -> "unsupported"
                Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> "foreground_only"
                else -> "supported"
            }
            return JSONObject()
                .put("capability", capability)
                .put("permission", permission)
                .put("foreground", AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION))
                .put("sttAvailable", instance?.transcriptionSttAvailable == true)
                .put("archiveAvailable", instance?.transcriptionArchiveAvailable == true)
                .put("captureMode", mode ?: JSONObject.NULL)
                .put("state", state)
                .put(
                    "reason",
                    instance?.transcriptionReason
                        ?: preferences.getString(TRANSCRIPTION_REASON_KEY, null)
                        ?: if (policy == null) "policy_unavailable" else JSONObject.NULL,
                )
        }

        private fun notificationPermissionAvailable(context: Context): Boolean =
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
                NotificationManagerCompat.from(context).areNotificationsEnabled()

        fun noteMicrophonePermissionRequested(context: Context) {
            context.getSharedPreferences(TRANSCRIPTION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(MICROPHONE_PERMISSION_REQUESTED_KEY, true)
                .apply()
        }

        /** The reasons currently keeping the one Aurora service alive. */
        fun activeForegroundReasonIds(): List<String> =
            AuroraRuntimeForegroundLedger.activeReasons().map { it.id }

        /** Whether a focused or durable native voice session currently holds the service. */
        fun foregroundVoiceSessionActive(): Boolean =
            AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE)

        /** Cancels and drains native voice without terminating the reusable service. */
        fun releaseVoiceSessionForProfileChange(context: Context, onComplete: (Boolean) -> Unit) {
            profileChangeBlocked = true
            clearSpeechStagesPolicy(context)
            val instance = activeInstance
            if (instance == null) {
                onComplete(
                    !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) &&
                        !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION),
                )
                return
            }
            val posted = instance.finishHandler.post {
                if (activeInstance !== instance) {
                    onComplete(
                        !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) &&
                            !AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION),
                    )
                } else {
                    instance.drainVoiceForProfileChange(onComplete)
                }
            }
            if (!posted) onComplete(false)
        }

        fun completeVoiceProfileChange(): Boolean {
            if (!profileChangeBlocked ||
                AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.VOICE) ||
                AuroraRuntimeForegroundLedger.isHeld(AuroraRuntimeForegroundReason.TRANSCRIPTION)
            ) {
                return false
            }
            val instance = activeInstance
            if (instance != null && (
                    instance.profileChangeDrainInFlight ||
                        instance.initializationInFlight.get() ||
                        instance.transcriptionInitializationInFlight.get() ||
                        instance.transcriptionReservationEpoch != null ||
                        instance.pendingTranscriptionResources.get() != null ||
                        instance.transcriptionCapture != null ||
                        instance.transcriptionSession != null ||
                        instance.transcriptionToken != null ||
                        instance.capture != null ||
                        instance.playback != null ||
                        instance.session != null
                    )
            ) {
                return false
            }
            profileChangeBlocked = false
            return true
        }

        private fun clearSpeechStagesPolicy(context: Context) {
            activeInstance?.speechStagesJson = null
            activeInstance?.confirmedProfileDocumentJson = null
            activeInstance?.admittedSttPackId = null
            activeInstance?.admittedTtsPackId = null
            activeInstance?.admittedVadPackId = null
            activeInstance?.admittedKwsPackId = null
            context.getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
                ?.edit()
                ?.remove(VOICE_SPEECH_STAGES_JSON_KEY)
                ?.remove(VOICE_CONFIRMED_PROFILE_DOCUMENT_JSON_KEY)
                ?.remove(VOICE_STT_PACK_ID_KEY)
                ?.remove(VOICE_TTS_PACK_ID_KEY)
                ?.remove(VOICE_VAD_PACK_ID_KEY)
                ?.remove(VOICE_KWS_PACK_ID_KEY)
                ?.apply()
        }

        fun backgroundStoppedByUser(context: Context): Boolean =
            context.getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
                .getBoolean(VOICE_BACKGROUND_STOPPED_BY_USER_KEY, false)

        fun canRestoreBackgroundSession(context: Context, currentProfileDocumentJson: String): Boolean {
            val preferences = context.getSharedPreferences(VOICE_SERVICE_PREFS, Context.MODE_PRIVATE)
            return preferences.getBoolean(VOICE_BACKGROUND_SESSION_REQUESTED_KEY, false) &&
                preferences.getString(VOICE_CONFIRMED_PROFILE_DOCUMENT_JSON_KEY, null) == currentProfileDocumentJson &&
                currentProfileDocumentJson.isNotBlank()
        }

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

        @Volatile
        private var profileChangeBlocked = false

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
