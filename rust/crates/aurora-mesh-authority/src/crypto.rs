//! The cryptographic subset of `packages/aurora-sdk/src/webrtc/crypto.ts` the
//! authority depends on: SHA-256, HMAC-SHA-256, hex codecs, a constant-time
//! comparison and the canonical JSON encoder the reconnect proof transcript is
//! built from.
//!
//! Only the reconnect-proof path is ported. Room key derivation, AEAD and the
//! scrypt worker stay in TypeScript: they belong to the session, and the R0
//! boundary note keeps session state out of the authority.

use serde_json::Value;
use sha2::{Digest, Sha256};

const SHA256_BLOCK_BYTES: usize = 64;

/// Domain separator for the mesh reconnect proof transcript.
///
/// Mirrors `RECONNECT_DOMAIN` in `webrtc/crypto.ts`, trailing NUL included.
pub const RECONNECT_DOMAIN: &[u8] = b"aurora.mesh.reconnect-proof.v1\0";

/// Inputs the reconnect proof transcript is bound to.
///
/// Field-for-field `ReconnectProofInput` from `webrtc/crypto.ts`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconnectProofInput<'a> {
    /// Opaque credential identity.
    pub token_id: &'a str,
    /// Single-use challenge issued by the verifier.
    pub challenge: &'a str,
    /// Transport channel binding the proof is scoped to.
    pub channel_binding: &'a str,
    /// Stable peer id presenting the credential.
    pub claimant_peer_id: &'a str,
    /// Stable peer id holding the verifier.
    pub verifier_peer_id: &'a str,
    /// Room the relationship lives in.
    pub room_name: &'a str,
}

/// SHA-256 of `input`.
#[must_use]
pub fn sha256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().into()
}

/// HMAC-SHA-256 of `message` under `key` (RFC 2104).
///
/// Implemented here rather than pulled in as a dependency so the crate adds no
/// entry to the reserved workspace manifest.
#[must_use]
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; SHA256_BLOCK_BYTES];
    if key.len() > SHA256_BLOCK_BYTES {
        block[..32].copy_from_slice(&sha256(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36_u8; SHA256_BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; SHA256_BLOCK_BYTES];
    for index in 0..SHA256_BLOCK_BYTES {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest: [u8; 32] = inner.finalize().into();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);

    block.fill(0);
    inner_pad.fill(0);
    outer_pad.fill(0);
    outer.finalize().into()
}

/// Lowercase hex encoding, matching `bytesToHex` in `webrtc/encoding.ts`.
#[must_use]
pub fn bytes_to_hex(value: &[u8]) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value {
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0f));
    }
    out
}

fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + nibble - 10) as char,
    }
}

/// Decode a hex string, mirroring `hexToBytes` — even length, `[0-9a-fA-F]` only.
///
/// Returns `None` where the TypeScript throws `Invalid hex string`.
#[must_use]
pub fn hex_to_bytes(value: &str) -> Option<Vec<u8>> {
    if !value.is_ascii() || value.len() % 2 != 0 {
        return None;
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push(((high << 4) | low) as u8);
    }
    Some(out)
}

/// Length-independent comparison, mirroring `constantTimeEqual`.
#[must_use]
pub fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut diff = (left.len() ^ right.len()) as u32;
    let length = left.len().max(right.len());
    for index in 0..length {
        let l = left.get(index).copied().unwrap_or(0);
        let r = right.get(index).copied().unwrap_or(0);
        diff |= u32::from(l ^ r);
    }
    diff == 0
}

/// Build the reconnect proof message, mirroring `buildMeshReconnectProofMessage`.
///
/// The transcript keys are already in canonical (code-point) order in the
/// TypeScript literal; they are emitted in that same order here.
#[must_use]
pub fn build_mesh_reconnect_proof_message(input: &ReconnectProofInput<'_>) -> Vec<u8> {
    let mut transcript = String::from("{");
    push_json_member(&mut transcript, "challenge", input.challenge, true);
    push_json_member(
        &mut transcript,
        "channel_binding",
        input.channel_binding,
        false,
    );
    push_json_member(
        &mut transcript,
        "claimant_peer_id",
        input.claimant_peer_id,
        false,
    );
    push_json_member(&mut transcript, "room_name", input.room_name, false);
    push_json_member(&mut transcript, "token_id", input.token_id, false);
    push_json_member(
        &mut transcript,
        "verifier_peer_id",
        input.verifier_peer_id,
        false,
    );
    transcript.push_str(",\"version\":1}");

    let mut out = Vec::with_capacity(RECONNECT_DOMAIN.len() + transcript.len());
    out.extend_from_slice(RECONNECT_DOMAIN);
    out.extend_from_slice(transcript.as_bytes());
    out
}

fn push_json_member(out: &mut String, key: &str, value: &str, first: bool) {
    if !first {
        out.push(',');
    }
    push_canonical_json_string(out, key);
    out.push(':');
    push_canonical_json_string(out, value);
}

/// Encode one JSON string the way `canonicalJson` does: `JSON.stringify`
/// escaping followed by `escapeAscii`, so every code point above `U+007E`
/// becomes a lowercase `\uXXXX` escape and the digest matches Python's
/// `json.dumps(ensure_ascii=True)`.
pub(crate) fn push_canonical_json_string(out: &mut String, value: &str) {
    push_canonical_json_string_with_mode(out, value, CanonicalJsonAsciiMode::EscapeNonAscii);
}

/// Whether canonical JSON preserves UTF-8 or escapes every non-ASCII code point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalJsonAsciiMode {
    /// Match `ensure_ascii=False` / JavaScript canonical object hashing.
    PreserveUtf8,
    /// Match `ensure_ascii=True` reconnect-proof transcripts.
    EscapeNonAscii,
}

/// Serialize JSON with sorted object keys and an explicit non-ASCII policy.
#[must_use]
pub fn canonical_json(value: &Value, ascii_mode: CanonicalJsonAsciiMode) -> String {
    let mut output = String::new();
    push_canonical_json_value(&mut output, value, ascii_mode);
    output
}

fn push_canonical_json_value(out: &mut String, value: &Value, ascii_mode: CanonicalJsonAsciiMode) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(string) => push_canonical_json_string_with_mode(out, string, ascii_mode),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                push_canonical_json_value(out, item, ascii_mode);
            }
            out.push(']');
        }
        Value::Object(object) => {
            out.push('{');
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                push_canonical_json_string_with_mode(out, key, ascii_mode);
                out.push(':');
                push_canonical_json_value(out, item, ascii_mode);
            }
            out.push('}');
        }
    }
}

fn push_canonical_json_string_with_mode(
    out: &mut String,
    value: &str,
    ascii_mode: CanonicalJsonAsciiMode,
) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{9}' => out.push_str("\\t"),
            '\u{a}' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\u{d}' => out.push_str("\\r"),
            control if (control as u32) < 0x20 => {
                push_unicode_escape(out, control as u32);
            }
            ascii if (ascii as u32) <= 0x7e => out.push(ascii),
            wide if ascii_mode == CanonicalJsonAsciiMode::PreserveUtf8 => out.push(wide),
            wide => {
                let code_point = wide as u32;
                if code_point <= 0xffff {
                    push_unicode_escape(out, code_point);
                } else {
                    let normalized = code_point - 0x1_0000;
                    push_unicode_escape(out, 0xd800 + (normalized >> 10));
                    push_unicode_escape(out, 0xdc00 + (normalized & 0x3ff));
                }
            }
        }
    }
    out.push('"');
}

fn push_unicode_escape(out: &mut String, code_unit: u32) {
    out.push_str("\\u");
    for shift in [12_u32, 8, 4, 0] {
        out.push(hex_digit(((code_unit >> shift) & 0xf) as u8));
    }
}

/// Compute the hex reconnect proof for a raw bearer token.
///
/// Mirrors `computeReconnectProofHex`: the HMAC key is `sha256(bearerToken)`.
#[must_use]
pub fn compute_reconnect_proof_hex(
    raw_bearer_token: &str,
    input: &ReconnectProofInput<'_>,
) -> String {
    let key = sha256(raw_bearer_token.as_bytes());
    bytes_to_hex(&hmac_sha256(
        &key,
        &build_mesh_reconnect_proof_message(input),
    ))
}

/// Verify a hex reconnect proof against a stored token hash.
///
/// Mirrors `verifyReconnectProofHex`, including its "malformed input is simply
/// `false`" behaviour and the 32-byte length gate on both operands.
#[must_use]
pub fn verify_reconnect_proof_hex(
    token_hash_hex: &str,
    proof_hex: &str,
    input: &ReconnectProofInput<'_>,
) -> bool {
    let (Some(key), Some(proof)) = (hex_to_bytes(token_hash_hex), hex_to_bytes(proof_hex)) else {
        return false;
    };
    if key.len() != 32 || proof.len() != 32 {
        return false;
    }
    let expected = hmac_sha256(&key, &build_mesh_reconnect_proof_message(input));
    constant_time_equal(&expected, &proof)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_case_one() {
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(
            bytes_to_hex(&mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn hmac_matches_rfc4231_long_key_case() {
        let mac = hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            bytes_to_hex(&mac),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn hex_round_trips_and_rejects_odd_input() {
        assert_eq!(hex_to_bytes("00ff"), Some(vec![0x00, 0xff]));
        assert_eq!(hex_to_bytes("00F"), None);
        assert_eq!(hex_to_bytes("zz"), None);
        assert_eq!(bytes_to_hex(&[0x00, 0xff]), "00ff");
    }

    #[test]
    fn canonical_strings_escape_above_ascii() {
        let mut out = String::new();
        push_canonical_json_string(&mut out, "a\u{7f}\u{e9}\u{1f600}\"\n");
        assert_eq!(out, "\"a\\u007f\\u00e9\\ud83d\\ude00\\\"\\n\"");
    }

    #[test]
    fn canonical_json_uses_one_encoder_with_explicit_ascii_policy() {
        let value = serde_json::json!({"z": "München🙂", "a": ["é", 1]});

        assert_eq!(
            canonical_json(&value, CanonicalJsonAsciiMode::PreserveUtf8),
            "{\"a\":[\"é\",1],\"z\":\"München🙂\"}"
        );
        assert_eq!(
            canonical_json(&value, CanonicalJsonAsciiMode::EscapeNonAscii),
            "{\"a\":[\"\\u00e9\",1],\"z\":\"M\\u00fcnchen\\ud83d\\ude42\"}"
        );
    }

    #[test]
    fn constant_time_equal_is_length_aware() {
        assert!(constant_time_equal(b"abc", b"abc"));
        assert!(!constant_time_equal(b"abc", b"abcd"));
        assert!(!constant_time_equal(b"abc", b"abd"));
    }
}
