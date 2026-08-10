// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  AuroraClient as Aurora,
  AuroraError,
  MockAuroraTransport,
  ORCHESTRATOR_METHODS,
  backendInventoryFixture,
  androidNativeCapabilityManifestFixture,
  buildCapabilityGraph,
  capabilityCatalogFixture,
  capabilityGraphCatalogFixture,
  cloneFixture,
  describeBackendInventory,
  evaluateRoutePolicy,
  gatewayRegistryFixture,
  iosNativeCapabilityManifestFixture,
  modelRuntimeCatalogFixture,
  meshPeerListFixture,
  meshStatusFixture,
  normalizeToolCatalog,
  routeExplainFixture,
  schedulerJobsFixture,
  supportBundleFixture,
  toolCatalogFixture,
  webrtcDiagnosticsFixture,
  type CapabilityActionInfo,
  type CapabilityCatalogResponse,
  type CapabilityProviderInfo,
  type GetRegistryResponse,
  type GetServicesResponse,
  type PendingPairingEntry,
  type VoiceRuntimeEvent,
  type AuroraTransportRequest
} from '@aurora/client'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import {
  buildAdminOverviewSnapshot,
  buildAdminServicesSnapshot,
  buildAdminPluginsSnapshot,
  buildAdminRbacSnapshot,
  buildAdminTokensSnapshot,
  buildAdminDevicesSnapshot,
  buildAdminAuditSnapshot,
  buildAdminSchedulerSnapshot,
  buildAuditExport,
  buildDeviceDeleteAdminAction,
  buildRbacPermissionPatchAction,
  buildTokenRevokeAdminAction,
  buildOnboardingViewModel,
  buildPairingAdminActionRequest,
  buildPairingQueueModel,
  buildMeshDiagnosticsSnapshot,
  buildMeshPeerAdminAction,
  buildMeshScopesAdminAction,
  buildMeshInvitePayload,
  meshInviteReadiness,
  buildMeshPeersSnapshot,
  MeshPeersView,
  buildRoutePolicySnapshot,
  buildRouteSheetViewModel,
  applyAssistantAudioChunkUpdate,
  attachmentStatusFromBackend,
  attachmentToContextItem,
  applyAssistantStreamDelta,
  applyAssistantTerminalUpdate,
  applyAssistantToolUpdate,
  AppShell,
  isAssistantStreamHardTerminal,
  assistantControlsForRoute,
  assistantRemotePrivacyWarning,
  contextIngestOutcomeIndex,
  isAcceptedContextStatus,
  mapContextIngestOutcomesByPendingIndex,
  submitToolDenialAction,
  buildToolCategories,
  filterTools,
  assistantErrorMessage,
  backupErrorMessage,
  buildAssistantVoiceModel,
  buildMemoryViewModel,
  buildShellSnapshot,
  loadingShellSnapshot,
  buildModelsViewModel,
  buildConfigEditorModel,
  buildSettingsPermissionsModel,
  errorShellSnapshot,
  productionSurfaceContracts,
  productionRouteOracles,
  productionGlobalMockReferences,
  requiredProductionMockReferenceFiles,
  snapshotFromGraph,
  parsePermissionList,
  pairingErrorMessage,
  meshPeerErrorMessage,
  meshDiagnosticsSnapshotFromResults,
  reconcileMeshDiagnosticsWithThinPeer,
  reconcileMeshPeersWithThinPeer,
  parseMeshPermissionList,
  redactDiagnosticText,
  retainThinShellSnapshot,
  assistantExecutionOptions,
  routePolicyDraftChange,
  routePolicyFromRoute,
  routePolicyScenarios,
  routeSheetErrorMessage,
  routeSheetPolicySignals,
  auroraMobileTabs,
  auroraAssistantCancellationItem,
  auroraAssistantVoiceItems,
  auroraNavSections,
  auroraEmbeddedNavItems,
  getAuroraNavItem,
  navItemSnapshot,
  getAuroraSurfaceProfile,
  type BrowserWebRtcSnapshot
} from '../src/index'


it('centralizes voice capture ownership by target surface', () => {
  const desktopLocal = getAuroraSurfaceProfile({ runtimeMode: 'desktop-local', transportKind: 'tauri-local' })
  expect(desktopLocal.kind).toBe('desktop-local')
  expect(desktopLocal.voiceCapture.focusedPushToTalkOwner).toBe('native-desktop')
  expect(desktopLocal.voiceCapture.wakewordOwner).toBe('unavailable')
  expect(desktopLocal.voiceCapture.wakewordRequiresFocus).toBe(true)
  expect(desktopLocal.voiceCapture.avoidCoordinatorPushToTalk).toBe(true)
  expect(desktopLocal.voiceCapture.canUseWebViewVisualizer).toBe(false)

  const webThin = getAuroraSurfaceProfile({ transportKind: 'http' })
  expect(webThin.kind).toBe('web')
  expect(webThin.isWebThin).toBe(true)
  expect(webThin.voiceCapture.wakewordOwner).toBe('webview-focused')
  expect(webThin.voiceCapture.wakewordRequiresFocus).toBe(true)

  const mobile = getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'ios' })
  expect(mobile.kind).toBe('ios')
  expect(mobile.voiceCapture.focusedPushToTalkOwner).toBe('unavailable')
  expect(mobile.voiceCapture.wakewordOwner).toBe('unavailable')
  expect(mobile.voiceCapture.canUseWebViewVisualizer).toBe(false)
})

class RecordingMockAuroraTransport extends MockAuroraTransport {
  readonly requests: AuroraTransportRequest[] = []

  override async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ) {
    this.requests.push(request)
    return super.request<TData, TPayload>(request)
  }
}

describe('Aurora production shell', () => {
  it('tracks the mobile visual viewport so the Android keyboard cannot cover the composer', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const viewport = new EventTarget()
    Object.defineProperties(viewport, {
      height: { configurable: true, value: 572.19 },
      offsetTop: { configurable: true, value: 0 },
    })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 914 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <AppShell snapshot={snapshot} runtimeMode="mobile">
            <div>Current page</div>
          </AppShell>,
        )
      })

      const shell = host.querySelector<HTMLElement>('.aui-shell')
      expect(shell?.dataset.mobileViewport).toBe('true')
      expect(shell?.dataset.virtualKeyboardOpen).toBe('true')
      expect(shell?.style.getPropertyValue('--aui-visual-viewport-height')).toBe('572px')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
      else Reflect.deleteProperty(window, 'innerHeight')
      if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
      else Reflect.deleteProperty(window, 'visualViewport')
    }
  })

  it('recognizes native resize-based keyboards and reclaims the mobile tab space', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    let viewportHeight = 914
    const viewport = new EventTarget()
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => viewportHeight },
      offsetTop: { configurable: true, value: 0 },
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => viewportHeight,
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <AppShell snapshot={snapshot} runtimeMode="mobile">
            <textarea aria-label="Prompt" />
          </AppShell>,
        )
      })

      const shell = host.querySelector<HTMLElement>('.aui-shell')
      expect(shell?.dataset.virtualKeyboardOpen).toBeUndefined()

      const prompt = host.querySelector<HTMLTextAreaElement>('textarea')
      await act(async () => prompt?.focus())
      viewportHeight = 572
      await act(async () => {
        viewport.dispatchEvent(new Event('resize'))
      })

      expect(shell?.dataset.virtualKeyboardOpen).toBe('true')
      expect(shell?.style.getPropertyValue('--aui-visual-viewport-height')).toBe('572px')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
      else Reflect.deleteProperty(window, 'innerHeight')
      if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
      else Reflect.deleteProperty(window, 'visualViewport')
    }
  })

  it('keeps status and recovery pages navigable while their capabilities are unavailable', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const mesh = snapshot.routes.find((candidate) => candidate.item.id === 'mesh')
    if (!mesh) throw new Error('Mesh route fixture is unavailable')
    const unavailableSnapshot = {
      ...snapshot,
      routes: snapshot.routes.map((candidate) => candidate.item.id === 'mesh'
        ? { ...candidate, disabled: true, routeable: false, state: 'stale' as const }
        : candidate),
    }
    const onNavigate = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <AppShell snapshot={unavailableSnapshot} currentPath="/" onNavigate={onNavigate}>
          <div>Current page</div>
        </AppShell>,
      )
    })
    const meshTab = host.querySelector<HTMLAnchorElement>('[data-mobile-tab="mesh"]')
    expect(meshTab).not.toBeNull()
    expect(meshTab?.getAttribute('aria-disabled')).toBeNull()
    await act(async () => meshTab?.click())
    expect(onNavigate).toHaveBeenCalledWith('/mesh')

    await act(async () => root.unmount())
    host.remove()
  })

  it('builds policy blocker signals for privacy-blocked routes', () => {
    const privacyBlocked = blockedRouteEvaluation('privacy-blocked')
    const policySignals = routeSheetPolicySignals({
      ...privacyBlocked,
      blockers: [
        ...privacyBlocked.blockers,
        { code: 'consent_required', message: 'Consent required.', severity: 'error' as const, provider_id: null, peer_id: null, security_privacy: true },
        { code: 'privacy_indicator_required', message: 'Privacy indicator required.', severity: 'error' as const, provider_id: null, peer_id: null, security_privacy: true },
        { code: 'native_permission_missing', message: 'Native permission required.', severity: 'error' as const, provider_id: null, peer_id: null, security_privacy: true }
      ]
    }, 'required')

    expect(policySignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'selector', label: 'Privacy selector', state: 'blocked' }),
      expect.objectContaining({ id: 'consent', label: 'Consent', state: 'blocked' }),
      expect.objectContaining({ id: 'privacy-indicator', label: 'Privacy indicator', state: 'blocked' }),
      expect.objectContaining({ id: 'native-permission', label: 'Device permission', state: 'blocked' }),
      expect.objectContaining({ id: 'admin-action', label: 'Admin approval', state: 'blocked' })
    ]))
    expect(policySignals.map((signal) => signal.detail).join(' ')).not.toMatch(/\b(AdminAction|Native permission|fallback|provider)\b/i)
  })

  it('builds route availability from Aurora capability catalog', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.evidenceSource).toContain('Local transport')
    expect(snapshot.routes.some((route) => route.state === 'available-local')).toBe(true)
    expect(route(snapshot, 'data').state).toBe('privacy-blocked')
    for (const id of ['access', 'tokens', 'devices', 'config', 'plugins', 'pairing', 'backups', 'scheduler', 'settings']) {
      const adminReadRoute = route(snapshot, id)
      expect(adminReadRoute.requiresAdminAction, `${id} read route must not require AdminAction`).toBe(false)
    }
    const accessRoute = route(snapshot, 'access')
    expect(`${accessRoute.item.capabilityModule}.${accessRoute.item.capabilityMethod}`).toBe('Auth.ListPrincipals')
    expect(accessRoute.state).not.toBe('unsupported')
    expect(accessRoute.providerLabel).toContain('Auth.ListPrincipals')
    expect(snapshot.routes.every((route) => route.repairActions.length > 0)).toBe(true)
    expect(snapshot.routes.every((route) => Array.isArray(route.candidateProviders))).toBe(true)
  })

  it('keeps missing non-private capability evidence unsupported while preserving explicit privacy-blocked fallback routes', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => {
      const catalog = cloneFixture(capabilityGraphCatalogFixture)
      catalog.actions = catalog.actions.filter((action) => !['Config.Get', 'Gateway.GetRegistry', 'DB.RAGSearch'].includes(action.topic ?? ''))
      return catalog
    })

    const snapshot = await buildShellSnapshot(new Aurora({ transport }))
    const missingConfig = route(snapshot, 'config')
    const missingContracts = route(snapshot, 'contracts')
    const privacyFallback = route(snapshot, 'data')

    for (const missingRoute of [missingConfig, missingContracts]) {
      expect(missingRoute.state).toBe('unsupported')
      expect(missingRoute.disabled).toBe(true)
      expect(missingRoute.routeable).toBe(false)
      expect(missingRoute.blockers).toContain('capability_not_advertised')
    }

    expect(privacyFallback.state).toBe('privacy-blocked')
    expect(privacyFallback.disabled).toBe(true)
    expect(privacyFallback.routeable).toBe(false)
    expect(privacyFallback.blockers).toContain('capability_not_advertised')
  })

  it('keeps read-only sensitive admin routes routeable without route-level AdminAction while mutations stay gated', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const adminReadRouteIds = ['admin', 'services', 'access', 'tokens', 'devices', 'config', 'contracts', 'plugins', 'pairing', 'backups', 'scheduler', 'audit']
    const sensitiveReadRouteIds = [...adminReadRouteIds, 'settings']

    for (const id of adminReadRouteIds) {
      const adminReadRoute = route(snapshot, id)
      expect(adminReadRoute.item.adminGated, `${id} remains an admin-owned route`).toBe(true)
    }
    for (const id of sensitiveReadRouteIds) {
      const readRoute = route(snapshot, id)
      expect(readRoute.requiresAdminAction, `${id} read route must not be AdminAction-blocked`).toBe(false)
    }

    const actionSurfaces = productionSurfaceContracts.filter((surface) => surface.adminActionRequired)
    expect(actionSurfaces.map((surface) => surface.id)).toEqual(expect.arrayContaining([
      'admin-rbac',
      'admin-devices',
      'admin-plugins',
      'admin-scheduler',
      'config-editor',
      'backup-restore',
      'mesh-peers',
      'settings-permissions-privacy'
    ]))
    for (const surface of actionSurfaces) {
      expect(surface.stateCoverage, `${surface.id} mutation state coverage`).toContain('admin-action')
      expect(
        surface.truthSources.some((source) => source.kind === 'admin-action'),
        `${surface.id} mutation truth source`
      ).toBe(true)
    }
  })

  it('documents every production surface with backend or explicit degraded status', () => {
    const requiredSurfaceIds = [
      'assistant-route-sheet',
      'admin-overview',
      'admin-services',
      'admin-contracts',
      'admin-rbac',
      'admin-audit',
      'admin-plugins',
      'admin-devices',
      'admin-scheduler',
      'config-editor',
      'memory-rag',
      'backup-restore',
      'models-runtime',
      'mesh-peers',
      'mesh-diagnostics',
      'route-policy',
      'resource-diagnostics',
      'settings-permissions-privacy',
      'native-capabilities',
      'onboarding-auth-pairing'
    ]
    const surfaceIds = productionSurfaceContracts.map((surface) => surface.id)
    const navIds = new Set([
      ...auroraNavSections.flatMap((section) => section.items.map((item) => item.id)),
      ...auroraEmbeddedNavItems.map((item) => item.id),
      auroraAssistantCancellationItem.id,
      ...Object.values(auroraAssistantVoiceItems).map((item) => item.id)
    ])
    const descriptorMethods = new Set(
      describeBackendInventory(backendInventoryFixture).methods.map((method) => method.busTopic)
    )

    expect(surfaceIds).toEqual(requiredSurfaceIds)
    const primaryNavIds = auroraNavSections.flatMap((section) => section.items.map((item) => item.id))
    const coveredNavIds = new Set(productionSurfaceContracts.flatMap((surface) => surface.navItemIds))
    expect(primaryNavIds.filter((id) => !coveredNavIds.has(id))).toEqual([])

    const allNavIds = [...primaryNavIds, ...auroraEmbeddedNavItems.map((item) => item.id)]
    const oracleNavIds = productionRouteOracles.map((oracle) => oracle.navItemId)
    expect([...new Set(oracleNavIds)]).toHaveLength(oracleNavIds.length)
    expect(primaryNavIds.filter((id) => !oracleNavIds.includes(id))).toEqual([])
    expect(oracleNavIds.filter((id) => !allNavIds.includes(id))).toEqual([])

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const uiSrcRoot = join(repoRoot, 'packages/aurora-ui/src')
    const mockRoot = join(repoRoot, 'modules/ui-mock-reference')
    const requiredStates = ['loading', 'empty', 'error', 'offline', 'permission', 'unsupported'] as const

    for (const surface of productionSurfaceContracts) {
      expect(surface.navItemIds.length, `${surface.id} nav bindings`).toBeGreaterThan(0)
      expect(surface.mockReferenceFiles.length, `${surface.id} mock references`).toBeGreaterThan(0)
      expect(surface.componentFiles.length, `${surface.id} components`).toBeGreaterThan(0)
      expect(surface.stateCoverage.length, `${surface.id} state coverage`).toBeGreaterThan(0)
      expect(surface.truthSources.length, `${surface.id} truth sources`).toBeGreaterThan(0)
      expect(surface.coverage.length, `${surface.id} coverage`).toBeGreaterThan(0)
      for (const oracle of surface.routeOracles ?? []) {
        expect(surface.navItemIds, `${surface.id} oracle nav binding`).toContain(oracle.navItemId)
        expect(oracle.renderedLandmarks.length, `${surface.id}/${oracle.navItemId} rendered landmarks`).toBeGreaterThan(0)
        expect(oracle.routeSpecificControls.length, `${surface.id}/${oracle.navItemId} route-specific controls`).toBeGreaterThan(0)
        expect(
          oracle.renderedLandmarks.every((landmark) => landmark.trim().length > 2),
          `${surface.id}/${oracle.navItemId} meaningful landmarks`
        ).toBe(true)
        expect(
          oracle.routeSpecificControls.every((control) => control.trim().length > 2),
          `${surface.id}/${oracle.navItemId} meaningful route-specific controls`
        ).toBe(true)
      }
      expect(surface.fixturePolicy, `${surface.id} fixture policy`).toBe('test-only')
      expect(surface.truthSources.some((source) => source.kind !== 'unsupported-degraded'), `${surface.id} live source`).toBe(true)
      expect(surface.navItemIds.every((id) => navIds.has(id)), `${surface.id} nav ids`).toBe(true)
      expect(requiredStates.filter((state) => !surface.stateCoverage.includes(state)), `${surface.id} required route states`).toEqual([])
      expect(surface.mockReferenceFiles.every((file) => existsSync(join(mockRoot, file))), `${surface.id} mock files exist`).toBe(true)
      expect(surface.componentFiles.every((file) => existsSync(join(uiSrcRoot, file))), `${surface.id} component files exist`).toBe(true)

      if (surface.mutatingMethodType === 'manage') {
        expect(surface.adminActionRequired, `${surface.id} AdminAction`).toBe(true)
        expect(surface.stateCoverage.includes('admin-action'), `${surface.id} AdminAction state`).toBe(true)
        expect(
          surface.truthSources.some((source) => source.kind === 'admin-action'),
          `${surface.id} AdminAction truth source`
        ).toBe(true)
      }

      const descriptorBackedMethods = surface.truthSources
        .flatMap((source) => source.methods)
        .filter((method) => descriptorMethods.has(method))
      expect(
        descriptorBackedMethods.length > 0 ||
          surface.truthSources.some((source) =>
            ['admin-action', 'capability-graph', 'native-manifest', 'unsupported-degraded'].includes(source.kind)
          ),
        `${surface.id} descriptor or explicit gated/degraded status`
      ).toBe(true)
    }
  })

  it('locks the original mock reference corpus and shell structure as production UX status', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const mockRoot = join(repoRoot, 'modules/ui-mock-reference')
    const uiSrcRoot = join(repoRoot, 'packages/aurora-ui/src')
    const surfaceMockReferences = new Set(productionSurfaceContracts.flatMap((surface) => surface.mockReferenceFiles))

    for (const file of requiredProductionMockReferenceFiles) {
      expect(existsSync(join(mockRoot, file)), `${file} exists in modules/ui-mock-reference`).toBe(true)
    }
    for (const file of requiredProductionMockReferenceFiles) {
      expect(
        surfaceMockReferences.has(file) || productionGlobalMockReferences.includes(file as typeof productionGlobalMockReferences[number]),
        `${file} is bound to a production surface or global shell reference`
      ).toBe(true)
    }

    const shellSource = readFileSync(join(uiSrcRoot, 'shell.tsx'), 'utf8')
    expect(shellSource).toContain('Primary navigation')
    expect(shellSource).toContain('Navigation')
    expect(shellSource).toContain('Mobile navigation')
    expect(shellSource).toContain('MobileNavigationSheet')
    expect(shellSource).toContain('MobileBottomTabs')
    expect(shellSource).toContain('Toggle activity rail')
    expect(shellSource).toContain('Route')
    expect(shellSource).toContain('Privacy')
    expect(shellSource).toContain('RouteMatrix')
    expect(shellSource).toContain('Aurora activity')
  })

  it('keeps mock-driven interaction anchors in production component source', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const uiSrcRoot = join(repoRoot, 'packages/aurora-ui/src')
    const genericStatusOnly = /\b(catalog|status|loading|backend|Aurora|SDK|route status)\b/i
    const memoryRagContract = productionSurfaceContracts.find((surface) => surface.id === 'memory-rag')

    expect(memoryRagContract?.mockUxAnchors).toContain('Activity history for policy changes')
    expect(memoryRagContract?.mockUxAnchors).not.toContain('Audit trail for policy changes')

    for (const surface of productionSurfaceContracts) {
      const sourceText = surface.componentFiles
        .map((file) => readFileSync(join(uiSrcRoot, file), 'utf8'))
        .join('\n')

      expect(surface.mockUxAnchors.length, `${surface.id} mock UX anchors`).toBeGreaterThanOrEqual(3)
      expect(
        surface.mockUxAnchors.some((anchor) => !genericStatusOnly.test(anchor)),
        `${surface.id} cannot be documented only by backend/status/catalog labels`
      ).toBe(true)

      for (const anchor of surface.mockUxAnchors) {
        expect(
          sourceText.includes(anchor) || productionAnchorAliasPresent(sourceText, anchor),
          `${surface.id} production components must retain mock-derived interaction anchor "${anchor}"`
        ).toBe(true)
      }
    }
  })

  it('keeps production UI screens behind Aurora and away from mock fixtures as live truth', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const scannedFiles = [
      ...filesUnder(join(repoRoot, 'packages/aurora-ui/src'), /\.(ts|tsx)$/),
      ...filesUnder(join(repoRoot, 'apps/aurora-web/app'), /\.(ts|tsx)$/),
      ...filesUnder(join(repoRoot, 'apps/aurora-tauri/src'), /\.(ts|tsx)$/)
    ].filter((file) => !isAllowedAdapterFile(repoRoot, file) && !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(file))

    expect(scannedFiles.length).toBeGreaterThan(0)
    for (const file of scannedFiles) {
      const rel = relative(repoRoot, file)
      const text = readFileSync(file, 'utf8')
      expect(text, `${rel} must not call fetch directly`).not.toMatch(/\bfetch\s*\(/)
      expect(text, `${rel} must not call Tauri invoke directly`).not.toMatch(/\binvoke\s*\(/)
      expect(text, `${rel} must not import SDK fixtures`).not.toMatch(/@aurora\/client.*Fixture|packages\/aurora-sdk\/src\/fixtures/)
      expect(text, `${rel} must not import mock reference fixtures`).not.toMatch(/modules\/ui-mock-reference|ui-mock-reference\/lib\/aurora\/data/)
      expect(text, `${rel} must not call raw service objects`).not.toMatch(/\b(LocalBus|BullMQBus|MeshBus|ConfigManager)\b/)
    }
  })

  it('removes debug dump styling from production route previews', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const scannedFiles = filesUnder(join(repoRoot, 'packages/aurora-ui/src'), /\.(ts|tsx|css)$/)
      .filter((file) => !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(file))

    for (const file of scannedFiles) {
      const rel = relative(repoRoot, file)
      const text = readFileSync(file, 'utf8')
      expect(text, `${rel} must not use legacy JSON dump preview styling`).not.toContain('aui-json-preview')
      expect(text, `${rel} must not render raw preformatted debug dumps`).not.toMatch(/<pre[\s>]/)
      expect(text, `${rel} must not expose debug dashboard copy`).not.toMatch(/debug-dashboard|debug dump/i)
    }
  })

  it('keeps mock-derived mobile tabs in the required id order', () => {
    expect(auroraMobileTabs.map((tab) => tab.id)).toEqual(['assistant', 'mesh', 'settings'])
  })

  it('keeps desktop, tablet, and mobile responsive shell rules explicit', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8')

    expect(css).toContain('.aui-content>* { width:min(100%,112rem);margin-inline:auto }')
    expect(css).toContain('.aui-activity-drawer { display:block }')
    expect(css).toContain('.aui-activity-drawer-panel')
    expect(css).toContain('.aui-content:where(button,.aui-button,.aui-action-chip,input,select,textarea,summary) { min-height:2.6rem }')
    expect(css).toContain('[data-slot="card-footer"]')
    expect(css).toContain('[data-slot="button"]')
    expect(css).toContain('.aui-mesh')
    expect(css).toContain(
      '.aui-onboarding-scroll-viewport { width:100%;height:100vh;height:100dvh;overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch }'
    )
    expect(css).toContain('height: calc(100dvh - max(env(safe-area-inset-top), 1.5rem));')
    expect(css).toContain('margin-top: max(env(safe-area-inset-top), 1.5rem);')
    expect(css).toContain('scroll-padding-bottom: calc(12rem + env(safe-area-inset-bottom));')
    expect(css).toContain('max-height: min(12rem, 32dvh);')
    expect(css).toContain('field-sizing: fixed;')
    expect(css).toContain('.aui-webthin-invite-action {\n    margin-bottom: 0;')
    expect(css).toContain('.aui-assistant-form .aui-route-details-trigger {\n  width:1.75rem;\n  flex:0 0 1.75rem;')
    expect(css).toContain('.aui-chat-workspace {\n    overflow-x:hidden;\n    overscroll-behavior-x:none;')
    expect(css).toContain('.aui-assistant-form {\n    position:relative;\n    bottom:auto;')
    expect(css).toContain('.aui-chat-panel {\n    padding-bottom:0;\n    scroll-padding-bottom:0;')
    expect(css).toContain('.aui-chat-scroller-content[data-slot="message-scroller-content"] {\n    padding-bottom:1.25rem;')
    expect(css).toContain('.aui-composer-toolbar {\n    flex-wrap:nowrap;\n    overflow:hidden;')
    expect(css).toContain('.aui-composer-selectors {\n    flex:1 1 0;\n    max-width:100%;\n    overflow-x:auto;')
    expect(css).toContain('width: min(30rem, min(96vw, var(--aui-chat-width, 30rem)));')
    expect(css).toContain('[data-slot="model-selector-search"] { font-size:1rem }')
    expect(css).toContain('.aui-shell[data-navigation-open="true"] .aui-topbar {\n    z-index: 65;')
    expect(css).toContain('.aui-mobile-menu > button {\n    position: relative;\n    z-index: 50;')
    expect(css).toContain('.aui-content:has(.aui-assistant) {\n    overflow: hidden;\n    padding-bottom: calc(4.1rem + env(safe-area-inset-bottom));')
    expect(css).toContain('.aui-content:has(.aui-assistant) .aui-assistant {\n    min-height: 0;\n    height: 100%;\n    overflow: hidden;\n    padding-bottom: 0;')
    expect(css).toContain('.aui-assistant-grid,\n  .aui-chat-workspace,\n  .aui-chat-panel {\n    min-height: 0;')
    expect(css).toContain('.aui-shell[data-mobile-viewport="true"] {\n    height: var(--aui-visual-viewport-height, 100dvh);')
    expect(css).toContain('.aui-shell[data-virtual-keyboard-open="true"] .aui-mobile-tabs {\n    display: none;')
    expect(css).toContain('.aui-shell[data-virtual-keyboard-open="true"] .aui-content:has(.aui-assistant) {\n    padding-bottom: 0;')
  })

  it('maps capability graph states into disabled routes and repair actions', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => stateMatrixCatalog())
    const snapshot = await buildShellSnapshot(new Aurora({ transport }))

    const services = route(snapshot, 'services')
    const config = route(snapshot, 'settings')
    const tools = route(snapshot, 'tools')
    const memory = route(snapshot, 'memory')

    expect(services.state).toBe('degraded')
    expect(services.disabled).toBe(false)
    expect(config.state).toBe('denied')
    expect(config.disabled).toBe(true)
    expect(config.repairActions.map((action) => action.id)).toContain('grant-permission')
    expect(tools.state).toBe('privacy-blocked')
    expect(tools.repairActions.map((action) => action.id)).toContain('configure-route')
    expect(memory.state).toBe('stale')
    expect(memory.repairActions.map((action) => action.id)).toContain('pair')
  })

  it('keeps local selector-required routes clickable with route-selection UX', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => localSelectorRequiredRouteCatalog())
    const snapshot = await buildShellSnapshot(new Aurora({ transport }))

    const scheduler = route(snapshot, 'scheduler')
    expect(scheduler).toEqual(expect.objectContaining({
      state: 'available-local',
      selectorRequired: true,
      routeable: true,
      disabled: false
    }))
    expect(scheduler.repairActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'configure-route',
        label: 'Choose device',
        disabled: false
      })
    ]))
    expect(scheduler.candidateProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: 'available-local',
        selectable: true,
        requiredAction: 'Choose which approved device should handle this.'
      })
    ]))
  })

  it('does not mark desktop-local RouteMatrix read routes as broad privacy-blocked', () => {
    const graph = buildCapabilityGraph({
      catalog: localSelectorRequiredRouteCatalog(),
      registry: gatewayRegistryFixture,
      transportKind: 'tauri-local'
    })
    const snapshot = snapshotFromGraph('tauri-local', graph, null)
    const localReadRouteIds = ['mesh', 'tokens', 'backups', 'scheduler', 'audit', 'models']
    const localReadRoutes = localReadRouteIds.map((id) => route(snapshot, id))

    for (const localRoute of localReadRoutes) {
      expect(localRoute.state, `${localRoute.item.id} must stay routeable in desktop-local mode`).toBe('available-local')
      expect(localRoute.disabled, `${localRoute.item.id} must stay clickable in desktop-local mode`).toBe(false)
      expect(localRoute.requiresAdminAction, `${localRoute.item.id} is a read route and must not require route-level AdminAction`).toBe(false)
      expect(localRoute.blockers.join(' '), `${localRoute.item.id} must not carry privacy blockers`).not.toMatch(/privacy|consent|indicator/i)
    }

    const scheduler = route(snapshot, 'scheduler')
    expect(scheduler.selectorRequired).toBe(true)
    expect(scheduler.repairActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'configure-route', disabled: false })
    ]))
  })

  it('keeps SDK errors visible as disabled shell state', () => {
    const snapshot = errorShellSnapshot('http', new Error('Gateway unavailable'))

    expect(snapshot.loadState).toBe('error')
    expect(snapshot.routes.every((route) => route.disabled)).toBe(true)
    expect(snapshot.routes.every((route) => route.blockers.includes('sdk_error'))).toBe(true)
    const userFacing = shellRouteCopySurface([
      ...snapshot.routes,
      snapshot.assistantCancellationRoute,
      ...Object.values(snapshot.assistantVoiceRoutes)
    ])
    expect(userFacing).not.toMatch(/runtime|shell|provider|service contract|first-run gate/i)
    expect(findForbiddenProductionCopyTerms(userFacing).map((term) => term.id), userFacing).toEqual([])
  })

  it('keeps internal shell task names out of user-facing route labels and reasons', () => {
    const catalog = cloneFixture(capabilityGraphCatalogFixture)
    catalog.providers = []
    catalog.actions = []
    catalog.provider_index = {}
    catalog.action_index = {}
    const graph = buildCapabilityGraph({
      catalog,
      registry: null,
      transportKind: 'mock'
    })
    const snapshot = snapshotFromGraph('mock', graph, null)
    const hostileRoutes = [
      route(snapshot, 'assistant'),
      route(snapshot, 'onboarding'),
      route(snapshot, 'native'),
      snapshot.assistantVoiceRoutes.transcription
    ]

    expect(hostileRoutes.map((candidate) => candidate.providerLabel)).toEqual([
      'Assistant needs setup',
      'Onboarding needs setup',
      'Device Features needs setup',
      'Remote transcription needs setup'
    ])
    for (const candidate of hostileRoutes) {
      const userFacing = [
        candidate.providerLabel,
        candidate.explanation,
        ...candidate.repairActions.flatMap((action) => [action.label, action.reason]),
        ...candidate.candidateProviders.flatMap((provider) => [
          provider.label,
          provider.reason,
          provider.requiredAction ?? ''
        ])
      ].join(' ')
      expect(userFacing).not.toMatch(/service contract|first-run gate/i)
      expect(findForbiddenProductionCopyTerms(userFacing).map((term) => term.id), userFacing).toEqual([])
    }
  })

  it('sanitizes hostile provider node names before shell data reaches rendered routes', () => {
    const catalog = cloneFixture(capabilityGraphCatalogFixture)
    const provider = catalog.providers.find((candidate) => candidate.provider_id === 'mesh:studio-gpu:Orchestrator')
    const action = catalog.actions.find((candidate) => candidate.action_id === 'assistant-local-external-user-input')
    if (!provider || !action) throw new Error('missing assistant capability fixture')
    provider.node_name = 'runtime provider shell'
    provider.peer_id = 'hostile-runtime-provider'
    action.provider_id = provider.provider_id
    action.provider_kind = provider.provider_kind
    action.peer_id = provider.peer_id
    action.service_instance_id = provider.service_instance_id
    action.selector = { peer_id: provider.peer_id, module: provider.module }
    const graph = buildCapabilityGraph({
      catalog,
      registry: null,
      transportKind: 'mock'
    })
    const snapshot = snapshotFromGraph('mock', graph, null)
    const assistant = route(snapshot, 'assistant')

    expect(assistant.providerLabel).toBe('Connected Aurora device')
    expect(assistant.candidateProviders[0]?.label).toBe('Connected Aurora device')
    const userFacing = shellRouteCopySurface([assistant])
    expect(userFacing).not.toMatch(/runtime provider shell|hostile-runtime-provider/i)
    expect(findForbiddenProductionCopyTerms(userFacing).map((term) => term.id), userFacing).toEqual([])
  })

  it('builds model runtime provider state from SDK catalog, capability graph, and native status', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      transportKind: 'mock'
    })
    const model = buildModelsViewModel({
      catalog: modelRuntimeCatalogFixture,
      graph,
      nativeManifest: null,
      loadState: 'ready'
    })

    expect(model.providerCount).toBe(4)
    expect(model.selectedProviderId).toBe('local:Orchestrator:llama-cpp')
    expect(model.remoteCount).toBe(2)
    expect(model.categoryRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Currently selected source',
        value: 'llama.cpp desktop'
      }),
      expect.objectContaining({
        label: 'Configured sources',
        value: '4 configured'
      }),
      expect.objectContaining({
        label: 'Installed local models',
        value: '1 installed',
        detail: expect.stringContaining('llama-3-8b-instruct.Q4_K_M.gguf')
      }),
      expect.objectContaining({
        label: 'Downloadable/importable models',
        value: '0 active operations',
        detail: expect.stringContaining('No import or download is active')
      }),
      expect.objectContaining({
        label: 'Benchmarkable sources',
        value: '2 with benchmark status'
      }),
      expect.objectContaining({
        label: 'Connected or cloud sources',
        value: '2 remote-capable'
      }),
      expect.objectContaining({
        label: 'Mobile local-light availability',
        value: 'unsupported'
      })
    ]))
    expect(model.providers.find((provider) => provider.id === 'local:Orchestrator:llama-cpp')).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        canSelect: false,
        selectReason: expect.stringContaining('Selected source is reported by Aurora'),
        privacyClass: 'public',
        routeQuality: expect.stringContaining('local; available-local; routeable from catalog status'),
        latencyContext: expect.stringContaining('1200 ms latency; 8192 token context; 2048 token generation limit'),
        modelIdentity: expect.stringContaining('llama-3-8b-instruct; local-filesystem; user-provided')
      })
    )
    expect(model.providers.find((provider) => provider.id === 'mesh:studio-gpu:Orchestrator')).toEqual(
      expect.objectContaining({
        availability: 'available-remote',
        canSelect: false,
        selectReason: expect.stringContaining('Only local executable sources can be selected'),
        providerType: 'mesh',
        routeLabel: 'Connected device',
        routeQuality: expect.stringContaining('mesh remote; available-remote')
      })
    )
    expect(model.providers.find((provider) => provider.id === 'cloud:openai:Orchestrator')).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        privacyClass: 'sensitive',
        canBenchmark: false
      })
    )
    expect(model.providers.find((provider) => provider.id === 'native:mobile-local-light')).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        canSelect: false,
        blockers: expect.arrayContaining(['This model source needs review before it can be used.'])
      })
    )
    expect(model.mobileLocalLightState).toBe('unsupported')

    const nativeModel = buildModelsViewModel({
      catalog: modelRuntimeCatalogFixture,
      graph,
      nativeManifest: androidNativeCapabilityManifestFixture,
      loadState: 'ready'
    })
    expect(nativeModel.providers.find((provider) => provider.id === 'native:mobile-local-light')).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        routeLabel: 'Available on this device',
        blockers: expect.arrayContaining(['Native mobile model source needs attention.'])
      })
    )
    expect(nativeModel.mobileLocalLightState).toBe('degraded')
    expect(nativeModel.mobileLocalLightReason).toBe('Native mobile model source needs attention.')
  })

  it('marks an unselected executable local model provider selectable through admin approval status', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      transportKind: 'mock'
    })
    const catalog = cloneFixture(modelRuntimeCatalogFixture)
    catalog.selected_provider_id = 'cloud:openai:Orchestrator'
    catalog.providers = catalog.providers.map((provider) => ({
      ...provider,
      selected: provider.provider_id === 'cloud:openai:Orchestrator'
    }))

    const model = buildModelsViewModel({
      catalog,
      graph,
      nativeManifest: null,
      loadState: 'ready'
    })

    expect(model.providers.find((provider) => provider.id === 'local:Orchestrator:llama-cpp')).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerType: 'local',
        selected: false,
        canSelect: true,
        selectConfigValue: 'llama_cpp',
        selectReason: expect.stringContaining('admin approval')
      })
    )
    expect(model.providers.find((provider) => provider.id === 'mesh:studio-gpu:Orchestrator')).toEqual(
      expect.objectContaining({
        canSelect: false,
        selectReason: expect.stringContaining('Only local executable sources can be selected')
      })
    )
    expect(model.providers.find((provider) => provider.id === 'native:mobile-local-light')).toEqual(
      expect.objectContaining({
        canSelect: false,
        selectReason: expect.stringContaining('Only local executable sources can be selected')
      })
    )
  })

  it('renders settings, privacy defaults, native permissions, and AdminAction state from SDK status', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const model = buildSettingsPermissionsModel(snapshot)

    expect(model.loadState).toBe('ready')
    expect(model.privacyControls.map((control) => control.id)).toEqual([
      'prefer-local',
      'explicit-selector',
      'block-explicit-fallback'
    ])
    expect(model.privacyControls.some((control) => control.requiresAdminAction)).toBe(true)
    expect(model.voiceBehavior.map((item) => item.id)).toEqual(['push-to-talk', 'wake-mode', 'spoken-replies'])
    expect(model.nativePermissions.length).toBeGreaterThan(0)
    expect(model.nativePermissions.some((permission) => permission.state === 'privacy-blocked')).toBe(true)
    expect(model.routeDefaults.map((item) => item.id)).toContain('denied-routes')
  })

  it('renders iOS App Intents as app-owned Shortcuts integration without claiming system assistant ownership', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Native.GetCapabilityManifest', () => iosNativeCapabilityManifestFixture)
    const snapshot = await buildShellSnapshot(new Aurora({ transport }))
    const model = buildSettingsPermissionsModel(snapshot)

    expect(snapshot.nativePlatform).toBe('ios')
    expect(model.nativeIntegrations.map((integration) => integration.id)).toEqual([
      'askAuroraAppIntent',
      'askAuroraShortcut',
      'summarizeSharedContentShortcut',
      'stopAuroraSpeechAppIntent',
      'shareExtension',
      'deepLinks',
      'widgets',
      'fileAssociations',
      'iosLocalLightInference',
      'siriReplacement'
    ])
    expect(model.nativeIntegrations.find((integration) => integration.id === 'askAuroraAppIntent')).toEqual(
      expect.objectContaining({
        state: 'degraded',
        backendMethod: 'Orchestrator.ExternalUserInput',
        invocation: 'app-intent',
        siriReplacement: false
      })
    )
    expect(model.nativeIntegrations.find((integration) => integration.id === 'summarizeSharedContentShortcut')).toEqual(
      expect.objectContaining({
        state: 'degraded',
        privacyClass: 'sensitive',
        requiresConfirmation: true
      })
    )
    expect(model.nativeIntegrations.find((integration) => integration.id === 'shareExtension')).toEqual(
      expect.objectContaining({
        state: 'pending',
        privacyClass: 'sensitive',
        requiresConfirmation: true
      })
    )
    expect(model.nativeIntegrations.find((integration) => integration.id === 'widgets')).toEqual(
      expect.objectContaining({
        state: 'pending',
        privacyClass: 'personal',
        requiresConfirmation: false
      })
    )
    expect(model.nativeIntegrations.find((integration) => integration.id === 'fileAssociations')).toEqual(
      expect.objectContaining({
        state: 'pending',
        privacyClass: 'sensitive',
        requiresConfirmation: true
      })
    )
    expect(model.nativeIntegrations.find((integration) => integration.id === 'siriReplacement')).toEqual(
      expect.objectContaining({
        state: 'unsupported',
        siriReplacement: false
      })
    )
  })

  it('maps settings state matrix for denied, degraded, native-unavailable, optimistic and rollback/error states', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => stateMatrixCatalog())
    transport.register('Native.GetCapabilityManifest', () => ({
      platform: 'android',
      permissions: {
        'aurora.microphone': false,
        'aurora.notifications': true
      },
      capabilities: {
        'aurora.microphone': false,
        'aurora.notifications': true
      }
    }))
    const snapshot = await buildShellSnapshot(new Aurora({ transport }))
    Object.assign(route(snapshot, 'settings'), {
      state: 'available-local',
      disabled: false,
      requiresAdminAction: false,
      blockers: [],
      providerLabel: 'local / Config.Get'
    })
    Object.assign(route(snapshot, 'assistant'), {
      state: 'available-remote',
      disabled: false,
      providerLabel: 'remote:studio / Orchestrator.ExternalUserInput'
    })
    const model = buildSettingsPermissionsModel(snapshot)

    expect(model.routeDefaults.find((item) => item.id === 'degraded-fallback')?.state).toBe('degraded')
    expect(model.routeDefaults.find((item) => item.id === 'denied-routes')?.state).toBe('privacy-blocked')
    expect(model.privacyControls.map((control) => control.mutationState)).toContain('optimistic')
    expect(model.privacyControls.map((control) => control.mutationState)).toContain('rollback-error')
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.microphone')?.state).toBe('privacy-blocked')
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.notifications')?.state).toBe('available-local')
  })

  it('renders Android local-light inference as a degraded native provider in settings', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: androidNativeCapabilityManifestFixture,
      transportKind: 'native-mobile'
    })
    const snapshot = snapshotFromGraph('native-mobile', graph, androidNativeCapabilityManifestFixture)
    const model = buildSettingsPermissionsModel(snapshot)
    const localLight = model.nativePermissions.find((permission) => permission.id === 'aurora.android.localLightInference')

    expect(localLight).toEqual(
      expect.objectContaining({
        state: 'degraded',
        granted: false,
        requestEnabled: false
      })
    )
  })

  it('renders Android assistant role qualification and fallback entrypoints from native manifest status', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: androidNativeCapabilityManifestFixture,
      transportKind: 'native-mobile'
    })
    const snapshot = snapshotFromGraph('native-mobile', graph, androidNativeCapabilityManifestFixture)
    const model = buildSettingsPermissionsModel(snapshot)

    const assistantRole = model.nativePermissions.find((permission) => permission.id === 'android.assistantRole')
    const notificationFallback = model.nativePermissions.find((permission) => permission.id === 'android.fallback.notification')
    const foregroundVoiceFallback = model.nativePermissions.find((permission) => permission.id === 'android.fallback.foreground_voice_controls')

    expect(snapshot.nativePlatform).toBe('android')
    expect(assistantRole).toEqual(expect.objectContaining({
      state: 'privacy-blocked',
      requestEnabled: true,
      capabilityEnabled: true,
      blockers: expect.arrayContaining(['assistant_role_user_grant_required'])
    }))
    expect(notificationFallback).toEqual(expect.objectContaining({
      state: 'privacy-blocked',
      granted: false
    }))
    expect(foregroundVoiceFallback).toEqual(expect.objectContaining({
      state: 'privacy-blocked',
      granted: false
    }))
  })

  it('renders iOS native integration states and no-Siri-replacement limits in settings', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: iosNativeCapabilityManifestFixture,
      transportKind: 'native-mobile'
    })
    const snapshot = snapshotFromGraph('native-mobile', graph, iosNativeCapabilityManifestFixture)
    const model = buildSettingsPermissionsModel(snapshot)

    expect(model.nativeIntegrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'shareExtension', state: 'pending' }),
        expect.objectContaining({ id: 'widgets', state: 'pending' }),
        expect.objectContaining({ id: 'fileAssociations', state: 'pending' }),
        expect.objectContaining({ id: 'iosLocalLightInference', state: 'degraded' }),
        expect.objectContaining({ id: 'siriReplacement', state: 'unsupported' })
      ])
    )
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.iosLocalLightInference')).toEqual(
      expect.objectContaining({
        state: 'degraded',
        label: 'iOS Local Light Inference',
        detail: 'Local iOS models need a supported device and an available model before selection.'
      })
    )
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.iosMicrophoneCapture')).toEqual(
      expect.objectContaining({
        state: 'privacy-blocked',
        label: 'iOS microphone capture',
        detail: expect.stringContaining('microphone access')
      })
    )
    expect(model.nativePermissions.find((permission) => permission.id === 'ios.backgroundVoice')).toEqual(
      expect.objectContaining({
        state: 'unsupported',
        blockers: ['ios_background_voice_limited']
      })
    )
    expect(model.nativePermissions.find((permission) => permission.id === 'ios.appOwnedInvocation')).toEqual(
      expect.objectContaining({
        state: 'privacy-blocked',
        detail: 'iOS can start Aurora actions from Siri, Shortcuts, widgets, the share sheet, and links.'
      })
    )
    expect(model.nativeLimitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'noSiriReplacement',
          detail: 'iOS does not allow Aurora to become the default assistant.'
        })
      ])
    )
  })

  it('renders iOS Siri/Shortcuts/App Intents integration and preflight status from the native manifest', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Native.GetCapabilityManifest', () => iosNativeCapabilityManifestFixture)
    const snapshot = await buildShellSnapshot(new Aurora({ transport }))
    const model = buildSettingsPermissionsModel(snapshot)

    expect(snapshot.nativePlatform).toBe('ios')
    expect(model.nativePlatformIntegrations.map((integration) => integration.id)).toContain('ios-app-intents')
    expect(model.nativeReleaseGates.map((gate) => gate.id)).toContain('app-store-connect-signing')
    expect(model.nativeDeviceMatrix.map((row) => row.id)).toContain('ios-device-current')
  })

  it('does not count routeable local selector preferences as hard-blocked settings routes', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    for (const candidate of snapshot.routes) {
      Object.assign(candidate, {
        state: 'available-local' as const,
        disabled: false,
        routeable: true,
        selectorRequired: false,
        blockers: [],
        evidenceSources: ['controlled local route status']
      })
    }
    Object.assign(route(snapshot, 'tools'), {
      selectorRequired: true,
      explanation: 'Local provider selector is a preference, not a hard privacy blocker.',
      blockers: ['selector_preference_missing'],
      repairActions: []
    })

    const model = buildSettingsPermissionsModel(snapshot)
    const explicitSelector = model.privacyControls.find((control) => control.id === 'explicit-selector')
    const hardFallback = model.privacyControls.find((control) => control.id === 'block-explicit-fallback')
    const deniedRoutes = model.routeDefaults.find((item) => item.id === 'denied-routes')

    expect(explicitSelector).toEqual(expect.objectContaining({
      state: 'degraded',
      providerLabel: '1 choices need review',
      enabled: true
    }))
    expect(hardFallback).toEqual(expect.objectContaining({
      state: 'available-local',
      providerLabel: 'No blocked choices'
    }))
    expect(deniedRoutes).toEqual(expect.objectContaining({
      state: 'available-local',
      value: '0'
    }))
  })

  it('keeps settings screen honest for SDK errors and empty native manifests', () => {
    const snapshot = errorShellSnapshot('http', new Error('Gateway unavailable'))
    const model = buildSettingsPermissionsModel(snapshot)

    expect(model.error).toBe('Could not connect to this Aurora device. Try again.')
    expect(model.nativePermissions).toEqual([])
    expect(model.privacyControls.every((control) => control.disabled)).toBe(true)
  })

  it('renders iOS Keychain, biometric admin unlock, and Siri limitation copy from native manifest status', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Native.GetCapabilityManifest', () => ({
      platform: 'ios',
      permissions: {
        'aurora.iosKeychain': true,
        'aurora.iosBiometricUnlock': true
      },
      capabilities: {
        'ios.keychain.secureCredentialStorage': true,
        'ios.biometric.adminUnlock': true,
        'ios.appIntents': true,
        'ios.shortcuts': true,
        'ios.shareExtension': true,
        'ios.widgets': true,
        'ios.deepLinks': true,
        'ios.siriReplacement': false
      }
    }))
    const snapshot = await buildShellSnapshot(new Aurora({ transport }))
    const model = buildSettingsPermissionsModel(snapshot)

    expect(snapshot.nativePlatform).toBe('ios')
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.iosKeychain')).toEqual(
      expect.objectContaining({ state: 'available-local', label: 'iOS Keychain' })
    )
    expect(model.nativePermissions.find((permission) => permission.id === 'ios.siriReplacement')).toEqual(
      expect.objectContaining({ state: 'unsupported', label: 'System assistant role' })
    )
  })

  it('warns before private remote fallback and keeps raw audio plus tool payloads redacted', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const privateRemoteRoute = enabledRoute(route(snapshot, 'assistant'), {
      state: 'available-remote',
      providerLabel: `mesh peer / ${ORCHESTRATOR_METHODS.externalUserInput}`,
      explanation: 'Remote mesh fallback is eligible after route policy review.',
      selectorRequired: true,
      item: {
        ...route(snapshot, 'assistant').item,
        privacyClass: 'sensitive'
      }
    })
    const warning = assistantRemotePrivacyWarning(privateRemoteRoute)

    expect(warning).toContain('Sensitive data needs privacy review before another device can help')
    expect(warning).not.toMatch(/\b(remote|mesh|fallback|route\/privacy)\b/i)
    expect(assistantRemotePrivacyWarning(enabledRoute(route(snapshot, 'assistant'), {
      item: { ...route(snapshot, 'assistant').item, privacyClass: 'public' }
    }))).toBeNull()

    const assistantSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/assistant-view.tsx'), 'utf8')
    const renderStringifyLines = assistantSource
      .split('\n')
      .filter((line) => line.includes('JSON.stringify') && !line.includes('localStorage.setItem'))
    expect(renderStringifyLines).toEqual([
      expect.stringContaining('new TextEncoder().encode(JSON.stringify({'),
      expect.stringContaining('new TextEncoder().encode(JSON.stringify({'),
      expect.stringContaining('JSON.stringify(value)'),
    ])
    expect(renderStringifyLines.join('\n')).not.toMatch(/tool\.(payloadPreview|errorDetails|resultPreview)/)
  })

  it('maps assistant SDK error codes to user-facing messages', () => {
    expect(assistantErrorMessage(new AuroraError({ code: 'timeout', message: 'timed out' }))).toContain('timed out')
    expect(assistantErrorMessage(new AuroraError({ code: 'auth', message: '401 Unauthorized' }))).toContain('Review access')
    expect(assistantErrorMessage(new AuroraError({ code: 'transport_loss', message: 'Gateway offline' }))).toContain('interrupted before Aurora finished')
  })

  it('locks assistant backend integration boundaries for send, stream fallback, cancellation, voice, and context', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog())
    transport.register('Native.GetCapabilityManifest', () => ({
      platform: 'tauri-desktop',
      permissions: { microphone: true },
      capabilities: { voiceCapture: true }
    }))
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)
    const assistantRoute = enabledRoute(route(snapshot, 'assistant'), {
      providerLabel: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`
    })
    if (!snapshot.assistantCancellationRoute) throw new Error('missing assistant cancellation route')
    const cancellationRoute = {
      ...snapshot.assistantCancellationRoute,
      state: 'available-local' as const,
      disabled: false,
      providerLabel: `local / ${ORCHESTRATOR_METHODS.interrupt}`,
      blockers: [],
      routeable: true
    }

    expect(`${assistantRoute.item.capabilityModule}.${assistantRoute.item.capabilityMethod}`).toBe(ORCHESTRATOR_METHODS.externalUserInput)
    expect(`${cancellationRoute.item.capabilityModule}.${cancellationRoute.item.capabilityMethod}`).toBe(ORCHESTRATOR_METHODS.interrupt)
    expect(Object.values(auroraAssistantVoiceItems).map((item) => `${item.capabilityModule}.${item.capabilityMethod}`)).toEqual([
      'Transcription.Transcribe',
      'WakeWord.ProcessAudio',
      'WakeWord.Control',
      'TTS.Synthesize',
      'TTS.Stop'
    ])

    const controls = assistantControlsForRoute(assistantRoute, cancellationRoute, true)
    expect(controls).toEqual(expect.objectContaining({
      canSend: false,
      canCancel: true,
      cancelReason: 'Stop is available for this response.'
    }))

    const pendingMessage = {
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Waiting for Aurora...',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const,
      modelLabel: 'gpt-4o',
      providerLabel: 'OpenAI',
      routeLabel: 'local / Orchestrator.ExternalUserInput'
    }
    expect(applyAssistantTerminalUpdate(pendingMessage, {
      ...streamUpdate('Final fallback response'),
      kind: 'fallback' as const,
      eventId: 'fallback-event-1',
      messageId: 'assistant-pending',
      text: 'Final fallback response',
      textDelta: 'Final fallback response'
    })).toEqual(expect.objectContaining({
      id: 'assistant-pending',
      text: 'Final fallback response',
      status: 'sent',
      modelLabel: 'gpt-4o',
      providerLabel: 'OpenAI'
    }))

    expect(applyAssistantTerminalUpdate(pendingMessage, {
      ...streamUpdate('Final streamed response'),
      kind: 'completed' as const,
      messageId: 'backend-message-id',
      text: 'Final streamed response',
      textDelta: ''
    }).id).toBe('assistant-pending')

    const contextItem = attachmentToContextItem({
      id: 'context-text-1',
      kind: 'text',
      label: 'Shared incident note',
      detail: 'operator pasted text',
      contentText: 'Gateway is healthy; summarize recent mesh handoffs.',
      url: null,
      filename: null,
      mimeType: 'text/plain',
      sizeBytes: 54,
      sourceChannel: 'chat',
      sourceDisplayName: 'chat composer',
      privacyClass: 'personal',
      status: 'staged',
      progress: 0,
      message: 'Staged for backend validation.',
      reasonCode: null,
      redacted: false
    })
    expect(contextItem).toEqual(expect.objectContaining({
      kind: 'text',
      content_text: 'Gateway is healthy; summarize recent mesh handoffs.',
      source: expect.objectContaining({ channel: 'chat', display_name: 'chat composer' }),
      metadata: expect.objectContaining({ route_privacy_class: 'personal', ui_status: 'staged' })
    }))

    const voiceModel = buildAssistantVoiceModel({
      client,
      route: assistantRoute,
      voiceRoutes: snapshot.assistantVoiceRoutes,
      nativeAvailable: snapshot.nativeAvailable,
      nativePlatform: snapshot.nativePlatform,
      nativePermissions: snapshot.nativePermissions,
      nativeCapabilities: snapshot.nativeCapabilities,
      captureStatus: 'listening',
      consentGranted: true,
      voiceEvents: voiceStatusEvents()
    })
    expect(voiceModel.controls.map((control) => control.label)).toEqual(expect.arrayContaining([
      'Start speech capture',
      'Wake foreground',
      'Synthesize speech',
      'Stop playback'
    ]))
    expect(voiceModel.events.map((event) => event.id)).toEqual(expect.arrayContaining(['partial', 'final', 'tts-started', 'remote-denied']))
  })

  it('routes the backups view as an enabled non-disabled surface', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const backups = route(snapshot, 'backups')

    expect(backups.disabled).toBe(false)
  })

  it('maps backup SDK error codes to user-facing messages', () => {
    expect(backupErrorMessage(new AuroraError({ code: 'permission', message: 'denied' }))).toContain('Permission is needed')
    expect(backupErrorMessage(new AuroraError({ code: 'unavailable_service', message: 'missing' }))).toContain('cannot use that feature yet')
    expect(backupErrorMessage(new AuroraError({ code: 'transport_loss', message: 'lost' }))).toContain('Connection lost')
  })

  it('builds assistant voice routes from capability graph and native manifest status', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog())
    transport.register('Native.GetCapabilityManifest', () => ({
      platform: 'tauri-desktop',
      permissions: { microphone: true },
      capabilities: { voiceCapture: true }
    }))
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)

    expect(snapshot.assistantVoiceRoutes.transcription.state).toBe('available-local')
    expect(snapshot.assistantVoiceRoutes.ttsSynthesize.state).toBe('available-remote')
    expect(snapshot.assistantVoiceRoutes.wakeControl.state).toBe('available-local')

    const model = buildAssistantVoiceModel({
      client,
      route: enabledRoute(route(snapshot, 'assistant')),
      voiceRoutes: snapshot.assistantVoiceRoutes,
      nativeAvailable: snapshot.nativeAvailable,
      nativePlatform: snapshot.nativePlatform,
      nativePermissions: snapshot.nativePermissions,
      nativeCapabilities: snapshot.nativeCapabilities,
      captureStatus: 'listening',
      consentGranted: true
    })

    expect(model.chips.find((chip) => chip.id === 'native-capture')?.state).toBe('available-local')
    expect(model.chips.find((chip) => chip.id === 'remote-processing')?.state).toBe('available-local')
    expect(model.transcriptionRoute.item.capabilityMethod).toBe('Transcribe')
    expect(model.transcriptionRoute.state).toBe('available-local')
    expect(model.remoteAudioRoute.item.capabilityMethod).toBe('Transcribe')
    expect(model.remoteAudioRoute.state).toBe('available-local')
    expect(model.speechRoute.item.capabilityMethod).toBe('Synthesize')
    expect(model.speechRoute.state).toBe('available-remote')
    expect(model.controls.find((control) => control.id === 'remote-transcription')?.reason).toContain('Audio can start')
    expect(model.events.map((event) => event.id)).toEqual(expect.arrayContaining(['partial', 'final', 'timeout', 'cancelled', 'remote-denied', 'peer-disconnect']))

    const eventDrivenModel = buildAssistantVoiceModel({
      client,
      route: enabledRoute(route(snapshot, 'assistant')),
      voiceRoutes: snapshot.assistantVoiceRoutes,
      nativeAvailable: snapshot.nativeAvailable,
      nativePlatform: snapshot.nativePlatform,
      nativePermissions: snapshot.nativePermissions,
      nativeCapabilities: snapshot.nativeCapabilities,
      captureStatus: 'listening',
      consentGranted: true,
      voiceEvents: voiceStatusEvents()
    })

    expect(eventDrivenModel.events.find((event) => event.id === 'partial')).toEqual(expect.objectContaining({
      state: 'available-local',
      detail: 'Aurora is hearing speech.'
    }))
    expect(eventDrivenModel.events.find((event) => event.id === 'final')?.detail).toBe('Aurora received the final speech text.')
    expect(eventDrivenModel.events.find((event) => event.id === 'tts-started')).toEqual(expect.objectContaining({
      state: 'available-local',
      detail: 'Aurora started speaking.'
    }))
    expect(eventDrivenModel.events.find((event) => event.id === 'remote-denied')).toEqual(expect.objectContaining({
      state: 'denied',
      detail: 'Voice needs attention before it can continue.'
    }))
  })

  it('keeps remote STT consent-gated, denial visible, and revoked consent blocking dispatch', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog('remote-stt'))
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)
    const assistantRoute = enabledRoute(route(snapshot, 'assistant'))

    const noConsent = buildAssistantVoiceModel({
      client,
      route: assistantRoute,
      voiceRoutes: snapshot.assistantVoiceRoutes,
      captureStatus: 'listening',
      consentGranted: false
    })
    expect(noConsent.controls.find((control) => control.id === 'remote-transcription')?.state).toBe('privacy-blocked')
    expect(noConsent.controls.find((control) => control.id === 'remote-transcription')?.reason).toContain('Grant session consent')

    const granted = buildAssistantVoiceModel({
      client,
      route: assistantRoute,
      voiceRoutes: snapshot.assistantVoiceRoutes,
      captureStatus: 'listening',
      consentGranted: true
    })
    expect(granted.sessionTtl).toBe('current UI session')

    const revoked = buildAssistantVoiceModel({
      client,
      route: assistantRoute,
      voiceRoutes: snapshot.assistantVoiceRoutes,
      captureStatus: 'listening',
      consentGranted: false
    })
    expect(revoked.sessionTtl).toBe('consent not granted')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog('remote-denied'))
    const deniedSnapshot = await buildShellSnapshot(new Aurora({ transport: deniedTransport }))
    expect(deniedSnapshot.assistantVoiceRoutes.transcription.state).toBe('denied')
  })

  it('covers peer disconnect, local permission loss, and mobile foreground-only voice limits', async () => {
    const staleTransport = new MockAuroraTransport()
    staleTransport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog('stale-remote'))
    const staleClient = new Aurora({ transport: staleTransport })
    const staleSnapshot = await buildShellSnapshot(staleClient)
    const staleModel = buildAssistantVoiceModel({
      client: staleClient,
      route: enabledRoute(route(staleSnapshot, 'assistant')),
      voiceRoutes: staleSnapshot.assistantVoiceRoutes,
      captureStatus: 'permission-denied',
      consentGranted: true
    })

    expect(staleSnapshot.assistantVoiceRoutes.transcription.state).toBe('stale')
    expect(staleModel.events.find((event) => event.id === 'peer-disconnect')?.state).toBe('stale')
    expect(staleModel.events.find((event) => event.id === 'permission-loss')?.state).toBe('denied')

    const mobileTransport = new MockAuroraTransport()
    mobileTransport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog())
    mobileTransport.register('Native.GetCapabilityManifest', () => ({
      platform: 'ios',
      permissions: { microphone: false },
      capabilities: { voiceCapture: false }
    }))
    const mobileClient = new Aurora({ transport: mobileTransport })
    const mobileSnapshot = await buildShellSnapshot(mobileClient)
    const mobileModel = buildAssistantVoiceModel({
      client: mobileClient,
      route: enabledRoute(route(mobileSnapshot, 'assistant')),
      voiceRoutes: mobileSnapshot.assistantVoiceRoutes,
      nativeAvailable: mobileSnapshot.nativeAvailable,
      nativePlatform: mobileSnapshot.nativePlatform,
      nativePermissions: mobileSnapshot.nativePermissions,
      nativeCapabilities: mobileSnapshot.nativeCapabilities,
      captureStatus: 'idle',
      consentGranted: false
    })

    expect(mobileModel.chips.find((chip) => chip.id === 'native-capture')?.state).toBe('privacy-blocked')
    expect(mobileModel.chips.find((chip) => chip.id === 'wake')?.detail).toContain('only while Aurora is open')
  })

  it('renders iOS permission copy as Siri Shortcuts App Intents integration without replacement claims', async () => {
    const mobileTransport = new MockAuroraTransport()
    mobileTransport.register('Native.GetCapabilityManifest', () => ({
      platform: 'ios',
      permissions: {
        'aurora.iosAppIntents': true,
        'aurora.iosShortcuts': true,
        'aurora.iosSiriReplacement': false
      },
      capabilities: {
        'ios.appIntents': true,
        'ios.shortcuts': true,
        'ios.siriReplacement': false
      }
    }))
    const mobileClient = new Aurora({ transport: mobileTransport })
    const snapshot = await buildShellSnapshot(mobileClient)
    const settings = buildSettingsPermissionsModel(snapshot)
    const onboarding = buildOnboardingViewModel({ client: mobileClient, snapshot, selectedModeId: 'make-this-device-available' })

    expect(settings.nativePermissions.map((permission) => permission.label)).toEqual(
      expect.arrayContaining(['iOS App Intents', 'iOS Shortcuts', 'iOS System Assistant Role'])
    )
    expect(settings.nativePermissions.find((permission) => permission.label === 'iOS System Assistant Role')?.state).toBe('unsupported')
    const iosMode = onboarding.modes.find((mode) => mode.id === 'make-this-device-available')
    expect(iosMode?.repair).toContain('iOS shortcuts')
    expect(iosMode?.repair).toContain('Aurora-owned surfaces')
    expect(iosMode?.repair).not.toContain('Siri replacement')
  })

  it('keeps Connect to Aurora available for native Android thin clients', async () => {
    const mobileTransport = new MockAuroraTransport()
    Object.defineProperty(mobileTransport, 'kind', { value: 'tauri-local' })
    mobileTransport.register('Native.GetCapabilityManifest', () => androidNativeCapabilityManifestFixture)
    const mobileClient = new Aurora({ transport: mobileTransport })
    const snapshot = await buildShellSnapshot(mobileClient)
    const connectMode = buildOnboardingViewModel({ client: mobileClient, snapshot }).modes.find((mode) => mode.id === 'connect-to-aurora')

    expect(snapshot.nativePlatform).toBe('android')
    expect(connectMode?.state).toBe('available-remote')
    expect(connectMode?.disabled).toBe(false)
  })

  it('uses packaged Android capability evidence when the active mesh peer has no native manifest', async () => {
    const remoteMeshTransport = new MockAuroraTransport()
    Object.defineProperty(remoteMeshTransport, 'kind', { value: 'mesh' })
    remoteMeshTransport.register('Native.GetCapabilityManifest', () => {
      throw new Error('The connected server does not expose device-local Android features')
    })
    const mobileClient = new Aurora({ transport: remoteMeshTransport })

    const snapshot = await buildShellSnapshot(mobileClient, {
      nativeManifest: async () => androidNativeCapabilityManifestFixture,
    })
    const makeAvailableMode = buildOnboardingViewModel({
      client: mobileClient,
      snapshot,
      selectedModeId: 'make-this-device-available',
    }).modes.find((mode) => mode.id === 'make-this-device-available')

    expect(snapshot.nativePlatform).toBe('android')
    expect(snapshot.nativeAvailable).toBe(true)
    expect(makeAvailableMode?.state).toBe('available-local')
    expect(makeAvailableMode?.disabled).toBe(false)
  })

  it('maps assistant attachment drafts to backend context payloads and statuses', () => {
    const item = attachmentToContextItem({
      id: 'context-1',
      kind: 'url',
      label: 'docs.example',
      detail: 'https://docs.example/context',
      contentText: null,
      url: 'https://docs.example/context',
      filename: null,
      mimeType: 'text/uri-list',
      sizeBytes: 28,
      sourceChannel: 'mobile_share_sheet',
      sourceDisplayName: 'mobile share sheet',
      privacyClass: 'sensitive',
      status: 'staged',
      progress: 0,
      message: 'Staged for backend validation.',
      reasonCode: null,
      redacted: false
    })

    expect(item).toEqual(
      expect.objectContaining({
        kind: 'url',
        url: 'https://docs.example/context',
        title: 'docs.example',
        source: expect.objectContaining({
          channel: 'mobile_share_sheet',
          display_name: 'mobile share sheet'
        }),
        metadata: expect.objectContaining({
          ui_status: 'staged',
          route_privacy_class: 'sensitive'
        })
      })
    )
    expect(attachmentStatusFromBackend('accepted')).toBe('accepted')
    expect(attachmentStatusFromBackend('stored')).toBe('stored')
    expect(attachmentStatusFromBackend('redacted')).toBe('redacted')
    expect(attachmentStatusFromBackend('unsupported')).toBe('unsupported')
    expect(attachmentStatusFromBackend('rejected')).toBe('rejected')
    expect(isAcceptedContextStatus('accepted')).toBe(true)
    expect(isAcceptedContextStatus('unsupported')).toBe(false)
  })

  it('maps production context ingest item ids back to pending attachments', () => {
    const outcomes = mapContextIngestOutcomesByPendingIndex({
      accepted_items: [
        {
          item_id: 'context-0-abc123def456',
          kind: 'url',
          status: 'accepted',
          storage_policy: 'ephemeral',
          privacy_class: 'personal',
          accepted_bytes: 64,
          stored_namespace: null,
          stored_key: null,
          redacted: false,
          redaction_reasons: [],
          reason_code: null,
          message: 'URL accepted'
        }
      ],
      rejected_items: [
        {
          item_id: 'context-1-fedcba654321',
          kind: 'image',
          status: 'unsupported',
          storage_policy: 'ephemeral',
          privacy_class: 'personal',
          accepted_bytes: 0,
          stored_namespace: null,
          stored_key: null,
          redacted: false,
          redaction_reasons: [],
          reason_code: 'unsupported_type',
          message: 'Images are not supported by this route.'
        }
      ]
    })

    expect(contextIngestOutcomeIndex('context-0-abc123def456')).toBe(0)
    expect(contextIngestOutcomeIndex('context-1-fedcba654321')).toBe(1)
    expect(contextIngestOutcomeIndex('mock-context-2')).toBe(2)
    expect(contextIngestOutcomeIndex('context-abc123def456')).toBeNull()
    expect(outcomes.get(0)?.status).toBe('accepted')
    expect(outcomes.get(1)?.status).toBe('unsupported')
    expect(outcomes.get(1)?.reason_code).toBe('unsupported_type')
  })

  it('renders onboarding modes, endpoint validation, login, pairing, and fallback states from SDK status', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const model = buildOnboardingViewModel({ client, snapshot })

    expect(model.modes.map((mode) => mode.id)).toEqual([
      'connect-to-aurora',
      'make-this-device-available'
    ])
    expect(model.modes.find((mode) => mode.id === 'connect-to-aurora')).toEqual(
      expect.objectContaining({
        state: 'degraded',
        evidence: 'Local preview'
      })
    )
    expect(model.modes.find((mode) => mode.id === 'make-this-device-available')?.repair).toContain('Open setup')
    expect(model.setupSteps.every((step) => step.repair.length > 0)).toBe(true)
  })

  it('keeps onboarding bearer tokens out of browser storage', () => {
    const source = readFileSync(
      join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'packages/aurora-ui/src/onboarding-view.tsx'),
      'utf8'
    )

    expect(source).not.toMatch(/\b(localStorage|sessionStorage)\b/)
    expect(source).toContain("const [token, setToken] = useState('')")
  })

  it('maps auth session matrix into onboarding availability without inventing success', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)

    expect(buildOnboardingViewModel({ client, snapshot }).authState).toBe('pending')

    client.auth.updateFromLogin({
      user_id: 'admin-1',
      username: 'admin',
      permissions: ['Gateway.use'],
      effective_perms: ['Gateway.use'],
      is_admin: false
    })
    expect(buildOnboardingViewModel({ client, snapshot }).authState).toBe('available-local')

    client.auth.expire('Token expired')
    const expired = buildOnboardingViewModel({ client, snapshot })
    expect(expired.authState).toBe('denied')
    expect(expired.authExplanation).toContain('Token expired')

    client.auth.updateFromTokenValidation({ valid: true, source: 'auth_disabled', permissions: ['*'], effective_perms: ['*'] })
    const system = buildOnboardingViewModel({ client, snapshot })
    expect(system.authState).toBe('degraded')
    expect(system.authExplanation).toContain('Local development access')
  })

  it('keeps invalid endpoints and SDK errors visible in onboarding state', async () => {
    const client = new Aurora({ transport: MockAuroraTransport.empty().lose('Gateway.GetRegistry') })
    const snapshot = await buildShellSnapshot(client)
    const model = buildOnboardingViewModel({ client, snapshot, endpoint: 'ftp://not-supported' })

    expect(snapshot.loadState).toBe('error')
    expect(model.endpointState).toBe('denied')
    expect(model.endpointEvidence).toContain('could not load')
  })

  it('builds assistant route policy and user-facing SDK error messages from backend status', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const assistantRoute = route(snapshot, 'assistant')
    const policy = routePolicyFromRoute(assistantRoute)

    expect(policy.routeState).toBe(assistantRoute.state)
    expect(policy.privacyClass).toBe('personal')
    expect(assistantErrorMessage(new AuroraError({ code: 'timeout', message: 'slow' }))).toContain('timed out')
    expect(assistantErrorMessage(new AuroraError({ code: 'auth', message: 'denied' }))).toContain('denied')
    expect(assistantErrorMessage(new AuroraError({ code: 'unavailable_service', message: 'down' }))).toContain('unavailable')
  })

  it('keeps default route policy on the local provider until explicit peer dispatch is selected', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const candidateRoute = enabledRoute(route(snapshot, 'assistant'), {
      candidateProviders: [
        {
          id: 'local:Transcription',
          providerId: 'local:Transcription',
          providerKind: 'local',
          peerId: null,
          nodeName: 'This device',
          serviceInstanceId: 'local:Transcription',
          label: 'local / Transcription.Transcribe',
          state: 'available-local',
          selectable: true,
          reason: 'available',
          requiredAction: null
        },
        {
          id: 'remote:peer-studio:Transcription',
          providerId: 'remote:peer-studio:Transcription',
          providerKind: 'remote',
          peerId: 'peer-studio',
          nodeName: 'Studio',
          serviceInstanceId: 'remote:peer-studio:Transcription',
          label: 'remote / Transcription.Transcribe',
          state: 'available-remote',
          selectable: true,
          reason: 'available',
          requiredAction: null
        }
      ]
    })

    expect(routePolicyFromRoute(candidateRoute)).toEqual(expect.objectContaining({
      providerId: 'local:Transcription',
      peerId: null,
      serviceInstanceId: null
    }))
    expect(assistantExecutionOptions(candidateRoute)[1]?.routePolicy).toEqual(expect.objectContaining({
      providerId: 'remote:peer-studio:Transcription',
      peerId: 'peer-studio',
      serviceInstanceId: 'remote:peer-studio:Transcription'
    }))
  })

  it('wires admin services and contract explorer from Aurora SDK resources', async () => {
    const snapshot = await buildAdminServicesSnapshot(new Aurora({ transport: adminServicesTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.services.map((service) => service.module)).toContain('Gateway')
    expect(snapshot.contracts.map((contract) => contract.busTopic)).toContain('Gateway.GetServices')
  })

  it('keeps service control actions capability-driven and AdminAction-gated', async () => {
    const snapshot = await buildAdminServicesSnapshot(new Aurora({ transport: adminServicesTransport() }))
    const supervisor = snapshot.services.find((service) => service.module === 'Supervisor')
    const gateway = snapshot.services.find((service) => service.module === 'Gateway')

    expect(supervisor?.controls.find((control) => control.verb === 'restart')?.available).toBe(true)
    expect(supervisor?.controls.find((control) => control.verb === 'restart')?.requiresAdminAction).toBe(true)
    expect(supervisor?.controls.find((control) => control.verb === 'restart')?.action?.methodId).toBe('Supervisor.RestartService')
    expect(gateway?.controls.every((control) => !control.available)).toBe(true)
  })

  it('renders admin service loading, empty, denied, degraded, and unavailable states', async () => {
    const emptySnapshot = await buildAdminServicesSnapshot(new Aurora({ transport: emptyAdminTransport() }))
    expect(emptySnapshot.loadState).toBe('empty')

    const deniedTransport = adminServicesTransport()
    deniedTransport.fail('Gateway.GetCapabilityCatalog', 'permission', 'Capability catalog denied')
    const deniedSnapshot = await buildAdminServicesSnapshot(new Aurora({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')

    const degradedTransport = adminServicesTransport()
    degradedTransport.lose('Gateway.GetServices', 'Gateway service list unavailable')
    const degradedSnapshot = await buildAdminServicesSnapshot(new Aurora({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')

    const unavailableSnapshot = await buildAdminServicesSnapshot(
      new Aurora({ transport: MockAuroraTransport.empty().lose('Gateway.GetServices').lose('Gateway.GetRegistry').lose('Gateway.GetCapabilityCatalog') })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(unavailableSnapshot.evidenceSource).toBe('Aurora needs attention')
  })

  it('preserves denied, degraded, stale, privacy-blocked, and unsupported contract status', async () => {
    const snapshot = await buildAdminServicesSnapshot(new Aurora({ transport: adminStateMatrixTransport() }))

    expect(snapshot.services.map((service) => service.routeState)).toEqual(
      expect.arrayContaining(['degraded', 'denied', 'stale', 'privacy-blocked', 'unsupported'])
    )
  })

  it('wires plugin admin ready state and policy summary from Aurora', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const pluginsRoute = enabledRoute(route(shell, 'plugins'))
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.sourceSummaries.length).toBeGreaterThan(0)
    expect(snapshot.policy.mode).toBeTruthy()
  })

  it('renders plugin admin empty, denied, unavailable, and disabled-route states', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const pluginsRoute = enabledRoute(route(shell, 'plugins'))

    const emptyTransport = MockAuroraTransport.empty()
    emptyTransport.register('Tooling.GetToolCatalog', () => ({ tools: [], secrets_redacted: true }))
    const emptySnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: emptyTransport }), pluginsRoute)
    expect(emptySnapshot.loadState).toBe('empty')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Tooling.GetToolCatalog', 'permission', 'tool catalog denied')
    const deniedSnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: deniedTransport }), pluginsRoute)
    expect(deniedSnapshot.loadState).toBe('denied')

    const unavailableSnapshot = await buildAdminPluginsSnapshot(
      new Aurora({ transport: MockAuroraTransport.empty().lose('Tooling.GetToolCatalog').lose('Gateway.GetRegistry') }),
      pluginsRoute
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')

    const disabledRoute = { ...pluginsRoute, disabled: true, state: 'denied' as const, blockers: ['missing:Tooling.manage'] }
    const disabledSnapshot = await buildAdminPluginsSnapshot(client, disabledRoute)
    expect(disabledSnapshot.loadState).toBe('denied')
  })

  it('wires scheduler jobs, ownership states, and delegated target status from Aurora', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const schedulerRoute = enabledRoute(route(shell, 'scheduler'), {
      providerLabel: 'local / Scheduler.ListJobs',
      explanation: 'Backend catalog reports Scheduler.ListJobs as routeable.',
      requiresAdminAction: true
    })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.totals).toEqual({
      local: 1,
      delegatedOwned: 1,
      remoteRunning: 1,
      foreignDenied: 1
    })
    expect(snapshot.jobs.map((job) => job.ownership)).toEqual(expect.arrayContaining([
      'local-owned',
      'delegated-owned',
      'remote-running',
      'foreign-denied'
    ]))
    expect(snapshot.jobs.flatMap((job) => job.operationControls).every((control) => control.requiresAdminAction)).toBe(true)
  })

  it('keeps scheduler create and job mutations AdminAction-gated by advertised registry methods', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const schedulerRoute = enabledRoute(route(shell, 'scheduler'), {
      providerLabel: 'local / Scheduler.ListJobs',
      requiresAdminAction: true
    })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute)
    const delegatedJob = snapshot.jobs.find((job) => job.ownership === 'delegated-owned')
    const deniedJob = snapshot.jobs.find((job) => job.ownership === 'foreign-denied')

    expect(snapshot.createControl.available).toBe(true)
    expect(snapshot.createControl.requiresAdminAction).toBe(true)
    expect(snapshot.createControl.targetOptions.map((option) => option.id)).toEqual(expect.arrayContaining(['local-peer', 'peer-studio-gpu']))
    expect(delegatedJob?.operationControls.find((control) => control.action === 'cancel')?.available).toBe(true)
    expect(delegatedJob?.operationControls.find((control) => control.action === 'pause')?.available).toBe(true)
    expect(delegatedJob?.operationControls.find((control) => control.action === 'resume')?.available).toBe(false)
    expect(deniedJob?.operationControls.every((control) => !control.available)).toBe(true)
  })

  it('renders scheduler disabled and SDK error states without fake local state', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const schedulerRoute = enabledRoute(route(shell, 'scheduler'), {
      providerLabel: 'local / Scheduler.ListJobs',
      requiresAdminAction: true
    })
    const disabledRoute = { ...schedulerRoute, disabled: true, state: 'denied' as const, blockers: ['missing:Scheduler.manage'] }
    const disabledSnapshot = await buildAdminSchedulerSnapshot(client, disabledRoute)
    expect(disabledSnapshot.loadState).toBe('denied')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Scheduler.ListJobs', 'permission', 'scheduler list denied')
    const deniedSnapshot = await buildAdminSchedulerSnapshot(new Aurora({ transport: deniedTransport }), schedulerRoute)
    expect(deniedSnapshot.loadState).toBe('denied')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Scheduler.ListJobs', () => ({ jobs: [], total: 0 }))
    const emptySnapshot = await buildAdminSchedulerSnapshot(new Aurora({ transport: emptyTransport }), schedulerRoute)
    expect(emptySnapshot.loadState).toBe('empty')

    const customTransport = new MockAuroraTransport()
    customTransport.register('Scheduler.ListJobs', () => schedulerJobsFixture)
    const customSnapshot = await buildAdminSchedulerSnapshot(new Aurora({ transport: customTransport }), schedulerRoute)
    expect(customSnapshot.jobs).toHaveLength(schedulerJobsFixture.jobs.length)
  })

  it('wires RBAC principals, roles, permissions, and audit status from Aurora', async () => {
    const snapshot = await buildAdminRbacSnapshot(new Aurora({ transport: new MockAuroraTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.principals.map((principal) => principal.id)).toContain('principal-owner')
    expect(snapshot.roles.map((role) => role.label)).toEqual(expect.arrayContaining(['Owner', 'Admin', 'Automation', 'Member']))
    expect(snapshot.roles.every((role) => role.description.includes('current principal permissions'))).toBe(true)
    expect(snapshot.permissions.map((permission) => permission.id)).toContain('Auth.manage')
    expect(snapshot.audit.map((entry) => entry.correlationId)).toContain('corr-rbac-001')
    expect(snapshot.principals.some((principal) => principal.patchPreview.requiresAdminAction)).toBe(true)
    expect(auroraNavSections.flatMap((section) => section.items).find((item) => item.id === 'access')).toEqual(
      expect.objectContaining({ capabilityModule: 'Auth', capabilityMethod: 'ListPrincipals', fallbackState: 'degraded' })
    )
  })

  it('builds RBAC permission patch AdminAction payloads with effective diffs and cascade notes', async () => {
    const snapshot = await buildAdminRbacSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const principal = snapshot.principals.find((row) => row.id === 'principal-assistant')
    expect(principal).toBeTruthy()
    expect(principal?.patchPreview.cascade.join(' ')).toContain('updated permissions')

    const action = buildRbacPermissionPatchAction(principal!, {
      grant: ['Auth.manage'],
      revoke: ['DB.use'],
      reason: 'promote assistant operator'
    })

    expect(action.methodId).toBe('Auth.PatchPermissions')
    expect(action.requiresAdminAction).toBe(true)
    expect(action.payload).toEqual({ user_id: 'principal-assistant', grant: ['Auth.manage'], revoke: ['DB.use'] })
    expect(action.affectedResources).toEqual(expect.arrayContaining(['principal:principal-assistant', 'grant:Auth.manage', 'revoke:DB.use']))
    expect(action.diff.find((row) => row.key === 'principal.permissions')?.after).toContain('Auth.manage')
    expect(action.auditReason).toBe('promote assistant operator')
  })

  it('renders RBAC loading, empty, denied, degraded, unavailable, and rollback-error states', async () => {
    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListPrincipals', () => ({ principals: [] }))
    emptyTransport.register('Auth.AuditLog', () => ({ events: [], total: 0 }))
    const emptySnapshot = await buildAdminRbacSnapshot(new Aurora({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.ListPrincipals', 'permission', 'Auth RBAC denied')
    const deniedSnapshot = await buildAdminRbacSnapshot(new Aurora({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')

    const degradedTransport = new MockAuroraTransport()
    degradedTransport.lose('Auth.AuditLog', 'audit backend unavailable')
    const degradedSnapshot = await buildAdminRbacSnapshot(new Aurora({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')

    const unavailableSnapshot = await buildAdminRbacSnapshot(
      new Aurora({
        transport: MockAuroraTransport.empty()
          .lose('Auth.ListPrincipals')
          .lose('Auth.AuditLog')
          .lose('Gateway.GetRegistry')
          .lose('Gateway.GetCapabilityCatalog')
      })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
  })

  it('wires audit log details, mesh filters, redaction, and export from Aurora', async () => {
    const snapshot = await buildAdminAuditSnapshot(new Aurora({ transport: new MockAuroraTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.rows.map((row) => row.correlationId)).toEqual(expect.arrayContaining(['corr-tool-approval-001', 'corr-scheduler-001']))
    expect(snapshot.rows.map((row) => row.lifecycleLabel)).toEqual(expect.arrayContaining(['requested', 'approve-all scope created', 'replay rejected']))
    expect(snapshot.rows.some((row) => row.dataNamespace === 'recipes')).toBe(true)
    expect(snapshot.rows.some((row) => row.audioSessionId === 'audio-session-77')).toBe(true)
    expect(snapshot.rows.some((row) => row.schedulerJobId === 'job-nightly-sync')).toBe(true)

    const exportPayload = buildAuditExport(snapshot.rows)
    expect(exportPayload.redaction.raw_payloads_included).toBe(false)
    expect(exportPayload.support_bundle_correlation_ids).toContain('bundle-corr-001')
    expect(JSON.stringify(exportPayload)).not.toContain('redacted-by-backend')
    expect(JSON.stringify(exportPayload)).toContain('sha256:scheduler001')
  })

  it('filters audit events by peer/provider, route, approval mode, namespace, audio, scheduler, correlation, and denial reason', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })

    const schedulerSnapshot = await buildAdminAuditSnapshot(client, {
      peerOrProvider: 'peer-kitchen',
      routePath: 'Scheduler.RunJob',
      approvalMode: 'approve_all',
      dataNamespace: 'recipes',
      audioSessionId: 'audio-session-77',
      schedulerJobId: 'job-nightly-sync',
      correlationId: 'corr-scheduler-001'
    })
    expect(schedulerSnapshot.rows).toHaveLength(1)
    expect(schedulerSnapshot.rows[0]?.event).toBe('mesh.audit.executed')
    expect(schedulerSnapshot.warnings.join(' ')).toContain('Data area is filtered')

    const deniedSnapshot = await buildAdminAuditSnapshot(client, {
      toolId: 'tool:studio:shell.exec',
      denialReason: 'policy_denied',
      status: 'denied'
    })
    expect(deniedSnapshot.rows).toHaveLength(1)
    expect(deniedSnapshot.rows[0]?.status).toBe('denied')
    expect(deniedSnapshot.warnings.join(' ')).toContain('Result is filtered')
  })

  it('renders audit loading, empty, denied, degraded, and unavailable states', async () => {
    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.AuditLog', () => ({ events: [], total: 0 }))
    const emptySnapshot = await buildAdminAuditSnapshot(new Aurora({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.AuditLog', 'permission', 'audit access denied')
    const deniedSnapshot = await buildAdminAuditSnapshot(new Aurora({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')

    const unavailableSnapshot = await buildAdminAuditSnapshot(
      new Aurora({ transport: MockAuroraTransport.empty().lose('Auth.AuditLog', 'audit service unavailable') })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
  })

  it('wires scoped tokens, one-time reveal rules, and revoke AdminAction status from Aurora', async () => {
    const snapshot = await buildAdminTokensSnapshot(new Aurora({ transport: new MockAuroraTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.tokens.map((token) => token.prefix)).toContain('aur_stu')
    expect(snapshot.tokens.some((token) => token.revokeAction?.methodId === 'Auth.RevokeToken')).toBe(true)
  })

  it('builds token revoke mutations as AdminAction requests without secret payloads', async () => {
    const snapshot = await buildAdminTokensSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const token = snapshot.tokens.find((row) => row.id === 'token-studio-mac-active')
    expect(token).toBeTruthy()

    const action = buildTokenRevokeAdminAction(token!, 'rotate exposed workstation token')
    expect(action.methodId).toBe('Auth.RevokeToken')
    expect(action.payload).toEqual({ token_id: 'token-studio-mac-active' })
    expect(action.reason).toBe('rotate exposed workstation token')
    expect(action.requiresAdminAction).toBe(true)
    expect(JSON.stringify(action)).not.toContain('secret')
  })

  it('renders token loading, empty, denied, degraded, and unavailable states', async () => {
    // These assertions cover the buildAdminTokensSnapshot data-layer
    // classification for every loadState instead of crashing or leaking secrets.
    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListTokens', () => ({ tokens: [] }))
    const emptySnapshot = await buildAdminTokensSnapshot(new Aurora({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.ListTokens', 'permission', 'token access denied')
    const deniedSnapshot = await buildAdminTokensSnapshot(new Aurora({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(deniedSnapshot.error).toContain('Permission is needed')

    const degradedTransport = new MockAuroraTransport()
    degradedTransport.lose('Gateway.GetCapabilityCatalog', 'token capability catalog unavailable')
    const degradedSnapshot = await buildAdminTokensSnapshot(new Aurora({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')

    const unavailableSnapshot = await buildAdminTokensSnapshot(
      new Aurora({
        transport: MockAuroraTransport.empty()
          .lose('Auth.ListTokens')
          .lose('Gateway.GetCapabilityCatalog')
      })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(unavailableSnapshot.error).toContain('Aurora token resources are unavailable')
  })

  it('wires device/session management from Aurora Auth resources', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.devices.map((device) => device.id)).toContain('device-studio-mac')
    expect(snapshot.devices.some((device) => device.activeSessionCount > 0)).toBe(true)
    expect(snapshot.pendingPairings.some((pairing) => pairing.requestId === 'mesh-pairing-peer-kitchen')).toBe(true)
    expect(snapshot.devices.some((device) => device.deleteAction?.methodId === 'Auth.DeleteDevice')).toBe(true)
  })

  it('builds device delete mutations as AdminAction requests', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const device = snapshot.devices.find((row) => row.id === 'device-studio-mac')
    expect(device).toBeTruthy()

    const action = buildDeviceDeleteAdminAction(device!, 'retire lost laptop')
    expect(action.methodId).toBe('Auth.DeleteDevice')
    expect(action.payload).toEqual({ device_id: 'device-studio-mac' })
    expect(action.reason).toBe('retire lost laptop')
    expect(action.reauthConfirmed).toBe(false)
    expect(action.affectedResources).toEqual(expect.arrayContaining(['device:device-studio-mac', 'device_tokens', 'active_sessions']))
  })

  it('renders device loading, empty, denied, degraded, unavailable, optimistic, rollback, and capability-gated states', async () => {
    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListDevices', () => ({ devices: [] }))
    emptyTransport.register('Auth.ListTokens', () => ({ tokens: [] }))
    const emptySnapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.ListDevices', 'permission', 'device access denied')
    const deniedSnapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')

    const degradedTransport = new MockAuroraTransport()
    degradedTransport.lose('Auth.ListTokens', 'token service unavailable')
    const degradedSnapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')

    const unavailableSnapshot = await buildAdminDevicesSnapshot(
      new Aurora({
        transport: MockAuroraTransport.empty()
          .lose('Auth.ListDevices')
          .lose('Auth.ListTokens')
          .lose('Gateway.GetCapabilityCatalog')
      })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')

    const gatedTransport = new MockAuroraTransport()
    gatedTransport.register('Gateway.GetCapabilityCatalog', () => deviceCatalogWithoutDelete())
    const gatedSnapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: gatedTransport }))
    expect(gatedSnapshot.deleteState).toBe('unsupported')
    expect(gatedSnapshot.devices.every((device) => device.deleteAction === null)).toBe(true)
  })

  it('renders config editor schema, rollback, and AdminAction controls from SDK status', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const configRoute = enabledRoute(route(snapshot, 'config'))
    const model = await buildConfigEditorModel(client, configRoute)

    expect(model.state).toBe('ready')
    expect(model.fields.map((field) => field.key_path)).toContain('services.gateway.api.port')
    expect(model.versions.map((version) => version.version_id)).toContain('cfgv-gateway-port-001')
  })

  it('keeps config editor denied states disabled without local-only fallback', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const configRoute = { ...route(snapshot, 'config'), disabled: true, state: 'denied' as const, blockers: ['missing:Config.manage'] }
    const model = await buildConfigEditorModel(client, configRoute)

    expect(model.state).toBe('denied')
    expect(model.fields).toEqual([])
  })

  it('renders pairing queue states without exposing pairing codes', () => {
    const route = pairingRoute()
    const model = buildPairingQueueModel({
      route,
      response: {
        pairings: [
          pairingEntry({ request_id: 'pending-1', code: 'secret-pending-code', status: 'pending' }),
          pairingEntry({ request_id: 'approved-1', status: 'approved', approved_by: 'admin-1', granted_permissions: ['Gateway.use'] }),
          pairingEntry({ request_id: 'denied-1', status: 'denied', denied_by: 'admin-2', denied_reason: 'Wrong device' })
        ],
        total: 3,
        expired_count: 0,
        secrets_redacted: true
      }
    })

    expect(model.state).toBe('pending')
  })

  it('maps pairing queue loading, empty, denied, degraded, and disabled states', () => {
    const route = pairingRoute()
    const disabled = pairingRoute({ disabled: true, state: 'unsupported', explanation: 'No executable Auth.ListPendingPairings entry.' })

    expect(buildPairingQueueModel({ route, loadState: 'loading' }).state).toBe('loading')
    expect(buildPairingQueueModel({ route, response: emptyPairingQueue() }).description).toContain('no pending')
    expect(buildPairingQueueModel({
      route,
      loadState: 'error',
      error: new AuroraError({ code: 'permission', message: 'Forbidden' })
    }).state).toBe('denied')
    expect(buildPairingQueueModel({
      route,
      loadState: 'error',
      error: new AuroraError({ code: 'unavailable_service', message: 'Auth down' })
    }).state).toBe('degraded')
    expect(buildPairingQueueModel({ route: disabled }).disabledReason).toContain('Capability unavailable')
    expect(pairingErrorMessage(new AuroraError({ code: 'unsupported_feature', message: 'missing' }))).toContain('cannot use that pairing feature yet')
    expect(parsePermissionList('Gateway.use, Auth.use\nDB.use')).toEqual(['Gateway.use', 'Auth.use', 'DB.use'])
  })

  it('builds pairing approve and deny mutations as AdminAction requests', () => {
    const entry = pairingEntry()
    const approve = buildPairingAdminActionRequest(entry, 'approve', {
      reason: 'Approve kitchen tablet',
      permissions: 'Gateway.use Auth.use',
      grantAdmin: false,
      reauthConfirmed: true
    })
    const deny = buildPairingAdminActionRequest(entry, 'deny', {
      reason: 'Wrong peer',
      reauthConfirmed: true
    })

    expect(approve).toEqual(
      expect.objectContaining({
        methodId: 'Auth.PairingApprove',
        path: '/api/Auth/PairingApprove',
        reauthConfirmed: true,
        reason: 'Approve kitchen tablet',
        affectedResources: ['pairing:pair-1', 'peer:peer-kitchen', 'device:Kitchen tablet'],
        payload: {
          code: '123456',
          permissions: ['Gateway.use', 'Auth.use'],
          is_admin: false
        }
      })
    )
    expect(deny).toEqual(
      expect.objectContaining({
        methodId: 'Auth.PairingDeny',
        path: '/api/Auth/PairingDeny',
        payload: {
          code: '123456',
          reason: 'Wrong peer'
        }
      })
    )
  })

  it('builds mesh peer lifecycle snapshots from SDK mesh, Auth, WebRTC, and capability status', async () => {
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport: new MockAuroraTransport() }), meshRoute())

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.localPeerId).toBe(meshStatusFixture.local.peer_id)
    expect(snapshot.secretsRedacted).toBe(true)
    expect(snapshot.pendingCount).toBe(1)
    expect(snapshot.pendingRequests).toHaveLength(1)
    expect(snapshot.approvedCount).toBe(1)
    expect(snapshot.deniedCount).toBe(1)
    expect(snapshot.removedCount).toBe(1)
    expect(snapshot.runtimePeerCount).toBe(meshStatusFixture.peers.length)
    expect(snapshot.liveSessionCount).toBe(1)
    expect(snapshot.deviceCount).toBe(3)
    expect(snapshot.routeCount).toBe(meshStatusFixture.routes.length)
    expect(snapshot.peers.map((peer) => peer.peerId)).toEqual(
      expect.arrayContaining(meshPeerListFixture.peers.map((peer) => peer.peer_id))
    )
    expect(snapshot.liveSessions[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-peer',
        stablePeerId: 'stable-peer',
        evidenceSource: 'Gateway.GetWebRTCDiagnostics'
      })
    )
    expect(snapshot.devices.map((device) => device.name)).toEqual(
      expect.arrayContaining(['Studio Mac', 'Ops tablet', 'Assistant phone'])
    )
    expect(snapshot.peers.find((peer) => peer.peerId === 'peer-kitchen')).toEqual(
      expect.objectContaining({
        trustState: 'pending',
        connectionStatus: 'connected',
        pendingPairing: expect.objectContaining({
          remote_peer_id: 'peer-kitchen',
          code: 'mesh-pairing-secret'
        }),
        approveAction: expect.objectContaining({
          methodId: 'Auth.PairingApprove',
          path: '/api/Auth/PairingApprove',
          payload: expect.objectContaining({ code: 'mesh-pairing-secret' })
        }),
        lastEvidenceSource: expect.stringContaining('Auth.MeshListPeers')
      })
    )
    expect(snapshot.pendingRequests[0]).toEqual(expect.objectContaining({
      peerId: 'peer-kitchen',
      pendingPairing: expect.objectContaining({ request_id: 'mesh-pairing-peer-kitchen', code: 'mesh-pairing-secret' }),
      denyAction: expect.objectContaining({
        methodId: 'Auth.PairingDeny',
        path: '/api/Auth/PairingDeny',
        payload: expect.objectContaining({ code: 'mesh-pairing-secret' })
      })
    }))
    expect(snapshot.liveSessions.find((session) => session.stablePeerId === 'stable-peer')?.evidenceSource).toBe('Gateway.GetWebRTCDiagnostics')
    expect(snapshot.devices.find((device) => device.name === 'Studio Mac')).toEqual(
      expect.objectContaining({
        trustLabel: 'trusted Auth device',
        evidenceSource: 'Auth.ListDevices'
      })
    )
    expect(snapshot.peers.find((peer) => peer.peerId === 'peer-den')?.compatibility).toContain('incompatible')
  })

  it('shows outgoing pairing progress on Mesh when the incoming queue is empty', async () => {
    const transport = new MockAuroraTransport()
    transport
      .register('Auth.ListPendingPairings', () => emptyPairingQueue())
      .register('Gateway.GetWebRTCDiagnostics', () => ({
        ...webrtcDiagnosticsFixture,
        peers: [{
          ...webrtcDiagnosticsFixture.peers[0]!,
          signaling_peer_id: 'session-outgoing-pairing',
          stable_peer_id: 'stable-peer-outgoing',
          node_name: 'Aurora 2',
          connection_state: 'connected',
          data_channel_state: 'open',
          auth_state: 'anonymous',
          pairing_active: true,
          auth_timeout_pending: true,
          pending_pairing_task: true,
          pairing_session_id: 'a'.repeat(64),
          verification_code: '48271935'
        }]
      }))

    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport }), meshRoute())
    expect(snapshot.pendingRequests).toEqual([])
    expect(snapshot.liveSessions).toEqual([
      expect.objectContaining({
        nodeName: 'Aurora 2',
        connectionState: 'connected',
        pairingState: expect.stringContaining('pairing active')
      })
    ])

    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<MeshPeersView snapshot={snapshot} route={meshRoute()} />))

      expect(container.textContent).not.toContain('Pending pairing requests')
      expect(container.textContent).toContain('Outgoing pairing is active')
      expect(container.textContent).toContain('Pairing request sent to Aurora 2')
      expect(container.textContent).toContain('Compare the verification code shown on both devices')
      expect(container.textContent).toContain('4827 1935')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps duplicate mesh pairing requests request-scoped and targets each displayed code', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Auth.ListPendingPairings', () => ({
      pairings: [
        pairingEntry({
          request_id: 'pairing-first',
          code: 'opaque-handle-first',
          pairing_session_id: 'a'.repeat(64),
          verification_code: '11111111'
        }),
        pairingEntry({
          request_id: 'pairing-second',
          code: 'opaque-handle-second',
          pairing_session_id: 'b'.repeat(64),
          verification_code: '22222222'
        })
      ],
      total: 2,
      expired_count: 0,
      secrets_redacted: true
    }))

    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport }), meshRoute())

    expect(snapshot.pendingCount).toBe(2)
    expect(snapshot.pendingRequests.map((peer) => peer.pendingPairing.request_id)).toEqual(['pairing-first', 'pairing-second'])
    expect(snapshot.pendingRequests.map((peer) => peer.approveAction)).toEqual([
      expect.objectContaining({
        methodId: 'Auth.PairingApprove',
        path: '/api/Auth/PairingApprove',
        payload: expect.objectContaining({ code: 'opaque-handle-first' })
      }),
      expect.objectContaining({
        methodId: 'Auth.PairingApprove',
        path: '/api/Auth/PairingApprove',
        payload: expect.objectContaining({ code: 'opaque-handle-second' })
      })
    ])
    expect(snapshot.pendingRequests.map((peer) => peer.denyAction?.payload)).toEqual([
      expect.objectContaining({ code: 'opaque-handle-first' }),
      expect.objectContaining({ code: 'opaque-handle-second' })
    ])

    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<MeshPeersView snapshot={snapshot} route={meshRoute()} />))
      const reviewButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.includes('Review & approve'))
      expect(reviewButtons).toHaveLength(2)
      expect(container.textContent).toContain('1111 1111')
      expect(container.textContent).toContain('2222 2222')
      expect(container.textContent).not.toContain('opaque-handle-first')
      expect(container.textContent).not.toContain('opaque-handle-second')

      await act(async () => {
        reviewButtons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('2222 2222')
      expect(dialog?.textContent).not.toContain('1111 1111')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('uses the existing Mesh pairing UI for thin peers and keeps remote service configuration read-only', async () => {
    const snapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport() }),
      meshRoute(),
    )
    const thinPeerSnapshot: BrowserWebRtcSnapshot = {
      state: 'awaiting-sas-confirmation',
      connectionMode: 'webrtc-only',
      icePathCategory: 'host',
      protocolCapabilities: [],
      reconnectCount: 0,
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      sentFragmentCount: 0,
      receivedFragmentCount: 0,
      updatedAt: '2026-07-28T00:00:00Z',
      status: 'pairing',
      pairingSessionId: 'thin-pairing-session',
      pairingVerificationCode: '48271935',
      nodeName: 'Aurora host',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    }
    const onConfirmThinPairing = vi.fn()
    const onRejectThinPairing = vi.fn()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(
        <MeshPeersView
          snapshot={snapshot}
          route={meshRoute()}
          canManageLocalServiceConfiguration={false}
          thinPeerSnapshot={thinPeerSnapshot}
          onConfirmThinPairing={onConfirmThinPairing}
          onRejectThinPairing={onRejectThinPairing}
        />
      ))

      expect(container.textContent).toContain('Connected devices')
      expect(container.textContent).toContain('Waiting for approval')
      expect(container.textContent).toContain('4827 1935')
      expect(container.textContent).not.toContain('Thin-shell transport')
      expect(container.textContent).not.toContain('Device connection settings')
      expect(container.textContent).not.toContain('Connect device')
      expect(container.querySelectorAll('[data-slot="card"]').length).toBeGreaterThan(1)
      expect(
        container.querySelector('[data-slot="switch"]')?.hasAttribute('data-disabled'),
      ).toBe(true)

      const review = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Review & approve'),
      )
      await act(async () => review?.click())
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Approve Aurora host')
      expect(dialog?.textContent).toContain('4827 1935')

      const approve = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('Approve & pair'))
      await act(async () => approve?.click())
      expect(onConfirmThinPairing).toHaveBeenCalledWith('thin-pairing-session', { sharedFeatureIds: [] })
      expect(onRejectThinPairing).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps a configured thin peer visible as offline instead of calling WebRTC disabled', async () => {
    const unavailable = await buildMeshPeersSnapshot(
      new Aurora({
        transport: MockAuroraTransport.empty()
          .lose('Gateway.GetMeshStatus', 'WebRTC mesh transport is not connected')
          .lose('Gateway.GetWebRTCDiagnostics', 'WebRTC mesh transport is not connected')
          .lose('Gateway.GetCapabilityCatalog', 'WebRTC mesh transport is not connected'),
      }),
      meshRoute(),
    )
    const thinPeerSnapshot: BrowserWebRtcSnapshot = {
      state: 'failed',
      connectionMode: 'webrtc-only',
      expectedStablePeerId: 'peer-host',
      nodeName: 'Aurora host',
      icePathCategory: 'unknown',
      protocolCapabilities: [],
      reconnectCount: 3,
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      sentFragmentCount: 0,
      receivedFragmentCount: 0,
      updatedAt: '2026-07-28T00:00:00Z',
      status: 'failed',
      diagnostic: 'WebRTC mesh transport is not connected; preferred-mode fallback is unavailable.',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    }

    const snapshot = reconcileMeshPeersWithThinPeer(
      unavailable,
      thinPeerSnapshot,
    )

    expect(snapshot.loadState).toBe('degraded')
    expect(snapshot.meshEnabled).toBe(true)
    expect(snapshot.webrtcStarted).toBe(true)
    expect(snapshot.error).toBeNull()
    expect(snapshot.peers).toEqual([
      expect.objectContaining({
        peerId: 'peer-host',
        nodeName: 'Aurora host',
        lifecycleState: 'stale',
        connectionStatus: 'offline',
      }),
    ])
    expect(snapshot.warnings.join(' ')).not.toContain(
      'WebRTC mesh transport is not connected',
    )

    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <MeshPeersView
            snapshot={snapshot}
            route={meshRoute()}
            canManageLocalServiceConfiguration={false}
            thinPeerSnapshot={thinPeerSnapshot}
            onReconnectThinPeer={vi.fn()}
          />,
        ),
      )
      expect(container.textContent).toContain('Aurora host is offline')
      expect(container.textContent).toContain('Saved devices and last-known services stay visible')
      expect(container.textContent).not.toContain(
        'Device connection needs attention',
      )
      expect(container.textContent).not.toContain(
        'WebRTC mesh transport is not connected',
      )
      expect(container.textContent).toContain('Offline')
      expect(container.textContent).not.toContain('Needs attention')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('retains last-known peer providers and projects the thin peer offline without emptying the shell', async () => {
    const ready = await buildShellSnapshot(
      new Aurora({ transport: new MockAuroraTransport() }),
    )
    const failed = errorShellSnapshot(
      'mesh',
      new Error('WebRTC mesh transport is not connected'),
    )
    const thinPeerSnapshot: BrowserWebRtcSnapshot = {
      state: 'failed',
      connectionMode: 'webrtc-only',
      expectedStablePeerId: 'peer-host',
      nodeName: 'Aurora host',
      icePathCategory: 'unknown',
      protocolCapabilities: [],
      reconnectCount: 1,
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      sentFragmentCount: 0,
      receivedFragmentCount: 0,
      updatedAt: '2026-07-28T00:00:00Z',
      status: 'failed',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    }

    const retained = retainThinShellSnapshot(ready, failed, thinPeerSnapshot)

    expect(retained.nodeName).toBe('Aurora host')
    expect(retained.routeCount).toBe(ready.routeCount)
    expect(retained.routes).toHaveLength(ready.routes.length)
    expect(
      retained.routes.flatMap((route) =>
        route.candidateProviders.map((candidate) => candidate.id),
      ),
    ).toEqual(
      expect.arrayContaining(
        ready.routes
          .flatMap((route) =>
            route.candidateProviders.map((candidate) => candidate.id),
          )
          .slice(0, 1),
      ),
    )
    expect(retained.routes.every((route) => route.state === 'stale')).toBe(true)
    expect(
      Object.values(retained.assistantVoiceRoutes).every(
        (route) => route.state === 'stale',
      ),
    ).toBe(true)
    expect(retained.availableCount).toBe(0)
    expect(retained.error).toBeNull()

    const hostilePeerSnapshot: BrowserWebRtcSnapshot = {
      ...thinPeerSnapshot,
      expectedStablePeerId: 'thin-runtime-provider',
      nodeName: 'runtime provider shell',
    }
    const hostileRetained = retainThinShellSnapshot(ready, failed, hostilePeerSnapshot)
    expect(hostileRetained.nodeName).toBe('Invited Aurora device')
    const retainedCopy = shellRouteCopySurface([
      ...hostileRetained.routes,
      hostileRetained.assistantCancellationRoute,
      ...Object.values(hostileRetained.assistantVoiceRoutes)
    ])
    expect(retainedCopy).not.toMatch(/runtime provider shell|thin-runtime-provider|last-known provider|mesh route/i)
    expect(findForbiddenProductionCopyTerms(retainedCopy).map((term) => term.id), retainedCopy).toEqual([])

    const coldOffline = retainThinShellSnapshot(
      { ...loadingShellSnapshot, loadState: 'ready' },
      failed,
      thinPeerSnapshot,
    )
    expect(coldOffline.routes).toHaveLength(failed.routes.length)
    expect(coldOffline.routes.every((route) => route.state === 'stale')).toBe(true)
    expect(coldOffline.routes[0]?.explanation).toContain(
      'approved Aurora device reconnects',
    )
    expect(coldOffline.error).toBeNull()

    const connectedFailure = retainThinShellSnapshot(
      ready,
      failed,
      {
        ...thinPeerSnapshot,
        state: 'authorized',
        status: 'authorized',
      },
    )
    expect(connectedFailure).toBe(failed)
    expect(connectedFailure.error).toBe('Could not connect to this Aurora device. Try again.')
  })

  it('keeps pending pairing requests out of the scopes approval path', async () => {
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport: new MockAuroraTransport() }), meshRoute())
    const pendingPeer = snapshot.peers.find((peer) => peer.pendingPairing)
    const approvedPeer = snapshot.peers.find((peer) => !peer.pendingPairing && peer.outboundStatus === 'approved')
    expect(pendingPeer).toBeDefined()
    expect(approvedPeer).toBeDefined()

    expect(buildMeshScopesAdminAction(pendingPeer!, ['Gateway.use'])).toBeNull()
    expect(buildMeshScopesAdminAction({ ...pendingPeer!, pendingPairing: null }, ['Gateway.use'])).toBeNull()
    expect(buildMeshScopesAdminAction(approvedPeer!, ['Gateway.use'])).toEqual(expect.objectContaining({
      methodId: 'Auth.MeshUpdatePeerPermissions',
      path: '/api/Auth/MeshUpdatePeerPermissions',
      payload: { peer_id: approvedPeer!.peerId, permissions: ['Gateway.use'] }
    }))

    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(
        <MeshPeersView
          snapshot={{ ...snapshot, peers: [pendingPeer!] }}
          route={meshRoute()}
        />
      ))
      const buttonLabels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent?.trim())
      expect(buttonLabels).not.toContain('Scopes')
      expect(container.textContent).toContain('Review required')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('shows mesh latency as a measured band without raw-float or fake-percent noise', async () => {
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport: new MockAuroraTransport() }), meshRoute())
    const peer = snapshot.peers.find((candidate) => candidate.outboundStatus === 'approved') ?? snapshot.peers[0]!
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => root.render(
        <MeshPeersView
          snapshot={{ ...snapshot, peers: [{ ...peer, latencyMs: null, connectionStatus: 'connected' }] }}
          route={meshRoute()}
        />
      ))
      expect(container.textContent).toContain('connected')
      expect(container.textContent).toContain('Response time unavailable')
      expect(container.textContent).not.toContain('measuring')
      expect(container.textContent).not.toContain('Route qualitygood')

      await act(async () => root.render(
        <MeshPeersView
          snapshot={{ ...snapshot, peers: [{ ...peer, latencyMs: 479.43071997724473, connectionStatus: 'connected' }] }}
          route={meshRoute()}
        />
      ))
      expect(container.textContent).toContain('479.4 ms')
      expect(container.textContent).toContain('poor')
      expect(container.textContent).not.toContain('479.43071997724473')
      expect(container.textContent).not.toContain('0%')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('shows a live negotiated peer as connected when saved inbound trust is not yet mirrored', async () => {
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport: new MockAuroraTransport() }), meshRoute())
    const peer = snapshot.peers.find((candidate) => candidate.peerId === 'peer-studio-gpu') ?? snapshot.peers[0]!
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => root.render(
        <MeshPeersView
          snapshot={{
            ...snapshot,
            peers: [{
              ...peer,
              trustState: 'degraded',
              trustLabel: 'Waiting for the other device',
              outboundStatus: 'approved',
              inboundStatus: 'unknown',
              lifecycleState: 'available-remote',
              lifecycleLabel: 'Connected',
              connectionStatus: 'connected',
              latencyMs: 4.6,
            }],
          }}
          route={meshRoute()}
        />
      ))

      expect(container.textContent).toContain('Remote')
      expect(container.textContent).toContain('4.6 ms')
      expect(container.textContent).not.toContain('Needs attention')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('does not send Auth pairing reads before Auth or the mesh runtime is ready', async () => {
    const transport = new MockAuroraTransport()
    const disabledMesh = cloneFixture(meshStatusFixture)
    disabledMesh.local.mesh_enabled = false
    disabledMesh.local.mesh_started = false
    disabledMesh.local.webrtc_started = false
    disabledMesh.peers = []
    disabledMesh.routes = []
    const authReads: string[] = []

    transport
      .register('Gateway.GetMeshStatus', () => disabledMesh)
      .register('Config.Get', () => ({
        config: {
          services: {
            auth: { enabled: false },
            gateway: {
              mesh_network: { enabled: false },
              webrtc: { enabled: false, app_id: 'aurora', room: 'default', password: '' }
            }
          }
        }
      }))
      .register('Auth.MeshListPeers', () => {
        authReads.push('Auth.MeshListPeers')
        return { peers: [] }
      })
      .register('Auth.ListPendingPairings', () => {
        authReads.push('Auth.ListPendingPairings')
        return { pairings: [] }
      })
      .register('Auth.ListDevices', () => {
        authReads.push('Auth.ListDevices')
        return { devices: [] }
      })

    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport }), meshRoute())

    expect(authReads).toEqual([])
    expect(snapshot.meshEnabled).toBe(false)
    expect(snapshot.warnings.join(' ')).not.toMatch(/mesh peers|pairing queue|Auth devices/)
  })

  it('does not send admin Auth reads from a non-admin mesh peer session', async () => {
    const backingTransport = new MockAuroraTransport()
    const authReads: string[] = []
    backingTransport
      .register('Auth.MeshListPeers', () => {
        authReads.push('Auth.MeshListPeers')
        return cloneFixture(meshPeerListFixture)
      })
      .register('Auth.ListPendingPairings', () => {
        authReads.push('Auth.ListPendingPairings')
        return emptyPairingQueue()
      })
      .register('Auth.ListDevices', () => {
        authReads.push('Auth.ListDevices')
        return { devices: [] }
      })
    const transport = {
      kind: 'mesh' as const,
      request: backingTransport.request.bind(backingTransport),
    }
    const client = new Aurora({ transport })
    client.auth.setMeshPeer({
      principalId: 'mobile-peer',
      permissions: ['Gateway.use', 'Auth.MeshListPeers'],
      effectivePermissions: ['Gateway.use', 'Auth.MeshListPeers'],
      source: 'webrtc_rpc',
    })

    const snapshot = await buildMeshPeersSnapshot(client, meshRoute())

    expect(snapshot.peers.length).toBeGreaterThan(0)
    expect(authReads).toEqual(['Auth.MeshListPeers'])
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({
      state: 'mesh_peer',
      isAuthenticated: true,
      isDenied: false,
    }))
  })

  it('builds mesh invites with mandatory signaling credentials and without pre-created pairing codes', async () => {
    const route = meshRoute()
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport: new MockAuroraTransport() }), route)
    const secureSnapshot = {
      ...snapshot,
      secretsRedacted: false,
      config: {
        ...snapshot.config,
        secretsRedacted: false,
        fields: snapshot.config.fields.map((field) =>
          field.key_path === 'services.gateway.webrtc.password'
            ? { ...field, current_value: 'secret-room-key' }
            : field
        )
      }
    }

    expect(snapshot.fixtureOnly).toBe(true)
    expect(snapshot.evidenceSource).toBe('Sample data')
    expect(snapshot.config.fields.some((field) => field.key_path === 'services.gateway.webrtc.room')).toBe(true)
    const buildMandatoryInvite = buildMeshInvitePayload as unknown as (input: typeof secureSnapshot) => ReturnType<typeof buildMeshInvitePayload>
    const invite = buildMandatoryInvite(secureSnapshot)
    expect(invite.kind).toBe('aurora.mesh.invite')
    expect(invite.signaling).toEqual(expect.objectContaining({
      app_id: 'aurora-dev',
      room: 'aurora-studio-room',
      room_password: 'secret-room-key'
    }))
    expect(JSON.stringify(invite)).toContain('Gateway.use')
    expect(invite).not.toHaveProperty('pairing')
    expect(JSON.stringify(invite)).not.toContain('mesh-pairing-secret')
  })

  it('does not expose manual code creation or optional-password controls in the Mesh Connect UI', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const route = meshRoute()
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport: new MockAuroraTransport() }), route)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<MeshPeersView snapshot={snapshot} route={route} />)
      })
      const connectButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Connect device'))
      expect(connectButton).toBeDefined()

      await act(async () => {
        connectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(dialog?.textContent).toContain('Invite a device')
      expect(dialog?.textContent).not.toContain('Create pairing code')
      expect(dialog?.textContent).not.toContain('Include room password')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('keeps mesh configuration read-only when schema metadata is unavailable', async () => {
    const snapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport().lose('Config.GetSchemaMetadata', 'metadata down') }),
      meshRoute()
    )
    expect(snapshot.config.fields.length).toBeGreaterThan(0)
    expect(snapshot.config.editable).toBe(false)
    expect(snapshot.config.state).toBe('degraded')
    expect(snapshot.config.reason).toContain('editing is unavailable')
    expect(snapshot.config.warnings.join(' ')).toContain('Connection lost')
  })

  it('reports security settings as unknown when Config and diagnostics evidence are absent', async () => {
    const transport = new MockAuroraTransport()
      .lose('Config.GetSchemaMetadata', 'metadata down')
      .lose('Gateway.GetWebRTCDiagnostics', 'diagnostics down')
    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport }), meshRoute())
    const value = (keyPath: string) => snapshot.config.fields.find((field) => field.key_path === keyPath)?.current_value

    expect(value('services.gateway.webrtc.encrypt_signaling')).toBeNull()
    expect(value('services.gateway.webrtc.enable_app_layer_e2ee')).toBeNull()
    expect(snapshot.config.editable).toBe(false)
    expect(snapshot.config.state).toBe('degraded')
    expect(meshInviteReadiness(snapshot)).toEqual(
      expect.objectContaining({ ready: false, reason: expect.stringContaining('Private invite protection') }),
    )
  })

  it('does not surface non-pending pairing history as approval requests', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Auth.ListPendingPairings', () => ({
      pairings: [
        {
          request_id: 'mesh-pairing-history',
          code: 'historical-secret',
          device_name: 'Kitchen tablet',
          client_ip: '192.168.10.42',
          status: 'approved',
          expires_at: '2026-06-25T16:30:00Z',
          created_at: '2026-06-25T16:00:00Z',
          remote_peer_id: 'peer-studio-gpu',
          remote_node_name: 'Studio GPU',
          approved_by: 'admin',
          denied_by: null,
          denied_reason: '',
          granted_permissions: ['Gateway.use'],
          granted_is_admin: false
        } satisfies PendingPairingEntry
      ],
      total: 1,
      expired_count: 0,
      secrets_redacted: true
    }))

    const snapshot = await buildMeshPeersSnapshot(new Aurora({ transport }), meshRoute())
    const stablePeer = snapshot.peers.find((peer) => peer.peerId === 'peer-studio-gpu')

    expect(stablePeer?.pendingPairing).toBeNull()
    expect(stablePeer?.trustState).not.toBe('pending')
  })

  it('builds mesh peer AdminAction payloads without raw confirmation shortcuts', () => {
    const pairing = pairingEntry({ request_id: 'pairing-exact', code: '654321' })
    const approvePairing = buildMeshPeerAdminAction(
      { peerId: pairing.remote_peer_id, nodeName: pairing.remote_node_name, pendingPairing: pairing },
      'approve',
      { reason: 'Matching code verified', permissions: 'Gateway.use', reauthConfirmed: true }
    )
    const denyPairing = buildMeshPeerAdminAction(
      { peerId: pairing.remote_peer_id, nodeName: pairing.remote_node_name, pendingPairing: pairing },
      'deny',
      { reason: 'Code mismatch', reauthConfirmed: true }
    )
    const approve = buildMeshPeerAdminAction(
      { peerId: 'peer-kitchen', nodeName: 'Kitchen node' },
      'approve',
      { reason: 'Fingerprint verified out of band', permissions: 'Gateway.use, TTS.use', reauthConfirmed: true }
    )
    const deny = buildMeshPeerAdminAction(
      { peerId: 'peer-cabin', nodeName: 'Cabin node' },
      'deny',
      { reason: 'Fingerprint mismatch' }
    )
    const remove = buildMeshPeerAdminAction(
      { peerId: 'peer-lab', nodeName: 'Lab node' },
      'remove',
      { reason: 'Retire test peer', revokeToken: false, reauthConfirmed: true }
    )

    expect(approvePairing).toEqual(expect.objectContaining({
      methodId: 'Auth.PairingApprove',
      payload: { code: '654321', permissions: ['Gateway.use'], is_admin: false },
      affectedResources: ['pairing:pairing-exact', 'peer:peer-kitchen', 'device:Kitchen tablet'],
      path: '/api/Auth/PairingApprove'
    }))
    expect(denyPairing).toEqual(expect.objectContaining({
      methodId: 'Auth.PairingDeny',
      payload: { code: '654321', reason: 'Code mismatch' },
      path: '/api/Auth/PairingDeny'
    }))
    expect(approve).toEqual(expect.objectContaining({
      methodId: 'Auth.MeshApprovePeer',
      payload: { peer_id: 'peer-kitchen', permissions: ['Gateway.use', 'TTS.use'] },
      reason: 'Fingerprint verified out of band',
      reauthConfirmed: true,
      affectedResources: ['mesh-peer:peer-kitchen', 'peer:Kitchen node'],
      path: '/api/Auth/MeshApprovePeer'
    }))
    expect(deny).toEqual(expect.objectContaining({
      methodId: 'Auth.MeshDenyPeer',
      payload: { peer_id: 'peer-cabin' },
      path: '/api/Auth/MeshDenyPeer'
    }))
    expect(remove).toEqual(expect.objectContaining({
      methodId: 'Auth.MeshRemovePeer',
      payload: { peer_id: 'peer-lab', revoke_token: false },
      path: '/api/Auth/MeshRemovePeer'
    }))
    expect(JSON.stringify([approvePairing, denyPairing, approve, deny, remove])).not.toContain('"confirmed":true')
    expect(parseMeshPermissionList('Gateway.use, TTS.use\nScheduler.use')).toEqual(['Gateway.use', 'TTS.use', 'Scheduler.use'])
  })

  it('maps mesh disabled, denied, degraded, and loading states without faking backend truth', async () => {
    const disabledSnapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport() }),
      meshRoute({ disabled: true, state: 'unsupported', explanation: 'Gateway.GetMeshStatus is not routeable.' })
    )
    expect(disabledSnapshot.loadState).toBe('service-unavailable')
    expect(disabledSnapshot.error).toContain('Capability unavailable')

    const deniedSnapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport().fail('Auth.MeshListPeers', 'permission', 'Auth denied') }),
      meshRoute()
    )
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(deniedSnapshot.error).toContain('denied')

    const degradedSnapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport().lose('Gateway.GetWebRTCDiagnostics', 'diagnostics down') }),
      meshRoute()
    )
    expect(degradedSnapshot.loadState).toBe('degraded')
    expect(degradedSnapshot.warnings.join(' ')).toContain('Could not connect to this Aurora device')

    const deviceDegradedSnapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport().fail('Auth.ListDevices', 'unavailable_service', 'devices down') }),
      meshRoute()
    )
    expect(deviceDegradedSnapshot.loadState).toBe('degraded')
    expect(deviceDegradedSnapshot.warnings.join(' ')).toContain('Could not connect to this Aurora device')
    expect(deviceDegradedSnapshot.peers.length).toBeGreaterThan(0)
  })

  it('builds WebRTC ICE diagnostics from SDK WebRTC, mesh, and capability status', async () => {
    const snapshot = await buildMeshDiagnosticsSnapshot(new Aurora({ transport: new MockAuroraTransport() }), meshRoute())

    expect(snapshot.loadState).toBe('degraded')
    expect(snapshot.localMeshPeerId).toBe('local-peer')
    expect(snapshot.secretsRedacted).toBe(true)
    expect(snapshot.signalingState).toBe('available-remote')
    expect(snapshot.connectedPeerCount).toBe(1)
    expect(snapshot.transportRows[0]).toEqual(
      expect.objectContaining({
        peerId: 'stable-peer',
        signalingPeerId: 'session-peer',
        state: 'available-remote',
        authState: 'authenticated',
        dataChannelState: 'open',
        routeQuality: 'healthy'
      })
    )
    expect(snapshot.routeRows.map((row) => row.module)).toEqual(expect.arrayContaining(['TTS', 'Scheduler']))
    expect(snapshot.routeRows.find((row) => row.module === 'TTS')?.blockers.join(' ')).toContain('stale_provider')
    expect(snapshot.recentErrors[0]?.code).toBe('rpc_timeout')
    expect(snapshot.supportBundleState).toBe('available-local')
    expect(snapshot.supportBundleCorrelationId).toBe(supportBundleFixture.correlation_id)
    expect(snapshot.supportBundleAuditReceipt).toBe(supportBundleFixture.audit_receipt)
    expect(snapshot.supportBundleServiceCount).toBe(supportBundleFixture.services.length)
    expect(snapshot.serviceProbeRows.map((row) => row.name)).toEqual(expect.arrayContaining(['Gateway service probe']))
    expect(snapshot.nativeCapabilityRows.map((row) => row.name)).toContain('native_capability_manifest')
    expect(snapshot.sidecarLogRows.map((row) => row.name)).toContain('gateway_sidecar_logs')
    expect(snapshot.frontendLogRows.map((row) => row.name)).toContain('Frontend errors/logs')
    expect(snapshot.liveProbes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining(['Gateway route registry', 'Mesh peer metrics', 'Diagnostics bundle contract'])
    )
    expect(snapshot.redactionRows.find((row) => row.label === 'Credential values')?.value).toBe(100)
    expect(snapshot.redactionRows.find((row) => row.label === 'Audio capture data')?.value).toBe(100)
    expect(snapshot.timelineRows.map((row) => row.title)).toEqual(expect.arrayContaining(['Tooling.ExecuteTool', 'diagnostics.support_bundle.exported']))
  })

  it('redacts diagnostic credentials, API keys, and raw-audio payload status before rendering', () => {
    const route = meshRoute({ disabled: true, explanation: 'authorization=Bearer route-secret raw audio payload=bytes' })
    const webrtc = cloneFixture(webrtcDiagnosticsFixture)
    webrtc.recent_errors = [
      {
        timestamp: '2026-06-19T00:00:00Z',
        code: 'rpc_timeout',
        message: 'Authorization: Bearer transport-secret token=secret-token audio_buffer=base64 raw audio payload=pcm',
        peer_id: 'peer-token=secret-peer'
      }
    ]
    const mesh = cloneFixture(meshStatusFixture)
    mesh.routes[0]!.reason = 'fallback used because api_key=secret-key'
    mesh.routes[0]!.providers[1]!.reason = 'raw-audio payload=bytes password=secret'
    mesh.compatibility_failures = [
      {
        peer_id: 'peer-den',
        module: 'Tooling',
        direction: 'local',
        reason: 'credential=mesh-secret'
      }
    ]
    const snapshot = meshDiagnosticsSnapshotFromResults({
      route,
      webrtc: { data: webrtc, error: 'Gateway token=secret-token unavailable' },
      mesh: { data: mesh, error: 'mesh secret=mesh-secret unavailable' },
      catalog: { data: null, error: 'catalog api_key=secret-key unavailable' }
    })

    expect(redactDiagnosticText('Authorization: Bearer secret-token audio_buffer=abc raw audio payload=pcm')).not.toContain('secret-token')
    for (const leaked of ['secret-token', 'transport-secret', 'secret-key', 'mesh-secret', 'secret-peer', 'audio_buffer=base64', 'raw audio payload=pcm']) {
      expect(snapshot.errors.join(' ')).not.toContain(leaked)
      expect(snapshot.warnings.join(' ')).not.toContain(leaked)
      expect(snapshot.recentErrors.map((error) => error.message).join(' ')).not.toContain(leaked)
    }
  })

  it('maps WebRTC diagnostics empty, denied, and SDK error states with repair status', async () => {
    const noPeers = cloneFixture(webrtcDiagnosticsFixture)
    noPeers.peers = []
    noPeers.connected_peer_count = 0
    noPeers.authenticated_peer_count = 0
    noPeers.started = false
    const emptySnapshot = meshDiagnosticsSnapshotFromResults({
      route: meshRoute(),
      webrtc: { data: noPeers, error: null },
      mesh: { data: { ...cloneFixture(meshStatusFixture), peers: [], routes: [], compatibility_failures: [] }, error: null },
      catalog: { data: capabilityCatalogFixture, error: null }
    })
    expect(emptySnapshot.loadState).toBe('degraded')
    expect(emptySnapshot.transportRows).toHaveLength(0)
    expect(emptySnapshot.warnings.join(' ')).toContain('WebRTC runtime is not started')

    const deniedSnapshot = await buildMeshDiagnosticsSnapshot(
      new Aurora({ transport: new MockAuroraTransport().fail('Gateway.GetWebRTCDiagnostics', 'permission', 'Gateway denied') }),
      meshRoute()
    )
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(deniedSnapshot.errors.join(' ')).toContain('Gateway denied')

    const unavailableSnapshot = await buildMeshDiagnosticsSnapshot(
      new Aurora({
        transport: MockAuroraTransport.empty()
          .fail('Gateway.GetWebRTCDiagnostics', 'unavailable_service', 'diagnostics down')
          .fail('Gateway.GetMeshStatus', 'unavailable_service', 'mesh down')
          .fail('Gateway.GetCapabilityCatalog', 'unavailable_service', 'catalog down')
      }),
      meshRoute()
    )
    expect(unavailableSnapshot.loadState).toBe('unavailable')
    expect(unavailableSnapshot.signalingRepair).toContain('Repair Gateway.GetWebRTCDiagnostics')
  })

  it('reports the configured thin transport as enabled and its expected peer as offline', async () => {
    const unavailable = await buildMeshDiagnosticsSnapshot(
      new Aurora({
        transport: MockAuroraTransport.empty()
          .lose('Gateway.GetWebRTCDiagnostics', 'WebRTC mesh transport is not connected')
          .lose('Gateway.GetMeshStatus', 'WebRTC mesh transport is not connected')
          .lose('Gateway.GetCapabilityCatalog', 'WebRTC mesh transport is not connected')
          .lose('Gateway.GetSupportBundle', 'WebRTC mesh transport is not connected'),
      }),
      meshRoute(),
    )
    const snapshot = reconcileMeshDiagnosticsWithThinPeer(unavailable, {
      state: 'failed',
      connectionMode: 'webrtc-only',
      expectedStablePeerId: 'peer-host',
      nodeName: 'Aurora host',
      icePathCategory: 'unknown',
      protocolCapabilities: [],
      reconnectCount: 2,
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      sentFragmentCount: 0,
      receivedFragmentCount: 0,
      updatedAt: '2026-07-28T00:00:00Z',
      status: 'failed',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    })

    expect(snapshot.loadState).toBe('degraded')
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.started).toBe(true)
    expect(snapshot.signalingEvidence).toContain('peer is offline')
    expect(snapshot.signalingRepair).toContain('WebRTC remains enabled')
    expect(snapshot.errors).toEqual([])
    expect(snapshot.transportRows).toEqual([
      expect.objectContaining({
        peerId: 'peer-host',
        nodeName: 'Aurora host',
        state: 'stale',
        connectionState: 'offline',
      }),
    ])
  })

  it('builds mesh peer AdminAction requests with typed method paths and redacted scopes', () => {
    const peer = { peerId: 'peer-kitchen', nodeName: 'Kitchen node' }
    const approve = buildMeshPeerAdminAction(peer, 'approve', {
      reason: 'Approve expected kitchen peer',
      permissions: 'Gateway.use, TTS.use\nTooling.use',
      reauthConfirmed: true
    })
    const deny = buildMeshPeerAdminAction(peer, 'deny', { reason: 'Wrong peer', reauthConfirmed: true })
    const remove = buildMeshPeerAdminAction(peer, 'remove', { reason: 'Retire peer', revokeToken: false, reauthConfirmed: true })

    expect(parseMeshPermissionList('Gateway.use, Auth.use\nDB.use')).toEqual(['Gateway.use', 'Auth.use', 'DB.use'])
    expect(approve).toEqual(
      expect.objectContaining({
        methodId: 'Auth.MeshApprovePeer',
        path: '/api/Auth/MeshApprovePeer',
        reauthConfirmed: true,
        reason: 'Approve expected kitchen peer',
        affectedResources: ['mesh-peer:peer-kitchen', 'peer:Kitchen node'],
        payload: { peer_id: 'peer-kitchen', permissions: ['Gateway.use', 'TTS.use', 'Tooling.use'] }
      })
    )
    expect(deny).toEqual(
      expect.objectContaining({
        methodId: 'Auth.MeshDenyPeer',
        path: '/api/Auth/MeshDenyPeer',
        payload: { peer_id: 'peer-kitchen' }
      })
    )
    expect(remove).toEqual(
      expect.objectContaining({
        methodId: 'Auth.MeshRemovePeer',
        path: '/api/Auth/MeshRemovePeer',
        payload: { peer_id: 'peer-kitchen', revoke_token: false }
      })
    )
    expect(meshPeerErrorMessage(new AuroraError({ code: 'unsupported_feature', message: 'missing' }))).toContain('cannot use that feature yet')
  })

  it('builds route policy explain state matrix through Aurora route APIs', async () => {
    const snapshot = await buildRoutePolicySnapshot(new Aurora({ transport: new MockAuroraTransport() }), meshRoute())

    expect(snapshot.loadState).toBe('degraded')
    expect(snapshot.scenarios.map((scenario) => scenario.scenario.id)).toEqual([
      'assistant_prompt',
      'tool_call',
      'rag_query',
      'audio_session',
      'model_runtime',
      'scheduler_job',
      'admin_action'
    ])
    expect(snapshot.scenarios.find((scenario) => scenario.scenario.id === 'tool_call')?.evaluation?.privacyClass).toBe('admin-critical')
    expect(snapshot.scenarios.find((scenario) => scenario.scenario.id === 'rag_query')?.scenario.selector).toEqual({ resource_id: 'rag:home-lab' })
    expect(snapshot.scenarios.find((scenario) => scenario.scenario.id === 'audio_session')?.evaluation?.privacyClass).toBe('raw-audio')
    expect(snapshot.scenarios.find((scenario) => scenario.scenario.id === 'scheduler_job')?.evaluation?.repairPath).toContain('selector')
    expect(snapshot.policyCapabilityReason).toContain('Gateway.ExplainRoute')
    expect(snapshot.configCapabilityReason).toContain('Config.Set')
  })

  it('builds the route policy matrix with one shared capability catalog request', async () => {
    const transport = new RecordingMockAuroraTransport()
    await buildRoutePolicySnapshot(new Aurora({ transport }), meshRoute())

    const methods = transport.requests.map((request) => request.method)
    expect(methods.filter((method) => method === 'Gateway.GetCapabilityCatalog')).toHaveLength(1)
    expect(methods.filter((method) => method === 'Gateway.ExplainRoute')).toHaveLength(routePolicyScenarios().length)
  })

  it('keeps route policy SDK failures visible and disabled', async () => {
    const transport = new MockAuroraTransport()
      .fail('Gateway.ExplainRoute', 'unavailable_service', 'route explain down')
      .fail('Gateway.GetCapabilityCatalog', 'permission', 'catalog denied')
    const snapshot = await buildRoutePolicySnapshot(new Aurora({ transport }), meshRoute())

    expect(snapshot.loadState).toBe('denied')
    expect(snapshot.error).toContain('Route explain')
    expect(snapshot.canEditPolicy).toBe(false)
  })

  it('serializes route policy draft to schema-backed outbound mesh routing config', () => {
    const change = routePolicyDraftChange({
      ...routePolicyDraft(),
      module: 'TTS',
      allowedProviderPeerIds: 'peer-a, peer-b',
      deniedPeers: 'peer-c',
      requiredProviderFeatureIds: 'speech-output, streaming-output',
      requiredProviderCapabilityTags: 'synthesize, low-latency',
      minimumVersion: '0.3.0'
    })

    expect(change.key_path).toBe('services.tts.mesh_routing')
    expect(change.value).toEqual({
      require_explicit_selector: true,
      allowed_provider_peer_ids: ['peer-a', 'peer-b'],
      required_provider_feature_ids: ['speech-output', 'streaming-output'],
      required_provider_capability_tags: ['synthesize', 'low-latency'],
      min_version: '0.3.0',
      fallback: 'local'
    })
    expect(routePolicyScenarios().map((scenario) => scenario.id)).toContain('admin_action')
  })

  it('renders admin SDK errors as unavailable disabled state without inventing service health', async () => {
    const client = new Aurora({ transport: MockAuroraTransport.empty().lose('Gateway.GetRegistry', 'registry offline') })
    await expect(buildAdminOverviewSnapshot(client)).rejects.toThrow(/registry offline/)
  })

  it('keeps assistant stop capability disabled until Orchestrator.Interrupt status exists', async () => {
    const snapshot = await buildShellSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const assistantRoute = route(snapshot, 'assistant')
    const controlsWithoutInterrupt = assistantControlsForRoute(assistantRoute, undefined, true)

    expect(controlsWithoutInterrupt.canCancel).toBe(false)
    expect(controlsWithoutInterrupt.cancelReason).toContain('Stop is unavailable')

    const interruptRoute = {
      ...assistantRoute,
      item: {
        ...assistantRoute.item,
        id: 'assistant-cancel',
        capabilityMethod: 'Interrupt'
      },
      disabled: false,
      blockers: [],
      state: 'available-local' as const
    }
    const controlsWithInterrupt = assistantControlsForRoute(assistantRoute, interruptRoute, true)

    expect(controlsWithInterrupt.canCancel).toBe(true)
    expect(controlsWithInterrupt.cancelReason).toContain('Stop is available')
  })

  it('accumulates assistant stream deltas without replacing backend text with local-only state', () => {
    const message = {
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Waiting for Aurora...',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const
    }

    const first = applyAssistantStreamDelta(message, streamUpdate('Hel'))
    const second = applyAssistantStreamDelta(first, streamUpdate('lo'))

    expect(first.text).toBe('Hel')
    expect(second.text).toBe('Hello')
    expect(second.status).toBe('streaming')
  })

  it('consumes structured tool updates and ignores TTS audio chunks as assistant text', () => {
    const pending = {
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Waiting for Aurora...',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const
    }
    const toolUpdated = applyAssistantToolUpdate(pending, {
      ...streamUpdate(''),
      kind: 'tool' as const,
      eventId: 'tool-event-1',
      text: 'Tool call requested',
      textDelta: '',
      tool: {
        id: 'call-1',
        name: 'Calendar.CreateEvent',
        status: 'running',
        riskClass: 'requires-approval',
        target: 'local calendar',
        dataLeavesDevice: false,
        summary: 'Create a local calendar event.',
        payloadPreview: { title: 'Standup' },
        resultPreview: null
      }
    })

    expect(toolUpdated.text).toContain('using a tool')
    expect(toolUpdated.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call-1',
        name: 'Calendar.CreateEvent',
        sessionId: 'session-1',
        status: 'running',
        riskClass: 'requires-approval',
        target: 'local calendar',
        dataLeavesDevice: false,
        payloadPreview: { title: 'Standup' }
      })
    ])

    const withText = { ...pending, text: 'Final answer already visible.' }
    const audioUpdated = applyAssistantAudioChunkUpdate(withText, {
      ...streamUpdate(''),
      kind: 'tts_audio_chunk' as const,
      text: '',
      textDelta: '',
      ttsAudio: {
        chunkId: 'chunk-1',
        sequence: 1,
        audioData: 'UklGRg==',
        encoding: 'base64',
        mimeType: 'audio/wav',
        sampleRate: 24000,
        channels: 1,
        durationMs: 90,
        final: false
      }
    })

    expect(audioUpdated.text).toBe('Final answer already visible.')
    expect(audioUpdated.status).toBe('sent')
  })


  it('keeps same-name tool calls distinct by stable ids and treats completed as drainable', () => {
    const pending = {
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Waiting for Aurora...',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const
    }

    const firstTool = applyAssistantToolUpdate(pending, {
      ...streamUpdate(''),
      kind: 'tool' as const,
      eventId: 'tool-event-a',
      tool: {
        id: 'tool-call-a',
        name: 'Search.Web',
        status: 'running',
        riskClass: null,
        target: null,
        dataLeavesDevice: false,
        summary: 'First search',
        payloadPreview: { query: 'alpha' },
        resultPreview: null
      }
    })
    const secondTool = applyAssistantToolUpdate(firstTool, {
      ...streamUpdate(''),
      kind: 'tool' as const,
      eventId: 'tool-event-b',
      tool: {
        id: 'tool-call-b',
        name: 'Search.Web',
        status: 'running',
        riskClass: null,
        target: null,
        dataLeavesDevice: false,
        summary: 'Second search',
        payloadPreview: { query: 'beta' },
        resultPreview: null
      }
    })

    expect(secondTool.toolCalls).toHaveLength(2)
    expect(secondTool.toolCalls?.map((tool) => tool.id)).toEqual(['tool-call-a', 'tool-call-b'])
    expect(isAssistantStreamHardTerminal({ kind: 'completed' })).toBe(false)
    expect(isAssistantStreamHardTerminal({ kind: 'failed' })).toBe(true)
  })

  it('preserves and updates tool call cards when final assistant text arrives', () => {
    const pending = applyAssistantToolUpdate({
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Waiting for Aurora...',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const
    }, {
      ...streamUpdate(''),
      kind: 'tool' as const,
      eventId: 'tool-event-running',
      tool: {
        id: 'tool-call-search',
        name: 'duckduckgo_results_json',
        status: 'running',
        riskClass: 'backend-evaluated',
        target: 'openai',
        dataLeavesDevice: false,
        summary: 'Tool execution is running.',
        payloadPreview: { query: { text: 'latest news in Egypt' } },
        resultPreview: null,
        error: null
      }
    })
    const completed = applyAssistantToolUpdate(pending, {
      ...streamUpdate(''),
      kind: 'tool' as const,
      eventId: 'tool-event-completed',
      tool: {
        id: 'tool-call-search',
        name: 'duckduckgo_results_json',
        status: 'completed',
        riskClass: 'backend-evaluated',
        target: 'openai',
        dataLeavesDevice: false,
        summary: 'Tool execution completed.',
        payloadPreview: { query: { text: 'latest news in Egypt' } },
        resultPreview: { count: 3 },
        error: null
      }
    })
    const terminal = applyAssistantTerminalUpdate(completed, {
      ...streamUpdate('Here are the results.'),
      kind: 'completed' as const,
      text: 'Here are the results.',
      textDelta: ''
    })

    expect(terminal.text).toBe('Here are the results.')
    expect(terminal.toolCalls).toEqual([
      expect.objectContaining({
        id: 'tool-call-search',
        status: 'completed',
        payloadPreview: { query: { text: 'latest news in Egypt' } },
        resultPreview: { count: 3 }
      })
    ])
  })

  it('keeps substantive assistant text when a terminal update has no text', () => {
    const completedTool = applyAssistantToolUpdate({
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'No active scheduled tasks found on aurora-2.',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const
    }, {
      ...streamUpdate(''),
      kind: 'tool' as const,
      eventId: 'tool-event-completed',
      tool: {
        id: 'tool-call-list-schedules',
        name: 'aurora-2.list_scheduled_tasks_tool',
        status: 'completed',
        riskClass: 'backend-evaluated',
        target: 'aurora-2',
        dataLeavesDevice: false,
        summary: 'Tool execution completed.',
        payloadPreview: null,
        resultPreview: { taskCount: 0 },
        error: null
      }
    })
    const terminal = applyAssistantTerminalUpdate(completedTool, {
      ...streamUpdate(''),
      kind: 'completed' as const,
      text: '',
      textDelta: ''
    })

    expect(terminal.text).toBe('No active scheduled tasks found on aurora-2.')
    expect(terminal.status).toBe('sent')
    expect(terminal.toolCalls).toEqual([
      expect.objectContaining({
        id: 'tool-call-list-schedules',
        status: 'completed',
        resultPreview: { taskCount: 0 }
      })
    ])
  })

  it('keeps a cancelled assistant message from being overwritten by later stream events', () => {
    const cancelled = {
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Stopped by user.',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'cancelled' as const
    }
    const completed = {
      ...streamUpdate('Final response'),
      kind: 'completed' as const,
      text: 'Final response',
      textDelta: 'Final response'
    }

    expect(applyAssistantStreamDelta(cancelled, streamUpdate('late delta'))).toEqual(cancelled)
    expect(applyAssistantTerminalUpdate(cancelled, completed)).toEqual(cancelled)
  })

  it('filters the tool catalog by category and search text', () => {
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: 'mock' })
    const categories = buildToolCategories(tools)

    expect(categories.map((category) => category.label)).toEqual(expect.arrayContaining([
      'All',
      'Read-only',
      'Mutating',
      'External',
      'Admin'
    ]))
    expect(filterTools(tools, 'external', 'email').map((tool) => tool.name)).toEqual(['Send email draft'])
    expect(filterTools(tools, 'admin', 'garage').map((tool) => tool.name)).toEqual(['Open garage door'])
    expect(filterTools(tools, 'read', 'diagnostics').map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'diagnostics.serviceHealth',
      'Collect diagnostics bundle'
    ]))
    expect(filterTools(tools, 'mutating', 'Hardware.manage')).toEqual([])
    expect(filterTools(tools, 'admin', 'Hardware.manage').map((tool) => tool.name)).toEqual(['Open garage door'])
    expect(filterTools(tools, 'all', 'not-a-real-tool')).toEqual([])
  })

  it('covers provider selector, scoped approvals, dry-run-only, denied, expired, replay, and unavailable states', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const toolsRoute = enabledRoute(route(snapshot, 'tools'))
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })

    expect(tools.some((tool) => tool.state === 'provider-selector-required')).toBe(true)
    expect(tools.some((tool) => tool.approvalScopes.includes('session'))).toBe(true)
    expect(tools.some((tool) => tool.approvalScopes.includes('peer'))).toBe(true)
    expect(tools.some((tool) => tool.approvalScopes.includes('local-safe-tools'))).toBe(true)
    expect(tools.some((tool) => tool.state === 'dry-run-only')).toBe(true)
    expect(tools.some((tool) => tool.state === 'denied')).toBe(true)
    expect(tools.some((tool) => tool.state === 'expired')).toBe(true)
    expect(tools.some((tool) => tool.state === 'replay-rejected')).toBe(true)
    expect(tools.some((tool) => tool.state === 'unavailable')).toBe(true)
  })

  it('keeps high-risk tools disabled until AdminAction confirmation exists', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
    expect(tools.some((tool) => tool.requiresAdminAction)).toBe(true)
    expect(tools.some((tool) => tool.riskClass.includes('admin'))).toBe(true)
  })

  it('shows sensitive tool approval UI without direct execution', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
    expect(tools.some((tool) => tool.riskClass === 'external')).toBe(true)
    expect(tools.some((tool) => tool.state === 'unavailable')).toBe(true)
    expect(tools.some((tool) => tool.approvalScopes.includes('once'))).toBe(true)
  })

  it('submits tool denial through the SDK backend path and returns correlation status', async () => {
    let confirmationPayload: unknown = null
    const transport = new MockAuroraTransport({ fixtures: false }).register('Tooling.ConfirmExecution', (request) => {
      confirmationPayload = request.payload
      return {
        ok: true,
        approval_token: null,
        expires_at: null,
        policy_decision_id: 'policy-local-danger',
        correlation_id: 'corr-denied-ui',
        error: null
      }
    })
    const client = new Aurora({ transport })
    const tool = normalizeToolCatalog(toolCatalogFixture).find((candidate) => candidate.id === 'tool:local:filesystem.writeConfig')
    if (!tool) throw new Error('missing local dangerous tool fixture')

    const result = await submitToolDenialAction({
      client,
      tool,
      reason: 'User rejected risky config write'
    })

    expect(confirmationPayload).toMatchObject({
      approval_request_id: 'approval-local-danger',
      approve: false,
      reason: 'User rejected risky config write',
      correlation_id: 'corr-local-danger'
    })
    expect(result.approved).toBe(false)
    expect(result.correlationId).toBe('corr-denied-ui')
    expect(result.policyDecisionId).toBe('policy-local-danger')
  })

  it('surfaces SDK denial failures from the tool denial action', async () => {
    const client = new Aurora({
      transport: new MockAuroraTransport({ fixtures: false }).register('Tooling.ConfirmExecution', {
        ok: false,
        approval_token: null,
        expires_at: null,
        policy_decision_id: null,
        correlation_id: 'corr-denied-error',
        error: 'approval_denied'
      })
    })
    const tool = normalizeToolCatalog(toolCatalogFixture).find((candidate) => candidate.id === 'tool:local:filesystem.writeConfig')
    if (!tool) throw new Error('missing local dangerous tool fixture')

    await expect(submitToolDenialAction({
      client,
      tool,
      reason: 'User rejected risky config write'
    })).rejects.toMatchObject({
      code: 'permission',
      method: 'Tooling.ConfirmExecution',
      correlationId: 'corr-denied-error'
    })
  })

  it('blocks RouteSheet confirmation for privacy denied, unavailable, SDK error, and unconfirmed AdminAction states', () => {
    const denied = blockedRouteEvaluation('privacy-blocked')
    const deniedModel = buildRouteSheetViewModel({
      loadState: 'ready',
      evaluation: denied,
      error: null,
      selectedScope: 'request',
      adminActionState: 'not-required'
    })
    const adminModel = buildRouteSheetViewModel({
      loadState: 'ready',
      evaluation: allowedRouteEvaluation(),
      error: null,
      selectedScope: 'global',
      adminActionState: 'required'
    })
    const errorModel = buildRouteSheetViewModel({
      loadState: 'error',
      evaluation: null,
      error: routeSheetErrorMessage(new AuroraError({ code: 'timeout', message: 'slow route' })),
      selectedScope: 'request',
      adminActionState: 'not-required'
    })

    expect(deniedModel.canConfirm).toBe(false)
    expect(deniedModel.primaryReason).toContain('Choose the device or resource')
    expect(adminModel.canConfirm).toBe(false)
    expect(adminModel.primaryReason).toContain('Administrator confirmation')
    expect(errorModel.primaryReason).toContain('Connection lost')
  })

  it('distinguishes RouteSheet selector, consent, privacy indicator, native permission, and AdminAction states', () => {
    const privacyBlocked = blockedRouteEvaluation('privacy-blocked')
    const evaluation = {
      ...privacyBlocked,
      blockers: [
        ...privacyBlocked.blockers,
        {
          code: 'consent_required',
          message: 'Consent is required before raw audio leaves this node.',
          severity: 'error' as const,
          provider_id: 'mesh:orchestrator',
          peer_id: 'peer-remote',
          security_privacy: true
        },
        {
          code: 'privacy_indicator_required',
          message: 'Show the privacy indicator before streaming audio.',
          severity: 'error' as const,
          provider_id: 'mesh:orchestrator',
          peer_id: 'peer-remote',
          security_privacy: true
        },
        {
          code: 'native_permission_required',
          message: 'Native microphone permission is missing.',
          severity: 'error' as const,
          provider_id: null,
          peer_id: null,
          security_privacy: true
        }
      ]
    }

    const signals = routeSheetPolicySignals(evaluation, 'required')
    expect(signals.map((signal) => signal.id)).toEqual([
      'selector',
      'consent',
      'privacy-indicator',
      'native-permission',
      'admin-action'
    ])
    expect(Object.fromEntries(signals.map((signal) => [signal.id, signal.state]))).toEqual({
      selector: 'blocked',
      consent: 'blocked',
      'privacy-indicator': 'blocked',
      'native-permission': 'blocked',
      'admin-action': 'blocked'
    })
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'selector', label: 'Privacy selector', state: 'blocked' }),
      expect.objectContaining({ id: 'consent', label: 'Consent', state: 'blocked' }),
      expect.objectContaining({ id: 'privacy-indicator', label: 'Privacy indicator', state: 'blocked' }),
      expect.objectContaining({ id: 'native-permission', label: 'Device permission', state: 'blocked' }),
      expect.objectContaining({ id: 'admin-action', label: 'Admin approval', state: 'blocked' })
    ]))
    expect(signals.map((signal) => `${signal.label} ${signal.detail}`).join(' ')).not.toMatch(/\b(AdminAction|Native permission|fallback|provider)\b/i)

    const localPreferenceSignals = routeSheetPolicySignals({
      ...allowedRouteEvaluation(),
      explicitSelectorRequired: true
    }, 'not-required')
    expect(localPreferenceSignals.find((signal) => signal.id === 'selector')).toEqual(expect.objectContaining({
      state: 'preference',
      detail: 'A local destination preference is set; this route remains available.'
    }))
  })

  it('maps RouteSheet SDK error codes to user-facing messages', () => {
    const errorMessage = routeSheetErrorMessage(new AuroraError({ code: 'privacy_blocked', message: 'blocked' }))

    expect(errorMessage).toContain('required privacy choice')
  })

  it('renders memory namespaces, conversation history, provenance, and AdminAction-gated controls', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const model = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'peer-studio-gpu.memories',
      query: 'mesh pairing'
    })

    expect(model.selectedNamespace?.kind).toBe('remote-peer')
    expect(model.searchDecision).toBe('allowed')
    expect(model.searchItems[0]?.provenance.source_peer_id).toBe('peer-studio-gpu')
  })

  it('renders a real empty memory state instead of a generic capability report', async () => {
    const transport = new MockAuroraTransport()
      .register('DB.GetMessages', () => ({ messages: [], total: 0, has_more: false }))
      .register('DB.RAGListNamespaces', () => ({ namespaces: [] }))
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const model = await buildMemoryViewModel(client, memoryRoute)

    expect(model.loadState).toBe('ready')
    expect(model.namespaces).toEqual([])
    expect(model.conversations).toEqual([])
  })

  it('keeps local export/import/delete controls disabled behind AdminAction policy', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const memoryModel = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'main.memories',
      query: 'recent'
    })
    const ragModel = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'main.rag',
      query: 'context'
    })

    expect(memoryModel.actions.export.supported).toBe(true)
    expect(memoryModel.actions.export.disabled).toBe(true)
    expect(memoryModel.actions.export.reason).toContain('administrator or sharing approval')
    expect(memoryModel.actions.delete.supported).toBe(true)
    expect(memoryModel.actions.delete.disabled).toBe(true)
    expect(memoryModel.actions.delete.reason).toContain('administrator or sharing approval')
    expect(ragModel.actions.importPreview.supported).toBe(true)
    expect(ragModel.actions.importPreview.disabled).toBe(true)
    expect(ragModel.actions.importPreview.reason).toContain('administrator or sharing approval')
  })

  it('shows denied and stale memory namespace states without labeling them local', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const denied = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'peer-denied.secret',
      query: 'secrets'
    })
    const stale = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'peer-cabin-node.archive',
      query: 'archive'
    })

    expect(denied.selectedNamespace?.kind).toBe('denied')
    expect(denied.searchDecision).toBe('denied')
    expect(denied.denialReason).toContain('denied')
    expect(stale.selectedNamespace?.kind).toBe('stale')
    expect(stale.searchDecision).toBe('unavailable')
  })

  it('keeps memory SDK errors visible as route-scoped disabled state', async () => {
    const transport = new MockAuroraTransport().fail('DB.RAGListNamespaces', 'permission', 'DB permission denied')
    const client = new Aurora({ transport })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const model = await buildMemoryViewModel(client, memoryRoute, { query: 'anything' })

    expect(model.loadState).toBe('error')
    expect(model.error).toContain('denied')
  })
})

function route(snapshot: Awaited<ReturnType<typeof buildShellSnapshot>>, id: string) {
  const match = snapshot.routes.find((candidate) => candidate.item.id === id)
  if (match) return match
  // Embedded nav items (devices, config, contracts, plugins, pairing, diagnostics, data, native)
  // are resolvable via getAuroraNavItem but are not part of the primary snapshot.routes list.
  // Synthesize a route from the nav item so route()-based screens can still be exercised.
  const navItem = getAuroraNavItem(id)
  if (!navItem) throw new Error(`missing route ${id}`)
  return {
    item: navItemSnapshot(navItem),
    state: navItem.fallbackState,
    explanation: 'Embedded route resolved from Aurora nav catalog.',
    providerLabel: `${navItem.capabilityModule}.${navItem.capabilityMethod ?? 'status'}`,
    blockers: [],
    repairActions: [{ id: 'retry', label: 'Retry connection', href: navItem.href, disabled: false, reason: 'Reload the capability snapshot.' }],
    candidateProviders: [],
    evidenceSources: ['Aurora nav catalog'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: navItem.fallbackState !== 'unsupported',
    disabled: navItem.fallbackState === 'unsupported' || navItem.fallbackState === 'privacy-blocked',
    requiresAdminAction: navItem.methodType === 'manage'
  }
}

function shellRouteCopySurface(
  routes: Array<Awaited<ReturnType<typeof buildShellSnapshot>>['routes'][number] | null>
): string {
  return routes
    .filter((candidate): candidate is Awaited<ReturnType<typeof buildShellSnapshot>>['routes'][number] => Boolean(candidate))
    .flatMap((candidate) => [
      candidate.providerLabel,
      candidate.explanation,
      ...candidate.repairActions.flatMap((action) => [action.label, action.reason]),
      ...candidate.candidateProviders.flatMap((provider) => [
        provider.label,
        provider.reason,
        provider.requiredAction ?? ''
      ])
    ])
    .join(' ')
}

function productionAnchorAliasPresent(sourceText: string, anchor: string): boolean {
  if (anchor === 'Welcome to Aurora') return sourceText.includes('PRODUCT_COPY.onboarding.title')
  if (anchor === 'First-run setup') return sourceText.includes('First step')
  if (anchor === 'setup modes') return sourceText.includes('Aurora setup choice')
  if (anchor === 'Use an invite to connect this device.') {
    return sourceText.includes('Use an invite or address to connect this device.')
  }
  return false
}

function adminServicesTransport(): MockAuroraTransport {
  const transport = new MockAuroraTransport()
  transport.register('Gateway.GetServices', () => adminServicesFixture())
  transport.register('Gateway.GetRegistry', () => adminRegistryFixture())
  transport.register('Gateway.GetCapabilityCatalog', () => adminCapabilityCatalog())
  return transport
}

function emptyAdminTransport(): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Gateway.GetServices', () => ({ mode: 'threads', services: [] }))
    .register('Gateway.GetRegistry', () => ({ modules: [], digest: 'empty', service_count: 0, method_count: 0 }))
    .register('Gateway.GetCapabilityCatalog', () => ({
      generated_at: '2026-06-25T00:00:00Z',
      local_peer_id: 'local-peer',
      local_node_name: 'local',
      providers: [],
      actions: [],
      resources: [],
      provider_index: {},
      action_index: {},
      secrets_redacted: true
    }))
}

function adminStateMatrixTransport(): MockAuroraTransport {
  const transport = adminServicesTransport()
  const catalog = adminCapabilityCatalog()
  const baseProvider = catalog.providers[0]!
  const baseAction = catalog.actions[0]!
  const modules = ['Denied', 'Stale', 'Audio', 'InternalOnly']
  catalog.providers = [
    provider(baseProvider, {
      provider_id: 'local:Gateway-degraded',
      module: 'Gateway',
      service_instance_id: 'gateway-degraded',
      reason_code: 'fallback_used',
      reason: 'Reduced Gateway service diagnostics.'
    }),
    provider(baseProvider, {
      provider_id: 'local:Denied',
      module: 'Denied',
      service_instance_id: 'denied-local',
      eligible: false,
      reason_code: 'policy_denied',
      reason: 'Current principal is denied.',
      policy: { ...baseProvider.policy, denial_reasons: ['policy_denied'] }
    }),
    provider(baseProvider, {
      provider_id: 'remote:Stale',
      module: 'Stale',
      service_instance_id: 'stale-remote',
      eligible: false,
      reason_code: 'stale_provider',
      reason: 'Provider heartbeat is stale.',
      freshness: { ...baseProvider.freshness, stale: true, last_probe_age_s: 900 }
    }),
    provider(baseProvider, {
      provider_id: 'remote:Audio',
      module: 'Audio',
      service_instance_id: 'audio-remote',
      eligible: false,
      reason_code: 'explicit_selector_required',
      reason: 'Audio action requires explicit selector.',
      policy: { ...baseProvider.policy, explicit_selector_required: true, selector_required: true, consent_required: true }
    })
  ]
  catalog.actions = [
    action(baseAction, catalog.providers[0]!, {
      action_id: 'gateway-degraded-services',
      method: 'GetServices',
      topic: 'Gateway.GetServices',
      bindability: 'degraded'
    }),
    action(baseAction, catalog.providers[1]!, {
      action_id: 'denied-use',
      method: 'Use',
      topic: 'Denied.Use',
      bindability: 'denied'
    }),
    action(baseAction, catalog.providers[2]!, {
      action_id: 'stale-use',
      method: 'Use',
      topic: 'Stale.Use',
      bindability: 'unavailable'
    }),
    action(baseAction, catalog.providers[3]!, {
      action_id: 'audio-use',
      method: 'Use',
      topic: 'Audio.Use',
      bindability: 'unavailable'
    })
  ]
  transport.register('Gateway.GetCapabilityCatalog', () => catalog)
  transport.register('Gateway.GetServices', () => ({
    mode: 'threads',
    services: modules.map((module) => service(module)).concat(service('Gateway'))
  }))
  transport.register('Gateway.GetRegistry', () => ({
    modules: modules.map((module) => registryModule(module, module === 'InternalOnly' ? 'internal' : 'external')).concat(registryModule('Gateway')),
    digest: 'matrix',
    service_count: modules.length + 1,
    method_count: modules.length + 1
  }))
  return transport
}

function adminServicesFixture(): GetServicesResponse {
  return {
    mode: 'threads',
    services: [
      service('Gateway', { capabilities: ['registry', 'services'], method_count: 2, instance_id: 'gateway-local' }),
      service('Supervisor', { capabilities: ['lifecycle'], method_count: 2, instance_id: 'supervisor-local' })
    ]
  }
}

function adminRegistryFixture(): GetRegistryResponse {
  return {
    modules: [
      {
        ...registryModule('Gateway'),
        methods: [
          method('Gateway', 'GetServices', 'use', 'external', ['Gateway.use']),
          method('Gateway', 'GetRegistry', 'use', 'external', ['Gateway.use'])
        ]
      },
      {
        ...registryModule('Supervisor'),
        methods: [
          method('Supervisor', 'RestartService', 'manage', 'external', ['Supervisor.manage']),
          method('Supervisor', 'StopService', 'manage', 'internal', ['Supervisor.manage'])
        ]
      }
    ],
    digest: 'admin',
    service_count: 2,
    method_count: 4
  }
}

function adminCapabilityCatalog(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const baseProvider = catalog.providers[0]!
  const baseAction = catalog.actions[0]!
  const gateway = provider(baseProvider, {
    provider_id: 'local:Gateway',
    module: 'Gateway',
    service_instance_id: 'gateway-local',
    reason: 'Gateway admin services are available.'
  })
  const supervisor = provider(baseProvider, {
    provider_id: 'local:Supervisor',
    module: 'Supervisor',
    service_instance_id: 'supervisor-local',
    reason: 'Supervisor restart is available through AdminAction.'
  })
  catalog.providers = [gateway, supervisor]
  catalog.actions = [
    action(baseAction, gateway, {
      action_id: 'gateway-get-services',
      method: 'GetServices',
      topic: 'Gateway.GetServices'
    }),
    action(baseAction, gateway, {
      action_id: 'gateway-get-registry',
      method: 'GetRegistry',
      topic: 'Gateway.GetRegistry'
    }),
    action(baseAction, supervisor, {
      action_id: 'supervisor-restart',
      method: 'RestartService',
      topic: 'Supervisor.RestartService',
      policy: {
        ...supervisor.policy,
        required_permissions: ['Supervisor.manage'],
        operation_class: 'admin',
        safety_class: 'admin',
        approval_required: true
      }
    })
  ]
  catalog.provider_index = { Gateway: ['local:Gateway'], Supervisor: ['local:Supervisor'] }
  catalog.action_index = {
    'Gateway.GetServices': ['gateway-get-services'],
    'Gateway.GetRegistry': ['gateway-get-registry'],
    'Supervisor.RestartService': ['supervisor-restart']
  }
  return catalog
}

function service(
  module: string,
  overrides: Partial<GetServicesResponse['services'][number]> = {}
): GetServicesResponse['services'][number] {
  return {
    module,
    version: '0.1.0',
    summary: `${module} service`,
    capabilities: [module.toLowerCase()],
    method_count: 1,
    last_seen: '2026-06-25T00:00:00Z',
    status: 'healthy',
    instance_id: `${module.toLowerCase()}-local`,
    ...overrides
  }
}

function registryModule(
  module: string,
  exposure: 'external' | 'internal' = 'external'
): GetRegistryResponse['modules'][number] {
  return {
    module,
    version: '0.1.0',
    summary: `${module} service`,
    capabilities: [module.toLowerCase()],
    methods: [method(module, 'Use', 'use', exposure, [`${module}.use`])]
  }
}

function method(
  module: string,
  name: string,
  methodType: 'use' | 'manage',
  exposure: 'external' | 'internal',
  permissions: string[]
): GetRegistryResponse['modules'][number]['methods'][number] {
  return {
    name,
    summary: `${module} ${name}`,
    bus_topic: `${module}.${name}`,
    exposure,
    input_model: null,
    output_model: null,
    required_perms: permissions,
    method_type: methodType,
    input_schema: null,
    output_schema: null
  }
}

function pairingRoute(overrides: Partial<Awaited<ReturnType<typeof buildShellSnapshot>>['routes'][number]> = {}) {
  return {
    item: {
      id: 'pairing',
      label: 'Pairing',
      href: '/admin/pairing',
      capabilityModule: 'Auth',
      capabilityMethod: 'ListPendingPairings',
      methodType: 'manage',
      privacyClass: 'credential',
      fallbackState: 'unsupported',
      adminGated: true,
      expectedTask: 'ADM-011'
    },
    state: 'available-local',
    explanation: 'Backend catalog reports Auth.ListPendingPairings as routeable.',
    providerLabel: 'local / Auth.ListPendingPairings',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['capability-catalog'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: true,
    ...overrides
  } as Awaited<ReturnType<typeof buildShellSnapshot>>['routes'][number]
}

function meshRoute(overrides: Partial<Awaited<ReturnType<typeof buildShellSnapshot>>['routes'][number]> = {}) {
  return {
    item: {
      id: 'mesh',
      label: 'Mesh',
      href: '/mesh',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetMeshStatus',
      methodType: 'use',
      privacyClass: 'credential',
      fallbackState: 'unsupported',
      adminGated: false,
      expectedTask: 'MESH-001'
    },
    state: 'available-local',
    explanation: 'Backend catalog reports Gateway.GetMeshStatus and Auth.MeshListPeers as routeable.',
    providerLabel: 'local / Gateway.GetMeshStatus',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['capability-catalog'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
    ...overrides
  } as Awaited<ReturnType<typeof buildShellSnapshot>>['routes'][number]
}

function routePolicyDraft() {
  return {
    module: 'TTS',
    requireExplicitSelector: true,
    allowedProviderPeerIds: '',
    deniedPeers: '',
    requiredProviderFeatureIds: '',
    requiredProviderCapabilityTags: 'synthesize',
    minimumVersion: '',
    trustTier: 'paired',
    fallbackPolicy: 'local' as const,
    safetySensitiveClasses: 'admin-critical, raw-audio, credential',
    reason: 'Update mesh route policy',
    reauthConfirmed: true
  }
}

function emptyPairingQueue() {
  return {
    pairings: [],
    total: 0,
    expired_count: 0,
    secrets_redacted: true
  }
}

function pairingEntry(overrides: Partial<PendingPairingEntry> = {}): PendingPairingEntry {
  return {
    request_id: 'pair-1',
    code: '123456',
    device_name: 'Kitchen tablet',
    client_ip: '192.0.2.10',
    status: 'pending',
    expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-06-24T12:00:00Z',
    remote_peer_id: 'peer-kitchen',
    remote_node_name: 'Kitchen node',
    approved_by: null,
    denied_by: null,
    denied_reason: '',
    granted_permissions: [],
    granted_is_admin: false,
    ...overrides
  }
}

function streamUpdate(textDelta: string) {
  return {
    kind: 'delta' as const,
    eventId: 'event-1',
    messageId: 'message-1',
    sessionId: 'session-1',
    text: textDelta,
    textDelta,
    modelLabel: null,
    error: null,
    audit: {
      correlationId: 'corr-1',
      eventKind: 'assistant.delta',
      peerId: null,
      principalId: null,
      targetPeerId: null,
      method: 'Orchestrator.ExternalUserInput',
      busTopic: 'Orchestrator.ExternalUserInput',
      toolId: null,
      resourceId: null,
      status: null,
      transport: 'mock',
      redaction: {
        secretsRedacted: true,
        redactedFields: [],
        source: 'sdk' as const,
        warnings: []
      }
    },
    metadata: {},
    tool: null,
    ttsAudio: null
  }
}

function voiceStatusEvents(): VoiceRuntimeEvent[] {
  const audit = {
    correlationId: 'corr-voice-1',
    eventKind: 'voice.event',
    peerId: 'peer-local',
    principalId: null,
    targetPeerId: 'peer-kitchen',
    method: null,
    busTopic: null,
    toolId: null,
    resourceId: null,
    status: null,
    transport: 'mock',
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'backend' as const,
      warnings: []
    }
  }
  const base = {
    sessionId: 'voice-session-1',
    correlationId: 'corr-voice-1',
    sourcePeerId: 'peer-local',
    targetPeerId: 'peer-kitchen',
    targetDeviceId: 'mic-kitchen',
    consentDecision: 'approved',
    policyDecisionId: 'policy-voice-1',
    privacyClass: 'raw-audio',
    redacted: true,
    level: null,
    peak: null,
    bars: null,
    occurredAt: '2026-06-27T16:00:00Z',
    audit,
    raw: {}
  }
  return [
    { ...base, id: 'voice-partial', kind: 'transcription_partial', topic: 'STTCoordinator.Partial', state: 'processing', text: 'turn', reason: null },
    { ...base, id: 'voice-final', kind: 'transcription_final', topic: 'STTCoordinator.Final', state: 'processing', text: 'turn on lights', reason: null },
    { ...base, id: 'voice-tts', kind: 'tts_started', topic: 'TTS.Started', state: 'speaking', text: 'Turning on lights.', reason: null, privacyClass: 'personal' },
    { ...base, id: 'voice-denied', kind: 'audio_denied', topic: 'AudioSession.Events', state: 'denied', text: null, reason: 'policy_denied' }
  ]
}

function enabledRoute(match: ReturnType<typeof route>, overrides: Partial<ReturnType<typeof route>> = {}) {
  return {
    ...match,
    state: 'available-local' as const,
    disabled: false,
    providerLabel: 'local / Tooling.GetToolCatalog',
    blockers: [],
    routeable: true,
    ...overrides
  }
}

function voiceModeCatalog(variant: 'local' | 'remote-stt' | 'remote-denied' | 'stale-remote' = 'local'): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const baseProvider = catalog.providers[0]!
  const baseAction = catalog.actions[0]!
  const localTranscription = provider(baseProvider, {
    provider_id: 'local:Transcription',
    module: 'Transcription',
    service_instance_id: 'transcription-local',
    reason: 'Local transcription provider is available.'
  })
  const remoteTranscription = provider(baseProvider, {
    provider_id: 'mesh:studio:Transcription',
    peer_id: 'studio-peer',
    provider_kind: 'remote',
    node_name: 'Studio node',
    module: 'Transcription',
    service_instance_id: 'transcription-studio',
    reason: 'Remote transcription provider is eligible.'
  })
  const deniedTranscription = provider(remoteTranscription, {
    eligible: false,
    reason_code: 'policy_denied',
    reason: 'Remote transcription denied by peer policy.',
    policy: {
      ...remoteTranscription.policy,
      denial_reasons: ['policy_denied'],
      mesh_visible: true,
      trust_tier: 'paired'
    }
  })
  const staleTranscription = provider(remoteTranscription, {
    eligible: false,
    status: 'stale',
    reason_code: 'peer_disconnect',
    reason: 'Remote transcription peer disconnected.',
    freshness: {
      ...remoteTranscription.freshness,
      stale: true,
      last_probe_age_s: 900
    }
  })
  const wake = provider(baseProvider, {
    provider_id: 'local:WakeWord',
    module: 'WakeWord',
    service_instance_id: 'wake-local',
    reason: 'Foreground wake control is available locally.'
  })
  const ttsRemote = provider(baseProvider, {
    provider_id: 'mesh:kitchen:TTS',
    peer_id: 'kitchen-peer',
    provider_kind: 'remote',
    node_name: 'Kitchen node',
    module: 'TTS',
    service_instance_id: 'tts-kitchen',
    reason: 'Remote TTS synthesis provider is eligible.'
  })
  const transcriptionProvider = variant === 'remote-stt'
    ? remoteTranscription
    : variant === 'remote-denied'
      ? deniedTranscription
      : variant === 'stale-remote'
        ? staleTranscription
        : localTranscription

  catalog.providers = [transcriptionProvider, wake, ttsRemote]
  catalog.actions = [
    action(baseAction, transcriptionProvider, {
      action_id: `${transcriptionProvider.provider_id}:Transcribe`,
      method: 'Transcribe',
      bindability: variant === 'remote-denied' ? 'denied' : variant === 'stale-remote' ? 'unavailable' : 'available',
      policy: {
        ...transcriptionProvider.policy,
        required_permissions: ['Transcription.use'],
        resource_scope: 'raw-audio',
        mesh_visible: transcriptionProvider.provider_kind !== 'local',
        trust_tier: transcriptionProvider.provider_kind === 'local' ? 'local' : 'paired'
      },
      freshness: transcriptionProvider.freshness
    }),
    action(baseAction, wake, {
      action_id: 'local:WakeWord:ProcessAudio',
      method: 'ProcessAudio',
      policy: {
        ...wake.policy,
        required_permissions: ['WakeWord.use'],
        resource_scope: 'raw-audio'
      }
    }),
    action(baseAction, wake, {
      action_id: 'local:WakeWord:Control',
      method: 'Control',
      policy: {
        ...wake.policy,
        required_permissions: ['WakeWord.use'],
        resource_scope: 'raw-audio'
      }
    }),
    action(baseAction, ttsRemote, {
      action_id: 'mesh:kitchen:TTS:Synthesize',
      method: 'Synthesize',
      policy: {
        ...ttsRemote.policy,
        required_permissions: ['TTS.use'],
        mesh_visible: true,
        trust_tier: 'paired'
      }
    }),
    action(baseAction, ttsRemote, {
      action_id: 'mesh:kitchen:TTS:Stop',
      method: 'Stop',
      policy: {
        ...ttsRemote.policy,
        required_permissions: ['TTS.use'],
        mesh_visible: true,
        trust_tier: 'paired'
      }
    })
  ]
  catalog.provider_index = {
    Transcription: [transcriptionProvider.provider_id],
    WakeWord: [wake.provider_id],
    TTS: [ttsRemote.provider_id]
  }
  catalog.action_index = {
    'Transcription.Transcribe': [`${transcriptionProvider.provider_id}:Transcribe`],
    'WakeWord.ProcessAudio': ['local:WakeWord:ProcessAudio'],
    'WakeWord.Control': ['local:WakeWord:Control'],
    'TTS.Synthesize': ['mesh:kitchen:TTS:Synthesize'],
    'TTS.Stop': ['mesh:kitchen:TTS:Stop']
  }
  return catalog
}

function stateMatrixCatalog(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const baseProvider = catalog.providers[0]!
  const baseAction = catalog.actions[0]!
  const localServices = provider(baseProvider, {
    provider_id: 'local:Gateway-services',
    module: 'Gateway',
    service_instance_id: 'gateway-services',
    reason_code: 'fallback_used',
    reason: 'Service list is available through reduced diagnostics.'
  })
  const deniedConfig = provider(baseProvider, {
    provider_id: 'local:Config-denied',
    module: 'Config',
    service_instance_id: 'config-denied',
    eligible: false,
    reason_code: 'permission_denied',
    reason: 'Current principal lacks Config.manage.'
  })
  const blockedTooling = provider(baseProvider, {
    provider_id: 'mesh:tools',
    peer_id: 'tool-peer',
    provider_kind: 'remote',
    module: 'Tooling',
    service_instance_id: 'tooling-remote',
    eligible: false,
    reason_code: 'explicit_selector_required',
    reason: 'Remote tool catalog needs an explicit provider selector.'
  })
  const staleDb = provider(baseProvider, {
    provider_id: 'mesh:db',
    peer_id: 'db-peer',
    provider_kind: 'remote',
    module: 'DB',
    service_instance_id: 'db-remote',
    status: 'stale',
    eligible: false,
    reason_code: 'stale_provider',
    reason: 'DB provider heartbeat is stale.',
    freshness: { ...baseProvider.freshness, stale: true, last_probe_age_s: 900 }
  })

  catalog.providers = [...catalog.providers, localServices, deniedConfig, blockedTooling, staleDb]
  catalog.actions = [
    ...catalog.actions,
    action(baseAction, localServices, {
      action_id: 'gateway-services-degraded',
      method: 'GetServices',
      bindability: 'degraded',
      route_blockers: []
    }),
    action(baseAction, deniedConfig, {
      action_id: 'config-get-denied',
      method: 'Get',
      bindability: 'denied',
      policy: {
        ...baseAction.policy,
        required_permissions: ['Config.manage'],
        denial_reasons: ['permission_denied'],
        operation_class: 'admin',
        safety_class: 'admin'
      }
    }),
    action(baseAction, blockedTooling, {
      action_id: 'tooling-catalog-selector',
      method: 'GetToolCatalog',
      bindability: 'unavailable',
      route_blockers: ['explicit_selector_required'],
      policy: {
        ...baseAction.policy,
        required_permissions: ['Tooling.use'],
        explicit_selector_required: true,
        selector_required: true
      }
    }),
    action(baseAction, staleDb, {
      action_id: 'db-rag-stale',
      method: 'RAGSearch',
      bindability: 'unavailable',
      route_blockers: ['stale_provider'],
      freshness: staleDb.freshness,
      policy: { ...baseAction.policy, required_permissions: ['DB.use'] }
    })
  ]
  return catalog
}

function localSelectorRequiredRouteCatalog(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityGraphCatalogFixture)
  catalog.actions = catalog.actions.map((entry) => {
    if (entry.module !== 'Scheduler' || entry.method !== 'ListJobs' || entry.provider_kind !== 'local') {
      return entry
    }
    return {
      ...entry,
      action_id: 'scheduler-list-local-selector-required',
      bindability: 'available',
      route_blockers: [],
      policy: {
        ...entry.policy,
        explicit_selector_required: true,
        selector_required: true,
        consent_required: false,
        privacy_indicator_required: false,
        approval_required: false,
        denial_reasons: []
      },
      summary: 'Local scheduler list route requires explicit local provider confirmation, not a hard block.'
    }
  })
  return catalog
}

function provider(
  base: CapabilityProviderInfo,
  overrides: Partial<CapabilityProviderInfo>
): CapabilityProviderInfo {
  return {
    ...base,
    policy: { ...base.policy },
    freshness: { ...base.freshness },
    ...overrides
  }
}

function action(
  base: CapabilityActionInfo,
  providerInfo: CapabilityProviderInfo,
  overrides: Partial<CapabilityActionInfo>
): CapabilityActionInfo {
  const method = overrides.method ?? base.method
  return {
    ...base,
    action_id: `${providerInfo.provider_id}:${method}`,
    module: providerInfo.module,
    method,
    topic: `${providerInfo.module}.${method}`,
    provider_id: providerInfo.provider_id,
    peer_id: providerInfo.peer_id,
    provider_kind: providerInfo.provider_kind,
    service_instance_id: providerInfo.service_instance_id,
    selector: { peer_id: providerInfo.peer_id, module: providerInfo.module },
    route_blockers: providerInfo.eligible ? [] : [providerInfo.reason_code],
    summary: providerInfo.reason,
    policy: { ...providerInfo.policy },
    freshness: { ...providerInfo.freshness },
    ...overrides
  }
}

function allowedRouteEvaluation() {
  const route = cloneFixture(routeExplainFixture)
  route.selected_target = 'local'
  route.selected_provider_id = 'local:orchestrator'
  route.selected_peer_id = null
  route.selected_service_instance_id = 'orchestrator-local'
  route.selector_valid = true
  route.fallback_behavior = 'none'
  route.blockers = []
  route.security_privacy_blockers = []
  route.candidates = [
    {
      provider_id: 'local:orchestrator',
      peer_id: '',
      provider_kind: 'local',
      service_instance_id: 'orchestrator-local',
      module: 'Orchestrator',
      version: '1',
      included: true,
      selected: true,
      reason_code: 'selected',
      reason: 'Local Orchestrator route is eligible.',
      latency_ms: 8,
      active_calls: 0,
      max_concurrent: 4,
      available_capacity: 4,
      blockers: []
    }
  ]
  return evaluateRoutePolicy({
    route,
    catalog: null,
    topic: 'Orchestrator.ExternalUserInput',
    method: 'ExternalUserInput',
    payload: { message: 'summarize deployment', token: 'secret-token' },
    privacyClass: 'personal',
    transportKind: 'mock'
  })
}

function blockedRouteEvaluation(availability: 'privacy-blocked' | 'unsupported') {
  const route = cloneFixture(routeExplainFixture)
  route.selected_target = availability === 'privacy-blocked' ? 'remote' : 'none'
  route.selected_provider_id = availability === 'privacy-blocked' ? 'mesh:orchestrator' : null
  route.selected_peer_id = availability === 'privacy-blocked' ? 'peer-remote' : null
  route.selector_valid = availability !== 'privacy-blocked'
  route.selector_validation_code = availability === 'privacy-blocked' ? 'explicit_selector_required' : ''
  route.selector_validation_message = availability === 'privacy-blocked' ? 'Remote peer selector is required.' : ''
  route.fallback_behavior = 'none'
  route.candidates = availability === 'privacy-blocked'
    ? [
        {
          provider_id: 'mesh:orchestrator',
          peer_id: 'peer-remote',
          provider_kind: 'remote',
          service_instance_id: 'orchestrator-remote',
          module: 'Orchestrator',
          version: '1',
          included: false,
          selected: true,
          reason_code: 'explicit_selector_required',
          reason: 'Remote route requires explicit selector and trust scope.',
          latency_ms: 45,
          active_calls: 0,
          max_concurrent: 2,
          available_capacity: 1,
          blockers: []
        }
      ]
    : []
  route.blockers = [
    {
      code: availability === 'privacy-blocked' ? 'explicit_selector_required' : 'no_route',
      message: availability === 'privacy-blocked'
        ? 'Select the target peer/resource before execution.'
        : 'No route candidate is available for this request.',
      severity: 'error',
      provider_id: availability === 'privacy-blocked' ? 'mesh:orchestrator' : null,
      peer_id: availability === 'privacy-blocked' ? 'peer-remote' : null,
      security_privacy: availability === 'privacy-blocked'
    }
  ]
  route.security_privacy_blockers = [...route.blockers]
  return evaluateRoutePolicy({
    route,
    catalog: null,
    topic: 'Orchestrator.ExternalUserInput',
    method: 'ExternalUserInput',
    payload: { message: 'remote sensitive prompt' },
    privacyClass: availability === 'privacy-blocked' ? 'sensitive' : 'personal',
    transportKind: 'mock'
  })
}

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path, pattern)
    return pattern.test(entry.name) ? [path] : []
  })
}

function isAllowedAdapterFile(repoRoot: string, file: string): boolean {
  const rel = relative(repoRoot, file)
  return [
    'apps/aurora-web/app/aurora-client.ts',
    'apps/aurora-tauri/src/aurora-client.ts',
    'apps/aurora-tauri/src/local-data/tauri-local-data-invoke.ts',
    'apps/aurora-tauri/src/eventstream-smoke.tsx'
  ].includes(rel)
}

function deviceCatalogWithoutDelete(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityGraphCatalogFixture)
  catalog.actions = catalog.actions.filter((action) => action.topic !== 'Auth.DeleteDevice')
  delete catalog.action_index['Auth.DeleteDevice']
  return catalog
}
