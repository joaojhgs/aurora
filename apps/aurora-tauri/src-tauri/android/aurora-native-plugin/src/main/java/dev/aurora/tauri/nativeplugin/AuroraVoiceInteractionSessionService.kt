package dev.aurora.tauri.nativeplugin

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService

class AuroraVoiceInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession =
        AuroraVoiceInteractionSession(this)
}

private class AuroraVoiceInteractionSession(
    context: Context,
) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        val roleManager = context.getSystemService(RoleManager::class.java)
        if (roleManager?.isRoleHeld(RoleManager.ROLE_ASSISTANT) != true) {
            hide()
            return
        }
        val intent = Intent(this@AuroraVoiceInteractionSession.context, AuroraVoiceForegroundService::class.java).apply {
            action = AuroraVoiceForegroundService.ACTION_START_ASSISTANT
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                this@AuroraVoiceInteractionSession.context.startForegroundService(intent)
            } else {
                @Suppress("DEPRECATION")
                this@AuroraVoiceInteractionSession.context.startService(intent)
            }
        }
        hide()
    }
}
