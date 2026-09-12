package dev.aurora.tauri.nativeplugin

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.provider.Settings

/**
 * Returns whether Android currently selects Aurora as the assistant.
 *
 * RoleManager is authoritative when it reports the role as held. Some OEM
 * builds and Waydroid can briefly report false while the secure assistant
 * component already names Aurora, so that platform-owned setting is accepted
 * as a narrow compatibility source. Both sources must identify this package.
 */
internal fun Context.isAuroraAssistantRoleHeld(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val roleManager = getSystemService(RoleManager::class.java)
        if (roleManager?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true) {
            return true
        }
    }
    return selectedAssistantPackageName() == packageName
}

private fun Context.selectedAssistantPackageName(): String? {
    @Suppress("DEPRECATION")
    val flattened = Settings.Secure.getString(contentResolver, "assistant") ?: return null
    return ComponentName.unflattenFromString(flattened)?.packageName
}
