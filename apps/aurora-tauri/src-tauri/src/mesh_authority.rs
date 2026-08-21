//! Tauri command surface for the mesh authority.
//!
//! The native half of workstream R2. Decisions cross this boundary; storage does
//! not. TypeScript hydrates the authority at session start from the durable
//! adapters it already owns, and asks every permission question through here.
//! The web build runs the same Rust core as WebAssembly
//! (`packages/aurora-mesh-authority-web`), so there is no second implementation
//! to drift from.
//!
//! Per the R0 boundary note (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`, section
//! 1) this is the *authority store* and not a session registry: it is keyed by
//! peer identity, holds no transport state, and never learns which connection a
//! peer arrived on.

use aurora_mesh_authority::authority::{
    AuthorityError, AuthorityResult, InboundCredentialVerifierStore,
    IssueReconnectChallengeRequest, LocalPeerCredentialVerifierV1, LocalPeerGrantV1,
    MemoryInboundCredentialVerifierStore, MemoryPeerAuditSink, MemoryPeerGrantRepository,
    MemoryPeerRevocationBroadcaster, MemoryPeerRevocationController, MemoryReconnectChallengeStore,
    PeerAuthorityResolver, PeerGrantRepository, PeerRelationshipSelector, RandomSource,
    VerifyReconnectProofRequest,
};
use aurora_mesh_authority::authorization::PeerAuthorityHostAuthorizationStore;
use aurora_mesh_authority::grant_management::{PeerGrantManager, PeerGrantSelection};
use aurora_mesh_authority::types::{
    PeerHostAuthorizationStore, PeerHostAuthorizeRequest, PeerHostManifestAuthorityRequest,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

/// Bytes from the OS CSPRNG.
///
/// The authority never invents randomness of its own; the platform supplies it,
/// exactly as `webrtc/crypto.ts` does on the web.
struct OsRandomSource;

impl RandomSource for OsRandomSource {
    fn random_bytes(&self, length: usize) -> AuthorityResult<Vec<u8>> {
        let mut out = vec![0_u8; length];
        getrandom::getrandom(&mut out).map_err(|_| AuthorityError::RandomSourceUnavailable)?;
        Ok(out)
    }
}

type NativeAuthority = PeerAuthorityHostAuthorizationStore<
    MemoryInboundCredentialVerifierStore,
    MemoryPeerGrantRepository,
    MemoryReconnectChallengeStore,
    MemoryPeerAuditSink,
>;

fn new_authority() -> NativeAuthority {
    PeerAuthorityHostAuthorizationStore::new(PeerAuthorityResolver::new(
        MemoryInboundCredentialVerifierStore::new(),
        MemoryPeerGrantRepository::new(),
        MemoryReconnectChallengeStore::new(Box::new(OsRandomSource)),
        MemoryPeerAuditSink::default(),
    ))
}

/// One authority per app.
///
/// The mutex is the write lock: the authority's write paths take `&mut self`,
/// which is the Rust replacement for the promise queue the TypeScript grant
/// manager used. It must not be worked around with interior mutability.
pub struct MeshAuthorityState(Mutex<NativeAuthority>);

impl Default for MeshAuthorityState {
    fn default() -> Self {
        Self(Mutex::new(new_authority()))
    }
}

impl MeshAuthorityState {
    /// Take the write lock.
    ///
    /// R3's background dispatcher asks the same authority the foreground asks,
    /// through this same lock, which is what makes a backgrounded decision
    /// identical to a foreground one rather than merely similar.
    pub(crate) async fn lock(&self) -> tokio::sync::MutexGuard<'_, NativeAuthority> {
        self.0.lock().await
    }
}

fn to_error<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(to_error)
}

/// Durable rows the shell replays into the authority at session start.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshAuthorityHydrateRequest {
    /// Credential verifiers held for inbound peers.
    #[serde(default)]
    pub verifiers: Vec<LocalPeerCredentialVerifierV1>,
    /// Grants issued to inbound peers.
    #[serde(default)]
    pub grants: Vec<LocalPeerGrantV1>,
}

/// Load durable verifiers and grants into the authority.
#[tauri::command]
pub async fn aurora_mesh_authority_hydrate(
    state: tauri::State<'_, MeshAuthorityState>,
    request: MeshAuthorityHydrateRequest,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let resolver = authority.resolver_mut();
    for verifier in request.verifiers {
        resolver
            .verifier_store
            .upsert_verifier(verifier)
            .await
            .map_err(to_error)?;
    }
    let mut grants = 0_usize;
    for grant in request.grants {
        resolver
            .grant_repository
            .upsert_grant(grant)
            .await
            .map_err(to_error)?;
        grants += 1;
    }
    to_value(&serde_json::json!({ "hydratedGrants": grants }))
}

/// May this peer call this method right now?
#[tauri::command]
pub async fn aurora_mesh_authority_authorize(
    state: tauri::State<'_, MeshAuthorityState>,
    request: PeerHostAuthorizeRequest,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let decision = authority.authorize(&request).await.map_err(to_error)?;
    to_value(&decision)
}

/// What does this peer's manifest advertise about its authority?
#[tauri::command]
pub async fn aurora_mesh_authority_snapshot_manifest(
    state: tauri::State<'_, MeshAuthorityState>,
    request: PeerHostManifestAuthorityRequest,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let snapshot = authority
        .snapshot_manifest_authority(&request)
        .await
        .map_err(to_error)?;
    to_value(&snapshot)
}

/// Mint a single-use reconnect challenge.
#[tauri::command]
pub async fn aurora_mesh_authority_issue_reconnect_challenge(
    state: tauri::State<'_, MeshAuthorityState>,
    request: IssueReconnectChallengeRequest,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let record = authority
        .resolver_mut()
        .issue_reconnect_challenge(&request)
        .await
        .map_err(to_error)?;
    to_value(&record)
}

/// Check a reconnect proof and, on success, mint the authenticated context.
#[tauri::command]
pub async fn aurora_mesh_authority_verify_reconnect_proof(
    state: tauri::State<'_, MeshAuthorityState>,
    request: VerifyReconnectProofRequest,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let result = authority
        .resolver_mut()
        .verify_reconnect_proof(&request)
        .await
        .map_err(to_error)?;
    to_value(&result)
}

/// Take the audit rows recorded since the last drain, oldest first.
///
/// The authority records who asked for what and what it answered; persisting
/// those rows is the shell's job, because the durable store is TypeScript's.
/// Draining rather than streaming keeps the authority free of a sink it would
/// have to hold open.
#[tauri::command]
pub async fn aurora_mesh_authority_drain_audit(
    state: tauri::State<'_, MeshAuthorityState>,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let records = std::mem::take(&mut authority.resolver_mut().audit_sink.records);
    to_value(&records)
}

/// Evaluate a grant across any of the four coverage dimensions.
///
/// The local tool execution policy asks about tool contracts, capability packs
/// and resource scopes as well as methods; without this it would have to decide
/// coverage itself, which is the drift R2 exists to prevent.
#[tauri::command]
pub async fn aurora_mesh_authority_resolve_grant(
    state: tauri::State<'_, MeshAuthorityState>,
    context: aurora_mesh_authority::authority::AuthenticatedPeerContext,
    dimensions: aurora_mesh_authority::authority::GrantDimensions,
    now_ms: i64,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let decision = authority
        .resolver_mut()
        .resolve_grant_dimensions(&context, &dimensions, now_ms)
        .await
        .map_err(to_error)?;
    to_value(&decision)
}

/// Mint a bearer credential for a relationship at pairing time.
#[tauri::command]
pub async fn aurora_mesh_authority_issue_pairing_credential(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    expires_at_ms: Option<i64>,
    now_ms: i64,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let resolver = authority.resolver_mut();
    let mut issuer = aurora_mesh_authority::authority::PeerPairingIssuer::new(
        std::mem::take(&mut resolver.verifier_store),
        std::mem::take(&mut resolver.audit_sink),
        Box::new(OsRandomSource),
    );
    let issued = issuer
        .issue(
            &selector,
            &aurora_mesh_authority::authority::PeerPairingIssueOptions {
                expires_at_ms,
                feature_ids: None,
            },
            now_ms,
        )
        .await;
    let (verifier_store, audit_sink) = issuer.into_ports();
    let resolver = authority.resolver_mut();
    resolver.verifier_store = verifier_store;
    resolver.audit_sink = audit_sink;
    to_value(&issued.map_err(to_error)?)
}

/// Undo a pairing the flow abandoned.
#[tauri::command]
pub async fn aurora_mesh_authority_rollback_pairing_credential(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
) -> Result<(), String> {
    let mut authority = state.0.lock().await;
    authority
        .resolver_mut()
        .verifier_store
        .delete_verifier(&selector)
        .await
        .map_err(to_error)
}

/// Every grant row held for a relationship, for durable persistence.
#[tauri::command]
pub async fn aurora_mesh_authority_export_grants(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let rows = authority
        .resolver_mut()
        .grant_repository
        .export_grants(&selector);
    to_value(&rows)
}

/// Withdraw every grant for a relationship.
#[tauri::command]
pub async fn aurora_mesh_authority_revoke_sharing(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    now_ms: i64,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let repository = std::mem::take(&mut authority.resolver_mut().grant_repository);
    let mut manager = PeerGrantManager::new(repository);
    let summaries = manager.revoke_sharing(&selector, now_ms).await;
    authority.resolver_mut().grant_repository = manager.into_repository();
    to_value(&summaries.map_err(to_error)?)
}

/// Every live grant for a relationship, as the sharing settings render it.
#[tauri::command]
pub async fn aurora_mesh_authority_list_active_grants(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    now_ms: i64,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let repository = std::mem::take(&mut authority.resolver_mut().grant_repository);
    let manager = PeerGrantManager::new(repository);
    let summaries = manager.list_active_grants(&selector, now_ms).await;
    authority.resolver_mut().grant_repository = manager.into_repository();
    to_value(&summaries.map_err(to_error)?)
}

/// Replace a relationship's sharing with a new selection.
#[tauri::command]
pub async fn aurora_mesh_authority_replace_grant(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    selection: PeerGrantSelection,
    now_ms: i64,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let repository = std::mem::take(&mut authority.resolver_mut().grant_repository);
    let mut manager = PeerGrantManager::new(repository).with_grant_id_source(Box::new(|| {
        let mut bytes = [0_u8; 16];
        getrandom::getrandom(&mut bytes).ok()?;
        Some(format!(
            "grant-{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ))
    }));
    let summary = manager.replace_grant(&selector, &selection, now_ms).await;
    authority.resolver_mut().grant_repository = manager.into_repository();
    to_value(&summary.map_err(to_error)?)
}

/// Revoke a relationship outright: verifier, grants and challenges.
#[tauri::command]
pub async fn aurora_mesh_authority_revoke_peer_authority(
    state: tauri::State<'_, MeshAuthorityState>,
    selector: PeerRelationshipSelector,
    reason_code: String,
    revoked_at_ms: i64,
) -> Result<Value, String> {
    let mut authority = state.0.lock().await;
    let resolver = authority.resolver_mut();
    let mut controller = MemoryPeerRevocationController::new(
        std::mem::take(&mut resolver.verifier_store),
        std::mem::take(&mut resolver.grant_repository),
        std::mem::replace(
            &mut resolver.challenge_store,
            MemoryReconnectChallengeStore::new(Box::new(OsRandomSource)),
        ),
        std::mem::take(&mut resolver.audit_sink),
        MemoryPeerRevocationBroadcaster::default(),
    );
    let event = controller
        .revoke(&selector, &reason_code, revoked_at_ms)
        .await;
    let resolver = authority.resolver_mut();
    resolver.verifier_store = controller.verifier_store;
    resolver.grant_repository = controller.grant_repository;
    resolver.challenge_store = controller.challenge_store;
    resolver.audit_sink = controller.audit_sink;
    to_value(&event.map_err(to_error)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selector() -> PeerRelationshipSelector {
        PeerRelationshipSelector {
            token_id: "token-a".to_owned(),
            claimant_peer_id: "peer-a".to_owned(),
            verifier_peer_id: "peer-host".to_owned(),
            room_name: "lab-room".to_owned(),
        }
    }

    fn grant() -> LocalPeerGrantV1 {
        LocalPeerGrantV1 {
            version: 1,
            grant_id: "grant-a".to_owned(),
            token_id: "token-a".to_owned(),
            claimant_peer_id: "peer-a".to_owned(),
            verifier_peer_id: "peer-host".to_owned(),
            room_name: "lab-room".to_owned(),
            allowed_method_ids: vec!["Tooling.GetTools".to_owned()],
            allowed_tool_contract_ids: Vec::new(),
            capability_pack_ids: Vec::new(),
            resource_scopes: Vec::new(),
            created_at_ms: 1_000,
            expires_at_ms: None,
            revoked_at_ms: None,
            grant_revision: 3,
        }
    }

    fn context(claimant: &str) -> aurora_mesh_authority::authority::AuthenticatedPeerContext {
        aurora_mesh_authority::authority::AuthenticatedPeerContext {
            selector: PeerRelationshipSelector {
                claimant_peer_id: claimant.to_owned(),
                ..selector()
            },
            transport: aurora_mesh_authority::authority::ReconnectTransportAttestation {
                channel_binding: "b".repeat(64),
                claimant_signaling_peer_id: "sig-a".to_owned(),
                verifier_signaling_peer_id: "sig-host".to_owned(),
            },
            connection_epoch: None,
            credential_revision: 1,
            authenticated_at_ms: 500,
        }
    }

    fn authorize_request(remote_peer_id: &str, claimant: &str) -> PeerHostAuthorizeRequest {
        PeerHostAuthorizeRequest {
            remote_peer_id: remote_peer_id.to_owned(),
            method_id: "Tooling.GetTools".to_owned(),
            required_permissions: Vec::new(),
            identity: aurora_mesh_authority::types::PeerHostIdentity {
                caller_peer_id: remote_peer_id.to_owned(),
                ..Default::default()
            },
            authenticated_peer_context: Some(context(claimant)),
            now_ms: 2_000,
        }
    }

    /// The command bodies, exercised without a Tauri app handle.
    async fn hydrated() -> NativeAuthority {
        let mut authority = new_authority();
        authority
            .resolver_mut()
            .grant_repository
            .upsert_grant(grant())
            .await
            .expect("grant is valid");
        authority
    }

    #[tokio::test]
    async fn authorizes_a_peer_with_a_covering_grant() {
        let mut authority = hydrated().await;
        let decision = authority
            .authorize(&authorize_request("peer-a", "peer-a"))
            .await
            .expect("authority answers");
        assert!(decision.allowed);
        assert_eq!(decision.grant_revision, Some(3));
    }

    /// Invariant: authority contexts never cross peers.
    #[tokio::test]
    async fn refuses_a_context_belonging_to_another_peer() {
        let mut authority = hydrated().await;
        let decision = authority
            .authorize(&authorize_request("peer-b", "peer-a"))
            .await
            .expect("authority answers");
        assert!(!decision.allowed);
        assert_eq!(decision.reason_code.as_deref(), Some("selector_mismatch"));
    }

    /// Invariant: room membership is not authority.
    #[tokio::test]
    async fn refuses_a_peer_with_no_grant() {
        let mut authority = new_authority();
        let decision = authority
            .authorize(&authorize_request("peer-a", "peer-a"))
            .await
            .expect("authority answers");
        assert!(!decision.allowed);
        assert_eq!(decision.reason_code.as_deref(), Some("grant_not_found"));
    }

    /// The camelCase shapes the shell sends must deserialize into the commands.
    #[test]
    fn hydrate_request_accepts_the_shell_payload() {
        let request: MeshAuthorityHydrateRequest = serde_json::from_value(serde_json::json!({
            "verifiers": [],
            "grants": [{
                "version": 1,
                "grantId": "grant-a",
                "tokenId": "token-a",
                "claimantPeerId": "peer-a",
                "verifierPeerId": "peer-host",
                "roomName": "lab-room",
                "allowedMethodIds": ["Tooling.GetTools"],
                "allowedToolContractIds": [],
                "capabilityPackIds": [],
                "resourceScopes": [],
                "createdAtMs": 1000,
                "grantRevision": 3
            }]
        }))
        .expect("hydrate payload deserializes");
        assert_eq!(request.grants.len(), 1);
    }

    #[test]
    fn authorize_request_accepts_the_shell_payload() {
        let request: PeerHostAuthorizeRequest = serde_json::from_value(serde_json::json!({
            "remotePeerId": "peer-a",
            "methodId": "Tooling.GetTools",
            "requiredPermissions": [],
            "identity": { "callerPeerId": "peer-a", "effectivePermissions": [] },
            "nowMs": 2000
        }))
        .expect("authorize payload deserializes");
        assert_eq!(request.remote_peer_id, "peer-a");
    }
}
