import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const kotlinPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'
const voiceStorePath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraVoiceForegroundService.kt'
const permissionPath = 'apps/aurora-tauri/src-tauri/permissions/aurora-android-native-plugin.toml'
const capabilityPath = 'apps/aurora-tauri/src-tauri/capabilities/aurora-android-thin.json'

function repoText(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('Android native voice route policy', () => {
  it('derives the encrypted voice route from profile and native peer credentials', () => {
    const kotlin = repoText(kotlinPath)
    const voiceStore = repoText(voiceStorePath)

    for (const invariant of [
      'syncNativeVoiceRoute()',
      'voiceRouteCandidate',
      'loadUnexpiredThinPeerCredential',
      'AuroraVoiceNativeConfigStore.setRoute(activity, candidate.gateway, bearer)',
      'AuroraVoiceNativeConfigStore.clearRoute(activity)',
      'voice_route_credential_missing',
      'voice_route_profile_missing',
      'voice_route_invalid',
    ]) {
      expect(kotlin).toContain(invariant)
    }
    expect(voiceStore).toContain('fun setRoute(context: Context, gateway: String, bearer: String)')
    expect(voiceStore).toContain('fun clearRoute(context: Context)')
    expect(voiceStore).toContain('VOICE_GATEWAY_KEY')
    expect(voiceStore).toContain('VOICE_BEARER_KEY')
    expect(voiceStore).toContain('VOICE_REMOTE_AUDIO_CONSENT_KEY')
    const setRouteBody = voiceStore.slice(
      voiceStore.indexOf('fun setRoute(context: Context, gateway: String, bearer: String)'),
      voiceStore.indexOf('fun clearRoute(context: Context)', voiceStore.indexOf('fun setRoute(context: Context, gateway: String, bearer: String)')),
    )
    expect(setRouteBody).toContain('.remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)')
    const clearRouteBody = voiceStore.slice(
      voiceStore.indexOf('fun clearRoute(context: Context)'),
      voiceStore.indexOf('fun load(context: Context)', voiceStore.indexOf('fun clearRoute(context: Context)')),
    )
    expect(clearRouteBody).toContain('.remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)')
    expect(voiceStore).toContain('?: false')
  })

  it('keeps Android voice cleartext limited to loopback routes', () => {
    const voiceStore = repoText(voiceStorePath)
    const manifest = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml',
    )
    const networkSecurity = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/res/xml/aurora_network_security_config.xml',
    )

    expect(voiceStore).toContain('scheme == "https" || (scheme == "http" && loopback)')
    expect(manifest).toContain('android:usesCleartextTraffic="false"')
    expect(manifest).toContain('android:networkSecurityConfig="@xml/aurora_network_security_config"')
    expect(networkSecurity).toContain('<base-config cleartextTrafficPermitted="false" />')
    expect(networkSecurity).toContain('<domain includeSubdomains="false">localhost</domain>')
    expect(networkSecurity).toContain('<domain includeSubdomains="false">127.0.0.1</domain>')
    expect(networkSecurity).not.toContain('includeSubdomains="true"')
    expect(voiceStore).not.toContain('host == "::1"')
  })

  it('keeps assistant and background voice entry points disabled before native session creation', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const assistantService = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraVoiceInteractionSessionService.kt',
    )

    expect(plugin).toContain('if (args.backgroundSession) {')
    expect(plugin).toContain('reason", "background_voice_unavailable"')
    expect(foregroundService).toContain('private const val BACKGROUND_VOICE_AVAILABLE = false')
    expect(foregroundService).toContain('ACTION_START_ASSISTANT')
    expect(foregroundService).toContain('backgroundSession && !BACKGROUND_VOICE_AVAILABLE')
    expect(foregroundService).toContain('nativeSession.startBackground()')
    expect(assistantService).toContain('action = AuroraVoiceForegroundService.ACTION_START_ASSISTANT')
    expect(assistantService).not.toContain('AuroraVoiceNativeConfigStore.setRemoteAudioConsent')

    const onCreateBody = foregroundService.slice(
      foregroundService.indexOf('override fun onCreate()'),
      foregroundService.indexOf('override fun onStartCommand', foregroundService.indexOf('override fun onCreate()')),
    )
    expect(onCreateBody).not.toContain('AuroraVoiceNativeConfigStore.load')
    expect(onCreateBody).not.toContain('AuroraNativeVoiceSessionBridge')

    const onStartBody = foregroundService.slice(
      foregroundService.indexOf('override fun onStartCommand'),
      foregroundService.indexOf('private fun initializeNativeVoiceSession', foregroundService.indexOf('override fun onStartCommand')),
    )
    expect(onStartBody.indexOf('backgroundSession && !BACKGROUND_VOICE_AVAILABLE')).toBeGreaterThanOrEqual(0)
    expect(onStartBody.indexOf('initializeNativeVoiceSession()')).toBeGreaterThan(
      onStartBody.indexOf('backgroundSession && !BACKGROUND_VOICE_AVAILABLE'),
    )
  })

  it('releases foreground microphone access on Android focus or foreground loss', () => {
    const plugin = repoText(kotlinPath)
    const runtime = repoText('apps/aurora-tauri/src/aurora-client.ts')

    const onPauseBody = plugin.slice(
      plugin.indexOf('override fun onPause()'),
      plugin.indexOf('override fun onStop()', plugin.indexOf('override fun onPause()')),
    )
    const onStopBody = plugin.slice(
      plugin.indexOf('override fun onStop()'),
      plugin.indexOf('override fun onDestroy', plugin.indexOf('override fun onStop()')),
    )
    const lifecycleBody = plugin.slice(
      plugin.indexOf('private fun lifecycleStatusObject'),
      plugin.indexOf('private fun emitLifecycle', plugin.indexOf('private fun lifecycleStatusObject')),
    )
    const listenerBody = runtime.slice(
      runtime.indexOf('export function installAndroidLifecyclePolicy'),
      runtime.indexOf('interface AndroidLifecyclePluginPayload', runtime.indexOf('export function installAndroidLifecyclePolicy')),
    )

    expect(onPauseBody).toContain('focused = false')
    expect(onPauseBody).toContain('denyPendingMicRequests()')
    expect(onPauseBody).toContain('emitLifecycle("pause")')
    expect(onStopBody).toContain('foreground = false')
    expect(onStopBody).toContain('focused = false')
    expect(onStopBody).toContain('denyPendingMicRequests()')
    expect(onStopBody).toContain('emitLifecycle("stop")')
    expect(lifecycleBody).toContain('ret.put("mustReleaseMicrophone", !foreground || !focused)')
    expect(lifecycleBody).toContain('ret.put("backgroundWakeword", false)')
    expect(lifecycleBody).toContain('release_mic_until_explicit_resume')
    expect(listenerBody).toContain('payload.mustReleaseMicrophone === true')
    expect(listenerBody).toContain('payload.foreground === false || payload.focused === false')
    expect(listenerBody).toContain('AURORA_RELEASE_FOCUSED_MEDIA_EVENT')
  })

  it('keeps assistant role selection behind the explicit request command', () => {
    const plugin = repoText(kotlinPath)
    const manifestBody = plugin.slice(
      plugin.indexOf('fun nativeCapabilityManifest(invoke: Invoke)'),
      plugin.indexOf('@Command\n    fun assistantRoleStatus', plugin.indexOf('fun nativeCapabilityManifest(invoke: Invoke)')),
    )
    const requestBody = plugin.slice(
      plugin.indexOf('fun requestAssistantRole(invoke: Invoke)'),
      plugin.indexOf('@Command\n    fun recordAssistantRoleResult', plugin.indexOf('fun requestAssistantRole(invoke: Invoke)')),
    )
    const startVoiceBody = plugin.slice(
      plugin.indexOf('fun startVoiceForegroundService(invoke: Invoke)'),
      plugin.indexOf('@Command\n    fun stopVoiceForegroundService', plugin.indexOf('fun startVoiceForegroundService(invoke: Invoke)')),
    )

    expect(manifestBody).toContain('assistantRoleStatusObject()')
    expect(manifestBody).toContain('permissions.put("aurora.android.assistantRoleRequest", assistantRoleRequestable)')
    expect(manifestBody).not.toContain('createRequestRoleIntent')
    expect(manifestBody).not.toContain('startActivityForResult')
    expect(requestBody).toContain('if (!status.getBoolean("requestable"))')
    expect(requestBody).toContain('roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)')
    expect(requestBody).toContain('activity.startActivityForResult')
    expect(startVoiceBody).not.toContain('createRequestRoleIntent')
    expect(startVoiceBody).not.toContain('ACTION_START_ASSISTANT')
  })

  it('keeps the thin APK on narrow profile/peer-storage permissions', () => {
    const permission = repoText(permissionPath)
    const capability = repoText(capabilityPath)

    expect(permission).toContain('aurora_inbound_verifier_set')
    expect(permission).toContain('aurora_android_voice_foreground_service_start')
    expect(capability).not.toContain('aurora-secure-storage')
    expect(capability).not.toContain('aurora-secure-storage-set')
    expect(permission).not.toContain('aurora_secure_storage_set')
  })

  it('does not make route provisioning a role selector', () => {
    const kotlin = repoText(kotlinPath)
    const syncBody = kotlin.slice(
      kotlin.indexOf('private fun syncNativeVoiceRoute()'),
      kotlin.indexOf('private fun voiceRouteCandidate', kotlin.indexOf('private fun syncNativeVoiceRoute()')),
    )

    expect(kotlin).toContain('activeProfileId')
    expect(syncBody).toContain('candidate.gateway')
    expect(kotlin).toContain('Both remote-console and mesh-node profiles')
    expect(syncBody).not.toContain('nodeMode =')
    expect(syncBody).not.toContain('runtimeTier =')
    expect(syncBody).not.toContain('VITE_AURORA_RUNTIME_MODE')
  })

  it('fails closed when encrypted peer credentials are unreadable before route provisioning', () => {
    const kotlin = repoText(kotlinPath)
    const loadBody = kotlin.slice(
      kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      kotlin.indexOf(
        'private fun thinPeerStatusResponse',
        kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      ),
    )
    const syncBody = kotlin.slice(
      kotlin.indexOf('private fun syncNativeVoiceRoute()'),
      kotlin.indexOf(
        'private fun voiceRouteCandidate',
        kotlin.indexOf('private fun syncNativeVoiceRoute()'),
      ),
    )

    expect(loadBody).toContain('val key = thinPeerCredentialKey(peerId)')
    expect(loadBody).toContain('JSONObject(decryptSecureValue(stored))')
    expect(loadBody).toContain('validateThinPeerCredentialRecord(record)')
    expect(loadBody).toContain('catch (_: Exception)')
    expect(loadBody).toMatch(/securePrefs\(\)\.edit\(\)\.remove\(key\)\.apply\(\)[\s\S]*return null/)
    expect(syncBody).toContain('?.let(::loadUnexpiredThinPeerCredential)')
    expect(syncBody).toContain('AuroraVoiceNativeConfigStore.clearRoute(activity)')
    expect(syncBody).toMatch(/if \(candidate == null\) \{[\s\S]*AuroraVoiceNativeConfigStore\.clearRoute\(activity\)[\s\S]*voice_route_profile_missing/)
    expect(syncBody).toMatch(/if \(!loopback && bearer\.isBlank\(\)\) \{[\s\S]*AuroraVoiceNativeConfigStore\.clearRoute\(activity\)[\s\S]*voice_route_credential_missing/)
    expect(syncBody).toMatch(/catch \(_:\s*Exception\) \{[\s\S]*AuroraVoiceNativeConfigStore\.clearRoute\(activity\)[\s\S]*voice_route_invalid/)
    expect(syncBody).not.toContain('rawBearerToken", record.getString')
  })

  it('rejects stored peer credentials with missing bearer fields before route provisioning', () => {
    const kotlin = repoText(kotlinPath)
    const loadBody = kotlin.slice(
      kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      kotlin.indexOf(
        'private fun thinPeerStatusResponse',
        kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      ),
    )
    const validatorBody = kotlin.slice(
      kotlin.indexOf('private fun validateThinPeerCredentialRecord(record: JSONObject)'),
      kotlin.indexOf(
        'private fun validateReconnectChallenge',
        kotlin.indexOf('private fun validateThinPeerCredentialRecord(record: JSONObject)'),
      ),
    )

    expect(loadBody).toMatch(/validateThinPeerCredentialRecord\(record\)[\s\S]*catch \(_:\s*Exception\)/)
    expect(loadBody).toMatch(/catch \(_:\s*Exception\) \{[\s\S]*securePrefs\(\)\.edit\(\)\.remove\(key\)\.apply\(\)[\s\S]*return null/)
    for (const field of [
      'tokenId',
      'claimantPeerId',
      'verifierPeerId',
      'claimantSignalingPeerId',
      'verifierSignalingPeerId',
      'roomName',
      'rawBearerToken',
    ]) {
      expect(validatorBody).toContain(`validateNonEmpty("${field}"`)
    }
    expect(validatorBody).toContain('validateOptionalJsonLong(record, "createdAtMs")')
    expect(validatorBody).toContain('validateOptionalJsonLong(record, "expiresAtMs", requirePositive = true)')
  })
})
