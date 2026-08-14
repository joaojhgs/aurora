package dev.aurora.tauri.nativeplugin

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle

class AuroraAssistActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val serviceIntent = Intent(this, AuroraVoiceForegroundService::class.java).apply {
            action = AuroraVoiceForegroundService.ACTION_START_ASSISTANT
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
