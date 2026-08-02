import { describe, expect, it, vi } from 'vitest'

import {
  AURORA_RPC_DATA_CHANNEL_LABEL,
  WebRtcPeerSession,
  categorizeIceCandidate,
  type DataChannelLike,
  type PeerConnectionLike,
  type PeerSessionAuthContext,
  type PeerSessionSignalingPort,
  type SignalingMessage
} from '../src/webrtc/peer-session.js'
import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  parseProtocolHello
} from '../src/webrtc/peer-protocol.js'
import type { AuthenticatedPeerContext } from '../src/peer-host/authority.js'

class FakeTimers {
  next = 1
  handles = new Map<number, { callback: () => void; ms: number }>()
  setTimeout = (callback: () => void, ms: number): number => {
    const handle = this.next++
    this.handles.set(handle, { callback, ms })
    return handle
  }
  clearTimeout = (handle: unknown): void => {
    this.handles.delete(handle as number)
  }
  fireAll(): void {
    for (const { callback } of [...this.handles.values()]) callback()
  }
  fireDelay(ms: number): void {
    const entry = [...this.handles.entries()].find(([, timer]) => timer.ms === ms)
    if (!entry) throw new Error(`No timer is scheduled for ${ms}ms`)
    this.handles.delete(entry[0])
    entry[1].callback()
  }
  scheduledDelays(): number[] {
    return [...this.handles.values()].map((timer) => timer.ms).sort((left, right) => left - right)
  }
}

class FakeSignaling implements PeerSessionSignalingPort {
  listeners = new Set<(message: SignalingMessage) => void>()
  published: Array<{ channel: string; envelope: Record<string, unknown>; toPeer?: string }> = []
  closed = false
  connect = vi.fn(async () => undefined)
  close = vi.fn(async () => { this.closed = true })
  publish = vi.fn(async (channel: any, envelope: any, toPeer?: string) => {
    const entry: { channel: string; envelope: Record<string, unknown>; toPeer?: string } = { channel, envelope }
    if (toPeer !== undefined) entry.toPeer = toPeer
    this.published.push(entry)
  })
  subscribe(listener: (message: SignalingMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(message: SignalingMessage): void {
    for (const listener of [...this.listeners]) listener(message)
  }
}

class FakeDataChannel implements DataChannelLike {
  readyState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer | ArrayBufferView }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  closed = false
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  constructor(readonly label: string) {}
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data)
    this.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength
  }
  close(): void {
    if (this.readyState === 'closed') return
    this.closed = true
    this.readyState = 'closed'
    this.onclose?.()
    this.emit('close')
  }
  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const bucket = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
    bucket.add(listener)
    this.listeners.set(type, bucket)
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener)
  }
  drainTo(bufferedAmount: number): void {
    this.bufferedAmount = bufferedAmount
    this.emit('bufferedamountlow')
  }
  private emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === 'function') {
        listener(new Event(type))
      } else {
        listener.handleEvent(new Event(type))
      }
    }
  }
}

class FakePeerConnection implements PeerConnectionLike {
  localDescription = null as any
  remoteDescription = null as any
  connectionState = 'new'
  iceConnectionState = 'new'
  onicecandidate: PeerConnectionLike['onicecandidate'] = null
  ondatachannel: PeerConnectionLike['ondatachannel'] = null
  onconnectionstatechange: PeerConnectionLike['onconnectionstatechange'] = null
  oniceconnectionstatechange: PeerConnectionLike['oniceconnectionstatechange'] = null
  channels: FakeDataChannel[] = []
  candidates: unknown[] = []
  statsReport: Map<string, unknown> = new Map()
  closed = false
  constructor(readonly offerSdp = 'v=0\r\no=- offer\r\n', readonly answerSdp = 'v=0\r\no=- answer\r\n') {}
  createDataChannel(label: string): DataChannelLike {
    const channel = new FakeDataChannel(label)
    this.channels.push(channel)
    return channel
  }
  async createOffer(): Promise<any> { return { type: 'offer', sdp: this.offerSdp } }
  async createAnswer(): Promise<any> { return { type: 'answer', sdp: this.answerSdp } }
  async setLocalDescription(description: any): Promise<void> { this.localDescription = description }
  async setRemoteDescription(description: any): Promise<void> { this.remoteDescription = description }
  async addIceCandidate(candidate: unknown): Promise<void> { this.candidates.push(candidate) }
  async getStats(): Promise<Map<string, unknown>> { return this.statsReport }
  close(): void { this.closed = true }
  remoteChannel(channel: FakeDataChannel): void { this.ondatachannel?.({ channel }) }
  localCandidate(candidate: string | null): void { this.onicecandidate?.({ candidate: candidate === null ? null : { candidate } }) }
  fail(): void { this.connectionState = 'failed'; this.onconnectionstatechange?.() }
}

function presence(from: string, stablePeerId = `stable-${from}`): SignalingMessage {
  return { channel: 'presence', from, stablePeerId, envelope: { type: 'presence', stable_peer_id: stablePeerId } }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve()
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function authorizedAnswerer(options: Partial<ConstructorParameters<typeof WebRtcPeerSession>[0]> = {}): Promise<{
  session: WebRtcPeerSession
  signaling: FakeSignaling
  pc: FakePeerConnection
  channel: FakeDataChannel
}> {
  const signaling = new FakeSignaling()
  const pc = new FakePeerConnection()
  const session = new WebRtcPeerSession({
    localSignalingId: 'z',
    signaling,
    createPeerConnection: () => pc,
    codec,
    timers: new FakeTimers(),
    auth: { tryReconnect: async () => true, handleFrame: async () => undefined },
    ...options
  })
  await session.start()
  signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
  await flush()
  const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
  pc.remoteChannel(channel)
  channel.open()
  await flush()
  expect(session.getSnapshot()).toMatchObject({ state: 'authorized', authorized: true })
  channel.sent = []
  channel.bufferedAmount = 0
  return { session, signaling, pc, channel }
}

const codec = {
  seal: vi.fn(async (frame: unknown) => JSON.stringify(frame)),
  open: vi.fn(async (data: unknown) => JSON.parse(String(data)))
}

function authenticatedContext(): AuthenticatedPeerContext {
  return {
    selector: {
      tokenId: 'token-1',
      claimantPeerId: 'stable-a',
      verifierPeerId: 'stable-z',
      roomName: 'room-a'
    },
    transport: {
      channelBinding: 'a'.repeat(64),
      claimantSignalingPeerId: 'a',
      verifierSignalingPeerId: 'z'
    },
    credentialRevision: 3,
    authenticatedAtMs: 1000
  }
}

describe('WebRtcPeerSession', () => {
  it('is SSR import safe and categorizes ICE candidates without exposing addresses', async () => {
    await expect(import('../src/webrtc/peer-session.js')).resolves.toBeTruthy()
    expect(categorizeIceCandidate('candidate:0 1 udp 1 192.168.1.2 123 typ host')).toBe('host')
    expect(categorizeIceCandidate('candidate:0 1 udp 1 203.0.113.2 123 typ srflx')).toBe('srflx')
    expect(categorizeIceCandidate('candidate:0 1 udp 1 203.0.113.4 123 typ prflx')).toBe('prflx')
    expect(categorizeIceCandidate('candidate:0 1 udp 1 203.0.113.3 123 typ relay')).toBe('relay')
  })

  it('exposes authenticated peer context only after auth success and clears it on reconnect', async () => {
    const context = authenticatedContext()
    const { session, pc } = await authorizedAnswerer({
      auth: { tryReconnect: async () => ({ authenticated: true, authenticatedPeerContext: context }), handleFrame: async () => undefined },
      localStableId: 'stable-z',
      expectedRemoteStableId: 'stable-a'
    })

    expect(session.getSnapshot().authenticatedPeerContext).toEqual(context)
    pc.fail()
    await flush()
    expect(session.getSnapshot().authenticatedPeerContext).toBeUndefined()
  })

  it('updates authenticated peer context from a later authorized auth result and emits a snapshot', async () => {
    const nextContext = authenticatedContext()
    const snapshots: Array<ReturnType<WebRtcPeerSession['getSnapshot']>> = []
    const { session, channel } = await authorizedAnswerer({
      auth: {
        tryReconnect: async () => true,
        handleFrame: async (frame: unknown) => {
          if (typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'mesh_auth_proof_v1') {
            return { handled: true, authenticated: true, authenticatedPeerContext: nextContext }
          }
          return undefined
        }
      },
      localStableId: 'stable-z',
      expectedRemoteStableId: 'stable-a'
    })
    session.subscribe((snapshot) => snapshots.push(snapshot))

    expect(session.getSnapshot().authenticatedPeerContext).toBeUndefined()
    channel.onmessage?.({ data: JSON.stringify({ type: 'mesh_auth_proof_v1' }) })
    await flush()

    expect(session.getSnapshot().authenticatedPeerContext).toEqual(nextContext)
    expect(snapshots.some((snapshot) => snapshot.authenticatedPeerContext?.selector.tokenId === 'token-1')).toBe(true)
  })

  it('fails closed when an authorized auth frame is handled but terminally denied', async () => {
    const { session, channel } = await authorizedAnswerer({
      auth: {
        tryReconnect: async () => true,
        handleFrame: async (frame: unknown) => {
          if (typeof frame === 'object' && frame !== null && (frame as { type?: unknown }).type === 'mesh_auth_proof_v1') {
            return { handled: true, denied: true, terminal: true }
          }
          return undefined
        }
      }
    })

    channel.onmessage?.({ data: JSON.stringify({ type: 'mesh_auth_proof_v1', replay: true }) })
    await flush()

    expect(session.getSnapshot()).toMatchObject({
      state: 'failed',
      authorized: false,
      lastError: 'authorized auth frame denied'
    })
  })

  it('preserves selected prflx evidence even when a configured STUN server gathered srflx', async () => {
    const { session, pc } = await authorizedAnswerer({
      iceServers: [{ urls: ['stun:127.0.0.1:3478'] }]
    })
    pc.statsReport = new Map<string, unknown>([
      ['transport-1', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
      ['pair-1', {
        type: 'candidate-pair',
        selected: true,
        nominated: true,
        state: 'succeeded',
        localCandidateId: 'local-prflx',
        remoteCandidateId: 'remote-host',
        bytesSent: 10,
        bytesReceived: 20
      }],
      ['local-prflx', { type: 'local-candidate', candidateType: 'prflx', protocol: 'udp' }],
      ['remote-host', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
      ['local-srflx', {
        type: 'local-candidate',
        candidateType: 'srflx',
        protocol: 'udp',
        url: 'stun:127.0.0.1:3478'
      }]
    ])

    await expect(session.getSelectedCandidatePairEvidence()).resolves.toMatchObject({
      selected: true,
      category: 'prflx',
      localCandidateType: 'prflx',
      remoteCandidateType: 'host',
      stunServerReflexiveCandidate: {
        gathered: true,
        candidateType: 'srflx',
        urlScheme: 'stun',
        urlMatchesConfiguredStunServer: true,
        rawAddressRedacted: true
      },
      statsSource: 'RTCPeerConnection.getStats',
      rawAddressRedacted: true
    })
  })

  it('uses lower signaling id as offerer and passes exact SDP/candidates through signaling', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection('exact-offer-sdp')
    const session = new WebRtcPeerSession({
      localSignalingId: 'a-local',
      localStableId: 'stable-local',
      expectedRemoteStableId: 'stable-z-remote',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers: new FakeTimers(),
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await session.start()
    expect(session.getSnapshot()).toMatchObject({ state: 'discovering-peer' })
    expect(session.getSnapshot().remoteStableId).toBeUndefined()
    signaling.emit(presence('z-remote'))
    await flush()
    expect(session.getSnapshot()).toMatchObject({ role: 'offerer', state: 'negotiating', remoteStableId: 'stable-z-remote' })
    expect(session.getDiagnostics()).toMatchObject({ remoteStableId: 'stable-z-remote', expectedRemoteStableId: 'stable-z-remote' })
    expect(pc.channels[0]?.label).toBe(AURORA_RPC_DATA_CHANNEL_LABEL)
    expect(signaling.published.find((item) => item.channel === 'offer')?.envelope.sdp).toBe('exact-offer-sdp')

    signaling.emit({ channel: 'answer', from: 'z-remote', stablePeerId: 'stable-z-remote', envelope: { type: 'answer', sdp: 'exact-answer-sdp' } })
    await flush()
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'exact-answer-sdp' })

    pc.localCandidate('candidate:0 1 udp 1 10.0.0.1 123 typ relay')
    pc.localCandidate(null)
    await flush()
    expect(signaling.published.some((item) => item.channel === 'candidate' && item.envelope.candidate_category === 'relay')).toBe(true)
    expect(signaling.published.some((item) => item.channel === 'candidate' && item.envelope.candidate === null)).toBe(true)
    expect(session.getDiagnostics()).toMatchObject({ icePath: 'relay' })
  })

  it('processes retained presence delivered before signaling connect resolves', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection('startup-race-offer')
    signaling.connect = vi.fn(async () => {
      signaling.emit(presence('z-remote'))
    })
    const session = new WebRtcPeerSession({
      localSignalingId: 'a-local',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers: new FakeTimers(),
      auth: {
        tryReconnect: async () => true,
        handleFrame: async () => undefined
      }
    })

    await session.start()
    await flush()

    expect(session.getSnapshot()).toMatchObject({
      state: 'negotiating',
      role: 'offerer',
      remoteSignalingId: 'z-remote',
      remoteStableId: 'stable-z-remote'
    })
    expect(
      signaling.published.find((item) => item.channel === 'offer')?.envelope,
    ).toMatchObject({
      type: 'offer',
      sdp: 'startup-race-offer'
    })
  })

  it('answers offers, accepts only aurora-rpc label, and authorizes after reconnect', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection('unused-offer', 'exact-answer-sdp')
    const auth = { tryReconnect: vi.fn(async () => true), handleFrame: vi.fn(async () => undefined) }
    const session = new WebRtcPeerSession({
      localSignalingId: 'z-local',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers: new FakeTimers(),
      auth
    })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a-remote', stablePeerId: 'stable-a-remote', envelope: { type: 'offer', sdp: 'exact-offer-sdp' } })
    await flush()
    expect(session.getSnapshot()).toMatchObject({ role: 'answerer', state: 'negotiating', remoteStableId: 'stable-a-remote' })
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'exact-offer-sdp' })
    expect(signaling.published.find((item) => item.channel === 'answer')?.envelope.sdp).toBe('exact-answer-sdp')

    const wrong = new FakeDataChannel('wrong')
    const wrongSession = new WebRtcPeerSession({ localSignalingId: 'z2', signaling: new FakeSignaling(), createPeerConnection: () => new FakePeerConnection(), codec, timers: new FakeTimers(), auth: { handleFrame: async () => undefined } })
    await wrongSession.start()
    ;(wrongSession as any).remoteSignalingId = 'a2'
    ;(wrongSession as any).role = 'answerer'
    ;(wrongSession as any).ensurePeerConnection()
    ;(wrongSession as any).pc.remoteChannel(wrong)
    expect(wrong.closed).toBe(true)
    expect(wrongSession.getSnapshot()).toMatchObject({ state: 'failed' })

    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()
    expect(auth.tryReconnect).toHaveBeenCalledWith(expect.objectContaining({ remoteSignalingId: 'a-remote' }))
    expect(session.getSnapshot()).toMatchObject({ state: 'authorized', authorized: true, remoteStableId: 'stable-a-remote' })
    expect(channel.sent).toHaveLength(1)
    expect(parseProtocolHello(JSON.parse(String(channel.sent[0]))).role).toBe('consumer')
  })

  it('requires SAS confirmation when reconnect is unavailable and sends fail-closed encrypted frames', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const auth = { tryReconnect: vi.fn(async () => false), startPairing: vi.fn(), confirmPairing: vi.fn(async () => true), handleFrame: vi.fn(async () => undefined) }
    const badCodec = { seal: vi.fn(async () => 'sealed'), open: vi.fn(async () => { throw new Error('bad frame') }) }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec: badCodec, timers: new FakeTimers(), auth })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()
    expect(session.getSnapshot().state).toBe('awaiting-sas-confirmation')
    await session.confirmSas('123456')
    expect(session.getSnapshot().state).toBe('authorized')
    await session.sendFrame({ hello: true })
    expect(channel.sent).toEqual(['sealed', 'sealed'])
    channel.onmessage?.({ data: 'not-json' })
    await flush()
    expect(session.getSnapshot()).toMatchObject({ state: 'failed' })
  })

  it('sends authorized app frames through the accepted DataChannel flow controller', async () => {
    const { session, channel } = await authorizedAnswerer()

    await session.sendFrame({ hello: true })

    expect(channel.sent).toEqual([JSON.stringify({ hello: true })])
  })

  it('waits for bufferedamountlow before sending while the DataChannel buffer is high', async () => {
    const { session, channel } = await authorizedAnswerer({
      dataChannelFlowLimits: { lowWatermarkBytes: 4, highWatermarkBytes: 8, maxQueueBytes: 4096 }
    })

    channel.bufferedAmount = 16
    const send = session.sendFrame({ delayed: true })
    await flush()
    expect(channel.sent).toEqual([])

    channel.drainTo(2)
    await expect(send).resolves.toBeUndefined()
    expect(channel.sent).toEqual([JSON.stringify({ delayed: true })])
    expect(channel.bufferedAmountLowThreshold).toBe(4)
  })

  it('aborts pending sends if the DataChannel closes before drain and does not call send', async () => {
    const { session, channel } = await authorizedAnswerer({
      dataChannelFlowLimits: { lowWatermarkBytes: 4, highWatermarkBytes: 8, maxQueueBytes: 4096 }
    })

    channel.bufferedAmount = 16
    const send = session.sendFrame({ never: 'sent' })
    await flush()
    channel.close()

    await expect(send).rejects.toThrow('Aurora WebRTC data channel send failed')
    expect(channel.sent).toEqual([])
  })

  it('replaces closed DataChannel flow state with a fresh controller for the next channel epoch', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc1 = new FakePeerConnection()
    const pc2 = new FakePeerConnection()
    const pcs = [pc1, pc2]
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      dataChannelFlowLimits: { lowWatermarkBytes: 4, highWatermarkBytes: 8, maxQueueBytes: 4096 },
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-1' } })
    await flush()
    const first = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc1.remoteChannel(first)
    first.open()
    await flush()
    first.sent = []
    first.bufferedAmount = 16
    const blocked = session.sendFrame({ blocked: true })
    await flush()
    first.close()
    await expect(blocked).rejects.toThrow('Aurora WebRTC data channel send failed')
    expect(first.sent).toEqual([])

    timers.fireAll()
    expect(session.getSnapshot()).toMatchObject({ state: 'discovering-peer', remoteStableId: 'stable-a' })
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-2' } })
    await flush()
    const second = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc2.remoteChannel(second)
    second.open()
    await flush()
    second.sent = []
    second.bufferedAmount = 0

    await session.sendFrame({ fresh: true })
    expect(second.sent).toEqual([JSON.stringify({ fresh: true })])
    expect(second.bufferedAmountLowThreshold).toBe(4)
  })

  it('suppresses reconnect after explicit close or identity mismatch and cleans listeners/timers/resources', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const session = new WebRtcPeerSession({
      localSignalingId: 'a',
      expectedRemoteStableId: 'stable-b',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers,
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await session.start()
    expect(signaling.listeners.size).toBe(1)
    signaling.emit({ channel: 'presence', from: 'b', stablePeerId: 'evil', envelope: { type: 'presence', stable_peer_id: 'evil' } })
    expect(session.getSnapshot()).toMatchObject({ state: 'failed' })
    expect(timers.handles.size).toBe(0)
    expect(signaling.listeners.size).toBe(0)
    expect(pc.closed).toBe(false)

    const stableTimers = new FakeTimers()
    const stableSignaling = new FakeSignaling()
    const stablePc = new FakePeerConnection()
    const stableSession = new WebRtcPeerSession({
      localSignalingId: 'a',
      signaling: stableSignaling,
      createPeerConnection: () => stablePc,
      codec,
      timers: stableTimers,
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await stableSession.start()
    stableSignaling.emit(presence('b', 'stable-b'))
    await flush()
    expect(stableSession.getSnapshot()).toMatchObject({ state: 'negotiating', remoteStableId: 'stable-b' })
    stableSignaling.emit({ channel: 'candidate', from: 'b', stablePeerId: 'evil-stable-b', envelope: { type: 'candidate', candidate: 'candidate:0 1 udp 1 203.0.113.3 123 typ relay' } })
    await flush()
    expect(stableSession.getSnapshot()).toMatchObject({ state: 'failed', remoteStableId: 'stable-b', lastError: 'remote stable identity changed' })
    expect(stableTimers.handles.size).toBe(0)

    const timers2 = new FakeTimers()
    const signaling2 = new FakeSignaling()
    const pc2 = new FakePeerConnection()
    const session2 = new WebRtcPeerSession({ localSignalingId: 'a', signaling: signaling2, createPeerConnection: () => pc2, codec, timers: timers2, auth: { tryReconnect: async () => true, handleFrame: async () => undefined } })
    await session2.start()
    signaling2.emit(presence('b'))
    await flush()
    pc2.channels[0]?.open()
    await session2.close()
    pc2.fail()
    timers2.fireAll()
    expect(session2.getSnapshot()).toMatchObject({ state: 'closed', reconnectAttempts: 0 })
    expect(signaling2.listeners.size).toBe(0)
    expect(signaling2.closed).toBe(true)
    expect(pc2.closed).toBe(true)
  })

  it('schedules capped jittered reconnect only for transient failure', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const session = new WebRtcPeerSession({
      localSignalingId: 'a',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers,
      random: () => 0.5,
      reconnect: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await session.start()
    signaling.emit(presence('b'))
    await flush()
    pc.fail()
    expect(session.getSnapshot()).toMatchObject({ state: 'reconnecting', reconnectAttempts: 1, remoteStableId: 'stable-b' })
    timers.fireAll()
    expect(session.getSnapshot()).toMatchObject({ state: 'discovering-peer', remoteStableId: 'stable-b' })
  })

  it('keeps retrying transient transport failures by default until explicitly closed', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pcs = Array.from({ length: 5 }, () => new FakePeerConnection())
    const session = new WebRtcPeerSession({
      localSignalingId: 'a',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      random: () => 0.5,
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })

    await session.start()
    signaling.emit(presence('b'))
    await flush()

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const current = (session as unknown as { pc: FakePeerConnection }).pc
      current.fail()
      expect(session.getSnapshot()).toMatchObject({ state: 'reconnecting', reconnectAttempts: attempt })
      timers.fireDelay(500 * 2 ** (attempt - 1))
      await flush()
      expect(session.getSnapshot().failed).toBe(false)
    }

    await session.close()
    expect(session.getSnapshot().state).toBe('closed')
  })

  it('rebinds a restarted peer signaling session only when its stable identity still matches', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const firstPc = new FakePeerConnection('unused', 'answer-old')
    const secondPc = new FakePeerConnection('unused', 'answer-new')
    const pcs = [firstPc, secondPc]
    const auth = {
      tryReconnect: vi.fn(async () => true),
      startPairing: vi.fn(async () => undefined),
      resetTransport: vi.fn(),
      handleFrame: vi.fn(async () => undefined)
    }
    const session = new WebRtcPeerSession({
      localSignalingId: 'z-local',
      expectedRemoteStableId: 'stable-home',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      random: () => 0.5,
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth
    })

    await session.start()
    signaling.emit({
      channel: 'offer',
      from: 'home-epoch-old',
      stablePeerId: 'stable-home',
      envelope: { type: 'offer', stable_peer_id: 'stable-home', sdp: 'offer-old' }
    })
    await flush()
    const firstChannel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    firstPc.remoteChannel(firstChannel)
    firstChannel.open()
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'authorized',
      remoteSignalingId: 'home-epoch-old',
      remoteStableId: 'stable-home'
    })

    signaling.emit(presence('home-epoch-new', 'stable-home'))
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'reconnecting',
      failed: false,
      remoteSignalingId: 'home-epoch-old',
      remoteStableId: 'stable-home'
    })

    timers.fireDelay(1)
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'discovering-peer',
      role: 'answerer',
      remoteSignalingId: 'home-epoch-new',
      remoteStableId: 'stable-home'
    })
    expect(firstPc.closed).toBe(true)
    expect(auth.resetTransport).toHaveBeenCalledOnce()

    signaling.emit({
      channel: 'offer',
      from: 'home-epoch-new',
      stablePeerId: 'stable-home',
      envelope: { type: 'offer', stable_peer_id: 'stable-home', sdp: 'offer-new' }
    })
    await flush()
    expect(secondPc.remoteDescription).toEqual({ type: 'offer', sdp: 'offer-new' })
    expect(signaling.published).toContainEqual(expect.objectContaining({
      channel: 'answer',
      toPeer: 'home-epoch-new',
      envelope: expect.objectContaining({ sdp: 'answer-new' })
    }))

    const secondChannel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    secondPc.remoteChannel(secondChannel)
    secondChannel.open()
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'authorized',
      authorized: true,
      remoteSignalingId: 'home-epoch-new',
      remoteStableId: 'stable-home'
    })
    expect(session.getSnapshot().lastError).toBeUndefined()
    expect(auth.tryReconnect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      remoteSignalingId: 'home-epoch-new',
      remoteStableId: 'stable-home'
    }))
    expect(auth.startPairing).not.toHaveBeenCalled()
  })

  it('replays a same-stable-peer presence received before rollover teardown completes', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const firstPc = new FakePeerConnection('offer-old')
    const secondPc = new FakePeerConnection('offer-new')
    const pcs = [firstPc, secondPc]
    const auth = {
      tryReconnect: vi.fn(async () => true),
      resetTransport: vi.fn(),
      handleFrame: vi.fn(async () => undefined)
    }
    const session = new WebRtcPeerSession({
      localSignalingId: 'a-local',
      expectedRemoteStableId: 'stable-home',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      random: () => 0.5,
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth
    })

    await session.start()
    signaling.emit(presence('home-epoch-old', 'stable-home'))
    await flush()
    signaling.emit({
      channel: 'answer',
      from: 'home-epoch-old',
      stablePeerId: 'stable-home',
      envelope: { type: 'answer', stable_peer_id: 'stable-home', sdp: 'answer-old' }
    })
    await flush()
    firstPc.channels[0]!.open()
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'authorized',
      remoteSignalingId: 'home-epoch-old',
      remoteStableId: 'stable-home'
    })

    signaling.emit(presence('home-epoch-new', 'stable-home'))
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'reconnecting',
      remoteSignalingId: 'home-epoch-old',
      remoteStableId: 'stable-home'
    })

    timers.fireDelay(1)
    await flush()
    expect(session.getSnapshot()).toMatchObject({
      state: 'negotiating',
      role: 'offerer',
      remoteSignalingId: 'home-epoch-new',
      remoteStableId: 'stable-home'
    })
    expect(signaling.published).toContainEqual(expect.objectContaining({
      channel: 'offer',
      toPeer: 'home-epoch-new',
      envelope: expect.objectContaining({ sdp: 'offer-new' })
    }))
    expect(firstPc.closed).toBe(true)
    expect(auth.resetTransport).toHaveBeenCalledOnce()
  })

  it('treats a trusted peer departure as recoverable but preserves an explicit signaling-session pin', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const session = new WebRtcPeerSession({
      localSignalingId: 'z-local',
      expectedRemoteStableId: 'stable-home',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers,
      random: () => 0.5,
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await session.start()
    signaling.emit({
      channel: 'offer',
      from: 'home-epoch-old',
      stablePeerId: 'stable-home',
      envelope: { type: 'offer', stable_peer_id: 'stable-home', sdp: 'offer-old' }
    })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()

    signaling.emit({
      channel: 'presence',
      from: 'home-epoch-old',
      stablePeerId: 'stable-home',
      envelope: { type: 'presence_departed', stable_peer_id: 'stable-home' }
    })
    await flush()
    expect(session.getSnapshot()).toMatchObject({ state: 'reconnecting', failed: false })

    const pinnedSignaling = new FakeSignaling()
    const pinned = new WebRtcPeerSession({
      localSignalingId: 'z-pinned',
      expectedRemoteSignalingId: 'home-epoch-old',
      expectedRemoteStableId: 'stable-home',
      signaling: pinnedSignaling,
      createPeerConnection: () => new FakePeerConnection(),
      codec,
      timers: new FakeTimers(),
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })
    await pinned.start()
    pinnedSignaling.emit(presence('home-epoch-new', 'stable-home'))
    await flush()
    expect(pinned.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: 'remote signaling identity mismatch'
    })
  })

  it('keeps SAS approval alive for the pairing window, then retries with fresh transport state and presence', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const auth = {
      tryReconnect: vi.fn(async () => undefined),
      startPairing: vi.fn(async () => undefined),
      resetTransport: vi.fn(),
      handleFrame: vi.fn(async () => undefined)
    }
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers,
      timeouts: { authMs: 20, pairingMs: 300, discoveryMs: 30, negotiationMs: 20, signalingMs: 10 },
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth
    })

    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-1' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()

    expect(session.getSnapshot()).toMatchObject({ state: 'awaiting-sas-confirmation', failed: false })
    expect(timers.scheduledDelays()).toEqual([300])

    timers.fireDelay(300)
    expect(session.getSnapshot()).toMatchObject({ state: 'reconnecting', failed: false, reconnectAttempts: 1 })
    timers.fireDelay(1)
    await flush()

    expect(auth.resetTransport).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ state: 'discovering-peer', failed: false, remoteStableId: 'stable-a' })
    expect(signaling.published).toContainEqual(expect.objectContaining({ channel: 'presence' }))
  })

  it('replaces the approval-window timer when confirmation begins and allows the delayed exchange to finish', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const confirmation = deferred<true>()
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pc,
      codec,
      timers,
      timeouts: { authMs: 20, pairingMs: 300, discoveryMs: 30, negotiationMs: 20, signalingMs: 10 },
      auth: {
        tryReconnect: async () => undefined,
        startPairing: async () => undefined,
        confirmPairing: () => confirmation.promise,
        handleFrame: async () => undefined
      }
    })

    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()

    const approvalTimerHandle = [...timers.handles.keys()][0]!
    const pendingConfirmation = session.confirmSas('123456')
    const exchangeTimerHandle = [...timers.handles.keys()][0]!
    expect(exchangeTimerHandle).not.toBe(approvalTimerHandle)
    expect(timers.handles.has(approvalTimerHandle)).toBe(false)
    expect(timers.scheduledDelays()).toEqual([300])

    confirmation.resolve(true)
    await pendingConfirmation
    expect(session.getSnapshot()).toMatchObject({ state: 'authorized', authorized: true })
    expect(timers.handles.size).toBe(0)
  })

  it('drops a delayed old offer and old local ICE callback after reconnect creates a replacement transport', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc1 = new FakePeerConnection('stale-offer')
    const pc2 = new FakePeerConnection('fresh-offer')
    const offer = deferred<{ type: 'offer'; sdp: string }>()
    pc1.createOffer = () => offer.promise
    const pcs = [pc1, pc2]
    const session = new WebRtcPeerSession({
      localSignalingId: 'a',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      random: () => 0.5,
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })

    await session.start()
    signaling.emit(presence('b'))
    await flush()
    const oldIceCallback = pc1.onicecandidate
    pc1.fail()
    timers.fireDelay(1)
    await flush()

    expect(pc1.closed).toBe(true)
    expect(signaling.published.filter((item) => item.channel === 'offer').map((item) => item.envelope.sdp)).toEqual(['fresh-offer'])
    oldIceCallback?.({ candidate: { candidate: 'candidate:0 1 udp 1 203.0.113.9 9 typ relay' } })
    offer.resolve({ type: 'offer', sdp: 'stale-offer' })
    await flush()

    expect(signaling.published.filter((item) => item.channel === 'offer').map((item) => item.envelope.sdp)).toEqual(['fresh-offer'])
    expect(signaling.published.some((item) => item.channel === 'candidate')).toBe(false)
    expect(pc2.localDescription?.sdp).toBe('fresh-offer')
  })

  it('drops delayed remote SDP and candidate work from an answerer transport replaced during reconnect', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc1 = new FakePeerConnection('unused', 'stale-answer')
    const pc2 = new FakePeerConnection('unused', 'fresh-answer')
    const remoteDescription = deferred<void>()
    const candidate = deferred<void>()
    pc1.setRemoteDescription = async (description) => {
      await remoteDescription.promise
      pc1.remoteDescription = description
    }
    pc1.addIceCandidate = async (value) => {
      await candidate.promise
      pc1.candidates.push(value)
    }
    const pcs = [pc1, pc2]
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      random: () => 0.5,
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth: { tryReconnect: async () => true, handleFrame: async () => undefined }
    })

    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'stale-offer' } })
    signaling.emit({ channel: 'candidate', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'candidate', candidate: 'candidate:0 1 udp 1 203.0.113.8 8 typ relay' } })
    await flush()
    pc1.fail()
    timers.fireDelay(1)
    await flush()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'fresh-offer' } })
    await flush()

    candidate.resolve(undefined)
    remoteDescription.resolve(undefined)
    await flush()

    expect(signaling.published.filter((item) => item.channel === 'answer').map((item) => item.envelope.sdp)).toEqual(['fresh-answer'])
    expect(pc2.remoteDescription?.sdp).toBe('fresh-offer')
    expect(session.getSnapshot().icePath).toBe('unknown')
  })

  it('ignores authentication work that completes after its data channel was replaced', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc1 = new FakePeerConnection()
    const pc2 = new FakePeerConnection()
    const pcs = [pc1, pc2]
    const firstReconnect = deferred<true | undefined>()
    const secondReconnect = deferred<true | undefined>()
    let reconnectCall = 0
    const auth = {
      tryReconnect: vi.fn(() => {
        reconnectCall += 1
        return reconnectCall === 1 ? firstReconnect.promise : secondReconnect.promise
      }),
      startPairing: vi.fn(async () => undefined),
      resetTransport: vi.fn(),
      handleFrame: vi.fn(async () => undefined)
    }
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth
    })

    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-1' } })
    await flush()
    const firstChannel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc1.remoteChannel(firstChannel)
    firstChannel.open()
    await flush()
    expect(session.getSnapshot().state).toBe('reconnect-authenticating')

    firstChannel.close()
    timers.fireDelay(1)
    await flush()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-2' } })
    await flush()
    const secondChannel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc2.remoteChannel(secondChannel)
    secondChannel.open()
    await flush()
    expect(session.getSnapshot().state).toBe('reconnect-authenticating')

    firstReconnect.resolve(undefined)
    await flush()
    expect(session.getSnapshot().state).toBe('reconnect-authenticating')
    expect(auth.startPairing).not.toHaveBeenCalled()

    secondReconnect.resolve(true)
    await flush()
    expect(session.getSnapshot()).toMatchObject({ state: 'authorized', authorized: true })
    expect(auth.resetTransport).toHaveBeenCalledOnce()
  })

  it('routes preauth challenge/pairing frames through auth and lets auth send proof control frames before authorization', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const handled: unknown[] = []
    const auth = {
      tryReconnect: vi.fn(async () => undefined),
      handleFrame: vi.fn(async (frame: unknown, context: any) => {
        handled.push(frame)
        if ((frame as any).type === 'challenge') {
          await context.sendControlFrame({ type: 'proof', id: (frame as any).id })
        }
        return undefined
      })
    }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec, timers: new FakeTimers(), auth })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()
    channel.onmessage?.({ data: JSON.stringify({ type: 'challenge', id: 'c1' }) })
    channel.onmessage?.({ data: JSON.stringify({ type: 'pairing_commit', id: 'p1' }) })
    await flush()
    expect(session.getSnapshot().state).toBe('awaiting-sas-confirmation')
    expect(auth.handleFrame).toHaveBeenCalledTimes(2)
    expect(handled).toEqual([{ type: 'challenge', id: 'c1' }, { type: 'pairing_commit', id: 'p1' }])
    expect(channel.sent).toContain(JSON.stringify({ type: 'proof', id: 'c1' }))
  })

  it('fails closed without unhandled rejection when auth startup send races channel closure', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    let channel: FakeDataChannel | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const auth = {
      tryReconnect: vi.fn(async () => undefined),
      startPairing: vi.fn(async (context: PeerSessionAuthContext) => {
        channel?.close()
        await context.sendControlFrame({ type: 'pairing_v2_commit', sequence: 1 })
      }),
      handleFrame: vi.fn(async () => undefined)
    }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec, timers: new FakeTimers(), auth })

    try {
      await session.start()
      signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
      await flush()
      channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
      pc.remoteChannel(channel)
      channel.open()
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(session.getSnapshot()).toMatchObject({
        state: 'failed',
        authorized: false,
        lastError: 'Aurora WebRTC control channel is not open'
      })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('processes encrypted inbound frames in ordered DataChannel sequence', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const handled: unknown[] = []
    let releaseFirstFrame!: () => void
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve
    })
    const delayedCodec = {
      seal: vi.fn(async (frame: unknown) => JSON.stringify(frame)),
      open: vi.fn(async (data: unknown) => {
        const frame = JSON.parse(String(data)) as { sequence?: number }
        if (frame.sequence === 1) await firstFrameGate
        return frame
      })
    }
    let releaseFirstHandler!: () => void
    const firstHandlerGate = new Promise<void>((resolve) => {
      releaseFirstHandler = resolve
    })
    const auth = {
      tryReconnect: vi.fn(async () => undefined),
      handleFrame: vi.fn(async (frame: unknown) => {
        if ((frame as { sequence?: number }).sequence === 1) {
          await firstHandlerGate
        }
        handled.push(frame)
        return undefined
      })
    }
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pc,
      codec: delayedCodec,
      timers: new FakeTimers(),
      auth
    })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()

    channel.onmessage?.({ data: JSON.stringify({ type: 'pairing_v2_commit', sequence: 1 }) })
    channel.onmessage?.({ data: JSON.stringify({ type: 'pairing_v2_reveal', sequence: 2 }) })
    await flush()
    expect(handled).toEqual([])

    releaseFirstFrame()
    await flush()
    expect(handled).toEqual([])

    releaseFirstHandler()
    await flush()
    expect(handled).toEqual([
      { type: 'pairing_v2_commit', sequence: 1 },
      { type: 'pairing_v2_reveal', sequence: 2 }
    ])
    await session.close()
  })

  it('withholds app frames before auth, completes on remote protocol hello, sends local hello once, then delivers decoded frames exactly once', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const auth = { tryReconnect: vi.fn(async () => undefined), handleFrame: vi.fn(async (frame: unknown) => (typeof frame === 'object' && frame !== null && (frame as any).type === 'protocol_hello' ? true : undefined)) }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec, timers: new FakeTimers(), auth })
    const frames: unknown[] = []
    session.subscribeFrames((frame) => frames.push(frame))
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()

    channel.onmessage?.({ data: JSON.stringify({ type: 'result', id: 'preauth' }) })
    await flush()
    expect(frames).toEqual([])
    expect(auth.handleFrame).toHaveBeenCalledWith({ type: 'result', id: 'preauth' }, expect.anything())

    channel.onmessage?.({ data: JSON.stringify({ type: 'protocol_hello', v: 1, role: 'hybrid' }) })
    await flush()
    expect(session.getSnapshot()).toMatchObject({ state: 'authorized', authorized: true })
    expect(channel.sent.map(String).map((item) => JSON.parse(item)).filter((item) => item.type === 'protocol_hello')).toHaveLength(1)

    channel.onmessage?.({ data: JSON.stringify({ type: 'result', id: 'r1' }) })
    channel.onmessage?.({ data: JSON.stringify({ type: 'event', id: 'e1' }) })
    await flush()
    expect(frames).toEqual([{ type: 'protocol_hello', v: 1, role: 'hybrid' }, { type: 'result', id: 'r1' }, { type: 'event', id: 'e1' }])
  })

  it('does not authorize without auth port or from undefined SAS/auth callbacks and clears auth timers on explicit auth', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const noAuth = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec, timers } as any)
    await noAuth.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()
    expect(noAuth.getSnapshot()).toMatchObject({ state: 'failed', authorized: false })

    const timers2 = new FakeTimers()
    const signaling2 = new FakeSignaling()
    const pc2 = new FakePeerConnection()
    const auth = { tryReconnect: vi.fn(async () => undefined), confirmPairing: vi.fn(async () => false), handleFrame: vi.fn(async () => undefined) }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling: signaling2, createPeerConnection: () => pc2, codec, timers: timers2, auth })
    await session.start()
    signaling2.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel2 = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc2.remoteChannel(channel2)
    channel2.open()
    await flush()
    expect(session.getSnapshot().state).toBe('awaiting-sas-confirmation')
    expect(timers2.handles.size).toBe(1)
    await session.confirmSas('123456')
    expect(session.getSnapshot().state).toBe('failed')
    expect(timers2.handles.size).toBe(0)
    return
    channel2.onmessage?.({ data: JSON.stringify({ type: 'protocol_hello', v: 1, role: 'hybrid' }) })
    await flush()
    expect(session.getSnapshot().state).toBe('authorized')
    expect(session.getSnapshot().remoteStableId).toBe('stable-a')
    expect(timers2.handles.size).toBe(0)
  })


  it('does not authorize spoofed valid protocol hello unless auth handler explicitly approves', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const auth = { tryReconnect: vi.fn(async () => undefined), handleFrame: vi.fn(async () => undefined) }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec, timers: new FakeTimers(), auth })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()
    const validHello = { type: 'protocol_hello', v: 1, role: 'hybrid', capabilities: [], limits: { fragment_payload_bytes: 16384, max_logical_bytes: 8388608, max_peer_aggregate_bytes: 16777216, incomplete_ttl_seconds: 30, max_fragments: 4096 } }
    channel.onmessage?.({ data: JSON.stringify(validHello) })
    await flush()
    expect(parseProtocolHello(validHello).role).toBe('hybrid')
    expect(auth.handleFrame).toHaveBeenCalledWith(validHello, expect.anything())
    expect(session.getSnapshot()).toMatchObject({ state: 'awaiting-sas-confirmation', authorized: false })
    expect(channel.sent.map(String).some((item) => item.includes('protocol_hello'))).toBe(false)
  })

  it('sends exact default local consumer hello with all G002 caps only after auth-approved remote hello', async () => {
    const signaling = new FakeSignaling()
    const pc = new FakePeerConnection()
    const auth = { tryReconnect: vi.fn(async () => undefined), handleFrame: vi.fn(async () => ({ authenticated: true })) }
    const session = new WebRtcPeerSession({ localSignalingId: 'z', signaling, createPeerConnection: () => pc, codec, timers: new FakeTimers(), auth })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', envelope: { type: 'offer', sdp: 'offer' } })
    await flush()
    const channel = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc.remoteChannel(channel)
    channel.open()
    await flush()
    const remoteHello = { type: 'protocol_hello', v: 1, role: 'hybrid', capabilities: [], limits: { fragment_payload_bytes: 16384, max_logical_bytes: 8388608, max_peer_aggregate_bytes: 16777216, incomplete_ttl_seconds: 30, max_fragments: 4096 } }
    channel.onmessage?.({ data: JSON.stringify(remoteHello) })
    await flush()
    expect(session.getSnapshot()).toMatchObject({ state: 'authorized', authorized: true })
    const helloFrames = channel.sent.map(String).map((item) => JSON.parse(item)).filter((item) => item.type === 'protocol_hello')
    expect(helloFrames).toHaveLength(1)
    const parsed = parseProtocolHello(helloFrames[0])
    expect(parsed.role).toBe('consumer')
    expect(parsed.capabilities).toEqual(new Set([CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_CONSUMER_ONLY_V1]))
  })


  it('sends local protocol hello once per accepted data channel auth epoch across reconnect', async () => {
    const timers = new FakeTimers()
    const signaling = new FakeSignaling()
    const pc1 = new FakePeerConnection()
    const pc2 = new FakePeerConnection()
    const pcs = [pc1, pc2]
    const auth = { tryReconnect: vi.fn(async () => undefined), handleFrame: vi.fn(async () => true) }
    const session = new WebRtcPeerSession({
      localSignalingId: 'z',
      signaling,
      createPeerConnection: () => pcs.shift() ?? new FakePeerConnection(),
      codec,
      timers,
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      auth
    })
    await session.start()
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-1' } })
    await flush()
    const first = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc1.remoteChannel(first)
    first.open()
    await flush()
    first.onmessage?.({ data: JSON.stringify({ type: 'protocol_hello', v: 1, role: 'hybrid', capabilities: [], limits: { fragment_payload_bytes: 16384, max_logical_bytes: 8388608, max_peer_aggregate_bytes: 16777216, incomplete_ttl_seconds: 30, max_fragments: 4096 } }) })
    first.onmessage?.({ data: JSON.stringify({ type: 'protocol_hello', v: 1, role: 'hybrid', capabilities: [], limits: { fragment_payload_bytes: 16384, max_logical_bytes: 8388608, max_peer_aggregate_bytes: 16777216, incomplete_ttl_seconds: 30, max_fragments: 4096 } }) })
    await flush()
    expect(session.getSnapshot().state).toBe('authorized')
    expect(session.getSnapshot().remoteStableId).toBe('stable-a')
    expect(first.sent.map(String).filter((item) => JSON.parse(item).type === 'protocol_hello')).toHaveLength(1)

    pc1.fail()
    expect(session.getSnapshot().state).toBe('reconnecting')
    timers.fireAll()
    expect(session.getSnapshot()).toMatchObject({ state: 'discovering-peer', remoteStableId: 'stable-a' })
    signaling.emit({ channel: 'offer', from: 'a', stablePeerId: 'stable-a', envelope: { type: 'offer', sdp: 'offer-2' } })
    await flush()
    const second = new FakeDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL)
    pc2.remoteChannel(second)
    second.open()
    await flush()
    second.onmessage?.({ data: JSON.stringify({ type: 'protocol_hello', v: 1, role: 'hybrid', capabilities: [], limits: { fragment_payload_bytes: 16384, max_logical_bytes: 8388608, max_peer_aggregate_bytes: 16777216, incomplete_ttl_seconds: 30, max_fragments: 4096 } }) })
    second.onmessage?.({ data: JSON.stringify({ type: 'protocol_hello', v: 1, role: 'hybrid', capabilities: [], limits: { fragment_payload_bytes: 16384, max_logical_bytes: 8388608, max_peer_aggregate_bytes: 16777216, incomplete_ttl_seconds: 30, max_fragments: 4096 } }) })
    await flush()
    expect(session.getSnapshot()).toMatchObject({ state: 'authorized', remoteStableId: 'stable-a' })
    expect(second.sent.map(String).filter((item) => JSON.parse(item).type === 'protocol_hello')).toHaveLength(1)
    expect(first.sent.map(String).filter((item) => JSON.parse(item).type === 'protocol_hello')).toHaveLength(1)
  })

})
