import { sha256 } from '@noble/hashes/sha2.js'

import { base64UrlDecode, base64UrlEncode, bytesToHex } from './encoding.js'

export const CAP_FRAGMENTATION_V1 = 'fragmentation_v1' as const
export const CAP_BACKPRESSURE_V1 = 'backpressure_v1' as const
export const CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1 = 'scoped_event_subscriptions_v1' as const
export const CAP_CONSUMER_ONLY_V1 = 'consumer_only_v1' as const
export const CAP_PROVIDER_LEASE_V1 = 'provider_lease_v1' as const

export const KNOWN_PEER_CAPABILITIES = new Set<string>([
  CAP_FRAGMENTATION_V1,
  CAP_BACKPRESSURE_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_PROVIDER_LEASE_V1
])

export const DEFAULT_PEER_CAPABILITIES = Object.freeze([
  CAP_FRAGMENTATION_V1,
  CAP_BACKPRESSURE_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
] as const)

export const PEER_PROTOCOL_VERSION = 1 as const
export const PROTOCOL_HELLO_TYPE = 'protocol_hello' as const
export const FRAGMENT_FRAME_TYPE = 'fragment' as const

export type PeerRole = 'provider' | 'consumer' | 'hybrid'

export const DEFAULT_FRAGMENT_PAYLOAD_BYTES = 16 * 1024
export const DEFAULT_MAX_LOGICAL_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_PEER_AGGREGATE_BYTES = 16 * 1024 * 1024
export const DEFAULT_INCOMPLETE_TTL_SECONDS = 30
export const DEFAULT_MAX_FRAGMENTS = 4096
export const DEFAULT_MAX_COMPLETED_TOMBSTONES = 4096
export const DEFAULT_MAX_COMPLETED_TOMBSTONES_PER_PEER = 1024
const MAX_ID_LENGTH = 128
const MAX_CONTENT_TYPE_LENGTH = 128
const MAX_CAPABILITIES = 32
const MAX_CAPABILITY_LENGTH = 96
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/

export class PeerProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PeerProtocolError'
  }
}

export class FragmentProtocolError extends PeerProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'FragmentProtocolError'
  }
}

export class PeerProtocolLimits {
  readonly fragmentPayloadBytes: number
  readonly maxLogicalBytes: number
  readonly maxPeerAggregateBytes: number
  readonly incompleteTtlSeconds: number
  readonly maxFragments: number

  constructor(options: Partial<PeerProtocolLimitsInit> = {}) {
    this.fragmentPayloadBytes = options.fragmentPayloadBytes ?? DEFAULT_FRAGMENT_PAYLOAD_BYTES
    this.maxLogicalBytes = options.maxLogicalBytes ?? DEFAULT_MAX_LOGICAL_BYTES
    this.maxPeerAggregateBytes = options.maxPeerAggregateBytes ?? DEFAULT_MAX_PEER_AGGREGATE_BYTES
    this.incompleteTtlSeconds = options.incompleteTtlSeconds ?? DEFAULT_INCOMPLETE_TTL_SECONDS
    this.maxFragments = options.maxFragments ?? DEFAULT_MAX_FRAGMENTS
    this.validate()
  }

  private validate(): void {
    if (this.fragmentPayloadBytes <= 0 || this.fragmentPayloadBytes > DEFAULT_FRAGMENT_PAYLOAD_BYTES) {
      throw new PeerProtocolError('fragment_payload_bytes must be in 1..16384')
    }
    if (this.maxLogicalBytes <= 0 || this.maxLogicalBytes > DEFAULT_MAX_LOGICAL_BYTES) {
      throw new PeerProtocolError('max_logical_bytes must be in 1..8388608')
    }
    if (this.maxPeerAggregateBytes < this.maxLogicalBytes) {
      throw new PeerProtocolError('max_peer_aggregate_bytes must be >= max_logical_bytes')
    }
    if (this.maxPeerAggregateBytes > DEFAULT_MAX_PEER_AGGREGATE_BYTES) {
      throw new PeerProtocolError('max_peer_aggregate_bytes must be <= 16777216')
    }
    if (this.incompleteTtlSeconds <= 0 || this.incompleteTtlSeconds > DEFAULT_INCOMPLETE_TTL_SECONDS) {
      throw new PeerProtocolError('incomplete_ttl_seconds must be in 0..30')
    }
    if (this.maxFragments <= 0 || this.maxFragments > DEFAULT_MAX_FRAGMENTS) {
      throw new PeerProtocolError('max_fragments must be in 1..4096')
    }
  }

  asWire(): PeerProtocolLimitsWire {
    return {
      fragment_payload_bytes: this.fragmentPayloadBytes,
      max_logical_bytes: this.maxLogicalBytes,
      max_peer_aggregate_bytes: this.maxPeerAggregateBytes,
      incomplete_ttl_seconds: this.incompleteTtlSeconds,
      max_fragments: this.maxFragments
    }
  }
}

export interface PeerProtocolLimitsInit {
  fragmentPayloadBytes: number
  maxLogicalBytes: number
  maxPeerAggregateBytes: number
  incompleteTtlSeconds: number
  maxFragments: number
}

export interface PeerProtocolLimitsWire {
  fragment_payload_bytes: number
  max_logical_bytes: number
  max_peer_aggregate_bytes: number
  incomplete_ttl_seconds: number
  max_fragments: number
}

export interface ProtocolHello {
  role: PeerRole
  capabilities: ReadonlySet<string>
  limits: PeerProtocolLimits
  rawCapabilities: readonly string[]
}

export interface NegotiatedPeerProtocol {
  role: PeerRole
  capabilities: ReadonlySet<string>
  limits: PeerProtocolLimits
  supports(capability: string): boolean
}

interface FragmentAssembly {
  peerId: string
  messageId: string
  total: number
  totalLen: number
  digest: string
  contentType: string
  createdAt: number
  updatedAt: number
  fragments: Map<number, Uint8Array>
}

export interface FragmentFrame {
  type: typeof FRAGMENT_FRAME_TYPE
  v: typeof PEER_PROTOCOL_VERSION
  id: string
  seq: number
  total: number
  total_len: number
  sha256: string
  content_type: string
  payload_b64: string
}

export function buildProtocolHello(input: {
  role?: PeerRole
  capabilities?: Iterable<string>
  limits?: PeerProtocolLimits
} = {}): Record<string, unknown> {
  const role = parseRole(input.role ?? 'hybrid')
  const rawCapabilities = parseCapabilities(input.capabilities ?? DEFAULT_PEER_CAPABILITIES)
  const limits = input.limits ?? new PeerProtocolLimits()
  return {
    type: PROTOCOL_HELLO_TYPE,
    v: PEER_PROTOCOL_VERSION,
    role,
    capabilities: [...rawCapabilities],
    limits: limits.asWire()
  }
}

export function parseProtocolHello(frame: unknown): ProtocolHello {
  if (!isRecord(frame)) {
    throw new PeerProtocolError('hello must be an object')
  }
  if (frame.type !== PROTOCOL_HELLO_TYPE || frame.v !== PEER_PROTOCOL_VERSION) {
    throw new PeerProtocolError('unsupported protocol hello')
  }
  const role = parseRole(frame.role)
  const rawCapabilities = parseCapabilities(frame.capabilities ?? [])
  const limits = parseLimits(frame.limits)
  return {
    role,
    capabilities: new Set(rawCapabilities.filter((capability) => KNOWN_PEER_CAPABILITIES.has(capability))),
    limits,
    rawCapabilities
  }
}

export function negotiateProtocol(
  localHello: unknown,
  remoteHello: unknown
): NegotiatedPeerProtocol {
  const local = isProtocolHello(localHello) ? localHello : parseProtocolHello(localHello)
  const remote = isProtocolHello(remoteHello) ? remoteHello : parseProtocolHello(remoteHello)
  const capabilities = new Set([...local.capabilities].filter((capability) => remote.capabilities.has(capability)))
  return {
    role: remote.role,
    capabilities,
    limits: new PeerProtocolLimits({
      fragmentPayloadBytes: Math.min(local.limits.fragmentPayloadBytes, remote.limits.fragmentPayloadBytes),
      maxLogicalBytes: Math.min(local.limits.maxLogicalBytes, remote.limits.maxLogicalBytes),
      maxPeerAggregateBytes: Math.min(local.limits.maxPeerAggregateBytes, remote.limits.maxPeerAggregateBytes),
      incompleteTtlSeconds: Math.min(local.limits.incompleteTtlSeconds, remote.limits.incompleteTtlSeconds),
      maxFragments: Math.min(local.limits.maxFragments, remote.limits.maxFragments)
    }),
    supports(capability: string) {
      return capabilities.has(capability)
    }
  }
}

export function fragmentMessage(
  message: string,
  input: {
    messageId?: string
    contentType?: string
    limits?: PeerProtocolLimits
  } = {}
): FragmentFrame[] {
  if (typeof message !== 'string') {
    throw new FragmentProtocolError('message must be a string')
  }
  const contentType = input.contentType ?? 'application/json'
  if (typeof contentType !== 'string' || !contentType || contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    throw new FragmentProtocolError('content_type must be a non-empty bounded string')
  }
  const limits = input.limits ?? new PeerProtocolLimits()
  const payload = new TextEncoder().encode(message)
  if (payload.length > limits.maxLogicalBytes) {
    throw new FragmentProtocolError('logical message exceeds maximum size')
  }
  const fragmentCount = Math.max(1, Math.ceil(payload.length / limits.fragmentPayloadBytes))
  if (fragmentCount > limits.maxFragments) {
    throw new FragmentProtocolError('logical message exceeds maximum fragment count')
  }
  const messageId = requireIdentifier(input.messageId ?? cryptoRandomId(), 'message_id')
  const digest = bytesToHex(sha256(payload))
  const frames: FragmentFrame[] = []
  for (let seq = 0; seq < fragmentCount; seq += 1) {
    const start = seq * limits.fragmentPayloadBytes
    const chunk = payload.slice(start, start + limits.fragmentPayloadBytes)
    frames.push({
      type: FRAGMENT_FRAME_TYPE,
      v: PEER_PROTOCOL_VERSION,
      id: messageId,
      seq,
      total: fragmentCount,
      total_len: payload.length,
      sha256: digest,
      content_type: contentType,
      payload_b64: bytesToBase64Url(chunk)
    })
  }
  return frames
}

export class FragmentReassembler {
  readonly limits: PeerProtocolLimits
  private readonly clock: () => number
  private readonly assemblies = new Map<string, FragmentAssembly>()
  private readonly completed = new Map<string, number>()

  constructor(input: { limits?: PeerProtocolLimits; clock?: () => number } = {}) {
    this.limits = input.limits ?? new PeerProtocolLimits()
    this.clock = input.clock ?? (() => Date.now() / 1000)
  }

  receive(peerId: string, frame: unknown): string | null {
    const peer = requireIdentifier(peerId, 'peer_id')
    const now = this.clock()
    this.expire({ now })
    let parsed: ReturnType<typeof parseFragmentFrame>
    try {
      parsed = parseFragmentFrame(frame, this.limits)
    } catch (error) {
      const frameId = isRecord(frame) && typeof frame.id === 'string' ? frame.id : null
      if (frameId && frameId.length <= MAX_ID_LENGTH) {
        this.drop(`${peer}|${frameId}`)
      }
      throw error
    }
    const key = `${peer}|${parsed.messageId}`
    if (this.completed.has(key)) {
      this.bumpCompleted(key)
      return null
    }

    let assembly = this.assemblies.get(key)
    if (!assembly) {
      const projected = this.peerStoredBytes(peer) + parsed.payload.length
      if (projected > this.limits.maxPeerAggregateBytes) {
        this.drop(key)
        throw new FragmentProtocolError('peer fragment aggregate quota exceeded')
      }
      assembly = {
        peerId: peer,
        messageId: parsed.messageId,
        total: parsed.total,
        totalLen: parsed.totalLen,
        digest: parsed.digest,
        contentType: parsed.contentType,
        createdAt: now,
        updatedAt: now,
        fragments: new Map()
      }
      this.assemblies.set(key, assembly)
    } else {
      if (
        assembly.total !== parsed.total ||
        assembly.totalLen !== parsed.totalLen ||
        assembly.digest !== parsed.digest ||
        assembly.contentType !== parsed.contentType
      ) {
        this.drop(key)
        throw new FragmentProtocolError('fragment metadata conflicts with existing assembly')
      }
      const existing = assembly.fragments.get(parsed.seq)
      if (existing) {
        if (bytesEqual(existing, parsed.payload)) {
          assembly.updatedAt = now
          return null
        }
        this.drop(key)
        throw new FragmentProtocolError('fragment duplicate conflicts with existing payload')
      }
      const projected = this.peerStoredBytes(peer) + parsed.payload.length
      if (projected > this.limits.maxPeerAggregateBytes) {
        this.drop(key)
        throw new FragmentProtocolError('peer fragment aggregate quota exceeded')
      }
    }

    assembly.fragments.set(parsed.seq, parsed.payload)
    assembly.updatedAt = now
    if (assembly.fragments.size !== assembly.total) {
      return null
    }

    const ordered = new Uint8Array(assembly.totalLen)
    let offset = 0
    for (let index = 0; index < assembly.total; index += 1) {
      const fragment = assembly.fragments.get(index)
      if (!fragment) {
        this.drop(key)
        throw new FragmentProtocolError('missing fragment in completed assembly')
      }
      ordered.set(fragment, offset)
      offset += fragment.length
    }
    if (ordered.length !== assembly.totalLen) {
      this.drop(key)
      throw new FragmentProtocolError('reassembled length mismatch')
    }
    if (bytesToHex(sha256(ordered)) !== assembly.digest) {
      this.drop(key)
      throw new FragmentProtocolError('reassembled sha256 mismatch')
    }
    const logical = new TextDecoder().decode(ordered)
    this.drop(key)
    this.rememberCompleted(key, now)
    return logical
  }

  expire(input: { now?: number } = {}): number {
    const now = input.now ?? this.clock()
    let expired = 0
    for (const [key, assembly] of this.assemblies) {
      if (now - assembly.updatedAt > this.limits.incompleteTtlSeconds) {
        this.drop(key)
        expired += 1
      }
    }
    for (const [key, completedAt] of this.completed) {
      if (now - completedAt > this.limits.incompleteTtlSeconds) {
        this.completed.delete(key)
        expired += 1
      }
    }
    return expired
  }

  cleanupPeer(peerId: string): number {
    const peer = requireIdentifier(peerId, 'peer_id')
    let removed = 0
    for (const key of [...this.assemblies.keys()]) {
      if (key.startsWith(`${peer}|`)) {
        this.drop(key)
        removed += 1
      }
    }
    for (const key of [...this.completed.keys()]) {
      if (key.startsWith(`${peer}|`)) {
        this.completed.delete(key)
        removed += 1
      }
    }
    return removed
  }

  incompleteCount(peerId?: string | null): number {
    if (!peerId) return this.assemblies.size
    const peer = requireIdentifier(peerId, 'peer_id')
    let count = 0
    for (const key of this.assemblies.keys()) {
      if (key.startsWith(`${peer}|`)) count += 1
    }
    return count
  }

  completedCount(peerId?: string | null): number {
    if (!peerId) return this.completed.size
    const peer = requireIdentifier(peerId, 'peer_id')
    let count = 0
    for (const key of this.completed.keys()) {
      if (key.startsWith(`${peer}|`)) count += 1
    }
    return count
  }

  private rememberCompleted(key: string, completedAt: number): void {
    this.completed.set(key, completedAt)
    const peer = key.split('|', 1)[0] ?? key
    const completedKeys = [...this.completed.keys()].filter((entry) => entry.startsWith(`${peer}|`))
    while (this.completed.size > DEFAULT_MAX_COMPLETED_TOMBSTONES) {
      const oldest = this.completed.keys().next().value as string | undefined
      if (!oldest) break
      this.completed.delete(oldest)
    }
    const overflow = completedKeys.length - DEFAULT_MAX_COMPLETED_TOMBSTONES_PER_PEER
    for (let index = 0; index < overflow; index += 1) {
      const keyToRemove = completedKeys[index]
      if (keyToRemove) this.completed.delete(keyToRemove)
    }
  }

  private bumpCompleted(key: string): void {
    const value = this.completed.get(key)
    if (value !== undefined) {
      this.completed.delete(key)
      this.completed.set(key, value)
    }
  }

  private peerStoredBytes(peerId: string): number {
    let total = 0
    for (const [key, assembly] of this.assemblies) {
      if (key.startsWith(`${peerId}|`)) {
        for (const fragment of assembly.fragments.values()) total += fragment.length
      }
    }
    return total
  }

  private drop(key: string): void {
    this.assemblies.delete(key)
  }
}

function parseRole(value: unknown): PeerRole {
  if (value === 'provider' || value === 'consumer' || value === 'hybrid') return value
  throw new PeerProtocolError('role must be provider, consumer, or hybrid')
}

function parseCapabilities(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new PeerProtocolError('capabilities must be a bounded list')
  }
  const parsed: string[] = []
  const seen = new Set<string>()
  for (const capability of value) {
    if (typeof capability !== 'string' || !capability || capability.length > MAX_CAPABILITY_LENGTH) {
      throw new PeerProtocolError('capability names must be bounded strings')
    }
    if (!seen.has(capability)) {
      parsed.push(capability)
      seen.add(capability)
    }
  }
  return parsed
}

function parseLimits(value: unknown): PeerProtocolLimits {
  if (value == null) return new PeerProtocolLimits()
  if (!isRecord(value)) {
    throw new PeerProtocolError('limits must be an object')
  }
  const normalized: Partial<PeerProtocolLimitsInit> = {}
  for (const [key, mapped] of [
    ['fragment_payload_bytes', 'fragmentPayloadBytes'],
    ['max_logical_bytes', 'maxLogicalBytes'],
    ['max_peer_aggregate_bytes', 'maxPeerAggregateBytes'],
    ['incomplete_ttl_seconds', 'incompleteTtlSeconds'],
    ['max_fragments', 'maxFragments']
  ] as const) {
    const candidate = value[key]
    if (candidate !== undefined) {
      if (typeof candidate !== 'number' || Number.isNaN(candidate) || !Number.isFinite(candidate) || Number.isInteger(candidate) !== true && key !== 'incomplete_ttl_seconds') {
        throw new PeerProtocolError('limits must be numeric and not boolean')
      }
      if (typeof candidate === 'boolean') {
        throw new PeerProtocolError('limits must be numeric and not boolean')
      }
      ;(normalized as Record<string, number>)[mapped] = candidate
    }
  }
  return new PeerProtocolLimits(normalized)
}

function isProtocolHello(value: unknown): value is ProtocolHello {
  return isRecord(value)
    && (value.role === 'provider' || value.role === 'consumer' || value.role === 'hybrid')
    && value.capabilities instanceof Set
    && value.capabilities.size <= MAX_CAPABILITIES
    && [...value.capabilities].every((capability) =>
      typeof capability === 'string' && KNOWN_PEER_CAPABILITIES.has(capability)
    )
    && value.limits instanceof PeerProtocolLimits
    && Array.isArray(value.rawCapabilities)
    && value.rawCapabilities.length <= MAX_CAPABILITIES
    && value.rawCapabilities.every((capability) =>
      typeof capability === 'string'
      && capability.length > 0
      && capability.length <= MAX_CAPABILITY_LENGTH
    )
}

function parseFragmentFrame(frame: unknown, limits: PeerProtocolLimits): {
  messageId: string
  seq: number
  total: number
  totalLen: number
  digest: string
  contentType: string
  payload: Uint8Array
} {
  if (!isRecord(frame)) {
    throw new FragmentProtocolError('fragment must be an object')
  }
  if (frame.type !== FRAGMENT_FRAME_TYPE || frame.v !== PEER_PROTOCOL_VERSION) {
    throw new FragmentProtocolError('unsupported fragment frame')
  }
  const messageId = requireIdentifier(frame.id, 'id')
  const seq = frame.seq as unknown
  const total = frame.total as unknown
  const totalLen = frame.total_len as unknown
  if (!Number.isInteger(seq) || !Number.isInteger(total) || !Number.isInteger(totalLen)) {
    throw new FragmentProtocolError('seq, total, and total_len must be integers')
  }
  const seqNum = Number(seq)
  const totalNum = Number(total)
  const totalLenNum = Number(totalLen)
  if (totalNum <= 0 || totalNum > limits.maxFragments) {
    throw new FragmentProtocolError('invalid fragment total')
  }
  if (seqNum < 0 || seqNum >= totalNum) {
    throw new FragmentProtocolError('invalid fragment sequence')
  }
  if (totalLenNum < 0 || totalLenNum > limits.maxLogicalBytes) {
    throw new FragmentProtocolError('invalid total_len')
  }
  if (totalNum !== Math.max(1, Math.ceil(totalLenNum / limits.fragmentPayloadBytes))) {
    throw new FragmentProtocolError('fragment count does not match limits')
  }
  const digest = frame.sha256
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new FragmentProtocolError('sha256 must be lowercase hex')
  }
  const contentType = frame.content_type
  if (typeof contentType !== 'string' || !contentType || contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    throw new FragmentProtocolError('content_type must be a bounded string')
  }
  const payload = base64UrlToBytes(frame.payload_b64)
  if (payload.length > limits.fragmentPayloadBytes) {
    throw new FragmentProtocolError('fragment payload exceeds negotiated size')
  }
  if (seqNum < totalNum - 1 && payload.length !== limits.fragmentPayloadBytes) {
    throw new FragmentProtocolError('non-final fragment has invalid length')
  }
  if (seqNum === totalNum - 1) {
    const finalLen = totalLenNum - limits.fragmentPayloadBytes * (totalNum - 1)
    if (payload.length !== finalLen) {
      throw new FragmentProtocolError('final fragment has invalid length')
    }
  }
  return { messageId, seq: seqNum, total: totalNum, totalLen: totalLenNum, digest, contentType, payload }
}

function requireIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) {
    throw new PeerProtocolError(`${fieldName} must be a non-empty bounded string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') return false
  }
  return true
}

function bytesToBase64Url(bytes: Uint8Array): string {
  try {
    return base64UrlEncode(bytes)
  } catch (error) {
    throw new FragmentProtocolError('base64url encoding is unavailable')
  }
}

function base64UrlToBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > DEFAULT_FRAGMENT_PAYLOAD_BYTES * 2) {
    throw new FragmentProtocolError('payload_b64 must be a bounded string')
  }
  if (value.length % 4 === 1 || !BASE64URL_RE.test(value)) {
    throw new FragmentProtocolError('payload_b64 is not base64url')
  }
  try {
    return base64UrlDecode(value)
  } catch (error) {
    throw new FragmentProtocolError('payload_b64 is not base64url')
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!
  return diff === 0
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues(bytes)
  return bytesToHex(bytes)
}
