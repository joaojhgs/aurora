// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  type AuroraClient,
  type ConfigFieldMetadata,
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

describe('settings/native route separation', () => {
  it('keeps /settings focused on route, voice, assistant, theme/accessibility/local storage, and AdminAction policy', () => {
    const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
    const settingsMarkup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} currentPath="/settings" />)
    const nativeMarkup = renderToStaticMarkup(<SettingsNativeView snapshot={snapshot} />)

    expect(settingsMarkup).toContain('General')
    expect(settingsMarkup).toContain('Configuration')
    expect(settingsMarkup).toContain('Advanced')
    expect(settingsMarkup).toContain('Privacy defaults')
    expect(settingsMarkup).toContain('Voice behavior')
    expect(settingsMarkup).toContain('Assistant behavior')
    expect(settingsMarkup).toContain('Theme, accessibility, and local storage')
    expect(settingsMarkup).toContain('Connection choices')
    expect(settingsMarkup).toContain('Needs confirmation')
    expect(settingsMarkup).toContain('redacted non-secret UI preferences')

    expect(settingsMarkup).not.toContain('Native permissions and capabilities')
    expect(settingsMarkup).not.toContain('Tauri tray status')
    expect(settingsMarkup).not.toContain('iOS App Intents, Shortcuts, widgets, share, and deep links')

    expect(nativeMarkup).toContain('Advanced')
    expect(nativeMarkup).toContain('Additional device and account choices')
    expect(nativeMarkup).toContain('Routes')
    expect(nativeMarkup).toContain('Experience')
    expect(nativeMarkup).toContain('Platform')
    expect(nativeMarkup).toContain('Export my data')
    expect(nativeMarkup).toContain('Delete my data')
    expect(nativeMarkup).not.toContain('Native permissions and capabilities')
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

    expect(markup).toContain('Advanced')
    expect(markup).toContain('Platform')
    expect(markup).toContain('Export my data')
    expect(markup).not.toContain('Request permission')
    expect(markup).not.toContain('Request unavailable')
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
    expect(model.nativeIntegrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'shareExtension', state: 'pending' }),
        expect.objectContaining({ id: 'widgets', state: 'pending' }),
        expect.objectContaining({ id: 'fileAssociations', state: 'pending' })
      ])
    )

    expect(markup).toContain('Advanced')
    expect(markup).toContain('Platform')
    expect(markup).toContain('Export my data')
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

it('keeps hostile advanced settings metadata and errors out of rendered copy while preserving mutation keys across surfaces', async () => {
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
  const fields = hostileAdvancedFields()

  for (const snapshot of snapshots) {
    const configRoute = availableConfigRoute(snapshot)
    const dataRoute = { ...configRoute, disabled: true, explanation: 'r-a-w provider manifest schema fallback permission error' }
    const applied: unknown[] = []
    const client = hostileSettingsClient(applied, fields)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <SettingsView
          client={client}
          snapshot={snapshot}
          configRoute={configRoute}
          dataRoute={dataRoute}
          initialTab="advanced"
        />
      )
    })
    await flushReactWork()

    const advancedMarkup = advancedSettingsMarkup(container)
    const advancedText = visibleText(advancedMarkup)
    assertNoForbiddenRenderedCopy(`${snapshot.transportKind}-advanced-settings`, advancedMarkup)
    expect(advancedText).toContain('Automation')
    expect(advancedText).toContain('More settings 1')
    expect(advancedText).toContain('Model Choice')
    expect(advancedText).toContain('Setting')
    expect(Array.from(container.querySelectorAll('input')).some((candidate) => candidate.value === '[REDACTED]')).toBe(true)
    expect(advancedText).not.toContain('scheduler')
    expect(advancedText).not.toContain('arbitraryService')
    expect(advancedText).not.toContain('services.orchestrator.llm.provider')
    expect(advancedText).not.toContain('Orchestrator.ExternalUserInput')

    const input = Array.from(container.querySelectorAll('input')).find((candidate) => candidate.value === 'remote') as HTMLInputElement
    input.value = 'local'
    await act(async () => {
      input.focus()
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'local' }))
      input.blur()
    })
    await flushReactWork()

    expect(applied).toEqual([
      expect.objectContaining({
        change: expect.objectContaining({ key_path: 'services.scheduler.hostile_provider_choice' })
      })
    ])
    assertNoForbiddenRenderedCopy(`${snapshot.transportKind}-advanced-settings-after-save`, advancedSettingsMarkup(container))

    await act(async () => root.unmount())
    container.remove()
  }
})

it('maps unavailable and load-error settings copy without echoing raw explanations or errors', async () => {
  const snapshot = snapshotFor(nativeCapabilityManifestFixture, 'tauri-local')
  const unavailableContainer = document.createElement('div')
  document.body.appendChild(unavailableContainer)
  const unavailableRoot = createRoot(unavailableContainer)
  const unavailableRoute = {
    ...availableConfigRoute(snapshot),
    disabled: true,
    explanation: 'r.a.w AdminAction provider manifest schema method services.scheduler.host'
  }

  await act(async () => {
    unavailableRoot.render(
      <SettingsView
        client={hostileSettingsClient([], [])}
        snapshot={snapshot}
        configRoute={unavailableRoute}
        dataRoute={unavailableRoute}
        initialTab="advanced"
      />
    )
  })
  await flushReactWork()
  assertNoForbiddenRenderedCopy('advanced-settings-unavailable', advancedSettingsMarkup(unavailableContainer))
  expect(unavailableContainer.textContent).toContain('Review access and try again.')

  await act(async () => unavailableRoot.unmount())
  unavailableContainer.remove()

  const errorContainer = document.createElement('div')
  document.body.appendChild(errorContainer)
  const errorRoot = createRoot(errorContainer)
  await act(async () => {
    errorRoot.render(
      <SettingsView
        client={errorSettingsClient()}
        snapshot={snapshot}
        configRoute={availableConfigRoute(snapshot)}
        dataRoute={unavailableRoute}
        initialTab="advanced"
      />
    )
  })
  await flushReactWork()
  assertNoForbiddenRenderedCopy('advanced-settings-error', advancedSettingsMarkup(errorContainer))
  expect(visibleText(advancedSettingsMarkup(errorContainer))).toContain('Connection lost. Reconnecting')

  await act(async () => errorRoot.unmount())
  errorContainer.remove()
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

function hostileAdvancedFields(): ConfigFieldMetadata[] {
  return [
    configField({
      key_path: 'services.scheduler.hostile_provider_choice',
      title: 'Model Choice',
      description: 'provider manifest schema fallback key_path services.orchestrator.llm.provider',
      current_value: 'remote'
    }),
    configField({
      key_path: 'services.arbitraryService.raw_title',
      title: 'r.a.w',
      description: 'm-e-t-h-o-d Orchestrator.ExternalUserInput p-r-o-v-i-d-e-r'
    }),
    configField({
      key_path: 'services.arbitraryService.secret_method_id',
      title: 'Secret method id',
      description: 'AdminAction schema permission evidence',
      current_value: 'Orchestrator.ExternalUserInput',
      secret: true
    }),
    configField({
      key_path: 'customRoot.debug_manifest_setting',
      title: 'Debug manifest setting',
      description: 'f.a.l.l.b.a.c.k p.r.o.v.i.d.e.r schema'
    })
  ]
}

function configField(overrides: Partial<ConfigFieldMetadata>): ConfigFieldMetadata {
  return {
    key_path: 'services.scheduler.setting',
    title: 'Setting',
    description: 'Update how Aurora behaves on this device.',
    type: 'string',
    default: 'remote',
    current_value: 'remote',
    source_layer: 'schema',
    secret: false,
    reload_required: false,
    restart_required: false,
    affected_services: [],
    constraints: {},
    ...overrides
  }
}

function availableConfigRoute(snapshot: AuroraShellSnapshot): RouteAvailability {
  return {
    ...snapshot.routes.find((route) => route.item.id === 'settings')!,
    disabled: false,
    state: 'available-local' as const,
    explanation: 'Ready',
    blockers: []
  }
}

function hostileSettingsClient(applied: unknown[], fields: ConfigFieldMetadata[]): AuroraClient {
  return {
    config: {
      getSchemaMetadata: async () => ({ ok: true, data: { fields, secrets_redacted: true } }),
      applyChange: async (change: unknown) => {
        applied.push(change)
        return { ok: true, data: { success: true } }
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

function errorSettingsClient(): AuroraClient {
  return {
    config: {
      getSchemaMetadata: async () => ({
        ok: false,
        error: { message: 'r.a.w provider manifest schema method failure', code: 'connection_lost' }
      })
    },
    memory: { listNamespaces: async () => ({ ok: true, data: { namespaces: [] } }), listMessages: async () => ({ ok: true, data: { conversations: [] } }) },
    capabilities: { listCatalog: async () => ({ ok: true, data: capabilityGraphCatalogFixture }) },
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

function advancedSettingsMarkup(container: HTMLElement): string {
  const html = container.innerHTML
  const stop = html.indexOf('Memory')
  return stop >= 0 ? html.slice(0, stop) : html
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
