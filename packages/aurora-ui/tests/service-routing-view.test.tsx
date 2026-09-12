// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient, MeshStatusResponse } from '@aurora/client'
import {
  LocalServiceRoutingResource,
  MeshServiceSharingResource,
  ServiceRoutingView,
  buildLocalServiceRoutingSnapshot,
  buildNodeServiceRoutingSnapshot,
  buildServiceRoutingSnapshot,
  commitServiceRoutingChanges,
  previewServiceRoutingChanges,
  reconcileServiceRoutingWithThinPeer,
  SERVICE_ROUTING_SNAPSHOT_TIMEOUT_MS,
  serviceRoutingDraftChanges,
  serviceRoutingDraftFromRow,
  serviceRoutingProviderMode,
  validMaxConcurrency,
  type ServiceRoutingRow,
  type ServiceRoutingPreviewEvidence,
  type ServiceRoutingSnapshot,
} from '../src/service-routing-view'
import { getAuroraSurfaceProfile } from '../src/platform-surface'
import type {
  LocalFeatureSharingPort,
  LocalFeatureSharingSnapshot,
} from '../src/local-feature-sharing'
import type { RouteAvailability } from '../src/shell-data'
import type {
  BrowserWebRtcPeerController,
  BrowserWebRtcSnapshot,
} from '../src/web-thin-runtime'

const TARGET_BASES = [
  'services.orchestrator', 'services.db', 'services.tooling', 'services.scheduler',
  'services.tts', 'services.stt.coordinator', 'services.stt.wakeword', 'services.stt.transcription',
]

function route(): RouteAvailability {
  return {
    item: { id: 'mesh', label: 'Mesh', href: '/mesh', capabilityModule: 'Gateway', capabilityMethod: 'GetMeshStatus', methodType: 'use', privacyClass: 'credential', fallbackState: 'unsupported', adminGated: false, expectedTask: 'MESH-001' },
    state: 'available-local', explanation: 'available', providerLabel: 'local', blockers: [], repairActions: [], candidateProviders: [], evidenceSources: [], selectorRequired: false, approvalRequired: false, routeable: true, disabled: false, requiresAdminAction: false,
  }
}

function row(overrides: Partial<ServiceRoutingRow> = {}): ServiceRoutingRow {
  return {
    id: 'tts', label: 'Text to speech', basePath: 'services.tts', sharingPath: 'services.tts.mesh_sharing', routingPath: 'services.tts.mesh_routing',
    registryStatus: 'healthy', registryVersion: '1.0.0', registered: true,
    exportPolicy: { share: true, maxConcurrent: 4, unsharedFeatureIds: [], unsharedMethodIds: ['TTS.Removed'] },
    routingPolicy: { prefer: 'network', fallback: 'local', allowedProviderPeerIds: null, minVersion: null, requiredProviderFeatureIds: [], requiredProviderCapabilityTags: [], requireExplicitSelector: false },
    exportFeatures: [{ featureId: 'speech', label: 'Speech synthesis', summary: 'Synthesize speech.', stale: false, methods: [{ topic: 'TTS.Synthesize', label: 'Synthesize', summary: 'Speak text.' }] }],
    ungroupedMethods: [{ topic: 'TTS.Ping', label: 'Ping', summary: 'Check TTS.' }],
    staleMethodIds: ['TTS.Removed'],
    providerOptions: [{ id: 'peer-provider', label: 'Studio node', stale: false }],
    remoteFeatureOptions: [{ id: 'speech', label: 'Speech synthesis', stale: false }],
    remoteCapabilityTagOptions: [{ id: 'gpu_accelerated', label: 'gpu_accelerated', stale: false }],
    ...overrides,
  }
}

function snapshot(testRow = row()): ServiceRoutingSnapshot {
  return { loadState: 'ready', rows: [testRow], knownPeers: [{ peerId: 'peer-provider', label: 'Studio node' }], editable: true, registryMode: 'thread', warnings: [], error: null, evidenceSource: 'test' }
}

function previewEvidence(overrides: Partial<ServiceRoutingPreviewEvidence> = {}): ServiceRoutingPreviewEvidence {
  return {
    valid: true,
    diffs: [{ key_path: 'services.tts.mesh_sharing.share', old_value: true, new_value: false, changed: true, source_layer: 'user', secret: false, reload_required: true, restart_required: false, affected_services: ['Tooling'] }],
    errors: [],
    baseRevision: 7,
    previewToken: 'preview-7',
    changedPaths: ['services.tts.mesh_sharing.share'],
    secretsRedacted: true,
    ...overrides,
  }
}

function localSharingSnapshot(): LocalFeatureSharingSnapshot {
  const service = {
    serviceId: 'tooling',
    servicePermissionId: 'Tooling.use',
    serviceLabel: 'Tools',
    serviceDescription: 'Use tools this device makes available.',
  } as const
  return {
    features: [
      { ...service, id: 'Native.GetDeviceStatus', label: 'Device status', description: 'Read device status.', enabled: true, available: true, requiresAuroraOpen: true, requiresLocalConfirmation: false },
      { ...service, id: 'Native.StartVoice', label: 'Voice capture', description: 'Start voice capture.', enabled: true, available: true, requiresAuroraOpen: true, requiresLocalConfirmation: true },
      { ...service, id: 'Native.Unavailable', label: 'Unavailable', description: 'Unavailable here.', enabled: false, available: false, requiresAuroraOpen: true, requiresLocalConfirmation: true },
    ],
    approvedDevices: [{ peerId: 'peer-home', peerLabel: 'Home Aurora', featureIds: ['Native.GetDeviceStatus'], expiresAtMs: null }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function browserPeerSnapshot(
  overrides: Partial<BrowserWebRtcSnapshot> = {},
): BrowserWebRtcSnapshot {
  return {
    state: 'closed',
    connectionMode: 'webrtc-only',
    expectedStablePeerId: 'peer-provider',
    nodeName: 'Studio node',
    icePathCategory: 'unknown',
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0,
    sentFragmentCount: 0,
    receivedFragmentCount: 0,
    updatedAt: '2026-07-28T00:00:00Z',
    status: 'closed',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: true,
    persistenceBackend: 'platform-keychain',
    ...overrides,
  }
}

function mutableBrowserPeer(initial: BrowserWebRtcSnapshot) {
  let current = initial
  const listeners = new Set<(snapshot: BrowserWebRtcSnapshot) => void>()
  const peer = {
    snapshot: () => current,
    subscribe: (listener: (snapshot: BrowserWebRtcSnapshot) => void) => {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
  } as unknown as BrowserWebRtcPeerController
  return {
    peer,
    emit(next: BrowserWebRtcSnapshot) {
      current = next
      for (const listener of listeners) listener(current)
    },
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text)!
}

function metadataFields() {
  return TARGET_BASES.flatMap((base) => [
    { key_path: `${base}.mesh_sharing.share`, default: false },
    { key_path: `${base}.mesh_sharing.max_concurrent`, default: 10 },
    { key_path: `${base}.mesh_sharing.unshared_feature_ids`, default: [] },
    { key_path: `${base}.mesh_sharing.unshared_method_ids`, default: [] },
    { key_path: `${base}.mesh_routing.prefer`, default: 'local' },
    { key_path: `${base}.mesh_routing.fallback`, default: 'local' },
    { key_path: `${base}.mesh_routing.allowed_provider_peer_ids`, default: null },
    { key_path: `${base}.mesh_routing.min_version`, default: null },
    { key_path: `${base}.mesh_routing.required_provider_feature_ids`, default: [] },
    { key_path: `${base}.mesh_routing.required_provider_capability_tags`, default: [] },
    { key_path: `${base}.mesh_routing.require_explicit_selector`, default: false },
  ])
}

function snapshotClient(metadata = metadataFields()): AuroraClient {
  const meshStatus: MeshStatusResponse = {
    local: { mesh_enabled: true, mesh_started: true, webrtc_started: true, peer_id: 'local', node_name: 'Local', peer_selection: 'latency', version_policy: 'compatible', shared_modules: [], routed_modules: [] },
    peers: [
      { peer_id: 'peer-provider', node_name: 'Studio node', status: 'negotiated', latency_ms: 2, last_ping_age_s: 1, last_manifest_age_s: 1, active_calls: 0, services: [{ module: 'TTS', version: '1', capabilities: ['gpu_accelerated'], method_names: ['Synthesize'], max_concurrent: 2, active_calls: 0, available_capacity: 2, digest: 'd' }], compatibility: { local_compatible: [], local_incompatible: [], local_unused: [], remote_compatible: [], remote_incompatible: [], remote_unused: [] } },
      { peer_id: 'peer-not-provider', node_name: 'Kitchen node', status: 'negotiated', latency_ms: 3, last_ping_age_s: 1, last_manifest_age_s: 1, active_calls: 0, services: [], compatibility: { local_compatible: [], local_incompatible: [], local_unused: [], remote_compatible: [], remote_incompatible: [], remote_unused: [] } },
    ],
    routes: [], compatibility_failures: [], secrets_redacted: true,
  }
  const config = { tts: { mesh_sharing: { share: true, max_concurrent: 4, unshared_feature_ids: [], unshared_method_ids: ['TTS.Removed'] }, mesh_routing: { prefer: 'network', fallback: 'local', allowed_provider_peer_ids: ['peer-stale'], min_version: null, required_provider_feature_ids: ['removed_feature'], required_provider_capability_tags: ['removed_tag'], require_explicit_selector: false } } }
  return {
    registry: {
      getRegistry: async () => ({ modules: [{ module: 'TTS', version: '1', summary: 'TTS', capabilities: ['local_only_tag'], callable_features: [{ feature_id: 'speech', module: 'TTS', label: 'Speech synthesis', summary: 'Speech', method_ids: ['TTS.Synthesize'] }], methods: [{ name: 'Synthesize', summary: 'Speak', bus_topic: 'TTS.Synthesize', exposure: 'external', input_model: null, output_model: null, required_perms: ['TTS.use'], method_type: 'use' }, { name: 'Ping', summary: 'Check', bus_topic: 'TTS.Ping', exposure: 'both', input_model: null, output_model: null, required_perms: ['TTS.use'], method_type: 'use' }, { name: 'Internal', summary: 'No', bus_topic: 'TTS.Internal', exposure: 'internal', input_model: null, output_model: null, required_perms: ['TTS.manage'], method_type: 'manage' }] }], digest: 'r', service_count: 1, method_count: 3 }),
      listServices: async () => ({ services: [{ module: 'TTS', version: '1', summary: 'TTS', capabilities: ['local_only_tag'], callable_features: [], method_count: 2, last_seen: '', status: 'healthy', instance_id: 'tts-local' }], mode: 'thread', app_id: '', room: '', room_password: '' }),
    },
    config: {
      get: async () => ({ ok: true, data: { config, sources: {}, schema_version: '1', secrets_redacted: true, warnings: [] } }),
      getSchemaMetadata: async () => ({ ok: true, data: { fields: metadata, secrets_redacted: true } }),
    },
    capabilities: {
      listCatalog: async () => ({ generated_at: '', local_peer_id: 'local', local_node_name: 'Local', providers: [{ provider_id: 'remote:TTS', peer_id: 'peer-provider', provider_kind: 'remote', node_name: 'Studio node', status: 'negotiated', service_instance_id: 'tts-remote', module: 'TTS', version: '1', latency_ms: 2, max_concurrent: 2, active_calls: 0, available_capacity: 2, eligible: true, reason_code: 'eligible', reason: '', policy: {} as never, freshness: {} as never }], actions: [{ action_id: 'tts-speech', module: 'TTS', method: 'Synthesize', topic: 'TTS.Synthesize', callable_feature_ids: ['speech'], callable_features: [{ feature_id: 'speech', module: 'TTS', label: 'Speech synthesis', summary: 'Speech', method_ids: ['TTS.Synthesize'] }], tool_id: null, resource_id: null, provider_id: 'remote:TTS', peer_id: 'peer-provider', provider_kind: 'remote', service_instance_id: 'tts-remote', selector: {}, bindability: 'available', sdk_operation_kind: 'bus_method', route_hints: [], route_blockers: [], summary: '', input_schema: null, output_schema: null, policy: {} as never, freshness: {} as never }], resources: [], provider_index: {}, action_index: {}, secrets_redacted: true }),
    },
    requestResult: async (method: string) => method === 'Gateway.GetMeshStatus'
      ? { ok: true, data: meshStatus }
      : { ok: true, data: { peers: [{ peer_id: 'peer-provider', node_name: 'Studio node' }, { peer_id: 'peer-not-provider', node_name: 'Kitchen node' }] } },
  } as unknown as AuroraClient
}

describe('Service sharing and outbound routing', () => {
  it('projects only actually available local services into the canonical sharing table', () => {
    const local = buildLocalServiceRoutingSnapshot(localSharingSnapshot())
    expect(local.rows.map((candidate) => candidate.label)).toEqual(['Tools'])
    expect(local.rows[0]?.exportPolicy.share).toBe(true)
    expect(local.knownPeers).toEqual([{ peerId: 'peer-home', label: 'Home Aurora' }])
    expect(JSON.stringify(local)).not.toContain('Orchestrator')
    expect(JSON.stringify(local)).not.toContain('Gateway')
    expect(JSON.stringify(local)).not.toContain('Native.Unavailable')
  })

  it('keeps node service sharing limited to services this device can share', async () => {
    const connected = await buildServiceRoutingSnapshot(snapshotClient(), route())
    const node = buildNodeServiceRoutingSnapshot(localSharingSnapshot(), connected)

    expect(node.rows.map((candidate) => candidate.id)).toEqual(['tooling'])
    expect(node.rows.find((candidate) => candidate.id === 'tooling')).toMatchObject({
      sharingEditable: true,
      sharingDetailsEditable: false,
      routingEditable: false,
      exportPolicy: { share: true },
    })
    expect(JSON.stringify(node)).not.toMatch(/Text to speech|STT coordinator|STT transcription/iu)
  })

  it('shows the sharing table for a remote console instead of omitting it', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      nodeMode: 'remote-console',
      transportKind: 'http',
    })
    expect(surface.ownsLocalNodeState).toBe(false)
    expect(surface.canManageLocalServiceConfiguration).toBe(false)

    await act(async () => {
      root.render(
        <MeshServiceSharingResource
          client={snapshotClient()}
          route={route()}
          surface={surface}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain('Text to speech')
    expect(container.querySelector('[aria-label="Share Text to speech from this device"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Where Aurora sends Text to speech requests"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps lightweight mesh-node sharing on the same table', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      nodeMode: 'mesh-node',
      transportKind: 'mesh',
    })
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      subscribe: () => () => undefined,
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }

    await act(async () => {
      root.render(
        <MeshServiceSharingResource
          client={snapshotClient()}
          route={route()}
          surface={surface}
          localFeatureSharing={port}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain('Tools')
    expect(container.textContent).not.toContain('Text to speech')
    expect(container.textContent).not.toContain('STT coordinator')
    expect(container.textContent).not.toContain('STT transcription')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps desktop-local node mode on the local shareable-service projection', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      nodeMode: 'mesh-node',
      transportKind: 'tauri-local',
      runtimeTier: 'python-full',
    })
    expect(surface.canManageLocalServiceConfiguration).toBe(true)
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      subscribe: () => () => undefined,
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }

    await act(async () => {
      root.render(
        <MeshServiceSharingResource
          client={snapshotClient()}
          route={route()}
          surface={surface}
          localFeatureSharing={port}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Text to speech')
    expect(container.textContent).not.toContain('STT coordinator')
    await act(async () => root.unmount())
  })

  it('shows an honest empty state when this device has nothing to share', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <ServiceRoutingView
          snapshot={{
            loadState: 'ready',
            rows: [],
            knownPeers: [],
            editable: false,
            registryMode: null,
            warnings: [],
            error: null,
            evidenceSource: 'test',
          }}
        />,
      )
    })
    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain('This device has nothing to share yet.')
    await act(async () => root.unmount())
  })

  it('keeps a reviewed change ready across status-only service refreshes', async () => {
    const onPreviewRow = vi.fn(async () => previewEvidence())
    const onSaveRow = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    const initialSnapshot = snapshot()

    await act(async () => {
      root.render(
        <ServiceRoutingView
          snapshot={initialSnapshot}
          onPreviewRow={onPreviewRow}
          onSaveRow={onSaveRow}
        />,
      )
    })

    const table = container.querySelector('table')!
    await act(async () => {
      table.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')?.click()
      buttonByText(table, 'Review changes').click()
      await Promise.resolve()
    })
    const approval = Array.from(table.querySelectorAll<HTMLElement>('[role="checkbox"]'))
      .find((checkbox) => checkbox.parentElement?.textContent?.includes('I approve these changes for this session'))!
    await act(async () => approval.click())

    await act(async () => {
      root.render(
        <ServiceRoutingView
          snapshot={{
            ...initialSnapshot,
            knownPeers: [{ peerId: 'peer-provider', label: 'Renamed studio node' }],
            rows: initialSnapshot.rows.map((candidate) => ({
              ...candidate,
              registryStatus: 'degraded',
              registryVersion: '1.0.1',
              providerOptions: candidate.providerOptions.map((option) => ({
                ...option,
                label: 'Renamed studio node',
                stale: true,
              })),
            })),
          }}
          onPreviewRow={onPreviewRow}
          onSaveRow={onSaveRow}
        />,
      )
    })

    const refreshedTable = container.querySelector('table')!
    expect(refreshedTable.querySelector('[role="region"]')?.textContent).toContain('Ready to save')
    await act(async () => buttonByText(refreshedTable, 'Save changes').click())
    expect(onSaveRow).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
  })

  it('does not wait for a connected routing baseline before enabling local service edits', async () => {
    const connectedRegistry = deferred<Awaited<ReturnType<AuroraClient['registry']['getRegistry']>>>()
    const baseClient = snapshotClient()
    const registryResult = await baseClient.registry.getRegistry()
    const client = {
      ...baseClient,
      registry: {
        ...baseClient.registry,
        getRegistry: vi.fn(() => connectedRegistry.promise),
      },
    } as unknown as AuroraClient
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      subscribe: (listener) => {
        listener(localSharingSnapshot())
        return () => undefined
      },
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <LocalServiceRoutingResource
          featureSharing={port}
          client={client}
          route={route()}
        />,
      )
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    expect(client.registry.getRegistry).not.toHaveBeenCalled()

    await act(async () => {
      connectedRegistry.resolve(registryResult)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Text to speech')
    await act(async () => root.unmount())
  })

  it('keeps local sharing available when a peer becomes authorized', async () => {
    const connectedRegistry = deferred<Awaited<ReturnType<AuroraClient['registry']['getRegistry']>>>()
    const baseClient = snapshotClient()
    const registryResult = await baseClient.registry.getRegistry()
    const client = {
      ...baseClient,
      registry: {
        ...baseClient.registry,
        getRegistry: vi.fn(() => connectedRegistry.promise),
      },
    } as unknown as AuroraClient
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      subscribe: (listener) => {
        listener(localSharingSnapshot())
        return () => undefined
      },
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const thinPeer = mutableBrowserPeer(browserPeerSnapshot())
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <LocalServiceRoutingResource
          featureSharing={port}
          client={client}
          route={route()}
          thinPeer={thinPeer.peer}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()

    await act(async () => {
      thinPeer.emit(browserPeerSnapshot({ state: 'authorized', status: 'authorized' }))
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    expect(client.registry.getRegistry).not.toHaveBeenCalled()

    await act(async () => {
      connectedRegistry.resolve(registryResult)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Text to speech')
    await act(async () => root.unmount())
  })

  it('does not load connected service evidence for local node sharing', async () => {
    const connectedRegistry = deferred<Awaited<ReturnType<AuroraClient['registry']['getRegistry']>>>()
    const baseClient = snapshotClient()
    const client = {
      ...baseClient,
      registry: {
        ...baseClient.registry,
        getRegistry: vi.fn(() => connectedRegistry.promise),
      },
    } as unknown as AuroraClient
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      subscribe: (listener) => {
        listener(localSharingSnapshot())
        return () => undefined
      },
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const thinPeer = mutableBrowserPeer(browserPeerSnapshot({ state: 'authorized', status: 'authorized' }))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <LocalServiceRoutingResource
          featureSharing={port}
          client={client}
          route={route()}
          thinPeer={thinPeer.peer}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(client.registry.getRegistry).not.toHaveBeenCalled()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Needs attention')
    expect(container.textContent).not.toContain('Some service sharing details are temporarily unavailable.')
    expect(container.textContent).not.toMatch(/registry unavailable|config metadata|capability catalog/iu)
    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('does not let an older local load overwrite a newer sharing update', async () => {
    const staleLoad = deferred<LocalFeatureSharingSnapshot>()
    const current = localSharingSnapshot()
    const newer: LocalFeatureSharingSnapshot = {
      ...current,
      features: current.features.map((feature) => ({ ...feature, enabled: false })),
    }
    const port: LocalFeatureSharingPort = {
      load: vi.fn(() => staleLoad.promise),
      subscribe(listener) {
        listener(newer)
        return () => undefined
      },
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<LocalServiceRoutingResource featureSharing={port} />)
      await Promise.resolve()
    })

    const sharingSwitch = container.querySelector<HTMLElement>(
      '[aria-label="Share Tools from this device"]',
    )
    expect(sharingSwitch?.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      staleLoad.resolve(localSharingSnapshot())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sharingSwitch?.getAttribute('aria-checked')).toBe('false')
    await act(async () => root.unmount())
  })

  it('refreshes local node sharing without retrying the connected catalog', async () => {
    const retryConnectedRegistry = deferred<Awaited<ReturnType<AuroraClient['registry']['getRegistry']>>>()
    const baseClient = snapshotClient()
    const registryResult = await baseClient.registry.getRegistry()
    const client = {
      ...baseClient,
      registry: {
        ...baseClient.registry,
        getRegistry: vi.fn()
          .mockImplementationOnce(() => {
            throw new Error('connected registry unavailable')
          })
          .mockReturnValueOnce(retryConnectedRegistry.promise),
      },
    } as unknown as AuroraClient
    let localSharingListener: ((snapshot: LocalFeatureSharingSnapshot) => void) | null = null
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      subscribe: (listener) => {
        localSharingListener = listener
        listener(localSharingSnapshot())
        return () => { localSharingListener = null }
      },
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const thinPeer = mutableBrowserPeer(browserPeerSnapshot())
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <LocalServiceRoutingResource
          featureSharing={port}
          client={client}
          route={route()}
          thinPeer={thinPeer.peer}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()

    await act(async () => {
      thinPeer.emit(browserPeerSnapshot({ state: 'authorized', status: 'authorized' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()

    await act(async () => {
      localSharingListener?.(localSharingSnapshot())
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(buttonByText(container, 'Refresh').disabled).toBe(false)

    await act(async () => {
      buttonByText(container, 'Refresh').click()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    expect(client.registry.getRegistry).not.toHaveBeenCalled()

    await act(async () => {
      retryConnectedRegistry.resolve(registryResult)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading service sharing through Aurora')
    expect(container.querySelector('[aria-label="Share Tools from this device"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('reuses the service table for a lightweight node and changes every available local tool', async () => {
    const setFeatureEnabled = vi.fn(async () => undefined)
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      setFeatureEnabled,
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <LocalServiceRoutingResource
          featureSharing={port}
          client={snapshotClient()}
          route={route()}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain('Tools')
    expect(container.textContent).not.toContain('Text to speech')
    expect(container.querySelector('table')?.className).toContain('aui-service-sharing-table')

    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Share Tools from this device"]')?.click()
    })
    await act(async () => buttonByText(container, 'Review changes').click())
    const approval = Array.from(container.querySelectorAll<HTMLElement>('[role="checkbox"]'))
      .find((checkbox) => checkbox.parentElement?.textContent?.includes('I approve these changes for this session'))!
    await act(async () => approval.click())
    await act(async () => {
      buttonByText(container, 'Save changes').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setFeatureEnabled.mock.calls).toEqual([
      ['Native.GetDeviceStatus', false],
      ['Native.StartVoice', false],
    ])
    await act(async () => root.unmount())
  })

  it('reviews local node sharing without mutating connected routing', async () => {
    const setFeatureEnabled = vi.fn(async () => undefined)
    const previewDiff = vi.fn(async ({ changes }: { changes: Array<{ key_path: string; value: unknown }> }) => ({
      ok: true as const,
      data: {
        valid: true,
        diffs: changes.map((change) => ({
          key_path: change.key_path,
          old_value: false,
          new_value: change.value,
          changed: true,
          source_layer: 'user',
          secret: false,
          reload_required: false,
          restart_required: false,
          affected_services: ['Tooling'],
        })),
        errors: [],
        secrets_redacted: true,
        base_revision: 12,
        preview_token: 'connected-preview-12',
        changed_paths: changes.map((change) => change.key_path),
      },
    }))
    const commitChangeSet = vi.fn(async () => ({
      ok: true as const,
      data: {
        success: true,
        revision: 13,
        changed_paths: ['services.tooling.mesh_routing.require_explicit_selector'],
        reload_required: false,
        restart_required: false,
        error: null,
        error_code: null,
        secrets_redacted: true,
      },
    }))
    const baseClient = snapshotClient()
    const client = {
      ...baseClient,
      config: {
        ...baseClient.config,
        previewDiff,
        commitChangeSet,
      },
    } as unknown as AuroraClient
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => localSharingSnapshot()),
      setFeatureEnabled,
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <LocalServiceRoutingResource
          featureSharing={port}
          client={client}
          route={route()}
          sessionIsAdmin
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const toolsCard = Array.from(container.querySelectorAll<HTMLElement>('article'))
      .find((candidate) => candidate.querySelector('h3')?.textContent === 'Tools')!
    await act(async () => {
      toolsCard.querySelector<HTMLElement>('[aria-label="Share Tools from this device on mobile"]')?.click()
      buttonByText(toolsCard, 'Edit sharing').click()
    })
    expect(toolsCard.querySelector<HTMLInputElement>('input[type="number"]')?.disabled).toBe(true)
    const routingSwitch = Array.from(toolsCard.querySelectorAll<HTMLElement>('[role="switch"]'))
      .find((candidate) => candidate.parentElement?.textContent?.includes('Require device selection'))!
    await act(async () => routingSwitch.click())
    await act(async () => buttonByText(toolsCard, 'Review changes').click())
    await act(async () => Promise.resolve())

    expect(toolsCard.textContent).toContain('Review 1 change')
    expect(toolsCard.textContent).not.toContain('separately')
    const approval = Array.from(toolsCard.querySelectorAll<HTMLElement>('[role="checkbox"]'))
      .find((checkbox) => checkbox.parentElement?.textContent?.includes('I approve these changes for this session'))!
    await act(async () => approval.click())
    await act(async () => {
      buttonByText(toolsCard, 'Save changes').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(previewDiff).not.toHaveBeenCalled()
    expect(commitChangeSet).not.toHaveBeenCalled()
    expect(setFeatureEnabled.mock.calls).toEqual([
      ['Native.GetDeviceStatus', false],
      ['Native.StartVoice', false],
    ])
    await act(async () => root.unmount())
  })

  it('allows fragmented WebRTC registry snapshots to traverse native WebView IPC', () => {
    expect(SERVICE_ROUTING_SNAPSHOT_TIMEOUT_MS).toBe(60_000)
  })

  it('retains provider rows and suppresses expected transport errors while a configured peer is offline', () => {
    const previous = snapshot()
    const unavailable: ServiceRoutingSnapshot = {
      loadState: 'unavailable',
      rows: [],
      knownPeers: [],
      editable: false,
      registryMode: null,
      warnings: [
        'full service registry unavailable: WebRTC mesh transport is not connected',
        'recipient capability catalog unavailable: preferred-mode HTTP fallback is unavailable',
      ],
      error: 'Gateway routing capability is unavailable for this route.',
      evidenceSource: 'Aurora request error',
    }
    const thinPeer: BrowserWebRtcSnapshot = {
      state: 'closed',
      connectionMode: 'webrtc-only',
      expectedStablePeerId: 'peer-provider',
      nodeName: 'Studio node',
      icePathCategory: 'unknown',
      protocolCapabilities: [],
      reconnectCount: 1,
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      sentFragmentCount: 0,
      receivedFragmentCount: 0,
      updatedAt: '2026-07-28T00:00:00Z',
      status: 'failed',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    }

    const reconciled = reconcileServiceRoutingWithThinPeer(
      unavailable,
      thinPeer,
      previous,
    )

    expect(reconciled.loadState).toBe('degraded')
    expect(reconciled.rows).toEqual(previous.rows)
    expect(reconciled.knownPeers).toEqual(previous.knownPeers)
    expect(reconciled.editable).toBe(false)
    expect(reconciled.error).toBeNull()
    expect(reconciled.warnings).toEqual([])
    expect(reconciled.evidenceSource).toContain('refresh after reconnect')
  })

  it('preserves Any, None, and Selected provider values without coercion', () => {
    expect(serviceRoutingProviderMode(null)).toBe('any')
    expect(serviceRoutingProviderMode([])).toBe('none')
    expect(serviceRoutingProviderMode(['peer-a'])).toBe('selected')
    for (const [mode, initial, expected] of [['any', ['peer-old'], null], ['none', null, []], ['selected', null, ['peer-a']]] as const) {
      const source = row({ routingPolicy: { ...row().routingPolicy, allowedProviderPeerIds: initial ? [...initial] : null } })
      const draft = { ...serviceRoutingDraftFromRow(source), providerMode: mode, selectedProviderPeerIds: ['peer-a'] }
      expect(serviceRoutingDraftChanges(source, draft).find((change) => change.keyPath.endsWith('allowed_provider_peer_ids'))?.value).toEqual(expected)
    }
  })

  it('writes provider export and outbound routing to separate config blocks', () => {
    const draft = { ...serviceRoutingDraftFromRow(row()), share: false, unsharedFeatureIds: ['speech'], unsharedMethodIds: ['TTS.Synthesize'], requiredProviderFeatureIds: ['speech'], requiredProviderCapabilityTags: ['gpu_accelerated'], minVersion: '2.0.0' }
    const changes = serviceRoutingDraftChanges(row(), draft)
    expect(changes).toEqual(expect.arrayContaining([
      { keyPath: 'services.tts.mesh_sharing.share', value: false },
      { keyPath: 'services.tts.mesh_sharing.unshared_feature_ids', value: ['speech'] },
      { keyPath: 'services.tts.mesh_sharing.unshared_method_ids', value: ['TTS.Synthesize'] },
      { keyPath: 'services.tts.mesh_routing.required_provider_feature_ids', value: ['speech'] },
      { keyPath: 'services.tts.mesh_routing.required_provider_capability_tags', value: ['gpu_accelerated'] },
      { keyPath: 'services.tts.mesh_routing.min_version', value: '2.0.0' },
    ]))
    expect(JSON.stringify(changes)).not.toContain('allowed_peers')
  })

  it('uses recipient-projected providers/features and remote manifest tags while retaining stale configured IDs', async () => {
    const result = await buildServiceRoutingSnapshot(snapshotClient(), route())
    const tts = result.rows.find((candidate) => candidate.id === 'tts')!
    expect(result.editable).toBe(true)
    expect(tts.providerOptions).toEqual(expect.arrayContaining([
      { id: 'peer-provider', label: 'Studio node', stale: false },
      { id: 'peer-stale', label: 'peer-stale', stale: true },
    ]))
    expect(tts.providerOptions.some((option) => option.id === 'peer-not-provider')).toBe(false)
    expect(tts.remoteFeatureOptions).toEqual(expect.arrayContaining([{ id: 'speech', label: 'Speech synthesis', stale: false }, { id: 'removed_feature', label: 'removed_feature', stale: true }]))
    expect(tts.remoteCapabilityTagOptions).toEqual(expect.arrayContaining([{ id: 'gpu_accelerated', label: 'gpu_accelerated', stale: false }, { id: 'removed_tag', label: 'removed_tag', stale: true }]))
    expect(tts.remoteCapabilityTagOptions.some((option) => option.id === 'local_only_tag')).toBe(false)
    expect(tts.exportFeatures[0]?.methods.map((method) => method.topic)).toEqual(['TTS.Synthesize'])
    expect(tts.ungroupedMethods.map((method) => method.topic)).toEqual(['TTS.Ping'])
  })

  it('fails legacy metadata closed as degraded read-only', async () => {
    const result = await buildServiceRoutingSnapshot(snapshotClient([]), route())
    expect(result.editable).toBe(false)
    expect(result.loadState).toBe('degraded')
    expect(result.warnings.join(' ')).toContain('not ready for editing')
  })

  it('requires every editable metadata leaf and validates concurrency without coercion', async () => {
    const partial = metadataFields().filter((field) => !field.key_path.endsWith('mesh_routing.min_version'))
    const result = await buildServiceRoutingSnapshot(snapshotClient(partial), route())
    expect(result.editable).toBe(false)
    expect(validMaxConcurrency('0')).toBe(true)
    expect(validMaxConcurrency('12')).toBe(true)
    expect(validMaxConcurrency('-1')).toBe(false)
    expect(validMaxConcurrency('1.5')).toBe(false)
    const draft = { ...serviceRoutingDraftFromRow(row()), maxConcurrent: '-1', share: false }
    const changes = serviceRoutingDraftChanges(row(), draft)
    expect(changes).toContainEqual({ keyPath: 'services.tts.mesh_sharing.share', value: false })
    expect(changes.some((change) => change.keyPath.endsWith('max_concurrent'))).toBe(false)
  })

  it('previews once and commits the complete row change set exactly once', async () => {
    const previewDiff = vi.fn(async () => ({ ok: true, data: { valid: true, diffs: [], errors: [], secrets_redacted: true, base_revision: 7, preview_token: 'preview-7', changed_paths: [] } }))
    const commitChangeSet = vi.fn(async (_input: { request: unknown }) => ({ data: { success: true, revision: 8, changed_paths: [] } }))
    const client = { config: { previewDiff, commitChangeSet } } as unknown as AuroraClient
    const changes = [{ keyPath: 'services.tts.mesh_sharing.share', value: false }, { keyPath: 'services.tts.mesh_routing.prefer', value: 'network_only' }]
    const preview = await previewServiceRoutingChanges(client, changes)
    await commitServiceRoutingChanges(client, row(), changes, preview, { reauthConfirmed: true })
    expect(previewDiff).toHaveBeenCalledTimes(1)
    expect(commitChangeSet).toHaveBeenCalledTimes(1)
    expect(commitChangeSet.mock.calls[0]?.[0].request).toEqual({ changes: changes.map((change) => ({ key_path: change.keyPath, value: change.value })), base_revision: 7, preview_token: 'preview-7' })
  })

  it('does not commit without atomic preview evidence and explains conflicts', async () => {
    const commitChangeSet = vi.fn()
    const missing = { config: { commitChangeSet } } as unknown as AuroraClient
    await expect(commitServiceRoutingChanges(missing, row(), [{ keyPath: 'x', value: true }], previewEvidence(), { reauthConfirmed: false })).rejects.toThrow('Approve this save')
    await expect(commitServiceRoutingChanges(missing, row(), [{ keyPath: 'x', value: true }], previewEvidence({ baseRevision: null, previewToken: null }), { reauthConfirmed: true })).rejects.toThrow('could not confirm')
    expect(commitChangeSet).not.toHaveBeenCalled()
    const conflict = { config: { commitChangeSet: vi.fn(async () => ({ data: { success: false, changed_paths: [], error_code: 'config_revision_conflict' } })) } } as unknown as AuroraClient
    await expect(commitServiceRoutingChanges(conflict, row(), [{ keyPath: 'x', value: true }], previewEvidence(), { reauthConfirmed: true })).rejects.toThrow('Refresh and review')
  })

  it('renders unambiguous sharing/routing wording and no inbound peer gate copy', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={async () => previewEvidence()} onSaveRow={() => undefined} />))
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label*="Toggle service sharing"]')!
    await act(async () => toggle.click())
    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain('Shared from this device')
    expect(container.textContent).toContain('Send requests to devices')
    expect(container.textContent).toContain('Any approved device')
    expect(container.textContent).toContain('Selected devices')
    expect(container.textContent).toContain('This device only')
    expect(container.textContent).toContain('Sharing choices do not grant access')
    expect(container.textContent).not.toContain('Allowed peers')
    expect(container.textContent).not.toContain('Restrict which paired peers may call')
    expect(container.textContent).not.toContain('Evidence: test')
    expect(container.innerHTML).toContain('Mobile service policy cards')
    expect(container.textContent).toContain('Other callable methods')
    expect(container.textContent).toContain('TTS.Ping')
    expect(container.textContent).toContain('Remove exclusion')
    const selectedMode = container.querySelector<HTMLInputElement>('input[type="radio"][value="selected"]')!
    await act(async () => selectedMode.click())
    expect(container.textContent).toContain('Select at least one device, or choose Any approved device or This device only.')
    const reviewButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.textContent?.includes('Review changes'))
    expect(reviewButtons.length).toBeGreaterThan(0)
    expect(reviewButtons.every((button) => button.disabled)).toBe(true)
    await act(async () => root.unmount())
  })

  it('previews local paths before explicit confirmation and only then submits once', async () => {
    const onSaveRow = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    const onPreviewRow = vi.fn(async () => previewEvidence())
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={onPreviewRow} onSaveRow={onSaveRow} />))
    const share = container.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')!
    await act(async () => share.click())
    const review = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Review changes')!
    await act(async () => review.click())
    expect(onPreviewRow).toHaveBeenCalledTimes(1)
    expect(onSaveRow).not.toHaveBeenCalled()
    expect(container.textContent).toContain('No changes have been saved')
    expect(container.textContent).toContain('Device sharing')
    expect(container.textContent).not.toContain('services.tts.mesh_sharing.share')
    expect(container.textContent).toContain('Ready to save')
    expect(container.textContent).not.toContain('Base revision')
    expect(container.textContent).not.toContain('Preview token')
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Save changes')!
    expect(confirm.disabled).toBe(true)
    const unlock = Array.from(container.querySelectorAll<HTMLElement>('[role="checkbox"]')).find((checkbox) => checkbox.parentElement?.textContent?.includes('I approve these changes for this session'))!
    await act(async () => unlock.click())
    expect(confirm.disabled).toBe(false)
    await act(async () => confirm.click())
    expect(onSaveRow).toHaveBeenCalledTimes(1)
    expect(onSaveRow.mock.calls[0]?.[2]).toEqual(previewEvidence())
    expect(onSaveRow.mock.calls[0]?.[3]).toEqual({ reauthConfirmed: true })
    await act(async () => root.unmount())
  })

  it('invalidates authoritative preview and unlock attestation whenever the draft changes', async () => {
    const onSaveRow = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={async () => previewEvidence()} onSaveRow={onSaveRow} />))
    const share = container.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')!
    await act(async () => share.click())
    const review = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Review changes')!
    await act(async () => review.click())
    const unlock = Array.from(container.querySelectorAll<HTMLElement>('[role="checkbox"]')).find((checkbox) => checkbox.parentElement?.textContent?.includes('I approve these changes for this session'))!
    await act(async () => unlock.click())
    expect(container.textContent).toContain('Ready to save')
    await act(async () => share.click())
    expect(container.textContent).not.toContain('Ready to save')
    expect(container.textContent).not.toContain('I approve these changes for this session')
    expect(onSaveRow).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('disables every rendered mobile editor control in read-only state and shows mobile loading copy', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={async () => previewEvidence()} onSaveRow={() => undefined} />))
    const desktopToggle = container.querySelector<HTMLButtonElement>('button[aria-label*="Toggle service sharing"]')!
    await act(async () => desktopToggle.click())
    await act(async () => root.render(<ServiceRoutingView snapshot={{ ...snapshot(), editable: false }} onPreviewRow={async () => previewEvidence()} onSaveRow={() => undefined} />))
    const mobile = container.querySelector<HTMLElement>('[aria-label="Mobile service policy cards"]')!
    const nativeControls = Array.from(mobile.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input'))
    expect(nativeControls.length).toBeGreaterThan(5)
    expect(nativeControls.every((control) => control.disabled)).toBe(true)
    await act(async () => root.render(<ServiceRoutingView snapshot={{ ...snapshot(), loadState: 'loading', rows: [], editable: false }} onPreviewRow={async () => previewEvidence()} onSaveRow={() => undefined} />))
    expect(container.querySelector('[aria-label="Mobile service policy cards"]')?.textContent).toContain('Loading service sharing through Aurora')
    await act(async () => root.unmount())
  })

  it('ignores an older identical preview success after cancel and retry', async () => {
    const first = deferred<ServiceRoutingPreviewEvidence>()
    const second = deferred<ServiceRoutingPreviewEvidence>()
    const onPreviewRow = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={onPreviewRow} onSaveRow={() => undefined} />))
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')!.click())
    await act(async () => buttonByText(container, 'Review changes').click())
    await act(async () => buttonByText(container, 'Cancel').click())
    await act(async () => buttonByText(container, 'Review changes').click())
    await act(async () => second.resolve(previewEvidence({
      baseRevision: 22,
      previewToken: 'preview-22',
      diffs: [{ ...previewEvidence().diffs[0]!, key_path: 'services.tts.mesh_routing.prefer' }],
    })))
    expect(container.textContent).toContain('Preferred device')
    expect(container.textContent).not.toContain('services.tts.mesh_routing.prefer')
    await act(async () => first.resolve(previewEvidence({ baseRevision: 11, previewToken: 'preview-11' })))
    expect(container.textContent).toContain('Preferred device')
    expect(container.textContent).not.toContain('services.tts.mesh_routing.prefer')
    await act(async () => root.unmount())
  })

  it('ignores an older identical preview failure after a newer retry succeeds', async () => {
    const first = deferred<ServiceRoutingPreviewEvidence>()
    const second = deferred<ServiceRoutingPreviewEvidence>()
    const onPreviewRow = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={onPreviewRow} onSaveRow={() => undefined} />))
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')!.click())
    await act(async () => buttonByText(container, 'Review changes').click())
    await act(async () => buttonByText(container, 'Cancel').click())
    await act(async () => buttonByText(container, 'Review changes').click())
    await act(async () => second.resolve(previewEvidence({
      baseRevision: 33,
      previewToken: 'preview-33',
      diffs: [{ ...previewEvidence().diffs[0]!, key_path: 'services.tts.mesh_routing.prefer' }],
    })))
    await act(async () => first.reject(new Error('stale preview failure')))
    expect(container.textContent).toContain('Preferred device')
    expect(container.textContent).not.toContain('services.tts.mesh_routing.prefer')
    expect(container.textContent).not.toContain('stale preview failure')
    expect(container.textContent).not.toContain('Review failed')
    await act(async () => root.unmount())
  })

  it('keeps preview generations monotonic across a snapshot refresh', async () => {
    const first = deferred<ServiceRoutingPreviewEvidence>()
    const second = deferred<ServiceRoutingPreviewEvidence>()
    const onPreviewRow = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const onSaveRow = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ServiceRoutingView snapshot={snapshot()} onPreviewRow={onPreviewRow} onSaveRow={onSaveRow} />))
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')!.click())
    await act(async () => buttonByText(container, 'Review changes').click())

    await act(async () => root.render(<ServiceRoutingView snapshot={{
      ...snapshot(row({
        routingPolicy: {
          ...row().routingPolicy,
          fallback: 'error',
        },
      })),
      evidenceSource: 'refreshed test',
    }} onPreviewRow={onPreviewRow} onSaveRow={onSaveRow} />))
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Share Text to speech from this device"]')!.click())
    await act(async () => buttonByText(container, 'Review changes').click())

    await act(async () => first.resolve(previewEvidence({ baseRevision: 11, previewToken: 'preview-11' })))
    expect(container.textContent).toContain('Checking changes')
    expect(container.textContent).not.toContain('Ready to save')
    await act(async () => second.resolve(previewEvidence({
      baseRevision: 22,
      previewToken: 'preview-22',
      diffs: [{ ...previewEvidence().diffs[0]!, key_path: 'services.tts.mesh_routing.prefer' }],
    })))
    expect(container.textContent).toContain('Preferred device')
    expect(container.textContent).not.toContain('services.tts.mesh_routing.prefer')
    expect(onSaveRow).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})
