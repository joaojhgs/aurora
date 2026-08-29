package dev.aurora.tauri.nativeplugin

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle

class AuroraAssistActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!applicationContext.isAuroraAssistantRoleHeld()) {
            finish()
            return
        }
        val serviceIntent = Intent(this, AuroraRuntimeForegroundService::class.java).apply {
            action = AuroraRuntimeForegroundService.ACTION_START_ASSISTANT
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            @Suppress("DEPRECATION")
            startService(serviceIntent)
        }
        finish()
    }

}
