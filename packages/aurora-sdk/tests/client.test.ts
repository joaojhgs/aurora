import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  backendInventoryFixture,
  buildPermissionCatalog,
  buildPermissionCatalogFromBackendInventory,
  checkAccess,
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  capabilityCatalogFixture,
  createAuditReceipt,
  createAuroraEvent,
  describeBackendInventory,
  describeRegistry,
  gatewayBuiltinRoutesFixture,
  gatewayServicesFixture,
  gatewayRegistryFixture,
  hasPermission,
  permissionLabel,
  resolveEffectivePermissions,
  wildcardIntersection
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

  it('builds a deterministic capability graph with separate local and remote providers', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: {
        platform: 'android',
        permissions: { microphone: true },
        capabilities: { microphoneCapture: true }
      },
      transportKind: 'http'
    })

    const tts = graph.byFeatureId['method:TTS.Synthesize']
    expect(tts).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'local',
        routeable: true
      })
    )
    expect(tts?.providers.map((provider) => provider.providerIdentity)).toEqual([
      'local',
      'remote:kitchen-peer'
    ])

    const duplicatedTool = graph.byFeatureId['tool:tool:notes']
    expect(duplicatedTool?.providers).toHaveLength(2)
    expect(duplicatedTool?.providers.map((provider) => provider.providerIdentity)).toEqual([
      'local',
      'remote:kitchen-peer'
    ])
    expect(duplicatedTool?.selectedProvider?.providerIdentity).toBe('local')

    const native = graph.byFeatureId['native:android:microphoneCapture']
    expect(native).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'native:android',
        privacyClass: 'raw-audio'
      })
    )
  })

  it('explains policy, selector, stale, and unsupported capability states', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: {
        platform: 'android',
        permissions: { microphone: false },
        capabilities: { microphoneCapture: true }
      },
      transportKind: 'http'
    })

    const denied = graph.explain('tool:tool:garage-door')
    expect(denied).toEqual(
      expect.objectContaining({
        state: 'privacy-blocked',
        selectorRequired: true,
        approvalRequired: true,
        nextRepairAction: 'choose a peer/provider'
      })
    )
    expect(denied.providerCandidates[0]).toEqual(
      expect.objectContaining({
        providerIdentity: 'remote:den-peer',
        selectable: false,
        disabledReasons: expect.arrayContaining(['policy_denied'])
      })
    )

    const stale = graph.explain('tool:tool:camera-snapshot')
    expect(stale).toEqual(
      expect.objectContaining({
        state: 'stale',
        routeable: false,
        nextRepairAction: 'refresh peer manifest or reconnect provider'
      })
    )

    const internalOnly = graph.explain('method:Gateway.InternalOnly')
    expect(internalOnly).toEqual(
      expect.objectContaining({
        state: 'unsupported',
        routeable: false,
        nextRepairAction: 'use a local/Tauri transport with bus access or expose a backend contract'
      })
    )

    const nativePermission = graph.explain('native:android:microphoneCapture')
    expect(nativePermission).toEqual(
      expect.objectContaining({
        state: 'privacy-blocked',
        nextRepairAction: 'grant required native permission',
        requiredPermissions: ['microphone']
      })
    )
  })

  it('loads capability graph explanations through the client namespace', async () => {
    const transport = new MockAuroraTransport()
      .register('Gateway.GetRegistry', gatewayRegistryFixture)
      .register('Gateway.GetCapabilityCatalog', capabilityGraphCatalogFixture)
    const client = new AuroraClient({ transport })

    const explanation = await client.capabilities.explain('tool:tool:file-search')

    expect(explanation).toEqual(
      expect.objectContaining({
        state: 'available-remote',
        routeable: true,
        selectedProvider: expect.objectContaining({
          providerIdentity: 'remote:kitchen-peer'
        })
      })
    )
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

  it('tracks user, admin, mesh peer, system, expired, and revoked auth session states', () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    client.auth.updateFromLogin({
      user_id: 'user-1',
      username: 'Ada',
      permissions: ['Gateway.use'],
      is_admin: false,
      expires_at: '2030-01-01T00:00:00Z'
    })
    expect(client.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'user',
        principalId: 'user-1',
        principalName: 'Ada',
        isAuthenticated: true,
        isAdmin: false,
        tokenExpiresAt: '2030-01-01T00:00:00Z'
      })
    )

    client.auth.updateFromTokenValidation({
      valid: true,
      principal_id: 'admin-1',
      principal_name: 'Owner',
      permissions: ['Auth.manage'],
      effective_perms: ['Auth.manage', 'Gateway.manage'],
      is_admin: true,
      source: 'http_bearer'
    })
    expect(client.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'admin',
        principalId: 'admin-1',
        isAdmin: true,
        credentialKind: 'bearer_token',
        effectivePermissions: ['Auth.manage', 'Gateway.manage']
      })
    )

    client.auth.updateFromPairingExchange({
      user_id: 'peer-principal-1',
      device_id: 'device-1',
      permissions: ['TTS.use'],
      peer_id: 'peer-1',
      node_name: 'Kitchen node'
    })
    expect(client.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'mesh_peer',
        principalId: 'peer-principal-1',
        peerId: 'peer-1',
        nodeName: 'Kitchen node',
        isMeshPeer: true,
        credentialKind: 'mesh_peer_token'
      })
    )

    client.auth.updateFromWhoAmI({
      principal_id: 'system',
      principal_name: 'SYSTEM',
      permissions: ['*'],
      effective_perms: ['*'],
      is_admin: true,
      source: 'api_key'
    })
    expect(client.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'api_key_system',
        principalId: 'system',
        isSystem: true,
        isAdmin: true,
        credentialKind: 'api_key'
      })
    )
    expect(client.auth.hasPermission('Auth.DeletePrincipal')).toBe(true)

    client.auth.setAuthenticated('user-2', ['Gateway.use'], '2020-01-01T00:00:00Z')
    client.auth.refreshClock(new Date('2020-01-01T00:00:01Z'))
    expect(client.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'expired',
        needsAuthentication: true,
        isTerminal: true
      })
    )

    client.auth.revoke('Token revoked by admin')
    expect(client.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'revoked',
        reason: 'Token revoked by admin',
        needsAuthentication: true
      })
    )
  })

  it('uses 401 and 403 results to update auth session without mutating on transport loss', async () => {
    const authTransport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { code: 'token_expired', message: 'Token expired' } }), {
          status: 401
        })
    })
    const authClient = new AuroraClient({ transport: authTransport })
    authClient.auth.setAuthenticated('user-1', ['Gateway.use'])
    const authResult = await authClient.requestResult('Gateway.GetRegistry', {}, { path: '/api/Gateway/GetRegistry' })

    expect(authResult.ok).toBe(false)
    expect(authClient.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'expired',
        status: 401,
        needsAuthentication: true
      })
    )

    const permissionTransport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { code: 'permission_denied', message: 'Forbidden' } }), {
          status: 403
        })
    })
    const permissionClient = new AuroraClient({ transport: permissionTransport })
    permissionClient.auth.setAuthenticated('user-2', ['Gateway.use'])
    const permissionResult = await permissionClient.requestResult('Gateway.GetRegistry', {}, { path: '/api/Gateway/GetRegistry' })

    expect(permissionResult.ok).toBe(false)
    expect(permissionClient.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'forbidden',
        status: 403,
        isDenied: true,
        isTerminal: true
      })
    )

    const lossClient = new AuroraClient({
      transport: {
        kind: 'mock',
        request: async () => {
          throw new TypeError('network unavailable')
        }
      }
    })
    lossClient.auth.setAuthenticated('user-3', ['Gateway.use'])
    await lossClient.requestResult('Gateway.GetRegistry')

    expect(lossClient.auth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'user',
        principalId: 'user-3'
      })
    )
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

describe('permissions', () => {
  it('matches backend permission semantics without lowercasing backend IDs', () => {
    expect(hasPermission('Auth.DeletePrincipal', ['*'])).toBe(true)
    expect(hasPermission('Auth.DeletePrincipal', ['Auth.DeletePrincipal'])).toBe(true)
    expect(hasPermission('Auth.DeletePrincipal', ['Auth.*'])).toBe(true)
    expect(hasPermission('Auth.DeletePrincipal', ['Auth.manage'], 'manage')).toBe(true)
    expect(hasPermission('Auth.DeletePrincipal', ['Auth.use'], 'manage')).toBe(false)
    expect(hasPermission('Auth.DeletePrincipal', ['auth.*'])).toBe(false)

    expect(checkAccess(['Gateway.use'], ['Gateway.GetRegistry'], 'use')).toEqual(
      expect.objectContaining({
        allowed: true,
        satisfied: ['Gateway.GetRegistry'],
        missing: [],
        grants: { 'Gateway.GetRegistry': 'Gateway.use' }
      })
    )

    expect(checkAccess(['Gateway.use'], ['Gateway.InternalOnly'], 'manage')).toEqual(
      expect.objectContaining({
        allowed: false,
        missing: ['Gateway.InternalOnly'],
        grants: { 'Gateway.InternalOnly': null }
      })
    )
  })

  it('resolves effective permissions with backend wildcard intersection rules', () => {
    expect(resolveEffectivePermissions({
      userPermissions: ['Gateway.use', 'Auth.manage'],
      userIsAdmin: true,
      tokenScopes: ['Gateway.use']
    })).toEqual(['*'])

    expect(resolveEffectivePermissions({
      userPermissions: ['Gateway.use', 'Auth.manage'],
      tokenScopes: ['all']
    })).toEqual(['Auth.manage', 'Gateway.use'])

    expect(wildcardIntersection(['TTS.Synthesize', 'DB.RagSearch'], ['TTS.*'])).toEqual(['TTS.Synthesize'])
    expect(resolveEffectivePermissions({
      userPermissions: ['TTS.*', 'Gateway.GetRegistry'],
      tokenScopes: ['TTS.Synthesize', 'Gateway.*']
    })).toEqual(['Gateway.GetRegistry', 'TTS.Synthesize'])
  })

  it('builds a permission catalog from generated backend inventory and gateway builtins', () => {
    const catalog = buildPermissionCatalogFromBackendInventory(backendInventoryFixture)
    const byId = new Map(catalog.map((entry) => [entry.id, entry]))

    expect(byId.get('*')).toEqual(
      expect.objectContaining({
        label: 'Full access',
        kind: 'all'
      })
    )
    expect(byId.get('Gateway.use')).toEqual(
      expect.objectContaining({
        id: 'Gateway.use',
        label: 'Use Gateway',
        kind: 'method_type'
      })
    )
    expect(byId.get('Gateway.manage')).toEqual(
      expect.objectContaining({
        id: 'Gateway.manage',
        methodType: 'manage'
      })
    )
    expect(byId.get('Auth.manage')).toEqual(
      expect.objectContaining({
        id: 'Auth.manage',
        label: 'Manage Auth',
        kind: 'method_type',
        availableOverHttp: true,
        requiredBy: [
          expect.objectContaining({
            method: 'list_peers',
            routePath: '/api/admin/peers',
            source: 'gateway_builtin'
          })
        ]
      })
    )
    expect(catalog.map((entry) => entry.id)).toEqual(expect.arrayContaining(['Gateway.GetRegistry', 'Gateway.*']))
    expect(permissionLabel('Tooling.use')).toBe('Use Tooling')
  })

  it('builds a registry-backed permission catalog through AuroraClient and preserves transport-loss failures', async () => {
    const client = new AuroraClient({
      transport: new MockAuroraTransport().register('Gateway.GetRegistry', gatewayRegistryFixture)
    })
    client.auth.updateFromTokenValidation({
      valid: true,
      principal_id: 'user-1',
      permissions: ['Gateway.use'],
      effective_perms: ['Gateway.use'],
      is_admin: false
    })

    const catalog = await client.permissions.listCatalog({ gatewayBuiltins: gatewayBuiltinRoutesFixture })
    expect(catalog.map((entry) => entry.id)).toEqual(expect.arrayContaining(['Gateway.use', 'Auth.manage']))
    expect(client.permissions.has('Gateway.GetRegistry', 'use')).toBe(true)
    expect(client.permissions.check(['Gateway.InternalOnly'], 'manage')).toEqual(
      expect.objectContaining({
        allowed: false,
        missing: ['Gateway.InternalOnly']
      })
    )

    const result = await new AuroraClient({
      transport: {
        kind: 'mock',
        request: async () => {
          throw new TypeError('registry offline')
        }
      }
    }).result(async function loadPermissions() {
      const failingClient = new AuroraClient({
        transport: {
          kind: 'mock',
          request: async () => {
            throw new TypeError('registry offline')
          }
        }
      })
      return failingClient.permissions.listCatalog()
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('transport_loss')
  })

  it('builds manual catalog entries from registry descriptors and builtins without invented IDs', () => {
    const methods = describeRegistry(gatewayRegistryFixture)
    const catalog = buildPermissionCatalog({ methods, gatewayBuiltins: gatewayBuiltinRoutesFixture })

    expect(catalog.find((entry) => entry.id === 'Gateway.GetRegistry')).toEqual(
      expect.objectContaining({
        busTopic: 'Gateway.GetRegistry',
        routePath: '/api/Gateway/GetRegistry',
        availableOverHttp: true
      })
    )
    expect(catalog.find((entry) => entry.id === 'Gateway.manage')).toEqual(
      expect.objectContaining({
        busTopic: null,
        kind: 'method_type'
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

  it('ingests generated backend inventory without changing route or permission truth', () => {
    const generated = describeBackendInventory(backendInventoryFixture)
    const registryMethods = describeRegistry(gatewayRegistryFixture)
    const generatedByTopic = new Map(generated.methods.map((method) => [method.busTopic, method]))

    for (const registryMethod of registryMethods) {
      const generatedMethod = generatedByTopic.get(registryMethod.busTopic)
      expect(generatedMethod).toBeDefined()
      expect(generatedMethod).toEqual(
        expect.objectContaining({
          busTopic: registryMethod.busTopic,
          routePath: registryMethod.routePath,
          requiredPermissions: registryMethod.requiredPermissions,
          availableOverHttp: registryMethod.availableOverHttp
        })
      )
    }

    expect(generated.methodTypes['Gateway.GetRegistry']).toEqual(
      expect.objectContaining({
        busTopic: 'Gateway.GetRegistry',
        requestModel: null,
        responseModel: 'GetRegistryResponse',
        responseSchema: expect.objectContaining({ title: 'GetRegistryResponse' })
      })
    )
    expect(generated.gatewayBuiltins).toEqual([
      expect.objectContaining({
        routePath: '/api/registry',
        httpMethods: ['GET'],
        requiredPermissions: []
      }),
      expect.objectContaining({
        routePath: '/api/admin/peers',
        methodType: 'manage',
        requiredPermissions: ['Auth.manage']
      })
    ])
  })

  it('rejects generated backend inventory methods without backend bus identity', () => {
    expect(() =>
      describeBackendInventory({
        methods: [
          {
            module: 'Gateway',
            name: 'Broken',
            bus_topic: null,
            exposure: 'external',
            method_type: 'use',
            required_perms: []
          }
        ]
      })
    ).toThrow('missing bus_topic')
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
