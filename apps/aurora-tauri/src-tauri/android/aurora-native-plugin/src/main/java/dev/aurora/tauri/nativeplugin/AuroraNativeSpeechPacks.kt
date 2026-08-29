package dev.aurora.tauri.nativeplugin

import android.content.Context
import java.io.File
import java.util.Locale
import org.json.JSONArray

internal const val AURORA_SPEECH_PACK_STORE_DIR = "aurora_speech_packs"
internal const val AURORA_SPEECH_PACK_PREFS = "aurora_voice_pack_cache"
internal const val AURORA_SPEECH_PACK_LEGACY_ACTIVE_ID_KEY = "active_voice_pack_id"
internal const val AURORA_SPEECH_PACK_MAX_ARCHIVE_BYTES = 3L * 1024L * 1024L * 1024L
internal const val AURORA_TTS_REFERENCE_PREFS = "aurora_tts_reference_profiles"
internal const val AURORA_WAKE_PHRASE_ID_KEY = "wake_phrase_id"
internal const val AURORA_WAKE_PHRASE_TEXT_KEY = "wake_phrase_text"
internal const val AURORA_WAKE_PHRASE_REVISION_KEY = "wake_phrase_revision"
internal const val AURORA_TTS_REFERENCE_ID_KEY = "tts_reference_id"
internal const val AURORA_TTS_REFERENCE_AUDIO_URI_KEY = "tts_reference_audio_uri"
internal const val AURORA_TTS_REFERENCE_TEXT_KEY = "tts_reference_text"
internal const val AURORA_TTS_REFERENCE_REVISION_KEY = "tts_reference_revision"
internal const val AURORA_TTS_REFERENCE_SAMPLE_RATE_HZ_KEY = "tts_reference_sample_rate_hz"
internal const val AURORA_TTS_REFERENCE_SAMPLES_KEY = "tts_reference_samples"
internal const val AURORA_TTS_REFERENCE_MAX_SAMPLES = 160_000

internal enum class AuroraSpeechPackTask(val nativeName: String) {
    STT("stt"),
    TTS("tts"),
    VAD("vad"),
    KWS("kws"),
}

internal data class AuroraWakePhraseSelection(
    val id: String,
    val text: String,
    val revision: String,
)

internal data class AuroraTtsReferenceSelection(
    val id: String,
    val audioUri: String,
    val text: String,
    val revision: String,
    val sampleRateHz: Int,
    val samples: FloatArray,
)

internal fun auroraSpeechPackStoreRoot(context: Context): File =
    File(context.filesDir, AURORA_SPEECH_PACK_STORE_DIR).apply { mkdirs() }

internal fun auroraSpeechPackActiveKey(task: AuroraSpeechPackTask): String =
    "active.${task.nativeName}"

internal fun inferAuroraSpeechPackTask(tasks: List<String>): AuroraSpeechPackTask? {
    val normalized = tasks.map { it.trim().lowercase(Locale.getDefault()) }
    if (normalized.any { it == "tts" || it.contains("text-to-speech") || it.contains("speech_synthesis") }) {
        return AuroraSpeechPackTask.TTS
    }
    if (normalized.any { it == "vad" || it.contains("voice-activity") || it.contains("voice_activity") }) {
        return AuroraSpeechPackTask.VAD
    }
    if (normalized.any { it == "kws" || it.contains("wakeword") || it.contains("wake-word") || it.contains("keyword") }) {
        return AuroraSpeechPackTask.KWS
    }
    if (normalized.any { it == "stt" || it == "asr" || it.contains("transcription") || it.contains("speech-to-text") }) {
        return AuroraSpeechPackTask.STT
    }
    return null
}

internal fun auroraSpeechPackTaskFromName(value: String): AuroraSpeechPackTask? =
    when (value.trim().lowercase(Locale.getDefault())) {
        "stt", "asr", "transcription" -> AuroraSpeechPackTask.STT
        "tts", "speech_synthesis", "speech-synthesis", "text-to-speech" -> AuroraSpeechPackTask.TTS
        "vad", "voice-activity", "voice_activity" -> AuroraSpeechPackTask.VAD
        "kws", "wakeword", "wake-word", "keyword" -> AuroraSpeechPackTask.KWS
        else -> null
    }

internal fun auroraTtsReferenceAudioReady(
    id: String,
    sampleRateHz: Int,
    samples: FloatArray,
): Boolean = id.isNotBlank() && sampleRateHz > 0 && samples.isNotEmpty()

internal fun auroraTtsReferenceSelectionOrNull(
    id: String,
    audioUri: String,
    text: String,
    revision: String,
    sampleRateHz: Int,
    samples: FloatArray,
): AuroraTtsReferenceSelection? {
    if (!auroraTtsReferenceAudioReady(id, sampleRateHz, samples)) return null
    return AuroraTtsReferenceSelection(id, audioUri, text, revision, sampleRateHz, samples)
}

internal fun auroraTtsReferenceRequired(
    task: AuroraSpeechPackTask?,
    modelFamily: String,
    requiresReferenceAudio: Boolean,
    referenceAudioMode: String,
): Boolean {
    if (task != AuroraSpeechPackTask.TTS) return false
    return when (referenceAudioMode.trim().lowercase(Locale.getDefault())) {
        "internal" -> false
        "profile" -> true
        else -> requiresReferenceAudio || modelFamily == "pockettts"
    }
}

internal fun auroraVoicePackReferenceAudioMode(item: org.json.JSONObject): String =
    item.optString("referenceAudioMode", item.optString("reference_audio_mode", ""))
        .trim()
        .lowercase(Locale.getDefault())

internal object AuroraNativeSpeechPackBridge {
    fun install(
        context: Context,
        packId: String,
        task: AuroraSpeechPackTask,
        onProgress: ((phase: String, completedBytes: Long, expectedBytes: Long) -> Unit)? = null,
    ): Boolean {
        val progressSink = if (onProgress == null) {
            null
        } else {
            object : AuroraSpeechPackInstallProgressSink {
                override fun onProgress(phase: String, completedBytes: Long, expectedBytes: Long) {
                    onProgress(phase, completedBytes, expectedBytes)
                }
            }
        }
        return nativeInstall(auroraSpeechPackStoreRoot(context).path, packId, task.nativeName, progressSink)
    }

    fun resolve(context: Context, packId: String, task: AuroraSpeechPackTask): Boolean =
        nativeResolve(auroraSpeechPackStoreRoot(context).path, packId, task.nativeName)

    fun remove(context: Context, packId: String, task: AuroraSpeechPackTask): Boolean =
        nativeRemove(auroraSpeechPackStoreRoot(context).path, packId, task.nativeName)

    fun embeddedCatalogJson(): String =
        nativeEmbeddedCatalogJson()

    fun installedPackIds(context: Context): Set<String>? {
        val payload = nativeInstalledPackIdsJson(auroraSpeechPackStoreRoot(context).path)
            ?: return null
        val entries = runCatching { JSONArray(payload) }.getOrNull() ?: return null
        val packIds = mutableSetOf<String>()
        for (index in 0 until entries.length()) {
            entries.optString(index).trim().takeIf { it.isNotEmpty() }?.let(packIds::add)
        }
        return packIds
    }

    private external fun nativeInstall(
        root: String,
        packId: String,
        task: String,
        progressSink: AuroraSpeechPackInstallProgressSink?,
    ): Boolean
    private external fun nativeResolve(root: String, packId: String, task: String): Boolean
    private external fun nativeRemove(root: String, packId: String, task: String): Boolean
    private external fun nativeEmbeddedCatalogJson(): String
    private external fun nativeInstalledPackIdsJson(root: String): String?

    init {
        System.loadLibrary("aurora_tauri_lib")
    }
}

internal interface AuroraSpeechPackInstallProgressSink {
    fun onProgress(phase: String, completedBytes: Long, expectedBytes: Long)
}
