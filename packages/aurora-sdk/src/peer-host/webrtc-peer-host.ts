import { sha256 } from '@noble/hashes/sha2.js'

import { AuroraValidationError } from '../validation/index.js'
import { bytesToHex, canonicalJson } from '../webrtc/encoding.js'
import type { CallFrame, SubscribeFrame } from '../webrtc/protocol.js'
import { ProviderLeaseController } from './provider-lease.js'
import type { AuthenticatedPeerContext } from './authority.js'
import type {
  PeerHostCallContext,
  PeerHostAuthorizationDecision,
  PeerHostEventDescriptor,
  PeerHostErrorBody,
  PeerHostFrameSender,
  PeerHostIdentity,
  PeerHostManifestAuthoritySnapshot,
  PeerHostMethodDescriptor,
  PeerHostOptions,
  PeerHostProjectionMethodType
} from './types.js'

type ActiveWork = { abort: AbortController; cleanup(): void; settled: boolean; kind: 'call' | 'stream' | 'subscription' }
type ManifestEvidence = {
  projectionDigest: string
  registryRevision: string
  policyRevision: string
  authGrantRevision: number
  requiredServices: string[]
} | null

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const TIMEOUT_ERROR_REF = 'peer-host-timeout'
const ACTIVE_MANIFEST_PROTOCOL = 'projection-v1'
const LEGACY_MANIFEST_PROTOCOL = 'legacy-unfiltered-v0'
const ACTIVE_VERSION = 'v1'
const ACTIVE_TIER = 'projection'

export class WebRtcPeerHost {
  readonly lease: ProviderLeaseController
  private readonly options: Required<Pick<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>> & Omit<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>
  private readonly active = new Map<string, ActiveWork>()
  private sender: PeerHostFrameSender | null = null
  private acceptingInbound = false
  private availabilityRevision = 0
  private connectionEpoch: string
  private pendingManifest: ManifestEvidence = null
  private lastRecipientPeerId: string | undefined
  private lastAuthenticatedPeerContext: AuthenticatedPeerContext | undefined
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

  async startEpoch(remotePeerId?: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<Record<string, unknown>> {
    this.acceptingInbound = false
    this.connectionEpoch = this.lease.startEpoch()
    this.availabilityRevision = 0
    this.pendingManifest = null
    if (remotePeerId !== undefined) this.lastRecipientPeerId = remotePeerId
    if (authenticatedPeerContext !== undefined) this.lastAuthenticatedPeerContext = authenticatedPeerContext
    return await this.buildManifest(remotePeerId, authenticatedPeerContext)
  }

  markManifestAcknowledged(ack: Record<string, unknown>): boolean {
    if (!this.pendingManifest) return false
    if (ack.active_protocol !== ACTIVE_MANIFEST_PROTOCOL) return false
    if (ack.active_version !== ACTIVE_VERSION) return false
    if (ack.active_tier !== ACTIVE_TIER) return false
    if (ack.projection_digest !== this.pendingManifest.projectionDigest) return false
    if (ack.registry_revision !== this.pendingManifest.registryRevision) return false
    if (ack.export_policy_revision !== this.pendingManifest.policyRevision) return false
    if (ack.auth_grant_revision !== this.pendingManifest.authGrantRevision) return false
    const compatible = this.validateStructuredManifestAckServices(ack)
    if (compatible === null) return false
    if (!this.pendingManifest.requiredServices.every((service) => compatible.includes(service))) return false
    if (this.pendingManifest.requiredServices.length === 0) return false
    this.acceptingInbound = true
    this.pendingManifest = null
    void this.sender?.sendFrame(this.renewLease()).catch(() => undefined)
    return true
  }

  suspend(reason = 'provider_unavailable'): Record<string, unknown> {
    this.acceptingInbound = false
    this.cancelAll(reason)
    const frame = this.lease.tombstone(reason) as unknown as Record<string, unknown>
    return frame
  }

  async resume(): Promise<Record<string, unknown>> {
    return await this.startEpoch(this.lastRecipientPeerId, this.lastAuthenticatedPeerContext)
  }

  async resumeLocalProvider(): Promise<void> {
    const sender = this.requireSender()
    await sender.sendFrame(await this.resume())
  }

  async renewLocalProvider(): Promise<void> {
    const sender = this.requireSender()
    if (!this.acceptingInbound) return
    await sender.sendFrame(this.renewLease())
  }

  async suspendLocalProvider(reason = 'provider_unavailable'): Promise<void> {
    const sender = this.requireSender()
    await sender.sendFrame(this.suspend(reason))
  }

  renewLease(): Record<string, unknown> {
    const lease = this.lease.renew()
    this.availabilityRevision = lease.availability_revision
    return lease as unknown as Record<string, unknown>
  }

  currentLease(): Record<string, unknown> | null {
    return this.lease.snapshot() as unknown as Record<string, unknown> | null
  }

  private validateStructuredManifestAckServices(ack: Record<string, unknown>): string[] | null {
    const compatible = this.readAckServicePartition(ack.compatible_services)
    const incompatible = this.readAckServicePartition(ack.incompatible_services)
    const unused = this.readAckServicePartition(ack.unused_services)
    const services = Array.isArray(ack.services) ? ack.services : null
    if (!compatible || !incompatible || !unused || !services || services.length === 0) return null
    if (!this.isSortedUnique(compatible) || !this.isSortedUnique(incompatible) || !this.isSortedUnique(unused)) return null
    const partitions = new Map<string, 'compatible' | 'incompatible' | 'unused'>()
    for (const service of compatible) partitions.set(service, 'compatible')
    for (const service of incompatible) {
      if (partitions.has(service)) return null
      partitions.set(service, 'incompatible')
    }
    for (const service of unused) {
      if (partitions.has(service)) return null
      partitions.set(service, 'unused')
    }
    const actual = { compatible: [] as string[], incompatible: [] as string[], unused: [] as string[] }
    const seenRows = new Set<string>()
    for (const item of services) {
      if (!isRecord(item)) return null
      const serviceId = typeof item.service_id === 'string' ? item.service_id : null
      const status = typeof item.status === 'string' ? item.status : null
      if (!serviceId || seenRows.has(serviceId)) return null
      if (status !== 'compatible' && status !== 'incompatible' && status !== 'unused') return null
      seenRows.add(serviceId)
      actual[status].push(serviceId)
      if (item.service_label !== '' || item.reason !== '' || !Array.isArray(item.reason_codes)) return null
      const reasonCodes = item.reason_codes.filter((reason): reason is string => typeof reason === 'string')
      if (reasonCodes.length !== item.reason_codes.length || !this.isSortedUnique(reasonCodes)) return null
      if (status === 'compatible' && reasonCodes.length > 0) return null
    }
    if (!sameOrderedStrings(actual.compatible, compatible)) return null
    if (!sameOrderedStrings(actual.incompatible, incompatible)) return null
    if (!sameOrderedStrings(actual.unused, unused)) return null
    return compatible
  }

  private readAckServicePartition(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    const out = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return out.length === value.length ? out : null
  }

  private isSortedUnique(values: readonly string[]): boolean {
    return values.every((value, index) => {
      const previous = values[index - 1]
      return index === 0 || (previous !== undefined && previous < value)
    })
  }

  async buildManifest(remotePeerId?: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<Record<string, unknown>> {
    if (remotePeerId !== undefined) this.lastRecipientPeerId = remotePeerId
    if (authenticatedPeerContext !== undefined) this.lastAuthenticatedPeerContext = authenticatedPeerContext
    const nowMs = Math.floor(this.options.clock())
    const authority = await this.manifestAuthoritySnapshot(remotePeerId, authenticatedPeerContext, nowMs)
    const grantedMethodIds = new Set(authority.grantedMethodIds)
    const registryMethods = this.options.registry.list()
    const registryDigest = digest({ services: [manifestService(registryMethods.map((method) => manifestMethod(method)).sort((left, right) => String(left.bus_topic).localeCompare(String(right.bus_topic))))] })
    const registryRevision = registryDigest
    const policyDigest = digest({ recipient_peer_id: authority.recipientPeerId ?? '', granted_method_ids: sortedUnique(authority.grantedMethodIds) })
    const policyRevision = policyDigest
    const methods = registryMethods
      .filter((method) => grantedMethodIds.has(method.methodId))
      .map((method) => manifestMethod(method))
      .sort((left, right) => String(left.bus_topic).localeCompare(String(right.bus_topic)))
    const effectivePermissions = effectivePermissionsForMethods(registryMethods.filter((method) => grantedMethodIds.has(method.methodId)))
    const service = methods.length > 0 ? manifestService(methods) : null
    const sharedServices = service ? [service] : []
    const projectionDigest = digest({
      provider_peer_id: this.options.localPeerId,
      services: sharedServices.map((item) => withoutDigest(item))
    })
    const grants = effectivePermissions.map((permission) => ({ permission, source: 'effective' }))
    const grantsDigest = digest({ grants })
    const authGrantState = authority.authGrantState
    const authGrantDigest = digest({
      grants,
      peer_id: authority.recipientPeerId ?? '',
      readiness: authGrantState === 'active' ? 'ready' : authGrantState,
      revision: authority.authGrantRevision,
      state: authGrantState
    })
    const evidence: Record<string, unknown> = {
      provider_peer_id: this.options.localPeerId,
      recipient_peer_id: authority.recipientPeerId ?? '',
      registry_revision: registryRevision,
      registry_digest: registryDigest,
      policy_revision: policyRevision,
      policy_digest: policyDigest,
      auth_grant_revision: authority.authGrantRevision,
      auth_grant_state: authGrantState,
      auth_grant_digest: authGrantDigest,
      grants_digest: grantsDigest,
      protocol_tier: ACTIVE_MANIFEST_PROTOCOL,
      projection_digest: projectionDigest,
      grants
    }
    evidence.evidence_digest = digest(evidence)
    const requiredServices = sharedServices.length > 0 ? ['Tooling'] : []
    this.pendingManifest = {
      projectionDigest,
      registryRevision,
      policyRevision,
      authGrantRevision: authority.authGrantRevision,
      requiredServices
    }
    return {
      type: 'manifest',
      peer_id: this.options.localPeerId,
      node_name: this.options.nodeName,
      aurora_version: '',
      shared_services: sharedServices,
      granted_permissions: null,
      active_protocol: ACTIVE_MANIFEST_PROTOCOL,
      active_version: ACTIVE_VERSION,
      active_tier: ACTIVE_TIER,
      supported_protocols: [LEGACY_MANIFEST_PROTOCOL, ACTIVE_MANIFEST_PROTOCOL],
      projection_supported: true,
      projection_active: true,
      recipient_projection_evidence: evidence,
      timestamp: new Date(nowMs).toISOString()
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
    const authorizedIdentity = identityFromAuthority(authenticatedPeerContext, frame.identity, remotePeerId, decision, this.effectivePermissionsForGrant(decision))
    if (method.methodType === 'stream') {
      await this.handleStreamCall(method, frame, remotePeerId, authorizedIdentity, nowMs, deadlineAtMs, authenticatedPeerContext)
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
      const context = this.callContext(frame, method, remotePeerId, authorizedIdentity, abort.signal, nowMs, deadlineAtMs, authenticatedPeerContext)
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

  private async manifestAuthoritySnapshot(remotePeerId: string | undefined, authenticatedPeerContext: AuthenticatedPeerContext | undefined, nowMs: number): Promise<PeerHostManifestAuthoritySnapshot> {
    const context = authenticatedPeerContext ?? this.lastAuthenticatedPeerContext
    const peerId = remotePeerId ?? context?.selector.claimantPeerId ?? this.lastRecipientPeerId
    return await (this.options.authorizationStore.snapshotManifestAuthority?.({
      ...(peerId !== undefined ? { remotePeerId: peerId } : {}),
      ...(context !== undefined ? { authenticatedPeerContext: context } : {}),
      nowMs
    }) ?? {
      ...(peerId !== undefined ? { recipientPeerId: peerId } : {}),
      grantedMethodIds: [],
      authGrantRevision: 0,
      authGrantState: 'unknown'
    })
  }

  private effectivePermissionsForGrant(decision: PeerHostAuthorizationDecision): string[] {
    const grantedMethodIds = new Set(decision.grantedMethodIds ?? [])
    return sortedUnique([
      ...effectivePermissionsForMethods(this.options.registry.list().filter((method) => grantedMethodIds.has(method.methodId))),
      ...(decision.grantedPermissions ?? [])
    ])
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

function identityFromAuthority(context: AuthenticatedPeerContext | undefined, frameIdentity: unknown, fallbackPeerId: string, decision?: PeerHostAuthorizationDecision, effectivePermissions: readonly string[] = []): PeerHostIdentity {
  const parsed = parseIdentity(frameIdentity, fallbackPeerId)
  if (context === undefined) {
    if (decision !== undefined) {
      return {
        callerPeerId: fallbackPeerId,
        principalId: null,
        effectivePermissions: sortedUnique(effectivePermissions),
        authGrantRevision: decision.grantRevision ?? null,
        manifestRevision: null
      }
    }
    return {
      ...parsed,
      effectivePermissions: parsed.effectivePermissions,
      authGrantRevision: parsed.authGrantRevision ?? null
    }
  }
  return {
    callerPeerId: context.selector.claimantPeerId,
    principalId: null,
    effectivePermissions: sortedUnique(effectivePermissions),
    authGrantRevision: decision?.grantRevision ?? null,
    manifestRevision: null
  }
}

function manifestService(methods: Array<Record<string, unknown>>): Record<string, unknown> {
  const service = {
    module: 'Tooling',
    version: '0.0.0',
    capabilities: [],
    callable_features: [],
    available_feature_ids: [],
    methods,
    max_concurrent: 10
  }
  return { ...service, digest: digest(service) }
}

function manifestMethod(method: PeerHostMethodDescriptor): Record<string, unknown> {
  const name = method.methodId.includes('.') ? method.methodId.split('.').at(-1) ?? method.methodId : method.methodId
  return {
    name,
    summary: '',
    bus_topic: method.methodId,
    exposure: 'both',
    input_model: schemaName(method.inputSchemaId),
    output_model: schemaName(method.outputSchemaId),
    required_perms: sortedUnique(method.requiredPermissions),
    callable_feature_ids: [],
    callable_features: [],
    public_infrastructure: false,
    method_type: projectionMethodType(method),
    input_schema: null,
    output_schema: null
  }
}

function projectionMethodType(method: PeerHostMethodDescriptor): PeerHostProjectionMethodType {
  return method.projectionMethodType ?? 'use'
}

function schemaName(schemaId: string): string {
  const parts = schemaId.split('.').filter(Boolean)
  return parts.at(-1) ?? schemaId
}

function effectivePermissionsForMethods(methods: readonly PeerHostMethodDescriptor[]): string[] {
  return sortedUnique(methods.flatMap((method) => method.requiredPermissions))
}

function withoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...rest } = value
  return rest
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))))
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
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
