import {
  bytesToHex,
  computeReconnectProofHex,
  randomBytes,
  sha256Bytes,
  verifyReconnectProofHex
} from '../webrtc/crypto.js'
import { zeroBytes } from '../webrtc/encoding.js'

const HEX64_RE = /^[0-9a-f]{64}$/u
const DEFAULT_CHALLENGE_TTL_MS = 20_000
const MAX_CHALLENGE_COLLISION_RETRIES = 8

export interface PeerRelationshipSelector {
  readonly tokenId: string
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
}

export interface ReconnectTransportAttestation {
  readonly channelBinding: string
  readonly claimantSignalingPeerId: string
  readonly verifierSignalingPeerId: string
}

export interface AuthenticatedPeerContext {
  readonly selector: PeerRelationshipSelector
  readonly transport: ReconnectTransportAttestation
  readonly connectionEpoch?: string
  readonly credentialRevision: number
  readonly authenticatedAtMs: number
}

export interface LocalPeerCredentialVerifierV1 extends PeerRelationshipSelector {
  readonly version: 1
  readonly tokenHashHex: string
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly credentialRevision: number
}

export interface LocalPeerGrantV1 extends PeerRelationshipSelector {
  readonly version: 1
  readonly grantId: string
  readonly allowedMethodIds: readonly string[]
  readonly allowedToolContractIds: readonly string[]
  readonly capabilityPackIds: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly grantRevision: number
}

export interface LocalPeerApprovalRequest {
  readonly selector: PeerRelationshipSelector
  readonly allowedMethodIds?: readonly string[]
  readonly allowedToolContractIds?: readonly string[]
  readonly capabilityPackIds?: readonly string[]
  readonly resourceScopes?: readonly string[]
  readonly expiresAtMs?: number
  readonly approvedBy?: string
  readonly reason?: string
}

export type PeerAuthorityDecisionReason =
  | 'credential_not_found'
  | 'credential_expired'
  | 'credential_revoked'
  | 'grant_not_found'
  | 'grant_store_unreadable'
  | 'grant_expired'
  | 'grant_revoked'
  | 'method_not_granted'
  | 'tool_not_granted'
  | 'capability_not_granted'
  | 'resource_not_granted'

export interface PeerAuthorityDecision {
  readonly allowed: boolean
  readonly grant?: LocalPeerGrantV1
  readonly reasonCode?: PeerAuthorityDecisionReason
}

export interface PeerGrantResolutionRequest {
  readonly selector: PeerRelationshipSelector
  readonly methodId?: string
  readonly toolContractId?: string
  readonly capabilityPackId?: string
  readonly resourceScope?: string
  readonly nowMs: number
}

export type LocalPeerAuditAction =
  | 'credential.issue'
  | 'credential.verify'
  | 'grant.check'
  | 'grant.revoke'
  | 'challenge.issue'
  | 'challenge.consume'
  | 'challenge.reject'
  | 'revocation.broadcast'

export interface LocalPeerAuditRecord {
  readonly action: LocalPeerAuditAction
  readonly selector: PeerRelationshipSelector
  readonly decision: 'accepted' | 'rejected' | 'revoked' | 'issued'
  readonly reasonCode?: string
  readonly methodId?: string
  readonly toolContractId?: string
  readonly capabilityPackId?: string
  readonly resourceScope?: string
  readonly correlationId?: string
  readonly connectionEpoch?: string
  readonly createdAtMs: number
  readonly redacted: true
  readonly redactedFields: readonly string[]
}

export interface PeerRevocationEvent {
  readonly type: 'peer_authority_revoked_v1'
  readonly selector: PeerRelationshipSelector
  readonly revokedGrantIds: readonly string[]
  readonly credentialRevision?: number
  readonly revokedAtMs: number
  readonly reasonCode: string
  readonly redacted: true
}

export interface InboundCredentialVerifierStore {
  getVerifier(selector: PeerRelationshipSelector, nowMs?: number): Promise<LocalPeerCredentialVerifierV1 | undefined>
  upsertVerifier(verifier: LocalPeerCredentialVerifierV1): Promise<void>
  revokeVerifier(selector: PeerRelationshipSelector, revokedAtMs: number): Promise<LocalPeerCredentialVerifierV1 | undefined>
  deleteVerifier(selector: PeerRelationshipSelector): Promise<void>
}

export interface PeerGrantRepository {
  upsertGrant(grant: LocalPeerGrantV1): Promise<void>
  resolveGrant(request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision>
  listRecipientGrants(selector: PeerRelationshipSelector, nowMs: number): Promise<readonly LocalPeerGrantV1[]>
  revokeGrants(selector: PeerRelationshipSelector, revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]>
}

export type ReconnectChallengeConsumeStatus =
  | 'accepted'
  | 'replay'
  | 'not_found'
  | 'expired'
  | 'selector_mismatch'
  | 'transport_mismatch'
  | 'rejected'

export interface ReconnectChallengeRecord {
  readonly challenge: string
  readonly selector: PeerRelationshipSelector
  readonly transport: ReconnectTransportAttestation
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly consumedAtMs?: number
  readonly rejectedAtMs?: number
}

export interface ReconnectChallengeConsumeResult {
  readonly status: ReconnectChallengeConsumeStatus
  readonly challenge?: ReconnectChallengeRecord
}

export interface ReconnectChallengeStore {
  issueChallenge(selector: PeerRelationshipSelector, transport: ReconnectTransportAttestation, nowMs: number): Promise<ReconnectChallengeRecord>
  consumeChallenge(challenge: string, selector: PeerRelationshipSelector, transport: ReconnectTransportAttestation, nowMs: number): Promise<ReconnectChallengeConsumeResult>
  rejectChallenges(selector: PeerRelationshipSelector, rejectedAtMs: number): Promise<number>
}

export interface PeerAuditSink {
  record(record: LocalPeerAuditRecord): Promise<void>
}

export interface PeerRevocationBroadcaster {
  publish(event: PeerRevocationEvent): Promise<void>
  subscribe(listener: (event: PeerRevocationEvent) => void): () => void
}

export interface PeerRevocationController {
  revoke(selector: PeerRelationshipSelector, reasonCode?: string, revokedAtMs?: number): Promise<PeerRevocationEvent>
}

export interface PeerPairingIssuerOptions {
  verifierStore: InboundCredentialVerifierStore
  auditSink?: PeerAuditSink
  randomBytes?: (length: number) => Uint8Array
  now?: () => number
}

export interface IssuedPeerBearerCredential {
  readonly tokenId: string
  readonly bearerToken: string
  readonly verifier: LocalPeerCredentialVerifierV1
}

export interface PeerAuthorityResolverOptions {
  verifierStore: InboundCredentialVerifierStore
  grantRepository: PeerGrantRepository
  challengeStore?: ReconnectChallengeStore
  auditSink?: PeerAuditSink
  manifestProvider?: (context: AuthenticatedPeerContext, grants: readonly LocalPeerGrantV1[]) => Promise<unknown> | unknown
}

export interface VerifyReconnectProofRequest {
  readonly proofHex: string
  readonly selector: PeerRelationshipSelector
  readonly transport: ReconnectTransportAttestation
  readonly challenge: string
  readonly nowMs: number
}

export interface VerifyReconnectProofResult {
  readonly ok: boolean
  readonly context?: AuthenticatedPeerContext
  readonly reasonCode?: string
}

export class DenyAllInboundCredentialVerifierStore implements InboundCredentialVerifierStore {
  async getVerifier(_selector: PeerRelationshipSelector, _nowMs?: number): Promise<undefined> {
    return undefined
  }
  async upsertVerifier(_verifier: LocalPeerCredentialVerifierV1): Promise<void> {
  }
  async revokeVerifier(_selector: PeerRelationshipSelector, _revokedAtMs: number): Promise<undefined> {
    return undefined
  }
  async deleteVerifier(_selector: PeerRelationshipSelector): Promise<void> {
  }
}

export class DenyAllPeerGrantRepository implements PeerGrantRepository {
  async upsertGrant(_grant: LocalPeerGrantV1): Promise<void> {
  }
  async resolveGrant(_request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    return { allowed: false, reasonCode: 'grant_not_found' }
  }
  async listRecipientGrants(_selector: PeerRelationshipSelector, _nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return []
  }
  async revokeGrants(_selector: PeerRelationshipSelector, _revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return []
  }
}

export class NoopReconnectChallengeStore implements ReconnectChallengeStore {
  async issueChallenge(selector: PeerRelationshipSelector, transport: ReconnectTransportAttestation, nowMs: number): Promise<ReconnectChallengeRecord> {
    validateSelector(selector)
    validateTransport(transport)
    return {
      challenge: '0'.repeat(64),
      selector: cloneSelector(selector),
      transport: cloneTransport(transport),
      issuedAtMs: nowMs,
      expiresAtMs: nowMs
    }
  }

  async consumeChallenge(_challenge: string, _selector: PeerRelationshipSelector, _transport: ReconnectTransportAttestation, _nowMs: number): Promise<ReconnectChallengeConsumeResult> {
    return { status: 'not_found' }
  }

  async rejectChallenges(_selector: PeerRelationshipSelector, _rejectedAtMs: number): Promise<number> {
    return 0
  }
}

export class NoopPeerAuditSink implements PeerAuditSink {
  async record(_record: LocalPeerAuditRecord): Promise<void> {
  }
}
export class NoopPeerRevocationBroadcaster implements PeerRevocationBroadcaster {
  async publish(_event: PeerRevocationEvent): Promise<void> {
  }
  subscribe(_listener: (event: PeerRevocationEvent) => void): () => void {
    return () => undefined
  }
}

export class PeerAuthorityResolver {
  private readonly verifierStore: InboundCredentialVerifierStore
  private readonly grantRepository: PeerGrantRepository
  private readonly challengeStore: ReconnectChallengeStore
  private readonly auditSink: PeerAuditSink
  private readonly manifestProvider: ((context: AuthenticatedPeerContext, grants: readonly LocalPeerGrantV1[]) => Promise<unknown> | unknown) | undefined

  constructor(options: PeerAuthorityResolverOptions) {
    this.verifierStore = options.verifierStore
    this.grantRepository = options.grantRepository
    this.challengeStore = options.challengeStore ?? new NoopReconnectChallengeStore()
    this.auditSink = options.auditSink ?? new NoopPeerAuditSink()
    this.manifestProvider = options.manifestProvider
  }

  async verifyReconnectProof(request: VerifyReconnectProofRequest): Promise<VerifyReconnectProofResult> {
    const challenge = await this.challengeStore.consumeChallenge(request.challenge, request.selector, request.transport, request.nowMs)
    if (challenge.status !== 'accepted') {
      await this.auditSink.record(auditRecord('challenge.consume', request.selector, 'rejected', request.nowMs, challenge.status))
      return { ok: false, reasonCode: challenge.status }
    }
    const verifier = await this.verifierStore.getVerifier(request.selector, request.nowMs)
    if (verifier === undefined) {
      await this.auditSink.record(auditRecord('credential.verify', request.selector, 'rejected', request.nowMs, 'credential_not_found'))
      return { ok: false, reasonCode: 'credential_not_found' }
    }
    const ok = await verifyReconnectProofHex(verifier.tokenHashHex, request.proofHex, {
      tokenId: request.selector.tokenId,
      challenge: request.challenge,
      channelBinding: request.transport.channelBinding,
      claimantPeerId: request.selector.claimantPeerId,
      verifierPeerId: request.selector.verifierPeerId,
      roomName: request.selector.roomName
    })
    if (!ok) {
      await this.auditSink.record(auditRecord('credential.verify', request.selector, 'rejected', request.nowMs, 'proof_mismatch'))
      return { ok: false, reasonCode: 'proof_mismatch' }
    }
    const context: AuthenticatedPeerContext = {
      selector: cloneSelector(request.selector),
      transport: cloneTransport(request.transport),
      credentialRevision: verifier.credentialRevision,
      authenticatedAtMs: request.nowMs
    }
    await this.auditSink.record(auditRecord('credential.verify', request.selector, 'accepted', request.nowMs))
    return { ok: true, context }
  }

  async resolveGrant(context: AuthenticatedPeerContext, request: Omit<PeerGrantResolutionRequest, 'selector' | 'nowMs'> & { nowMs: number }): Promise<PeerAuthorityDecision> {
    const decision = await this.grantRepository.resolveGrant({
      ...request,
      selector: context.selector,
      nowMs: request.nowMs
    })
    await this.auditSink.record(auditRecord('grant.check', context.selector, decision.allowed ? 'accepted' : 'rejected', request.nowMs, decision.reasonCode, request.methodId, context.connectionEpoch))
    return decision
  }

  async listRecipientGrants(context: AuthenticatedPeerContext, nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return await this.grantRepository.listRecipientGrants(context.selector, nowMs)
  }

  async getRecipientManifest(context: AuthenticatedPeerContext, nowMs: number): Promise<unknown> {
    const grants = await this.listRecipientGrants(context, nowMs)
    if (grants.length === 0 || this.manifestProvider === undefined) {
      return { shared_services: [], grants: [] }
    }
    return await this.manifestProvider(context, grants)
  }
}

export class MemoryInboundCredentialVerifierStore implements InboundCredentialVerifierStore {
  private readonly verifiers = new Map<string, LocalPeerCredentialVerifierV1>()

  async getVerifier(selector: PeerRelationshipSelector, nowMs = Date.now()): Promise<LocalPeerCredentialVerifierV1 | undefined> {
    const verifier = this.verifiers.get(selectorKey(selector))
    if (verifier === undefined) return undefined
    if (verifier.expiresAtMs !== undefined && verifier.expiresAtMs <= nowMs) return undefined
    if (verifier.revokedAtMs !== undefined && verifier.revokedAtMs <= nowMs) return undefined
    return cloneVerifier(verifier)
  }

  async upsertVerifier(verifier: LocalPeerCredentialVerifierV1): Promise<void> {
    validateVerifier(verifier)
    this.verifiers.set(selectorKey(verifier), cloneVerifier(verifier))
  }

  async revokeVerifier(selector: PeerRelationshipSelector, revokedAtMs: number): Promise<LocalPeerCredentialVerifierV1 | undefined> {
    const verifier = this.verifiers.get(selectorKey(selector))
    if (verifier === undefined) return undefined
    const revoked = { ...verifier, revokedAtMs, credentialRevision: verifier.credentialRevision + 1 }
    this.verifiers.set(selectorKey(selector), revoked)
    return cloneVerifier(revoked)
  }

  async deleteVerifier(selector: PeerRelationshipSelector): Promise<void> {
    this.verifiers.delete(selectorKey(selector))
  }
}

export class MemoryPeerGrantRepository implements PeerGrantRepository {
  private readonly grants = new Map<string, LocalPeerGrantV1>()

  async upsertGrant(grant: LocalPeerGrantV1): Promise<void> {
    validateGrant(grant)
    this.grants.set(grant.grantId, cloneGrant(grant))
  }

  async resolveGrant(request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    const candidates = [...this.grants.values()]
      .filter((grant) => selectorEquals(grant, request.selector))
      .sort(compareGrants)
    let blockedReason: PeerAuthorityDecisionReason = 'grant_not_found'
    for (const grant of candidates) {
      if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= request.nowMs) {
        blockedReason = 'grant_revoked'
        continue
      }
      if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) {
        blockedReason = 'grant_expired'
        continue
      }
      const reason = grantCoverageFailure(grant, request)
      if (reason === undefined) return { allowed: true, grant: cloneGrant(grant) }
      blockedReason = reason
    }
    return { allowed: false, reasonCode: blockedReason }
  }

  async listRecipientGrants(selector: PeerRelationshipSelector, nowMs: number): Promise<readonly LocalPeerGrantV1[]> {
    return [...this.grants.values()]
      .filter((grant) => selectorEquals(grant, selector))
      .filter((grant) => (grant.revokedAtMs === undefined || grant.revokedAtMs > nowMs) && (grant.expiresAtMs === undefined || grant.expiresAtMs > nowMs))
      .sort(compareGrants)
      .map(cloneGrant)
  }

  async revokeGrants(selector: PeerRelationshipSelector, revokedAtMs: number): Promise<readonly LocalPeerGrantV1[]> {
    const revoked: LocalPeerGrantV1[] = []
    for (const [grantId, grant] of this.grants) {
      if (!selectorEquals(grant, selector)) continue
      const next = { ...grant, revokedAtMs, grantRevision: grant.grantRevision + 1 }
      this.grants.set(grantId, next)
      revoked.push(cloneGrant(next))
    }
    return revoked.sort(compareGrants)
  }
}

export class MemoryReconnectChallengeStore implements ReconnectChallengeStore {
  private readonly challenges = new Map<string, ReconnectChallengeRecord>()
  private readonly random: (length: number) => Uint8Array

  constructor(options: { ttlMs?: number; randomBytes?: (length: number) => Uint8Array } = {}) {
    if ((options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS) !== DEFAULT_CHALLENGE_TTL_MS) {
      throw new Error('Reconnect challenge TTL must be exactly 20 seconds')
    }
    this.random = options.randomBytes ?? randomBytes
  }

  async issueChallenge(selector: PeerRelationshipSelector, transport: ReconnectTransportAttestation, nowMs: number): Promise<ReconnectChallengeRecord> {
    validateSelector(selector)
    validateTransport(transport)
    this.prune(nowMs)
    for (let attempt = 0; attempt <= MAX_CHALLENGE_COLLISION_RETRIES; attempt += 1) {
      const challenge = bytesToHex(this.random(32))
      if (!HEX64_RE.test(challenge)) throw new Error('Invalid reconnect challenge bytes')
      if (this.challenges.has(challenge)) continue
      const record: ReconnectChallengeRecord = {
        challenge,
        selector: cloneSelector(selector),
        transport: cloneTransport(transport),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + DEFAULT_CHALLENGE_TTL_MS
      }
      this.challenges.set(challenge, record)
      return cloneChallenge(record)
    }
    throw new Error('Reconnect challenge collision retry limit exceeded')
  }

  async consumeChallenge(challenge: string, selector: PeerRelationshipSelector, transport: ReconnectTransportAttestation, nowMs: number): Promise<ReconnectChallengeConsumeResult> {
    const record = this.challenges.get(challenge)
    if (record === undefined) return { status: 'not_found' }
    if (record.expiresAtMs <= nowMs) {
      this.challenges.delete(challenge)
      return { status: 'expired' }
    }
    if (record.rejectedAtMs !== undefined) return { status: 'rejected', challenge: cloneChallenge(record) }
    if (!selectorEquals(record.selector, selector)) return { status: 'selector_mismatch', challenge: cloneChallenge(record) }
    if (!transportEquals(record.transport, transport)) return { status: 'transport_mismatch', challenge: cloneChallenge(record) }
    if (record.consumedAtMs !== undefined) return { status: 'replay', challenge: cloneChallenge(record) }
    const consumed = { ...record, consumedAtMs: nowMs }
    this.challenges.set(challenge, consumed)
    return { status: 'accepted', challenge: cloneChallenge(consumed) }
  }

  async rejectChallenges(selector: PeerRelationshipSelector, rejectedAtMs: number): Promise<number> {
    let rejected = 0
    for (const [challenge, record] of this.challenges) {
      if (!selectorEquals(record.selector, selector)) continue
      if (record.expiresAtMs <= rejectedAtMs) {
        this.challenges.delete(challenge)
        continue
      }
      this.challenges.set(challenge, { ...record, rejectedAtMs })
      rejected += 1
    }
    return rejected
  }

  private prune(nowMs: number): void {
    for (const [challenge, record] of this.challenges) {
      if (record.expiresAtMs <= nowMs) this.challenges.delete(challenge)
    }
  }
}

export class MemoryPeerAuditSink implements PeerAuditSink {
  readonly records: LocalPeerAuditRecord[] = []

  async record(record: LocalPeerAuditRecord): Promise<void> {
    this.records.push({ ...record, selector: cloneSelector(record.selector), redactedFields: [...record.redactedFields] })
  }
}

export class MemoryPeerRevocationBroadcaster implements PeerRevocationBroadcaster {
  private readonly listeners = new Set<(event: PeerRevocationEvent) => void>()
  readonly events: PeerRevocationEvent[] = []

  async publish(event: PeerRevocationEvent): Promise<void> {
    const cloned = cloneRevocationEvent(event)
    this.events.push(cloned)
    for (const listener of [...this.listeners]) listener(cloned)
  }

  subscribe(listener: (event: PeerRevocationEvent) => void): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }
}

export class PeerPairingIssuer {
  private readonly verifierStore: InboundCredentialVerifierStore
  private readonly auditSink: PeerAuditSink
  private readonly random: (length: number) => Uint8Array
  private readonly now: () => number

  constructor(options: PeerPairingIssuerOptions) {
    this.verifierStore = options.verifierStore
    this.auditSink = options.auditSink ?? new NoopPeerAuditSink()
    this.random = options.randomBytes ?? randomBytes
    this.now = options.now ?? Date.now
  }

  async issue(selector: PeerRelationshipSelector, options: { expiresAtMs?: number } = {}): Promise<IssuedPeerBearerCredential> {
    validateSelector(selector)
    const tokenBytes = this.random(32)
    const bearerToken = bytesToHex(tokenBytes)
    const tokenHash = await sha256Bytes(bearerToken)
    try {
      const nowMs = this.now()
      const verifier: LocalPeerCredentialVerifierV1 = {
        version: 1,
        ...cloneSelector(selector),
        tokenHashHex: bytesToHex(tokenHash),
        createdAtMs: nowMs,
        credentialRevision: 1
      }
      if (options.expiresAtMs !== undefined) Object.assign(verifier, { expiresAtMs: options.expiresAtMs })
      await this.verifierStore.upsertVerifier(verifier)
      await this.auditSink.record(auditRecord('credential.issue', selector, 'issued', nowMs))
      return { tokenId: selector.tokenId, bearerToken, verifier }
    } finally {
      zeroBytes(tokenBytes)
      zeroBytes(tokenHash)
    }
  }
}

export class MemoryPeerRevocationController implements PeerRevocationController {
  private readonly verifierStore: InboundCredentialVerifierStore
  private readonly grantRepository: PeerGrantRepository
  private readonly challengeStore: ReconnectChallengeStore
  private readonly auditSink: PeerAuditSink
  private readonly broadcaster: PeerRevocationBroadcaster
  private readonly now: () => number

  constructor(options: {
    verifierStore: InboundCredentialVerifierStore
    grantRepository: PeerGrantRepository
    challengeStore: ReconnectChallengeStore
    auditSink?: PeerAuditSink
    broadcaster?: PeerRevocationBroadcaster
    now?: () => number
  }) {
    this.verifierStore = options.verifierStore
    this.grantRepository = options.grantRepository
    this.challengeStore = options.challengeStore
    this.auditSink = options.auditSink ?? new NoopPeerAuditSink()
    this.broadcaster = options.broadcaster ?? new NoopPeerRevocationBroadcaster()
    this.now = options.now ?? Date.now
  }

  async revoke(selector: PeerRelationshipSelector, reasonCode = 'peer_authority_revoked', revokedAtMs = this.now()): Promise<PeerRevocationEvent> {
    const verifier = await this.verifierStore.revokeVerifier(selector, revokedAtMs)
    const grants = await this.grantRepository.revokeGrants(selector, revokedAtMs)
    await this.challengeStore.rejectChallenges(selector, revokedAtMs)
    const event: PeerRevocationEvent = {
      type: 'peer_authority_revoked_v1',
      selector: cloneSelector(selector),
      revokedGrantIds: grants.map((grant) => grant.grantId),
      revokedAtMs,
      reasonCode,
      redacted: true
    }
    if (verifier?.credentialRevision !== undefined) Object.assign(event, { credentialRevision: verifier.credentialRevision })
    await this.auditSink.record(auditRecord('grant.revoke', selector, 'revoked', revokedAtMs, reasonCode))
    await this.broadcaster.publish(event)
    return event
  }
}

export async function createReconnectProofForBearer(rawBearerToken: string, selector: PeerRelationshipSelector, transport: ReconnectTransportAttestation, challenge: string): Promise<string> {
  return await computeReconnectProofHex(rawBearerToken, {
    tokenId: selector.tokenId,
    challenge,
    channelBinding: transport.channelBinding,
    claimantPeerId: selector.claimantPeerId,
    verifierPeerId: selector.verifierPeerId,
    roomName: selector.roomName
  })
}

function validateSelector(selector: PeerRelationshipSelector): void {
  assertNonEmpty('tokenId', selector.tokenId, 128)
  assertNonEmpty('claimantPeerId', selector.claimantPeerId)
  assertNonEmpty('verifierPeerId', selector.verifierPeerId)
  assertNonEmpty('roomName', selector.roomName, 512)
}

function validateTransport(transport: ReconnectTransportAttestation): void {
  if (!HEX64_RE.test(transport.channelBinding)) throw new Error('Invalid channel binding')
  assertNonEmpty('claimantSignalingPeerId', transport.claimantSignalingPeerId)
  assertNonEmpty('verifierSignalingPeerId', transport.verifierSignalingPeerId)
}

function validateVerifier(verifier: LocalPeerCredentialVerifierV1): void {
  if (verifier.version !== 1) throw new Error('unsupported verifier version')
  validateSelector(verifier)
  if (!HEX64_RE.test(verifier.tokenHashHex)) throw new Error('Invalid verifier token hash')
  assertTimestamp('createdAtMs', verifier.createdAtMs)
  assertRevision('credentialRevision', verifier.credentialRevision)
}

function validateGrant(grant: LocalPeerGrantV1): void {
  if (grant.version !== 1) throw new Error('unsupported grant version')
  validateSelector(grant)
  assertNonEmpty('grantId', grant.grantId, 128)
  if (!Array.isArray(grant.allowedMethodIds)) throw new Error('grant allowed methods are required')
  assertTimestamp('createdAtMs', grant.createdAtMs)
  assertRevision('grantRevision', grant.grantRevision)
}

function assertNonEmpty(name: string, value: string, maxLength = 256): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${name}`)
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`)
}

function assertRevision(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`)
}

function selectorKey(selector: PeerRelationshipSelector): string {
  return JSON.stringify([selector.tokenId, selector.claimantPeerId, selector.verifierPeerId, selector.roomName])
}

function selectorEquals(left: PeerRelationshipSelector, right: PeerRelationshipSelector): boolean {
  return left.tokenId === right.tokenId &&
    left.claimantPeerId === right.claimantPeerId &&
    left.verifierPeerId === right.verifierPeerId &&
    left.roomName === right.roomName
}

function transportEquals(left: ReconnectTransportAttestation, right: ReconnectTransportAttestation): boolean {
  return left.channelBinding === right.channelBinding &&
    left.claimantSignalingPeerId === right.claimantSignalingPeerId &&
    left.verifierSignalingPeerId === right.verifierSignalingPeerId
}

function compareGrants(left: LocalPeerGrantV1, right: LocalPeerGrantV1): number {
  return right.grantRevision - left.grantRevision ||
    right.createdAtMs - left.createdAtMs ||
    left.grantId.localeCompare(right.grantId)
}

function grantCoverageFailure(grant: LocalPeerGrantV1, request: PeerGrantResolutionRequest): PeerAuthorityDecisionReason | undefined {
  if (request.methodId !== undefined && !grant.allowedMethodIds.includes(request.methodId)) return 'method_not_granted'
  if (request.toolContractId !== undefined && !grant.allowedToolContractIds.includes(request.toolContractId)) return 'tool_not_granted'
  if (request.capabilityPackId !== undefined && !grant.capabilityPackIds.includes(request.capabilityPackId)) return 'capability_not_granted'
  if (request.resourceScope !== undefined && !grant.resourceScopes.includes(request.resourceScope)) return 'resource_not_granted'
  return undefined
}

function auditRecord(
  action: LocalPeerAuditAction,
  selector: PeerRelationshipSelector,
  decision: LocalPeerAuditRecord['decision'],
  createdAtMs: number,
  reasonCode?: string,
  methodId?: string,
  connectionEpoch?: string
): LocalPeerAuditRecord {
  const record: LocalPeerAuditRecord = {
    action,
    selector: cloneSelector(selector),
    decision,
    createdAtMs,
    redacted: true,
    redactedFields: ['bearerToken', 'tokenHashHex', 'proofHex']
  }
  if (reasonCode !== undefined) Object.assign(record, { reasonCode })
  if (methodId !== undefined) Object.assign(record, { methodId })
  if (connectionEpoch !== undefined) Object.assign(record, { connectionEpoch })
  return record
}

function cloneSelector(selector: PeerRelationshipSelector): PeerRelationshipSelector {
  return {
    tokenId: selector.tokenId,
    claimantPeerId: selector.claimantPeerId,
    verifierPeerId: selector.verifierPeerId,
    roomName: selector.roomName
  }
}

function cloneTransport(transport: ReconnectTransportAttestation): ReconnectTransportAttestation {
  return {
    channelBinding: transport.channelBinding,
    claimantSignalingPeerId: transport.claimantSignalingPeerId,
    verifierSignalingPeerId: transport.verifierSignalingPeerId
  }
}

function cloneVerifier(verifier: LocalPeerCredentialVerifierV1): LocalPeerCredentialVerifierV1 {
  return { ...verifier }
}

function cloneGrant(grant: LocalPeerGrantV1): LocalPeerGrantV1 {
  return {
    ...grant,
    allowedMethodIds: [...grant.allowedMethodIds],
    allowedToolContractIds: [...grant.allowedToolContractIds],
    capabilityPackIds: [...grant.capabilityPackIds],
    resourceScopes: [...grant.resourceScopes]
  }
}

function cloneChallenge(record: ReconnectChallengeRecord): ReconnectChallengeRecord {
  return {
    ...record,
    selector: cloneSelector(record.selector),
    transport: cloneTransport(record.transport)
  }
}

function cloneRevocationEvent(event: PeerRevocationEvent): PeerRevocationEvent {
  return {
    ...event,
    selector: cloneSelector(event.selector),
    revokedGrantIds: [...event.revokedGrantIds]
  }
}
