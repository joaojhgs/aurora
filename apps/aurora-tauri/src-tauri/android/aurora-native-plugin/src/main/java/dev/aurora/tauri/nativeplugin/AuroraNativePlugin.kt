package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.service.voice.VoiceInteractionService
import android.util.Base64
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val ASSISTANT_ROLE_REQUEST_CODE = 4202
private const val ANDROID_PERMISSION_REQUEST_CODE = 4204
private const val ADMIN_UNLOCK_REQUEST_CODE = 4206
private const val SECURE_STORAGE_PREFS = "aurora_secure_storage"
private const val SECURE_STORAGE_KEY_ALIAS = "aurora_secure_storage_v1"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
private const val AES_GCM_TAG_BITS = 128

@TauriPlugin
class AuroraNativePlugin(private val activity: Activity) : Plugin(activity) {
    private var lastAssistantRoleDenied: Boolean = false
    private var lastAdminUnlockDenied: Boolean = false

    @Command
    fun nativeCapabilityManifest(invoke: Invoke) {
        val assistantRole = assistantRoleStatusObject()
        val entrypoints = entrypointsArray()
        val microphoneGranted = hasRuntimePermission(Manifest.permission.RECORD_AUDIO)
        val notificationsGranted = hasPostNotificationsPermission()
        val foregroundServiceReady = hasForegroundServiceMicrophonePermission() && microphoneGranted
        val voiceForeground = voiceForegroundServiceStatusObject(microphoneGranted, notificationsGranted, foregroundServiceReady)
        val biometricReady = hasBiometricCapability()
        val secureStorageReady = hasSecureStorageCapability()
        val adminUnlock = adminUnlockStatusObject()
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
        permissions.put("aurora.android.secureStorage", secureStorageReady)
        permissions.put("aurora.android.adminUnlock", adminUnlock.getBoolean("requestable"))
        permissions.put("aurora.android.localNetwork", localNetworkReady)
        permissions.put("aurora.android.foregroundServiceMicrophone", foregroundServiceReady)
        permissions.put("aurora.android.voiceForegroundService", foregroundServiceReady)
        permissions.put("aurora.android.voiceForegroundStart", voiceForeground.getBoolean("startable"))
        permissions.put("aurora.android.localFileRead", false)
        permissions.put("aurora.android.localFileWrite", false)
        permissions.put("aurora.android.filePick", false)
        permissions.put("aurora.android.shareIntent", true)
        permissions.put("aurora.android.deepLink", true)
        permissions.put("aurora.android.appWidget", true)
        permissions.put("aurora.android.appShortcut", true)
        permissions.put("aurora.android.quickTile", true)
        permissions.put("aurora.android.entrypointPayload", true)

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
        capabilities.put("android.secureCredentialStorage", secureStorageReady)
        capabilities.put("android.adminUnlock", adminUnlock.getBoolean("available"))
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
        capabilities.put("android.appWidget", true)
        capabilities.put("android.appShortcut", true)
        capabilities.put("android.quickTile", true)
        capabilities.put("android.entrypointPayload", true)
        capabilities.put("android.fallbackEntrypoints", true)

        val permissionStates = JSObject()
        permissionStates.put("aurora.android.assistantRoleStatus", "available")
        permissionStates.put("aurora.android.assistantRoleRequest", assistantRoleState(assistantRole))
        permissionStates.put("aurora.android.microphone", permissionState(microphoneGranted))
        permissionStates.put("aurora.android.microphoneRequest", permissionRequestState(microphoneGranted, true))
        permissionStates.put("aurora.android.notifications", permissionState(notificationsGranted))
        permissionStates.put("aurora.android.notificationsRequest", permissionRequestState(notificationsGranted, Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU))
        permissionStates.put("aurora.android.biometric", if (biometricReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.secureStorage", if (secureStorageReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.adminUnlock", adminUnlock.getString("state"))
        permissionStates.put("aurora.android.localNetwork", if (localNetworkReady) "available" else "degraded")
        permissionStates.put("aurora.android.foregroundServiceMicrophone", permissionState(foregroundServiceReady))
        permissionStates.put("aurora.android.voiceForegroundService", permissionState(foregroundServiceReady))
        permissionStates.put("aurora.android.voiceForegroundStart", if (voiceForeground.getBoolean("startable")) "available" else voiceForeground.getString("state"))
        permissionStates.put("aurora.android.localFileRead", "degraded")
        permissionStates.put("aurora.android.localFileWrite", "degraded")
        permissionStates.put("aurora.android.filePick", "degraded")
        permissionStates.put("aurora.android.shareIntent", "available")
        permissionStates.put("aurora.android.deepLink", "available")
        permissionStates.put("aurora.android.appWidget", "fallback")
        permissionStates.put("aurora.android.appShortcut", "fallback")
        permissionStates.put("aurora.android.quickTile", "fallback")
        permissionStates.put("aurora.android.entrypointPayload", "available")

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
        capabilityStates.put("android.secureCredentialStorage", if (secureStorageReady) "available" else "unsupported_platform")
        capabilityStates.put("android.adminUnlock", adminUnlock.getString("state"))
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
        capabilityStates.put("android.appWidget", "fallback")
        capabilityStates.put("android.appShortcut", "fallback")
        capabilityStates.put("android.quickTile", "fallback")
        capabilityStates.put("android.entrypointPayload", "available")
        capabilityStates.put("android.fallbackEntrypoints", "fallback")

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("permissions", permissions)
        ret.put("capabilities", capabilities)
        ret.put("permissionStates", permissionStates)
        ret.put("capabilityStates", capabilityStates)
        ret.put("mobileIntegrations", mobileIntegrationsArray())
        ret.put("entrypoints", entrypoints)
        ret.put("assistantRole", assistantRole)
        ret.put("voiceForegroundService", voiceForeground)
        ret.put("adminUnlock", adminUnlock)
        ret.put("secureStorage", secureStorageStatusObject())
        ret.put("fallbackEntrypoints", fallbackEntrypointsArray())
        ret.put("lastEntrypointPayload", lastEntrypointPayloadObject())
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
        ret.put("entrypoints", entrypointsArray())
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

    @Command
    fun entrypointPayload(invoke: Invoke) {
        val ret = JSObject()
        ret.put("payload", lastEntrypointPayloadObject())
        ret.put("entrypoints", entrypointsArray())
        ret.put("evidenceSource", "android-intent-redacted")
        ret.put("secretsRedacted", true)
        invoke.resolve(ret)
    }

    @Command
    fun secureStorageGet(invoke: Invoke) {
        val args = invoke.parseArgs(SecureStorageArgs::class.java)
        try {
            validateSecureStorageKey(args.key)
            val stored = securePrefs().getString(args.key, null)
            val value = stored?.let { decryptSecureValue(it) }
            val ret = secureStorageResult(args.key)
            ret.put("value", value)
            ret.put("found", stored != null)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "secure_storage_get_failed")
        }
    }

    @Command
    fun secureStorageSet(invoke: Invoke) {
        val args = invoke.parseArgs(SecureStorageArgs::class.java)
        try {
            validateSecureStorageKey(args.key)
            securePrefs().edit().putString(args.key, encryptSecureValue(args.value)).apply()
            val ret = secureStorageResult(args.key)
            ret.put("ok", true)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "secure_storage_set_failed")
        }
    }

    @Command
    fun secureStorageDelete(invoke: Invoke) {
        val args = invoke.parseArgs(SecureStorageArgs::class.java)
        try {
            validateSecureStorageKey(args.key)
            securePrefs().edit().remove(args.key).apply()
            val ret = secureStorageResult(args.key)
            ret.put("ok", true)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "secure_storage_delete_failed")
        }
    }

    @Command
    fun biometricAdminUnlockStatus(invoke: Invoke) {
        invoke.resolve(adminUnlockStatusObject())
    }

    @Command
    fun biometricAdminUnlock(invoke: Invoke) {
        val status = adminUnlockStatusObject()
        if (!status.getBoolean("requestable")) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", status.getString("reason"))
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
            return
        }

        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        val intent = keyguard?.createConfirmDeviceCredentialIntent(
            "Aurora admin confirmation",
            "Confirm device credentials to unlock admin-critical Aurora actions.",
        )
        if (intent == null) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", "credential_intent_unavailable")
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
            return
        }

        activity.startActivityForResult(intent, ADMIN_UNLOCK_REQUEST_CODE)
        val ret = JSObject()
        ret.put("started", true)
        ret.put("requestCode", ADMIN_UNLOCK_REQUEST_CODE)
        ret.put("status", status)
        ret.put("reason", "admin_unlock_requested")
        ret.put("secretsRedacted", true)
        invoke.resolve(ret)
    }

    @Command
    fun recordBiometricAdminUnlockResult(invoke: Invoke) {
        val args = invoke.parseArgs(AdminUnlockResultArgs::class.java)
        lastAdminUnlockDenied = args.resultCode != Activity.RESULT_OK
        invoke.resolve(adminUnlockStatusObject())
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
        fallbacks.put(fallback("app_open", "fallback", true, "android.deepLink", null, "available without assistant role", "android.intent.action.MAIN"))
        fallbacks.put(fallback("push_to_talk", "degraded", hasRuntimePermission(Manifest.permission.RECORD_AUDIO), "android.microphoneCapture", "aurora.android.microphone", "requires microphone permission and backend audio evidence"))
        fallbacks.put(fallback("foreground_voice_controls", "degraded", voiceForegroundServiceStatusObject().getBoolean("startable"), "android.voiceForegroundService", "aurora.android.voiceForegroundService", "requires microphone plus Android foreground-service microphone readiness"))
        fallbacks.put(fallback("notification", "fallback", hasPostNotificationsPermission(), "android.notifications", "aurora.android.notifications", "requires notification permission on Android 13+"))
        fallbacks.put(fallback("quick_tile", "fallback", true, "android.quickTile", "aurora.android.quickTile", "Quick Settings tile opens Aurora without assistant role", "android.service.quicksettings.action.QS_TILE"))
        fallbacks.put(fallback("app_widget", "fallback", true, "android.appWidget", "aurora.android.appWidget", "home-screen widget opens Aurora without assistant role", "android.appwidget.action.APPWIDGET_UPDATE"))
        fallbacks.put(fallback("app_shortcut", "fallback", true, "android.appShortcut", "aurora.android.appShortcut", "static launcher shortcut opens Aurora without assistant role", "android.intent.action.VIEW"))
        fallbacks.put(fallback("share_intent", "fallback", true, "android.shareIntent", "aurora.android.shareIntent", "share sheet opens Aurora and records redacted intent metadata", "android.intent.action.SEND"))
        fallbacks.put(fallback("deep_link", "fallback", true, "android.deepLink", "aurora.android.deepLink", "deep links open Aurora and record redacted URI metadata", "android.intent.action.VIEW"))
        return fallbacks
    }

    private fun fallback(
        id: String,
        state: String,
        available: Boolean,
        capability: String,
        permission: String?,
        reason: String,
        action: String? = null,
    ): JSObject {
        val ret = JSObject()
        ret.put("id", id)
        ret.put("state", if (available) state else "needs_native_permission")
        ret.put("available", available)
        ret.put("capability", capability)
        ret.put("permission", permission)
        ret.put("reason", reason)
        ret.put("manifestDeclared", available)
        ret.put("backendRequired", id == "share_intent" || id == "deep_link")
        if (action != null) ret.put("intentAction", action)
        return ret
    }

    private fun entrypointsArray(): JSArray {
        val entrypoints = JSArray()
        entrypoints.put(entrypoint("share_sheet", "Share sheet", "android.shareIntent", "aurora.android.shareIntent", "fallback", "android.intent.action.SEND", "text/*, image/*, application/pdf", true))
        entrypoints.put(entrypoint("share_sheet_multiple", "Share sheet multiple", "android.shareIntent", "aurora.android.shareIntent", "fallback", "android.intent.action.SEND_MULTIPLE", "image/*, application/pdf", true))
        entrypoints.put(entrypoint("process_text", "Selected text", "android.shareIntent", "aurora.android.shareIntent", "fallback", "android.intent.action.PROCESS_TEXT", "text/plain", true))
        entrypoints.put(entrypoint("deep_link", "Aurora deep link", "android.deepLink", "aurora.android.deepLink", "fallback", "android.intent.action.VIEW", "aurora://assistant and https://aurora.local/assistant", true))
        entrypoints.put(entrypoint("app_shortcut", "Launcher shortcut", "android.appShortcut", "aurora.android.appShortcut", "fallback", "android.intent.action.VIEW", "aurora://assistant/new", false))
        entrypoints.put(entrypoint("app_widget", "Home-screen widget", "android.appWidget", "aurora.android.appWidget", "fallback", "android.appwidget.action.APPWIDGET_UPDATE", "home_screen", false))
        entrypoints.put(entrypoint("quick_tile", "Quick Settings tile", "android.quickTile", "aurora.android.quickTile", "fallback", "android.service.quicksettings.action.QS_TILE", "qs_tile", false))
        return entrypoints
    }

    private fun entrypoint(
        id: String,
        label: String,
        capability: String,
        permission: String,
        state: String,
        action: String,
        intakeType: String,
        backendRequired: Boolean,
    ): JSObject {
        val ret = JSObject()
        ret.put("id", id)
        ret.put("platform", "android")
        ret.put("label", label)
        ret.put("state", state)
        ret.put("available", true)
        ret.put("capability", capability)
        ret.put("permission", permission)
        ret.put("intentAction", action)
        ret.put("intakeType", intakeType)
        ret.put("manifestDeclared", true)
        ret.put("backendRequired", backendRequired)
        ret.put("payloadCommand", "entrypointPayload")
        ret.put("reason", if (backendRequired) "native entrypoint is declared; backend intake must process redacted payload before Aurora claims action success" else "native fallback opens Aurora without assistant role")
        return ret
    }

    private fun mobileIntegrationsArray(): JSArray {
        val integrations = JSArray()
        integrations.put(mobileIntegration("androidShareSheet", "Android share sheet", "supported", "android.shareIntent", "aurora.android.shareIntent", "personal", "Share sheet intent filters are declared; payloads are redacted until backend context ingestion handles them."))
        integrations.put(mobileIntegration("androidDeepLinks", "Android deep links", "supported", "android.deepLink", "aurora.android.deepLink", "personal", "Aurora and https deep links are declared through Android intent filters."))
        integrations.put(mobileIntegration("androidStaticShortcut", "Android launcher shortcut", "supported", "android.appShortcut", "aurora.android.appShortcut", "personal", "Static shortcut metadata is packaged and opens Aurora through the native entrypoint activity."))
        integrations.put(mobileIntegration("androidWidget", "Android home-screen widget", "supported-path", "android.appWidget", "aurora.android.appWidget", "personal", "Widget provider is packaged; device launcher placement remains user/OEM controlled."))
        integrations.put(mobileIntegration("androidQuickTile", "Android Quick Settings tile", "supported-path", "android.quickTile", "aurora.android.quickTile", "personal", "Quick Settings tile service is packaged; tile placement remains user/OEM controlled."))
        return integrations
    }

    private fun mobileIntegration(
        id: String,
        label: String,
        support: String,
        capability: String,
        permission: String,
        privacyClass: String,
        userCopy: String,
    ): JSObject {
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("id", id)
        ret.put("label", label)
        ret.put("support", support)
        ret.put("capability", capability)
        ret.put("permission", permission)
        ret.put("privacyClass", privacyClass)
        ret.put("evidenceSource", "android-manifest-merge-native-plugin")
        ret.put("userCopy", userCopy)
        ret.put("verifier", "tauri android build plus emulator/device intent, shortcut, widget, and quick-tile invocation smoke")
        return ret
    }

    private fun lastEntrypointPayloadObject(): JSObject {
        val payload = AuroraEntrypointStore.lastPayload()
        val ret = JSObject()
        ret.put("source", payload.optString("source", "none"))
        ret.put("action", payload.opt("action"))
        ret.put("type", payload.opt("type"))
        ret.put("scheme", payload.opt("scheme"))
        ret.put("host", payload.opt("host"))
        ret.put("path", payload.opt("path"))
        ret.put("categories", payload.optJSONArray("categories") ?: JSArray())
        ret.put("extras", payload.optJSONArray("extras") ?: JSArray())
        ret.put("secretsRedacted", true)
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

    private fun secureStorageStatusObject(): JSObject {
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("available", hasSecureStorageCapability())
        ret.put("backend", "android-keystore")
        ret.put("persisted", true)
        ret.put("privacyClass", "credential")
        ret.put("allowedKeyPrefixes", "aurora.session,aurora.auth,aurora.gateway,aurora.mesh,aurora.admin")
        ret.put("evidenceSource", "android-keystore-shared-preferences")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun adminUnlockStatusObject(): JSObject {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        val secureDevice = keyguard?.isDeviceSecure == true
        val biometricReady = hasBiometricCapability()
        val available = secureDevice
        val requestable = secureDevice
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("available", available)
        ret.put("requestable", requestable)
        ret.put("deviceSecure", secureDevice)
        ret.put("biometricReady", biometricReady)
        ret.put("lastDenied", lastAdminUnlockDenied)
        ret.put("state", adminUnlockState(secureDevice, requestable, available))
        ret.put("reason", adminUnlockReason(secureDevice, available, biometricReady))
        ret.put("privacyClass", "admin-critical")
        ret.put("evidenceSource", "android-biometric-keyguard-keystore")
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

    private fun hasSecureStorageCapability(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.M

    private fun adminUnlockState(secureDevice: Boolean, requestable: Boolean, available: Boolean): String {
        if (available) return "available"
        if (requestable) return "needs_native_permission"
        if (!secureDevice) return "needs_native_permission"
        return "unsupported_platform"
    }

    private fun adminUnlockReason(
        secureDevice: Boolean,
        available: Boolean,
        biometricReady: Boolean,
    ): String {
        if (lastAdminUnlockDenied) return "admin_unlock_denied"
        if (!secureDevice) return "device_credential_not_enrolled"
        if (available && biometricReady) return "biometric_or_device_credential_available"
        if (available) return "device_credential_available"
        return "device_credential_unavailable"
    }

    private fun securePrefs() =
        activity.getSharedPreferences(SECURE_STORAGE_PREFS, Context.MODE_PRIVATE)

    private fun encryptSecureValue(value: String): String {
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secureStorageKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val payload = JSONObject()
        payload.put("version", 1)
        payload.put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        payload.put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        return payload.toString()
    }

    private fun decryptSecureValue(encoded: String): String {
        val payload = JSONObject(encoded)
        val iv = Base64.decode(payload.getString("iv"), Base64.NO_WRAP)
        val ciphertext = Base64.decode(payload.getString("ciphertext"), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secureStorageKey(), GCMParameterSpec(AES_GCM_TAG_BITS, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    private fun secureStorageKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(SECURE_STORAGE_KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                SECURE_STORAGE_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return keyGenerator.generateKey()
    }

    private fun secureStorageResult(key: String): JSObject {
        val ret = secureStorageStatusObject()
        ret.put("key", key)
        return ret
    }

    private fun validateSecureStorageKey(key: String) {
        if (key.isEmpty() || key.length > 128) {
            throw IllegalArgumentException("secure storage key length must be 1..128 characters")
        }
        if (!key.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }) {
            throw IllegalArgumentException("secure storage key contains unsupported characters")
        }
        val allowed = listOf(
            "aurora.session",
            "aurora.auth",
            "aurora.gateway",
            "aurora.mesh",
            "aurora.admin",
        )
        if (allowed.none { key == it || key.startsWith("${it}.") || key.startsWith("${it}-") || key.startsWith("${it}_") }) {
            throw IllegalArgumentException("secure storage key must be in an Aurora credential namespace")
        }
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

class SecureStorageArgs {
    var key: String = ""
    var value: String = ""
}

class AdminUnlockResultArgs {
    var resultCode: Int = Activity.RESULT_CANCELED
}
