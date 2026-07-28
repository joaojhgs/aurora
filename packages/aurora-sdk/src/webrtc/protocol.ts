import {
  FRAGMENT_FRAME_TYPE,
  PEER_PROTOCOL_VERSION,
  PROTOCOL_HELLO_TYPE,
  type FragmentFrame,
  parseProtocolHello,
  type ProtocolHello
} from './peer-protocol.js'

export type RpcFrameType = 'call' | 'result' | 'error' | 'chunk' | 'eof' | 'cancel' | 'event'
export type SubscriptionFrameType = 'subscribe' | 'subscribed' | 'subscribe_rejected' | 'unsubscribe' | 'unsubscribed'
export type SignalingFrameType = 'presence' | 'presence_departed' | 'offer' | 'answer' | 'candidate' | 'mesh_event'
export type PairingFrameType = 'pairing_v2_commit' | 'pairing_v2_reveal' | 'pairing_v2_terminal'
export type AuthFrameType = 'auth' | 'reauth' | 'mesh_auth_challenge_v1' | 'mesh_auth_proof_v1' | 'manifest' | 'manifest_request' | 'ping' | 'pong'

export interface CallFrame {
  type: 'call'
  id: string
  method: string
  params?: unknown
  correlation_id?: string
  identity?: unknown
}
export interface ResultFrame { type: 'result'; id: string; result?: unknown }
export interface ErrorFrame { type: 'error'; id: string; error: { code: number; message: string }; correlation_id?: string }
export interface ChunkFrame { type: 'chunk'; id: string; data?: unknown }
export interface EofFrame { type: 'eof'; id: string; cancelled?: boolean }
export interface CancelFrame { type: 'cancel'; id: string }
export interface EventFrame { type: 'event'; topic: string; params?: unknown; correlation_id?: string }

export interface SubscribeFrame { type: 'subscribe'; id: string; topics: string[]; correlation_ids?: string[]; ttl_seconds?: number }
export interface SubscribedFrame {
  type: 'subscribed'
  id: string
  subscription_id: string
  accepted: boolean
  accepted_topics: string[]
  rejected_topics: Array<string | { topic: string; reason?: string }>
  correlation_ids: string[]
  ttl_seconds: number
  reason: string | null
  idempotent: boolean
}
export interface SubscribeRejectedFrame { type: 'subscribe_rejected'; id: string; reason: string; rejected_topics?: string[] }
export interface UnsubscribeFrame { type: 'unsubscribe'; id: string }
export interface UnsubscribedFrame { type: 'unsubscribed'; id: string; subscription_id?: string; removed?: boolean }

export interface OfferFrame { type: 'offer'; app_id: string; room: string; from: string; to: string; sdp: string; stable_peer_id?: string; node_name?: string }
export interface AnswerFrame { type: 'answer'; app_id: string; room: string; from: string; to: string; sdp: string; stable_peer_id?: string; node_name?: string }
export interface CandidateFrame { type: 'candidate'; app_id: string; room: string; from: string; to: string; candidate: string }
export interface PresenceFrame { type: 'presence' | 'presence_departed'; app_id: string; room: string; peer_id: string; from?: string; stable_peer_id?: string; node_name?: string }

export interface PairingCommitFrame { type: 'pairing_v2_commit'; version: 2; handshake_id: string; channel_binding_sha256: string; nonce_commitment: string; identity: unknown }
export interface PairingRevealFrame { type: 'pairing_v2_reveal'; version: 2; handshake_id: string; channel_binding_sha256: string; nonce: string }
export interface PairingTerminalFrame { type: 'pairing_v2_terminal'; status: 'denied' | 'expired' | 'superseded' | 'failed'; pairing_session_id?: string; verification_code?: string; peer_id?: string; signaling_peer_id?: string }
export interface MeshAuthBindingFrame {
  type: 'mesh_auth_challenge_v1' | 'mesh_auth_proof_v1'
  challenge: string
  channel_binding: string
  claimant_peer_id: string
  verifier_peer_id: string
  claimant_signaling_peer_id: string
  verifier_signaling_peer_id: string
  room_name: string
}
export type MeshAuthChallengeFrame = MeshAuthBindingFrame & { type: 'mesh_auth_challenge_v1' }
export type MeshAuthProofFrame = MeshAuthBindingFrame & { type: 'mesh_auth_proof_v1'; token_id: string; proof: string }

export type AuroraRpcFrame = CallFrame | ResultFrame | ErrorFrame | ChunkFrame | EofFrame | CancelFrame | EventFrame
export type AuroraSubscriptionFrame = SubscribeFrame | SubscribedFrame | SubscribeRejectedFrame | UnsubscribeFrame | UnsubscribedFrame
export type AuroraSignalingFrame = OfferFrame | AnswerFrame | CandidateFrame | PresenceFrame
export type AuroraPairingFrame = PairingCommitFrame | PairingRevealFrame | PairingTerminalFrame
export type AuroraAuthFrame = MeshAuthChallengeFrame | MeshAuthProofFrame
export type AuroraProtocolFrame = AuroraRpcFrame | AuroraSubscriptionFrame | AuroraSignalingFrame | AuroraPairingFrame | AuroraAuthFrame | ProtocolHello | FragmentFrame | Record<string, unknown>

export class WebRtcProtocolParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebRtcProtocolParseError'
  }
}

export interface ParserLimits {
  maxStringLength: number
  maxArrayLength: number
  maxObjectKeys: number
  maxDepth: number
  maxTopicLength: number
  maxTopics: number
  maxTtlSeconds: number
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = Object.freeze({
  maxStringLength: 256 * 1024,
  maxArrayLength: 4096,
  maxObjectKeys: 128,
  maxDepth: 16,
  maxTopicLength: 256,
  maxTopics: 64,
  maxTtlSeconds: 300
})

const TYPE_MAX = 64
const ID_MAX = 128
const METHOD_MAX = 256
const TOPIC_RE = /^[A-Za-z0-9_.:/-]+$/
const HEX_64_RE = /^[0-9a-f]{64}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

export function parseWebRtcJsonFrame(json: string, limits: Partial<ParserLimits> = {}): AuroraProtocolFrame {
  if (typeof json !== 'string' || json.length > DEFAULT_PARSER_LIMITS.maxStringLength) {
    throw new WebRtcProtocolParseError('frame JSON must be a bounded string')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch {
    throw new WebRtcProtocolParseError('frame JSON is invalid')
  }
  return parseWebRtcFrame(decoded, limits)
}

export function parseWebRtcFrame(frame: unknown, limits: Partial<ParserLimits> = {}): AuroraProtocolFrame {
  const merged = { ...DEFAULT_PARSER_LIMITS, ...limits }
  const object = requirePlainRecord(frame, 'frame')
  validateJsonTree(object, merged)
  const type = requireString(object.type, 'type', TYPE_MAX)
  switch (type) {
    case 'call': return parseCall(object, merged)
    case 'result': return { type, id: requireId(object.id) as string, ...(object.result !== undefined ? { result: object.result } : {}) }
    case 'error': return parseErrorFrame(object)
    case 'chunk': return { type, id: requireId(object.id) as string, ...(object.data !== undefined ? { data: object.data } : {}) }
    case 'eof': return { type, id: requireId(object.id) as string, ...(object.cancelled !== undefined ? { cancelled: requireBoolean(object.cancelled, 'cancelled') } : {}) }
    case 'cancel': return { type, id: requireId(object.id) as string }
    case 'event': return parseEvent(object, merged)
    case 'subscribe': return parseSubscribe(object, merged)
    case 'subscribed': return parseSubscribed(object, merged)
    case 'subscribe_rejected': return parseSubscribeRejected(object, merged)
    case 'unsubscribe': return { type, id: requireId(object.id) as string }
    case 'unsubscribed': return parseUnsubscribed(object)
    case 'presence':
    case 'presence_departed': return parsePresence(object, type)
    case 'offer': return parseSdp(object, 'offer')
    case 'answer': return parseSdp(object, 'answer')
    case 'candidate': return parseCandidate(object)
    case 'pairing_v2_commit': return parsePairingCommit(object)
    case 'pairing_v2_reveal': return parsePairingReveal(object)
    case 'pairing_v2_terminal': return parsePairingTerminal(object)
    case 'mesh_auth_challenge_v1': return parseMeshAuthChallenge(object)
    case 'mesh_auth_proof_v1': return parseMeshAuthProof(object)
    case PROTOCOL_HELLO_TYPE: return parseProtocolHello(object)
    case FRAGMENT_FRAME_TYPE: return parseFragmentMetadata(object)
    default:
      if (isKnownControlType(type)) return object
      throw new WebRtcProtocolParseError(`unsupported frame type: ${type}`)
  }
}

export function buildSubscribeFrame(input: { id: string; topics: string[]; correlationIds?: string[]; ttlSeconds?: number }): SubscribeFrame {
  const frame: SubscribeFrame = {
    type: 'subscribe',
    id: requireId(input.id) as string,
    topics: normalizeTopics(input.topics, DEFAULT_PARSER_LIMITS)
  }
  if (input.correlationIds !== undefined) frame.correlation_ids = normalizeIds(input.correlationIds, 'correlation_ids')
  if (input.ttlSeconds !== undefined) frame.ttl_seconds = requirePositiveFiniteNumber(input.ttlSeconds, 'ttl_seconds', DEFAULT_PARSER_LIMITS.maxTtlSeconds)
  return frame
}

export function buildUnsubscribeFrame(id: string): UnsubscribeFrame {
  return { type: 'unsubscribe', id: requireId(id) as string }
}

function parseCall(object: Record<string, unknown>, _limits: ParserLimits): CallFrame {
  const frame: CallFrame = { type: 'call', id: requireId(object.id) as string, method: requireString(object.method, 'method', METHOD_MAX) }
  if (object.params !== undefined) frame.params = object.params
  if (object.correlation_id !== undefined) frame.correlation_id = requireId(object.correlation_id) as string
  if (object.identity !== undefined) frame.identity = object.identity
  return frame
}

function parseErrorFrame(object: Record<string, unknown>): ErrorFrame {
  const error = requirePlainRecord(object.error, 'error')
  const frame: ErrorFrame = {
    type: 'error',
    id: requireId(object.id) as string,
    error: {
      code: requireInteger(error.code, 'error.code', 0, 9999),
      message: requireString(error.message, 'error.message', 4096)
    }
  }
  if (object.correlation_id !== undefined) frame.correlation_id = requireId(object.correlation_id) as string
  return frame
}

function parseEvent(object: Record<string, unknown>, limits: ParserLimits): EventFrame {
  const frame: EventFrame = { type: 'event', topic: requireTopic(object.topic, limits) }
  if (object.params !== undefined) frame.params = object.params
  if (object.correlation_id !== undefined) frame.correlation_id = requireId(object.correlation_id) as string
  return frame
}

function parseSubscribe(object: Record<string, unknown>, limits: ParserLimits): SubscribeFrame {
  const input: { id: string; topics: string[]; correlationIds?: string[]; ttlSeconds?: number } = {
    id: requireId(object.id) as string,
    topics: requireStringArray(object.topics, 'topics', limits.maxTopics, limits.maxTopicLength)
  }
  if (object.correlation_ids !== undefined) input.correlationIds = requireStringArray(object.correlation_ids, 'correlation_ids', limits.maxArrayLength, ID_MAX)
  if (object.ttl_seconds !== undefined) input.ttlSeconds = requirePositiveFiniteNumber(object.ttl_seconds, 'ttl_seconds', limits.maxTtlSeconds)
  return buildSubscribeFrame(input)
}

function parseSubscribed(object: Record<string, unknown>, limits: ParserLimits): SubscribedFrame {
  if (Object.prototype.hasOwnProperty.call(object, 'expires_at')) throw new WebRtcProtocolParseError('subscribed uses ttl_seconds, not expires_at')
  return {
    type: 'subscribed',
    id: requireId(object.id) as string,
    subscription_id: requireId(object.subscription_id) as string,
    accepted: requireBoolean(object.accepted, 'accepted'),
    accepted_topics: normalizeTopics(requireStringArray(object.accepted_topics, 'accepted_topics', limits.maxTopics, limits.maxTopicLength), limits),
    rejected_topics: parseRejectedTopics(object.rejected_topics, limits),
    correlation_ids: normalizeIds(requireStringArray(object.correlation_ids, 'correlation_ids', limits.maxArrayLength, ID_MAX), 'correlation_ids'),
    ttl_seconds: requirePositiveFiniteNumber(object.ttl_seconds, 'ttl_seconds', limits.maxTtlSeconds),
    reason: object.reason === null ? null : requireString(object.reason, 'reason', 4096),
    idempotent: requireBoolean(object.idempotent, 'idempotent')
  }
}

function parseSubscribeRejected(object: Record<string, unknown>, limits: ParserLimits): SubscribeRejectedFrame {
  const frame: SubscribeRejectedFrame = { type: 'subscribe_rejected', id: requireId(object.id) as string, reason: requireString(object.reason, 'reason', 4096) }
  if (object.rejected_topics !== undefined) frame.rejected_topics = normalizeTopics(requireStringArray(object.rejected_topics, 'rejected_topics', limits.maxTopics, limits.maxTopicLength), limits)
  return frame
}

function parseUnsubscribed(object: Record<string, unknown>): UnsubscribedFrame {
  const frame: UnsubscribedFrame = { type: 'unsubscribed', id: requireId(object.id) as string }
  if (object.subscription_id !== undefined) frame.subscription_id = requireId(object.subscription_id) as string
  if (object.removed !== undefined) frame.removed = requireBoolean(object.removed, 'removed')
  return frame
}

function parsePresence(object: Record<string, unknown>, type: 'presence' | 'presence_departed'): PresenceFrame {
  const frame: PresenceFrame = {
    type,
    app_id: requireString(object.app_id, 'app_id', ID_MAX),
    room: requireString(object.room, 'room', ID_MAX),
    peer_id: requireId(object.peer_id) as string
  }
  if (object.from !== undefined) frame.from = requireId(object.from) as string
  if (object.stable_peer_id !== undefined) frame.stable_peer_id = requireId(object.stable_peer_id) as string
  if (object.node_name !== undefined) frame.node_name = requireString(object.node_name, 'node_name', 256)
  return frame
}

function parseSdp(object: Record<string, unknown>, type: 'offer' | 'answer'): OfferFrame | AnswerFrame {
  const base = {
    type,
    app_id: requireString(object.app_id, 'app_id', ID_MAX),
    room: requireString(object.room, 'room', ID_MAX),
    from: requireId(object.from) as string,
    to: requireId(object.to) as string,
    sdp: requireString(object.sdp, 'sdp', 1024 * 1024)
  }
  const optional = optionalPeerIdentity(object)
  return { ...base, ...optional } as OfferFrame | AnswerFrame
}

function parseCandidate(object: Record<string, unknown>): CandidateFrame {
  return {
    type: 'candidate',
    app_id: requireString(object.app_id, 'app_id', ID_MAX),
    room: requireString(object.room, 'room', ID_MAX),
    from: requireId(object.from) as string,
    to: requireId(object.to) as string,
    candidate: requireString(object.candidate, 'candidate', 32 * 1024)
  }
}

function parsePairingCommit(object: Record<string, unknown>): PairingCommitFrame {
  requireExactVersion2(object.version)
  const frame: PairingCommitFrame = {
    type: 'pairing_v2_commit',
    version: 2,
    handshake_id: requireId(object.handshake_id) as string,
    channel_binding_sha256: requireHex64(object.channel_binding_sha256, 'channel_binding_sha256'),
    nonce_commitment: requireHex64(object.nonce_commitment, 'nonce_commitment'),
    identity: requirePlainRecord(object.identity, 'identity')
  }
  return frame
}

function parsePairingReveal(object: Record<string, unknown>): PairingRevealFrame {
  requireExactVersion2(object.version)
  return {
    type: 'pairing_v2_reveal',
    version: 2,
    handshake_id: requireId(object.handshake_id) as string,
    channel_binding_sha256: requireHex64(object.channel_binding_sha256, 'channel_binding_sha256'),
    nonce: requireBase64Url(object.nonce, 'nonce', 128)
  }
}

function parsePairingTerminal(object: Record<string, unknown>): PairingTerminalFrame {
  const status = object.status
  if (status !== 'denied' && status !== 'expired' && status !== 'superseded' && status !== 'failed') throw new WebRtcProtocolParseError('invalid pairing terminal status')
  const frame: PairingTerminalFrame = { type: 'pairing_v2_terminal', status }
  if (object.pairing_session_id !== undefined) frame.pairing_session_id = requireHex64(object.pairing_session_id, 'pairing_session_id')
  if (object.verification_code !== undefined) frame.verification_code = requireString(object.verification_code, 'verification_code', 16)
  if (object.peer_id !== undefined) frame.peer_id = requireId(object.peer_id) as string
  if (object.signaling_peer_id !== undefined) frame.signaling_peer_id = requireId(object.signaling_peer_id) as string
  return frame
}

function parseMeshAuthChallenge(object: Record<string, unknown>): MeshAuthChallengeFrame {
  if (Object.prototype.hasOwnProperty.call(object, 'token_id')) throw new WebRtcProtocolParseError('mesh_auth_challenge_v1 must not include token_id')
  if (Object.prototype.hasOwnProperty.call(object, 'proof') || Object.prototype.hasOwnProperty.call(object, 'proof_hmac_sha256')) throw new WebRtcProtocolParseError('mesh_auth_challenge_v1 must not include proof')
  return parseMeshAuthBindings(object, 'mesh_auth_challenge_v1') as MeshAuthChallengeFrame
}

function parseMeshAuthProof(object: Record<string, unknown>): MeshAuthProofFrame {
  if (Object.prototype.hasOwnProperty.call(object, 'proof_hmac_sha256')) throw new WebRtcProtocolParseError('mesh_auth_proof_v1 uses proof, not proof_hmac_sha256')
  return {
    ...(parseMeshAuthBindings(object, 'mesh_auth_proof_v1') as MeshAuthProofFrame),
    token_id: requireString(object.token_id, 'token_id', ID_MAX),
    proof: requireHex64(object.proof, 'proof')
  }
}

function parseMeshAuthBindings(object: Record<string, unknown>, type: 'mesh_auth_challenge_v1' | 'mesh_auth_proof_v1'): MeshAuthBindingFrame {
  return {
    type,
    challenge: requireHex64(object.challenge, 'challenge'),
    channel_binding: requireHex64(object.channel_binding, 'channel_binding'),
    claimant_peer_id: requireId(object.claimant_peer_id) as string,
    verifier_peer_id: requireId(object.verifier_peer_id) as string,
    claimant_signaling_peer_id: requireId(object.claimant_signaling_peer_id) as string,
    verifier_signaling_peer_id: requireId(object.verifier_signaling_peer_id) as string,
    room_name: requireString(object.room_name, 'room_name', ID_MAX)
  }
}

function parseFragmentMetadata(object: Record<string, unknown>): FragmentFrame {
  return {
    type: FRAGMENT_FRAME_TYPE,
    v: requireInteger(object.v, 'v', PEER_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION) as typeof PEER_PROTOCOL_VERSION,
    id: requireId(object.id) as string,
    seq: requireInteger(object.seq, 'seq', 0, 4095),
    total: requireInteger(object.total, 'total', 1, 4096),
    total_len: requireInteger(object.total_len, 'total_len', 0, 8 * 1024 * 1024),
    sha256: requireHex64(object.sha256, 'sha256'),
    content_type: requireString(object.content_type, 'content_type', 128),
    payload_b64: requireBase64Url(object.payload_b64, 'payload_b64', 64 * 1024)
  }
}

function optionalPeerIdentity(object: Record<string, unknown>): { stable_peer_id?: string; node_name?: string } {
  const out: { stable_peer_id?: string; node_name?: string } = {}
  if (object.stable_peer_id !== undefined) out.stable_peer_id = requireId(object.stable_peer_id) as string
  if (object.node_name !== undefined) out.node_name = requireString(object.node_name, 'node_name', 256)
  return out
}

function parseRejectedTopics(value: unknown, limits: ParserLimits): Array<string | { topic: string; reason?: string }> {
  if (!Array.isArray(value) || value.length > limits.maxTopics) throw new WebRtcProtocolParseError('rejected_topics must be a bounded array')
  return value.map((item) => {
    if (typeof item === 'string') return requireTopic(item, limits)
    const object = requirePlainRecord(item, 'rejected_topic')
    const out: { topic: string; reason?: string } = { topic: requireTopic(object.topic, limits) }
    if (object.reason !== undefined) out.reason = requireString(object.reason, 'rejected_topic.reason', 4096)
    return out
  })
}

function requirePlainRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new WebRtcProtocolParseError(`${field} must be a plain object`)
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      throw new WebRtcProtocolParseError(`${field}.${key} must not be an accessor`)
    }
  }
  return value as Record<string, unknown>
}

function validateJsonTree(value: unknown, limits: ParserLimits, depth = 0): void {
  if (depth > limits.maxDepth) throw new WebRtcProtocolParseError('frame exceeds maximum nesting depth')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WebRtcProtocolParseError('frame contains non-finite number')
    return
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) throw new WebRtcProtocolParseError('frame contains oversized string')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) throw new WebRtcProtocolParseError('frame contains oversized array')
    for (const item of value) validateJsonTree(item, limits, depth + 1)
    return
  }
  const object = requirePlainRecord(value, 'frame')
  const keys = Object.keys(object)
  if (keys.length > limits.maxObjectKeys) throw new WebRtcProtocolParseError('frame contains too many fields')
  for (const key of keys) validateJsonTree(object[key], limits, depth + 1)
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new WebRtcProtocolParseError(`${field} must be a bounded string`)
  return value
}

function requireId(value: unknown): string {
  return requireString(value, 'id', ID_MAX)
}

function requireStringArray(value: unknown, field: string, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxCount) throw new WebRtcProtocolParseError(`${field} must be a bounded array`)
  return value.map((item) => requireString(item, field, maxLength))
}

function normalizeIds(values: string[], field: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const id = requireId(value)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function normalizeTopics(topics: string[], limits: ParserLimits): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const topic of topics) {
    const parsed = requireTopic(topic, limits)
    if (!seen.has(parsed)) {
      seen.add(parsed)
      out.push(parsed)
    }
  }
  if (out.length === 0) throw new WebRtcProtocolParseError('topics must be non-empty')
  return out
}

function requireTopic(value: unknown, limits: ParserLimits): string {
  const topic = requireString(value, 'topic', limits.maxTopicLength)
  if (!TOPIC_RE.test(topic) || topic.includes('*') || topic.includes('+')) throw new WebRtcProtocolParseError('topic must be an exact typed topic')
  return topic
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new WebRtcProtocolParseError(`${field} must be boolean`)
  return value
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < min || value > max) {
    throw new WebRtcProtocolParseError(`${field} must be a bounded integer`)
  }
  return value
}

function requirePositiveFiniteNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new WebRtcProtocolParseError(`${field} must be a positive finite number`)
  }
  return value
}

function requireHex64(value: unknown, field: string): string {
  const parsed = requireString(value, field, 64)
  if (!HEX_64_RE.test(parsed)) throw new WebRtcProtocolParseError(`${field} must be lowercase sha256 hex`)
  return parsed
}

function requireBase64Url(value: unknown, field: string, maxLength: number): string {
  const parsed = requireString(value, field, maxLength)
  if (!BASE64URL_RE.test(parsed) || parsed.includes('=')) throw new WebRtcProtocolParseError(`${field} must be unpadded base64url`)
  return parsed
}

function requireExactVersion2(value: unknown): void {
  if (value !== 2) throw new WebRtcProtocolParseError('pairing v2 frame requires version 2')
}

function isKnownControlType(type: string): boolean {
  return ['auth', 'reauth', 'manifest', 'manifest_request', 'ping', 'pong', 'mesh_event'].includes(type)
}
