import { MeshP2PTransport, type MeshP2PTransportOptions, type MeshPeerBridge, type MeshPeerManifest, type MeshRpcRequest, type MeshRpcResponse, type MeshStreamRpcRequest } from '../mesh.js'
import type { AuroraEvent } from '../types.js'
import { MeshEventSubscriptionRegistry } from './event-subscriptions.js'
import {
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  FragmentReassembler,
  PeerProtocolLimits,
  fragmentMessage,
  parseProtocolHello,
  type ProtocolHello
} from './peer-protocol.js'
import type { WebRtcPeerSession, PeerSessionSnapshot } from './peer-session.js'
import { buildWebRtcManifestAck, parseWebRtcMeshManifest } from './manifest.js'
import { DEFAULT_PARSER_LIMITS, parseWebRtcFrame, type AuroraProtocolFrame } from './protocol.js'

export interface WebRtcMeshPeerBridgeOptions {
  session: Pick<WebRtcPeerSession, 'sendFrame' | 'subscribeFrames' | 'subscribe' | 'getSnapshot'>
  remotePeerId: string
  localPeerRole?: 'consumer' | 'provider' | 'hybrid'
  timeoutMs?: number
  streamQueueLimit?: number
  fragmentationThresholdBytes?: number
  randomId?: () => string
  manifestParser?: (frame: unknown, expectedPeerId: string) => MeshPeerManifest
  clock?: () => number
}

export interface WebRtcMeshTransportOptions extends Omit<MeshP2PTransportOptions, 'bridge'> {
  session: WebRtcMeshPeerBridgeOptions['session']
  remotePeerId: string
  bridge?: Omit<WebRtcMeshPeerBridgeOptions, 'session' | 'remotePeerId'>
}

type PendingRpc = {
  id: string
  correlationId: string
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: unknown
  cleanup(): void
}

type PendingSubscribe = {
  id: string
  topics: string[]
  correlationIds: string[]
  resolve(value: SubscribeAck): void
  reject(error: unknown): void
  timer: unknown
  cleanup(): void
}

type PendingManifest = {
  resolve(value: MeshPeerManifest | null): void
  reject(error: unknown): void
  timer: unknown
}

type StreamController = {
  id: string
  topics: string[]
  correlationIds: string[]
  queue: Array<AuroraEvent | Record<string, unknown>>
  waiters: Array<() => void>
  done: boolean
  error: unknown
}

type SubscribeAck = {
  subscriptionId: string
  acceptedTopics: string[]
  correlationIds: string[]
  ttlSeconds: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_STREAM_QUEUE_LIMIT = 128
const DEFAULT_FRAGMENT_THRESHOLD = 16 * 1024
const MAX_INLINE_LOGICAL_BYTES = 64 * 1024
const SUBSCRIBE_TTL_SECONDS = 60
const TOPIC_RE = /^[A-Za-z0-9_.:/-]+$/

export class WebRtcMeshPeerBridge implements MeshPeerBridge {
  private readonly session: WebRtcMeshPeerBridgeOptions['session']
  private readonly remotePeerId: string
  private readonly localPeerRole: 'consumer' | 'provider' | 'hybrid'
  private readonly timeoutMs: number
  private readonly streamQueueLimit: number
  private readonly fragmentationThresholdBytes: number
  private readonly randomId: () => string
  private readonly manifestParser: ((frame: unknown, expectedPeerId: string) => MeshPeerManifest) | undefined
  private readonly clock: () => number
  private readonly pending = new Map<string, PendingRpc>()
  private readonly pendingSubscribes = new Map<string, PendingSubscribe>()
  private readonly pendingManifests = new Map<string, PendingManifest>()
  private readonly streams = new Map<string, StreamController>()
  private readonly eventSubscriptions: MeshEventSubscriptionRegistry
  private reassembler: FragmentReassembler
  private readonly timers = new Set<unknown>()
  private remoteProtocol: ProtocolHello | null = null
  private closed = false
  private manifest: MeshPeerManifest | null = null
  private unsubscribeFrames: (() => void) | undefined
  private unsubscribeSession: (() => void) | undefined

  constructor(options: WebRtcMeshPeerBridgeOptions) {
    this.session = options.session
    this.remotePeerId = requireIdentifier(options.remotePeerId, 'remotePeerId')
    this.localPeerRole = options.localPeerRole ?? 'consumer'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.streamQueueLimit = options.streamQueueLimit ?? DEFAULT_STREAM_QUEUE_LIMIT
    this.fragmentationThresholdBytes = options.fragmentationThresholdBytes ?? DEFAULT_FRAGMENT_THRESHOLD
    this.randomId = options.randomId ?? (() => `webrtc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
    this.manifestParser = options.manifestParser ?? ((frame, expectedPeerId) => parseWebRtcMeshManifest(assertRecord(frame, 'manifest frame'), expectedPeerId))
    this.clock = options.clock ?? (() => Date.now() / 1000)
    this.assertAuthenticatedPeerSnapshot(this.session.getSnapshot())
    this.eventSubscriptions = new MeshEventSubscriptionRegistry({ maxTopicsPerPeer: 32, clock: this.clock })
    this.reassembler = new FragmentReassembler({ limits: new PeerProtocolLimits(), clock: this.clock })
    this.unsubscribeFrames = this.session.subscribeFrames((frame) => this.handleFrame(frame))
    this.unsubscribeSession = this.session.subscribe((snapshot) => {
      try {
        this.handleSessionSnapshot(snapshot)
      } catch {
        // Session transition cleanup must fail pending bridge work closed, not crash host page event loops.
      }
    })
  }

  async call<TPayload = unknown>(request: MeshRpcRequest<TPayload>): Promise<MeshRpcResponse<unknown>> {
    this.assertOpen()
    this.assertPeer(request.peerId)
    if (request.signal?.aborted) throw abortError()
    const id = request.correlationId ?? this.randomId()
    const frame: Record<string, unknown> = {
      type: 'call',
      id,
      correlation_id: id,
      method: request.busTopic || request.method,
      params: stripMeshSelectorKeys(request.payload),
      identity: buildIdentity(request)
    }
    const timeoutMs = request.timeoutMs || this.timeoutMs
    return await new Promise<MeshRpcResponse<unknown>>((resolve, reject) => {
      let settled = false
      let pending: PendingRpc
      const settleReject = (error: unknown, cancel = false) => {
        if (settled) return
        settled = true
        this.pending.delete(id)
        pending.cleanup()
        if (cancel) void this.sendLogicalFrame({ type: 'cancel', id }).catch(() => undefined)
        reject(error)
      }
      const onAbort = () => settleReject(abortError(), true)
      pending = {
        id,
        correlationId: id,
        resolve: (value) => {
          if (settled) return
          settled = true
          pending.cleanup()
          if (isRecord(value) && ('error' in value || 'data' in value || 'status' in value)) {
            resolve(value as MeshRpcResponse<unknown>)
            return
          }
          resolve({ data: value, status: 200, peerId: this.remotePeerId, targetPeerId: request.peerId, correlationId: id })
        },
        reject: (error) => settleReject(error),
        timer: this.armTimer(timeoutMs, () => settleReject(new TimeoutError(`WebRTC mesh RPC timed out: ${request.busTopic || request.method}`), true)),
        cleanup: () => {
          this.clearTimer(pending.timer)
          request.signal?.removeEventListener('abort', onAbort)
        }
      }
      this.pending.set(id, pending)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.sendLogicalFrame(frame).catch((error) => settleReject(error))
    })
  }

  subscribe<TEventPayload = unknown>(request: MeshStreamRpcRequest): AsyncIterable<AuroraEvent<TEventPayload> | Record<string, unknown>> {
    this.assertOpen()
    this.assertPeer(request.peerId)
    const topics = normalizeTopics(request.topics)
    const correlationIds = normalizeCorrelationIds(readCorrelationIds(request))
    if (!this.remoteProtocol?.capabilities.has(CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)) throw new Error('unsupported scoped_event_subscriptions_v1')
    if (request.signal?.aborted) throw abortError()
    const id = this.randomId()
    const stream: StreamController = { id, topics, correlationIds, queue: [], waiters: [], done: false, error: null }
    const abort = () => {
      this.cancelSubscription(id, abortError())
      void this.sendLogicalFrame({ type: 'unsubscribe', id }).catch(() => undefined)
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    this.streams.set(id, stream)
    void this.openSubscription(id, topics, correlationIds, request.timeoutMs ?? this.timeoutMs, request.signal, abort).catch((error) => this.failStream(stream, error))
    return this.iterateStream<TEventPayload>(stream, request.signal, abort)
  }

  async getManifest(peerId: string): Promise<MeshPeerManifest | null> {
    this.assertOpen()
    this.assertPeer(peerId)
    if (this.manifest) return this.manifest
    if (!this.manifestParser) return null
    if (this.pendingManifests.size > 0) {
      return await new Promise<MeshPeerManifest | null>((resolve, reject) => {
        this.pendingManifests.set(`wait-${this.pendingManifests.size + 1}`, {
          resolve,
          reject,
          timer: this.armTimer(this.timeoutMs, () => reject(new TimeoutError('WebRTC mesh manifest request timed out')))
        })
      })
    }
    return await new Promise<MeshPeerManifest | null>((resolve, reject) => {
      const pending: PendingManifest = {
        resolve,
        reject,
        timer: this.armTimer(this.timeoutMs, () => {
          const error = new TimeoutError('WebRTC mesh manifest request timed out')
          for (const item of this.pendingManifests.values()) {
            this.clearTimer(item.timer)
            item.reject(error)
          }
          this.pendingManifests.clear()
        })
      }
      this.pendingManifests.set('manifest', pending)
      this.sendLogicalFrame({ type: 'manifest_request' }).catch((error) => {
        this.clearTimer(pending.timer)
        this.pendingManifests.delete('manifest')
        reject(error)
      })
    })
  }


  getDiagnostics(): {
    pendingCallCount: number
    pendingStreamCount: number
    pendingSubscriptionCount: number
    pendingFragmentCount: number
    bufferPressureHighWaterBytes: number
    remoteProtocolCapabilities: string[]
  } {
    return {
      pendingCallCount: this.pending.size,
      pendingStreamCount: this.streams.size,
      pendingSubscriptionCount: this.pendingSubscribes.size,
      pendingFragmentCount: 0,
      bufferPressureHighWaterBytes: 0,
      remoteProtocolCapabilities: [...(this.remoteProtocol?.capabilities ?? [])]
    }
  }

  close(reason = 'bridge closed'): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeFrames?.()
    this.unsubscribeSession?.()
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(new Error(reason))
    }
    this.pending.clear()
    for (const pending of this.pendingSubscribes.values()) {
      pending.cleanup()
      pending.reject(new Error(reason))
    }
    this.pendingSubscribes.clear()
    for (const pending of this.pendingManifests.values()) {
      this.clearTimer(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingManifests.clear()
    for (const stream of this.streams.values()) this.failStream(stream, new Error(reason))
    this.streams.clear()
    this.reassembler.cleanupPeer(this.remotePeerId)
    this.clearAllTimers()
  }

  private async openSubscription(id: string, topics: string[], correlationIds: string[], timeoutMs: number, signal?: AbortSignal, abortListener?: () => void): Promise<void> {
    const ack = await new Promise<SubscribeAck>((resolve, reject) => {
      let pending: PendingSubscribe
      const cleanup = () => {
        this.clearTimer(pending.timer)
        if (abortListener) signal?.removeEventListener('abort', abortListener)
      }
      pending = {
        id,
        topics,
        correlationIds,
        resolve,
        reject,
        timer: this.armTimer(timeoutMs, () => {
          this.pendingSubscribes.delete(id)
          cleanup()
          reject(new TimeoutError('WebRTC mesh subscription timed out'))
        }),
        cleanup
      }
      this.pendingSubscribes.set(id, pending)
      const frame: Record<string, unknown> = { type: 'subscribe', id, topics, correlation_ids: correlationIds, ttl_seconds: SUBSCRIBE_TTL_SECONDS }
      this.sendLogicalFrame(frame).catch((error) => {
        this.pendingSubscribes.delete(id)
        cleanup()
        reject(error)
      })
    })
    this.eventSubscriptions.subscribe({ peerId: this.remotePeerId, id: ack.subscriptionId, topics: ack.acceptedTopics, correlationIds: ack.correlationIds, ttlSeconds: ack.ttlSeconds })
  }

  private async *iterateStream<TEventPayload>(stream: StreamController, signal?: AbortSignal, abortListener?: () => void): AsyncIterable<AuroraEvent<TEventPayload> | Record<string, unknown>> {
    try {
      while (true) {
        if (stream.error) throw stream.error
        const next = stream.queue.shift()
        if (next !== undefined) {
          yield next as AuroraEvent<TEventPayload> | Record<string, unknown>
          continue
        }
        if (stream.done) return
        await new Promise<void>((resolve) => stream.waiters.push(resolve))
      }
    } finally {
      stream.done = true
      this.streams.delete(stream.id)
      this.cancelSubscription(stream.id, new Error('subscription closed'))
      this.eventSubscriptions.unsubscribe(this.remotePeerId, stream.id)
      if (abortListener) signal?.removeEventListener('abort', abortListener)
      if (!this.closed) void this.sendLogicalFrame({ type: 'unsubscribe', id: stream.id }).catch(() => undefined)
    }
  }

  private resetEpoch(reason: string): void {
    const error = new TransportClosedError(
      `WebRTC mesh transport lost during epoch reset: ${reason}`
    )
    for (const pending of [...this.pending.values()]) pending.reject(error)
    this.pending.clear()
    for (const pending of [...this.pendingSubscribes.values()]) {
      try { pending.cleanup() } catch {}
      pending.reject(error)
    }
    this.pendingSubscribes.clear()
    for (const pending of [...this.pendingManifests.values()]) {
      try { this.clearTimer(pending.timer) } catch {}
      pending.reject(error)
    }
    this.pendingManifests.clear()
    for (const stream of this.streams.values()) this.failStream(stream, error)
    this.streams.clear()
    for (const subscription of this.eventSubscriptions.snapshot(this.remotePeerId)) {
      try { this.eventSubscriptions.unsubscribe(this.remotePeerId, subscription.id) } catch {}
    }
    this.reassembler.cleanupPeer(this.remotePeerId)
    this.remoteProtocol = null
    this.manifest = null
    this.clearAllTimers()
  }

  private handleSessionSnapshot(snapshot: PeerSessionSnapshot): void {
    if (snapshot.state === 'closed' || snapshot.state === 'failed') {
      this.close(`session ${snapshot.state}`)
      return
    }
    if (snapshot.state !== 'authorized' || !snapshot.authorized) this.resetEpoch(`session ${snapshot.state}`)
  }

  private handleFrame(raw: unknown): void {
    if (this.closed) return
    try {
      const logical = this.logicalFrameFromRaw(raw)
      if (logical === null) return
      if (isRecord(logical) && logical.type === 'protocol_hello') {
        this.setRemoteProtocol(parseProtocolHello(logical))
        return
      }
      const frame = parseWebRtcFrame(logical, parserLimitsFor(this.remoteProtocol))
      this.dispatchFrame(frame)
    } catch (error) {
      // Unknown malformed inbound frames are fail-closed for assemblies but should not crash the app shell.
      if (error instanceof Error && error.name === 'FragmentProtocolError') this.reassembler.cleanupPeer(this.remotePeerId)
    }
  }

  private logicalFrameFromRaw(raw: unknown): unknown | null {
    if (isRecord(raw) && raw.type === 'fragment') {
      if (!this.remoteProtocol?.capabilities.has(CAP_FRAGMENTATION_V1)) throw new Error('received fragment before fragmentation capability negotiation')
      const json = this.reassembler.receive(this.remotePeerId, raw)
      return json === null ? null : JSON.parse(json)
    }
    return raw
  }

  private dispatchFrame(frame: AuroraProtocolFrame): void {
    if (!isRecord(frame)) return
    switch (frame.type) {
      case 'protocol_hello':
        this.setRemoteProtocol(parseProtocolHello(frame))
        return
      case 'result':
        this.resolvePending(String(frame.id), frame.result)
        return
      case 'error':
        this.resolvePendingError(String(frame.id), frame as unknown as { error: unknown; correlation_id?: string })
        this.failStreamById(String(frame.id), normalizeRemoteError(frame.error))
        return
      case 'chunk':
        this.enqueueStream(String(frame.id), frame.data)
        return
      case 'eof':
        this.finishStream(String(frame.id))
        return
      case 'cancel':
        this.finishStream(String(frame.id))
        return
      case 'event':
        this.dispatchEvent(frame as unknown as { topic: string; params?: unknown; correlation_id?: string })
        return
      case 'subscribed':
        this.resolveSubscribe(frame as unknown as { id: string; subscription_id: string; accepted_topics: string[]; correlation_ids: string[]; ttl_seconds: number })
        return
      case 'subscribe_rejected':
        this.rejectSubscribe(String(frame.id), new Error(String(frame.reason)))
        return
      case 'unsubscribed':
        this.eventSubscriptions.unsubscribe(this.remotePeerId, String(frame.subscription_id ?? frame.id))
        return
      case 'call':
        void this.rejectInboundCall(frame as unknown as { id: string })
        return
      case 'manifest':
        this.handleManifest(frame)
        return
      case 'ping':
        void this.sendLogicalFrame({ type: 'pong', id: typeof frame.id === 'string' ? frame.id : undefined }).catch(() => undefined)
        return
      default:
        return
    }
  }

  private setRemoteProtocol(protocol: ProtocolHello): void {
    this.remoteProtocol = protocol
    this.reassembler.cleanupPeer(this.remotePeerId)
    this.reassembler = new FragmentReassembler({ limits: protocol.limits, clock: this.clock })
  }

  private resolvePending(id: string, value: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    pending.resolve(value)
  }

  private resolvePendingError(id: string, frame: { error: unknown; correlation_id?: string }): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    const code = isRecord(frame.error) && typeof frame.error.code === 'number' ? frame.error.code : undefined
    pending.resolve({ error: frame.error, status: code, correlationId: frame.correlation_id ?? pending.correlationId, peerId: this.remotePeerId, targetPeerId: this.remotePeerId })
  }

  private enqueueStream(id: string, data: unknown): void {
    const stream = this.streams.get(id)
    if (!stream || stream.done) return
    if (stream.queue.length >= this.streamQueueLimit) {
      this.failStream(stream, new Error('WebRTC mesh stream queue overflow'))
      void this.sendLogicalFrame({ type: 'cancel', id }).catch(() => undefined)
      return
    }
    stream.queue.push(isRecord(data) ? data : { data })
    this.wakeStream(stream)
  }

  private dispatchEvent(frame: { topic: string; params?: unknown; correlation_id?: string }): void {
    if (!this.eventSubscriptions.isInterested({ peerId: this.remotePeerId, topic: frame.topic, correlationId: frame.correlation_id ?? null })) return
    for (const stream of this.streams.values()) {
      if (!stream.topics.includes(frame.topic)) continue
      if (stream.correlationIds.length > 0 && (!frame.correlation_id || !stream.correlationIds.includes(frame.correlation_id))) continue
      const kind = readEventKind(frame.params) ?? frame.topic
      this.enqueueStream(stream.id, { kind, topic: frame.topic, payload: frame.params, correlation_id: frame.correlation_id, peer_id: this.remotePeerId, target_peer_id: this.remotePeerId })
    }
  }

  private finishStream(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) return
    stream.done = true
    this.wakeStream(stream)
  }

  private failStreamById(id: string, error: unknown): void {
    const stream = this.streams.get(id)
    if (stream) this.failStream(stream, error)
  }

  private failStream(stream: StreamController, error: unknown): void {
    stream.error = error
    stream.done = true
    this.wakeStream(stream)
  }

  private wakeStream(stream: StreamController): void {
    for (const resolve of stream.waiters.splice(0)) resolve()
  }

  private resolveSubscribe(frame: { id: string; subscription_id: string; accepted_topics: string[]; correlation_ids: string[]; ttl_seconds: number }): void {
    const pending = this.pendingSubscribes.get(frame.id)
    if (!pending) return
    this.pendingSubscribes.delete(frame.id)
    pending.cleanup()
    try {
      const acceptedTopics = normalizeTopics(frame.accepted_topics)
      const acceptedCorrelations = normalizeCorrelationIds(frame.correlation_ids)
      if (frame.subscription_id !== pending.id) throw new Error('subscription ack id mismatch')
      if (frame.ttl_seconds > 120) throw new Error('subscription ttl exceeds supported bound')
      if (!isSubset(acceptedTopics, pending.topics) || acceptedTopics.length !== pending.topics.length) throw new Error('subscription ack topics mismatch')
      if (!sameStringSet(acceptedCorrelations, pending.correlationIds)) throw new Error('subscription ack correlations mismatch')
      pending.resolve({ subscriptionId: frame.subscription_id, acceptedTopics, correlationIds: acceptedCorrelations, ttlSeconds: frame.ttl_seconds })
    } catch (error) {
      pending.reject(error)
    }
  }

  private rejectSubscribe(id: string, error: unknown): void {
    const pending = this.pendingSubscribes.get(id)
    if (!pending) return
    this.pendingSubscribes.delete(id)
    pending.cleanup()
    pending.reject(error)
  }

  private cancelSubscription(id: string, error: unknown): void {
    this.rejectSubscribe(id, error)
  }

  private async rejectInboundCall(frame: { id: string }): Promise<void> {
    if (this.localPeerRole === 'consumer' || this.remoteProtocol?.role === 'consumer' || this.remoteProtocol?.capabilities.has(CAP_CONSUMER_ONLY_V1)) {
      await this.sendLogicalFrame({ type: 'error', id: frame.id, correlation_id: frame.id, error: { code: 405, message: 'Local peer is consumer-only' } })
    }
  }

  private handleManifest(frame: unknown): void {
    if (!this.manifestParser) return
    try {
      this.manifest = this.manifestParser(frame, this.remotePeerId)
      void this.sendLogicalFrame(buildManifestAck(this.manifest)).catch(() => undefined)
      for (const pending of this.pendingManifests.values()) {
        this.clearTimer(pending.timer)
        pending.resolve(this.manifest)
      }
      this.pendingManifests.clear()
    } catch (error) {
      for (const pending of this.pendingManifests.values()) {
        this.clearTimer(pending.timer)
        pending.reject(error)
      }
      this.pendingManifests.clear()
    }
  }

  private async sendLogicalFrame(frame: Record<string, unknown>): Promise<void> {
    this.assertOpen()
    const json = JSON.stringify(frame)
    const bytes = utf8Bytes(json)
    const limits = this.remoteProtocol?.limits ?? new PeerProtocolLimits()
    if (bytes > limits.maxLogicalBytes) throw new Error('WebRTC mesh logical frame exceeds negotiated maximum')
    const fragmentThresholdBytes = Math.min(this.fragmentationThresholdBytes, limits.fragmentPayloadBytes)
    if (bytes > fragmentThresholdBytes) {
      if (!this.remoteProtocol?.capabilities.has(CAP_FRAGMENTATION_V1)) throw new Error('WebRTC mesh peer did not negotiate fragmentation_v1')
      for (const fragment of fragmentMessage(json, { messageId: this.randomId(), limits })) {
        await this.session.sendFrame(fragment)
      }
      return
    }
    if (bytes > MAX_INLINE_LOGICAL_BYTES && !this.remoteProtocol?.capabilities.has(CAP_FRAGMENTATION_V1)) throw new Error('WebRTC mesh frame too large without fragmentation_v1')
    await this.session.sendFrame(frame)
  }

  private armTimer(ms: number, callback: () => void): unknown {
    const handle = globalThis.setTimeout(callback, ms)
    this.timers.add(handle)
    return handle
  }

  private clearTimer(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    this.timers.delete(handle)
  }

  private clearAllTimers(): void {
    for (const timer of [...this.timers]) this.clearTimer(timer)
  }

  private assertOpen(): void {
    const snapshot = this.session.getSnapshot()
    if (this.closed || snapshot.state !== 'authorized' || !snapshot.authorized) throw new Error('WebRTC mesh peer bridge is not connected')
    this.assertAuthenticatedPeerSnapshot(snapshot)
  }

  private assertAuthenticatedPeerSnapshot(snapshot: PeerSessionSnapshot): void {
    if (snapshot.state !== 'authorized' || !snapshot.authorized) throw new Error('WebRTC mesh peer bridge requires an authorized session')
    const actualStable = (snapshot as PeerSessionSnapshot & { remoteStableId?: string }).remoteStableId
    const stable = actualStable ?? snapshot.expectedRemoteStableId
    if (stable !== this.remotePeerId) throw new Error('WebRTC mesh peer stable identity mismatch')
  }

  private assertPeer(peerId: string): void {
    if (peerId !== this.remotePeerId) throw new Error('WebRTC mesh peer id mismatch')
  }
}

export function createWebRtcMeshTransport(options: WebRtcMeshTransportOptions): MeshP2PTransport {
  const bridge = new WebRtcMeshPeerBridge({ session: options.session, remotePeerId: options.remotePeerId, ...(options.bridge ?? {}) })
  return new MeshP2PTransport({ ...options, bridge })
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

class TransportClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

function normalizeRemoteError(error: unknown): Error {
  if (isRecord(error)) return new Error(typeof error.message === 'string' ? error.message : 'Remote WebRTC mesh error')
  if (typeof error === 'string') return new Error(error)
  return new Error('Remote WebRTC mesh error')
}

function normalizeTopics(topics: unknown): string[] {
  if (!Array.isArray(topics) || topics.length === 0 || topics.length > 32) throw new Error('topics must be a bounded non-empty array')
  const result: string[] = []
  const seen = new Set<string>()
  for (const topic of topics) {
    if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256 || topic.includes('*') || topic.includes('+') || !TOPIC_RE.test(topic)) {
      throw new Error('wildcard or invalid topics are not supported')
    }
    if (!seen.has(topic)) {
      seen.add(topic)
      result.push(topic)
    }
  }
  return result
}

function normalizeCorrelationIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 32) throw new Error('correlation ids must be bounded array')
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 128)
}

function readCorrelationIds(request: MeshStreamRpcRequest): string[] {
  const payload = request.payload
  if (isRecord(payload)) {
    const value = payload.correlation_ids ?? payload.correlationIds ?? payload.correlation_id ?? payload.correlationId
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return normalizeCorrelationIds(value)
  }
  return []
}

function stripMeshSelectorKeys(value: unknown): unknown {
  if (!isRecord(value)) return value ?? {}
  const out: Record<string, unknown> = {}
  const blocked = new Set(['selector', 'mesh_selector', 'meshSelector', 'target_selector', 'targetSelector', 'dispatch_selector', 'dispatchSelector'])
  for (const [key, nested] of Object.entries(value)) {
    if (!blocked.has(key)) out[key] = nested
  }
  return out
}

function buildIdentity(request: MeshRpcRequest): Record<string, unknown> {
  const audit = isRecord(request.audit) ? request.audit : {}
  return {
    principal_id: readSafe(audit, 'principalId', 'principal_id'),
    effective_perms: readSafeArray(audit, 'effectivePerms', 'effective_perms'),
    source: readSafe(audit, 'source'),
    method_type: readSafe(audit, 'methodType', 'method_type'),
    caller_peer_id: readSafe(audit, 'callerPeerId', 'caller_peer_id') ?? request.audit?.peerId ?? null,
    auth_grant_revision: readSafeNumber(audit, 'authGrantRevision', 'auth_grant_revision'),
    manifest_revision: readSafe(audit, 'manifestRevision', 'manifest_revision')
  }
}

function buildManifestAck(manifest: MeshPeerManifest): Record<string, unknown> {
  return buildWebRtcManifestAck(manifest) as unknown as Record<string, unknown>
}


function parserLimitsFor(protocol: ProtocolHello | null): Partial<typeof DEFAULT_PARSER_LIMITS> {
  const max = protocol?.limits.maxLogicalBytes ?? DEFAULT_PARSER_LIMITS.maxStringLength
  return { maxStringLength: Math.max(DEFAULT_PARSER_LIMITS.maxStringLength, max), maxArrayLength: DEFAULT_PARSER_LIMITS.maxArrayLength, maxDepth: DEFAULT_PARSER_LIMITS.maxDepth, maxObjectKeys: DEFAULT_PARSER_LIMITS.maxObjectKeys }
}

function readEventKind(params: unknown): string | null {
  if (!isRecord(params)) return null
  const value = params.kind ?? params.event_kind ?? params.eventKind
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readSafe(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length <= 512) return value
  }
  return null
}

function readSafeNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  }
  return null
}

function readSafeArray(record: Record<string, unknown>, ...keys: string[]): string[] | null {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length <= 256).slice(0, 256)
  }
  return null
}

function isSubset(values: string[], allowed: string[]): boolean {
  const set = new Set(allowed)
  return values.every((value) => set.has(value))
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && isSubset(left, right) && isSubset(right, left)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

function abortError(): DOMException {
  return new DOMException('WebRTC mesh request aborted', 'AbortError')
}

function requireIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error(`${name} must be a bounded string`)
  return value
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
