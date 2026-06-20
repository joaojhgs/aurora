import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  capabilityCatalogFixture,
  createAuditReceipt,
  createAuroraEvent,
  describeRegistry,
  gatewayRegistryFixture
} from '../src/index.js'

describe('AuroraClient', () => {
  it('loads registry methods and preserves permission casing', async () => {
    const transport = new MockAuroraTransport().register('Gateway.GetRegistry', gatewayRegistryFixture)
    const client = new AuroraClient({ transport })

    const methods = await client.registry.listMethods()

    expect(methods).toEqual([
      expect.objectContaining({
        busTopic: 'Gateway.GetRegistry',
        routePath: '/api/Gateway/GetRegistry',
        requiredPermissions: ['Gateway.use'],
        availableOverHttp: true
      }),
      expect.objectContaining({
        busTopic: 'Gateway.InternalOnly',
        routePath: null,
        requiredPermissions: ['Gateway.manage'],
        availableOverHttp: false
      })
    ])
  })

  it('summarizes capability catalog responses without inventing state', async () => {
    const catalog = {
      ...capabilityCatalogFixture,
      actions: [
        {
          action_id: 'tts-local',
          module: 'TTS',
          method: 'Synthesize',
          topic: 'TTS.Synthesize',
          tool_id: null,
          resource_id: null,
          provider_id: 'local:TTS',
          peer_id: 'local-peer',
          provider_kind: 'local',
          service_instance_id: 'tts-local',
          selector: { peer_id: 'local-peer', module: 'TTS' },
          bindability: 'available',
          sdk_operation_kind: 'bus_method',
          route_hints: [],
          route_blockers: [],
          summary: 'Synthesize speech',
          input_schema: null,
          output_schema: null,
          policy: {
            required_permissions: ['TTS.use'],
            trust_tier: 'local',
            safety_class: 'standard',
            explicit_selector_required: false,
            consent_required: false,
            privacy_indicator_required: false,
            bandwidth_check_required: false,
            approval_required: false,
            selector_required: false,
            mesh_visible: false,
            local_only: false,
            allowed_peers: null,
            operation_class: null,
            resource_scope: null,
            denial_reasons: []
          },
          freshness: {
            source: 'registry',
            manifest_time: null,
            last_probe_age_s: null,
            ttl_s: null,
            stale: false,
            registry_digest: 'fixture'
          }
        }
      ]
    }
    const transport = new MockAuroraTransport().register('Gateway.GetCapabilityCatalog', catalog)
    const client = new AuroraClient({ transport })

    await expect(client.capabilities.listSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: 'tts-local',
        availability: 'available-local',
        requiredPermissions: ['TTS.use'],
        peerId: 'local-peer'
      })
    ])
  })

  it('returns classified result errors for permissions and transport loss', async () => {
    const permissionTransport = new MockAuroraTransport().fail('Gateway.GetRegistry', 'permission', 'Forbidden')
    const permissionClient = new AuroraClient({ transport: permissionTransport })
    const permissionResult = await permissionClient.result(() => permissionClient.registry.getRegistry())

    expect(permissionResult.ok).toBe(false)
    if (!permissionResult.ok) expect(permissionResult.error.code).toBe('permission')

    const transportLoss = {
      kind: 'mock',
      request: async () => {
        throw new TypeError('network unavailable')
      }
    }
    const transportClient = new AuroraClient({ transport: transportLoss })
    const lossResult = await transportClient.result(() => transportClient.registry.getRegistry())

    expect(lossResult.ok).toBe(false)
    if (!lossResult.ok) expect(lossResult.error.code).toBe('transport_loss')
  })

  it('normalizes successful results with audit and redaction metadata', async () => {
    const transport = new MockAuroraTransport().register('Gateway.ExplainRoute', {
      data: {
        topic: 'TTS.Synthesize',
        correlation_id: 'corr-route-1',
        peer_id: 'local-peer',
        target_peer_id: 'remote-peer',
        method: 'ExplainRoute',
        bus_topic: 'Gateway.ExplainRoute',
        status: 'success',
        secrets_redacted: true,
        redacted_fields: ['selector.token']
      },
      audit: {
        transport: 'mock'
      },
      status: 200
    })
    const client = new AuroraClient({ transport })

    const result = await client.result(() => client.routes.explain({ topic: 'TTS.Synthesize' }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.audit).toEqual(
        expect.objectContaining({
          correlationId: 'corr-route-1',
          peerId: 'local-peer',
          targetPeerId: 'remote-peer',
          method: 'ExplainRoute',
          busTopic: 'Gateway.ExplainRoute',
          status: 'success',
          transport: 'mock',
          redaction: expect.objectContaining({
            secretsRedacted: true,
            redactedFields: ['selector.token'],
            source: 'backend'
          })
        })
      )
    }
  })

  it('normalizes direct transport envelopes into one result shape', async () => {
    const transport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      fetchImpl: async () =>
        new Response(JSON.stringify({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 }), {
          status: 200,
          headers: { 'x-correlation-id': 'corr-http-200' }
        })
    })
    const client = new AuroraClient({ transport })

    const result = await client.requestResult<{ digest: string }>('Gateway.GetRegistry', {}, { path: '/api/Gateway/GetRegistry' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.digest).toBe('fixture')
      expect(result.audit).toEqual(
        expect.objectContaining({
          correlationId: 'corr-http-200',
          method: 'Gateway.GetRegistry',
          busTopic: 'Gateway.GetRegistry',
          transport: 'http',
          redaction: expect.objectContaining({
            secretsRedacted: true,
            source: 'sdk'
          })
        })
      )
    }
  })

  it('classifies HTTP auth, validation, timeout, and unavailable service failures', async () => {
    const responses = [401, 422, 504, 503]
    const expected = ['auth', 'validation', 'timeout', 'unavailable_service']
    for (const [index, status] of responses.entries()) {
      const transport = new HttpGatewayTransport({
        baseUrl: 'http://aurora.local',
        fetchImpl: async () =>
          new Response(JSON.stringify({ detail: { message: `status ${status}` } }), { status })
      })
      const client = new AuroraClient({ transport })
      const result = await client.result(() => client.registry.getRegistry())

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(expected[index])
    }
  })

  it('preserves HTTP correlation headers on classified failures', async () => {
    const transport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { message: 'Forbidden' } }), {
          status: 403,
          headers: { 'x-correlation-id': 'corr-http-403' }
        })
    })
    const client = new AuroraClient({ transport })
    const result = await client.result(() => client.registry.getRegistry())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission')
      expect(result.error.correlationId).toBe('corr-http-403')
      expect(result.audit).toEqual(
        expect.objectContaining({
          correlationId: 'corr-http-403',
          method: 'Gateway.GetRegistry',
          busTopic: 'Gateway.GetRegistry',
          status: 'permission',
          transport: 'http'
        })
      )
    }
  })

  it('classifies unsupported, privacy blocked, and native permission errors', async () => {
    const unsupportedClient = new AuroraClient({ transport: new MockAuroraTransport() })
    const unsupported = await unsupportedClient.result(() => unsupportedClient.registry.getRegistry())
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.error.code).toBe('unsupported_feature')

    const privacyTransport = new MockAuroraTransport().fail(
      'Gateway.ExplainRoute',
      'privacy_blocked',
      'Explicit selector required'
    )
    const privacyClient = new AuroraClient({ transport: privacyTransport })
    const privacy = await privacyClient.result(() => privacyClient.routes.explain({ topic: 'TTS.Synthesize' }))
    expect(privacy.ok).toBe(false)
    if (!privacy.ok) expect(privacy.error.code).toBe('privacy_blocked')

    const nativeClient = new AuroraClient({
      transport: new MockAuroraTransport().register('Native.GetCapabilityManifest', {
        platform: 'android',
        permissions: { microphone: false },
        capabilities: {}
      })
    })
    const native = await nativeClient.result(async () => {
      const manifest = await nativeClient.native.getManifest()
      nativeClient.native.requirePermission('microphone', manifest)
      return manifest
    })
    expect(native.ok).toBe(false)
    if (!native.ok) expect(native.error.code).toBe('native_permission_missing')
  })

  it('builds canonical audit receipts and event envelopes from backend-shaped payloads', () => {
    const receipt = createAuditReceipt({
      correlation_id: 'corr-event-1',
      event_kind: 'tool.executed',
      principal_id: 'principal-1',
      peer_id: 'local-peer',
      target_peer_id: 'remote-peer',
      method: 'ExecuteTool',
      bus_topic: 'Tooling.ExecuteTool',
      tool_id: 'tool:remote:file-search',
      resource_id: 'resource:docs',
      result: 'success',
      secrets_redacted: true
    })

    expect(receipt).toEqual(
      expect.objectContaining({
        correlationId: 'corr-event-1',
        eventKind: 'tool.executed',
        principalId: 'principal-1',
        peerId: 'local-peer',
        targetPeerId: 'remote-peer',
        method: 'ExecuteTool',
        busTopic: 'Tooling.ExecuteTool',
        toolId: 'tool:remote:file-search',
        resourceId: 'resource:docs',
        status: 'success'
      })
    )

    const event = createAuroraEvent('tool.executed', {
      id: 'event-1',
      topic: 'Tooling.ExecuteTool',
      correlation_id: 'corr-event-1',
      secrets_redacted: true
    })

    expect(event).toEqual(
      expect.objectContaining({
        id: 'event-1',
        kind: 'tool.executed',
        topic: 'Tooling.ExecuteTool',
        busTopic: 'Tooling.ExecuteTool',
        audit: expect.objectContaining({
          correlationId: 'corr-event-1',
          eventKind: 'tool.executed'
        }),
        redaction: expect.objectContaining({ secretsRedacted: true })
      })
    )
  })
})

describe('descriptors', () => {
  it('uses bus topic plus method name as identity source', () => {
    expect(describeRegistry(gatewayRegistryFixture)[0]).toEqual(
      expect.objectContaining({
        name: 'GetRegistry',
        busTopic: 'Gateway.GetRegistry'
      })
    )
  })

  it('can carry explicit AuroraError metadata', () => {
    const error = new AuroraError({
      code: 'validation',
      message: 'Invalid request',
      busTopic: 'Gateway.GetRegistry',
      correlationId: 'corr-1'
    })

    expect(error.busTopic).toBe('Gateway.GetRegistry')
    expect(error.correlationId).toBe('corr-1')
  })
})
