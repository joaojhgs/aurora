package dev.aurora.tauri.nativeplugin

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.util.Log

class AuroraVoiceInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession =
        AuroraVoiceInteractionSession(this)
}

private class AuroraVoiceInteractionSession(
    context: Context,
) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            hide()
            return
        }
        if (!context.isAuroraAssistantRoleHeld()) {
            hide()
            return
        }
        val intent = Intent(this@AuroraVoiceInteractionSession.context, AuroraRuntimeForegroundService::class.java).apply {
            action = AuroraRuntimeForegroundService.ACTION_START_ASSISTANT
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                this@AuroraVoiceInteractionSession.context.startForegroundService(intent)
            } else {
                @Suppress("DEPRECATION")
                this@AuroraVoiceInteractionSession.context.startService(intent)
            }
        }.onFailure { error ->
            Log.w("AuroraVoiceSession", "voice_service_start_failed error=${error.javaClass.simpleName}")
        }
        hide()
    }
}
