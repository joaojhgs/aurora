// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  gatewayRegistryFixture,
} from '@aurora/client'
import { AppShell } from '../src/shell'
import {
  MeshPeersView,
  MeshServiceSharingResource,
  ServiceRoutingView,
  buildMeshPeersSnapshot,
  meshHomeServerConfigLocked,
  resolveSessionIsAdmin,
  type MeshPeersSnapshot,
  type ServiceRoutingSnapshot,
} from '../src/index'
import { PRODUCT_COPY } from '../src/product-copy'
import { getAuroraSurfaceProfile } from '../src/platform-surface'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import { snapshotFromGraph, type RouteAvailability } from '../src/shell-data'
import type { BrowserWebRtcSnapshot } from '../src/web-thin-runtime'
import type { LocalFeatureSharingPort } from '../src/local-feature-sharing'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('mesh member vs admin interactivity', () => {
  it('locks home-server sharing for remote-console members and keeps local-node sharing with the person on the device', () => {
    expect(meshHomeServerConfigLocked({ sessionIsAdmin: false, ownsLocalNodeState: false })).toBe(true)
    expect(meshHomeServerConfigLocked({ sessionIsAdmin: true, ownsLocalNodeState: false })).toBe(false)
    expect(meshHomeServerConfigLocked({ sessionIsAdmin: false, ownsLocalNodeState: true })).toBe(false)
    expect(resolveSessionIsAdmin(true)).toBe(true)
    expect(resolveSessionIsAdmin(false)).toBe(false)
    expect(resolveSessionIsAdmin(undefined)).toBe(false)
  })

  it('keeps Mesh in member navigation', () => {
    const snapshot = snapshotFromGraph(
      'http',
      buildCapabilityGraph({
        catalog: capabilityGraphCatalogFixture,
        registry: gatewayRegistryFixture,
        nativeManifest: null,
        transportKind: 'http',
      }),
      null,
    )
    const { container, unmount } = render(
      <AppShell snapshot={snapshot} currentPath="/mesh" sessionIsAdmin={false}>
        <main>Mesh page</main>
      </AppShell>,
    )
    expect(container.querySelector('[data-mobile-tab="mesh"]')).not.toBeNull()
    expect(container.textContent).toContain('Mesh')
    unmount()
  })

  it('shows peer scopes for a remote-console member but does not let them save, while reconnect stays usable', async () => {
    const snapshot = await approvedMeshSnapshot()
    const onSaveScopes = vi.fn()
    const onReconnect = vi.fn()
    const { container, unmount } = render(
      <MeshPeersView
        snapshot={snapshot}
        route={meshRoute()}
        sessionIsAdmin={false}
        ownsLocalNodeState={false}
        canManageLocalServiceConfiguration={false}
        onSaveScopes={onSaveScopes}
        onReconnectThinPeer={onReconnect}
        thinPeerSnapshot={offlineThinPeer()}
      />,
    )

    expect(container.textContent).toContain('All devices')
    expect(container.textContent).toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    expect(findForbiddenProductionCopyTerms(container.textContent ?? '')).toEqual([])
    const reconnect = findButton(container, 'Reconnect')
    expect(reconnect.disabled).toBe(false)
    await act(async () => reconnect.click())
    expect(onReconnect).toHaveBeenCalledTimes(1)

    const features = findButton(container, 'Features')
    expect(features.disabled).toBe(false)
    await act(async () => features.click())
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    expect(isControlDisabled(findButton(dialog ?? document.body, 'Save'))).toBe(true)
    const permissionToggle = dialog?.querySelector('[data-slot="switch"], [role="switch"]')
    expect(permissionToggle).not.toBeNull()
    expect(isControlDisabled(permissionToggle)).toBe(true)
    expect(onSaveScopes).not.toHaveBeenCalled()
    unmount()
  })

  it('lets an administrator change peer scopes on a remote console', async () => {
    const snapshot = await approvedMeshSnapshot()
    const onSaveScopes = vi.fn()
    const { container, unmount } = render(
      <MeshPeersView
        snapshot={snapshot}
        route={meshRoute()}
        sessionIsAdmin
        ownsLocalNodeState={false}
        canManageLocalServiceConfiguration={false}
        onSaveScopes={onSaveScopes}
      />,
    )

    expect(container.textContent).not.toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    await act(async () => findButton(container, 'Features').click())
    const dialog = document.body.querySelector('[role="dialog"]')
    const save = findButton(dialog ?? document.body, 'Save')
    expect(isControlDisabled(save)).toBe(false)
    await act(async () => save.click())
    expect(onSaveScopes).toHaveBeenCalled()
    unmount()
  })

  it('shows home-server service sharing for a member but disables every sharing control', async () => {
    const onSaveRow = vi.fn()
    const { container, unmount } = render(
      <ServiceRoutingView
        snapshot={sharingSnapshot()}
        adminLocked
        onPreviewRow={async () => ({
          valid: true,
          diffs: [],
          errors: [],
          baseRevision: 1,
          previewToken: 'token',
          changedPaths: [],
          secretsRedacted: true,
        })}
        onSaveRow={onSaveRow}
      />,
    )

    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    const share = container.querySelector('[aria-label="Share Text to speech from this device"]')
    expect(share).not.toBeNull()
    expect(isControlDisabled(share)).toBe(true)
    expect(isControlDisabled(container.querySelector('[aria-label="Where Aurora sends Text to speech requests"]'))).toBe(true)
    expect(isControlDisabled(container.querySelector('[aria-label="What Aurora does when Text to speech is unavailable"]'))).toBe(true)
    expect(isControlDisabled(findButton(container, 'Review changes'))).toBe(true)
    expect(onSaveRow).not.toHaveBeenCalled()
    unmount()
  })

  it('keeps home-server service sharing editable for an administrator', () => {
    const { container, unmount } = render(
      <ServiceRoutingView
        snapshot={sharingSnapshot()}
        adminLocked={false}
        onPreviewRow={async () => ({
          valid: true,
          diffs: [],
          errors: [],
          baseRevision: 1,
          previewToken: 'token',
          changedPaths: [],
          secretsRedacted: true,
        })}
        onSaveRow={() => undefined}
      />,
    )

    expect(container.textContent).not.toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    expect(isControlDisabled(container.querySelector('[aria-label="Share Text to speech from this device"]'))).toBe(false)
    expect(findButton(container, 'Review changes').disabled).toBe(true)
    unmount()
  })

  it('loads remote-console service sharing as visible and locked for members, editable for admins', async () => {
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      nodeMode: 'remote-console',
      transportKind: 'http',
    })
    const member = render(
      <MeshServiceSharingResource
        client={sharingClient()}
        route={meshRoute()}
        surface={surface}
        sessionIsAdmin={false}
      />,
    )
    await flush()
    expect(member.container.textContent).toContain('Service sharing')
    expect(member.container.textContent).toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    expect(isControlDisabled(member.container.querySelector('[aria-label="Share Text to speech from this device"]'))).toBe(true)
    member.unmount()

    const admin = render(
      <MeshServiceSharingResource
        client={sharingClient()}
        route={meshRoute()}
        surface={surface}
        sessionIsAdmin
      />,
    )
    await flush()
    expect(admin.container.textContent).not.toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    expect(isControlDisabled(admin.container.querySelector('[aria-label="Share Text to speech from this device"]'))).toBe(false)
    admin.unmount()
  })

  it('keeps this-device sharing editable for a mesh-node member', async () => {
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      nodeMode: 'mesh-node',
      transportKind: 'mesh',
    })
    const port: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [{
          id: 'Native.GetDeviceStatus',
          serviceId: 'tooling',
          servicePermissionId: 'Tooling.use',
          serviceLabel: 'Tools',
          serviceDescription: 'Use tools this device makes available.',
          label: 'Device status',
          description: 'Read device status.',
          enabled: true,
          available: true,
          requiresAuroraOpen: true,
          requiresLocalConfirmation: false,
        }],
        approvedDevices: [],
      })),
      subscribe: () => () => undefined,
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const { container, unmount } = render(
      <MeshServiceSharingResource
        client={sharingClient()}
        route={meshRoute()}
        surface={surface}
        localFeatureSharing={port}
        sessionIsAdmin={false}
      />,
    )
    await flush()
    expect(container.textContent).toContain('Service sharing')
    expect(container.textContent).toContain('Tools')
    expect(container.textContent).not.toContain(PRODUCT_COPY.mesh.adminSharingLocked)
    expect(isControlDisabled(container.querySelector('[aria-label="Share Tools from this device"]'))).toBe(false)
    unmount()
  })
})

function render(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return {
    container,
    unmount() {
      act(() => root.unmount())
      container.remove()
      document.body.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.remove())
    },
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function isControlDisabled(element: Element | null | undefined): boolean {
  if (!element) return false
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    return element.disabled
  }
  return element.hasAttribute('data-disabled') || element.getAttribute('aria-disabled') === 'true' || element.getAttribute('data-disabled') === 'true'
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button ${text} not found`)
  return button
}

function meshRoute(): RouteAvailability {
  return {
    item: {
      id: 'mesh',
      label: 'Mesh',
      href: '/mesh',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetMeshStatus',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'degraded',
      adminGated: false,
      expectedTask: 'MESH-001',
    },
    state: 'available-local',
    explanation: 'ready',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

async function approvedMeshSnapshot(): Promise<MeshPeersSnapshot> {
  const snapshot = await buildMeshPeersSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }), meshRoute())
  const approved = snapshot.peers.find((peer) => peer.outboundStatus === 'approved' && !peer.pendingPairing)
  if (!approved) throw new Error('approved mesh peer fixture is unavailable')
  return {
    ...snapshot,
    peers: [approved],
    mutationState: 'available-local',
  }
}

function offlineThinPeer(): BrowserWebRtcSnapshot {
  return {
    state: 'closed',
    connectionMode: 'webrtc-only',
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
    updatedAt: '2026-08-16T00:00:00Z',
    status: 'closed',
    nodeName: 'Home Aurora',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: true,
    persistenceBackend: 'platform-keychain',
  }
}

function sharingSnapshot(): ServiceRoutingSnapshot {
  return {
    loadState: 'ready',
    rows: [{
      id: 'tts',
      label: 'Text to speech',
      basePath: 'services.tts',
      sharingPath: 'services.tts.mesh_sharing',
      routingPath: 'services.tts.mesh_routing',
      registryStatus: 'healthy',
      registryVersion: '1.0.0',
      registered: true,
      exportPolicy: { share: true, maxConcurrent: 2, unsharedFeatureIds: [], unsharedMethodIds: [] },
      routingPolicy: { prefer: 'local', fallback: 'network', allowedProviderPeerIds: ['peer-studio'], minVersion: null, requiredProviderFeatureIds: [], requiredProviderCapabilityTags: [], requireExplicitSelector: false },
      exportFeatures: [],
      ungroupedMethods: [],
      staleMethodIds: [],
      providerOptions: [{ id: 'peer-studio', label: 'Studio Aurora', stale: false }],
      remoteFeatureOptions: [],
      remoteCapabilityTagOptions: [],
    }],
    knownPeers: [{ peerId: 'peer-studio', label: 'Studio Aurora' }],
    editable: true,
    registryMode: 'thread',
    warnings: [],
    error: null,
    evidenceSource: 'Aurora',
  }
}

function sharingClient() {
  const meshStatus = {
    local: { mesh_enabled: true, mesh_started: true, webrtc_started: true, peer_id: 'local', node_name: 'Local', peer_selection: 'latency', version_policy: 'compatible', shared_modules: [], routed_modules: [] },
    peers: [],
    routes: [],
    compatibility_failures: [],
    secrets_redacted: true,
  }
  const config = { tts: { mesh_sharing: { share: true, max_concurrent: 4, unshared_feature_ids: [], unshared_method_ids: [] }, mesh_routing: { prefer: 'network', fallback: 'local', allowed_provider_peer_ids: null, min_version: null, required_provider_feature_ids: [], required_provider_capability_tags: [], require_explicit_selector: false } } }
  const bases = [
    'services.orchestrator', 'services.db', 'services.tooling', 'services.scheduler',
    'services.tts', 'services.stt.coordinator', 'services.stt.wakeword', 'services.stt.transcription',
  ]
  const fields = bases.flatMap((base) => [
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
  return {
    registry: {
      getRegistry: async () => ({ modules: [{ module: 'TTS', version: '1', summary: 'TTS', capabilities: [], callable_features: [{ feature_id: 'speech', module: 'TTS', label: 'Speech synthesis', summary: 'Speech', method_ids: ['TTS.Synthesize'] }], methods: [{ name: 'Synthesize', summary: 'Speak', bus_topic: 'TTS.Synthesize', exposure: 'external', input_model: null, output_model: null, required_perms: ['TTS.use'], method_type: 'use' }] }], digest: 'r', service_count: 1, method_count: 1 }),
      listServices: async () => ({ services: [{ module: 'TTS', version: '1', summary: 'TTS', capabilities: [], callable_features: [], method_count: 1, last_seen: '', status: 'healthy', instance_id: 'tts-local' }], mode: 'thread', app_id: '', room: '', room_password: '' }),
    },
    config: {
      get: async () => ({ ok: true, data: { config, sources: {}, schema_version: '1', secrets_redacted: true, warnings: [] } }),
      getSchemaMetadata: async () => ({ ok: true, data: { fields, secrets_redacted: true } }),
    },
    capabilities: {
      listCatalog: async () => ({ generated_at: '', local_peer_id: 'local', local_node_name: 'Local', providers: [], actions: [] }),
    },
    requestResult: async (method: string) => method === 'Gateway.GetMeshStatus'
      ? { ok: true, data: meshStatus }
      : { ok: true, data: { peers: [] } },
  } as never
}
