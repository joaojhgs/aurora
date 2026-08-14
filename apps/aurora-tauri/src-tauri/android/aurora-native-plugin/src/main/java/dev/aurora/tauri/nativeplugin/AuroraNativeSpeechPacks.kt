package dev.aurora.tauri.nativeplugin

import android.content.Context
import java.io.File
import java.util.Locale

internal const val AURORA_SPEECH_PACK_STORE_DIR = "aurora_speech_packs"
internal const val AURORA_SPEECH_PACK_PREFS = "aurora_voice_pack_cache"
internal const val AURORA_SPEECH_PACK_LEGACY_ACTIVE_ID_KEY = "active_voice_pack_id"
internal const val AURORA_WAKE_PHRASE_ID_KEY = "wake_phrase_id"
internal const val AURORA_WAKE_PHRASE_TEXT_KEY = "wake_phrase_text"
internal const val AURORA_WAKE_PHRASE_REVISION_KEY = "wake_phrase_revision"

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

internal object AuroraNativeSpeechPackBridge {
    fun install(context: Context, packId: String, task: AuroraSpeechPackTask): Boolean =
        nativeInstall(auroraSpeechPackStoreRoot(context).path, packId, task.nativeName)

    fun resolve(context: Context, packId: String, task: AuroraSpeechPackTask): Boolean =
        nativeResolve(auroraSpeechPackStoreRoot(context).path, packId, task.nativeName)

    fun remove(context: Context, packId: String, task: AuroraSpeechPackTask): Boolean =
        nativeRemove(auroraSpeechPackStoreRoot(context).path, packId, task.nativeName)

    private external fun nativeInstall(root: String, packId: String, task: String): Boolean
    private external fun nativeResolve(root: String, packId: String, task: String): Boolean
    private external fun nativeRemove(root: String, packId: String, task: String): Boolean

    init {
        System.loadLibrary("aurora_tauri_lib")
    }
}
