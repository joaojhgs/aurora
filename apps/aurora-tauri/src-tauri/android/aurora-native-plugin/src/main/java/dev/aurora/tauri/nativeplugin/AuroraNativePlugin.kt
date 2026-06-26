package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.voice.VoiceInteractionService
import androidx.core.content.ContextCompat
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
        val microphoneGranted = hasRuntimePermission(Manifest.permission.RECORD_AUDIO)
        val notificationsGranted = hasPostNotificationsPermission()
        val foregroundServiceReady = hasForegroundServiceMicrophonePermission() && microphoneGranted
        val biometricReady = hasBiometricCapability()
        val localNetworkReady = hasPackagePermission(Manifest.permission.INTERNET) &&
            hasPackagePermission(Manifest.permission.ACCESS_NETWORK_STATE)
        val assistantRoleRequestable = assistantRole.getBoolean("requestable")
        val assistantRoleHeld = assistantRole.getBoolean("roleHeld")
        val assistantRoleAvailable = assistantRole.getBoolean("roleAvailable")
        val assistantRolePackageQualified = assistantRole.getBoolean("packageQualified")
        val assistantRoleDenied = assistantRole.getBoolean("denied")
        val assistantRoleOemUnavailable = assistantRole.getBoolean("oemUnavailable")

        val permissions = JSObject()
        permissions.put("aurora.android.assistantRoleStatus", true)
        permissions.put("aurora.android.assistantRoleRequest", assistantRoleRequestable)
        permissions.put("aurora.android.microphone", microphoneGranted)
        permissions.put("aurora.android.notifications", notificationsGranted)
        permissions.put("aurora.android.biometric", biometricReady)
        permissions.put("aurora.android.localNetwork", localNetworkReady)
        permissions.put("aurora.android.foregroundServiceMicrophone", foregroundServiceReady)
        permissions.put("aurora.android.localFileRead", false)
        permissions.put("aurora.android.localFileWrite", false)
        permissions.put("aurora.android.filePick", false)
        permissions.put("aurora.android.shareIntent", true)
        permissions.put("aurora.android.deepLink", true)

        val capabilities = JSObject()
        capabilities.put("android.assistantRole.status", true)
        capabilities.put("android.assistantRole.available", assistantRoleAvailable)
        capabilities.put("android.assistantRole.packageQualified", assistantRolePackageQualified)
        capabilities.put("android.assistantRole.request", assistantRoleRequestable)
        capabilities.put("android.assistantRole.held", assistantRoleHeld)
        capabilities.put("android.assistantRole.denied", assistantRoleDenied)
        capabilities.put("android.assistantRole.oemUnavailable", assistantRoleOemUnavailable)
        capabilities.put("android.microphoneCapture", microphoneGranted)
        capabilities.put("android.notifications", notificationsGranted)
        capabilities.put("android.biometric", biometricReady)
        capabilities.put("android.localNetwork", localNetworkReady)
        capabilities.put("android.foregroundService", foregroundServiceReady)
        capabilities.put("android.localFileRead", false)
        capabilities.put("android.localFileWrite", false)
        capabilities.put("android.filePick", false)
        capabilities.put("android.shareIntent", true)
        capabilities.put("android.deepLink", true)
        capabilities.put("android.fallbackEntrypoints", true)

        val permissionStates = JSObject()
        permissionStates.put("aurora.android.assistantRoleStatus", "available")
        permissionStates.put("aurora.android.assistantRoleRequest", assistantRoleState(assistantRole))
        permissionStates.put("aurora.android.microphone", permissionState(microphoneGranted))
        permissionStates.put("aurora.android.notifications", permissionState(notificationsGranted))
        permissionStates.put("aurora.android.biometric", if (biometricReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.localNetwork", if (localNetworkReady) "available" else "degraded")
        permissionStates.put("aurora.android.foregroundServiceMicrophone", permissionState(foregroundServiceReady))
        permissionStates.put("aurora.android.localFileRead", "degraded")
        permissionStates.put("aurora.android.localFileWrite", "degraded")
        permissionStates.put("aurora.android.filePick", "degraded")
        permissionStates.put("aurora.android.shareIntent", "available")
        permissionStates.put("aurora.android.deepLink", "available")

        val capabilityStates = JSObject()
        capabilityStates.put("android.assistantRole.status", "available")
        capabilityStates.put("android.assistantRole.available", if (assistantRoleAvailable) "available" else "unsupported_platform")
        capabilityStates.put("android.assistantRole.packageQualified", if (assistantRolePackageQualified) "available" else "degraded")
        capabilityStates.put("android.assistantRole.request", assistantRoleState(assistantRole))
        capabilityStates.put("android.assistantRole.held", if (assistantRoleHeld) "available" else "needs_native_permission")
        capabilityStates.put("android.assistantRole.denied", if (assistantRoleDenied) "needs_native_permission" else "degraded")
        capabilityStates.put("android.assistantRole.oemUnavailable", if (assistantRoleOemUnavailable) "unsupported_platform" else "degraded")
        capabilityStates.put("android.microphoneCapture", permissionState(microphoneGranted))
        capabilityStates.put("android.notifications", permissionState(notificationsGranted))
        capabilityStates.put("android.biometric", if (biometricReady) "available" else "unsupported_platform")
        capabilityStates.put("android.localNetwork", if (localNetworkReady) "available" else "degraded")
        capabilityStates.put("android.foregroundService", permissionState(foregroundServiceReady))
        capabilityStates.put("android.localFileRead", "degraded")
        capabilityStates.put("android.localFileWrite", "degraded")
        capabilityStates.put("android.filePick", "degraded")
        capabilityStates.put("android.shareIntent", "available")
        capabilityStates.put("android.deepLink", "available")
        capabilityStates.put("android.fallbackEntrypoints", "fallback")

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("permissions", permissions)
        ret.put("capabilities", capabilities)
        ret.put("permissionStates", permissionStates)
        ret.put("capabilityStates", capabilityStates)
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
            roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT),
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
        val ret = JSObject()
        ret.put("fallbackEntrypoints", fallbackEntrypointsArray())
        ret.put("evidenceSource", "android-rolemanager-package-manager")
        ret.put("secretsRedacted", true)
        invoke.resolve(ret)
    }

    private fun assistantRoleStatusObject(): JSObject {
        val sdkSupportsRole = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val roleManager = roleManagerOrNull()
        val roleAvailable = roleManager?.isRoleAvailable(RoleManager.ROLE_ASSISTANT) == true
        val roleHeld = roleManager?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true
        val packageQualified = packageHandlesAssist() || packageDeclaresVoiceInteractionService()
        val requestable = roleAvailable && packageQualified && !roleHeld
        val oemUnavailable = sdkSupportsRole && !roleAvailable

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("roleName", RoleManager.ROLE_ASSISTANT)
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
        fallbacks.put(fallback("app_open", "fallback", true, "android.deepLink", null, "available without assistant role"))
        fallbacks.put(fallback("push_to_talk", "degraded", hasRuntimePermission(Manifest.permission.RECORD_AUDIO), "android.microphoneCapture", "aurora.android.microphone", "requires microphone permission and backend audio evidence"))
        fallbacks.put(fallback("notification", "fallback", hasPostNotificationsPermission(), "android.notifications", "aurora.android.notifications", "requires notification permission on Android 13+"))
        fallbacks.put(fallback("quick_tile", "degraded", true, "android.fallbackEntrypoints", null, "planned Android quick tile entrypoint; not assistant-role dependent"))
        fallbacks.put(fallback("share_intent", "fallback", true, "android.shareIntent", "aurora.android.shareIntent", "available without assistant role"))
        fallbacks.put(fallback("deep_link", "fallback", true, "android.deepLink", "aurora.android.deepLink", "available without assistant role"))
        return fallbacks
    }

    private fun fallback(
        id: String,
        state: String,
        available: Boolean,
        capability: String,
        permission: String?,
        reason: String,
    ): JSObject {
        val ret = JSObject()
        ret.put("id", id)
        ret.put("state", if (available) state else "needs_native_permission")
        ret.put("available", available)
        ret.put("capability", capability)
        ret.put("permission", permission)
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

    private fun hasRuntimePermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

    private fun hasPackagePermission(permission: String): Boolean =
        activity.packageManager.checkPermission(permission, activity.packageName) == PackageManager.PERMISSION_GRANTED

    private fun roleManagerOrNull(): RoleManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            activity.getSystemService(RoleManager::class.java)
        } else {
            null
        }

    private fun hasPostNotificationsPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasRuntimePermission(Manifest.permission.POST_NOTIFICATIONS)

    private fun hasForegroundServiceMicrophonePermission(): Boolean =
        Build.VERSION.SDK_INT < 34 || hasRuntimePermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE)

    private fun hasBiometricCapability(): Boolean {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (keyguard?.isDeviceSecure == true) return true
        return activity.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) ||
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_FACE) ||
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_IRIS)
    }

    private fun permissionState(granted: Boolean): String =
        if (granted) "available" else "needs_native_permission"

    private fun assistantRoleState(status: JSObject): String {
        if (status.getBoolean("roleHeld")) return "available"
        if (status.getBoolean("requestable")) return "needs_native_permission"
        if (status.getBoolean("oemUnavailable")) return "unsupported_platform"
        if (status.getBoolean("denied")) return "needs_native_permission"
        return "degraded"
    }
}

class AssistantRoleResultArgs {
    var resultCode: Int = Activity.RESULT_CANCELED
}
