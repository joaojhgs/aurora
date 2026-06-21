import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  AuroraError,
  MockAuroraTransport,
  capabilityCatalogFixture,
  cloneFixture,
  evaluateRoutePolicy,
  normalizeToolCatalog,
  routeExplainFixture,
  toolCatalogFixture,
  type CapabilityActionInfo,
  type CapabilityCatalogResponse,
  type CapabilityProviderInfo
} from '@aurora/client'
import {
  AppShell,
  AssistantView,
  OnboardingView,
  RouteSheet,
  buildOnboardingViewModel,
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
  buildShellSnapshot,
  errorShellSnapshot,
  routeSheetErrorMessage,
  routePolicyFromRoute
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
      <AssistantView client={new AuroraClient({ transport: new MockAuroraTransport() })} route={enabledRoute} />
    )

    expect(markup).toContain('Text chat')
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
      <AssistantView client={new AuroraClient({ transport: new MockAuroraTransport() })} route={assistantRoute} />
    )
    expect(disabledMarkup).toContain('Assistant send is disabled')
    expect(disabledMarkup).toContain('Assistant capability is unavailable')
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
})

function route(snapshot: Awaited<ReturnType<typeof buildShellSnapshot>>, id: string) {
  const match = snapshot.routes.find((candidate) => candidate.item.id === id)
  if (!match) throw new Error(`missing route ${id}`)
  return match
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
