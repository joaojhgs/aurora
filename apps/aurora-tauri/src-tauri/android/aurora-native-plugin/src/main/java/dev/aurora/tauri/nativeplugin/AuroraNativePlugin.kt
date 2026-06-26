package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.voice.VoiceInteractionService
import androidx.core.content.ContextCompat
import androidx.core.role.RoleManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val ASSISTANT_ROLE_REQUEST_CODE = 4202

@TauriPlugin
class AuroraNativePlugin(private val activity: Activity) : Plugin(activity) {
    private var lastAssistantRoleDenied: Boolean = false

    @Command
    fun nativeCapabilityManifest(invoke: Invoke) {
        val assistantRole = assistantRoleStatusObject()
        val permissions = JSObject()
        permissions.put("aurora.android.assistantRoleStatus", true)
        permissions.put("aurora.android.assistantRoleRequest", assistantRole.getBoolean("requestable"))
        permissions.put("aurora.android.microphone", hasPermission(Manifest.permission.RECORD_AUDIO))
        permissions.put("aurora.android.notifications", hasPostNotificationsPermission())
        permissions.put("aurora.android.foregroundServiceMicrophone", hasForegroundServiceMicrophonePermission())
        permissions.put("aurora.android.shareIntent", true)
        permissions.put("aurora.android.deepLink", true)

        val capabilities = JSObject()
        capabilities.put("android.assistantRole.status", true)
        capabilities.put("android.assistantRole.request", assistantRole.getBoolean("requestable"))
        capabilities.put("android.assistantRole.held", assistantRole.getBoolean("roleHeld"))
        capabilities.put("android.microphoneCapture", hasPermission(Manifest.permission.RECORD_AUDIO))
        capabilities.put("android.notifications", hasPostNotificationsPermission())
        capabilities.put("android.foregroundService", hasForegroundServiceMicrophonePermission())
        capabilities.put("android.shareIntent", true)
        capabilities.put("android.deepLink", true)
        capabilities.put("android.fallbackEntrypoints", true)

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("permissions", permissions)
        ret.put("capabilities", capabilities)
        ret.put("assistantRole", assistantRole)
        ret.put("fallbackEntrypoints", fallbackEntrypointsArray())
        ret.put("evidenceSource", "android-rolemanager-package-manager")
        ret.put("secretsRedacted", true)
        invoke.resolve(ret)
    }

    @Command
    fun assistantRoleStatus(invoke: Invoke) {
        invoke.resolve(assistantRoleStatusObject())
    }

    @Command
    fun requestAssistantRole(invoke: Invoke) {
        val status = assistantRoleStatusObject()
        if (!status.getBoolean("requestable")) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", status.getString("reason"))
            invoke.resolve(ret)
            return
        }

        val roleManager = roleManagerOrNull()
        if (roleManager == null) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", "role_manager_unavailable")
            invoke.resolve(ret)
            return
        }

        activity.startActivityForResult(
            roleManager.createRequestRoleIntent(RoleManagerCompat.ROLE_ASSISTANT),
            ASSISTANT_ROLE_REQUEST_CODE,
        )
        val ret = JSObject()
        ret.put("started", true)
        ret.put("requestCode", ASSISTANT_ROLE_REQUEST_CODE)
        ret.put("status", status)
        invoke.resolve(ret)
    }

    @Command
    fun recordAssistantRoleResult(invoke: Invoke) {
        val args = invoke.parseArgs(AssistantRoleResultArgs::class.java)
        lastAssistantRoleDenied = args.resultCode != Activity.RESULT_OK
        invoke.resolve(assistantRoleStatusObject())
    }

    @Command
    fun fallbackEntrypoints(invoke: Invoke) {
        invoke.resolve(fallbackEntrypointsArray())
    }

    private fun assistantRoleStatusObject(): JSObject {
        val sdkSupportsRole = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val roleManager = roleManagerOrNull()
        val roleAvailable = roleManager?.isRoleAvailable(RoleManagerCompat.ROLE_ASSISTANT) == true
        val roleHeld = roleManager?.isRoleHeld(RoleManagerCompat.ROLE_ASSISTANT) == true
        val packageQualified = packageHandlesAssist() || packageDeclaresVoiceInteractionService()
        val requestable = roleAvailable && packageQualified && !roleHeld
        val oemUnavailable = sdkSupportsRole && !roleAvailable

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("roleName", RoleManagerCompat.ROLE_ASSISTANT)
        ret.put("roleAvailable", roleAvailable)
        ret.put("packageQualified", packageQualified)
        ret.put("roleHeld", roleHeld)
        ret.put("requestable", requestable)
        ret.put("denied", lastAssistantRoleDenied)
        ret.put("oemUnavailable", oemUnavailable)
        ret.put("fallbackAvailable", true)
        ret.put("reason", assistantRoleReason(roleAvailable, packageQualified, roleHeld, oemUnavailable))
        ret.put("evidenceSource", "android-rolemanager-package-manager")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun assistantRoleReason(
        roleAvailable: Boolean,
        packageQualified: Boolean,
        roleHeld: Boolean,
        oemUnavailable: Boolean,
    ): String {
        if (roleHeld) return "role_held"
        if (lastAssistantRoleDenied) return "request_denied"
        if (oemUnavailable) return "oem_unavailable"
        if (!roleAvailable) return "unsupported_platform"
        if (!packageQualified) return "package_not_qualified"
        return "requestable"
    }

    private fun fallbackEntrypointsArray(): JSArray {
        val fallbacks = JSArray()
        fallbacks.put(fallback("push_to_talk", "degraded", hasPermission(Manifest.permission.RECORD_AUDIO), "requires microphone permission and backend audio evidence"))
        fallbacks.put(fallback("share_intent", "fallback", true, "available without assistant role"))
        fallbacks.put(fallback("deep_link", "fallback", true, "available without assistant role"))
        return fallbacks
    }

    private fun fallback(id: String, state: String, available: Boolean, reason: String): JSObject {
        val ret = JSObject()
        ret.put("id", id)
        ret.put("state", if (available) state else "needs_native_permission")
        ret.put("available", available)
        ret.put("reason", reason)
        return ret
    }

    private fun packageHandlesAssist(): Boolean {
        val intent = Intent(Intent.ACTION_ASSIST).setPackage(activity.packageName)
        val activities = activity.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        return activities.isNotEmpty()
    }

    private fun packageDeclaresVoiceInteractionService(): Boolean {
        val intent = Intent(VoiceInteractionService.SERVICE_INTERFACE).setPackage(activity.packageName)
        val services = activity.packageManager.queryIntentServices(intent, PackageManager.MATCH_DISABLED_COMPONENTS)
        return services.any { service ->
            service.serviceInfo?.enabled == true &&
                service.serviceInfo?.permission == Manifest.permission.BIND_VOICE_INTERACTION
        }
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

    private fun roleManagerOrNull(): RoleManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            activity.getSystemService(RoleManager::class.java)
        } else {
            null
        }

    private fun hasPostNotificationsPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPermission(Manifest.permission.POST_NOTIFICATIONS)

    private fun hasForegroundServiceMicrophonePermission(): Boolean =
        Build.VERSION.SDK_INT < 34 || hasPermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE)
}

class AssistantRoleResultArgs {
    var resultCode: Int = Activity.RESULT_CANCELED
}
