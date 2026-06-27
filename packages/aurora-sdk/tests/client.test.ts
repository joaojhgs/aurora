import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  AuroraError,
  DB_METHODS,
  HttpGatewayTransport,
  MeshP2PTransport,
  MockAuroraTransport,
  backupListFixture,
  ORCHESTRATOR_METHODS,
  TauriLocalTransport,
  backendInventoryFixture,
  buildPermissionCatalog,
  buildPermissionCatalogFromBackendInventory,
  checkAccess,
  buildAdminOverviewManifest,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  capabilityCatalogFixture,
  cloneFixture,
  compareRegistryFixtureToBackendInventory,
  createAuditReceipt,
  createAuroraEvent,
  defaultMockAuroraFixtures,
  deploymentTopologyFixture,
  describeBackendInventory,
  describeRegistry,
  evaluateRoutePolicy,
  gatewayBuiltinRoutesFixture,
  gatewayServicesFixture,
  gatewayRegistryFixture,
  hasPermission,
  modelRuntimeCatalogFixture,
  nativeCapabilityManifestFixture,
  androidNativeCapabilityManifestFixture,
  ORCHESTRATOR_MODEL_METHODS,
  permissionLabel,
  normalizeToolCatalog,
  routeExplainFixture,
  resolveEffectivePermissions,
  supportBundleFixture,
  toolCatalogFixture,
  uiMockReferenceFixtureSummary,
  wildcardIntersection
} from '../src/index.js'

describe('AuroraClient', () => {
  it('loads registry methods and preserves permission casing', async () => {
    const transport = new MockAuroraTransport().register('Gateway.GetRegistry', gatewayRegistryFixture)
    const client = new AuroraClient({ transport })

    const methods = await client.registry.listMethods()

    expect(methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          busTopic: 'Gateway.GetRegistry',
          routePath: '/api/Gateway/GetRegistry',
          requiredPermissions: ['Gateway.use'],
          availableOverHttp: true
        }),
        expect.objectContaining({
          busTopic: 'Gateway.GetDeploymentTopology',
          routePath: '/api/Gateway/GetDeploymentTopology',
          requiredPermissions: ['Gateway.manage'],
          availableOverHttp: true
        }),
        expect.objectContaining({
          busTopic: 'Gateway.GetWebRTCDiagnostics',
          routePath: '/api/Gateway/GetWebRTCDiagnostics',
          requiredPermissions: ['Gateway.manage'],
          availableOverHttp: true
        }),
        expect.objectContaining({
          busTopic: 'Gateway.InternalOnly',
          routePath: null,
          requiredPermissions: ['Gateway.manage'],
          availableOverHttp: false
        })
      ])
    )
  })

  it('classifies pending pairing queue as an admin backend descriptor', () => {
    const descriptors = describeBackendInventory(backendInventoryFixture)

    expect(descriptors.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          busTopic: 'Auth.ListPendingPairings',
          routePath: '/api/Auth/ListPendingPairings',
          exposure: 'both',
          methodType: 'manage',
          requiredPermissions: ['Auth.manage'],
          availableOverHttp: true,
          routeKind: 'dynamic'
        })
      ])
    )
    expect(descriptors.methodTypes['Auth.ListPendingPairings']).toEqual(
      expect.objectContaining({
        requestModel: 'ListPendingPairingsRequest',
        responseModel: 'ListPendingPairingsResponse'
      })
    )
  })

  it('routes Auth pairing queue reads and review methods through typed SDK descriptors', async () => {
    const calls: Array<{ method: string; path: string | undefined; payload: unknown }> = []
    const transport = MockAuroraTransport.empty()
      .register('Auth.ListPendingPairings', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return {
          pairings: [pendingPairingFixture()],
          total: 1,
          expired_count: 0,
          secrets_redacted: true
        }
      })
      .register('Auth.PairingApprove', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
      .register('Auth.PairingDeny', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
    const client = new AuroraClient({ transport })

    const queue = await client.authApi.listPendingPairings({ include_non_pending: true })
    const approved = await client.authApi.pairingApprove({
      code: '123456',
      permissions: ['Gateway.use'],
      is_admin: false
    })
    const denied = await client.authApi.pairingDeny({ code: '654321', reason: 'Wrong device' })

    expect(queue.ok).toBe(true)
    expect(approved.ok).toBe(true)
    expect(denied.ok).toBe(true)
    expect(calls).toEqual([
      {
        method: 'Auth.ListPendingPairings',
        path: '/api/Auth/ListPendingPairings',
        payload: { include_non_pending: true }
      },
      {
        method: 'Auth.PairingApprove',
        path: '/api/Auth/PairingApprove',
        payload: { code: '123456', permissions: ['Gateway.use'], is_admin: false }
      },
      {
        method: 'Auth.PairingDeny',
        path: '/api/Auth/PairingDeny',
        payload: { code: '654321', reason: 'Wrong device' }
      }
    ])
  })

  it('routes mesh peer lifecycle reads and mutations through typed SDK descriptors', async () => {
    const calls: Array<{ method: string; path: string | undefined; payload: unknown }> = []
    const transport = MockAuroraTransport.empty()
      .register('Gateway.GetMeshStatus', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return defaultMockAuroraFixtures.meshStatus
      })
      .register('Auth.MeshListPeers', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return defaultMockAuroraFixtures.meshPeers
      })
      .register('Auth.MeshGetPeer', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { peer: defaultMockAuroraFixtures.meshPeers.peers[0] }
      })
      .register('Auth.MeshApprovePeer', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
      .register('Auth.MeshDenyPeer', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
      .register('Auth.MeshUpdatePeerPermissions', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
      .register('Auth.MeshRemovePeer', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
    const client = new AuroraClient({ transport })

    await client.mesh.getStatus()
    await client.mesh.listPeers({ include_disconnected: true })
    await client.mesh.getPeer({ peer_id: 'peer-kitchen' })
    await client.mesh.approvePeer({ peer_id: 'peer-kitchen', permissions: ['Gateway.use'] })
    await client.mesh.denyPeer({ peer_id: 'peer-den' })
    await client.mesh.updatePeerPermissions({ peer_id: 'peer-kitchen', permissions: ['Gateway.use', 'TTS.use'] })
    await client.mesh.removePeer({ peer_id: 'peer-den', revoke_token: true })

    expect(calls).toEqual([
      { method: 'Gateway.GetMeshStatus', path: '/api/Gateway/GetMeshStatus', payload: undefined },
      { method: 'Auth.MeshListPeers', path: '/api/Auth/MeshListPeers', payload: { include_disconnected: true } },
      { method: 'Auth.MeshGetPeer', path: '/api/Auth/MeshGetPeer', payload: { peer_id: 'peer-kitchen' } },
      {
        method: 'Auth.MeshApprovePeer',
        path: '/api/Auth/MeshApprovePeer',
        payload: { peer_id: 'peer-kitchen', permissions: ['Gateway.use'] }
      },
      {
        method: 'Auth.MeshDenyPeer',
        path: '/api/Auth/MeshDenyPeer',
        payload: { peer_id: 'peer-den' }
      },
      {
        method: 'Auth.MeshUpdatePeerPermissions',
        path: '/api/Auth/MeshUpdatePeerPermissions',
        payload: { peer_id: 'peer-kitchen', permissions: ['Gateway.use', 'TTS.use'] }
      },
      {
        method: 'Auth.MeshRemovePeer',
        path: '/api/Auth/MeshRemovePeer',
        payload: { peer_id: 'peer-den', revoke_token: true }
      }
    ])
  })

  it('routes Auth device and token management through typed SDK descriptors', async () => {
    const calls: Array<{ method: string; path: string | undefined; payload: unknown }> = []
    const transport = MockAuroraTransport.empty()
      .register('Auth.ListDevices', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return {
          devices: [
            {
              id: 'device-studio-mac',
              user_id: 'principal-owner',
              name: 'Studio Mac',
              is_trusted: true,
              created_at: '2026-06-19T00:30:00Z',
              last_seen: '2026-06-25T02:30:00Z'
            }
          ]
        }
      })
      .register('Auth.ListTokens', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return {
          tokens: [
            {
              id: 'token-studio',
              prefix: 'aur_stu',
              device_id: 'device-studio-mac',
              user_id: 'principal-owner',
              scopes: ['Auth.manage'],
              created_at: '2026-06-19T00:35:00Z',
              expires_at: '2026-07-19T00:35:00Z'
            }
          ]
        }
      })
      .register('Auth.DeleteDevice', (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { success: true }
      })
    const client = new AuroraClient({ transport })

    const devices = await client.authApi.listDevices({ principal_id: 'principal-owner' })
    const tokens = await client.authApi.listTokens({ device_id: 'device-studio-mac' })
    const deleted = await client.authApi.deleteDevice({ device_id: 'device-studio-mac' })

    expect(devices.ok).toBe(true)
    expect(tokens.ok).toBe(true)
    expect(deleted.ok).toBe(true)
    expect(calls).toEqual([
      {
        method: 'Auth.ListDevices',
        path: '/api/Auth/ListDevices',
        payload: { principal_id: 'principal-owner' }
      },
      {
        method: 'Auth.ListTokens',
        path: '/api/Auth/ListTokens',
        payload: { device_id: 'device-studio-mac' }
      },
      {
        method: 'Auth.DeleteDevice',
        path: '/api/Auth/DeleteDevice',
        payload: { device_id: 'device-studio-mac' }
      }
    ])
  })

  it('advertises assistant context ingestion from backend inventory descriptors', () => {
    const descriptors = describeBackendInventory(backendInventoryFixture)

    expect(descriptors.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          busTopic: ORCHESTRATOR_METHODS.ingestContext,
          routePath: '/api/Orchestrator/IngestContext',
          exposure: 'external',
          methodType: 'use',
          requiredPermissions: ['Orchestrator.use'],
          inputModel: 'AttachmentContextIngestRequest',
          outputModel: 'AttachmentContextIngestResponse',
          availableOverHttp: true,
          routeKind: 'dynamic'
        })
      ])
    )
    expect(descriptors.methodTypes[ORCHESTRATOR_METHODS.ingestContext]).toEqual(
      expect.objectContaining({
        requestModel: 'AttachmentContextIngestRequest',
        responseModel: 'AttachmentContextIngestResponse'
      })
    )
  })

  it('loads model runtime catalog and normalizes unsupported operations through AuroraClient', async () => {
    const transport = new MockAuroraTransport()
      .fail(ORCHESTRATOR_MODEL_METHODS.benchmarkModel, 'unsupported_feature', 'benchmark backend is not enabled')
    const client = new AuroraClient({ transport })

    const catalog = await client.models.listCatalog({ include_unavailable: true, include_operations: true })
    const runtime = await client.models.getRuntime()
    const benchmark = await client.models.benchmarkModel({ provider_id: 'native:mobile-local-light', dry_run: true })

    expect(catalog).toEqual(modelRuntimeCatalogFixture)
    expect(catalog.providers.map((provider) => provider.provider_id)).toEqual(
      expect.arrayContaining([
        'local:Orchestrator:llama-cpp',
        'mesh:studio-gpu:Orchestrator',
        'cloud:openai:Orchestrator',
        'native:mobile-local-light'
      ])
    )
    expect(runtime.provider?.provider_id).toBe(catalog.selected_provider_id)
    expect(benchmark.ok).toBe(false)
    if (!benchmark.ok) {
      expect(benchmark.error.code).toBe('unsupported_feature')
      expect(benchmark.audit.busTopic).toBe(ORCHESTRATOR_MODEL_METHODS.benchmarkModel)
    }
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

  it('models iOS invocation through App Intents and Shortcuts without a Siri replacement claim', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: nativeCapabilityManifestFixture,
      transportKind: 'tauri-local'
    })

    expect(nativeCapabilityManifestFixture.mobileIntegrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'ios',
          id: 'appIntents',
          label: 'Siri/Shortcuts/App Intents integration',
          support: 'planned'
        }),
        expect.objectContaining({
          platform: 'ios',
          id: 'shortcuts',
          support: 'supported-path'
        }),
        expect.objectContaining({
          platform: 'ios',
          id: 'siriReplacement',
          support: 'unsupported',
          userCopy: expect.stringContaining('does not allow Aurora to replace Siri')
        })
      ])
    )
    expect(nativeCapabilityManifestFixture.platformLimitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'noSiriReplacement',
          userCopy: 'Use Siri/Shortcuts/App Intents integration; do not claim Aurora replaces Siri.'
        })
      ])
    )

    expect(graph.explain('native:ios:appIntents')).toEqual(
      expect.objectContaining({
        state: 'pending',
        routeable: false,
        nextRepairAction: 'implement scoped iOS plugin, App Intent, or extension task'
      })
    )
    expect(graph.explain('native:ios:shortcuts')).toEqual(
      expect.objectContaining({
        state: 'degraded',
        routeable: false,
        nextRepairAction: 'verify platform path in macOS/Xcode simulator or device'
      })
    )
    expect(graph.explain('native:ios:siriReplacement')).toEqual(
      expect.objectContaining({
        state: 'unsupported',
        routeable: false,
        nextRepairAction: 'do not claim this platform capability'
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

  it('keeps Android fallback entrypoints selectable independently from assistant-role and microphone blockers', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: androidNativeCapabilityManifestFixture,
      transportKind: 'native-mobile'
    })

    expect(graph.byFeatureId['native:android:android.assistantRole.status']).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'native:android'
      })
    )
    expect(graph.byFeatureId['native:android:android.assistantRole.request']).toEqual(
      expect.objectContaining({
        availability: 'privacy-blocked',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'needs_native_permission' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.microphoneCapture']).toEqual(
      expect.objectContaining({
        availability: 'privacy-blocked',
        privacyClass: 'raw-audio',
        requiredPermissions: expect.arrayContaining(['aurora.android.microphone']),
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'needs_native_permission' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.notifications']).toEqual(
      expect.objectContaining({
        availability: 'privacy-blocked',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'needs_native_permission' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.biometric']).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'unsupported_platform' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.secureCredentialStorage']).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        privacyClass: 'credential',
        providerIdentity: 'native:android'
      })
    )
    expect(graph.byFeatureId['native:android:android.adminUnlock']).toEqual(
      expect.objectContaining({
        availability: 'privacy-blocked',
        privacyClass: 'admin-critical',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'needs_native_permission' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.localFileRead']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'degraded' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.shareIntent']).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'native:android'
      })
    )
    expect(graph.byFeatureId['native:android:android.deepLink']).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'native:android'
      })
    )
    expect(graph.byFeatureId['native:android:android.appWidget']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'fallback' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.appShortcut']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'fallback' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.quickTile']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'fallback' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.entrypointPayload']).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'native:android'
      })
    )
    expect(graph.byFeatureId['native:android:android.fallbackEntrypoints']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'fallback' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.localLightInference.provider']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        privacyClass: 'personal',
        providers: expect.arrayContaining([
          expect.objectContaining({
            providerIdentity: 'native:android',
            routeability: 'degraded',
            requiredAction: 'use the supported subset or complete native integration'
          })
        ])
      })
    )
    expect(graph.byFeatureId['native:android:android.localLightInference.modelRuntime']).toEqual(
      expect.objectContaining({
        availability: 'privacy-blocked',
        requiredPermissions: expect.arrayContaining(['aurora.android.localLightInference']),
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'needs_native_permission' })])
      })
    )
    expect(graph.byFeatureId['native:android:android.localLightInference.fallback']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'fallback' })])
      })
    )
    expect(graph.byFeatureId['native:android:androidWidget']).toEqual(
      expect.objectContaining({
        availability: 'degraded',
        providers: expect.arrayContaining([
          expect.objectContaining({
            disabledReasons: expect.arrayContaining([
              expect.stringContaining('Widget provider is packaged')
            ])
          })
        ])
      })
    )
  })

  it('keeps iOS native invocation app-owned without Siri replacement capability', () => {
    const graph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: {
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
      },
      transportKind: 'native-mobile'
    })

    expect(graph.byFeatureId['native:ios:ios.appIntents']).toEqual(
      expect.objectContaining({
        availability: 'available-local',
        providerIdentity: 'native:ios',
        requiredPermissions: []
      })
    )
    expect(graph.byFeatureId['native:ios:ios.siriReplacement']).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        providerIdentity: 'native:ios',
        routeable: false
      })
    )
  })

  it('distinguishes Android assistant-role held, denied, and OEM-unavailable native states', () => {
    const heldGraph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: {
        ...androidNativeCapabilityManifestFixture,
        permissions: {
          ...androidNativeCapabilityManifestFixture.permissions,
          'aurora.android.assistantRoleRequest': false
        },
        capabilities: {
          ...androidNativeCapabilityManifestFixture.capabilities,
          'android.assistantRole.request': false,
          'android.assistantRole.held': true
        },
        capabilityStates: {
          ...androidNativeCapabilityManifestFixture.capabilityStates,
          'android.assistantRole.request': 'degraded',
          'android.assistantRole.held': 'available'
        },
        assistantRole: {
          ...androidNativeCapabilityManifestFixture.assistantRole!,
          roleHeld: true,
          requestable: false,
          reason: 'role_held'
        }
      },
      transportKind: 'native-mobile'
    })
    expect(heldGraph.byFeatureId['native:android:android.assistantRole.held']).toEqual(
      expect.objectContaining({ availability: 'available-local' })
    )

    const deniedGraph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: {
        ...androidNativeCapabilityManifestFixture,
        capabilityStates: {
          ...androidNativeCapabilityManifestFixture.capabilityStates,
          'android.assistantRole.request': 'needs_native_permission',
          'android.assistantRole.denied': 'needs_native_permission'
        },
        assistantRole: {
          ...androidNativeCapabilityManifestFixture.assistantRole!,
          denied: true,
          requestable: false,
          reason: 'request_denied'
        }
      },
      transportKind: 'native-mobile'
    })
    expect(deniedGraph.byFeatureId['native:android:android.assistantRole.denied']).toEqual(
      expect.objectContaining({
        availability: 'privacy-blocked',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'needs_native_permission' })])
      })
    )

    const oemUnavailableGraph = buildCapabilityGraph({
      catalog: capabilityGraphCatalogFixture,
      registry: gatewayRegistryFixture,
      nativeManifest: {
        ...androidNativeCapabilityManifestFixture,
        permissions: {
          ...androidNativeCapabilityManifestFixture.permissions,
          'aurora.android.assistantRoleRequest': false
        },
        capabilities: {
          ...androidNativeCapabilityManifestFixture.capabilities,
          'android.assistantRole.available': false,
          'android.assistantRole.request': false,
          'android.assistantRole.oemUnavailable': true
        },
        capabilityStates: {
          ...androidNativeCapabilityManifestFixture.capabilityStates,
          'android.assistantRole.available': 'unsupported_platform',
          'android.assistantRole.request': 'unsupported_platform',
          'android.assistantRole.oemUnavailable': 'unsupported_platform'
        },
        assistantRole: {
          ...androidNativeCapabilityManifestFixture.assistantRole!,
          roleAvailable: false,
          requestable: false,
          oemUnavailable: true,
          reason: 'oem_unavailable'
        }
      },
      transportKind: 'native-mobile'
    })
    expect(oemUnavailableGraph.byFeatureId['native:android:android.assistantRole.oemUnavailable']).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        providers: expect.arrayContaining([expect.objectContaining({ routeability: 'unsupported_platform' })])
      })
    )
    expect(oemUnavailableGraph.byFeatureId['native:android:android.fallbackEntrypoints']).toEqual(
      expect.objectContaining({ availability: 'degraded' })
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
        services: 4,
        methods: 33,
        externalMethods: 32,
        internalMethods: 1,
        gatewayBuiltins: 2,
        capabilityActions: 1
      })
    )
    expect(manifest.services.find((service) => service.module === 'Gateway')).toEqual(
      expect.objectContaining({
        module: 'Gateway',
        status: 'healthy',
        requiredPermissions: ['Gateway.manage', 'Gateway.use']
      })
    )
    expect(manifest.internalOnly).toHaveLength(1)
    expect(manifest.internalOnly[0]?.busTopic).toBe('Gateway.InternalOnly')
    expect(manifest.permissionCatalog).toEqual([
      'Auth.manage',
      'Gateway.manage',
      'Gateway.use',
      'Orchestrator.manage',
      'Orchestrator.use',
      'Scheduler.manage',
      'Scheduler.use'
    ])
    expect(manifest.native).toEqual(
      expect.objectContaining({
        availability: 'unsupported',
        evidenceSource: 'not-provided'
      })
    )
    expect(manifest.deploymentTopology).toBeNull()
    expect(manifest.deploymentTopologyError).toBeNull()
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
      .register('Gateway.GetDeploymentTopology', deploymentTopologyFixture)
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
    expect(manifest.deploymentTopology?.bus_backend).toBe('LocalBus')
    expect(manifest.deploymentTopology?.mode_capability_degradations).toContain('thread_mode_no_process_controls')
    expect(manifest.native.availability).toBe('unsupported')
  })

  it('keeps admin overview usable when deployment topology is unavailable', async () => {
    const transport = new MockAuroraTransport()
      .register('Gateway.GetRegistry', gatewayRegistryFixture)
      .register('Gateway.GetServices', gatewayServicesFixture)
      .register('Gateway.GetCapabilityCatalog', capabilityCatalogFixture)
      .lose('Gateway.GetDeploymentTopology', 'deployment topology unavailable')
    const client = new AuroraClient({ transport })

    const manifest = await client.adminOverview.getManifest()

    expect(manifest.services.length).toBeGreaterThan(0)
    expect(manifest.deploymentTopology).toBeNull()
    expect(manifest.deploymentTopologyError).toBe('deployment topology unavailable')
  })

  it('accepts process-mode deployment topology evidence in admin overview fixtures', () => {
    const topology = cloneFixture(deploymentTopologyFixture)
    topology.architecture_mode = 'processes'
    topology.runtime_mode = 'server-process'
    topology.bus_backend = 'BullMQBus'
    topology.redis_url_redacted = 'redis://[redacted]@redis:6379/0'
    topology.redis_reachable = true
    topology.bullmq_queue_health = {
      ...topology.bullmq_queue_health,
      backend: 'BullMQBus',
      redis_url_redacted: 'redis://[redacted]@redis:6379/0',
      redis_reachable: true,
      bullmq_available: true,
      queue_depth: 0,
      status: 'healthy',
      degraded_reasons: []
    }
    topology.mode_capability_degradations = []
    topology.container_topology_hints = {
      orchestrator: 'docker-compose',
      compose_file: 'docker-compose.process.yml',
      redis_service: 'redis',
      gateway_service: 'gateway-service',
      config_service: 'config-service',
      notes: ['process mode runs one container per Aurora service']
    }

    const manifest = buildAdminOverviewManifest({
      registry: gatewayRegistryFixture,
      services: { ...gatewayServicesFixture, mode: 'processes' },
      capabilityCatalog: capabilityCatalogFixture,
      deploymentTopology: topology
    })

    expect(manifest.serviceMode).toBe('processes')
    expect(manifest.deploymentTopology?.bus_backend).toBe('BullMQBus')
    expect(manifest.deploymentTopology?.redis_url_redacted).toContain('[redacted]')
    expect(manifest.deploymentTopology?.mode_capability_degradations).toEqual([])
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
        permissions: expect.objectContaining({
          'aurora.sidecarStart': true,
          'aurora.shell': false
        }),
        capabilities: expect.objectContaining({
          'desktop.localSidecarSupervision': true,
          'native.audio': false
        })
      })
    )
    expect(toolCatalog.tools[0]?.global_tool_id).toBe('tool:local:diagnostics.serviceHealth')
    expect(uiMockReferenceFixtureSummary.privacyClasses).toContain('admin-critical')
  })

  it('ingests assistant attachment context through the typed SDK namespace', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    await expect(
      client.assistant.ingestContext({
        items: [
          {
            kind: 'text',
            content_text: 'Screenshot OCR with password=redacted by backend',
            title: 'Screenshot OCR',
            source: { channel: 'mobile_share_sheet', display_name: 'Android share sheet' }
          },
          {
            kind: 'image',
            filename: 'screen.png',
            mime_type: 'image/png',
            size_bytes: 42_000,
            source: { channel: 'mobile_share_sheet', display_name: 'Android share sheet' }
          }
        ],
        privacy_class: 'personal',
        storage_policy: 'ephemeral',
        limits: { max_item_bytes: 262_144 }
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          accepted: true,
          rejected: true,
          accepted_items: [
            expect.objectContaining({
              kind: 'text',
              status: 'redacted',
              redacted: true,
              privacy_class: 'personal'
            })
          ],
          rejected_items: [
            expect.objectContaining({
              kind: 'image',
              status: 'unsupported',
              reason_code: 'no_text_context'
            })
          ],
          secrets_redacted: true
        })
      })
    )

    await expect(
      client.assistant.ingestContext({
        items: [{ kind: 'text', content_text: 'token body' }],
        privacy_class: 'credential'
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          accepted: false,
          rejected: true,
          rejected_items: [
            expect.objectContaining({
              status: 'rejected',
              reason_code: 'privacy_class_blocked'
            })
          ]
        })
      })
    )
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
        modules: expect.arrayContaining([
          expect.objectContaining({
            methods: expect.arrayContaining([
              expect.objectContaining({
                bus_topic: 'Gateway.GetRegistry',
                required_perms: ['Gateway.use']
              })
            ])
          })
        ])
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

  it('drafts, confirms, and submits AdminAction routes with backend-issued headers', async () => {
    const calls: Array<{ method: string; payload: unknown; headers?: Record<string, string> }> = []
    const recordCall = (method: string, payload: unknown, headers?: Record<string, string>) => {
      const call: { method: string; payload: unknown; headers?: Record<string, string> } = { method, payload }
      if (headers !== undefined) call.headers = headers
      calls.push(call)
    }
    const transport = new MockAuroraTransport({ fixtures: false })
      .register('Gateway.AdminActionDraft', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return {
          action_id: 'aa-config-set',
          nonce: 'nonce-config-set',
          digest: 'digest-config-set',
          method_id: 'Config.Set',
          affected_resources: ['key:services.gateway.enabled'],
          required_phrase: 'CONFIRM',
          required_reason: true,
          required_reauth: true,
          expires_at: '2026-06-20T10:05:00Z',
          expires_in_seconds: 300,
          confirmation_headers: {
            action_id: 'X-Aurora-AdminAction-Id',
            confirmation_token: 'X-Aurora-AdminAction-Token',
            digest: 'X-Aurora-AdminAction-Digest'
          }
        }
      })
      .register('Gateway.AdminActionConfirm', (request) => {
        recordCall(request.method, request.payload, request.headers)
        expect(request.payload).toEqual(
          expect.objectContaining({
            action_id: 'aa-config-set',
            nonce: 'nonce-config-set',
            digest: 'digest-config-set',
            reason: 'Enable Gateway for local admin',
            reauth_confirmed: true,
            phrase: 'CONFIRM'
          })
        )
        return {
          action_id: 'aa-config-set',
          confirmation_token: 'token-config-set',
          digest: 'digest-config-set',
          confirmed: true,
          expires_at: '2026-06-20T10:05:00Z',
          audit_receipt: 'aar-config-set',
          confirmation_headers: {
            action_id: 'X-Aurora-AdminAction-Id',
            confirmation_token: 'X-Aurora-AdminAction-Token',
            digest: 'X-Aurora-AdminAction-Digest'
          }
        }
      })
      .register('Config.Set', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return { success: true, correlation_id: 'corr-config-set' }
      })
    const client = new AuroraClient({ transport })
    const payload = { key: 'services.gateway.enabled', value: true }

    const draft = await client.admin.draft({ method_id: 'Config.Set', payload })
    const confirmation = await client.admin.confirm(draft, {
      reason: 'Enable Gateway for local admin',
      reauthConfirmed: true
    })
    const submitted = await client.admin.submit<{ success: boolean }>({
      methodId: 'Config.Set',
      payload,
      confirmation
    })

    expect(submitted.success).toBe(true)
    expect(calls.at(-1)).toEqual(
      expect.objectContaining({
        method: 'Config.Set',
        payload,
        headers: {
          'X-Aurora-AdminAction-Id': 'aa-config-set',
          'X-Aurora-AdminAction-Token': 'token-config-set',
          'X-Aurora-AdminAction-Digest': 'digest-config-set'
        }
      })
    )
  })

  it('loads config metadata, diff, reload impact, and history through the config namespace', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    const schema = await client.config.getSchemaMetadata({ include_values: true })
    const diff = await client.config.previewDiff({ changes: [{ key_path: 'services.gateway.api.port', value: 8080 }] })
    const impact = await client.config.previewReloadImpact({ changes: [{ key_path: 'services.gateway.api.port', value: 8080 }] })
    const history = await client.config.getVersionHistory({ limit: 2 })

    expect(schema.ok).toBe(true)
    expect(schema.ok && schema.data.fields.some((field) => field.key_path === 'services.gateway.api.token_secret' && field.secret)).toBe(true)
    expect(diff.ok && diff.data.diffs[0]?.restart_required).toBe(true)
    expect(impact.ok && impact.data.impacts[0]?.affected_services).toContain('gateway')
    expect(history.ok && history.data.versions[0]?.version_id).toBe('cfgv-gateway-port-001')
  })

  it('applies config changes and rollback through AdminAction headers', async () => {
    const calls: Array<{ method: string; payload: unknown; headers?: Record<string, string> }> = []
    const recordCall = (method: string, payload: unknown, headers?: Record<string, string>) => {
      const call: { method: string; payload: unknown; headers?: Record<string, string> } = { method, payload }
      if (headers !== undefined) call.headers = headers
      calls.push(call)
    }
    const transport = new MockAuroraTransport({ fixtures: false })
      .register('Gateway.AdminActionDraft', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return {
          action_id: 'aa-config',
          nonce: 'nonce-config',
          digest: 'digest-config',
          method_id: (request.payload as { method_id: string }).method_id,
          affected_resources: ['services.gateway.api.port'],
          required_phrase: 'APPLY',
          required_reason: true,
          required_reauth: false,
          expires_at: '2026-06-19T00:10:00Z',
          expires_in_seconds: 300,
          confirmation_headers: {
            action_id: 'X-Aurora-AdminAction-Id',
            confirmation_token: 'X-Aurora-AdminAction-Token',
            digest: 'X-Aurora-AdminAction-Digest'
          }
        }
      })
      .register('Gateway.AdminActionConfirm', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return {
          action_id: 'aa-config',
          confirmation_token: 'token-config',
          digest: 'digest-config',
          confirmed: true,
          expires_at: '2026-06-19T00:10:00Z',
          audit_receipt: 'aar-config',
          confirmation_headers: {
            action_id: 'X-Aurora-AdminAction-Id',
            confirmation_token: 'X-Aurora-AdminAction-Token',
            digest: 'X-Aurora-AdminAction-Digest'
          }
        }
      })
      .register('Config.Set', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return { success: true, previous_value: 8000 }
      })
      .register('Config.Rollback', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return {
          success: true,
          version_id: 'cfgv-gateway-port-001',
          key_path: 'services.gateway.api.port',
          rolled_back_to: 7000,
          affected_sections: ['services.gateway.api'],
          error: null,
          secrets_redacted: true
        }
      })

    const client = new AuroraClient({ transport })
    await client.config.applyChange({
      change: { key_path: 'services.gateway.api.port', value: 8080 },
      reason: 'test change',
      reauthConfirmed: true
    })
    await client.config.rollback({
      versionId: 'cfgv-gateway-port-001',
      reason: 'test rollback',
      reauthConfirmed: true
    })

    const configSet = calls.find((call) => call.method === 'Config.Set')
    const rollback = calls.find((call) => call.method === 'Config.Rollback')
    expect(configSet?.headers).toMatchObject({ 'X-Aurora-AdminAction-Token': 'token-config' })
    expect(rollback?.headers).toMatchObject({ 'X-Aurora-AdminAction-Id': 'aa-config' })
    expect(calls.filter((call) => call.method === 'Gateway.AdminActionDraft')).toHaveLength(2)
  })

  it('loads diagnostics bundles and exports them through AdminAction', async () => {
    const calls: Array<{ method: string; payload: unknown; headers?: Record<string, string> }> = []
    const recordCall = (method: string, payload: unknown, headers?: Record<string, string>) => {
      const call: { method: string; payload: unknown; headers?: Record<string, string> } = { method, payload }
      if (headers !== undefined) call.headers = headers
      calls.push(call)
    }
    const transport = new MockAuroraTransport({ fixtures: false })
      .register('Gateway.GetSupportBundle', (request) => {
        recordCall(request.method, request.payload, request.headers)
        return supportBundleFixture
      })
      .register('Gateway.AdminActionDraft', (request) => {
        recordCall(request.method, request.payload, request.headers)
        expect(request.payload).toEqual(
          expect.objectContaining({
            method_id: 'Gateway.GetSupportBundle',
            payload: expect.objectContaining({ correlation_id: 'corr-diagnostics-fixture' }),
            affected_resources: expect.arrayContaining(['diagnostics.support_bundle'])
          })
        )
        return {
          action_id: 'aa-support-bundle',
          nonce: 'nonce-support-bundle',
          digest: 'digest-support-bundle',
          method_id: 'Gateway.GetSupportBundle',
          affected_resources: ['diagnostics.support_bundle'],
          required_phrase: 'CONFIRM',
          required_reason: true,
          required_reauth: true,
          expires_at: '2026-06-20T10:05:00Z',
          expires_in_seconds: 300,
          confirmation_headers: {
            action_id: 'X-Aurora-AdminAction-Id',
            confirmation_token: 'X-Aurora-AdminAction-Token',
            digest: 'X-Aurora-AdminAction-Digest'
          }
        }
      })
      .register('Gateway.AdminActionConfirm', {
        action_id: 'aa-support-bundle',
        confirmation_token: 'token-support-bundle',
        digest: 'digest-support-bundle',
        confirmed: true,
        expires_at: '2026-06-20T10:05:00Z',
        audit_receipt: 'aar-support-bundle',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      })
    const client = new AuroraClient({ transport })

    const preview = await client.diagnostics.getSupportBundle({
      correlation_id: 'corr-diagnostics-fixture',
      event_limit: 5,
      audit_limit: 5
    })
    const exported = await client.diagnostics.exportSupportBundle({
      request: { correlation_id: 'corr-diagnostics-fixture', event_limit: 5, audit_limit: 5 },
      reason: 'Share redacted diagnostics with support',
      reauthConfirmed: true
    })

    expect(preview.ok).toBe(true)
    if (preview.ok) {
      expect(preview.data.redaction).toEqual(
        expect.objectContaining({
          secrets_redacted: true,
          omitted_payloads: expect.arrayContaining(['raw audio', 'tokens and credentials'])
        })
      )
    }
    expect(exported.data.audit_receipt).toBe('support_bundle:fixture')
    expect(calls.at(-1)).toEqual(
      expect.objectContaining({
        method: 'Gateway.GetSupportBundle',
        headers: expect.objectContaining({
          'X-Aurora-AdminAction-Id': 'aa-support-bundle',
          'X-Aurora-AdminAction-Token': 'token-support-bundle',
          'X-Aurora-AdminAction-Digest': 'digest-support-bundle'
        })
      })
    )
  })

  it('lists backups through the Backup SDK namespace and wraps backup mutations in AdminAction', async () => {
    const calls: Array<{ method: string; payload: unknown; headers?: Record<string, string> }> = []
    const recordBackupCall = (method: string, payload: unknown, headers?: Record<string, string>) => {
      const call: { method: string; payload: unknown; headers?: Record<string, string> } = { method, payload }
      if (headers !== undefined) call.headers = headers
      calls.push(call)
    }
    const transport = new MockAuroraTransport()
      .register('Gateway.AdminActionDraft', (request) => {
        recordBackupCall(request.method, request.payload, request.headers)
        const methodId = (request.payload as { method_id: string }).method_id
        return adminDraftFixture(methodId)
      })
      .register('Gateway.AdminActionConfirm', (request) => {
        recordBackupCall(request.method, request.payload, request.headers)
        return adminConfirmFixture((request.payload as { action_id: string }).action_id)
      })
      .register('Backup.Create', (request) => {
        recordBackupCall(request.method, request.payload, request.headers)
        return {
          status: 'ok',
          backup: null,
          audit_receipt: 'audit-create',
          message: 'created'
        }
      })
      .register('Backup.Verify', (request) => {
        recordBackupCall(request.method, request.payload, request.headers)
        return {
          status: 'ok',
          backup_id: 'backup-20260625T120000Z-config-rag',
          verified: true,
          manifest_digest: 'sha256:backup-fixture-a',
          components: [],
          message: null
        }
      })
      .register('Backup.Restore', (request) => {
        recordBackupCall(request.method, request.payload, request.headers)
        return {
          status: 'ok',
          backup_id: 'backup-20260625T120000Z-config-rag',
          restored: false,
          rollback_backup_id: null,
          impact_plan: backupImpactPlanFixture(),
          audit_receipt: 'audit-restore',
          message: 'Restore dry-run only; no state was changed.'
        }
      })
      .register('Backup.Rollback', (request) => {
        recordBackupCall(request.method, request.payload, request.headers)
        return {
          status: 'ok',
          rollback_backup_id: 'rollback-1',
          rolled_back: false,
          impact_plan: backupImpactPlanFixture(),
          audit_receipt: 'audit-rollback',
          message: 'Rollback dry-run only; no state was changed.'
        }
      })
    const client = new AuroraClient({ transport })

    const listed = await client.backups.list()
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.data.backups[0]?.backup_id).toContain('backup-20260625')
      expect(listed.data.secrets_redacted).toBe(true)
    }

    await expect(client.backups.create({ reason: 'Operator backup', include_personal_data: false })).resolves.toMatchObject({ ok: true })
    await expect(client.backups.verify({ backup_id: 'backup-20260625T120000Z-config-rag' }, 'Verify before restore')).resolves.toMatchObject({ ok: true })
    await expect(client.backups.restore({ backup_id: 'backup-20260625T120000Z-config-rag', dry_run: true, reason: 'Preview restore' })).resolves.toMatchObject({ ok: true })
    await expect(client.backups.rollback({ rollback_backup_id: 'rollback-1', dry_run: true, reason: 'Preview rollback' })).resolves.toMatchObject({ ok: true })

    expect(calls.filter((call) => call.method === 'Gateway.AdminActionDraft')).toHaveLength(4)
    expect(calls.filter((call) => call.method === 'Gateway.AdminActionConfirm')).toHaveLength(4)
    for (const method of ['Backup.Create', 'Backup.Verify', 'Backup.Restore', 'Backup.Rollback']) {
      expect(calls.find((call) => call.method === method)?.headers).toEqual(
        expect.objectContaining({
          'X-Aurora-AdminAction-Id': expect.stringContaining('aa-Backup'),
          'X-Aurora-AdminAction-Token': expect.stringContaining('token-'),
          'X-Aurora-AdminAction-Digest': expect.stringContaining('digest-')
        })
      )
    }
  })


  it('keeps AdminAction and tool approval separate but composable for dangerous tools', async () => {
    const transport = new MockAuroraTransport({ fixtures: false })
      .register('Tooling.RequestApproval', {
        ok: true,
        approval_request_id: 'tool-approval-1',
        policy_decision: {
          decision_id: 'policy-1',
          allowed: true,
          approval_required: true,
          approval_mode: 'ask_each_time',
          token_ttl_seconds: 300,
          risk_class: 'admin-critical'
        },
        expires_at: 1781953500,
        correlation_id: 'corr-approval-1',
        error: null
      })
      .register('Tooling.ConfirmExecution', {
        ok: true,
        approval_token: 'tool-token-1',
        expires_at: 1781953500,
        policy_decision_id: 'policy-1',
        correlation_id: 'corr-approval-1',
        error: null
      })
      .register('Gateway.AdminActionDraft', {
        action_id: 'aa-tool',
        nonce: 'nonce-tool',
        digest: 'digest-tool',
        method_id: 'Tooling.ExecuteTool',
        affected_resources: ['tool:tool:remote-danger'],
        required_phrase: 'CONFIRM',
        required_reason: true,
        required_reauth: true,
        expires_at: '2026-06-20T10:05:00Z',
        expires_in_seconds: 300,
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      })
      .register('Gateway.AdminActionConfirm', {
        action_id: 'aa-tool',
        confirmation_token: 'admin-token-tool',
        digest: 'digest-tool',
        confirmed: true,
        expires_at: '2026-06-20T10:05:00Z',
        audit_receipt: 'aar-tool',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      })
      .register('Tooling.ExecuteTool', (request) => ({
        ok: true,
        used_tool_approval_token: (request.payload as { approval_token?: string }).approval_token,
        admin_header: request.headers?.['X-Aurora-AdminAction-Id']
      }))
    const client = new AuroraClient({ transport })

    const approval = await client.approvals.request({
      global_tool_id: 'tool:remote-danger',
      provider_peer_id: 'peer-kitchen',
      provider_service_instance_id: 'tooling-remote',
      args_hash: 'sha256:danger-args',
      redacted_args_preview: { target: 'garage', api_key: '[redacted]' },
      risk_class: 'admin-critical',
      requested_approval_scope: 'tool-args',
      expected_audit_event: 'tooling.approval.approved',
      args: { target: 'garage' }
    })
    const token = await client.approvals.approve({
      approval_request_id: approval.approval_request_id!,
      approver_principal_id: 'admin-1',
      reason: 'Operator approved garage diagnostic'
    })
    const adminDraft = await client.admin.draft({
      method_id: 'Tooling.ExecuteTool',
      payload: {
        global_tool_id: 'tool:remote-danger',
        approval_token: token.approvalToken,
        args: { target: 'garage' }
      }
    })
    const adminConfirmation = await client.admin.confirm(adminDraft, {
      reason: 'Dangerous tool requires admin confirmation',
      reauthConfirmed: true
    })
    const execution = await client.admin.submit<{ ok: boolean; used_tool_approval_token: string; admin_header: string }>({
      methodId: 'Tooling.ExecuteTool',
      payload: {
        global_tool_id: 'tool:remote-danger',
        approval_token: token.approvalToken,
        args: { target: 'garage' }
      },
      confirmation: adminConfirmation
    })

    expect(execution).toEqual({
      ok: true,
      used_tool_approval_token: 'tool-token-1',
      admin_header: 'aa-tool'
    })
  })

  it('submits tool denial decisions through the backend approval confirmation path', async () => {
    let confirmationPayload: unknown = null
    const transport = new MockAuroraTransport({ fixtures: false })
      .register('Tooling.ConfirmExecution', (request) => {
        confirmationPayload = request.payload
        return {
          ok: true,
          approval_token: null,
          expires_at: null,
          policy_decision_id: 'policy-local-danger',
          correlation_id: 'corr-local-danger-denied',
          error: null
        }
      })
    const client = new AuroraClient({ transport })
    const tool = normalizeToolCatalog(toolCatalogFixture).find((candidate) => candidate.id === 'tool:local:filesystem.writeConfig')
    if (!tool) throw new Error('missing local dangerous tool fixture')

    const result = await client.tools.submitDenialDecision({
      tool,
      approverPrincipalId: 'admin-1',
      reason: 'Operator denied config mutation'
    })

    expect(confirmationPayload).toEqual({
      approval_request_id: 'approval-local-danger',
      approver_principal_id: 'admin-1',
      approve: false,
      reason: 'Operator denied config mutation',
      correlation_id: 'corr-local-danger'
    })
    expect(result).toEqual({
      toolId: 'tool:local:filesystem.writeConfig',
      approvalRequestId: 'approval-local-danger',
      approvalToken: null,
      correlationId: 'corr-local-danger-denied',
      policyDecisionId: 'policy-local-danger',
      approved: false,
      audit: null
    })
  })

  it('classifies approval denial, expiry, replay, changed args, changed provider, and downgraded risk as typed errors', async () => {
    const cases = [
      ['approval_denied', 'permission'],
      ['approval_request_expired', 'timeout'],
      ['approval_request_replayed', 'validation'],
      ['approval_token_args_hash_mismatch', 'validation'],
      ['approval_token_provider_peer_id_mismatch', 'validation'],
      ['approval_token_downgraded_risk', 'validation']
    ] as const

    for (const [backendError, expectedCode] of cases) {
      const client = new AuroraClient({
        transport: new MockAuroraTransport({ fixtures: false }).register('Tooling.ConfirmExecution', {
          ok: false,
          approval_token: null,
          expires_at: null,
          policy_decision_id: null,
          correlation_id: `corr-${backendError}`,
          error: backendError
        })
      })

      await expect(
        client.approvals.confirm({
          approval_request_id: `approval-${backendError}`,
          approver_principal_id: 'admin-1'
        })
      ).rejects.toMatchObject({
        code: expectedCode,
        method: 'Tooling.ConfirmExecution',
        correlationId: `corr-${backendError}`
      })
    }
  })

  it('returns controller result errors for auth, permission, validation, timeout, unavailable, unsupported, privacy, native permission, and transport loss', async () => {
    const cases = [
      ['auth', 'Gateway.AdminActionDraft'],
      ['permission', 'Gateway.AdminActionDraft'],
      ['validation', 'Gateway.AdminActionDraft'],
      ['timeout', 'Gateway.AdminActionDraft'],
      ['unavailable_service', 'Gateway.AdminActionDraft'],
      ['unsupported_feature', 'Gateway.AdminActionDraft'],
      ['privacy_blocked', 'Gateway.AdminActionDraft'],
      ['native_permission_missing', 'Gateway.AdminActionDraft']
    ] as const

    for (const [code, method] of cases) {
      const client = new AuroraClient({
        transport: new MockAuroraTransport({ fixtures: false }).fail(method, code, `failure ${code}`)
      })
      const result = await client.result(() =>
        client.admin.draft({ method_id: 'Config.Set', payload: { key: 'x', value: true } })
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(code)
    }

    const lossClient = new AuroraClient({
      transport: new MockAuroraTransport({ fixtures: false }).lose('Gateway.AdminActionDraft')
    })
    const loss = await lossClient.result(() =>
      lossClient.admin.draft({ method_id: 'Config.Set', payload: { key: 'x', value: true } })
    )
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
        if (command === 'aurora_sidecar_session') {
          return { token: 'session-token' }
        }
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
    expect(calls[0]).toEqual({ command: 'aurora_sidecar_session', args: undefined })
    expect(calls[1]).toEqual({
      command: 'aurora_command',
      args: {
        request: expect.objectContaining({
          method: 'Gateway.GetRegistry',
          busTopic: 'Gateway.GetRegistry',
          path: '/api/registry',
          httpMethod: 'GET',
          headers: { 'x-aurora-sidecar-token': 'session-token' }
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
          case 'aurora_sidecar_session':
            return { token: 'session-token' }
          case 'aurora_sidecar_start':
            return { running: true, mode: 'sidecar', pid: 42 }
          case 'aurora_sidecar_stop':
            return { running: false, mode: 'desktop-local-stopped', pid: null }
          case 'aurora_sidecar_status':
            return { running: true, mode: 'sidecar', pid: 42 }
          case 'aurora_native_capability_manifest':
            return nativeCapabilityManifestFixture
          case 'aurora_native_permission_status':
            return {
              platform: 'tauri-desktop',
              permissions: nativeCapabilityManifestFixture.permissions,
              capabilities: nativeCapabilityManifestFixture.capabilities,
              deniedByDefault: ['aurora.notificationsSend', 'aurora.audioCapture'],
              privacyClasses: ['personal', 'credential', 'raw-audio'],
              evidenceSource: 'tauri-capability-manifest',
              secretsRedacted: true
            }
          case 'aurora_tray_status':
            return { available: true, permission: 'aurora.trayStatus', capability: 'desktop.tray', source: 'tauri-core-tray-icon' }
          case 'aurora_notification_status':
            return { available: false, permission: 'aurora.notificationsSend', capability: 'native.notifications', source: 'tauri-capability-manifest', reason: 'disabled' }
          case 'aurora_notification_send':
            throw { detail: { code: 'native_permission_missing', message: 'native permission missing' } }
          case 'aurora_dialog_status':
            return { available: false, permission: 'aurora.dialogOpen', capability: 'native.dialogs', source: 'tauri-capability-manifest', reason: 'disabled' }
          case 'aurora_audio_bridge_status':
            return {
              available: false,
              permission: 'aurora.audioCapture',
              capability: 'native.audio',
              source: 'tauri-capability-manifest',
              reason: 'raw-audio requires consent',
              details: { privacyClass: 'raw-audio', backendEvidenceRequired: true }
            }
          case 'aurora_log_tail':
            return { available: false, source: 'aurora-sidecar', lines: [], truncated: false }
          case 'aurora_secure_storage_get':
            return { key: 'session', value: 'token-ref' }
          case 'aurora_secure_storage_set':
          case 'aurora_secure_storage_delete':
            return { key: String(args?.key), ok: true }
          case 'aurora_biometric_admin_unlock_status':
            return {
              platform: 'android',
              available: false,
              requestable: false,
              deviceSecure: false,
              biometricReady: false,
              lastDenied: false,
              state: 'needs_native_permission',
              reason: 'device_credential_not_enrolled',
              privacyClass: 'admin-critical',
              evidenceSource: 'android-biometric-keyguard-keystore',
              secretsRedacted: true
            }
          case 'aurora_biometric_admin_unlock':
            return {
              started: false,
              reason: 'device_credential_not_enrolled',
              status: {
                platform: 'android',
                available: false,
                requestable: false,
                deviceSecure: false,
                biometricReady: false,
                lastDenied: false,
                state: 'needs_native_permission',
                reason: 'device_credential_not_enrolled',
                privacyClass: 'admin-critical',
                evidenceSource: 'android-biometric-keyguard-keystore',
                secretsRedacted: true
              },
              secretsRedacted: true
            }
          case 'aurora_local_file_read':
            return { path: String(args?.path), data: 'hello', encoding: 'utf-8' }
          case 'aurora_local_file_write':
            return { path: String(args?.path), ok: true, bytesWritten: 5 }
          case 'aurora_local_file_pick':
            return { paths: ['/tmp/a.txt'], cancelled: false }
          case 'aurora_secure_file_handle_open':
            return { paths: ['/tmp/a.txt'], cancelled: false }
          default:
            throw new Error(`Unexpected command ${command}`)
        }
      }
    })

    await expect(transport.getSidecarStatus()).resolves.toEqual(
      expect.objectContaining({ running: true, mode: 'sidecar' })
    )
    await expect(transport.startSidecar()).resolves.toEqual(expect.objectContaining({ running: true }))
    await expect(transport.stopSidecar()).resolves.toEqual(expect.objectContaining({ running: false }))
    await expect(transport.getNativeCapabilityManifest()).resolves.toEqual(nativeCapabilityManifestFixture)
    await expect(transport.getNativePermissionStatus()).resolves.toEqual(
      expect.objectContaining({
        deniedByDefault: expect.arrayContaining(['aurora.notificationsSend', 'aurora.audioCapture']),
        privacyClasses: expect.arrayContaining(['raw-audio']),
        secretsRedacted: true
      })
    )
    await expect(transport.getTrayStatus()).resolves.toEqual(
      expect.objectContaining({ available: true, capability: 'desktop.tray' })
    )
    await expect(transport.getNotificationStatus()).resolves.toEqual(
      expect.objectContaining({ available: false, permission: 'aurora.notificationsSend' })
    )
    await expect(transport.sendNotification({ title: 'Aurora', body: 'Ready' })).rejects.toMatchObject({
      code: 'native_permission_missing'
    })
    await expect(transport.getDialogStatus()).resolves.toEqual(
      expect.objectContaining({ available: false, capability: 'native.dialogs' })
    )
    await expect(transport.getAudioBridgeStatus()).resolves.toEqual(
      expect.objectContaining({
        available: false,
        details: expect.objectContaining({ privacyClass: 'raw-audio', backendEvidenceRequired: true })
      })
    )
    await expect(transport.getLogTail({ lines: 10 })).resolves.toEqual({
      available: false,
      source: 'aurora-sidecar',
      lines: [],
      truncated: false
    })
    await expect(transport.secureStorageGet('session')).resolves.toEqual({ key: 'session', value: 'token-ref' })
    await expect(transport.secureStorageSet('session', 'token-ref')).resolves.toEqual({ key: 'session', ok: true })
    await expect(transport.secureStorageDelete('session')).resolves.toEqual({ key: 'session', ok: true })
    await expect(transport.getBiometricAdminUnlockStatus()).resolves.toEqual(
      expect.objectContaining({
        privacyClass: 'admin-critical',
        secretsRedacted: true
      })
    )
    await expect(transport.requestBiometricAdminUnlock()).resolves.toEqual(
      expect.objectContaining({
        started: false,
        reason: 'device_credential_not_enrolled',
        secretsRedacted: true
      })
    )
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
    await expect(transport.openSecureFileHandle({ mode: 'read' })).resolves.toEqual({
      paths: ['/tmp/a.txt'],
      cancelled: false
    })

    expect(calls.map((call) => call.command)).toEqual([
      'aurora_sidecar_status',
      'aurora_sidecar_session',
      'aurora_sidecar_start',
      'aurora_sidecar_stop',
      'aurora_native_capability_manifest',
      'aurora_native_permission_status',
      'aurora_tray_status',
      'aurora_notification_status',
      'aurora_notification_send',
      'aurora_dialog_status',
      'aurora_audio_bridge_status',
      'aurora_log_tail',
      'aurora_secure_storage_get',
      'aurora_secure_storage_set',
      'aurora_secure_storage_delete',
      'aurora_biometric_admin_unlock_status',
      'aurora_biometric_admin_unlock',
      'aurora_local_file_read',
      'aurora_local_file_write',
      'aurora_local_file_pick',
      'aurora_secure_file_handle_open'
    ])
    expect(calls[2]?.args).toEqual({ commandToken: { token: 'session-token' } })
    expect(calls[3]?.args).toEqual({ commandToken: { token: 'session-token' } })
    expect(calls[8]?.args).toEqual({ request: { title: 'Aurora', body: 'Ready' } })
    expect(calls[11]?.args).toEqual({ request: { lines: 10 } })
    expect(calls[12]?.args).toEqual({ key: 'session' })
    expect(calls[13]?.args).toEqual({ key: 'session', value: 'token-ref' })
    expect(calls[17]?.args).toEqual({ path: '/tmp/a.txt', options: {} })
    expect(calls[18]?.args).toEqual({ path: '/tmp/a.txt', data: 'hello', options: {} })
    expect(calls[20]?.args).toEqual({ options: { mode: 'read' } })
  })

  it('exposes Android assistant-role status and fallback entrypoints through the Tauri transport', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        switch (command) {
          case 'aurora_native_capability_manifest':
            return androidNativeCapabilityManifestFixture
          case 'assistantRoleStatus':
            return androidNativeCapabilityManifestFixture.assistantRole
          case 'requestAssistantRole':
            return {
              started: true,
              requestCode: 4202,
              status: androidNativeCapabilityManifestFixture.assistantRole,
              reason: 'requestable'
            }
          case 'fallbackEntrypoints':
            return androidNativeCapabilityManifestFixture.fallbackEntrypoints
          case 'localLightInferenceStatus':
            return androidNativeCapabilityManifestFixture.localLightInference
          case 'requestAndroidPermission':
            return {
              started: true,
              permission: args?.permission,
              requestCode: 4204,
              requestedPermissions: ['android.permission.RECORD_AUDIO']
            }
          case 'voiceForegroundServiceStatus':
            return androidNativeCapabilityManifestFixture.voiceForegroundService
          case 'startVoiceForegroundService':
            return {
              started: false,
              reason: 'microphone_permission_missing',
              status: androidNativeCapabilityManifestFixture.voiceForegroundService
            }
          case 'stopVoiceForegroundService':
            return {
              stopped: false,
              reason: 'foreground_service_not_running',
              status: androidNativeCapabilityManifestFixture.voiceForegroundService
            }
          case 'entrypointPayload':
            return {
              payload: androidNativeCapabilityManifestFixture.lastEntrypointPayload,
              entrypoints: androidNativeCapabilityManifestFixture.entrypoints,
              evidenceSource: 'android-intent-redacted',
              secretsRedacted: true
            }
          default:
            throw new Error(`Unexpected command ${command}`)
        }
      }
    })

    await expect(transport.getNativeCapabilityManifest()).resolves.toEqual(
      expect.objectContaining({
        platform: 'android',
        assistantRole: expect.objectContaining({
          roleAvailable: true,
          packageQualified: true,
          roleHeld: false,
          requestable: true,
          oemUnavailable: false,
          reason: 'requestable',
          handlesAssistActivity: true,
          declaresVoiceInteractionService: true
        }),
        permissionStates: expect.objectContaining({
          'aurora.android.microphone': 'needs_native_permission',
          'aurora.android.microphoneRequest': 'needs_native_permission',
          'aurora.android.notifications': 'needs_native_permission',
          'aurora.android.notificationsRequest': 'needs_native_permission',
          'aurora.android.voiceForegroundService': 'needs_native_permission',
          'aurora.android.biometric': 'unsupported_platform',
          'aurora.android.secureStorage': 'available',
          'aurora.android.adminUnlock': 'needs_native_permission',
          'aurora.android.localNetwork': 'available',
          'aurora.android.filePick': 'degraded',
          'aurora.android.shareIntent': 'available',
          'aurora.android.quickTile': 'fallback',
          'aurora.android.entrypointPayload': 'available',
          'aurora.android.localLightInference': 'degraded'
        }),
        capabilityStates: expect.objectContaining({
          'android.assistantRole.packageQualified': 'available',
          'android.assistantRole.request': 'needs_native_permission',
          'android.assistantRole.held': 'needs_native_permission',
          'android.assistantRole.denied': 'degraded',
          'android.assistantRole.oemUnavailable': 'degraded',
          'android.foregroundService': 'needs_native_permission',
          'android.voiceForegroundService': 'needs_native_permission',
          'android.voiceForegroundService.start': 'needs_native_permission',
          'android.secureCredentialStorage': 'available',
          'android.adminUnlock': 'needs_native_permission',
          'android.localFileRead': 'degraded',
          'android.appWidget': 'fallback',
          'android.quickTile': 'fallback',
          'android.fallbackEntrypoints': 'fallback',
          'android.localLightInference.provider': 'degraded',
          'android.localLightInference.modelRuntime': 'needs_native_permission',
          'android.localLightInference.fallback': 'fallback'
        }),
        localLightInference: expect.objectContaining({
          providerId: 'native:mobile-local-light',
          state: 'degraded',
          fallbackAvailable: true,
          backendModelCatalogRequired: true,
          reason: 'backend_model_catalog_and_device_model_proof_required'
        }),
        voiceForegroundService: expect.objectContaining({
          state: 'needs_native_permission',
          reason: 'microphone_permission_missing',
          backendAudioEvidenceRequired: true
        }),
        mobileIntegrations: expect.arrayContaining([
          expect.objectContaining({ id: 'androidShareSheet', support: 'supported' }),
          expect.objectContaining({ id: 'androidWidget', support: 'supported-path' }),
          expect.objectContaining({ id: 'androidQuickTile', support: 'supported-path' }),
          expect.objectContaining({ id: 'androidLocalLightInference', support: 'supported-path' })
        ]),
        entrypoints: expect.arrayContaining([
          expect.objectContaining({ id: 'share_sheet', backendRequired: true, payloadCommand: 'entrypointPayload' }),
          expect.objectContaining({ id: 'deep_link', backendRequired: true }),
          expect.objectContaining({ id: 'quick_tile', backendRequired: false })
        ]),
        lastEntrypointPayload: expect.objectContaining({ source: 'none', secretsRedacted: true }),
        fallbackEntrypoints: expect.arrayContaining([
          expect.objectContaining({ id: 'app_open', state: 'fallback', available: true }),
          expect.objectContaining({ id: 'foreground_voice_controls', state: 'needs_native_permission', available: false }),
          expect.objectContaining({ id: 'notification', state: 'needs_native_permission', available: false }),
          expect.objectContaining({ id: 'quick_tile', state: 'fallback', available: true, manifestDeclared: true }),
          expect.objectContaining({ id: 'app_widget', state: 'fallback', available: true, manifestDeclared: true }),
          expect.objectContaining({ id: 'share_intent', state: 'fallback', available: true })
        ])
      })
    )
    await expect(transport.getAndroidAssistantRoleStatus()).resolves.toEqual(
      expect.objectContaining({
        roleName: 'android.app.role.ASSISTANT',
        roleAvailable: true,
        packageQualified: true,
        roleHeld: false,
        requestable: true,
        fallbackAvailable: true,
        handlesAssistActivity: true,
        declaresVoiceInteractionService: true
      })
    )
    await expect(transport.requestAndroidAssistantRole()).resolves.toEqual(
      expect.objectContaining({
        started: true,
        requestCode: 4202,
        reason: 'requestable'
      })
    )
    await expect(transport.getAndroidFallbackEntrypoints()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'push_to_talk', state: 'needs_native_permission', available: false }),
        expect.objectContaining({ id: 'foreground_voice_controls', state: 'needs_native_permission', available: false }),
        expect.objectContaining({ id: 'notification', state: 'needs_native_permission', available: false }),
        expect.objectContaining({ id: 'share_intent', state: 'fallback', available: true, backendRequired: true })
      ])
    )
    await expect(transport.getAndroidLocalLightInferenceStatus()).resolves.toEqual(
      expect.objectContaining({
        providerId: 'native:mobile-local-light',
        state: 'degraded',
        fallbackAvailable: true,
        modelRuntimeProvider: false
      })
    )
    await expect(transport.requestAndroidPermission('aurora.android.microphone')).resolves.toEqual(
      expect.objectContaining({
        started: true,
        permission: 'aurora.android.microphone',
        requestCode: 4204,
        requestedPermissions: ['android.permission.RECORD_AUDIO']
      })
    )
    await expect(transport.getAndroidVoiceForegroundServiceStatus()).resolves.toEqual(
      expect.objectContaining({
        state: 'needs_native_permission',
        backendAudioEvidenceRequired: true
      })
    )
    await expect(transport.startAndroidVoiceForegroundService()).resolves.toEqual(
      expect.objectContaining({
        started: false,
        reason: 'microphone_permission_missing'
      })
    )
    await expect(transport.stopAndroidVoiceForegroundService()).resolves.toEqual(
      expect.objectContaining({
        stopped: false,
        reason: 'foreground_service_not_running'
      })
    )
    await expect(transport.getAndroidEntrypointPayload()).resolves.toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ source: 'none', secretsRedacted: true }),
        entrypoints: expect.arrayContaining([
          expect.objectContaining({ id: 'share_sheet', manifestDeclared: true })
        ]),
        evidenceSource: 'android-intent-redacted',
        secretsRedacted: true
      })
    )
    expect(calls.map((call) => call.command)).toEqual([
      'aurora_native_capability_manifest',
      'assistantRoleStatus',
      'requestAssistantRole',
      'fallbackEntrypoints',
      'localLightInferenceStatus',
      'requestAndroidPermission',
      'voiceForegroundServiceStatus',
      'startVoiceForegroundService',
      'stopVoiceForegroundService',
      'entrypointPayload'
    ])
    expect(calls[5]?.args).toEqual({ permission: 'aurora.android.microphone' })
  })

  it('exposes iOS Swift native plugin manifest, status, and action invocation through the Tauri transport', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const iosManifest = {
      platform: 'ios',
      permissions: {
        'aurora.iosAppIntents': true,
        'aurora.iosShortcuts': true,
        'aurora.iosShareExtension': false,
        'aurora.iosWidgets': false,
        'aurora.iosDeepLinks': false,
        'aurora.iosSiriReplacement': false
      },
      capabilities: {
        'ios.appIntents': true,
        'ios.shortcuts': true,
        'ios.shareExtension': false,
        'ios.widgets': false,
        'ios.deepLinks': false,
        'ios.siriReplacement': false
      }
    }
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        switch (command) {
          case 'aurora_ios_native_plugin_manifest':
            return iosManifest
          case 'aurora_ios_invocation_status':
            return {
              available: true,
              surface: 'Siri/Shortcuts/App Intents integration',
              supportedActions: [
                'app-intent.open-assistant',
                'shortcut.open-assistant',
                'share.import-context',
                'deeplink.open'
              ],
              siriReplacement: false,
              requiresBackendEvidence: true,
              secretsRedacted: true
            }
          case 'aurora_ios_invoke_action':
            return {
              accepted: true,
              action: (args?.request as { action?: string } | undefined)?.action,
              handoff: 'AuroraClient',
              correlationId: (args?.request as { correlationId?: string } | undefined)?.correlationId,
              secretsRedacted: true
            }
          default:
            throw new Error(`Unexpected command ${command}`)
        }
      }
    })

    await expect(transport.getIosNativePluginManifest()).resolves.toEqual(
      expect.objectContaining({
        platform: 'ios',
        capabilities: expect.objectContaining({
          'ios.appIntents': true,
          'ios.siriReplacement': false
        }),
        permissions: expect.objectContaining({
          'aurora.iosAppIntents': true,
          'aurora.iosSiriReplacement': false
        })
      })
    )
    await expect(transport.getIosInvocationStatus()).resolves.toEqual(
      expect.objectContaining({
        surface: 'Siri/Shortcuts/App Intents integration',
        supportedActions: expect.arrayContaining(['app-intent.open-assistant', 'share.import-context']),
        siriReplacement: false,
        requiresBackendEvidence: true,
        secretsRedacted: true
      })
    )
    await expect(
      transport.invokeIosAuroraAction({
        action: 'app-intent.open-assistant',
        correlationId: 'corr-ios-action'
      })
    ).resolves.toEqual(
      expect.objectContaining({
        accepted: true,
        action: 'app-intent.open-assistant',
        handoff: 'AuroraClient',
        correlationId: 'corr-ios-action',
        secretsRedacted: true
      })
    )
    expect(calls.map((call) => call.command)).toEqual([
      'aurora_ios_native_plugin_manifest',
      'aurora_ios_invocation_status',
      'aurora_ios_invoke_action'
    ])
    expect(calls[2]?.args).toEqual({
      request: {
        action: 'app-intent.open-assistant',
        correlationId: 'corr-ios-action'
      }
    })
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
        expect(command).toBe('aurora_subscribe')
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

describe('AuroraClient assistant namespace', () => {
  it('streams assistant deltas, final event evidence, and model metadata', async () => {
    const transport = new MockAuroraTransport().stream('assistant', [
      { id: 's1', kind: 'assistant.delta', payload: { textDelta: 'Hel' }, correlation_id: 'corr-stream' },
      { id: 's2', kind: 'assistant.delta', payload: { delta: 'lo' }, correlation_id: 'corr-stream' },
      {
        id: 's3',
        kind: 'assistant.completed',
        payload: { text: 'Hello', session_id: 'session-stream', metadata: { model: 'mock-stream' } },
        correlation_id: 'corr-stream'
      }
    ])
    const client = new AuroraClient({ transport })

    const events = await collectEvents(client.assistant.streamMessage({ text: 'hello' }), 3)

    expect(events.map((event) => event.kind)).toEqual(['delta', 'delta', 'completed'])
    expect(events[0]?.textDelta).toBe('Hel')
    expect(events[1]?.textDelta).toBe('lo')
    expect(events[2]).toEqual(
      expect.objectContaining({
        eventId: 's3',
        sessionId: 'session-stream',
        text: 'Hello',
        modelLabel: 'mock-stream',
        audit: expect.objectContaining({ correlationId: 'corr-stream' })
      })
    )
  })

  it('falls back to non-streaming assistant response when stream transport is unavailable before data', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    const events = await collectEvents(client.assistant.streamMessage({ text: 'fallback please' }), 1)

    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: 'fallback',
        sessionId: 'mock-assistant-session',
        text: 'Mock Aurora response to "fallback please"',
        modelLabel: 'mock-local'
      })
    )
  })

  it('reports transport loss after the last streamed event instead of inventing completion', async () => {
    const transport = new MockAuroraTransport().stream('assistant', async function* () {
      yield { id: 's1', kind: 'assistant.delta', payload: { text: 'partial' } }
      throw new TypeError('stream disconnected')
    })
    const client = new AuroraClient({ transport })

    const events = await collectEvents(client.assistant.streamMessage({ text: 'hello' }), 2)

    expect(events[0]?.kind).toBe('delta')
    expect(events[1]).toEqual(
      expect.objectContaining({
        kind: 'transport_lost',
        error: expect.objectContaining({ code: 'transport_loss' })
      })
    )
  })

  it('closes assistant stream on external abort without falling back to sendMessage', async () => {
    let sendCalls = 0
    const transport = new MockAuroraTransport().stream('assistant', async function* () {
      yield { id: 's1', kind: 'assistant.delta', payload: { text: 'partial' } }
      await new Promise(() => undefined)
    })
    transport.register(ORCHESTRATOR_METHODS.externalUserInput, () => {
      sendCalls += 1
      return {
        text: 'fallback should not run',
        session_id: 'session-fallback',
        metadata: { model: 'fallback-model' }
      }
    })
    const client = new AuroraClient({ transport })
    const controller = new AbortController()
    const iterator = client.assistant.streamMessage({ text: 'hello', signal: controller.signal })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: expect.objectContaining({ kind: 'delta', text: 'partial' })
      })
    )
    controller.abort()

    await expect(raceWithTimeout(iterator.next(), 100)).resolves.toEqual({ done: true, value: undefined })
    expect(sendCalls).toBe(0)
  })

  it('calls the Orchestrator.Interrupt contract for cancellation through the SDK', async () => {
    let capturedPayload: unknown
    const transport = new MockAuroraTransport()
    transport.register(ORCHESTRATOR_METHODS.interrupt, (request) => {
      capturedPayload = request.payload
      return {
        interrupt_id: 'interrupt-1',
        status: 'interrupted',
        requested_scopes: ['generation', 'session'],
        results: [],
        session_id: 'session-123',
        request_id: 'request-123',
        event_topic: 'Orchestrator.Interrupted',
        audit_event: 'orchestrator.interrupt.requested',
        idempotent: true,
        secrets_redacted: true
      }
    })
    const client = new AuroraClient({ transport })

    const result = await client.assistant.cancel({
      sessionId: 'session-123',
      requestId: 'request-123',
      scopes: ['generation', 'session']
    })

    expect(capturedPayload).toEqual({
      scopes: ['generation', 'session'],
      reason: 'user_interrupt',
      session_id: 'session-123',
      request_id: 'request-123'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected interrupt success')
    expect(result.data.status).toBe('interrupted')
  })

  it('sends text prompts through Orchestrator.ExternalUserInput and normalizes final responses', async () => {
    let capturedPayload: unknown
    const transport = new MockAuroraTransport()
    transport.register(ORCHESTRATOR_METHODS.externalUserInput, (request) => {
      capturedPayload = request.payload
      return {
        data: {
          text: 'Final assistant response',
          session_id: 'session-123',
          metadata: {
            model: 'llama-local',
            provider: 'local-orchestrator'
          }
        },
        status: 200,
        audit: {
          correlationId: 'corr-assistant-123'
        }
      }
    })

    const client = new AuroraClient({ transport })
    const result = await client.assistant.sendMessage({
      text: '  hello Aurora  ',
      sessionId: 'session-123',
      routePolicy: {
        providerId: 'local:orchestrator',
        privacyClass: 'personal',
        routeState: 'available-local'
      }
    })

    expect(capturedPayload).toEqual({
      text: 'hello Aurora',
      source: 'external',
      session_id: 'session-123'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected assistant send success')
    expect(result.data.sessionId).toBe('session-123')
    expect(result.data.response.text).toBe('Final assistant response')
    expect(result.data.modelLabel).toBe('llama-local')
    expect(result.data.routePolicy?.providerId).toBe('local:orchestrator')
    expect(result.audit.correlationId).toBe('corr-assistant-123')
  })

  it('maps assistant timeout, auth denied, and unavailable responses into SDK result failures', async () => {
    const timeoutClient = new AuroraClient({
      transport: MockAuroraTransport.empty().timeout(ORCHESTRATOR_METHODS.externalUserInput)
    })
    const authClient = new AuroraClient({
      transport: MockAuroraTransport.empty().fail(ORCHESTRATOR_METHODS.externalUserInput, 'auth', 'token expired')
    })
    const unavailableClient = new AuroraClient({
      transport: MockAuroraTransport.empty().fail(ORCHESTRATOR_METHODS.externalUserInput, 'unavailable_service', 'orchestrator unavailable')
    })

    const timeout = await timeoutClient.assistant.sendMessage({ text: 'hello' })
    const auth = await authClient.assistant.sendMessage({ text: 'hello' })
    const unavailable = await unavailableClient.assistant.sendMessage({ text: 'hello' })

    expect(timeout.ok).toBe(false)
    expect(auth.ok).toBe(false)
    expect(unavailable.ok).toBe(false)
    if (timeout.ok || auth.ok || unavailable.ok) throw new Error('expected assistant send failures')
    expect(timeout.error.code).toBe('timeout')
    expect(auth.error.code).toBe('auth')
    expect(unavailable.error.code).toBe('unavailable_service')
  })

  it('rejects empty assistant prompts before transport execution', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const result = await client.assistant.sendMessage({ text: '   ' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected empty prompt failure')
    expect(result.error).toBeInstanceOf(AuroraError)
    expect(result.error.code).toBe('validation')
  })
})

describe('AuroraClient memory namespace', () => {
  it('uses typed DB/RAG methods with provenance and policy responses', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const namespaces = await client.memory.listNamespaces({ include_remote: true, include_unavailable: true })
    const messages = await client.memory.listMessages({ limit: 2 })
    const search = await client.memory.search({
      namespace: 'peer-studio-gpu.memories',
      query: 'mesh pairing'
    })
    const denied = await client.memory.search({
      namespace: 'peer-denied.secret',
      query: 'secret'
    })

    expect(namespaces.ok).toBe(true)
    expect(namespaces.ok && namespaces.data.namespaces.some((namespace) => namespace.namespace === 'peer-studio-gpu.memories')).toBe(true)
    expect(messages.ok && messages.data.messages[0]?.content).toContain('mesh pairing')
    expect(search.ok && search.audit.method).toBe(DB_METHODS.ragSearchRemote)
    expect(search.ok && search.data.items[0]?.provenance.source_peer_id).toBe('peer-studio-gpu')
    expect(search.ok && search.data.items[0]?.redacted).toBe(true)
    expect(denied.ok && denied.data.decision).toBe('denied')
    expect(denied.ok && denied.data.denial_reason).toContain('denied')
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
        requiredBy: expect.arrayContaining([
          expect.objectContaining({
            method: 'ListPendingPairings',
            routePath: '/api/Auth/ListPendingPairings',
            source: 'backend_inventory'
          }),
          expect.objectContaining({
            method: 'list_peers',
            routePath: '/api/admin/peers',
            source: 'gateway_builtin'
          })
        ])
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

function pendingPairingFixture() {
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
    granted_is_admin: false
  }
}

describe('descriptors', () => {
  it('uses bus topic plus method name as identity source', () => {
    expect(describeRegistry(gatewayRegistryFixture).find((method) => method.busTopic === 'Gateway.GetRegistry')).toEqual(
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
      checked: 33,
      issues: []
    })

    const gatewayModule = gatewayRegistryFixture.modules.find((moduleInfo) => moduleInfo.module === 'Gateway')!

    const mismatched = compareRegistryFixtureToBackendInventory(
      {
        ...gatewayRegistryFixture,
        modules: [
          {
            ...gatewayModule,
            methods: [
              {
                ...gatewayModule.methods[0]!,
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

function adminDraftFixture(methodId: string) {
  const suffix = methodId.replace('.', '-')
  return {
    action_id: `aa-${suffix}`,
    nonce: `nonce-${suffix}`,
    digest: `digest-${suffix}`,
    method_id: methodId,
    affected_resources: ['admin.backups'],
    required_phrase: 'CONFIRM',
    required_reason: true,
    required_reauth: true,
    expires_at: '2026-06-25T12:05:00Z',
    expires_in_seconds: 300,
    confirmation_headers: {
      action_id: 'X-Aurora-AdminAction-Id',
      confirmation_token: 'X-Aurora-AdminAction-Token',
      digest: 'X-Aurora-AdminAction-Digest'
    }
  }
}

function adminConfirmFixture(actionId: string) {
  const suffix = actionId.replace('aa-', '')
  return {
    action_id: actionId,
    confirmation_token: `token-${suffix}`,
    digest: `digest-${suffix}`,
    confirmed: true,
    expires_at: '2026-06-25T12:05:00Z',
    audit_receipt: `audit-${suffix}`,
    confirmation_headers: {
      action_id: 'X-Aurora-AdminAction-Id',
      confirmation_token: 'X-Aurora-AdminAction-Token',
      digest: 'X-Aurora-AdminAction-Digest'
    }
  }
}

function backupImpactPlanFixture() {
  return {
    admin_critical: true,
    requires_quiesce: true,
    requires_restart: true,
    affected_services: [
      {
        service: 'Config',
        action: 'reload',
        required: true,
        reason: 'Config state changes require reload review.'
      },
      {
        service: 'DB',
        action: 'quiesce',
        required: true,
        reason: 'DB/RAG restore needs write quiesce.'
      }
    ],
    warnings: ['Destructive restore remains disabled by backend policy.']
  }
}
