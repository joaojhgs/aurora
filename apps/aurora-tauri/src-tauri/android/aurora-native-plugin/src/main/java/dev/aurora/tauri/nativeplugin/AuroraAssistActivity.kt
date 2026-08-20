package dev.aurora.tauri.nativeplugin

import android.app.Activity
import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings

class AuroraAssistActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!isAuroraAssistantRoleHeld()) {
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

    private fun isAuroraAssistantRoleHeld(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java) ?: return false
            return roleManager.isRoleHeld(RoleManager.ROLE_ASSISTANT)
        }
        @Suppress("DEPRECATION")
        val flattened = Settings.Secure.getString(contentResolver, "assistant") ?: return false
        val assistant = ComponentName.unflattenFromString(flattened) ?: return false
        return assistant.packageName == packageName
    }
}
