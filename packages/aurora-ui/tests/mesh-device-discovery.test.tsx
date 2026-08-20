// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'

import { MeshPeersView, type MeshPeersSnapshot } from '../src/mesh-peers-view'
import { buildLocalMeshNodeSnapshot } from '../src/index'
import { HomeNodeConnectionPanel } from '../src/web-thin-connection-panel'
import { webRtcProfileFromInvite, type BrowserDiscoveredDevice, type BrowserWebRtcSnapshot } from '../src/web-thin-runtime'
import { encodeMeshInviteToken } from '../src/mesh-invite'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const DISCOVERED: readonly BrowserDiscoveredDevice[] = [
  { peerId: 'peer-home', deviceName: 'Living room Aurora', shortCode: 'HOME', state: 'known' },
  { peerId: 'peer-kitchen', deviceName: 'Kitchen speaker', shortCode: 'CHEN', state: 'new' },
  { peerId: 'peer-studio', deviceName: 'Studio desktop', shortCode: 'UDIO', state: 'connected' },
]

function thinSnapshot(partial: Partial<BrowserWebRtcSnapshot> = {}): BrowserWebRtcSnapshot {
  return {
    state: 'idle',
    connectionMode: 'webrtc-only',
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
    updatedAt: '2026-08-19T00:00:00.000Z',
    status: 'needs-invite',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: false,
    discoveredDevices: DISCOVERED,
    ...partial,
  }
}

class FakeDiscoveryPeer {
  connected: WebRtcPeerConnectionProfile[] = []
  constructor(private readonly value: BrowserWebRtcSnapshot) {}
  snapshot() { return this.value }
  subscribe(listener: (snapshot: BrowserWebRtcSnapshot) => void) {
    listener(this.value)
    return () => undefined
  }
  importInvite(inviteText: string): WebRtcPeerConnectionProfile {
    return webRtcProfileFromInvite(inviteText)!
  }
  async connect(profile?: WebRtcPeerConnectionProfile) {
    if (profile) this.connected.push(profile)
  }
  async confirmPairing() { return undefined }
  async rejectPairing() { return undefined }
  async getSelectedCandidatePairEvidence() {
    return { selected: false, category: 'unknown' as const, statsSource: 'RTCPeerConnection.getStats', rawAddressRedacted: true as const }
  }
  async disconnect() { return undefined }
}

function invitePayload(originPeerId: string | null) {
  return {
    kind: 'aurora.mesh.invite',
    version: 2,
    generated_at: '2026-08-19T00:00:00.000Z',
    ...(originPeerId ? { origin_peer_id: originPeerId } : {}),
    node: { node_name: 'Living room Aurora' },
    signaling: {
      provider: 'mqtt',
      app_id: 'aurora',
      room: 'lab-room',
      room_password: 'secret-room-password',
      mqtt_brokers: ['wss://broker.example/mqtt'],
    },
    webrtc: { app_layer_e2ee: true, stun_servers: [], turn_servers: [] },
  }
}

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(element)
  })
  return container
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button ${text} not found`)
  return button
}

function renderConnectPanel(
  peer: FakeDiscoveryPeer,
  saved: WebRtcPeerConnectionProfile[] = [],
  originPeerId: string | null = 'peer-home',
): HTMLElement {
  return render(
    <HomeNodeConnectionPanel
      peer={peer as never}
      mode="webrtc-only"
      transportKind="webrtc"
      initialInviteText={encodeMeshInviteToken(invitePayload(originPeerId))}
      configureOnly
      onSaveProfile={async (profile) => {
        if (profile.webrtcProfile) saved.push(profile.webrtcProfile)
      }}
    />,
  )
}

const CONTINUE_LABEL = 'Save invite and continue'

/** An approved Studio desktop plus the devices this surface has only seen. */
function meshSnapshot(): MeshPeersSnapshot {
  return buildLocalMeshNodeSnapshot({
    localNode: { peerId: 'local-device', nodeName: 'This device' },
    thinPeer: thinSnapshot({
      status: 'authorized',
      state: 'authorized',
      expectedStablePeerId: 'peer-studio',
      nodeName: 'Studio desktop',
    }),
    sharingAvailable: true,
    featureSharing: {
      features: [],
      approvedDevices: [{
        peerId: 'peer-studio',
        peerLabel: 'Studio desktop',
        featureIds: [],
        expiresAtMs: null,
      }],
    },
  })
}

function route(): RouteAvailability {
  return {
    item: {
      id: 'mesh',
      label: 'Devices',
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

describe('W5 device discovery and selection', () => {
  it('lists every device found with its name, code and setup state', () => {
    const container = renderConnectPanel(new FakeDiscoveryPeer(thinSnapshot()))

    expect(container.textContent).toContain('Devices in this Aurora')
    expect(container.textContent).toContain('Living room Aurora')
    expect(container.textContent).toContain('Code HOME')
    expect(container.textContent).toContain('Set up on this device')
    expect(container.textContent).toContain('Kitchen speaker')
    expect(container.textContent).toContain('Code CHEN')
    expect(container.textContent).toContain('Not set up yet')
    expect(container.textContent).toContain('Studio desktop')
    // The identity behind a device never reaches the screen.
    expect(container.innerHTML).not.toContain('peer-kitchen')
    expect(container.innerHTML).not.toContain('peer-home')
  })

  it('pre-selects the device the invite came from', () => {
    const container = renderConnectPanel(new FakeDiscoveryPeer(thinSnapshot()))

    const selected = Array.from(container.querySelectorAll('[role="radio"]')).filter(
      (node) => node.getAttribute('aria-checked') === 'true',
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]?.textContent).toContain('Living room Aurora')
    expect(selected[0]?.textContent).toContain('From your invite')
  })

  it('sets up the device chosen instead of the one that sent the invite', async () => {
    const saved: WebRtcPeerConnectionProfile[] = []
    const container = renderConnectPanel(new FakeDiscoveryPeer(thinSnapshot()), saved)

    const kitchen = Array.from(container.querySelectorAll('button')).find(
      (node) => node.getAttribute('role') === 'radio' && node.textContent?.includes('Kitchen speaker'),
    )
    expect(kitchen).toBeDefined()
    await act(async () => {
      kitchen?.click()
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, CONTINUE_LABEL).click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(saved).toHaveLength(1)
    expect(saved[0]?.expectedStablePeerId).toBe('peer-kitchen')
    expect(saved[0]?.nodeName).toBe('Kitchen speaker')
  })

  it('starts from the invited device when nothing else is chosen', async () => {
    const saved: WebRtcPeerConnectionProfile[] = []
    const container = renderConnectPanel(new FakeDiscoveryPeer(thinSnapshot()), saved)

    await act(async () => {
      findButton(container, CONTINUE_LABEL).click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(saved[0]?.expectedStablePeerId).toBe('peer-home')
  })

  it('lets the devices screen set up several of the devices it found', async () => {
    const added: string[] = []
    const container = render(
      <MeshPeersView
        snapshot={meshSnapshot()}
        route={route()}
        canManageLocalServiceConfiguration={false}
        thinPeerSnapshot={thinSnapshot({ status: 'authorized', state: 'authorized' })}
        onConnectDiscoveredDevice={(peerId) => {
          added.push(peerId)
        }}
      />,
    )

    const card = container.querySelector('[aria-label="Devices in this Aurora"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Living room Aurora')
    expect(card?.textContent).toContain('Kitchen speaker')
    // Already an approved device here, so it is not offered again.
    expect(card?.textContent).not.toContain('Studio desktop')

    await act(async () => {
      for (const button of Array.from(card?.querySelectorAll('button') ?? [])) {
        if (button.textContent?.includes('Set up')) button.click()
      }
      await Promise.resolve()
    })

    expect(added).toEqual(['peer-home', 'peer-kitchen'])
  })

  it('keeps the discovered device copy free of internal wording', () => {
    const panel = renderConnectPanel(new FakeDiscoveryPeer(thinSnapshot()))
    const mesh = render(
      <MeshPeersView
        snapshot={meshSnapshot()}
        route={route()}
        canManageLocalServiceConfiguration={false}
        thinPeerSnapshot={thinSnapshot({ status: 'authorized', state: 'authorized' })}
        onConnectDiscoveredDevice={() => undefined}
      />,
    )

    for (const [name, container] of [['connect', panel], ['devices', mesh]] as const) {
      const text = (container.textContent ?? '').replace(/\s+/gu, ' ')
      const matches = findForbiddenProductionCopyTerms(text).map((term) => term.id)
      expect(matches, `${name} rendered forbidden copy in: ${text}`).toEqual([])
    }
  })
})
