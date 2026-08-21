import { sha256 } from '@noble/hashes/sha2.js'

import type { CallableFeatureContract } from '../types.js'
import { AuroraValidationError } from '../validation/index.js'
import { bytesToHex, canonicalJson } from '../webrtc/encoding.js'
import type { CallFrame, SubscribeFrame } from '../webrtc/protocol.js'
import { ProviderLeaseController } from './provider-lease.js'
import type { AuthenticatedPeerContext, PeerRevocationEvent, PeerRelationshipSelector } from './authority-types.js'
import type {
  PeerHostCallContext,
  PeerHostAuthorizationDecision,
  PeerHostEventEmitOptions,
  PeerHostEventDescriptor,
  PeerHostEventEmissionValidator,
  PeerHostErrorBody,
  PeerHostFrameSender,
  PeerHostIdentity,
  PeerHostManifestAuthoritySnapshot,
  PeerHostMethodDescriptor,
  PeerHostOptions,
  PeerHostProjectionMethodType
} from './types.js'

type ActiveWork = { abort: AbortController; cleanup(reason: string): void; settled: boolean; kind: 'call' | 'stream' | 'subscription' }
type SubscriptionEmissionState = {
  acknowledged: boolean
  failed: boolean
  pending: Record<string, unknown>[]
  queuedSends: number
  sendChain: Promise<void>
  validators: Map<string, PeerHostEventEmissionValidator>
}
type ManifestEvidence = {
  projectionDigest: string
  registryRevision: string
  policyRevision: string
  authGrantRevision: number
  requiredServices: string[]
} | null

/**
 * Everything this host knows about one peer it talks to.
 *
 * Transport and identity, never authority. The context is a reference to what
 * a reconnect proof established so a manifest can be built for the right peer;
 * grants and permission evaluation stay behind `PeerHostAuthorizationStore`.
 */
type PeerHostRecipient = {
  sender?: PeerHostFrameSender
  authenticatedPeerContext?: AuthenticatedPeerContext
}

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const TIMEOUT_ERROR_REF = 'peer-host-timeout'
const ACTIVE_MANIFEST_PROTOCOL = 'projection-v1'
const LEGACY_MANIFEST_PROTOCOL = 'legacy-unfiltered-v0'
const ACTIVE_VERSION = 'v1'
const ACTIVE_TIER = 'projection'
const TOOLING_PROVIDER_CAPABILITIES = Object.freeze(['tool_discovery', 'tool_execution'] as const)
const MAX_STALE_MANIFEST_ACK_RETRIES = 3
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024
const MAX_SUBSCRIPTION_EVENT_QUEUE = 32
const MAX_EVENT_CORRELATION_ID_LENGTH = 128

export class WebRtcPeerHost {
  readonly lease: ProviderLeaseController
  private readonly options: Required<Pick<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>> & Omit<PeerHostOptions, 'clock' | 'randomId' | 'maxRequestBytes' | 'defaultTimeoutMs'>
  private readonly active = new Map<string, ActiveWork>()
  private sender: PeerHostFrameSender | null = null
  private acceptingInbound = false
  // Modules the recipient's ACK reported compatible. Admission is per service:
  // a consumer that does not route one of our modules must not close the rest.
  private admittedServices: ReadonlySet<string> = new Set<string>()
  private availabilityRevision = 0
  private connectionEpoch: string
  private pendingManifest: ManifestEvidence = null
  private pendingManifestFrame: Record<string, unknown> | null = null
  private staleManifestAckRetryCount = 0
  /**
   * One record per peer this host talks to, keyed by stable peer id.
   *
   * This replaces the `lastRecipientPeerId` / `lastAuthenticatedPeerContext`
   * pair, which was a single mutable "who did I last talk to" and is the wrong
   * shape now that one host serves several peers (see
   * `docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md` section 8). The two halves of
   * that defect travelled together: every per-peer bridge called `attach()` on
   * the same host, so the *sender* was clobbered by whichever peer connected
   * last and peer A's manifest could leave down peer B's data channel. A
   * recipient owns both its sender and its authenticated context, so neither
   * can be borrowed from another peer.
   *
   * The context is a reference to what a reconnect proof established. It is
   * never a grant: every authorization question still goes to the authority.
   */
  private readonly recipients = new Map<string, PeerHostRecipient>()
  private activeAuthoritySelector: PeerRelationshipSelector | null = null
  private authorityRevoked = false
  private unsubscribeRevocation: (() => void) | null = null
  private timeoutSendFailureCount = 0
  private lastTimeoutFailureReason: 'timeout_send_failed' | null = null
  private readonly reservedWorkIds = new Set<string>()
  private readonly inFlightCallIds = new Set<string>()

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

  get localPeerId(): string {
    return this.options.localPeerId
  }

  /**
   * Register where this host's frames go.
   *
   * With a `remotePeerId` the sender belongs to that peer alone. Without one it
   * becomes the fallback, which is what a single-peer surface and a bridge that
   * has not yet learned its peer's stable id both use.
   */
  attach(sender: PeerHostFrameSender, remotePeerId?: string): void {
    if (remotePeerId === undefined) {
      this.sender = sender
      return
    }
    const recipient = this.recipientFor(remotePeerId)
    recipient.sender = sender
  }

  /** Forget one peer, so nothing is later sent down a channel that is gone. */
  detach(remotePeerId: string): boolean {
    return this.recipients.delete(remotePeerId)
  }

  /** Peers this host currently holds a record for, in first-seen order. */
  recipientPeerIds(): string[] {
    return [...this.recipients.keys()]
  }

  private recipientFor(remotePeerId: string): PeerHostRecipient {
    const existing = this.recipients.get(remotePeerId)
    if (existing) return existing
    const created: PeerHostRecipient = {}
    this.recipients.set(remotePeerId, created)
    return created
  }

  private rememberRecipient(remotePeerId?: string, authenticatedPeerContext?: AuthenticatedPeerContext): void {
    if (remotePeerId === undefined) return
    const recipient = this.recipientFor(remotePeerId)
    if (authenticatedPeerContext !== undefined) recipient.authenticatedPeerContext = authenticatedPeerContext
  }

  /**
   * The peer a peer-less call is about, when there is exactly one.
   *
   * With several peers there is no correct answer, so this returns nothing
   * rather than guessing. Guessing is precisely the old defect: it hands one
   * peer's manifest authority to another.
   */
  private soleRecipientPeerId(): string | undefined {
    if (this.recipients.size !== 1) return undefined
    const [only] = this.recipients.keys()
    return only
  }

  private contextFor(remotePeerId?: string): AuthenticatedPeerContext | undefined {
    const peerId = remotePeerId ?? this.soleRecipientPeerId()
    if (peerId === undefined) return undefined
    return this.recipients.get(peerId)?.authenticatedPeerContext
  }

  async startEpoch(remotePeerId?: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<Record<string, unknown>> {
    this.acceptingInbound = false
    this.admittedServices = new Set<string>()
    this.connectionEpoch = this.lease.startEpoch()
    this.availabilityRevision = 0
    this.pendingManifest = null
    this.pendingManifestFrame = null
    this.staleManifestAckRetryCount = 0
    this.authorityRevoked = false
    this.rememberRecipient(remotePeerId, authenticatedPeerContext)
    const epochContext = this.authenticatedContextForCurrentEpoch(authenticatedPeerContext ?? this.contextFor(remotePeerId))
    this.bindRevocation(epochContext)
    return await this.buildManifest(remotePeerId, epochContext)
  }

  markManifestAcknowledged(ack: Record<string, unknown>): boolean {
    if (!this.pendingManifest) return false
    if (!this.manifestAckEvidenceMatches(ack)) return false
    const compatible = this.validateStructuredManifestAckServices(ack)
    if (compatible === null) return false
    if (this.pendingManifest.requiredServices.length === 0) return false
    // Admit exactly the projected modules the recipient called compatible.
    // Python classifies a service it has no routing config for as `unused`,
    // which is a statement about the consumer's preference, not about whether
    // the service works — so an all-or-nothing gate here let one uninterested
    // consumer close the provider entirely.
    const admitted = this.pendingManifest.requiredServices.filter((service) => compatible.includes(service))
    if (admitted.length === 0) return false
    this.admittedServices = new Set(admitted)
    this.acceptingInbound = true
    this.pendingManifest = null
    this.pendingManifestFrame = null
    this.staleManifestAckRetryCount = 0
    void this.resolveSender()?.sendFrame(this.renewLease()).catch(() => undefined)
    return true
  }

  /** Retransmit the pending manifest after a stale authority acknowledgement. */
  async retryManifestAfterStaleAcknowledgement(ack: Record<string, unknown>): Promise<boolean> {
    if (!this.pendingManifest || !this.pendingManifestFrame) return false
    if (this.manifestAckEvidenceMatches(ack)) return false
    if (this.staleManifestAckRetryCount >= MAX_STALE_MANIFEST_ACK_RETRIES) return false
    this.staleManifestAckRetryCount += 1
    await this.requireSender().sendFrame(this.pendingManifestFrame)
    return true
  }

  suspend(reason = 'provider_unavailable'): Record<string, unknown> {
    this.acceptingInbound = false
    this.admittedServices = new Set<string>()
    this.cancelAll(reason)
    const frame = this.lease.tombstone(reason) as unknown as Record<string, unknown>
    return frame
  }

  /**
   * Restart an epoch for one peer, or for the only peer when there is one.
   *
   * With several peers and no `remotePeerId` there is nothing correct to
   * restart, so this restarts nothing rather than picking whichever peer spoke
   * last. `resumeLocalProvider` is the multi-peer entry point.
   */
  async resume(remotePeerId?: string): Promise<Record<string, unknown>> {
    const peerId = remotePeerId ?? this.soleRecipientPeerId()
    return await this.startEpoch(peerId, this.contextFor(peerId))
  }

  /**
   * Re-announce this provider to every peer it serves, each down its own channel.
   *
   * A single-peer surface keeps its old behaviour exactly: one recipient means
   * one epoch and one frame. With several peers each gets its own manifest,
   * built from its own authenticated context, instead of all of them getting
   * whichever peer happened to speak last.
   */
  async resumeLocalProvider(): Promise<void> {
    const peerIds = this.recipientPeerIds()
    if (peerIds.length === 0) {
      await this.requireSender().sendFrame(await this.resume())
      return
    }
    for (const peerId of peerIds) {
      const frame = await this.resume(peerId)
      await this.senderFor(peerId).sendFrame(frame)
    }
  }

  async renewLocalProvider(): Promise<void> {
    if (!this.acceptingInbound) return
    const peerIds = this.recipientPeerIds()
    if (peerIds.length === 0) {
      await this.requireSender().sendFrame(this.renewLease())
      return
    }
    const lease = this.renewLease()
    for (const peerId of peerIds) {
      await this.senderFor(peerId).sendFrame(lease)
    }
  }

  async suspendLocalProvider(reason = 'provider_unavailable'): Promise<void> {
    const frame = this.suspend(reason)
    const peerIds = this.recipientPeerIds()
    if (peerIds.length === 0) {
      await this.requireSender().sendFrame(frame)
      return
    }
    for (const peerId of peerIds) {
      await this.senderFor(peerId).sendFrame(frame)
    }
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

  /**
   * Whether the recipient's ACK admitted this module for inbound work.
   *
   * Callers must derive the module with `methodModule`, the same helper that
   * builds the manifest, so the admitted set and the advertised set cannot
   * disagree about which module a descriptor belongs to.
   */
  private isServiceAdmitted(module: string): boolean {
    return this.admittedServices.has(module)
  }

  private manifestAckEvidenceMatches(ack: Record<string, unknown>): boolean {
    return Boolean(
      this.pendingManifest
      && ack.active_protocol === ACTIVE_MANIFEST_PROTOCOL
      && ack.active_version === ACTIVE_VERSION
      && ack.active_tier === ACTIVE_TIER
      && ack.projection_digest === this.pendingManifest.projectionDigest
      && ack.registry_revision === this.pendingManifest.registryRevision
      && ack.export_policy_revision === this.pendingManifest.policyRevision
      && ack.auth_grant_revision === this.pendingManifest.authGrantRevision
    )
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
    this.rememberRecipient(remotePeerId)
    const epochContext = this.authenticatedContextForCurrentEpoch(authenticatedPeerContext)
    this.rememberRecipient(remotePeerId, epochContext)
    const nowMs = Math.floor(this.options.clock())
    const authority = await this.manifestAuthoritySnapshot(remotePeerId, epochContext, nowMs)
    const grantedMethodIds = new Set(authority.grantedMethodIds)
    const registryMethods = this.options.registry.list()
    const registryDigest = digest({ services: manifestServices(registryMethods) })
    const registryRevision = registryDigest
    const policyDigest = digest({ recipient_peer_id: authority.recipientPeerId ?? '', granted_method_ids: sortedUnique(authority.grantedMethodIds) })
    const policyRevision = policyDigest
    const methods = registryMethods.filter((method) => grantedMethodIds.has(method.methodId))
    const projectionReady = authority.authGrantState === 'active'
      && authority.authGrantRevision >= 1
      && typeof authority.recipientPeerId === 'string'
      && authority.recipientPeerId.length > 0
      && methods.length > 0
    if (!projectionReady) {
      this.pendingManifest = null
      this.pendingManifestFrame = null
      this.staleManifestAckRetryCount = 0
      return {
        type: 'manifest',
        peer_id: this.options.localPeerId,
        node_name: this.options.nodeName,
        aurora_version: '',
        shared_services: [],
        granted_permissions: null,
        active_protocol: LEGACY_MANIFEST_PROTOCOL,
        active_version: 'v0',
        active_tier: 'legacy',
        supported_protocols: [LEGACY_MANIFEST_PROTOCOL, ACTIVE_MANIFEST_PROTOCOL],
        projection_supported: true,
        projection_active: false,
        timestamp: new Date(nowMs).toISOString()
      }
    }
    const effectivePermissions = sortedUnique([
      ...effectivePermissionsForMethods(
        registryMethods.filter((method) => grantedMethodIds.has(method.methodId))
      ),
      ...(authority.grantedPermissions ?? [])
    ])
    const sharedServices = manifestServices(methods)
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
    const requiredServices = sharedServices
      .map((service) => service.module)
      .filter((module): module is string => typeof module === 'string')
    this.pendingManifest = {
      projectionDigest,
      registryRevision,
      policyRevision,
      authGrantRevision: authority.authGrantRevision,
      requiredServices
    }
    this.staleManifestAckRetryCount = 0
    const manifestFrame: Record<string, unknown> = {
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
    this.pendingManifestFrame = manifestFrame
    return manifestFrame
  }

  async handleCall(frame: CallFrame, remotePeerId: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    const sender = this.senderFor(remotePeerId)
    this.rememberRecipient(remotePeerId, authenticatedPeerContext)
    if (this.reservedWorkIds.has(frame.id)) {
      await sender.sendFrame(
        errorFrame(frame.id, 409, 'request is already active', 'request_in_progress')
      )
      return
    }
    this.reservedWorkIds.add(frame.id)
    this.inFlightCallIds.add(frame.id)
    try {
      const epochContext = this.authenticatedContextForCurrentEpoch(authenticatedPeerContext)
      const method = this.options.registry.get(frame.method)
      if (!method) {
        await sender.sendFrame(errorFrame(frame.id, 404, 'method not found', 'method_not_found'))
        return
      }
      if (this.authorityRevoked) {
        await sender.sendFrame(errorFrame(frame.id, 403, 'peer authority revoked', 'peer_authority_revoked'))
        return
      }
      if (!this.acceptingInbound || !this.lease.isActive()) {
        await sender.sendFrame(errorFrame(frame.id, 425, 'provider is not ready', 'provider_not_ready'))
        return
      }
      if (!this.isServiceAdmitted(methodModule(method))) {
        await sender.sendFrame(errorFrame(frame.id, 403, 'service is not admitted', 'service_not_admitted'))
        return
      }
      const requestBytes = utf8Bytes(JSON.stringify(frame.params ?? {}))
      const maxBytes = method.maxRequestBytes ?? this.options.maxRequestBytes
      if (requestBytes > maxBytes) {
        await sender.sendFrame(errorFrame(frame.id, 413, 'request too large', 'request_too_large'))
        return
      }
      const identity = identityFromAuthority(epochContext, frame.identity, remotePeerId)
      const nowMs = Math.floor(this.options.clock())
      const deadlineAtMs = nowMs + (method.timeoutMs ?? this.options.defaultTimeoutMs)
      const authorizeRequest = {
        remotePeerId,
        methodId: method.methodId,
        requiredPermissions: method.requiredPermissions,
        identity,
        nowMs
      }
      if (epochContext !== undefined) Object.assign(authorizeRequest, { authenticatedPeerContext: epochContext })
      const decision = await this.options.authorizationStore.authorize(authorizeRequest)
      if (!decision.allowed) {
        await sender.sendFrame(errorFrame(frame.id, 403, 'not authorized', decision.reasonCode ?? 'not_authorized'))
        return
      }
      const authorizedIdentity = identityFromAuthority(epochContext, frame.identity, remotePeerId, decision, this.effectivePermissionsForGrant(decision))
      if (method.methodType === 'stream') {
        await this.handleStreamCall(method, frame, remotePeerId, authorizedIdentity, nowMs, deadlineAtMs, epochContext)
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
        const context = this.callContext(frame, method, remotePeerId, authorizedIdentity, abort.signal, nowMs, deadlineAtMs, epochContext)
        const result = await this.options.registry.dispatch(method, frame.params ?? {}, context)
        if (this.finishActive(frame.id, active)) await sender.sendFrame({ type: 'result', id: frame.id, result })
      } catch (error) {
        if (this.finishActive(frame.id, active)) await sender.sendFrame({ type: 'error', id: frame.id, correlation_id: frame.id, error: redactError(error, this.options.randomId) })
      } finally {
        this.finishActive(frame.id, active)
      }
    } finally {
      this.inFlightCallIds.delete(frame.id)
      this.reservedWorkIds.delete(frame.id)
    }
  }

  async handleSubscribe(frame: SubscribeFrame, remotePeerId: string, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    const sender = this.senderFor(remotePeerId)
    this.rememberRecipient(remotePeerId, authenticatedPeerContext)
    if (this.reservedWorkIds.has(frame.id)) {
      await sender.sendFrame({
        type: 'subscribe_rejected',
        id: frame.id,
        reason: 'request_in_progress',
        rejected_topics: frame.topics
      })
      return
    }
    this.reservedWorkIds.add(frame.id)
    try {
      await this.handleReservedSubscribe(frame, remotePeerId, authenticatedPeerContext, sender)
    } finally {
      if (!this.active.has(frame.id)) this.reservedWorkIds.delete(frame.id)
    }
  }

  private async handleReservedSubscribe(frame: SubscribeFrame, remotePeerId: string, authenticatedPeerContext: AuthenticatedPeerContext | undefined, sender: PeerHostFrameSender): Promise<void> {
    const epochContext = this.authenticatedContextForCurrentEpoch(authenticatedPeerContext)
    if (this.authorityRevoked) {
      await sender.sendFrame({
        type: 'subscribe_rejected',
        id: frame.id,
        reason: 'peer_authority_revoked',
        rejected_topics: frame.topics
      })
      return
    }
    if (!this.acceptingInbound || !this.lease.isActive()) {
      await sender.sendFrame({
        type: 'subscribe_rejected',
        id: frame.id,
        reason: 'provider_not_ready',
        rejected_topics: frame.topics
      })
      return
    }
    if (this.active.has(frame.id)) {
      await sender.sendFrame({
        type: 'subscribe_rejected',
        id: frame.id,
        reason: 'duplicate_subscription_id',
        rejected_topics: frame.topics
      })
      return
    }
    const events = frame.topics.map((topic) => this.options.registry.getEvent(topic))
    if (events.some((event) => event === undefined)) {
      await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: 'topic_not_registered', rejected_topics: frame.topics })
      return
    }
    // Subscriptions are deliberately not gated on manifest admission: the
    // manifest advertises method-bearing services only, so an event-only module
    // has no entry in the ACK partition to be admitted by. Event authorization
    // is enforced per topic by authorizationStore.authorize below.
    const nowMs = Math.floor(this.options.clock())
    const identity = identityFromAuthority(epochContext, undefined, remotePeerId)
    for (const event of events as PeerHostEventDescriptor[]) {
      const authorizeRequest = {
        remotePeerId,
        methodId: event.topic,
        requiredPermissions: event.requiredPermissions,
        identity,
        nowMs
      }
      if (epochContext !== undefined) Object.assign(authorizeRequest, { authenticatedPeerContext: epochContext })
      const decision = await this.options.authorizationStore.authorize(authorizeRequest)
      if (!decision.allowed) {
        await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: decision.reasonCode ?? 'not_authorized', rejected_topics: frame.topics })
        return
      }
    }
    for (const event of events as PeerHostEventDescriptor[]) {
      const ttlSeconds = frame.ttl_seconds ?? 60
      if (event.maxTtlSeconds !== undefined && ttlSeconds > event.maxTtlSeconds) {
        await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: 'ttl_too_large', rejected_topics: frame.topics })
        return
      }
    }
    const abort = new AbortController()
    const timer = setTimeout(() => {
      void this.handleUnsubscribe(frame.id).catch(() => undefined)
    }, Math.max(1, frame.ttl_seconds ?? 60) * 1000)
    const handles: Array<{ close(reason?: string): void | Promise<void> }> = []
    const emission: SubscriptionEmissionState = {
      acknowledged: false,
      failed: false,
      pending: [],
      queuedSends: 0,
      sendChain: Promise.resolve(),
      validators: new Map(
        (events as PeerHostEventDescriptor[]).flatMap((event) => {
          const validator = event.createEmissionValidator?.()
          return validator === undefined ? [] : [[event.topic, validator] as const]
        })
      )
    }
    const active: ActiveWork = {
      abort,
      kind: 'subscription',
      settled: false,
      cleanup: (reason: string) => {
        clearTimeout(timer)
        for (const handle of handles) void handle.close(reason)
      }
    }
    this.active.set(frame.id, active)
    try {
      for (const event of events as PeerHostEventDescriptor[]) {
        const ttlSeconds = frame.ttl_seconds ?? 60
        const subscribeContext = {
          id: frame.id,
          topic: event.topic,
          remotePeerId,
          topics: frame.topics,
          correlationIds: frame.correlation_ids ?? [],
          ttlSeconds,
          signal: abort.signal,
          receivedAtMs: nowMs,
          emit: (value: unknown, options?: PeerHostEventEmitOptions) => this.emitSubscriptionEvent(
            event,
            value,
            options,
            frame,
            active,
            emission
          )
        }
        if (epochContext !== undefined) Object.assign(subscribeContext, { authenticatedPeerContext: epochContext })
        const handle = await this.options.registry.openSubscription(event, subscribeContext)
        if (abort.signal.aborted || active.settled || this.active.get(frame.id) !== active) {
          if (handle) void handle.close('peer_authority_revoked')
          return
        }
        if (handle) handles.push(handle)
      }
      if (emission.failed) throw new Error('peer-host subscription event queue overflow')
    } catch {
      if (!this.finishActive(frame.id, active, 'subscription_rejected')) return
      await sender.sendFrame({ type: 'subscribe_rejected', id: frame.id, reason: 'handler_failed', rejected_topics: frame.topics })
      return
    }
    if (abort.signal.aborted || active.settled || this.active.get(frame.id) !== active) return
    try {
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
      }, abort.signal)
      const buffered = emission.pending.splice(0)
      emission.acknowledged = true
      const delivered = await Promise.all(
        buffered.map((eventFrame) => this.scheduleSubscriptionEvent(frame.id, active, emission, eventFrame))
      )
      if (delivered.some((sent) => !sent)) return
    } catch (error) {
      active.abort.abort('event_send_failed')
      this.finishActive(frame.id, active, 'event_send_failed')
      throw error
    }
  }

  async handleUnsubscribe(id: string): Promise<void> {
    const sender = this.requireSender()
    const active = this.active.get(id)
    const removed = active?.kind === 'subscription'
    if (removed && active) {
      active.abort.abort('remote_unsubscribed')
      this.finishActive(id, active, 'remote_unsubscribed')
    }
    await sender.sendFrame({
      type: 'unsubscribed',
      id,
      subscription_id: id,
      removed
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
    this.admittedServices = new Set<string>()
    this.cancelAll(reason)
    this.unbindRevocation()
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
    const context = authenticatedPeerContext ?? this.contextFor(remotePeerId)
    const peerId = remotePeerId ?? context?.selector.claimantPeerId ?? this.soleRecipientPeerId()
    return await (this.options.authorizationStore.snapshotManifestAuthority?.({
      ...(peerId !== undefined ? { remotePeerId: peerId } : {}),
      ...(context !== undefined ? { authenticatedPeerContext: context } : {}),
      correlationId: `manifest:${this.connectionEpoch}`,
      nowMs
    }) ?? {
      ...(peerId !== undefined ? { recipientPeerId: peerId } : {}),
      grantedMethodIds: [],
      authGrantRevision: 0,
      authGrantState: 'unknown'
    })
  }

  private authenticatedContextForCurrentEpoch(context: AuthenticatedPeerContext | undefined): AuthenticatedPeerContext | undefined {
    if (context === undefined) return undefined
    if (context.connectionEpoch === this.connectionEpoch) return context
    return { ...context, selector: { ...context.selector }, transport: { ...context.transport }, connectionEpoch: this.connectionEpoch }
  }

  private effectivePermissionsForGrant(decision: PeerHostAuthorizationDecision): string[] {
    const grantedMethodIds = new Set(decision.grantedMethodIds ?? [])
    return sortedUnique([
      ...effectivePermissionsForMethods(this.options.registry.list().filter((method) => grantedMethodIds.has(method.methodId))),
      ...(decision.grantedPermissions ?? [])
    ])
  }

  private async handleStreamCall(method: PeerHostMethodDescriptor, frame: CallFrame, remotePeerId: string, identity: PeerHostIdentity, nowMs: number, deadlineAtMs: number, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    const sender = this.senderFor(remotePeerId)
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

  private async emitSubscriptionEvent(
    event: PeerHostEventDescriptor,
    value: unknown,
    options: PeerHostEventEmitOptions | undefined,
    subscription: SubscribeFrame,
    active: ActiveWork,
    emission: SubscriptionEmissionState
  ): Promise<boolean> {
    if (active.settled || active.abort.signal.aborted || this.active.get(subscription.id) !== active) return false
    const queueDepth = emission.acknowledged ? emission.queuedSends : emission.pending.length
    if (queueDepth >= MAX_SUBSCRIPTION_EVENT_QUEUE) {
      emission.failed = true
      if (emission.acknowledged) {
        this.terminateSubscriptionDelivery(subscription.id, active, 'event_queue_overflow')
      }
      return false
    }

    const parsed = this.options.registry.parseEventOutput(event, value)
    const correlationId = eventCorrelationId(parsed, options?.correlationId, subscription.correlation_ids ?? [])
    const eventFrame: Record<string, unknown> = {
      type: 'event',
      topic: event.topic,
      params: parsed
    }
    if (correlationId !== undefined) eventFrame.correlation_id = correlationId
    const maxEventBytes = event.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
    if (utf8Bytes(JSON.stringify(eventFrame)) > maxEventBytes) {
      throw new Error('peer-host event exceeds bounded payload size')
    }
    emission.validators.get(event.topic)?.(
      parsed,
      correlationId === undefined ? {} : { correlationId }
    )

    if (!emission.acknowledged) {
      emission.pending.push(eventFrame)
      return true
    }
    return await this.scheduleSubscriptionEvent(subscription.id, active, emission, eventFrame)
  }

  private scheduleSubscriptionEvent(
    subscriptionId: string,
    active: ActiveWork,
    emission: SubscriptionEmissionState,
    eventFrame: Record<string, unknown>
  ): Promise<boolean> {
    if (active.settled || active.abort.signal.aborted || this.active.get(subscriptionId) !== active) {
      return Promise.resolve(false)
    }
    if (emission.queuedSends >= MAX_SUBSCRIPTION_EVENT_QUEUE) {
      emission.failed = true
      this.terminateSubscriptionDelivery(subscriptionId, active, 'event_queue_overflow')
      return Promise.resolve(false)
    }
    emission.queuedSends += 1
    const delivery = emission.sendChain.then(async () => {
      if (active.settled || active.abort.signal.aborted || this.active.get(subscriptionId) !== active) return false
      await this.requireSender().sendFrame(eventFrame, active.abort.signal)
      return !active.settled && !active.abort.signal.aborted && this.active.get(subscriptionId) === active
    })
    emission.sendChain = delivery.then(() => undefined, () => undefined)
    return delivery.catch((error) => {
      this.terminateSubscriptionDelivery(subscriptionId, active, 'event_send_failed')
      throw error
    }).finally(() => {
      emission.queuedSends -= 1
    })
  }

  private terminateSubscriptionDelivery(
    subscriptionId: string,
    active: ActiveWork,
    reason: string
  ): void {
    active.abort.abort(reason)
    if (!this.finishActive(subscriptionId, active, reason)) return
    void this.resolveSender()?.sendFrame({
      type: 'unsubscribed',
      id: subscriptionId,
      subscription_id: subscriptionId,
      removed: true
    }).catch(() => undefined)
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

  private cancelRevokedAuthority(event: PeerRevocationEvent): void {
    if (!this.selectorMatchesActiveAuthority(event.selector)) return
    this.authorityRevoked = true
    this.acceptingInbound = false
    this.admittedServices = new Set<string>()
    const terminal = revocationTerminalError(event)
    for (const [id, active] of [...this.active]) {
      active.abort.abort('peer_authority_revoked')
      if (!this.finishActive(id, active, 'peer_authority_revoked')) continue
      void this.sendRevocationTerminal(id, active.kind, terminal).catch(() => undefined)
    }
  }

  private async sendRevocationTerminal(id: string, kind: ActiveWork['kind'], error: PeerHostErrorBody): Promise<void> {
    if (kind === 'subscription') {
      await this.resolveSender()?.sendFrame({ type: 'unsubscribed', id, subscription_id: id, removed: true })
      return
    }
    await this.resolveSender()?.sendFrame({ type: 'error', id, correlation_id: id, error })
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

  private finishActive(id: string, active: ActiveWork, reason = 'work_finished'): boolean {
    if (active.settled || this.active.get(id) !== active) return false
    active.settled = true
    active.cleanup(reason)
    this.active.delete(id)
    if (!this.inFlightCallIds.has(id)) this.reservedWorkIds.delete(id)
    return true
  }

  private bindRevocation(context: AuthenticatedPeerContext | undefined): void {
    this.unbindRevocation()
    if (context === undefined || this.options.revocationBroadcaster === undefined) {
      this.activeAuthoritySelector = null
      return
    }
    this.activeAuthoritySelector = { ...context.selector }
    this.unsubscribeRevocation = this.options.revocationBroadcaster.subscribe((event) => {
      this.cancelRevokedAuthority(event)
    })
  }

  private unbindRevocation(): void {
    this.unsubscribeRevocation?.()
    this.unsubscribeRevocation = null
    this.activeAuthoritySelector = null
  }

  private selectorMatchesActiveAuthority(selector: PeerRelationshipSelector): boolean {
    const active = this.activeAuthoritySelector
    return active !== null &&
      active.tokenId === selector.tokenId &&
      active.claimantPeerId === selector.claimantPeerId &&
      active.verifierPeerId === selector.verifierPeerId &&
      active.roomName === selector.roomName
  }

  private requireSender(): PeerHostFrameSender {
    const sender = this.resolveSender()
    if (!sender) throw new Error('peer host is not attached')
    return sender
  }

  /**
   * The channel one peer's frames go down.
   *
   * A peer's own sender first. Then the unkeyed one, for a surface that never
   * named a peer. Then the only recipient's, when there is exactly one, which
   * is what makes a single-peer host behave as it always did.
   *
   * With several peers and no peer named there is no correct channel, so this
   * resolves to nothing and the caller's optional chain drops the frame rather
   * than sending it to whoever happens to be first. Sending it anyway is the
   * defect this map exists to end: one peer's frame leaving down another's
   * channel.
   */
  private resolveSender(remotePeerId?: string): PeerHostFrameSender | undefined {
    if (remotePeerId !== undefined) {
      const keyed = this.recipients.get(remotePeerId)?.sender
      if (keyed) return keyed
    }
    if (this.sender) return this.sender
    if (this.recipients.size !== 1) return undefined
    const [only] = this.recipients.values()
    return only?.sender
  }

  private senderFor(remotePeerId?: string): PeerHostFrameSender {
    const sender = this.resolveSender(remotePeerId)
    if (!sender) throw new Error('peer host is not attached')
    return sender
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

function manifestServices(methods: readonly PeerHostMethodDescriptor[]): Array<Record<string, unknown>> {
  const byModule = new Map<string, PeerHostMethodDescriptor[]>()
  for (const method of methods) {
    const module = methodModule(method)
    const group = byModule.get(module) ?? []
    group.push(method)
    byModule.set(module, group)
  }
  return [...byModule.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([module, serviceMethods]) => manifestService(module, serviceMethods))
}

function manifestService(
  module: string,
  descriptors: readonly PeerHostMethodDescriptor[]
): Record<string, unknown> {
  const methods = descriptors
    .map((method) => manifestMethod(method))
    .sort((left, right) => compareCodePoints(String(left.bus_topic), String(right.bus_topic)))
  const declaredCapabilities = sortedUnique(
    descriptors.flatMap((method) => method.serviceCapabilities ?? [])
  )
  const capabilities = declaredCapabilities.length > 0
    ? declaredCapabilities
    : module === 'Tooling'
      ? [...TOOLING_PROVIDER_CAPABILITIES]
      : []
  const versions = sortedUnique(
    descriptors
      .map((method) => method.serviceVersion)
      .filter((version): version is string => typeof version === 'string' && version.length > 0)
  )
  const concurrencyLimits = descriptors
    .map((method) => method.maxConcurrent)
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0)
  const availableFeatureIds = sortedUnique(
    descriptors.flatMap((method) => method.callableFeatureIds ?? [])
  )
  const availableFeatureIdSet = new Set(availableFeatureIds)
  const service = {
    module,
    version: versions[0] ?? '0.0.0',
    capabilities,
    callable_features: canonicalCallableFeatures(
      descriptors
        .flatMap((method) => method.callableFeatures ?? [])
        .filter((feature) => availableFeatureIdSet.has(feature.feature_id))
    ),
    available_feature_ids: availableFeatureIds,
    methods,
    max_concurrent: concurrencyLimits.length > 0 ? Math.min(...concurrencyLimits) : 10
  }
  return { ...service, digest: digest(service) }
}

function manifestMethod(method: PeerHostMethodDescriptor): Record<string, unknown> {
  const name = method.name
    ?? (method.methodId.includes('.') ? method.methodId.split('.').at(-1) ?? method.methodId : method.methodId)
  const callableFeatureIds = sortedUnique(method.callableFeatureIds ?? [])
  const callableFeatureIdSet = new Set(callableFeatureIds)
  return {
    name,
    summary: method.summary ?? '',
    bus_topic: method.busTopic ?? method.methodId,
    exposure: method.exposure ?? 'both',
    input_model: method.inputModel ?? schemaName(method.inputSchemaId),
    output_model: method.outputModel ?? schemaName(method.outputSchemaId),
    required_perms: sortedUnique(method.requiredPermissions),
    callable_feature_ids: callableFeatureIds,
    callable_features: canonicalCallableFeatures(
      (method.callableFeatures ?? []).filter((feature) => callableFeatureIdSet.has(feature.feature_id))
    ),
    speech_constraints: method.speechConstraints ?? null,
    public_infrastructure: false,
    method_type: projectionMethodType(method),
    input_schema: null,
    output_schema: null
  }
}

function methodModule(method: PeerHostMethodDescriptor): string {
  if (method.module && method.module.length > 0) return method.module
  const separator = method.methodId.indexOf('.')
  return separator > 0 ? method.methodId.slice(0, separator) : 'Tooling'
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

function canonicalCallableFeatures(
  features: readonly CallableFeatureContract[]
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>()
  for (const feature of features) {
    if (feature.feature_id.length === 0) continue
    byId.set(feature.feature_id, {
      feature_id: feature.feature_id,
      module: feature.module,
      label: feature.label,
      summary: feature.summary,
      method_ids: sortedUnique(feature.method_ids)
    })
  }
  return [...byId.values()].sort((left, right) =>
    compareCodePoints(String(left.feature_id), String(right.feature_id))
  )
}

/**
 * Order strings exactly the way Python's `sorted()` does.
 *
 * The projection manifest must arrive in canonical order or Python's
 * `_require_canonical_unique` rejects the whole thing as
 * `projection_not_canonical`. `localeCompare` uses ICU collation, which is
 * case-insensitive at the primary level and orders punctuation differently, so
 * it can disagree with code-point order and silently fail the manifest closed.
 */
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

function revocationTerminalError(event: PeerRevocationEvent): PeerHostErrorBody {
  return {
    code: 403,
    message: 'peer authority revoked',
    reason_code: 'peer_authority_revoked',
    error_ref: String(event.revokedAtMs).slice(0, 64)
  }
}

function eventCorrelationId(
  value: unknown,
  explicitCorrelationId: string | undefined,
  allowedCorrelationIds: readonly string[]
): string | undefined {
  const payloadCorrelationId = isRecord(value) && typeof value.correlation_id === 'string'
    ? value.correlation_id
    : undefined
  if (
    explicitCorrelationId !== undefined
    && payloadCorrelationId !== undefined
    && explicitCorrelationId !== payloadCorrelationId
  ) {
    throw new Error('peer-host event correlation does not match payload')
  }
  const correlationId = explicitCorrelationId ?? payloadCorrelationId
  if (
    correlationId !== undefined
    && (correlationId.length === 0 || correlationId.length > MAX_EVENT_CORRELATION_ID_LENGTH)
  ) {
    throw new Error('peer-host event correlation is not a bounded identifier')
  }
  if (
    allowedCorrelationIds.length > 0
    && (correlationId === undefined || !allowedCorrelationIds.includes(correlationId))
  ) {
    throw new Error('peer-host event correlation is outside the subscription scope')
  }
  return correlationId
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
