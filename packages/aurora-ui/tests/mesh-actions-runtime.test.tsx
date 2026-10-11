// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import {
  BrowserWebRtcPeerController,
  getAuroraSurfaceProfile,
  type LocalFeatureSharingPort,
  MeshPeersResource,
  type BrowserWebRtcSnapshot,
} from '../src/index'

const roots: Root[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function meshRoute() {
  return {
    item: {
      id: 'mesh', label: 'Mesh', href: '/mesh', capabilityModule: 'Gateway',
      capabilityMethod: 'GetMeshStatus', methodType: 'use', privacyClass: 'credential',
      fallbackState: 'unsupported', adminGated: false, expectedTask: 'MESH-001',
    },
    state: 'available-local', explanation: 'Mesh is available.', providerLabel: 'local',
    blockers: [], repairActions: [], candidateProviders: [], evidenceSources: ['capability-catalog'],
    selectorRequired: false, approvalRequired: false, routeable: true, disabled: false,
    requiresAdminAction: false,
  } as never
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button ${text} not found`)
  return button
}

function meshTransport(): MockAuroraTransport {
  const transport = new MockAuroraTransport()
  transport.register('Auth.ListPendingPairings', () => ({
    pairings: [{
      request_id: 'mesh-pairing-peer-kitchen',
      code: 'mesh-pairing-secret',
      verification_code: '12345678',
      device_name: 'Kitchen tablet',
      client_ip: '192.0.2.42',
      status: 'pending',
      expires_at: '2026-09-19T00:00:00Z',
      created_at: '2026-09-18T00:00:00Z',
      remote_peer_id: 'peer-kitchen',
      remote_node_name: 'Kitchen node',
      approved_by: null,
      denied_by: null,
      denied_reason: '',
      granted_permissions: ['Gateway.use'],
      granted_is_admin: false,
    }],
    total: 1,
    expired_count: 0,
    secrets_redacted: true,
  }))
  return transport
}

function findPeerButton(container: ParentNode, peerName: string, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .filter((candidate) => candidate.textContent?.includes(label))
    .find((candidate) => candidate.closest('[data-slot="card"]')?.textContent?.includes(peerName) ?? false)
  if (!button) throw new Error(`${label} button for ${peerName} not found`)
  return button
}

type AdminExecuteSpy = MockInstance<
  (input: Parameters<Aurora['admin']['execute']>[0]) => Promise<unknown>
>

function mutationCalls(execute: AdminExecuteSpy, methodId: string) {
  return execute.mock.calls.filter(([request]) => request?.methodId === methodId)
}

function renderResource(
  client: Aurora,
  thinPeer?: BrowserWebRtcPeerController,
  options: {
    surfaceProfile?: ReturnType<typeof getAuroraSurfaceProfile>
    localFeatureSharing?: LocalFeatureSharingPort
    localNode?: { readonly peerId: string; readonly nodeName: string }
  } = {},
): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <MeshPeersResource
        client={client}
        route={meshRoute()}
        surfaceProfile={options.surfaceProfile ?? getAuroraSurfaceProfile({ runtimeMode: 'web-thin', transportKind: 'http', nodeMode: 'remote-console' })}
        sessionIsAdmin
        {...(thinPeer ? { thinPeer } : {})}
        {...(options.localFeatureSharing ? { localFeatureSharing: options.localFeatureSharing } : {})}
        {...(options.localNode ? { localNode: options.localNode } : {})}
      />,
    )
  })
  return container
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function connectedThinPeer(
  peerId = 'peer-studio-gpu',
  snapshotOverrides: Partial<BrowserWebRtcSnapshot> = {},
): BrowserWebRtcPeerController {
  const peer = new BrowserWebRtcPeerController(null, 'webrtc-only', { httpFallback: false })
  const snapshot: BrowserWebRtcSnapshot = {
    state: 'authorized', connectionMode: 'webrtc-only', expectedStablePeerId: peerId,
    nodeName: 'Studio GPU', icePathCategory: 'host', protocolCapabilities: [], reconnectCount: 0,
    pendingCallCount: 0, pendingStreamCount: 0, pendingSubscriptionCount: 0, pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0, sentFragmentCount: 0, receivedFragmentCount: 0,
    updatedAt: '2026-09-18T00:00:00.000Z', status: 'authorized', secureContext: true,
    visible: true, focused: true, hasHttpFallback: false, secretsPersisted: true,
    ...snapshotOverrides,
  }
  vi.spyOn(peer, 'snapshot').mockReturnValue(snapshot)
  vi.spyOn(peer, 'roster').mockReturnValue(null)
  return peer
}

describe('mesh action controls', () => {
  it('runs approval through MeshPeersResource and suppresses duplicate review actions', async () => {
    const client = new Aurora({ transport: meshTransport() })
    let release!: () => void
    const execute = vi.spyOn(client.admin, 'execute').mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({} as never) }),
    )
    const container = renderResource(client)
    await flushReactWork()
    await vi.waitFor(() => expect(findButton(container, 'Review & approve')).toBeTruthy())

    await act(async () => { findButton(container, 'Review & approve').click() })
    const approve = findButton(document.body, 'Approve & pair')
    await act(async () => {
      approve.click()
      approve.click()
      await Promise.resolve()
    })

    expect(mutationCalls(execute, 'Auth.PairingApprove')).toHaveLength(1)
    expect(approve.disabled).toBe(true)
    release()
    await flushReactWork()
    expect(findButton(document.body, 'Approve & pair').disabled).toBe(false)
  })

  it('runs scope saving through the resource and exposes production failure cleanup', async () => {
    const client = new Aurora({ transport: meshTransport() })
    const execute = vi.spyOn(client.admin, 'execute').mockRejectedValue(new Error('scope update rejected'))
    const container = renderResource(client)
    await flushReactWork()
    await vi.waitFor(() => expect(findButton(container, 'Features')).toBeTruthy())

    await act(async () => { findButton(container, 'Features').click() })
    const toggle = document.body.querySelector<HTMLButtonElement>('[aria-label^="Toggle "]')
    expect(toggle).not.toBeNull()
    await act(async () => { toggle?.click() })
    const save = findButton(document.body, 'Save')
    await act(async () => { save.click(); await Promise.resolve() })

    expect(mutationCalls(execute, 'Auth.MeshUpdatePeerPermissions')).toHaveLength(1)
    expect(document.body.textContent).toContain('Device change was not saved')
    expect(findButton(document.body, 'Save').disabled).toBe(false)
  })

  it('persists only currently available local service features for a node-owned peer', async () => {
    const client = new Aurora({ transport: meshTransport() })
    const execute = vi.spyOn(client.admin, 'execute').mockResolvedValue({} as never)
    let availableFeatureEnabled = false
    const availableFeature = {
      serviceId: 'tooling',
      servicePermissionId: 'Tooling.use',
      serviceLabel: 'Tools',
      serviceDescription: 'Use tools this device makes available.',
      id: 'feature-available',
      label: 'Available feature',
      description: 'An available local feature.',
      enabled: false,
      available: true,
      requiresAuroraOpen: true,
      requiresLocalConfirmation: false,
    }
    const localFeatureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [
          { ...availableFeature, enabled: availableFeatureEnabled },
          { ...availableFeature, id: 'feature-unavailable', label: 'Unavailable feature', available: false },
        ],
        approvedDevices: [{
          peerId: 'peer-studio-gpu',
          peerLabel: 'Studio GPU',
          featureIds: [],
          expiresAtMs: 1_800_000_000_000,
        }],
      })),
      setFeatureEnabled: vi.fn(async (featureId, enabled) => {
        if (featureId === 'feature-available') availableFeatureEnabled = enabled
      }),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const thinPeer = connectedThinPeer()
    const container = renderResource(client, thinPeer, {
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'mobile-native',
        transportKind: 'native-mobile',
        nativePlatform: 'android',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
      }),
      localFeatureSharing,
      localNode: { peerId: 'peer-waydroid', nodeName: 'Waydroid' },
    })
    await flushReactWork()

    await act(async () => { findButton(container, 'Features').click() })
    const toggle = document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Tools"]')
    expect(toggle).not.toBeNull()
    await act(async () => { toggle?.click() })
    await act(async () => { findButton(document.body, 'Save').click(); await Promise.resolve() })
    await flushReactWork()

    expect(localFeatureSharing.setFeatureEnabled).toHaveBeenCalledOnce()
    expect(localFeatureSharing.setFeatureEnabled).toHaveBeenCalledWith('feature-available', true)
    expect(vi.mocked(localFeatureSharing.replacePeerSharing).mock.calls).toEqual([[
      'peer-studio-gpu',
      ['feature-available'],
      1_800_000_000_000,
    ]])
    expect(mutationCalls(execute, 'Auth.MeshUpdatePeerPermissions')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Unavailable feature')
  })

  it('retries thin pairing through the resource after the controller rejects once', async () => {
    const client = new Aurora({ transport: meshTransport() })
    const availableFeature = {
      serviceId: 'tooling',
      servicePermissionId: 'Tooling.use',
      serviceLabel: 'Tools',
      serviceDescription: 'Use tools this device makes available.',
      id: 'feature-available',
      label: 'Available feature',
      description: 'An available local feature.',
      enabled: false,
      available: true,
      requiresAuroraOpen: true,
      requiresLocalConfirmation: false,
    }
    let availableFeatureEnabled = false
    const localFeatureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [
          { ...availableFeature, enabled: availableFeatureEnabled },
          { ...availableFeature, id: 'feature-unavailable', label: 'Unavailable feature', available: false },
        ],
        approvedDevices: [],
      })),
      setFeatureEnabled: vi.fn(async (featureId, enabled) => {
        if (featureId === 'feature-available') availableFeatureEnabled = enabled
      }),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const thinPeer = connectedThinPeer('peer-new-device', {
      state: 'awaiting-sas-confirmation',
      status: 'pairing',
      pairingSessionId: 'pairing-session-resource',
      pairingVerificationCode: '87654321',
      discoveredDevices: [{
        peerId: 'peer-new-device',
        deviceName: 'New Aurora',
        shortCode: 'ABCD',
        state: 'new',
      }],
    })
    const connectDiscoveredDevice = vi.spyOn(thinPeer, 'connectDiscoveredDevice').mockResolvedValue(undefined)
    const confirmPairing = vi.spyOn(thinPeer, 'confirmPairing')
      .mockRejectedValueOnce(new Error('connection interrupted'))
      .mockResolvedValue(undefined)
    const container = renderResource(client, thinPeer, {
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'mobile-native',
        transportKind: 'native-mobile',
        nativePlatform: 'android',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
      }),
      localFeatureSharing,
      localNode: { peerId: 'peer-waydroid', nodeName: 'Waydroid' },
    })
    await flushReactWork()

    await act(async () => { findButton(container, 'Set up').click(); await Promise.resolve() })
    expect(connectDiscoveredDevice).toHaveBeenCalledWith('peer-new-device')
    await flushReactWork()
    const toggle = document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Tools"]')
    expect(toggle).not.toBeNull()
    await act(async () => { toggle?.click() })
    await act(async () => { findButton(document.body, 'Approve & pair').click(); await Promise.resolve() })
    await flushReactWork()

    expect(confirmPairing).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Could not approve this device')
    expect(findButton(document.body, 'Approve & pair').disabled).toBe(false)
    await act(async () => { findButton(document.body, 'Approve & pair').click(); await Promise.resolve() })
    await flushReactWork()

    expect(confirmPairing).toHaveBeenCalledTimes(2)
    expect(vi.mocked(confirmPairing).mock.calls).toEqual([
      ['pairing-session-resource', { sharedFeatureIds: ['feature-available'] }],
      ['pairing-session-resource', { sharedFeatureIds: ['feature-available'] }],
    ])
    expect(localFeatureSharing.setFeatureEnabled).toHaveBeenCalledOnce()
    expect(vi.mocked(localFeatureSharing.setFeatureEnabled).mock.calls).toEqual([['feature-available', true]])
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('submits an overlapping thin-pair approval only once', async () => {
    const client = new Aurora({ transport: meshTransport() })
    const thinPeer = connectedThinPeer('peer-new-device', {
      state: 'awaiting-sas-confirmation',
      status: 'pairing',
      pairingSessionId: 'pairing-session-overlap',
      pairingVerificationCode: '87654321',
      discoveredDevices: [{
        peerId: 'peer-new-device',
        deviceName: 'New Aurora',
        shortCode: 'ABCD',
        state: 'new',
      }],
    })
    const connectDiscoveredDevice = vi.spyOn(thinPeer, 'connectDiscoveredDevice').mockResolvedValue(undefined)
    let releaseConfirmation!: () => void
    const confirmation = new Promise<void>((resolve) => { releaseConfirmation = resolve })
    const confirmPairing = vi.spyOn(thinPeer, 'confirmPairing').mockReturnValue(confirmation)
    const container = renderResource(client, thinPeer, {
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'mobile-native',
        transportKind: 'native-mobile',
        nativePlatform: 'android',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
      }),
      localNode: { peerId: 'peer-waydroid', nodeName: 'Waydroid' },
    })
    await flushReactWork()

    await act(async () => { findButton(container, 'Set up').click(); await Promise.resolve() })
    expect(connectDiscoveredDevice).toHaveBeenCalledWith('peer-new-device')
    await flushReactWork()

    const approve = findButton(document.body, 'Approve & pair')
    await act(async () => {
      approve.click()
      approve.click()
      await Promise.resolve()
    })
    try {
      await flushReactWork()
      expect(confirmPairing).toHaveBeenCalledTimes(1)
      expect(confirmPairing).toHaveBeenCalledWith('pairing-session-overlap', { sharedFeatureIds: [] })
    } finally {
      releaseConfirmation()
      await flushReactWork()
    }
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('forgets through the resource, removing the remote peer best effort before local cleanup', async () => {
    const client = new Aurora({ transport: meshTransport() })
    const execute = vi.spyOn(client.admin, 'execute').mockResolvedValue({} as never)
    const thinPeer = connectedThinPeer()
    const forgetSavedPeer = vi.spyOn(thinPeer, 'forgetSavedPeer').mockResolvedValue({
      peerId: 'peer-studio-gpu', cleared: true,
    })
    const container = renderResource(client, thinPeer)
    await flushReactWork()
    await vi.waitFor(() => expect(findButton(container, 'Details')).toBeTruthy())

    await act(async () => { findPeerButton(container, 'Studio GPU', 'Details').click() })
    const forget = findButton(document.body, 'Forget this device')
    await act(async () => { forget.click(); await Promise.resolve() })
    await flushReactWork()

    expect(mutationCalls(execute, 'Auth.MeshRemovePeer')).toHaveLength(1)
    expect(forgetSavedPeer).toHaveBeenCalledWith('peer-studio-gpu')
    expect(findButton(document.body, 'Forget this device').disabled).toBe(false)
  })

  it('releases forget after local cleanup rejects and keeps removal feedback visible', async () => {
    const client = new Aurora({ transport: meshTransport() })
    const execute = vi.spyOn(client.admin, 'execute').mockResolvedValue({} as never)
    const thinPeer = connectedThinPeer()
    const forgetSavedPeer = vi.spyOn(thinPeer, 'forgetSavedPeer').mockRejectedValue(new Error('credential store unavailable'))
    const container = renderResource(client, thinPeer)
    await flushReactWork()
    await vi.waitFor(() => expect(findButton(container, 'Details')).toBeTruthy())

    await act(async () => { findPeerButton(container, 'Studio GPU', 'Details').click() })
    const forget = findButton(document.body, 'Forget this device')
    await act(async () => { forget.click(); await Promise.resolve() })
    await flushReactWork()

    expect(mutationCalls(execute, 'Auth.MeshRemovePeer')).toHaveLength(1)
    expect(forgetSavedPeer).toHaveBeenCalledWith('peer-studio-gpu')
    expect(document.body.textContent).toContain('saved approval for this device could not be removed')
    expect(findButton(document.body, 'Forget this device').disabled).toBe(false)
  })
})
