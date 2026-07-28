import { AuroraValidationError } from '../validation/index.js'
import type { CallFrame, SubscribeFrame } from '../webrtc/protocol.js'
import { ProviderLeaseController } from './provider-lease.js'
import type {
  PeerHostCallContext,
  PeerHostErrorBody,
  PeerHostFrameSender,
  PeerHostIdentity,
  PeerHostMethodDescriptor,
  PeerHostOptions
} from './types.js'

type ActiveWork = { abort: AbortController; cleanup(): void }

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_ERROR_MESSAGE = 160

export class WebRtcPeerHost {
  readonly lease: ProviderLeaseController
  private readonly options: Required<Pick<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>> & Omit<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>
  private readonly active = new Map<string, ActiveWork>()
  private sender: PeerHostFrameSender | null = null
  private acceptingInbound = false
  private availabilityRevision = 0
  private connectionEpoch: string

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
    return this.buildManifest()
  }

  markManifestAcknowledged(): void {
    this.acceptingInbound = true
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
    return {
      type: 'manifest',
      peer_id: this.options.localPeerId,
      node_name: this.options.nodeName,
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
        projection_digest: '0'.repeat(64)
      }
    }
  }

  async handleCall(frame: CallFrame, remotePeerId: string): Promise<void> {
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
    const identity = parseIdentity(frame.identity, remotePeerId)
    const nowMs = Math.floor(this.options.clock())
    const deadlineAtMs = nowMs + (method.timeoutMs ?? this.options.defaultTimeoutMs)
    const decision = await this.options.authorizationStore.authorize({
      remotePeerId,
      methodId: method.methodId,
      requiredPermissions: method.requiredPermissions,
      identity,
      nowMs
    })
    if (!decision.allowed) {
      await sender.sendFrame(errorFrame(frame.id, 403, 'not authorized', decision.reasonCode ?? 'not_authorized'))
      return
    }
    if (method.methodType === 'stream') {
      await this.handleStreamCall(method, frame, remotePeerId, identity, nowMs, deadlineAtMs)
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort('deadline'), Math.max(1, deadlineAtMs - nowMs))
    this.active.set(frame.id, { abort, cleanup: () => clearTimeout(timer) })
    try {
      const context = this.callContext(frame, method, remotePeerId, identity, abort.signal, nowMs, deadlineAtMs)
      const result = await this.options.registry.dispatch(method, frame.params ?? {}, context)
      await sender.sendFrame({ type: 'result', id: frame.id, result })
    } catch (error) {
      await sender.sendFrame({ type: 'error', id: frame.id, correlation_id: frame.id, error: redactError(error) })
    } finally {
      const active = this.active.get(frame.id)
      active?.cleanup()
      this.active.delete(frame.id)
    }
  }

  async handleSubscribe(frame: SubscribeFrame, remotePeerId: string): Promise<void> {
    if (!this.acceptingInbound || !this.lease.isActive()) {
      await this.requireSender().sendFrame({
        type: 'subscribe_rejected',
        id: frame.id,
        reason: 'provider_not_ready',
        rejected_topics: frame.topics
      })
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort('ttl'), Math.max(1, frame.ttl_seconds ?? 60) * 1000)
    this.active.set(frame.id, { abort, cleanup: () => clearTimeout(timer) })
    await this.requireSender().sendFrame({
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
    active.cleanup()
    this.active.delete(id)
  }

  handleDisconnect(reason = 'disconnect'): void {
    this.acceptingInbound = false
    this.cancelAll(reason)
  }

  getActiveWorkCount(): number {
    return this.active.size
  }

  private async handleStreamCall(method: PeerHostMethodDescriptor, frame: CallFrame, remotePeerId: string, identity: PeerHostIdentity, nowMs: number, deadlineAtMs: number): Promise<void> {
    const sender = this.requireSender()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort('deadline'), Math.max(1, deadlineAtMs - nowMs))
    this.active.set(frame.id, { abort, cleanup: () => clearTimeout(timer) })
    try {
      const context = this.callContext(frame, method, remotePeerId, identity, abort.signal, nowMs, deadlineAtMs)
      const stream = await this.options.registry.openStream(method, frame.params ?? {}, context)
      for await (const chunk of stream) {
        if (abort.signal.aborted) break
        await sender.sendFrame({ type: 'chunk', id: frame.id, data: chunk })
      }
      await sender.sendFrame({ type: 'eof', id: frame.id, cancelled: abort.signal.aborted })
    } catch (error) {
      await sender.sendFrame({ type: 'error', id: frame.id, correlation_id: frame.id, error: redactError(error) })
    } finally {
      const active = this.active.get(frame.id)
      active?.cleanup()
      this.active.delete(frame.id)
    }
  }

  private callContext(frame: CallFrame, method: PeerHostMethodDescriptor, remotePeerId: string, identity: PeerHostIdentity, signal: AbortSignal, receivedAtMs: number, deadlineAtMs: number): PeerHostCallContext {
    return {
      id: frame.id,
      methodId: method.methodId,
      remotePeerId,
      identity,
      signal,
      receivedAtMs,
      deadlineAtMs
    }
  }

  private cancelAll(reason: string): void {
    for (const [id, active] of this.active) {
      active.abort.abort(reason)
      active.cleanup()
      this.active.delete(id)
    }
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

function redactError(error: unknown): PeerHostErrorBody {
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
  const message = error instanceof Error ? error.message : 'handler failed'
  return { code: 500, message: message.slice(0, MAX_ERROR_MESSAGE), reason_code: 'handler_failed' }
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
