import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  cloneFixture,
  evaluateRoutePolicy,
  routeExplainFixture,
  type PrivacyClass,
  type RoutePolicyEvaluation
} from '@aurora/client'
import {
  AssistantView,
  DataPolicyView,
  MemoryView,
  PairingQueueSurface,
  RoutePolicyView,
  RouteSheet,
  auroraEmbeddedNavItems,
  auroraNavSections,
  buildPairingQueueModel,
  emptyMemoryViewModel,
  navItemSnapshot,
  routePolicyScenarios,
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
  audio: 'NotReadableError: WebRTC transport runtime fallback failed'
}

const hostileValues = Object.values(hostile)

describe('hostile production copy mapping for assistant and data surfaces', () => {
  it('does not expose hostile internal strings in rendered text or user-facing attributes', () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const route = enabledRoute('assistant')
    const evaluation = hostileEvaluation()

    const surfaces = [
      renderToStaticMarkup(<AssistantView client={client} route={route} initialSession={assistantSession()} />),
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
      expect(rendered).not.toMatch(/\b(WebRTC|transport|fallback|runtime|provider|Tooling\.DeleteSecret|secret-token|api_key)\b/i)
      expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id), `surface ${index}: ${rendered}`).toEqual([])
    }
  })
})

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
    namespaces: [],
    conversations: [],
    checks: [
      {
        id: 'hostile-data-policy',
        label: 'Shared-device help',
        description: 'Review shared-device help.',
        routeRequest: { topic: hostile.methodId, module: 'Tooling', method: 'DeleteSecret' },
        payload: { secret: hostile.json },
        selector: { providerId: hostile.providerId },
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

function hostileEvaluation(): RoutePolicyEvaluation {
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
    privacyClass: 'sensitive' as PrivacyClass,
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

function renderedUserCopy(markup: string): string {
  const attributes = Array.from(markup.matchAll(/\s(?:aria-label|title|placeholder|disabledreason)="([^"]*)"/giu), (match) => match[1] ?? '')
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
