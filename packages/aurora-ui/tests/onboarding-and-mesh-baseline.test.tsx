// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
} from '@aurora/client'
import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'
import {
  buildMeshPeersSnapshot,
  errorShellSnapshot,
  MeshPeersView,
  OnboardingView,
  WebThinConnectionPanel,
  webRtcProfileFromInvite,
  type AuroraShellSnapshot,
  type BrowserWebRtcSnapshot,
} from '../src/index'
import { encodeMeshInviteToken, encodeMeshInviteUrl } from '../src/mesh-invite'
import type { ThinConnectionProfile } from '../src/thin-connection-profile'

const roots: Root[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Phase 2 onboarding and Mesh baseline behavior', () => {
  it('offers device naming plus scan, open, paste, and deep-link invite setup on mobile surfaces', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const scannedInvite = inviteToken('scan-room')
    const container = renderOnboardingWithPanel(
      <WebThinConnectionPanel
        peer={peer as never}
        mode="webrtc-only"
        transportKind="native-mobile"
        nativePlatform="android"
        initialInviteText={inviteDeepLink()}
        configureOnly
        onScanQr={async () => scannedInvite}
        onSaveProfile={async () => undefined}
      />,
    )

    expect(findButton(container, 'Continue')).not.toBeNull()
    expect(container.textContent).not.toContain('Scan invite')
    await act(async () => {
      findButton(container, 'Continue').click()
      await Promise.resolve()
    })
    expect(container.querySelector('.aui-onboarding-scroll-viewport')).not.toBeNull()
    expect(container.textContent).not.toContain('Guided setup')
    expect(container.querySelector<HTMLInputElement>('#webthin-profile-node-name')).not.toBeNull()
    expect(findButton(container, 'Scan invite')).not.toBeNull()
    expect(findButton(container, 'Open invite file')).not.toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toContain('aurora://mesh/invite?')
    expect(container.textContent).toContain('Paste invite')

    await act(async () => {
      findButton(container, 'Scan invite').click()
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(scannedInvite)

    const pastedInvite = inviteToken('paste-room')
    await setTextareaValue(container, '#webthin-invite', pastedInvite)
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(pastedInvite)

    const fileInvite = inviteToken('file-room')
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['ignored by mocked text'], 'invite.aurora', {
      type: 'application/vnd.aurora.context+json',
    })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: async () => fileInvite,
    })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(fileInvite)
  })

  it.each([
    ['permission denial', async () => { throw new Error('Camera permission was not granted for QR scanning.') }],
    ['cancelled scan', async () => null],
    ['empty scan', async () => ''],
  ])('restores mobile invite controls after %s without raw object text', async (_label, onScanQr) => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = renderOnboardingWithPanel(
      <WebThinConnectionPanel
        peer={peer as never}
        mode="webrtc-only"
        transportKind="native-mobile"
        nativePlatform="android"
        configureOnly
        onScanQr={onScanQr}
        onSaveProfile={async () => undefined}
      />,
    )

    expect(container.textContent).not.toContain('Scan invite')
    await act(async () => {
      findButton(container, 'Continue').click()
      await Promise.resolve()
    })

    await act(async () => {
      findButton(container, 'Scan invite').click()
      await Promise.resolve()
    })

    expect(findButton(container, 'Scan invite').disabled).toBe(false)
    expect(findButton(container, 'Open invite file').disabled).toBe(false)
    expect(container.querySelector<HTMLInputElement>('#webthin-profile-node-name')?.disabled)
      .toBe(false)
    expect(container.textContent).not.toContain('Saving…')
    expect(container.textContent).not.toContain('[object Object]')
    expect(container.textContent).not.toContain('{"')
  })

  it('keeps the Mesh page layout and bilateral approval hierarchy intact', async () => {
    const snapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport() }),
      meshRoute(),
    )
    snapshot.pendingRequests[0]!.pendingPairing.verification_code = '654321'
    const approvePeer = vi.fn()
    const denyPeer = vi.fn()
    const container = render(
      <MeshPeersView
        snapshot={snapshot}
        route={meshRoute()}
        permissions="Gateway.use"
        onApprovePeer={approvePeer}
        onDenyPeer={denyPeer}
      />,
    )

    const pageText = container.textContent ?? ''
    expect(pageText.indexOf('Mesh & Peers')).toBeLessThan(pageText.indexOf('Local node'))
    expect(pageText.indexOf('Local node')).toBeLessThan(pageText.indexOf('Pending pairing requests'))
    expect(pageText.indexOf('Pending pairing requests')).toBeLessThan(pageText.indexOf('All peer records'))
    expect(container.querySelectorAll('[data-slot="card"]').length).toBeGreaterThanOrEqual(4)

    await act(async () => {
      findButton(container, 'Review & approve').click()
      await Promise.resolve()
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Approve Kitchen node')
    expect(dialog?.textContent).toContain('Confirm that the verification code matches on both Auroras')
    expect(dialog?.textContent).toContain('6543 21')

    await act(async () => {
      findButton(document.body, 'Approve & pair').click()
    })
    expect(approvePeer).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: 'peer-kitchen',
        pendingPairing: expect.objectContaining({
          request_id: 'mesh-pairing-peer-kitchen',
        }),
      }),
    )
    expect(denyPeer).not.toHaveBeenCalled()
  })
})

class FakeBrowserPeer {
  private readonly snapshotValue: BrowserWebRtcSnapshot

  constructor(partial: Partial<BrowserWebRtcSnapshot> = {}) {
    this.snapshotValue = {
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
      updatedAt: '2026-07-28T00:00:00.000Z',
      status: 'idle',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: false,
      ...partial,
    }
  }

  snapshot() { return this.snapshotValue }
  subscribe(listener: (snapshot: BrowserWebRtcSnapshot) => void) {
    listener(this.snapshotValue)
    return () => undefined
  }
  importInvite(inviteText: string): WebRtcPeerConnectionProfile {
    return webRtcProfileFromInvite(inviteText)!
  }
  async connect() { return undefined }
  async confirmPairing() { return undefined }
  async rejectPairing() { return undefined }
  async disconnect() { return undefined }
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

function renderOnboardingWithPanel(panel: React.ReactElement): HTMLElement {
  return render(
    <OnboardingView
      client={new Aurora({ transport: new MockAuroraTransport() })}
      snapshot={onboardingSnapshot()}
      setupRequired
      thinConnectionPanel={panel}
    />,
  )
}

function onboardingSnapshot(): AuroraShellSnapshot {
  return {
    ...errorShellSnapshot('native-mobile', new Error('offline')),
    loadState: 'ready',
    transportKind: 'native-mobile',
    error: null,
    nativePlatform: 'android',
    nativeAvailable: true,
  }
}

function inviteToken(room: string): string {
  return encodeMeshInviteToken(invitePayload(room))
}

function inviteDeepLink(): string {
  return encodeMeshInviteUrl(invitePayload('deep-link-room'))
}

function invitePayload(room: string) {
  return {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: '2026-07-28T00:00:00.000Z',
    node: { peer_id: 'peer-host', node_name: 'Aurora host' },
    signaling: {
      provider: 'mqtt',
      app_id: 'aurora',
      room,
      room_password: 'secret-room-password',
      mqtt_brokers: ['wss://broker.example/mqtt'],
    },
    webrtc: {
      app_layer_e2ee: true,
      stun_servers: ['stun:stun.example:19302'],
      turn_servers: [],
    },
  }
}

function meshRoute(overrides: Record<string, unknown> = {}) {
  return {
    item: {
      id: 'mesh',
      label: 'Mesh',
      href: '/mesh',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetMeshStatus',
      methodType: 'use',
      privacyClass: 'credential',
      fallbackState: 'unsupported',
      adminGated: false,
      expectedTask: 'MESH-001',
    },
    state: 'available-local',
    explanation: 'Backend catalog reports Gateway.GetMeshStatus and Auth.MeshListPeers as routeable.',
    providerLabel: 'local / Gateway.GetMeshStatus',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['capability-catalog'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
    ...overrides,
  } as never
}

async function setTextareaValue(
  container: HTMLElement,
  selector: string,
  value: string,
) {
  const textarea = container.querySelector<HTMLTextAreaElement>(selector)
  expect(textarea).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    setter?.call(textarea, value)
    textarea?.dispatchEvent(new Event('input', { bubbles: true }))
    textarea?.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button ${text} not found`)
  return button
}
