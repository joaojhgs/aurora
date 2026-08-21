//! Port of `packages/aurora-sdk/src/peer-host/authority.ts`.
//!
//! Selectors, credential verifiers, grants, the reconnect challenge replay
//! guard, the audit record shape, revocation, and the resolver that ties them
//! together. Transport state stays out: per the R0 boundary note the authority
//! is keyed by peer identity and never learns which connection a peer arrived
//! on.
//!
//! ## Where TypeScript was loose
//!
//! * `LocalPeerGrantV1` exists twice in TypeScript — once in `types.ts` with
//!   only `tokenId` + `claimantPeerId`, once in `authority.ts` extending the
//!   full [`PeerRelationshipSelector`]. Rust keeps one type, the `authority.ts`
//!   superset, because every consumer of the narrow shape reads only fields the
//!   superset also carries.
//! * Random sources are injected rather than reaching for a global. The
//!   TypeScript default is `globalThis.crypto`, which is itself a platform
//!   injection; Rust makes it explicit so the same core runs under WASM, Tauri
//!   and tests.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::crypto::{
    bytes_to_hex, compute_reconnect_proof_hex, sha256, verify_reconnect_proof_hex,
    ReconnectProofInput,
};

/// Reconnect challenge lifetime. The TypeScript store rejects any other value.
pub const DEFAULT_CHALLENGE_TTL_MS: i64 = 20_000;
const MAX_CHALLENGE_COLLISION_RETRIES: u32 = 8;
const MAX_TOKEN_ID_LENGTH: usize = 128;
const MAX_GRANT_ID_LENGTH: usize = 128;
const MAX_ROOM_NAME_LENGTH: usize = 512;
const MAX_PEER_ID_LENGTH: usize = 256;

/// Fields an audit record always redacts.
pub const AUDIT_REDACTED_FIELDS: [&str; 3] = ["bearerToken", "tokenHashHex", "proofHex"];

/// Failure raised by the validators the TypeScript throws `Error` for.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AuthorityError {
    /// A bounded identifier was empty, over-long, or the wrong shape.
    #[error("Invalid {0}")]
    Invalid(String),
    /// A versioned record carried a version this build does not implement.
    #[error("unsupported {0} version")]
    UnsupportedVersion(&'static str),
    /// `grant.allowedMethodIds` was absent.
    #[error("grant allowed methods are required")]
    GrantAllowedMethodsRequired,
    /// The reconnect challenge store is a deny-all stub.
    #[error("Reconnect challenge store is unavailable")]
    ChallengeStoreUnavailable,
    /// The platform cryptographic random source could not provide bytes.
    #[error("Cryptographic random source is unavailable")]
    RandomSourceUnavailable,
    /// The random source produced a colliding challenge too many times.
    #[error("Reconnect challenge collision retry limit exceeded")]
    ChallengeCollisionRetryLimit,
    /// The random source produced bytes that are not a 64-character hex string.
    #[error("Invalid reconnect challenge bytes")]
    InvalidChallengeBytes,
    /// The reconnect challenge TTL was configured away from 20 seconds.
    #[error("Reconnect challenge TTL must be exactly 20 seconds")]
    ChallengeTtlNotTwentySeconds,
    /// A backing store could not answer.
    #[error("{0}")]
    Store(String),
}

/// Convenience alias for authority fallibility.
pub type AuthorityResult<T> = Result<T, AuthorityError>;

/// The four-part key a peer relationship is stored under.
#[derive(Clone, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
pub struct PeerRelationshipSelector {
    /// Opaque credential identity.
    #[serde(rename = "tokenId")]
    pub token_id: String,
    /// Stable peer id presenting the credential.
    #[serde(rename = "claimantPeerId")]
    pub claimant_peer_id: String,
    /// Stable peer id holding the verifier.
    #[serde(rename = "verifierPeerId")]
    pub verifier_peer_id: String,
    /// Room the relationship lives in.
    #[serde(rename = "roomName")]
    pub room_name: String,
}

impl PeerRelationshipSelector {
    /// Drop the token id, leaving the relationship identity.
    #[must_use]
    pub fn identity(&self) -> PeerRelationshipIdentity {
        PeerRelationshipIdentity {
            claimant_peer_id: self.claimant_peer_id.clone(),
            verifier_peer_id: self.verifier_peer_id.clone(),
            room_name: self.room_name.clone(),
        }
    }
}

/// A peer relationship without its credential identity.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
pub struct PeerRelationshipIdentity {
    /// Stable peer id presenting the credential.
    #[serde(rename = "claimantPeerId")]
    pub claimant_peer_id: String,
    /// Stable peer id holding the verifier.
    #[serde(rename = "verifierPeerId")]
    pub verifier_peer_id: String,
    /// Room the relationship lives in.
    #[serde(rename = "roomName")]
    pub room_name: String,
}

/// What the reconnect proof is bound to on the wire.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ReconnectTransportAttestation {
    /// Hex channel binding derived from the negotiated transport.
    #[serde(rename = "channelBinding")]
    pub channel_binding: String,
    /// Signaling peer id the claimant used.
    #[serde(rename = "claimantSignalingPeerId")]
    pub claimant_signaling_peer_id: String,
    /// Signaling peer id the verifier used.
    #[serde(rename = "verifierSignalingPeerId")]
    pub verifier_signaling_peer_id: String,
}

/// The result of a successful reconnect proof: who this peer is, proven.
///
/// This is the only value that crosses out of the authority into the peer host,
/// and it carries no session handle — see the R0 boundary note, section 1.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct AuthenticatedPeerContext {
    /// The proven relationship.
    pub selector: PeerRelationshipSelector,
    /// The transport the proof was bound to.
    pub transport: ReconnectTransportAttestation,
    /// Opaque per-connection epoch used only for audit correlation.
    #[serde(rename = "connectionEpoch", skip_serializing_if = "Option::is_none")]
    pub connection_epoch: Option<String>,
    /// Revision of the verifier that accepted the proof.
    #[serde(rename = "credentialRevision")]
    pub credential_revision: i64,
    /// When the proof was accepted.
    #[serde(rename = "authenticatedAtMs")]
    pub authenticated_at_ms: i64,
}

/// The stored half of a bearer credential.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct LocalPeerCredentialVerifierV1 {
    /// Always `1`.
    pub version: u8,
    /// Opaque credential identity.
    #[serde(rename = "tokenId")]
    pub token_id: String,
    /// Stable peer id presenting the credential.
    #[serde(rename = "claimantPeerId")]
    pub claimant_peer_id: String,
    /// Stable peer id holding the verifier.
    #[serde(rename = "verifierPeerId")]
    pub verifier_peer_id: String,
    /// Room the relationship lives in.
    #[serde(rename = "roomName")]
    pub room_name: String,
    /// Hex SHA-256 of the raw bearer token.
    #[serde(rename = "tokenHashHex")]
    pub token_hash_hex: String,
    /// When the credential was issued.
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    /// Optional expiry.
    #[serde(rename = "expiresAtMs", skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    /// Optional revocation instant.
    #[serde(rename = "revokedAtMs", skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<i64>,
    /// Monotonic revision, bumped on revoke.
    #[serde(rename = "credentialRevision")]
    pub credential_revision: i64,
}

impl LocalPeerCredentialVerifierV1 {
    /// The relationship this verifier is stored under.
    #[must_use]
    pub fn selector(&self) -> PeerRelationshipSelector {
        PeerRelationshipSelector {
            token_id: self.token_id.clone(),
            claimant_peer_id: self.claimant_peer_id.clone(),
            verifier_peer_id: self.verifier_peer_id.clone(),
            room_name: self.room_name.clone(),
        }
    }
}

/// One durable authorization grant.
///
/// The single Rust shape for both TypeScript declarations of the name; see the
/// module documentation.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct LocalPeerGrantV1 {
    /// Always `1`.
    pub version: u8,
    /// Stable grant identity.
    #[serde(rename = "grantId")]
    pub grant_id: String,
    /// Opaque credential identity this grant is bound to.
    #[serde(rename = "tokenId")]
    pub token_id: String,
    /// Stable peer id the grant is issued to.
    #[serde(rename = "claimantPeerId")]
    pub claimant_peer_id: String,
    /// Stable peer id that issued the grant.
    #[serde(rename = "verifierPeerId")]
    pub verifier_peer_id: String,
    /// Room the grant lives in.
    #[serde(rename = "roomName")]
    pub room_name: String,
    /// Methods the claimant may call.
    #[serde(rename = "allowedMethodIds")]
    pub allowed_method_ids: Vec<String>,
    /// Tool contracts the claimant may reach.
    #[serde(rename = "allowedToolContractIds", default)]
    pub allowed_tool_contract_ids: Vec<String>,
    /// Capability packs the claimant may use.
    #[serde(rename = "capabilityPackIds", default)]
    pub capability_pack_ids: Vec<String>,
    /// Resource scopes the claimant may touch.
    #[serde(rename = "resourceScopes", default)]
    pub resource_scopes: Vec<String>,
    /// When the grant was created.
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    /// Optional expiry.
    #[serde(rename = "expiresAtMs", skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    /// Optional revocation instant.
    #[serde(rename = "revokedAtMs", skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<i64>,
    /// Monotonic revision, bumped on revoke and on replace.
    #[serde(rename = "grantRevision")]
    pub grant_revision: i64,
}

impl LocalPeerGrantV1 {
    /// The relationship this grant is stored under.
    #[must_use]
    pub fn selector(&self) -> PeerRelationshipSelector {
        PeerRelationshipSelector {
            token_id: self.token_id.clone(),
            claimant_peer_id: self.claimant_peer_id.clone(),
            verifier_peer_id: self.verifier_peer_id.clone(),
            room_name: self.room_name.clone(),
        }
    }
}

/// Why the authority said no.
///
/// The vocabulary is closed and matches `PeerAuthorityDecisionReason`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerAuthorityDecisionReason {
    /// No verifier is stored for this relationship.
    CredentialNotFound,
    /// The verifier has expired.
    CredentialExpired,
    /// The verifier has been revoked.
    CredentialRevoked,
    /// No grant covers this relationship.
    GrantNotFound,
    /// The grant store could not be read.
    GrantStoreUnreadable,
    /// Every candidate grant has expired.
    GrantExpired,
    /// Every candidate grant has been revoked.
    GrantRevoked,
    /// A grant exists but does not carry the requested method.
    MethodNotGranted,
    /// A grant exists but does not carry the requested tool contract.
    ToolNotGranted,
    /// A grant exists but does not carry the requested capability pack.
    CapabilityNotGranted,
    /// A grant exists but does not carry the requested resource scope.
    ResourceNotGranted,
}

impl PeerAuthorityDecisionReason {
    /// Wire spelling, identical to the TypeScript string union member.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CredentialNotFound => "credential_not_found",
            Self::CredentialExpired => "credential_expired",
            Self::CredentialRevoked => "credential_revoked",
            Self::GrantNotFound => "grant_not_found",
            Self::GrantStoreUnreadable => "grant_store_unreadable",
            Self::GrantExpired => "grant_expired",
            Self::GrantRevoked => "grant_revoked",
            Self::MethodNotGranted => "method_not_granted",
            Self::ToolNotGranted => "tool_not_granted",
            Self::CapabilityNotGranted => "capability_not_granted",
            Self::ResourceNotGranted => "resource_not_granted",
        }
    }
}

/// The answer to "does a grant cover this?".
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerAuthorityDecision {
    /// Whether the request is covered.
    pub allowed: bool,
    /// The grant that covered it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant: Option<LocalPeerGrantV1>,
    /// Why not, when `allowed` is false.
    #[serde(rename = "reasonCode", skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<PeerAuthorityDecisionReason>,
}

impl PeerAuthorityDecision {
    /// A denial carrying only a reason.
    #[must_use]
    pub fn denied(reason: PeerAuthorityDecisionReason) -> Self {
        Self {
            allowed: false,
            grant: None,
            reason_code: Some(reason),
        }
    }

    /// An approval carrying the covering grant.
    #[must_use]
    pub fn allowed(grant: LocalPeerGrantV1) -> Self {
        Self {
            allowed: true,
            grant: Some(grant),
            reason_code: None,
        }
    }
}

/// What a caller wants a grant to cover.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerGrantResolutionRequest {
    /// The relationship asking.
    pub selector: PeerRelationshipSelector,
    /// Method to be called, when the caller is checking a method.
    #[serde(rename = "methodId", default, skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
    /// Tool contract to be reached.
    #[serde(
        rename = "toolContractId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_contract_id: Option<String>,
    /// Capability pack to be used.
    #[serde(
        rename = "capabilityPackId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub capability_pack_id: Option<String>,
    /// Resource scope to be touched.
    #[serde(
        rename = "resourceScope",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub resource_scope: Option<String>,
    /// Evaluation instant.
    #[serde(rename = "nowMs")]
    pub now_ms: i64,
}

/// Audit actions the authority records.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalPeerAuditAction {
    /// A bearer credential was minted.
    CredentialIssue,
    /// A reconnect proof was checked.
    CredentialVerify,
    /// A grant was evaluated.
    GrantCheck,
    /// A relationship was revoked.
    GrantRevoke,
    /// The manifest authority was snapshotted.
    ManifestSnapshot,
    /// A reconnect challenge was issued.
    ChallengeIssue,
    /// A reconnect challenge was consumed.
    ChallengeConsume,
    /// Reconnect challenges were invalidated.
    ChallengeReject,
    /// A revocation was published.
    RevocationBroadcast,
}

impl LocalPeerAuditAction {
    /// Wire spelling, matching the TypeScript dotted literals.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CredentialIssue => "credential.issue",
            Self::CredentialVerify => "credential.verify",
            Self::GrantCheck => "grant.check",
            Self::GrantRevoke => "grant.revoke",
            Self::ManifestSnapshot => "manifest.snapshot",
            Self::ChallengeIssue => "challenge.issue",
            Self::ChallengeConsume => "challenge.consume",
            Self::ChallengeReject => "challenge.reject",
            Self::RevocationBroadcast => "revocation.broadcast",
        }
    }
}

/// The audit outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalPeerAuditDecision {
    /// The request was allowed.
    Accepted,
    /// The request was denied.
    Rejected,
    /// Authority was withdrawn.
    Revoked,
    /// A credential or challenge was minted.
    Issued,
}

/// Either half of an audited relationship key.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AuditSubject {
    /// A full selector, when the token id is known.
    Selector(PeerRelationshipSelector),
    /// A bare identity, when it is not.
    Identity(PeerRelationshipIdentity),
}

impl AuditSubject {
    fn validate(&self) -> AuthorityResult<()> {
        match self {
            Self::Selector(selector) => validate_selector(selector),
            Self::Identity(identity) => validate_identity(identity),
        }
    }
}

/// One redacted audit row.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct LocalPeerAuditRecord {
    /// What happened.
    pub action: LocalPeerAuditAction,
    /// Who it happened to.
    pub selector: AuditSubject,
    /// The outcome.
    pub decision: LocalPeerAuditDecision,
    /// The denial reason, when there was one.
    #[serde(rename = "reasonCode", skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// The method under evaluation, when there was one.
    #[serde(rename = "methodId", skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
    /// The tool contract under evaluation, when there was one.
    #[serde(rename = "toolContractId", skip_serializing_if = "Option::is_none")]
    pub tool_contract_id: Option<String>,
    /// The capability pack under evaluation, when there was one.
    #[serde(rename = "capabilityPackId", skip_serializing_if = "Option::is_none")]
    pub capability_pack_id: Option<String>,
    /// The resource scope under evaluation, when there was one.
    #[serde(rename = "resourceScope", skip_serializing_if = "Option::is_none")]
    pub resource_scope: Option<String>,
    /// The correlation id the caller supplied.
    #[serde(rename = "correlationId", skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    /// Per-connection epoch, for audit correlation only.
    #[serde(rename = "connectionEpoch", skip_serializing_if = "Option::is_none")]
    pub connection_epoch: Option<String>,
    /// Authority state at snapshot time.
    #[serde(rename = "authorityState", skip_serializing_if = "Option::is_none")]
    pub authority_state: Option<String>,
    /// When the row was written.
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    /// Always true; the row never carries secret material.
    pub redacted: bool,
    /// Names of the fields that were withheld.
    #[serde(rename = "redactedFields")]
    pub redacted_fields: Vec<String>,
}

/// Broadcast when a relationship loses its authority.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerRevocationEvent {
    /// Always `peer_authority_revoked_v1`.
    #[serde(rename = "type")]
    pub event_type: String,
    /// The relationship that was revoked.
    pub selector: PeerRelationshipSelector,
    /// Every grant that was revoked with it.
    #[serde(rename = "revokedGrantIds")]
    pub revoked_grant_ids: Vec<String>,
    /// The revision the verifier moved to, when there was a verifier.
    #[serde(rename = "credentialRevision", skip_serializing_if = "Option::is_none")]
    pub credential_revision: Option<i64>,
    /// When the revocation happened.
    #[serde(rename = "revokedAtMs")]
    pub revoked_at_ms: i64,
    /// Machine-readable reason.
    #[serde(rename = "reasonCode")]
    pub reason_code: String,
    /// Always true.
    pub redacted: bool,
}

/// A source of cryptographically strong bytes.
///
/// Injected rather than assumed. TypeScript reaches for `globalThis.crypto`;
/// Rust makes the platform binding explicit so the same core runs under WASM,
/// Tauri and tests.
pub trait RandomSource: Send + Sync {
    /// Fill `length` bytes.
    fn random_bytes(&self, length: usize) -> AuthorityResult<Vec<u8>>;
}

impl<F> RandomSource for F
where
    F: Fn(usize) -> Vec<u8> + Send + Sync,
{
    fn random_bytes(&self, length: usize) -> AuthorityResult<Vec<u8>> {
        Ok(self(length))
    }
}

/// Persistence for the verifier half of inbound credentials.
#[async_trait]
pub trait InboundCredentialVerifierStore: Send {
    /// Read a live verifier, or `None` when absent, expired or revoked.
    async fn get_verifier(
        &self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> AuthorityResult<Option<LocalPeerCredentialVerifierV1>>;
    /// Write a verifier.
    async fn upsert_verifier(
        &mut self,
        verifier: LocalPeerCredentialVerifierV1,
    ) -> AuthorityResult<()>;
    /// Revoke a verifier and return the revoked row.
    async fn revoke_verifier(
        &mut self,
        selector: &PeerRelationshipSelector,
        revoked_at_ms: i64,
    ) -> AuthorityResult<Option<LocalPeerCredentialVerifierV1>>;
    /// Delete a verifier outright.
    async fn delete_verifier(&mut self, selector: &PeerRelationshipSelector)
        -> AuthorityResult<()>;
}

/// Persistence for grants.
#[async_trait]
pub trait PeerGrantRepository: Send {
    /// Write a grant.
    async fn upsert_grant(&mut self, grant: LocalPeerGrantV1) -> AuthorityResult<()>;
    /// Decide whether any live grant covers the request.
    async fn resolve_grant(
        &self,
        request: &PeerGrantResolutionRequest,
    ) -> AuthorityResult<PeerAuthorityDecision>;
    /// List live grants for a relationship, newest revision first.
    async fn list_recipient_grants(
        &self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>>;
    /// Revoke every grant for a relationship and return them.
    async fn revoke_grants(
        &mut self,
        selector: &PeerRelationshipSelector,
        revoked_at_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>>;
}

/// The outcome of presenting a reconnect challenge.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconnectChallengeConsumeStatus {
    /// First and only use, bound to the right peer and transport.
    Accepted,
    /// The challenge had already been consumed.
    Replay,
    /// No such challenge.
    NotFound,
    /// The challenge outlived its 20-second window.
    Expired,
    /// The challenge belongs to a different peer relationship.
    SelectorMismatch,
    /// The challenge was issued against a different transport.
    TransportMismatch,
    /// The challenge was invalidated by a revocation.
    Rejected,
}

impl ReconnectChallengeConsumeStatus {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Replay => "replay",
            Self::NotFound => "not_found",
            Self::Expired => "expired",
            Self::SelectorMismatch => "selector_mismatch",
            Self::TransportMismatch => "transport_mismatch",
            Self::Rejected => "rejected",
        }
    }
}

/// One issued reconnect challenge.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ReconnectChallengeRecord {
    /// 64 hex characters of challenge.
    pub challenge: String,
    /// The relationship it was issued to.
    pub identity: PeerRelationshipIdentity,
    /// The transport it is bound to.
    pub transport: ReconnectTransportAttestation,
    /// When it was issued.
    #[serde(rename = "issuedAtMs")]
    pub issued_at_ms: i64,
    /// When it stops being usable.
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: i64,
    /// When it was consumed — the replay guard.
    #[serde(rename = "consumedAtMs", skip_serializing_if = "Option::is_none")]
    pub consumed_at_ms: Option<i64>,
    /// When it was invalidated by a revocation.
    #[serde(rename = "rejectedAtMs", skip_serializing_if = "Option::is_none")]
    pub rejected_at_ms: Option<i64>,
}

/// Status plus, where useful, the record it applies to.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ReconnectChallengeConsumeResult {
    /// What happened.
    pub status: ReconnectChallengeConsumeStatus,
    /// The record, when one was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge: Option<ReconnectChallengeRecord>,
}

/// The single-use reconnect challenge guard.
#[async_trait]
pub trait ReconnectChallengeStore: Send {
    /// Mint a challenge for a relationship on a transport.
    async fn issue_challenge(
        &mut self,
        identity: &PeerRelationshipIdentity,
        transport: &ReconnectTransportAttestation,
        now_ms: i64,
    ) -> AuthorityResult<ReconnectChallengeRecord>;
    /// Present a challenge exactly once.
    async fn consume_challenge(
        &mut self,
        challenge: &str,
        selector: &PeerRelationshipSelector,
        transport: &ReconnectTransportAttestation,
        now_ms: i64,
    ) -> AuthorityResult<ReconnectChallengeConsumeResult>;
    /// Invalidate every outstanding challenge for a relationship.
    async fn reject_challenges(
        &mut self,
        identity: &PeerRelationshipIdentity,
        rejected_at_ms: i64,
    ) -> AuthorityResult<usize>;
}

/// Where audit rows go.
#[async_trait]
pub trait PeerAuditSink: Send {
    /// Record one row.
    async fn record(&mut self, record: LocalPeerAuditRecord) -> AuthorityResult<()>;
}

/// Where revocations go.
#[async_trait]
pub trait PeerRevocationBroadcaster: Send {
    /// Publish one revocation.
    async fn publish(&mut self, event: PeerRevocationEvent) -> AuthorityResult<()>;
}

// ---------------------------------------------------------------------------
// Deny-all and no-op implementations
// ---------------------------------------------------------------------------

/// A verifier store that never holds anything.
#[derive(Clone, Copy, Debug, Default)]
pub struct DenyAllInboundCredentialVerifierStore;

#[async_trait]
impl InboundCredentialVerifierStore for DenyAllInboundCredentialVerifierStore {
    async fn get_verifier(
        &self,
        _selector: &PeerRelationshipSelector,
        _now_ms: i64,
    ) -> AuthorityResult<Option<LocalPeerCredentialVerifierV1>> {
        Ok(None)
    }
    async fn upsert_verifier(
        &mut self,
        _verifier: LocalPeerCredentialVerifierV1,
    ) -> AuthorityResult<()> {
        Ok(())
    }
    async fn revoke_verifier(
        &mut self,
        _selector: &PeerRelationshipSelector,
        _revoked_at_ms: i64,
    ) -> AuthorityResult<Option<LocalPeerCredentialVerifierV1>> {
        Ok(None)
    }
    async fn delete_verifier(
        &mut self,
        _selector: &PeerRelationshipSelector,
    ) -> AuthorityResult<()> {
        Ok(())
    }
}

/// A grant repository that grants nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct DenyAllPeerGrantRepository;

#[async_trait]
impl PeerGrantRepository for DenyAllPeerGrantRepository {
    async fn upsert_grant(&mut self, _grant: LocalPeerGrantV1) -> AuthorityResult<()> {
        Ok(())
    }
    async fn resolve_grant(
        &self,
        _request: &PeerGrantResolutionRequest,
    ) -> AuthorityResult<PeerAuthorityDecision> {
        Ok(PeerAuthorityDecision::denied(
            PeerAuthorityDecisionReason::GrantNotFound,
        ))
    }
    async fn list_recipient_grants(
        &self,
        _selector: &PeerRelationshipSelector,
        _now_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        Ok(Vec::new())
    }
    async fn revoke_grants(
        &mut self,
        _selector: &PeerRelationshipSelector,
        _revoked_at_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        Ok(Vec::new())
    }
}

/// A challenge store that cannot issue and never recognises a challenge.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopReconnectChallengeStore;

#[async_trait]
impl ReconnectChallengeStore for NoopReconnectChallengeStore {
    async fn issue_challenge(
        &mut self,
        identity: &PeerRelationshipIdentity,
        transport: &ReconnectTransportAttestation,
        _now_ms: i64,
    ) -> AuthorityResult<ReconnectChallengeRecord> {
        validate_identity(identity)?;
        validate_transport(transport)?;
        Err(AuthorityError::ChallengeStoreUnavailable)
    }

    async fn consume_challenge(
        &mut self,
        _challenge: &str,
        _selector: &PeerRelationshipSelector,
        _transport: &ReconnectTransportAttestation,
        _now_ms: i64,
    ) -> AuthorityResult<ReconnectChallengeConsumeResult> {
        Ok(ReconnectChallengeConsumeResult {
            status: ReconnectChallengeConsumeStatus::NotFound,
            challenge: None,
        })
    }

    async fn reject_challenges(
        &mut self,
        _identity: &PeerRelationshipIdentity,
        _rejected_at_ms: i64,
    ) -> AuthorityResult<usize> {
        Ok(0)
    }
}

/// An audit sink that drops every row.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopPeerAuditSink;

#[async_trait]
impl PeerAuditSink for NoopPeerAuditSink {
    async fn record(&mut self, _record: LocalPeerAuditRecord) -> AuthorityResult<()> {
        Ok(())
    }
}

/// A broadcaster that drops every event.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopPeerRevocationBroadcaster;

#[async_trait]
impl PeerRevocationBroadcaster for NoopPeerRevocationBroadcaster {
    async fn publish(&mut self, _event: PeerRevocationEvent) -> AuthorityResult<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

/// In-memory verifier store, keyed by the four-part selector.
#[derive(Clone, Debug, Default)]
pub struct MemoryInboundCredentialVerifierStore {
    verifiers: BTreeMap<PeerRelationshipSelector, LocalPeerCredentialVerifierV1>,
}

impl MemoryInboundCredentialVerifierStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl InboundCredentialVerifierStore for MemoryInboundCredentialVerifierStore {
    async fn get_verifier(
        &self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> AuthorityResult<Option<LocalPeerCredentialVerifierV1>> {
        let Some(verifier) = self.verifiers.get(selector) else {
            return Ok(None);
        };
        if verifier.expires_at_ms.is_some_and(|at| at <= now_ms) {
            return Ok(None);
        }
        if verifier.revoked_at_ms.is_some_and(|at| at <= now_ms) {
            return Ok(None);
        }
        Ok(Some(verifier.clone()))
    }

    async fn upsert_verifier(
        &mut self,
        verifier: LocalPeerCredentialVerifierV1,
    ) -> AuthorityResult<()> {
        validate_verifier(&verifier)?;
        self.verifiers.insert(verifier.selector(), verifier);
        Ok(())
    }

    async fn revoke_verifier(
        &mut self,
        selector: &PeerRelationshipSelector,
        revoked_at_ms: i64,
    ) -> AuthorityResult<Option<LocalPeerCredentialVerifierV1>> {
        let Some(verifier) = self.verifiers.get(selector) else {
            return Ok(None);
        };
        let mut revoked = verifier.clone();
        revoked.revoked_at_ms = Some(revoked_at_ms);
        revoked.credential_revision = verifier.credential_revision + 1;
        self.verifiers.insert(selector.clone(), revoked.clone());
        Ok(Some(revoked))
    }

    async fn delete_verifier(
        &mut self,
        selector: &PeerRelationshipSelector,
    ) -> AuthorityResult<()> {
        self.verifiers.remove(selector);
        Ok(())
    }
}

/// In-memory grant repository, keyed by grant id.
///
/// Every read path sorts by [`compare_grants`] before it inspects anything, so
/// the map's own ordering is not observable.
#[derive(Clone, Debug, Default)]
pub struct MemoryPeerGrantRepository {
    grants: BTreeMap<String, LocalPeerGrantV1>,
}

impl MemoryPeerGrantRepository {
    /// An empty repository.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every grant held for a relationship, revoked and expired rows included.
    ///
    /// `list_recipient_grants` deliberately hides anything that is no longer
    /// live, which is right for a decision and wrong for persistence: a caller
    /// writing these back to durable storage has to record the revocation too,
    /// or a revoked grant returns from the dead on the next hydrate.
    #[must_use]
    pub fn export_grants(&self, selector: &PeerRelationshipSelector) -> Vec<LocalPeerGrantV1> {
        let mut rows: Vec<LocalPeerGrantV1> = self
            .grants
            .values()
            .filter(|grant| selector_equals(&grant.selector(), selector))
            .cloned()
            .collect();
        rows.sort_by(compare_grants_owned);
        rows
    }
}

#[async_trait]
impl PeerGrantRepository for MemoryPeerGrantRepository {
    async fn upsert_grant(&mut self, grant: LocalPeerGrantV1) -> AuthorityResult<()> {
        validate_grant(&grant)?;
        self.grants.insert(grant.grant_id.clone(), grant);
        Ok(())
    }

    async fn resolve_grant(
        &self,
        request: &PeerGrantResolutionRequest,
    ) -> AuthorityResult<PeerAuthorityDecision> {
        let mut candidates: Vec<&LocalPeerGrantV1> = self
            .grants
            .values()
            .filter(|grant| selector_equals(&grant.selector(), &request.selector))
            .collect();
        candidates.sort_by(|left, right| compare_grants(left, right));

        let mut blocked_reason = PeerAuthorityDecisionReason::GrantNotFound;
        for grant in candidates {
            if grant.revoked_at_ms.is_some_and(|at| at <= request.now_ms) {
                blocked_reason = PeerAuthorityDecisionReason::GrantRevoked;
                continue;
            }
            if grant.expires_at_ms.is_some_and(|at| at <= request.now_ms) {
                blocked_reason = PeerAuthorityDecisionReason::GrantExpired;
                continue;
            }
            match grant_coverage_failure(grant, request) {
                None => return Ok(PeerAuthorityDecision::allowed(grant.clone())),
                Some(reason) => blocked_reason = reason,
            }
        }
        Ok(PeerAuthorityDecision::denied(blocked_reason))
    }

    async fn list_recipient_grants(
        &self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        let mut live: Vec<LocalPeerGrantV1> = self
            .grants
            .values()
            .filter(|grant| selector_equals(&grant.selector(), selector))
            .filter(|grant| {
                grant.revoked_at_ms.is_none_or(|at| at > now_ms)
                    && grant.expires_at_ms.is_none_or(|at| at > now_ms)
            })
            .cloned()
            .collect();
        live.sort_by(compare_grants_owned);
        Ok(live)
    }

    async fn revoke_grants(
        &mut self,
        selector: &PeerRelationshipSelector,
        revoked_at_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        let mut revoked = Vec::new();
        for grant in self.grants.values_mut() {
            if !selector_equals(&grant.selector(), selector) {
                continue;
            }
            grant.revoked_at_ms = Some(revoked_at_ms);
            grant.grant_revision += 1;
            revoked.push(grant.clone());
        }
        revoked.sort_by(compare_grants_owned);
        Ok(revoked)
    }
}

/// In-memory reconnect challenge store — the replay guard.
///
/// The TTL is fixed at 20 seconds; the TypeScript constructor throws for any
/// other value and so does [`MemoryReconnectChallengeStore::with_ttl`].
pub struct MemoryReconnectChallengeStore {
    challenges: BTreeMap<String, ReconnectChallengeRecord>,
    random: Box<dyn RandomSource>,
}

impl std::fmt::Debug for MemoryReconnectChallengeStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MemoryReconnectChallengeStore")
            .field("challenges", &self.challenges.len())
            .finish_non_exhaustive()
    }
}

impl MemoryReconnectChallengeStore {
    /// A store using `random` for challenge bytes.
    #[must_use]
    pub fn new(random: Box<dyn RandomSource>) -> Self {
        Self {
            challenges: BTreeMap::new(),
            random,
        }
    }

    /// A store with an explicit TTL, which must be exactly 20 seconds.
    pub fn with_ttl(random: Box<dyn RandomSource>, ttl_ms: i64) -> AuthorityResult<Self> {
        if ttl_ms != DEFAULT_CHALLENGE_TTL_MS {
            return Err(AuthorityError::ChallengeTtlNotTwentySeconds);
        }
        Ok(Self::new(random))
    }

    fn prune(&mut self, now_ms: i64) {
        self.challenges
            .retain(|_, record| record.expires_at_ms > now_ms);
    }
}

#[async_trait]
impl ReconnectChallengeStore for MemoryReconnectChallengeStore {
    async fn issue_challenge(
        &mut self,
        identity: &PeerRelationshipIdentity,
        transport: &ReconnectTransportAttestation,
        now_ms: i64,
    ) -> AuthorityResult<ReconnectChallengeRecord> {
        validate_identity(identity)?;
        validate_transport(transport)?;
        self.prune(now_ms);
        for _ in 0..=MAX_CHALLENGE_COLLISION_RETRIES {
            let challenge = bytes_to_hex(&self.random.random_bytes(32)?);
            if !is_hex64(&challenge) {
                return Err(AuthorityError::InvalidChallengeBytes);
            }
            if self.challenges.contains_key(&challenge) {
                continue;
            }
            let record = ReconnectChallengeRecord {
                challenge: challenge.clone(),
                identity: identity.clone(),
                transport: transport.clone(),
                issued_at_ms: now_ms,
                expires_at_ms: now_ms + DEFAULT_CHALLENGE_TTL_MS,
                consumed_at_ms: None,
                rejected_at_ms: None,
            };
            self.challenges.insert(challenge, record.clone());
            return Ok(record);
        }
        Err(AuthorityError::ChallengeCollisionRetryLimit)
    }

    async fn consume_challenge(
        &mut self,
        challenge: &str,
        selector: &PeerRelationshipSelector,
        transport: &ReconnectTransportAttestation,
        now_ms: i64,
    ) -> AuthorityResult<ReconnectChallengeConsumeResult> {
        let Some(record) = self.challenges.get(challenge).cloned() else {
            return Ok(ReconnectChallengeConsumeResult {
                status: ReconnectChallengeConsumeStatus::NotFound,
                challenge: None,
            });
        };
        if record.expires_at_ms <= now_ms {
            self.challenges.remove(challenge);
            return Ok(ReconnectChallengeConsumeResult {
                status: ReconnectChallengeConsumeStatus::Expired,
                challenge: None,
            });
        }
        if record.rejected_at_ms.is_some() {
            return Ok(found(ReconnectChallengeConsumeStatus::Rejected, record));
        }
        if !identity_equals(&record.identity, &selector.identity()) {
            return Ok(found(
                ReconnectChallengeConsumeStatus::SelectorMismatch,
                record,
            ));
        }
        if !transport_equals(&record.transport, transport) {
            return Ok(found(
                ReconnectChallengeConsumeStatus::TransportMismatch,
                record,
            ));
        }
        if record.consumed_at_ms.is_some() {
            return Ok(found(ReconnectChallengeConsumeStatus::Replay, record));
        }
        let mut consumed = record;
        consumed.consumed_at_ms = Some(now_ms);
        self.challenges
            .insert(challenge.to_owned(), consumed.clone());
        Ok(found(ReconnectChallengeConsumeStatus::Accepted, consumed))
    }

    async fn reject_challenges(
        &mut self,
        identity: &PeerRelationshipIdentity,
        rejected_at_ms: i64,
    ) -> AuthorityResult<usize> {
        validate_identity(identity)?;
        let mut rejected = 0_usize;
        let mut expired = Vec::new();
        for (challenge, record) in &mut self.challenges {
            if !identity_equals(&record.identity, identity) {
                continue;
            }
            if record.expires_at_ms <= rejected_at_ms {
                expired.push(challenge.clone());
                continue;
            }
            record.rejected_at_ms = Some(rejected_at_ms);
            rejected += 1;
        }
        for challenge in expired {
            self.challenges.remove(&challenge);
        }
        Ok(rejected)
    }
}

fn found(
    status: ReconnectChallengeConsumeStatus,
    record: ReconnectChallengeRecord,
) -> ReconnectChallengeConsumeResult {
    ReconnectChallengeConsumeResult {
        status,
        challenge: Some(record),
    }
}

/// An audit sink that keeps every row in memory, for tests and diagnostics.
#[derive(Clone, Debug, Default)]
pub struct MemoryPeerAuditSink {
    /// Every row recorded so far, in order.
    pub records: Vec<LocalPeerAuditRecord>,
}

#[async_trait]
impl PeerAuditSink for MemoryPeerAuditSink {
    async fn record(&mut self, record: LocalPeerAuditRecord) -> AuthorityResult<()> {
        self.records.push(record);
        Ok(())
    }
}

/// A broadcaster that keeps every event in memory.
#[derive(Clone, Debug, Default)]
pub struct MemoryPeerRevocationBroadcaster {
    /// Every event published so far, in order.
    pub events: Vec<PeerRevocationEvent>,
}

#[async_trait]
impl PeerRevocationBroadcaster for MemoryPeerRevocationBroadcaster {
    async fn publish(&mut self, event: PeerRevocationEvent) -> AuthorityResult<()> {
        self.events.push(event);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Resolver, issuer, revocation controller
// ---------------------------------------------------------------------------

/// The four coverage dimensions a caller may ask a grant about.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct GrantDimensions {
    /// Method to be called.
    #[serde(rename = "methodId", default, skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
    /// Tool contract to be reached.
    #[serde(
        rename = "toolContractId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_contract_id: Option<String>,
    /// Capability pack to be used.
    #[serde(
        rename = "capabilityPackId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub capability_pack_id: Option<String>,
    /// Resource scope to be touched.
    #[serde(
        rename = "resourceScope",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub resource_scope: Option<String>,
}

/// Request to mint a reconnect challenge.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct IssueReconnectChallengeRequest {
    /// Who the challenge is for.
    pub identity: PeerRelationshipIdentity,
    /// The transport it is bound to.
    pub transport: ReconnectTransportAttestation,
    /// Issue instant.
    #[serde(rename = "nowMs")]
    pub now_ms: i64,
}

/// Request to check a reconnect proof.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct VerifyReconnectProofRequest {
    /// Hex proof presented by the claimant.
    #[serde(rename = "proofHex")]
    pub proof_hex: String,
    /// The relationship being claimed.
    pub selector: PeerRelationshipSelector,
    /// The transport the proof must be bound to.
    pub transport: ReconnectTransportAttestation,
    /// The challenge being answered.
    pub challenge: String,
    /// Verification instant.
    #[serde(rename = "nowMs")]
    pub now_ms: i64,
}

/// Outcome of a reconnect proof check.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct VerifyReconnectProofResult {
    /// Whether the proof was accepted.
    pub ok: bool,
    /// The proven identity, on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<AuthenticatedPeerContext>,
    /// Why not, on failure.
    #[serde(rename = "reasonCode", skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

/// What a resolver needs.
///
/// The `manifestProvider` hook is not ported: it produces a TypeScript manifest
/// document, which is the peer host's business, not the authority's.
pub struct PeerAuthorityResolver<V, G, C, A>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
{
    /// Verifier persistence.
    pub verifier_store: V,
    /// Grant persistence.
    pub grant_repository: G,
    /// Replay guard.
    pub challenge_store: C,
    /// Audit destination.
    pub audit_sink: A,
}

impl<V, G, C, A> PeerAuthorityResolver<V, G, C, A>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
{
    /// Assemble a resolver over the four ports.
    pub fn new(verifier_store: V, grant_repository: G, challenge_store: C, audit_sink: A) -> Self {
        Self {
            verifier_store,
            grant_repository,
            challenge_store,
            audit_sink,
        }
    }

    /// Mint a challenge and audit it.
    pub async fn issue_reconnect_challenge(
        &mut self,
        request: &IssueReconnectChallengeRequest,
    ) -> AuthorityResult<ReconnectChallengeRecord> {
        let challenge = self
            .challenge_store
            .issue_challenge(&request.identity, &request.transport, request.now_ms)
            .await?;
        self.audit_sink
            .record(audit_record(
                LocalPeerAuditAction::ChallengeIssue,
                AuditSubject::Identity(request.identity.clone()),
                LocalPeerAuditDecision::Issued,
                request.now_ms,
            )?)
            .await?;
        Ok(challenge)
    }

    /// Consume the challenge, check the proof, and mint an authenticated context.
    ///
    /// The order matters and is preserved: the challenge is consumed *before*
    /// the verifier is read, so a replayed challenge is rejected without
    /// revealing whether a credential exists.
    pub async fn verify_reconnect_proof(
        &mut self,
        request: &VerifyReconnectProofRequest,
    ) -> AuthorityResult<VerifyReconnectProofResult> {
        let consumed = self
            .challenge_store
            .consume_challenge(
                &request.challenge,
                &request.selector,
                &request.transport,
                request.now_ms,
            )
            .await?;
        if consumed.status != ReconnectChallengeConsumeStatus::Accepted {
            self.audit_sink
                .record(
                    audit_record(
                        LocalPeerAuditAction::ChallengeConsume,
                        AuditSubject::Selector(request.selector.clone()),
                        LocalPeerAuditDecision::Rejected,
                        request.now_ms,
                    )?
                    .with_reason(consumed.status.as_str()),
                )
                .await?;
            return Ok(VerifyReconnectProofResult {
                ok: false,
                context: None,
                reason_code: Some(consumed.status.as_str().to_owned()),
            });
        }

        let Some(verifier) = self
            .verifier_store
            .get_verifier(&request.selector, request.now_ms)
            .await?
        else {
            self.audit_sink
                .record(
                    audit_record(
                        LocalPeerAuditAction::CredentialVerify,
                        AuditSubject::Selector(request.selector.clone()),
                        LocalPeerAuditDecision::Rejected,
                        request.now_ms,
                    )?
                    .with_reason("credential_not_found"),
                )
                .await?;
            return Ok(VerifyReconnectProofResult {
                ok: false,
                context: None,
                reason_code: Some("credential_not_found".to_owned()),
            });
        };

        let ok = verify_reconnect_proof_hex(
            &verifier.token_hash_hex,
            &request.proof_hex,
            &ReconnectProofInput {
                token_id: &request.selector.token_id,
                challenge: &request.challenge,
                channel_binding: &request.transport.channel_binding,
                claimant_peer_id: &request.selector.claimant_peer_id,
                verifier_peer_id: &request.selector.verifier_peer_id,
                room_name: &request.selector.room_name,
            },
        );
        if !ok {
            self.audit_sink
                .record(
                    audit_record(
                        LocalPeerAuditAction::CredentialVerify,
                        AuditSubject::Selector(request.selector.clone()),
                        LocalPeerAuditDecision::Rejected,
                        request.now_ms,
                    )?
                    .with_reason("proof_mismatch"),
                )
                .await?;
            return Ok(VerifyReconnectProofResult {
                ok: false,
                context: None,
                reason_code: Some("proof_mismatch".to_owned()),
            });
        }

        let context = AuthenticatedPeerContext {
            selector: request.selector.clone(),
            transport: request.transport.clone(),
            connection_epoch: None,
            credential_revision: verifier.credential_revision,
            authenticated_at_ms: request.now_ms,
        };
        self.audit_sink
            .record(audit_record(
                LocalPeerAuditAction::CredentialVerify,
                AuditSubject::Selector(request.selector.clone()),
                LocalPeerAuditDecision::Accepted,
                request.now_ms,
            )?)
            .await?;
        Ok(VerifyReconnectProofResult {
            ok: true,
            context: Some(context),
            reason_code: None,
        })
    }

    /// Evaluate a grant for an already authenticated peer.
    ///
    /// The selector comes from the authenticated context, never from the
    /// caller: this is the seam that keeps authority contexts from crossing
    /// peers.
    pub async fn resolve_grant(
        &mut self,
        context: &AuthenticatedPeerContext,
        method_id: Option<&str>,
        now_ms: i64,
    ) -> AuthorityResult<PeerAuthorityDecision> {
        self.resolve_grant_dimensions(
            context,
            &GrantDimensions {
                method_id: method_id.map(str::to_owned),
                ..GrantDimensions::default()
            },
            now_ms,
        )
        .await
    }

    /// Evaluate a grant across any of the four coverage dimensions.
    ///
    /// The local tool policy asks about tool contracts, capability packs and
    /// resource scopes as well as methods, so the seam has to carry all four or
    /// the caller ends up re-deciding coverage itself.
    pub async fn resolve_grant_dimensions(
        &mut self,
        context: &AuthenticatedPeerContext,
        dimensions: &GrantDimensions,
        now_ms: i64,
    ) -> AuthorityResult<PeerAuthorityDecision> {
        let method_id = dimensions.method_id.clone();
        let request = PeerGrantResolutionRequest {
            selector: context.selector.clone(),
            method_id: dimensions.method_id.clone(),
            tool_contract_id: dimensions.tool_contract_id.clone(),
            capability_pack_id: dimensions.capability_pack_id.clone(),
            resource_scope: dimensions.resource_scope.clone(),
            now_ms,
        };
        let decision = self.grant_repository.resolve_grant(&request).await?;
        let mut record = audit_record(
            LocalPeerAuditAction::GrantCheck,
            AuditSubject::Selector(context.selector.clone()),
            if decision.allowed {
                LocalPeerAuditDecision::Accepted
            } else {
                LocalPeerAuditDecision::Rejected
            },
            now_ms,
        )?;
        record.reason_code = decision
            .reason_code
            .map(|reason| reason.as_str().to_owned());
        record.method_id = method_id;
        record.connection_epoch = context.connection_epoch.clone();
        self.audit_sink.record(record).await?;
        Ok(decision)
    }

    /// Every live grant for the authenticated peer.
    pub async fn list_recipient_grants(
        &self,
        context: &AuthenticatedPeerContext,
        now_ms: i64,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        self.grant_repository
            .list_recipient_grants(&context.selector, now_ms)
            .await
    }

    /// Every live grant, plus a `manifest.snapshot` audit row.
    pub async fn snapshot_recipient_grants(
        &mut self,
        context: &AuthenticatedPeerContext,
        now_ms: i64,
        correlation_id: Option<&str>,
    ) -> AuthorityResult<Vec<LocalPeerGrantV1>> {
        let grants = self
            .grant_repository
            .list_recipient_grants(&context.selector, now_ms)
            .await?;
        let active = grants.iter().filter(|grant| {
            grant.revoked_at_ms.is_none_or(|at| at > now_ms)
                && grant.expires_at_ms.is_none_or(|at| at > now_ms)
        });
        let state = if active.count() > 0 {
            "active"
        } else {
            "unknown"
        };
        let mut record = audit_record(
            LocalPeerAuditAction::ManifestSnapshot,
            AuditSubject::Selector(context.selector.clone()),
            if state == "active" {
                LocalPeerAuditDecision::Accepted
            } else {
                LocalPeerAuditDecision::Rejected
            },
            now_ms,
        )?;
        if state != "active" {
            record.reason_code = Some("grant_not_found".to_owned());
        }
        record.connection_epoch = context.connection_epoch.clone();
        record.correlation_id = correlation_id.map(str::to_owned);
        record.authority_state = Some(state.to_owned());
        self.audit_sink.record(record).await?;
        Ok(grants)
    }
}

/// Result of minting a bearer credential.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct IssuedPeerBearerCredential {
    /// Credential identity.
    #[serde(rename = "tokenId")]
    pub token_id: String,
    /// The raw bearer token — held only long enough to hand to the peer.
    #[serde(rename = "bearerToken")]
    pub bearer_token: String,
    /// The stored half.
    pub verifier: LocalPeerCredentialVerifierV1,
    /// Product permission labels derived from the features shared at pairing.
    #[serde(rename = "grantedPermissions", skip_serializing_if = "Option::is_none")]
    pub granted_permissions: Option<Vec<String>>,
}

/// Options for one pairing issue.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PeerPairingIssueOptions {
    /// Optional credential expiry.
    pub expires_at_ms: Option<i64>,
    /// Local feature identifiers selected during this pairing approval.
    pub feature_ids: Option<Vec<String>>,
}

/// Mints bearer credentials at pairing time.
pub struct PeerPairingIssuer<V, A>
where
    V: InboundCredentialVerifierStore,
    A: PeerAuditSink,
{
    verifier_store: V,
    audit_sink: A,
    random: Box<dyn RandomSource>,
}

impl<V, A> PeerPairingIssuer<V, A>
where
    V: InboundCredentialVerifierStore,
    A: PeerAuditSink,
{
    /// Assemble an issuer.
    pub fn new(verifier_store: V, audit_sink: A, random: Box<dyn RandomSource>) -> Self {
        Self {
            verifier_store,
            audit_sink,
            random,
        }
    }

    /// Mint a credential for a relationship.
    pub async fn issue(
        &mut self,
        selector: &PeerRelationshipSelector,
        options: &PeerPairingIssueOptions,
        now_ms: i64,
    ) -> AuthorityResult<IssuedPeerBearerCredential> {
        validate_selector(selector)?;
        let bearer_token = bytes_to_hex(&self.random.random_bytes(32)?);
        let token_hash = sha256(bearer_token.as_bytes());
        let verifier = LocalPeerCredentialVerifierV1 {
            version: 1,
            token_id: selector.token_id.clone(),
            claimant_peer_id: selector.claimant_peer_id.clone(),
            verifier_peer_id: selector.verifier_peer_id.clone(),
            room_name: selector.room_name.clone(),
            token_hash_hex: bytes_to_hex(&token_hash),
            created_at_ms: now_ms,
            expires_at_ms: options.expires_at_ms,
            revoked_at_ms: None,
            credential_revision: 1,
        };
        self.verifier_store
            .upsert_verifier(verifier.clone())
            .await?;
        self.audit_sink
            .record(audit_record(
                LocalPeerAuditAction::CredentialIssue,
                AuditSubject::Selector(selector.clone()),
                LocalPeerAuditDecision::Issued,
                now_ms,
            )?)
            .await?;
        Ok(IssuedPeerBearerCredential {
            token_id: selector.token_id.clone(),
            bearer_token,
            verifier,
            granted_permissions: None,
        })
    }

    /// Undo an issue that the pairing flow abandoned.
    pub async fn rollback(&mut self, selector: &PeerRelationshipSelector) -> AuthorityResult<()> {
        validate_selector(selector)?;
        self.verifier_store.delete_verifier(selector).await
    }

    /// Hand the ports back, so a caller that lent them can take them home.
    pub fn into_ports(self) -> (V, A) {
        (self.verifier_store, self.audit_sink)
    }
}

/// Revokes a relationship: verifier, grants, and every outstanding challenge.
pub struct MemoryPeerRevocationController<V, G, C, A, B>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
    B: PeerRevocationBroadcaster,
{
    /// Verifier persistence.
    pub verifier_store: V,
    /// Grant persistence.
    pub grant_repository: G,
    /// Replay guard.
    pub challenge_store: C,
    /// Audit destination.
    pub audit_sink: A,
    /// Revocation fan-out.
    pub broadcaster: B,
}

impl<V, G, C, A, B> MemoryPeerRevocationController<V, G, C, A, B>
where
    V: InboundCredentialVerifierStore,
    G: PeerGrantRepository,
    C: ReconnectChallengeStore,
    A: PeerAuditSink,
    B: PeerRevocationBroadcaster,
{
    /// Assemble a controller over the five ports.
    pub fn new(
        verifier_store: V,
        grant_repository: G,
        challenge_store: C,
        audit_sink: A,
        broadcaster: B,
    ) -> Self {
        Self {
            verifier_store,
            grant_repository,
            challenge_store,
            audit_sink,
            broadcaster,
        }
    }

    /// Revoke everything for `selector` and publish the event.
    pub async fn revoke(
        &mut self,
        selector: &PeerRelationshipSelector,
        reason_code: &str,
        revoked_at_ms: i64,
    ) -> AuthorityResult<PeerRevocationEvent> {
        let verifier = self
            .verifier_store
            .revoke_verifier(selector, revoked_at_ms)
            .await?;
        let grants = self
            .grant_repository
            .revoke_grants(selector, revoked_at_ms)
            .await?;
        self.challenge_store
            .reject_challenges(&selector.identity(), revoked_at_ms)
            .await?;
        let post_revoke = self
            .grant_repository
            .resolve_grant(&PeerGrantResolutionRequest {
                selector: selector.clone(),
                method_id: None,
                tool_contract_id: None,
                capability_pack_id: None,
                resource_scope: None,
                now_ms: revoked_at_ms,
            })
            .await?;
        if post_revoke.reason_code == Some(PeerAuthorityDecisionReason::GrantStoreUnreadable) {
            self.audit_sink
                .record(
                    audit_record(
                        LocalPeerAuditAction::GrantRevoke,
                        AuditSubject::Selector(selector.clone()),
                        LocalPeerAuditDecision::Rejected,
                        revoked_at_ms,
                    )?
                    .with_reason("grant_store_unreadable"),
                )
                .await?;
        }
        let event = PeerRevocationEvent {
            event_type: "peer_authority_revoked_v1".to_owned(),
            selector: selector.clone(),
            revoked_grant_ids: grants.iter().map(|grant| grant.grant_id.clone()).collect(),
            credential_revision: verifier.map(|row| row.credential_revision),
            revoked_at_ms,
            reason_code: reason_code.to_owned(),
            redacted: true,
        };
        self.audit_sink
            .record(
                audit_record(
                    LocalPeerAuditAction::GrantRevoke,
                    AuditSubject::Selector(selector.clone()),
                    LocalPeerAuditDecision::Revoked,
                    revoked_at_ms,
                )?
                .with_reason(reason_code),
            )
            .await?;
        self.broadcaster.publish(event.clone()).await?;
        Ok(event)
    }
}

/// Compute the reconnect proof a claimant presents for a raw bearer token.
#[must_use]
pub fn create_reconnect_proof_for_bearer(
    raw_bearer_token: &str,
    selector: &PeerRelationshipSelector,
    transport: &ReconnectTransportAttestation,
    challenge: &str,
) -> String {
    compute_reconnect_proof_hex(
        raw_bearer_token,
        &ReconnectProofInput {
            token_id: &selector.token_id,
            challenge,
            channel_binding: &transport.channel_binding,
            claimant_peer_id: &selector.claimant_peer_id,
            verifier_peer_id: &selector.verifier_peer_id,
            room_name: &selector.room_name,
        },
    )
}

// ---------------------------------------------------------------------------
// Validation and ordering helpers
// ---------------------------------------------------------------------------

impl LocalPeerAuditRecord {
    fn with_reason(mut self, reason: &str) -> Self {
        self.reason_code = Some(reason.to_owned());
        self
    }
}

fn audit_record(
    action: LocalPeerAuditAction,
    subject: AuditSubject,
    decision: LocalPeerAuditDecision,
    created_at_ms: i64,
) -> AuthorityResult<LocalPeerAuditRecord> {
    subject.validate()?;
    Ok(LocalPeerAuditRecord {
        action,
        selector: subject,
        decision,
        reason_code: None,
        method_id: None,
        tool_contract_id: None,
        capability_pack_id: None,
        resource_scope: None,
        correlation_id: None,
        connection_epoch: None,
        authority_state: None,
        created_at_ms,
        redacted: true,
        redacted_fields: AUDIT_REDACTED_FIELDS
            .iter()
            .map(|field| (*field).to_owned())
            .collect(),
    })
}

/// True when `value` is exactly 64 lowercase hex characters.
#[must_use]
pub fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validate a full selector, token id included.
pub fn validate_selector(selector: &PeerRelationshipSelector) -> AuthorityResult<()> {
    assert_non_empty("tokenId", &selector.token_id, MAX_TOKEN_ID_LENGTH)?;
    validate_identity(&selector.identity())
}

/// Validate a relationship identity.
pub fn validate_identity(identity: &PeerRelationshipIdentity) -> AuthorityResult<()> {
    assert_non_empty(
        "claimantPeerId",
        &identity.claimant_peer_id,
        MAX_PEER_ID_LENGTH,
    )?;
    assert_non_empty(
        "verifierPeerId",
        &identity.verifier_peer_id,
        MAX_PEER_ID_LENGTH,
    )?;
    assert_non_empty("roomName", &identity.room_name, MAX_ROOM_NAME_LENGTH)
}

/// Validate a transport attestation.
pub fn validate_transport(transport: &ReconnectTransportAttestation) -> AuthorityResult<()> {
    if !is_hex64(&transport.channel_binding) {
        return Err(AuthorityError::Invalid("channel binding".to_owned()));
    }
    assert_non_empty(
        "claimantSignalingPeerId",
        &transport.claimant_signaling_peer_id,
        MAX_PEER_ID_LENGTH,
    )?;
    assert_non_empty(
        "verifierSignalingPeerId",
        &transport.verifier_signaling_peer_id,
        MAX_PEER_ID_LENGTH,
    )
}

/// Validate a credential verifier before it is stored.
pub fn validate_verifier(verifier: &LocalPeerCredentialVerifierV1) -> AuthorityResult<()> {
    if verifier.version != 1 {
        return Err(AuthorityError::UnsupportedVersion("verifier"));
    }
    validate_selector(&verifier.selector())?;
    if !is_hex64(&verifier.token_hash_hex) {
        return Err(AuthorityError::Invalid("verifier token hash".to_owned()));
    }
    assert_timestamp("createdAtMs", verifier.created_at_ms)?;
    assert_revision("credentialRevision", verifier.credential_revision)
}

/// Validate a grant before it is stored.
pub fn validate_grant(grant: &LocalPeerGrantV1) -> AuthorityResult<()> {
    if grant.version != 1 {
        return Err(AuthorityError::UnsupportedVersion("grant"));
    }
    validate_selector(&grant.selector())?;
    assert_non_empty("grantId", &grant.grant_id, MAX_GRANT_ID_LENGTH)?;
    assert_timestamp("createdAtMs", grant.created_at_ms)?;
    assert_revision("grantRevision", grant.grant_revision)
}

fn assert_non_empty(name: &str, value: &str, max_length: usize) -> AuthorityResult<()> {
    // TypeScript measures `String.length`, i.e. UTF-16 code units.
    let length = value.chars().map(char::len_utf16).sum::<usize>();
    if length == 0 || length > max_length {
        return Err(AuthorityError::Invalid(name.to_owned()));
    }
    Ok(())
}

fn assert_timestamp(name: &str, value: i64) -> AuthorityResult<()> {
    if value < 0 {
        return Err(AuthorityError::Invalid(name.to_owned()));
    }
    Ok(())
}

fn assert_revision(name: &str, value: i64) -> AuthorityResult<()> {
    if value < 0 {
        return Err(AuthorityError::Invalid(name.to_owned()));
    }
    Ok(())
}

/// Two identities are equal when all three parts match.
#[must_use]
pub fn identity_equals(left: &PeerRelationshipIdentity, right: &PeerRelationshipIdentity) -> bool {
    left.claimant_peer_id == right.claimant_peer_id
        && left.verifier_peer_id == right.verifier_peer_id
        && left.room_name == right.room_name
}

/// Two selectors are equal when the token id and the identity match.
#[must_use]
pub fn selector_equals(left: &PeerRelationshipSelector, right: &PeerRelationshipSelector) -> bool {
    left.token_id == right.token_id && identity_equals(&left.identity(), &right.identity())
}

/// Two transports are equal when all three parts match.
#[must_use]
pub fn transport_equals(
    left: &ReconnectTransportAttestation,
    right: &ReconnectTransportAttestation,
) -> bool {
    left.channel_binding == right.channel_binding
        && left.claimant_signaling_peer_id == right.claimant_signaling_peer_id
        && left.verifier_signaling_peer_id == right.verifier_signaling_peer_id
}

/// Newest revision first, then newest creation, then grant id ascending.
#[must_use]
pub fn compare_grants(left: &LocalPeerGrantV1, right: &LocalPeerGrantV1) -> std::cmp::Ordering {
    right
        .grant_revision
        .cmp(&left.grant_revision)
        .then_with(|| right.created_at_ms.cmp(&left.created_at_ms))
        .then_with(|| left.grant_id.cmp(&right.grant_id))
}

fn compare_grants_owned(left: &LocalPeerGrantV1, right: &LocalPeerGrantV1) -> std::cmp::Ordering {
    compare_grants(left, right)
}

/// Which coverage check a live grant failed, if any.
#[must_use]
pub fn grant_coverage_failure(
    grant: &LocalPeerGrantV1,
    request: &PeerGrantResolutionRequest,
) -> Option<PeerAuthorityDecisionReason> {
    if let Some(method_id) = &request.method_id {
        if !grant.allowed_method_ids.contains(method_id) {
            return Some(PeerAuthorityDecisionReason::MethodNotGranted);
        }
    }
    if let Some(tool_contract_id) = &request.tool_contract_id {
        if !grant.allowed_tool_contract_ids.contains(tool_contract_id) {
            return Some(PeerAuthorityDecisionReason::ToolNotGranted);
        }
    }
    if let Some(capability_pack_id) = &request.capability_pack_id {
        if !grant.capability_pack_ids.contains(capability_pack_id) {
            return Some(PeerAuthorityDecisionReason::CapabilityNotGranted);
        }
    }
    if let Some(resource_scope) = &request.resource_scope {
        if !grant.resource_scopes.contains(resource_scope) {
            return Some(PeerAuthorityDecisionReason::ResourceNotGranted);
        }
    }
    None
}

/// De-duplicate and sort, matching `[...new Set(values)].sort()`.
#[must_use]
pub fn sorted_unique(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = values.to_vec();
    out.sort();
    out.dedup();
    out
}
