import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  DEFAULT_PEER_CAPABILITIES,
  FRAGMENT_FRAME_TYPE,
  FragmentProtocolError,
  FragmentReassembler,
  PeerProtocolLimits,
  buildProtocolHello,
  fragmentMessage,
  negotiateProtocol,
  parseProtocolHello
} from '../src/webrtc/index.js'

function fixture(): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8'))
}

describe('WebRTC peer protocol helpers', () => {
  it('keeps hello and capability negotiation aligned with the committed vectors', () => {
    const data = fixture().peer_protocol
    const local = buildProtocolHello({
      role: 'hybrid',
      capabilities: DEFAULT_PEER_CAPABILITIES,
      limits: new PeerProtocolLimits({
        fragmentPayloadBytes: data.local_hello.limits.fragment_payload_bytes,
        maxLogicalBytes: data.local_hello.limits.max_logical_bytes,
        maxPeerAggregateBytes: data.local_hello.limits.max_peer_aggregate_bytes,
        incompleteTtlSeconds: data.local_hello.limits.incomplete_ttl_seconds,
        maxFragments: data.local_hello.limits.max_fragments
      })
    })
    const parsed = parseProtocolHello(local)
    expect(parsed.role).toBe('hybrid')
    expect(parsed.capabilities.has(CAP_FRAGMENTATION_V1)).toBe(true)
    expect(parsed.capabilities.has(CAP_BACKPRESSURE_V1)).toBe(true)
    expect(parsed.capabilities.has(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)).toBe(true)
    expect(parsed.capabilities.has(CAP_CONSUMER_ONLY_V1)).toBe(false)
    expect(local).toEqual(data.local_hello)

    const negotiated = negotiateProtocol(local, data.consumer_hello)
    expect(negotiated.role).toBe('consumer')
    expect(negotiated.supports(CAP_FRAGMENTATION_V1)).toBe(true)
    expect(negotiated.supports(CAP_BACKPRESSURE_V1)).toBe(true)
    expect(negotiated.supports(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)).toBe(true)
    expect(negotiated.supports(CAP_CONSUMER_ONLY_V1)).toBe(false)
  })



  it('rejects inherited/prototype/accessor hello and fragment objects before field reads', () => {
    const data = fixture().peer_protocol
    const inheritedHello = Object.create(data.local_hello) as Record<string, unknown>
    expect(() => parseProtocolHello(inheritedHello)).toThrow(/object|hello/i)

    const inheritedLimits = { ...data.local_hello, limits: Object.create(data.local_hello.limits) as Record<string, unknown> }
    expect(() => parseProtocolHello(inheritedLimits)).toThrow(/limits/i)

    let helloAccessorInvoked = false
    const accessorHello: Record<string, unknown> = { ...data.local_hello }
    Object.defineProperty(accessorHello, 'role', {
      enumerable: true,
      get() {
        helloAccessorInvoked = true
        return 'hybrid'
      }
    })
    expect(() => parseProtocolHello(accessorHello)).toThrow(/object|hello/i)
    expect(helloAccessorInvoked).toBe(false)

    const limits = new PeerProtocolLimits({ fragmentPayloadBytes: 8, maxLogicalBytes: 512, maxPeerAggregateBytes: 1024, incompleteTtlSeconds: 5, maxFragments: 32 })
    const reassembler = new FragmentReassembler({ limits })
    const validFragment = data.fragmented_call.frames[0]
    const inheritedFragment = Object.create(validFragment) as Record<string, unknown>
    expect(() => reassembler.receive('peer-a', inheritedFragment)).toThrow(FragmentProtocolError)

    let fragmentAccessorInvoked = false
    const accessorFragment: Record<string, unknown> = { ...validFragment }
    Object.defineProperty(accessorFragment, 'id', {
      enumerable: true,
      get() {
        fragmentAccessorInvoked = true
        return 'fragment-call-001'
      }
    })
    expect(() => reassembler.receive('peer-a', accessorFragment)).toThrow(FragmentProtocolError)
    expect(fragmentAccessorInvoked).toBe(false)

    expect(parseProtocolHello(data.local_hello).role).toBe('hybrid')
    expect(reassembler.receive('peer-a', validFragment)).toBeNull()
  })

  it('fragments and reassembles a logical message exactly once', () => {
    const limits = new PeerProtocolLimits({
      fragmentPayloadBytes: 8,
      maxLogicalBytes: 512,
      maxPeerAggregateBytes: 1024,
      incompleteTtlSeconds: 5,
      maxFragments: 32
    })
    const logical = fixture().peer_protocol.fragmented_call.logical_json
    const frames = fragmentMessage(logical, { messageId: 'fragment-call-001', limits })
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every((frame) => frame.type === FRAGMENT_FRAME_TYPE)).toBe(true)
    expect(frames.every((frame) => !String(frame.payload_b64).includes('='))).toBe(true)

    const reassembler = new FragmentReassembler({ limits, clock: () => 1_000 })
    expect(reassembler.receive('peer-a', frames[1])).toBeNull()
    expect(reassembler.receive('peer-a', frames[0])).toBeNull()
    let completed: string | null = null
    for (const frame of frames.slice(2)) {
      completed = reassembler.receive('peer-a', frame)
    }
    expect(completed).toBe(logical)
    expect(reassembler.receive('peer-a', frames[0])).toBeNull()
  })

  it('fails closed for conflicting fragments and over-size logical payloads', () => {
    const limits = new PeerProtocolLimits({
      fragmentPayloadBytes: 8,
      maxLogicalBytes: 128,
      maxPeerAggregateBytes: 256,
      incompleteTtlSeconds: 1,
      maxFragments: 32
    })
    const reassembler = new FragmentReassembler({ limits, clock: () => 1_000 })
    const frames = fragmentMessage('{"type":"ping","id":"1","padding":"xxxxxxxx"}', { messageId: 'frag-deny', limits })
    const first = frames[0]
    if (first === undefined) throw new Error('expected at least one fragment')
    expect(reassembler.receive('peer-a', first)).toBeNull()
    expect(reassembler.incompleteCount('peer-a')).toBe(1)

    const conflicting = { ...first, payload_b64: 'QUJDREVGR0g' }
    expect(() => reassembler.receive('peer-a', conflicting)).toThrow(FragmentProtocolError)
    expect(reassembler.incompleteCount('peer-a')).toBe(0)

    expect(reassembler.receive('peer-a', first)).toBeNull()
    reassembler.cleanupPeer('peer-a')
    expect(() => fragmentMessage('x'.repeat(limits.maxLogicalBytes + 1), { limits })).toThrow(FragmentProtocolError)
  })
})
