package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.voice.VoiceInteractionService
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val ASSISTANT_ROLE_REQUEST_CODE = 4202
private const val ANDROID_PERMISSION_REQUEST_CODE = 4204

@TauriPlugin
class AuroraNativePlugin(private val activity: Activity) : Plugin(activity) {
    private var lastAssistantRoleDenied: Boolean = false

    @Command
    fun nativeCapabilityManifest(invoke: Invoke) {
        val assistantRole = assistantRoleStatusObject()
        val microphoneGranted = hasRuntimePermission(Manifest.permission.RECORD_AUDIO)
        val notificationsGranted = hasPostNotificationsPermission()
        val foregroundServiceReady = hasForegroundServiceMicrophonePermission() && microphoneGranted
        val voiceForeground = voiceForegroundServiceStatusObject(microphoneGranted, notificationsGranted, foregroundServiceReady)
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
        permissions.put("aurora.android.microphoneRequest", !microphoneGranted)
        permissions.put("aurora.android.notifications", notificationsGranted)
        permissions.put("aurora.android.notificationsRequest", !notificationsGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        permissions.put("aurora.android.biometric", biometricReady)
        permissions.put("aurora.android.localNetwork", localNetworkReady)
        permissions.put("aurora.android.foregroundServiceMicrophone", foregroundServiceReady)
        permissions.put("aurora.android.voiceForegroundService", foregroundServiceReady)
        permissions.put("aurora.android.voiceForegroundStart", voiceForeground.getBoolean("startable"))
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
        capabilities.put("android.microphonePermissionRequest", !microphoneGranted)
        capabilities.put("android.notifications", notificationsGranted)
        capabilities.put("android.notificationPermissionRequest", !notificationsGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        capabilities.put("android.biometric", biometricReady)
        capabilities.put("android.localNetwork", localNetworkReady)
        capabilities.put("android.foregroundService", foregroundServiceReady)
        capabilities.put("android.voiceForegroundService", foregroundServiceReady)
        capabilities.put("android.voiceForegroundService.running", voiceForeground.getBoolean("running"))
        capabilities.put("android.voiceForegroundService.start", voiceForeground.getBoolean("startable"))
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
        permissionStates.put("aurora.android.microphoneRequest", permissionRequestState(microphoneGranted, true))
        permissionStates.put("aurora.android.notifications", permissionState(notificationsGranted))
        permissionStates.put("aurora.android.notificationsRequest", permissionRequestState(notificationsGranted, Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU))
        permissionStates.put("aurora.android.biometric", if (biometricReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.localNetwork", if (localNetworkReady) "available" else "degraded")
        permissionStates.put("aurora.android.foregroundServiceMicrophone", permissionState(foregroundServiceReady))
        permissionStates.put("aurora.android.voiceForegroundService", permissionState(foregroundServiceReady))
        permissionStates.put("aurora.android.voiceForegroundStart", if (voiceForeground.getBoolean("startable")) "available" else voiceForeground.getString("state"))
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
        capabilityStates.put("android.microphonePermissionRequest", permissionRequestState(microphoneGranted, true))
        capabilityStates.put("android.notifications", permissionState(notificationsGranted))
        capabilityStates.put("android.notificationPermissionRequest", permissionRequestState(notificationsGranted, Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU))
        capabilityStates.put("android.biometric", if (biometricReady) "available" else "unsupported_platform")
        capabilityStates.put("android.localNetwork", if (localNetworkReady) "available" else "degraded")
        capabilityStates.put("android.foregroundService", permissionState(foregroundServiceReady))
        capabilityStates.put("android.voiceForegroundService", voiceForeground.getString("state"))
        capabilityStates.put("android.voiceForegroundService.running", if (voiceForeground.getBoolean("running")) "available" else "degraded")
        capabilityStates.put("android.voiceForegroundService.start", if (voiceForeground.getBoolean("startable")) "available" else voiceForeground.getString("state"))
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
        ret.put("voiceForegroundService", voiceForeground)
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

    @Command
    fun requestAndroidPermission(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidPermissionRequestArgs::class.java)
        val permissions = runtimePermissionsFor(args.permission)
        if (permissions.isEmpty()) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("permission", args.permission)
            ret.put("reason", "unsupported_or_manifest_only_permission")
            ret.put("manifest", nativeCapabilitySnapshot())
            invoke.resolve(ret)
            return
        }

        val missing = permissions.filterNot { hasRuntimePermission(it) }.toTypedArray()
        if (missing.isEmpty()) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("permission", args.permission)
            ret.put("reason", "already_granted")
            ret.put("manifest", nativeCapabilitySnapshot())
            invoke.resolve(ret)
            return
        }

        ActivityCompat.requestPermissions(activity, missing, ANDROID_PERMISSION_REQUEST_CODE)
        val ret = JSObject()
        ret.put("started", true)
        ret.put("permission", args.permission)
        ret.put("requestCode", ANDROID_PERMISSION_REQUEST_CODE)
        val requestedPermissions = JSArray()
        missing.forEach { requestedPermissions.put(it) }
        ret.put("requestedPermissions", requestedPermissions)
        invoke.resolve(ret)
    }

    @Command
    fun voiceForegroundServiceStatus(invoke: Invoke) {
        invoke.resolve(voiceForegroundServiceStatusObject())
    }

    @Command
    fun startVoiceForegroundService(invoke: Invoke) {
        val status = voiceForegroundServiceStatusObject()
        if (!status.getBoolean("startable")) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", status.getString("reason"))
            invoke.resolve(ret)
            return
        }

        val intent = Intent(activity, AuroraVoiceForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
        val ret = JSObject()
        ret.put("started", true)
        ret.put("status", voiceForegroundServiceStatusObject())
        ret.put("reason", "foreground_service_start_requested")
        invoke.resolve(ret)
    }

    @Command
    fun stopVoiceForegroundService(invoke: Invoke) {
        val stopped = activity.stopService(Intent(activity, AuroraVoiceForegroundService::class.java))
        val ret = JSObject()
        ret.put("stopped", stopped)
        ret.put("status", voiceForegroundServiceStatusObject())
        ret.put("reason", if (stopped) "foreground_service_stop_requested" else "foreground_service_not_running")
        invoke.resolve(ret)
    }

    private fun assistantRoleStatusObject(): JSObject {
        val sdkSupportsRole = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val roleManager = roleManagerOrNull()
        val roleAvailable = roleManager?.isRoleAvailable(RoleManager.ROLE_ASSISTANT) == true
        val roleHeld = roleManager?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true
        val handlesAssistActivity = packageHandlesAssist()
        val declaresVoiceInteractionService = packageDeclaresVoiceInteractionService()
        val packageQualified = handlesAssistActivity && declaresVoiceInteractionService
        val requestable = roleAvailable && packageQualified && !roleHeld
        val oemUnavailable = sdkSupportsRole && !roleAvailable

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("roleName", RoleManager.ROLE_ASSISTANT)
        ret.put("sdkSupportsRole", sdkSupportsRole)
        ret.put("handlesAssistActivity", handlesAssistActivity)
        ret.put("declaresVoiceInteractionService", declaresVoiceInteractionService)
        ret.put("roleAvailable", roleAvailable)
        ret.put("packageQualified", packageQualified)
        ret.put("roleHeld", roleHeld)
        ret.put("requestable", requestable)
        ret.put("denied", lastAssistantRoleDenied)
        ret.put("oemUnavailable", oemUnavailable)
        ret.put("fallbackAvailable", true)
        ret.put("reason", assistantRoleReason(sdkSupportsRole, roleAvailable, packageQualified, roleHeld, oemUnavailable))
        ret.put("evidenceSource", "android-rolemanager-package-manager")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun assistantRoleReason(
        sdkSupportsRole: Boolean,
        roleAvailable: Boolean,
        packageQualified: Boolean,
        roleHeld: Boolean,
        oemUnavailable: Boolean,
    ): String {
        if (roleHeld) return "role_held"
        if (lastAssistantRoleDenied) return "request_denied"
        if (oemUnavailable) return "oem_unavailable"
        if (!sdkSupportsRole) return "unsupported_platform"
        if (!roleAvailable) return "unsupported_platform"
        if (!packageQualified) return "package_not_qualified"
        return "requestable"
    }

    private fun fallbackEntrypointsArray(): JSArray {
        val fallbacks = JSArray()
        fallbacks.put(fallback("app_open", "fallback", true, "android.deepLink", null, "available without assistant role"))
        fallbacks.put(fallback("push_to_talk", "degraded", hasRuntimePermission(Manifest.permission.RECORD_AUDIO), "android.microphoneCapture", "aurora.android.microphone", "requires microphone permission and backend audio evidence"))
        fallbacks.put(fallback("foreground_voice_controls", "degraded", voiceForegroundServiceStatusObject().getBoolean("startable"), "android.voiceForegroundService", "aurora.android.voiceForegroundService", "requires microphone plus Android foreground-service microphone readiness"))
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
        val services = activity.packageManager.queryIntentServices(
            intent,
            PackageManager.MATCH_DISABLED_COMPONENTS or PackageManager.GET_META_DATA,
        )
        return services.any { service ->
            service.serviceInfo?.enabled == true &&
                service.serviceInfo?.permission == Manifest.permission.BIND_VOICE_INTERACTION &&
                service.serviceInfo?.metaData?.containsKey(VoiceInteractionService.SERVICE_META_DATA) == true
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

    private fun voiceForegroundServiceStatusObject(
        microphoneGranted: Boolean = hasRuntimePermission(Manifest.permission.RECORD_AUDIO),
        notificationsGranted: Boolean = hasPostNotificationsPermission(),
        foregroundServiceReady: Boolean = hasForegroundServiceMicrophonePermission() && microphoneGranted,
    ): JSObject {
        val manifestReady = hasPackagePermission(Manifest.permission.FOREGROUND_SERVICE) &&
            (Build.VERSION.SDK_INT < 34 || hasPackagePermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE))
        val startable = microphoneGranted && foregroundServiceReady && manifestReady
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("running", AuroraVoiceForegroundService.running)
        ret.put("startable", startable)
        ret.put("microphoneGranted", microphoneGranted)
        ret.put("notificationsGranted", notificationsGranted)
        ret.put("foregroundServiceReady", foregroundServiceReady)
        ret.put("manifestReady", manifestReady)
        ret.put("state", voiceForegroundState(startable, manifestReady, microphoneGranted, notificationsGranted))
        ret.put("reason", voiceForegroundReason(startable, manifestReady, microphoneGranted, notificationsGranted))
        ret.put("privacyClass", "raw-audio")
        ret.put("backendAudioEvidenceRequired", true)
        ret.put("evidenceSource", "android-permission-foreground-service")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun voiceForegroundState(
        startable: Boolean,
        manifestReady: Boolean,
        microphoneGranted: Boolean,
        notificationsGranted: Boolean,
    ): String {
        if (!manifestReady) return "unsupported_platform"
        if (!microphoneGranted) return "needs_native_permission"
        if (!notificationsGranted) return "degraded"
        if (startable) return "available"
        return "degraded"
    }

    private fun voiceForegroundReason(
        startable: Boolean,
        manifestReady: Boolean,
        microphoneGranted: Boolean,
        notificationsGranted: Boolean,
    ): String {
        if (!manifestReady) return "foreground_service_manifest_missing"
        if (!microphoneGranted) return "microphone_permission_missing"
        if (!notificationsGranted) return "notification_permission_missing"
        if (startable) return "foreground_service_startable"
        return "foreground_service_degraded"
    }

    private fun nativeCapabilitySnapshot(): JSObject {
        val ret = JSObject()
        val microphoneGranted = hasRuntimePermission(Manifest.permission.RECORD_AUDIO)
        val notificationsGranted = hasPostNotificationsPermission()
        ret.put("microphoneGranted", microphoneGranted)
        ret.put("notificationsGranted", notificationsGranted)
        ret.put("foregroundService", voiceForegroundServiceStatusObject(microphoneGranted, notificationsGranted))
        ret.put("evidenceSource", "android-permission-foreground-service")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun runtimePermissionsFor(permission: String): List<String> =
        when (permission) {
            "aurora.android.microphone", "android.microphoneCapture" -> listOf(Manifest.permission.RECORD_AUDIO)
            "aurora.android.notifications", "android.notifications" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
            "aurora.android.voiceForegroundService", "android.voiceForegroundService" ->
                listOfNotNull(
                    Manifest.permission.RECORD_AUDIO,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.POST_NOTIFICATIONS else null,
                )
            else -> emptyList()
        }

    private fun hasBiometricCapability(): Boolean {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (keyguard?.isDeviceSecure == true) return true
        return activity.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) ||
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_FACE) ||
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_IRIS)
    }

    private fun permissionState(granted: Boolean): String =
        if (granted) "available" else "needs_native_permission"

    private fun permissionRequestState(granted: Boolean, requestable: Boolean): String =
        if (granted) "available" else if (requestable) "needs_native_permission" else "unsupported_platform"

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

class AndroidPermissionRequestArgs {
    var permission: String = ""
}
