//! Port of `packages/aurora-sdk/src/peer-host/types.ts`.
//!
//! The authority-facing half of that file: the identity a call arrives with,
//! the authorization request and decision, the manifest authority snapshot, the
//! error body vocabulary, and the execution policy carried on a method
//! descriptor.
//!
//! ## What is deliberately not here
//!
//! `PeerHostMethodDescriptor.handler`, `streamHandler`, `PeerHostCallContext`,
//! `PeerHostSubscribeContext`, `PeerHostFrameSender` and `PeerHostOptions` are
//! *host* types, not authority types. They carry closures, abort signals and a
//! frame sender — transport state the R0 boundary note keeps out of this crate.
//! What the authority needs from a descriptor is its policy: who may call it,
//! how big a request may be, how long it may run, how many may run at once.
//! That is [`PeerHostMethodDescriptor`] here, and the host supplies the
//! handlers on its own side of the seam.

use serde::{Deserialize, Serialize};

use crate::authority::AuthenticatedPeerContext;

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

/// The HTTP-shaped numeric codes the peer host answers with.
///
/// Mirrors `webrtc-peer-host.ts` exactly. The R0 boundary note adds `503` for
/// the orchestration deferral in R3; it is not minted here because nothing in
/// the authority defers.
pub mod error_code {
    /// Request failed schema validation at the boundary.
    pub const SCHEMA_VALIDATION_FAILED: u16 = 400;
    /// Caller is not authorized, or its authority was revoked.
    pub const NOT_AUTHORIZED: u16 = 403;
    /// Caller cancelled the request.
    pub const REQUEST_CANCELLED: u16 = 499;
    /// The handler itself failed.
    pub const HANDLER_FAILED: u16 = 500;
    /// The request outlived its deadline.
    pub const REQUEST_TIMEOUT: u16 = 504;
}

/// The machine-readable `reason_code` vocabulary carried on an error body.
///
/// Closed and verbatim from `webrtc-peer-host.ts`. Anything the authority
/// denies for maps into one of these before it reaches the wire; the finer
/// grained authority reasons (`grant_expired`, `selector_mismatch`, …) travel
/// in [`PeerHostAuthorizationDecision::reason_code`] and are for audit, not for
/// the caller.
pub mod reason_code {
    /// The handler raised.
    pub const HANDLER_FAILED: &str = "handler_failed";
    /// The provider lease backing the call expired.
    pub const LEASE_EXPIRED: &str = "lease_expired";
    /// The peer's authority was withdrawn.
    pub const PEER_AUTHORITY_REVOKED: &str = "peer_authority_revoked";
    /// The caller cancelled.
    pub const REQUEST_CANCELLED: &str = "request_cancelled";
    /// The deadline passed.
    pub const REQUEST_TIMEOUT: &str = "request_timeout";
    /// The payload did not match its schema.
    pub const SCHEMA_VALIDATION_FAILED: &str = "schema_validation_failed";
}

/// Every `reason_code` the peer host may emit, in sorted order.
///
/// Exists so a test can assert the vocabulary did not silently grow.
pub const REASON_CODES: [&str; 6] = [
    reason_code::HANDLER_FAILED,
    reason_code::LEASE_EXPIRED,
    reason_code::PEER_AUTHORITY_REVOKED,
    reason_code::REQUEST_CANCELLED,
    reason_code::REQUEST_TIMEOUT,
    reason_code::SCHEMA_VALIDATION_FAILED,
];

/// One schema validation complaint.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostErrorIssue {
    /// Dotted path to the offending member.
    pub path: String,
    /// Validator code.
    pub code: String,
    /// Human-readable detail.
    pub message: String,
}

/// The `error` member of an `error` frame.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostErrorBody {
    /// HTTP-shaped numeric code.
    pub code: u16,
    /// Product copy. User-facing if it ever surfaces.
    pub message: String,
    /// Machine-readable reason.
    pub reason_code: String,
    /// When the caller should try again, for the retryable codes that know.
    ///
    /// Additive and optional, so an older peer that ignores it still sees a
    /// well-formed error. Its only value today is `peer_foreground`, carried by
    /// R3's orchestration deferral (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`
    /// section 6); nothing in the authority sets it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_when: Option<String>,
    /// Opaque correlation handle for logs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_ref: Option<String>,
    /// Schema the payload failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_id: Option<String>,
    /// Which boundary rejected it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
    /// Individual validation complaints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<Vec<PeerHostErrorIssue>>,
}

impl PeerHostErrorBody {
    /// The 403 body the host sends when the authority says no.
    #[must_use]
    pub fn not_authorized(reason_code: &str) -> Self {
        Self {
            code: error_code::NOT_AUTHORIZED,
            message: "not authorized".to_owned(),
            reason_code: reason_code.to_owned(),
            retry_when: None,
            error_ref: None,
            schema_id: None,
            boundary: None,
            issues: None,
        }
    }

    /// The 403 body the host sends when a live request loses its authority.
    #[must_use]
    pub fn peer_authority_revoked() -> Self {
        Self {
            code: error_code::NOT_AUTHORIZED,
            message: "peer authority revoked".to_owned(),
            reason_code: reason_code::PEER_AUTHORITY_REVOKED.to_owned(),
            retry_when: None,
            error_ref: None,
            schema_id: None,
            boundary: None,
            issues: None,
        }
    }

    /// The 504 body the host sends when a request outlives its deadline.
    #[must_use]
    pub fn request_timeout() -> Self {
        Self {
            code: error_code::REQUEST_TIMEOUT,
            message: "request timed out".to_owned(),
            reason_code: reason_code::REQUEST_TIMEOUT.to_owned(),
            retry_when: None,
            error_ref: None,
            schema_id: None,
            boundary: None,
            issues: None,
        }
    }

    /// The 499 body the host sends when the caller cancels.
    #[must_use]
    pub fn request_cancelled() -> Self {
        Self {
            code: error_code::REQUEST_CANCELLED,
            message: "request cancelled".to_owned(),
            reason_code: reason_code::REQUEST_CANCELLED.to_owned(),
            retry_when: None,
            error_ref: None,
            schema_id: None,
            boundary: None,
            issues: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Identity and authorization
// ---------------------------------------------------------------------------

/// Who a call claims to be.
///
/// `principalId`, `authGrantRevision` and `manifestRevision` are nullable in
/// TypeScript *and* optional, which is two ways of spelling absent. Rust keeps
/// one: `Option`.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostIdentity {
    /// Stable peer id of the caller.
    #[serde(rename = "callerPeerId")]
    pub caller_peer_id: String,
    /// Principal the caller acts as, when it declares one.
    #[serde(
        rename = "principalId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub principal_id: Option<String>,
    /// Permissions the caller believes it holds.
    #[serde(rename = "effectivePermissions", default)]
    pub effective_permissions: Vec<String>,
    /// Grant revision the caller last saw.
    #[serde(
        rename = "authGrantRevision",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub auth_grant_revision: Option<i64>,
    /// Manifest revision the caller last saw. A string or a number on the wire.
    #[serde(
        rename = "manifestRevision",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub manifest_revision: Option<serde_json::Value>,
}

/// The question the peer host asks the authority on every inbound call.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostAuthorizeRequest {
    /// Stable peer id the frame arrived from.
    #[serde(rename = "remotePeerId")]
    pub remote_peer_id: String,
    /// Method being called.
    #[serde(rename = "methodId")]
    pub method_id: String,
    /// Permissions the descriptor demands.
    #[serde(rename = "requiredPermissions", default)]
    pub required_permissions: Vec<String>,
    /// What the caller claims about itself.
    pub identity: PeerHostIdentity,
    /// What the reconnect proof established, when there was one.
    #[serde(
        rename = "authenticatedPeerContext",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub authenticated_peer_context: Option<AuthenticatedPeerContext>,
    /// Evaluation instant.
    #[serde(rename = "nowMs")]
    pub now_ms: i64,
}

/// The authority's answer.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostAuthorizationDecision {
    /// Whether the call may proceed.
    pub allowed: bool,
    /// Why not, when it may not.
    #[serde(
        rename = "reasonCode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reason_code: Option<String>,
    /// Revision of the grant that decided it.
    #[serde(
        rename = "grantRevision",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub grant_revision: Option<i64>,
    /// Every method the grant carries, sorted and de-duplicated.
    #[serde(
        rename = "grantedMethodIds",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub granted_method_ids: Option<Vec<String>>,
    /// Product permission labels the grant maps to, sorted and de-duplicated.
    #[serde(
        rename = "grantedPermissions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub granted_permissions: Option<Vec<String>>,
    /// Tool contracts the grant carries, sorted and de-duplicated.
    ///
    /// Reported rather than interpreted. Mapping a tool contract to a product
    /// permission label needs the local tool registry, which is TypeScript data
    /// the authority has no business holding — so the authority says what is
    /// granted and the caller projects the labels.
    #[serde(
        rename = "grantedToolContractIds",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub granted_tool_contract_ids: Option<Vec<String>>,
}

impl PeerHostAuthorizationDecision {
    /// A denial carrying only a reason.
    #[must_use]
    pub fn denied(reason_code: &str) -> Self {
        Self {
            allowed: false,
            reason_code: Some(reason_code.to_owned()),
            grant_revision: None,
            granted_method_ids: None,
            granted_permissions: None,
            granted_tool_contract_ids: None,
        }
    }
}

/// How the grant state reads on a manifest.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerHostAuthGrantState {
    /// Nothing is granted, or nothing is known.
    #[default]
    Unknown,
    /// Approval has been requested but not settled.
    Pending,
    /// At least one live grant covers the peer.
    Active,
    /// Authority was withdrawn.
    Revoked,
}

impl PeerHostAuthGrantState {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Revoked => "revoked",
        }
    }
}

/// What the manifest advertises about a recipient's authority.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostManifestAuthoritySnapshot {
    /// Peer the snapshot is about.
    #[serde(
        rename = "recipientPeerId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub recipient_peer_id: Option<String>,
    /// Every granted method, sorted and de-duplicated.
    #[serde(rename = "grantedMethodIds")]
    pub granted_method_ids: Vec<String>,
    /// Every granted permission label, sorted and de-duplicated.
    #[serde(
        rename = "grantedPermissions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub granted_permissions: Option<Vec<String>>,
    /// Tool contracts the live grants carry, sorted and de-duplicated.
    ///
    /// Reported, not interpreted — see the same field on
    /// [`PeerHostAuthorizationDecision`].
    #[serde(
        rename = "grantedToolContractIds",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub granted_tool_contract_ids: Option<Vec<String>>,
    /// Highest live grant revision.
    #[serde(rename = "authGrantRevision")]
    pub auth_grant_revision: i64,
    /// Whether anything is granted.
    #[serde(rename = "authGrantState")]
    pub auth_grant_state: PeerHostAuthGrantState,
}

/// What the peer host asks for when it composes a manifest.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostManifestAuthorityRequest {
    /// Peer the manifest is for, when the host knows.
    #[serde(
        rename = "remotePeerId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub remote_peer_id: Option<String>,
    /// What the reconnect proof established, when there was one.
    #[serde(
        rename = "authenticatedPeerContext",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub authenticated_peer_context: Option<AuthenticatedPeerContext>,
    /// Evaluation instant.
    #[serde(rename = "nowMs")]
    pub now_ms: i64,
    /// Correlation handle for audit.
    #[serde(
        rename = "correlationId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub correlation_id: Option<String>,
}

/// The seam the rest of the system asks authorization questions through.
///
/// The R0 boundary note promises W1 and R3 that this interface is what they
/// ask through, so its shape is the contract this crate satisfies:
/// `PeerHostAuthorizationStore` in `peer-host/types.ts`.
#[async_trait::async_trait]
pub trait PeerHostAuthorizationStore {
    /// May this peer call this method right now?
    async fn authorize(
        &mut self,
        request: &PeerHostAuthorizeRequest,
    ) -> crate::authority::AuthorityResult<PeerHostAuthorizationDecision>;

    /// What does this peer's manifest advertise about its authority?
    ///
    /// Optional in TypeScript (`snapshotManifestAuthority?`). Rust gives it a
    /// default returning the empty, `unknown` snapshot, which is what the peer
    /// host falls back to when the method is absent.
    async fn snapshot_manifest_authority(
        &mut self,
        request: &PeerHostManifestAuthorityRequest,
    ) -> crate::authority::AuthorityResult<PeerHostManifestAuthoritySnapshot> {
        Ok(PeerHostManifestAuthoritySnapshot {
            recipient_peer_id: request.remote_peer_id.clone(),
            granted_method_ids: Vec::new(),
            granted_permissions: None,
            granted_tool_contract_ids: None,
            auth_grant_revision: 0,
            auth_grant_state: PeerHostAuthGrantState::Unknown,
        })
    }
}

// ---------------------------------------------------------------------------
// Execution policy
// ---------------------------------------------------------------------------

/// How a method is invoked.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerHostMethodType {
    /// One request, one response.
    Unary,
    /// One request, a stream of chunks.
    Stream,
    /// A subscription.
    Event,
}

impl PeerHostMethodType {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unary => "unary",
            Self::Stream => "stream",
            Self::Event => "event",
        }
    }
}

/// The authorization class the projection assigns a method.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerHostProjectionMethodType {
    /// Reads and ordinary use.
    Use,
    /// Configuration and administration.
    Manage,
}

impl PeerHostProjectionMethodType {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Use => "use",
            Self::Manage => "manage",
        }
    }

    /// Parse the generated contract's `method_type`.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "use" => Some(Self::Use),
            "manage" => Some(Self::Manage),
            _ => None,
        }
    }
}

/// Whether a method is reachable from outside the node.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerHostMethodExposure {
    /// In-process callers only.
    Internal,
    /// Remote callers only.
    External,
    /// Both.
    Both,
}

impl PeerHostMethodExposure {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::External => "external",
            Self::Both => "both",
        }
    }

    /// Parse the generated contract's `exposure`.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "internal" => Some(Self::Internal),
            "external" => Some(Self::External),
            "both" => Some(Self::Both),
            _ => None,
        }
    }
}

/// The policy half of a peer-host method descriptor.
///
/// Everything the authority and the execution path need to decide whether a
/// call may run and how far it may go. The handler is the host's.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostMethodDescriptor {
    /// Typed method identity.
    #[serde(rename = "methodId")]
    pub method_id: String,
    /// Owning service module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Method name within the module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Human summary. The generated builder sets this empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Typed bus topic. Never a literal string at a call site.
    #[serde(rename = "busTopic", default, skip_serializing_if = "Option::is_none")]
    pub bus_topic: Option<String>,
    /// Reachability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure: Option<PeerHostMethodExposure>,
    /// Invocation shape.
    #[serde(rename = "methodType")]
    pub method_type: PeerHostMethodType,
    /// Authorization class.
    #[serde(
        rename = "projectionMethodType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub projection_method_type: Option<PeerHostProjectionMethodType>,
    /// Input schema identity.
    #[serde(rename = "inputSchemaId")]
    pub input_schema_id: String,
    /// Output schema identity.
    #[serde(rename = "outputSchemaId")]
    pub output_schema_id: String,
    /// Permissions a caller must hold.
    #[serde(rename = "requiredPermissions", default)]
    pub required_permissions: Vec<String>,
    /// Callable feature identities used by route selection.
    #[serde(rename = "callableFeatureIds", default)]
    pub callable_feature_ids: Vec<String>,
    /// Provider capabilities the method advertises.
    #[serde(rename = "serviceCapabilities", default)]
    pub service_capabilities: Vec<String>,
    /// Version advertised on the mesh for this projected surface.
    #[serde(
        rename = "serviceVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub service_version: Option<String>,
    /// How many may run at once.
    #[serde(
        rename = "maxConcurrent",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_concurrent: Option<u32>,
    /// Largest request body accepted.
    #[serde(
        rename = "maxRequestBytes",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_request_bytes: Option<u64>,
    /// Deadline in milliseconds.
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// The policy half of a peer-host event descriptor.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct PeerHostEventDescriptor {
    /// Typed event topic.
    pub topic: String,
    /// Owning service module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Event name within the module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Payload schema identity.
    #[serde(rename = "outputSchemaId")]
    pub output_schema_id: String,
    /// Permissions a subscriber must hold.
    #[serde(rename = "requiredPermissions", default)]
    pub required_permissions: Vec<String>,
    /// Longest subscription lifetime.
    #[serde(
        rename = "maxTtlSeconds",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_ttl_seconds: Option<u32>,
    /// Largest event payload.
    #[serde(
        rename = "maxEventBytes",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_event_bytes: Option<u64>,
    /// Ordering group the topic belongs to.
    #[serde(
        rename = "orderedEventGroup",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ordered_event_group: Option<String>,
}
