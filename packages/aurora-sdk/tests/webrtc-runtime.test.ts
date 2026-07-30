import { describe, expect, it, vi } from 'vitest'

import { AuroraClient, AuroraError, type AuroraTransport, type AuroraTransportRequest, type AuroraTransportResponse, type AuroraEventSubscription, type AuroraStreamRequest, createEventSubscription } from '../src/index.js'
import { createBrowserWebRtcAuroraRuntime, MemoryPeerCredentialStore, type BrowserWebRtcRuntime, type WebRtcPeerConnectionProfile } from '../src/webrtc/index.js'
import {
  MemoryInboundCredentialVerifierStore,
  MemoryPeerGrantRepository,
  MemoryReconnectChallengeStore,
  PeerAuthorityResolver,
  PeerPairingIssuer,
  createReconnectProofForBearer
} from '../src/peer-host/authority.js'

const secureLocation = { protocol: 'https:', hostname: 'app.example.test' }

function profile(overrides: Partial<WebRtcPeerConnectionProfile> = {}): WebRtcPeerConnectionProfile {
  return {
    mode: 'webrtc-preferred',
    appId: 'aurora',
    room: 'room-1',
    roomSecretRef: 'memory-room-secret',
    signalingBrokers: ['wss://broker.example.test/mqtt'],
    expectedStablePeerId: 'peer-remote',
    nodeName: 'Remote node',
    ...overrides
  }
}

function okResponse<TData>(data: TData, transport: 'http' | 'mesh' = 'http'): AuroraTransportResponse<TData> {
  return {
    data,
    status: 200,
    audit: { method: 'Gateway.GetRegistry', busTopic: 'Gateway.GetRegistry', transport }
  }
}

class FakeHttpTransport implements AuroraTransport {
  readonly kind = 'http' as const
  requests: AuroraTransportRequest[] = []
  async request<TData = unknown, TPayload = unknown>(request: AuroraTransportRequest<TPayload>): Promise<AuroraTransportResponse<TData>> {
    this.requests.push(request)
    return okResponse({ via: 'http', method: request.method } as TData)
  }
  subscribe<TEventPayload = unknown>(): AuroraEventSubscription<TEventPayload> {
    return createEventSubscription((async function* () {})())
  }
}

class RuntimeClientTransportWrapper implements AuroraTransport {
  readonly kind: AuroraTransport['kind']

  constructor(readonly source: AuroraTransport) {
    this.kind = source.kind
  }

  request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    return this.source.request<TData, TPayload>(request)
  }

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> | Promise<AuroraEventSubscription<TEventPayload>> {
    const source = this.source as AuroraTransport & {
      subscribe?: <TNextEventPayload = TEventPayload, TNextPayload = TPayload>(
        request: AuroraStreamRequest<TNextPayload>,
      ) => AuroraEventSubscription<TNextEventPayload> | Promise<AuroraEventSubscription<TNextEventPayload>>
    }
    if (!source.subscribe) throw new AuroraError({ code: 'unsupported_feature', message: 'source does not support subscriptions' })
    return source.subscribe<TEventPayload, TPayload>(request)
  }
}


describe('browser WebRTC Aurora runtime facade', () => {
  it('constructs http-only without touching WebRTC profile, RTCPeerConnection, or signaling', async () => {
    const oldRtc = (globalThis as Record<string, unknown>).RTCPeerConnection
    delete (globalThis as Record<string, unknown>).RTCPeerConnection
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    try {
      const runtime = createBrowserWebRtcAuroraRuntime({
        mode: 'http-only',
        http: { baseUrl: 'https://gateway.example.test', fetchImpl },
        windowLocation: secureLocation
      })
      expect(runtime.transport.kind).toBe('http')
      expect(runtime.meshTransport).toBeUndefined()
      expect(runtime.peer.snapshot()).toMatchObject({ connectionMode: 'http-only', state: 'idle' })
      await runtime.client.registry.getRegistry()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await runtime.close()
    } finally {
      if (oldRtc !== undefined) (globalThis as Record<string, unknown>).RTCPeerConnection = oldRtc
    }
  })

  it('maps client-facing transports before the default SDK client factory without replacing runtime internals', async () => {
    const wrapped: RuntimeClientTransportWrapper[] = []
    const mapClientTransport = vi.fn((transport: AuroraTransport) => {
      const wrapper = new RuntimeClientTransportWrapper(transport)
      wrapped.push(wrapper)
      return wrapper
    })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch

    const httpRuntime = createBrowserWebRtcAuroraRuntime({
      mode: 'http-only',
      http: { baseUrl: 'https://gateway.example.test', fetchImpl },
      mapClientTransport,
      windowLocation: secureLocation
    })
    const meshRuntime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-preferred',
      profile: profile(),
      http: { baseUrl: 'https://gateway.example.test', fetchImpl },
      mapClientTransport,
      windowLocation: secureLocation
    })

    expect(httpRuntime.client).toBeInstanceOf(AuroraClient)
    expect(meshRuntime.client).toBeInstanceOf(AuroraClient)
    expect(mapClientTransport).toHaveBeenNthCalledWith(1, httpRuntime.transport)
    expect(mapClientTransport).toHaveBeenNthCalledWith(2, meshRuntime.transport)
    expect(httpRuntime.client.transport).toBe(wrapped[0])
    expect(meshRuntime.client.transport).toBe(wrapped[1])
    expect(wrapped[0]?.source).toBe(httpRuntime.transport)
    expect(wrapped[1]?.source).toBe(meshRuntime.transport)
    expect(httpRuntime.httpTransport).toBe(httpRuntime.transport)
    expect(meshRuntime.httpTransport).not.toBe(wrapped[1])
    expect(meshRuntime.meshTransport).toBeUndefined()

    await httpRuntime.close()
    await meshRuntime.close()
  })

  it('maps client-facing transports before an injected runtime client factory', async () => {
    const wrapped: RuntimeClientTransportWrapper[] = []
    const mapClientTransport = vi.fn((transport: AuroraTransport) => {
      const wrapper = new RuntimeClientTransportWrapper(transport)
      wrapped.push(wrapper)
      return wrapper
    })
    const createClient = vi.fn((transport: AuroraTransport) => ({ transport }))

    const runtime = createBrowserWebRtcAuroraRuntime<{ transport: AuroraTransport }>({
      mode: 'webrtc-only',
      mapClientTransport,
      createClient,
      windowLocation: secureLocation
    })

    expect(mapClientTransport).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(mapClientTransport.mock.invocationCallOrder[0]!).toBeLessThan(createClient.mock.invocationCallOrder[0]!)
    expect(createClient).toHaveBeenCalledWith(wrapped[0])
    expect(runtime.client.transport).toBe(wrapped[0])
    expect(wrapped[0]?.source).toBe(runtime.transport)
    expect(runtime.transport).not.toBe(wrapped[0])

    await runtime.close()
  })

  it('constructs a WebRTC thin runtime before an invite supplies its profile', async () => {
    const runtime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-only',
      windowLocation: secureLocation
    })

    expect(runtime.peer.snapshot()).toMatchObject({
      connectionMode: 'webrtc-only',
      state: 'closed'
    })
    await expect(runtime.client.registry.getRegistry()).rejects.toMatchObject({ code: 'unavailable_service' })
    await runtime.close()
  })

  it('fails before signaling when the WebView has no RTCPeerConnection implementation', async () => {
    const oldRtc = (globalThis as Record<string, unknown>).RTCPeerConnection
    const signalingFactory = vi.fn(() => {
      throw new Error('signaling must not start without a peer connection runtime')
    })
    delete (globalThis as Record<string, unknown>).RTCPeerConnection
    try {
      const runtime = createBrowserWebRtcAuroraRuntime({
        mode: 'webrtc-only',
        profile: profile({ mode: 'webrtc-only' }),
        signalingFactory,
        windowLocation: secureLocation
      })

      await expect(runtime.peer.connect(profile({ mode: 'webrtc-only' }))).rejects.toMatchObject({
        code: 'unsupported_feature'
      })
      expect(signalingFactory).not.toHaveBeenCalled()
      expect(runtime.peer.snapshot()).toMatchObject({
        connectionMode: 'webrtc-only',
        expectedStablePeerId: 'peer-remote',
        state: 'closed'
      })
      await runtime.close()
    } finally {
      if (oldRtc !== undefined) {
        (globalThis as Record<string, unknown>).RTCPeerConnection = oldRtc
      }
    }
  })

  it('fails closed for webrtc-only when no authorized peer is connected and never falls back to HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    const runtime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-only',
      profile: profile({ mode: 'webrtc-only' }),
      http: { baseUrl: 'https://gateway.example.test', fetchImpl },
      windowLocation: secureLocation
    })

    await expect(runtime.client.registry.getRegistry()).rejects.toMatchObject({ code: 'unavailable_service' })
    expect(fetchImpl).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('blocks HTTP fallback in webrtc-preferred until an authorized mesh route has existed, then prefers authorized mesh', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ via: 'http' }), { status: 200 })) as unknown as typeof fetch
    const harness = makeRuntimeHarness({
      mode: 'webrtc-preferred',
      http: { baseUrl: 'https://gateway.example.test', fetchImpl }
    })

    await expect(harness.runtime.client.registry.getRegistry()).rejects.toMatchObject({ code: 'unavailable_service' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(harness.runtime.peer.snapshot().lastRedactedError).toMatchObject({ code: 'webrtc_no_authorized_route' })

    const { channel } = await authorizeHarness(harness)
    const frameIndex = channel.sent.length
    const meshRequest = harness.runtime.client.registry.getRegistry()
    const call = await decodeSent(channel, frameIndex)
    expect(call).toMatchObject({ type: 'call', method: 'Gateway.GetRegistry' })
    channel.receive(await encodeInbound({
      type: 'result',
      id: call.id,
      correlation_id: call.correlation_id,
      result: { data: { via: 'mesh', method: call.method }, status: 200 }
    }))
    await expect(meshRequest).resolves.toMatchObject({ via: 'mesh' })
    expect(fetchImpl).not.toHaveBeenCalled()
    await harness.runtime.close()
  })

  it('falls back in preferred mode for transport loss but not auth, permission, or security failures', async () => {
    for (const [code, shouldFallback] of [
      ['transport_loss', true],
      ['auth', false],
      ['permission', false],
      ['native_permission_missing', false],
      ['unknown', false]
    ] as const) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ via: 'http-fallback' }), { status: 200 })) as unknown as typeof fetch
      const harness = makeRuntimeHarness({
        mode: 'webrtc-preferred',
        http: { baseUrl: 'https://gateway.example.test', fetchImpl }
      })
      const { channel } = await authorizeHarness(harness)
      const frameIndex = channel.sent.length
      const request = harness.runtime.client.registry.getRegistry()
      const call = await decodeSent(channel, frameIndex)
      const message = code === 'native_permission_missing'
        ? 'native permission missing'
        : code === 'transport_loss'
          ? 'transport datachannel not connected'
          : code === 'auth'
            ? 'authentication failed'
            : code === 'permission'
              ? 'permission denied'
              : 'programming invariant violated'
      channel.receive(await encodeInbound({
        type: 'error',
        id: call.id,
        correlation_id: call.correlation_id,
        error: { code: 500, message }
      }))
      if (shouldFallback) {
        await expect(request).resolves.toMatchObject({ via: 'http-fallback' })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
      } else {
        await expect(request).rejects.toMatchObject({ code })
        expect(fetchImpl).not.toHaveBeenCalled()
      }
      await harness.runtime.close()
    }
  })


  it('does not replay unsafe mutations through HTTP fallback after uncertain WebRTC transport loss', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ via: 'http-fallback' }), { status: 200 })) as unknown as typeof fetch
    const harness = makeRuntimeHarness({
      mode: 'webrtc-preferred',
      http: { baseUrl: 'https://gateway.example.test', fetchImpl }
    })
    const { channel } = await authorizeHarness(harness)
    const frameIndex = channel.sent.length

    const request = harness.runtime.client.requestResult(
      'Orchestrator.ExternalUserInput',
      { text: 'turn on the lights', correlation_id: 'unsafe-corr' },
      { busTopic: 'Orchestrator.ExternalUserInput' }
    )
    const call = await decodeSent(channel, frameIndex)
    expect(call).toMatchObject({ type: 'call', id: 'unsafe-corr', method: 'Orchestrator.ExternalUserInput' })
    channel.receive(await encodeInbound({
      type: 'error',
      id: call.id,
      correlation_id: call.correlation_id,
      error: { code: 500, message: 'transport datachannel not connected after partial send' }
    }))

    await expect(request).resolves.toMatchObject({ ok: false, error: expect.objectContaining({ code: 'transport_loss' }) })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(channel.sent).toHaveLength(frameIndex + 1)
    await harness.runtime.close()
  })

  it('reissues only safe read fallback over HTTP after a prior authorized mesh route fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ via: 'http-fallback' }), { status: 200 })) as unknown as typeof fetch
    const harness = makeRuntimeHarness({
      mode: 'webrtc-preferred',
      http: { baseUrl: 'https://gateway.example.test', fetchImpl }
    })
    const { channel } = await authorizeHarness(harness)
    const frameIndex = channel.sent.length

    const request = harness.runtime.client.registry.getRegistry()
    const call = await decodeSent(channel, frameIndex)
    expect(call).toMatchObject({ type: 'call', method: 'Gateway.GetRegistry' })
    channel.receive(await encodeInbound({
      type: 'error',
      id: call.id,
      correlation_id: call.correlation_id,
      error: { code: 500, message: 'transport datachannel not connected before response' }
    }))

    await expect(request).resolves.toMatchObject({ via: 'http-fallback' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(channel.sent).toHaveLength(frameIndex + 1)
    expect(harness.runtime.peer.snapshot().lastRedactedError).toMatchObject({ code: 'http_fallback_after_transport_loss' })
    await harness.runtime.close()
  })



  it('defers mesh bridge creation until the peer session reaches authorized state', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-preferred' })
    await harness.store.save('peer-remote', {
      tokenId: 'token-row-1',
      claimantPeerId: 'local-stable',
      verifierPeerId: 'peer-remote',
      claimantSignalingPeerId: 'a-local',
      verifierSignalingPeerId: 'z-remote',
      roomName: 'room-1',
      rawBearerToken: 'saved-token'
    })
    await harness.runtime.peer.connect(harness.runtimeProfile)
    expect(harness.runtime.meshTransport).toBeUndefined()
    expect(harness.runtime.peer.snapshot()).toMatchObject({ state: 'discovering-peer', selectedSignalingBrokerOrigin: 'wss://broker.example.test' })

    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    await flushRuntime()
    const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
    channel.receive(await encodeInbound({
      type: 'mesh_auth_challenge_v1',
      challenge: 'a'.repeat(64),
      channel_binding: binding,
      claimant_peer_id: 'local-stable',
      verifier_peer_id: 'peer-remote',
      claimant_signaling_peer_id: 'a-local',
      verifier_signaling_peer_id: 'z-remote',
      room_name: 'room-1'
    }))
    await decodeSent(channel, 0)
    expect(harness.runtime.meshTransport).toBeUndefined()
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')

    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    await waitForSent(channel, 2)
    expect(harness.runtime.meshTransport).toBeDefined()
    expect(harness.runtime.peer.snapshot().lastRedactedError).toMatchObject({ code: 'webrtc_mesh_authorized' })
    await harness.runtime.close()
    expect(harness.runtime.meshTransport).toBeUndefined()
  })


  it('does not HTTP fallback assistant/event subscriptions in preferred mode before authorization', async () => {
    const runtime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-preferred',
      profile: profile(),
      http: { baseUrl: 'https://gateway.example.test', fetchImpl: vi.fn() as unknown as typeof fetch },
      windowLocation: secureLocation
    })
    await expect(runtime.client.events.streamAssistant(undefined, { correlationId: 'corr-1' })[Symbol.asyncIterator]().next()).rejects.toThrow(AuroraError)
  })

  it('enforces secure context for WebRTC modes but allows http-only from non-secure shells', () => {
    expect(() => createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-only',
      profile: profile({ mode: 'webrtc-only' }),
      windowLocation: { protocol: 'http:', hostname: 'evil.example.test' }
    })).toThrow(AuroraError)

    expect(() => createBrowserWebRtcAuroraRuntime({
      mode: 'http-only',
      http: { baseUrl: 'http://localhost:8000', fetchImpl: vi.fn() as unknown as typeof fetch },
      windowLocation: { protocol: 'http:', hostname: 'evil.example.test' }
    })).not.toThrow()
  })

  it('allows the packaged Tauri local origin when loopback signaling is explicitly enabled', () => {
    expect(() => createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-only',
      profile: profile({
        mode: 'webrtc-only',
        allowInsecureLoopbackSignaling: true,
      }),
      allowInsecureLoopback: true,
      windowLocation: { protocol: 'http:', hostname: 'tauri.localhost' },
    })).not.toThrow()
  })

  it('removes visibility listeners when the thin runtime closes', async () => {
    const visibilityDocument = {
      visibilityState: 'visible' as const,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const runtime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-preferred',
      profile: profile(),
      visibilityDocument,
      windowLocation: secureLocation
    })
    expect(visibilityDocument.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    await runtime.close()
    expect(visibilityDocument.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })


  it('keeps reconnect credentials memory-only and redacts diagnostics/secrets from snapshots', async () => {
    const store = new MemoryPeerCredentialStore()
    const runtime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-preferred',
      profile: profile(),
      credentialStore: store,
      initialCredentials: [{
        tokenId: 'tok-1',
        claimantPeerId: 'local-peer',
        verifierPeerId: 'peer-remote',
        claimantSignalingPeerId: 'sig-local',
        verifierSignalingPeerId: 'sig-remote',
        roomName: 'room-1',
        rawBearerToken: 'super-secret-token'
      }],
      windowLocation: secureLocation
    })
    await store.save('peer-remote', {
      tokenId: 'tok-1',
      claimantPeerId: 'local-peer',
      verifierPeerId: 'peer-remote',
      claimantSignalingPeerId: 'sig-local',
      verifierSignalingPeerId: 'sig-remote',
      roomName: 'room-1',
      rawBearerToken: 'super-secret-token'
    })
    expect(JSON.stringify(await store.get('peer-remote'))).not.toContain('super-secret-token')
    expect(JSON.stringify(runtime.peer.snapshot()).toLowerCase()).not.toContain('super-secret-token')
    expect(JSON.stringify(runtime.peer.snapshot()).toLowerCase()).not.toContain('password')
    await runtime.close()
    await expect(store.get('peer-remote')).rejects.toThrow(/closed/u)
  })

  it('is SSR-safe to import the WebRTC subpath and construct preferred runtime before connect', async () => {
    const oldWindow = (globalThis as Record<string, unknown>).window
    const oldRtc = (globalThis as Record<string, unknown>).RTCPeerConnection
    try {
      delete (globalThis as Record<string, unknown>).window
      delete (globalThis as Record<string, unknown>).RTCPeerConnection
      const mod = await import('../src/webrtc/index.js')
      const runtime = mod.createBrowserWebRtcAuroraRuntime({
        mode: 'webrtc-preferred',
        profile: profile(),
        http: { baseUrl: 'https://gateway.example.test', fetchImpl: vi.fn() as unknown as typeof fetch }
      })
      expect(runtime.peer.snapshot()).toMatchObject({ connectionMode: 'webrtc-preferred', state: 'closed' })
      await runtime.close()
    } finally {
      if (oldWindow !== undefined) (globalThis as Record<string, unknown>).window = oldWindow
      if (oldRtc !== undefined) (globalThis as Record<string, unknown>).RTCPeerConnection = oldRtc
    }
  })
})

import { base64UrlDecode, decodeJsonPayload, deriveRoomKeys, encodeJsonPayload } from '../src/webrtc/crypto.js'
import { PairingSasHandshake, deriveChannelBinding, nonceCommitment, pairingIdentity } from '../src/webrtc/pairing.js'
import {
  buildProtocolHello,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
} from '../src/webrtc/peer-protocol.js'
import type { DataChannelLike, PeerConnectionLike } from '../src/webrtc/peer-session.js'

class RuntimeFakeSignaling {
  sent: Array<{ channel: string; envelope: Record<string, unknown>; toPeer?: string }> = []
  private listeners = new Set<(message: any) => void>()
  snapshot = () => ({ selectedBrokerOrigin: 'wss://broker.example.test', reconnectCount: 0 })
  diagnostics = () => ({ attempts: [], reconnectCount: 0 })
  connect = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  send = vi.fn(async (channel: string, envelope: Record<string, unknown>, toPeer?: string) => {
    const item: { channel: string; envelope: Record<string, unknown>; toPeer?: string } = { channel, envelope }
    if (toPeer !== undefined) item.toPeer = toPeer
    this.sent.push(item)
  })
  onMessage(listener: (message: any) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(message: { channel: any; from: string; stablePeerId?: string; envelope: Record<string, unknown> }): void {
    for (const listener of [...this.listeners]) listener({ topic: 'test', raw: new Uint8Array(), ...message })
  }
}

class RuntimeFakeChannel implements DataChannelLike {
  readyState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer | ArrayBufferView }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  constructor(readonly label: string) {}
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(data) }
  close(): void { this.readyState = 'closed'; this.onclose?.() }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const bucket = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
    bucket.add(listener)
    this.listeners.set(type, bucket)
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void { this.listeners.get(type)?.delete(listener) }
  open(): void { this.readyState = 'open'; this.onopen?.() }
  receive(data: string | ArrayBuffer | ArrayBufferView): void { this.onmessage?.({ data }) }
}

class RuntimeFakePeerConnection implements PeerConnectionLike {
  localDescription: { type: 'offer' | 'answer'; sdp: string } | null = null
  remoteDescription: { type: 'offer' | 'answer'; sdp: string } | null = null
  connectionState = 'new'
  iceConnectionState = 'new'
  onicecandidate: PeerConnectionLike['onicecandidate'] = null
  ondatachannel: PeerConnectionLike['ondatachannel'] = null
  onconnectionstatechange: PeerConnectionLike['onconnectionstatechange'] = null
  oniceconnectionstatechange: PeerConnectionLike['oniceconnectionstatechange'] = null
  channels: RuntimeFakeChannel[] = []
  constructor(readonly offerSdp = 'offer-sdp', readonly answerSdp = 'answer-sdp') {}
  createDataChannel(label: string): DataChannelLike { const ch = new RuntimeFakeChannel(label); this.channels.push(ch); return ch }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: this.offerSdp } }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> { return { type: 'answer', sdp: this.answerSdp } }
  async setLocalDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> { this.localDescription = description }
  async setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> { this.remoteDescription = description }
  async addIceCandidate(): Promise<void> { }
  close(): void { this.connectionState = 'closed' }
}

async function runtimeKeys() {
  return deriveRoomKeys('memory-room-secret', 'aurora', 'room-1', { scryptDeriver: async () => new Uint8Array(32).fill(7) })
}

// WebCrypto jobs share constrained CI worker pools with other workspace tests.
const RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS = 4_000

async function waitForSent(channel: RuntimeFakeChannel, count: number): Promise<void> {
  const deadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
  while (channel.sent.length < count) {
    if (Date.now() > deadline) throw new Error(`Expected ${count} encrypted WebRTC frame(s), saw ${channel.sent.length}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function bytesFromSent(value: string | ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

async function decodeSent(channel: RuntimeFakeChannel, index: number): Promise<Record<string, unknown>> {
  await waitForSent(channel, index + 1)
  const keys = await runtimeKeys()
  try {
    return await decodeJsonPayload(await bytesFromSent(channel.sent[index]!), { key: keys.kData, encrypted: true }) as Record<string, unknown>
  } finally {
    keys.k0.fill(0); keys.kSig.fill(0); keys.kData.fill(0)
  }
}

async function encodeInbound(frame: unknown): Promise<Uint8Array> {
  const keys = await runtimeKeys()
  try {
    return (await encodeJsonPayload(frame, { key: keys.kData })).payload
  } finally {
    keys.k0.fill(0); keys.kSig.fill(0); keys.kData.fill(0)
  }
}

async function flushRuntime(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

async function waitForRuntimeState(runtime: ReturnType<typeof createBrowserWebRtcAuroraRuntime>, state: string): Promise<void> {
  const deadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
  while (runtime.peer.snapshot().state !== state) {
    if (Date.now() > deadline) throw new Error(`Expected runtime state ${state}, saw ${runtime.peer.snapshot().state}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}


interface RuntimeHarness {
  runtime: BrowserWebRtcRuntime
  signaling: RuntimeFakeSignaling
  pc: RuntimeFakePeerConnection
  store: MemoryPeerCredentialStore
  runtimeProfile: WebRtcPeerConnectionProfile
}

function makeRuntimeHarness(options: {
  mode?: 'webrtc-only' | 'webrtc-preferred'
  http?: Parameters<typeof createBrowserWebRtcAuroraRuntime>[0]['http']
  runtimeProfile?: WebRtcPeerConnectionProfile
  pairingConnectPoll?: Parameters<typeof createBrowserWebRtcAuroraRuntime>[0]['pairingConnectPoll']
  credentialStore?: MemoryPeerCredentialStore
  localProtocolCapabilities?: readonly string[]
  appLayerE2eeAllowed?: boolean
  peerAuthorityResolver?: PeerAuthorityResolver
  peerPairingIssuer?: PeerPairingIssuer
} = {}): RuntimeHarness {
  const signaling = new RuntimeFakeSignaling()
  const pc = new RuntimeFakePeerConnection('offer-sdp', 'answer-sdp')
  const store = options.credentialStore ?? new MemoryPeerCredentialStore()
  let id = 0
  const runtimeProfile = options.runtimeProfile ?? profile({ mode: options.mode ?? 'webrtc-only', expectedSignalingPeerId: 'z-remote' })
  const runtime = createBrowserWebRtcAuroraRuntime({
    mode: options.mode ?? 'webrtc-only',
    profile: runtimeProfile,
    http: options.http,
    pairingConnectPoll: options.pairingConnectPoll ?? { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 10 },
    localStablePeerId: 'local-stable',
    localNodeName: 'Thin Shell',
    credentialStore: store,
    signalingFactory: () => signaling as any,
    createPeerConnection: () => pc,
    scryptDeriver: async () => new Uint8Array(32).fill(7),
    randomId: () => (id++ === 0 ? 'a-local' : `rpc-${id}`),
    localProtocolCapabilities: options.localProtocolCapabilities,
    appLayerE2eeAllowed: options.appLayerE2eeAllowed,
    peerAuthorityResolver: options.peerAuthorityResolver,
    peerPairingIssuer: options.peerPairingIssuer,
    windowLocation: secureLocation
  })
  return { runtime, signaling, pc, store, runtimeProfile }
}


async function prepareSasPairing(harness: RuntimeHarness): Promise<{ channel: RuntimeFakeChannel; remoteSas: Awaited<ReturnType<PairingSasHandshake['acceptReveal']>>; pairingStart: Record<string, unknown> }> {
  await harness.runtime.peer.connect(harness.runtimeProfile)
  harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
  await flushRuntime()
  harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
  await flushRuntime()
  const channel = harness.pc.channels[0] as RuntimeFakeChannel
  channel.open()
  await flushRuntime()

  const localCommit = await decodeSent(channel, 0)
  expect(localCommit.type).toBe('pairing_v2_commit')
  const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
  const remote = new PairingSasHandshake({
    channelBindingSha256: binding,
    localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: 'peer-remote', signalingPeerId: 'z-remote', nodeName: 'Remote node' }),
    expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: 'a-local', nodeName: 'Thin Shell' })
  })
  remote.acceptCommit(localCommit)
  channel.receive(await encodeInbound(await remote.commitMessage()))
  await flushRuntime()
  const localReveal = await decodeSent(channel, 1)
  expect(localReveal.type).toBe('pairing_v2_reveal')
  const remoteSas = await remote.acceptReveal(localReveal)
  channel.receive(await encodeInbound(remote.revealMessage()))
  await waitForSent(channel, 3)
  expect(harness.runtime.peer.snapshot().pendingPairing).toMatchObject({ sessionId: remoteSas.pairingSessionId, verificationCode: remoteSas.verificationCode })
  const pairingStart = await decodeSent(channel, 2)
  expect(pairingStart).toMatchObject({ type: 'call', method: 'Auth.PairingStart' })
  return { channel, remoteSas, pairingStart }
}

async function prepareDurableInboundCredential(): Promise<{
  harness: RuntimeHarness
  channel: RuntimeFakeChannel
  remoteSas: Awaited<ReturnType<PairingSasHandshake['acceptReveal']>>
  issuedToken: string
  issuedTokenId: string
}> {
  const verifierStore = new MemoryInboundCredentialVerifierStore()
  const pairingIssuer = new PeerPairingIssuer({
    verifierStore,
    randomBytes: () => new Uint8Array(32).fill(21),
    now: () => 200
  })
  const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerPairingIssuer: pairingIssuer })
  const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
  channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
  const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
  const pairingConnect = await decodeSent(channel, 3)
  channel.receive(await encodeInbound({ type: 'result', id: pairingConnect.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
  const browserExchange = await decodeSent(channel, 4)
  channel.receive(await encodeInbound({ type: 'result', id: browserExchange.id, result: { token: 'fresh-token', token_id: 'token-row-1', peer_id: 'peer-remote', node_name: 'Remote node' } }))
  await decodeSent(channel, 5)
  await confirm

  channel.receive(await encodeInbound({
    type: 'call',
    id: 'python-start-durable-hostile',
    method: 'Auth.PairingStart',
    params: {
      device_name: 'Remote node',
      remote_peer_id: 'peer-remote',
      remote_node_name: 'Remote node',
      room_name: 'room-1',
      pairing_session_id: remoteSas.pairingSessionId,
      verification_code: remoteSas.verificationCode
    }
  }))
  const reverseStart = await decodeSent(channel, 6)
  const reverseHandle = (reverseStart.result as Record<string, unknown>).code
  channel.receive(await encodeInbound({ type: 'call', id: 'python-connect-durable-hostile', method: 'Auth.PairingConnect', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
  await decodeSent(channel, 7)
  channel.receive(await encodeInbound({ type: 'call', id: 'python-exchange-durable-hostile', method: 'Auth.PairingExchange', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
  const reverseExchange = await decodeSent(channel, 8)
  return {
    harness,
    channel,
    remoteSas,
    issuedToken: String((reverseExchange.result as Record<string, unknown>).token),
    issuedTokenId: String((reverseExchange.result as Record<string, unknown>).token_id)
  }
}

async function authorizeHarnessToReconnectProof(harness: RuntimeHarness): Promise<{ channel: RuntimeFakeChannel; proof: Record<string, unknown> }> {
  await harness.store.save('peer-remote', {
    tokenId: 'token-row-1',
    claimantPeerId: 'local-stable',
    verifierPeerId: 'peer-remote',
    claimantSignalingPeerId: 'a-local',
    verifierSignalingPeerId: 'z-remote',
    roomName: 'room-1',
    rawBearerToken: 'saved-token'
  })
  await harness.runtime.peer.connect(harness.runtimeProfile)
  harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
  await flushRuntime()
  harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
  await flushRuntime()
  const channel = harness.pc.channels[0] as RuntimeFakeChannel
  channel.open()
  await flushRuntime()
  const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
  channel.receive(await encodeInbound({
    type: 'mesh_auth_challenge_v1',
    challenge: 'a'.repeat(64),
    channel_binding: binding,
    claimant_peer_id: 'local-stable',
    verifier_peer_id: 'peer-remote',
    claimant_signaling_peer_id: 'a-local',
    verifier_signaling_peer_id: 'z-remote',
    room_name: 'room-1'
  }))
  const proof = await decodeSent(channel, 0)
  expect(proof).toMatchObject({ type: 'mesh_auth_proof_v1', token_id: 'token-row-1', claimant_peer_id: 'local-stable', verifier_peer_id: 'peer-remote' })
  return { channel, proof }
}

async function authorizeHarness(harness: RuntimeHarness): Promise<{ channel: RuntimeFakeChannel; proof: Record<string, unknown> }> {
  await harness.store.save('peer-remote', {
    tokenId: 'token-row-1',
    claimantPeerId: 'local-stable',
    verifierPeerId: 'peer-remote',
    claimantSignalingPeerId: 'a-local',
    verifierSignalingPeerId: 'z-remote',
    roomName: 'room-1',
    rawBearerToken: 'saved-token'
  })
  await harness.runtime.peer.connect(harness.runtimeProfile)
  harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
  await flushRuntime()
  harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
  await flushRuntime()
  const channel = harness.pc.channels[0] as RuntimeFakeChannel
  channel.open()
  await flushRuntime()
  const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
  channel.receive(await encodeInbound({
    type: 'mesh_auth_challenge_v1',
    challenge: 'a'.repeat(64),
    channel_binding: binding,
    claimant_peer_id: 'local-stable',
    verifier_peer_id: 'peer-remote',
    claimant_signaling_peer_id: 'a-local',
    verifier_signaling_peer_id: 'z-remote',
    room_name: 'room-1'
  }))
  const proof = await decodeSent(channel, 0)
  expect(proof).toMatchObject({ type: 'mesh_auth_proof_v1', token_id: 'token-row-1', claimant_peer_id: 'local-stable', verifier_peer_id: 'peer-remote' })
  channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
  await waitForRuntimeState(harness.runtime, 'authorized')
  await waitForSent(channel, 2)
  expect(harness.runtime.meshTransport).toBeDefined()
  expect(harness.runtime.peer.snapshot().protocolCapabilities).toContain(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)
  return { channel, proof }
}

describe('browser WebRTC runtime Python gateway auth interop', () => {
  it('advertises only enabled local capabilities and negotiates their intersection', async () => {
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      localProtocolCapabilities: [CAP_CONSUMER_ONLY_V1],
    })
    const { channel } = await authorizeHarnessToReconnectProof(harness)

    channel.receive(await encodeInbound(buildProtocolHello({
      role: 'provider',
      capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1],
    })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    const localHello = await decodeSent(channel, 1)

    expect(localHello).toMatchObject({
      type: 'protocol_hello',
      role: 'consumer',
      capabilities: [CAP_CONSUMER_ONLY_V1],
    })
    expect(harness.runtime.peer.snapshot().protocolCapabilities).toEqual([])
    await harness.runtime.close()
  })

  it('uses plaintext JSON only when the profile permits it and the E2EE rollout gate is off', async () => {
    const runtimeProfile = profile({
      mode: 'webrtc-only',
      expectedSignalingPeerId: 'z-remote',
      requireAppLayerE2ee: false,
    })
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      runtimeProfile,
      appLayerE2eeAllowed: false,
    })
    await harness.store.save('peer-remote', {
      tokenId: 'token-row-1',
      claimantPeerId: 'local-stable',
      verifierPeerId: 'peer-remote',
      claimantSignalingPeerId: 'a-local',
      verifierSignalingPeerId: 'z-remote',
      roomName: 'room-1',
      rawBearerToken: 'saved-token',
    })

    await harness.runtime.peer.connect(runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    await flushRuntime()
    const binding = await deriveChannelBinding({
      appId: 'aurora',
      room: 'room-1',
      offererSignalingId: 'a-local',
      answererSignalingId: 'z-remote',
      offerSdp: 'offer-sdp',
      answerSdp: 'answer-sdp',
    })
    channel.receive(JSON.stringify({
      type: 'mesh_auth_challenge_v1',
      challenge: 'a'.repeat(64),
      channel_binding: binding,
      claimant_peer_id: 'local-stable',
      verifier_peer_id: 'peer-remote',
      claimant_signaling_peer_id: 'a-local',
      verifier_signaling_peer_id: 'z-remote',
      room_name: 'room-1',
    }))
    await waitForSent(channel, 1)

    expect(typeof channel.sent[0]).toBe('string')
    expect(JSON.parse(String(channel.sent[0]))).toMatchObject({
      type: 'mesh_auth_proof_v1',
      token_id: 'token-row-1',
    })
    channel.receive(JSON.stringify(buildProtocolHello({
      role: 'provider',
      capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1],
    })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    await waitForSent(channel, 2)
    expect(JSON.parse(String(channel.sent[1]))).toMatchObject({ type: 'protocol_hello' })
    await harness.runtime.close()
  })

  it('never downgrades a profile that requires application-layer E2EE', async () => {
    const runtimeProfile = profile({
      mode: 'webrtc-only',
      expectedSignalingPeerId: 'z-remote',
      requireAppLayerE2ee: true,
    })
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      runtimeProfile,
      appLayerE2eeAllowed: false,
    })

    await expect(harness.runtime.peer.connect(runtimeProfile)).rejects.toThrow(/requires application-layer E2EE/i)
    expect(harness.pc.channels).toHaveLength(0)
    await harness.runtime.close()
  })

  it('single-flights pairing bootstrap when channel-open and inbound commit race', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
    const remote = new PairingSasHandshake({
      channelBindingSha256: binding,
      localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: 'peer-remote', signalingPeerId: 'z-remote', nodeName: 'Remote node' }),
      expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: 'a-local', nodeName: 'Thin Shell' })
    })
    const remoteCommit = await remote.commitMessage()

    channel.open()
    channel.receive(await encodeInbound(remoteCommit))
    await waitForSent(channel, 2)

    const frames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    const localCommits = frames.filter((frame) => frame.type === 'pairing_v2_commit')
    expect(localCommits).toHaveLength(1)
    const localCommit = localCommits[0]!
    expect(localCommit).toMatchObject({ channel_binding_sha256: binding, identity: { stable_peer_id: 'local-stable', signaling_peer_id: 'a-local' } })
    const localReveal = frames.find((frame) => frame.type === 'pairing_v2_reveal')
    expect(localReveal).toBeDefined()
    const revealNonce = base64UrlDecode(String(localReveal!.nonce))
    await expect(nonceCommitment(
      String(localCommit.channel_binding_sha256),
      localCommit.identity as Parameters<typeof nonceCommitment>[1],
      revealNonce
    )).resolves.toBe(localCommit.nonce_commitment)

    remote.acceptCommit(localCommit)
    await expect(remote.acceptReveal(localReveal)).resolves.toMatchObject({ remoteStablePeerId: 'local-stable' })
    await harness.runtime.close()
  })

  it('performs SAS pairing, waits for local confirmation, polls pending Auth.PairingConnect, exchanges, auths, and hello-authorizes', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)

    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    await flushRuntime()
    expect(channel.sent).toHaveLength(3)
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')

    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    const pairingConnect = await decodeSent(channel, 3)
    expect(pairingConnect).toMatchObject({ type: 'call', method: 'Auth.PairingConnect', params: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId } })
    channel.receive(await encodeInbound({ type: 'result', id: pairingConnect.id, result: { status: 'pending', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))

    const pairingConnectApproved = await decodeSent(channel, 4)
    expect(pairingConnectApproved).toMatchObject({ type: 'call', method: 'Auth.PairingConnect', params: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId } })
    channel.receive(await encodeInbound({ type: 'result', id: pairingConnectApproved.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))

    const pairingExchange = await decodeSent(channel, 5)
    expect(pairingExchange).toMatchObject({ type: 'call', method: 'Auth.PairingExchange' })
    channel.receive(await encodeInbound({ type: 'result', id: pairingExchange.id, result: { token: 'fresh-token', token_id: 'token-row-1', peer_id: 'peer-remote', node_name: 'Remote node' } }))
    const authFrame = await decodeSent(channel, 6)
    expect(authFrame).toMatchObject({ type: 'auth', peer_id: 'local-stable', signaling_peer_id: 'a-local', pairing_session_id: remoteSas.pairingSessionId, token: 'fresh-token' })
    await confirm

    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect(harness.runtime.peer.snapshot()).toMatchObject({ state: 'authorized', connectedStablePeerId: 'peer-remote' })
    expect(harness.runtime.meshTransport).toBeDefined()
    expect(harness.runtime.peer.snapshot().protocolCapabilities).toEqual(expect.arrayContaining([CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1]))
    await harness.runtime.close()
  })

  it('answers only SAS-bound Auth.PairingStart/Connect/Exchange inbound after authorization while staying consumer-only', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)

    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    const pairingConnect = await decodeSent(channel, 3)
    channel.receive(await encodeInbound({ type: 'result', id: pairingConnect.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const pairingExchange = await decodeSent(channel, 4)
    channel.receive(await encodeInbound({ type: 'result', id: pairingExchange.id, result: { token: 'fresh-token', token_id: 'token-row-1', peer_id: 'peer-remote', node_name: 'Remote node' } }))
    await decodeSent(channel, 5)
    await confirm
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    await waitForSent(channel, 7)

    const startIndex = channel.sent.length
    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-start',
      method: 'Auth.PairingStart',
      params: {
        device_name: 'Remote node',
        remote_peer_id: 'peer-remote',
        remote_node_name: 'Remote node',
        room_name: 'room-1',
        pairing_session_id: remoteSas.pairingSessionId,
        verification_code: remoteSas.verificationCode
      }
    }))
    const startResponse = await decodeSent(channel, startIndex)
    expect(startResponse).toMatchObject({ type: 'result', id: 'python-start', result: { pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode, status: 'approved' } })
    const reverseHandle = (startResponse.result as Record<string, unknown>).code
    expect(reverseHandle).toEqual(expect.any(String))
    expect(reverseHandle).not.toBe(remoteSas.verificationCode)

    channel.receive(await encodeInbound({ type: 'call', id: 'python-connect', method: 'Auth.PairingConnect', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    await expect(decodeSent(channel, startIndex + 1)).resolves.toMatchObject({ type: 'result', id: 'python-connect', result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } })

    channel.receive(await encodeInbound({ type: 'call', id: 'python-exchange', method: 'Auth.PairingExchange', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    const exchangeResponse = await decodeSent(channel, startIndex + 2)
    expect(exchangeResponse).toMatchObject({ type: 'result', id: 'python-exchange', result: { token: expect.any(String), token_id: expect.any(String), peer_id: 'local-stable', node_name: 'Thin Shell' } })

    channel.receive(await encodeInbound({
      type: 'auth',
      peer_name: 'Remote node',
      peer_id: 'peer-remote',
      signaling_peer_id: 'z-remote',
      pairing_session_id: remoteSas.pairingSessionId,
      token: (exchangeResponse.result as Record<string, unknown>).token
    }))
    await waitForRuntimeState(harness.runtime, 'authorized')

    channel.receive(await encodeInbound({ type: 'call', id: 'provider-call', method: 'Gateway.GetRegistry', params: {} }))
    await expect(decodeSent(channel, startIndex + 3)).resolves.toMatchObject({ type: 'error', id: 'provider-call', error: { code: 405, message: 'Local peer is consumer-only' } })
    await harness.runtime.close()
  })

  it('keeps bilateral auth alive when the gateway starts reverse pairing before browser authorization', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)

    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-start-early',
      method: 'Auth.PairingStart',
      params: {
        device_name: 'Remote node',
        remote_peer_id: 'peer-remote',
        remote_node_name: 'Remote node',
        room_name: 'room-1',
        pairing_session_id: remoteSas.pairingSessionId,
        verification_code: remoteSas.verificationCode
      }
    }))
    const earlyStartResponse = await decodeSent(channel, 3)
    expect(earlyStartResponse).toMatchObject({ type: 'result', id: 'python-start-early', result: { status: 'pending', pairing_session_id: remoteSas.pairingSessionId } })
    const reverseHandle = (earlyStartResponse.result as Record<string, unknown>).code

    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    const browserConnect = await decodeSent(channel, 4)
    channel.receive(await encodeInbound({ type: 'result', id: browserConnect.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const browserExchange = await decodeSent(channel, 5)
    channel.receive(await encodeInbound({ type: 'result', id: browserExchange.id, result: { token: 'fresh-token', token_id: 'token-row-1', peer_id: 'peer-remote', node_name: 'Remote node' } }))
    await decodeSent(channel, 6)
    await confirm

    channel.receive(await encodeInbound({ type: 'call', id: 'python-connect-early', method: 'Auth.PairingConnect', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    await expect(decodeSent(channel, 7)).resolves.toMatchObject({ type: 'result', id: 'python-connect-early', result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId } })
    channel.receive(await encodeInbound({ type: 'call', id: 'python-exchange-early', method: 'Auth.PairingExchange', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    const reverseExchange = await decodeSent(channel, 8)
    channel.receive(await encodeInbound({
      type: 'auth',
      peer_name: 'Remote node',
      peer_id: 'peer-remote',
      signaling_peer_id: 'z-remote',
      pairing_session_id: remoteSas.pairingSessionId,
      token: (reverseExchange.result as Record<string, unknown>).token
    }))
    await waitForRuntimeState(harness.runtime, 'authorized')
    await harness.runtime.close()
  })

  it.each(['denied', 'expired', 'superseded'] as const)('stops SAS pairing when Auth.PairingConnect reports %s', async (status) => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    const pairingConnect = await decodeSent(channel, 3)
    channel.receive(await encodeInbound({ type: 'result', id: pairingConnect.id, result: { status, pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    await confirm
    await waitForRuntimeState(harness.runtime, 'failed')
    expect(harness.runtime.peer.snapshot().state).toBe('failed')
    expect(harness.runtime.meshTransport).toBeUndefined()
    await harness.runtime.close()
  })

  it('times out bounded Auth.PairingConnect polling without exchange or auth', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', pairingConnectPoll: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 1 } })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    await harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    await waitForRuntimeState(harness.runtime, 'failed')
    expect(harness.runtime.peer.snapshot().state).toBe('failed')
    const sentFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(sentFrames.filter((frame) => frame.type === 'call' && frame.method === 'Auth.PairingConnect')).toHaveLength(2)
    expect(sentFrames.some((frame) => frame.type === 'call' && frame.method === 'Auth.PairingExchange')).toBe(false)
    expect(sentFrames.some((frame) => frame.type === 'auth')).toBe(false)
    await harness.runtime.close()
  })


  it.each(['auth_success', 'authenticated'] as const)('ignores forged unsupported %s auth signal before protocol_hello', async (type) => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    const { channel } = await authorizeHarnessToReconnectProof(harness)
    channel.receive(await encodeInbound({ type }))
    await flushRuntime()
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()

    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect(harness.runtime.meshTransport).toBeDefined()
    await harness.runtime.close()
  })

  it('starts SAS pairing when reconnect storage explicitly reports no record', async () => {
    const store = new MemoryPeerCredentialStore()
    const status = vi.spyOn(store, 'status')
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', credentialStore: store })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    await waitForRuntimeState(harness.runtime, 'awaiting-sas-confirmation')

    expect(status).toHaveBeenCalledWith('peer-remote')
    expect(await decodeSent(channel, 0)).toMatchObject({ type: 'pairing_v2_commit' })
    await harness.runtime.close()
  })

  it('fails closed with a typed redacted diagnostic when reconnect storage errors', async () => {
    const store = new MemoryPeerCredentialStore()
    vi.spyOn(store, 'status').mockRejectedValue(
      new Error('backend failure with super-secret-token')
    )
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', credentialStore: store })
    const diagnosticCodes: string[] = []
    const diagnosticMessages: string[] = []
    const unsubscribe = harness.runtime.peer.subscribe((snapshot) => {
      if (snapshot.lastRedactedError) {
        diagnosticCodes.push(snapshot.lastRedactedError.code)
        diagnosticMessages.push(snapshot.lastRedactedError.message)
      }
    })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    await waitForRuntimeState(harness.runtime, 'failed')

    expect(channel.sent).toEqual([])
    expect(diagnosticCodes).toContain('webrtc_reconnect_store_unavailable')
    expect(diagnosticMessages).not.toContain('backend failure with super-secret-token')
    expect(harness.runtime.peer.snapshot()).toMatchObject({ state: 'failed' })
    unsubscribe()
    await harness.runtime.close()
  })

  it('answers reconnect challenge with proof and authorizes only after gateway hello', async () => {
    const signaling = new RuntimeFakeSignaling()
    const pc = new RuntimeFakePeerConnection('offer-sdp', 'answer-sdp')
    const store = new MemoryPeerCredentialStore()
    const createReconnectProof = vi.spyOn(store, 'createReconnectProof')
    vi.spyOn(store, 'prove').mockRejectedValue(new Error('runtime should prefer createReconnectProof'))
    await store.save('peer-remote', {
      tokenId: 'token-row-1',
      claimantPeerId: 'local-stable',
      verifierPeerId: 'peer-remote',
      claimantSignalingPeerId: 'a-local',
      verifierSignalingPeerId: 'z-remote',
      roomName: 'room-1',
      rawBearerToken: 'saved-token'
    })
    const runtime = createBrowserWebRtcAuroraRuntime({
      mode: 'webrtc-only',
      profile: profile({ mode: 'webrtc-only', expectedSignalingPeerId: 'z-remote' }),
      localStablePeerId: 'local-stable',
      localNodeName: 'Thin Shell',
      credentialStore: store,
      signalingFactory: () => signaling as any,
      createPeerConnection: () => pc,
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      randomId: (() => { let first = true; return () => first ? (first = false, 'a-local') : 'rpc-reconnect' })(),
      windowLocation: secureLocation
    })
    await runtime.peer.connect(profile({ mode: 'webrtc-only', expectedSignalingPeerId: 'z-remote' }))
    signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = pc.channels[0] as RuntimeFakeChannel
    channel.open()
    await flushRuntime()
    const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
    channel.receive(await encodeInbound({
      type: 'mesh_auth_challenge_v1',
      challenge: 'a'.repeat(64),
      channel_binding: binding,
      claimant_peer_id: 'local-stable',
      verifier_peer_id: 'peer-remote',
      claimant_signaling_peer_id: 'a-local',
      verifier_signaling_peer_id: 'z-remote',
      room_name: 'room-1'
    }))
    await flushRuntime()
    const proof = await decodeSent(channel, 0)
    expect(createReconnectProof).toHaveBeenCalledOnce()
    expect(proof).toMatchObject({ type: 'mesh_auth_proof_v1', token_id: 'token-row-1', claimant_peer_id: 'local-stable', verifier_peer_id: 'peer-remote' })
    expect(runtime.peer.snapshot().state).not.toBe('authorized')
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
    await waitForRuntimeState(runtime, 'authorized')
    expect(runtime.peer.snapshot().state).toBe('authorized')
    expect(runtime.peer.snapshot().protocolCapabilities).toContain(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)
    await runtime.close()
  })

  it('issues verifier-side tokenless reconnect challenges and accepts full-selector proofs with context', async () => {
    const verifierStore = new MemoryInboundCredentialVerifierStore()
    const issuer = new PeerPairingIssuer({
      verifierStore,
      randomBytes: () => new Uint8Array(32).fill(15),
      now: () => 100
    })
    const issued = await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = new PeerAuthorityResolver({
      verifierStore,
      grantRepository: new MemoryPeerGrantRepository(),
      challengeStore: new MemoryReconnectChallengeStore({ randomBytes: () => new Uint8Array(32).fill(16) })
    })
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const challenge = await decodeSent(channel, 0)
    expect(challenge).toMatchObject({
      type: 'mesh_auth_challenge_v1',
      challenge: '10'.repeat(32),
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    })
    expect(challenge).not.toHaveProperty('token_id')
    const proof = await createReconnectProofForBearer(
      issued.bearerToken,
      issued.verifier,
      {
        channelBinding: String(challenge.channel_binding),
        claimantSignalingPeerId: 'z-remote',
        verifierSignalingPeerId: 'a-local'
      },
      String(challenge.challenge)
    )
    channel.receive(await encodeInbound({
      type: 'mesh_auth_proof_v1',
      token_id: issued.tokenId,
      challenge: challenge.challenge,
      proof,
      channel_binding: challenge.channel_binding,
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    }))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect((harness.runtime.peer as any).session.getSnapshot().authenticatedPeerContext).toMatchObject({
      selector: { tokenId: issued.tokenId, claimantPeerId: 'peer-remote', verifierPeerId: 'local-stable', roomName: 'room-1' },
      transport: { channelBinding: challenge.channel_binding, claimantSignalingPeerId: 'z-remote', verifierSignalingPeerId: 'a-local' }
    })
    await harness.runtime.close()
  })

  it('fails closed with redacted diagnostics when verifier reconnect challenge issuance is unavailable', async () => {
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository: new MemoryPeerGrantRepository()
    })
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })
    const diagnosticCodes: string[] = []
    const diagnosticMessages: string[] = []
    const unsubscribe = harness.runtime.peer.subscribe((snapshot) => {
      if (snapshot.lastRedactedError) {
        diagnosticCodes.push(snapshot.lastRedactedError.code)
        diagnosticMessages.push(snapshot.lastRedactedError.message)
      }
    })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    await waitForRuntimeState(harness.runtime, 'failed')

    expect(channel.sent).toEqual([])
    expect((harness.runtime.peer as any).session?.getSnapshot().authenticatedPeerContext).toBeUndefined()
    expect(diagnosticCodes).toContain('webrtc_reconnect_challenge_unavailable')
    expect(diagnosticMessages.join('\n')).not.toMatch(/token|secret|proof|hash|bearer/u)
    unsubscribe()
    await harness.runtime.close()
  })

  it.each([
    ['wrong token', (frame: Record<string, unknown>) => { frame.token_id = 'token-row-wrong' }],
    ['stable peer', (frame: Record<string, unknown>) => { frame.claimant_peer_id = 'peer-other' }],
    ['signaling peer', (frame: Record<string, unknown>) => { frame.claimant_signaling_peer_id = 'sig-other' }],
    ['room', (frame: Record<string, unknown>) => { frame.room_name = 'room-other' }],
    ['channel binding', (frame: Record<string, unknown>) => { frame.channel_binding = 'b'.repeat(64) }]
  ] as const)('fails closed for hostile verifier reconnect proof with %s mismatch', async (_name, mutate) => {
    const verifierStore = new MemoryInboundCredentialVerifierStore()
    const issuer = new PeerPairingIssuer({
      verifierStore,
      randomBytes: () => new Uint8Array(32).fill(18),
      now: () => 100
    })
    const issued = await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = new PeerAuthorityResolver({
      verifierStore,
      grantRepository: new MemoryPeerGrantRepository(),
      challengeStore: new MemoryReconnectChallengeStore({ randomBytes: () => new Uint8Array(32).fill(19) })
    })
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const challenge = await decodeSent(channel, 0)
    const proof = await createReconnectProofForBearer(
      issued.bearerToken,
      issued.verifier,
      {
        channelBinding: String(challenge.channel_binding),
        claimantSignalingPeerId: 'z-remote',
        verifierSignalingPeerId: 'a-local'
      },
      String(challenge.challenge)
    )
    const proofFrame: Record<string, unknown> = {
      type: 'mesh_auth_proof_v1',
      token_id: issued.tokenId,
      challenge: challenge.challenge,
      proof,
      channel_binding: challenge.channel_binding,
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    }
    mutate(proofFrame)
    channel.receive(await encodeInbound(proofFrame))
    await waitForRuntimeState(harness.runtime, 'failed')

    expect((harness.runtime.peer as any).session?.getSnapshot().authenticatedPeerContext).toBeUndefined()
    expect(harness.runtime.meshTransport).toBeUndefined()
    await harness.runtime.close()
  })

  it('durably issues inbound PairingExchange verifier hashes and fresh auth yields context', async () => {
    const verifierStore = new MemoryInboundCredentialVerifierStore()
    const pairingIssuer = new PeerPairingIssuer({
      verifierStore,
      randomBytes: () => new Uint8Array(32).fill(17),
      now: () => 200
    })
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerPairingIssuer: pairingIssuer })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    const pairingConnect = await decodeSent(channel, 3)
    channel.receive(await encodeInbound({ type: 'result', id: pairingConnect.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const browserExchange = await decodeSent(channel, 4)
    channel.receive(await encodeInbound({ type: 'result', id: browserExchange.id, result: { token: 'fresh-token', token_id: 'token-row-1', peer_id: 'peer-remote', node_name: 'Remote node' } }))
    await decodeSent(channel, 5)
    await confirm

    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-start-durable',
      method: 'Auth.PairingStart',
      params: {
        device_name: 'Remote node',
        remote_peer_id: 'peer-remote',
        remote_node_name: 'Remote node',
        room_name: 'room-1',
        pairing_session_id: remoteSas.pairingSessionId,
        verification_code: remoteSas.verificationCode
      }
    }))
    const reverseStart = await decodeSent(channel, 6)
    const reverseHandle = (reverseStart.result as Record<string, unknown>).code
    channel.receive(await encodeInbound({ type: 'call', id: 'python-connect-durable', method: 'Auth.PairingConnect', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    await decodeSent(channel, 7)
    channel.receive(await encodeInbound({ type: 'call', id: 'python-exchange-durable', method: 'Auth.PairingExchange', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    const reverseExchange = await decodeSent(channel, 8)
    const issuedToken = String((reverseExchange.result as Record<string, unknown>).token)
    const issuedTokenId = String((reverseExchange.result as Record<string, unknown>).token_id)
    const verifier = await verifierStore.getVerifier({
      tokenId: issuedTokenId,
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    }, 201)
    expect(verifier?.tokenHashHex).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(verifier)).not.toContain(issuedToken)
    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-exchange-repeat',
      method: 'Auth.PairingExchange',
      params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId }
    }))
    await expect(decodeSent(channel, 9)).resolves.toMatchObject({ type: 'error', id: 'python-exchange-repeat' })

    channel.receive(await encodeInbound({
      type: 'auth',
      peer_name: 'Remote node',
      peer_id: 'peer-remote',
      signaling_peer_id: 'z-remote',
      pairing_session_id: remoteSas.pairingSessionId,
      token: issuedToken
    }))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect((harness.runtime.peer as any).session.getSnapshot().authenticatedPeerContext).toMatchObject({
      selector: { tokenId: issuedTokenId, claimantPeerId: 'peer-remote', verifierPeerId: 'local-stable', roomName: 'room-1' },
      transport: { claimantSignalingPeerId: 'z-remote', verifierSignalingPeerId: 'a-local' }
    })
    await harness.runtime.close()
  })

  it.each([
    ['wrong token', { token: 'wrong-token' }],
    ['stable peer', { peer_id: 'peer-other' }],
    ['signaling peer', { signaling_peer_id: 'sig-other' }]
  ] as const)('fails closed for hostile durable inbound auth with %s mismatch', async (_name, patch) => {
    const { harness, channel, remoteSas, issuedToken } = await prepareDurableInboundCredential()

    channel.receive(await encodeInbound({
      type: 'auth',
      peer_name: 'Remote node',
      peer_id: 'peer-remote',
      signaling_peer_id: 'z-remote',
      pairing_session_id: remoteSas.pairingSessionId,
      token: issuedToken,
      ...patch
    }))
    await waitForRuntimeState(harness.runtime, 'failed')

    expect((harness.runtime.peer as any).session?.getSnapshot().authenticatedPeerContext).toBeUndefined()
    expect(harness.runtime.meshTransport).toBeUndefined()
    await harness.runtime.close()
  })
})
