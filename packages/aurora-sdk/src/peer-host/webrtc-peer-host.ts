import { sha256 } from '@noble/hashes/sha2.js'

import { AuroraValidationError } from '../validation/index.js'
import { bytesToHex, canonicalJson } from '../webrtc/encoding.js'
import type { CallFrame, SubscribeFrame } from '../webrtc/protocol.js'
import { ProviderLeaseController } from './provider-lease.js'
import type { AuthenticatedPeerContext } from './authority.js'
import type {
  PeerHostCallContext,
  PeerHostEventDescriptor,
  PeerHostErrorBody,
  PeerHostFrameSender,
  PeerHostIdentity,
  PeerHostMethodDescriptor,
  PeerHostOptions
} from './types.js'

type ActiveWork = { abort: AbortController; cleanup(): void; settled: boolean; kind: 'call' | 'stream' | 'subscription' }
type ManifestEvidence = { epoch: string; revision: string; digest: string; requiredServices: string[] } | null

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const TIMEOUT_ERROR_REF = 'peer-host-timeout'

export class WebRtcPeerHost {
  readonly lease: ProviderLeaseController
  private readonly options: Required<Pick<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>> & Omit<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>
  private readonly active = new Map<string, ActiveWork>()
  private sender: PeerHostFrameSender | null = null
  private acceptingInbound = false
  private availabilityRevision = 0
  private connectionEpoch: string
  private manifestRevision = '0'
  private manifestDigest = '0'.repeat(64)
  private pendingManifest: ManifestEvidence = null
  private timeoutSendFailureCount = 0
  private lastTimeoutFailureReason: 'timeout_send_failed' | null = null

  constructor(options: PeerHostOptions) {
    const randomId = options.randomId ?? (() => `host-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
    const clock = options.clock ?? (() => Date.now())
    this.options = {
      ...options,
      clock,
      randomId,
      maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    }
    this.connectionEpoch = randomId()
    this.lease = new ProviderLeaseController({ peerId: options.localPeerId, clock, randomId })
  }

  attach(sender: PeerHostFrameSender): void {
    this.sender = sender
  }

  startEpoch(): Record<string, unknown> {
    this.acceptingInbound = false
    const lease = this.lease.startEpoch()
    this.connectionEpoch = lease.connection_epoch
    this.availabilityRevision = lease.availability_revision
    this.manifestRevision = String(this.availabilityRevision)
    this.pendingManifest = null
    return this.buildManifest()
  }

  markManifestAcknowledged(ack: Record<string, unknown>): boolean {
    if (!this.pendingManifest) return false
    if (ack.connection_epoch !== this.pendingManifest.epoch) return false
    if (ack.manifest_revision !== this.pendingManifest.revision) return false
    if (ack.manifest_digest !== this.pendingManifest.digest) return false
    const compatible = Array.isArray(ack.compatible_services) ? ack.compatible_services.filter((item): item is string => typeof item === 'string') : []
    if (!this.pendingManifest.requiredServices.every((service) => compatible.includes(service))) return false
    this.acceptingInbound = true
    this.pendingManifest = null
    return true
  }

  suspend(reason = 'provider_unavailable'): Record<string, unknown> {
    this.acceptingInbound = false
    this.cancelAll(reason)
    const frame = this.lease.tombstone(reason) as unknown as Record<string, unknown>
    void this.sender?.sendFrame(frame).catch(() => undefined)
    return frame
  }

  resume(): Record<string, unknown> {
    const frame = this.startEpoch()
    void this.sender?.sendFrame(frame).catch(() => undefined)
    return frame
  }

  renewLease(): Record<string, unknown> {
    const lease = this.lease.renew()
    this.availabilityRevision = lease.availability_revision
    const frame = lease as unknown as Record<string, unknown>
    void this.sender?.sendFrame(frame).catch(() => undefined)
    return frame
  }

  buildManifest(): Record<string, unknown> {
    const methods = this.options.registry.list().map((method) => ({
      bus_topic: method.methodId,
      method_type: method.methodType,
      required_permissions: [...method.requiredPermissions],
      input_schema_id: method.inputSchemaId,
      output_schema_id: method.outputSchemaId
    }))
    const requiredServices = methods.length > 0 ? ['Tooling'] : []
    const digestInput = {
      peer_id: this.options.localPeerId,
      connection_epoch: this.connectionEpoch,
      manifest_revision: this.manifestRevision,
      shared_services: [{
        module: 'Tooling',
        methods,
        capabilities: ['provider_lease_v1']
      }]
    }
    this.manifestDigest = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(digestInput))))
    this.pendingManifest = {
      epoch: this.connectionEpoch,
      revision: this.manifestRevision,
      digest: this.manifestDigest,
      requiredServices
    }
    return {
      type: 'manifest',
      peer_id: this.options.localPeerId,
      node_name: this.options.nodeName,
      manifest_revision: this.manifestRevision,
      manifest_digest: this.manifestDigest,
      required_services: requiredServices,
      shared_services: [{
        module: 'Tooling',
        provider_id: `local:${encodeURIComponent(this.options.localPeerId)}:Tooling`,
        service_instance_id: `local:${encodeURIComponent(this.options.localPeerId)}:Tooling`,
        methods,
        capabilities: ['provider_lease_v1'],
        connection_epoch: this.connectionEpoch,
        availability_revision: this.availabilityRevision
      }],
      connection_epoch: this.connectionEpoch,
      availability_revision: this.availabilityRevision,
      active_protocol: 'projection-v1',
      active_version: 'v1',
      active_tier: 'projection',
      projection_active: true,
      recipient_projection_evidence: {
        provider_peer_id: this.options.localPeerId,
        protocol_tier: 'projection-v1',
        registry_revision: String(this.availabilityRevision),
        policy_revision: '0',
        auth_grant_revision: 0,
        projection_digest: this.manifestDigest
      }
    }
  }

  async handleCall(frame: CallFrame, remotePeerId: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    const sender = this.requireSender()
    const method = this.options.registry.get(frame.method)
    if (!method) {
      await sender.sendFrame(errorFrame(frame.id, 404, 'method not found', 'method_not_found'))
      return
    }
    if (!this.acceptingInbound || !this.lease.isActive()) {
      await sender.sendFrame(errorFrame(frame.id, 425, 'provider is not ready', 'provider_not_ready'))
      return
    }
    const requestBytes = utf8Bytes(JSON.stringify(frame.params ?? {}))
    const maxBytes = method.maxRequestBytes ?? this.options.maxRequestBytes
    if (requestBytes > maxBytes) {
      await sender.sendFrame(errorFrame(frame.id, 413, 'request too large', 'request_too_large'))
      return
    }
    const identity = identityFromAuthority(authenticatedPeerContext, frame.identity, remotePeerId)
    const nowMs = Math.floor(this.options.clock())
    const deadlineAtMs = nowMs + (method.timeoutMs ?? this.options.defaultTimeoutMs)
    const authorizeRequest = {
      remotePeerId,
      methodId: method.methodId,
      requiredPermissions: method.requiredPermissions,
      identity,
      nowMs
    }
    if (authenticatedPeerContext !== undefined) Object.assign(authorizeRequest, { authenticatedPeerContext })
    const decision = await this.options.authorizationStore.authorize(authorizeRequest)
    if (!decision.allowed) {
      await sender.sendFrame(errorFrame(frame.id, 403, 'not authorized', decision.reasonCode ?? 'not_authorized'))
      return
    }
    if (method.methodType === 'stream') {
      await this.handleStreamCall(method, frame, remotePeerId, identity, nowMs, deadlineAtMs, authenticatedPeerContext)
      return
    }
    const abort = new AbortController()
    const active: ActiveWork = {
      abort,
      kind: 'call',
      settled: false,
      cleanup: () => clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      void this.timeoutWork(frame.id, active)
    }, Math.max(1, deadlineAtMs - nowMs))
    this.active.set(frame.id, active)
    try {
      const context = this.callContext(frame, method, remotePeerId, identity, abort.signal, nowMs, deadlineAtMs, authenticatedPeerContext)
      const result = await this.options.registry.dispatch(method, frame.params ?? {}, context)
      if (this.finishActive(frame.id, active)) await sender.sendFrame({ type: 'result', id: frame.id, result })
    } catch (error) {
      if (this.finishActive(frame.id, active)) await sender.sendFrame({ type: 'error', id: frame.id, correlation_id: frame.id, error: redactError(error, this.options.randomId) })
    } finally {
      this.finishActive(frame.id, active)
    }
  }

  async handleSubscribe(frame: SubscribeFrame, remotePeerId: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    const sender = this.requireSender()
    if (!this.acceptingInbound || !this.lease.isActive()) {
      await sender.sendFrame({
        type: 'subscribe_rejected',
        id: frame.id,
        reason: 'provider_not_ready',
        rejected_topics: frame.topics
      })
      return
    }
    const events = frame.topics.map((topic) => this.options.registry.getEvent(topic))
    if (events.some((event) => event === undefined)) {
      await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: 'topic_not_registered', rejected_topics: frame.topics })
      return
    }
    const nowMs = Math.floor(this.options.clock())
    const identity = identityFromAuthority(authenticatedPeerContext, undefined, remotePeerId)
    for (const event of events as PeerHostEventDescriptor[]) {
      const authorizeRequest = {
        remotePeerId,
        methodId: event.topic,
        requiredPermissions: event.requiredPermissions,
        identity,
        nowMs
      }
      if (authenticatedPeerContext !== undefined) Object.assign(authorizeRequest, { authenticatedPeerContext })
      const decision = await this.options.authorizationStore.authorize(authorizeRequest)
      if (!decision.allowed) {
        await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: decision.reasonCode ?? 'not_authorized', rejected_topics: frame.topics })
        return
      }
    }
    const abort = new AbortController()
    const timer = setTimeout(() => this.handleCancel(frame.id), Math.max(1, frame.ttl_seconds ?? 60) * 1000)
    const handles: Array<{ close(reason?: string): void | Promise<void> }> = []
    const active: ActiveWork = {
      abort,
      kind: 'subscription',
      settled: false,
      cleanup: () => {
        clearTimeout(timer)
        for (const handle of handles) void handle.close('subscription_closed')
      }
    }
    try {
      for (const event of events as PeerHostEventDescriptor[]) {
        const ttlSeconds = frame.ttl_seconds ?? 60
        if (event.maxTtlSeconds !== undefined && ttlSeconds > event.maxTtlSeconds) {
          await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: 'ttl_too_large', rejected_topics: frame.topics })
          return
        }
        const subscribeContext = {
          id: frame.id,
          remotePeerId,
          topics: frame.topics,
          correlationIds: frame.correlation_ids ?? [],
          ttlSeconds,
          signal: abort.signal,
          receivedAtMs: nowMs
        }
        if (authenticatedPeerContext !== undefined) Object.assign(subscribeContext, { authenticatedPeerContext })
        const handle = await this.options.registry.openSubscription(event, subscribeContext)
        if (handle) handles.push(handle)
      }
    } catch {
      for (const handle of handles) void handle.close('subscription_rejected')
      await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: 'handler_failed', rejected_topics: frame.topics })
      return
    }
    this.active.set(frame.id, active)
    await sender.sendFrame({
      type: 'subscribed',
      id: frame.id,
      subscription_id: frame.id,
      accepted: true,
      accepted_topics: frame.topics,
      rejected_topics: [],
      correlation_ids: frame.correlation_ids ?? [],
      ttl_seconds: frame.ttl_seconds ?? 60,
      reason: null,
      idempotent: false
    })
  }

  handleCancel(id: string): void {
    const active = this.active.get(id)
    if (!active) return
    active.abort.abort('remote_cancelled')
    this.finishActive(id, active)
  }

  handleDisconnect(reason = 'disconnect'): void {
    this.acceptingInbound = false
    this.cancelAll(reason)
  }

  getActiveWorkCount(): number {
    return this.active.size
  }

  getDiagnostics(): { activeWorkCount: number; timeoutSendFailureCount: number; lastTimeoutFailureReason: 'timeout_send_failed' | null } {
    return {
      activeWorkCount: this.active.size,
      timeoutSendFailureCount: this.timeoutSendFailureCount,
      lastTimeoutFailureReason: this.lastTimeoutFailureReason
    }
  }

  private async handleStreamCall(method: PeerHostMethodDescriptor, frame: CallFrame, remotePeerId: string, identity: PeerHostIdentity, nowMs: number, deadlineAtMs: number, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    const sender = this.requireSender()
    const abort = new AbortController()
    const active: ActiveWork = {
      abort,
      kind: 'stream',
      settled: false,
      cleanup: () => clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      void this.timeoutWork(frame.id, active)
    }, Math.max(1, deadlineAtMs - nowMs))
    this.active.set(frame.id, active)
    try {
      const context = this.callContext(frame, method, remotePeerId, identity, abort.signal, nowMs, deadlineAtMs, authenticatedPeerContext)
      const stream = await this.options.registry.openStream(method, frame.params ?? {}, context)
      for await (const chunk of stream) {
        if (abort.signal.aborted || active.settled) break
        const parsed = this.options.registry.parseOutput(method, chunk)
        if (this.active.get(frame.id) !== active || active.settled) break
        await sender.sendFrame({ type: 'chunk', id: frame.id, data: parsed })
      }
      if (this.finishActive(frame.id, active)) await sender.sendFrame({ type: 'eof', id: frame.id, cancelled: abort.signal.aborted })
    } catch (error) {
      if (this.finishActive(frame.id, active)) await sender.sendFrame({ type: 'error', id: frame.id, correlation_id: frame.id, error: redactError(error, this.options.randomId) })
    } finally {
      this.finishActive(frame.id, active)
    }
  }

  private callContext(frame: CallFrame, method: PeerHostMethodDescriptor, remotePeerId: string, identity: PeerHostIdentity, signal: AbortSignal, receivedAtMs: number, deadlineAtMs: number, authenticatedPeerContext?: AuthenticatedPeerContext): PeerHostCallContext {
    const context = {
      id: frame.id,
      methodId: method.methodId,
      remotePeerId,
      identity,
      signal,
      receivedAtMs,
      deadlineAtMs
    }
    if (authenticatedPeerContext !== undefined) Object.assign(context, { authenticatedPeerContext })
    return context
  }

  private cancelAll(reason: string): void {
    for (const [id, active] of this.active) {
      active.abort.abort(reason)
      this.finishActive(id, active)
    }
  }

  private async timeoutWork(id: string, active: ActiveWork): Promise<void> {
    if (!this.finishActive(id, active)) return
    active.abort.abort('deadline')
    try {
      await this.requireSender().sendFrame({
        type: 'error',
        id,
        correlation_id: id,
        error: { code: 504, message: 'request timed out', reason_code: 'request_timeout', error_ref: TIMEOUT_ERROR_REF }
      })
    } catch {
      this.timeoutSendFailureCount += 1
      this.lastTimeoutFailureReason = 'timeout_send_failed'
    }
  }

  private finishActive(id: string, active: ActiveWork): boolean {
    if (active.settled || this.active.get(id) !== active) return false
    active.settled = true
    active.cleanup()
    this.active.delete(id)
    return true
  }

  private requireSender(): PeerHostFrameSender {
    if (!this.sender) throw new Error('peer host is not attached')
    return this.sender
  }
}

function parseIdentity(value: unknown, fallbackPeerId: string): PeerHostIdentity {
  if (!isRecord(value)) return { callerPeerId: fallbackPeerId, effectivePermissions: [] }
  return {
    callerPeerId: typeof value.caller_peer_id === 'string' && value.caller_peer_id.length > 0 ? value.caller_peer_id : fallbackPeerId,
    principalId: typeof value.principal_id === 'string' ? value.principal_id : null,
    effectivePermissions: Array.isArray(value.effective_perms) ? value.effective_perms.filter((item): item is string => typeof item === 'string' && item.length <= 256) : [],
    authGrantRevision: typeof value.auth_grant_revision === 'number' ? value.auth_grant_revision : null,
    manifestRevision: typeof value.manifest_revision === 'string' || typeof value.manifest_revision === 'number' ? value.manifest_revision : null
  }
}

function identityFromAuthority(context: AuthenticatedPeerContext | undefined, frameIdentity: unknown, fallbackPeerId: string): PeerHostIdentity {
  if (context === undefined) return parseIdentity(frameIdentity, fallbackPeerId)
  return {
    callerPeerId: context.selector.claimantPeerId,
    principalId: null,
    effectivePermissions: [],
    authGrantRevision: context.credentialRevision,
    manifestRevision: null
  }
}

function redactError(error: unknown, randomId: () => string): PeerHostErrorBody {
  if (error instanceof AuroraValidationError) {
    return {
      code: 400,
      message: 'invalid request',
      reason_code: 'schema_validation_failed',
      schema_id: error.schemaId,
      boundary: error.boundary,
      issues: error.issues.slice(0, 8)
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 499, message: 'request cancelled', reason_code: 'request_cancelled' }
  }
  return {
    code: 500,
    message: 'handler failed',
    reason_code: 'handler_failed',
    error_ref: String(randomId()).slice(0, 64)
  }
}

function errorFrame(id: string, code: number, message: string, reasonCode: string): Record<string, unknown> {
  return { type: 'error', id, correlation_id: id, error: { code, message, reason_code: reasonCode } }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
