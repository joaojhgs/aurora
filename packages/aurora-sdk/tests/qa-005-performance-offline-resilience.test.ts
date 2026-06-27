import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  HttpGatewayTransport,
  MeshP2PTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  capabilityGraphCatalogFixture,
  cloneFixture,
  normalizeToolCatalog,
  summarizeCapabilities,
  toolCatalogFixture,
  type AuroraEvent,
  type AuroraStreamRequest,
  type CapabilityActionInfo,
  type CapabilityCatalogResponse,
  type CapabilityProviderInfo,
  type ToolCatalogEntry,
  type ToolCatalogResponse
} from '../src/index.js'

const LARGE_LIST_BUDGET_MS = 100

describe('QA-005 performance, offline, and resilience gate', () => {
  it('reconnects assistant event streams from the last backend-proven event id without duplicate replay', async () => {
    const subscribeLastEventIds: Array<string | null | undefined> = []
    let streamAttempt = 0
    const transport = MockAuroraTransport.empty().stream('assistant', async function* (
      request: AuroraStreamRequest
    ): AsyncIterable<Record<string, unknown>> {
      subscribeLastEventIds.push(request.lastEventId)
      streamAttempt += 1

      if (streamAttempt === 1) {
        yield assistantEvent('evt-1', 'assistant.delta', 'Hel')
        throw new TypeError('simulated SSE reconnect')
      }

      yield assistantEvent('evt-2', 'assistant.delta', 'lo')
      yield assistantEvent('evt-3', 'assistant.completed', 'Hello')
    })
    const client = new AuroraClient({ transport })

    const events = await collectEvents(
      client.events.streamAssistant(undefined, {
        reconnect: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
      })
    )

    expect(subscribeLastEventIds).toEqual([null, 'evt-1'])
    expect(events.map((event) => event.id)).toEqual(['evt-1', 'evt-2', 'evt-3'])
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    expect(events.every((event) => event.audit.transport === 'mock')).toBe(true)
    expect(events.every((event) => event.redaction.secretsRedacted)).toBe(true)
  })

  it('reports offline transport loss and unsupported native/event surfaces without marking production ready', async () => {
    const offlineClient = new AuroraClient({
      transport: MockAuroraTransport.empty().lose('Gateway.GetRegistry', 'gateway offline')
    })
    const offlineResult = await offlineClient.requestResult('Gateway.GetRegistry')

    expect(offlineResult.ok).toBe(false)
    if (!offlineResult.ok) {
      expect(offlineResult.error.code).toBe('transport_loss')
      expect(offlineResult.audit).toMatchObject({
        method: 'Gateway.GetRegistry',
        busTopic: 'Gateway.GetRegistry',
        transport: 'mock'
      })
    }

    const httpClient = new AuroraClient({
      transport: new HttpGatewayTransport({
        baseUrl: 'http://aurora.local',
        fetchImpl: async () => {
          throw new TypeError('network unreachable')
        }
      })
    })

    expect(() => httpClient.native.getManifest()).toThrowError(/Native capability manifest/)
    await expect(collectEvents(httpClient.events.watchHealth())).rejects.toMatchObject({ code: 'unsupported_feature' })

    const tauriTransport = new TauriLocalTransport({
      invoke: async (command) => {
        if (command === 'aurora_sidecar_status') {
          return {
            running: false,
            mode: 'sidecar',
            pid: null,
            gatewayUrl: null,
            version: null,
            lastError: 'gateway offline',
            details: { artifact: 'apps/aurora-tauri/reports/qa-005-sidecar-smoke.log' }
          }
        }
        throw new TypeError(`offline ${command}`)
      }
    })

    await expect(tauriTransport.getSidecarStatus()).resolves.toMatchObject({
      running: false,
      lastError: 'gateway offline',
      details: { artifact: 'apps/aurora-tauri/reports/qa-005-sidecar-smoke.log' }
    })
    await expect(tauriTransport.startSidecar()).rejects.toMatchObject({ code: 'native_permission_missing' })
  })

  it('preserves mesh failover, degraded route, and audit evidence through public SDK calls', async () => {
    const calls: string[] = []
    const client = new AuroraClient({
      transport: new MeshP2PTransport({
        defaultPeerId: 'peer-primary',
        fallbackPeerIds: ['peer-fallback'],
        routeResolver: () => ({
          peerId: 'peer-fallback',
          selector: { peer_id: 'peer-fallback', module: 'Gateway' },
          fallbackAllowed: true,
          candidates: [
            {
              peerId: 'peer-primary',
              providerId: 'mesh:peer-primary:Gateway',
              serviceInstanceId: 'gateway-primary',
              module: 'Gateway',
              eligible: false,
              reasonCode: 'stale'
            },
            {
              peerId: 'peer-fallback',
              providerId: 'mesh:peer-fallback:Gateway',
              serviceInstanceId: 'gateway-fallback',
              module: 'Gateway',
              eligible: true,
              reasonCode: null,
              fallback: true
            }
          ]
        }),
        bridge: {
          async call(request) {
            calls.push(request.peerId)
            return {
              data: {
                ...cloneFixture(capabilityGraphCatalogFixture),
                providers: [
                  unavailableProvider('mesh:peer-primary:Gateway', 'peer-primary', 'stale'),
                  eligibleProvider('mesh:peer-fallback:Gateway', 'peer-fallback')
                ],
                actions: [
                  {
                    ...cloneFixture(capabilityGraphCatalogFixture.actions[0]),
                    action_id: 'gateway.health.fallback',
                    provider_id: 'mesh:peer-fallback:Gateway',
                    peer_id: 'peer-fallback',
                    provider_kind: 'remote',
                    bindability: 'degraded',
                    route_blockers: []
                  }
                ],
                provider_index: { Gateway: ['mesh:peer-fallback:Gateway'] },
                action_index: { 'Gateway.GetCapabilityCatalog': ['gateway.health.fallback'] }
              },
              status: 200,
              fallbackUsed: true,
              targetPeerId: request.peerId,
              providerId: 'mesh:peer-fallback:Gateway',
              serviceInstanceId: 'gateway-fallback',
              correlationId: 'corr-mesh-failover',
              secretsRedacted: true
            }
          }
        }
      })
    })

    const result = await client.requestResult<CapabilityCatalogResponse, { include_unavailable: boolean }>(
      'Gateway.GetCapabilityCatalog',
      { include_unavailable: true }
    )

    expect(calls).toEqual(['peer-fallback'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.audit).toMatchObject({
        correlationId: 'corr-mesh-failover',
        targetPeerId: 'peer-fallback',
        transport: 'mesh',
        redaction: { secretsRedacted: true }
      })
      expect(summarizeCapabilities(result.data)).toEqual([
        expect.objectContaining({
          id: 'gateway.health.fallback',
          peerId: 'peer-fallback',
          availability: 'degraded',
          routeBlockers: []
        })
      ])
    }
  })

  it('keeps large capability and tool lists within the QA-005 budget without dropping policy fields', () => {
    const catalog = largeCapabilityCatalog(1_200)
    const tools = largeToolCatalog(1_200)

    const startedAt = Date.now()
    const capabilitySummaries = summarizeCapabilities(catalog)
    const toolCards = normalizeToolCatalog(tools)
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(LARGE_LIST_BUDGET_MS)
    expect(capabilitySummaries).toHaveLength(1_200)
    expect(toolCards).toHaveLength(1_200)
    expect(capabilitySummaries[0]).toEqual(
      expect.objectContaining({
        providerId: 'provider-large-0',
        peerId: 'peer-large-0',
        availability: 'available-remote',
        requiredPermissions: ['Gateway.use']
      })
    )
    expect(toolCards[0]).toEqual(
      expect.objectContaining({
        id: 'tool.large.0',
        providerPeerId: 'peer-large-0',
        approvalRequired: true,
        selectorRequired: true,
        secretsRedacted: true
      })
    )
  })
})

async function collectEvents<TPayload>(
  subscription: AsyncIterable<AuroraEvent<TPayload>>
): Promise<Array<AuroraEvent<TPayload>>> {
  const events: Array<AuroraEvent<TPayload>> = []
  for await (const event of subscription) {
    events.push(event)
  }
  return events
}

function assistantEvent(id: string, kind: string, text: string): Record<string, unknown> {
  return {
    id,
    kind,
    topic: 'Orchestrator.Response',
    payload: {
      text_delta: text,
      session_id: 'qa-005-session',
      correlation_id: `corr-${id}`,
      secrets_redacted: true
    }
  }
}

function largeCapabilityCatalog(count: number): CapabilityCatalogResponse {
  const base = cloneFixture(capabilityGraphCatalogFixture)
  const sourceAction = base.actions[0]
  if (!sourceAction) throw new Error('capability fixture must include at least one action')
  const providers: CapabilityProviderInfo[] = []
  const actions: CapabilityActionInfo[] = []
  const providerIndex: Record<string, string[]> = {}
  const actionIndex: Record<string, string[]> = {}

  for (let index = 0; index < count; index += 1) {
    const provider = eligibleProvider(`provider-large-${index}`, `peer-large-${index}`)
    const action: CapabilityActionInfo = {
      ...cloneFixture(sourceAction),
      action_id: `action.large.${index}`,
      provider_id: provider.provider_id,
      peer_id: provider.peer_id,
      provider_kind: 'remote',
      service_instance_id: provider.service_instance_id,
      policy: {
        ...cloneFixture(sourceAction.policy),
        required_permissions: ['Gateway.use'],
        explicit_selector_required: false,
        selector_required: false,
        consent_required: false,
        privacy_indicator_required: false,
        denial_reasons: []
      },
      freshness: {
        ...cloneFixture(sourceAction.freshness),
        stale: false
      },
      route_blockers: [],
      bindability: 'available'
    }
    providers.push(provider)
    actions.push(action)
    const providerIndexKey = action.module
    const actionIndexKey = action.topic ?? action.action_id
    providerIndex[providerIndexKey] = [...(providerIndex[providerIndexKey] ?? []), provider.provider_id]
    actionIndex[actionIndexKey] = [...(actionIndex[actionIndexKey] ?? []), action.action_id]
  }

  return {
    ...base,
    providers,
    actions,
    provider_index: providerIndex,
    action_index: actionIndex
  }
}

function largeToolCatalog(count: number): ToolCatalogResponse {
  const sourceTool = toolCatalogFixture.tools[0]
  if (!sourceTool) throw new Error('tool fixture must include at least one tool')
  const base = cloneFixture(sourceTool)
  const tools: ToolCatalogEntry[] = []
  for (let index = 0; index < count; index += 1) {
    tools.push({
      ...base,
      global_tool_id: `tool.large.${index}`,
      display_name: `Large Tool ${index}`,
      provider_id: `provider-large-${index}`,
      provider_peer_id: `peer-large-${index}`,
      service_instance_id: `tooling-large-${index}`,
      provider_kind: 'remote',
      approval_required: true,
      explicit_selector_required: true,
      secrets_redacted: true
    })
  }
  return {
    generated_at: '2026-06-27T00:00:00Z',
    tools,
    secrets_redacted: true
  }
}

function eligibleProvider(providerId: string, peerId: string): CapabilityProviderInfo {
  const sourceProvider = capabilityGraphCatalogFixture.providers[0]
  if (!sourceProvider) throw new Error('capability fixture must include at least one provider')
  const base = cloneFixture(sourceProvider)
  return {
    ...base,
    provider_id: providerId,
    peer_id: peerId,
    provider_kind: 'remote',
    node_name: peerId,
    status: 'available',
    service_instance_id: `${providerId}:service`,
    eligible: true,
    reason_code: '',
    reason: ''
  }
}

function unavailableProvider(providerId: string, peerId: string, reasonCode: string): CapabilityProviderInfo {
  return {
    ...eligibleProvider(providerId, peerId),
    status: 'stale',
    eligible: false,
    reason_code: reasonCode,
    reason: reasonCode
  }
}
