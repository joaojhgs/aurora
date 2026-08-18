// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  type AuroraClient,
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
  buildNativePlatformStatusArtifact,
  buildNativePlatformStatusJson,
  buildSettingsPermissionsModel,
  snapshotFromGraph
} from '../src/index'
import { SettingsView } from '../src/settings-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { AuroraShellSnapshot, RouteAvailability } from '../src/shell-data'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshotFor(nativeManifest: typeof nativeCapabilityManifestFixture, transportKind = 'native-mobile') {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest,
    transportKind
  })
  return snapshotFromGraph(transportKind, graph, nativeManifest)
}

describe('settings this-device surface', () => {
  it('renders This device with connection, appearance, voice, overlay, and storage sections and no legacy tab labels', () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const settingsMarkup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} currentPath="/settings" />)
    const nativeMarkup = renderToStaticMarkup(<SettingsNativeView snapshot={snapshot} />)

    expect(settingsMarkup).toContain('This device')
    expect(settingsMarkup).toContain('Privacy defaults')
    expect(settingsMarkup).toContain('Assistant behavior')
    expect(settingsMarkup).toContain('Appearance')
    expect(settingsMarkup).toContain('Connection &amp; role')
    expect(settingsMarkup).toContain('Voice on this device')
    expect(settingsMarkup).toContain('Overlay &amp; shortcuts')
    expect(settingsMarkup).toContain('Storage on this device')
    expect(settingsMarkup).toContain('Export my data')
    expect(settingsMarkup).toContain('Delete my data')

    expect(settingsMarkup).not.toContain('>General<')
    expect(settingsMarkup).not.toContain('Configuration')
    expect(settingsMarkup).not.toContain('>Advanced<')
    expect(settingsMarkup).not.toContain('Native permissions and capabilities')
    expect(settingsMarkup).not.toContain('Tauri tray status')
    expect(settingsMarkup).not.toContain('iOS App Intents, Shortcuts, widgets, share, and deep links')

    expect(nativeMarkup).toContain('This device')
    expect(nativeMarkup).toContain('Export my data')
    expect(nativeMarkup).toContain('Delete my data')
    expect(nativeMarkup).not.toContain('>Advanced<')
    expect(nativeMarkup).not.toContain('Additional device and account choices')
    expect(nativeMarkup).not.toContain('>Configuration<')
    expect(nativeMarkup).not.toContain('Theme, accessibility, and local storage')
  })

  it('renders Android device access with request buttons only for supported commands', () => {
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

    expect(markup).toContain('This device')
    expect(markup).toContain('Android')
    expect(markup).toContain('Device access')
    expect(markup).toContain('Default assistant')
    expect(markup).toContain('Request access')
    expect(markup).toContain('Export my data')
    expect(markup).not.toContain('>Advanced<')
    expect(markup).not.toContain('Overlay &amp; shortcuts')
    expect(markup).not.toContain('Request permission')
    expect(markup).not.toContain('Request unavailable')
    expect(markup).not.toContain('Theme, accessibility, and local storage')
  })

  it('sends an explicit Android assistant selection request from the device access control', async () => {
    const snapshot = snapshotFor(androidNativeCapabilityManifestFixture)
    const requestAccess = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(
          <SettingsPermissionsView
            snapshot={snapshot}
            surface="native"
            onRequestNativeAccess={requestAccess}
          />
        )
      })
      await flushReactWork()

      const assistantRow = Array.from(container.querySelectorAll('tr'))
        .find((row) => row.textContent?.includes('Default assistant'))
      const requestButton = assistantRow?.querySelector('button')
      expect(requestButton).toBeTruthy()
      expect(requestButton?.disabled).toBe(false)

      await act(async () => {
        requestButton?.click()
      })
      await flushReactWork()

      expect(requestAccess).toHaveBeenCalledTimes(1)
      expect(requestAccess).toHaveBeenCalledWith('android.assistantRole')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('renders iOS limits without native request fallbacks and without legacy Advanced labeling', () => {
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
    expect(model.nativeIntegrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'shareExtension', state: 'pending' }),
        expect.objectContaining({ id: 'widgets', state: 'pending' }),
        expect.objectContaining({ id: 'fileAssociations', state: 'pending' })
      ])
    )
    expect(model.nativePermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ios.shareExtension', state: 'pending' }),
        expect.objectContaining({ id: 'ios.widgets', state: 'pending' }),
        expect.objectContaining({ id: 'ios.fileAssociations', state: 'pending' })
      ])
    )
    expect(
      model.nativePermissions
        .filter((permission) => ['ios.shareExtension', 'ios.widgets', 'ios.fileAssociations'].includes(permission.id))
        .map((permission) => permission.state)
    ).not.toContain('privacy-blocked')

    expect(markup).toContain('This device')
    expect(markup).toContain('Export my data')
    expect(markup).not.toContain('>Advanced<')
    expect(markup).not.toContain('Voice on this device')
    expect(markup).not.toContain('Overlay &amp; shortcuts')
    expect(markup).not.toContain('system assistant ownership is unavailable')
    expect(markup).not.toContain('Request permission')
  })
})

it('maps hostile settings/native text and copy attributes across desktop, web, Android, and iOS', () => {
  const webGraph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest: null,
    transportKind: 'http'
  })
  const snapshots = [
    snapshotFor(nativeCapabilityManifestFixture, 'tauri-local'),
    snapshotFromGraph('http', webGraph, null),
    snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile'),
    snapshotFor(iosNativeCapabilityManifestFixture, 'native-mobile')
  ].map(poisonSnapshot)

  for (const snapshot of snapshots) {
    const settingsMarkup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} surface="settings" />)
    const nativeMarkup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} surface="native" />)
    assertNoForbiddenRenderedCopy(`${snapshot.transportKind}-settings`, settingsMarkup)
    assertNoForbiddenRenderedCopy(`${snapshot.transportKind}-native`, nativeMarkup)
  }
})

it('does not render leftover schema forms, home panes, or Configuration/Advanced tabs in Settings', async () => {
  const webGraph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest: null,
    transportKind: 'http'
  })
  const snapshots = [
    snapshotFor(nativeCapabilityManifestFixture, 'tauri-local'),
    snapshotFromGraph('http', webGraph, null),
    snapshotFor(androidNativeCapabilityManifestFixture, 'native-mobile'),
    snapshotFor(iosNativeCapabilityManifestFixture, 'native-mobile')
  ]

  for (const snapshot of snapshots) {
    const configRoute = availableConfigRoute(snapshot)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <SettingsView
          client={hostileSettingsClient([], [])}
          snapshot={snapshot}
          configRoute={configRoute}
          dataRoute={configRoute}
          sessionIsAdmin
        />
      )
    })
    await flushReactWork()

    const text = visibleText(container.innerHTML)
    expect(container.querySelector('#settings-this-device-title')?.textContent).toBe('This device')
    expect(container.querySelector('[aria-label="All Aurora settings"]')).toBeNull()
    expect(container.querySelector('#settings-home-title')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.startsWith('Aurora on '))).toBe(false)
    expect(text).not.toContain('All Aurora settings')
    expect(text).not.toMatch(/\bConfiguration\b/)
    expect(text).not.toMatch(/\bAdvanced\b/)
    assertNoForbiddenRenderedCopy(`${snapshot.transportKind}-settings-local-only`, container.innerHTML)

    await act(async () => root.unmount())
    container.remove()
  }
})

it('builds stable JSON status for desktop local, web fallback, Android preflight, and iOS preflight without unsupported-available claims', () => {
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

  const json = buildNativePlatformStatusJson({
    'desktop-local': desktop,
    'web-fallback': web,
    'android-preflight': android,
    'ios-preflight': ios
  })
  const status = JSON.parse(json) as {
    kind: string
    artifacts: Array<ReturnType<typeof buildNativePlatformStatusArtifact>>
  }

  expect(status.kind).toBe('aurora-native-platform-status')
  expect(status.artifacts.map((artifact) => artifact.id)).toEqual([
    'desktop-local',
    'web-fallback',
    'android-preflight',
    'ios-preflight'
  ])
  expect(status.artifacts.every((artifact) => artifact.unsupportedAvailableClaims.length === 0)).toBe(true)
  expect(status.artifacts.find((artifact) => artifact.id === 'desktop-local')).toEqual(expect.objectContaining({
    transportKind: 'tauri-local',
    nativePlatform: 'tauri-desktop',
    nativeAvailable: true,
    localPythonRequired: true
  }))
  expect(status.artifacts.find((artifact) => artifact.id === 'web-fallback')).toEqual(expect.objectContaining({
    transportKind: 'http',
    nativeAvailable: false,
    thinClientUsable: true,
    localPythonRequired: false
  }))
  expect(status.artifacts.find((artifact) => artifact.id === 'android-preflight')).toEqual(expect.objectContaining({
    transportKind: 'native-mobile',
    nativePlatform: 'android',
    thinClientUsable: true,
    localPythonRequired: false
  }))
  expect(status.artifacts.find((artifact) => artifact.id === 'ios-preflight')).toEqual(expect.objectContaining({
    transportKind: 'native-mobile',
    nativePlatform: 'ios',
    thinClientUsable: true,
    localPythonRequired: false
  }))
  expect(status.artifacts.find((artifact) => artifact.id === 'ios-preflight')?.unsupportedAvailableClaims).not.toEqual(
    expect.arrayContaining(['ios.shareExtension', 'ios.widgets', 'ios.fileAssociations'])
  )
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

function poisonSnapshot(snapshot: AuroraShellSnapshot): AuroraShellSnapshot {
  const poisoned = structuredClone(snapshot) as AuroraShellSnapshot
  poisoned.error = 'fallback provider manifest schema raw method permission error'
  poisoned.evidenceSource = 'debug evidence fixture manifest schema'
  for (const route of poisoned.routes) {
    route.providerLabel = 'raw provider / Orchestrator.ExternalUserInput method'
    route.explanation = 'fallback provider manifest schema error'
    route.blockers = ['raw permission method key_path services.tts.voice']
    route.evidenceSources = ['debug fixture evidence manifest']
  }
  poisoned.assistantCancellationRoute = poisoned.assistantCancellationRoute
    ? {
      ...poisoned.assistantCancellationRoute,
      providerLabel: 'provider fallback method route',
      explanation: 'schema manifest permission error',
      blockers: ['key_path services.gateway.host'],
      evidenceSources: ['proof fixture evidence']
    }
    : null
  poisoned.nativePermissions = poisoned.nativePermissions.map((permission) => ({
    ...permission,
    nativeState: permission.nativeState ?? 'fallback'
  }))
  poisoned.nativeCapabilities = poisoned.nativeCapabilities.map((capability) => ({
    ...capability,
    nativeState: capability.nativeState ?? 'fallback'
  }))
  poisoned.nativeAssistantRole = poisoned.nativeAssistantRole
    ? {
      ...poisoned.nativeAssistantRole,
      reason: 'RoleManager provider fallback raw permission error',
      evidenceSource: 'debug fixture evidence'
    }
    : null
  poisoned.nativeFallbackEntrypoints = poisoned.nativeFallbackEntrypoints.map((entrypoint) => ({
    ...entrypoint,
    reason: 'fallback provider manifest permission error'
  }))
  poisoned.nativeEntrypoints = poisoned.nativeEntrypoints.map((entrypoint) => ({
    ...entrypoint,
    label: 'Debug manifest permission action',
    reason: 'provider schema fallback error'
  }))
  poisoned.nativeMobileIntegrations = poisoned.nativeMobileIntegrations.map((integration) => ({
    ...integration,
    label: 'Provider fallback integration',
    userCopy: 'manifest schema permission method error',
    capability: 'provider.runtime.manifest',
    backendMethod: 'Orchestrator.ExternalUserInput',
    permission: 'services.tts.permission',
    evidenceSource: 'debug fixture evidence',
    verifier: 'assertion proof'
  }))
  poisoned.nativePlatformLimitations = (poisoned.nativePlatformLimitations ?? []).map((limitation) => ({
    ...limitation,
    label: 'Manifest fallback limitation',
    userCopy: 'schema permission provider method error',
    evidenceSource: 'proof fixture evidence'
  }))
  return poisoned
}

function availableConfigRoute(snapshot: AuroraShellSnapshot): RouteAvailability {
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'config')!
  return {
    ...route,
    disabled: false,
    state: 'available-local' as const,
    explanation: 'Ready',
    blockers: []
  }
}

function hostileSettingsClient(applied: unknown[], fields: unknown[]): AuroraClient {
  return {
    config: {
      getSchemaMetadata: async () => ({ ok: true, data: { fields, secrets_redacted: true } }),
      applyChange: async (change: unknown) => {
        applied.push(change)
        return { ok: true, data: { success: true } }
      }
    },
    speech: {
      tts: {
        getCapabilities: async () => ({ ok: true, data: { capabilities: { ready: false } } }),
        listVoices: async () => ({ ok: true, data: { voices: [] } })
      }
    },
    memory: {
      listNamespaces: async () => ({ ok: true, data: { namespaces: [] } }),
      listMessages: async () => ({ ok: true, data: { conversations: [] } })
    },
    capabilities: {
      listCatalog: async () => ({ ok: true, data: capabilityGraphCatalogFixture })
    },
    routes: { evaluatePolicy: async (request: { auditReceiptTarget?: string }) => policyEvaluation(request) }
  } as unknown as AuroraClient
}

function policyEvaluation(request: { auditReceiptTarget?: string }) {
  return {
    decision: 'allowed',
    allowed: true,
    availability: 'available-local',
    reasonCode: 'ready',
    repairPath: null,
    privacyClass: 'personal',
    dataClasses: ['personal'],
    explicitSelectorRequired: false,
    approval: { required: false, status: 'not-required', scopes: [] },
    route: {},
    selectedCandidate: null,
    blockers: [],
    preview: {
      fallbackBehavior: 'none',
      auditReceiptTarget: request.auditReceiptTarget ?? 'local'
    }
  }
}

function assertNoForbiddenRenderedCopy(name: string, markup: string): void {
  const visible = visibleText(markup)
  const visibleMatches = forbiddenCopyMatches(visible)
  expect(visibleMatches, `${name} visible copy: ${visible}`).toEqual([])
  const attributeMatches = copyAttributeValues(markup).flatMap((value) => forbiddenCopyMatches(value))
  expect(attributeMatches, `${name} copy attributes: ${copyAttributeValues(markup).join(' | ')}`).toEqual([])
}

function forbiddenCopyMatches(value: string): string[] {
  const matches = findForbiddenProductionCopyTerms(value).map((term) => term.id)
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  for (const term of [
    'raw',
    'permission',
    'adminaction',
    'method',
    'provider',
    'fallback',
    'manifest',
    'schema',
    'evidence',
    'debug',
    'proof',
    'assertion',
    'runtime',
    'transport',
    'sidecar',
    'thin',
    'keypath'
  ]) {
    if (compact.includes(term)) matches.push('raw-settings-detail')
  }
  if (/\b[A-Z][A-Za-z0-9]+\s*[._-]\s*[A-Z][A-Za-z0-9]+\b/u.test(value)) matches.push('raw-settings-detail')
  return [...new Set(matches)]
}

function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&quot;|&#x27;|&amp;|&lt;|&gt;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function copyAttributeValues(markup: string): string[] {
  const values: string[] = []
  for (const match of markup.matchAll(/\s(?:aria-label|title|placeholder|data-[a-z0-9-]+)=["']([^"']*)["']/giu)) {
    values.push(match[1] ?? '')
  }
  return values
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
