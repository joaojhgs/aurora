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
    AuthenticatedPeerContext, AuthorityError, AuthorityResult, IssueReconnectChallengeRequest,
    LocalPeerCredentialVerifierV1, LocalPeerGrantV1, MemoryInboundCredentialVerifierStore,
    MemoryPeerAuditSink, MemoryPeerGrantRepository, MemoryPeerRevocationBroadcaster,
    MemoryPeerRevocationController, MemoryReconnectChallengeStore, PeerAuthorityResolver,
    PeerGrantRepository, PeerRelationshipSelector, RandomSource, VerifyReconnectProofRequest,
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

/// A JSON value decoded from JavaScript without serde_json's private sentinel
/// map conventions. `serde-wasm-bindgen` supplies the JS traversal; this
/// visitor owns the resulting object shape directly.
#[derive(Debug, PartialEq)]
struct WasmJsonValue(serde_json::Value);

impl<'de> serde::Deserialize<'de> for WasmJsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct JsonValueVisitor;

        impl<'de> serde::de::Visitor<'de> for JsonValueVisitor {
            type Value = WasmJsonValue;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON-compatible JavaScript value")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(WasmJsonValue(serde_json::Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(WasmJsonValue(serde_json::Value::Number(value.into())))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(WasmJsonValue(serde_json::Value::Number(value.into())))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
                Ok(WasmJsonValue(serde_json::Number::from_f64(value).map_or(
                    serde_json::Value::Null,
                    serde_json::Value::Number,
                )))
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                self.visit_string(value.to_owned())
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(WasmJsonValue(serde_json::Value::String(value)))
            }

            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                self.visit_unit()
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(WasmJsonValue(serde_json::Value::Null))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<WasmJsonValue>()? {
                    values.push(value.0);
                }
                Ok(WasmJsonValue(serde_json::Value::Array(values)))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, WasmJsonValue>()? {
                    values.insert(key, value.0);
                }
                Ok(WasmJsonValue(serde_json::Value::Object(values)))
            }
        }

        deserializer.deserialize_any(JsonValueVisitor)
    }
}

/// Private input mirror for the one authorization DTO carrying dynamic JSON.
/// Keep its serde attributes aligned with `PeerHostIdentity` and
/// `PeerHostAuthorizeRequest`; all other fields still use serde-wasm-bindgen's
/// existing typed conversion.
#[derive(serde::Deserialize)]
struct WasmPeerHostIdentity {
    #[serde(rename = "callerPeerId")]
    caller_peer_id: String,
    #[serde(rename = "principalId", default)]
    principal_id: Option<String>,
    #[serde(rename = "effectivePermissions", default)]
    effective_permissions: Vec<String>,
    #[serde(rename = "authGrantRevision", default)]
    auth_grant_revision: Option<i64>,
    #[serde(rename = "manifestRevision", default)]
    manifest_revision: Option<WasmJsonValue>,
}

impl From<WasmPeerHostIdentity> for crate::types::PeerHostIdentity {
    fn from(identity: WasmPeerHostIdentity) -> Self {
        Self {
            caller_peer_id: identity.caller_peer_id,
            principal_id: identity.principal_id,
            effective_permissions: identity.effective_permissions,
            auth_grant_revision: identity.auth_grant_revision,
            manifest_revision: identity.manifest_revision.map(|value| value.0),
        }
    }
}

#[derive(serde::Deserialize)]
struct WasmPeerHostAuthorizeRequest {
    #[serde(rename = "remotePeerId")]
    remote_peer_id: String,
    #[serde(rename = "methodId")]
    method_id: String,
    #[serde(rename = "requiredPermissions", default)]
    required_permissions: Vec<String>,
    identity: WasmPeerHostIdentity,
    #[serde(rename = "authenticatedPeerContext", default)]
    authenticated_peer_context: Option<AuthenticatedPeerContext>,
    #[serde(rename = "nowMs")]
    now_ms: i64,
}

impl From<WasmPeerHostAuthorizeRequest> for PeerHostAuthorizeRequest {
    fn from(request: WasmPeerHostAuthorizeRequest) -> Self {
        Self {
            remote_peer_id: request.remote_peer_id,
            method_id: request.method_id,
            required_permissions: request.required_permissions,
            identity: request.identity.into(),
            authenticated_peer_context: request.authenticated_peer_context,
            now_ms: request.now_ms,
        }
    }
}

fn from_js_json_value(value: JsValue) -> Result<serde_json::Value, JsValue> {
    serde_wasm_bindgen::from_value::<WasmJsonValue>(value)
        .map(|value| value.0)
        .map_err(|_| JsValue::from_str("invalid JSON value"))
}

fn from_js_authorize_request(value: JsValue) -> Result<PeerHostAuthorizeRequest, JsValue> {
    serde_wasm_bindgen::from_value::<WasmPeerHostAuthorizeRequest>(value)
        .map(PeerHostAuthorizeRequest::from)
        .map_err(|_| JsValue::from_str("invalid authorization request"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifierStatus {
    found: bool,
    credential_revision: Option<i64>,
}

/// Bytes drawn from the host page's `crypto.getRandomValues`.
///
/// The authority never invents randomness of its own; the platform supplies it,
/// exactly as `webrtc/crypto.ts` does today.
struct JsRandomSource;

impl RandomSource for JsRandomSource {
    fn random_bytes(&self, length: usize) -> AuthorityResult<Vec<u8>> {
        let mut out = vec![0_u8; length];
        getrandom_from_js(&mut out).map_err(|_| AuthorityError::RandomSourceUnavailable)?;
        Ok(out)
    }
}

fn getrandom_from_js(out: &mut [u8]) -> Result<JsValue, JsValue> {
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(catch, js_namespace = crypto, js_name = getRandomValues)]
        fn get_random_values(target: &mut [u8]) -> Result<JsValue, JsValue>;
    }
    get_random_values(out)
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
        let request = from_js_authorize_request(request)?;
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

    /// Redacted live credential status for a relationship.
    ///
    /// A read, not a decision: the shell asks it to answer "do I already have a
    /// credential for this peer" without exposing verifier proof key material.
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
        to_js(&VerifierStatus {
            found: verifier.is_some(),
            credential_revision: verifier.map(|row| row.credential_revision),
        })
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
        let event = from_js_json_value(event)?;
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

#[cfg(test)]
mod wasm_json_shape_tests {
    use super::{from_js_authorize_request, from_js_json_value};
    use serde_json::json;
    use wasm_bindgen::prelude::wasm_bindgen;
    use wasm_bindgen::JsValue;
    use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

    wasm_bindgen_test_configure!(run_in_browser);

    fn authorization_request_js_value(value: &serde_json::Value) -> JsValue {
        let json = serde_json::to_string(value).expect("serialize authorization fixture JSON");
        parse_plain_json(&json)
    }

    #[wasm_bindgen(inline_js = r#"
        export function parse_plain_json(source) {
            return JSON.parse(source);
        }
        export function request_with_undefined_manifest_revision() {
            return { remotePeerId: 'remote-probe', methodId: 'TTS.AudioChunk', identity: { callerPeerId: 'caller-probe', manifestRevision: undefined }, nowMs: 0 };
        }
        export function request_with_manifest_revision(manifestRevision) {
            return { remotePeerId: 'remote-probe', methodId: 'TTS.AudioChunk', identity: { callerPeerId: 'caller-probe', manifestRevision }, nowMs: 0 };
        }
        export function literal_number_marker_object() {
            return { '$serde_json::private::Number': '1' };
        }
        export function literal_raw_value_marker_object() {
            return { '$serde_json::private::RawValue': 'not-json' };
        }
        export function escaped_number_marker_object() {
            return JSON.parse('{"\\u0024serde_json::private::Number":"1"}');
        }
        export function escaped_raw_value_marker_object() {
            return JSON.parse('{"\\u0024serde_json::private::RawValue":"1"}');
        }
        export function ordinary_raw_value_token_text() {
            return 'ordinary text containing $serde_json::private::RawValue';
        }
        export function request_with_nan_manifest_revision() {
            return { remotePeerId: 'remote-probe', methodId: 'TTS.AudioChunk', identity: { callerPeerId: 'caller-probe', manifestRevision: NaN }, nowMs: 0 };
        }
        export function nan_value() { return NaN; }
        export function undefined_value() { return undefined; }
        export function array_with_hole() { return [1, , 3]; }
        export function string_key_map() { return new Map([['alpha', 1], ['beta', [2, 3]]]); }
        export function numeric_key_map() { return new Map([[1, 'one']]); }
    "#)]
    extern "C" {
        fn parse_plain_json(source: &str) -> JsValue;
        fn request_with_undefined_manifest_revision() -> JsValue;
        fn request_with_manifest_revision(manifest_revision: JsValue) -> JsValue;
        fn literal_number_marker_object() -> JsValue;
        fn literal_raw_value_marker_object() -> JsValue;
        fn request_with_nan_manifest_revision() -> JsValue;
        fn escaped_number_marker_object() -> JsValue;
        fn escaped_raw_value_marker_object() -> JsValue;
        fn ordinary_raw_value_token_text() -> JsValue;
        fn nan_value() -> JsValue;
        fn undefined_value() -> JsValue;
        fn array_with_hole() -> JsValue;
        fn string_key_map() -> JsValue;
        fn numeric_key_map() -> JsValue;
    }

    #[wasm_bindgen_test]
    fn dynamic_json_visitor_preserves_sentinel_objects_and_text() {
        let value = json!({
            "$serde_json::private::Number": "1",
            "extra": {
                "$serde_json::private::RawValue": "false",
                "nested": ["{\"$serde_json::private::Number\":\"1\"}"]
            }
        });
        let js_value = serde_wasm_bindgen::to_value(&value).expect("convert JSON fixture");

        assert_eq!(
            from_js_json_value(js_value).expect("decode dynamic JSON"),
            value
        );

        assert_eq!(
            from_js_json_value(escaped_number_marker_object()).expect("decode escaped marker"),
            json!({ "$serde_json::private::Number": "1" })
        );
        assert_eq!(
            from_js_json_value(escaped_raw_value_marker_object())
                .expect("decode escaped raw marker"),
            json!({ "$serde_json::private::RawValue": "1" })
        );
        assert_eq!(
            from_js_json_value(ordinary_raw_value_token_text())
                .expect("decode ordinary token text"),
            json!("ordinary text containing $serde_json::private::RawValue")
        );
        assert_eq!(
            from_js_json_value(nan_value()).expect("decode NaN"),
            json!(null)
        );
        assert_eq!(
            from_js_json_value(undefined_value()).expect("decode undefined"),
            json!(null)
        );
        assert_eq!(
            from_js_json_value(array_with_hole()).expect("decode array hole"),
            json!([1, null, 3])
        );
        assert_eq!(
            from_js_json_value(string_key_map()).expect("decode string-keyed Map"),
            json!({ "alpha": 1, "beta": [2, 3] })
        );
        let error = from_js_json_value(numeric_key_map()).expect_err("reject numeric Map key");
        assert_eq!(error.as_string().as_deref(), Some("invalid JSON value"));
    }

    #[wasm_bindgen_test]
    fn authorization_mirror_preserves_dynamic_manifest_and_authenticated_context() {
        let manifest_revision = json!({
            "$serde_json::private::Number": "1",
            "additional": true
        });
        let input = json!({
            "remotePeerId": "remote-probe",
            "methodId": "TTS.AudioChunk",
            "requiredPermissions": ["TTS.AudioChunk:use"],
            "identity": {
                "callerPeerId": "caller-probe",
                "principalId": "principal-probe",
                "effectivePermissions": ["TTS.AudioChunk:use"],
                "authGrantRevision": 7,
                "manifestRevision": manifest_revision.clone()
            },
            "authenticatedPeerContext": {
                "selector": {
                    "tokenId": "token-probe",
                    "claimantPeerId": "caller-probe",
                    "verifierPeerId": "remote-probe",
                    "roomName": "room-probe"
                },
                "transport": {
                    "channelBinding": "binding-probe",
                    "claimantSignalingPeerId": "caller-probe",
                    "verifierSignalingPeerId": "remote-probe"
                },
                "connectionEpoch": "epoch-probe",
                "credentialRevision": 7,
                "authenticatedAtMs": 11
            },
            "nowMs": 12
        });
        let js_value = authorization_request_js_value(&input);

        let request = from_js_authorize_request(js_value).expect("decode authorization request");
        assert_eq!(request.identity.manifest_revision, Some(manifest_revision));
        let context = request
            .authenticated_peer_context
            .expect("retain authenticated context");
        assert_eq!(context.selector.token_id, "token-probe");
        assert_eq!(context.transport.channel_binding, "binding-probe");
        assert_eq!(context.connection_epoch.as_deref(), Some("epoch-probe"));
        assert_eq!(context.credential_revision, 7);
        assert_eq!(context.authenticated_at_ms, 11);

        for (manifest_revision, expected) in [
            (
                literal_number_marker_object(),
                json!({ "$serde_json::private::Number": "1" }),
            ),
            (
                escaped_number_marker_object(),
                json!({ "$serde_json::private::Number": "1" }),
            ),
            (
                literal_raw_value_marker_object(),
                json!({ "$serde_json::private::RawValue": "not-json" }),
            ),
            (
                escaped_raw_value_marker_object(),
                json!({ "$serde_json::private::RawValue": "1" }),
            ),
            (
                ordinary_raw_value_token_text(),
                json!("ordinary text containing $serde_json::private::RawValue"),
            ),
        ] {
            let request =
                from_js_authorize_request(request_with_manifest_revision(manifest_revision))
                    .expect("decode dynamic manifest value from plain request object");
            assert_eq!(request.identity.manifest_revision, Some(expected));
        }
    }

    #[wasm_bindgen_test]
    fn authorization_option_keeps_null_like_values_absent() {
        for input in [
            json!({
                "remotePeerId": "remote-probe",
                "methodId": "TTS.AudioChunk",
                "identity": { "callerPeerId": "caller-probe" },
                "nowMs": 0
            }),
            json!({
                "remotePeerId": "remote-probe",
                "methodId": "TTS.AudioChunk",
                "identity": {
                    "callerPeerId": "caller-probe",
                    "manifestRevision": null
                },
                "nowMs": 0
            }),
        ] {
            let js_value = authorization_request_js_value(&input);
            let request =
                from_js_authorize_request(js_value).expect("decode authorization request");
            assert_eq!(request.identity.manifest_revision, None);
        }

        let request = from_js_authorize_request(request_with_undefined_manifest_revision())
            .expect("decode undefined manifest revision");
        assert_eq!(request.identity.manifest_revision, None);

        let request = from_js_authorize_request(request_with_nan_manifest_revision())
            .expect("decode non-finite manifest revision");
        assert_eq!(
            request.identity.manifest_revision,
            Some(serde_json::Value::Null)
        );

        let input = JsValue::from_str("malformed authorization input");
        let error = from_js_authorize_request(input).expect_err("reject non-object request");
        assert_eq!(
            error.as_string().as_deref(),
            Some("invalid authorization request")
        );
    }
}
