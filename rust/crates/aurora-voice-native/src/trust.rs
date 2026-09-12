//! Strict Ed25519 verification for signed model-pack manifests.

use std::collections::BTreeMap;
use std::fmt;

use aurora_voice_engine::{ManifestSignature, ModelPackError, SignatureVerifier};
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};

const ED25519_ALGORITHM: &str = "ed25519";
const MAX_KEY_ID_BYTES: usize = 256;

/// Immutable trusted-key registry used by the portable manifest trust boundary.
#[derive(Clone, Default)]
pub struct Ed25519TrustStore {
    keys: BTreeMap<String, VerifyingKey>,
}

impl fmt::Debug for Ed25519TrustStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Ed25519TrustStore")
            .field("trusted_key_count", &self.keys.len())
            .finish()
    }
}

impl Ed25519TrustStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a base64-encoded 32-byte Ed25519 public key under a stable key ID.
    pub fn add_base64_key(
        &mut self,
        key_id: impl Into<String>,
        public_key_base64: &str,
    ) -> Result<(), ModelPackError> {
        let key_id = key_id.into();
        if key_id.trim() != key_id || key_id.is_empty() || key_id.len() > MAX_KEY_ID_BYTES {
            return Err(trust_error("key_id"));
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(public_key_base64)
            .map_err(|_| trust_error("public_key"))?;
        let bytes =
            <[u8; 32]>::try_from(decoded.as_slice()).map_err(|_| trust_error("public_key"))?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| trust_error("public_key"))?;
        if self.keys.insert(key_id, key).is_some() {
            return Err(trust_error("duplicate_key"));
        }
        Ok(())
    }

    pub fn key_count(&self) -> usize {
        self.keys.len()
    }
}

impl SignatureVerifier for Ed25519TrustStore {
    fn verify(
        &self,
        canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError> {
        if signature.algorithm != ED25519_ALGORITHM {
            return Err(trust_error("algorithm"));
        }
        let Some(key) = self.keys.get(&signature.key_id) else {
            return Ok(false);
        };
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&signature.value)
            .map_err(|_| trust_error("signature_encoding"))?;
        let signature =
            Signature::from_slice(&decoded).map_err(|_| trust_error("signature_encoding"))?;
        Ok(key
            .verify_strict(canonical_json.as_bytes(), &signature)
            .is_ok())
    }
}

fn trust_error(code: &'static str) -> ModelPackError {
    ModelPackError::Trust { code }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;

    #[test]
    fn verifies_only_the_registered_key_and_exact_canonical_bytes() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut trust = Ed25519TrustStore::new();
        trust
            .add_base64_key(
                "release-key",
                &base64::engine::general_purpose::STANDARD
                    .encode(signing_key.verifying_key().as_bytes()),
            )
            .expect("register key");
        let canonical = r#"{"pack_id":"pack","schema_version":1}"#;
        let signature = ManifestSignature {
            key_id: "release-key".to_owned(),
            algorithm: ED25519_ALGORITHM.to_owned(),
            value: base64::engine::general_purpose::STANDARD
                .encode(signing_key.sign(canonical.as_bytes()).to_bytes()),
        };

        assert_eq!(trust.verify(canonical, &signature), Ok(true));
        assert_eq!(trust.verify("{}", &signature), Ok(false));
        assert_eq!(trust.key_count(), 1);
    }

    #[test]
    fn rejects_wrong_key_algorithm_and_malformed_material_without_disclosure() {
        let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
        let mut trust = Ed25519TrustStore::new();
        trust
            .add_base64_key(
                "release-key",
                &base64::engine::general_purpose::STANDARD
                    .encode(signing_key.verifying_key().as_bytes()),
            )
            .expect("register key");
        let signature = ManifestSignature {
            key_id: "missing-key".to_owned(),
            algorithm: ED25519_ALGORITHM.to_owned(),
            value: "signature-secret".to_owned(),
        };
        assert_eq!(trust.verify("{}", &signature), Ok(false));

        let wrong_algorithm = ManifestSignature {
            key_id: "release-key".to_owned(),
            algorithm: "ecdsa-p256-sha256".to_owned(),
            value: "signature-secret".to_owned(),
        };
        let error = trust
            .verify("{}", &wrong_algorithm)
            .expect_err("reject algorithm");
        let rendered = error.to_string();
        assert!(!rendered.contains("signature-secret"));
        assert!(!rendered.contains("missing-key"));

        assert_eq!(
            trust.add_base64_key("bad-key", "public-key-secret"),
            Err(ModelPackError::Trust { code: "public_key" })
        );
    }
}
