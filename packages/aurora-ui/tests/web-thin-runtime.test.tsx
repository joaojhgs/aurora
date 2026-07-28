// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryPeerCredentialStore,
  type PeerConnectionSnapshot,
  type WebRtcPeerConnectionProfile,
} from '@aurora/client/webrtc'
import { AuroraClient, AuroraError, MockAuroraTransport, type AuroraTransport, type JsonObject } from '@aurora/client'
import {
  BrowserWebRtcPeerController,
  WebThinConnectionPanel,
  createBrowserWebThinRuntime,
  encodeMeshInviteToken,
  explainBrowserThinRuntime,
  getAuroraSurfaceProfile,
  hostedMixedContentWarning,
  webRtcProfileFromInvite,
  type BrowserWebRtcSnapshot,
  type ThinConnectionProfile,
  type WebThinRoomSecret,
} from '../src/index'

const roots: Root[] = []
const createClient = (transport: AuroraTransport) => new AuroraClient({ transport })
const createDemoClient = () => new AuroraClient({ transport: new MockAuroraTransport() })

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser WebRTC thin-shell runtime', () => {
  it('classifies mesh/WebRTC thin transport through the centralized surface profile', () => {
    const web = getAuroraSurfaceProfile({ runtimeMode: 'web-thin', transportKind: 'mesh' })
    expect(web.kind).toBe('web')
    expect(web.isWebThin).toBe(true)
    expect(web.supportsWebRtcThin).toBe(true)
    expect(web.prefersWebRtcTransport).toBe(true)
    expect(web.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')

    const desktop = getAuroraSurfaceProfile({ runtimeMode: 'desktop-thin', transportKind: 'webrtc-preferred' })
    expect(desktop.kind).toBe('desktop-thin')
    expect(desktop.supportsWebRtcThin).toBe(true)
    expect(desktop.usesLocalSidecar).toBe(false)

    const local = getAuroraSurfaceProfile({ runtimeMode: 'desktop-local', transportKind: 'tauri-local' })
    expect(local.voiceCapture.wakewordOwner).toBe('coordinator-daemon')

    const androidHttp = getAuroraSurfaceProfile({ runtimeMode: 'mobile-native', transportKind: 'http', nativePlatform: 'android' })
    expect(androidHttp.kind).toBe('android')
    expect(androidHttp.isWebThin).toBe(true)
    expect(androidHttp.supportsAndroidOnly).toBe(true)
    expect(androidHttp.supportsWebRtcThin).toBe(true)
    expect(androidHttp.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(androidHttp.voiceCapture.wakewordOwner).toBe('webview-focused')
    expect(androidHttp.voiceCapture.detail).toContain('focused foreground WebView microphone')
    expect(androidHttp.voiceCapture.detail).toContain('no durable background wakeword')

    const androidWebRtc = getAuroraSurfaceProfile({ runtimeMode: 'mobile-native', transportKind: 'webrtc-preferred', nativePlatform: 'android' })
    expect(androidWebRtc.kind).toBe('android')
    expect(androidWebRtc.prefersWebRtcTransport).toBe(true)

    const androidPackaged = getAuroraSurfaceProfile({ runtimeMode: 'android-thin', transportKind: 'webrtc-preferred' })
    expect(androidPackaged.kind).toBe('android')
    expect(androidPackaged.isMobile).toBe(true)

    const iosPackaged = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'webrtc-preferred',
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    })
    expect(iosPackaged.kind).toBe('ios')
    expect(iosPackaged.isMobile).toBe(true)
    expect(iosPackaged.isWebThin).toBe(true)
    expect(iosPackaged.supportsWebRtcThin).toBe(true)
  })

  it('builds a memory-only WebRTC profile from an invite without browser storage', () => {
    const localStorageSet = vi.spyOn(Storage.prototype, 'setItem')
    const sessionStorageSet = vi.spyOn(Storage.prototype, 'setItem')
    const invite = inviteText()

    const profile = webRtcProfileFromInvite(invite, { nodeName: 'Browser shell' })

    expect(profile).toMatchObject({
      appId: 'aurora',
      room: 'studio-room',
      expectedStablePeerId: 'peer-host',
      nodeName: 'Browser shell',
      signalingBrokers: ['wss://broker.example/mqtt'],
      requireAppLayerE2ee: true,
    })
    expect(profile?.roomSecretRef).toMatch(/^ref:memory:/)
    expect(localStorageSet).not.toHaveBeenCalled()
    expect(sessionStorageSet).not.toHaveBeenCalled()
  })

  it('describes invite presence without making a persistence-backend claim', () => {
    const notes = explainBrowserThinRuntime({
      mode: 'webrtc-only',
      inviteText: inviteText(),
    })

    expect(notes).toContain(
      'invite room=studio-room; brokers=1; secret=provided',
    )
    expect(notes.join('\n')).not.toContain('secret=memory-only')
  })

  it('uses the exact nonsecret profile signaling endpoint over invite metadata', () => {
    const profile = webRtcProfileFromInvite(inviteText(), {
      nodeName: 'Desktop shell',
      signalingUrl: 'wss://profile-signaling.example/mqtt',
    })

    expect(profile?.signalingBrokers).toEqual([
      'wss://profile-signaling.example/mqtt',
    ])
    expect(profile?.expectedStablePeerId).toBe('peer-host')
  })

  it('selects explicit http-only and webrtc-preferred fallback modes', async () => {
    const httpOnly = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'http-only',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    expect(httpOnly.mode).toBe('http-only')
    expect(httpOnly.client.transport.kind).toBe('http')
    expect(httpOnly.peer.snapshot().status).toBe('idle')

    const preferred = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    expect(preferred.mode).toBe('webrtc-preferred')
    expect(preferred.client.transport.kind).toBe('mesh')
    expect(preferred.peer.snapshot().hasHttpFallback).toBe(true)
    await httpOnly.close()
    await preferred.close()
  })

  it('rolls WebRTC-preferred back to HTTP without consuming or rewriting peer credentials', async () => {
    const credentialStore = Object.assign(new MemoryPeerCredentialStore(), {
      loadConnectionProfile: vi.fn(() => null),
      saveConnectionProfile: vi.fn(),
      setRoomSecret: vi.fn(),
    })
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      credentialStore,
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })

    expect(runtime.mode).toBe('webrtc-preferred')
    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
      diagnostic: expect.stringMatching(/rollout flag/i),
    })
    expect(credentialStore.loadConnectionProfile).not.toHaveBeenCalled()
    expect(credentialStore.saveConnectionProfile).not.toHaveBeenCalled()
    expect(credentialStore.setRoomSecret).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('fails WebRTC-only closed when the thin-client rollout flag is disabled', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: false,
      diagnostic: expect.stringMatching(/rollout flag/i),
    })
    await expect(runtime.peer.connect()).rejects.toThrow(/rollout flag/i)
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(/rollout flag/i)
    await runtime.close()
  })

  it('fails closed for WebRTC-only on insecure non-loopback contexts', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'http:', hostname: 'public.example' },
    })

    const snapshot = runtime.peer.snapshot()
    expect(snapshot.status).toBe('needs-secure-context')
    expect(snapshot.hasHttpFallback).toBe(false)
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(/secure|unavailable/i)
  })

  it('surfaces missing RTCPeerConnection during connect without using HTTP in WebRTC-only mode', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      signalingFactory: () => new FakeSignalingClient() as any,
      createPeerConnection: () => { throw new Error('RTCPeerConnection unavailable') },
      randomId: () => 'local-z',
    })
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(false)

    await runtime.peer.connect()
    await waitUntil(() => ['failed', 'connecting'].includes(runtime.peer.snapshot().status), 200)
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(false)
    expect(['failed', 'connecting']).toContain(runtime.peer.snapshot().status)
  })

  it('does not fall back to HTTP before an attempted WebRTC connection in preferred mode', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      fetchImpl,
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(/WebRTC mesh transport is not connected|fallback is disabled/i)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(true)
    await runtime.close()
  })

  it('fails closed for WebRTC-preferred secure-context validation instead of falling back to HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      fetchImpl,
      windowLocation: { protocol: 'http:', hostname: 'public.example' },
    })

    expect(runtime.peer.snapshot().status).toBe('needs-secure-context')
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(false)
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(/secure|unavailable/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not allow HTTP fallback for generic unavailable/not-connected errors', async () => {
    const peer = new FakeBrowserPeer({ status: 'authorized', state: 'authorized' })
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-preferred', { httpFallback: true })

    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'transport_loss', message: 'ICE transport lost' }))).toBe(false)
    await controller.connect(webRtcProfileFromInvite(inviteText())!)
    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'unavailable_service', message: 'WebRTC mesh transport is not connected and HTTP fallback is disabled.' }))).toBe(false)
    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'auth', message: 'pairing token rejected' }))).toBe(false)
    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'transport_loss', message: 'ICE transport lost' }))).toBe(true)
  })

  it('disconnects WebRTC peer sessions when the thin-shell document is hidden', async () => {
    const peer = new FakeBrowserPeer({ status: 'authorized', state: 'authorized' })
    const listeners = new Map<string, Set<() => void>>()
    const visibilityDocument = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (event: string, listener: () => void) => {
        const set = listeners.get(event) ?? new Set<() => void>()
        set.add(listener)
        listeners.set(event, set)
      },
      removeEventListener: (event: string, listener: () => void) => {
        listeners.get(event)?.delete(listener)
      },
    } as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false, visibilityDocument })

    Object.defineProperty(visibilityDocument, 'visibilityState', { configurable: true, value: 'hidden' as DocumentVisibilityState })
    for (const listener of listeners.get('visibilitychange') ?? []) listener()
    await waitUntil(() => peer.disconnectedReasons.includes('hidden document'))

    expect(peer.disconnectedReasons).toContain('hidden document')
    expect(controller.snapshot().status).toBe('closed')
    expect(controller.snapshot().diagnostic).toMatch(/lost visibility/i)
  })

  it('forwards selected candidate-pair evidence without exposing raw addresses', async () => {
    const peer = new FakeBrowserPeer({ status: 'authorized', state: 'authorized' })
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false })

    const evidence = await controller.getSelectedCandidatePairEvidence()

    expect(peer.selectedCandidatePairEvidenceCalls).toBe(1)
    expect(evidence).toEqual({
      selected: true,
      category: 'prflx',
      pairState: 'succeeded',
      nominated: true,
      localCandidateType: 'prflx',
      remoteCandidateType: 'host',
      localProtocol: 'udp',
      remoteProtocol: 'udp',
      stunServerReflexiveCandidate: {
        gathered: true,
        candidateType: 'srflx',
        urlScheme: 'stun',
        urlMatchesConfiguredStunServer: true,
        configuredStunServerCount: 1,
        statsSource: 'RTCPeerConnection.getStats',
        rawAddressRedacted: true,
      },
      statsSource: 'RTCPeerConnection.getStats',
      rawAddressRedacted: true,
    })
    expect(Object.keys(evidence)).not.toEqual(expect.arrayContaining(['localAddress', 'remoteAddress', 'ip', 'address']))
    expect(JSON.stringify(evidence)).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })

  it('redacts secret-bearing runtime diagnostics', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      signalingFactory: () => { throw new Error('password=secret-room-password token=abc123') },
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      randomId: () => 'local-redacted',
    })

    await expect(runtime.peer.connect()).rejects.toThrow()
    const diagnostic = runtime.peer.snapshot().diagnostic ?? ''
    expect(diagnostic).not.toContain('secret-room-password')
    expect(diagnostic).not.toContain('abc123')
  })

  it('renders invite diagnostics and SAS confirmation controls accessibly', async () => {
    const peer = new FakeBrowserPeer({
      status: 'pairing',
      pairingSessionId: 'pair-session-1',
      pairingVerificationCode: '12345678',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const onInviteAccepted = vi.fn()

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
          initialInviteText={inviteText()}
          onInviteAccepted={onInviteAccepted}
        />
      )
    })

    expect(container.textContent).toContain('Thin-shell transport')
    expect(container.textContent).toContain('Compare SAS')
    expect(container.textContent).toContain('12345678')
    expect(container.textContent).toContain('memory-only')

    const confirm = findButton(container, 'Confirm SAS')
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(peer.confirmed).toEqual(['pair-session-1'])

    const accept = findButton(container, 'Use invite for WebRTC')
    await act(async () => {
      accept.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(peer.connectedProfiles).toHaveLength(1)
    expect(peer.connectedProfiles[0]?.room).toBe('studio-room')
    expect(onInviteAccepted).toHaveBeenCalledTimes(1)

    const reconnect = findButton(container, 'Reconnect WebRTC')
    await act(async () => {
      reconnect.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(peer.connectedProfiles).toHaveLength(2)
  })

  it('edits and saves a nonsecret desktop-thin connection profile', async () => {
    const peer = new FakeBrowserPeer({ status: 'idle' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const profile = {
      id: 'office',
      label: 'Office',
      mode: 'webrtc-preferred' as const,
      gatewayUrl: 'https://gateway.example.invalid',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora desktop',
      localStablePeerId: 'desktop-peer-01',
    }
    const onSaveProfile = vi.fn(async () => undefined)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-preferred"
          transportKind="mesh"
          profile={profile}
          profiles={[profile, { ...profile, id: 'home', label: 'Home' }]}
          profileStoreEvidence="Nonsecret platform profile storage"
          onSaveProfile={onSaveProfile}
          onSelectProfile={async () => undefined}
        />
      )
    })

    expect(container.querySelector('[aria-label="Thin connection profile"]')).not.toBeNull()
    expect(container.textContent).toContain('Nonsecret platform profile storage')
    const nodeName = container.querySelector<HTMLInputElement>('#webthin-profile-node-name')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nodeName, 'Edited desktop')
      nodeName.dispatchEvent(new Event('input', { bubbles: true }))
      nodeName.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton(container, 'Save and use profile').click()
    })

    expect(onSaveProfile).toHaveBeenCalledWith({
      ...profile,
      nodeName: 'Edited desktop',
    })
    expect(container.querySelector('input[name*="token" i]')).toBeNull()
    expect(container.querySelector('input[name*="secret" i]')).toBeNull()
  })

  it('imports an invite into secure storage before leaving configure-only onboarding', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const actions: string[] = []
    const onSaveProfile = vi.fn(async (
      _profile: ThinConnectionProfile,
      _roomSecret?: WebThinRoomSecret,
    ) => {
      actions.push('saved')
    })
    const onInviteAccepted = vi.fn(async () => {
      actions.push('accepted')
    })

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="http-only"
          transportKind="http"
          initialInviteText={inviteText()}
          configureOnly
          onSaveProfile={onSaveProfile}
          onInviteAccepted={onInviteAccepted}
        />
      )
    })

    expect(container.querySelector('[data-thin-invite-onboarding="true"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Thin connection profile"]')).toBeNull()
    expect(container.querySelector('#webthin-profile-mode')).toBeNull()
    expect(container.querySelector('#webthin-profile-gateway')).toBeNull()
    expect(container.querySelector('#webthin-profile-signaling')).toBeNull()
    expect(container.querySelector('#webthin-profile-stable-peer')).toBeNull()
    expect(container.textContent).not.toContain('Thin transport diagnostics')
    expect(container.textContent).not.toContain('Scan QR invite')

    const nodeName = container.querySelector<HTMLInputElement>('#webthin-profile-node-name')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(nodeName, 'Kitchen tablet')
      nodeName.dispatchEvent(new Event('input', { bubbles: true }))
      nodeName.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton(container, 'Save invite and continue').click()
      await Promise.resolve()
    })

    expect(onSaveProfile).toHaveBeenCalledTimes(1)
    expect(onSaveProfile.mock.calls[0]?.[0]).toMatchObject({
      mode: 'webrtc-only',
      signalingUrl: 'wss://broker.example/mqtt',
      nodeName: 'Kitchen tablet',
      webrtcProfile: {
        room: 'studio-room',
        roomSecretRef: 'ref:memory:studio-room',
        nodeName: 'Kitchen tablet',
      },
    })
    expect(onSaveProfile.mock.calls[0]?.[1]).toEqual({
      roomSecretRef: 'ref:memory:studio-room',
      roomSecret: 'secret-room-password',
    })
    expect(actions).toEqual(['saved', 'accepted'])
    expect(peer.connectedProfiles).toHaveLength(0)
  })

  it('offers QR invite scanning only on mobile configure-only onboarding', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="http-only"
          transportKind="native-mobile"
          nativePlatform="android"
          configureOnly
          onSaveProfile={async () => undefined}
        />
      )
    })

    expect(container.textContent).toContain('Scan QR invite')
    expect(container.textContent).toContain('Open invite file')
    expect(container.textContent).toContain('Paste mesh invite')
  })

  it('fills the invite field from native/browser QR scan and an invite file', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const scannedInvite = inviteText()
    const onScanQr = vi.fn(async () => scannedInvite)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
          onScanQr={onScanQr}
        />
      )
    })
    await act(async () => {
      findButton(container, 'Scan QR invite').click()
      await Promise.resolve()
    })
    expect(onScanQr).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(scannedInvite)

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['ignored by mocked text'], 'invite.aurora', {
      type: 'application/vnd.aurora.context+json',
    })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: async () => scannedInvite,
    })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(scannedInvite)
  })

  it('warns that hosted HTTPS cannot override browser mixed-content blocking', () => {
    const profile = {
      id: 'cleartext',
      label: 'LAN',
      mode: 'webrtc-preferred' as const,
      gatewayUrl: 'http://aurora.lan:8000',
      signalingUrl: 'ws://aurora.lan:9001/mqtt',
      nodeName: 'Hosted browser',
      localStablePeerId: 'hosted-browser-stable',
    }

    expect(hostedMixedContentWarning('web', profile, 'https:')).toContain(
      'Browsers block HTTP or unencrypted WebSocket endpoints',
    )
    expect(hostedMixedContentWarning('desktop-thin', profile, 'https:')).toBeNull()
    expect(hostedMixedContentWarning('web', profile, 'http:')).toBeNull()
  })

  it('re-enables profile controls after profile selection succeeds or fails', async () => {
    const peer = new FakeBrowserPeer({ status: 'idle' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const profile = {
      id: 'office',
      label: 'Office',
      mode: 'webrtc-preferred' as const,
      gatewayUrl: 'https://gateway.example.invalid',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora desktop',
      localStablePeerId: 'desktop-peer-01',
    }
    const home = { ...profile, id: 'home', label: 'Home' }
    const failing = { ...profile, id: 'failing', label: 'Failing' }
    const onSelectProfile = vi.fn(async (profileId: string) => {
      if (profileId === 'failing') throw new Error('token=secret failure')
    })

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-preferred"
          transportKind="mesh"
          profile={profile}
          profiles={[profile, home, failing]}
          onSaveProfile={async () => undefined}
          onSelectProfile={onSelectProfile}
        />
      )
    })

    const openAndChoose = async (label: string) => {
      await act(async () => {
        container.querySelector<HTMLElement>('#webthin-profile-select')?.click()
      })
      const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
        .find((candidate) => candidate.textContent?.includes(label))
      expect(item, `select item ${label}`).toBeTruthy()
      await act(async () => {
        item?.click()
      })
    }

    await openAndChoose('Home')
    expect(onSelectProfile).toHaveBeenCalledWith('home')
    expect(findButton(container, 'Save and use profile').hasAttribute('disabled')).toBe(false)

    await openAndChoose('Failing')
    expect(onSelectProfile).toHaveBeenCalledWith('failing')
    expect(findButton(container, 'Save and use profile').hasAttribute('disabled')).toBe(false)
    expect(container.textContent).toContain('[redacted]')
    expect(container.textContent).not.toContain('token=secret')
  })

})

class FakeBrowserPeer {
  confirmed: string[] = []
  connectedProfiles: WebRtcPeerConnectionProfile[] = []
  disconnectedReasons: string[] = []
  selectedCandidatePairEvidenceCalls = 0
  private snapshotValue: BrowserWebRtcSnapshot
  constructor(partial: Partial<BrowserWebRtcSnapshot> = {}) {
    this.snapshotValue = {
      state: 'awaiting-sas-confirmation',
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
      updatedAt: new Date().toISOString(),
      status: 'pairing',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: false,
      ...partial,
    }
  }
  snapshot() { return this.snapshotValue }
  subscribe(listener: (snapshot: BrowserWebRtcSnapshot) => void) { listener(this.snapshotValue); return () => undefined }
  importInvite(invite: string) { return webRtcProfileFromInvite(invite)! }
  async connect(profile?: WebRtcPeerConnectionProfile) { if (profile) this.connectedProfiles.push(profile); return undefined }
  async confirmPairing(sessionId: string) { this.confirmed.push(sessionId) }
  async rejectPairing(_sessionId: string) { return undefined }
  async getSelectedCandidatePairEvidence() {
    this.selectedCandidatePairEvidenceCalls += 1
    return {
      selected: true,
      category: 'prflx' as const,
      pairState: 'succeeded',
      nominated: true,
      localCandidateType: 'prflx',
      remoteCandidateType: 'host',
      localProtocol: 'udp',
      remoteProtocol: 'udp',
      stunServerReflexiveCandidate: {
        gathered: true,
        candidateType: 'srflx',
        urlScheme: 'stun',
        urlMatchesConfiguredStunServer: true,
        configuredStunServerCount: 1,
        statsSource: 'RTCPeerConnection.getStats',
        rawAddressRedacted: true,
      },
      statsSource: 'RTCPeerConnection.getStats' as const,
      rawAddressRedacted: true as const,
    }
  }
  async disconnect(reason?: string) { this.disconnectedReasons.push(reason ?? 'disconnect'); return undefined }
}

function inviteText(): string {
  const invite: JsonObject = {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: '2026-07-26T00:00:00Z',
    node: { peer_id: 'peer-host', node_name: 'Host node' },
    signaling: {
      provider: 'mqtt',
      app_id: 'aurora',
      room: 'studio-room',
      room_password: 'secret-room-password',
      mqtt_brokers: ['wss://broker.example/mqtt'],
    },
    webrtc: { app_layer_e2ee: true, stun_servers: ['stun:stun.example:19302'], turn_servers: [] },
  }
  return encodeMeshInviteToken(invite)
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button ${text} not found`)
  return button
}


class FakeSignalingClient {
  signalingPeerId = 'local-z'
  private handlers = new Set<(message: any) => void>()
  snapshot() { return { selectedBrokerOrigin: 'wss://broker.example' } }
  diagnostics() { return { attempts: [], reconnectCount: 0 } }
  onMessage(handler: (message: any) => void) { this.handlers.add(handler); return () => this.handlers.delete(handler) }
  async connect(_room: any) {
    queueMicrotask(() => {
      for (const handler of this.handlers) handler({
        channel: 'presence',
        from: 'remote-a',
        stablePeerId: 'peer-host',
        envelope: { type: 'presence', peer_id: 'remote-a', stable_peer_id: 'peer-host' },
        topic: 'presence',
        raw: new Uint8Array(),
      })
    })
  }
  async close() { return undefined }
  async send() { return undefined }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  }
}
