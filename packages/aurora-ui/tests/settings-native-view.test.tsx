import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  androidNativeCapabilityManifestFixture,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  gatewayRegistryFixture,
  iosNativeCapabilityManifestFixture,
  nativeCapabilityManifestFixture
} from '@aurora/client'
import {
  SettingsPermissionsView,
  SettingsNativeView,
  buildNativePlatformEvidenceArtifact,
  buildNativePlatformEvidenceJson,
  buildSettingsPermissionsModel,
  snapshotFromGraph
} from '../src/index'

function snapshotFor(nativeManifest: typeof nativeCapabilityManifestFixture, transportKind = 'native-mobile') {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest,
    transportKind
  })
  return snapshotFromGraph(transportKind, graph, nativeManifest)
}

describe('settings/native route separation', () => {
  it('keeps /settings focused on route, voice, assistant, theme/accessibility/local storage, and AdminAction policy', () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const settingsMarkup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} currentPath="/settings" />)
    const nativeMarkup = renderToStaticMarkup(<SettingsNativeView snapshot={snapshot} />)

    expect(settingsMarkup).toContain('Settings and permissions')
    expect(settingsMarkup).toContain('Privacy defaults')
    expect(settingsMarkup).toContain('Voice behavior')
    expect(settingsMarkup).toContain('Assistant behavior')
    expect(settingsMarkup).toContain('Theme, accessibility, and local storage')
    expect(settingsMarkup).toContain('Route and fallback policy')
    expect(settingsMarkup).toContain('AdminAction required')
    expect(settingsMarkup).toContain('redacted non-secret UI preferences')

    expect(settingsMarkup).not.toContain('Native permissions and capabilities')
    expect(settingsMarkup).not.toContain('Tauri tray status')
    expect(settingsMarkup).not.toContain('iOS App Intents, Shortcuts, widgets, share, and deep links')

    expect(nativeMarkup).toContain('Native platform settings')
    expect(nativeMarkup).toContain('Native permissions and capabilities')
    expect(nativeMarkup).toContain('Tauri native manifest')
    expect(nativeMarkup).toContain('Tauri tray status')
    expect(nativeMarkup).toContain('Tauri notifications status')
    expect(nativeMarkup).toContain('Tauri dialog open')
    expect(nativeMarkup).toContain('Tauri audio capture')
    expect(nativeMarkup).toContain('Tauri local file read')
    expect(nativeMarkup).toContain('Tauri updater')
    expect(nativeMarkup).not.toContain('Privacy defaults')
    expect(nativeMarkup).not.toContain('Theme, accessibility, and local storage')
    expect(nativeMarkup).not.toBe(settingsMarkup)
  })

  it('renders Android native assistant, notifications, foreground audio, Keystore, biometrics, share, and deep-link state with request buttons only for supported commands', () => {
    const snapshot = snapshotFor(androidNativeCapabilityManifestFixture)
    const model = buildSettingsPermissionsModel(snapshot)
    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} surface="native" />)

    expect(snapshot.nativePlatform).toBe('android')
    expect(model.nativePermissions.find((permission) => permission.id === 'android.assistantRole')).toEqual(
      expect.objectContaining({ requestEnabled: true, state: 'privacy-blocked' })
    )
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.android.notifications')).toBeTruthy()
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.android.voiceForegroundService')).toBeTruthy()
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.android.secureStorage')).toBeTruthy()
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.android.biometric')).toBeTruthy()
    expect(model.nativeIntegrations.map((integration) => integration.id)).toEqual(
      expect.arrayContaining(['androidShareSheet', 'androidDeepLinks'])
    )

    expect(markup).toContain('Android assistant role')
    expect(markup).toContain('Android notifications')
    expect(markup).toContain('Android foreground voice service')
    expect(markup).toContain('Android Keystore secure storage')
    expect(markup).toContain('Android biometrics')
    expect(markup).toContain('Android share sheet')
    expect(markup).toContain('Android deep links')
    expect(markup).toContain('Request permission')
    expect(markup).toContain('Request unavailable')
    expect(markup).not.toContain('Theme, accessibility, and local storage')
  })

  it('renders iOS Keychain, biometrics, App Intents, Shortcuts, widgets, share/deep links, and foreground constraints without native request fallbacks', () => {
    const iosManifest = {
      ...iosNativeCapabilityManifestFixture,
      permissions: {
        ...iosNativeCapabilityManifestFixture.permissions,
        'aurora.iosKeychain': true,
        'aurora.iosBiometricUnlock': true
      },
      capabilities: {
        ...iosNativeCapabilityManifestFixture.capabilities,
        'ios.keychain.secureCredentialStorage': true,
        'ios.biometric.adminUnlock': true
      }
    }
    const snapshot = snapshotFor(iosManifest)
    const model = buildSettingsPermissionsModel(snapshot)
    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} surface="native" />)

    expect(snapshot.nativePlatform).toBe('ios')
    expect(model.nativePermissions.find((permission) => permission.id === 'ios.backgroundVoice')).toEqual(
      expect.objectContaining({ state: 'unsupported', requestEnabled: false })
    )
    expect(model.nativeIntegrations.map((integration) => integration.id)).toEqual(
      expect.arrayContaining(['askAuroraAppIntent', 'askAuroraShortcut', 'shareExtension', 'deepLinks', 'widgets', 'siriReplacement'])
    )

    expect(markup).toContain('iOS App Intents, Shortcuts, widgets, share, and deep links')
    expect(markup).toContain('iOS Keychain')
    expect(markup).toContain('Face ID / Touch ID admin unlock')
    expect(markup).toContain('iOS App Intents')
    expect(markup).toContain('iOS Shortcuts')
    expect(markup).toContain('iOS widgets')
    expect(markup).toContain('iOS share extension')
    expect(markup).toContain('iOS deep links')
    expect(markup).toContain('Foreground voice capture')
    expect(markup).toContain('Always-on background listening is unavailable on iOS')
    expect(markup).toContain('system assistant ownership is unavailable')
    expect(markup).not.toContain('Request permission')
  })
})

it('builds stable JSON evidence for desktop local, web fallback, Android preflight, and iOS preflight without unsupported-available claims', () => {
  const desktop = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
  const webGraph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest: null,
    transportKind: 'http'
  })
  const web = snapshotFromGraph('http', webGraph, null)
  const android = snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile')
  const ios = snapshotFor(iosNativeCapabilityManifestFixture, 'native-mobile')

  const json = buildNativePlatformEvidenceJson({
    'desktop-local': desktop,
    'web-fallback': web,
    'android-preflight': android,
    'ios-preflight': ios
  })
  const evidence = JSON.parse(json) as {
    kind: string
    artifacts: Array<ReturnType<typeof buildNativePlatformEvidenceArtifact>>
  }

  expect(evidence.kind).toBe('aurora-native-platform-evidence')
  expect(evidence.artifacts.map((artifact) => artifact.id)).toEqual([
    'desktop-local',
    'web-fallback',
    'android-preflight',
    'ios-preflight'
  ])
  expect(evidence.artifacts.every((artifact) => artifact.unsupportedAvailableClaims.length === 0)).toBe(true)
  expect(evidence.artifacts.find((artifact) => artifact.id === 'desktop-local')).toEqual(expect.objectContaining({
    transportKind: 'tauri-local',
    nativePlatform: 'tauri-desktop',
    nativeAvailable: true,
    localPythonRequired: true
  }))
  expect(evidence.artifacts.find((artifact) => artifact.id === 'web-fallback')).toEqual(expect.objectContaining({
    transportKind: 'http',
    nativeAvailable: false,
    thinClientUsable: true,
    localPythonRequired: false
  }))
  expect(evidence.artifacts.find((artifact) => artifact.id === 'android-preflight')).toEqual(expect.objectContaining({
    transportKind: 'native-mobile',
    nativePlatform: 'android',
    thinClientUsable: true,
    localPythonRequired: false
  }))
  expect(evidence.artifacts.find((artifact) => artifact.id === 'ios-preflight')).toEqual(expect.objectContaining({
    transportKind: 'native-mobile',
    nativePlatform: 'ios',
    thinClientUsable: true,
    localPythonRequired: false
  }))
})

it('does not expose platform-inapplicable native rows as available capabilities', () => {
  const desktopModel = buildSettingsPermissionsModel(snapshotFor(nativeCapabilityManifestFixture, 'tauri-local'))
  const androidModel = buildSettingsPermissionsModel(snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile'))
  const iosModel = buildSettingsPermissionsModel(snapshotFor(iosNativeCapabilityManifestFixture, 'native-mobile'))

  expect(desktopModel.nativePermissions.some((permission) => permission.id.toLowerCase().includes('ios'))).toBe(false)
  expect(desktopModel.nativePermissions.some((permission) => permission.id.toLowerCase().includes('android'))).toBe(false)
  expect(desktopModel.nativeIntegrations).toEqual([])
  expect(androidModel.nativePermissions.some((permission) => permission.id.toLowerCase().includes('ios'))).toBe(false)
  expect(iosModel.nativePermissions.some((permission) => permission.id.toLowerCase().includes('android'))).toBe(false)

  for (const model of [desktopModel, androidModel, iosModel]) {
    expect(model.nativePermissions.filter((permission) => permission.state === 'unsupported' && (permission.granted || permission.capabilityEnabled || permission.requestEnabled))).toEqual([])
  }
})
