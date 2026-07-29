import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CAP_PROVIDER_LEASE_V1 } from '../src/webrtc/peer-protocol.js'
import { parseWebRtcJsonFrame } from '../src/webrtc/protocol.js'
import {
  AEAD_PARAMETERS,
  DATA_CHANNEL_LABEL,
  HKDF_INFO,
  INVITE_FORMAT_VERSION,
  PAIRING_PROTOCOL_VERSION,
  RPC_FRAME_TYPES,
  SCRYPT_PARAMETERS,
  SIGNALING_TOPICS,
  WEBRTC_THIN_CAPABILITY_VERSION,
  WEBRTC_THIN_PROTOCOL_CAPABILITIES,
  WEBRTC_THIN_PROTOCOL_VERSION
} from '../src/webrtc-protocol-contract.js'

interface Fixture {
  schema: string
  protocol_descriptor: Record<string, any>
  rpc_frames: Record<string, { frame: Record<string, unknown>; json: string }>
  peer_protocol: {
    capability_names: string[]
    local_hello: Record<string, any>
    consumer_hello: Record<string, any>
    negotiated: Record<string, any>
    fragmented_call: { logical_json: string; frames: Array<Record<string, any>> }
    subscriptions: {
      subscribe: { frame: Record<string, any>; json: string }
      subscribed: { frame: Record<string, any>; json: string }
      unsubscribe: { frame: Record<string, any>; json: string }
    }
    consumer_only: {
      call: { frame: Record<string, any>; json: string }
      error: { frame: Record<string, any>; json: string }
    }
    provider_lease_numbers: {
      capability: string
      accepted: Array<{
        name: string
        canonical_json: boolean
        frame: Record<string, unknown>
        json: string
      }>
      rejected: Array<{ name: string; error_fragment: string; json: string }>
    }
  }
  invite: { payload: Record<string, unknown>; token: string; url: string; json: string }
  reconnect: { inputs: Record<string, string>; challenge: { frame: Record<string, unknown>; json: string }; proof: { frame: Record<string, unknown>; json: string }; hmac_sha256_hex: string }
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8'))
}

function encodeInviteTokenFromJson(json: string): string {
  return `amv1.${Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`
}

describe('WebRTC web thin protocol vectors', () => {
  it('keeps the TS descriptor in parity with the Python descriptor fixture', () => {
    const descriptor = fixture().protocol_descriptor

    expect(WEBRTC_THIN_PROTOCOL_VERSION).toBe(descriptor.protocol_version)
    expect(WEBRTC_THIN_CAPABILITY_VERSION).toBe(descriptor.capability_version)
    expect(PAIRING_PROTOCOL_VERSION).toBe(descriptor.pairing_protocol_version)
    expect(INVITE_FORMAT_VERSION).toBe(descriptor.invite_format)
    expect(DATA_CHANNEL_LABEL).toBe(descriptor.data_channel_label)
    expect(SCRYPT_PARAMETERS).toEqual(descriptor.scrypt)
    expect(HKDF_INFO).toEqual(descriptor.hkdf_info)
    expect(AEAD_PARAMETERS).toEqual({
      algorithm: descriptor.aead.algorithm,
      nonceBytes: descriptor.aead.nonce_bytes,
      payload: descriptor.aead.payload,
      plaintextJson: descriptor.aead.plaintext_json
    })
    expect(SIGNALING_TOPICS).toEqual(descriptor.signaling_topics)
    expect([...RPC_FRAME_TYPES]).toEqual(descriptor.rpc_frame_types)
    expect(WEBRTC_THIN_PROTOCOL_CAPABILITIES.rpc.fragmentation).toBe(true)
    expect(WEBRTC_THIN_PROTOCOL_CAPABILITIES.rpc.backpressure).toBe(true)
    expect(WEBRTC_THIN_PROTOCOL_CAPABILITIES.rpc.scopedEventSubscriptions).toBe(true)
    expect(WEBRTC_THIN_PROTOCOL_CAPABILITIES.rpc.consumerOnlyPeer).toBe(true)
  })

  it('validates committed RPC frame JSON encodings', () => {
    const frames = fixture().rpc_frames
    for (const [name, vector] of Object.entries(frames)) {
      expect(JSON.parse(vector.json), name).toEqual(vector.frame)
      expect(RPC_FRAME_TYPES).toContain(vector.frame.type as any)
    }
    expect(frames.call?.frame).toEqual(
      expect.objectContaining({ type: 'call', id: 'req-001', method: 'Gateway.GetRegistry' })
    )
    expect(frames.cancel?.frame).toEqual(expect.objectContaining({ type: 'cancel', id: 'stream-002' }))
  })


  it('validates peer protocol vectors for fragmentation, subscriptions, and consumer-only role', () => {
    const peerProtocol = fixture().peer_protocol

    expect(peerProtocol.capability_names).toEqual([
      'fragmentation_v1',
      'backpressure_v1',
      'scoped_event_subscriptions_v1',
      'consumer_only_v1'
    ])
    expect(peerProtocol.local_hello).toEqual(
      expect.objectContaining({ type: 'protocol_hello', v: 1, role: 'hybrid' })
    )
    expect(peerProtocol.consumer_hello).toEqual(
      expect.objectContaining({ type: 'protocol_hello', v: 1, role: 'consumer' })
    )
    expect(peerProtocol.negotiated.role).toBe('consumer')
    expect(peerProtocol.fragmented_call.frames.length).toBeGreaterThan(1)
    for (const frame of peerProtocol.fragmented_call.frames) {
      expect(frame.type).toBe('fragment')
      expect(String(frame.payload_b64)).not.toContain('=')
    }

    const subscribed = peerProtocol.subscriptions.subscribed
    expect(Object.keys(JSON.parse(subscribed.json))).toEqual([
      'type',
      'id',
      'subscription_id',
      'accepted',
      'accepted_topics',
      'rejected_topics',
      'correlation_ids',
      'ttl_seconds',
      'reason',
      'idempotent'
    ])
    expect(JSON.parse(subscribed.json)).toEqual(subscribed.frame)
    expect(subscribed.frame).toEqual({
      type: 'subscribed',
      id: 'sub-001',
      subscription_id: 'sub-001',
      accepted: true,
      accepted_topics: ['Tooling.ProjectionInvalidated'],
      rejected_topics: [],
      correlation_ids: ['corr-event-001'],
      ttl_seconds: 60.0,
      reason: null,
      idempotent: false
    })
    expect(subscribed.frame).not.toHaveProperty('topics')
    expect(subscribed.frame).not.toHaveProperty('expires_at')

    const consumerError = peerProtocol.consumer_only.error
    expect(JSON.parse(consumerError.json)).toEqual(consumerError.frame)
    expect(consumerError.frame.error).toEqual({ code: 405, message: 'Local peer is consumer-only' })
  })

  it('enforces shared provider lease safe-integer semantics from raw JSON', () => {
    const vectors = fixture().peer_protocol.provider_lease_numbers
    const accepted = Object.fromEntries(vectors.accepted.map((vector) => [vector.name, vector]))

    expect(vectors.capability).toBe(CAP_PROVIDER_LEASE_V1)
    expect(new Set(vectors.accepted.map((vector) => vector.name))).toEqual(
      new Set([
        'canonical_integer_provider_lease',
        'integral_decimal_provider_lease',
        'safe_exponent_provider_lease',
        'canonical_integer_provider_unavailable',
        'max_safe_integer_provider_unavailable'
      ])
    )
    expect(new Set(vectors.rejected.map((vector) => vector.name))).toEqual(
      new Set([
        'fractional_revision_provider_lease',
        'boolean_revision_provider_lease',
        'negative_revision_provider_unavailable',
        'unsafe_revision_provider_unavailable',
        'negative_issued_at_provider_unavailable',
        'expiry_regression_provider_lease'
      ])
    )
    expect(accepted.integral_decimal_provider_lease?.json).toContain('.0')
    expect(accepted.safe_exponent_provider_lease?.json).toContain('1e3')

    for (const vector of vectors.accepted) {
      expect(parseWebRtcJsonFrame(vector.json), vector.name).toEqual(vector.frame)
      if (vector.canonical_json) {
        expect(vector.json, vector.name).toBe(JSON.stringify(vector.frame))
      }
    }

    for (const vector of vectors.rejected) {
      expect(() => parseWebRtcJsonFrame(vector.json), vector.name).toThrow(vector.error_fragment)
    }
  })


  it('validates reconnect challenge/proof wire shape', () => {
    const reconnect = fixture().reconnect
    expect(reconnect.challenge.frame).toEqual({
      type: 'mesh_auth_challenge_v1',
      challenge: reconnect.inputs.challenge,
      channel_binding: reconnect.inputs.channel_binding,
      claimant_peer_id: reconnect.inputs.claimant_peer_id,
      verifier_peer_id: reconnect.inputs.verifier_peer_id,
      claimant_signaling_peer_id: reconnect.inputs.claimant_signaling_peer_id,
      verifier_signaling_peer_id: reconnect.inputs.verifier_signaling_peer_id,
      room_name: reconnect.inputs.room_name
    })
    expect(reconnect.challenge.frame).not.toHaveProperty('token_id')
    expect(JSON.parse(reconnect.challenge.json)).toEqual(reconnect.challenge.frame)
    expect(reconnect.proof.frame).toEqual({
      ...reconnect.challenge.frame,
      type: 'mesh_auth_proof_v1',
      token_id: reconnect.inputs.token_id,
      proof: reconnect.hmac_sha256_hex
    })
    expect(reconnect.proof.frame).not.toHaveProperty('proof_hmac_sha256')
    expect(JSON.parse(reconnect.proof.json)).toEqual(reconnect.proof.frame)
  })

  it('validates deterministic amv1 invite encoding without importing UI code', () => {
    const invite = fixture().invite
    const token = encodeInviteTokenFromJson(invite.json)
    expect(token).toBe(invite.token)
    expect(`aurora://mesh/invite?i=${token}`).toBe(invite.url)
    expect(JSON.parse(invite.json)).toEqual(invite.payload)
  })
})
