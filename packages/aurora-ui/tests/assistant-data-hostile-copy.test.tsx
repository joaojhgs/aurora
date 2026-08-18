import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  cloneFixture,
  evaluateRoutePolicy,
  routeExplainFixture,
  type PrivacyClass,
  type RoutePolicyEvaluation,
  type VoiceRuntimeEvent
} from '@aurora/client'
import {
  AssistantView,
  DataPolicyView,
  MemoryView,
  PairingQueueSurface,
  RoutePolicyView,
  RouteSheet,
  assistantPrivacyClassCopy,
  auroraEmbeddedNavItems,
  auroraNavSections,
  buildAssistantVoiceModel,
  buildPairingQueueModel,
  buildRoutePolicySnapshot,
  emptyMemoryViewModel,
  navItemSnapshot,
  routePolicyScenarios,
  assistantRemotePrivacyWarning,
  type AssistantSessionSnapshot,
  type DataPolicySnapshot,
  type MemoryViewModel,
  type PairingOperationModel,
  type RouteAvailability,
  type RoutePolicySnapshot
} from '../src/index'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

const hostile = {
  mixedReason: 'not evaluated: WebRTC transport fallback failed',
  routeReason: 'Gateway.ExplainRoute runtime provider fallback failed',
  methodId: 'Tooling.DeleteSecret',
  providerId: 'provider://mesh-peer-runtime',
  peerId: 'peer-webrtc-runtime',
  json: '{"api_key":"sk-secret","transport":"WebRTC","payload":{"token":"secret-token"}}',
  audio: 'NotReadableError: WebRTC transport runtime fallback failed',
  sdk: 'SDK native-manifest WebView daemon Orchestrator'
}

const hostileValues = Object.values(hostile)

describe('hostile production copy mapping for assistant and data surfaces', () => {
  it('does not expose hostile internal strings in rendered text or user-facing attributes', () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const route = enabledRoute('assistant')
    const evaluation = hostileEvaluation()

    const surfaces = [
      renderToStaticMarkup(<AssistantView client={client} route={route} initialSession={assistantSession()} />),
      renderToStaticMarkup(
        <AssistantView
          client={client}
          route={disabledAssistantRoute()}
          nativeAvailable
          nativePlatform={hostile.routeReason}
          nativePermissions={[{ name: hostile.routeReason, granted: false }]}
          nativeCapabilities={[{ name: hostile.methodId, enabled: false }]}
          recentVoiceEvents={hostileVoiceEvents()}
        />
      ),
      renderToStaticMarkup(<MemoryView client={client} route={enabledRoute('memory')} initialModel={memoryModel()} />),
      renderToStaticMarkup(<DataPolicyView snapshot={dataPolicySnapshot(evaluation)} />),
      renderToStaticMarkup(<RoutePolicyView snapshot={routePolicySnapshot(evaluation)} />),
      renderToStaticMarkup(<RouteSheet client={client} initialEvaluation={evaluation} payload={{ secret: hostile.json }} />),
      renderToStaticMarkup(
        <PairingQueueSurface
          model={pairingModel()}
          route={{ ...enabledRoute('admin'), disabled: true, state: 'denied', explanation: hostile.routeReason }}
          operation={{ status: 'error', message: hostile.routeReason, auditReceipt: hostile.providerId } satisfies PairingOperationModel}
          mutationError={hostile.mixedReason}
          copyError={hostile.json}
        />
      )
    ]

    for (const [index, markup] of surfaces.entries()) {
      const rendered = renderedUserCopy(markup)
      for (const value of hostileValues) {
        expect(rendered).not.toContain(value)
        expect(markup).not.toContain(value)
      }
      expect(rendered).not.toMatch(hostileCopyPattern)
      expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id), `surface ${index}: ${rendered}`).toEqual([])
    }

    const voiceModel = buildAssistantVoiceModel({
      client,
      route: disabledAssistantRoute(),
      nativePlatform: hostile.routeReason,
      nativeAvailable: true,
      nativePermissions: [{ name: hostile.routeReason, granted: false }],
      nativeCapabilities: [{ name: hostile.methodId, enabled: false }],
      captureStatus: 'idle',
      consentGranted: false,
      voiceEvents: hostileVoiceEvents(),
      waveformBars: []
    })
    const nativeCapture = voiceModel.chips.find((chip) => chip.id === 'native-capture')
    const voiceCopy = JSON.stringify({
      controls: voiceModel.controls.map((control) => ({ label: control.label, reason: control.reason })),
      visualizerSourceLabel: voiceModel.visualizerSourceLabel,
      platformTruth: voiceModel.platformTruth,
      events: voiceModel.events.map((event) => ({ label: event.label, detail: event.detail, state: event.state })),
      nativeCapture: nativeCapture ? {
        label: nativeCapture.label,
        providerLabel: nativeCapture.providerLabel,
        detail: nativeCapture.detail,
        blockers: nativeCapture.blockers,
        evidence: nativeCapture.evidence
      } : null
    })
    for (const value of hostileValues) expect(voiceCopy).not.toContain(value)
    expect(voiceCopy).not.toMatch(hostileCopyPattern)
  })

  it('keeps structured denied route-policy failures distinct from unavailable failures', async () => {
    const deniedTransport = new MockAuroraTransport()
      .fail('Gateway.ExplainRoute', 'unavailable_service', 'route explain down')
      .fail('Gateway.GetCapabilityCatalog', 'permission', 'catalog denied')
    const unavailableTransport = new MockAuroraTransport()
      .fail('Gateway.ExplainRoute', 'unavailable_service', 'route explain down')
      .fail('Gateway.GetCapabilityCatalog', 'unavailable_service', 'catalog down')

    await expect(buildRoutePolicySnapshot(new AuroraClient({ transport: deniedTransport }), enabledRoute('admin')))
      .resolves.toMatchObject({ loadState: 'denied' })
    await expect(buildRoutePolicySnapshot(new AuroraClient({ transport: unavailableTransport }), enabledRoute('admin')))
      .resolves.toMatchObject({ loadState: 'unavailable' })
  })

  it('presents shared-device choices without exposing internal availability states', () => {
    const markup = renderToStaticMarkup(<RoutePolicyView snapshot={routePolicySnapshot(hostileEvaluation())} />)
    const rendered = renderedUserCopy(markup)

    expect(rendered).toContain('How Aurora chooses a device')
    expect(rendered).toContain('Example tasks')
    expect(rendered).toContain('Device choice needed')
    expect(rendered).not.toMatch(/\b(?:route policy|decision matrix|selected scenario|route explain|available-local|available-remote|privacy-blocked|explicit selector|required provider)\b/iu)
  })

  it('keeps microphone route warnings product-safe while preserving the privacy class value', () => {
    const route = rawAudioAssistantRoute()

    const warning = assistantRemotePrivacyWarning(route)

    expect(route.item.privacyClass).toBe('raw-audio')
    expect(assistantPrivacyClassCopy('raw-audio')).toBe('Microphone audio')
    expect(assistantPrivacyClassCopy('unknown-internal')).toBe('Sensitive')
    expect(warning).toContain('Microphone audio')
    expect(warning).not.toContain('Raw audio')
    expect(warning).not.toMatch(/\braw\b/iu)
    expect(findForbiddenProductionCopyTerms(warning ?? '').map((term) => term.id)).toEqual([])
  })

  it('renders raw-audio assistant without leaking the privacy enum or showing a composer privacy badge', () => {
    const route = rawAudioAssistantRoute()
    const markup = renderToStaticMarkup(
      <AssistantView
        client={new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })}
        route={route}
        nativeAvailable
        nativePlatform={hostile.routeReason}
        nativePermissions={[{ name: hostile.routeReason, granted: false }]}
        nativeCapabilities={[{ name: hostile.methodId, enabled: false }]}
        recentVoiceEvents={hostileVoiceEvents()}
        initialSession={assistantSession()}
      />
    )
    const rendered = renderedUserCopy(markup)

    expect(route.item.privacyClass).toBe('raw-audio')
    expect(markup).not.toContain('aui-composer-route-context')
    expect(rendered).not.toContain('Microphone audio')
    expect(rendered).not.toContain('raw-audio')
    expect(rendered).not.toContain('Raw Audio')
    expect(rendered).not.toContain('Raw audio')
    expect(rendered).not.toMatch(/\braw\b/iu)
    expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id), rendered).toEqual([])
  })

  it('renders assistant audio RouteSheet policy copy without leaking the privacy enum', () => {
    const evaluation = hostileEvaluation('raw-audio')
    const markup = renderToStaticMarkup(
      <RouteSheet
        client={new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })}
        initialEvaluation={evaluation}
        payload={{ audio_privacy_class: evaluation.privacyClass, sample_format: 'pcm16' }}
        dataClasses={[evaluation.privacyClass]}
        privacyClass={evaluation.privacyClass}
      />
    )
    const rendered = renderedUserCopy(markup)

    expect(evaluation.privacyClass).toBe('raw-audio')
    expect(rendered).toContain('Microphone audio')
    expect(rendered).not.toContain('raw-audio')
    expect(rendered).not.toContain('Raw Audio')
    expect(rendered).not.toContain('Raw audio')
    expect(rendered).not.toMatch(/\braw\b/iu)
    expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id), rendered).toEqual([])
  })
})

const hostileCopyPattern = /\b(?:SDK|WebView|daemon|Orchestrator|native-manifest|WebRTC|transport|fallback|runtime|Gateway\.ExplainRoute|Tooling\.DeleteSecret|api_key|secret-token|sk-secret)\b|provider:\/\/|peer-webrtc-runtime/i

function hostileVoiceEvents(): VoiceRuntimeEvent[] {
  return [
    hostileVoiceEvent({
      id: 'voice-hostile-final',
      kind: 'transcription_final',
      topic: 'STTCoordinator.Final',
      state: 'processing',
      text: hostile.sdk,
      reason: hostile.routeReason
    }),
    hostileVoiceEvent({
      id: 'voice-hostile-denied',
      kind: 'audio_denied',
      topic: 'AudioSession.Events',
      state: 'denied',
      text: hostile.json,
      reason: hostile.mixedReason
    })
  ]
}

function hostileVoiceEvent(overrides: Partial<VoiceRuntimeEvent>): VoiceRuntimeEvent {
  return {
    id: 'voice-hostile',
    kind: 'stt_error',
    topic: 'Gateway.ExplainRoute',
    sessionId: 'session-WebRTC-runtime',
    correlationId: 'correlation-secret-token',
    sourcePeerId: hostile.peerId,
    targetPeerId: hostile.peerId,
    targetDeviceId: 'device-native-manifest',
    consentDecision: hostile.methodId,
    policyDecisionId: hostile.providerId,
    privacyClass: 'raw-audio',
    state: 'error',
    text: hostile.json,
    level: null,
    peak: null,
    bars: null,
    reason: hostile.routeReason,
    redacted: true,
    occurredAt: '2026-07-28T00:00:00Z',
    audit: {
      correlationId: 'correlation-secret-token',
      eventKind: 'Gateway.ExplainRoute',
      peerId: hostile.peerId,
      principalId: hostile.providerId,
      targetPeerId: hostile.peerId,
      method: hostile.methodId,
      busTopic: 'Gateway.ExplainRoute',
      toolId: hostile.methodId,
      resourceId: hostile.providerId,
      status: hostile.routeReason,
      transport: 'WebRTC',
      redaction: {
        secretsRedacted: true,
        redactedFields: ['api_key'],
        source: 'transport',
        warnings: [hostile.mixedReason]
      }
    },
    raw: { payload: hostile.json, reason: hostile.routeReason },
    ...overrides
  }
}

function assistantSession(): AssistantSessionSnapshot {
  return {
    sessionId: 'hostile-copy-session',
    messages: [
      {
        id: 'assistant-hostile-tool',
        role: 'assistant',
        text: 'Aurora paused for a tool approval decision.',
        createdAt: '2026-07-28T00:00:00Z',
        status: 'streaming',
        routeLabel: hostile.providerId,
        providerLabel: hostile.providerId,
        modelLabel: hostile.routeReason,
        toolCalls: [
          {
            id: 'tool-hostile',
            name: hostile.methodId,
            sessionId: 'hostile-copy-session',
            status: 'requires_action',
            riskClass: hostile.routeReason,
            target: hostile.providerId,
            dataLeavesDevice: true,
            summary: hostile.mixedReason,
            auditId: hostile.peerId,
            payloadPreview: { request: hostile.json },
            resultPreview: { result: hostile.json },
            error: hostile.audio,
            errorDetails: { reason: hostile.routeReason },
            pendingId: 'pending-hostile',
            approvalRequestId: 'approval-hostile',
            approvalExpiresAt: 1_785_196_800_000,
            policyDecisionId: hostile.providerId
          }
        ]
      }
    ]
  }
}

function memoryModel(): MemoryViewModel {
  const route = enabledRoute('memory')
  const model = {
    ...emptyMemoryViewModel(route),
    loadState: 'ready' as const,
    query: 'saved note',
    denialReason: hostile.mixedReason,
    actions: {
      ...emptyMemoryViewModel(route).actions,
      delete: { supported: false, disabled: true, label: 'Delete', reason: hostile.routeReason, requiresAdminAction: true }
    },
    searchItems: [
      {
        namespace: hostile.providerId,
        key: hostile.methodId,
        value: 'Relevant saved note.',
        score: 0.92,
        search_score: 0.92,
        redacted: true,
        redaction_reasons: [hostile.json],
        provenance: {
          namespace: hostile.providerId,
          key: hostile.methodId,
          record_id: hostile.json,
          origin_principal_id: hostile.providerId,
          created_at: '2026-07-28T00:00:00Z',
          updated_at: '2026-07-28T00:00:00Z',
          schema_version: hostile.routeReason,
          policy_decision_id: hostile.routeReason,
          correlation_id: hostile.peerId,
          imported_at: '2026-07-28T00:00:00Z',
          import_operation_id: hostile.methodId,
          source_peer_id: hostile.peerId,
          owner_peer_id: 'local-peer',
          tombstone: true,
          deleted_at: '2026-07-28T00:00:00Z',
          deleted_by: hostile.providerId,
          delete_reason: hostile.mixedReason
        }
      }
    ]
  }
  return model
}

function dataPolicySnapshot(evaluation: RoutePolicyEvaluation): DataPolicySnapshot {
  return {
    loadState: 'ready',
    generatedAt: '2026-07-28T00:00:00Z',
    route: enabledRoute('data'),
    namespaces: [
      {
        namespace: hostile.methodId,
        source_peer_id: hostile.peerId,
        owner_peer_id: 'local-peer',
        provider_peer_id: hostile.providerId,
        availability: 'denied',
        policy: {
          sharing_mode: 'remote_query',
          privacy_class: 'sensitive',
          allowed_operations: [],
          explicit_selector_required: true,
          export_supported: false,
          import_supported: false,
          delete_supported: false,
          requires_admin_approval: false,
          denial_reason: hostile.mixedReason
        },
        record_count: 3,
        embedding_model: hostile.providerId,
        schema_version: hostile.routeReason,
        freshness: hostile.json
      }
    ],
    conversations: [],
    checks: [
      {
        id: 'hostile-data-policy',
        label: 'Shared-device help',
        description: 'Review shared-device help.',
        routeRequest: { topic: hostile.methodId, module: 'Tooling', method: 'DeleteSecret' },
        payload: { secret: hostile.json },
        selector: { provider_id: hostile.providerId },
        privacyClass: 'sensitive',
        dataClasses: ['sensitive'],
        consentGranted: false,
        privacyIndicatorShown: false,
        allowCloudFallback: true,
        auditReceiptTarget: hostile.providerId,
        evaluation,
        error: hostile.routeReason
      }
    ],
    error: hostile.audio,
    warnings: [hostile.mixedReason],
    secretsRedacted: true
  }
}

function disabledAssistantRoute(): RouteAvailability {
  return {
    ...enabledRoute('assistant'),
    state: 'denied',
    disabled: true,
    routeable: false,
    explanation: hostile.routeReason,
    providerLabel: hostile.providerId,
    blockers: [hostile.mixedReason],
    evidenceSources: [hostile.json]
  }
}

function routePolicySnapshot(evaluation: RoutePolicyEvaluation): RoutePolicySnapshot {
  const scenario = routePolicyScenarios()[0]!
  return {
    loadState: 'ready',
    generatedAt: '2026-07-28T00:00:00Z',
    secretsRedacted: true,
    routeState: 'privacy-blocked',
    routeReason: hostile.routeReason,
    policyCapabilityState: 'degraded',
    policyCapabilityReason: hostile.mixedReason,
    configCapabilityState: 'denied',
    configCapabilityReason: hostile.routeReason,
    canEditPolicy: false,
    scenarios: [
      {
        scenario,
        state: 'privacy-blocked',
        evaluation,
        error: hostile.audio
      }
    ],
    selectedScenarioId: scenario.id,
    persistedReceipt: hostile.providerId,
    error: hostile.routeReason,
    warnings: [hostile.mixedReason],
    evidenceSource: hostile.json
  }
}

function pairingModel() {
  return buildPairingQueueModel({
    route: { ...enabledRoute('admin'), disabled: true, state: 'denied', explanation: hostile.routeReason },
    loadState: 'error',
    error: { code: 'transport_loss', message: hostile.mixedReason }
  })
}

function hostileEvaluation(privacyClass: PrivacyClass = 'sensitive'): RoutePolicyEvaluation {
  const route = cloneFixture(routeExplainFixture)
  route.selected_target = hostile.providerId
  route.selected_provider_id = hostile.providerId
  route.selected_peer_id = hostile.peerId
  route.selected_service_instance_id = hostile.methodId
  route.selector_valid = false
  route.selector_validation_code = hostile.mixedReason
  route.selector_validation_message = hostile.routeReason
  route.fallback_behavior = hostile.mixedReason
  route.candidates = [
    {
      provider_id: hostile.providerId,
      peer_id: hostile.peerId,
      provider_kind: hostile.routeReason,
      service_instance_id: hostile.methodId,
      module: hostile.methodId,
      version: '1',
      included: false,
      selected: true,
      reason_code: hostile.mixedReason,
      reason: hostile.routeReason,
      latency_ms: 45,
      active_calls: 1,
      max_concurrent: 2,
      available_capacity: 1,
      blockers: [
        {
          code: hostile.mixedReason,
          message: hostile.routeReason,
          severity: 'error',
          provider_id: hostile.providerId,
          peer_id: hostile.peerId,
          security_privacy: true
        }
      ]
    }
  ]
  route.blockers = [
    {
      code: hostile.mixedReason,
      message: hostile.routeReason,
      severity: 'error',
      provider_id: hostile.providerId,
      peer_id: hostile.peerId,
      security_privacy: true
    }
  ]
  route.security_privacy_blockers = [...route.blockers]
  return evaluateRoutePolicy({
    route,
    catalog: null,
    topic: hostile.methodId,
    method: 'DeleteSecret',
    payload: { prompt: hostile.json },
    privacyClass,
    transportKind: hostile.routeReason
  })
}

function enabledRoute(id: string): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === id)
    ?? auroraEmbeddedNavItems.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`missing route ${id}`)
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Available on this device.',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false
  }
}

function rawAudioAssistantRoute(): RouteAvailability {
  const route = enabledRoute('assistant')
  return {
    ...route,
    item: { ...route.item, privacyClass: 'raw-audio' as PrivacyClass },
    state: 'available-remote',
    providerLabel: 'peer-WebRTC-runtime',
    explanation: 'remote WebRTC transport runtime fallback',
    candidateProviders: [{
      id: 'remote:peer-WebRTC-runtime:Orchestrator',
      label: 'remote WebRTC runtime',
      state: 'available-remote',
      reason: 'transport ready',
      providerKind: 'remote',
      selectable: true,
      requiredAction: null,
    }],
  }
}

function renderedUserCopy(markup: string): string {
  const attributes = Array.from(markup.matchAll(/\s(?:aria-label|title|placeholder|disabledreason|data-(?!slot|variant|size|state)[a-z0-9-]+)="([^"]*)"/giu), (match) => match[1] ?? '')
  const text = markup
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities([text, ...attributes].join(' ')).replace(/\s+/g, ' ').trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
