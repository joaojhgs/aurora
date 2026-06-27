import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  AuroraError,
  MockAuroraTransport,
  androidNativeCapabilityManifestFixture,
  backupListFixture,
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  capabilityCatalogFixture,
  capabilityGraphCatalogFixture,
  cloneFixture,
  deploymentTopologyFixture,
  evaluateRoutePolicy,
  gatewayRegistryFixture,
  iosNativeCapabilityManifestFixture,
  modelRuntimeCatalogFixture,
  meshPeerListFixture,
  meshStatusFixture,
  normalizeToolCatalog,
  routeExplainFixture,
  schedulerJobsFixture,
  toolCatalogFixture,
  webrtcDiagnosticsFixture,
  type AdminOverviewManifest,
  type CapabilityActionInfo,
  type CapabilityCatalogResponse,
  type CapabilityProviderInfo,
  type DeploymentTopologyResponse,
  type GetRegistryResponse,
  type GetServicesResponse,
  type PendingPairingEntry
} from '@aurora/client'
import {
  AdminOverviewContent,
  AdminOverviewView,
  AdminPluginsView,
  AdminServicesView,
  AdminRbacView,
  AdminDevicesView,
  AdminAuditView,
  AdminSchedulerView,
  AppShell,
  AssistantView,
  BackupRestoreView,
  ConfigEditorView,
  ModelsView,
  MemoryView,
  OnboardingView,
  PairingQueueSurface,
  PairingQueueView,
  MeshDiagnosticsView,
  MeshPeersResource,
  MeshPeersView,
  RoutePolicyView,
  RouteSheet,
  buildAdminServicesSnapshot,
  buildAdminPluginsSnapshot,
  buildAdminRbacSnapshot,
  buildAdminDevicesSnapshot,
  buildAdminAuditSnapshot,
  buildAdminSchedulerSnapshot,
  buildAuditExport,
  buildDeviceDeleteAdminAction,
  buildRbacPermissionPatchAction,
  buildOnboardingViewModel,
  buildPairingAdminActionRequest,
  buildPairingQueueModel,
  buildMeshDiagnosticsSnapshot,
  buildMeshPeerAdminAction,
  buildMeshPeersSnapshot,
  buildRoutePolicySnapshot,
  buildRouteSheetViewModel,
  RouteMatrix,
  StateSurface,
  attachmentStatusFromBackend,
  attachmentToContextItem,
  applyAssistantStreamDelta,
  applyAssistantTerminalUpdate,
  assistantControlsForRoute,
  contextIngestOutcomeIndex,
  isAcceptedContextStatus,
  mapContextIngestOutcomesByPendingIndex,
  submitToolDenialAction,
  ToolApprovalPanel,
  assistantErrorMessage,
  backupErrorMessage,
  buildAssistantVoiceModel,
  buildMemoryViewModel,
  buildShellSnapshot,
  buildModelsViewModel,
  buildConfigEditorModel,
  buildSettingsPermissionsModel,
  errorShellSnapshot,
  snapshotFromGraph,
  parsePermissionList,
  pairingErrorMessage,
  meshPeerErrorMessage,
  meshDiagnosticsSnapshotFromResults,
  parseMeshPermissionList,
  routePolicyDraftChange,
  routePolicyFromRoute,
  routePolicyScenarios,
  routeSheetErrorMessage,
  SettingsPermissionsView
} from '../src/index'

describe('Aurora production shell', () => {
  it('builds route availability from AuroraClient capability catalog', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.evidenceSource).toContain('SDK')
    expect(snapshot.routes.some((route) => route.state === 'available-local')).toBe(true)
    expect(snapshot.routes.some((route) => route.state === 'privacy-blocked')).toBe(true)
    expect(snapshot.routes.some((route) => route.requiresAdminAction)).toBe(true)
    expect(snapshot.routes.every((route) => route.repairActions.length > 0)).toBe(true)
    expect(snapshot.routes.every((route) => Array.isArray(route.candidateProviders))).toBe(true)
  })

  it('renders accessible navigation and route state without direct backend calls', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(
      <AppShell snapshot={snapshot} currentPath="/admin">
        <RouteMatrix routes={snapshot.routes} />
      </AppShell>
    )

    expect(markup).toContain('Primary navigation')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('AdminAction')
    expect(markup).toContain('privacy-blocked')
    expect(markup).toContain('Feature details')
    expect(markup).toContain('Repair actions')
  })

  it('maps capability graph states into disabled routes and repair actions', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => stateMatrixCatalog())
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport }))

    const services = route(snapshot, 'services')
    const config = route(snapshot, 'config')
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

    const markup = renderToStaticMarkup(<RouteMatrix routes={[services, config, tools, memory]} />)
    expect(markup).toContain('Grant permission')
    expect(markup).toContain('Configure route')
    expect(markup).toContain('Pair or reconnect peer')
    expect(markup).toContain('Providers')
  })

  it('keeps SDK errors visible as disabled shell state', () => {
    const snapshot = errorShellSnapshot('http', new Error('Gateway unavailable'))

    expect(snapshot.loadState).toBe('error')
    expect(snapshot.routes.every((route) => route.disabled)).toBe(true)
    expect(snapshot.routes.every((route) => route.blockers.includes('sdk_error'))).toBe(true)

    const markup = renderToStaticMarkup(
      <StateSurface
        title="Diagnostics"
        state="error"
        description={snapshot.error ?? 'error'}
        evidence={snapshot.evidenceSource}
      />
    )
    expect(markup).toContain('Gateway unavailable')
    expect(markup).toContain('AuroraClient error')
  })

  it('builds model runtime provider state from SDK catalog, capability graph, and native evidence', () => {
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
    expect(model.providers.find((provider) => provider.id === 'local:Orchestrator:llama-cpp')).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        canSelect: false,
        privacyClass: 'public'
      })
    )
    expect(model.providers.find((provider) => provider.id === 'mesh:studio-gpu:Orchestrator')).toEqual(
      expect.objectContaining({
        availability: 'available-remote',
        canSelect: false,
        selectReason: expect.stringContaining('Backend model selection contract is not active'),
        providerType: 'mesh',
        routeLabel: expect.stringContaining('mesh / Orchestrator.GetModelCatalog')
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
        blockers: expect.arrayContaining(['native_provider_missing'])
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
        routeLabel: 'native:android / native:mobile-local-light',
        blockers: expect.arrayContaining(['backend_model_catalog_and_device_model_proof_required'])
      })
    )
    expect(nativeModel.mobileLocalLightState).toBe('degraded')
    expect(nativeModel.mobileLocalLightReason).toContain('android-native-local-light-adapter')
  })

  it('renders model runtime UI with disabled AdminAction operations and SDK error states', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      transportKind: 'mock'
    })
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const markup = renderToStaticMarkup(
      <ModelsView
        client={client}
        initialCatalog={modelRuntimeCatalogFixture}
        initialGraph={graph}
        initialNativeManifest={androidNativeCapabilityManifestFixture}
      />
    )

    expect(markup).toContain('Models and runtime')
    expect(markup).toContain('llama.cpp desktop')
    expect(markup).toContain('studio-gpu peer')
    expect(markup).toContain('OpenAI-compatible gateway')
    expect(markup).toContain('Mobile local-light runtime')
    expect(markup).toContain('secrets redacted')
    expect(markup).toContain('AdminAction model import contract is not active')
    expect(markup).toContain('Benchmark action stays disabled')
    expect(markup).toContain('Select: Backend model selection contract is not active')
    expect(markup).toContain('Backend model selection contract is not active; selection stays disabled until an SDK/AdminAction operation exists.')
    expect(markup).toContain('backend_model_catalog_and_device_model_proof_required')
    expect(markup).toContain('android-native-local-light-adapter')
    expect(markup).toContain('Mobile local-light')

    const errorMarkup = renderToStaticMarkup(
      <ModelsView client={client} initialCatalog={null} initialError="model catalog unavailable" />
    )
    expect(errorMarkup).toContain('role="alert"')
    expect(errorMarkup).toContain('model catalog unavailable')
  })

  it('renders settings, privacy defaults, native permissions, and AdminAction state from SDK evidence', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const model = buildSettingsPermissionsModel(snapshot)
    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} />)

    expect(model.loadState).toBe('ready')
    expect(model.privacyControls.map((control) => control.id)).toEqual([
      'prefer-local',
      'explicit-selector',
      'block-explicit-fallback'
    ])
    expect(model.privacyControls.some((control) => control.requiresAdminAction)).toBe(true)
    expect(model.nativePermissions.length).toBeGreaterThan(0)
    expect(model.nativePermissions.some((permission) => permission.state === 'privacy-blocked')).toBe(true)
    expect(model.routeDefaults.map((item) => item.id)).toContain('denied-routes')

    expect(markup).toContain('Settings and permissions')
    expect(markup).toContain('Privacy defaults')
    expect(markup).toContain('Native permissions')
    expect(markup).toContain('Route and fallback policy')
    expect(markup).toContain('AdminAction required')
    expect(markup).toContain('Request unavailable')
    expect(markup).toContain('secrets redacted')
  })

  it('renders iOS App Intents as app-owned Shortcuts integration without claiming Siri replacement', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Native.GetCapabilityManifest', () => iosNativeCapabilityManifestFixture)
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport }))
    const model = buildSettingsPermissionsModel(snapshot)
    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} />)

    expect(snapshot.nativePlatform).toBe('ios')
    expect(model.nativeIntegrations.map((integration) => integration.id)).toEqual([
      'askAuroraAppIntent',
      'askAuroraShortcut',
      'summarizeSharedContentShortcut',
      'stopAuroraSpeechAppIntent',
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
    expect(model.nativeIntegrations.find((integration) => integration.id === 'siriReplacement')).toEqual(
      expect.objectContaining({
        state: 'unsupported',
        siriReplacement: false
      })
    )
    expect(markup).toContain('Siri, Shortcuts, and App Intents')
    expect(markup).toContain('does not replace Siri')
    expect(markup).toContain('Orchestrator.ExternalUserInput')
    expect(markup).toContain('confirmation required')
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
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport }))
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
    expect(model.routeDefaults.find((item) => item.id === 'denied-routes')?.state).toBe('denied')
    expect(model.privacyControls.map((control) => control.mutationState)).toContain('optimistic')
    expect(model.privacyControls.map((control) => control.mutationState)).toContain('rollback-error')
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.microphone')?.state).toBe('privacy-blocked')
    expect(model.nativePermissions.find((permission) => permission.id === 'aurora.notifications')?.state).toBe('available-local')

    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} />)
    expect(markup).toContain('Request unavailable')
    expect(markup).toContain('Granted')
    expect(markup).toContain('Fallback is visible as degraded capability evidence.')
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
    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} />)

    expect(localLight).toEqual(
      expect.objectContaining({
        state: 'degraded',
        granted: false,
        requestEnabled: false
      })
    )
    expect(markup).toContain('Android Local Light Inference')
    expect(markup).toContain('Native manifest reports a degraded or partial platform path for this feature.')
  })

  it('renders Android assistant role qualification and fallback entrypoints from native manifest evidence', () => {
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

    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} />)
    expect(markup).toContain('Android assistant role')
    expect(markup).toContain('RoleManager.isRoleAvailable(android.app.role.ASSISTANT)=true')
    expect(markup).toContain('Share sheet')
    expect(markup).toContain('Android Notification')
    expect(markup).toContain('assistant_role_user_grant_required')
  })

  it('keeps settings screen honest for SDK errors and empty native manifests', () => {
    const snapshot = errorShellSnapshot('http', new Error('Gateway unavailable'))
    const model = buildSettingsPermissionsModel(snapshot)
    const markup = renderToStaticMarkup(<SettingsPermissionsView snapshot={snapshot} />)

    expect(model.error).toBe('Gateway unavailable')
    expect(model.nativePermissions).toEqual([])
    expect(model.privacyControls.every((control) => control.disabled)).toBe(true)
    expect(markup).toContain('Gateway unavailable')
    expect(markup).toContain('No native permission manifest is available')
    expect(markup).toContain('AdminAction required')
  })

  it('renders assistant text chat with route, model, privacy, loading and disabled states', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const assistantRoute = route(snapshot, 'assistant')
    const enabledRoute = {
      ...assistantRoute,
      state: 'available-local' as const,
      disabled: false,
      providerLabel: 'local / Orchestrator.ExternalUserInput',
      blockers: [],
      routeable: true
    }
    const markup = renderToStaticMarkup(
      <AssistantView
        client={new AuroraClient({ transport: new MockAuroraTransport() })}
        route={enabledRoute}
        voiceRoutes={snapshot.assistantVoiceRoutes}
        nativeAvailable={snapshot.nativeAvailable}
        nativePlatform={snapshot.nativePlatform}
        nativePermissions={snapshot.nativePermissions}
        nativeCapabilities={snapshot.nativeCapabilities}
      />
    )

    expect(markup).toContain('Text chat')
    expect(markup).toContain('Voice modes')
    expect(markup).toContain('Browser capture')
    expect(markup).toContain('Native capture')
    expect(markup).toContain('Audio route and consent')
    expect(markup).toContain('Voice event stream')
    expect(markup).toContain('local / Orchestrator.ExternalUserInput')
    expect(markup).toContain('model pending')
    expect(markup).toContain('personal')
    expect(markup).toContain('Start with a prompt')
    expect(markup).toContain('Ask Aurora...')
    expect(markup).toContain('Attachments and shared content')
    expect(markup).toContain('Privacy label')
    expect(markup).toContain('Share source')
    expect(markup).toContain('Add URL')
    expect(markup).toContain('Add files or images')
    expect(markup).toContain('Native mobile share payloads remain disabled')
    expect(markup).toContain('0 context ready')

    const disabledMarkup = renderToStaticMarkup(
      <AssistantView
        client={new AuroraClient({ transport: new MockAuroraTransport() })}
        route={assistantRoute}
        voiceRoutes={snapshot.assistantVoiceRoutes}
      />
    )
    expect(disabledMarkup).toContain('Assistant send is disabled')
    expect(disabledMarkup).toContain('Assistant capability is unavailable')
  })

  it('renders backup dashboard with SDK manifests, AdminAction controls, download, and rollback visibility', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const backups = route(snapshot, 'backups')
    const markup = renderToStaticMarkup(
      <BackupRestoreView client={client} route={backups} initialList={backupListFixture} />
    )

    expect(backups.disabled).toBe(false)
    expect(markup).toContain('Backups &amp; Restore')
    expect(markup).toContain('Create via AdminAction')
    expect(markup).toContain('Verify via AdminAction')
    expect(markup).toContain('Preview restore impact')
    expect(markup).toContain('Full restore disabled')
    expect(markup).toContain('Preview rollback')
    expect(markup).toContain('Download manifest')
    expect(markup).toContain('backup-20260625T120000Z-config-rag')
    expect(markup).toContain('config:included')
    expect(markup).toContain('models:unsupported')
    expect(markup).toContain('secrets redacted')
  })

  it('renders backup empty, denied, degraded, unavailable, and SDK error states', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const backups = route(snapshot, 'backups')

    const emptyMarkup = renderToStaticMarkup(
      <BackupRestoreView client={client} route={backups} initialList={{ backups: [], total: 0, secrets_redacted: true }} />
    )
    expect(emptyMarkup).toContain('No manifests available')
    expect(emptyMarkup).toContain('No backup manifests were returned')

    const deniedMarkup = renderToStaticMarkup(
      <BackupRestoreView client={client} route={{ ...backups, state: 'denied', disabled: true, blockers: ['permission_denied'] }} />
    )
    expect(deniedMarkup).toContain('Backup operations are disabled')
    expect(deniedMarkup).toContain('permission_denied')

    const degradedMarkup = renderToStaticMarkup(
      <BackupRestoreView client={client} route={{ ...backups, state: 'degraded', disabled: false }} initialList={backupListFixture} />
    )
    expect(degradedMarkup).toContain('<dd>degraded</dd>')

    const unavailableMarkup = renderToStaticMarkup(
      <BackupRestoreView client={client} route={{ ...backups, state: 'unsupported', disabled: true, blockers: ['capability_not_advertised'] }} />
    )
    expect(unavailableMarkup).toContain('<dd>unavailable</dd>')
    expect(unavailableMarkup).toContain('capability_not_advertised')

    expect(backupErrorMessage(new AuroraError({ code: 'permission', message: 'denied' }))).toContain('denied')
    expect(backupErrorMessage(new AuroraError({ code: 'unavailable_service', message: 'missing' }))).toContain('unavailable')
    expect(backupErrorMessage(new AuroraError({ code: 'transport_loss', message: 'lost' }))).toContain('retry')
  })

  it('builds assistant voice routes from capability graph and native manifest evidence', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog())
    transport.register('Native.GetCapabilityManifest', () => ({
      platform: 'tauri-desktop',
      permissions: { microphone: true },
      capabilities: { voiceCapture: true }
    }))
    const client = new AuroraClient({ transport })
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
    expect(model.controls.find((control) => control.id === 'remote-transcription')?.reason).toContain('typed audio session')
    expect(model.events.map((event) => event.id)).toEqual(expect.arrayContaining(['partial', 'final', 'timeout', 'cancelled', 'remote-denied', 'peer-disconnect']))
  })

  it('keeps remote STT consent-gated, denial visible, and revoked consent blocking dispatch', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog('remote-stt'))
    const client = new AuroraClient({ transport })
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
    const deniedSnapshot = await buildShellSnapshot(new AuroraClient({ transport: deniedTransport }))
    expect(deniedSnapshot.assistantVoiceRoutes.transcription.state).toBe('denied')
  })

  it('covers peer disconnect, local permission loss, and mobile foreground-only voice limits', async () => {
    const staleTransport = new MockAuroraTransport()
    staleTransport.register('Gateway.GetCapabilityCatalog', () => voiceModeCatalog('stale-remote'))
    const staleClient = new AuroraClient({ transport: staleTransport })
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
    const mobileClient = new AuroraClient({ transport: mobileTransport })
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
    expect(mobileModel.chips.find((chip) => chip.id === 'wake')?.detail).toContain('foreground-only')
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
    const mobileClient = new AuroraClient({ transport: mobileTransport })
    const snapshot = await buildShellSnapshot(mobileClient)
    const settings = buildSettingsPermissionsModel(snapshot)
    const onboarding = buildOnboardingViewModel({ client: mobileClient, snapshot, selectedModeId: 'ios-thin' })

    expect(settings.nativePermissions.map((permission) => permission.label)).toEqual(
      expect.arrayContaining(['iOS App Intents', 'iOS Shortcuts', 'iOS Siri Replacement Unsupported'])
    )
    expect(settings.nativePermissions.find((permission) => permission.label === 'iOS Siri Replacement Unsupported')?.state).toBe('privacy-blocked')
    expect(onboarding.modes.find((mode) => mode.id === 'ios-thin')?.repair).toContain('Siri/Shortcuts/App Intents integration')
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

  it('renders onboarding modes, endpoint validation, login, pairing, and fallback states from SDK evidence', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const markup = renderToStaticMarkup(<OnboardingView client={client} snapshot={snapshot} />)

    expect(markup).toContain('Connect Aurora')
    expect(markup).toContain('Server Web')
    expect(markup).toContain('Desktop Local')
    expect(markup).toContain('Mesh Peer')
    expect(markup).toContain('Android Thin')
    expect(markup).toContain('iOS Thin')
    expect(markup).toContain('Offline Local')
    expect(markup).toContain('Gateway or local node URL')
    expect(markup).toContain('Login or restore')
    expect(markup).toContain('Pairing code')
    expect(markup).toContain('development fixture only')
  })

  it('maps auth session matrix into onboarding availability without inventing success', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
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
    expect(system.authExplanation).toContain('SYSTEM/API-key mode')
  })

  it('keeps invalid endpoints and SDK errors visible in onboarding state', async () => {
    const client = new AuroraClient({ transport: MockAuroraTransport.empty().lose('Gateway.GetRegistry') })
    const snapshot = await buildShellSnapshot(client)
    const model = buildOnboardingViewModel({ client, snapshot, endpoint: 'ftp://not-supported' })

    expect(snapshot.loadState).toBe('error')
    expect(model.endpointState).toBe('denied')
    expect(model.endpointEvidence).toContain('could not load')

    const markup = renderToStaticMarkup(<OnboardingView client={client} snapshot={snapshot} />)
    expect(markup).toContain('AuroraClient error')
    expect(markup).toContain('Capability state could not be loaded from AuroraClient')
  })

  it('builds assistant route policy and user-facing SDK error messages from backend evidence', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const assistantRoute = route(snapshot, 'assistant')
    const policy = routePolicyFromRoute(assistantRoute)

    expect(policy.routeState).toBe(assistantRoute.state)
    expect(policy.privacyClass).toBe('personal')
    expect(assistantErrorMessage(new AuroraError({ code: 'timeout', message: 'slow' }))).toContain('timed out')
    expect(assistantErrorMessage(new AuroraError({ code: 'auth', message: 'denied' }))).toContain('denied')
    expect(assistantErrorMessage(new AuroraError({ code: 'unavailable_service', message: 'down' }))).toContain('unavailable')
  })

  it('wires admin services and contract explorer from AuroraClient SDK resources', async () => {
    const snapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport: adminServicesTransport() }))
    const markup = renderToStaticMarkup(<AdminServicesView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.services.map((service) => service.module)).toContain('Gateway')
    expect(snapshot.contracts.map((contract) => contract.busTopic)).toContain('Gateway.GetServices')
    expect(markup).toContain('Services and contracts')
    expect(markup).toContain('SDK mock transport fixture')
    expect(markup).toContain('Gateway.GetServices')
    expect(markup).toContain('Supervisor.RestartService')
    expect(markup).toContain('AdminAction')
    expect(markup).not.toContain('visual mock')
  })

  it('keeps service control actions capability-driven and AdminAction-gated', async () => {
    const snapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport: adminServicesTransport() }))
    const supervisor = snapshot.services.find((service) => service.module === 'Supervisor')
    const gateway = snapshot.services.find((service) => service.module === 'Gateway')

    expect(supervisor?.controls.find((control) => control.verb === 'restart')?.available).toBe(true)
    expect(supervisor?.controls.find((control) => control.verb === 'restart')?.requiresAdminAction).toBe(true)
    expect(supervisor?.controls.find((control) => control.verb === 'restart')?.action?.methodId).toBe('Supervisor.RestartService')
    expect(gateway?.controls.every((control) => !control.available)).toBe(true)

    const markup = renderToStaticMarkup(<AdminServicesView snapshot={snapshot} />)
    expect(markup).toContain('Preview requires AdminAction draft/confirm/audit')
    expect(markup).toContain('Supervisor control contract is not present in the service registry')
  })

  it('renders admin service loading, empty, denied, degraded, and unavailable states', async () => {
    const loadingMarkup = renderToStaticMarkup(
      <AdminServicesView snapshot={{
        loadState: 'loading',
        servicesMode: 'pending',
        generatedAt: null,
        secretsRedacted: true,
        services: [],
        contracts: [],
        warnings: [],
        error: null,
        evidenceSource: 'pending AuroraClient SDK calls'
      }} />
    )
    expect(loadingMarkup).toContain('Loading services')

    const emptySnapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport: emptyAdminTransport() }))
    expect(emptySnapshot.loadState).toBe('empty')
    expect(renderToStaticMarkup(<AdminServicesView snapshot={emptySnapshot} />)).toContain('No service registry')

    const deniedTransport = adminServicesTransport()
    deniedTransport.fail('Gateway.GetCapabilityCatalog', 'permission', 'Capability catalog denied')
    const deniedSnapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminServicesView snapshot={deniedSnapshot} />)).toContain('Capability catalog denied')

    const degradedTransport = adminServicesTransport()
    degradedTransport.lose('Gateway.GetServices', 'Gateway service list unavailable')
    const degradedSnapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')
    expect(renderToStaticMarkup(<AdminServicesView snapshot={degradedSnapshot} />)).toContain('Gateway service list unavailable')

    const unavailableSnapshot = await buildAdminServicesSnapshot(
      new AuroraClient({ transport: MockAuroraTransport.empty().lose('Gateway.GetServices').lose('Gateway.GetRegistry').lose('Gateway.GetCapabilityCatalog') })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(renderToStaticMarkup(<AdminServicesView snapshot={unavailableSnapshot} />)).toContain('AuroraClient SDK error')
  })

  it('preserves denied, degraded, stale, privacy-blocked, and unsupported contract evidence', async () => {
    const snapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport: adminStateMatrixTransport() }))
    const markup = renderToStaticMarkup(<AdminServicesView snapshot={snapshot} />)

    expect(snapshot.services.map((service) => service.routeState)).toEqual(
      expect.arrayContaining(['degraded', 'denied', 'stale', 'privacy-blocked', 'unsupported'])
    )
    expect(markup).toContain('policy_denied')
    expect(markup).toContain('stale_provider')
    expect(markup).toContain('explicit_selector_required')
    expect(markup).toContain('internal-only')
  })

  it('wires plugins, MCP, provider grouping, risk metadata, and policy controls from AuroraClient', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const pluginsRoute = enabledRoute(route(shell, 'plugins'))
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute)
    const markup = renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.tools.map((tool) => tool.providerGroup)).toEqual(expect.arrayContaining([
      'local-built-in',
      'local-mcp',
      'remote-peer-built-in',
      'unavailable-stale'
    ]))
    expect(snapshot.tools.some((tool) => tool.admin && tool.mutating && tool.riskClass === 'admin-critical')).toBe(true)
    expect(snapshot.tools.some((tool) => tool.dataClasses.includes('external-egress'))).toBe(true)
    expect(snapshot.tools.some((tool) => tool.policyControls.some((control) => control.mode === 'require-confirmation'))).toBe(true)
    expect(snapshot.tools.some((tool) => tool.policyControls.some((control) => control.mode === 'dry-run-only'))).toBe(true)
    expect(snapshot.tools.some((tool) => tool.policyControls.some((control) => control.mode === 'allowed-peers'))).toBe(true)
    expect(markup).toContain('Plugins, MCP, and tools')
    expect(markup).toContain('Local built-in')
    expect(markup).toContain('Local MCP')
    expect(markup).toContain('Remote peer built-in')
    expect(markup).toContain('Unavailable or stale provider')
    expect(markup).toContain('Write local config file')
    expect(markup).toContain('Open garage door')
    expect(markup).toContain('Send email draft')
    expect(markup).toContain('admin-critical')
    expect(markup).toContain('external-egress')
    expect(markup).toContain('Share selected')
    expect(markup).toContain('Require confirmation')
    expect(markup).toContain('Dry-run only')
    expect(markup).toContain('Allowed peers/providers')
    expect(markup).toContain('audit.local.tooling')
    expect(markup).not.toContain('secret-token')
  })

  it('keeps plugin reload, install, and sharing mutations AdminAction-gated by advertised registry methods', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const pluginsRoute = enabledRoute(route(shell, 'plugins'))
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute)
    const markup = renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={snapshot} />)

    expect(snapshot.actions.map((action) => action.methodId)).toEqual([
      'Tooling.ReloadPlugins',
      'Tooling.InstallPlugin',
      'Tooling.UpdateToolSharingPolicy'
    ])
    expect(snapshot.actions.every((action) => action.requiresAdminAction || action.state === 'unsupported')).toBe(true)
    expect(snapshot.actions.every((action) => !action.available)).toBe(true)
    expect(markup).toContain('Tooling.ReloadPlugins is not advertised')
    expect(markup).toContain('Tooling.InstallPlugin is not advertised')
    expect(markup).toContain('Tooling.UpdateToolSharingPolicy is not advertised')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Remote peer tool policy is read-only')
  })

  it('renders plugin admin loading, empty, denied, degraded, unavailable, and error states', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const pluginsRoute = enabledRoute(route(shell, 'plugins'))
    expect(renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={{
      loadState: 'loading',
      generatedAt: null,
      secretsRedacted: true,
      tools: [],
      providerGroups: [],
      actions: [],
      warnings: [],
      error: null,
      evidenceSource: 'pending AuroraClient SDK calls'
    }} />)).toContain('Loading Tooling catalog')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Tooling.GetToolCatalog', () => ({ tools: [], secrets_redacted: true }))
    const emptySnapshot = await buildAdminPluginsSnapshot(new AuroraClient({ transport: emptyTransport }), pluginsRoute)
    expect(emptySnapshot.loadState).toBe('empty')
    expect(renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={emptySnapshot} />)).toContain('No Tooling catalog entries')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Tooling.GetToolCatalog', 'permission', 'tool catalog denied')
    const deniedSnapshot = await buildAdminPluginsSnapshot(new AuroraClient({ transport: deniedTransport }), pluginsRoute)
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={deniedSnapshot} />)).toContain('tool catalog denied')

    const degradedTransport = new MockAuroraTransport()
    degradedTransport.lose('Gateway.GetRegistry', 'registry unavailable')
    const degradedSnapshot = await buildAdminPluginsSnapshot(new AuroraClient({ transport: degradedTransport }), pluginsRoute)
    expect(degradedSnapshot.loadState).toBe('degraded')
    expect(renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={degradedSnapshot} />)).toContain('registry unavailable')

    const unavailableSnapshot = await buildAdminPluginsSnapshot(
      new AuroraClient({ transport: MockAuroraTransport.empty().lose('Tooling.GetToolCatalog').lose('Gateway.GetRegistry') }),
      pluginsRoute
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute} initialSnapshot={unavailableSnapshot} />)).toContain('AuroraClient SDK error')

    const disabledRoute = { ...pluginsRoute, disabled: true, state: 'denied' as const, blockers: ['missing:Tooling.manage'] }
    const disabledSnapshot = await buildAdminPluginsSnapshot(client, disabledRoute)
    expect(disabledSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminPluginsView client={client} route={disabledRoute} initialSnapshot={disabledSnapshot} />)).toContain('missing:Tooling.manage')
  })

  it('wires scheduler jobs, ownership states, and delegated target evidence from AuroraClient', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const schedulerRoute = enabledRoute(route(shell, 'scheduler'), {
      providerLabel: 'local / Scheduler.ListJobs',
      explanation: 'Backend catalog reports Scheduler.ListJobs as routeable.',
      requiresAdminAction: true
    })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute)
    const markup = renderToStaticMarkup(<AdminSchedulerView client={client} route={schedulerRoute} initialSnapshot={snapshot} />)

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
    expect(markup).toContain('Scheduler jobs')
    expect(markup).toContain('Delegated by this node')
    expect(markup).toContain('Running on remote peer')
    expect(markup).toContain('Denied foreign namespace')
    expect(markup).toContain('AdminAction')
    expect(markup).toContain('approval token present')
    expect(markup).toContain('policy-remote-index')
    expect(markup).not.toContain('secret-token')
  })

  it('keeps scheduler create and job mutations AdminAction-gated by advertised registry methods', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const schedulerRoute = enabledRoute(route(shell, 'scheduler'), {
      providerLabel: 'local / Scheduler.ListJobs',
      requiresAdminAction: true
    })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute)
    const delegatedJob = snapshot.jobs.find((job) => job.ownership === 'delegated-owned')
    const deniedJob = snapshot.jobs.find((job) => job.ownership === 'foreign-denied')
    const markup = renderToStaticMarkup(<AdminSchedulerView client={client} route={schedulerRoute} initialSnapshot={snapshot} />)

    expect(snapshot.createControl.available).toBe(true)
    expect(snapshot.createControl.requiresAdminAction).toBe(true)
    expect(snapshot.createControl.targetOptions.map((option) => option.id)).toEqual(expect.arrayContaining(['local-peer', 'peer-studio-gpu']))
    expect(delegatedJob?.operationControls.find((control) => control.action === 'cancel')?.available).toBe(true)
    expect(delegatedJob?.operationControls.find((control) => control.action === 'pause')?.available).toBe(true)
    expect(delegatedJob?.operationControls.find((control) => control.action === 'resume')?.available).toBe(false)
    expect(deniedJob?.operationControls.every((control) => !control.available)).toBe(true)
    expect(markup).toContain('Create via AdminAction')
    expect(markup).toContain('target selector')
    expect(markup).toContain('delegated permissions')
    expect(markup).toContain('disabled=""')
  })

  it('renders scheduler disabled and SDK error states without fake local state', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const shell = await buildShellSnapshot(client)
    const schedulerRoute = enabledRoute(route(shell, 'scheduler'), {
      providerLabel: 'local / Scheduler.ListJobs',
      requiresAdminAction: true
    })
    const disabledRoute = { ...schedulerRoute, disabled: true, state: 'denied' as const, blockers: ['missing:Scheduler.manage'] }
    const disabledSnapshot = await buildAdminSchedulerSnapshot(client, disabledRoute)
    expect(disabledSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminSchedulerView client={client} route={disabledRoute} initialSnapshot={disabledSnapshot} />)).toContain('missing:Scheduler.manage')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Scheduler.ListJobs', 'permission', 'scheduler list denied')
    const deniedSnapshot = await buildAdminSchedulerSnapshot(new AuroraClient({ transport: deniedTransport }), schedulerRoute)
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminSchedulerView client={client} route={schedulerRoute} initialSnapshot={deniedSnapshot} />)).toContain('scheduler list denied')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Scheduler.ListJobs', () => ({ jobs: [], total: 0 }))
    const emptySnapshot = await buildAdminSchedulerSnapshot(new AuroraClient({ transport: emptyTransport }), schedulerRoute)
    expect(emptySnapshot.loadState).toBe('empty')
    expect(renderToStaticMarkup(<AdminSchedulerView client={client} route={schedulerRoute} initialSnapshot={emptySnapshot} />)).toContain('No scheduler jobs')

    const customTransport = new MockAuroraTransport()
    customTransport.register('Scheduler.ListJobs', () => schedulerJobsFixture)
    const customSnapshot = await buildAdminSchedulerSnapshot(new AuroraClient({ transport: customTransport }), schedulerRoute)
    expect(customSnapshot.jobs).toHaveLength(schedulerJobsFixture.jobs.length)
  })

  it('wires RBAC principals, roles, permissions, and audit evidence from AuroraClient', async () => {
    const snapshot = await buildAdminRbacSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminRbacView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.principals.map((principal) => principal.id)).toContain('principal-owner')
    expect(snapshot.roles.map((role) => role.label)).toEqual(expect.arrayContaining(['Owner', 'Admin', 'Automation', 'Member']))
    expect(snapshot.permissions.map((permission) => permission.id)).toContain('Auth.manage')
    expect(snapshot.audit.map((entry) => entry.correlationId)).toContain('corr-rbac-001')
    expect(snapshot.principals.some((principal) => principal.patchPreview.requiresAdminAction)).toBe(true)
    expect(markup).toContain('Access and RBAC')
    expect(markup).toContain('Auth.PatchPermissions')
    expect(markup).toContain('AdminAction approval')
    expect(markup).toContain('Recent access changes')
    expect(markup).not.toContain('secret-pending-code')
  })

  it('builds RBAC permission patch AdminAction payloads with effective diffs and cascade notes', async () => {
    const snapshot = await buildAdminRbacSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const principal = snapshot.principals.find((row) => row.id === 'principal-assistant')
    expect(principal).toBeTruthy()
    expect(principal?.patchPreview.cascade.join(' ')).toContain('effective-permission')

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
    const loadingMarkup = renderToStaticMarkup(<AdminRbacView snapshot={rbacLoadingSnapshot()} />)
    expect(loadingMarkup).toContain('Loading RBAC principals')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListPrincipals', () => ({ principals: [] }))
    emptyTransport.register('Auth.AuditLog', () => ({ events: [], total: 0 }))
    const emptySnapshot = await buildAdminRbacSnapshot(new AuroraClient({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')
    expect(renderToStaticMarkup(<AdminRbacView snapshot={emptySnapshot} />)).toContain('No principals')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.ListPrincipals', 'permission', 'Auth RBAC denied')
    const deniedSnapshot = await buildAdminRbacSnapshot(new AuroraClient({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminRbacView snapshot={deniedSnapshot} />)).toContain('Auth RBAC denied')

    const degradedTransport = new MockAuroraTransport()
    degradedTransport.lose('Auth.AuditLog', 'audit backend unavailable')
    const degradedSnapshot = await buildAdminRbacSnapshot(new AuroraClient({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')
    expect(renderToStaticMarkup(<AdminRbacView snapshot={degradedSnapshot} />)).toContain('audit backend unavailable')

    const unavailableSnapshot = await buildAdminRbacSnapshot(
      new AuroraClient({
        transport: MockAuroraTransport.empty()
          .lose('Auth.ListPrincipals')
          .lose('Auth.AuditLog')
          .lose('Gateway.GetRegistry')
          .lose('Gateway.GetCapabilityCatalog')
      })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(renderToStaticMarkup(<AdminRbacView snapshot={unavailableSnapshot} />)).toContain('Auth RBAC SDK resources are unavailable')

    const rollbackMarkup = renderToStaticMarkup(
      <AdminRbacView
        snapshot={{
          ...rbacLoadingSnapshot(),
          loadState: 'error',
          mutationState: 'denied',
          error: 'Rollback required after AdminAction submit failed',
          mutationReason: 'Backend rejected the AdminAction confirmation token.'
        }}
      />
    )
    expect(rollbackMarkup).toContain('Rollback required after AdminAction submit failed')
  })

  it('wires audit log details, mesh filters, redaction, and export from AuroraClient', async () => {
    const snapshot = await buildAdminAuditSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminAuditView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.rows.map((row) => row.correlationId)).toEqual(expect.arrayContaining(['corr-tool-approval-001', 'corr-scheduler-001']))
    expect(snapshot.rows.map((row) => row.lifecycleLabel)).toEqual(expect.arrayContaining(['requested', 'approve-all scope created', 'replay rejected']))
    expect(snapshot.rows.some((row) => row.dataNamespace === 'recipes')).toBe(true)
    expect(snapshot.rows.some((row) => row.audioSessionId === 'audio-session-77')).toBe(true)
    expect(snapshot.rows.some((row) => row.schedulerJobId === 'job-nightly-sync')).toBe(true)
    expect(markup).toContain('Audit log')
    expect(markup).toContain('Redacted payload preview')
    expect(markup).toContain('mesh://peer-studio/Tooling.ExecuteTool')
    expect(markup).toContain('receipt-scheduler-001')
    expect(markup).toContain('payload_hash')
    expect(markup).not.toContain('secret-token')
    expect(markup).not.toContain('Bearer ')

    const exportPayload = buildAuditExport(snapshot.rows)
    expect(exportPayload.redaction.raw_payloads_included).toBe(false)
    expect(exportPayload.support_bundle_correlation_ids).toContain('bundle-corr-001')
    expect(JSON.stringify(exportPayload)).not.toContain('redacted-by-backend')
    expect(JSON.stringify(exportPayload)).toContain('sha256:scheduler001')
  })

  it('filters audit events by peer/provider, route, approval mode, namespace, audio, scheduler, correlation, and denial reason', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

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
    expect(schedulerSnapshot.warnings.join(' ')).toContain('Data namespace is filtered')

    const deniedSnapshot = await buildAdminAuditSnapshot(client, {
      toolId: 'tool:studio:shell.exec',
      denialReason: 'policy_denied'
    })
    expect(deniedSnapshot.rows).toHaveLength(1)
    expect(deniedSnapshot.rows[0]?.status).toBe('denied')
    expect(renderToStaticMarkup(<AdminAuditView snapshot={deniedSnapshot} />)).toContain('policy_denied')
  })

  it('renders audit loading, empty, denied, degraded, and unavailable states', async () => {
    const loadingMarkup = renderToStaticMarkup(<AdminAuditView snapshot={auditLoadingSnapshot()} />)
    expect(loadingMarkup).toContain('Loading audit events')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.AuditLog', () => ({ events: [], total: 0 }))
    const emptySnapshot = await buildAdminAuditSnapshot(new AuroraClient({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')
    expect(renderToStaticMarkup(<AdminAuditView snapshot={emptySnapshot} />)).toContain('No audit rows match')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.AuditLog', 'permission', 'audit access denied')
    const deniedSnapshot = await buildAdminAuditSnapshot(new AuroraClient({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminAuditView snapshot={deniedSnapshot} />)).toContain('audit access denied')

    const unavailableSnapshot = await buildAdminAuditSnapshot(
      new AuroraClient({ transport: MockAuroraTransport.empty().lose('Auth.AuditLog', 'audit service unavailable') })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(renderToStaticMarkup(<AdminAuditView snapshot={unavailableSnapshot} />)).toContain('audit service unavailable')

    const degradedMarkup = renderToStaticMarkup(
      <AdminAuditView
        snapshot={{
          ...auditLoadingSnapshot(),
          loadState: 'degraded',
          error: 'Audit backend returned partial redacted detail fields.',
          exportState: 'unsupported',
          exportReason: 'Export disabled until redacted details are complete.'
        }}
      />
    )
    expect(degradedMarkup).toContain('partial redacted detail fields')
  })

  it('wires device/session management from AuroraClient Auth resources', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminDevicesView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.devices.map((device) => device.id)).toContain('device-studio-mac')
    expect(snapshot.devices.some((device) => device.activeSessionCount > 0)).toBe(true)
    expect(snapshot.devices.some((device) => device.deleteAction?.methodId === 'Auth.DeleteDevice')).toBe(true)
    expect(markup).toContain('Devices and sessions')
    expect(markup).toContain('token-backed active sessions')
    expect(markup).toContain('AdminAction boundary')
    expect(markup).not.toContain('secret-token')
  })

  it('builds device delete mutations as AdminAction requests', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const device = snapshot.devices.find((row) => row.id === 'device-studio-mac')
    expect(device).toBeTruthy()

    const action = buildDeviceDeleteAdminAction(device!, 'retire lost laptop')
    expect(action.methodId).toBe('Auth.DeleteDevice')
    expect(action.payload).toEqual({ device_id: 'device-studio-mac' })
    expect(action.reason).toBe('retire lost laptop')
    expect(action.reauthConfirmed).toBe(true)
    expect(action.affectedResources).toEqual(expect.arrayContaining(['device:device-studio-mac', 'device_tokens', 'active_sessions']))
  })

  it('renders device loading, empty, denied, degraded, unavailable, optimistic, rollback, and capability-gated states', async () => {
    const loadingMarkup = renderToStaticMarkup(<AdminDevicesView snapshot={devicesLoadingSnapshot()} />)
    expect(loadingMarkup).toContain('Loading devices')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListDevices', () => ({ devices: [] }))
    emptyTransport.register('Auth.ListTokens', () => ({ tokens: [] }))
    const emptySnapshot = await buildAdminDevicesSnapshot(new AuroraClient({ transport: emptyTransport }))
    expect(emptySnapshot.loadState).toBe('empty')
    expect(renderToStaticMarkup(<AdminDevicesView snapshot={emptySnapshot} />)).toContain('No registered devices')

    const deniedTransport = new MockAuroraTransport()
    deniedTransport.fail('Auth.ListDevices', 'permission', 'device access denied')
    const deniedSnapshot = await buildAdminDevicesSnapshot(new AuroraClient({ transport: deniedTransport }))
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(renderToStaticMarkup(<AdminDevicesView snapshot={deniedSnapshot} />)).toContain('device access denied')

    const degradedTransport = new MockAuroraTransport()
    degradedTransport.lose('Auth.ListTokens', 'token service unavailable')
    const degradedSnapshot = await buildAdminDevicesSnapshot(new AuroraClient({ transport: degradedTransport }))
    expect(degradedSnapshot.loadState).toBe('degraded')
    expect(renderToStaticMarkup(<AdminDevicesView snapshot={degradedSnapshot} />)).toContain('token service unavailable')

    const unavailableSnapshot = await buildAdminDevicesSnapshot(
      new AuroraClient({
        transport: MockAuroraTransport.empty()
          .lose('Auth.ListDevices')
          .lose('Auth.ListTokens')
          .lose('Gateway.GetCapabilityCatalog')
      })
    )
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')
    expect(renderToStaticMarkup(<AdminDevicesView snapshot={unavailableSnapshot} />)).toContain('Auth device/session SDK resources are unavailable')

    const optimisticMarkup = renderToStaticMarkup(
      <AdminDevicesView snapshot={await buildAdminDevicesSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))} optimisticDeviceId="device-studio-mac" />
    )
    expect(optimisticMarkup).toContain('AdminAction submitted for device-studio-mac')

    const rollbackMarkup = renderToStaticMarkup(
      <AdminDevicesView snapshot={devicesLoadingSnapshot()} mutationError="Backend rejected the AdminAction confirmation token." />
    )
    expect(rollbackMarkup).toContain('Rollback required after AdminAction device deletion failed')

    const gatedTransport = new MockAuroraTransport()
    gatedTransport.register('Gateway.GetCapabilityCatalog', () => deviceCatalogWithoutDelete())
    const gatedSnapshot = await buildAdminDevicesSnapshot(new AuroraClient({ transport: gatedTransport }))
    expect(gatedSnapshot.deleteState).toBe('unsupported')
    expect(gatedSnapshot.devices.every((device) => device.deleteAction === null)).toBe(true)
    expect(renderToStaticMarkup(<AdminDevicesView snapshot={gatedSnapshot} />)).toContain('Auth.DeleteDevice is not advertised')
  })

  it('renders config editor schema, rollback, and AdminAction controls from SDK evidence', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const configRoute = enabledRoute(route(snapshot, 'config'))
    const model = await buildConfigEditorModel(client, configRoute)
    const markup = renderToStaticMarkup(<ConfigEditorView client={client} route={configRoute} initialModel={model} />)

    expect(model.state).toBe('ready')
    expect(model.fields.map((field) => field.key_path)).toContain('services.gateway.api.port')
    expect(model.versions.map((version) => version.version_id)).toContain('cfgv-gateway-port-001')
    expect(markup).toContain('Configuration')
    expect(markup).toContain('Gateway port')
    expect(markup).toContain('Apply through AdminAction')
    expect(markup).toContain('Rollback')
    expect(markup).toContain('secrets redacted')
    expect(markup).not.toContain('secret-token')
  })

  it('keeps config editor denied states disabled without local-only fallback', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const configRoute = { ...route(snapshot, 'config'), disabled: true, state: 'denied' as const, blockers: ['missing:Config.manage'] }
    const model = await buildConfigEditorModel(client, configRoute)
    const markup = renderToStaticMarkup(<ConfigEditorView client={client} route={configRoute} initialModel={model} />)

    expect(model.state).toBe('denied')
    expect(model.fields).toEqual([])
    expect(markup).toContain('Config editor unavailable')
    expect(markup).toContain('missing:Config.manage')
    expect(markup).toContain('disabled=""')
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
    const markup = renderToStaticMarkup(
      <PairingQueueSurface
        model={model}
        route={route}
        adminReason="Approve expected kitchen tablet"
        permissions="Gateway.use"
      />
    )

    expect(model.state).toBe('pending')
    expect(markup).toContain('Pairing queue')
    expect(markup).toContain('Kitchen tablet')
    expect(markup).toContain('Kitchen node / peer-kitchen')
    expect(markup).toContain('AdminAction approve')
    expect(markup).toContain('AdminAction deny')
    expect(markup).toContain('redacted by UI')
    expect(markup).not.toContain('secret-pending-code')
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
    expect(pairingErrorMessage(new AuroraError({ code: 'unsupported_feature', message: 'missing' }))).toContain('unsupported')
    expect(parsePermissionList('Gateway.use, Auth.use\nDB.use')).toEqual(['Gateway.use', 'Auth.use', 'DB.use'])
  })

  it('builds pairing approve and deny mutations as AdminAction requests', () => {
    const entry = pairingEntry()
    const approve = buildPairingAdminActionRequest(entry, 'approve', {
      reason: 'Approve kitchen tablet',
      permissions: 'Gateway.use Auth.use',
      grantAdmin: false
    })
    const deny = buildPairingAdminActionRequest(entry, 'deny', {
      reason: 'Wrong peer'
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

  it('renders pairing view initial loading state from an enabled SDK route', () => {
    const markup = renderToStaticMarkup(
      <PairingQueueView client={new AuroraClient({ transport: MockAuroraTransport.empty() })} route={pairingRoute()} />
    )

    expect(markup).toContain('Loading pairing queue')
    expect(markup).toContain('AdminAction required for approve/deny')
  })

  it('builds mesh peer lifecycle snapshots from SDK mesh, Auth, WebRTC, and capability evidence', async () => {
    const snapshot = await buildMeshPeersSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), meshRoute())

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.localPeerId).toBe(meshStatusFixture.local.peer_id)
    expect(snapshot.secretsRedacted).toBe(true)
    expect(snapshot.pendingCount).toBe(1)
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
        lastEvidenceSource: expect.stringContaining('Auth.MeshListPeers')
      })
    )
    expect(snapshot.peers.find((peer) => peer.peerId === 'peer-den')?.compatibility).toContain('incompatible')
  })

  it('renders mesh peer lifecycle UI without local-only trust or secret leakage', async () => {
    const route = meshRoute()
    const snapshot = await buildMeshPeersSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), route)
    const markup = renderToStaticMarkup(
      <MeshPeersView
        snapshot={snapshot}
        route={route}
        adminReason="Approve kitchen peer"
        permissions="Gateway.use TTS.use"
      />
    )

    expect(markup).toContain('Mesh peers')
    expect(markup).toContain('Active WebRTC sessions')
    expect(markup).toContain('Auth device records')
    expect(markup).toContain('Kitchen node')
    expect(markup).toContain('Studio GPU')
    expect(markup).toContain('session-peer')
    expect(markup).toContain('Studio Mac')
    expect(markup).toContain('AdminAction approve')
    expect(markup).toContain('AdminAction deny')
    expect(markup).toContain('AdminAction remove')
    expect(markup).toContain('secrets redacted')
    expect(markup).toContain('Gateway.GetMeshStatus')
    expect(markup).not.toContain('mesh-pairing-secret')
  })

  it('maps mesh disabled, denied, degraded, and loading states without faking backend truth', async () => {
    const disabledSnapshot = await buildMeshPeersSnapshot(
      new AuroraClient({ transport: new MockAuroraTransport() }),
      meshRoute({ disabled: true, state: 'unsupported', explanation: 'Gateway.GetMeshStatus is not routeable.' })
    )
    expect(disabledSnapshot.loadState).toBe('service-unavailable')
    expect(disabledSnapshot.error).toContain('Capability unavailable')

    const deniedSnapshot = await buildMeshPeersSnapshot(
      new AuroraClient({ transport: new MockAuroraTransport().fail('Auth.MeshListPeers', 'permission', 'Auth denied') }),
      meshRoute()
    )
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(deniedSnapshot.error).toContain('denied')

    const degradedSnapshot = await buildMeshPeersSnapshot(
      new AuroraClient({ transport: new MockAuroraTransport().lose('Gateway.GetWebRTCDiagnostics', 'diagnostics down') }),
      meshRoute()
    )
    expect(degradedSnapshot.loadState).toBe('degraded')
    expect(degradedSnapshot.warnings.join(' ')).toContain('diagnostics down')

    const deviceDegradedSnapshot = await buildMeshPeersSnapshot(
      new AuroraClient({ transport: new MockAuroraTransport().fail('Auth.ListDevices', 'unavailable_service', 'devices down') }),
      meshRoute()
    )
    expect(deviceDegradedSnapshot.loadState).toBe('degraded')
    expect(deviceDegradedSnapshot.warnings.join(' ')).toContain('devices down')
    expect(deviceDegradedSnapshot.peers.length).toBeGreaterThan(0)

    const loadingMarkup = renderToStaticMarkup(
      <MeshPeersResource client={new AuroraClient({ transport: MockAuroraTransport.empty() })} route={meshRoute()} />
    )
    expect(loadingMarkup).toContain('Loading mesh peers')
  })

  it('builds WebRTC ICE diagnostics from SDK WebRTC, mesh, and capability evidence', async () => {
    const snapshot = await buildMeshDiagnosticsSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), meshRoute())

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
  })

  it('renders WebRTC ICE diagnostics without leaking secret transport state', async () => {
    const route = meshRoute()
    const snapshot = await buildMeshDiagnosticsSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), route)
    const markup = renderToStaticMarkup(<MeshDiagnosticsView snapshot={snapshot} route={route} />)

    expect(markup).toContain('WebRTC and ICE diagnostics')
    expect(markup).toContain('Peer transport matrix')
    expect(markup).toContain('session-peer')
    expect(markup).toContain('stable-peer')
    expect(markup).toContain('ICE completed')
    expect(markup).toContain('DataChannel')
    expect(markup).toContain('Route quality')
    expect(markup).toContain('rpc_timeout')
    expect(markup).toContain('secrets redacted')
    expect(markup).not.toContain('mesh-pairing-secret')
  })

  it('maps WebRTC diagnostics empty, denied, and SDK error states with repair evidence', async () => {
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
      new AuroraClient({ transport: new MockAuroraTransport().fail('Gateway.GetWebRTCDiagnostics', 'permission', 'Gateway denied') }),
      meshRoute()
    )
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(deniedSnapshot.errors.join(' ')).toContain('Gateway denied')

    const unavailableSnapshot = await buildMeshDiagnosticsSnapshot(
      new AuroraClient({
        transport: MockAuroraTransport.empty()
          .fail('Gateway.GetWebRTCDiagnostics', 'unavailable_service', 'diagnostics down')
          .fail('Gateway.GetMeshStatus', 'unavailable_service', 'mesh down')
          .fail('Gateway.GetCapabilityCatalog', 'unavailable_service', 'catalog down')
      }),
      meshRoute()
    )
    expect(unavailableSnapshot.loadState).toBe('unavailable')
    expect(unavailableSnapshot.signalingRepair).toContain('Repair Gateway.GetWebRTCDiagnostics')
    const markup = renderToStaticMarkup(<MeshDiagnosticsView snapshot={unavailableSnapshot} route={meshRoute()} />)
    expect(markup).toContain('Degraded diagnostics inputs')
    expect(markup).toContain('diagnostics down')
    expect(markup).toContain('No live WebRTC peer sessions')
  })

  it('builds mesh peer AdminAction requests with typed method paths and redacted scopes', () => {
    const peer = { peerId: 'peer-kitchen', nodeName: 'Kitchen node' }
    const approve = buildMeshPeerAdminAction(peer, 'approve', {
      reason: 'Approve expected kitchen peer',
      permissions: 'Gateway.use, TTS.use\nTooling.use'
    })
    const deny = buildMeshPeerAdminAction(peer, 'deny', { reason: 'Wrong peer' })
    const remove = buildMeshPeerAdminAction(peer, 'remove', { reason: 'Retire peer', revokeToken: false })

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
    expect(meshPeerErrorMessage(new AuroraError({ code: 'unsupported_feature', message: 'missing' }))).toContain('unsupported')
  })

  it('builds route policy explain state matrix through AuroraClient route APIs', async () => {
    const snapshot = await buildRoutePolicySnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), meshRoute())

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

  it('renders route policy editor and exact explain blockers without local-only success claims', async () => {
    const snapshot = await buildRoutePolicySnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), meshRoute())
    const markup = renderToStaticMarkup(<RoutePolicyView snapshot={snapshot} draft={routePolicyDraft()} />)

    expect(markup).toContain('Route policy and explain')
    expect(markup).toContain('Backend decision matrix')
    expect(markup).toContain('Remote RAG namespace')
    expect(markup).toContain('Remote STT session')
    expect(markup).toContain('Scheduler delegation')
    expect(markup).toContain('explicit_selector_required')
    expect(markup).toContain('Select the target peer before remote raw-audio capable synthesis.')
    expect(markup).toContain('Config.Set')
    expect(markup).toContain('AdminAction')
    expect(markup).not.toContain('mesh-pairing-secret')
  })

  it('keeps route policy SDK failures visible and disabled', async () => {
    const transport = new MockAuroraTransport()
      .fail('Gateway.ExplainRoute', 'unavailable_service', 'route explain down')
      .fail('Gateway.GetCapabilityCatalog', 'permission', 'catalog denied')
    const snapshot = await buildRoutePolicySnapshot(new AuroraClient({ transport }), meshRoute())
    const markup = renderToStaticMarkup(<RoutePolicyView snapshot={snapshot} draft={routePolicyDraft()} />)

    expect(snapshot.loadState).toBe('denied')
    expect(snapshot.error).toContain('Route explain')
    expect(snapshot.canEditPolicy).toBe(false)
    expect(markup).toContain('route explain down')
    expect(markup).toContain('catalog denied')
    expect(markup).toContain('Save policy')
    expect(markup).toContain('disabled')
  })

  it('serializes route policy draft to schema-backed mesh sharing config', () => {
    const change = routePolicyDraftChange({
      ...routePolicyDraft(),
      module: 'TTS',
      allowedPeers: 'peer-a, peer-b',
      deniedPeers: 'peer-c',
      requiredCapabilities: 'synthesize, low-latency',
      minimumVersion: '0.3.0'
    })

    expect(change.key_path).toBe('services.tts.mesh_sharing')
    expect(change.value).toEqual({
      require_explicit_selector: true,
      allowed_peers: ['peer-a', 'peer-b'],
      required_capabilities: ['synthesize', 'low-latency'],
      min_version: '0.3.0',
      fallback: 'local'
    })
    expect(routePolicyScenarios().map((scenario) => scenario.id)).toContain('admin_action')
  })

  it('renders admin overview posture, services, capability gaps, activity, and AdminAction boundary from SDK manifest', async () => {
    const markup = renderToStaticMarkup(
      await AdminOverviewView({ client: new AuroraClient({ transport: new MockAuroraTransport() }) })
    )

    expect(markup).toContain('Admin overview')
    expect(markup).toContain('Deployment')
    expect(markup).toContain('Service mode')
    expect(markup).toContain('Health')
    expect(markup).toContain('Gateway')
    expect(markup).toContain('Capabilities')
    expect(markup).toContain('Activity')
    expect(markup).toContain('AdminAction controller')
    expect(markup).toContain('Manage/admin-critical operations')
    expect(markup).toContain('privacy-blocked')
    expect(markup).toContain('secrets redacted')
    expect(markup).toContain('Deployment topology')
    expect(markup).toContain('local thread-mode app')
    expect(markup).toContain('thread_mode_no_process_controls')
    expect(markup).toContain('Process controls unsupported')
  })

  it('keeps denied, stale, empty, and internal-only admin states visible with repair links', () => {
    const manifest = adminOverviewStateMatrixManifest()
    const markup = renderToStaticMarkup(<AdminOverviewContent manifest={manifest} transportKind="mock" />)

    expect(markup).toContain('denied')
    expect(markup).toContain('stale')
    expect(markup).toContain('Capabilities')
    expect(markup).toContain('Internal-only methods')
    expect(markup).toContain('Gateway.InternalOnly')
    expect(markup).toContain('Config.Get')
    expect(markup).toContain('DB.RAGSearch')
    expect(markup).toContain('AdminAction draft/confirm/audit is required')
  })

  it('renders process-mode deployment topology with Redis and BullMQ evidence', () => {
    const manifest = adminOverviewStateMatrixManifest(processTopologyFixture())
    const markup = renderToStaticMarkup(<AdminOverviewContent manifest={manifest} transportKind="http" />)

    expect(markup).toContain('server process-mode deployment')
    expect(markup).toContain('BullMQBus')
    expect(markup).toContain('redis://[redacted]@redis:6379/0 reachable')
    expect(markup).toContain('docker-compose.process.yml')
    expect(markup).toContain('Diagnostics export')
    expect(markup).toContain('Services and contracts')
    expect(markup).not.toContain('redis://:password')
  })

  it('renders Redis-down process topology as degraded with actionable repair copy', () => {
    const topology = processTopologyFixture({
      redis_reachable: false,
      bullmq_queue_health: {
        ...processTopologyFixture().bullmq_queue_health,
        redis_reachable: false,
        status: 'degraded',
        degraded_reasons: ['redis_unreachable', 'bullmq_queue_lag_unknown'],
        error: 'Redis connection failed'
      },
      mode_capability_degradations: ['redis_unreachable', 'bullmq_queue_lag_unknown']
    })
    const manifest = adminOverviewStateMatrixManifest(topology)
    const markup = renderToStaticMarkup(<AdminOverviewContent manifest={manifest} transportKind="http" />)

    expect(markup).toContain('degraded')
    expect(markup).toContain('redis_unreachable')
    expect(markup).toContain('verify Redis is running')
    expect(markup).toContain('bullmq_queue_lag_unknown')
  })

  it('renders mesh peer-only topology as privacy-blocked until peer topology is trusted', () => {
    const topology = topologyFixture({
      architecture_mode: 'mesh',
      runtime_mode: 'mesh-peer-only',
      bus_backend: 'MeshBus',
      mesh_peer_topology_trusted: false,
      mode_capability_degradations: ['mesh_peer_topology_untrusted'],
      service_process_topology: []
    })
    const manifest = adminOverviewStateMatrixManifest(topology)
    const markup = renderToStaticMarkup(<AdminOverviewContent manifest={manifest} transportKind="mesh" />)

    expect(markup).toContain('mesh peer-only shell')
    expect(markup).toContain('privacy-blocked')
    expect(markup).toContain('mesh_peer_topology_untrusted')
    expect(markup).toContain('require authenticated peer evidence')
  })

  it('renders missing deployment topology without inventing process health', () => {
    const manifest = {
      ...adminOverviewStateMatrixManifest(null),
      deploymentTopologyError: 'deployment topology unavailable'
    }
    const markup = renderToStaticMarkup(<AdminOverviewContent manifest={manifest} transportKind="http" />)

    expect(markup).toContain('Deployment topology unavailable')
    expect(markup).toContain('deployment topology unavailable')
    expect(markup).toContain('BE-016 topology unavailable')
    expect(markup).toContain('Open diagnostics')
  })

  it('renders admin SDK errors as unavailable disabled state without inventing service health', async () => {
    const markup = renderToStaticMarkup(
      await AdminOverviewView({
        client: new AuroraClient({ transport: MockAuroraTransport.empty().lose('Gateway.GetRegistry', 'registry offline') })
      })
    )

    expect(markup).toContain('Service overview unavailable')
    expect(markup).toContain('registry offline')
    expect(markup).toContain('Open diagnostics')
    expect(markup).toContain('AuroraClient could not load')
  })

  it('keeps assistant stop capability disabled until Orchestrator.Interrupt evidence exists', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const assistantRoute = route(snapshot, 'assistant')
    const controlsWithoutInterrupt = assistantControlsForRoute(assistantRoute, undefined, true)

    expect(controlsWithoutInterrupt.canCancel).toBe(false)
    expect(controlsWithoutInterrupt.cancelReason).toContain('missing Orchestrator.Interrupt')

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
    expect(controlsWithInterrupt.cancelReason).toContain('supported')
  })

  it('accumulates assistant stream deltas without replacing backend text with local-only state', () => {
    const message = {
      id: 'assistant-pending',
      role: 'assistant' as const,
      text: 'Waiting for Aurora stream...',
      createdAt: '2026-06-21T00:00:00Z',
      status: 'streaming' as const
    }

    const first = applyAssistantStreamDelta(message, streamUpdate('Hel'))
    const second = applyAssistantStreamDelta(first, streamUpdate('lo'))

    expect(first.text).toBe('Hel')
    expect(second.text).toBe('Hello')
    expect(second.status).toBe('streaming')
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

  it('renders tool approval cards and result evidence from the SDK tool catalog', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const toolsRoute = enabledRoute(route(snapshot, 'tools'))
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
    const markup = renderToStaticMarkup(<ToolApprovalPanel client={client} route={toolsRoute} initialTools={tools} />)

    expect(markup).toContain('Approval cards')
    expect(markup).toContain('Write local config file')
    expect(markup).toContain('Open garage door')
    expect(markup).toContain('Search notes')
    expect(markup).toContain('Send email draft')
    expect(markup).toContain('Delete calendar event')
    expect(markup).toContain('Apply lights scene')
    expect(markup).toContain('Unlock front door')
    expect(markup).toContain('Camera snapshot')
    expect(markup).toContain('Collect diagnostics bundle')
    expect(markup).toContain('AdminAction required')
    expect(markup).toContain('Data egress')
    expect(markup).toContain('audit.mesh.hardware')
    expect(markup).toContain('audit-receipt-tool-result')
    expect(markup).toContain('corr-tool-result')
    expect(markup).toContain('local-peer -&gt; tooling-local')
  })

  it('covers provider selector, scoped approvals, dry-run-only, denied, expired, replay, and unavailable states', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const toolsRoute = enabledRoute(route(snapshot, 'tools'))
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
    const markup = renderToStaticMarkup(<ToolApprovalPanel client={client} route={toolsRoute} initialTools={tools} />)

    expect(markup).toContain('Provider selector required before approval.')
    expect(markup).toContain('Backend requires an explicit provider selector before approval.')
    expect(markup).toContain('Approve session')
    expect(markup).toContain('Approve peer')
    expect(markup).toContain('Approve local safe')
    expect(markup).toContain('Dry-run only until backend policy permits execution.')
    expect(markup).toContain('Denied: peer policy denies destructive calendar changes.')
    expect(markup).toContain('Approval expired; request a fresh backend approval.')
    expect(markup).toContain('Replay rejected: approval_request_replayed.')
    expect(markup).toContain('Unavailable: service_unavailable.')
    expect(markup).toContain('disabled=""')
  })

  it('keeps tool approval unavailable when the route is capability-blocked', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const toolsRoute = {
      ...route(snapshot, 'tools'),
      disabled: true,
      blockers: ['capability_not_advertised'],
      state: 'unsupported' as const
    }
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
    const markup = renderToStaticMarkup(<ToolApprovalPanel client={client} route={toolsRoute} initialTools={tools} />)

    expect(markup).toContain('Tooling is capability-gated')
    expect(markup).toContain('capability_not_advertised')
    expect(markup).toContain('Route state')
    expect(markup).toContain('unsupported')
  })

  it('submits tool denial through the SDK backend path and returns correlation evidence', async () => {
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
    const client = new AuroraClient({ transport })
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
    const client = new AuroraClient({
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

  it('renders RouteSheet route/privacy preview, scope choices, candidates, and audit target from SDK policy output', () => {
    const evaluation = allowedRouteEvaluation()
    const markup = renderToStaticMarkup(
      <RouteSheet
        client={new AuroraClient({ transport: new MockAuroraTransport() })}
        initialEvaluation={evaluation}
        payload={{ message: 'summarize deployment', token: 'secret-token' }}
      />
    )

    expect(markup).toContain('Route and privacy')
    expect(markup).toContain('available-local')
    expect(markup).toContain('personal')
    expect(markup).toContain('local:orchestrator')
    expect(markup).toContain('&quot;token&quot;:&quot;[redacted]&quot;')
    expect(markup).toContain('<dt>Audit</dt><dd>local:orchestrator</dd>')
    expect(markup).toContain('Apply preference to')
    expect(markup).toContain('Request')
    expect(markup).toContain('Session')
    expect(markup).toContain('Feature')
    expect(markup).toContain('Global')
    expect(markup).toContain('Use selected route')
  })

  it('blocks RouteSheet confirmation for privacy denied, unavailable, SDK error, and unconfirmed AdminAction states', () => {
    const denied = blockedRouteEvaluation('privacy-blocked')
    const unavailable = blockedRouteEvaluation('unsupported')
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
    expect(deniedModel.primaryReason).toContain('explicit peer')
    expect(adminModel.canConfirm).toBe(false)
    expect(adminModel.primaryReason).toContain('AdminAction')
    expect(errorModel.primaryReason).toContain('timed out')

    const markup = renderToStaticMarkup(
      <>
        <RouteSheet client={new AuroraClient({ transport: new MockAuroraTransport() })} initialEvaluation={denied} />
        <RouteSheet client={new AuroraClient({ transport: new MockAuroraTransport() })} initialEvaluation={unavailable} />
        <RouteSheet
          client={new AuroraClient({ transport: new MockAuroraTransport() })}
          initialEvaluation={allowedRouteEvaluation()}
          requiresAdminAction
        />
      </>
    )

    expect(markup).toContain('privacy-blocked')
    expect(markup).toContain('No route candidates were returned')
    expect(markup).toContain('AdminAction confirmation is required')
    expect(markup).toContain('disabled=""')
  })

  it('surfaces RouteSheet loading and SDK error states without fixture route candidates', () => {
    const loadingMarkup = renderToStaticMarkup(<RouteSheet client={new AuroraClient({ transport: new MockAuroraTransport() })} />)
    const errorMessage = routeSheetErrorMessage(new AuroraError({ code: 'privacy_blocked', message: 'blocked' }))

    expect(loadingMarkup).toContain('Loading route policy from AuroraClient')
    expect(errorMessage).toContain('privacy policy')
  })

  it('includes the shared RouteSheet guard in assistant route details', async () => {
    const snapshot = await buildShellSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const assistantRoute = route(snapshot, 'assistant')
    const enabledRoute = {
      ...assistantRoute,
      state: 'available-local' as const,
      disabled: false,
      providerLabel: 'local / Orchestrator.ExternalUserInput',
      blockers: [],
      routeable: true
    }

    const markup = renderToStaticMarkup(
      <AssistantView client={new AuroraClient({ transport: new MockAuroraTransport() })} route={enabledRoute} />
    )

    expect(markup).toContain('Assistant route preview')
    expect(markup).toContain('The SDK evaluates where this prompt can run before dispatch.')
    expect(markup).toContain('Loading route policy from AuroraClient')
  })

  it('renders memory namespaces, conversation history, provenance, and AdminAction-gated controls', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const model = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'peer-studio-gpu.memories',
      query: 'mesh pairing'
    })
    const markup = renderToStaticMarkup(<MemoryView client={client} route={memoryRoute} initialModel={model} />)

    expect(model.selectedNamespace?.kind).toBe('remote-peer')
    expect(model.searchDecision).toBe('allowed')
    expect(model.searchItems[0]?.provenance.source_peer_id).toBe('peer-studio-gpu')
    expect(markup).toContain('Remote peer: peer-studio-gpu.memories')
    expect(markup).toContain('Search hit for &quot;mesh pairing&quot;')
    expect(markup).toContain('redacted')
    expect(markup).toContain('corr-memory-remote')
    expect(markup).toContain('Conversation history')
    expect(markup).toContain('Summarize recent mesh pairing failures')
    expect(markup).toContain('Export snapshot unsupported')
    expect(markup).toContain('Delete record unsupported')
  })

  it('keeps local export/import/delete controls disabled behind AdminAction policy', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
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
    expect(memoryModel.actions.export.reason).toContain('AdminAction')
    expect(memoryModel.actions.delete.supported).toBe(true)
    expect(memoryModel.actions.delete.disabled).toBe(true)
    expect(memoryModel.actions.delete.reason).toContain('AdminAction')
    expect(ragModel.actions.importPreview.supported).toBe(true)
    expect(ragModel.actions.importPreview.disabled).toBe(true)
    expect(ragModel.actions.importPreview.reason).toContain('AdminAction')
  })

  it('shows denied and stale memory namespace states without labeling them local', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
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

    const markup = renderToStaticMarkup(<MemoryView client={client} route={memoryRoute} initialModel={denied} />)
    expect(markup).toContain('denied: peer-denied.secret')
    expect(markup).not.toContain('Local memory: peer-denied.secret')
    expect(markup).toContain('remote namespace denied by policy')
  })

  it('keeps memory SDK errors visible as route-scoped disabled state', async () => {
    const transport = new MockAuroraTransport().fail('DB.RAGListNamespaces', 'permission', 'DB permission denied')
    const client = new AuroraClient({ transport })
    const snapshot = await buildShellSnapshot(client)
    const memoryRoute = enabledRoute(route(snapshot, 'memory'))
    const model = await buildMemoryViewModel(client, memoryRoute, { query: 'anything' })
    const markup = renderToStaticMarkup(<MemoryView client={client} route={memoryRoute} initialModel={model} />)

    expect(model.loadState).toBe('error')
    expect(model.error).toContain('denied')
    expect(markup).toContain('Memory request denied by authentication or permissions')
    expect(markup).toContain('No namespace reported')
  })
})

function route(snapshot: Awaited<ReturnType<typeof buildShellSnapshot>>, id: string) {
  const match = snapshot.routes.find((candidate) => candidate.item.id === id)
  if (!match) throw new Error(`missing route ${id}`)
  return match
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
    allowedPeers: '',
    deniedPeers: '',
    requiredCapabilities: 'synthesize',
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
    metadata: {}
  }
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

function adminOverviewStateMatrixManifest(
  deploymentTopology: DeploymentTopologyResponse | null = deploymentTopologyFixture
): AdminOverviewManifest {
  const catalog = stateMatrixCatalog()
  const services: GetServicesResponse = {
    mode: 'processes',
    services: [
      {
        module: 'Gateway',
        version: '0.1.0',
        summary: 'Gateway service',
        capabilities: ['registry'],
        status: 'healthy',
        method_count: 4,
        last_seen: '2026-06-19T00:00:00Z',
        instance_id: 'gateway-1'
      },
      {
        module: 'Config',
        version: '0.1.0',
        summary: 'Config service',
        capabilities: ['config'],
        status: 'denied',
        method_count: 1,
        last_seen: '2026-06-19T00:00:00Z',
        instance_id: 'config-1'
      },
      {
        module: 'DB',
        version: '0.1.0',
        summary: 'DB service',
        capabilities: ['rag'],
        status: 'stale',
        method_count: 1,
        last_seen: '2026-06-19T00:00:00Z',
        instance_id: 'db-1'
      }
    ]
  }
  return buildAdminOverviewManifest({
    registry: gatewayRegistryFixture,
    services,
    capabilityCatalog: catalog,
    deploymentTopology,
    generatedAt: '2026-06-19T00:00:00Z'
  })
}

function topologyFixture(
  overrides: Partial<DeploymentTopologyResponse> = {}
): DeploymentTopologyResponse {
  return {
    ...cloneFixture(deploymentTopologyFixture),
    ...overrides
  }
}

function processTopologyFixture(
  overrides: Partial<DeploymentTopologyResponse> = {}
): DeploymentTopologyResponse {
  const topology = topologyFixture({
    architecture_mode: 'processes',
    runtime_mode: 'server-process',
    bus_backend: 'BullMQBus',
    redis_url_redacted: 'redis://[redacted]@redis:6379/0',
    redis_reachable: true,
    bullmq_queue_health: {
      backend: 'BullMQBus',
      redis_url_redacted: 'redis://[redacted]@redis:6379/0',
      redis_reachable: true,
      bullmq_available: true,
      queue_lag_known: true,
      queue_depth: 0,
      published: 42,
      delivered: 42,
      retries: 0,
      dead_letters: 0,
      status: 'healthy',
      degraded_reasons: [],
      error: null
    },
    service_process_topology: [
      {
        module: 'Gateway',
        status: 'healthy',
        topology: 'container',
        instance_id: 'gateway-1',
        container_hint: 'gateway-service',
        process_hint: null,
        last_seen: '2026-06-19T00:00:00Z',
        stale: false
      },
      {
        module: 'Config',
        status: 'healthy',
        topology: 'container',
        instance_id: 'config-1',
        container_hint: 'config-service',
        process_hint: null,
        last_seen: '2026-06-19T00:00:00Z',
        stale: false
      }
    ],
    container_topology_hints: {
      orchestrator: 'docker-compose',
      compose_file: 'docker-compose.process.yml',
      redis_service: 'redis',
      gateway_service: 'gateway-service',
      config_service: 'config-service',
      notes: ['process mode runs one container per Aurora service']
    },
    mode_capability_degradations: [],
    mesh_peer_topology_trusted: null
  })
  return {
    ...topology,
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

function rbacLoadingSnapshot() {
  return {
    loadState: 'loading' as const,
    generatedAt: null,
    secretsRedacted: true,
    principals: [],
    roles: [],
    permissions: [],
    audit: [],
    mutationState: 'pending' as const,
    mutationReason: 'Loading RBAC principals, permission catalog, capability catalog, and audit log through AuroraClient.',
    warnings: [],
    error: null,
    evidenceSource: 'pending AuroraClient SDK calls'
  }
}

function auditLoadingSnapshot() {
  return {
    loadState: 'loading' as const,
    generatedAt: null,
    secretsRedacted: true,
    backendFilter: { limit: 100, offset: 0 },
    filters: {
      query: '',
      event: 'all',
      principalId: '',
      peerOrProvider: '',
      routePath: '',
      approvalMode: 'all',
      toolId: '',
      dataNamespace: '',
      audioSessionId: '',
      schedulerJobId: '',
      correlationId: '',
      denialReason: ''
    },
    rows: [],
    total: 0,
    warnings: [],
    error: null,
    evidenceSource: 'pending AuroraClient SDK calls',
    exportState: 'pending' as const,
    exportReason: 'Audit export waits for redacted Auth.AuditLog evidence.'
  }
}

function devicesLoadingSnapshot() {
  return {
    loadState: 'loading' as const,
    generatedAt: null,
    secretsRedacted: true,
    devices: [],
    listState: 'pending' as const,
    listReason: 'Loading Auth.ListDevices, Auth.ListTokens, capability catalog, and native manifest through AuroraClient.',
    tokenState: 'pending' as const,
    tokenReason: 'Loading token/session evidence through AuroraClient.',
    deleteState: 'pending' as const,
    deleteReason: 'Loading Auth.DeleteDevice capability before enabling mutations.',
    nativePlatform: null,
    nativeCapabilities: [],
    warnings: [],
    error: null,
    evidenceSource: 'pending AuroraClient SDK calls'
  }
}

function deviceCatalogWithoutDelete(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityGraphCatalogFixture)
  catalog.actions = catalog.actions.filter((action) => action.topic !== 'Auth.DeleteDevice')
  delete catalog.action_index['Auth.DeleteDevice']
  return catalog
}
