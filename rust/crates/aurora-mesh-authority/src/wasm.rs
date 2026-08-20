//! `wasm-bindgen` boundary for the web build, following the
//! `aurora-voice-wasm` precedent: a `cdylib` whose bindings live behind
//! `cfg(target_arch = "wasm32")` so native builds carry none of it.
//!
//! ## What crosses this boundary
//!
//! Decisions, never storage. The authority holds its grants, verifiers and
//! challenges in memory and TypeScript hydrates it at session start from the
//! durable adapters it already owns —
//! `peer-host/local-data-authority-adapters.ts`, which is deliberately outside
//! this port. That keeps encryption-at-rest, IndexedDB and the local-data
//! commands where they are, and leaves Rust as the single place a permission
//! question is answered. The alternative — teaching Rust to call back into
//! IndexedDB — would move persistence across the seam for no decision benefit.
//!
//! Every method takes and returns plain JSON through `serde-wasm-bindgen`, in
//! the same camelCase shape the TypeScript types already use, so the calling
//! code changes its import and nothing else.

use wasm_bindgen::prelude::*;

use crate::authority::{
    IssueReconnectChallengeRequest, LocalPeerCredentialVerifierV1, LocalPeerGrantV1,
    MemoryInboundCredentialVerifierStore, MemoryPeerAuditSink, MemoryPeerGrantRepository,
    MemoryPeerRevocationBroadcaster, MemoryPeerRevocationController, MemoryReconnectChallengeStore,
    PeerAuthorityResolver, PeerGrantRepository, PeerRelationshipSelector, RandomSource,
    VerifyReconnectProofRequest,
};
use crate::authorization::PeerAuthorityHostAuthorizationStore;
use crate::contract_registry::{
    generated_peer_host_event_descriptor, generated_peer_host_method_descriptor,
    GeneratedPeerHostEventRegistrationOptions, GeneratedPeerHostRegistrationOptions,
    TtsAudioChunkEmissionValidator,
};
use crate::grant_management::{PeerGrantManager, PeerGrantSelection};
use crate::types::{
    PeerHostAuthorizationStore, PeerHostAuthorizeRequest, PeerHostManifestAuthorityRequest,
};

/// Bytes drawn from the host page's `crypto.getRandomValues`.
///
/// The authority never invents randomness of its own; the platform supplies it,
/// exactly as `webrtc/crypto.ts` does today.
struct JsRandomSource;

impl RandomSource for JsRandomSource {
    fn random_bytes(&self, length: usize) -> Vec<u8> {
        let mut out = vec![0_u8; length];
        getrandom_from_js(&mut out);
        out
    }
}

fn getrandom_from_js(out: &mut [u8]) {
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues)]
        fn get_random_values(target: &mut [u8]);
    }
    get_random_values(out);
}

fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn to_error<E: std::fmt::Display>(error: E) -> JsValue {
    JsValue::from_str(&error.to_string())
}

type WasmResolver = PeerAuthorityResolver<
    MemoryInboundCredentialVerifierStore,
    MemoryPeerGrantRepository,
    MemoryReconnectChallengeStore,
    MemoryPeerAuditSink,
>;

/// The mesh authority, as the web build sees it.
#[wasm_bindgen]
pub struct MeshAuthority {
    store: PeerAuthorityHostAuthorizationStore<
        MemoryInboundCredentialVerifierStore,
        MemoryPeerGrantRepository,
        MemoryReconnectChallengeStore,
        MemoryPeerAuditSink,
    >,
    tts_validators: std::collections::BTreeMap<String, TtsAudioChunkEmissionValidator>,
}

#[wasm_bindgen]
impl MeshAuthority {
    /// An authority with no credentials and no grants.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        let resolver: WasmResolver = PeerAuthorityResolver::new(
            MemoryInboundCredentialVerifierStore::new(),
            MemoryPeerGrantRepository::new(),
            MemoryReconnectChallengeStore::new(Box::new(JsRandomSource)),
            MemoryPeerAuditSink::default(),
        );
        Self {
            store: PeerAuthorityHostAuthorizationStore::new(resolver),
            tts_validators: std::collections::BTreeMap::new(),
        }
    }

    /// Load one durable credential verifier.
    #[wasm_bindgen(js_name = hydrateVerifier)]
    pub async fn hydrate_verifier(&mut self, verifier: JsValue) -> Result<(), JsValue> {
        let verifier: LocalPeerCredentialVerifierV1 = from_js(verifier)?;
        use crate::authority::InboundCredentialVerifierStore;
        self.store
            .resolver_mut()
            .verifier_store
            .upsert_verifier(verifier)
            .await
            .map_err(to_error)
    }

    /// Load one durable grant.
    #[wasm_bindgen(js_name = hydrateGrant)]
    pub async fn hydrate_grant(&mut self, grant: JsValue) -> Result<(), JsValue> {
        let grant: LocalPeerGrantV1 = from_js(grant)?;
        self.store
            .resolver_mut()
            .grant_repository
            .upsert_grant(grant)
            .await
            .map_err(to_error)
    }

    /// Mint a single-use reconnect challenge.
    #[wasm_bindgen(js_name = issueReconnectChallenge)]
    pub async fn issue_reconnect_challenge(
        &mut self,
        request: JsValue,
    ) -> Result<JsValue, JsValue> {
        let request: IssueReconnectChallengeRequest = from_js(request)?;
        let record = self
            .store
            .resolver_mut()
            .issue_reconnect_challenge(&request)
            .await
            .map_err(to_error)?;
        to_js(&record)
    }

    /// Check a reconnect proof and, on success, mint the authenticated context.
    #[wasm_bindgen(js_name = verifyReconnectProof)]
    pub async fn verify_reconnect_proof(&mut self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: VerifyReconnectProofRequest = from_js(request)?;
        let result = self
            .store
            .resolver_mut()
            .verify_reconnect_proof(&request)
            .await
            .map_err(to_error)?;
        to_js(&result)
    }

    /// Evaluate a grant across any of the four coverage dimensions.
    ///
    /// The local tool execution policy asks about tool contracts, capability
    /// packs and resource scopes as well as methods; without this it would have
    /// to decide coverage itself, which is the drift R2 exists to prevent.
    #[wasm_bindgen(js_name = resolveGrant)]
    pub async fn resolve_grant(
        &mut self,
        context: JsValue,
        dimensions: JsValue,
        now_ms: f64,
    ) -> Result<JsValue, JsValue> {
        let context: crate::authority::AuthenticatedPeerContext = from_js(context)?;
        let dimensions: crate::authority::GrantDimensions = from_js(dimensions)?;
        let decision = self
            .store
            .resolver_mut()
            .resolve_grant_dimensions(&context, &dimensions, now_ms as i64)
            .await
            .map_err(to_error)?;
        to_js(&decision)
    }

    /// Mint a bearer credential for a relationship at pairing time.
    #[wasm_bindgen(js_name = issuePairingCredential)]
    pub async fn issue_pairing_credential(
        &mut self,
        selector: JsValue,
        expires_at_ms: Option<f64>,
        now_ms: f64,
    ) -> Result<JsValue, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let resolver = self.store.resolver_mut();
        let mut issuer = crate::authority::PeerPairingIssuer::new(
            std::mem::take(&mut resolver.verifier_store),
            std::mem::take(&mut resolver.audit_sink),
            Box::new(JsRandomSource),
        );
        let issued = issuer
            .issue(
                &selector,
                &crate::authority::PeerPairingIssueOptions {
                    expires_at_ms: expires_at_ms.map(|value| value as i64),
                    feature_ids: None,
                },
                now_ms as i64,
            )
            .await;
        let (verifier_store, audit_sink) = issuer.into_ports();
        let resolver = self.store.resolver_mut();
        resolver.verifier_store = verifier_store;
        resolver.audit_sink = audit_sink;
        to_js(&issued.map_err(to_error)?)
    }

    /// Undo a pairing the flow abandoned.
    #[wasm_bindgen(js_name = rollbackPairingCredential)]
    pub async fn rollback_pairing_credential(&mut self, selector: JsValue) -> Result<(), JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        use crate::authority::InboundCredentialVerifierStore;
        self.store
            .resolver_mut()
            .verifier_store
            .delete_verifier(&selector)
            .await
            .map_err(to_error)
    }

    /// The question the peer host asks on every inbound call.
    #[wasm_bindgen]
    pub async fn authorize(&mut self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: PeerHostAuthorizeRequest = from_js(request)?;
        let decision = self.store.authorize(&request).await.map_err(to_error)?;
        to_js(&decision)
    }

    /// What the manifest advertises about a recipient's authority.
    #[wasm_bindgen(js_name = snapshotManifestAuthority)]
    pub async fn snapshot_manifest_authority(
        &mut self,
        request: JsValue,
    ) -> Result<JsValue, JsValue> {
        let request: PeerHostManifestAuthorityRequest = from_js(request)?;
        let snapshot = self
            .store
            .snapshot_manifest_authority(&request)
            .await
            .map_err(to_error)?;
        to_js(&snapshot)
    }

    /// Every live grant for a relationship, as the sharing settings render it.
    #[wasm_bindgen(js_name = listActiveGrants)]
    pub async fn list_active_grants(
        &mut self,
        selector: JsValue,
        now_ms: f64,
    ) -> Result<JsValue, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let repository = std::mem::take(&mut self.store.resolver_mut().grant_repository);
        let manager = PeerGrantManager::new(repository);
        let summaries = manager
            .list_active_grants(&selector, now_ms as i64)
            .await
            .map_err(to_error);
        self.store.resolver_mut().grant_repository = manager.into_repository();
        to_js(&summaries?)
    }

    /// Replace a relationship's sharing with a new selection.
    #[wasm_bindgen(js_name = replaceGrant)]
    pub async fn replace_grant(
        &mut self,
        selector: JsValue,
        selection: JsValue,
        now_ms: f64,
        grant_id: String,
    ) -> Result<JsValue, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let selection: PeerGrantSelection = from_js(selection)?;
        let repository = std::mem::take(&mut self.store.resolver_mut().grant_repository);
        let mut manager = PeerGrantManager::new(repository)
            .with_grant_id_source(Box::new(move || Some(grant_id.clone())));
        let summary = manager
            .replace_grant(&selector, &selection, now_ms as i64)
            .await
            .map_err(to_error);
        self.store.resolver_mut().grant_repository = manager.into_repository();
        to_js(&summary?)
    }

    /// The live credential verifier for a relationship, if there is one.
    ///
    /// A read, not a decision: the shell asks it to answer "do I already have a
    /// credential for this peer" without having to keep a second copy.
    #[wasm_bindgen(js_name = getVerifier)]
    pub async fn get_verifier(&self, selector: JsValue, now_ms: f64) -> Result<JsValue, JsValue> {
        use crate::authority::InboundCredentialVerifierStore;
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let verifier = self
            .store
            .resolver()
            .verifier_store
            .get_verifier(&selector, now_ms as i64)
            .await
            .map_err(to_error)?;
        to_js(&verifier)
    }

    /// Every grant row held for a relationship, for durable persistence.
    #[wasm_bindgen(js_name = exportGrants)]
    pub fn export_grants(&self, selector: JsValue) -> Result<JsValue, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        to_js(
            &self
                .store
                .resolver()
                .grant_repository
                .export_grants(&selector),
        )
    }

    /// Withdraw every grant for a relationship.
    #[wasm_bindgen(js_name = revokeSharing)]
    pub async fn revoke_sharing(
        &mut self,
        selector: JsValue,
        now_ms: f64,
    ) -> Result<JsValue, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let repository = std::mem::take(&mut self.store.resolver_mut().grant_repository);
        let mut manager = PeerGrantManager::new(repository);
        let summaries = manager
            .revoke_sharing(&selector, now_ms as i64)
            .await
            .map_err(to_error);
        self.store.resolver_mut().grant_repository = manager.into_repository();
        to_js(&summaries?)
    }

    /// Revoke a relationship outright: verifier, grants and challenges.
    #[wasm_bindgen(js_name = revokePeerAuthority)]
    pub async fn revoke_peer_authority(
        &mut self,
        selector: JsValue,
        reason_code: String,
        revoked_at_ms: f64,
    ) -> Result<JsValue, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let resolver = self.store.resolver_mut();
        let mut controller = MemoryPeerRevocationController::new(
            std::mem::take(&mut resolver.verifier_store),
            std::mem::take(&mut resolver.grant_repository),
            std::mem::replace(
                &mut resolver.challenge_store,
                MemoryReconnectChallengeStore::new(Box::new(JsRandomSource)),
            ),
            std::mem::take(&mut resolver.audit_sink),
            MemoryPeerRevocationBroadcaster::default(),
        );
        let event = controller
            .revoke(&selector, &reason_code, revoked_at_ms as i64)
            .await
            .map_err(to_error);
        let resolver = self.store.resolver_mut();
        resolver.verifier_store = controller.verifier_store;
        resolver.grant_repository = controller.grant_repository;
        resolver.challenge_store = controller.challenge_store;
        resolver.audit_sink = controller.audit_sink;
        to_js(&event?)
    }

    /// The execution policy for one projected method.
    #[wasm_bindgen(js_name = describeMethod)]
    pub fn describe_method(&self, method_id: &str) -> Result<JsValue, JsValue> {
        let descriptor = generated_peer_host_method_descriptor(
            method_id,
            &GeneratedPeerHostRegistrationOptions::default(),
        )
        .map_err(to_error)?;
        to_js(&descriptor)
    }

    /// The execution policy for one projected event topic.
    #[wasm_bindgen(js_name = describeEvent)]
    pub fn describe_event(&self, topic: &str) -> Result<JsValue, JsValue> {
        let descriptor = generated_peer_host_event_descriptor(
            topic,
            &GeneratedPeerHostEventRegistrationOptions::default(),
        )
        .map_err(to_error)?;
        to_js(&descriptor)
    }

    /// Check one `TTS.AudioChunk` emission against its stream's state machine.
    #[wasm_bindgen(js_name = validateTtsAudioChunk)]
    pub fn validate_tts_audio_chunk(
        &mut self,
        subscription_id: String,
        event: JsValue,
        correlation_id: Option<String>,
    ) -> Result<(), JsValue> {
        let event: serde_json::Value = from_js(event)?;
        self.tts_validators
            .entry(subscription_id)
            .or_default()
            .validate(&event, correlation_id.as_deref())
            .map_err(to_error)
    }

    /// Forget a subscription's TTS stream state when it closes.
    #[wasm_bindgen(js_name = closeTtsSubscription)]
    pub fn close_tts_subscription(&mut self, subscription_id: &str) {
        self.tts_validators.remove(subscription_id);
    }

    /// The audit rows recorded so far, oldest first.
    #[wasm_bindgen(js_name = drainAuditRecords)]
    pub fn drain_audit_records(&mut self) -> Result<JsValue, JsValue> {
        let records = std::mem::take(&mut self.store.resolver_mut().audit_sink.records);
        to_js(&records)
    }

    /// Compute the reconnect proof a claimant presents. Test and pairing use.
    #[wasm_bindgen(js_name = createReconnectProofForBearer)]
    pub fn create_reconnect_proof_for_bearer(
        raw_bearer_token: &str,
        selector: JsValue,
        transport: JsValue,
        challenge: &str,
    ) -> Result<String, JsValue> {
        let selector: PeerRelationshipSelector = from_js(selector)?;
        let transport: crate::authority::ReconnectTransportAttestation = from_js(transport)?;
        Ok(crate::authority::create_reconnect_proof_for_bearer(
            raw_bearer_token,
            &selector,
            &transport,
            challenge,
        ))
    }
}

impl Default for MeshAuthority {
    fn default() -> Self {
        Self::new()
    }
}
