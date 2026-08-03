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
  buildLocalMeshNodeSnapshot,
  errorShellSnapshot,
  getAuroraSurfaceProfile,
  MeshPeersResource,
  MeshPeersView,
  OnboardingView,
  prepareLocalFeatureSharingApproval,
  WebThinConnectionPanel,
  webRtcProfileFromInvite,
  type AuroraShellSnapshot,
  type BrowserWebRtcSnapshot,
  type LocalFeatureSharingPort,
} from '../src/index'
import { encodeMeshInviteToken, encodeMeshInviteUrl } from '../src/mesh-invite'
import type { ThinConnectionProfile } from '../src/thin-connection-profile'

const roots: Root[] = []
const TOOLING_SERVICE = {
  serviceId: 'tooling',
  servicePermissionId: 'Tooling.use',
  serviceLabel: 'Tools',
  serviceDescription: 'Use tools this device makes available.',
} as const

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Phase 2 onboarding and Mesh baseline behavior', () => {
  it('projects a lightweight mesh node from its own identity and direct grants only', () => {
    const thinSnapshot: BrowserWebRtcSnapshot = {
      state: 'authorized',
      connectionMode: 'webrtc-only',
      expectedStablePeerId: 'peer-home',
      nodeName: 'Home Aurora',
      icePathCategory: 'host',
      protocolCapabilities: [],
      reconnectCount: 0,
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      sentFragmentCount: 0,
      receivedFragmentCount: 0,
      updatedAt: '2026-08-02T00:00:00.000Z',
      status: 'authorized',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
    }
    const snapshot = buildLocalMeshNodeSnapshot({
      localNode: { peerId: 'peer-waydroid', nodeName: 'Waydroid' },
      thinPeer: thinSnapshot,
      sharingAvailable: true,
      featureSharing: {
        features: [{
          ...TOOLING_SERVICE,
          id: 'aurora.local.native.get_device_status.v1',
          label: 'Device status',
          description: 'Read device status.',
          enabled: true,
          available: true,
          requiresAuroraOpen: true,
          requiresLocalConfirmation: false,
          requiredPermissions: ['Native.GetDeviceStatus'],
        }],
        approvedDevices: [{
          peerId: 'peer-home',
          peerLabel: 'Old server label',
          featureIds: ['aurora.local.native.get_device_status.v1'],
          expiresAtMs: null,
        }],
      },
    })

    expect(snapshot.localPeerId).toBe('peer-waydroid')
    expect(snapshot.localNodeName).toBe('Waydroid')
    expect(snapshot.peers.map((peer) => peer.peerId)).toEqual(['peer-home'])
    expect(snapshot.peers[0]).toMatchObject({
      nodeName: 'Home Aurora',
      services: ['Tools'],
      connectionStatus: 'connected',
    })
    expect(snapshot.peers[0]?.permissions).toEqual(['Tooling.use'])
    expect(snapshot.devices).toEqual([])
    expect(snapshot.liveSessionCount).toBe(1)

    const container = render(
      <MeshPeersView
        snapshot={snapshot}
        route={meshRoute()}
        ownsLocalNodeState
        canManageLocalServiceConfiguration={false}
      />,
    )
    expect(container.textContent).toContain('Waydroid')
    expect(container.textContent).toContain('Home Aurora')
    expect(container.textContent).not.toContain('Old server label')
    expect(container.textContent).not.toContain('Features on this device')
    expect(container.textContent).not.toContain('Device connections')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Features')).toBe(false)
  })

  it('never loads the connected server peer history for a node-owned Mesh page', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const requestResult = vi.spyOn(client, 'requestResult')
    const localFeatureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [{
          ...TOOLING_SERVICE,
          id: 'Native.GetDeviceStatus',
          label: 'Device status',
          description: 'Read device status.',
          enabled: true,
          available: true,
          requiresAuroraOpen: true,
          requiresLocalConfirmation: false,
        }],
        approvedDevices: [],
      })),
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const peer = new FakeBrowserPeer({
      status: 'authorized',
      state: 'authorized',
      expectedStablePeerId: 'peer-home',
      nodeName: 'Home Aurora',
      secretsPersisted: true,
    })
    const container = render(
      <MeshPeersResource
        client={client}
        route={meshRoute()}
        surfaceProfile={getAuroraSurfaceProfile({
          runtimeMode: 'mobile-native',
          transportKind: 'native-mobile',
          nativePlatform: 'android',
          nodeMode: 'mesh-node',
          runtimeTier: 'lightweight-ts',
        })}
        thinPeer={peer as never}
        localFeatureSharing={localFeatureSharing}
        localNode={{ peerId: 'peer-waydroid', nodeName: 'Waydroid' }}
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Waydroid')
    expect(container.textContent).toContain('Home Aurora')
    expect(requestResult).not.toHaveBeenCalled()
  })

  it('changes a paired device service access through the canonical Mesh scopes dialog', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const setFeatureEnabled = vi.fn(async () => undefined)
    const replacePeerSharing = vi.fn(async () => undefined)
    const localFeatureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [{
          ...TOOLING_SERVICE,
          id: 'Native.GetDeviceStatus',
          label: 'Device status',
          description: 'Read device status.',
          enabled: false,
          available: true,
          requiresAuroraOpen: true,
          requiresLocalConfirmation: false,
        }],
        approvedDevices: [{
          peerId: 'peer-home',
          peerLabel: 'Home Aurora',
          featureIds: [],
          expiresAtMs: 1_800_000_000_000,
        }],
      })),
      setFeatureEnabled,
      replacePeerSharing,
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const peer = new FakeBrowserPeer({
      status: 'authorized',
      state: 'authorized',
      expectedStablePeerId: 'peer-home',
      nodeName: 'Home Aurora',
      secretsPersisted: true,
    })
    const container = render(
      <MeshPeersResource
        client={client}
        route={meshRoute()}
        surfaceProfile={getAuroraSurfaceProfile({
          runtimeMode: 'mobile-native',
          transportKind: 'native-mobile',
          nativePlatform: 'android',
          nodeMode: 'mesh-node',
          runtimeTier: 'lightweight-ts',
        })}
        thinPeer={peer as never}
        localFeatureSharing={localFeatureSharing}
        localNode={{ peerId: 'peer-waydroid', nodeName: 'Waydroid' }}
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Features').click()
      await Promise.resolve()
    })

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Tools')
    expect(dialog?.textContent).not.toContain('Device status')
    expect(dialog?.textContent).not.toContain('Gateway')
    expect(dialog?.textContent).not.toContain('Orchestrator')
    expect(dialog?.querySelector('[aria-label="Role templates"]')).toBeNull()

    await act(async () => {
      const toolingToggle = dialog?.querySelector<HTMLButtonElement>('[aria-label="Toggle Tools"]')
      expect(toolingToggle).not.toBeNull()
      toolingToggle?.click()
      await Promise.resolve()
    })
    await act(async () => {
      findButton(document.body, 'Save').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setFeatureEnabled).toHaveBeenCalledWith('Native.GetDeviceStatus', true)
    expect(replacePeerSharing).toHaveBeenCalledWith(
      'peer-home',
      ['Native.GetDeviceStatus'],
      1_800_000_000_000,
    )
  })

  it('keeps Android mesh-node setup selectable while native details are still loading', async () => {
    const container = render(
      <OnboardingView
        client={new Aurora({ transport: new MockAuroraTransport() })}
        snapshot={{
          ...onboardingSnapshot(),
          transportKind: 'mesh',
          nativeAvailable: false,
        }}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    const makeAvailable = findButton(container, 'Make this device available')
    expect(makeAvailable.disabled).toBe(false)
    expect(makeAvailable.getAttribute('aria-checked')).toBe('true')
  })

  it('applies a changed device mode before reporting setup complete', async () => {
    let releaseApply: (() => void) | undefined
    const applyModePreference = vi.fn(
      () => new Promise<void>((resolve) => { releaseApply = resolve }),
    )
    const container = render(
      <OnboardingView
        client={new Aurora({ transport: new MockAuroraTransport() })}
        snapshot={onboardingSnapshot()}
        modePreferenceStore={{
          evidence: 'native storage',
          readSelectedMode: vi.fn(async () => 'remote-console'),
          readSelectedRuntimeTier: vi.fn(async () => 'none'),
          writeSelectedMode: vi.fn(async () => true),
          writeSelectedRuntimeTier: vi.fn(async () => true),
        }}
        onApplyModePreference={applyModePreference}
      />,
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const continueButton = findButton(container, 'Continue')
    expect(continueButton.disabled).toBe(false)
    await act(async () => {
      continueButton.click()
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Finish setup').click()
      await Promise.resolve()
    })

    expect(applyModePreference).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Applying choice…')
    expect(container.textContent).not.toContain("You're all set")

    await act(async () => {
      releaseApply?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain("You're all set")
    expect(container.textContent).toContain('change this choice from Settings')
  })

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
    expect(container.querySelector('.aui-onboarding-content')).not.toBeNull()
    expect(container.textContent).not.toContain('Guided setup')
    expect(container.querySelector<HTMLInputElement>('#webthin-profile-node-name')).not.toBeNull()
    expect(findButton(container, 'Scan invite')).not.toBeNull()
    expect(findButton(container, 'Open invite file')).not.toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toContain('aurora://mesh/invite?')
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.className)
      .toContain('aui-webthin-invite-textarea')
    expect(container.querySelector('.aui-webthin-invite-card-content')).not.toBeNull()
    expect(findButton(container, 'Save invite and continue').className)
      .toContain('aui-webthin-invite-action')
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

  it('enables mobile invite saving only after the pasted invite has complete connection details', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const incompletePayload = invitePayload('incomplete-room')
    delete (incompletePayload.signaling as { room_password?: string }).room_password
    const container = render(
      <WebThinConnectionPanel
        peer={peer as never}
        mode="webrtc-only"
        transportKind="native-mobile"
        nativePlatform="android"
        initialInviteText={encodeMeshInviteToken(incompletePayload)}
        configureOnly
        onSaveProfile={async () => undefined}
      />,
    )

    expect(findButton(container, 'Save invite and continue').disabled).toBe(true)

    await setTextareaValue(container, '#webthin-invite', `  ${inviteToken('complete-room')}  `)

    expect(findButton(container, 'Save invite and continue').disabled).toBe(false)
  })

  it('keeps the invite step aligned with the selected mobile setup choice', async () => {
    const container = renderOnboardingWithPanel(
      <WebThinConnectionPanel
        peer={new FakeBrowserPeer({ status: 'needs-invite' }) as never}
        mode="webrtc-only"
        transportKind="native-mobile"
        nativePlatform="android"
        configureOnly
        onSaveProfile={async () => undefined}
      />,
    )

    await act(async () => {
      findButton(container, 'Make this device available').click()
      findButton(container, 'Continue').click()
      await Promise.resolve()
    })

    const setup = container.querySelector<HTMLElement>('[data-step="setup"]')
    expect(setup?.textContent).toContain('Make this device available')
    expect(setup?.textContent).not.toContain('Connect to Aurora')
  })

  it('keeps setup-required mobile onboarding on connect when a stale node preference exists', async () => {
    const writeSelectedMode = vi.fn(async () => true)
    const writeSelectedRuntimeTier = vi.fn(async () => true)
    const container = render(
      <OnboardingView
        client={new Aurora({ transport: new MockAuroraTransport() })}
        snapshot={onboardingSnapshot()}
        setupRequired
        modePreferenceStore={{
          evidence: 'native storage',
          readSelectedMode: vi.fn(async () => 'mesh-node'),
          readSelectedRuntimeTier: vi.fn(async () => 'lightweight-ts'),
          writeSelectedMode,
          writeSelectedRuntimeTier,
        }}
        thinConnectionPanel={
          <WebThinConnectionPanel
            peer={new FakeBrowserPeer({ status: 'needs-invite' }) as never}
            mode="webrtc-only"
            transportKind="native-mobile"
            nativePlatform="android"
            configureOnly
            onSaveProfile={async () => undefined}
          />
        }
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Restored Make this device available')
    expect(findButton(container, 'Make this device available').getAttribute('aria-checked')).toBe('true')
    expect(writeSelectedMode).not.toHaveBeenCalled()
    expect(writeSelectedRuntimeTier).not.toHaveBeenCalled()
  })

  it('falls back to browser device setup when a saved hosted choice is unavailable', async () => {
    const writeSelectedMode = vi.fn(async () => true)
    const writeSelectedRuntimeTier = vi.fn(async () => true)
    const transport = new MockAuroraTransport()
    Object.defineProperty(transport, 'kind', { value: 'offline' })
    const hostedSnapshot: AuroraShellSnapshot = {
      ...onboardingSnapshot(),
      transportKind: 'offline',
      nativePlatform: '',
      nativeAvailable: false,
    }
    const container = render(
      <OnboardingView
        client={new Aurora({ transport })}
        snapshot={hostedSnapshot}
        setupRequired
        modePreferenceStore={{
          evidence: 'browser setup mode selection',
          readSelectedMode: vi.fn(async () => 'remote-console'),
          writeSelectedMode,
          writeSelectedRuntimeTier,
        }}
        thinConnectionPanel={
          <WebThinConnectionPanel
            peer={new FakeBrowserPeer({ status: 'needs-invite' }) as never}
            mode="webrtc-only"
            transportKind="offline"
            configureOnly
            onSaveProfile={async () => undefined}
          />
        }
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const makeAvailable = findButton(container, 'Make this device available')
    expect(makeAvailable.disabled).toBe(false)
    expect(makeAvailable.getAttribute('aria-checked')).toBe('true')
    expect(findButton(container, 'Connect to Aurora').disabled).toBe(true)
    expect(findButton(container, 'Continue').disabled).toBe(false)
    expect(writeSelectedMode).toHaveBeenCalledWith('mesh-node')
    expect(writeSelectedRuntimeTier).toHaveBeenCalledWith('lightweight-ts')
  })

  it('keeps hosted WebRTC setup selectable for connecting to Aurora', async () => {
    const transport = new MockAuroraTransport()
    Object.defineProperty(transport, 'kind', { value: 'mesh' })
    const container = render(
      <OnboardingView
        client={new Aurora({ transport })}
        snapshot={{
          ...onboardingSnapshot(),
          transportKind: 'mesh',
          nativePlatform: '',
          nativeAvailable: false,
        }}
        setupRequired
        modePreferenceStore={{
          evidence: 'browser setup mode selection',
          readSelectedMode: vi.fn(async () => 'remote-console'),
          writeSelectedMode: vi.fn(async () => true),
          writeSelectedRuntimeTier: vi.fn(async () => true),
        }}
        thinConnectionPanel={
          <WebThinConnectionPanel
            peer={new FakeBrowserPeer({ status: 'needs-invite' }) as never}
            mode="webrtc-only"
            transportKind="mesh"
            configureOnly
            onSaveProfile={async () => undefined}
          />
        }
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const connect = findButton(container, 'Connect to Aurora')
    expect(connect.disabled).toBe(false)
    expect(connect.getAttribute('aria-checked')).toBe('true')
    expect(findButton(container, 'Continue').disabled).toBe(false)
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
    expect(pageText.indexOf('Connected devices')).toBeLessThan(pageText.indexOf('This device'))
    expect(pageText.indexOf('This device')).toBeLessThan(pageText.indexOf('Waiting for approval'))
    expect(pageText.indexOf('Waiting for approval')).toBeLessThan(pageText.indexOf('All devices'))
    expect(container.querySelectorAll('[data-slot="card"]').length).toBeGreaterThanOrEqual(4)

    await act(async () => {
      findButton(container, 'Review & approve').click()
      await Promise.resolve()
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Approve Kitchen node')
    expect(dialog?.textContent).toContain('Confirm that the verification code matches on both Auroras')
    expect(dialog?.textContent).toContain('6543 21')
    expect(dialog?.textContent).toContain('Model selection')

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

  it('uses the shared service-scope table and explains the bilateral approval wait', async () => {
    const snapshot = await buildMeshPeersSnapshot(
      new Aurora({ transport: new MockAuroraTransport() }),
      meshRoute(),
    )
    snapshot.pendingRequests = []
    let rejectFirstApproval: ((reason?: unknown) => void) | undefined
    const confirmPairing = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectFirstApproval = reject
      }))
      .mockResolvedValue(undefined)
    const featureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [
          {
            ...TOOLING_SERVICE,
            id: 'aurora.local.native.get_device_status.v1',
            label: 'Device status',
            description: 'Share battery and connectivity status.',
            enabled: false,
            available: true,
            requiresAuroraOpen: true,
            requiresLocalConfirmation: false,
          },
          {
            ...TOOLING_SERVICE,
            id: 'aurora.local.native.share.v1',
            label: 'Share from this phone',
            description: 'Share a file selected on this phone.',
            enabled: true,
            available: true,
            requiresAuroraOpen: true,
            requiresLocalConfirmation: true,
          },
        ],
        approvedDevices: [],
      })),
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const thinSnapshot: BrowserWebRtcSnapshot = {
      state: 'awaiting-sas-confirmation',
      connectionMode: 'webrtc-only',
      expectedStablePeerId: 'peer-home',
      nodeName: 'Home Aurora',
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
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'pairing',
      pairingSessionId: 'pairing-session-mobile',
      pairingVerificationCode: '12345678',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: true,
    }
    const container = render(
      <MeshPeersView
        snapshot={snapshot}
        route={meshRoute()}
        thinPeerSnapshot={thinSnapshot}
        localFeatureSharing={featureSharing}
        onConfirmThinPairing={confirmPairing}
      />,
    )

    await act(async () => {
      findButton(container, 'Review & approve').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Choose what Home Aurora can use from this device')
    expect(dialog?.textContent).toContain('Tools')
    expect(dialog?.textContent).not.toContain('Tooling.use')
    expect(dialog?.textContent).not.toContain('Device status')
    expect(dialog?.textContent).not.toContain('Share from this phone')
    expect(dialog?.textContent).not.toContain('Gateway')
    expect(dialog?.textContent).not.toContain('Orchestrator')
    expect(dialog?.querySelector('[aria-label="Role templates"]')).toBeNull()
    await act(async () => {
      findButton(document.body, 'Approve & pair').click()
      await Promise.resolve()
    })

    expect(findButton(document.body, 'Waiting for other device…').hasAttribute('disabled')).toBe(true)
    await act(async () => {
      rejectFirstApproval?.(new Error('connection interrupted'))
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Could not approve this device')
    expect(findButton(document.body, 'Approve & pair').hasAttribute('disabled')).toBe(false)
    await act(async () => {
      findButton(document.body, 'Approve & pair').click()
      await Promise.resolve()
    })

    expect(confirmPairing).toHaveBeenCalledTimes(2)
    expect(confirmPairing).toHaveBeenLastCalledWith('pairing-session-mobile', {
      sharedFeatureIds: [
        'aurora.local.native.get_device_status.v1',
        'aurora.local.native.share.v1',
      ],
    })
  })

  it('enables only selected available local features before pairing', async () => {
    const setFeatureEnabled = vi.fn(async () => undefined)
    const featureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [
          {
            ...TOOLING_SERVICE,
            id: 'feature-a',
            label: 'Feature A',
            description: 'Feature A description',
            enabled: false,
            available: true,
            requiresAuroraOpen: true,
            requiresLocalConfirmation: false,
          },
          {
            ...TOOLING_SERVICE,
            id: 'feature-b',
            label: 'Feature B',
            description: 'Feature B description',
            enabled: true,
            available: true,
            requiresAuroraOpen: true,
            requiresLocalConfirmation: false,
          },
        ],
        approvedDevices: [],
      })),
      setFeatureEnabled,
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }

    await expect(prepareLocalFeatureSharingApproval(featureSharing, ['feature-b', 'feature-a']))
      .resolves.toEqual(['feature-a', 'feature-b'])
    expect(setFeatureEnabled).toHaveBeenCalledOnce()
    expect(setFeatureEnabled).toHaveBeenCalledWith('feature-a', true)
    await expect(prepareLocalFeatureSharingApproval(featureSharing, ['missing-feature']))
      .rejects.toThrow('no longer available')
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
