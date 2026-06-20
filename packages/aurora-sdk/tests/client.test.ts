import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  buildAdminOverviewManifest,
  capabilityCatalogFixture,
  describeRegistry,
  gatewayBuiltinRoutesFixture,
  gatewayServicesFixture,
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

  it('builds an admin overview manifest from backend evidence only', async () => {
    const catalog = {
      ...capabilityCatalogFixture,
      actions: [
        {
          action_id: 'gateway-catalog',
          module: 'Gateway',
          method: 'GetCapabilityCatalog',
          topic: 'Gateway.GetCapabilityCatalog',
          tool_id: null,
          resource_id: null,
          provider_id: 'local:Gateway',
          peer_id: 'local-peer',
          provider_kind: 'local',
          service_instance_id: 'gateway-local',
          selector: { peer_id: 'local-peer', module: 'Gateway' },
          bindability: 'available',
          sdk_operation_kind: 'bus_method',
          route_hints: [],
          route_blockers: [],
          summary: 'Capability catalog',
          input_schema: null,
          output_schema: null,
          policy: {
            required_permissions: ['Gateway.manage'],
            trust_tier: 'local',
            safety_class: 'admin',
            explicit_selector_required: false,
            consent_required: false,
            privacy_indicator_required: false,
            bandwidth_check_required: false,
            approval_required: false,
            selector_required: false,
            mesh_visible: false,
            local_only: false,
            allowed_peers: null,
            operation_class: 'admin',
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

    const manifest = buildAdminOverviewManifest({
      registry: gatewayRegistryFixture,
      services: gatewayServicesFixture,
      capabilityCatalog: catalog,
      gatewayBuiltins: gatewayBuiltinRoutesFixture,
      nativeManifest: null,
      peers: [],
      generatedAt: '2026-06-19T12:00:00Z'
    })

    expect(manifest.generatedAt).toBe('2026-06-19T12:00:00Z')
    expect(manifest.serviceMode).toBe('threads')
    expect(manifest.totals).toEqual(
      expect.objectContaining({
        services: 1,
        methods: 2,
        externalMethods: 1,
        internalMethods: 1,
        gatewayBuiltins: 2,
        capabilityActions: 1
      })
    )
    expect(manifest.services[0]).toEqual(
      expect.objectContaining({
        module: 'Gateway',
        status: 'healthy',
        requiredPermissions: ['Gateway.manage', 'Gateway.use']
      })
    )
    expect(manifest.internalOnly).toHaveLength(1)
    expect(manifest.internalOnly[0]?.busTopic).toBe('Gateway.InternalOnly')
    expect(manifest.permissionCatalog).toEqual(['Auth.manage', 'Gateway.manage', 'Gateway.use'])
    expect(manifest.native).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        evidenceSource: 'not-provided'
      })
    )
    expect(manifest.privacy).toEqual({
      secretsRedacted: true,
      nativeStateInvented: false,
      peerStateInvented: false
    })
  })

  it('loads the admin overview manifest through the client namespace', async () => {
    const transport = new MockAuroraTransport()
      .register('Gateway.GetRegistry', gatewayRegistryFixture)
      .register('Gateway.GetServices', gatewayServicesFixture)
      .register('Gateway.GetCapabilityCatalog', capabilityCatalogFixture)
    const client = new AuroraClient({ transport })

    const manifest = await client.adminOverview.getManifest({
      gatewayBuiltins: gatewayBuiltinRoutesFixture,
      generatedAt: '2026-06-19T12:00:00Z'
    })

    expect(manifest.registryDigest).toBe('fixture')
    expect(manifest.gatewayBuiltins.map((route) => route.routePath)).toEqual([
      '/api/admin/peers',
      '/api/health'
    ])
    expect(manifest.native.availability).toBe('unsupported')
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
