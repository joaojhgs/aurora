import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MeshP2PTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  backendInventoryFixture,
  buildPermissionCatalog,
  buildPermissionCatalogFromBackendInventory,
  checkAccess,
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  capabilityCatalogFixture,
  compareRegistryFixtureToBackendInventory,
  createAuditReceipt,
  createAuroraEvent,
  defaultMockAuroraFixtures,
  describeBackendInventory,
  describeRegistry,
  evaluateRoutePolicy,
  gatewayBuiltinRoutesFixture,
  gatewayServicesFixture,
  gatewayRegistryFixture,
  hasPermission,
  nativeCapabilityManifestFixture,
  permissionLabel,
  routeExplainFixture,
  resolveEffectivePermissions,
  uiMockReferenceFixtureSummary,
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

  it('preloads deterministic mock fixtures for offline SDK development', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    const [registry, services, summaries, route, nativeManifest, toolCatalog] = await Promise.all([
      client.registry.getRegistry(),
      client.registry.listServices(),
      client.capabilities.listSummaries({ include_unavailable: true }),
      client.routes.explain({ topic: 'TTS.Synthesize' }),
      client.native.getManifest(),
      client.tools.listCatalog<typeof defaultMockAuroraFixtures.toolCatalog>()
    ])

    expect(registry.digest).toBe('fixture')
    expect(services.services[0]?.module).toBe('Gateway')
    expect(summaries.map((summary) => summary.availability)).toEqual(
      expect.arrayContaining(['available-local', 'privacy-blocked', 'stale'])
    )
    expect(route).toEqual(routeExplainFixture)
    expect(nativeManifest).toEqual(
      expect.objectContaining({
        platform: 'tauri-desktop',
        permissions: expect.objectContaining({ microphone: false })
      })
    )
    expect(toolCatalog.tools[0]?.global_tool_id).toBe('tool:local:diagnostics.serviceHealth')
    expect(uiMockReferenceFixtureSummary.privacyClasses).toContain('admin-critical')
  })

  it('evaluates route policy denials without downgrading privacy blockers to unavailable', () => {
    const evaluation = evaluateRoutePolicy({
      route: routeExplainFixture,
      catalog: capabilityCatalogFixture,
      payload: { text: 'Remote speech synthesis should be reviewed before egress.' },
      privacyIndicatorShown: false,
      consentGranted: false,
      transportKind: 'mock'
    })

    expect(evaluation).toEqual(
      expect.objectContaining({
        allowed: false,
        decision: 'privacy-blocked',
        availability: 'privacy-blocked',
        reasonCode: 'explicit_selector_required',
        explicitSelectorRequired: true,
        repairPath: 'choose an explicit peer/provider/resource selector',
        privacyClass: 'raw-audio'
      })
    )
    expect(evaluation.preview).toEqual(
      expect.objectContaining({
        egressDestination: 'peer',
        providerId: 'mesh:studio-gpu:TTS',
        peerId: 'peer-studio-gpu',
        secretsRedacted: true,
        dataClasses: expect.arrayContaining(['raw-audio'])
      })
    )
    expect(evaluation.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['explicit_selector_required', 'privacy_indicator_required'])
    )
  })

  it('requires approval for local dangerous tools and accepts matching approval scopes', async () => {
    const route = {
      topic: 'Tooling.ExecuteTool',
      module: 'Tooling',
      selected_target: 'local',
      selected_peer_id: 'local-peer',
      selected_service_instance_id: 'tooling-local',
      selected_provider_id: 'local:TTS',
      selector_valid: true,
      selector_validation_code: '',
      selector_validation_message: '',
      fallback_behavior: '',
      candidates: [
        {
          provider_id: 'local:TTS',
          peer_id: 'local-peer',
          provider_kind: 'local',
          service_instance_id: 'tooling-local',
          module: 'Tooling',
          version: '0.1.0',
          included: true,
          selected: true,
          reason_code: 'eligible',
          reason: 'Local dangerous tool is available after approval.',
          latency_ms: 1,
          active_calls: 0,
          max_concurrent: 2,
          available_capacity: 2,
          blockers: []
        }
      ],
      blockers: [],
      security_privacy_blockers: [],
      secrets_redacted: true
    }
    const catalog = {
      ...capabilityGraphCatalogFixture,
      actions: capabilityGraphCatalogFixture.actions.map((action) =>
        action.action_id === 'tool-local-notes'
          ? {
              ...action,
              policy: {
                ...action.policy,
                approval_required: true,
                operation_class: 'admin',
                safety_class: 'admin'
              }
            }
          : action
      )
    }
    const transport = new MockAuroraTransport()
      .register('Gateway.ExplainRoute', route)
      .register('Gateway.GetCapabilityCatalog', catalog)
    const client = new AuroraClient({ transport })

    await expect(
      client.routes.evaluatePolicy({
        routeRequest: { topic: 'Tooling.ExecuteTool' },
        actionId: 'tool-local-notes',
        toolId: 'tool:notes',
        argsHash: 'args-local-1',
        payload: { token: 'must-not-render', operation: 'delete notes' },
        now: '2026-06-20T10:00:00Z'
      })
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: false,
        decision: 'privacy-blocked',
        reasonCode: 'approval_required',
        approval: expect.objectContaining({ required: true, status: 'required' }),
        preview: expect.objectContaining({
          payloadPreview: expect.objectContaining({ token: '[redacted]' })
        })
      })
    )

    await expect(
      client.routes.evaluatePolicy({
        route,
        catalog,
        actionId: 'tool-local-notes',
        toolId: 'tool:notes',
        argsHash: 'args-local-1',
        approvalScopes: [{ scope: 'single', decision: 'approve' }],
        now: '2026-06-20T10:00:00Z'
      })
    ).resolves.toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    await expect(
      client.routes.evaluatePolicy({
        route,
        catalog,
        actionId: 'tool-local-notes',
        toolId: 'tool:notes',
        argsHash: 'args-local-1',
        approvalScopes: [
          {
            scope: 'future-approve-all',
            decision: 'approve',
            providerId: 'local:TTS',
            argsHash: 'args-local-1'
          }
        ],
        now: '2026-06-20T10:00:00Z'
      })
    ).resolves.toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    await expect(
      client.routes.evaluatePolicy({
        route,
        catalog,
        actionId: 'tool-local-notes',
        toolId: 'tool:notes',
        argsHash: 'args-local-1',
        approvalScopes: [
          {
            scope: 'tool-args',
            decision: 'approve',
            toolId: 'tool:notes',
            providerId: 'local:TTS',
            argsHash: 'different'
          }
        ],
        now: '2026-06-20T10:00:00Z'
      })
    ).resolves.toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    await expect(
      client.routes.evaluatePolicy({
        route,
        catalog,
        actionId: 'tool-local-notes',
        toolId: 'tool:notes',
        argsHash: 'args-local-1',
        approvalScopes: [
          {
            scope: 'local-safe-tools',
            decision: 'approve',
            toolId: 'tool:notes',
            providerId: 'local:TTS'
          }
        ],
        now: '2026-06-20T10:00:00Z'
      })
    ).resolves.toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    await expect(
      client.routes.evaluatePolicy({
        route,
        catalog,
        actionId: 'tool-local-notes',
        toolId: 'tool:notes',
        argsHash: 'args-local-1',
        payload: { token: 'must-not-render', operation: 'delete notes' },
        approvalScopes: [
          {
            scope: 'tool-args',
            decision: 'approve',
            approvalId: 'approval-local-1',
            toolId: 'tool:notes',
            providerId: 'local:TTS',
            argsHash: 'args-local-1',
            expiresAt: '2026-06-20T10:05:00Z'
          }
        ],
        now: '2026-06-20T10:00:00Z'
      })
    ).resolves.toEqual(
      expect.objectContaining({
        allowed: true,
        decision: 'allowed',
        approval: expect.objectContaining({
          status: 'approved',
          matchedScope: expect.objectContaining({ approvalId: 'approval-local-1' })
        })
      })
    )
  })

  it('requires scoped session, provider, and args evidence for remote approvals', () => {
    const remoteAllowedRoute = {
      ...routeExplainFixture,
      selected_target: 'remote',
      selected_peer_id: 'peer-studio-gpu',
      selected_provider_id: 'mesh:studio-gpu:TTS',
      selected_service_instance_id: 'tts-remote-01',
      selector_valid: true,
      selector_validation_code: '',
      selector_validation_message: '',
      blockers: [],
      security_privacy_blockers: [],
      candidates: routeExplainFixture.candidates.map((candidate) => ({
        ...candidate,
        selected: true,
        included: true,
        blockers: []
      }))
    }
    const catalog = {
      ...capabilityCatalogFixture,
      actions: capabilityCatalogFixture.actions.map((action) =>
        action.action_id === 'tts-remote-privacy-blocked'
          ? {
              ...action,
              bindability: 'available',
              route_blockers: [],
              policy: {
                ...action.policy,
                approval_required: true,
                explicit_selector_required: false,
                selector_required: false,
                consent_required: false,
                privacy_indicator_required: false
              }
            }
          : action
      )
    }
    const base = {
      route: remoteAllowedRoute,
      catalog,
      actionId: 'tts-remote-privacy-blocked',
      argsHash: 'args-remote-1',
      sessionId: 'session-remote-1',
      selector: { peer_id: 'peer-studio-gpu', module: 'TTS' },
      now: '2026-06-20T10:00:00Z'
    }

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [{ scope: 'session', decision: 'approve' }]
      })
    ).toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [
          {
            scope: 'session',
            decision: 'approve',
            sessionId: 'session-remote-1',
            providerId: 'mesh:studio-gpu:TTS',
            expiresAt: '2026-06-20T10:05:00Z'
          }
        ]
      })
    ).toEqual(
      expect.objectContaining({
        allowed: true,
        approval: expect.objectContaining({ status: 'approved' })
      })
    )

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [
          {
            scope: 'session',
            decision: 'approve',
            sessionId: 'other-session',
            providerId: 'mesh:studio-gpu:TTS',
            expiresAt: '2026-06-20T10:05:00Z'
          }
        ]
      })
    ).toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [
          {
            scope: 'peer-provider',
            decision: 'approve',
            peerId: 'peer-studio-gpu',
            providerId: 'mesh:studio-gpu:TTS',
            expiresAt: '2026-06-20T10:05:00Z'
          }
        ]
      })
    ).toEqual(
      expect.objectContaining({
        allowed: true,
        approval: expect.objectContaining({ status: 'approved' })
      })
    )

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [
          {
            scope: 'peer-provider',
            decision: 'approve',
            peerId: 'other-peer',
            providerId: 'mesh:studio-gpu:TTS',
            expiresAt: '2026-06-20T10:05:00Z'
          }
        ]
      })
    ).toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [
          {
            scope: 'session',
            decision: 'approve',
            sessionId: 'session-remote-1',
            peerId: 'peer-studio-gpu',
            providerId: 'mesh:studio-gpu:TTS',
            expiresAt: '2026-06-20T09:59:00Z'
          }
        ]
      })
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        reasonCode: 'approval_required',
        approval: expect.objectContaining({ status: 'expired' })
      })
    )

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [{ scope: 'deny-all', decision: 'deny-all' }]
      })
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        reasonCode: 'approval_denied',
        approval: expect.objectContaining({ status: 'rejected' })
      })
    )

    expect(
      evaluateRoutePolicy({
        ...base,
        approvalScopes: [
          {
            scope: 'tool-args',
            decision: 'approve',
            toolId: 'tool:remote-danger',
            peerId: 'other-peer',
            providerId: 'mesh:studio-gpu:TTS',
            argsHash: 'different'
          }
        ]
      })
    ).toEqual(expect.objectContaining({ allowed: false, reasonCode: 'approval_required' }))
  })

  it('returns cloned fixture data so tests cannot mutate shared backend truth', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const registry = await client.registry.getRegistry()
    registry.modules[0]!.methods[0]!.required_perms.push('mutated.permission')

    await expect(client.registry.getRegistry()).resolves.toEqual(
      expect.objectContaining({
        modules: [
          expect.objectContaining({
            methods: [
              expect.objectContaining({
                required_perms: ['Gateway.use']
              }),
              expect.any(Object)
            ]
          })
        ]
      })
    )
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

  it('scripts mock permission, timeout, and transport-loss failures by method', async () => {
    const transport = new MockAuroraTransport()
      .fail('Gateway.GetRegistry', 'permission', 'Forbidden')
      .timeout('Gateway.GetServices')
      .lose('Gateway.GetCapabilityCatalog', 'mock socket closed')
    const client = new AuroraClient({ transport })

    const permission = await client.requestResult('Gateway.GetRegistry')
    const timeout = await client.requestResult('Gateway.GetServices')
    const loss = await client.requestResult('Gateway.GetCapabilityCatalog')

    expect(permission.ok).toBe(false)
    if (!permission.ok) expect(permission.error.code).toBe('permission')
    expect(timeout.ok).toBe(false)
    if (!timeout.ok) expect(timeout.error.code).toBe('timeout')
    expect(loss.ok).toBe(false)
    if (!loss.ok) expect(loss.error.code).toBe('transport_loss')
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

  it('uses Gateway built-in GET routes with auth headers and no request body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const transport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local/',
      apiKey: 'test-api-key',
      bearerToken: 'test-bearer-token',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} })
        return new Response(
          JSON.stringify({
            digest: 'fixture',
            modules: [],
            service_count: 0,
            method_count: 0
          }),
          {
            status: 200,
            headers: { 'x-correlation-id': 'corr-http-registry' }
          }
        )
      }
    })
    const client = new AuroraClient({ transport })

    await expect(client.registry.getRegistry()).resolves.toEqual(
      expect.objectContaining({ digest: 'fixture' })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://aurora.local/api/registry')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.body).toBeUndefined()
    expect(calls[0]?.init.headers).toEqual(
      expect.objectContaining({
        'X-API-Key': 'test-api-key',
        Authorization: 'Bearer test-bearer-token',
        'content-type': 'application/json'
      })
    )
  })

  it('posts dynamic generated route payloads by method identity when no explicit path is supplied', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const transport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} })
        return new Response(JSON.stringify({ route_decision: 'local', topic: 'TTS.Synthesize' }), {
          status: 200
        })
      }
    })
    const client = new AuroraClient({ transport })

    await expect(client.request('TTS.Synthesize', { text: 'hello' })).resolves.toEqual(
      expect.objectContaining({ route_decision: 'local' })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://aurora.local/api/TTS/Synthesize')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ text: 'hello' }))
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

  it('classifies HTTP detail-code unsupported, privacy, and native permission failures', async () => {
    const cases = [
      [{ detail: { code: 'unsupported_feature', message: 'Unsupported method' } }, 'unsupported_feature'],
      [{ detail: { reason_code: 'privacy_blocked', message: 'Explicit selector required' } }, 'privacy_blocked'],
      [{ detail: { code: 'native_permission_missing', message: 'Native permission missing' } }, 'native_permission_missing']
    ] as const

    for (const [body, expected] of cases) {
      const transport = new HttpGatewayTransport({
        baseUrl: 'http://aurora.local',
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 428 })
      })
      const client = new AuroraClient({ transport })
      const result = await client.requestResult('Gateway.ExplainRoute', { topic: 'TTS.Synthesize' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(expected)
    }
  })

  it('classifies HTTP abort timeout and network send failures', async () => {
    const timeoutTransport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      defaultTimeoutMs: 5,
      fetchImpl: async () => {
        throw new DOMException('Request aborted', 'AbortError')
      }
    })
    const timeoutClient = new AuroraClient({ transport: timeoutTransport })
    const timeoutResult = await timeoutClient.requestResult('Gateway.GetRegistry')

    expect(timeoutResult.ok).toBe(false)
    if (!timeoutResult.ok) expect(timeoutResult.error.code).toBe('timeout')

    const lossTransport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      }
    })
    const lossClient = new AuroraClient({ transport: lossTransport })
    const lossResult = await lossClient.requestResult('Gateway.GetRegistry')

    expect(lossResult.ok).toBe(false)
    if (!lossResult.ok) expect(lossResult.error.code).toBe('transport_loss')
  })

  it('classifies unsupported, privacy blocked, and native permission errors', async () => {
    const unsupportedClient = new AuroraClient({ transport: MockAuroraTransport.empty() })
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

  it('routes SDK calls through a mesh peer bridge with selector, candidates, and audit metadata', async () => {
    const calls: unknown[] = []
    const transport = new MeshP2PTransport({
      defaultPeerId: 'peer-kitchen',
      fallbackPeerIds: ['peer-office'],
      routeResolver: (request) => ({
        peerId: 'peer-kitchen',
        selector: { peer_id: 'peer-kitchen', module: 'TTS', service_instance_id: 'tts-remote' },
        candidates: [
          {
            peerId: 'peer-kitchen',
            providerId: 'remote:TTS:kitchen',
            serviceInstanceId: 'tts-remote',
            module: 'TTS',
            eligible: true,
            latencyMs: 12
          }
        ],
        fallbackAllowed: true
      }),
      bridge: {
        async call(request) {
          calls.push(request)
          return {
            data: { ok: true, provider_peer_id: request.peerId },
            correlationId: 'corr-mesh-1',
            targetPeerId: request.peerId,
            status: 'success',
            secretsRedacted: true
          }
        }
      }
    })
    const client = new AuroraClient({ transport })

    const result = await client.requestResult<{ ok: boolean }>('TTS.Synthesize', { text: 'hello' })

    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual(
      expect.objectContaining({
        peerId: 'peer-kitchen',
        method: 'TTS.Synthesize',
        busTopic: 'TTS.Synthesize',
        payload: { text: 'hello' },
        selector: { peer_id: 'peer-kitchen', module: 'TTS', service_instance_id: 'tts-remote' },
        candidates: expect.arrayContaining([
          expect.objectContaining({ peerId: 'peer-kitchen', eligible: true }),
          expect.objectContaining({ peerId: 'peer-office', fallback: true })
        ])
      })
    )
    if (result.ok) {
      expect(result.audit).toEqual(
        expect.objectContaining({
          correlationId: 'corr-mesh-1',
          method: 'TTS.Synthesize',
          busTopic: 'TTS.Synthesize',
          targetPeerId: 'peer-kitchen',
          status: 'success',
          transport: 'mesh'
        })
      )
    }
  })

  it('derives mesh target peer from explicit payload selector without inventing route state', async () => {
    const transport = new MeshP2PTransport({
      bridge: {
        async call(request) {
          return { data: { peer: request.peerId }, targetPeerId: request.peerId }
        }
      }
    })
    const client = new AuroraClient({ transport })

    const result = await client.requestResult<{ peer: string }>('Tooling.ExecuteTool', {
      mesh_selector: { peer_id: 'peer-den', tool_id: 'tool:remote:lights' },
      args: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.peer).toBe('peer-den')
  })

  it('classifies mesh permission, validation, timeout, unavailable, privacy, unsupported, and transport-loss paths', async () => {
    const cases = [
      [{ error: { code: 'permission_denied', message: 'Forbidden' } }, 'permission'],
      [{ error: { reason_code: 'validation_error', message: 'Invalid payload' } }, 'validation'],
      [{ error: { reason_code: 'timeout', message: 'Remote timed out' } }, 'timeout'],
      [{ error: { reason_code: 'no_route', message: 'No route to provider' } }, 'unavailable_service'],
      [{ error: { reason_code: 'privacy_blocked', message: 'Explicit selector required' } }, 'privacy_blocked'],
      [{ error: { code: 'unsupported_feature', message: 'Unsupported method' } }, 'unsupported_feature'],
      [new TypeError('DataChannel closed'), 'transport_loss']
    ] as const

    for (const [bridgeResult, expected] of cases) {
      const transport = new MeshP2PTransport({
        defaultPeerId: 'peer-kitchen',
        bridge: {
          async call() {
            if (bridgeResult instanceof Error) throw bridgeResult
            return bridgeResult
          }
        }
      })
      const client = new AuroraClient({ transport })
      const result = await client.requestResult('TTS.Synthesize', { text: 'hello' })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(expected)
    }
  })

  it('blocks mesh requests when route resolution reports privacy or no eligible peer', async () => {
    const privacyClient = new AuroraClient({
      transport: new MeshP2PTransport({
        bridge: { async call() { return { data: {} } } },
        routeResolver: () => ({ privacyBlockedReason: 'selector required by policy' })
      })
    })
    const privacy = await privacyClient.requestResult('TTS.Synthesize', { text: 'hello' })
    expect(privacy.ok).toBe(false)
    if (!privacy.ok) expect(privacy.error.code).toBe('privacy_blocked')

    const unavailableClient = new AuroraClient({
      transport: new MeshP2PTransport({
        bridge: { async call() { return { data: {} } } },
        routeResolver: () => ({ unavailableReason: 'stale_provider', candidates: [{ peerId: 'peer-old', eligible: false }] })
      })
    })
    const unavailable = await unavailableClient.requestResult('TTS.Synthesize', { text: 'hello' })
    expect(unavailable.ok).toBe(false)
    if (!unavailable.ok) expect(unavailable.error.code).toBe('unavailable_service')
  })

  it('bridges SDK requests through Tauri invoke without rewriting method identity', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        return {
          data: gatewayRegistryFixture,
          status: 200,
          audit: { correlationId: 'corr-tauri-registry' }
        }
      }
    })
    const client = new AuroraClient({ transport })

    const registry = await client.registry.getRegistry()
    const result = await client.requestResult('Gateway.GetRegistry')

    expect(registry.digest).toBe('fixture')
    expect(calls[0]).toEqual({
      command: 'aurora_request',
      args: {
        request: expect.objectContaining({
          method: 'Gateway.GetRegistry',
          busTopic: 'Gateway.GetRegistry',
          path: '/api/registry',
          httpMethod: 'GET'
        })
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.audit).toEqual(
        expect.objectContaining({
          correlationId: 'corr-tauri-registry',
          method: 'Gateway.GetRegistry',
          busTopic: 'Gateway.GetRegistry',
          transport: 'tauri-local'
        })
      )
    }
  })

  it('exposes Tauri native sidecar, secure storage, and local file helpers', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        switch (command) {
          case 'aurora_sidecar_status':
            return { running: true, mode: 'sidecar', pid: 42 }
          case 'aurora_native_capability_manifest':
            return nativeCapabilityManifestFixture
          case 'aurora_secure_storage_get':
            return { key: 'session', value: 'token-ref' }
          case 'aurora_secure_storage_set':
          case 'aurora_secure_storage_delete':
            return { key: String(args?.key), ok: true }
          case 'aurora_local_file_read':
            return { path: String(args?.path), data: 'hello', encoding: 'utf-8' }
          case 'aurora_local_file_write':
            return { path: String(args?.path), ok: true, bytesWritten: 5 }
          case 'aurora_local_file_pick':
            return { paths: ['/tmp/a.txt'], cancelled: false }
          default:
            throw new Error(`Unexpected command ${command}`)
        }
      }
    })

    await expect(transport.getSidecarStatus()).resolves.toEqual(
      expect.objectContaining({ running: true, mode: 'sidecar' })
    )
    await expect(transport.getNativeCapabilityManifest()).resolves.toEqual(nativeCapabilityManifestFixture)
    await expect(transport.secureStorageGet('session')).resolves.toEqual({ key: 'session', value: 'token-ref' })
    await expect(transport.secureStorageSet('session', 'token-ref')).resolves.toEqual({ key: 'session', ok: true })
    await expect(transport.secureStorageDelete('session')).resolves.toEqual({ key: 'session', ok: true })
    await expect(transport.readLocalFile('/tmp/a.txt')).resolves.toEqual({
      path: '/tmp/a.txt',
      data: 'hello',
      encoding: 'utf-8'
    })
    await expect(transport.writeLocalFile('/tmp/a.txt', 'hello')).resolves.toEqual({
      path: '/tmp/a.txt',
      ok: true,
      bytesWritten: 5
    })
    await expect(transport.pickLocalFile({ multiple: false })).resolves.toEqual({
      paths: ['/tmp/a.txt'],
      cancelled: false
    })

    expect(calls.map((call) => call.command)).toEqual([
      'aurora_sidecar_status',
      'aurora_native_capability_manifest',
      'aurora_secure_storage_get',
      'aurora_secure_storage_set',
      'aurora_secure_storage_delete',
      'aurora_local_file_read',
      'aurora_local_file_write',
      'aurora_local_file_pick'
    ])
    expect(calls[3]?.args).toEqual({ key: 'session', value: 'token-ref' })
    expect(calls[6]?.args).toEqual({ path: '/tmp/a.txt', data: 'hello', options: {} })
  })

  it('classifies Tauri auth, permission, validation, timeout, unavailable, unsupported, privacy, native permission, and transport-loss failures', async () => {
    const cases = [
      [{ status: 401, detail: { message: 'auth required' } }, 'auth'],
      [{ status: 403, detail: { message: 'forbidden' } }, 'permission'],
      [{ detail: { code: 'validation_error', message: 'bad payload' } }, 'validation'],
      [{ detail: { code: 'unavailable_service', message: 'service unavailable' } }, 'unavailable_service'],
      [{ detail: { code: 'unsupported_feature', message: 'unsupported' } }, 'unsupported_feature'],
      [{ detail: { reason_code: 'privacy_blocked', message: 'privacy blocked' } }, 'privacy_blocked'],
      [{ detail: { code: 'native_permission_missing', message: 'native permission missing' } }, 'native_permission_missing']
    ] as const

    for (const [error, expected] of cases) {
      const client = new AuroraClient({
        transport: new TauriLocalTransport({
          invoke: async () => {
            throw error
          }
        })
      })
      const result = await client.requestResult('Gateway.GetRegistry')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(expected)
    }

    const timeoutClient = new AuroraClient({
      transport: new TauriLocalTransport({
        defaultTimeoutMs: 1,
        invoke: async () => new Promise(() => undefined)
      })
    })
    const timeout = await timeoutClient.requestResult('Gateway.GetRegistry', undefined, { timeoutMs: 1 })
    expect(timeout.ok).toBe(false)
    if (!timeout.ok) expect(timeout.error.code).toBe('timeout')

    const lossClient = new AuroraClient({
      transport: new TauriLocalTransport({
        invoke: async () => {
          throw new TypeError('ipc closed')
        }
      })
    })
    const loss = await lossClient.requestResult('Gateway.GetRegistry')
    expect(loss.ok).toBe(false)
    if (!loss.ok) expect(loss.error.code).toBe('transport_loss')
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

  it('subscribes to mock event streams with filtered event envelopes', async () => {
    const transport = new MockAuroraTransport().stream('assistant', [
      { id: '1', kind: 'assistant.delta', payload: { text: 'hel' }, correlation_id: 'corr-assistant-1' },
      { id: '2', kind: 'tool.completed', payload: { ok: true }, tool_id: 'tool:notes' },
      { id: '3', kind: 'ignored', payload: {} }
    ])
    const client = new AuroraClient({ transport })

    const events = await collectEvents(client.events.streamAssistant(undefined, { kinds: ['assistant.delta', 'tool.completed'] }), 2)

    expect(events.map((event) => event.kind)).toEqual(['assistant.delta', 'tool.completed'])
    expect(events[0]).toEqual(
      expect.objectContaining({
        id: '1',
        payload: { text: 'hel' },
        audit: expect.objectContaining({
          correlationId: 'corr-assistant-1',
          eventKind: 'assistant.delta',
          transport: 'mock'
        })
      })
    )
    expect(events[1]?.audit.toolId).toBe('tool:notes')
  })

  it('reconnects streams with last event backfill hints after transport loss', async () => {
    let attempts = 0
    const seenLastEventIds: Array<string | null | undefined> = []
    const transport = new MockAuroraTransport().stream('health', async function* (request) {
      attempts += 1
      seenLastEventIds.push(request.lastEventId)
      if (attempts === 1) {
        yield { id: '1', kind: 'health.updated', payload: { status: 'starting' } }
        throw new TypeError('mock stream dropped')
      }
      yield { id: '2', kind: 'health.updated', payload: { status: 'healthy' } }
    })
    const client = new AuroraClient({ transport })

    const events = await collectEvents(client.events.watchHealth({ reconnect: { maxAttempts: 1, initialDelayMs: 0 } }), 2)

    expect(events.map((event) => event.id)).toEqual(['1', '2'])
    expect(seenLastEventIds).toEqual([null, '1'])
  })

  it('settles a pending event iterator when an idle wrapped stream is closed', async () => {
    const never = async function* () {
      await new Promise(() => undefined)
    }
    const client = new AuroraClient({
      transport: new MockAuroraTransport().stream('health', never)
    })
    const subscription = client.events.watchHealth()
    const iterator = subscription[Symbol.asyncIterator]()

    const pending = iterator.next().then(() => 'settled', () => 'rejected')
    setTimeout(() => subscription.close('test-close'), 10)

    await expect(raceWithTimeout(pending, 100)).resolves.toBe('settled')
  })

  it('classifies event stream unsupported and scripted failures', async () => {
    const unsupported = new AuroraClient({
      transport: {
        kind: 'mock',
        request: async <TData = unknown>() => ({ data: {} as TData })
      }
    })
    expect(() => unsupported.subscribe()).toThrow(AuroraError)

    const failing = new AuroraClient({
      transport: new MockAuroraTransport().failStream('config', 'permission', 'Forbidden stream')
    })
    await expect(collectEvents(failing.events.watchConfig(), 1)).rejects.toMatchObject({ code: 'permission' })
  })

  it('adapts HTTP SSE and WebSocket events into AuroraEvent envelopes', async () => {
    let sse: { onmessage: ((event: MessageEvent<string>) => void) | null; onerror: ((event: Event) => void) | null; close: () => void } | null = null
    const sseTransport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      eventSourceFactory: (url) => {
        expect(url).toContain('/api/events?stream=health')
        sse = { onmessage: null, onerror: null, close: () => undefined }
        return sse
      }
    })
    const sseClient = new AuroraClient({ transport: sseTransport })
    const sseEvents = collectEvents(sseClient.events.watchHealth(), 1)
    await Promise.resolve()
    expect(sse).not.toBeNull()
    const currentSse = sse!
    currentSse.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ id: 'health-1', kind: 'health.updated', payload: { status: 'healthy' } }),
        lastEventId: 'health-1'
      })
    )
    expect((await sseEvents)[0]).toEqual(
      expect.objectContaining({
        id: 'health-1',
        kind: 'health.updated',
        payload: { status: 'healthy' }
      })
    )

    let sent: string | null = null
    let socket: { onmessage: ((event: MessageEvent<string>) => void) | null; onerror: ((event: Event) => void) | null; onclose: ((event: CloseEvent) => void) | null; send: (data: string) => void; close: () => void } | null = null
    const wsTransport = new HttpGatewayTransport({
      baseUrl: 'https://aurora.local',
      webSocketFactory: (url) => {
        expect(url.startsWith('wss://aurora.local/api/events?stream=assistant')).toBe(true)
        socket = {
          onmessage: null,
          onerror: null,
          onclose: null,
          send: (data) => { sent = data },
          close: () => undefined
        }
        return socket
      }
    })
    const wsClient = new AuroraClient({ transport: wsTransport })
    const wsEvents = collectEvents(wsClient.events.streamAssistant({ prompt: 'hello' }, { protocol: 'websocket' }), 1)
    await Promise.resolve()
    expect(JSON.parse(sent ?? '{}')).toEqual(expect.objectContaining({ stream: 'assistant' }))
    expect(socket).not.toBeNull()
    const currentSocket = socket!
    currentSocket.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ id: 'assistant-1', kind: 'assistant.delta', payload: { text: 'hello' } })
      })
    )
    expect((await wsEvents)[0]?.kind).toBe('assistant.delta')
  })

  it('settles a pending HTTP SSE iterator when the subscription is closed without another event', async () => {
    let closed = false
    let sourceReady: () => void = () => undefined
    const sourceReadyPromise = new Promise<void>((resolve) => {
      sourceReady = resolve
    })
    const sseTransport = new HttpGatewayTransport({
      baseUrl: 'http://aurora.local',
      eventSourceFactory: () => {
        sourceReady()
        return {
          onmessage: null,
          onerror: null,
          close: () => { closed = true }
        }
      }
    })
    const client = new AuroraClient({ transport: sseTransport })
    const subscription = client.events.watchHealth()
    const iterator = subscription[Symbol.asyncIterator]()

    const pending = iterator.next().then(() => 'settled', () => 'rejected')
    await sourceReadyPromise
    subscription.close('test-close')

    await expect(raceWithTimeout(pending, 100)).resolves.toBe('settled')
    expect(closed).toBe(true)
  })

  it('adapts Tauri and mesh event streams without changing backend evidence', async () => {
    const tauri = new TauriLocalTransport({
      invoke: async (command, args) => {
        expect(command).toBe('aurora_event_subscribe')
        expect(args?.request).toEqual(expect.objectContaining({ stream: 'config' }))
        return [{ id: 'config-1', kind: 'config.updated', payload: { key: 'ui.dark_mode' }, correlation_id: 'corr-config' }]
      }
    })
    const tauriClient = new AuroraClient({ transport: tauri })
    const tauriEvents = await collectEvents(tauriClient.events.watchConfig(), 1)
    expect(tauriEvents[0]).toEqual(
      expect.objectContaining({
        id: 'config-1',
        audit: expect.objectContaining({
          correlationId: 'corr-config',
          transport: 'tauri-local'
        })
      })
    )

    const meshTransport = new MeshP2PTransport({
      defaultPeerId: 'peer-kitchen',
      bridge: {
        async call() {
          return { data: {} }
        },
        subscribe(request) {
          expect(request.peerId).toBe('peer-kitchen')
          return [{ id: 'mesh-1', kind: 'health.updated', payload: { peer: request.peerId } }]
        }
      }
    })
    const meshClient = new AuroraClient({ transport: meshTransport })
    const meshEvents = await collectEvents(meshClient.events.watchHealth(), 1)
    expect(meshEvents[0]).toEqual(
      expect.objectContaining({
        id: 'mesh-1',
        payload: { peer: 'peer-kitchen' },
        audit: expect.objectContaining({
          targetPeerId: 'peer-kitchen',
          transport: 'mesh'
        })
      })
    )
  })
})

async function collectEvents<TPayload>(
  subscription: AsyncIterable<TPayload> & { close?: () => void },
  count: number
): Promise<TPayload[]> {
  const events: TPayload[] = []
  try {
    for await (const event of subscription) {
      events.push(event)
      if (events.length >= count) break
    }
    return events
  } finally {
    subscription.close?.()
  }
}

async function raceWithTimeout<TValue>(promise: Promise<TValue>, ms: number): Promise<TValue | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), ms)
    })
  ])
}

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

  it('compares registry fixtures against backend inventory snapshots', () => {
    const comparison = compareRegistryFixtureToBackendInventory(gatewayRegistryFixture, backendInventoryFixture)

    expect(comparison).toEqual({
      ok: true,
      checked: 2,
      issues: []
    })

    const mismatched = compareRegistryFixtureToBackendInventory(
      {
        ...gatewayRegistryFixture,
        modules: [
          {
            ...gatewayRegistryFixture.modules[0]!,
            methods: [
              {
                ...gatewayRegistryFixture.modules[0]!.methods[0]!,
                required_perms: ['gateway.use']
              }
            ]
          }
        ],
        method_count: 1
      },
      backendInventoryFixture
    )

    expect(mismatched.ok).toBe(false)
    expect(mismatched.issues).toEqual([
      expect.objectContaining({
        busTopic: 'Gateway.GetRegistry',
        field: 'requiredPermissions',
        fixture: ['gateway.use'],
        inventory: ['Gateway.use']
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
