const HEX64_RE = /^[0-9a-f]{64}$/u

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
    await this.auditSink.record(auditRecord('credential.verify', request.selector, 'rejected', request.nowMs, 'proof_verification_unavailable'))
    return { ok: false, reasonCode: 'proof_verification_unavailable' }
  }

  async resolveGrant(context: AuthenticatedPeerContext, request: Omit<PeerGrantResolutionRequest, 'selector' | 'nowMs'> & { nowMs: number }): Promise<PeerAuthorityDecision> {
    const decision = await this.grantRepository.resolveGrant({
      ...request,
      selector: context.selector,
      nowMs: request.nowMs
    })
    await this.auditSink.record(auditRecord('grant.check', context.selector, decision.allowed ? 'accepted' : 'rejected', request.nowMs, decision.reasonCode, request.methodId))
    return decision
  }

  async getRecipientManifest(context: AuthenticatedPeerContext, nowMs: number): Promise<unknown> {
    const grants = await this.grantRepository.listRecipientGrants(context.selector, nowMs)
    if (grants.length === 0 || this.manifestProvider === undefined) {
      return { shared_services: [], grants: [] }
    }
    return await this.manifestProvider(context, grants)
  }
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

function assertNonEmpty(name: string, value: string, maxLength = 256): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${name}`)
  }
}

function auditRecord(
  action: LocalPeerAuditAction,
  selector: PeerRelationshipSelector,
  decision: LocalPeerAuditRecord['decision'],
  createdAtMs: number,
  reasonCode?: string,
  methodId?: string
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
