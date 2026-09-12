/**
 * The vocabulary of the mesh peer authority, as types.
 *
 * Workstream R2 moved the authority *implementation* into Rust
 * (`rust/crates/aurora-mesh-authority`). What survives in TypeScript is this
 * file: the shapes that cross the seam, plus the ports the SDK asks through.
 * Two authorities is drift in the one layer where drift is a vulnerability, so
 * there is deliberately no class here that decides anything.
 *
 * The wire shape is the Rust serde shape — camelCase, `undefined` for absent —
 * so a value that crossed Tauri IPC or a `wasm-bindgen` call is already one of
 * these without translation.
 */

/** The four-part key a peer relationship is stored under. */
export interface PeerRelationshipSelector {
  readonly tokenId: string
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
}

/** A peer relationship without its credential identity. */
export interface PeerRelationshipIdentity {
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
}

/** What a reconnect proof is bound to on the wire. */
export interface ReconnectTransportAttestation {
  readonly channelBinding: string
  readonly claimantSignalingPeerId: string
  readonly verifierSignalingPeerId: string
}

/**
 * The result of a successful reconnect proof: who this peer is, proven.
 *
 * Carries no session handle. Per the R0 boundary note (section 1) the authority
 * is keyed by peer identity and never learns which connection a peer arrived
 * on, which is what makes "authority contexts never cross peers" checkable in
 * one place.
 */
export interface AuthenticatedPeerContext {
  readonly selector: PeerRelationshipSelector
  readonly transport: ReconnectTransportAttestation
  readonly connectionEpoch?: string
  readonly credentialRevision: number
  readonly authenticatedAtMs: number
}

/** The stored half of a bearer credential. */
export interface LocalPeerCredentialVerifierV1 extends PeerRelationshipSelector {
  readonly version: 1
  readonly tokenHashHex: string
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly credentialRevision: number
}

/** One durable authorization grant. */
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

/** What a person approved at pairing time. */
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

/** Why the authority said no. Closed vocabulary; mirrors the Rust enum. */
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

/** The answer to "does a grant cover this?". */
export interface PeerAuthorityDecision {
  readonly allowed: boolean
  readonly grant?: LocalPeerGrantV1
  readonly reasonCode?: PeerAuthorityDecisionReason
}

/** The four coverage dimensions a caller may ask a grant about. */
export interface GrantDimensions {
  readonly methodId?: string
  readonly toolContractId?: string
  readonly capabilityPackId?: string
  readonly resourceScope?: string
}

/** What a caller wants a grant to cover, at an instant. */
export interface PeerGrantResolutionRequest extends GrantDimensions {
  readonly selector: PeerRelationshipSelector
  readonly nowMs: number
}

/** Audit actions the authority records. */
export type LocalPeerAuditAction =
  | 'credential.issue'
  | 'credential.verify'
  | 'grant.check'
  | 'grant.revoke'
  | 'manifest.snapshot'
  | 'challenge.issue'
  | 'challenge.consume'
  | 'challenge.reject'
  | 'revocation.broadcast'

/** One redacted audit row. */
export interface LocalPeerAuditRecord {
  readonly action: LocalPeerAuditAction
  readonly selector: PeerRelationshipSelector | PeerRelationshipIdentity
  readonly decision: 'accepted' | 'rejected' | 'revoked' | 'issued'
  readonly reasonCode?: string
  readonly methodId?: string
  readonly toolContractId?: string
  readonly capabilityPackId?: string
  readonly resourceScope?: string
  readonly correlationId?: string
  readonly connectionEpoch?: string
  readonly authorityState?: string
  readonly createdAtMs: number
  readonly redacted: true
  readonly redactedFields: readonly string[]
}

/** Broadcast when a relationship loses its authority. */
export interface PeerRevocationEvent {
  readonly type: 'peer_authority_revoked_v1'
  readonly selector: PeerRelationshipSelector
  readonly revokedGrantIds: readonly string[]
  readonly credentialRevision?: number
  readonly revokedAtMs: number
  readonly reasonCode: string
  readonly redacted: true
}

/** The outcome of presenting a reconnect challenge. */
export type ReconnectChallengeConsumeStatus =
  | 'accepted'
  | 'replay'
  | 'not_found'
  | 'expired'
  | 'selector_mismatch'
  | 'transport_mismatch'
  | 'rejected'

/** One issued reconnect challenge. */
export interface ReconnectChallengeRecord {
  readonly challenge: string
  readonly identity: PeerRelationshipIdentity
  readonly transport: ReconnectTransportAttestation
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly consumedAtMs?: number
  readonly rejectedAtMs?: number
}

/** Status plus, where useful, the record it applies to. */
export interface ReconnectChallengeConsumeResult {
  readonly status: ReconnectChallengeConsumeStatus
  readonly challenge?: ReconnectChallengeRecord
}

/** Request to mint a reconnect challenge. */
export interface IssueReconnectChallengeRequest {
  readonly identity: PeerRelationshipIdentity
  readonly transport: ReconnectTransportAttestation
  readonly nowMs: number
}

/** Request to check a reconnect proof. */
export interface VerifyReconnectProofRequest {
  readonly proofHex: string
  readonly selector: PeerRelationshipSelector
  readonly transport: ReconnectTransportAttestation
  readonly challenge: string
  readonly nowMs: number
}

/** Outcome of a reconnect proof check. */
export interface VerifyReconnectProofResult {
  readonly ok: boolean
  readonly context?: AuthenticatedPeerContext
  readonly reasonCode?: string
}

/** Options for one pairing issue. */
export interface PeerPairingIssueOptions {
  readonly expiresAtMs?: number
  /** Local feature identifiers selected during this pairing approval. */
  readonly featureIds?: readonly string[]
}

/** Result of minting a bearer credential. */
export interface IssuedPeerBearerCredential {
  readonly tokenId: string
  readonly bearerToken: string
  readonly verifier: LocalPeerCredentialVerifierV1
  /** Product permission labels derived from the features shared at pairing. */
  readonly grantedPermissions?: readonly string[]
}

/** What a person chose to share. */
export interface PeerGrantSelection {
  readonly allowedMethodIds?: readonly string[]
  readonly allowedToolContractIds?: readonly string[]
  readonly capabilityPackIds?: readonly string[]
  readonly resourceScopes?: readonly string[]
  readonly expiresAtMs?: number
}

/** The redacted view of a grant the sharing settings render. */
export interface PeerGrantSummary {
  readonly grantId: string
  readonly claimantPeerId: string
  readonly verifierPeerId: string
  readonly roomName: string
  readonly allowedMethodIds: readonly string[]
  readonly allowedToolContractIds: readonly string[]
  readonly capabilityPackIds: readonly string[]
  readonly resourceScopes: readonly string[]
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly revokedAtMs?: number
  readonly grantRevision: number
  readonly sharingState: 'active' | 'expired' | 'revoked'
  readonly secretFieldsRedacted: true
  readonly redactedFields: readonly string[]
}

/** Why a sharing change was refused. */
export type PeerGrantManagementErrorCode =
  | 'invalid_selector'
  | 'invalid_selection'
  | 'invalid_expiry'
  | 'repository_unavailable'
  | 'secure_random_unavailable'

// ---------------------------------------------------------------------------
// Storage ports
// ---------------------------------------------------------------------------
//
// These survive because they describe *storage*, not authority. The durable
// adapters in `local-data-authority-adapters.ts` keep implementing them, and
// the composition root reads through them to hydrate the Rust authority.

/** Persistence for the verifier half of inbound credentials. */
export interface InboundCredentialVerifierStore {
  getVerifier(
    selector: PeerRelationshipSelector,
    nowMs?: number
  ): Promise<LocalPeerCredentialVerifierV1 | undefined>
  upsertVerifier(verifier: LocalPeerCredentialVerifierV1): Promise<void>
  revokeVerifier(
    selector: PeerRelationshipSelector,
    revokedAtMs: number
  ): Promise<LocalPeerCredentialVerifierV1 | undefined>
  deleteVerifier(selector: PeerRelationshipSelector): Promise<void>
}

/** Persistence for grants. */
export interface PeerGrantRepository {
  upsertGrant(grant: LocalPeerGrantV1): Promise<void>
  resolveGrant(request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision>
  listRecipientGrants(
    selector: PeerRelationshipSelector,
    nowMs: number
  ): Promise<readonly LocalPeerGrantV1[]>
  revokeGrants(
    selector: PeerRelationshipSelector,
    revokedAtMs: number
  ): Promise<readonly LocalPeerGrantV1[]>
}

/** Where audit rows go. */
export interface PeerAuditSink {
  record(record: LocalPeerAuditRecord): Promise<void>
}

/** Where revocations go. */
export interface PeerRevocationBroadcaster {
  publish(event: PeerRevocationEvent): Promise<void>
  subscribe(listener: (event: PeerRevocationEvent) => void): () => void
}

/** Withdraws a relationship's authority. */
export interface PeerRevocationController {
  revoke(
    selector: PeerRelationshipSelector,
    reasonCode?: string,
    revokedAtMs?: number
  ): Promise<PeerRevocationEvent>
}

// ---------------------------------------------------------------------------
// Authority ports
// ---------------------------------------------------------------------------
//
// What the SDK asks *through*. Every one of these is answered by the Rust
// authority — over Tauri IPC on a native shell, over WebAssembly on the web.
// Nothing in TypeScript implements them by deciding.

/** Reconnect proof and grant evaluation. */
export interface PeerAuthorityResolverPort {
  issueReconnectChallenge(
    request: IssueReconnectChallengeRequest
  ): Promise<ReconnectChallengeRecord>
  verifyReconnectProof(request: VerifyReconnectProofRequest): Promise<VerifyReconnectProofResult>
  resolveGrant(
    context: AuthenticatedPeerContext,
    request: GrantDimensions & { readonly nowMs: number }
  ): Promise<PeerAuthorityDecision>
}

/** Minting and un-minting bearer credentials at pairing time. */
export interface PeerPairingIssuerPort {
  issue(
    selector: PeerRelationshipSelector,
    options?: PeerPairingIssueOptions
  ): Promise<IssuedPeerBearerCredential>
  rollback(selector: PeerRelationshipSelector): Promise<void>
}

/** Reading and writing what a relationship shares. */
export interface PeerGrantManagerPort {
  listActiveGrants(selector: PeerRelationshipSelector): Promise<readonly PeerGrantSummary[]>
  replaceGrant(
    selector: PeerRelationshipSelector,
    selection: PeerGrantSelection
  ): Promise<PeerGrantSummary>
  revokeSharing(selector: PeerRelationshipSelector): Promise<readonly PeerGrantSummary[]>
}
