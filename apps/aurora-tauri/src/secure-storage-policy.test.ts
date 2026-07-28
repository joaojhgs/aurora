import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webStorageTerms = ['local' + 'Storage', 'session' + 'Storage']
const iosNativePluginPath =
  'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift'

describe('Tauri secure storage policy', () => {
  it('keeps credential persistence out of browser web storage', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const files = [
      'apps/aurora-tauri/src/aurora-client.ts',
      'packages/aurora-sdk/src/tauri.ts',
      iosNativePluginPath
    ]

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8')
      for (const term of webStorageTerms) {
        expect(source, `${file} must not reference ${term}`).not.toContain(term)
      }
    }
  })

  it('persists onboarding mode preference only through the platform secure-storage namespace', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const onboardingSource = readFileSync(resolve(repoRoot, 'packages/aurora-ui/src/onboarding-view.tsx'), 'utf8')

    expect(runtimeSource).toMatch(/ONBOARDING_MODE_KEY = ['\"]aurora\.session\.onboarding-mode['\"]/)
    expect(runtimeSource).toContain('secureStorageGet(ONBOARDING_MODE_KEY)')
    expect(runtimeSource).toMatch(/secureStorageSet\(\s*ONBOARDING_MODE_KEY,\s*modeId,?\s*\)/s)
    expect(runtimeSource).toContain('browser thin mode preference is memory-only; no web storage persistence')
    expect(onboardingSource).toContain('isSupportedModeId(modeId)')
    for (const term of webStorageTerms) {
      expect(`${runtimeSource}\n${onboardingSource}`, `selected mode must not use ${term}`).not.toContain(term)
    }
  })

  it('uses native peer credentials only in real desktop/Android Tauri without a raw-token read command', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const sdkSource = readFileSync(resolve(repoRoot, 'packages/aurora-sdk/src/webrtc/credentials.ts'), 'utf8')
    const rustSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/lib.rs'), 'utf8')

    expect(runtimeSource).toContain('isDesktopTauriRuntime()')
    expect(runtimeSource).toContain('isAndroidTauriRuntime()')
    expect(runtimeSource).toContain('isIosTauriRuntime()')
    expect(runtimeSource).toContain('? createTauriNativePeerCredentialStore()')
    expect(sdkSource).toContain("status: 'aurora_thin_peer_credential_status'")
    expect(sdkSource).toContain("prove: 'aurora_thin_peer_reconnect_prove'")
    expect(sdkSource).not.toContain('aurora_thin_peer_credential_get')
    expect(rustSource).not.toMatch(/fn\s+aurora_thin_peer_credential_get\s*\(/)
  })

  it('grants generic secure storage only to trusted desktop-local main capability', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const mainCapability = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/capabilities/aurora-main.json'), 'utf8')
    const thinCapability = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/capabilities/aurora-thin.json'), 'utf8')
    const secureStoragePermission = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/permissions/aurora-secure-storage.toml'), 'utf8')

    expect(mainCapability).toContain('aurora-secure-storage')
    expect(secureStoragePermission).toContain('aurora_secure_storage_get')
    expect(secureStoragePermission).toContain('aurora_secure_storage_set')
    expect(thinCapability).not.toContain('aurora-secure-storage')
    expect(thinCapability).not.toMatch(/aurora_secure_storage_(get|set|delete)/)
  })


  it('keeps desktop-thin on narrow nonsecret profile and peer permissions only', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const thinCapability = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/capabilities/aurora-thin.json'), 'utf8')
    const profilePermission = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/permissions/aurora-thin-profile.toml'), 'utf8')
    const peerPermission = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/permissions/aurora-thin-peer-credentials.toml'), 'utf8')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')

    expect(thinCapability).toContain('aurora-thin-profile')
    expect(thinCapability).toContain('aurora-thin-peer-credentials')
    expect(thinCapability).not.toContain('aurora-secure-storage')
    expect(profilePermission).toContain('aurora_thin_profile_get')
    expect(profilePermission).toContain('aurora_thin_profile_set')
    expect(profilePermission).not.toMatch(/aurora_secure_storage_(get|set|delete)/)
    expect(peerPermission).not.toContain('aurora_thin_peer_credential_get')
    for (const secretPrefix of ['aurora.auth', 'aurora.admin', 'aurora.gateway']) {
      expect(profilePermission).not.toContain(secretPrefix)
      expect(thinCapability).not.toContain(secretPrefix)
    }
    expect(runtimeSource).toContain('aurora_thin_profile_get')
    expect(runtimeSource).toContain('aurora_thin_profile_set')
  })

  it('persists WebRTC room secrets in a narrow platform vault before saving reconnect metadata', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const appSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/tauri-app.tsx'), 'utf8')
    const panelSource = readFileSync(resolve(repoRoot, 'packages/aurora-ui/src/web-thin-connection-panel.tsx'), 'utf8')
    const rustSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/lib.rs'), 'utf8')
    const permission = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/permissions/aurora-thin-peer-credentials.toml'), 'utf8')
    const kotlinSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'), 'utf8')
    const swiftStorage = readFileSync(
      resolve(
        repoRoot,
        'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraThinPeerStorage.swift',
      ),
      'utf8',
    )

    for (const command of [
      'aurora_thin_room_secret_set',
      'aurora_thin_room_secret_get',
    ]) {
      expect(runtimeSource).toContain(command)
      expect(rustSource).toContain(command)
      expect(permission).toContain(command)
    }
    expect(panelSource).toMatch(/onSaveProfile\?\.\(nextProfile,\s*\{\s*roomSecretRef:/s)
    expect(appSource).toContain('controller.saveProfile(profile, roomSecret)')
    expect(runtimeSource).toMatch(
      /await persistTauriRoomSecret\([\s\S]*?await store\.save\(next\)/,
    )
    expect(rustSource).toContain('aurora.mesh.room-secret.')
    expect(rustSource).toContain('sha256_hex(ref_id.as_bytes())')
    expect(kotlinSource).toContain('encryptSecureValue(args.value)')
    expect(kotlinSource).toMatch(/thinRoomSecretKey\(args\.ref\)[\s\S]*?\.commit\(\)/)
    expect(swiftStorage).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly')
    expect(swiftStorage).toContain('roomSecretAccount(ref: args.ref)')
    expect(swiftStorage).toContain('"rawGetter": true')
    expect(permission).toContain('raw bearer tokens')
  })

  it('wires Android thin lifecycle and foreground microphone policy through native plugin command names', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const kotlinSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'), 'utf8')

    for (const command of ['androidLifecycleStatus', 'webviewMicrophonePermissionDecision', 'voiceForegroundServiceStatus']) {
      expect(kotlinSource).toContain(`fun ${command}`)
    }
    for (const command of ['aurora_android_lifecycle_status', 'aurora_android_webview_microphone_permission_decision', 'aurora_android_voice_foreground_service_status']) {
      expect(runtimeSource).toContain(`"${command}"`)
    }
    expect(runtimeSource).toContain('addPluginListener')
    expect(runtimeSource).toContain('ANDROID_NATIVE_PLUGIN_NAME = "aurora-native"')
    expect(runtimeSource).toContain('ANDROID_LIFECYCLE_EVENT = "aurora://android-lifecycle"')
    expect(runtimeSource).toContain('android.webkit.resource.AUDIO_CAPTURE')
    expect(runtimeSource).toContain('backgroundWakewordAllowed: false')
    expect(runtimeSource).toContain('microphoneAllowedInForeground: false')
    expect(kotlinSource).toContain('canonicalJsonQuote')
    expect(kotlinSource).toContain("character.code.toString(16).padStart(4, '0')")
  })

  it('keeps Android and iOS thin preferences out of generic secure storage commands', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const mobileThinBranch = runtimeSource.slice(
      runtimeSource.indexOf('if (isAndroidTauriRuntime() || isIosTauriRuntime())'),
      runtimeSource.indexOf('const mobileClient = configuredGatewayUrl'),
    )

    expect(mobileThinBranch).toContain('memoryOnlyModePreferenceStore')
    expect(mobileThinBranch).not.toContain('secureModePreferenceStore')
    expect(mobileThinBranch).not.toContain('secureStorageGet')
    expect(mobileThinBranch).not.toContain('secureStorageSet')
  })


  it('documents iOS biometric credential scope without system assistant ownership claims', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const swift = readFileSync(
      resolve(repoRoot, iosNativePluginPath),
      'utf8'
    )
    const plist = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/Info.ios.plist'), 'utf8')

    expect(swift).toContain('LocalAuthentication')
    expect(swift).toContain('secretsRedacted')
    expect(swift).toContain('confirmationOnly')
    expect(plist).toContain('NSFaceIDUsageDescription')
    expect(`${swift}\n${plist}`).toContain('does not allow third-party default assistant ownership')
    expect(`${swift}\n${plist}`).not.toMatch(/"userCopy":\s*"Aurora replaces Siri/i)
  })

  it('routes iOS thin WebRTC credentials through an opaque device-only Keychain adapter', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const rustSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/lib.rs'), 'utf8')
    const pluginSource = readFileSync(resolve(repoRoot, iosNativePluginPath), 'utf8')
    const storageSource = readFileSync(
      resolve(
        repoRoot,
        'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraThinPeerStorage.swift',
      ),
      'utf8',
    )
    const capability = readFileSync(
      resolve(repoRoot, 'apps/aurora-tauri/src-tauri/capabilities/aurora-ios-thin.json'),
      'utf8',
    )
    const overlay = readFileSync(
      resolve(repoRoot, 'apps/aurora-tauri/src-tauri/tauri.ios-thin.conf.json'),
      'utf8',
    )

    expect(runtimeSource).toContain('isAndroidTauriRuntime() || isIosTauriRuntime()')
    expect(runtimeSource).toContain('isMobileTauriRuntime()')
    expect(runtimeSource).toContain('isIosTauriRuntime()')
    for (const command of [
      'thinPeerCredentialSet',
      'thinPeerCredentialStatus',
      'thinPeerCredentialDelete',
      'thinPeerReconnectProve',
      'thinProfileGet',
      'thinProfileSet',
      'thinRoomSecretSet',
      'thinRoomSecretGet',
    ]) {
      expect(pluginSource).toContain(`@objc public func ${command}`)
      expect(rustSource).toContain(`"${command}"`)
    }
    for (const invariant of [
      'kSecClassGenericPassword',
      'kSecAttrAccessibleWhenUnlockedThisDeviceOnly',
      'kSecAttrSynchronizable as String: kCFBooleanFalse',
      'HMAC<SHA256>.authenticationCode',
      'aurora.mesh.reconnect-proof.v1\\u{0}',
      '.sortedKeys',
      '.withoutEscapingSlashes',
      'Data(ensureAscii(serialized).utf8)',
      'for codeUnit in value.utf16',
      '"rawGetter": false',
      '"allowedGenericSecureStorage": false',
      '"redactedFields": ["rawBearerToken"]',
    ]) {
      expect(storageSource).toContain(invariant)
    }
    expect(storageSource).not.toContain('func thinPeerCredentialGet')
    expect(capability).toContain('aurora-thin-peer-credentials')
    expect(capability).toContain('aurora-thin-profile')
    expect(capability).not.toContain('aurora-secure-storage')
    expect(capability).not.toContain('aurora-local-file')
    expect(capability).not.toContain('aurora-audio-bridge')
    expect(overlay).toContain('"externalBin": []')
    expect(overlay).toContain('"resources": {}')
    expect(overlay).not.toContain('aurora-sidecar')
  })
})
