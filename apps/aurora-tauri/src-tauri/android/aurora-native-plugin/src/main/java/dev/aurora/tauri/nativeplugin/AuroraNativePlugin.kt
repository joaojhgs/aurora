package dev.aurora.tauri.nativeplugin

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Message
import android.content.res.Configuration
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.FileInputStream
import android.graphics.Bitmap
import java.net.URL
import java.net.HttpURLConnection
import java.net.URI
import java.net.InetAddress
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebStorage
import android.webkit.WebView
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.service.voice.VoiceInteractionService
import android.util.Base64
import android.util.Log
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import org.json.JSONArray
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import java.util.Locale
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

private const val ASSISTANT_ROLE_REQUEST_CODE = 4202
private const val ANDROID_PERMISSION_REQUEST_CODE = 4204
private const val ADMIN_UNLOCK_REQUEST_CODE = 4206
private const val AURORA_ACTION_NOTIFICATION_CHANNEL_ID = "aurora_local_actions"
private const val AURORA_ACTION_NOTIFICATION_ID = 4208
private const val SECURE_STORAGE_PREFS = "aurora_secure_storage"
private const val THIN_PROFILE_PREFS = "aurora_thin_profile"
private const val THIN_PROFILE_KEY = "aurora.session.android-thin-connection-profile.v1"
private const val SECURE_STORAGE_KEY_ALIAS = "aurora_secure_storage_v1"
private const val VOICE_PACK_PREFS = "aurora_voice_pack_cache"
private const val VOICE_PACK_CATALOG_KEY = "catalog"
private const val VOICE_PACK_ACTIVE_ID_KEY = "active_voice_pack_id"
private const val VOICE_PACK_INSTALLED_PREFIX = "installed."
private const val VOICE_PACK_CACHE_DIR = "aurora_voice_packs"
private const val VOICE_PACK_SHA256_BYTES = 32
private const val VOICE_PACK_SHA256_HEX_LENGTH = VOICE_PACK_SHA256_BYTES * 2
private const val VOICE_PACK_SHA256_HEX_REGEX = "^[0-9a-f]{${VOICE_PACK_SHA256_HEX_LENGTH}}$"
private const val VOICE_PACK_MIN_BYTES = 4L * 1024L
private const val VOICE_PACK_DOWNLOAD_CONNECT_TIMEOUT_MS = 8_000
private const val VOICE_PACK_DOWNLOAD_READ_TIMEOUT_MS = 20_000
private const val VOICE_PACK_DOWNLOAD_REDIRECT_LIMIT = 3
private const val VOICE_PACK_LOCK_STALE_AGE_MS = 10L * 60L * 1000L
private const val VOICE_PACK_INSTALL_STACK_SIZE_BYTES = 16L * 1024L * 1024L
private const val VOICE_LIVE_TEST_PCM_MAX_BYTES = 3_200
private const val PEER_PROOF_PREFIX = "aurora.mesh.peer-proof."
private const val INBOUND_VERIFIER_KEY_PREFIX = "aurora.peer-host.inbound-verifier.v1"
private const val INBOUND_VERIFIER_STORAGE_PREFIX = "aurora.mesh.inbound-verifier."
private const val ROOM_SECRET_PREFIX = "aurora.mesh.room-secret."
private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
private const val AES_GCM_TAG_BITS = 128
private const val LOG_TAG = "AuroraNativePlugin"

@TauriPlugin
class AuroraNativePlugin(private val activity: Activity) : Plugin(activity) {
    private var lastAssistantRoleDenied: Boolean = false
    private var lastAdminUnlockDenied: Boolean = false
    private var foreground: Boolean = true
    private var focused: Boolean = true
    private var configuredMicOrigins: Array<String> = emptyArray()
    private var webChromeClientDelegateCaptured: Boolean = false
    private var micDenyFailureCount: Long = 0
    private var lastMicDenyFailureReason: String? = null
    private val pendingMicRequests = mutableSetOf<PermissionRequest>()
    private var microphonePermissionRequestInFlight: Boolean = false
    private val voicePackDownloadJobs: ConcurrentHashMap<String, VoicePackDownloadState> = ConcurrentHashMap()
    private val voicePackJobsByPack: ConcurrentHashMap<String, String> = ConcurrentHashMap()
    private val voicePackLocks: ConcurrentHashMap<String, Any> = ConcurrentHashMap()
    private val backgroundVoiceAutoStartGeneration = AtomicLong(0L)
    private val backgroundVoiceAutoStartExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(
            null,
            {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
                runnable.run()
            },
            "aurora-background-voice-readiness",
            VOICE_PACK_INSTALL_STACK_SIZE_BYTES,
        )
    }
    private var clearBackgroundStopOnNextResume: Boolean = true
    private val packCatalogIdRegex = Regex("[A-Za-z0-9._:-]+")
    private data class VoicePackDownloadState(
        val status: String = "queued",
        val packId: String = "",
        val totalBytes: Long = -1L,
        val downloadedBytes: Long = 0L,
        val error: String? = null,
        val completedAtMs: Long = 0L,
    )

    private fun updateVoicePackDownloadState(
        jobId: String,
        update: (VoicePackDownloadState) -> VoicePackDownloadState,
    ) {
        voicePackDownloadJobs.computeIfPresent(jobId) { _, current -> update(current) }
    }

    private data class VoicePackCatalogEntry(
        val packId: String,
        val packName: String,
        val uri: String,
        val provider: String,
        val language: String,
        val sha256: String,
        val sizeBytes: Long,
        val tasks: List<String>,
        val engineRuntimeRevision: String,
        val supportedOperatingSystems: List<String>,
        val supportedAbis: List<String>,
        val license: String,
        val attributionRequired: Boolean,
        val attributionText: String,
        val modelFamily: String,
        val requiresReferenceAudio: Boolean,
        val referenceAudioMode: String,
    )

    private enum class VoicePackDownloadResult {
        SUCCESS,
        BAD_HASH,
        INVALID_INPUT,
        SIZE_MISMATCH,
        REDIRECT_DENIED,
        CONNECT_TIMEOUT,
        READ_TIMEOUT,
        WRITE_FAILED,
    }

    override fun onResume() {
        foreground = true
        focused = true
        acknowledgeForegroundAppOpen()
        syncNativeVoiceRoute()
        if (!microphonePermissionRequestInFlight) {
            resolvePendingMicRequests(allowRuntimePrompt = false)
        }
        scheduleBackgroundVoiceAutoStart()
        emitLifecycle("resume")
    }

    override fun onPause() {
        focused = false
        backgroundVoiceAutoStartGeneration.incrementAndGet()
        if (!microphonePermissionRequestInFlight) {
            denyPendingMicRequests()
        }
        requestFocusedVoiceReleaseOnBackground()
        emitLifecycle("pause")
    }

    override fun onStop() {
        foreground = false
        focused = false
        clearBackgroundStopOnNextResume = true
        backgroundVoiceAutoStartGeneration.incrementAndGet()
        denyPendingMicRequests()
        requestFocusedVoiceReleaseOnBackground()
        emitLifecycle("stop")
    }

    override fun onDestroy(activity: AppCompatActivity) {
        foreground = false
        focused = false
        backgroundVoiceAutoStartGeneration.incrementAndGet()
        backgroundVoiceAutoStartExecutor.shutdownNow()
        denyPendingMicRequests()
        emitLifecycle("destroy")
    }

    override fun onRestart(activity: AppCompatActivity) {
        foreground = true
        clearBackgroundStopOnNextResume = true
        emitLifecycle("restart")
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        emitLifecycle("configurationChanged")
    }

    override fun load(webView: WebView) {
        configuredMicOrigins = try {
            getConfig(AuroraNativePluginConfig::class.java).microphoneOrigins
        } catch (_: Exception) {
            emptyArray()
        }
        val existing = existingWebChromeClient(webView)
        if (existing !is AuroraMicWebChromeClient) {
            webChromeClientDelegateCaptured = existing != null
            webView.webChromeClient = AuroraMicWebChromeClient(this, existing)
        } else {
            webChromeClientDelegateCaptured = true
        }
        acknowledgeForegroundAppOpen()
        scheduleBackgroundVoiceAutoStart()
        emitLifecycle("load")
    }

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
        val localLightInference = localLightInferenceStatusObject()
        val shareTextReady = canResolveExternalIntent(
            Intent(Intent.ACTION_SEND).setType("text/plain"),
        )
        val deepLinkReady = canResolveIntent(
            Intent(Intent.ACTION_VIEW, Uri.parse("https://aurora.local/"))
                .addCategory(Intent.CATEGORY_BROWSABLE),
        )
        val notificationActionReady = canPostNotifications()

        val permissions = JSObject()
        permissions.put("aurora.nativeCapabilityManifest", true)
        permissions.put("aurora.android.assistantRoleStatus", true)
        permissions.put("aurora.android.assistantRoleRequest", assistantRoleRequestable)
        permissions.put("aurora.android.microphone", microphoneGranted)
        permissions.put("aurora.android.microphoneRequest", !microphoneGranted)
        permissions.put("aurora.android.notifications", notificationsGranted)
        permissions.put("aurora.android.notificationsRequest", !notificationsGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        permissions.put("aurora.android.biometric", biometricReady)
        permissions.put("aurora.android.secureStorage", secureStorageReady)
        permissions.put("aurora.android.thinPeerProof", secureStorageReady)
        permissions.put("aurora.android.inboundVerifierStorage", secureStorageReady)
        permissions.put("aurora.android.thinProfile", true)
        permissions.put("aurora.android.webviewMicMediation", true)
        permissions.put("aurora.android.lifecycleEvents", true)
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
        permissions.put("aurora.android.shareText", shareTextReady)
        permissions.put("aurora.android.openDeepLink", deepLinkReady)
        permissions.put("aurora.android.showNotification", notificationActionReady)
        permissions.put("aurora.android.appWidget", true)
        permissions.put("aurora.android.appShortcut", true)
        permissions.put("aurora.android.quickTile", true)
        permissions.put("aurora.android.entrypointPayload", true)
        permissions.put("aurora.android.voicePackCatalog", true)
        permissions.put("aurora.android.voicePackCatalogStatus", true)
        permissions.put("aurora.android.voicePackDownload", true)
        permissions.put("aurora.android.voicePackActivation", true)
        permissions.put("aurora.android.voicePackRemoval", true)
        permissions.put("aurora.android.localLightInference", localLightInference.getBoolean("permissionGranted"))

        val capabilities = JSObject()
        capabilities.put("native.permissionsManifest", true)
        capabilities.put("native.deviceStatus", true)
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
        capabilities.put("android.thinPeerProof", secureStorageReady)
        capabilities.put("android.inboundVerifierStorage", secureStorageReady)
        capabilities.put("android.thinProfile", true)
        capabilities.put("android.webviewMicMediation", true)
        capabilities.put("android.lifecycleEvents", true)
        capabilities.put("android.adminUnlock", adminUnlock.getBoolean("available"))
        capabilities.put("android.localNetwork", localNetworkReady)
        capabilities.put("android.foregroundService", foregroundServiceReady)
        capabilities.put("android.voiceForegroundService", foregroundServiceReady)
        capabilities.put("android.voiceForegroundService.running", voiceForeground.getBoolean("running"))
        capabilities.put("android.voiceForegroundService.start", voiceForeground.getBoolean("startable"))
        capabilities.put("android.voicePackCatalog", true)
        capabilities.put("android.voicePackCatalog.list", true)
        capabilities.put("android.voicePackCatalog.download", true)
        capabilities.put("android.voicePackCatalog.activate", true)
        capabilities.put("android.voicePackCatalog.remove", true)
        capabilities.put("android.localFileRead", false)
        capabilities.put("android.localFileWrite", false)
        capabilities.put("android.filePick", false)
        capabilities.put("android.shareIntent", true)
        capabilities.put("android.deepLink", true)
        capabilities.put("android.shareText", shareTextReady)
        capabilities.put("android.openDeepLink", deepLinkReady)
        capabilities.put("android.showNotification", notificationActionReady)
        capabilities.put("android.appWidget", true)
        capabilities.put("android.appShortcut", true)
        capabilities.put("android.quickTile", true)
        capabilities.put("android.entrypointPayload", true)
        capabilities.put("android.fallbackEntrypoints", true)
        capabilities.put("android.localLightInference.provider", true)
        capabilities.put("android.localLightInference.modelRuntime", localLightInference.getBoolean("modelRuntimeProvider"))
        capabilities.put("android.localLightInference.fallback", localLightInference.getBoolean("fallbackAvailable"))

        val permissionStates = JSObject()
        permissionStates.put("aurora.nativeCapabilityManifest", "available")
        permissionStates.put("aurora.android.assistantRoleStatus", "available")
        permissionStates.put("aurora.android.assistantRoleRequest", assistantRoleState(assistantRole))
        permissionStates.put("aurora.android.microphone", permissionState(microphoneGranted))
        permissionStates.put("aurora.android.microphoneRequest", permissionRequestState(microphoneGranted, true))
        permissionStates.put("aurora.android.notifications", permissionState(notificationsGranted))
        permissionStates.put("aurora.android.notificationsRequest", permissionRequestState(notificationsGranted, Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU))
        permissionStates.put("aurora.android.biometric", if (biometricReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.secureStorage", if (secureStorageReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.thinPeerProof", if (secureStorageReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.inboundVerifierStorage", if (secureStorageReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.thinProfile", "available")
        permissionStates.put("aurora.android.webviewMicMediation", "available")
        permissionStates.put("aurora.android.lifecycleEvents", if (foreground && focused) "available" else "degraded")
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
        permissionStates.put("aurora.android.shareText", if (shareTextReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.openDeepLink", if (deepLinkReady) "available" else "unsupported_platform")
        permissionStates.put("aurora.android.showNotification", permissionState(notificationActionReady))
        permissionStates.put("aurora.android.appWidget", "fallback")
        permissionStates.put("aurora.android.appShortcut", "fallback")
        permissionStates.put("aurora.android.quickTile", "fallback")
        permissionStates.put("aurora.android.entrypointPayload", "available")
        permissionStates.put("aurora.android.localLightInference", localLightInference.getString("state"))

        val capabilityStates = JSObject()
        capabilityStates.put("native.permissionsManifest", "available")
        capabilityStates.put("native.deviceStatus", "available")
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
        capabilityStates.put("android.thinPeerProof", if (secureStorageReady) "available" else "unsupported_platform")
        capabilityStates.put("android.inboundVerifierStorage", if (secureStorageReady) "available" else "unsupported_platform")
        capabilityStates.put("android.thinProfile", "available")
        capabilityStates.put("android.webviewMicMediation", "available")
        capabilityStates.put("android.lifecycleEvents", if (foreground && focused) "available" else "degraded")
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
        capabilityStates.put("android.shareText", if (shareTextReady) "available" else "unsupported_platform")
        capabilityStates.put("android.openDeepLink", if (deepLinkReady) "available" else "unsupported_platform")
        capabilityStates.put("android.showNotification", permissionState(notificationActionReady))
        capabilityStates.put("android.appWidget", "fallback")
        capabilityStates.put("android.appShortcut", "fallback")
        capabilityStates.put("android.quickTile", "fallback")
        capabilityStates.put("android.entrypointPayload", "available")
        capabilityStates.put("android.fallbackEntrypoints", "fallback")
        capabilityStates.put("android.localLightInference.provider", localLightInference.getString("state"))
        capabilityStates.put("android.localLightInference.modelRuntime", if (localLightInference.getBoolean("modelRuntimeProvider")) "available" else "needs_native_permission")
        capabilityStates.put("android.localLightInference.fallback", if (localLightInference.getBoolean("fallbackAvailable")) "fallback" else "unsupported_platform")

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("permissions", permissions)
        ret.put("capabilities", capabilities)
        ret.put("permissionStates", permissionStates)
        ret.put("capabilityStates", capabilityStates)
        ret.put("mobileIntegrations", mobileIntegrationsArray())
        ret.put("entrypoints", entrypoints)
        ret.put("assistantRole", assistantRole)
        ret.put("localLightInference", localLightInference)
        ret.put("voiceForegroundService", voiceForeground)
        ret.put("adminUnlock", adminUnlock)
        ret.put("secureStorage", secureStorageStatusObject())
        ret.put("thinPeerCredentialStorage", thinPeerCredentialStorageStatusObject())
        ret.put("inboundVerifierStorage", inboundVerifierStatusObject())
        ret.put("thinProfileStorage", thinProfileStatusObject())
        ret.put("webviewMicrophonePolicy", webviewMicrophonePolicyStatusObject())
        ret.put("lifecycle", lifecycleStatusObject())
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || roleManager == null) {
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
    fun localLightInferenceStatus(invoke: Invoke) {
        invoke.resolve(localLightInferenceStatusObject())
    }

    /**
     * Take a hold on the one Aurora foreground service for a held device
     * connection.
     *
     * R4 built the reference-counted ledger and R3 is its first caller: a mesh
     * session that has to keep answering while the webview is frozen needs the
     * process kept alive, and this is how it asks. Voice and mesh share the one
     * service and the one entry in the shade, so this never starts a second
     * service and never ends a voice session that is holding its own reason.
     */
    @Command
    fun meshDeviceLinkHold(invoke: Invoke) {
        AuroraRuntimeForegroundService.holdDeviceLink(activity.applicationContext)
        invoke.resolve(deviceLinkStatusObject())
    }

    /** Drop one held device connection, stopping the service if it was the last reason. */
    @Command
    fun meshDeviceLinkRelease(invoke: Invoke) {
        AuroraRuntimeForegroundService.releaseDeviceLink(activity.applicationContext)
        invoke.resolve(deviceLinkStatusObject())
    }

    /** Refresh the peer section of the one shared foreground notification. */
    @Command
    fun meshDeviceLinkUpdate(invoke: Invoke) {
        val args = invoke.parseArgs(MeshDeviceLinkUpdateArgs::class.java)
        AuroraRuntimeForegroundService.updateConnectedPeers(
            activity.applicationContext,
            args.peers.map { peer ->
                AuroraNotificationPeer(
                    peerId = peer.peerId,
                    displayName = peer.displayName,
                    roundTripTimeMs = peer.roundTripTimeMs,
                )
            },
        )
        invoke.resolve(deviceLinkStatusObject())
    }

    /** What is currently keeping the one Aurora service alive. */
    @Command
    fun meshDeviceLinkStatus(invoke: Invoke) {
        invoke.resolve(deviceLinkStatusObject())
    }

    private fun deviceLinkStatusObject(): JSObject {
        val ret = JSObject()
        val reasons = AuroraRuntimeForegroundService.activeForegroundReasonIds()
        ret.put("held", reasons.contains("device_link"))
        ret.put("activeReasons", JSArray().apply { reasons.forEach { put(it) } })
        ret.put("serviceRunning", AuroraRuntimeForegroundService.running)
        ret.put("notificationsSuppressed", AuroraRuntimeForegroundService.notificationsSuppressed)
        ret.put("notificationPeerCount", AuroraRuntimeForegroundService.connectedPeerCount())
        return ret
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
        val args = invoke.parseArgs(AndroidVoiceForegroundServiceStatusArgs::class.java)
        val status = voiceForegroundServiceStatusWithRouteSync()
        if (args.takeFocusedResult) {
            status.put(
                "focusedTranscript",
                AuroraRuntimeForegroundService.takeFocusedTranscriptResult() ?: JSONObject.NULL,
            )
        }
        if (args.takeBackgroundResult) {
            val result = AuroraRuntimeForegroundService.takeBackgroundTurnResult()
            status.put(
                "backgroundTurnResult",
                result?.let { JSONObject(it) } ?: JSONObject.NULL,
            )
        }
        invoke.resolve(status)
    }

    @Command
    fun startVoiceForegroundService(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoiceForegroundServiceStartArgs::class.java)
        syncNativeVoiceRoute()
        AuroraVoiceNativeConfigStore.setRemoteAudioConsent(activity, args.remoteAudioConsent)
        val status = voiceForegroundServiceStatusObject()
        if (
            args.backgroundSession &&
            status.getBoolean("focusedVoiceActive")
        ) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", "foreground_voice_busy")
            invoke.resolve(ret)
            return
        }
        if (args.backgroundSession && !status.getBoolean("backgroundStartable")) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", "background_voice_unavailable")
            invoke.resolve(ret)
            return
        }
        if (!status.getBoolean("startable")) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("status", status)
            ret.put("reason", status.getString("reason"))
            invoke.resolve(ret)
            return
        }

        val intent = Intent(activity, AuroraRuntimeForegroundService::class.java).apply {
            if (args.backgroundSession) action = AuroraRuntimeForegroundService.ACTION_START_BACKGROUND
            else action = AuroraRuntimeForegroundService.ACTION_START_ASSISTANT
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
        val ret = JSObject()
        ret.put("started", true)
        ret.put("status", voiceForegroundServiceStatusWithRouteSync())
        ret.put("reason", "foreground_service_start_requested")
        invoke.resolve(ret)
    }

    @Command
    fun injectVoicePcmForLiveTest(invoke: Invoke) {
        val ret = JSObject()
        if ((activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            ret.put("accepted", false)
            ret.put("reason", "debuggable_package_required")
            invoke.resolve(ret)
            return
        }
        val args = invoke.parseArgs(AndroidVoiceLiveTestPcmArgs::class.java)
        if (args.armIngress) {
            val armed = AuroraRuntimeForegroundService.armPcmIngressForTest()
            ret.put("accepted", armed)
            ret.put("reason", if (armed) "pcm_ingress_armed" else "voice_session_not_accepting_audio")
            invoke.resolve(ret)
            return
        }
        val bytes = runCatching { Base64.decode(args.pcmBase64, Base64.NO_WRAP) }.getOrNull()
        if (
            bytes == null ||
            bytes.isEmpty() ||
            bytes.size > VOICE_LIVE_TEST_PCM_MAX_BYTES ||
            bytes.size % 2 != 0
        ) {
            ret.put("accepted", false)
            ret.put("reason", "invalid_pcm_frame")
            invoke.resolve(ret)
            return
        }
        val shortBuffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val samples = ShortArray(shortBuffer.remaining())
        shortBuffer.get(samples)
        val result = AuroraRuntimeForegroundService.injectPcmForTest(samples)
        ret.put("accepted", result == 0)
        ret.put(
            "reason",
            when (result) {
                0 -> "pcm_frame_accepted"
                1 -> "audio_queue_overloaded"
                2 -> "audio_queue_closed"
                else -> "voice_session_not_accepting_audio"
            },
        )
        invoke.resolve(ret)
    }

    @Command
    fun voicePackCatalogStatus(invoke: Invoke) {
        invoke.resolve(voicePackCatalogStatusObject())
    }

    @Command
    fun voicePackCatalog(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoicePackCatalogArgs::class.java)
        if (args.catalogJson.isBlank()) {
            val ret = voicePackCatalogStatusObject()
            ret.put("updated", false)
            ret.put("reason", "no_catalog_payload")
            invoke.resolve(ret)
            return
        }

        val normalized = runCatching { normalizeVoicePackCatalog(args.catalogJson) }
            .getOrNull()
            ?: JSONObject()
                .put("entries", org.json.JSONArray())

        if (!normalized.has("entries")) {
            val ret = voicePackCatalogStatusObject()
            ret.put("updated", false)
            ret.put("reason", "catalog_parse_failed")
            invoke.resolve(ret)
            return
        }

        voicePackPrefs().edit()
            .putString(VOICE_PACK_CATALOG_KEY, normalized.getJSONArray("entries").toString())
            .apply()
        val ret = voicePackCatalogStatusObject()
        ret.put("updated", true)
        invoke.resolve(ret)
    }

    @Command
    fun downloadVoicePack(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoicePackDownloadArgs::class.java)
        val entry = findCatalogEntry(args.packId)
        if (entry == null) {
            invoke.reject("pack_not_found")
            return
        }
        val task = requestedPackTask(entry, args.task)
        if (task == null) {
            invoke.reject("pack_not_supported")
            return
        }
        val packId = entry.packId
        val recordedInstalled = packId in recordedInstalledPackIds()
        if (recordedInstalled && !args.forceDownload && !args.activate) {
            val ret = JSObject()
            ret.put("started", false)
            ret.put("packId", packId)
            ret.put("status", voicePackCatalogStatusObject())
            ret.put("reason", "already_downloaded")
            ret.put("installed", true)
            invoke.resolve(ret)
            return
        }

        if (!isPackDownloadReady(entry)) {
            invoke.reject("pack_not_supported")
            return
        }

        val previous = voicePackJobsByPack[packId]
        if (previous != null) {
            val previousState = voicePackDownloadJobs[previous]
            if (previousState != null && (previousState.status == "queued" || previousState.status == "started")) {
                val ret = JSObject()
                ret.put("started", false)
                ret.put("packId", packId)
                ret.put("jobId", previous)
                ret.put("status", voicePackCatalogStatusObject())
                ret.put("reason", "pack_operation_in_progress")
                ret.put("installed", packId in recordedInstalledPackIds())
                invoke.resolve(ret)
                return
            }
        }

        val jobId = "voice_pack_${System.currentTimeMillis()}_${packId}"
        voicePackDownloadJobs[jobId] = VoicePackDownloadState(
            status = "queued",
            packId = packId,
        )
        voicePackJobsByPack[packId] = jobId

        val installPack = Runnable {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
            try {
                val lock = voicePackLock(packId)
                synchronized(lock) {
                    updateVoicePackDownloadState(jobId) { current -> current.copy(status = "started") }
                    val result = installPackForRuntime(entry, task) { phase, completedBytes, expectedBytes ->
                        updateVoicePackDownloadState(jobId) { current ->
                            val ready = phase == "ready"
                            val totalBytes = if (ready) {
                                entry.sizeBytes
                            } else if (expectedBytes > 0L) {
                                expectedBytes
                            } else {
                                current.totalBytes
                            }
                            val downloadedBytes = if (ready) {
                                totalBytes
                            } else {
                                completedBytes.coerceAtLeast(current.downloadedBytes)
                            }
                            current.copy(
                                status = "started",
                                downloadedBytes = downloadedBytes,
                                totalBytes = totalBytes,
                            )
                        }
                    }
                    val terminalState = when (result) {
                        VoicePackDownloadResult.SUCCESS -> {
                            if (args.activate) {
                                if (task == AuroraSpeechPackTask.TTS && ttsReferenceRequired(entry) && !storeTtsReferenceSelection(args)) {
                                    VoicePackDownloadState(
                                        status = "failed",
                                        packId = packId,
                                        totalBytes = entry.sizeBytes,
                                        error = "tts_reference_required",
                                    )
                                } else {
                                    setActivePack(entry, task)
                                    scheduleBackgroundVoiceAutoStart()
                                    VoicePackDownloadState(
                                        status = "completed",
                                        packId = packId,
                                        downloadedBytes = entry.sizeBytes,
                                        totalBytes = entry.sizeBytes,
                                    )
                                }
                            } else {
                                VoicePackDownloadState(
                                    status = "completed",
                                    packId = packId,
                                    downloadedBytes = entry.sizeBytes,
                                    totalBytes = entry.sizeBytes,
                                )
                            }
                        }
                        VoicePackDownloadResult.BAD_HASH -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "sha256_mismatch",
                        )
                        VoicePackDownloadResult.WRITE_FAILED -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "download_failed",
                        )
                        VoicePackDownloadResult.INVALID_INPUT -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "invalid_catalog",
                        )
                        VoicePackDownloadResult.SIZE_MISMATCH -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "size_mismatch",
                        )
                        VoicePackDownloadResult.REDIRECT_DENIED -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "redirect_denied",
                        )
                        VoicePackDownloadResult.CONNECT_TIMEOUT -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "connect_timeout",
                        )
                        VoicePackDownloadResult.READ_TIMEOUT -> VoicePackDownloadState(
                            status = "failed", packId = packId, totalBytes = entry.sizeBytes, error = "read_timeout",
                        )
                    }
                    updateVoicePackDownloadState(jobId) { terminalState }
                }
            } catch (_: Exception) {
                updateVoicePackDownloadState(jobId) { current ->
                    current.copy(
                        status = "failed",
                        totalBytes = entry.sizeBytes,
                        error = "download_failed",
                    )
                }
            } finally {
                updateVoicePackDownloadState(jobId) { current ->
                    current.copy(
                        totalBytes = if (current.status == "failed" && current.totalBytes <= 0) {
                            entry.sizeBytes
                        } else {
                            current.totalBytes
                        },
                        completedAtMs = currentUnixMs(),
                    )
                }
                voicePackJobsByPack.remove(packId, jobId)
            }
        }
        Thread(
            null,
            installPack,
            "aurora-voice-pack-install",
            VOICE_PACK_INSTALL_STACK_SIZE_BYTES,
        ).start()

        val ret = JSObject()
        ret.put("started", true)
        ret.put("packId", packId)
        ret.put("jobId", jobId)
        invoke.resolve(ret)
    }

    @Command
    fun voicePackDownloadStatus(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoicePackOperationStatusArgs::class.java)
        val state = if (args.jobId.isBlank()) {
            null
        } else {
            voicePackDownloadJobs[args.jobId]
        }
        if (state == null) {
            invoke.reject("job_not_found")
            return
        }
        val ret = JSObject()
        ret.put("jobId", args.jobId)
        ret.put("status", state.status)
        ret.put("packId", state.packId)
        ret.put("downloadedBytes", state.downloadedBytes)
        ret.put("totalBytes", state.totalBytes)
        ret.put("error", state.error ?: JSONObject.NULL)
        ret.put("completedAtMs", state.completedAtMs)
        invoke.resolve(ret)
    }

    @Command
    fun setActiveVoicePack(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoicePackActivateArgs::class.java)
        val candidate = findCatalogEntry(args.packId)
        if (candidate == null) {
            invoke.reject("pack_not_found")
            return
        }
        val task = requestedPackTask(candidate, args.task)
        if (task == null) {
            invoke.reject("pack_not_supported")
            return
        }
        if (candidate.packId !in recordedInstalledPackIds()) {
            invoke.reject("pack_not_downloaded")
            return
        }
        if (task == AuroraSpeechPackTask.TTS && ttsReferenceRequired(candidate) && !storeTtsReferenceSelection(args)) {
            invoke.reject("tts_reference_required")
            return
        }
        val verifyAndActivate = Runnable {
            val activated = synchronized(voicePackLock(args.packId)) {
                if (!isPackReadyForRuntime(candidate)) {
                    false
                } else {
                    setActivePack(candidate, task)
                    true
                }
            }
            val catalogStatus = voicePackCatalogStatusObject()
            if (activated) scheduleBackgroundVoiceAutoStart()
            activity.runOnUiThread {
                val ret = JSObject()
                ret.put("activated", activated)
                ret.put("packId", args.packId)
                ret.put("task", task.nativeName)
                ret.put("status", catalogStatus)
                if (!activated) {
                    ret.put(
                        "reason",
                        if (task == AuroraSpeechPackTask.TTS && ttsReferenceRequired(candidate)) {
                            "tts_reference_jni_unavailable"
                        } else {
                            "pack_not_supported"
                        },
                    )
                }
                invoke.resolve(ret)
            }
        }
        try {
            Thread(
                null,
                verifyAndActivate,
                "aurora-voice-pack-activation",
                VOICE_PACK_INSTALL_STACK_SIZE_BYTES,
            ).start()
        } catch (_: RuntimeException) {
            invoke.reject("pack_not_supported")
        }
    }

    @Command
    fun removeVoicePack(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoicePackRemoveArgs::class.java)
        val entry = findCatalogEntry(args.packId)
        if (entry == null) {
            invoke.reject("pack_not_found")
            return
        }
        val removed = synchronized(voicePackLock(args.packId)) {
            val task = requestedPackTask(entry, args.task)
            val removedNow = if (task != null) {
                runCatching { AuroraNativeSpeechPackBridge.remove(activity, entry.packId, task) }.getOrDefault(false)
            } else {
                removePackForRuntime(entry)
            }
            if (task != null && activePackId(task) == args.packId) {
                clearActivePack(task)
            }
            if (removedNow && task == AuroraSpeechPackTask.TTS) {
                clearTtsReferenceSelection()
            }
            if (legacyActivePackId() == args.packId) {
                clearLegacyActivePack()
            }
            removedNow
        }
        val ret = JSObject()
        ret.put("removed", removed)
        ret.put("packId", args.packId)
        ret.put("status", voicePackCatalogStatusObject())
        invoke.resolve(ret)
    }

    @Command
    fun stopVoiceForegroundService(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidVoiceForegroundServiceStopArgs::class.java)
        val stopIntent = Intent(activity, AuroraRuntimeForegroundService::class.java).apply {
            action = if (args.backgroundSession) {
                AuroraRuntimeForegroundService.ACTION_STOP_BY_USER
            } else {
                AuroraRuntimeForegroundService.ACTION_STOP
            }
        }
        val stopped = if (AuroraRuntimeForegroundService.running) {
            activity.startService(stopIntent)
            true
        } else {
            false
        }
        val ret = JSObject()
        ret.put("stopped", stopped)
        ret.put("status", voiceForegroundServiceStatusWithRouteSync())
        ret.put("reason", if (stopped) "foreground_service_stop_requested" else "foreground_service_not_running")
        invoke.resolve(ret)
    }

    @Command
    fun releaseFocusedVoiceOnBackground(invoke: Invoke) {
        val released = requestFocusedVoiceReleaseOnBackground()
        val ret = JSObject()
        ret.put("released", released)
        ret.put("backgroundSessionActive", AuroraRuntimeForegroundService.backgroundSessionActive)
        ret.put("secretsRedacted", true)
        invoke.resolve(ret)
    }

    @Command
    fun finishVoiceForegroundService(invoke: Invoke) {
        val intent = Intent(activity, AuroraRuntimeForegroundService::class.java).apply {
            action = AuroraRuntimeForegroundService.ACTION_FINISH
        }
        val delivered = if (AuroraRuntimeForegroundService.running) {
            activity.startService(intent)
            true
        } else {
            false
        }
        val ret = JSObject()
        ret.put("finished", delivered)
        ret.put("status", voiceForegroundServiceStatusWithRouteSync())
        ret.put("reason", if (delivered) "foreground_service_finish_requested" else "foreground_service_not_running")
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
    fun shareText(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidShareTextArgs::class.java)
        try {
            val text = boundedRequiredString("text", args.text, 8192)
            val title = boundedOptionalString("title", args.title, 160)
            val sendIntent = Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, text)
            if (title != null) sendIntent.putExtra(Intent.EXTRA_TITLE, title)
            if (!canResolveExternalIntent(sendIntent)) {
                invoke.reject("capability_unavailable")
                return
            }
            val chooser = Intent.createChooser(sendIntent, title ?: "Share with")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val ownShareTargets = resolvingActivityComponents(sendIntent)
                .filter { it.packageName == activity.packageName }
                .toTypedArray()
            if (ownShareTargets.isNotEmpty()) {
                chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, ownShareTargets)
            }
            activity.startActivity(chooser)
            val ret = JSObject()
            ret.put("shared", true)
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
        } catch (error: IllegalArgumentException) {
            invoke.reject(error.message ?: "invalid_arguments")
        } catch (_: ActivityNotFoundException) {
            invoke.reject("capability_unavailable")
        } catch (_: SecurityException) {
            invoke.reject("permission_denied")
        }
    }

    @Command
    fun openDeepLink(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidOpenDeepLinkArgs::class.java)
        try {
            val uri = validateOutboundDeepLink(args.url)
            val intent = Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (!canResolveIntent(intent)) {
                invoke.reject("capability_unavailable")
                return
            }
            activity.startActivity(intent)
            val ret = JSObject()
            ret.put("opened", true)
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
        } catch (error: IllegalArgumentException) {
            invoke.reject(error.message ?: "permission_denied")
        } catch (_: ActivityNotFoundException) {
            invoke.reject("capability_unavailable")
        } catch (_: SecurityException) {
            invoke.reject("permission_denied")
        }
    }

    @Command
    fun showNotification(invoke: Invoke) {
        val args = invoke.parseArgs(AndroidShowNotificationArgs::class.java)
        try {
            if (!canPostNotifications()) {
                invoke.reject("permission_denied")
                return
            }
            val title = boundedRequiredString("title", args.title, 160)
            val body = boundedOptionalString("body", args.body, 1024)
            ensureActionNotificationChannel()
            val builder = NotificationCompat.Builder(activity, AURORA_ACTION_NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            if (body != null) builder.setContentText(body)
            NotificationManagerCompat.from(activity).notify(AURORA_ACTION_NOTIFICATION_ID, builder.build())
            val ret = JSObject()
            ret.put("shown", true)
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
        } catch (error: IllegalArgumentException) {
            invoke.reject(error.message ?: "invalid_arguments")
        } catch (_: SecurityException) {
            invoke.reject("permission_denied")
        }
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
    fun localDataEnvelopeEncrypt(invoke: Invoke) {
        val args = invoke.parseArgs(LocalDataEnvelopeEncryptArgs::class.java)
        try {
            invoke.resolve(
                JSObject.fromJSONObject(
                    AuroraLocalDataEnvelopeCrypto.encrypt(
                        context = activity,
                        keyPurpose = args.keyPurpose,
                        profileId = args.profileId,
                        localNodeId = args.localNodeId,
                        plaintext = base64UrlDecode(args.plaintextB64Url),
                        aad = base64UrlDecode(args.aadB64Url),
                    ),
                ),
            )
        } catch (error: Exception) {
            invoke.reject(error.message ?: "local_data_envelope_encrypt_failed")
        }
    }

    @Command
    fun localDataEnvelopeDecrypt(invoke: Invoke) {
        val args = invoke.parseArgs(LocalDataEnvelopeDecryptArgs::class.java)
        try {
            val envelope = JSONObject()
                .put("version", args.envelope.version)
                .put("algorithm", args.envelope.algorithm)
                .put("keyId", args.envelope.keyId)
                .put("nonceB64Url", args.envelope.nonceB64Url)
                .put("ciphertextAndTagB64Url", args.envelope.ciphertextAndTagB64Url)
                .put("createdAtMs", args.envelope.createdAtMs)
            val plaintext = AuroraLocalDataEnvelopeCrypto.decrypt(
                context = activity,
                profileId = args.profileId,
                localNodeId = args.localNodeId,
                envelope = envelope,
                aad = base64UrlDecode(args.aadB64Url),
            )
            val ret = JSObject()
            ret.put("plaintextB64Url", base64UrlEncode(plaintext))
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "local_data_envelope_decrypt_failed")
        }
    }

    @Command
    fun localDataEnvelopeRotate(invoke: Invoke) {
        val args = invoke.parseArgs(LocalDataEnvelopeRotateArgs::class.java)
        try {
            val (previousKeyId, newKeyId) = AuroraLocalDataEnvelopeCrypto.rotate(
                context = activity,
                keyPurpose = args.keyPurpose,
                profileId = args.profileId,
                localNodeId = args.localNodeId,
            )
            val ret = JSObject()
            ret.put("previousKeyId", previousKeyId)
            ret.put("newKeyId", newKeyId)
            ret.put("secretsRedacted", true)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "local_data_envelope_rotate_failed")
        }
    }


    @Command
    fun thinPeerCredentialSet(invoke: Invoke) {
        val args = invoke.parseArgs(ThinPeerCredentialSetArgs::class.java)
        try {
            validateThinPeerSetArgs(args)
            if (args.expiresAtMs > 0 && args.expiresAtMs <= currentUnixMs()) {
                securePrefs().edit().remove(thinPeerCredentialKey(args.peerId)).apply()
                throw IllegalArgumentException("credential_expired")
            }
            val record = JSONObject()
            record.put("tokenId", args.tokenId)
            record.put("claimantPeerId", args.claimantPeerId)
            record.put("verifierPeerId", args.verifierPeerId)
            record.put("claimantSignalingPeerId", args.claimantSignalingPeerId)
            record.put("verifierSignalingPeerId", args.verifierSignalingPeerId)
            record.put("roomName", args.roomName)
            record.put("rawBearerToken", args.rawBearerToken)
            record.put("createdAtMs", if (args.createdAtMs > 0) args.createdAtMs else currentUnixMs())
            if (args.expiresAtMs > 0) record.put("expiresAtMs", args.expiresAtMs)
            securePrefs().edit().putString(thinPeerCredentialKey(args.peerId), encryptSecureValue(record.toString())).apply()
            val response = thinPeerStatusResponse(args.peerId, record, true)
            response.put("voiceRoute", syncNativeVoiceRoute())
            invoke.resolve(response)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_peer_credential_set_failed")
        }
    }

    @Command
    fun thinPeerCredentialStatus(invoke: Invoke) {
        val args = invoke.parseArgs(ThinPeerCredentialLookupArgs::class.java)
        try {
            validateNonEmpty("peerId", args.peerId, 256)
            val record = loadUnexpiredThinPeerCredential(args.peerId)
            invoke.resolve(thinPeerStatusResponse(args.peerId, record, record?.optString("rawBearerToken").orEmpty().isNotEmpty()))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_peer_credential_status_failed")
        }
    }

    @Command
    fun thinPeerCredentialDelete(invoke: Invoke) {
        val args = invoke.parseArgs(ThinPeerCredentialLookupArgs::class.java)
        try {
            validateNonEmpty("peerId", args.peerId, 256)
            securePrefs().edit().remove(thinPeerCredentialKey(args.peerId)).apply()
            val response = thinPeerStatusResponse(args.peerId, null, false)
            response.put("voiceRoute", syncNativeVoiceRoute())
            invoke.resolve(response)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_peer_credential_delete_failed")
        }
    }

    @Command
    fun thinPeerReconnectProve(invoke: Invoke) {
        val args = invoke.parseArgs(ThinPeerReconnectProveArgs::class.java)
        try {
            validateNonEmpty("peerId", args.peerId, 256)
            val challenge = args.challenge
            validateReconnectChallenge(challenge)
            val record = loadUnexpiredThinPeerCredential(args.peerId)
            if (record == null) {
                invoke.resolve(thinPeerProofResponse(args.peerId, null, false, null))
                return
            }
            if (!reconnectChallengeMatches(record, challenge)) {
                invoke.resolve(thinPeerProofResponse(args.peerId, record, false, null))
                return
            }
            val proof = JSONObject()
            proof.put("type", "mesh_auth_proof_v1")
            proof.put("token_id", record.getString("tokenId"))
            proof.put("challenge", challenge.challenge)
            proof.put("proof", computeReconnectProofHex(record.getString("rawBearerToken"), record, challenge))
            proof.put("channel_binding", challenge.channelBindingValue())
            proof.put("claimant_peer_id", record.getString("claimantPeerId"))
            proof.put("verifier_peer_id", record.getString("verifierPeerId"))
            proof.put("claimant_signaling_peer_id", challenge.claimantSignalingPeerIdValue())
            proof.put("verifier_signaling_peer_id", challenge.verifierSignalingPeerIdValue())
            proof.put("room_name", record.getString("roomName"))
            invoke.resolve(thinPeerProofResponse(args.peerId, record, true, proof))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_peer_reconnect_prove_failed")
        }
    }

    @Command
    fun inboundVerifierGet(invoke: Invoke) {
        val args = inboundVerifierArgs(invoke.parseArgs(InboundVerifierSecretArgs::class.java))
        try {
            validateInboundVerifierSecretKey(args.key)
            val stored = securePrefs().getString(inboundVerifierStorageAccount(args.key), null)
            val value = stored?.let {
                val plaintext = decryptSecureValue(it)
                validateInboundVerifierSecretValueForSelector(plaintext, parseInboundVerifierSecretKey(args.key))
                plaintext
            }
            invoke.resolve(inboundVerifierGetResponse(value))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "inbound_verifier_get_failed")
        }
    }

    @Command
    fun inboundVerifierSet(invoke: Invoke) {
        val args = inboundVerifierArgs(invoke.parseArgs(InboundVerifierSecretArgs::class.java))
        try {
            val selector = parseInboundVerifierSecretKey(args.key)
            validateInboundVerifierSecretValueForSelector(args.value, selector)
            securePrefs().edit()
                .putString(inboundVerifierStorageAccountFromValidKey(args.key), encryptSecureValue(args.value))
                .apply()
            invoke.resolve(inboundVerifierWriteResponse(true))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "inbound_verifier_set_failed")
        }
    }

    @Command
    fun inboundVerifierDelete(invoke: Invoke) {
        val args = inboundVerifierArgs(invoke.parseArgs(InboundVerifierSecretArgs::class.java))
        try {
            validateInboundVerifierSecretKey(args.key)
            val account = inboundVerifierStorageAccountFromValidKey(args.key)
            securePrefs().edit().remove(account).apply()
            invoke.resolve(inboundVerifierWriteResponse(true))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "inbound_verifier_delete_failed")
        }
    }

    @Command
    fun thinProfileGet(invoke: Invoke) {
        try {
            val ret = thinProfileStatusObject()
            val stored = activity
                .getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
                .getString(THIN_PROFILE_KEY, null)
            ret.put("key", THIN_PROFILE_KEY)
            ret.put("value", stored ?: JSONObject.NULL)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_profile_get_failed")
        }
    }

    @Command
    fun thinProfileSet(invoke: Invoke) {
        val args = invoke.parseArgs(ThinProfileSetArgs::class.java)
        if (args.value.length > 65536) {
            invoke.reject("thin profile value length must be <= 65536 bytes")
            return
        }
        val committed = activity.getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(THIN_PROFILE_KEY, args.value)
            .commit()
        if (!committed) {
            invoke.reject("thin_profile_set_failed")
            return
        }
        val ret = thinProfileStatusObject()
        ret.put("key", THIN_PROFILE_KEY)
        ret.put("ok", true)
        ret.put("voiceRoute", syncNativeVoiceRoute())
        scheduleBackgroundVoiceAutoStart()
        invoke.resolve(ret)
    }

    @Command
    fun thinRoomSecretSet(invoke: Invoke) {
        val args = invoke.parseArgs(ThinRoomSecretSetArgs::class.java)
        try {
            validateNonEmpty("roomSecretRef", args.ref, 1024)
            validateNonEmpty("roomSecret", args.value, 8192)
            val committed = securePrefs()
                .edit()
                .putString(thinRoomSecretKey(args.ref), encryptSecureValue(args.value))
                .commit()
            if (!committed) {
                throw IllegalStateException("thin_room_secret_set_failed")
            }
            val ret = thinRoomSecretStatusObject()
            ret.put("ref", args.ref)
            ret.put("ok", true)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_room_secret_set_failed")
        }
    }

    @Command
    fun thinRoomSecretGet(invoke: Invoke) {
        val args = invoke.parseArgs(ThinRoomSecretGetArgs::class.java)
        try {
            validateNonEmpty("roomSecretRef", args.ref, 1024)
            val stored = securePrefs().getString(thinRoomSecretKey(args.ref), null)
            val ret = thinRoomSecretStatusObject()
            ret.put("ref", args.ref)
            if (stored != null) ret.put("value", decryptSecureValue(stored))
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_room_secret_get_failed")
        }
    }

    @Command
    fun thinRoomSecretDelete(invoke: Invoke) {
        val args = invoke.parseArgs(ThinRoomSecretDeleteArgs::class.java)
        try {
            validateNonEmpty("roomSecretRef", args.ref, 1024)
            val committed = securePrefs()
                .edit()
                .remove(thinRoomSecretKey(args.ref))
                .commit()
            if (!committed) {
                throw IllegalStateException("thin_room_secret_delete_failed")
            }
            val ret = thinRoomSecretStatusObject()
            ret.put("ref", args.ref)
            ret.put("ok", true)
            ret.put("persisted", false)
            invoke.resolve(ret)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "thin_room_secret_delete_failed")
        }
    }

    @Command
    fun webviewMicrophonePermissionDecision(invoke: Invoke) {
        val args = invoke.parseArgs(WebviewMicrophonePermissionArgs::class.java)
        invoke.resolve(evaluateWebviewMicrophonePermission(args))
    }

    @Command
    fun androidLifecycleStatus(invoke: Invoke) {
        invoke.resolve(lifecycleStatusObject())
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
        val roleAvailable = if (sdkSupportsRole) {
            roleManager?.isRoleAvailable(RoleManager.ROLE_ASSISTANT) == true
        } else {
            false
        }
        val roleHeld = activity.applicationContext.isAuroraAssistantRoleHeld()
        val handlesAssistActivity = packageHandlesAssist()
        val declaresVoiceInteractionService = packageDeclaresVoiceInteractionService()
        val packageQualified = handlesAssistActivity && declaresVoiceInteractionService
        val requestable = roleAvailable && packageQualified && !roleHeld
        val oemUnavailable = sdkSupportsRole && !roleAvailable

        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("roleName", if (sdkSupportsRole) RoleManager.ROLE_ASSISTANT else "android.app.role.ASSISTANT")
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
        ret.put("evidenceSource", "android-rolemanager-secure-assistant-setting-package-manager")
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
        integrations.put(mobileIntegration("androidLocalLightInference", "Android local-light inference provider", "supported-path", "android.localLightInference.provider", "aurora.android.localLightInference", "personal", "Native adapter reports Android local-light inference as a capability-gated provider; backend model catalog and device/model proof are still required before selection."))
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

    private fun localLightInferenceStatusObject(): JSObject {
        val catalog = voicePackCatalogEntries()
        val installedPackIds = recordedInstalledPackIds()
        val referenceSelectionReady = ttsReferenceSelection() != null
        val activePackId = activePackId(AuroraSpeechPackTask.STT)
        val activePack = activePackId?.let { active -> catalog.firstOrNull { it.packId == active } }
        val catalogCount = catalog.size
        val installedCount = catalog.count { it.packId in installedPackIds }
        val activeCacheReady = activePack != null &&
            isRecordedPackReadyForRuntime(activePack, installedPackIds, referenceSelectionReady)
        val routeConfigured = AuroraVoiceNativeConfigStore.hasAssistantRoute(activity)
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("providerId", "native:mobile-local-light")
        ret.put("available", activeCacheReady)
        ret.put("requestable", catalogCount > 0)
        ret.put("modelRuntimeProvider", true)
        ret.put("backendModelCatalogRequired", catalogCount == 0)
        ret.put("engineReady", activeCacheReady)
        ret.put("rustCatalogBridgeReady", true)
        ret.put("routeConfigured", routeConfigured)
        ret.put("hardwareAcceleration", "unknown")
        ret.put("catalogCount", catalogCount)
        ret.put("installedCount", installedCount)
        ret.put("modelId", if (activePackId == null) JSONObject.NULL else activePackId)
        ret.put("modelPresent", activeCacheReady)
        ret.put("permissionGranted", true)
        ret.put("state", if (activeCacheReady) "ready" else "degraded")
        ret.put("fallbackAvailable", !activeCacheReady)
        ret.put("fallbackProviderId", "local:Orchestrator:llama-cpp")
        ret.put(
            "reason",
            when {
                !activeCacheReady && catalogCount > 0 -> "compatible_pack_not_available"
                !routeConfigured -> "voice_route_unconfigured"
                catalogCount == 0 -> "backend_model_catalog_required"
                else -> "ready"
            },
        )
        ret.put("evidenceSource", "android-native-local-light-adapter")
        ret.put(
            "activePack",
            activePack?.let { voicePackRuntimeSummary(it, it.packId in installedPackIds) } ?: JSONObject(),
        )
        ret.put("activePackReadyForRuntime", activeCacheReady)
        ret.put("activePackCacheReady", activeCacheReady)
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

    private fun backgroundSessionAllowed(
        installedPackIds: Set<String>,
        referenceSelectionReady: Boolean,
    ): Boolean =
        isActivePackReady(AuroraSpeechPackTask.STT, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.TTS, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.VAD, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.KWS, installedPackIds, referenceSelectionReady) &&
            wakePhraseSelection() != null

    private fun voicePackCatalogEntries(): List<VoicePackCatalogEntry> {
        val raw = voicePackCatalogRaw()
        val parsed = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        val out = ArrayList<VoicePackCatalogEntry>(parsed.length())
        for (i in 0 until parsed.length()) {
            val entryObj = parsed.optJSONObject(i) ?: continue
            val packId = entryObj.optString("packId", "").trim()
            val packName = entryObj.optString("packName", packId)
            val uri = entryObj.optString("uri", "").trim()
            val sha = entryObj.optString("sha256", "").trim().lowercase(Locale.getDefault())
            val sizeBytes = entryObj.optLong("sizeBytes", -1L)
            val tasks = stringListFromJSONArray(entryObj, "tasks")
            val engineRuntimeRevision = entryObj.optString("engineRuntimeRevision", "").trim()
            val supportedOperatingSystems = stringListFromJSONArray(entryObj, "supportedOperatingSystems")
            val supportedAbis = stringListFromJSONArray(entryObj, "supportedAbis")
            val license = entryObj.optString("license", "").trim()
            val attributionRequired = entryObj.optBoolean("attributionRequired", false)
            val attributionText = entryObj.optString("attributionText", "").trim()
            val modelFamily = entryObj.optString("modelFamily", entryObj.optString("model_family", "")).trim().lowercase(Locale.getDefault())
            val requiresReferenceAudio = entryObj.optBoolean(
                "requiresReferenceAudio",
                entryObj.optBoolean("referenceAudioRequired", entryObj.optBoolean("requiresReference", false)),
            )
            val referenceAudioMode = auroraVoicePackReferenceAudioMode(entryObj)
            if (
                packId.isBlank() ||
                uri.isBlank() ||
                !packCatalogIdRegex.matches(packId) ||
                !isValidHexSha256(sha) ||
                !isPositiveAndBoundedSize(sizeBytes) ||
                tasks.isEmpty() ||
                engineRuntimeRevision.isBlank() ||
                supportedOperatingSystems.isEmpty() ||
                supportedAbis.isEmpty() ||
                license.isBlank() ||
                attributionText.isBlank() && attributionRequired
            ) {
                continue
            }
            out.add(
                VoicePackCatalogEntry(
                    packId = packId,
                    packName = packName,
                    uri = uri,
                    provider = entryObj.optString("provider", "unknown"),
                    language = entryObj.optString("language", "und"),
                    sha256 = entryObj.optString("sha256", "").lowercase(),
                    sizeBytes = entryObj.optLong("sizeBytes", -1),
                    tasks = tasks,
                    engineRuntimeRevision = engineRuntimeRevision,
                    supportedOperatingSystems = supportedOperatingSystems,
                    supportedAbis = supportedAbis,
                    license = license,
                    attributionRequired = attributionRequired,
                    attributionText = attributionText,
                    modelFamily = modelFamily,
                    requiresReferenceAudio = requiresReferenceAudio,
                    referenceAudioMode = referenceAudioMode,
                ),
            )
        }
        return out
    }

    private fun voicePackCatalogRaw(): String {
        val stored = voicePackPrefs().getString(VOICE_PACK_CATALOG_KEY, null)?.trim()
        if (!stored.isNullOrBlank() && stored != "[]") return stored
        return runCatching { AuroraNativeSpeechPackBridge.embeddedCatalogJson() }.getOrDefault("[]")
    }

    private fun voicePackCatalogStatusObject(): JSObject {
        val catalog = voicePackCatalogEntries()
        val active = legacyActivePackId()
        val installedPackIds = recordedInstalledPackIds()
        val referenceSelectionReady = ttsReferenceSelection() != null
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("available", catalog.isNotEmpty())
        ret.put(
            "backgroundRuntimeReady",
            backgroundSessionAllowed(installedPackIds, referenceSelectionReady),
        )
        ret.put("activePackId", JSONObject.NULL)
        ret.put("legacyActivePackId", active ?: JSONObject.NULL)
        ret.put("activeSttPackId", activePackId(AuroraSpeechPackTask.STT) ?: JSONObject.NULL)
        ret.put("activeTtsPackId", activePackId(AuroraSpeechPackTask.TTS) ?: JSONObject.NULL)
        ret.put("activeVadPackId", activePackId(AuroraSpeechPackTask.VAD) ?: JSONObject.NULL)
        ret.put("activeKwsPackId", activePackId(AuroraSpeechPackTask.KWS) ?: JSONObject.NULL)
        val entries = JSArray()
        catalog.forEach { entry ->
            val task = inferAuroraSpeechPackTask(entry.tasks)
            val installed = entry.packId in installedPackIds
            val item = JSObject()
            item.put("packId", entry.packId)
            item.put("packName", entry.packName)
            item.put("provider", entry.provider)
            item.put("language", entry.language)
            item.put("uri", entry.uri)
            item.put("sha256", entry.sha256)
            item.put("sizeBytes", entry.sizeBytes)
            item.put("installed", installed)
            item.put("active", task != null && entry.packId == activePackId(task))
            item.put("runtimeTask", task?.nativeName ?: JSONObject.NULL)
            item.put("tasks", JSArray().also { jsonArray ->
                entry.tasks.forEach { jsonArray.put(it) }
            })
            item.put("engineRuntimeRevision", entry.engineRuntimeRevision)
            item.put("supportedOperatingSystems", JSArray().also { jsonArray ->
                entry.supportedOperatingSystems.forEach { jsonArray.put(it) }
            })
            item.put("supportedAbis", JSArray().also { jsonArray ->
                entry.supportedAbis.forEach { jsonArray.put(it) }
            })
            item.put("license", entry.license)
            item.put("attributionRequired", entry.attributionRequired)
            item.put("attributionText", entry.attributionText)
            item.put("modelFamily", entry.modelFamily)
            item.put("requiresReferenceAudio", entry.requiresReferenceAudio)
            item.put("referenceAudioMode", entry.referenceAudioMode)
            item.put("referenceSelectionRequired", ttsReferenceRequired(entry))
            item.put("referenceSelectionPresent", !ttsReferenceRequired(entry) || referenceSelectionReady)
            item.put("referenceRuntimeReady", !ttsReferenceRequired(entry) || referenceSelectionReady)
            item.put(
                "referenceRuntimeReason",
                when {
                    !ttsReferenceRequired(entry) -> "not_required"
                    !referenceSelectionReady -> "reference_selection_missing"
                    else -> "ready"
                },
            )
            item.put(
                "readyForRuntime",
                task != null &&
                    isRecordedPackReadyForRuntime(entry, installedPackIds, referenceSelectionReady),
            )
            item.put("readyForInstall", task != null && isPackDownloadReady(entry))
            item.put("cachePath", JSONObject.NULL)
            item.put("evidenceSource", "android-native-speech-pack-manager")
            entries.put(item)
        }
        ret.put("entries", entries)
        ret.put("evidenceSource", "android-native-speech-pack-manager")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun voicePackPrefs() =
        activity.getSharedPreferences(VOICE_PACK_PREFS, Context.MODE_PRIVATE)

    private fun voicePackLock(packId: String): Any =
        voicePackLocks.computeIfAbsent(packId) { Any() }

    private fun normalizeVoicePackCatalog(raw: String): JSObject {
        val parsed = JSONArray(raw)
        val normalized = JSONArray()
        for (i in 0 until parsed.length()) {
            val item = parsed.optJSONObject(i) ?: continue
            val packId = item.optString("packId", "").trim()
            val packName = item.optString("name", item.optString("packName", "")).trim()
            val uri = item.optString("uri", "").trim()
            val normalizedUri = parseVoicePackUri(uri)
            val sha = item.optString("sha256", "").trim().lowercase(Locale.getDefault())
            val provider = item.optString("provider", "unknown").trim()
            val language = item.optString("language", "und").trim()
            val size = item.optLong("sizeBytes", -1)
            val tasks = stringListFromJSONArray(item, "tasks")
            val engineRuntimeRevision = item.optString("engineRuntimeRevision", "").trim()
            val supportedOperatingSystems = stringListFromJSONArray(item, "supportedOperatingSystems")
            val supportedAbis = stringListFromJSONArray(item, "supportedAbis")
            val license = item.optString("license", "").trim()
            val attributionRequired = item.optBoolean("attributionRequired", false)
            val attributionText = item.optString("attributionText", "").trim()
            val modelFamily = item.optString("modelFamily", item.optString("model_family", "")).trim().lowercase(Locale.getDefault())
            val requiresReferenceAudio = item.optBoolean(
                "requiresReferenceAudio",
                item.optBoolean("referenceAudioRequired", item.optBoolean("requiresReference", false)),
            )
            val referenceAudioMode = auroraVoicePackReferenceAudioMode(item)
            if (packId.isBlank() || !packCatalogIdRegex.matches(packId)) continue
            if (uri.isBlank()) continue
            if (packName.isBlank()) continue
            if (!isValidHexSha256(sha)) continue
            if (!isPositiveAndBoundedSize(size)) continue
            if (tasks.isEmpty() ||
                engineRuntimeRevision.isBlank() ||
                supportedOperatingSystems.isEmpty() ||
                supportedAbis.isEmpty() ||
                license.isBlank() ||
                attributionText.isBlank() && attributionRequired
            ) {
                continue
            }
            val normalizedItem = JSONObject()
            normalizedItem.put("packId", packId)
            normalizedItem.put("packName", packName)
            normalizedItem.put("provider", provider)
            normalizedItem.put("language", language)
            normalizedItem.put("uri", normalizedUri.toString())
            normalizedItem.put("sha256", sha)
            normalizedItem.put("sizeBytes", size)
            normalizedItem.put("tasks", JSArray().also { jsonArray ->
                tasks.forEach { task ->
                    jsonArray.put(task)
                }
            })
            normalizedItem.put("engineRuntimeRevision", engineRuntimeRevision)
            normalizedItem.put("supportedOperatingSystems", JSArray().also { jsonArray ->
                supportedOperatingSystems.forEach { jsonArray.put(it) }
            })
            normalizedItem.put("supportedAbis", JSArray().also { jsonArray ->
                supportedAbis.forEach { jsonArray.put(it) }
            })
            normalizedItem.put("license", license)
            normalizedItem.put("attributionRequired", attributionRequired)
            normalizedItem.put("attributionText", attributionText)
            normalizedItem.put("modelFamily", modelFamily)
            normalizedItem.put("requiresReferenceAudio", requiresReferenceAudio)
            normalizedItem.put("referenceAudioMode", referenceAudioMode)
            normalized.put(normalizedItem)
        }
        return JSObject().put("entries", normalized)
    }

    private fun findCatalogEntry(packId: String): VoicePackCatalogEntry? =
        voicePackCatalogEntries().firstOrNull { it.packId == packId }

    private fun legacyActivePackId(): String? = voicePackPrefs().getString(VOICE_PACK_ACTIVE_ID_KEY, null)

    private fun activePackId(task: AuroraSpeechPackTask): String? =
        voicePackPrefs().getString(auroraSpeechPackActiveKey(task), null)

    private fun setActivePack(entry: VoicePackCatalogEntry, task: AuroraSpeechPackTask) {
        voicePackPrefs().edit()
            .putString(auroraSpeechPackActiveKey(task), entry.packId)
            .apply()
    }

    private fun clearActivePack(task: AuroraSpeechPackTask) {
        voicePackPrefs().edit().remove(auroraSpeechPackActiveKey(task)).apply()
    }

    private fun clearLegacyActivePack() {
        voicePackPrefs().edit().remove(VOICE_PACK_ACTIVE_ID_KEY).apply()
    }

    private fun voicePackRuntimeSummary(entry: VoicePackCatalogEntry, installed: Boolean): JSObject {
        val ret = JSObject()
        ret.put("packId", entry.packId)
        ret.put("packName", entry.packName)
        ret.put("provider", entry.provider)
        ret.put("language", entry.language)
        ret.put("sizeBytes", entry.sizeBytes)
        ret.put("installed", installed)
        ret.put("cachePath", JSONObject.NULL)
        return ret
    }

    /**
     * Returns the durable completed-install snapshot used by status and catalog UI.
     * This is deliberately non-authoritative: runtime activation and native session
     * construction still resolve and verify every selected pack before use.
     */
    private val recordedInstalledPackIdsCache = AtomicReference<Set<String>?>(null)

    private fun recordedInstalledPackIds(): Set<String> {
        val refreshed = runCatching {
            AuroraNativeSpeechPackBridge.installedPackIds(activity)
        }.getOrNull()
        if (refreshed != null) {
            val snapshot = refreshed.toSet()
            recordedInstalledPackIdsCache.set(snapshot)
            return snapshot
        }
        return recordedInstalledPackIdsCache.get() ?: AuroraSpeechPackTask.entries
            .mapNotNull(::activePackId)
            .toSet()
    }

    private fun isRecordedPackReadyForRuntime(
        entry: VoicePackCatalogEntry,
        installedPackIds: Set<String>,
        referenceSelectionReady: Boolean,
    ): Boolean =
        entry.packId in installedPackIds &&
            isPackDescriptorRuntimeReady(entry) &&
            (!ttsReferenceRequired(entry) || referenceSelectionReady)

    /** Performs authoritative on-disk verification for activation paths. */
    private fun isPackReadyForRuntime(entry: VoicePackCatalogEntry): Boolean =
        isPackInstalledForRuntime(entry) &&
            isPackDescriptorRuntimeReady(entry) &&
            (!ttsReferenceRequired(entry) || ttsReferenceSelection() != null)

    private fun ttsReferenceRequired(entry: VoicePackCatalogEntry): Boolean =
        auroraTtsReferenceRequired(
            inferAuroraSpeechPackTask(entry.tasks),
            entry.modelFamily,
            entry.requiresReferenceAudio,
            entry.referenceAudioMode,
        )

    private fun activeRuntimeProfileSelection(): JSONObject? {
        val raw = activity
            .getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
            .getString(THIN_PROFILE_KEY, null)
            ?: return null
        val root = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val activeProfileId = root.optString("activeProfileId", "").takeIf { it.isNotBlank() }
        val profile = if (activeProfileId != null) {
            val profileMap = root.optJSONObject("profiles")
            val profileArray = root.optJSONArray("profiles")
            profileMap?.optJSONObject(activeProfileId)
                ?: profileArray?.let { profiles ->
                    (0 until profiles.length())
                        .mapNotNull { index -> profiles.optJSONObject(index) }
                        .firstOrNull { item -> item.optString("id") == activeProfileId }
                }
        } else {
            null
        } ?: root.optJSONObject("activeProfile")
            ?: root.optJSONObject("profile")
            ?: return null
        return profile
            .optJSONObject("localNode")
            ?.optJSONObject("localSpeechSelection")
            ?: profile.optJSONObject("localSpeechSelection")
    }

    private fun ttsReferenceSelection(): AuroraTtsReferenceSelection? {
        val prefs = ttsReferencePrefs()
        val stored = auroraTtsReferenceSelectionOrNull(
            prefs.getString(AURORA_TTS_REFERENCE_ID_KEY, null)?.trim().orEmpty(),
            prefs.getString(AURORA_TTS_REFERENCE_AUDIO_URI_KEY, null)?.trim().orEmpty(),
            prefs.getString(AURORA_TTS_REFERENCE_TEXT_KEY, null)?.trim().orEmpty(),
            prefs.getString(AURORA_TTS_REFERENCE_REVISION_KEY, null)?.trim().orEmpty(),
            prefs.getInt(AURORA_TTS_REFERENCE_SAMPLE_RATE_HZ_KEY, 0),
            parseReferenceSamples(prefs.getString(AURORA_TTS_REFERENCE_SAMPLES_KEY, "[]")),
        )
        if (stored != null) return stored
        val reference = activeRuntimeProfileSelection()
            ?.let { selection ->
                selection.optJSONObject("ttsReference")
                    ?: selection.optJSONObject("referenceVoice")
                    ?: selection.optJSONObject("voiceSample")
            }
            ?: return null
        return auroraTtsReferenceSelectionOrNull(
            reference.optString("id", reference.optString("referenceId", reference.optString("sampleId", ""))).trim(),
            reference.optString("audioUri", reference.optString("uri", "")).trim(),
            reference.optString("text", reference.optString("referenceText", "")).trim(),
            reference.optString("revision", reference.optString("sampleRevision", "")).trim(),
            reference.optInt("sampleRateHz", reference.optInt("sample_rate_hz", 0)),
            parseReferenceSamples(reference.optJSONArray("samples") ?: reference.optJSONArray("referenceSamples")),
        )
    }

    private fun storeTtsReferenceSelection(args: AndroidVoicePackReferenceArgs): Boolean {
        val id = args.referenceId?.trim().orEmpty()
        val audioUri = args.referenceAudioUri?.trim().orEmpty()
        val text = args.referenceText?.trim().orEmpty()
        val revision = args.referenceRevision?.trim().orEmpty()
        val samples = args.referenceSamples.orEmpty().map { it.toFloat() }.toFloatArray()
        val sampleRateHz = args.referenceSampleRateHz ?: 0
        if (
            id.isBlank() &&
            audioUri.isBlank() &&
            text.isBlank() &&
            revision.isBlank() &&
            sampleRateHz <= 0 &&
            samples.isEmpty()
        ) return ttsReferenceSelection() != null
        if (!auroraTtsReferenceAudioReady(id, sampleRateHz, samples)) return false
        if (samples.size > AURORA_TTS_REFERENCE_MAX_SAMPLES) return false
        if (samples.any { !it.isFinite() || it < -1.0f || it > 1.0f }) return false
        val encodedSamples = org.json.JSONArray().also { array ->
            samples.forEach { sample -> array.put(sample.toDouble()) }
        }.toString()
        clearLegacyTtsReferenceSelection()
        ttsReferencePrefs().edit()
            .putString(AURORA_TTS_REFERENCE_ID_KEY, id)
            .putString(AURORA_TTS_REFERENCE_AUDIO_URI_KEY, audioUri)
            .putString(AURORA_TTS_REFERENCE_TEXT_KEY, text)
            .putString(AURORA_TTS_REFERENCE_REVISION_KEY, revision)
            .putInt(AURORA_TTS_REFERENCE_SAMPLE_RATE_HZ_KEY, sampleRateHz)
            .putString(AURORA_TTS_REFERENCE_SAMPLES_KEY, encodedSamples)
            .apply()
        return true
    }

    private fun clearTtsReferenceSelection() {
        clearLegacyTtsReferenceSelection()
        ttsReferencePrefs().edit()
            .remove(AURORA_TTS_REFERENCE_ID_KEY)
            .remove(AURORA_TTS_REFERENCE_AUDIO_URI_KEY)
            .remove(AURORA_TTS_REFERENCE_TEXT_KEY)
            .remove(AURORA_TTS_REFERENCE_REVISION_KEY)
            .remove(AURORA_TTS_REFERENCE_SAMPLE_RATE_HZ_KEY)
            .remove(AURORA_TTS_REFERENCE_SAMPLES_KEY)
            .apply()
    }

    private fun clearLegacyTtsReferenceSelection() {
        voicePackPrefs().edit()
            .remove(AURORA_TTS_REFERENCE_ID_KEY)
            .remove(AURORA_TTS_REFERENCE_AUDIO_URI_KEY)
            .remove(AURORA_TTS_REFERENCE_TEXT_KEY)
            .remove(AURORA_TTS_REFERENCE_REVISION_KEY)
            .remove(AURORA_TTS_REFERENCE_SAMPLE_RATE_HZ_KEY)
            .remove(AURORA_TTS_REFERENCE_SAMPLES_KEY)
            .apply()
    }

    private fun ttsReferencePrefs() =
        activity.getSharedPreferences(AURORA_TTS_REFERENCE_PREFS, Context.MODE_PRIVATE)

    private fun parseReferenceSamples(raw: String?): FloatArray =
        parseReferenceSamples(runCatching { JSONArray(raw ?: "[]") }.getOrNull())

    private fun parseReferenceSamples(array: JSONArray?): FloatArray {
        if (array == null || array.length() == 0) return FloatArray(0)
        val samples = FloatArray(array.length())
        for (index in 0 until array.length()) {
            val value = array.optDouble(index, Double.NaN)
            if (!value.isFinite() || value < -1.0 || value > 1.0) return FloatArray(0)
            samples[index] = value.toFloat()
        }
        return samples
    }

    private fun requestedPackTask(entry: VoicePackCatalogEntry, requestedTask: String): AuroraSpeechPackTask? {
        val catalogTask = inferAuroraSpeechPackTask(entry.tasks) ?: return null
        val requested = requestedTask.trim().takeIf { it.isNotBlank() }?.let(::auroraSpeechPackTaskFromName)
        return when {
            requestedTask.isBlank() -> catalogTask
            requested == catalogTask -> requested
            else -> null
        }
    }

    private fun isActivePackReady(
        task: AuroraSpeechPackTask,
        installedPackIds: Set<String>,
        referenceSelectionReady: Boolean,
    ): Boolean {
        val active = activePackId(task) ?: return false
        val entry = findCatalogEntry(active) ?: return false
        return inferAuroraSpeechPackTask(entry.tasks) == task &&
            isRecordedPackReadyForRuntime(entry, installedPackIds, referenceSelectionReady)
    }

    private fun isPackMetadataRuntimeCompatible(entry: VoicePackCatalogEntry): Boolean {
        val osOk = entry.supportedOperatingSystems.any {
            it.lowercase(Locale.getDefault()).let { os -> os == "android" || os == "android-native" || os == Build.VERSION.SDK_INT.toString() }
        }
        if (!osOk) return false
        val abiOk = entry.supportedAbis.any { abi ->
            abi.trim().lowercase(Locale.getDefault()).let { supported ->
                supported in setOf("*", "all") || Build.SUPPORTED_ABIS.any { deviceAbi -> deviceAbi.lowercase(Locale.getDefault()) == supported }
            }
        }
        if (!abiOk) return false
        return inferAuroraSpeechPackTask(entry.tasks) != null
    }

    private fun isPackDescriptorRuntimeReady(entry: VoicePackCatalogEntry): Boolean =
        isPackMetadataRuntimeCompatible(entry) &&
            isValidHexSha256(entry.sha256) &&
            isPositiveAndBoundedSize(entry.sizeBytes)

    private fun isPackDownloadReady(entry: VoicePackCatalogEntry): Boolean = runCatching {
        parseVoicePackUri(entry.uri).toString()
        isPackDescriptorRuntimeReady(entry)
    }.getOrDefault(false)

    private fun isPackInstalledForRuntime(entry: VoicePackCatalogEntry): Boolean {
        val task = inferAuroraSpeechPackTask(entry.tasks) ?: return false
        if (!packCatalogIdRegex.matches(entry.packId)) return false
        return runCatching {
            AuroraNativeSpeechPackBridge.resolve(activity, entry.packId, task)
        }.getOrDefault(false)
    }

    private fun installPackForRuntime(
        entry: VoicePackCatalogEntry,
        task: AuroraSpeechPackTask,
        onProgress: (phase: String, completedBytes: Long, expectedBytes: Long) -> Unit,
    ): VoicePackDownloadResult {
        if (!isPackDownloadReady(entry)) return VoicePackDownloadResult.INVALID_INPUT
        return if (
            runCatching {
                AuroraNativeSpeechPackBridge.install(activity, entry.packId, task) { phase, completedBytes, expectedBytes ->
                    onProgress(phase, completedBytes, expectedBytes)
                }
            }.getOrDefault(false)
        ) {
            VoicePackDownloadResult.SUCCESS
        } else {
            VoicePackDownloadResult.WRITE_FAILED
        }
    }

    private fun removePackForRuntime(entry: VoicePackCatalogEntry): Boolean {
        val task = inferAuroraSpeechPackTask(entry.tasks) ?: return false
        return runCatching {
            AuroraNativeSpeechPackBridge.remove(activity, entry.packId, task)
        }.getOrDefault(false)
    }

    private fun wakePhraseSelection(): AuroraWakePhraseSelection? {
        val prefs = voicePackPrefs()
        val id = prefs.getString(AURORA_WAKE_PHRASE_ID_KEY, null)?.trim().orEmpty()
        val text = prefs.getString(AURORA_WAKE_PHRASE_TEXT_KEY, null)?.trim().orEmpty()
        val revision = prefs.getString(AURORA_WAKE_PHRASE_REVISION_KEY, null)?.trim().orEmpty()
        if (id.isNotBlank() && text.isNotBlank() && revision.isNotBlank()) {
            return AuroraWakePhraseSelection(id, text, revision)
        }
        return wakePhraseSelectionFromRuntimeProfile()
    }

    private fun wakePhraseSelectionFromRuntimeProfile(): AuroraWakePhraseSelection? {
        val raw = activity
            .getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
            .getString(THIN_PROFILE_KEY, null)
            ?: return null
        val root = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val activeProfileId = root.optString("activeProfileId", "").takeIf { it.isNotBlank() }
        val profile = if (activeProfileId != null) {
            val profileMap = root.optJSONObject("profiles")
            val profileArray = root.optJSONArray("profiles")
            profileMap?.optJSONObject(activeProfileId)
                ?: profileArray?.let { profiles ->
                    (0 until profiles.length())
                        .mapNotNull { index -> profiles.optJSONObject(index) }
                        .firstOrNull { item -> item.optString("id") == activeProfileId }
                }
        } else {
            null
        } ?: root.optJSONObject("activeProfile")
            ?: root.optJSONObject("profile")
            ?: return null
        val selection = profile
            .optJSONObject("localNode")
            ?.optJSONObject("localSpeechSelection")
            ?: profile.optJSONObject("localSpeechSelection")
            ?: return null
        val phrase = selection.optJSONObject("wakePhrase") ?: selection
        val id = phrase.optString("id", phrase.optString("phraseId", "")).trim()
        val text = phrase.optString("text", phrase.optString("phrase", "")).trim()
        val revision = phrase.optString("revision", phrase.optString("phraseRevision", "")).trim()
        return if (id.isNotBlank() && text.isNotBlank() && revision.isNotBlank()) {
            AuroraWakePhraseSelection(id, text, revision)
        } else {
            null
        }
    }

    private fun downloadPackToCache(
        source: String,
        packId: String,
        sha256: String,
        expectedSize: Long,
    ): Pair<VoicePackDownloadResult, Long> {
        if (!packCatalogIdRegex.matches(packId)) {
            return Pair(VoicePackDownloadResult.INVALID_INPUT, 0L)
        }
        val safePackId = safePackFileName(packId)
        if (!isValidHexSha256(sha256)) return Pair(VoicePackDownloadResult.INVALID_INPUT, 0L)
        if (!isPositiveAndBoundedSize(expectedSize)) return Pair(VoicePackDownloadResult.INVALID_INPUT, 0L)
        val root = File(activity.filesDir, VOICE_PACK_CACHE_DIR).apply { mkdirs() }
        val destination = File(root, safePackId)
        val temp = File(root, "${safePackId}.${System.currentTimeMillis()}.part")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L

        try {
            val uri = validateAndParseVoicePackUri(source)
            val resolvedUri = resolvePackDownloadUri(uri, expectedSize) ?: return Pair(
                VoicePackDownloadResult.REDIRECT_DENIED,
                0L,
            )
            val response = downloadInputStream(resolvedUri) ?: return Pair(VoicePackDownloadResult.WRITE_FAILED, 0L)
            response.use { responseStream ->
                BufferedInputStream(responseStream.input).use { input ->
                    FileOutputStream(temp).use { output ->
                        val buffer = ByteArray(256 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            total += read.toLong()
                            if (total > expectedSize || total > AURORA_SPEECH_PACK_MAX_ARCHIVE_BYTES) {
                                return Pair(VoicePackDownloadResult.SIZE_MISMATCH, 0L)
                            }
                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                        }
                        output.flush()
                        output.fd.sync()
                    }
                }
            }
            if (total != expectedSize || temp.length() != expectedSize || total < VOICE_PACK_MIN_BYTES) {
                return Pair(VoicePackDownloadResult.SIZE_MISMATCH, 0L)
            }
            val actualHash = hex(digest.digest())
            if (sha256 != actualHash) {
                return Pair(VoicePackDownloadResult.BAD_HASH, 0L)
            }
            if (!replaceFileAtomically(temp, destination)) {
                return Pair(VoicePackDownloadResult.WRITE_FAILED, 0L)
            }
            voicePackPrefs().edit().putString("${VOICE_PACK_INSTALLED_PREFIX}${packId}", "{\"sha256\":\"${actualHash}\"}").apply()
            return Pair(VoicePackDownloadResult.SUCCESS, destination.length().toLong())
        } catch (_: IllegalArgumentException) {
            return Pair(VoicePackDownloadResult.INVALID_INPUT, 0L)
        } catch (error: java.net.SocketTimeoutException) {
            return Pair(VoicePackDownloadResult.READ_TIMEOUT, 0L)
        } catch (error: java.net.UnknownHostException) {
            return Pair(VoicePackDownloadResult.INVALID_INPUT, 0L)
        } catch (_: java.net.ConnectException) {
            return Pair(VoicePackDownloadResult.CONNECT_TIMEOUT, 0L)
        } catch (_: Exception) {
            return Pair(VoicePackDownloadResult.WRITE_FAILED, 0L)
        } finally {
            if (temp.exists()) {
                temp.delete()
            }
            cleanStalePackArtifacts(packId)
        }
    }

    private fun isPackDownloaded(packId: String, expectedSha256: String?): Boolean {
        if (!packCatalogIdRegex.matches(packId)) return false
        val file = File(activity.filesDir, "${VOICE_PACK_CACHE_DIR}/${safePackFileName(packId)}")
        if (!file.exists() || !file.isFile) return false
        val expected = expectedSha256?.trim()?.lowercase().orEmpty()
        if (expected.isBlank()) return true
        val actual = FileInputStream(file).use { fis ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(256 * 1024)
            while (true) {
                val count = fis.read(buffer)
                if (count <= 0) break
                digest.update(buffer, 0, count)
            }
            hex(digest.digest())
        }
        return expected == actual
    }

    /**
     * Validate catalog URI structure without performing network I/O.
     *
     * Catalog normalization and readiness checks run on the plugin command
     * thread, where Android rejects DNS lookups. The download worker calls
     * [validateAndParseVoicePackUri] before connecting, and redirect handling
     * repeats the resolved-address checks for every destination.
     */
    private fun parseVoicePackUri(source: String): URI {
        val trimmed = source.trim()
        val uri = runCatching { URI(trimmed) }.getOrElse { throw IllegalArgumentException("voice_pack_invalid_uri") }
        if (uri.scheme?.lowercase(Locale.getDefault()) != "https") {
            throw IllegalArgumentException("voice_pack_non_https")
        }
        if (uri.userInfo != null || uri.fragment != null) {
            throw IllegalArgumentException("voice_pack_unsafe_uri")
        }
        val host = uri.host?.lowercase(Locale.getDefault()) ?: throw IllegalArgumentException("voice_pack_missing_host")
        if (!isAllowedPackHost(host)) {
            throw IllegalArgumentException("voice_pack_disallowed_host")
        }
        return uri
    }

    private fun validateAndParseVoicePackUri(source: String): URI {
        val uri = parseVoicePackUri(source)
        val host = uri.host ?: throw IllegalArgumentException("voice_pack_missing_host")
        val addresses = runCatching { InetAddress.getAllByName(host) }.getOrElse { throw UnknownHostException(uri.host) }
        if (addresses.any { isPrivateOrLocalHostAddress(it) }) {
            throw IllegalArgumentException("voice_pack_local_network_host")
        }
        return uri
    }

    private fun isAllowedPackHost(host: String): Boolean {
        val normalized = host.trim().lowercase(Locale.getDefault())
        if (normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1" || normalized == "0.0.0.0") {
            return false
        }
        if (normalized.startsWith("10.") || normalized.startsWith("192.168.") || normalized.startsWith("169.254.")) return false
        if (normalized.startsWith("172.")) {
            val second = normalized.split('.').getOrNull(1)?.toIntOrNull() ?: return false
            if (second in 16..31) return false
        }
        return true
    }

    private fun isPrivateOrLocalHostAddress(address: InetAddress): Boolean =
        address.isLoopbackAddress ||
            address.isAnyLocalAddress ||
            address.isLinkLocalAddress ||
            address.isSiteLocalAddress ||
            address.isMulticastAddress

    private fun resolvePackDownloadUri(uri: URI, expectedBytes: Long): URI? {
        var redirectsLeft = VOICE_PACK_DOWNLOAD_REDIRECT_LIMIT
        var current = uri
        while (redirectsLeft >= 0) {
            val connection = runCatching { current.toURL().openConnection() as HttpURLConnection }.getOrElse { null } ?: return null
            try {
                connection.instanceFollowRedirects = false
                connection.requestMethod = "GET"
                connection.connectTimeout = VOICE_PACK_DOWNLOAD_CONNECT_TIMEOUT_MS
                connection.readTimeout = VOICE_PACK_DOWNLOAD_READ_TIMEOUT_MS
                connection.connect()
                when (connection.responseCode) {
                    in 300..399 -> {
                        val location = connection.getHeaderField("Location")
                        val next = resolveRedirectUri(current, location) ?: return null
                        redirectsLeft -= 1
                        current = next
                    }
                    in 200..299 -> {
                        val contentLength = connection.contentLengthLong
                        if (contentLength >= 0 && contentLength > expectedBytes) {
                            return null
                        }
                        return current
                    }
                    else -> return null
                }
            } finally {
                connection.disconnect()
            }
        }
        return null
    }

    private fun resolveRedirectUri(base: URI, location: String?): URI? {
        if (location.isNullOrBlank()) return null
        val resolved = runCatching { URI(location) }.getOrElse { runCatching { base.resolve(location) }.getOrNull() } ?: return null
        if (!isAllowedPackUri(resolved)) return null
        return resolved
    }

    private fun isAllowedPackUri(uri: URI): Boolean = runCatching {
        val scheme = uri.scheme?.lowercase(Locale.getDefault()) ?: return false
        if (scheme != "https") return false
        if (uri.userInfo != null || uri.fragment != null) return false
        val host = uri.host?.lowercase(Locale.getDefault()) ?: return false
        if (!isAllowedPackHost(host)) return false
        val addresses = InetAddress.getAllByName(host)
        if (addresses.any { isPrivateOrLocalHostAddress(it) }) return false
        true
    }.getOrElse { false }

    private data class VoicePackDownloadStream(val input: java.io.InputStream, val connection: HttpURLConnection) : AutoCloseable {
        override fun close() {
            input.close()
            connection.disconnect()
        }
    }

    private fun downloadInputStream(uri: URI): VoicePackDownloadStream? {
        val connection = runCatching { uri.toURL().openConnection() as HttpURLConnection }.getOrElse { null } ?: return null
        connection.instanceFollowRedirects = false
        connection.requestMethod = "GET"
        connection.connectTimeout = VOICE_PACK_DOWNLOAD_CONNECT_TIMEOUT_MS
        connection.readTimeout = VOICE_PACK_DOWNLOAD_READ_TIMEOUT_MS
        connection.setRequestProperty("Accept", "application/octet-stream,application/*")
        return try {
            connection.connect()
            if (connection.responseCode !in 200..299) {
                connection.disconnect()
                null
            } else {
                VoicePackDownloadStream(connection.inputStream, connection)
            }
        } catch (_: Exception) {
            connection.disconnect()
            null
        }
    }

    private fun replaceFileAtomically(temp: File, destination: File): Boolean {
        if (destination.exists() && !destination.delete()) {
            return false
        }
        val renamed = temp.renameTo(destination)
        if (!renamed) {
            try {
                FileOutputStream(destination).use { output ->
                    FileInputStream(temp).use { input ->
                        input.copyTo(output)
                    }
                }
                if (!temp.delete()) {
                    return false
                }
            } catch (_: Exception) {
                return false
            }
        }
        return destination.exists()
    }

    private fun cleanStalePackArtifacts(packId: String) {
        if (!packCatalogIdRegex.matches(packId)) return
        val safePackId = safePackFileName(packId)
        val cacheDir = File(activity.filesDir, VOICE_PACK_CACHE_DIR)
        val partSuffix = "${safePackId}."
        cacheDir.listFiles()?.forEach { file ->
            if (file.isFile && (file.name == safePackId || file.name.startsWith(partSuffix))) {
                if (file.name.endsWith(".part")) {
                    file.delete()
                } else if (file.lastModified() < currentUnixMs() - VOICE_PACK_LOCK_STALE_AGE_MS && file.length() == 0L) {
                    file.delete()
                }
            }
        }
    }

    private fun removePackFiles(packId: String): Boolean {
        if (!packCatalogIdRegex.matches(packId)) return false
        val file = File(activity.filesDir, VOICE_PACK_CACHE_DIR).resolve(safePackFileName(packId))
        if (file.exists()) {
            file.delete()
        }
        if (!file.exists()) {
            cleanStalePackArtifacts(packId)
            voicePackPrefs().edit().remove("${VOICE_PACK_INSTALLED_PREFIX}${packId}").apply()
            return true
        }
        return false
    }

    private fun safePackFileName(packId: String): String {
        return packId.lowercase().filter { it.isLetterOrDigit() || it in "._-" }.ifBlank { "pack.bin" }
    }

    private fun isValidHexSha256(value: String): Boolean =
        VOICE_PACK_SHA256_HEX_REGEX.toRegex().matches(value.trim().lowercase(Locale.getDefault()))

    private fun isPositiveAndBoundedSize(size: Long): Boolean =
        size in VOICE_PACK_MIN_BYTES..AURORA_SPEECH_PACK_MAX_ARCHIVE_BYTES

    private fun stringListFromJSONArray(entry: JSONObject, key: String): List<String> {
        val array = entry.optJSONArray(key) ?: return emptyList()
        val out = ArrayList<String>(array.length())
        for (index in 0 until array.length()) {
            val value = array.optString(index, "").trim().lowercase(Locale.getDefault())
            if (value.isNotBlank()) out.add(value)
        }
        return out
    }

    private fun roleManagerOrNull(): RoleManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            activity.getSystemService(RoleManager::class.java)
        } else {
            null
        }

    private fun hasPostNotificationsPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasRuntimePermission(Manifest.permission.POST_NOTIFICATIONS)

    private fun canPostNotifications(): Boolean =
        hasPostNotificationsPermission() && NotificationManagerCompat.from(activity).areNotificationsEnabled()

    private fun hasForegroundServiceMicrophonePermission(): Boolean =
        Build.VERSION.SDK_INT < 34 || hasRuntimePermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE)

    private fun hasForegroundServiceConnectedDevicePermission(): Boolean =
        Build.VERSION.SDK_INT < 34 ||
            (
                hasPackagePermission(Manifest.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE) &&
                    hasPackagePermission(Manifest.permission.CHANGE_NETWORK_STATE)
            )

    private fun voiceForegroundServiceStatusObject(
        microphoneGranted: Boolean = hasRuntimePermission(Manifest.permission.RECORD_AUDIO),
        notificationsGranted: Boolean = hasPostNotificationsPermission(),
        foregroundServiceReady: Boolean = hasForegroundServiceMicrophonePermission() && microphoneGranted,
    ): JSObject {
        val manifestReady = hasPackagePermission(Manifest.permission.FOREGROUND_SERVICE) &&
            (Build.VERSION.SDK_INT < 34 || hasPackagePermission(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE)) &&
            hasForegroundServiceConnectedDevicePermission()
        val nativeConfig = AuroraVoiceNativeConfigStore.load(activity)
        val nativeRouteReady = nativeConfig != null
        val installedPackIds = recordedInstalledPackIds()
        val referenceSelectionReady = ttsReferenceSelection() != null
        val localDuplexReady =
            isActivePackReady(AuroraSpeechPackTask.STT, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.TTS, installedPackIds, referenceSelectionReady)
        val backgroundRuntimeReady = localDuplexReady &&
            isActivePackReady(AuroraSpeechPackTask.VAD, installedPackIds, referenceSelectionReady) &&
            isActivePackReady(AuroraSpeechPackTask.KWS, installedPackIds, referenceSelectionReady) &&
            wakePhraseSelection() != null
        val notificationReady = canPostNotifications()
        val focusedRuntimeReady = localDuplexReady
        // A denied notification permission degrades the one Aurora shade entry;
        // it never blocks starting, and it never ends a running session.
        val startable = microphoneGranted && foregroundServiceReady && manifestReady && focusedRuntimeReady
        val backgroundStartable = microphoneGranted && foregroundServiceReady && manifestReady && backgroundRuntimeReady
        val ret = JSObject()
        ret.put("platform", "android")
        val capture = AuroraRuntimeForegroundService.captureSnapshot
        val running = AuroraRuntimeForegroundService.running
        val backgroundSessionActive = AuroraRuntimeForegroundService.backgroundSessionActive
        val foregroundReasons = AuroraRuntimeForegroundService.activeForegroundReasonIds()
        val focusedVoiceActive = running &&
            !backgroundSessionActive &&
            (capture.captureActive || capture.runtimeActive || "voice" in foregroundReasons)
        ret.put("running", running)
        ret.put("backgroundSessionActive", backgroundSessionActive)
        ret.put("focusedVoiceActive", focusedVoiceActive)
        ret.put("captureActive", capture.captureActive)
        ret.put("microphoneSignalDetected", capture.microphoneSignalDetected)
        ret.put("microphoneSilenced", capture.microphoneSilenced)
        ret.put("captureBackend", "android-audiorecord-rust-queue")
        ret.put("sampleRateHz", capture.sampleRateHz)
        ret.put("acceptedChunks", capture.acceptedChunks)
        ret.put("acceptedSamples", capture.acceptedSamples)
        ret.put("droppedChunks", capture.droppedChunks)
        ret.put("discontinuities", capture.discontinuities)
        ret.put("queuedChunks", capture.queuedChunks)
        ret.put("runtimeActive", capture.runtimeActive)
        ret.put("runtimePhase", capture.runtimePhase)
        ret.put("sessionGeneration", capture.sessionGeneration)
        ret.put("completedTurns", capture.completedTurns)
        ret.put("failedTurns", capture.failedTurns)
        ret.put("queuedOutputChunks", capture.queuedOutputChunks)
        ret.put("captureError", capture.errorCode)
        ret.put("startable", startable)
        ret.put("microphoneGranted", microphoneGranted)
        ret.put("notificationsGranted", notificationsGranted)
        ret.put("notificationReady", notificationReady)
        ret.put("notificationsSuppressed", !notificationReady || AuroraRuntimeForegroundService.notificationsSuppressed)
        ret.put("foregroundReasons", org.json.JSONArray(foregroundReasons))
        ret.put("foregroundServiceReady", foregroundServiceReady)
        ret.put("manifestReady", manifestReady)
        ret.put("nativeSessionReady", nativeRouteReady)
        ret.put("localDuplexReady", localDuplexReady)
        ret.put("backgroundRuntimeReady", backgroundRuntimeReady)
        ret.put("backgroundStartable", backgroundStartable)
        ret.put(
            "backgroundStoppedByUser",
            AuroraRuntimeForegroundService.backgroundStoppedByUser(activity),
        )
        ret.put("state", voiceForegroundState(startable, manifestReady, microphoneGranted, notificationReady, nativeRouteReady))
        ret.put(
            "reason",
            voiceForegroundReason(
                startable,
                manifestReady,
                microphoneGranted,
                notificationReady,
                nativeRouteReady,
                !focusedRuntimeReady,
            ),
        )
        ret.put("privacyClass", "raw-audio")
        ret.put("backendAudioEvidenceRequired", !capture.captureActive)
        ret.put("evidenceSource", "android-permission-foreground-service")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun voiceForegroundServiceStatusWithRouteSync(): JSObject {
        val voiceRoute = syncNativeVoiceRoute()
        return voiceForegroundServiceStatusObject().apply {
            put("voiceRoute", voiceRoute)
            put("nativeRouteReason", voiceRoute.optString("reason", "voice_route_unknown"))
        }
    }

    private fun voiceForegroundState(
        startable: Boolean,
        manifestReady: Boolean,
        microphoneGranted: Boolean,
        notificationReady: Boolean,
        nativeSessionReady: Boolean,
    ): String {
        if (!manifestReady) return "unsupported_platform"
        if (!microphoneGranted) return "needs_native_permission"
        if (!notificationReady) return "degraded"
        if (!nativeSessionReady) return "degraded"
        if (startable) return "available"
        return "degraded"
    }

    private fun voiceForegroundReason(
        startable: Boolean,
        manifestReady: Boolean,
        microphoneGranted: Boolean,
        notificationReady: Boolean,
        nativeSessionReady: Boolean,
        localSpeechSetupRequired: Boolean,
    ): String {
        if (!manifestReady) return "foreground_service_manifest_missing"
        if (!microphoneGranted) return "microphone_permission_missing"
        if (!notificationReady) return "notification_delivery_unavailable"
        if (!nativeSessionReady) return "native_voice_runtime_missing"
        if (localSpeechSetupRequired) return "local_speech_setup_required"
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
        ret.put("allowedKeyPrefixes", "aurora.session,aurora.auth,aurora.gateway,aurora.mesh,aurora.admin,aurora.voice")
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
            "aurora.android.notifications", "android.notifications", "aurora.android.showNotification", "android.showNotification" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
            "aurora.android.voiceForegroundService", "android.voiceForegroundService" ->
                listOfNotNull(
                    Manifest.permission.RECORD_AUDIO,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.POST_NOTIFICATIONS else null,
                )
            else -> emptyList()
        }

    private fun canResolveIntent(intent: Intent): Boolean =
        intent.resolveActivity(activity.packageManager) != null

    private fun canResolveExternalIntent(intent: Intent): Boolean =
        resolvingActivityComponents(intent).any { it.packageName != activity.packageName }

    private fun resolvingActivityComponents(intent: Intent): List<ComponentName> =
        activity.packageManager
            .queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
            .mapNotNull { resolveInfo ->
                resolveInfo.activityInfo?.let { info -> ComponentName(info.packageName, info.name) }
            }

    private fun boundedRequiredString(field: String, value: String, maxLen: Int): String {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) throw IllegalArgumentException("${field}_required")
        if (trimmed.length > maxLen) throw IllegalArgumentException("${field}_too_long")
        return trimmed
    }

    private fun boundedOptionalString(field: String, value: String, maxLen: Int): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.length > maxLen) throw IllegalArgumentException("${field}_too_long")
        return trimmed
    }

    private fun validateOutboundDeepLink(value: String): Uri {
        val raw = boundedRequiredString("url", value, 2048)
        val uri = Uri.parse(raw)
        val scheme = uri.scheme?.lowercase() ?: throw IllegalArgumentException("permission_denied")
        if (scheme !in setOf("https", "mailto", "tel", "aurora", "aurora-local")) {
            throw IllegalArgumentException("permission_denied")
        }
        if (scheme == "https" && uri.host.isNullOrBlank()) throw IllegalArgumentException("permission_denied")
        if ((scheme == "mailto" || scheme == "tel") && uri.schemeSpecificPart.isNullOrBlank()) {
            throw IllegalArgumentException("permission_denied")
        }
        return uri
    }

    private fun ensureActionNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            AURORA_ACTION_NOTIFICATION_CHANNEL_ID,
            "Aurora actions",
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        channel.description = "Shows Aurora device action results."
        val manager = activity.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
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

    private fun base64UrlEncode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun base64UrlDecode(value: String): ByteArray {
        if (value.isEmpty() || value.contains("=")) throw IllegalArgumentException("base64url_invalid")
        val bytes = Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        if (base64UrlEncode(bytes) != value) throw IllegalArgumentException("base64url_not_canonical")
        return bytes
    }

    private fun secureStorageResult(key: String): JSObject {
        val ret = secureStorageStatusObject()
        ret.put("key", key)
        return ret
    }

    private fun validateSecureStorageKey(key: String) {
        if (key.startsWith(PEER_PROOF_PREFIX)) {
            throw IllegalArgumentException("peer reconnect credential namespace is opaque-only")
        }
        if (key.startsWith(INBOUND_VERIFIER_STORAGE_PREFIX) || key.startsWith("$INBOUND_VERIFIER_KEY_PREFIX:")) {
            throw IllegalArgumentException("inbound verifier namespace is opaque-only")
        }
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
            "aurora.voice",
        )
        if (allowed.none { key == it || key.startsWith("${it}.") || key.startsWith("${it}-") || key.startsWith("${it}_") }) {
            throw IllegalArgumentException("secure storage key must be in an Aurora credential namespace")
        }
    }


    private fun thinPeerCredentialStorageStatusObject(): JSObject {
        val ret = secureStorageStatusObject()
        ret.put("backend", "android-keystore")
        ret.put("privacyClass", "opaque-peer-reconnect-proof")
        ret.put("rawGetter", false)
        ret.put("allowedGenericSecureStorage", false)
        ret.put("evidenceSource", "android-keystore-peer-proof-namespace")
        return ret
    }

    private fun thinRoomSecretStatusObject(): JSObject {
        val ret = secureStorageStatusObject()
        ret.put("backend", "android-keystore")
        ret.put("privacyClass", "secret")
        ret.put("rawGetter", true)
        ret.put("allowedGenericSecureStorage", false)
        ret.put("evidenceSource", "android-keystore-thin-room-secret-namespace")
        return ret
    }

    private fun thinProfileStatusObject(): JSObject {
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("backend", "android-private-shared-preferences")
        ret.put("persisted", true)
        ret.put("privacyClass", "nonsecret-connection-profile")
        ret.put("secretsRedacted", true)
        return ret
    }

    /**
     * Resolve the native voice route from the active runtime profile and the
     * native peer credential store. Both remote-console and mesh-node profiles
     * may legitimately own a Gateway route. This deliberately does not select
     * or gate a role; it only mirrors the route already authorized by
     * onboarding/profile state.
     */
    private fun syncNativeVoiceRoute(): JSObject {
        val profile = activity
            .getSharedPreferences(THIN_PROFILE_PREFS, Context.MODE_PRIVATE)
            .getString(THIN_PROFILE_KEY, null)
            ?.let { raw -> runCatching { JSONObject(raw) }.getOrNull() }
        val candidate = profile?.let(::voiceRouteCandidate)
        if (candidate == null) {
            AuroraVoiceNativeConfigStore.clearRoute(activity)
            return voiceRouteStatusObject("voice_route_profile_missing")
        }

        if (candidate.mode == "webrtc-only") {
            AuroraVoiceNativeConfigStore.clearRoute(activity)
            return voiceRouteStatusObject("voice_route_configured")
        }

        val gateway = candidate.gateway ?: run {
            AuroraVoiceNativeConfigStore.clearRoute(activity)
            return voiceRouteStatusObject("voice_route_profile_missing")
        }
        val uri = Uri.parse(gateway)
        val loopback = uri.host == "127.0.0.1" || uri.host == "localhost" || uri.host == "::1"
        val bearer = candidate.peerId
            ?.let(::loadUnexpiredThinPeerCredential)
            ?.optString("rawBearerToken")
            .orEmpty()
        if (!loopback && bearer.isBlank()) {
            AuroraVoiceNativeConfigStore.clearRoute(activity)
            return voiceRouteStatusObject("voice_route_credential_missing")
        }

        return try {
            AuroraVoiceNativeConfigStore.setRoute(activity, gateway, bearer)
            voiceRouteStatusObject("voice_route_configured")
        } catch (_: Exception) {
            AuroraVoiceNativeConfigStore.clearRoute(activity)
            voiceRouteStatusObject("voice_route_invalid")
        }
    }

    private fun voiceRouteCandidate(document: JSONObject): VoiceRouteCandidate? {
        val profiles = document.optJSONArray("profiles") ?: return null
        val activeProfileId = document.optString("activeProfileId").takeIf { it.isNotBlank() } ?: return null
        val profile = (0 until profiles.length())
            .mapNotNull { profiles.optJSONObject(it) }
            .firstOrNull { it.optString("id") == activeProfileId }
            ?: return null
        val home = profile.optJSONObject("homeConnection")
        val mode = home?.optString("mode")?.takeIf { it.isNotBlank() }
            ?: profile.optString("mode").takeIf { it.isNotBlank() }
        if (mode == null || mode !in setOf("http-only", "webrtc-preferred", "webrtc-only")) return null
        val gateway = home?.optString("gatewayUrl")?.trim()?.takeIf { it.isNotBlank() }
            ?: profile.optString("gatewayUrl").trim().takeIf { it.isNotBlank() }
        val homeWebRtc = home?.optJSONObject("webrtcProfile")
        val profileWebRtc = profile.optJSONObject("webrtcProfile")
        val peerId = home?.optString("homePeerId")?.takeIf { it.isNotBlank() }
            ?: homeWebRtc?.optString("expectedStablePeerId")?.takeIf { it.isNotBlank() }
            ?: profileWebRtc?.optString("expectedStablePeerId")?.takeIf { it.isNotBlank() }
        if (mode == "webrtc-only" && peerId == null) return null
        if (mode != "webrtc-only" && gateway == null) return null
        return VoiceRouteCandidate(mode, gateway, peerId)
    }

    private fun voiceRouteStatusObject(reason: String): JSObject {
        val configured = AuroraVoiceNativeConfigStore.hasAssistantRoute(activity)
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("configured", configured)
        ret.put("reason", if (configured) "voice_route_configured" else reason)
        ret.put("secretsRedacted", true)
        ret.put("redactedFields", JSArray().apply { put("gateway"); put("bearer") })
        return ret
    }

    private fun webviewMicrophonePolicyStatusObject(): JSObject {
        val ret = JSObject()
        ret.put("available", true)
        ret.put("allowWildcard", false)
        ret.put("allowHttp", false)
        ret.put("requiresForeground", true)
        ret.put("requiresFocused", true)
        ret.put("requiresRecordAudio", true)
        ret.put("resource", PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        ret.put("configuredHttpsOrigins", JSArray().apply { configuredMicOrigins.forEach { put(it) } })
        ret.put("installedWebChromeClient", true)
        ret.put("delegateWebChromeClientCaptured", webChromeClientDelegateCaptured)
        ret.put("micDenyFailureCount", micDenyFailureCount)
        ret.put("lastMicDenyFailureReason", lastMicDenyFailureReason ?: JSONObject.NULL)
        ret.put("evidenceSource", "android-webview-permission-policy")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun lifecycleStatusObject(phase: String? = null): JSObject {
        val backgroundWakeword = AuroraRuntimeForegroundService.running &&
            AuroraRuntimeForegroundService.backgroundSessionActive
        val ret = JSObject()
        ret.put("platform", "android")
        if (phase != null) ret.put("phase", phase)
        ret.put("eventName", "aurora://android-lifecycle")
        ret.put("foreground", foreground)
        ret.put("focused", focused)
        ret.put("mustReleaseMicrophone", (!foreground || !focused) && !backgroundWakeword)
        ret.put("backgroundWakeword", backgroundWakeword)
        ret.put(
            "reason",
            when {
                backgroundWakeword -> "background_wakeword_active"
                foreground && focused -> "foreground_focused"
                else -> "release_mic_until_explicit_resume"
            },
        )
        ret.put("micDenyFailureCount", micDenyFailureCount)
        ret.put("lastMicDenyFailureReason", lastMicDenyFailureReason ?: JSONObject.NULL)
        ret.put("evidenceSource", "android-activity-lifecycle-callbacks")
        ret.put("secretsRedacted", true)
        return ret
    }

    private fun emitLifecycle(phase: String) {
        trigger("aurora://android-lifecycle", lifecycleStatusObject(phase))
    }

    private fun acknowledgeForegroundAppOpen() {
        if (!clearBackgroundStopOnNextResume) return
        AuroraRuntimeForegroundService.clearBackgroundStoppedByUser(activity)
        clearBackgroundStopOnNextResume = false
    }

    private fun scheduleBackgroundVoiceAutoStart() {
        if (!foreground || !focused || activity.isFinishing || activity.isDestroyed) return
        if (AuroraRuntimeForegroundService.backgroundStoppedByUser(activity)) return
        val generation = backgroundVoiceAutoStartGeneration.incrementAndGet()
        try {
            backgroundVoiceAutoStartExecutor.execute {
                val ready = runCatching {
                    voiceForegroundServiceStatusObject().getBoolean("backgroundStartable")
                }.getOrDefault(false)
                if (!ready || generation != backgroundVoiceAutoStartGeneration.get()) return@execute
                activity.runOnUiThread {
                    if (
                        generation != backgroundVoiceAutoStartGeneration.get() ||
                        !foreground ||
                        !focused ||
                        activity.isFinishing ||
                        activity.isDestroyed ||
                        AuroraRuntimeForegroundService.backgroundStoppedByUser(activity) ||
                        AuroraRuntimeForegroundService.backgroundSessionActive
                    ) return@runOnUiThread
                    val intent = Intent(activity, AuroraRuntimeForegroundService::class.java).apply {
                        action = AuroraRuntimeForegroundService.ACTION_START_BACKGROUND
                    }
                    runCatching {
                        ContextCompat.startForegroundService(activity, intent)
                    }.onFailure { error ->
                        Log.w(
                            LOG_TAG,
                            "redacted_background_voice_autostart_failed error=${error.javaClass.simpleName}",
                        )
                    }
                }
            }
        } catch (_: RejectedExecutionException) {
            // The Activity and its plugin are already being destroyed.
        }
    }

    private fun requestFocusedVoiceReleaseOnBackground(): Boolean {
        if (AuroraRuntimeForegroundService.backgroundSessionActive ||
            !AuroraRuntimeForegroundService.foregroundVoiceSessionActive()
        ) {
            return false
        }
        val stopIntent = Intent(activity, AuroraRuntimeForegroundService::class.java).apply {
            action = AuroraRuntimeForegroundService.ACTION_STOP
        }
        return runCatching {
            activity.startService(stopIntent)
            true
        }
            .onFailure { error ->
                Log.w(
                    LOG_TAG,
                    "redacted_focused_voice_release_failed error=${error.javaClass.simpleName}",
                )
            }
            .getOrDefault(false)
    }

    private fun denyPendingMicRequests() {
        val pending = synchronized(pendingMicRequests) {
            val copy = pendingMicRequests.toList()
            pendingMicRequests.clear()
            copy
        }
        pending.forEach { request ->
            try {
                request.deny()
            } catch (error: Exception) {
                recordMicDenyFailure("pending_mic_deny_failed", error)
            }
        }
    }

    internal fun recordMicDenyFailure(reason: String, error: Exception) {
        micDenyFailureCount += 1
        lastMicDenyFailureReason = reason
        Log.w(LOG_TAG, "redacted_mic_permission_deny_failure reason=$reason error=${error.javaClass.simpleName}")
    }

    private fun existingWebChromeClient(webView: WebView): WebChromeClient? =
        try {
            WebView::class.java.getMethod("getWebChromeClient").invoke(webView) as? WebChromeClient
        } catch (_: Exception) {
            null
        }

    private fun thinPeerCredentialKey(peerId: String): String =
        PEER_PROOF_PREFIX + sha256Hex(peerId.toByteArray(Charsets.UTF_8))

    private fun thinRoomSecretKey(ref: String): String =
        ROOM_SECRET_PREFIX + sha256Hex(ref.toByteArray(Charsets.UTF_8))

    private fun loadUnexpiredThinPeerCredential(peerId: String): JSONObject? {
        val key = thinPeerCredentialKey(peerId)
        val stored = securePrefs().getString(key, null) ?: return null
        val record = try {
            JSONObject(decryptSecureValue(stored))
        } catch (_: Exception) {
            securePrefs().edit().remove(key).apply()
            return null
        }
        try {
            validateThinPeerCredentialRecord(record)
        } catch (_: Exception) {
            securePrefs().edit().remove(key).apply()
            return null
        }
        val expiresAt = record.optLong("expiresAtMs", 0L)
        if (expiresAt > 0 && expiresAt <= currentUnixMs()) {
            securePrefs().edit().remove(key).apply()
            return null
        }
        return record
    }

    private fun thinPeerStatusResponse(peerId: String, record: JSONObject?, hasToken: Boolean): JSObject {
        val ret = thinPeerCredentialStorageStatusObject()
        ret.put("peerId", peerId)
        ret.put("found", record != null)
        ret.put("hasBearerToken", hasToken)
        ret.put("credential", record?.let { thinPeerMetadata(peerId, it) })
        ret.put("redactedFields", redactedFields())
        return ret
    }

    private fun thinPeerProofResponse(peerId: String, record: JSONObject?, matched: Boolean, proof: JSONObject?): JSObject {
        val ret = thinPeerCredentialStorageStatusObject()
        ret.put("peerId", peerId)
        ret.put("found", record != null)
        ret.put("matched", matched)
        ret.put("proof", proof)
        ret.put("credential", record?.let { thinPeerMetadata(peerId, it) })
        ret.put("redactedFields", redactedFields())
        return ret
    }

    private fun thinPeerMetadata(peerId: String, record: JSONObject): JSObject {
        val metadata = JSObject()
        metadata.put("peerId", peerId)
        metadata.put("tokenId", record.getString("tokenId"))
        metadata.put("claimantPeerId", record.getString("claimantPeerId"))
        metadata.put("verifierPeerId", record.getString("verifierPeerId"))
        metadata.put("claimantSignalingPeerId", record.getString("claimantSignalingPeerId"))
        metadata.put("verifierSignalingPeerId", record.getString("verifierSignalingPeerId"))
        metadata.put("roomName", record.getString("roomName"))
        if (record.has("createdAtMs")) metadata.put("createdAtMs", record.getLong("createdAtMs"))
        if (record.has("expiresAtMs")) metadata.put("expiresAtMs", record.getLong("expiresAtMs"))
        return metadata
    }

    private fun redactedFields(): JSArray {
        val fields = JSArray()
        fields.put("rawBearerToken")
        return fields
    }

    private fun inboundVerifierRedactedFields(): JSArray {
        val fields = JSArray()
        fields.put("tokenHashHex")
        fields.put("rawBearerToken")
        fields.put("proof")
        fields.put("verifierKey")
        return fields
    }

    private fun inboundVerifierGetResponse(value: String?): JSObject {
        val ret = inboundVerifierStatusObject()
        ret.put("found", value != null)
        ret.put("value", value ?: JSONObject.NULL)
        return ret
    }

    private fun inboundVerifierWriteResponse(ok: Boolean): JSObject {
        val ret = inboundVerifierStatusObject()
        ret.put("ok", ok)
        return ret
    }

    private fun inboundVerifierStatusObject(): JSObject {
        val ret = JSObject()
        ret.put("platform", "android")
        ret.put("backend", "android-keystore")
        ret.put("persisted", true)
        ret.put("privacyClass", "inbound-verifier")
        ret.put("rawGetter", true)
        ret.put("allowedGenericSecureStorage", false)
        ret.put("evidenceSource", "android-keystore-inbound-verifier-namespace")
        ret.put("secretsRedacted", true)
        ret.put("redactedFields", inboundVerifierRedactedFields())
        return ret
    }

    private fun inboundVerifierArgs(args: InboundVerifierSecretArgs): InboundVerifierSecretRequestArg =
        if (args.request.key.isNotEmpty() || args.request.value.isNotEmpty()) args.request else args

    private fun validateInboundVerifierSecretKey(key: String) {
        parseInboundVerifierSecretKey(key)
    }

    private fun parseInboundVerifierSecretKey(key: String): InboundVerifierSelector {
        if (key.isEmpty() || key.toByteArray(Charsets.UTF_8).size > 4096) {
            throw IllegalArgumentException("inbound verifier key length must be 1..4096 bytes")
        }
        val prefix = "$INBOUND_VERIFIER_KEY_PREFIX:"
        if (!key.startsWith(prefix)) {
            throw IllegalArgumentException("inbound verifier key must use the SDK peer-host namespace")
        }
        val parts = key.removePrefix(prefix).split(":")
        if (parts.size != 4 || parts.any { it.isEmpty() }) {
            throw IllegalArgumentException("inbound verifier key selector is invalid")
        }
        val verifierPeerId = decodeSdkKeyPart(parts[0], "verifierPeerId")
        val claimantPeerId = decodeSdkKeyPart(parts[1], "claimantPeerId")
        val roomName = decodeSdkKeyPart(parts[2], "roomName")
        val tokenId = decodeSdkKeyPart(parts[3], "tokenId")
        if (
            encodeSdkKeyPart(verifierPeerId) != parts[0] ||
            encodeSdkKeyPart(claimantPeerId) != parts[1] ||
            encodeSdkKeyPart(roomName) != parts[2] ||
            encodeSdkKeyPart(tokenId) != parts[3]
        ) {
            throw IllegalArgumentException("inbound verifier key must be canonical")
        }
        validateSafePeerAuthorityId("verifierPeerId", verifierPeerId, 256)
        validateSafePeerAuthorityId("claimantPeerId", claimantPeerId, 256)
        validateNonEmptyBytes("roomName", roomName, 512)
        validateSafePeerAuthorityId("tokenId", tokenId, 256)
        return InboundVerifierSelector(tokenId, claimantPeerId, verifierPeerId, roomName)
    }

    private fun inboundVerifierStorageAccount(key: String): String {
        validateInboundVerifierSecretKey(key)
        return inboundVerifierStorageAccountFromValidKey(key)
    }

    private fun inboundVerifierStorageAccountFromValidKey(key: String): String =
        INBOUND_VERIFIER_STORAGE_PREFIX + sha256Hex(key.toByteArray(Charsets.UTF_8))

    private fun validateInboundVerifierSecretValueForSelector(value: String, selector: InboundVerifierSelector) {
        val record = parseInboundVerifierSecretValue(value)
        if (!inboundVerifierSelectorMatchesRecord(selector, record)) {
            throw IllegalArgumentException("inbound verifier value does not match key selector")
        }
        validateCanonicalInboundVerifierSecretValue(value, record)
    }

    private fun validateCanonicalInboundVerifierSecretValue(value: String, record: InboundVerifierSecretRecord) {
        if (canonicalInboundVerifierSecretValue(record) != value) {
            throw IllegalArgumentException("inbound verifier value must be canonical SDK JSON")
        }
    }

    private fun parseInboundVerifierSecretValue(value: String): InboundVerifierSecretRecord {
        if (value.isEmpty() || value.toByteArray(Charsets.UTF_8).size > 8192) {
            throw IllegalArgumentException("inbound verifier value length must be 1..8192 bytes")
        }
        val rawRecord = try {
            JSONObject(value)
        } catch (_: Exception) {
            throw IllegalArgumentException("inbound verifier value must be canonical JSON")
        }
        val allowed = setOf(
            "version",
            "tokenId",
            "claimantPeerId",
            "verifierPeerId",
            "roomName",
            "tokenHashHex",
            "createdAtMs",
            "expiresAtMs",
            "revokedAtMs",
            "credentialRevision",
        )
        val keys = rawRecord.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in allowed || isForbiddenInboundVerifierField(key)) {
                throw IllegalArgumentException("inbound verifier value contains unsupported secret material")
            }
        }
        val record = InboundVerifierSecretRecord(
            version = strictJsonLong(rawRecord, "version").toInt(),
            tokenId = strictJsonString(rawRecord, "tokenId"),
            claimantPeerId = strictJsonString(rawRecord, "claimantPeerId"),
            verifierPeerId = strictJsonString(rawRecord, "verifierPeerId"),
            roomName = strictJsonString(rawRecord, "roomName"),
            tokenHashHex = strictJsonString(rawRecord, "tokenHashHex"),
            createdAtMs = strictJsonLong(rawRecord, "createdAtMs"),
            expiresAtMs = optionalStrictJsonLong(rawRecord, "expiresAtMs"),
            revokedAtMs = optionalStrictJsonLong(rawRecord, "revokedAtMs"),
            credentialRevision = strictJsonLong(rawRecord, "credentialRevision"),
        )
        if (record.version != 1) throw IllegalArgumentException("inbound verifier version is unsupported")
        validateSafePeerAuthorityId("tokenId", record.tokenId, 256)
        validateSafePeerAuthorityId("claimantPeerId", record.claimantPeerId, 256)
        validateSafePeerAuthorityId("verifierPeerId", record.verifierPeerId, 256)
        validateNonEmptyBytes("roomName", record.roomName, 512)
        validateLowerHex64("tokenHashHex", record.tokenHashHex)
        validateSafeEpoch("createdAtMs", record.createdAtMs)
        record.expiresAtMs?.let { validateSafeEpoch("expiresAtMs", it) }
        record.revokedAtMs?.let { validateSafeEpoch("revokedAtMs", it) }
        validateSafeEpoch("credentialRevision", record.credentialRevision)
        return record
    }

    private fun inboundVerifierSelectorMatchesRecord(selector: InboundVerifierSelector, record: InboundVerifierSecretRecord): Boolean =
        selector.tokenId == record.tokenId &&
            selector.claimantPeerId == record.claimantPeerId &&
            selector.verifierPeerId == record.verifierPeerId &&
            selector.roomName == record.roomName

    private fun canonicalInboundVerifierSecretValue(record: InboundVerifierSecretRecord): String {
        val fields = mutableListOf(
            "\"version\":${record.version}",
            "\"tokenId\":${canonicalJsonQuote(record.tokenId)}",
            "\"claimantPeerId\":${canonicalJsonQuote(record.claimantPeerId)}",
            "\"verifierPeerId\":${canonicalJsonQuote(record.verifierPeerId)}",
            "\"roomName\":${canonicalJsonQuote(record.roomName)}",
            "\"tokenHashHex\":${canonicalJsonQuote(record.tokenHashHex)}",
            "\"createdAtMs\":${record.createdAtMs}",
        )
        record.expiresAtMs?.let { fields.add("\"expiresAtMs\":$it") }
        record.revokedAtMs?.let { fields.add("\"revokedAtMs\":$it") }
        fields.add("\"credentialRevision\":${record.credentialRevision}")
        return "{${fields.joinToString(",")}}"
    }

    private fun strictJsonString(record: JSONObject, field: String): String {
        if (!record.has(field) || record.isNull(field)) throw IllegalArgumentException("inbound verifier value has invalid fields")
        return record.get(field) as? String
            ?: throw IllegalArgumentException("inbound verifier value has invalid fields")
    }

    private fun strictJsonLong(record: JSONObject, field: String): Long {
        if (!record.has(field) || record.isNull(field)) throw IllegalArgumentException("inbound verifier value has invalid fields")
        val value = record.get(field)
        if (value !is Number || value is Double || value is Float || !value.toString().matches(Regex("^[0-9]+$"))) {
            throw IllegalArgumentException("inbound verifier value has invalid fields")
        }
        return value.toLong()
    }

    private fun optionalStrictJsonLong(record: JSONObject, field: String): Long? {
        if (!record.has(field)) return null
        if (record.isNull(field)) throw IllegalArgumentException("inbound verifier value has invalid fields")
        return strictJsonLong(record, field)
    }

    private fun isForbiddenInboundVerifierField(field: String): Boolean {
        val normalized = field
            .filter { it.isLetterOrDigit() }
            .lowercase()
        return normalized in setOf(
            "bearer",
            "rawbearertoken",
            "rawtoken",
            "proof",
            "proofhex",
            "verifierkey",
            "password",
            "secret",
            "authorization",
        )
    }

    private fun validateSafePeerAuthorityId(field: String, value: String, maxLen: Int) {
        validateNonEmptyBytes(field, value, maxLen)
        if (!value.all { it.isLetterOrDigit() || it == '_' || it == '.' || it == ':' || it == '@' || it == '/' || it == '-' }) {
            throw IllegalArgumentException("$field contains unsupported characters")
        }
        if (!value.all { it.code <= 0x7f }) throw IllegalArgumentException("$field contains unsupported characters")
    }

    private fun validateNonEmptyBytes(field: String, value: String, maxLen: Int) {
        val byteLength = value.toByteArray(Charsets.UTF_8).size
        if (byteLength == 0 || byteLength > maxLen) throw IllegalArgumentException("$field length must be 1..$maxLen bytes")
    }

    private fun validateLowerHex64(field: String, value: String) {
        if (value.length != 64 || !value.all { it in '0'..'9' || it in 'a'..'f' }) {
            throw IllegalArgumentException("$field must be 64 lowercase hex characters")
        }
    }

    private fun validateSafeEpoch(field: String, value: Long) {
        if (value < 0L || value > 9_007_199_254_740_991L) throw IllegalArgumentException("$field is outside the safe integer range")
    }

    private fun decodeSdkKeyPart(value: String, field: String): String {
        val output = ByteArray(value.length)
        var outputLength = 0
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char == '%') {
                if (index + 2 >= value.length) throw IllegalArgumentException("$field has invalid percent encoding")
                val high = hexValue(value[index + 1]) ?: throw IllegalArgumentException("$field has invalid percent encoding")
                val low = hexValue(value[index + 2]) ?: throw IllegalArgumentException("$field has invalid percent encoding")
                output[outputLength] = ((high shl 4) or low).toByte()
                outputLength += 1
                index += 3
            } else {
                if (char.code > 0x7f) throw IllegalArgumentException("$field is not valid UTF-8")
                output[outputLength] = char.code.toByte()
                outputLength += 1
                index += 1
            }
        }
        return String(output, 0, outputLength, Charsets.UTF_8)
    }

    private fun encodeSdkKeyPart(value: String): String = buildString(value.length) {
        value.toByteArray(Charsets.UTF_8).forEach { rawByte ->
            val byte = rawByte.toInt() and 0xff
            if (isSdkKeyUnescapedByte(byte)) {
                append(byte.toChar())
            } else {
                append('%')
                append(byte.toString(16).uppercase().padStart(2, '0'))
            }
        }
    }

    private fun isSdkKeyUnescapedByte(byte: Int): Boolean =
        (byte in 'A'.code..'Z'.code) ||
            (byte in 'a'.code..'z'.code) ||
            (byte in '0'.code..'9'.code) ||
            byte == '-'.code ||
            byte == '_'.code ||
            byte == '!'.code ||
            byte == '~'.code ||
            byte == '*'.code ||
            byte == '\''.code ||
            byte == '('.code ||
            byte == ')'.code

    private fun hexValue(char: Char): Int? =
        when (char) {
            in '0'..'9' -> char.code - '0'.code
            in 'a'..'f' -> char.code - 'a'.code + 10
            in 'A'..'F' -> char.code - 'A'.code + 10
            else -> null
        }

    private fun validateThinPeerSetArgs(args: ThinPeerCredentialSetArgs) {
        validateNonEmpty("peerId", args.peerId, 256)
        validateNonEmpty("tokenId", args.tokenId, 128)
        validateNonEmpty("claimantPeerId", args.claimantPeerId, 256)
        validateNonEmpty("verifierPeerId", args.verifierPeerId, 256)
        validateNonEmpty("claimantSignalingPeerId", args.claimantSignalingPeerId, 256)
        validateNonEmpty("verifierSignalingPeerId", args.verifierSignalingPeerId, 256)
        validateNonEmpty("roomName", args.roomName, 512)
        validateNonEmpty("rawBearerToken", args.rawBearerToken, 4096)
    }

    private fun validateThinPeerCredentialRecord(record: JSONObject) {
        validateNonEmpty("tokenId", record.optString("tokenId"), 128)
        validateNonEmpty("claimantPeerId", record.optString("claimantPeerId"), 256)
        validateNonEmpty("verifierPeerId", record.optString("verifierPeerId"), 256)
        validateNonEmpty("claimantSignalingPeerId", record.optString("claimantSignalingPeerId"), 256)
        validateNonEmpty("verifierSignalingPeerId", record.optString("verifierSignalingPeerId"), 256)
        validateNonEmpty("roomName", record.optString("roomName"), 512)
        validateNonEmpty("rawBearerToken", record.optString("rawBearerToken"), 4096)
        validateOptionalJsonLong(record, "createdAtMs")
        validateOptionalJsonLong(record, "expiresAtMs", requirePositive = true)
    }

    private fun validateOptionalJsonLong(record: JSONObject, field: String, requirePositive: Boolean = false) {
        if (!record.has(field)) return
        val value = record.get(field)
        if (value !is Number || value is Double || value is Float || !value.toString().matches(Regex("^[0-9]+$"))) {
            throw IllegalArgumentException("$field must be an unsigned integer")
        }
        if (requirePositive && value.toLong() <= 0L) {
            throw IllegalArgumentException("$field must be a positive integer")
        }
    }

    private fun validateReconnectChallenge(challenge: MeshReconnectChallengeFrameArgs) {
        if (challenge.type != "mesh_auth_challenge_v1") throw IllegalArgumentException("reconnect challenge type must be mesh_auth_challenge_v1")
        validateHex64("challenge", challenge.challenge)
        validateHex64("channelBinding", challenge.channelBindingValue())
        validateNonEmpty("claimantPeerId", challenge.claimantPeerIdValue(), 256)
        validateNonEmpty("verifierPeerId", challenge.verifierPeerIdValue(), 256)
        validateNonEmpty("claimantSignalingPeerId", challenge.claimantSignalingPeerIdValue(), 256)
        validateNonEmpty("verifierSignalingPeerId", challenge.verifierSignalingPeerIdValue(), 256)
        validateNonEmpty("roomName", challenge.roomNameValue(), 512)
    }

    private fun validateHex64(field: String, value: String) {
        if (value.length != 64 || !value.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            throw IllegalArgumentException("$field must be 64 hex characters")
        }
    }

    private fun validateNonEmpty(field: String, value: String, maxLen: Int) {
        if (value.isEmpty() || value.length > maxLen) throw IllegalArgumentException("$field length must be 1..$maxLen bytes")
    }

    private fun reconnectChallengeMatches(record: JSONObject, challenge: MeshReconnectChallengeFrameArgs): Boolean =
        challenge.claimantPeerIdValue() == record.getString("claimantPeerId") &&
            challenge.verifierPeerIdValue() == record.getString("verifierPeerId") &&
            challenge.roomNameValue() == record.getString("roomName")

    private fun computeReconnectProofHex(rawBearerToken: String, record: JSONObject, challenge: MeshReconnectChallengeFrameArgs): String {
        val key = sha256(rawBearerToken.toByteArray(Charsets.UTF_8))
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return hex(mac.doFinal(buildReconnectProofMessage(record, challenge)))
    }

    private fun buildReconnectProofMessage(record: JSONObject, challenge: MeshReconnectChallengeFrameArgs): ByteArray {
        val transcript = "{" +
            "\"challenge\":${canonicalJsonQuote(challenge.challenge)}," +
            "\"channel_binding\":${canonicalJsonQuote(challenge.channelBindingValue())}," +
            "\"claimant_peer_id\":${canonicalJsonQuote(challenge.claimantPeerIdValue())}," +
            "\"room_name\":${canonicalJsonQuote(challenge.roomNameValue())}," +
            "\"token_id\":${canonicalJsonQuote(record.getString("tokenId"))}," +
            "\"verifier_peer_id\":${canonicalJsonQuote(challenge.verifierPeerIdValue())}," +
            "\"version\":1}"
        return "aurora.mesh.reconnect-proof.v1\u0000".toByteArray(Charsets.UTF_8) + transcript.toByteArray(Charsets.UTF_8)
    }

    private fun canonicalJsonQuote(value: String): String = buildString(value.length + 2) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\t' -> append("\\t")
                '\n' -> append("\\n")
                '\u000c' -> append("\\f")
                '\r' -> append("\\r")
                in '\u0000'..'\u001f', in '\u007f'..'\uffff' -> {
                    append("\\u")
                    append(character.code.toString(16).padStart(4, '0'))
                }
                else -> append(character)
            }
        }
        append('"')
    }

    private fun evaluateWebviewMicrophonePermission(args: WebviewMicrophonePermissionArgs): JSObject {
        val resources = args.resources.filter { it.isNotBlank() }
        val resourceAllowed = resources.isNotEmpty() && resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
        val originAllowed = isTrustedMicOrigin(args.origin, args.configuredHttpsOrigins.ifEmpty { configuredMicOrigins })
        val runtimeGranted = hasRuntimePermission(Manifest.permission.RECORD_AUDIO)
        val active = args.foreground && args.focused && foreground && focused
        val nativeServiceOwnsMic = AuroraRuntimeForegroundService.running || AuroraRuntimeForegroundService.captureSnapshot.captureActive
        val granted = resourceAllowed && originAllowed && runtimeGranted && active && !nativeServiceOwnsMic
        val ret = JSObject()
        ret.put("grant", granted)
        val grantResources = JSArray()
        if (granted) grantResources.put(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
        ret.put("resources", grantResources)
        ret.put("reason", when {
            !resourceAllowed -> "audio_capture_resource_only"
            !originAllowed -> "untrusted_origin"
            !runtimeGranted -> "record_audio_permission_missing"
            !active -> "webview_not_foreground_focused"
            nativeServiceOwnsMic -> "native_voice_session_active"
            else -> "trusted_foreground_audio_capture"
        })
        ret.put("origin", args.origin)
        ret.put("foreground", foreground)
        ret.put("focused", focused)
        ret.put("nativeVoiceActive", nativeServiceOwnsMic)
        ret.put("secretsRedacted", true)
        return ret
    }

    internal fun isTrustedMicOrigin(origin: String, configuredHttpsOrigins: Array<String>): Boolean {
        if (isTauriAppOrigin(origin)) return true
        val normalized = normalizeOrigin(origin) ?: return false
        return configuredHttpsOrigins.any { configured ->
            configured.isNotBlank() && normalizeOrigin(configured) == normalized
        }
    }

    private fun isTauriAppOrigin(origin: String): Boolean {
        val uri = try { Uri.parse(origin) } catch (_: Exception) { return false }
        val scheme = uri.scheme ?: return false
        if (scheme != "http" && scheme != "https") return false
        if (uri.host != "tauri.localhost") return false
        if (uri.port >= 0) return false
        if (!uri.userInfo.isNullOrBlank()) return false
        if (!uri.encodedPath.isNullOrBlank() && uri.encodedPath != "/") return false
        if (!uri.encodedQuery.isNullOrBlank()) return false
        if (!uri.encodedFragment.isNullOrBlank()) return false
        return true
    }

    private fun normalizeOrigin(origin: String): String? {
        if (origin.contains("*")) return null
        val uri = try { Uri.parse(origin) } catch (_: Exception) { return null }
        val scheme = uri.scheme ?: return null
        val host = uri.host ?: return null
        if (scheme != "https") return null
        if (!uri.userInfo.isNullOrBlank()) return null
        if (!uri.encodedPath.isNullOrBlank() && uri.encodedPath != "/") return null
        if (!uri.encodedQuery.isNullOrBlank()) return null
        if (!uri.encodedFragment.isNullOrBlank()) return null
        val port = if (uri.port >= 0) ":${uri.port}" else ""
        return "$scheme://$host$port"
    }


    internal fun handleWebViewPermissionRequest(request: PermissionRequest) {
        synchronized(pendingMicRequests) { pendingMicRequests.add(request) }
        activity.runOnUiThread {
            resolveWebViewPermissionRequest(request, allowRuntimePrompt = true)
        }
    }

    internal fun handleWebViewPermissionRequestCanceled(request: PermissionRequest) {
        synchronized(pendingMicRequests) { pendingMicRequests.remove(request) }
    }

    private fun resolvePendingMicRequests(allowRuntimePrompt: Boolean) {
        val pending = synchronized(pendingMicRequests) {
            pendingMicRequests.toList()
        }
        pending.forEach { request ->
            resolveWebViewPermissionRequest(request, allowRuntimePrompt)
        }
    }

    private fun resolveWebViewPermissionRequest(
        request: PermissionRequest,
        allowRuntimePrompt: Boolean,
    ) {
        if (!synchronized(pendingMicRequests) { pendingMicRequests.contains(request) }) return
        try {
            val args = WebviewMicrophonePermissionArgs().apply {
                origin = request.origin?.toString().orEmpty()
                resources = request.resources ?: emptyArray()
                configuredHttpsOrigins = configuredMicOrigins
                foreground = this@AuroraNativePlugin.foreground
                focused = this@AuroraNativePlugin.focused
            }
            val decision = evaluateWebviewMicrophonePermission(args)
            if (decision.getBoolean("grant")) {
                synchronized(pendingMicRequests) { pendingMicRequests.remove(request) }
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                return
            }
            if (
                allowRuntimePrompt &&
                decision.getString("reason") == "record_audio_permission_missing"
            ) {
                requestMicrophonePermission()
                return
            }
            synchronized(pendingMicRequests) { pendingMicRequests.remove(request) }
            request.deny()
        } catch (error: Exception) {
            synchronized(pendingMicRequests) { pendingMicRequests.remove(request) }
            try {
                request.deny()
            } catch (denyError: Exception) {
                recordMicDenyFailure("mic_exception_deny_failed", denyError)
            }
            recordMicDenyFailure("mic_permission_exception_denied", error)
        }
    }

    private fun requestMicrophonePermission() {
        if (microphonePermissionRequestInFlight) return
        microphonePermissionRequestInFlight = true
        try {
            PluginManager.requestPermissions(
                arrayOf(Manifest.permission.RECORD_AUDIO),
            ) {
                activity.runOnUiThread {
                    microphonePermissionRequestInFlight = false
                    if (foreground && focused) {
                        resolvePendingMicRequests(allowRuntimePrompt = false)
                        scheduleBackgroundVoiceAutoStart()
                    }
                }
            }
        } catch (error: Exception) {
            microphonePermissionRequestInFlight = false
            recordMicDenyFailure("mic_runtime_permission_request_failed", error)
            denyPendingMicRequests()
        }
    }

    private fun currentUnixMs(): Long = System.currentTimeMillis()
    private fun sha256(input: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(input)
    private fun sha256Hex(input: ByteArray): String = hex(sha256(input))
    private fun hex(input: ByteArray): String = input.joinToString("") { "%02x".format(it.toInt() and 0xff) }

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



@InvokeArg
class AuroraNativePluginConfig {
    var microphoneOrigins: Array<String> = emptyArray()
}

class AuroraMicWebChromeClient(
    private val plugin: AuroraNativePlugin,
    private val delegate: WebChromeClient?,
) : WebChromeClient() {
    override fun getDefaultVideoPoster(): Bitmap? =
        if (delegate != null) delegate.getDefaultVideoPoster() else super.getDefaultVideoPoster()

    override fun getVideoLoadingProgressView(): View? =
        if (delegate != null) delegate.getVideoLoadingProgressView() else super.getVideoLoadingProgressView()

    override fun getVisitedHistory(callback: ValueCallback<Array<String>>?) {
        if (delegate != null) {
            delegate.getVisitedHistory(callback)
        } else {
            super.getVisitedHistory(callback)
        }
    }

    override fun onCloseWindow(window: WebView?) {
        if (delegate != null) {
            delegate.onCloseWindow(window)
        } else {
            super.onCloseWindow(window)
        }
    }

    override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean =
        delegate?.onConsoleMessage(consoleMessage) ?: super.onConsoleMessage(consoleMessage)

    @Deprecated("Deprecated in Java")
    override fun onConsoleMessage(message: String?, lineNumber: Int, sourceID: String?) {
        if (delegate != null) {
            delegate.onConsoleMessage(message, lineNumber, sourceID)
        } else {
            super.onConsoleMessage(message, lineNumber, sourceID)
        }
    }

    override fun onCreateWindow(
        view: WebView?,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message?,
    ): Boolean = delegate?.onCreateWindow(view, isDialog, isUserGesture, resultMsg)
        ?: super.onCreateWindow(view, isDialog, isUserGesture, resultMsg)

    @Deprecated("Deprecated in Java")
    override fun onExceededDatabaseQuota(
        url: String?,
        databaseIdentifier: String?,
        quota: Long,
        estimatedDatabaseSize: Long,
        totalQuota: Long,
        quotaUpdater: WebStorage.QuotaUpdater?,
    ) {
        if (delegate != null) {
            delegate.onExceededDatabaseQuota(url, databaseIdentifier, quota, estimatedDatabaseSize, totalQuota, quotaUpdater)
        } else {
            super.onExceededDatabaseQuota(url, databaseIdentifier, quota, estimatedDatabaseSize, totalQuota, quotaUpdater)
        }
    }

    override fun onGeolocationPermissionsHidePrompt() {
        if (delegate != null) {
            delegate.onGeolocationPermissionsHidePrompt()
        } else {
            super.onGeolocationPermissionsHidePrompt()
        }
    }

    override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
        if (delegate != null) {
            delegate.onGeolocationPermissionsShowPrompt(origin, callback)
        } else {
            super.onGeolocationPermissionsShowPrompt(origin, callback)
        }
    }

    override fun onHideCustomView() {
        if (delegate != null) {
            delegate.onHideCustomView()
        } else {
            super.onHideCustomView()
        }
    }

    override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean =
        delegate?.onJsAlert(view, url, message, result) ?: super.onJsAlert(view, url, message, result)

    override fun onJsBeforeUnload(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean =
        delegate?.onJsBeforeUnload(view, url, message, result) ?: super.onJsBeforeUnload(view, url, message, result)

    override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean =
        delegate?.onJsConfirm(view, url, message, result) ?: super.onJsConfirm(view, url, message, result)

    override fun onJsPrompt(
        view: WebView?,
        url: String?,
        message: String?,
        defaultValue: String?,
        result: JsPromptResult?,
    ): Boolean = delegate?.onJsPrompt(view, url, message, defaultValue, result)
        ?: super.onJsPrompt(view, url, message, defaultValue, result)

    @Deprecated("Deprecated in Java")
    override fun onJsTimeout(): Boolean = delegate?.onJsTimeout() ?: super.onJsTimeout()

    override fun onPermissionRequest(request: PermissionRequest) {
        val resources = request.resources ?: emptyArray()
        if (resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }) {
            plugin.handleWebViewPermissionRequest(request)
        } else if (delegate != null) {
            delegate.onPermissionRequest(request)
        } else {
            super.onPermissionRequest(request)
        }
    }

    override fun onPermissionRequestCanceled(request: PermissionRequest?) {
        if (request != null) plugin.handleWebViewPermissionRequestCanceled(request)
        if (delegate != null) {
            delegate.onPermissionRequestCanceled(request)
        } else {
            super.onPermissionRequestCanceled(request)
        }
    }

    override fun onProgressChanged(view: WebView?, newProgress: Int) {
        if (delegate != null) {
            delegate.onProgressChanged(view, newProgress)
        } else {
            super.onProgressChanged(view, newProgress)
        }
    }

    override fun onReceivedIcon(view: WebView?, icon: Bitmap?) {
        if (delegate != null) {
            delegate.onReceivedIcon(view, icon)
        } else {
            super.onReceivedIcon(view, icon)
        }
    }

    override fun onReceivedTitle(view: WebView?, title: String?) {
        if (delegate != null) {
            delegate.onReceivedTitle(view, title)
        } else {
            super.onReceivedTitle(view, title)
        }
    }

    override fun onReceivedTouchIconUrl(view: WebView?, url: String?, precomposed: Boolean) {
        if (delegate != null) {
            delegate.onReceivedTouchIconUrl(view, url, precomposed)
        } else {
            super.onReceivedTouchIconUrl(view, url, precomposed)
        }
    }

    override fun onRequestFocus(view: WebView?) {
        if (delegate != null) {
            delegate.onRequestFocus(view)
        } else {
            super.onRequestFocus(view)
        }
    }

    override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
        if (delegate != null) {
            delegate.onShowCustomView(view, callback)
        } else {
            super.onShowCustomView(view, callback)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onShowCustomView(view: View?, requestedOrientation: Int, callback: CustomViewCallback?) {
        if (delegate != null) {
            delegate.onShowCustomView(view, requestedOrientation, callback)
        } else {
            super.onShowCustomView(view, requestedOrientation, callback)
        }
    }

    override fun onShowFileChooser(
        webView: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: FileChooserParams?,
    ): Boolean = delegate?.onShowFileChooser(webView, filePathCallback, fileChooserParams)
        ?: super.onShowFileChooser(webView, filePathCallback, fileChooserParams)
}

@InvokeArg
class AssistantRoleResultArgs {
    var resultCode: Int = Activity.RESULT_CANCELED
}

@InvokeArg
class MeshDeviceLinkUpdateArgs {
    var peers: Array<MeshNotificationPeerArgs> = emptyArray()
}

@InvokeArg
class MeshNotificationPeerArgs {
    var peerId: String = ""
    var displayName: String = ""
    var roundTripTimeMs: Double? = null
}

@InvokeArg
class AndroidPermissionRequestArgs {
    var permission: String = ""
}

@InvokeArg
class AndroidVoiceForegroundServiceStartArgs {
    var remoteAudioConsent: Boolean = false
    var backgroundSession: Boolean = false
}

@InvokeArg
class AndroidVoiceForegroundServiceStatusArgs {
    var takeFocusedResult: Boolean = false
    var takeBackgroundResult: Boolean = false
}

@InvokeArg
class AndroidVoiceForegroundServiceStopArgs {
    var backgroundSession: Boolean = false
}

@InvokeArg
class AndroidVoiceLiveTestPcmArgs {
    var pcmBase64: String = ""
    var armIngress: Boolean = false
}

@InvokeArg
class AndroidVoicePackCatalogArgs {
    var catalogJson: String = "[]"
}

interface AndroidVoicePackReferenceArgs {
    var referenceId: String?
    var referenceAudioUri: String?
    var referenceText: String?
    var referenceRevision: String?
    var referenceSampleRateHz: Int?
    var referenceSamples: Array<Double>?
}

@InvokeArg
class AndroidVoicePackDownloadArgs : AndroidVoicePackReferenceArgs {
    var packId: String = ""
    var task: String = ""
    var activate: Boolean = false
    var forceDownload: Boolean = false
    override var referenceId: String? = null
    override var referenceAudioUri: String? = null
    override var referenceText: String? = null
    override var referenceRevision: String? = null
    override var referenceSampleRateHz: Int? = null
    override var referenceSamples: Array<Double>? = null
}

@InvokeArg
class AndroidVoicePackOperationStatusArgs {
    var jobId: String = ""
}

@InvokeArg
class AndroidVoicePackActivateArgs : AndroidVoicePackReferenceArgs {
    var packId: String = ""
    var task: String = ""
    override var referenceId: String? = null
    override var referenceAudioUri: String? = null
    override var referenceText: String? = null
    override var referenceRevision: String? = null
    override var referenceSampleRateHz: Int? = null
    override var referenceSamples: Array<Double>? = null
}

@InvokeArg
class AndroidVoicePackRemoveArgs {
    var packId: String = ""
    var task: String = ""
}

private data class VoiceRouteCandidate(
    val mode: String,
    val gateway: String?,
    val peerId: String?,
)

@InvokeArg
class AndroidShareTextArgs {
    var text: String = ""
    var title: String = ""
}

@InvokeArg
class AndroidOpenDeepLinkArgs {
    var url: String = ""
}

@InvokeArg
class AndroidShowNotificationArgs {
    var title: String = ""
    var body: String = ""
}

@InvokeArg
class SecureStorageArgs {
    var key: String = ""
    var value: String = ""
}

@InvokeArg
class LocalDataEnvelopeEncryptArgs {
    var keyPurpose: String = ""
    var profileId: String = ""
    var localNodeId: String = ""
    var plaintextB64Url: String = ""
    var aadB64Url: String = ""
}

@InvokeArg
class LocalDataEnvelopeDecryptArgs {
    var profileId: String = ""
    var localNodeId: String = ""
    var envelope: LocalDataEnvelopeArg = LocalDataEnvelopeArg()
    var aadB64Url: String = ""
}

@InvokeArg
class LocalDataEnvelopeRotateArgs {
    var keyPurpose: String = ""
    var profileId: String = ""
    var localNodeId: String = ""
}

@InvokeArg
class LocalDataEnvelopeArg {
    var version: Int = 0
    var algorithm: String = ""
    var keyId: String = ""
    var nonceB64Url: String = ""
    var ciphertextAndTagB64Url: String = ""
    var createdAtMs: Long = 0
}

@InvokeArg
class ThinPeerCredentialSetArgs {
    var peerId: String = ""
    var tokenId: String = ""
    var claimantPeerId: String = ""
    var verifierPeerId: String = ""
    var claimantSignalingPeerId: String = ""
    var verifierSignalingPeerId: String = ""
    var roomName: String = ""
    var rawBearerToken: String = ""
    var createdAtMs: Long = 0
    var expiresAtMs: Long = 0
}

@InvokeArg
class ThinPeerCredentialLookupArgs {
    var peerId: String = ""
}

@InvokeArg
class ThinPeerReconnectProveArgs {
    var peerId: String = ""
    var challenge: MeshReconnectChallengeFrameArgs = MeshReconnectChallengeFrameArgs()
}

@InvokeArg
open class InboundVerifierSecretRequestArg {
    var key: String = ""
    var value: String = ""
}

@InvokeArg
class InboundVerifierSecretArgs : InboundVerifierSecretRequestArg() {
    var request: InboundVerifierSecretRequestArg = InboundVerifierSecretRequestArg()
}

data class InboundVerifierSelector(
    val tokenId: String,
    val claimantPeerId: String,
    val verifierPeerId: String,
    val roomName: String,
)

data class InboundVerifierSecretRecord(
    val version: Int,
    val tokenId: String,
    val claimantPeerId: String,
    val verifierPeerId: String,
    val roomName: String,
    val tokenHashHex: String,
    val createdAtMs: Long,
    val expiresAtMs: Long?,
    val revokedAtMs: Long?,
    val credentialRevision: Long,
)

@InvokeArg
class MeshReconnectChallengeFrameArgs {
    var type: String = ""
    var challenge: String = ""
    var channelBinding: String = ""
    var channel_binding: String = ""
    var claimantPeerId: String = ""
    var claimant_peer_id: String = ""
    var verifierPeerId: String = ""
    var verifier_peer_id: String = ""
    var claimantSignalingPeerId: String = ""
    var claimant_signaling_peer_id: String = ""
    var verifierSignalingPeerId: String = ""
    var verifier_signaling_peer_id: String = ""
    var roomName: String = ""
    var room_name: String = ""

    fun channelBindingValue(): String = channel_binding.ifEmpty { channelBinding }
    fun claimantPeerIdValue(): String = claimant_peer_id.ifEmpty { claimantPeerId }
    fun verifierPeerIdValue(): String = verifier_peer_id.ifEmpty { verifierPeerId }
    fun claimantSignalingPeerIdValue(): String = claimant_signaling_peer_id.ifEmpty { claimantSignalingPeerId }
    fun verifierSignalingPeerIdValue(): String = verifier_signaling_peer_id.ifEmpty { verifierSignalingPeerId }
    fun roomNameValue(): String = room_name.ifEmpty { roomName }
}

@InvokeArg
class ThinProfileSetArgs {
    var value: String = ""
}

@InvokeArg
class ThinRoomSecretSetArgs {
    var ref: String = ""
    var value: String = ""
}

@InvokeArg
class ThinRoomSecretGetArgs {
    var ref: String = ""
}

@InvokeArg
class ThinRoomSecretDeleteArgs {
    var ref: String = ""
}

@InvokeArg
class WebviewMicrophonePermissionArgs {
    var origin: String = ""
    var resources: Array<String> = emptyArray()
    var configuredHttpsOrigins: Array<String> = emptyArray()
    var foreground: Boolean = false
    var focused: Boolean = false
}

@InvokeArg
class AdminUnlockResultArgs {
    var resultCode: Int = Activity.RESULT_CANCELED
}
