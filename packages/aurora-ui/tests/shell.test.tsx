import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  AuroraError,
  MockAuroraTransport,
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  capabilityCatalogFixture,
  capabilityGraphCatalogFixture,
  cloneFixture,
  evaluateRoutePolicy,
  gatewayRegistryFixture,
  modelRuntimeCatalogFixture,
  normalizeToolCatalog,
  routeExplainFixture,
  toolCatalogFixture,
  type AdminOverviewManifest,
  type CapabilityActionInfo,
  type CapabilityCatalogResponse,
  type CapabilityProviderInfo,
  type GetRegistryResponse,
  type GetServicesResponse,
  type PendingPairingEntry
} from '@aurora/client'
import {
  AdminOverviewContent,
  AdminOverviewView,
  AdminServicesView,
  AdminRbacView,
  AppShell,
  AssistantView,
  ModelsView,
  MemoryView,
  OnboardingView,
  PairingQueueSurface,
  PairingQueueView,
  RouteSheet,
  buildAdminServicesSnapshot,
  buildAdminRbacSnapshot,
  buildRbacPermissionPatchAction,
  buildOnboardingViewModel,
  buildPairingAdminActionRequest,
  buildPairingQueueModel,
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
  buildAssistantVoiceModel,
  buildMemoryViewModel,
  buildShellSnapshot,
  buildModelsViewModel,
  buildSettingsPermissionsModel,
  errorShellSnapshot,
  parsePermissionList,
  pairingErrorMessage,
  routePolicyFromRoute,
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
  })

  it('renders model runtime UI with disabled AdminAction operations and SDK error states', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      transportKind: 'mock'
    })
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const markup = renderToStaticMarkup(
      <ModelsView client={client} initialCatalog={modelRuntimeCatalogFixture} initialGraph={graph} />
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
    expect(markup).toContain('native_provider_missing')
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

function enabledRoute(match: ReturnType<typeof route>) {
  return {
    ...match,
    state: 'available-local' as const,
    disabled: false,
    providerLabel: 'local / Tooling.GetToolCatalog',
    blockers: [],
    routeable: true
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

function adminOverviewStateMatrixManifest(): AdminOverviewManifest {
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
    generatedAt: '2026-06-19T00:00:00Z'
  })
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
