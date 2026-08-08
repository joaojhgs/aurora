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
    expect(syncBody).not.toContain('nodeMode =')
    expect(syncBody).not.toContain('runtimeTier =')
    expect(syncBody).not.toContain('VITE_AURORA_RUNTIME_MODE')
  })
})
