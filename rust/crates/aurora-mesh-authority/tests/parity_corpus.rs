//! Drive the Rust authority from the shared parity corpus.
//!
//! The corpus is `tests/fixtures/mesh_authority_parity_vectors.json`, generated
//! by `scripts/generate_mesh_authority_fixtures.py` and consumed unchanged by
//! `packages/aurora-sdk/tests/mesh-authority-parity-vectors.test.ts`. While both
//! authorities exist they answer the same questions from the same file, so a
//! divergence fails here or there rather than in production.
//!
//! Every section asserts a non-zero case count, so a corpus that silently loses
//! its cases fails instead of passing vacuously.

use std::path::PathBuf;

use aurora_mesh_authority::authority::{
    AuthenticatedPeerContext, AuthorityError, AuthorityResult, InboundCredentialVerifierStore,
    LocalPeerCredentialVerifierV1, LocalPeerGrantV1, MemoryInboundCredentialVerifierStore,
    MemoryPeerAuditSink, MemoryPeerGrantRepository, MemoryReconnectChallengeStore,
    PeerAuthorityResolver, PeerGrantRepository, PeerGrantResolutionRequest,
    PeerPairingIssueOptions, PeerPairingIssuer, PeerRelationshipIdentity, PeerRelationshipSelector,
    RandomSource, ReconnectChallengeStore, ReconnectTransportAttestation,
};
use aurora_mesh_authority::authorization::{
    PeerAuthorityHostAuthorizationStore, SessionPeerHostAuthorizationStore,
};
use aurora_mesh_authority::contract_registry::{
    generated_peer_host_event_descriptor, generated_peer_host_method_descriptor,
    GeneratedPeerHostEventRegistrationOptions, GeneratedPeerHostRegistrationOptions,
    TtsAudioChunkEmissionValidator, AURORA_BACKEND_CONTRACT_VERSION,
};
use aurora_mesh_authority::crypto::{
    build_mesh_reconnect_proof_message, bytes_to_hex, compute_reconnect_proof_hex, sha256,
    verify_reconnect_proof_hex, ReconnectProofInput,
};
use aurora_mesh_authority::grant_management::{
    normalize_selection, PeerGrantSelection, DEFAULT_MAX_EXPIRY_WINDOW_MS,
};
use aurora_mesh_authority::types::{
    PeerHostAuthorizationStore, PeerHostAuthorizeRequest, PeerHostIdentity,
    PeerHostManifestAuthorityRequest, REASON_CODES,
};
use serde_json::Value;

/// The bytes the corpus expects [`MemoryReconnectChallengeStore`] to draw.
struct FixedRandomSource(u8);

impl RandomSource for FixedRandomSource {
    fn random_bytes(&self, length: usize) -> AuthorityResult<Vec<u8>> {
        Ok(vec![self.0; length])
    }
}

struct FailingRandomSource;

impl RandomSource for FailingRandomSource {
    fn random_bytes(&self, _length: usize) -> AuthorityResult<Vec<u8>> {
        Err(AuthorityError::RandomSourceUnavailable)
    }
}

fn corpus() -> Value {
    let path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("tests/fixtures/mesh_authority_parity_vectors.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text).expect("corpus is valid JSON")
}

fn section<'a>(document: &'a Value, name: &str) -> &'a Value {
    document
        .get(name)
        .unwrap_or_else(|| panic!("corpus is missing section {name}"))
}

fn cases<'a>(node: &'a Value, name: &str) -> &'a Vec<Value> {
    node.get(name)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("corpus section is missing case list {name}"))
}

fn case_name(case: &Value) -> String {
    case.get("name")
        .and_then(Value::as_str)
        .unwrap_or("<unnamed>")
        .to_owned()
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value, what: &str) -> T {
    serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("corpus {what} does not deserialize: {error}"))
}

fn selector_of(case: &Value, pointer: &str) -> PeerRelationshipSelector {
    parse(
        case.pointer(pointer)
            .unwrap_or_else(|| panic!("corpus case has no selector at {pointer}")),
        "selector",
    )
}

fn transport_of(case: &Value, pointer: &str) -> ReconnectTransportAttestation {
    parse(
        case.pointer(pointer)
            .unwrap_or_else(|| panic!("corpus case has no transport at {pointer}")),
        "transport",
    )
}

fn grants_of(case: &Value) -> Vec<LocalPeerGrantV1> {
    case.get("grants")
        .and_then(Value::as_array)
        .map(|values| values.iter().map(|value| parse(value, "grant")).collect())
        .unwrap_or_default()
}

fn expected_str(expected: &Value, key: &str) -> Option<String> {
    expected.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn expected_i64(expected: &Value, key: &str) -> Option<i64> {
    expected.get(key).and_then(Value::as_i64)
}

fn expected_strings(expected: &Value, key: &str) -> Option<Vec<String>> {
    expected.get(key).and_then(Value::as_array).map(|values| {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

fn now_ms(node: &Value) -> i64 {
    node.get("nowMs")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("corpus node has no nowMs"))
}

async fn seeded_repository(grants: &[LocalPeerGrantV1]) -> MemoryPeerGrantRepository {
    let mut repository = MemoryPeerGrantRepository::new();
    for grant in grants {
        repository
            .upsert_grant(grant.clone())
            .await
            .expect("corpus grants are valid");
    }
    repository
}

fn verifier_for(
    selector: &PeerRelationshipSelector,
    credential_revision: i64,
    revoked_at_ms: Option<i64>,
) -> LocalPeerCredentialVerifierV1 {
    LocalPeerCredentialVerifierV1 {
        version: 1,
        token_id: selector.token_id.clone(),
        claimant_peer_id: selector.claimant_peer_id.clone(),
        verifier_peer_id: selector.verifier_peer_id.clone(),
        room_name: selector.room_name.clone(),
        token_hash_hex: "a".repeat(64),
        created_at_ms: 1_000,
        expires_at_ms: None,
        revoked_at_ms,
        credential_revision,
    }
}

fn grant_for(
    selector: &PeerRelationshipSelector,
    grant_id: &str,
    grant_revision: i64,
    revoked_at_ms: Option<i64>,
) -> LocalPeerGrantV1 {
    LocalPeerGrantV1 {
        version: 1,
        grant_id: grant_id.to_owned(),
        token_id: selector.token_id.clone(),
        claimant_peer_id: selector.claimant_peer_id.clone(),
        verifier_peer_id: selector.verifier_peer_id.clone(),
        room_name: selector.room_name.clone(),
        allowed_method_ids: vec!["Tooling.GetTools".to_owned()],
        allowed_tool_contract_ids: Vec::new(),
        capability_pack_ids: Vec::new(),
        resource_scopes: Vec::new(),
        created_at_ms: 1_000,
        expires_at_ms: None,
        revoked_at_ms,
        grant_revision,
    }
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn stale_verifier_upsert_cannot_resurrect_a_revoked_credential() {
    let selector = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let mut store = MemoryInboundCredentialVerifierStore::new();
    store
        .upsert_verifier(verifier_for(&selector, 1, None))
        .await
        .expect("initial verifier is valid");
    store
        .revoke_verifier(&selector, 2_000)
        .await
        .expect("verifier revoke succeeds");

    store
        .upsert_verifier(verifier_for(&selector, 1, None))
        .await
        .expect("stale hydrate row is valid but ignored");
    assert!(
        store
            .get_verifier(&selector, 3_000)
            .await
            .expect("verifier read succeeds")
            .is_none(),
        "lower-revision verifier resurrected a revoked credential"
    );

    store
        .upsert_verifier(verifier_for(&selector, 2, None))
        .await
        .expect("equal hydrate row is valid but ignored");
    assert!(
        store
            .get_verifier(&selector, 3_000)
            .await
            .expect("verifier read succeeds")
            .is_none(),
        "equal-revision verifier resurrected a revoked credential"
    );
}

#[tokio::test]
async fn newer_verifier_revision_can_replace_a_revoked_credential() {
    let selector = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let mut store = MemoryInboundCredentialVerifierStore::new();
    store
        .upsert_verifier(verifier_for(&selector, 1, None))
        .await
        .expect("initial verifier is valid");
    store
        .revoke_verifier(&selector, 2_000)
        .await
        .expect("verifier revoke succeeds");

    store
        .upsert_verifier(verifier_for(&selector, 3, None))
        .await
        .expect("newer credential revision is accepted");
    let live = store
        .get_verifier(&selector, 3_000)
        .await
        .expect("verifier read succeeds")
        .expect("newer verifier is live");
    assert_eq!(live.credential_revision, 3);
}

#[tokio::test]
async fn stale_grant_upsert_cannot_resurrect_a_revoked_grant() {
    let selector = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let mut repository = MemoryPeerGrantRepository::new();
    repository
        .upsert_grant(grant_for(&selector, "grant-a", 1, None))
        .await
        .expect("initial grant is valid");
    repository
        .revoke_grants(&selector, 2_000)
        .await
        .expect("grant revoke succeeds");

    repository
        .upsert_grant(grant_for(&selector, "grant-a", 1, None))
        .await
        .expect("stale hydrate grant is valid but ignored");
    let denied = repository
        .resolve_grant(&PeerGrantResolutionRequest {
            selector: selector.clone(),
            method_id: Some("Tooling.GetTools".to_owned()),
            tool_contract_id: None,
            capability_pack_id: None,
            resource_scope: None,
            now_ms: 3_000,
        })
        .await
        .expect("grant resolution succeeds");
    assert!(!denied.allowed, "lower-revision grant resurrected access");
    assert_eq!(
        denied.reason_code,
        Some(aurora_mesh_authority::authority::PeerAuthorityDecisionReason::GrantRevoked)
    );

    repository
        .upsert_grant(grant_for(&selector, "grant-a", 2, None))
        .await
        .expect("equal hydrate grant is valid but ignored");
    let denied = repository
        .resolve_grant(&PeerGrantResolutionRequest {
            selector,
            method_id: Some("Tooling.GetTools".to_owned()),
            tool_contract_id: None,
            capability_pack_id: None,
            resource_scope: None,
            now_ms: 3_000,
        })
        .await
        .expect("grant resolution succeeds");
    assert!(!denied.allowed, "equal-revision grant resurrected access");
    assert_eq!(
        denied.reason_code,
        Some(aurora_mesh_authority::authority::PeerAuthorityDecisionReason::GrantRevoked)
    );
}

#[tokio::test]
async fn newer_grant_revision_can_replace_a_revoked_grant() {
    let selector = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let mut repository = MemoryPeerGrantRepository::new();
    repository
        .upsert_grant(grant_for(&selector, "grant-a", 1, None))
        .await
        .expect("initial grant is valid");
    repository
        .revoke_grants(&selector, 2_000)
        .await
        .expect("grant revoke succeeds");

    repository
        .upsert_grant(grant_for(&selector, "grant-a", 3, None))
        .await
        .expect("newer grant revision is accepted");
    let allowed = repository
        .resolve_grant(&PeerGrantResolutionRequest {
            selector,
            method_id: Some("Tooling.GetTools".to_owned()),
            tool_contract_id: None,
            capability_pack_id: None,
            resource_scope: None,
            now_ms: 3_000,
        })
        .await
        .expect("grant resolution succeeds");
    assert!(allowed.allowed);
    assert_eq!(allowed.grant.expect("covering grant").grant_revision, 3);
}

#[test]
fn corpus_declares_the_schema_and_is_synthetic() {
    let document = corpus();
    assert_eq!(
        document.get("schema").and_then(Value::as_str),
        Some("aurora.mesh.authority.parity_vectors.v1")
    );
    assert_eq!(
        document.get("synthetic").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn reason_code_vocabulary_has_not_drifted() {
    let document = corpus();
    let expected: Vec<String> = section(&document, "constants")
        .get("reasonCodes")
        .and_then(Value::as_array)
        .expect("corpus declares reasonCodes")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let actual: Vec<String> = REASON_CODES.iter().map(|code| (*code).to_owned()).collect();
    assert_eq!(actual, expected, "reason_code vocabulary drifted");
}

#[test]
fn error_codes_keep_their_http_shape() {
    use aurora_mesh_authority::types::error_code;
    let document = corpus();
    let codes = section(&document, "constants")
        .get("errorCodes")
        .expect("corpus declares errorCodes");
    let expect = |key: &str, actual: u16| {
        assert_eq!(
            codes.get(key).and_then(Value::as_u64),
            Some(u64::from(actual)),
            "{key} drifted"
        );
    };
    expect(
        "schemaValidationFailed",
        error_code::SCHEMA_VALIDATION_FAILED,
    );
    expect("notAuthorized", error_code::NOT_AUTHORIZED);
    expect("requestCancelled", error_code::REQUEST_CANCELLED);
    expect("handlerFailed", error_code::HANDLER_FAILED);
    expect("requestTimeout", error_code::REQUEST_TIMEOUT);
}

#[test]
fn reconnect_proof_vectors_match() {
    let document = corpus();
    let node = section(&document, "reconnectProof");
    let vectors = cases(node, "cases");
    assert!(!vectors.is_empty(), "corpus has no reconnect proof vectors");

    for case in vectors {
        let name = case_name(case);
        let selector = selector_of(case, "/selector");
        let transport = transport_of(case, "/transport");
        let challenge = case
            .get("challenge")
            .and_then(Value::as_str)
            .expect("case has a challenge");
        let bearer_token = case
            .get("bearerToken")
            .and_then(Value::as_str)
            .expect("case has a bearer token");
        let input = ReconnectProofInput {
            token_id: &selector.token_id,
            challenge,
            channel_binding: &transport.channel_binding,
            claimant_peer_id: &selector.claimant_peer_id,
            verifier_peer_id: &selector.verifier_peer_id,
            room_name: &selector.room_name,
        };

        assert_eq!(
            bytes_to_hex(&build_mesh_reconnect_proof_message(&input)),
            case.get("expectedMessageHex")
                .and_then(Value::as_str)
                .expect("case has expectedMessageHex"),
            "{name}: transcript bytes diverged"
        );
        assert_eq!(
            bytes_to_hex(&sha256(bearer_token.as_bytes())),
            case.get("expectedTokenHashHex")
                .and_then(Value::as_str)
                .expect("case has expectedTokenHashHex"),
            "{name}: token hash diverged"
        );
        assert_eq!(
            compute_reconnect_proof_hex(bearer_token, &input),
            case.get("expectedProofHex")
                .and_then(Value::as_str)
                .expect("case has expectedProofHex"),
            "{name}: proof diverged"
        );
    }

    let verifications = cases(node, "verify");
    assert!(!verifications.is_empty(), "corpus has no verify cases");
    for case in verifications {
        let name = case_name(case);
        let selector = selector_of(case, "/selector");
        let transport = transport_of(case, "/transport");
        let ok = verify_reconnect_proof_hex(
            case.get("tokenHashHex")
                .and_then(Value::as_str)
                .expect("case has tokenHashHex"),
            case.get("proofHex")
                .and_then(Value::as_str)
                .expect("case has proofHex"),
            &ReconnectProofInput {
                token_id: &selector.token_id,
                challenge: case
                    .get("challenge")
                    .and_then(Value::as_str)
                    .expect("case has a challenge"),
                channel_binding: &transport.channel_binding,
                claimant_peer_id: &selector.claimant_peer_id,
                verifier_peer_id: &selector.verifier_peer_id,
                room_name: &selector.room_name,
            },
        );
        assert_eq!(
            ok,
            case.get("expected")
                .and_then(Value::as_bool)
                .expect("expected"),
            "{name}: verification diverged"
        );
    }
}

#[tokio::test]
async fn grant_resolution_matches() {
    let document = corpus();
    let vectors = cases(section(&document, "grantResolution"), "cases");
    assert!(!vectors.is_empty(), "corpus has no grant resolution cases");

    for case in vectors {
        let name = case_name(case);
        let repository = seeded_repository(&grants_of(case)).await;
        let request_node = case.get("request").expect("case has a request");
        let request = PeerGrantResolutionRequest {
            selector: selector_of(case, "/request/selector"),
            method_id: expected_str(request_node, "methodId"),
            tool_contract_id: expected_str(request_node, "toolContractId"),
            capability_pack_id: expected_str(request_node, "capabilityPackId"),
            resource_scope: expected_str(request_node, "resourceScope"),
            now_ms: now_ms(request_node),
        };
        let decision = repository
            .resolve_grant(&request)
            .await
            .expect("in-memory repository never fails");
        let expected = case.get("expected").expect("case has an expectation");

        assert_eq!(
            decision.allowed,
            expected
                .get("allowed")
                .and_then(Value::as_bool)
                .expect("allowed"),
            "{name}: allowed diverged"
        );
        assert_eq!(
            decision
                .reason_code
                .map(|reason| reason.as_str().to_owned()),
            expected_str(expected, "reasonCode"),
            "{name}: reasonCode diverged"
        );
        assert_eq!(
            decision.grant.map(|grant| grant.grant_id),
            expected_str(expected, "grantId"),
            "{name}: covering grant diverged"
        );
    }
}

fn authorize_request(case: &Value, request_node: &Value) -> PeerHostAuthorizeRequest {
    let remote_peer_id = request_node
        .get("remotePeerId")
        .and_then(Value::as_str)
        .expect("request has remotePeerId")
        .to_owned();
    let authenticated_peer_context: Option<AuthenticatedPeerContext> = case
        .pointer("/request/authenticatedPeerContext")
        .map(|value| parse(value, "authenticated peer context"));
    PeerHostAuthorizeRequest {
        method_id: request_node
            .get("methodId")
            .and_then(Value::as_str)
            .expect("request has methodId")
            .to_owned(),
        required_permissions: Vec::new(),
        identity: PeerHostIdentity {
            caller_peer_id: remote_peer_id.clone(),
            ..PeerHostIdentity::default()
        },
        authenticated_peer_context,
        now_ms: now_ms(request_node),
        remote_peer_id,
    }
}

fn assert_decision(
    name: &str,
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
    expected: &Value,
) {
    assert_eq!(
        decision.allowed,
        expected
            .get("allowed")
            .and_then(Value::as_bool)
            .expect("allowed"),
        "{name}: allowed diverged"
    );
    assert_eq!(
        decision.reason_code,
        expected_str(expected, "reasonCode"),
        "{name}: reasonCode diverged"
    );
    assert_eq!(
        decision.grant_revision,
        expected_i64(expected, "grantRevision"),
        "{name}: grantRevision diverged"
    );
    assert_eq!(
        decision.granted_method_ids,
        expected_strings(expected, "grantedMethodIds"),
        "{name}: grantedMethodIds diverged"
    );
}

#[tokio::test]
async fn session_authorization_matches() {
    let document = corpus();
    let vectors = cases(section(&document, "sessionAuthorize"), "cases");
    assert!(!vectors.is_empty(), "corpus has no session authorize cases");

    for case in vectors {
        let name = case_name(case);
        let mut store = SessionPeerHostAuthorizationStore::new(grants_of(case))
            .expect("corpus grants are valid");
        let request = authorize_request(case, case.get("request").expect("case has a request"));
        let decision = store
            .authorize(&request)
            .await
            .expect("session store never fails");
        assert_decision(&name, &decision, case.get("expected").expect("expected"));
    }
}

async fn authority_store(
    grants: &[LocalPeerGrantV1],
) -> PeerAuthorityHostAuthorizationStore<
    MemoryInboundCredentialVerifierStore,
    MemoryPeerGrantRepository,
    MemoryReconnectChallengeStore,
    MemoryPeerAuditSink,
> {
    PeerAuthorityHostAuthorizationStore::new(PeerAuthorityResolver::new(
        MemoryInboundCredentialVerifierStore::new(),
        seeded_repository(grants).await,
        MemoryReconnectChallengeStore::new(Box::new(FixedRandomSource(0x11))),
        MemoryPeerAuditSink::default(),
    ))
}

#[tokio::test]
async fn authority_authorization_matches() {
    let document = corpus();
    let vectors = cases(section(&document, "authorityAuthorize"), "cases");
    assert!(
        !vectors.is_empty(),
        "corpus has no authority authorize cases"
    );

    for case in vectors {
        let name = case_name(case);
        let mut store = authority_store(&grants_of(case)).await;
        let request = authorize_request(case, case.get("request").expect("case has a request"));
        let decision = store
            .authorize(&request)
            .await
            .expect("authority store never fails");
        assert_decision(&name, &decision, case.get("expected").expect("expected"));
    }
}

#[tokio::test]
async fn manifest_snapshots_match() {
    let document = corpus();
    let node = section(&document, "manifestSnapshot");

    for case in cases(node, "session") {
        let name = case_name(case);
        let mut store = SessionPeerHostAuthorizationStore::new(grants_of(case))
            .expect("corpus grants are valid");
        let request_node = case.get("request").expect("case has a request");
        let snapshot = store
            .snapshot_manifest_authority(&PeerHostManifestAuthorityRequest {
                remote_peer_id: expected_str(request_node, "remotePeerId"),
                authenticated_peer_context: request_node
                    .get("authenticatedPeerContext")
                    .map(|value| parse(value, "authenticated peer context")),
                now_ms: now_ms(request_node),
                correlation_id: None,
            })
            .await
            .expect("session store never fails");
        let expected = case.get("expected").expect("expected");
        assert_eq!(
            snapshot.recipient_peer_id,
            expected_str(expected, "recipientPeerId"),
            "{name}: recipientPeerId diverged"
        );
        assert_eq!(
            Some(snapshot.granted_method_ids),
            expected_strings(expected, "grantedMethodIds"),
            "{name}: grantedMethodIds diverged"
        );
        assert_eq!(
            snapshot.auth_grant_revision,
            expected_i64(expected, "authGrantRevision").expect("authGrantRevision"),
            "{name}: authGrantRevision diverged"
        );
        assert_eq!(
            snapshot.auth_grant_state.as_str(),
            expected_str(expected, "authGrantState")
                .expect("authGrantState")
                .as_str(),
            "{name}: authGrantState diverged"
        );
    }

    for case in cases(node, "authority") {
        let name = case_name(case);
        let mut store = authority_store(&grants_of(case)).await;
        let request_node = case.get("request").expect("case has a request");
        let snapshot = store
            .snapshot_manifest_authority(&PeerHostManifestAuthorityRequest {
                remote_peer_id: expected_str(request_node, "remotePeerId"),
                authenticated_peer_context: request_node
                    .get("authenticatedPeerContext")
                    .map(|value| parse(value, "authenticated peer context")),
                now_ms: now_ms(request_node),
                correlation_id: None,
            })
            .await
            .expect("authority store never fails");
        let expected = case.get("expected").expect("expected");
        assert_eq!(
            snapshot.recipient_peer_id,
            expected_str(expected, "recipientPeerId"),
            "{name}: recipientPeerId diverged"
        );
        assert_eq!(
            Some(snapshot.granted_method_ids),
            expected_strings(expected, "grantedMethodIds"),
            "{name}: grantedMethodIds diverged"
        );
        assert_eq!(
            snapshot.granted_permissions,
            expected_strings(expected, "grantedPermissions"),
            "{name}: grantedPermissions diverged"
        );
        assert_eq!(
            snapshot.auth_grant_revision,
            expected_i64(expected, "authGrantRevision").expect("authGrantRevision"),
            "{name}: authGrantRevision diverged"
        );
        assert_eq!(
            snapshot.auth_grant_state.as_str(),
            expected_str(expected, "authGrantState")
                .expect("authGrantState")
                .as_str(),
            "{name}: authGrantState diverged"
        );
    }
}

#[tokio::test]
async fn reconnect_challenge_replay_guard_matches() {
    let document = corpus();
    let node = section(&document, "reconnectChallenge");
    let vectors = cases(node, "cases");
    assert!(
        !vectors.is_empty(),
        "corpus has no reconnect challenge cases"
    );

    let challenge_bytes_hex = node
        .get("challengeBytesHex")
        .and_then(Value::as_str)
        .expect("corpus declares challengeBytesHex");

    for case in vectors {
        let name = case_name(case);
        let mut store = MemoryReconnectChallengeStore::new(Box::new(FixedRandomSource(0x11)));
        let issue_node = case.get("issue").expect("case has an issue");
        let identity: PeerRelationshipIdentity =
            parse(issue_node.get("identity").expect("identity"), "identity");
        let issued = store
            .issue_challenge(
                &identity,
                &transport_of(case, "/issue/transport"),
                now_ms(issue_node),
            )
            .await
            .expect("issuing a challenge succeeds");
        assert_eq!(
            issued.challenge, challenge_bytes_hex,
            "{name}: issued challenge diverged from the corpus"
        );

        for step in case
            .get("steps")
            .and_then(Value::as_array)
            .expect("case has steps")
        {
            let action = step
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("consume");
            if action == "reject" {
                store
                    .reject_challenges(&identity, now_ms(step))
                    .await
                    .expect("rejecting challenges succeeds");
                continue;
            }
            let challenge = step
                .get("challenge")
                .and_then(Value::as_str)
                .expect("step has a challenge");
            let challenge = if challenge == "ISSUED" {
                issued.challenge.as_str()
            } else {
                challenge
            };
            let result = store
                .consume_challenge(
                    challenge,
                    &parse(step.get("selector").expect("selector"), "selector"),
                    &parse(step.get("transport").expect("transport"), "transport"),
                    now_ms(step),
                )
                .await
                .expect("consuming a challenge succeeds");
            assert_eq!(
                result.status.as_str(),
                step.get("expectedStatus")
                    .and_then(Value::as_str)
                    .expect("step has expectedStatus"),
                "{name}: challenge status diverged"
            );
        }
    }
}

#[test]
fn grant_selection_normalization_matches() {
    let document = corpus();
    let vectors = cases(section(&document, "grantSelection"), "cases");
    assert!(!vectors.is_empty(), "corpus has no grant selection cases");

    for case in vectors {
        let name = case_name(case);
        let selection: PeerGrantSelection =
            parse(case.get("selection").expect("selection"), "selection");
        let expected = case.get("expected").expect("expected");
        let outcome = normalize_selection(&selection, now_ms(case), DEFAULT_MAX_EXPIRY_WINDOW_MS);

        if expected.get("ok").and_then(Value::as_bool) == Some(true) {
            let normalized =
                outcome.unwrap_or_else(|error| panic!("{name}: expected an allow, got {error}"));
            let want = expected.get("normalized").expect("normalized");
            assert_eq!(
                Some(normalized.allowed_method_ids),
                expected_strings(want, "allowedMethodIds"),
                "{name}: allowedMethodIds diverged"
            );
            assert_eq!(
                Some(normalized.allowed_tool_contract_ids),
                expected_strings(want, "allowedToolContractIds"),
                "{name}: allowedToolContractIds diverged"
            );
            assert_eq!(
                Some(normalized.capability_pack_ids),
                expected_strings(want, "capabilityPackIds"),
                "{name}: capabilityPackIds diverged"
            );
            assert_eq!(
                Some(normalized.resource_scopes),
                expected_strings(want, "resourceScopes"),
                "{name}: resourceScopes diverged"
            );
            assert_eq!(
                normalized.expires_at_ms,
                expected_i64(want, "expiresAtMs"),
                "{name}: expiresAtMs diverged"
            );
            continue;
        }

        let error = outcome
            .err()
            .unwrap_or_else(|| panic!("{name}: expected a refusal, got an allow"));
        assert_eq!(
            error.code.as_str(),
            expected_str(expected, "code").expect("code").as_str(),
            "{name}: refusal code diverged"
        );
        assert_eq!(
            error.message,
            expected_str(expected, "message").expect("message"),
            "{name}: refusal copy diverged"
        );
    }
}

#[test]
fn execution_policy_matches() {
    let document = corpus();
    let node = section(&document, "executionPolicy");

    assert_eq!(
        node.pointer("/defaults/serviceVersion")
            .and_then(Value::as_str),
        Some(AURORA_BACKEND_CONTRACT_VERSION),
        "advertised contract version drifted"
    );

    let methods = cases(node, "methods");
    assert!(!methods.is_empty(), "corpus has no execution policy cases");
    for case in methods {
        let name = case_name(case);
        let method_id = case
            .get("methodId")
            .and_then(Value::as_str)
            .expect("case has methodId");
        let descriptor = generated_peer_host_method_descriptor(
            method_id,
            &GeneratedPeerHostRegistrationOptions::default(),
        )
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        let actual = serde_json::to_value(&descriptor).expect("descriptor serializes");
        let expected = case.get("expected").expect("expected");
        assert_eq!(&actual, expected, "{name}: execution policy diverged");
    }

    let blocked = cases(node, "blockedMethods");
    assert!(!blocked.is_empty(), "corpus has no blocked method cases");
    for case in blocked {
        let name = case_name(case);
        let method_id = case
            .get("methodId")
            .and_then(Value::as_str)
            .expect("case has methodId");
        let error = generated_peer_host_method_descriptor(
            method_id,
            &GeneratedPeerHostRegistrationOptions::default(),
        )
        .err()
        .unwrap_or_else(|| panic!("{name}: a blocked method was projected"));
        assert_eq!(
            error.to_string(),
            expected_str(case, "expectedError").expect("expectedError"),
            "{name}: refusal copy diverged"
        );
    }

    let events = cases(node, "events");
    assert!(!events.is_empty(), "corpus has no event policy cases");
    for case in events {
        let name = case_name(case);
        let topic = case
            .get("topic")
            .and_then(Value::as_str)
            .expect("case has topic");
        let descriptor = generated_peer_host_event_descriptor(
            topic,
            &GeneratedPeerHostEventRegistrationOptions::default(),
        )
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        let actual = serde_json::to_value(&descriptor).expect("descriptor serializes");
        assert_eq!(
            &actual,
            case.get("expected").expect("expected"),
            "{name}: event policy diverged"
        );
    }
}

#[test]
fn tts_emission_validator_matches() {
    let document = corpus();
    let vectors = cases(section(&document, "ttsEmission"), "cases");
    assert!(!vectors.is_empty(), "corpus has no TTS emission cases");

    for case in vectors {
        let name = case_name(case);
        let correlation_id = case.get("correlationId").and_then(Value::as_str);
        let mut validator = TtsAudioChunkEmissionValidator::new();
        for (index, event) in case
            .get("events")
            .and_then(Value::as_array)
            .expect("case has events")
            .iter()
            .enumerate()
        {
            let payload = event.get("payload").expect("event has a payload");
            let outcome = validator.validate(payload, correlation_id);
            let expected_error = event.get("expectedError").and_then(Value::as_str);
            match expected_error {
                None => assert!(
                    outcome.is_ok(),
                    "{name}[{index}]: expected an accept, got {outcome:?}"
                ),
                Some(message) => {
                    let error = outcome
                        .err()
                        .unwrap_or_else(|| panic!("{name}[{index}]: expected a refusal"));
                    assert_eq!(
                        error.to_string(),
                        message,
                        "{name}[{index}]: refusal copy diverged"
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Invariants that must fail loudly
// ---------------------------------------------------------------------------

/// Invariant: authority contexts never cross peers.
///
/// The corpus already pins the decisions; this pins the *shape*. An
/// authenticated context carries a selector and a transport attestation and
/// nothing that names a connection, so there is no handle for one peer's
/// session to reach another's authority through.
#[tokio::test]
async fn authority_holds_no_transport_state() {
    let context = AuthenticatedPeerContext {
        selector: PeerRelationshipSelector {
            token_id: "token-a".to_owned(),
            claimant_peer_id: "peer-a".to_owned(),
            verifier_peer_id: "peer-host".to_owned(),
            room_name: "lab-room".to_owned(),
        },
        transport: ReconnectTransportAttestation {
            channel_binding: "b".repeat(64),
            claimant_signaling_peer_id: "sig-a".to_owned(),
            verifier_signaling_peer_id: "sig-host".to_owned(),
        },
        connection_epoch: None,
        credential_revision: 1,
        authenticated_at_ms: 500,
    };
    let encoded = serde_json::to_value(&context).expect("context serializes");
    let members: Vec<&str> = encoded
        .as_object()
        .expect("context is an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        members,
        vec![
            "authenticatedAtMs",
            "credentialRevision",
            "selector",
            "transport"
        ],
        "an authenticated context grew a member; check it is not transport state"
    );

    // And the decision for peer A's proven context, presented on a frame from
    // peer B, is a refusal — not peer A's grant.
    let grant = LocalPeerGrantV1 {
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
        grant_revision: 1,
    };
    let mut store = authority_store(&[grant]).await;
    let decision = store
        .authorize(&PeerHostAuthorizeRequest {
            remote_peer_id: "peer-b".to_owned(),
            method_id: "Tooling.GetTools".to_owned(),
            required_permissions: Vec::new(),
            identity: PeerHostIdentity {
                caller_peer_id: "peer-b".to_owned(),
                ..PeerHostIdentity::default()
            },
            authenticated_peer_context: Some(context),
            now_ms: 2_000,
        })
        .await
        .expect("authority store never fails");
    assert!(!decision.allowed);
    assert_eq!(decision.reason_code.as_deref(), Some("selector_mismatch"));
}

/// Invariant: room membership is not authority.
///
/// A peer holding a live credential for the room, with no grant, gets nothing.
#[tokio::test]
async fn a_credential_without_a_grant_authorizes_nothing() {
    let mut verifiers = MemoryInboundCredentialVerifierStore::new();
    let selector = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    verifiers
        .upsert_verifier(
            aurora_mesh_authority::authority::LocalPeerCredentialVerifierV1 {
                version: 1,
                token_id: selector.token_id.clone(),
                claimant_peer_id: selector.claimant_peer_id.clone(),
                verifier_peer_id: selector.verifier_peer_id.clone(),
                room_name: selector.room_name.clone(),
                token_hash_hex: "a".repeat(64),
                created_at_ms: 1_000,
                expires_at_ms: None,
                revoked_at_ms: None,
                credential_revision: 1,
            },
        )
        .await
        .expect("verifier is valid");

    let mut store = PeerAuthorityHostAuthorizationStore::new(PeerAuthorityResolver::new(
        verifiers,
        MemoryPeerGrantRepository::new(),
        MemoryReconnectChallengeStore::new(Box::new(FixedRandomSource(0x11))),
        MemoryPeerAuditSink::default(),
    ));
    let decision = store
        .authorize(&PeerHostAuthorizeRequest {
            remote_peer_id: "peer-a".to_owned(),
            method_id: "Tooling.GetTools".to_owned(),
            required_permissions: Vec::new(),
            identity: PeerHostIdentity {
                caller_peer_id: "peer-a".to_owned(),
                ..PeerHostIdentity::default()
            },
            authenticated_peer_context: Some(AuthenticatedPeerContext {
                selector,
                transport: ReconnectTransportAttestation {
                    channel_binding: "b".repeat(64),
                    claimant_signaling_peer_id: "sig-a".to_owned(),
                    verifier_signaling_peer_id: "sig-host".to_owned(),
                },
                connection_epoch: None,
                credential_revision: 1,
                authenticated_at_ms: 500,
            }),
            now_ms: 2_000,
        })
        .await
        .expect("authority store never fails");
    assert!(
        !decision.allowed,
        "a paired peer with no grant was authorized"
    );
    assert_eq!(decision.reason_code.as_deref(), Some("grant_not_found"));
}

/// Invariant: reconnect challenges stay single-use per peer.
///
/// Beyond the corpus case, this asserts the guard is *per peer*: peer B cannot
/// spend a challenge issued to peer A, and consuming peer A's does not consume
/// peer B's.
#[tokio::test]
async fn reconnect_challenges_are_single_use_per_peer() {
    struct Counter(std::sync::atomic::AtomicU8);
    impl RandomSource for Counter {
        fn random_bytes(&self, length: usize) -> AuthorityResult<Vec<u8>> {
            let value = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(vec![value; length])
        }
    }

    let mut store =
        MemoryReconnectChallengeStore::new(Box::new(Counter(std::sync::atomic::AtomicU8::new(1))));
    let transport = ReconnectTransportAttestation {
        channel_binding: "b".repeat(64),
        claimant_signaling_peer_id: "sig-a".to_owned(),
        verifier_signaling_peer_id: "sig-host".to_owned(),
    };
    let identity_a = PeerRelationshipIdentity {
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let identity_b = PeerRelationshipIdentity {
        claimant_peer_id: "peer-b".to_owned(),
        ..identity_a.clone()
    };

    let challenge_a = store
        .issue_challenge(&identity_a, &transport, 1_000)
        .await
        .expect("issue succeeds");
    let challenge_b = store
        .issue_challenge(&identity_b, &transport, 1_000)
        .await
        .expect("issue succeeds");
    assert_ne!(challenge_a.challenge, challenge_b.challenge);

    let selector_a = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let selector_b = PeerRelationshipSelector {
        claimant_peer_id: "peer-b".to_owned(),
        ..selector_a.clone()
    };

    // Peer B cannot spend peer A's challenge.
    let stolen = store
        .consume_challenge(&challenge_a.challenge, &selector_b, &transport, 1_100)
        .await
        .expect("consume succeeds");
    assert_eq!(stolen.status.as_str(), "selector_mismatch");

    // Peer A spends its own, once.
    assert_eq!(
        store
            .consume_challenge(&challenge_a.challenge, &selector_a, &transport, 1_100)
            .await
            .expect("consume succeeds")
            .status
            .as_str(),
        "accepted"
    );
    assert_eq!(
        store
            .consume_challenge(&challenge_a.challenge, &selector_a, &transport, 1_200)
            .await
            .expect("consume succeeds")
            .status
            .as_str(),
        "replay"
    );

    // Peer B's own challenge is untouched by any of that.
    assert_eq!(
        store
            .consume_challenge(&challenge_b.challenge, &selector_b, &transport, 1_300)
            .await
            .expect("consume succeeds")
            .status
            .as_str(),
        "accepted"
    );
}

#[tokio::test]
async fn random_source_failure_rejects_challenge_issue_without_panicking() {
    let identity = PeerRelationshipIdentity {
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let transport = ReconnectTransportAttestation {
        channel_binding: "b".repeat(64),
        claimant_signaling_peer_id: "sig-a".to_owned(),
        verifier_signaling_peer_id: "sig-host".to_owned(),
    };
    let mut store = MemoryReconnectChallengeStore::new(Box::new(FailingRandomSource));

    let error = store
        .issue_challenge(&identity, &transport, 1_000)
        .await
        .expect_err("random-source failure is returned");

    assert!(matches!(error, AuthorityError::RandomSourceUnavailable));
}

#[tokio::test]
async fn random_source_failure_rejects_pairing_issue_without_panicking() {
    let selector = PeerRelationshipSelector {
        token_id: "token-a".to_owned(),
        claimant_peer_id: "peer-a".to_owned(),
        verifier_peer_id: "peer-host".to_owned(),
        room_name: "lab-room".to_owned(),
    };
    let mut issuer = PeerPairingIssuer::new(
        MemoryInboundCredentialVerifierStore::new(),
        MemoryPeerAuditSink::default(),
        Box::new(FailingRandomSource),
    );

    let error = issuer
        .issue(&selector, &PeerPairingIssueOptions::default(), 1_000)
        .await
        .expect_err("random-source failure is returned");

    assert!(matches!(error, AuthorityError::RandomSourceUnavailable));
}

/// The corpus must keep carrying hostile cases, or it stops being a guard.
#[test]
fn the_corpus_carries_hostile_cases() {
    let document = corpus();
    let mut hostile = 0_usize;
    let mut total = 0_usize;
    let object = document.as_object().expect("corpus is an object");
    for value in object.values() {
        let Some(section) = value.as_object() else {
            continue;
        };
        for group in section.values() {
            let Some(list) = group.as_array() else {
                continue;
            };
            for case in list {
                if case.get("name").is_none() {
                    continue;
                }
                total += 1;
                if case.get("hostile").and_then(Value::as_bool) == Some(true) {
                    hostile += 1;
                }
            }
        }
    }
    assert!(total >= 100, "corpus shrank to {total} cases");
    assert!(hostile >= 60, "corpus carries only {hostile} hostile cases");
}
