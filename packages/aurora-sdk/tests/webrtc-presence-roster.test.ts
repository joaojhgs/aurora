import { describe, expect, it, vi } from 'vitest'

import {
  createBrowserWebRtcAuroraRuntime,
  type MeshPeerRegistryController,
  type WebRtcPeerConnectionProfile
} from '../src/webrtc/index.js'
import { deriveRoomKeys, encodeJsonPayload } from '../src/webrtc/crypto.js'
import {
  MqttWebSocketSignalingClient,
  type MqttClientLike,
  type MqttPublishOptions,
  type MqttSignalingOptions
} from '../src/webrtc/signaling-mqtt.js'
import { SignalingSessionAllowlist } from '../src/webrtc/signaling-allowlist.js'
import type { DataChannelLike, PeerConnectionLike } from '../src/webrtc/peer-session.js'

const secureLocation = { protocol: 'https:', hostname: 'app.example.test' }
const LOCAL_SIGNALING_ID = 'a-local'
const TOPIC_PREFIX = 'aurora/aurora/room-1'

function profile(overrides: Partial<WebRtcPeerConnectionProfile> = {}): WebRtcPeerConnectionProfile {
  return {
    mode: 'webrtc-only',
    appId: 'aurora',
    room: 'room-1',
    roomSecretRef: 'memory-room-secret',
    signalingBrokers: ['wss://broker.example.test/mqtt'],
    expectedStablePeerId: 'peer-remote',
    nodeName: 'Remote node',
    ...overrides
  }
}

class FakeBroker implements MqttClientLike {
  handlers = new Map<string, Array<(...args: any[]) => void>>()
  subscriptions: string[] = []
  publishes: Array<{ topic: string; payload: Uint8Array }> = []

  on(event: any, handler: (...args: any[]) => void): this {
    const bucket = this.handlers.get(event) ?? []
    bucket.push(handler)
    this.handlers.set(event, bucket)
    return this
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  subscribe(topic: string): void { this.subscriptions.push(topic) }
  async subscribeAsync(topic: string): Promise<void> { this.subscribe(topic) }
  unsubscribe(): void {}
  async unsubscribeAsync(): Promise<void> {}
  publish(topic: string, payload: Uint8Array, _options: MqttPublishOptions) {
    this.publishes.push({ topic, payload })
    return { waitForPublish: vi.fn() }
  }
  async publishAsync(topic: string, payload: Uint8Array, options: MqttPublishOptions): Promise<void> {
    this.publish(topic, payload, options)
  }
  end(): void {}
  async endAsync(): Promise<void> {}
}

class RosterFakeChannel implements DataChannelLike {
  readyState: DataChannelLike['readyState'] = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer | ArrayBufferView }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  constructor(readonly label: string) {}
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(data) }
  close(): void { this.readyState = 'closed'; this.onclose?.() }
  addEventListener(): void {}
  removeEventListener(): void {}
  open(): void { this.readyState = 'open'; this.onopen?.() }
}

class RosterFakePeerConnection implements PeerConnectionLike {
  localDescription: { type: 'offer' | 'answer'; sdp: string } | null = null
  remoteDescription: { type: 'offer' | 'answer'; sdp: string } | null = null
  connectionState = 'new'
  iceConnectionState = 'new'
  onicecandidate: PeerConnectionLike['onicecandidate'] = null
  ondatachannel: PeerConnectionLike['ondatachannel'] = null
  onconnectionstatechange: PeerConnectionLike['onconnectionstatechange'] = null
  oniceconnectionstatechange: PeerConnectionLike['oniceconnectionstatechange'] = null
  channels: RosterFakeChannel[] = []
  addedIceCandidates: unknown[] = []
  appliedRemoteDescriptions: Array<{ type: string; sdp: string }> = []
  statsReport = new Map<string, unknown>([
    ['pair-1', {
      type: 'candidate-pair',
      nominated: true,
      state: 'succeeded',
      currentRoundTripTime: 0.236,
      localCandidateId: 'local-relay',
      remoteCandidateId: 'remote-host',
      bytesSent: 10,
      bytesReceived: 20,
    }],
    ['local-relay', { type: 'local-candidate', candidateType: 'relay', protocol: 'udp' }],
    ['remote-host', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ])
  createDataChannel(label: string): DataChannelLike {
    const channel = new RosterFakeChannel(label)
    this.channels.push(channel)
    return channel
  }
  async createOffer() { return { type: 'offer' as const, sdp: 'offer-sdp' } }
  async createAnswer() { return { type: 'answer' as const, sdp: 'local-answer-sdp' } }
  async setLocalDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    this.localDescription = description
  }
  async setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    this.remoteDescription = description
    this.appliedRemoteDescriptions.push({ ...description })
  }
  async addIceCandidate(candidate: unknown): Promise<void> { this.addedIceCandidates.push(candidate) }
  async getStats(): Promise<Map<string, unknown>> { return this.statsReport }
  close(): void { this.connectionState = 'closed' }
}

async function roomKeys() {
  return deriveRoomKeys('memory-room-secret', 'aurora', 'room-1', { scryptDeriver: async () => new Uint8Array(32).fill(7) })
}

async function sealed(envelope: Record<string, unknown>): Promise<Uint8Array> {
  const keys = await roomKeys()
  try {
    return (await encodeJsonPayload(envelope, { key: keys.kSig })).payload
  } finally {
    keys.k0.fill(0); keys.kSig.fill(0); keys.kData.fill(0)
  }
}

// Envelope sealing and opening are real WebCrypto jobs, so draining
// microtasks is not enough; these settle on the timer queue.
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const ASYNC_ASSERTION_TIMEOUT_MS = 10_000

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + ASYNC_ASSERTION_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await flush()
}

function makeRosterHarness(overrides: Partial<WebRtcPeerConnectionProfile> = {}) {
  const broker = new FakeBroker()
  const pc = new RosterFakePeerConnection()
  const runtimeProfile = profile(overrides)
  let ids = 0
  const runtime = createBrowserWebRtcAuroraRuntime({
    mode: 'webrtc-only',
    profile: runtimeProfile,
    localStablePeerId: 'local-stable',
    localNodeName: 'This device',
    scryptDeriver: async () => new Uint8Array(32).fill(7),
    randomId: () => (ids++ === 0 ? LOCAL_SIGNALING_ID : `rpc-${ids}`),
    createPeerConnection: () => pc,
    signalingFactory: (options: MqttSignalingOptions) => new MqttWebSocketSignalingClient({
      ...options,
      mqttFactory: () => {
        setTimeout(() => broker.fire('connect'), 0)
        return broker
      }
    }),
    windowLocation: secureLocation
  })

  const deliver = async (topic: string, envelope: Record<string, unknown>): Promise<void> => {
    broker.fire('message', topic, await sealed(envelope))
    await flush()
  }

  const announce = async (from: string, stablePeerId: string, nodeName: string): Promise<void> => {
    await deliver(`${TOPIC_PREFIX}/presence/${from}`, {
      type: 'presence',
      app_id: 'aurora',
      room: 'room-1',
      from,
      peer_id: from,
      stable_peer_id: stablePeerId,
      node_name: nodeName
    })
  }

  const peer = runtime.peer as unknown as MeshPeerRegistryController & {
    connect(profile: WebRtcPeerConnectionProfile): Promise<void>
    snapshot(): { state: string; connectedSignalingPeerId?: string; connectedStablePeerId?: string; reconnectCount: number }
    isAuthorized(): boolean
  }
  return { runtime, peer, broker, pc, runtimeProfile, deliver, announce }
}

describe('W3 presence roster and per-session signaling allowlist', () => {
  it('measures candidate-pair evidence for the exact registered peer', async () => {
    const harness = makeRosterHarness()
    await harness.peer.connect(harness.runtimeProfile)
    await flush()
    await harness.announce('z-remote', 'peer-remote', 'Remote node')
    await flush()

    await expect(harness.peer.getPeerSelectedCandidatePairEvidence('peer-remote')).resolves.toMatchObject({
      selected: true,
      category: 'relay',
      roundTripTimeMs: 236,
      rawAddressRedacted: true,
    })
    await expect(harness.peer.getPeerSelectedCandidatePairEvidence('peer-unknown')).resolves.toMatchObject({
      selected: false,
      category: 'unknown',
      rawAddressRedacted: true,
    })

    await harness.runtime.close()
  })

  it('reports every device in a three-node room while only the invited one holds a session', async () => {
    const harness = makeRosterHarness()
    await harness.peer.connect(harness.runtimeProfile)
    await flush()

    await harness.announce('z-remote', 'peer-remote', 'Home node')
    await harness.announce('m-kitchen', 'peer-kitchen', 'Kitchen speaker')
    await harness.announce('q-studio', 'peer-studio', 'Studio desktop')
    await harness.announce('stale-local-signal', 'local-stable', 'This device')

    const roster = harness.peer.roster()
    expect(roster.discovered.map((peer) => peer.peerId).sort()).toEqual(['peer-kitchen', 'peer-remote', 'peer-studio'])
    expect(roster.discovered.find((peer) => peer.peerId === 'peer-kitchen')).toMatchObject({
      nodeName: 'Kitchen speaker',
      signalingPeerId: 'm-kitchen',
      connected: false
    })
    // Discovery is not a session: only the invited device is connected.
    expect(roster.peers.map((peer) => peer.peerId)).toEqual(['peer-remote'])
    expect(roster.discovered.find((peer) => peer.peerId === 'peer-remote')?.connected).toBe(true)

    await harness.runtime.close()
  })

  it('keeps a discovered device out of an authorized session until it pairs', async () => {
    const harness = makeRosterHarness()
    await harness.peer.connect(harness.runtimeProfile)
    await flush()

    await harness.announce('m-kitchen', 'peer-kitchen', 'Kitchen speaker')

    expect(harness.peer.roster().discovered.map((peer) => peer.peerId)).toEqual(['peer-kitchen'])
    // Being seen in the room starts nothing: no session for that device, and
    // no authorized route anywhere. Only the invited device holds an entry, and
    // it is still waiting for its peer.
    expect(harness.peer.roster().peers.map((peer) => peer.peerId)).toEqual(['peer-remote'])
    expect(harness.peer.roster().discovered[0]?.connected).toBe(false)
    expect(harness.peer.isAuthorized()).toBe(false)
    expect(harness.pc.appliedRemoteDescriptions).toHaveLength(0)
    expect(harness.broker.publishes.some(({ topic }) => topic.startsWith(`${TOPIC_PREFIX}/offer/`))).toBe(false)

    await harness.runtime.close()
  })

  it('refuses forged signaling that names an established session’s device', async () => {
    const harness = makeRosterHarness()
    await harness.peer.connect(harness.runtimeProfile)
    await flush()

    await harness.announce('z-remote', 'peer-remote', 'Home node')
    await harness.deliver(`${TOPIC_PREFIX}/answer/${LOCAL_SIGNALING_ID}`, {
      type: 'answer',
      app_id: 'aurora',
      room: 'room-1',
      from: 'z-remote',
      to: LOCAL_SIGNALING_ID,
      stable_peer_id: 'peer-remote',
      sdp: 'remote-answer-sdp'
    })
    harness.pc.channels[0]?.open()
    await flush()

    const established = harness.peer.snapshot()
    expect(established.connectedSignalingPeerId).toBe('z-remote')
    expect(harness.pc.appliedRemoteDescriptions).toEqual([{ type: 'answer', sdp: 'remote-answer-sdp' }])

    // A room member can seal envelopes, so it can claim any identity it likes.
    // None of these may reach the session that already belongs to peer-remote.
    await harness.deliver(`${TOPIC_PREFIX}/offer/${LOCAL_SIGNALING_ID}`, {
      type: 'offer',
      app_id: 'aurora',
      room: 'room-1',
      from: 'evil-remote',
      to: LOCAL_SIGNALING_ID,
      stable_peer_id: 'peer-remote',
      sdp: 'forged-offer-sdp'
    })
    await harness.deliver(`${TOPIC_PREFIX}/answer/${LOCAL_SIGNALING_ID}`, {
      type: 'answer',
      app_id: 'aurora',
      room: 'room-1',
      from: 'evil-remote',
      to: LOCAL_SIGNALING_ID,
      stable_peer_id: 'peer-remote',
      sdp: 'forged-answer-sdp'
    })
    await harness.deliver(`${TOPIC_PREFIX}/candidate/${LOCAL_SIGNALING_ID}`, {
      type: 'candidate',
      app_id: 'aurora',
      room: 'room-1',
      from: 'evil-remote',
      to: LOCAL_SIGNALING_ID,
      stable_peer_id: 'peer-remote',
      candidate: 'candidate:1 1 udp 2113937151 203.0.113.9 44444 typ host'
    })
    await harness.announce('evil-remote', 'peer-remote', 'Home node')
    await harness.deliver(`${TOPIC_PREFIX}/presence/evil-remote`, {
      type: 'presence_departed',
      app_id: 'aurora',
      room: 'room-1',
      from: 'evil-remote',
      peer_id: 'evil-remote',
      stable_peer_id: 'peer-remote'
    })

    // Effects, not early returns: no SDP applied, no candidate added, no state move.
    expect(harness.pc.appliedRemoteDescriptions).toEqual([{ type: 'answer', sdp: 'remote-answer-sdp' }])
    expect(harness.pc.addedIceCandidates).toEqual([])
    const after = harness.peer.snapshot()
    expect(after.state).toBe(established.state)
    expect(after.connectedSignalingPeerId).toBe('z-remote')
    expect(after.connectedStablePeerId).toBe('peer-remote')
    expect(after.reconnectCount).toBe(established.reconnectCount)
    // The forged announcement does not get to describe or retire the real device.
    const roster = harness.peer.roster()
    expect(roster.discovered).toHaveLength(1)
    expect(roster.discovered[0]).toMatchObject({ peerId: 'peer-remote', signalingPeerId: 'z-remote', connected: true })

    await harness.runtime.close()
  })
})

describe('SignalingSessionAllowlist', () => {
  it('binds on first contact and then admits only the bound device', () => {
    const allowlist = new SignalingSessionAllowlist({ expectedStablePeerId: 'peer-remote' })
    expect(allowlist.admits({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote' })).toBe(true)
    expect(allowlist.signalingPeerId).toBe('z-remote')
    // Direct channels carry no stable id of their own; the binding covers them.
    expect(allowlist.admits({ channel: 'answer', from: 'z-remote' })).toBe(true)
    expect(allowlist.admits({ channel: 'answer', from: 'evil-remote', stablePeerId: 'peer-remote' })).toBe(false)
    expect(allowlist.admits({ channel: 'presence', from: 'm-kitchen', stablePeerId: 'peer-kitchen' })).toBe(false)
  })

  it('lets discovery rebind a restarted device, and nothing else', () => {
    const allowlist = new SignalingSessionAllowlist({ expectedStablePeerId: 'peer-remote' })
    allowlist.admits({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote' })
    expect(allowlist.admits({ channel: 'offer', from: 'z-restarted', stablePeerId: 'peer-remote' })).toBe(false)
    expect(allowlist.admits({ channel: 'presence', from: 'z-restarted', stablePeerId: 'peer-remote' })).toBe(true)
    expect(allowlist.signalingPeerId).toBe('z-restarted')
  })

  it('pins an established session until its owner releases it', () => {
    const allowlist = new SignalingSessionAllowlist({ expectedStablePeerId: 'peer-remote' })
    allowlist.admits({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote' })
    allowlist.establish('z-remote')
    expect(allowlist.admits({ channel: 'presence', from: 'z-restarted', stablePeerId: 'peer-remote' })).toBe(false)
    allowlist.release()
    expect(allowlist.admits({ channel: 'presence', from: 'z-restarted', stablePeerId: 'peer-remote' })).toBe(true)
  })

  it('never widens past a configured signaling identity', () => {
    const allowlist = new SignalingSessionAllowlist({ expectedStablePeerId: 'peer-remote', expectedSignalingPeerId: 'z-remote' })
    expect(allowlist.admits({ channel: 'presence', from: 'z-restarted', stablePeerId: 'peer-remote' })).toBe(false)
    allowlist.release()
    expect(allowlist.admits({ channel: 'presence', from: 'z-restarted', stablePeerId: 'peer-remote' })).toBe(false)
    expect(allowlist.admits({ channel: 'presence', from: 'z-remote', stablePeerId: 'peer-remote' })).toBe(true)
  })
})
