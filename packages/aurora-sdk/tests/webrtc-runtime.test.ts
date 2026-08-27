import { describe, expect, it, vi } from 'vitest'

import { AuroraClient, AuroraError, type AuroraTransport, type AuroraTransportRequest, type AuroraTransportResponse, type AuroraEventSubscription, type AuroraStreamRequest, createEventSubscription } from '../src/index.js'
import { createBrowserWebRtcAuroraRuntime, MemoryPeerCredentialStore, type BrowserWebRtcRuntime, type BrowserWebRtcRuntimeOptions, type MeshPeerRegistryController, type WebRtcPeerConnectionProfile } from '../src/webrtc/index.js'
import type { PeerAuthorityResolverPort, PeerRelationshipSelector } from '../src/peer-host/authority-types.js'
import { scriptedResolver } from './helpers/authority-doubles.js'
import { createTestAuthority } from './helpers/wasm-authority.js'

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

  it('does not expose a stale disconnected diagnostic after the session is authorized', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    await authorizeHarness(harness)

    const peer = harness.runtime.peer as unknown as {
      noteUnavailable(code: string, method: string): void
    }
    peer.noteUnavailable('webrtc_peer_not_connected', 'Gateway.GetRegistry')

    expect(harness.runtime.peer.snapshot()).toMatchObject({
      state: 'authorized',
      lastRedactedError: { code: 'webrtc_mesh_authorized' }
    })
    await harness.runtime.close()
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
  connect = vi.fn(async (): Promise<void> => undefined)
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
  candidates: unknown[] = []
  constructor(
    readonly offerSdp = 'offer-sdp',
    readonly answerSdp = 'answer-sdp',
    private readonly remoteDescriptionGate?: Promise<void>,
  ) {}
  createDataChannel(label: string): DataChannelLike { const ch = new RuntimeFakeChannel(label); this.channels.push(ch); return ch }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: this.offerSdp } }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> { return { type: 'answer', sdp: this.answerSdp } }
  async setLocalDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> { this.localDescription = description }
  async setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    await this.remoteDescriptionGate
    this.remoteDescription = description
  }
  async addIceCandidate(candidate: unknown): Promise<void> {
    if (this.remoteDescription === null) throw new Error('remote description is not ready')
    this.candidates.push(candidate)
  }
  close(): void { this.connectionState = 'closed' }
}

async function runtimeKeys() {
  return deriveRoomKeys('memory-room-secret', 'aurora', 'room-1', { scryptDeriver: async () => new Uint8Array(32).fill(7) })
}

// WebCrypto jobs share constrained CI worker pools with other workspace tests.
const RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS = 30_000

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

async function waitForDecodedFrame(
  channel: RuntimeFakeChannel,
  predicate: (frame: Record<string, unknown>) => boolean,
  startIndex = 0,
): Promise<{ frame: Record<string, unknown>; index: number }> {
  const deadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
  let index = startIndex
  while (Date.now() <= deadline) {
    while (index < channel.sent.length) {
      const frame = await decodeSent(channel, index)
      if (predicate(frame)) return { frame, index }
      index += 1
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`Expected matching encrypted WebRTC frame after index ${startIndex}`)
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
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
  localSignalingId?: string
  pairingConnectPoll?: Parameters<typeof createBrowserWebRtcAuroraRuntime>[0]['pairingConnectPoll']
  credentialStore?: MemoryPeerCredentialStore
  localProtocolCapabilities?: readonly string[]
  appLayerE2eeAllowed?: boolean
  peerAuthorityResolver?: PeerAuthorityResolverPort
  peerPairingIssuer?: NonNullable<Parameters<typeof createBrowserWebRtcAuroraRuntime>[0]['peerPairingIssuer']>
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
    pairingConnectPoll: options.pairingConnectPoll ?? { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 1_000 },
    localStablePeerId: 'local-stable',
    localNodeName: 'Thin Shell',
    credentialStore: store,
    signalingFactory: () => signaling as any,
    createPeerConnection: () => pc,
    scryptDeriver: async () => new Uint8Array(32).fill(7),
    randomId: () => (id++ === 0 ? (options.localSignalingId ?? 'a-local') : `rpc-${id}`),
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
  const authority = await createTestAuthority(() => 200)
  const pairingIssuer = authority.pairingIssuer
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

describe('browser WebRTC runtime Python gateway auth interop', {
  timeout: RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS + 5_000,
}, () => {
  it('honors an explicit answerer role when the remote peer initiates', async () => {
    const runtimeProfile = profile({
      mode: 'webrtc-only',
      expectedSignalingPeerId: 'a-remote',
    })
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      runtimeProfile,
      localSignalingId: 'z-local',
    })

    const peer = harness.runtime.peer as typeof harness.runtime.peer & MeshPeerRegistryController
    await peer.connectPeer(runtimeProfile, { negotiationIntent: 'answerer' })
    harness.signaling.emit({
      channel: 'presence',
      from: 'a-remote',
      stablePeerId: 'peer-remote',
      envelope: { type: 'presence', stable_peer_id: 'peer-remote' },
    })
    await flushRuntime()

    expect(harness.runtime.peer.snapshot()).toMatchObject({
      negotiationRole: 'answerer',
      state: 'discovering-peer',
    })
    expect(harness.pc.channels).toHaveLength(0)

    harness.signaling.emit({
      channel: 'offer',
      from: 'a-remote',
      stablePeerId: 'peer-remote',
      envelope: { type: 'offer', sdp: 'remote-offer-sdp' },
    })
    await flushRuntime()

    expect(harness.signaling.sent).toContainEqual(expect.objectContaining({
      channel: 'answer',
      toPeer: 'a-remote',
      envelope: expect.objectContaining({ type: 'answer', sdp: 'answer-sdp' }),
    }))
    await harness.runtime.close()
  })

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

    const auth = (harness.runtime.peer as any).session.options.auth
    expect(auth.localSasConfirmed).toBe(true)
    auth.resetTransport()
    expect(auth.pairing).toBeNull()
    expect(auth.pairingHandle).toBeNull()
    expect(auth.inboundPairingHandle).toBeNull()
    expect(auth.issuedInboundCredential).toBeNull()
    expect(auth.localSasConfirmed).toBe(false)
    expect(auth.approvedSharedFeatureIds).toEqual([])
    await harness.runtime.close()
  })

  it('starts a fresh SAS transcript after an incomplete pairing transport is replaced', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    await prepareSasPairing(harness)
    const auth = (harness.runtime.peer as any).session.options.auth

    auth.resetTransport()

    expect(auth.handshake).toBeNull()
    expect(auth.pairing).toBeNull()
    expect(auth.pairingHandle).toBeNull()
    expect(auth.inboundPairingHandle).toBeNull()
    expect(auth.issuedInboundCredential).toBeNull()
    expect(auth.localSasConfirmed).toBe(false)
    expect(auth.approvedSharedFeatureIds).toEqual([])

    const sent: Record<string, unknown>[] = []
    const context = {
      localSignalingId: 'a-local',
      remoteSignalingId: 'z-remote',
      localStableId: 'local-stable',
      remoteStableId: 'peer-remote',
      offerSdp: 'replacement-offer-sdp',
      answerSdp: 'replacement-answer-sdp',
      sendControlFrame: async (frame: unknown) => { sent.push(frame as Record<string, unknown>) },
    }
    await auth.startPairing(context)
    expect(sent[0]).toMatchObject({ type: 'pairing_v2_commit' })

    const binding = await deriveChannelBinding({
      appId: 'aurora',
      room: 'room-1',
      offererSignalingId: 'a-local',
      answererSignalingId: 'z-remote',
      offerSdp: 'replacement-offer-sdp',
      answerSdp: 'replacement-answer-sdp',
    })
    const remote = new PairingSasHandshake({
      channelBindingSha256: binding,
      localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: 'peer-remote', signalingPeerId: 'z-remote', nodeName: 'Remote node' }),
      expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: 'a-local', nodeName: 'Thin Shell' }),
    })
    remote.acceptCommit(sent[0] as any)

    await expect(auth.handleFrame(await remote.commitMessage(), context)).resolves.toBeUndefined()
    expect(sent[1]).toMatchObject({ type: 'pairing_v2_reveal' })
    await harness.runtime.close()
  })

  it('does not clear a newer pairing prompt when an older approval finishes late', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    let finishApproval!: () => void
    const delayedApproval = new Promise<void>((resolve) => { finishApproval = resolve })
    const session = { confirmSas: vi.fn(() => delayedApproval) }
    // Seed the peer through the registry's own API rather than poking a
    // projected setter: an entry exists because a peer was registered, which
    // is the only way one is created in production either.
    const controller = harness.runtime.peer as unknown as {
      registry: {
        add(entry: Record<string, unknown>): { pendingPairing: Record<string, unknown> | null; session: unknown }
        remove(entry: unknown): void
      }
    }
    const entry = controller.registry.add({
      key: 'peer-remote',
      peerId: 'peer-remote',
      profile: profile({ mode: 'webrtc-only' }),
      session,
      signaling: null,
      bridge: null,
      keyMaterial: null,
      localProtocolHello: null,
      pendingPairing: {
        pairingSessionId: 'pairing-old',
        verificationCode: '11112222',
        remoteStablePeerId: 'peer-remote',
        remoteNodeName: 'Remote node'
      }
    })

    const approval = harness.runtime.peer.confirmPairing('pairing-old')
    entry.pendingPairing = {
      pairingSessionId: 'pairing-new',
      verificationCode: '33334444',
      remoteStablePeerId: 'peer-remote',
      remoteNodeName: 'Remote node'
    }
    finishApproval()
    await approval

    expect(entry.pendingPairing).toMatchObject({ pairingSessionId: 'pairing-new' })
    entry.session = null
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
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    await harness.runtime.close()
  })

  it('does not authorize a mesh node until both pairing directions complete', async () => {
    const authority = await createTestAuthority(() => 200)
    const pairingIssuer = authority.pairingIssuer
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      peerPairingIssuer: pairingIssuer,
      pairingConnectPoll: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 1_000 }
    })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)

    channel.receive(await encodeInbound({
      type: 'result',
      id: pairingStart.id,
      result: {
        code: 'opaque-handle',
        pairing_session_id: remoteSas.pairingSessionId,
        verification_code: remoteSas.verificationCode
      }
    }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId, {
      sharedFeatureIds: ['aurora.local.native.get_device_status.v1']
    })
    const browserConnect = await decodeSent(channel, 3)

    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-start-reverse-first',
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
    const reverseStart = await decodeSent(channel, 4)
    const reverseHandle = (reverseStart.result as Record<string, unknown>).code
    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-connect-reverse-first',
      method: 'Auth.PairingConnect',
      params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId }
    }))
    await decodeSent(channel, 5)
    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-exchange-reverse-first',
      method: 'Auth.PairingExchange',
      params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId }
    }))
    const reverseExchange = await decodeSent(channel, 6)
    expect(reverseExchange).toMatchObject({
      type: 'result',
      id: 'python-exchange-reverse-first',
      result: { token: expect.any(String) }
    })
    channel.receive(await encodeInbound({
      type: 'auth',
      peer_name: 'Remote node',
      peer_id: 'peer-remote',
      signaling_peer_id: 'z-remote',
      pairing_session_id: remoteSas.pairingSessionId,
      token: (reverseExchange.result as Record<string, unknown>).token
    }))
    await flushRuntime()

    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()

    channel.receive(await encodeInbound({
      type: 'result',
      id: browserConnect.id,
      result: {
        status: 'approved',
        pairing_session_id: remoteSas.pairingSessionId,
        verification_code: remoteSas.verificationCode
      }
    }))
    const browserExchange = (await waitForDecodedFrame(
      channel,
      (frame) => frame.type === 'call' && frame.method === 'Auth.PairingExchange',
      7,
    )).frame
    channel.receive(await encodeInbound({
      type: 'result',
      id: browserExchange.id,
      result: {
        token: 'fresh-token',
        token_id: 'token-row-1',
        peer_id: 'peer-remote',
        node_name: 'Remote node'
      }
    }))
    await confirm
    const outboundAuth = await waitForDecodedFrame(
      channel,
      (frame) => frame.type === 'auth' && frame.token === 'fresh-token',
      7,
    )
    expect(outboundAuth.frame).toMatchObject({ type: 'auth', token: 'fresh-token' })
    await expect(waitForDecodedFrame(
      channel,
      (frame) => frame.type === 'protocol_hello',
      outboundAuth.index + 1,
    )).resolves.toMatchObject({ frame: { type: 'protocol_hello', role: 'consumer' } })

    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect(harness.runtime.meshTransport).toBeDefined()
    const completedAuth = (harness.runtime.peer as any).session.options.auth
    expect(completedAuth.issuedInboundCredential).not.toBeNull()
    completedAuth.resetTransport()
    expect(completedAuth.issuedInboundCredential).toBeNull()
    expect(completedAuth.localSasConfirmed).toBe(false)
    await harness.runtime.close()
  }, 15_000)

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

  it('retries transport after bounded Auth.PairingConnect polling without exchange or auth', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', pairingConnectPoll: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 1 } })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    await harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)
    await waitForRuntimeState(harness.runtime, 'reconnecting')
    expect(harness.runtime.peer.snapshot().state).toBe('reconnecting')
    const sentFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(sentFrames.filter((frame) => frame.type === 'call' && frame.method === 'Auth.PairingConnect')).toHaveLength(2)
    expect(sentFrames.some((frame) => frame.type === 'call' && frame.method === 'Auth.PairingExchange')).toBe(false)
    expect(sentFrames.some((frame) => frame.type === 'auth')).toBe(false)
    expect(sentFrames.filter((frame) => frame.type === 'call' && frame.method === 'Auth.PairingStart')).toHaveLength(1)
    await harness.runtime.close()
  })

  it('keeps polling an approved pairing request when attempts are unbounded', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', pairingConnectPoll: { maxAttempts: 0, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 500 } })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId)

    for (let index = 3; index < 66; index += 1) {
      const pendingConnect = await decodeSent(channel, index)
      expect(pendingConnect).toMatchObject({ type: 'call', method: 'Auth.PairingConnect' })
      channel.receive(await encodeInbound({ type: 'result', id: pendingConnect.id, result: { status: 'pending', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    }

    const approvedConnect = await decodeSent(channel, 66)
    expect(approvedConnect).toMatchObject({ type: 'call', method: 'Auth.PairingConnect' })
    channel.receive(await encodeInbound({ type: 'result', id: approvedConnect.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    let pairingExchange = await decodeSent(channel, 67)
    if (pairingExchange.type === 'call' && pairingExchange.method === 'Auth.PairingConnect') {
      channel.receive(await encodeInbound({ type: 'result', id: pairingExchange.id, result: { status: 'approved', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
      pairingExchange = await decodeSent(channel, 68)
    }
    expect(pairingExchange).toMatchObject({ type: 'call', method: 'Auth.PairingExchange' })
    channel.receive(await encodeInbound({ type: 'result', id: pairingExchange.id, result: { token: 'fresh-token', token_id: 'token-row-1', peer_id: 'peer-remote', node_name: 'Remote node' } }))
    await decodeSent(channel, channel.sent.length - 1)
    await confirm
    expect(harness.runtime.peer.snapshot().state).not.toBe('failed')
    await harness.runtime.close()
  })

  it('does not clear in-flight pairing state when transport reconnects mid-approval', async () => {
    const harness = makeRuntimeHarness({ mode: 'webrtc-only' })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const startSnapshot = harness.runtime.peer.snapshot()
    expect(startSnapshot.pendingPairing).toMatchObject({ sessionId: remoteSas.pairingSessionId, verificationCode: remoteSas.verificationCode })

    await flushRuntime()
    harness.pc.connectionState = 'disconnected'
    harness.pc.onconnectionstatechange?.()
    await waitForRuntimeState(harness.runtime, 'reconnecting')
    expect(harness.runtime.peer.snapshot().pendingPairing).toMatchObject({ sessionId: remoteSas.pairingSessionId, verificationCode: remoteSas.verificationCode })

    const sentFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(sentFrames.filter((frame) => frame.type === 'call' && frame.method === 'Auth.PairingStart')).toHaveLength(1)
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

  it('waits for a delayed reconnect challenge without starting fresh pairing and authorizes only after gateway hello', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 1_650))
    expect(channel.sent).toEqual([])
    expect(runtime.peer.snapshot().state).toBe('reconnect-authenticating')
    expect(runtime.peer.snapshot().pendingPairing).toBeUndefined()
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
    const framesBeforeHello = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(framesBeforeHello.some((frame) => frame.type === 'pairing_v2_commit')).toBe(false)
    expect(runtime.peer.snapshot().state).toBe('reconnect-authenticating')
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
    await waitForRuntimeState(runtime, 'authorized')
    expect(runtime.peer.snapshot().state).toBe('authorized')
    expect(runtime.peer.snapshot().protocolCapabilities).toContain(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)
    await runtime.close()
  })

  it('issues verifier-side tokenless reconnect challenges and accepts full-selector proofs with context', async () => {
    const authority = await createTestAuthority(() => 100)
    const issuer = authority.pairingIssuer
    const issued = await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = authority.resolver
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
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    })
    expect(challenge).not.toHaveProperty('token_id')
    await new Promise((resolve) => setTimeout(resolve, 1_650))
    const framesBeforeProof = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(framesBeforeProof.some((frame) => frame.type === 'pairing_v2_commit')).toBe(false)
    expect(harness.runtime.peer.snapshot().state).toBe('reconnect-authenticating')
    const proof = await authority.reconnectProof(
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
    await waitForSent(channel, 2)
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect((harness.runtime.peer as any).session.getSnapshot().authenticatedPeerContext).toMatchObject({
      selector: { tokenId: issued.tokenId, claimantPeerId: 'peer-remote', verifierPeerId: 'local-stable', roomName: 'room-1' },
      transport: { channelBinding: challenge.channel_binding, claimantSignalingPeerId: 'z-remote', verifierSignalingPeerId: 'a-local' }
    })
    await harness.runtime.close()
  })

  it('waits for reciprocal reconnect acknowledgement before exposing a bilateral mesh session', async () => {
    const authority = await createTestAuthority(() => 100)
    const issuer = authority.pairingIssuer
    const inbound = await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = authority.resolver
    const credentialStore = new MemoryPeerCredentialStore()
    await credentialStore.save('peer-remote', {
      tokenId: 'token-row-local',
      claimantPeerId: 'local-stable',
      verifierPeerId: 'peer-remote',
      claimantSignalingPeerId: 'a-local',
      verifierSignalingPeerId: 'z-remote',
      roomName: 'room-1',
      rawBearerToken: 'saved-local-token'
    })
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      credentialStore,
      peerAuthorityResolver: resolver
    })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const localChallenge = await decodeSent(channel, 0)
    const binding = String(localChallenge.channel_binding)

    channel.receive(await encodeInbound({
      type: 'mesh_auth_challenge_v1',
      challenge: 'b'.repeat(64),
      channel_binding: binding,
      claimant_peer_id: 'local-stable',
      verifier_peer_id: 'peer-remote',
      claimant_signaling_peer_id: 'a-local',
      verifier_signaling_peer_id: 'z-remote',
      room_name: 'room-1'
    }))
    await waitForSent(channel, 2)

    const remoteProof = await authority.reconnectProof(
      inbound.bearerToken,
      inbound.verifier,
      {
        channelBinding: binding,
        claimantSignalingPeerId: 'z-remote',
        verifierSignalingPeerId: 'a-local'
      },
      String(localChallenge.challenge)
    )
    channel.receive(await encodeInbound({
      type: 'mesh_auth_proof_v1',
      token_id: inbound.tokenId,
      challenge: localChallenge.challenge,
      proof: remoteProof,
      channel_binding: binding,
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    }))
    await waitForSent(channel, 3)

    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()
    const preAckFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(preAckFrames.filter((frame) => frame.type === 'protocol_hello')).toHaveLength(1)

    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    await waitForSent(channel, 3)
    expect((harness.runtime.peer as any).session.getSnapshot().authenticatedPeerContext).toMatchObject({
      selector: { tokenId: inbound.tokenId, claimantPeerId: 'peer-remote', verifierPeerId: 'local-stable', roomName: 'room-1' }
    })
    const postAckFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(postAckFrames.filter((frame) => frame.type === 'protocol_hello')).toHaveLength(1)
    await harness.runtime.close()
  })

  it('invalidates an unacknowledged outbound proof when the peer starts recovery pairing', async () => {
    const authority = await createTestAuthority(() => 100)
    const inbound = await authority.pairingIssuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const credentialStore = new MemoryPeerCredentialStore()
    await credentialStore.save('peer-remote', {
      tokenId: 'token-row-local',
      claimantPeerId: 'local-stable',
      verifierPeerId: 'peer-remote',
      claimantSignalingPeerId: 'a-local',
      verifierSignalingPeerId: 'z-remote',
      roomName: 'room-1',
      rawBearerToken: 'saved-local-token'
    })
    const harness = makeRuntimeHarness({
      mode: 'webrtc-only',
      credentialStore,
      peerAuthorityResolver: authority.resolver
    })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const localChallenge = await decodeSent(channel, 0)
    const binding = String(localChallenge.channel_binding)
    const remoteProof = await authority.reconnectProof(
      inbound.bearerToken,
      inbound.verifier,
      {
        channelBinding: binding,
        claimantSignalingPeerId: 'z-remote',
        verifierSignalingPeerId: 'a-local'
      },
      String(localChallenge.challenge)
    )

    channel.receive(await encodeInbound({
      type: 'mesh_auth_proof_v1',
      token_id: inbound.tokenId,
      challenge: localChallenge.challenge,
      proof: remoteProof,
      channel_binding: binding,
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    }))
    await flushRuntime()
    await expect(decodeSent(channel, 1)).resolves.toMatchObject({
      type: 'protocol_hello',
      role: 'consumer'
    })

    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()

    channel.receive(await encodeInbound({
      type: 'mesh_auth_challenge_v1',
      challenge: 'b'.repeat(64),
      channel_binding: binding,
      claimant_peer_id: 'local-stable',
      verifier_peer_id: 'peer-remote',
      claimant_signaling_peer_id: 'a-local',
      verifier_signaling_peer_id: 'z-remote',
      room_name: 'room-1'
    }))
    await waitForSent(channel, 3)
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')

    const remote = new PairingSasHandshake({
      channelBindingSha256: binding,
      localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: 'peer-remote', signalingPeerId: 'z-remote', nodeName: 'Remote node' }),
      expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: 'a-local', nodeName: 'Thin Shell' })
    })
    channel.receive(await encodeInbound(await remote.commitMessage()))
    const localCommit = await decodeSent(channel, 3)
    remote.acceptCommit(localCommit)
    const localReveal = await decodeSent(channel, 4)
    await remote.acceptReveal(localReveal)

    // The peer began fresh pairing instead of acknowledging our reconnect
    // proof. A delayed hello from that abandoned proof path must be ignored.
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await flushRuntime()
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()

    channel.receive(await encodeInbound(remote.revealMessage()))
    const pairingStart = await decodeSent(channel, 5)
    expect(pairingStart).toMatchObject({ type: 'call', method: 'Auth.PairingStart' })
    expect(harness.runtime.peer.snapshot().pendingPairing).toBeUndefined()

    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await flushRuntime()
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()
    await harness.runtime.close()
  })

  it('repairs the missing trust direction without treating a reconnect proof as fresh SAS approval', async () => {
    const authority = await createTestAuthority(() => 100)
    const issuer = authority.pairingIssuer
    const issued = await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = authority.resolver
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const challenge = await decodeSent(channel, 0)
    const proof = await authority.reconnectProof(
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
    await waitForSent(channel, 2)
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    expect(harness.runtime.meshTransport).toBeUndefined()
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect((harness.runtime.peer as any).session.options.auth.localSasConfirmed).toBe(false)

    const remote = new PairingSasHandshake({
      channelBindingSha256: String(challenge.channel_binding),
      localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: 'peer-remote', signalingPeerId: 'z-remote', nodeName: 'Remote node' }),
      expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: 'a-local', nodeName: 'Thin Shell' })
    })
    channel.receive(await encodeInbound(await remote.commitMessage()))
    const localCommit = await decodeSent(channel, 2)
    remote.acceptCommit(localCommit)
    const localReveal = await decodeSent(channel, 3)
    const reconnectSas = await remote.acceptReveal(localReveal)
    const remoteReveal = remote.revealMessage()
    channel.receive(await encodeInbound(remoteReveal))
    const missingDirectionStart = await decodeSent(channel, 4)

    expect(missingDirectionStart).toMatchObject({ type: 'call', method: 'Auth.PairingStart' })
    expect(harness.runtime.peer.snapshot().pendingPairing).toBeUndefined()

    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-start-after-proof',
      method: 'Auth.PairingStart',
      params: {
        device_name: 'Remote node',
        remote_peer_id: 'peer-remote',
        remote_node_name: 'Remote node',
        room_name: 'room-1',
        pairing_session_id: reconnectSas.pairingSessionId,
        verification_code: reconnectSas.verificationCode
      }
    }))
    await expect(decodeSent(channel, 5)).resolves.toMatchObject({
      type: 'result',
      id: 'python-start-after-proof',
      result: { status: 'already_trusted' }
    })

    channel.receive(await encodeInbound({
      type: 'result',
      id: missingDirectionStart.id,
      result: {
        code: 'existing-credential',
        status: 'already_trusted',
        pairing_session_id: reconnectSas.pairingSessionId,
        verification_code: reconnectSas.verificationCode
      }
    }))
    await harness.runtime.close()
  })

  it('fails closed with redacted diagnostics when verifier reconnect challenge issuance is unavailable', async () => {
    const resolver = scriptedResolver({
      issueReconnectChallenge: () => {
        throw new Error('Reconnect challenge store is unavailable')
      }
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

  it('falls back to fresh SAS pairing when a saved reconnect credential was removed', async () => {
    const authority = await createTestAuthority()
    const resolver = authority.resolver
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const challenge = await decodeSent(channel, 0)
    channel.receive(await encodeInbound({
      type: 'mesh_auth_proof_v1',
      token_id: 'removed-token-row',
      challenge: challenge.challenge,
      proof: 'a'.repeat(64),
      channel_binding: challenge.channel_binding,
      claimant_peer_id: 'peer-remote',
      verifier_peer_id: 'local-stable',
      claimant_signaling_peer_id: 'z-remote',
      verifier_signaling_peer_id: 'a-local',
      room_name: 'room-1'
    }))

    await waitForSent(channel, 2)
    await expect(decodeSent(channel, 1)).resolves.toMatchObject({ type: 'pairing_v2_commit' })
    await flushRuntime()
    const recoveryFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(recoveryFrames.some((frame) => frame.type === 'protocol_hello')).toBe(false)
    expect(harness.runtime.peer.snapshot().state).not.toBe('failed')
    expect(harness.runtime.peer.snapshot().lastRedactedError).toMatchObject({
      code: 'webrtc_reconnect_credential_stale'
    })
    expect(harness.runtime.meshTransport).toBeUndefined()
    await harness.runtime.close()
  })

  it.each([
    ['stable peer', (frame: Record<string, unknown>) => { frame.claimant_peer_id = 'peer-other' }],
    ['signaling peer', (frame: Record<string, unknown>) => { frame.claimant_signaling_peer_id = 'sig-other' }],
    ['room', (frame: Record<string, unknown>) => { frame.room_name = 'room-other' }],
    ['channel binding', (frame: Record<string, unknown>) => { frame.channel_binding = 'b'.repeat(64) }]
  ] as const)('fails closed for hostile verifier reconnect proof with %s mismatch', async (_name, mutate) => {
    const authority = await createTestAuthority(() => 100)
    const issuer = authority.pairingIssuer
    const issued = await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = authority.resolver
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const challenge = await decodeSent(channel, 0)
    const proof = await authority.reconnectProof(
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
    const authority = await createTestAuthority(() => 200)
    const basePairingIssuer = authority.pairingIssuer
    const pairingIssuer = {
      issue: vi.fn(async (...args: Parameters<typeof basePairingIssuer.issue>) => ({
        ...await basePairingIssuer.issue(...args),
        grantedPermissions: ['Native.ShareText', 'Native.GetDeviceStatus', 'Native.ShareText']
      })),
      rollback: (selector: PeerRelationshipSelector) => basePairingIssuer.rollback(selector)
    }
    const issueCredential = vi.spyOn(pairingIssuer, 'issue')
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerPairingIssuer: pairingIssuer })
    const { channel, remoteSas, pairingStart } = await prepareSasPairing(harness)
    channel.receive(await encodeInbound({ type: 'result', id: pairingStart.id, result: { code: 'opaque-handle', pairing_session_id: remoteSas.pairingSessionId, verification_code: remoteSas.verificationCode } }))
    const confirm = harness.runtime.peer.confirmPairing(remoteSas.pairingSessionId, {
      sharedFeatureIds: ['aurora.local.native.get_device_status.v1']
    })
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
    expect(reverseExchange.result).toMatchObject({
      permissions: ['Native.GetDeviceStatus', 'Native.ShareText']
    })
    const issuedToken = String((reverseExchange.result as Record<string, unknown>).token)
    const issuedTokenId = String((reverseExchange.result as Record<string, unknown>).token_id)
    expect(issueCredential).toHaveBeenCalledWith(
      expect.objectContaining({ claimantPeerId: 'peer-remote', verifierPeerId: 'local-stable' }),
      { featureIds: ['aurora.local.native.get_device_status.v1'] }
    )
    // The verifier now lives inside the Rust authority, so it is read from what
    // the issuer handed back rather than out of a TypeScript store. The point of
    // the assertion is unchanged: what is kept is a hash, and the raw bearer
    // token is not.
    const verifier = (await issueCredential.mock.results.at(-1)?.value)?.verifier
    expect(verifier?.tokenId).toBe(issuedTokenId)
    expect(verifier?.tokenHashHex).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(verifier)).not.toContain(issuedToken)
    channel.receive(await encodeInbound({
      type: 'call',
      id: 'python-exchange-repeat',
      method: 'Auth.PairingExchange',
      params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId }
    }))
    await expect(decodeSent(channel, 9)).resolves.toMatchObject({
      type: 'result',
      id: 'python-exchange-repeat',
      result: { token: issuedToken, token_id: issuedTokenId }
    })
    expect(issueCredential).toHaveBeenCalledTimes(1)

    channel.receive(await encodeInbound({
      type: 'auth',
      peer_name: 'Remote node',
      peer_id: 'peer-remote',
      signaling_peer_id: 'z-remote',
      pairing_session_id: remoteSas.pairingSessionId,
      token: issuedToken
    }))
    expect(harness.runtime.peer.snapshot().state).not.toBe('authorized')
    channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1] })))
    await waitForRuntimeState(harness.runtime, 'authorized')
    expect((harness.runtime.peer as any).session.getSnapshot().authenticatedPeerContext).toMatchObject({
      selector: { tokenId: issuedTokenId, claimantPeerId: 'peer-remote', verifierPeerId: 'local-stable', roomName: 'room-1' },
      transport: { claimantSignalingPeerId: 'z-remote', verifierSignalingPeerId: 'a-local' }
    })
    await harness.runtime.close()
  })

  it('rolls back an inbound credential issued after its transport generation becomes stale', async () => {
    const issueResult = deferred<any>()
    let issuedSelector: any
    const pairingIssuer = {
      issue: vi.fn(async (selector: any) => {
        issuedSelector = selector
        return await issueResult.promise
      }),
      rollback: vi.fn(async () => undefined)
    }
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
      id: 'python-start-stale-issue',
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
    channel.receive(await encodeInbound({ type: 'call', id: 'python-connect-stale-issue', method: 'Auth.PairingConnect', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))
    await decodeSent(channel, 7)
    channel.receive(await encodeInbound({ type: 'call', id: 'python-exchange-stale-issue', method: 'Auth.PairingExchange', params: { code: reverseHandle, pairing_session_id: remoteSas.pairingSessionId } }))

    const issueDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (issuedSelector === undefined) {
      if (Date.now() > issueDeadline) throw new Error('Pairing issuer was not called')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const session = (harness.runtime.peer as any).session
    session.options.auth.resetTransport()
    issueResult.resolve({
      tokenId: issuedSelector.tokenId,
      bearerToken: 'issued-but-not-delivered',
      verifier: {
        version: 1,
        ...issuedSelector,
        tokenHashHex: 'a'.repeat(64),
        createdAtMs: 200,
        credentialRevision: 1
      }
    })
    await flushRuntime()

    expect(pairingIssuer.rollback).toHaveBeenCalledOnce()
    expect(pairingIssuer.rollback).toHaveBeenCalledWith(issuedSelector)
    const sentFrames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(sentFrames.some((frame) => frame.id === 'python-exchange-stale-issue')).toBe(false)
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

  it('falls back to fresh pairing when the remote answers a reconnect challenge with a pairing commit', async () => {
    const authority = await createTestAuthority(() => 100)
    const issuer = authority.pairingIssuer
    await issuer.issue({
      tokenId: 'token-row-remote',
      claimantPeerId: 'peer-remote',
      verifierPeerId: 'local-stable',
      roomName: 'room-1'
    })
    const resolver = authority.resolver
    const harness = makeRuntimeHarness({ mode: 'webrtc-only', peerAuthorityResolver: resolver })

    await harness.runtime.peer.connect(harness.runtimeProfile)
    harness.signaling.emit({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'presence', stable_peer_id: 'peer-remote' } })
    await flushRuntime()
    harness.signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'peer-remote', envelope: { type: 'answer', sdp: 'answer-sdp' } })
    await flushRuntime()
    const channel = harness.pc.channels[0] as RuntimeFakeChannel
    channel.open()
    const challenge = await decodeSent(channel, 0)
    expect(challenge.type).toBe('mesh_auth_challenge_v1')
    expect(harness.runtime.peer.snapshot().state).toBe('reconnect-authenticating')

    // The remote no longer holds a credential for us, so instead of a proof it
    // opens a fresh SAS pairing. The saved approval is unusable, but the
    // transport must survive and re-pair rather than terminate.
    const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: 'a-local', answererSignalingId: 'z-remote', offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
    const remote = new PairingSasHandshake({
      channelBindingSha256: binding,
      localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: 'peer-remote', signalingPeerId: 'z-remote', nodeName: 'Remote node' }),
      expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: 'a-local', nodeName: 'Thin Shell' })
    })
    channel.receive(await encodeInbound(await remote.commitMessage()))
    await flushRuntime()

    await new Promise((resolve) => setTimeout(resolve, 2_000))

    // The saved approval is unusable, but the transport must survive and
    // re-pair instead of terminating or stalling in reconnect.
    const frames = await Promise.all(channel.sent.map((_, index) => decodeSent(channel, index)))
    expect(frames.map((frame) => frame.type)).toEqual([
      'mesh_auth_challenge_v1',
      'pairing_v2_commit',
      'pairing_v2_reveal'
    ])
    expect(harness.runtime.peer.snapshot().state).toBe('awaiting-sas-confirmation')
    await harness.runtime.close()
  })
})

import { CONNECT_IS_SINGLE_PEER_REASON, PEER_ALREADY_REGISTERED_REASON } from '../src/webrtc/peer-registry.js'

interface RuntimeRosterEntry {
  peerId: string
  primary: boolean
  nodeName?: string
  standby?: { reasonCode: string; resumeExpected: boolean; sinceMs: number }
  snapshot: { state: string; pendingPairing?: { sessionId: string; verificationCode: string } }
}

interface RuntimePeerRegistry {
  connectionPolicy(): 'connect' | 'mesh'
  roster(): { peers: RuntimeRosterEntry[]; primaryPeerId?: string; updatedAt: string }
  subscribeRoster(listener: (roster: { peers: RuntimeRosterEntry[]; primaryPeerId?: string }) => void): () => void
  connectPeer(profile: WebRtcPeerConnectionProfile): Promise<void>
  disconnectPeer(peerId: string, reason?: string): Promise<void>
  setPeerPriority(peerId: string, priority: { userPinned?: boolean; dependedUpon?: boolean }): void
  applyConnectionBudget?(reason?: 'connection_budget' | 'surface_suspended' | 'user_requested'): Promise<void>
  nativeDataChannelCodec(peerId: string): {
    version: 'aes-256-gcm-nonce-prefix-v1'
    key: Uint8Array
  } | null
}

interface MultiPeerHarness {
  runtime: BrowserWebRtcRuntime
  registry: RuntimePeerRegistry
  store: MemoryPeerCredentialStore
  nodeSignalingId: string
  signalings: RuntimeFakeSignaling[]
  connections: RuntimeFakePeerConnection[]
}

function meshPeerProfile(peerId: string | undefined, signalingPeerId: string, nodeName: string): WebRtcPeerConnectionProfile {
  const next = profile({ mode: 'webrtc-only', expectedSignalingPeerId: signalingPeerId, nodeName })
  if (peerId === undefined) delete (next as { expectedStablePeerId?: string }).expectedStablePeerId
  else next.expectedStablePeerId = peerId
  return next
}

function makeMultiPeerHarness(
  localSignalingIds: string[],
  peerConnectionPolicyOrOptions?: 'connect' | 'mesh' | {
    nodeRole?: 'remote-console' | 'mesh-node'
    peerConnectionPolicy?: 'connect' | 'mesh'
    peerConnectionBudget?: {
      foregroundPeerLimit: number | null
      backgroundPeerLimit: number | null
      backgroundStandbyReason?: 'connection_budget' | 'surface_suspended'
    }
    visibilityDocument?: BrowserWebRtcRuntimeOptions['visibilityDocument']
    signalingConnect?: (signaling: RuntimeFakeSignaling, index: number) => Promise<void>
    remoteDescriptionGate?: Promise<void>
  },
): MultiPeerHarness {
  const harnessOptions = typeof peerConnectionPolicyOrOptions === 'string'
    ? { peerConnectionPolicy: peerConnectionPolicyOrOptions }
    : peerConnectionPolicyOrOptions ?? {}
  const signalings: RuntimeFakeSignaling[] = []
  const connections: RuntimeFakePeerConnection[] = []
  const store = new MemoryPeerCredentialStore()
  const queuedLocalIds = [...localSignalingIds]
  let rpc = 0
  const runtime = createBrowserWebRtcAuroraRuntime({
    mode: 'webrtc-only',
    localStablePeerId: 'local-stable',
    localNodeName: 'Thin Shell',
    credentialStore: store,
    pairingConnectPoll: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, rpcTimeoutMs: 1_000 },
    signalingFactory: () => {
      const next = new RuntimeFakeSignaling()
      const index = signalings.length
      if (harnessOptions.signalingConnect !== undefined) {
        next.connect = vi.fn(async () => await harnessOptions.signalingConnect!(next, index))
      }
      signalings.push(next)
      return next as any
    },
    createPeerConnection: () => {
      const next = new RuntimeFakePeerConnection(
        'offer-sdp',
        'answer-sdp',
        harnessOptions.remoteDescriptionGate,
      )
      connections.push(next)
      return next
    },
    scryptDeriver: async () => new Uint8Array(32).fill(7),
    randomId: () => queuedLocalIds.shift() ?? `rpc-${rpc++}`,
    ...(harnessOptions.peerConnectionPolicy !== undefined ? { peerConnectionPolicy: harnessOptions.peerConnectionPolicy } : {}),
    ...(harnessOptions.nodeRole !== undefined ? { nodeRole: harnessOptions.nodeRole } : {}),
    ...(harnessOptions.peerConnectionBudget !== undefined ? { peerConnectionBudget: harnessOptions.peerConnectionBudget } : {}),
    ...(harnessOptions.visibilityDocument !== undefined ? { visibilityDocument: harnessOptions.visibilityDocument } : {}),
    windowLocation: secureLocation
  })
  return {
    runtime,
    registry: runtime.peer as unknown as RuntimePeerRegistry,
    store,
    nodeSignalingId: localSignalingIds[0] ?? 'a-node',
    signalings,
    connections,
  }
}

async function saveMeshPeerCredential(
  harness: MultiPeerHarness,
  peerId: string,
  _localSignalingId: string,
  remoteSignalingId: string
): Promise<void> {
  await harness.store.save(peerId, {
    tokenId: `token-row-${peerId}`,
    claimantPeerId: 'local-stable',
    verifierPeerId: peerId,
    claimantSignalingPeerId: harness.nodeSignalingId,
    verifierSignalingPeerId: remoteSignalingId,
    roomName: 'room-1',
    rawBearerToken: `saved-token-${peerId}`
  })
}

async function openMeshPeerChannel(
  harness: MultiPeerHarness,
  index: number,
  peerId: string,
  remoteSignalingId: string
): Promise<RuntimeFakeChannel> {
  const signaling = harness.signalings.at(-1) as RuntimeFakeSignaling
  signaling.emit({ channel: 'presence', from: remoteSignalingId, stablePeerId: peerId, envelope: { type: 'presence', stable_peer_id: peerId } })
  await flushRuntime()
  signaling.emit({ channel: 'answer', from: remoteSignalingId, stablePeerId: peerId, envelope: { type: 'answer', sdp: 'answer-sdp' } })
  await flushRuntime()
  const channel = (harness.connections[index] as RuntimeFakePeerConnection).channels[0] as RuntimeFakeChannel
  channel.open()
  await flushRuntime()
  return channel
}

async function authorizeMeshPeer(
  harness: MultiPeerHarness,
  index: number,
  peerId: string,
  _localSignalingId: string,
  remoteSignalingId: string
): Promise<RuntimeFakeChannel> {
  const channel = await openMeshPeerChannel(harness, index, peerId, remoteSignalingId)
  const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: harness.nodeSignalingId, answererSignalingId: remoteSignalingId, offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
  channel.receive(await encodeInbound({
    type: 'mesh_auth_challenge_v1',
    challenge: 'a'.repeat(64),
    channel_binding: binding,
    claimant_peer_id: 'local-stable',
    verifier_peer_id: peerId,
    claimant_signaling_peer_id: harness.nodeSignalingId,
    verifier_signaling_peer_id: remoteSignalingId,
    room_name: 'room-1'
  }))
  expect(await decodeSent(channel, 0)).toMatchObject({ type: 'mesh_auth_proof_v1', verifier_peer_id: peerId })
  channel.receive(await encodeInbound(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] })))
  await waitForSent(channel, 2)
  return channel
}

async function driveMeshSasPrompt(
  harness: MultiPeerHarness,
  index: number,
  peerId: string,
  _localSignalingId: string,
  remoteSignalingId: string,
  nodeName: string
): Promise<{ channel: RuntimeFakeChannel; remoteSas: Awaited<ReturnType<PairingSasHandshake['acceptReveal']>> }> {
  const channel = await openMeshPeerChannel(harness, index, peerId, remoteSignalingId)
  const localCommit = await decodeSent(channel, 0)
  expect(localCommit.type).toBe('pairing_v2_commit')
  const binding = await deriveChannelBinding({ appId: 'aurora', room: 'room-1', offererSignalingId: harness.nodeSignalingId, answererSignalingId: remoteSignalingId, offerSdp: 'offer-sdp', answerSdp: 'answer-sdp' })
  const remote = new PairingSasHandshake({
    channelBindingSha256: binding,
    localIdentity: pairingIdentity({ role: 'answerer', stablePeerId: peerId, signalingPeerId: remoteSignalingId, nodeName }),
    expectedRemoteIdentity: pairingIdentity({ role: 'offerer', stablePeerId: 'local-stable', signalingPeerId: harness.nodeSignalingId, nodeName: 'Thin Shell' })
  })
  remote.acceptCommit(localCommit)
  channel.receive(await encodeInbound(await remote.commitMessage()))
  await flushRuntime()
  const localReveal = await decodeSent(channel, 1)
  expect(localReveal.type).toBe('pairing_v2_reveal')
  const remoteSas = await remote.acceptReveal(localReveal)
  channel.receive(await encodeInbound(remote.revealMessage()))
  await waitForSent(channel, 3)
  return { channel, remoteSas }
}

describe('browser WebRTC runtime peer registry', {
  timeout: RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS + 5_000,
}, () => {
  it('multiplexes every mesh peer behind one node signaling identity', async () => {
    const harness = makeMultiPeerHarness(['a-node'], 'mesh')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))

    expect(harness.signalings).toHaveLength(1)
    const signaling = harness.signalings[0] as RuntimeFakeSignaling
    signaling.emit({
      channel: 'presence',
      from: 'z-alpha',
      stablePeerId: 'peer-alpha',
      envelope: { type: 'presence', stable_peer_id: 'peer-alpha' },
    })
    signaling.emit({
      channel: 'presence',
      from: 'z-beta',
      stablePeerId: 'peer-beta',
      envelope: { type: 'presence', stable_peer_id: 'peer-beta' },
    })
    await flushRuntime()

    expect(signaling.sent.filter((message) => message.channel === 'offer')).toEqual([
      expect.objectContaining({ toPeer: 'z-alpha' }),
      expect.objectContaining({ toPeer: 'z-beta' }),
    ])
    expect(harness.registry.roster().peers.map((entry) => [
      entry.peerId,
      entry.snapshot.state,
    ])).toEqual([
      ['peer-alpha', 'negotiating'],
      ['peer-beta', 'negotiating'],
    ])

    await harness.registry.disconnectPeer('peer-alpha', 'alpha left')
    expect(signaling.close).not.toHaveBeenCalled()
    await harness.registry.disconnectPeer('peer-beta', 'beta left')
    expect(signaling.close).toHaveBeenCalledTimes(1)

    await harness.runtime.close()
  })

  it('replays retained room presence when a later mesh session joins the shared signaling hub', async () => {
    const harness = makeMultiPeerHarness(['a-node'], 'mesh')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const signaling = harness.signalings[0] as RuntimeFakeSignaling

    signaling.emit({
      channel: 'presence',
      from: 'z-beta',
      stablePeerId: 'peer-beta',
      envelope: { type: 'presence', stable_peer_id: 'peer-beta' },
    })
    await flushRuntime()
    expect(signaling.sent.filter((message) => message.channel === 'offer')).toEqual([])

    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))

    expect(signaling.sent.filter((message) => message.channel === 'offer')).toEqual([
      expect.objectContaining({ toPeer: 'z-beta' }),
    ])
    await harness.runtime.close()
  })

  it('auto-materializes a mesh-node session for a targeted inbound offer', async () => {
    let releaseRemoteDescription!: () => void
    const remoteDescriptionGate = new Promise<void>((resolve) => {
      releaseRemoteDescription = resolve
    })
    const harness = makeMultiPeerHarness(['a-node'], {
      nodeRole: 'mesh-node',
      peerConnectionPolicy: 'mesh',
      remoteDescriptionGate,
    })
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const signaling = harness.signalings[0] as RuntimeFakeSignaling

    signaling.emit({
      channel: 'offer',
      from: 'z-beta',
      stablePeerId: 'peer-beta',
      envelope: {
        type: 'offer',
        stable_peer_id: 'peer-beta',
        node_name: 'Beta node',
        sdp: 'remote-beta-offer-sdp',
      },
    })
    signaling.emit({
      channel: 'candidate',
      from: 'z-beta',
      stablePeerId: 'peer-beta',
      envelope: {
        type: 'candidate',
        stable_peer_id: 'peer-beta',
        candidate: 'candidate:1 1 UDP 1 127.0.0.1 12345 typ host',
        sdp_mid: '0',
        sdp_mline_index: 0,
      },
    })
    await vi.waitFor(() => expect(harness.connections).toHaveLength(1))
    expect(harness.connections.at(-1)?.candidates).toEqual([])
    releaseRemoteDescription()
    await vi.waitFor(() => expect(signaling.sent.some((message) => message.channel === 'answer' && message.toPeer === 'z-beta')).toBe(true))

    expect(harness.signalings).toHaveLength(1)
    const betaEntry = harness.registry.roster().peers.find((entry) => entry.peerId === 'peer-beta')
    expect(betaEntry).toMatchObject({
      nodeName: 'Beta node',
      snapshot: {
        expectedStablePeerId: 'peer-beta',
        connectedStablePeerId: 'peer-beta',
        connectedSignalingPeerId: 'z-beta',
        negotiationRole: 'answerer',
        state: 'negotiating',
      },
    })
    expect(harness.connections.at(-1)?.remoteDescription).toEqual({ type: 'offer', sdp: 'remote-beta-offer-sdp' })
    expect(harness.connections.at(-1)?.candidates).toEqual([
      expect.objectContaining({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 12345 typ host' }),
    ])
    expect(signaling.sent).toEqual([
      expect.objectContaining({
        channel: 'answer',
        envelope: expect.objectContaining({ to: 'z-beta', sdp: 'answer-sdp' }),
        toPeer: 'z-beta',
      }),
    ])

    await harness.runtime.close()
  })

  it('does not auto-materialize inbound offers for remote-console mode', async () => {
    const harness = makeMultiPeerHarness(['z-node'], { nodeRole: 'remote-console', peerConnectionPolicy: 'mesh' })
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'a-alpha', 'Alpha node'))
    const signaling = harness.signalings[0] as RuntimeFakeSignaling

    signaling.emit({
      channel: 'offer',
      from: 'a-beta',
      stablePeerId: 'peer-beta',
      envelope: {
        type: 'offer',
        stable_peer_id: 'peer-beta',
        node_name: 'Beta node',
        sdp: 'remote-beta-offer-sdp',
      },
    })
    await flushRuntime()

    expect(harness.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha'])
    expect(harness.connections).toHaveLength(0)
    expect(signaling.sent).toEqual([])

    await harness.runtime.close()
  })

  it('closes an in-flight shared signaling acquisition exactly once when it resolves late', async () => {
    let resolveConnect!: () => void
    const connectGate = new Promise<void>((resolve) => { resolveConnect = resolve })
    const harness = makeMultiPeerHarness(['a-node'], {
      peerConnectionPolicy: 'mesh',
      signalingConnect: async () => await connectGate,
    })
    const connecting = harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await vi.waitFor(() => expect(harness.signalings[0]?.connect).toHaveBeenCalledOnce())

    const closing = harness.runtime.close()
    resolveConnect()
    await Promise.all([connecting, closing])

    expect(harness.signalings[0]?.close).toHaveBeenCalledTimes(1)
    expect(harness.registry.roster().peers).toEqual([])
  })

  it('closes an in-flight shared signaling acquisition exactly once when it rejects late', async () => {
    let rejectConnect!: (error: Error) => void
    const connectGate = new Promise<void>((_resolve, reject) => { rejectConnect = reject })
    const harness = makeMultiPeerHarness(['a-node'], {
      peerConnectionPolicy: 'mesh',
      signalingConnect: async () => await connectGate,
    })
    const connecting = harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await vi.waitFor(() => expect(harness.signalings[0]?.connect).toHaveBeenCalledOnce())

    const closing = harness.runtime.close()
    rejectConnect(new Error('signaling unavailable'))
    await Promise.all([connecting, closing])

    expect(harness.signalings[0]?.close).toHaveBeenCalledTimes(1)
    expect(harness.registry.roster().peers).toEqual([])
  })

  it('clones only the active data-channel key for trusted native composition', async () => {
    const harness = makeMultiPeerHarness(['a-alpha'])
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))

    const first = harness.registry.nativeDataChannelCodec('peer-alpha')
    expect(first).toMatchObject({ version: 'aes-256-gcm-nonce-prefix-v1' })
    expect(first?.key).toHaveLength(32)
    expect(JSON.stringify(harness.registry.roster())).not.toContain('key')

    first?.key.fill(0)
    const second = harness.registry.nativeDataChannelCodec('peer-alpha')
    expect(second?.key.some((byte) => byte !== 0)).toBe(true)
    expect(harness.registry.nativeDataChannelCodec('unknown-peer')).toBeNull()

    second?.key.fill(0)
    await harness.runtime.close()
    expect(harness.registry.nativeDataChannelCodec('peer-alpha')).toBeNull()
  })

  it('does not install a native encrypted codec when app-layer E2EE is disabled', async () => {
    const harness = makeMultiPeerHarness(['a-alpha'])
    await harness.registry.connectPeer({
      ...meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'),
      requireAppLayerE2ee: false
    })

    expect(harness.registry.nativeDataChannelCodec('peer-alpha')).toBeNull()
    await harness.runtime.close()
  })

  it('holds two authorized sessions at once and derives the single-peer snapshot from the primary', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta'])
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')

    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    expect(harness.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha', 'peer-beta'])

    await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')

    const roster = harness.registry.roster()
    expect(roster.peers.map((entry) => [entry.peerId, entry.snapshot.state])).toEqual([
      ['peer-alpha', 'authorized'],
      ['peer-beta', 'authorized']
    ])
    expect(roster.primaryPeerId).toBe('peer-alpha')
    expect(roster.peers.filter((entry) => entry.primary).map((entry) => entry.peerId)).toEqual(['peer-alpha'])
    // The single-peer snapshot stays a derived view of the primary entry.
    expect(harness.runtime.peer.snapshot()).toMatchObject({
      state: 'authorized',
      expectedStablePeerId: 'peer-alpha',
      connectedStablePeerId: 'peer-alpha',
      nodeName: 'Alpha node'
    })
    await expect(harness.runtime.transport.request({
      method: 'Gateway.GetRegistry',
      busTopic: 'Gateway.GetRegistry'
    })).rejects.toMatchObject({
      code: 'unavailable_service',
      detail: expect.objectContaining({ reason_code: 'no_route' })
    })

    await harness.runtime.close()
    expect(harness.registry.roster().peers).toEqual([])
  })

  it('keeps a Connect surface on one device by policy while the same registry holds a mesh', async () => {
    const connectOnly = makeMultiPeerHarness(['a-alpha', 'a-beta'], 'connect')
    expect(connectOnly.registry.connectionPolicy()).toBe('connect')
    await connectOnly.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))

    await expect(connectOnly.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node')))
      .rejects.toMatchObject({ detail: { reason_code: CONNECT_IS_SINGLE_PEER_REASON, peer_id: 'peer-beta' } })
    // The refusal is a policy decision, so the device already connected is left alone.
    expect(connectOnly.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha'])

    // Dropping the one it holds frees the surface to connect a different device.
    await connectOnly.registry.disconnectPeer('peer-alpha', 'switching devices')
    await connectOnly.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    expect(connectOnly.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-beta'])
    await connectOnly.runtime.close()

    // Nothing structural stops several: the same registry holds a mesh.
    const mesh = makeMultiPeerHarness(['a-alpha', 'a-beta'], 'mesh')
    expect(mesh.registry.connectionPolicy()).toBe('mesh')
    await mesh.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await mesh.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    expect(mesh.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha', 'peer-beta'])
    await mesh.runtime.close()
  })

  it('keeps pairing state independent per peer and drops only the rejected one', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta'])
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))

    const alpha = await driveMeshSasPrompt(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha', 'Alpha node')
    const beta = await driveMeshSasPrompt(harness, 1, 'peer-beta', 'a-beta', 'z-beta', 'Beta node')
    expect(alpha.remoteSas.pairingSessionId).not.toBe(beta.remoteSas.pairingSessionId)

    const prompts = new Map(harness.registry.roster().peers.map((entry) => [entry.peerId, entry.snapshot.pendingPairing]))
    expect(prompts.get('peer-alpha')).toMatchObject({ sessionId: alpha.remoteSas.pairingSessionId, verificationCode: alpha.remoteSas.verificationCode })
    expect(prompts.get('peer-beta')).toMatchObject({ sessionId: beta.remoteSas.pairingSessionId, verificationCode: beta.remoteSas.verificationCode })
    // No entry is authorized yet, so the derived view follows the newest entry.
    expect(harness.runtime.peer.snapshot().pendingPairing).toMatchObject({ sessionId: beta.remoteSas.pairingSessionId })

    await harness.runtime.peer.rejectPairing(beta.remoteSas.pairingSessionId)
    expect(harness.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha'])
    expect(harness.runtime.peer.snapshot().pendingPairing).toMatchObject({ sessionId: alpha.remoteSas.pairingSessionId })

    await harness.runtime.close()
  })

  it('refuses a second session for a stable peer id the registry already holds', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-clone'])
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))

    await expect(harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-clone', 'Alpha clone')))
      .rejects.toMatchObject({
        code: 'validation',
        detail: { reason_code: PEER_ALREADY_REGISTERED_REASON, peer_id: 'peer-alpha' }
      })
    expect(harness.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha'])
    // The refusal lands before any second signaling client or transport exists.
    expect(harness.signalings).toHaveLength(1)

    await harness.runtime.close()
  })

  it('refuses a known stable identity that presents on a second transport', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-ghost'])
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await openMeshPeerChannel(harness, 0, 'peer-alpha', 'z-alpha')
    expect(harness.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha'])

    // A second transport with no invited stable id announces itself as peer-alpha.
    await harness.registry.connectPeer(meshPeerProfile(undefined, 'z-ghost', 'Alpha node'))
    expect(harness.registry.roster().peers).toHaveLength(2)
    const ghostSignaling = harness.signalings.at(-1) as RuntimeFakeSignaling
    ghostSignaling.emit({ channel: 'presence', from: 'z-ghost', stablePeerId: 'peer-alpha', envelope: { type: 'presence', stable_peer_id: 'peer-alpha' } })
    await flushRuntime()

    expect(harness.registry.roster().peers.map((entry) => entry.peerId)).toEqual(['peer-alpha'])
    expect(harness.runtime.peer.snapshot().lastRedactedError).toMatchObject({ code: 'webrtc_peer_already_connected' })

    await harness.runtime.close()
  })

  it('drops one peer without disturbing the rest of the registry', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta'])
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')

    await harness.registry.disconnectPeer('peer-alpha', 'forgotten')
    const roster = harness.registry.roster()
    expect(roster.peers.map((entry) => [entry.peerId, entry.snapshot.state])).toEqual([['peer-beta', 'authorized']])
    expect(roster.primaryPeerId).toBe('peer-beta')
    expect(harness.runtime.meshTransport).toBeDefined()

    await harness.runtime.close()
  })

  it('sheds over-budget mesh peers by pin, dependency and recency after announcing standby', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta', 'a-gamma', 'a-gamma-return'], {
      peerConnectionPolicy: 'mesh',
      peerConnectionBudget: { foregroundPeerLimit: 2, backgroundPeerLimit: 1 }
    })
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await saveMeshPeerCredential(harness, 'peer-gamma', 'a-gamma', 'z-gamma')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-gamma', 'z-gamma', 'Gamma node'))
    harness.registry.setPeerPriority('peer-alpha', { userPinned: true })
    harness.registry.setPeerPriority('peer-beta', { dependedUpon: true })
    const alpha = await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    const beta = await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')
    const gamma = await authorizeMeshPeer(harness, 2, 'peer-gamma', 'a-gamma', 'z-gamma')

    await harness.registry.applyConnectionBudget?.('connection_budget')
    await flushRuntime()

    expect(harness.registry.roster().peers.map((entry) => [entry.peerId, entry.standby?.reasonCode ?? null])).toEqual([
      ['peer-alpha', null],
      ['peer-beta', null],
      ['peer-gamma', 'connection_budget']
    ])
    const gammaFrames = await Promise.all(gamma.sent.map((_, index) => decodeSent(gamma, index)))
    expect(gammaFrames).toContainEqual(expect.objectContaining({
      type: 'mesh_peer_standby_v1',
      peer_id: 'local-stable',
      reason_code: 'connection_budget',
      resume_expected: true
    }))
    expect(alpha.readyState).toBe('open')
    expect(beta.readyState).toBe('open')

    await saveMeshPeerCredential(harness, 'peer-gamma', 'a-gamma-return', 'z-gamma')
    await harness.registry.connectPeer(meshPeerProfile('peer-gamma', 'z-gamma', 'Gamma node'))
    const returningGamma = await openMeshPeerChannel(harness, 3, 'peer-gamma', 'z-gamma')
    const returningTypes = await Promise.all(returningGamma.sent.map((_, index) => decodeSent(returningGamma, index).then((frame) => frame.type)))
    expect(returningTypes).not.toContain('pairing_v2_commit')

    await harness.runtime.close()
  })

  it('keeps a user-pinned peer ahead of a depended-upon peer', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta'], {
      peerConnectionPolicy: 'mesh',
      peerConnectionBudget: { foregroundPeerLimit: 1, backgroundPeerLimit: 1 }
    })
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    harness.registry.setPeerPriority('peer-alpha', { userPinned: true })
    harness.registry.setPeerPriority('peer-beta', { dependedUpon: true })
    await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    const beta = await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')
    await harness.registry.applyConnectionBudget?.()

    expect(harness.registry.roster().peers.map((entry) => [entry.peerId, entry.standby?.reasonCode ?? null])).toEqual([
      ['peer-alpha', null],
      ['peer-beta', 'connection_budget']
    ])
    const betaFrames = await Promise.all(beta.sent.map((_, index) => decodeSent(beta, index)))
    expect(betaFrames).toContainEqual(expect.objectContaining({
      type: 'mesh_peer_standby_v1',
      reason_code: 'connection_budget'
    }))

    await harness.runtime.close()
  })

  it('keeps a peer with an active route ahead of a newer idle peer', async () => {
    const harness = makeMultiPeerHarness(['a-beta', 'a-alpha'], {
      peerConnectionPolicy: 'mesh',
      peerConnectionBudget: { foregroundPeerLimit: 1, backgroundPeerLimit: 1 }
    })
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    const beta = await authorizeMeshPeer(harness, 0, 'peer-beta', 'a-beta', 'z-beta')

    const callIndex = beta.sent.length
    const pending = harness.runtime.transport.request({
      method: 'Gateway.GetRegistry',
      busTopic: 'Gateway.GetRegistry',
      payload: { selector: { peer_id: 'peer-beta' } }
    })
    const call = await decodeSent(beta, callIndex)
    expect(call).toMatchObject({ type: 'call', method: 'Gateway.GetRegistry' })

    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const alpha = await authorizeMeshPeer(harness, 1, 'peer-alpha', 'a-alpha', 'z-alpha')
    const shedDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (!harness.registry.roster().peers.find((entry) => entry.peerId === 'peer-alpha')?.standby) {
      if (Date.now() > shedDeadline) throw new Error('Active-route priority did not shed the idle peer')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const alphaFrames = await Promise.all(alpha.sent.map((_, index) => decodeSent(alpha, index)))
    expect(alphaFrames).toContainEqual(expect.objectContaining({
      type: 'mesh_peer_standby_v1',
      reason_code: 'connection_budget'
    }))

    beta.receive(await encodeInbound({
      type: 'result',
      id: call.id,
      correlation_id: call.correlation_id,
      result: { data: { ok: true }, status: 200 }
    }))
    await expect(pending).resolves.toMatchObject({ data: { ok: true } })
    await harness.runtime.close()
  })

  it('uses the iOS suspend reason in background and resumes with the existing credential', async () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    let visibilityListener: (() => void) | undefined
    const visibilityDocument = {
      get visibilityState() { return visibilityState },
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        visibilityListener = typeof listener === 'function'
          ? () => listener(new Event('visibilitychange'))
          : () => listener.handleEvent(new Event('visibilitychange'))
      }),
      removeEventListener: vi.fn()
    } as unknown as BrowserWebRtcRuntimeOptions['visibilityDocument']
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta', 'a-beta-return'], {
      peerConnectionPolicy: 'mesh',
      peerConnectionBudget: {
        foregroundPeerLimit: 2,
        backgroundPeerLimit: 1,
        backgroundStandbyReason: 'surface_suspended'
      },
      visibilityDocument
    })
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    harness.registry.setPeerPriority('peer-alpha', { userPinned: true })
    await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    const beta = await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')

    visibilityState = 'hidden'
    visibilityListener?.()
    const suspendedDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (harness.registry.roster().peers.find((entry) => entry.peerId === 'peer-beta')?.standby === undefined) {
      if (Date.now() > suspendedDeadline) throw new Error('iOS background budget did not suspend the excess peer')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const betaFrames = await Promise.all(beta.sent.map((_, index) => decodeSent(beta, index)))
    expect(betaFrames).toContainEqual(expect.objectContaining({
      type: 'mesh_peer_standby_v1',
      reason_code: 'surface_suspended',
      resume_expected: true
    }))

    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta-return', 'z-beta')
    visibilityState = 'visible'
    visibilityListener?.()
    const resumeDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (harness.connections.length < 3) {
      if (Date.now() > resumeDeadline) throw new Error('iOS foreground did not resume the suspended peer')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const returning = await openMeshPeerChannel(harness, 2, 'peer-beta', 'z-beta')
    const returningTypes = await Promise.all(
      returning.sent.map((_, index) => decodeSent(returning, index).then((frame) => frame.type))
    )
    expect(returningTypes.filter((type) => String(type).startsWith('pairing_v2_'))).toEqual([])

    await harness.runtime.close()
  })

  it('uses the suspend reason when a peer is authorized after the surface is already hidden', async () => {
    const visibilityDocument = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as BrowserWebRtcRuntimeOptions['visibilityDocument']
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta'], {
      peerConnectionPolicy: 'mesh',
      peerConnectionBudget: {
        foregroundPeerLimit: 2,
        backgroundPeerLimit: 1,
        backgroundStandbyReason: 'surface_suspended'
      },
      visibilityDocument
    })
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    harness.registry.setPeerPriority('peer-alpha', { userPinned: true })
    await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    const beta = await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')

    const suspendedDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (harness.registry.roster().peers.find((entry) => entry.peerId === 'peer-beta')?.standby === undefined) {
      if (Date.now() > suspendedDeadline) throw new Error('Hidden surface did not suspend the excess peer')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const betaFrames = await Promise.all(beta.sent.map((_, index) => decodeSent(beta, index)))
    expect(betaFrames).toContainEqual(expect.objectContaining({
      type: 'mesh_peer_standby_v1',
      reason_code: 'surface_suspended'
    }))

    await harness.runtime.close()
  })

  it('keeps a remote standby row and credential distinct from a lost peer', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-alpha-return'])
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const alpha = await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')

    alpha.receive(await encodeInbound({
      type: 'mesh_peer_standby_v1',
      peer_id: 'peer-alpha',
      reason_code: 'surface_suspended',
      resume_expected: true
    }))
    const standbyDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (!harness.registry.roster().peers[0]?.standby) {
      if (Date.now() > standbyDeadline) throw new Error('Remote standby was not projected into the roster')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    expect(harness.registry.roster().peers).toEqual([
      expect.objectContaining({
        peerId: 'peer-alpha',
        standby: expect.objectContaining({
          reasonCode: 'surface_suspended',
          resumeExpected: true
        })
      })
    ])
    expect(await harness.store.get('peer-alpha')).toBeDefined()

    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha-return', 'z-alpha')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const returning = await openMeshPeerChannel(harness, 1, 'peer-alpha', 'z-alpha')
    const returningTypes = await Promise.all(
      returning.sent.map((_, index) => decodeSent(returning, index).then((frame) => frame.type))
    )
    expect(returningTypes.filter((type) => String(type).startsWith('pairing_v2_'))).toEqual([])

    await harness.runtime.close()
  })

  it('restores the remembered standby row when reconnect setup fails', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-alpha-return'])
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const alpha = await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')

    alpha.receive(await encodeInbound({
      type: 'mesh_peer_standby_v1',
      peer_id: 'peer-alpha',
      reason_code: 'surface_suspended',
      resume_expected: true
    }))
    const standbyDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (!harness.registry.roster().peers[0]?.standby) {
      if (Date.now() > standbyDeadline) throw new Error('Remote standby was not retained before reconnect')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    const returningSignaling = harness.signalings.at(-1) as RuntimeFakeSignaling
    returningSignaling.emit({
      channel: 'presence',
      from: 'z-alpha',
      stablePeerId: 'peer-alpha',
      envelope: { type: 'presence', stable_peer_id: 'peer-alpha' }
    })
    await flushRuntime()
    returningSignaling.emit({
      channel: 'answer',
      from: 'z-alpha',
      stablePeerId: 'peer-alpha',
      envelope: { type: 'answer', stable_peer_id: 'peer-alpha' }
    })
    const restoreDeadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
    while (!harness.registry.roster().peers[0]?.standby) {
      if (Date.now() > restoreDeadline) throw new Error('Failed resume did not restore the standby row')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(harness.registry.roster().peers).toEqual([
      expect.objectContaining({
        peerId: 'peer-alpha',
        standby: expect.objectContaining({
          reasonCode: 'surface_suspended',
          resumeExpected: true
        })
      })
    ])
    expect(await harness.store.get('peer-alpha')).toBeDefined()

    await harness.runtime.close()
  })
})

import { MeshPeerBridgeRouter, PEER_NOT_REGISTERED_REASON } from '../src/webrtc/mesh-bridge-router.js'

async function waitForCallFrame(channel: RuntimeFakeChannel, method: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS
  for (;;) {
    for (let index = 0; index < channel.sent.length; index += 1) {
      const frame = await decodeSent(channel, index)
      if (frame.type === 'call' && frame.method === method) return frame
    }
    if (Date.now() > deadline) throw new Error(`No ${method} call frame was sent`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('browser WebRTC runtime mesh bridge router', {
  timeout: RUNTIME_ASYNC_ASSERTION_TIMEOUT_MS + 5_000,
}, () => {
  it('releases route priority when a subscription fails before iteration starts', async () => {
    let rejectReady: ((error: Error) => void) | undefined
    const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject })
    const source = Object.assign((async function* () {})(), { ready })
    let activeRoutes = 0
    const router = new MeshPeerBridgeRouter({
      resolve: () => ({
        call: vi.fn(),
        subscribe: () => source,
      }),
      onRouteStart: () => { activeRoutes += 1 },
      onRouteEnd: () => { activeRoutes -= 1 },
    })

    const subscription = router.subscribe({
      peerId: 'peer-alpha',
      stream: 'Gateway.Events',
      topics: ['Gateway.Events'],
      kinds: [],
      candidates: [],
    }) as AsyncIterable<unknown> & { ready: Promise<void> }
    expect(activeRoutes).toBe(1)

    rejectReady?.(new Error('subscription setup failed'))
    await expect(subscription.ready).rejects.toThrow('subscription setup failed')
    expect(activeRoutes).toBe(0)
    for await (const _event of subscription) {
      throw new Error('failed subscription unexpectedly yielded an event')
    }
    expect(activeRoutes).toBe(0)
  })

  it('releases route priority when a ready subscription is aborted before iteration', async () => {
    const controller = new AbortController()
    const source = Object.assign((async function* () {})(), { ready: Promise.resolve() })
    let activeRoutes = 0
    const router = new MeshPeerBridgeRouter({
      resolve: () => ({
        call: vi.fn(),
        subscribe: () => source,
      }),
      onRouteStart: () => { activeRoutes += 1 },
      onRouteEnd: () => { activeRoutes -= 1 },
    })

    const subscription = router.subscribe({
      peerId: 'peer-alpha',
      stream: 'Gateway.Events',
      topics: ['Gateway.Events'],
      kinds: [],
      candidates: [],
      signal: controller.signal,
    }) as AsyncIterable<unknown> & { ready: Promise<void> }
    await subscription.ready
    expect(activeRoutes).toBe(1)

    controller.abort()
    expect(activeRoutes).toBe(0)
  })

  it('answers a request naming the second peer on that peer while the first stays connected', async () => {
    const harness = makeMultiPeerHarness(['a-alpha', 'a-beta'])
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await saveMeshPeerCredential(harness, 'peer-beta', 'a-beta', 'z-beta')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await harness.registry.connectPeer(meshPeerProfile('peer-beta', 'z-beta', 'Beta node'))
    const alpha = await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')
    const beta = await authorizeMeshPeer(harness, 1, 'peer-beta', 'a-beta', 'z-beta')
    const alphaFrameCount = alpha.sent.length

    const mesh = harness.runtime.meshTransport
    expect(mesh).toBeDefined()
    const pending = mesh!.request<{ answered_by: string }>({
      method: 'Gateway.GetRegistry',
      busTopic: 'Gateway.GetRegistry',
      payload: { selector: { peer_id: 'peer-beta' } }
    })
    const call = await waitForCallFrame(beta, 'Gateway.GetRegistry')
    beta.receive(await encodeInbound({ type: 'result', id: call.id, correlation_id: call.id, result: { answered_by: 'peer-beta' } }))

    const response = await pending
    expect(response.data).toEqual({ answered_by: 'peer-beta' })
    expect(response.audit).toMatchObject({ targetPeerId: 'peer-beta', transport: 'mesh' })
    // The default route still points at the primary, and peer A saw no traffic.
    expect(alpha.sent).toHaveLength(alphaFrameCount)

    await harness.runtime.close()
  })

  it('fails an unroutable peer id with a typed registry error rather than a bare throw', async () => {
    const harness = makeMultiPeerHarness(['a-alpha'])
    await saveMeshPeerCredential(harness, 'peer-alpha', 'a-alpha', 'z-alpha')
    await harness.registry.connectPeer(meshPeerProfile('peer-alpha', 'z-alpha', 'Alpha node'))
    await authorizeMeshPeer(harness, 0, 'peer-alpha', 'a-alpha', 'z-alpha')

    const mesh = harness.runtime.meshTransport
    expect(mesh).toBeDefined()
    await expect(mesh!.request({
      method: 'Gateway.GetRegistry',
      busTopic: 'Gateway.GetRegistry',
      payload: { selector: { peer_id: 'peer-ghost' } }
    })).rejects.toMatchObject({
      code: 'unavailable_service',
      detail: { reason_code: PEER_NOT_REGISTERED_REASON, peer_id: 'peer-ghost', reachable_peer_ids: ['peer-alpha'] }
    })
    await expect(mesh!.getManifest('peer-ghost')).rejects.toMatchObject({
      code: 'unavailable_service',
      detail: { reason_code: PEER_NOT_REGISTERED_REASON, peer_id: 'peer-ghost' }
    })

    await harness.runtime.close()
  })
})
