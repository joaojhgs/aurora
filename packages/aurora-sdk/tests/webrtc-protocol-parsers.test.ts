import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { DataChannelFlowController, type DataChannelLike } from '../src/webrtc/datachannel-flow.js'
import { MeshEventSubscriptionRegistry } from '../src/webrtc/event-subscriptions.js'
import {
  FragmentReassembler,
  PeerProtocolLimits,
  buildProtocolHello,
  fragmentMessage,
  negotiateProtocol,
  parseProtocolHello
} from '../src/webrtc/peer-protocol.js'
import { buildSubscribeFrame, buildUnsubscribeFrame, parseWebRtcFrame, parseWebRtcJsonFrame } from '../src/webrtc/protocol.js'

type Fixture = {
  rpc_frames: { call: { frame: Record<string, unknown>; json: string }; result: { frame: Record<string, unknown>; json: string }; error: { frame: Record<string, unknown>; json: string }; event: { frame: Record<string, unknown>; json: string } }
  peer_protocol: {
    local_hello: Record<string, unknown>
    consumer_hello: Record<string, unknown>
    negotiated: { capabilities: string[]; role: string }
    fragmented_call: { logical_json: string; frames: Array<Record<string, unknown>> }
    subscriptions: {
      subscribe: { frame: Record<string, unknown>; json: string }
      subscribed: { frame: Record<string, unknown>; json: string }
      unsubscribe: { frame: Record<string, unknown>; json: string }
    }
  }
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8'))
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

class FakeChannel implements DataChannelLike {
  readyState = 'open'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  sent: unknown[] = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = listener as (...args: unknown[]) => void
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = listener as (...args: unknown[]) => void
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== fn))
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0
  }
}

describe('WebRTC actual-G002 protocol parsers', () => {
  it('accepts Python fixture RPC, subscription, hello, and fragment frames', () => {
    const vector = fixture()
    expect(parseWebRtcJsonFrame(vector.rpc_frames.call.json)).toEqual(vector.rpc_frames.call.frame)
    expect(parseWebRtcJsonFrame(vector.rpc_frames.result.json)).toEqual(vector.rpc_frames.result.frame)
    expect(parseWebRtcJsonFrame(vector.rpc_frames.error.json)).toEqual(vector.rpc_frames.error.frame)
    expect(parseWebRtcJsonFrame(vector.rpc_frames.event.json)).toEqual(vector.rpc_frames.event.frame)
    expect(parseWebRtcJsonFrame(vector.peer_protocol.subscriptions.subscribe.json)).toEqual(vector.peer_protocol.subscriptions.subscribe.frame)
    expect(parseWebRtcJsonFrame(vector.peer_protocol.subscriptions.subscribed.json)).toEqual(vector.peer_protocol.subscriptions.subscribed.frame)
    expect(parseWebRtcJsonFrame(vector.peer_protocol.subscriptions.unsubscribe.json)).toEqual(vector.peer_protocol.subscriptions.unsubscribe.frame)
    expect(parseWebRtcFrame(vector.peer_protocol.local_hello)).toEqual(parseProtocolHello(vector.peer_protocol.local_hello))
    expect(parseWebRtcFrame(vector.peer_protocol.fragmented_call.frames[0])).toEqual(vector.peer_protocol.fragmented_call.frames[0])
  })

  it('rejects prototype/accessor objects, wildcard topics, expires_at, bool numerics, and hostile sizes', () => {
    expect(() => parseWebRtcFrame(Object.create(null))).toThrow(/plain object/)
    const accessor: Record<string, unknown> = { type: 'call', id: 'x', method: 'Gateway.GetRegistry' }
    Object.defineProperty(accessor, 'params', { get: () => ({}) })
    expect(() => parseWebRtcFrame(accessor)).toThrow(/accessor/)
    expect(() => parseWebRtcFrame({ type: 'subscribe', id: 's', topics: ['TTS.+'] })).toThrow(/exact typed topic/)
    expect(() => parseWebRtcFrame({ ...fixture().peer_protocol.subscriptions.subscribed.frame, expires_at: 'never' })).toThrow(/ttl_seconds/)
    expect(() => parseWebRtcFrame({ type: 'subscribed', id: 's', subscription_id: 's', accepted: true, accepted_topics: ['A.B'], rejected_topics: [], correlation_ids: [], ttl_seconds: true, reason: null, idempotent: false })).toThrow(/ttl_seconds/)
    expect(() => parseWebRtcFrame({ type: 'call', id: 'x', method: 'm'.repeat(300) })).toThrow(/method/)
  })

  it('accepts structured topic reasons on rejected subscriptions', () => {
    expect(parseWebRtcFrame({
      type: 'subscribe_rejected',
      id: 'sub-assistant',
      reason: 'not_authorized',
      rejected_topics: [
        { topic: 'TTS.AudioChunk', reason: 'grant_not_found' },
        'Orchestrator.Response',
      ],
    })).toEqual({
      type: 'subscribe_rejected',
      id: 'sub-assistant',
      reason: 'not_authorized',
      rejected_topics: [
        { topic: 'TTS.AudioChunk', reason: 'grant_not_found' },
        'Orchestrator.Response',
      ],
    })
  })

  it('preserves bounded machine-readable reasons on RPC error frames', () => {
    const frame = {
      type: 'error',
      id: 'provider-readiness',
      error: {
        code: 425,
        message: 'Provider is not ready',
        reason_code: 'provider_not_ready'
      }
    }

    expect(parseWebRtcFrame(frame)).toEqual(frame)
    expect(() => parseWebRtcFrame({
      ...frame,
      error: { ...frame.error, reason_code: 'x'.repeat(129) }
    })).toThrow(/error.reason_code/)
  })

  it('enforces top-level frame size by UTF-8 bytes', () => {
    const json = JSON.stringify({ type: 'result', id: 'emoji', result: { value: '🙂' } })
    const byteLength = utf8Bytes(json)

    expect(parseWebRtcJsonFrame(json, { maxStringLength: byteLength })).toMatchObject({
      type: 'result',
      id: 'emoji',
      result: { value: '🙂' }
    })
    expect(() => parseWebRtcJsonFrame(json, { maxStringLength: byteLength - 1 })).toThrow(/bounded string/)
  })

  it('enforces nested string size by UTF-8 bytes', () => {
    const frame = { type: 'result', id: 'emoji', result: { value: '🙂🙂' } }

    expect(parseWebRtcFrame(frame, { maxStringLength: 8 })).toMatchObject({
      type: 'result',
      id: 'emoji',
      result: { value: '🙂🙂' }
    })
    expect(() => parseWebRtcFrame(frame, { maxStringLength: 7 })).toThrow(/oversized string/)
  })

  it('accepts generated registry permission enums while retaining a bounded array ceiling', () => {
    const generatedPermissionEnum = Array.from(
      { length: 349 },
      (_, index) => `Permission.${index}`,
    )
    expect(
      parseWebRtcFrame({
        type: 'result',
        id: 'registry',
        result: {
          output_schema: {
            properties: {
              permissions: {
                items: { enum: generatedPermissionEnum },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      result: {
        output_schema: {
          properties: {
            permissions: {
              items: { enum: generatedPermissionEnum },
            },
          },
        },
      },
    })
    expect(() =>
      parseWebRtcFrame({
        type: 'result',
        id: 'oversized',
        result: { values: Array.from({ length: 4097 }, () => null) },
      }),
    ).toThrow(/oversized array/)
  })



  it('strictly parses reconnect challenge/proof frames and Python terminal statuses', () => {
    const challenge = {
      type: 'mesh_auth_challenge_v1',
      challenge: 'a'.repeat(64),
      channel_binding: 'b'.repeat(64),
      claimant_peer_id: 'stable-answer',
      verifier_peer_id: 'stable-offer',
      claimant_signaling_peer_id: 'sig-answer',
      verifier_signaling_peer_id: 'sig-offer',
      room_name: 'lab-room'
    }
    expect(parseWebRtcFrame(challenge)).toEqual(challenge)
    expect(() => parseWebRtcFrame({ ...challenge, token_id: 'token-fixture-001' })).toThrow(/token_id/)
    const missingClaimantSignal = { ...challenge }
    delete (missingClaimantSignal as Partial<typeof challenge>).claimant_signaling_peer_id
    expect(() => parseWebRtcFrame(missingClaimantSignal)).toThrow(/id/)

    const proof = { ...challenge, type: 'mesh_auth_proof_v1', token_id: 'token-fixture-001', proof: 'c'.repeat(64) }
    expect(parseWebRtcFrame(proof)).toEqual(proof)
    const legacyProof = { ...proof, proof_hmac_sha256: 'c'.repeat(64) }
    delete (legacyProof as Partial<typeof proof>).proof
    expect(() => parseWebRtcFrame(legacyProof)).toThrow(/proof_hmac_sha256/)
    const missingVerifierSignal = { ...proof }
    delete (missingVerifierSignal as Partial<typeof proof>).verifier_signaling_peer_id
    expect(() => parseWebRtcFrame(missingVerifierSignal)).toThrow(/id/)

    for (const status of ['denied', 'expired', 'superseded', 'failed']) {
      expect(parseWebRtcFrame({ type: 'pairing_v2_terminal', status })).toEqual({ type: 'pairing_v2_terminal', status })
    }
    expect(() => parseWebRtcFrame({ type: 'pairing_v2_terminal', status: 'approved' })).toThrow(/terminal status/)
    expect(() => parseWebRtcFrame({ type: 'pairing_v2_terminal', status: 'accepted' })).toThrow(/terminal status/)
  })

  it('builds exact subscribe/unsubscribe frames with ttl_seconds only', () => {
    expect(buildSubscribeFrame({ id: 's1', topics: ['Tooling.ProjectionInvalidated'], correlationIds: ['c1'], ttlSeconds: 60 })).toEqual({
      type: 'subscribe',
      id: 's1',
      topics: ['Tooling.ProjectionInvalidated'],
      correlation_ids: ['c1'],
      ttl_seconds: 60
    })
    expect(buildUnsubscribeFrame('s1')).toEqual({ type: 'unsubscribe', id: 's1' })
    expect(() => buildSubscribeFrame({ id: 's1', topics: ['Tooling.*'] })).toThrow(/exact typed topic/)
  })

  it('parses provider lease and manifest ACK evidence with bounded fields', () => {
    const ack = {
      type: 'manifest_ack',
      compatible_services: ['Tooling'],
      incompatible_services: [],
      unused_services: [],
      active_protocol: 'projection-v1',
      active_version: 'v1',
      active_tier: 'projection',
      protocol_revision: 'v1',
      registry_revision: 'registry-1',
      export_policy_revision: 'policy-1',
      auth_grant_revision: 3,
      projection_digest: 'a'.repeat(64),
      services: [
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' }
      ]
    }
    expect(parseWebRtcFrame(ack)).toEqual(ack)
    const pythonOrderedAck = {
      ...ack,
      compatible_services: ['TTS', 'Tooling', 'Transcription'],
      services: [
        { service_id: 'TTS', service_label: '', status: 'compatible', reason_codes: [], reason: '' },
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' },
        { service_id: 'Transcription', service_label: '', status: 'compatible', reason_codes: [], reason: '' }
      ]
    }
    expect(parseWebRtcFrame(pythonOrderedAck)).toEqual(pythonOrderedAck)
    expect(parseWebRtcFrame({ type: 'manifest_ack', compatible_services: ['Tooling'] })).toMatchObject({
      type: 'manifest_ack',
      compatible_services: ['Tooling'],
      incompatible_services: [],
      unused_services: [],
      active_protocol: null,
      projection_digest: null
    })
    const missingServicesAck = { ...ack }
    delete (missingServicesAck as Partial<typeof ack>).services
    expect(() => parseWebRtcFrame(missingServicesAck)).toThrow(/requires services/)
    expect(() => parseWebRtcFrame({
      ...ack,
      incompatible_services: ['Tooling']
    })).toThrow(/both compatible_services and incompatible_services/)
    expect(() => parseWebRtcFrame({
      ...ack,
      services: [
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' },
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' }
      ]
    })).toThrow(/duplicate service_id/)
    expect(() => parseWebRtcFrame({ ...ack, projection_digest: 'not-a-digest' })).toThrow(/projection_digest/)
    expect(() => parseWebRtcFrame({
      ...ack,
      services: [{ service_id: 'Tooling', service_label: '', status: 'incompatible', reason_codes: ['method_not_advertised'], reason: '' }]
    })).toThrow(/contradict/)

    const lease = {
      type: 'provider_lease',
      peer_id: 'peer-a',
      connection_epoch: 'epoch-1',
      availability_revision: 1,
      issued_at_ms: 1000,
      expires_at_ms: 61_000,
      available: true
    }
    expect(parseWebRtcFrame(lease)).toEqual(lease)
    expect(() => parseWebRtcFrame({ ...lease, expires_at_ms: 999 })).toThrow(/expires/)
  })
})

describe('WebRTC peer protocol helpers', () => {
  it('negotiates actual G002 hello capabilities and reassembles fixture fragments once', () => {
    const vector = fixture().peer_protocol
    const negotiated = negotiateProtocol(vector.local_hello, vector.consumer_hello)
    expect(negotiated.role).toBe(vector.negotiated.role)
    expect([...negotiated.capabilities].sort()).toEqual([...vector.negotiated.capabilities].sort())

    const reassembler = new FragmentReassembler({ limits: new PeerProtocolLimits({ fragmentPayloadBytes: 8, maxLogicalBytes: 512, maxPeerAggregateBytes: 1024, incompleteTtlSeconds: 5, maxFragments: 32 }) })
    let logical: string | null = null
    for (const frame of vector.fragmented_call.frames) logical = reassembler.receive('peer-a', frame)
    expect(logical).toBe(vector.fragmented_call.logical_json)
    for (const frame of vector.fragmented_call.frames) expect(reassembler.receive('peer-a', frame)).toBeNull()
  })

  it('enforces fragmentation bounds, conflicting duplicates, and cleanup', () => {
    const limits = new PeerProtocolLimits({ fragmentPayloadBytes: 4, maxLogicalBytes: 64, maxPeerAggregateBytes: 64, incompleteTtlSeconds: 1, maxFragments: 16 })
    const frames = fragmentMessage('hello world', { messageId: 'm1', limits })
    const reassembler = new FragmentReassembler({ limits, clock: vi.fn(() => 0) })
    expect(reassembler.receive('peer-a', frames[0])).toBeNull()
    const conflicting = { ...frames[0], payload_b64: 'QUJDRA' }
    expect(() => reassembler.receive('peer-a', conflicting)).toThrow(/duplicate|conflict/i)
    expect(reassembler.incompleteCount('peer-a')).toBe(0)
    expect(() => fragmentMessage('x'.repeat(65), { limits })).toThrow(/maximum size/)
  })
})

describe('WebRTC DataChannel flow and scoped subscriptions', () => {
  it('waits for bufferedamountlow and cleans listeners on close', async () => {
    const channel = new FakeChannel()
    channel.bufferedAmount = 20
    const controller = new DataChannelFlowController(channel, { highWatermarkBytes: 10, lowWatermarkBytes: 2, maxQueueBytes: 100 })
    const sent = controller.send('payload')
    await Promise.resolve()
    expect(channel.sent).toHaveLength(0)
    channel.bufferedAmount = 0
    channel.emit('bufferedamountlow')
    await expect(sent).resolves.toBe(true)
    expect(channel.sent).toEqual(['payload'])
    controller.close()
    expect(channel.listenerCount('close')).toBe(0)
  })

  it('rejects queued sends immediately when channel closes', async () => {
    const channel = new FakeChannel()
    channel.bufferedAmount = 20
    const controller = new DataChannelFlowController(channel, { highWatermarkBytes: 10, lowWatermarkBytes: 2, maxQueueBytes: 100 })
    const sent = controller.send('payload')
    channel.readyState = 'closed'
    channel.emit('close')
    await expect(sent).resolves.toBe(false)
  })

  it('keeps exact topic/correlation/TTL subscription scope', () => {
    let now = 100
    const registry = new MeshEventSubscriptionRegistry({ clock: () => now, maxTtlSeconds: 10 })
    const result = registry.subscribe({ peerId: 'peer-a', id: 'sub-a', topics: ['Orchestrator.Response'], correlationIds: ['corr-a'], ttlSeconds: 5 })
    expect(result).toEqual(expect.objectContaining({ accepted: true, ttlSeconds: 5, idempotent: false }))
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'Orchestrator.Response', correlationId: 'corr-a' })).toBe(true)
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'Orchestrator.Response', correlationId: 'corr-b' })).toBe(false)
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'TTS.AudioChunk', correlationId: 'corr-a' })).toBe(false)
    expect(() => registry.subscribe({ peerId: 'peer-a', id: 'wild', topics: ['TTS.+'] })).toThrow(/topic/)
    now = 106
    expect(registry.cleanup()).toBe(1)
    expect(registry.snapshot('peer-a')).toHaveLength(0)
  })
})
