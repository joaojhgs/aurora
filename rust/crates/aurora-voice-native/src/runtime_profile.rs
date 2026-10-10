//! Strict validation for persisted canonical runtime-profile documents.
//!
//! This module validates already serialized version-2 documents. It preserves
//! their original JSON bytes and performs no storage, migration, authorization,
//! package-entitlement, readiness, or speech-admission work.

use aurora_contracts::runtime_profile_text::{
    is_canonical_profile_text, is_runtime_profile_secret_query_key,
    is_runtime_profile_wake_phrase_text,
};
use aurora_voice_engine::json_text::parse_unique_json_value;
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;
use url::{form_urlencoded, Url};

const MAX_RUNTIME_PROFILE_DOCUMENT_BYTES: usize = 128 * 1024;
const MAX_RUNTIME_PROFILE_COUNT: usize = 64;
const MAX_PROFILE_ID_BYTES: usize = 96;
const MAX_PROFILE_LABEL_BYTES: usize = 120;
const MAX_NODE_TEXT_BYTES: usize = 160;
const MAX_OPTIONAL_PEER_TEXT_BYTES: usize = 256;
const MAX_WEBRTC_APP_ID_BYTES: usize = 256;
const MAX_WEBRTC_ROOM_BYTES: usize = 512;
const MAX_ROOM_SECRET_REFERENCE_BYTES: usize = 1024;
const MAX_WEBRTC_BROKERS: usize = 16;
const MAX_ICE_SERVERS: usize = 16;
const MAX_ICE_SERVER_BYTES: usize = 2048;
const MAX_CATALOG_TEXT_BYTES: usize = 256;
const MAX_WAKE_PHRASE_BYTES: usize = 64;
const MAX_WAKE_LOCALE_BYTES: usize = 32;
const MAX_SPEECH_LANGUAGE_BYTES: usize = 255;
const MAX_OVERLAY_HOTKEY_BYTES: usize = 64;
const MAX_OVERLAY_DELAY_MS: u64 = 60_000;

const CAPABILITY_PACKS: [&str; 7] = [
    "local-tools",
    "native-actions",
    "local-conversations",
    "lightweight-memory",
    "lightweight-orchestrator",
    "foreground-voice",
    "local-inference",
];

/// Trusted native package capabilities that affect canonical profile checks.
///
/// This value must be constructed by native package/bootstrap code. It must
/// never be derived from a renderer field, profile field, or environment role.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RuntimeProfileValidationOptions {
    /// Whether this installed package is permitted to use the Python runtime.
    pub allow_python_full: bool,
}

/// A validated canonical document retaining the exact accepted JSON bytes.
///
/// The value intentionally does not deserialize from arbitrary Rust callers
/// and exposes no constructor that bypasses validation.
#[derive(Clone)]
pub struct ValidatedRuntimeProfileDocument {
    json: String,
}

impl ValidatedRuntimeProfileDocument {
    /// Return the exact validated JSON text, without normalization or rewriting.
    pub fn as_json(&self) -> &str {
        &self.json
    }
}

impl fmt::Debug for ValidatedRuntimeProfileDocument {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedRuntimeProfileDocument")
            .field("json", &"[redacted]")
            .finish()
    }
}

/// Fixed, content-free failure for canonical runtime-profile validation.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("runtime profile document is invalid")]
pub struct RuntimeProfileValidationError;

/// Validate a complete canonical version-2 runtime-profile document.
///
/// The accepted string is retained byte-for-byte. Input is bounded before
/// parsing, duplicate decoded keys are rejected at every object depth, and all
/// profiles are validated, including inactive profiles.
pub fn validate_canonical_runtime_profile_document(
    text: &str,
    options: RuntimeProfileValidationOptions,
) -> Result<ValidatedRuntimeProfileDocument, RuntimeProfileValidationError> {
    if text.len() > MAX_RUNTIME_PROFILE_DOCUMENT_BYTES {
        return Err(RuntimeProfileValidationError);
    }
    let document = parse_unique_json_value(text).map_err(|_| RuntimeProfileValidationError)?;
    validate_document(&document, options)?;
    Ok(ValidatedRuntimeProfileDocument {
        json: text.to_owned(),
    })
}

fn validate_document(
    value: &Value,
    options: RuntimeProfileValidationOptions,
) -> Result<(), RuntimeProfileValidationError> {
    let document = object(value)?;
    exact_keys(document, &["version", "activeProfileId", "profiles"], &[])?;
    if unsigned_integer(field(document, "version")?)? != 2 {
        return invalid();
    }

    let profiles = array(field(document, "profiles")?)?;
    if profiles.len() > MAX_RUNTIME_PROFILE_COUNT {
        return invalid();
    }
    let active_profile_id = match field(document, "activeProfileId")? {
        Value::Null => None,
        Value::String(value) if canonical_text(value, MAX_PROFILE_ID_BYTES) => Some(value.as_str()),
        _ => return invalid(),
    };

    let mut profile_ids = BTreeSet::new();
    for profile in profiles {
        let profile_id = validate_profile(profile, options)?;
        if !profile_ids.insert(profile_id.to_owned()) {
            return invalid();
        }
    }
    if active_profile_id.is_some_and(|active| !profile_ids.contains(active)) {
        return invalid();
    }
    Ok(())
}

fn validate_profile(
    value: &Value,
    options: RuntimeProfileValidationOptions,
) -> Result<&str, RuntimeProfileValidationError> {
    let profile = object(value)?;
    exact_keys(
        profile,
        &[
            "version",
            "id",
            "label",
            "nodeMode",
            "runtimeTier",
            "localNode",
        ],
        &["homeConnection"],
    )?;
    if unsigned_integer(field(profile, "version")?)? != 2 {
        return invalid();
    }
    let profile_id = required_text(field(profile, "id")?, MAX_PROFILE_ID_BYTES)?;
    required_text(field(profile, "label")?, MAX_PROFILE_LABEL_BYTES)?;

    let node_mode = enum_text(
        field(profile, "nodeMode")?,
        &["remote-console", "mesh-node"],
    )?;
    let runtime_tier = enum_text(
        field(profile, "runtimeTier")?,
        &["none", "lightweight-ts", "python-full"],
    )?;
    match (node_mode, runtime_tier) {
        ("remote-console", "none") => {}
        ("mesh-node", "lightweight-ts") => {}
        ("mesh-node", "python-full") if options.allow_python_full => {}
        _ => return invalid(),
    }

    if let Some(home) = profile.get("homeConnection") {
        validate_home_connection(home)?;
    } else if node_mode == "remote-console" {
        return invalid();
    }

    let allow_offline_local_inference = node_mode == "mesh-node"
        && runtime_tier == "lightweight-ts"
        && !profile.contains_key("homeConnection");
    validate_local_node(
        field(profile, "localNode")?,
        node_mode,
        allow_offline_local_inference,
    )?;
    Ok(profile_id)
}

fn validate_home_connection(value: &Value) -> Result<(), RuntimeProfileValidationError> {
    let home = object(value)?;
    exact_keys(
        home,
        &["mode"],
        &["gatewayUrl", "signalingUrl", "homePeerId", "webrtcProfile"],
    )?;
    let mode = enum_text(
        field(home, "mode")?,
        &["http-only", "webrtc-only", "webrtc-preferred"],
    )?;

    let gateway = optional_endpoint(home, "gatewayUrl", &["http", "https"])?;
    let signaling = optional_endpoint(home, "signalingUrl", &["ws", "wss"])?;
    if let Some(peer_id) = home.get("homePeerId") {
        required_text(peer_id, MAX_OPTIONAL_PEER_TEXT_BYTES)?;
    }

    let webrtc = home.get("webrtcProfile");
    if mode != "webrtc-only" && gateway.is_none() {
        return invalid();
    }
    if mode != "http-only" && webrtc.is_none() {
        return invalid();
    }
    if let Some(webrtc) = webrtc {
        let broker_first = validate_webrtc_profile(
            webrtc,
            if mode == "webrtc-only" {
                "webrtc-only"
            } else {
                "webrtc-preferred"
            },
        )?;
        if signaling != Some(broker_first) {
            return invalid();
        }
    }
    Ok(())
}

fn validate_webrtc_profile<'a>(
    value: &'a Value,
    expected_mode: &str,
) -> Result<&'a str, RuntimeProfileValidationError> {
    let profile = object(value)?;
    exact_keys(
        profile,
        &["mode", "appId", "room", "roomSecretRef", "signalingBrokers"],
        &[
            "expectedStablePeerId",
            "expectedSignalingPeerId",
            "nodeName",
            "production",
            "allowInsecureLoopbackSignaling",
            "requireAppLayerE2ee",
            "stunServers",
            "turnServers",
        ],
    )?;
    if enum_text(
        field(profile, "mode")?,
        &["webrtc-only", "webrtc-preferred"],
    )? != expected_mode
    {
        return invalid();
    }
    required_text(field(profile, "appId")?, MAX_WEBRTC_APP_ID_BYTES)?;
    required_text(field(profile, "room")?, MAX_WEBRTC_ROOM_BYTES)?;
    required_text(
        field(profile, "roomSecretRef")?,
        MAX_ROOM_SECRET_REFERENCE_BYTES,
    )?;

    for key in ["expectedStablePeerId", "expectedSignalingPeerId"] {
        optional_text(profile, key, MAX_OPTIONAL_PEER_TEXT_BYTES)?;
    }
    optional_text(profile, "nodeName", MAX_NODE_TEXT_BYTES)?;
    for key in [
        "production",
        "allowInsecureLoopbackSignaling",
        "requireAppLayerE2ee",
    ] {
        optional_boolean(profile, key)?;
    }
    for key in ["stunServers", "turnServers"] {
        if let Some(servers) = profile.get(key) {
            validate_ice_servers(servers, key == "stunServers")?;
        }
    }

    let brokers = array(field(profile, "signalingBrokers")?)?;
    if brokers.is_empty() || brokers.len() > MAX_WEBRTC_BROKERS {
        return invalid();
    }
    let mut first = None;
    for broker in brokers {
        let broker = string(broker)?;
        if !canonical_endpoint(broker, &["ws", "wss"]) {
            return invalid();
        }
        if first.is_none() {
            first = Some(broker);
        }
    }
    first.ok_or(RuntimeProfileValidationError)
}

fn validate_local_node(
    value: &Value,
    node_mode: &str,
    allow_offline_local_inference: bool,
) -> Result<(), RuntimeProfileValidationError> {
    let node = object(value)?;
    exact_keys(
        node,
        &["nodeName", "stablePeerId", "enabledCapabilityPacks"],
        &[
            "primaryLanguage",
            "voiceLanguage",
            "localSpeechPackState",
            "localSpeechSelection",
            "desktopOverlay",
            "meshMembership",
        ],
    )?;
    required_text(field(node, "nodeName")?, MAX_NODE_TEXT_BYTES)?;
    required_text(field(node, "stablePeerId")?, MAX_NODE_TEXT_BYTES)?;
    validate_capability_packs(field(node, "enabledCapabilityPacks")?, node_mode)?;
    optional_speech_language(node, "primaryLanguage", false)?;
    optional_speech_language(node, "voiceLanguage", true)?;

    if let Some(state) = node.get("localSpeechPackState") {
        enum_text(
            state,
            &[
                "disabled",
                "downloading",
                "incompatible",
                "over-budget",
                "ready",
                "unavailable",
            ],
        )?;
    }
    if let Some(selection) = node.get("localSpeechSelection") {
        validate_speech_selection(selection)?;
    }
    if let Some(overlay) = node.get("desktopOverlay") {
        validate_desktop_overlay(overlay)?;
    }
    let membership = node.get("meshMembership");
    if node_mode == "mesh-node" && membership.is_none() {
        let packs = array(field(node, "enabledCapabilityPacks")?)?;
        let is_offline_local_inference = allow_offline_local_inference
            && packs.len() == 1
            && string(&packs[0])? == "local-inference";
        if !is_offline_local_inference {
            return invalid();
        }
    }
    if let Some(membership) = membership {
        validate_mesh_membership(membership)?;
    }
    Ok(())
}

fn validate_capability_packs(
    value: &Value,
    node_mode: &str,
) -> Result<(), RuntimeProfileValidationError> {
    let packs = array(value)?;
    let mut last_index = None;
    for pack in packs {
        let pack = string(pack)?;
        let index = CAPABILITY_PACKS
            .iter()
            .position(|candidate| *candidate == pack)
            .ok_or(RuntimeProfileValidationError)?;
        if last_index.is_some_and(|last| index <= last) {
            return invalid();
        }
        last_index = Some(index);
    }
    if node_mode == "remote-console" && !packs.is_empty() {
        return invalid();
    }
    Ok(())
}

fn validate_mesh_membership(value: &Value) -> Result<(), RuntimeProfileValidationError> {
    let membership = object(value)?;
    exact_keys(membership, &["signalingUrl", "webrtcProfile"], &[])?;
    let signaling = string(field(membership, "signalingUrl")?)?;
    if !canonical_endpoint(signaling, &["ws", "wss"]) {
        return invalid();
    }
    let broker = validate_webrtc_profile(field(membership, "webrtcProfile")?, "webrtc-only")?;
    if broker != signaling {
        return invalid();
    }
    let brokers = object(field(membership, "webrtcProfile")?)?
        .get("signalingBrokers")
        .and_then(Value::as_array)
        .ok_or(RuntimeProfileValidationError)?;
    if brokers.len() != 1 {
        return invalid();
    }
    Ok(())
}

fn validate_speech_selection(value: &Value) -> Result<(), RuntimeProfileValidationError> {
    let selection = object(value)?;
    if selection.is_empty() {
        return invalid();
    }
    for (task, asset) in selection {
        match task.as_str() {
            "wakePhrase" => validate_wake_phrase(asset)?,
            "kws" | "stt" | "tts" | "vad" => validate_speech_asset(asset, task == "tts")?,
            _ => return invalid(),
        }
    }
    Ok(())
}

fn validate_speech_asset(
    value: &Value,
    require_voice: bool,
) -> Result<(), RuntimeProfileValidationError> {
    let asset = object(value)?;
    exact_keys(
        asset,
        &["packId", "packRevision"],
        &["voiceId", "voiceRevision", "referenceProfileId"],
    )?;
    required_catalog_text(field(asset, "packId")?)?;
    required_catalog_text(field(asset, "packRevision")?)?;
    let voice_id = optional_catalog_text(asset, "voiceId")?;
    let voice_revision = optional_catalog_text(asset, "voiceRevision")?;
    optional_catalog_text(asset, "referenceProfileId")?;
    if voice_id.is_some() != voice_revision.is_some() || (require_voice && voice_id.is_none()) {
        return invalid();
    }
    Ok(())
}

fn validate_wake_phrase(value: &Value) -> Result<(), RuntimeProfileValidationError> {
    let phrase = object(value)?;
    exact_keys(phrase, &["phraseId", "phrase", "language", "revision"], &[])?;
    required_catalog_text_with_limit(field(phrase, "phraseId")?, 128)?;
    let text = string(field(phrase, "phrase")?)?;
    if text.len() > MAX_WAKE_PHRASE_BYTES || !is_runtime_profile_wake_phrase_text(text) {
        return invalid();
    }
    required_locale_text(field(phrase, "language")?)?;
    required_catalog_text_with_limit(field(phrase, "revision")?, 128)?;
    Ok(())
}

fn validate_desktop_overlay(value: &Value) -> Result<(), RuntimeProfileValidationError> {
    let overlay = object(value)?;
    exact_keys(
        overlay,
        &["enabled", "voiceEnabled", "textHotkey", "autoCloseDelayMs"],
        &[],
    )?;
    boolean(field(overlay, "enabled")?)?;
    boolean(field(overlay, "voiceEnabled")?)?;
    let hotkey = string(field(overlay, "textHotkey")?)?;
    if !canonical_hotkey(hotkey) {
        return invalid();
    }
    if unsigned_integer(field(overlay, "autoCloseDelayMs")?)? > MAX_OVERLAY_DELAY_MS {
        return invalid();
    }
    Ok(())
}

fn validate_ice_servers(value: &Value, stun: bool) -> Result<(), RuntimeProfileValidationError> {
    let servers = array(value)?;
    if servers.len() > MAX_ICE_SERVERS {
        return invalid();
    }
    let prefixes: &[&str] = if stun {
        &["stun:", "stuns:"]
    } else {
        &["turn:", "turns:"]
    };
    for server in servers {
        let text = string(server)?;
        if !is_canonical_profile_text(text, MAX_ICE_SERVER_BYTES) {
            return invalid();
        }
        let colon = text.find(':').ok_or(RuntimeProfileValidationError)?;
        let scheme = text[..=colon].to_ascii_lowercase();
        if !prefixes.contains(&scheme.as_str()) {
            return invalid();
        }
        let remainder = &text[colon + 1..];
        let (authority, query) = remainder
            .split_once('?')
            .map_or((remainder, None), |(authority, query)| {
                (authority, Some(query))
            });
        if authority.contains('@') {
            return invalid();
        }
        if let Some(query) = query {
            if form_urlencoded::parse(query.as_bytes())
                .any(|(key, _)| is_runtime_profile_secret_query_key(&key))
            {
                return invalid();
            }
        }
    }
    Ok(())
}

fn optional_endpoint<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    protocols: &[&str],
) -> Result<Option<&'a str>, RuntimeProfileValidationError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let value = string(value)?;
    if !canonical_endpoint(value, protocols) {
        return invalid();
    }
    Ok(Some(value))
}

fn canonical_endpoint(value: &str, protocols: &[&str]) -> bool {
    if !is_canonical_profile_text(value, usize::MAX) {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !protocols.iter().any(|protocol| url.scheme() == *protocol)
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return false;
    }
    if url.query().is_some_and(|query| {
        form_urlencoded::parse(query.as_bytes())
            .any(|(key, _)| is_runtime_profile_secret_query_key(&key))
    }) {
        return false;
    }
    let serialized = url.as_str();
    serialized.strip_suffix('/').unwrap_or(serialized) == value
}

fn optional_speech_language(
    object: &Map<String, Value>,
    key: &str,
    allow_auto: bool,
) -> Result<(), RuntimeProfileValidationError> {
    let Some(value) = object.get(key) else {
        return Ok(());
    };
    let value = string(value)?;
    if value.len() > MAX_SPEECH_LANGUAGE_BYTES
        || (value == "auto" && !allow_auto)
        || (value != "auto" && !valid_speech_language(value))
    {
        return invalid();
    }
    Ok(())
}

fn valid_speech_language(value: &str) -> bool {
    if value.len() < 2 || value.len() > MAX_SPEECH_LANGUAGE_BYTES || !value.is_ascii() {
        return false;
    }
    let mut segments = value.split('-');
    let Some(first) = segments.next() else {
        return false;
    };
    let subtags: Vec<&str> = segments.collect();
    let ordinary =
        (2..=8).contains(&first.len()) && first.bytes().all(|byte| byte.is_ascii_lowercase());
    let private_use = matches!(first, "i" | "x")
        && !subtags.is_empty()
        && subtags
            .iter()
            .all(|segment| (1..=8).contains(&segment.len()));
    (ordinary || private_use)
        && subtags.iter().all(|segment| {
            (1..=8).contains(&segment.len())
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn required_locale_text(value: &Value) -> Result<(), RuntimeProfileValidationError> {
    let value = string(value)?;
    if value.len() > MAX_WAKE_LOCALE_BYTES {
        return invalid();
    }
    let mut segments = value.split('-');
    let first = segments.next().ok_or(RuntimeProfileValidationError)?;
    let valid_first = first == "und"
        || ((2..=3).contains(&first.len()) && first.bytes().all(|byte| byte.is_ascii_alphabetic()));
    if !valid_first
        || segments.count() > 6
        || value.split('-').skip(1).any(|segment| {
            !(2..=8).contains(&segment.len())
                || !segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
    {
        return invalid();
    }
    Ok(())
}

fn required_catalog_text(value: &Value) -> Result<&str, RuntimeProfileValidationError> {
    required_catalog_text_with_limit(value, MAX_CATALOG_TEXT_BYTES)
}

fn optional_catalog_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, RuntimeProfileValidationError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    required_catalog_text(value).map(Some)
}

fn required_catalog_text_with_limit(
    value: &Value,
    limit: usize,
) -> Result<&str, RuntimeProfileValidationError> {
    let text = required_text(value, limit)?;
    let mut bytes = text.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._:+/@-".contains(&byte))
    {
        return invalid();
    }
    Ok(text)
}

fn canonical_hotkey(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_OVERLAY_HOTKEY_BYTES || !value.is_ascii() {
        return false;
    }
    let parts: Vec<&str> = value.split('+').collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    let key = parts[parts.len() - 1];
    if key.len() != 1
        || (!key.as_bytes()[0].is_ascii_uppercase() && !key.as_bytes()[0].is_ascii_digit())
    {
        return false;
    }
    let mut modifiers = BTreeSet::new();
    parts[..parts.len() - 1].iter().all(|modifier| {
        matches!(*modifier, "CommandOrControl" | "Command" | "Alt" | "Shift")
            && modifiers.insert(*modifier)
    })
}

fn optional_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    limit: usize,
) -> Result<Option<&'a str>, RuntimeProfileValidationError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    required_text(value, limit).map(Some)
}

fn optional_boolean(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<bool>, RuntimeProfileValidationError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    boolean(value).map(Some)
}

fn required_text(value: &Value, limit: usize) -> Result<&str, RuntimeProfileValidationError> {
    let value = string(value)?;
    if !is_canonical_profile_text(value, limit) {
        return invalid();
    }
    Ok(value)
}

fn enum_text<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a str, RuntimeProfileValidationError> {
    let value = string(value)?;
    if allowed.contains(&value) {
        Ok(value)
    } else {
        invalid()
    }
}

fn exact_keys(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), RuntimeProfileValidationError> {
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return invalid();
    }
    Ok(())
}

fn field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Value, RuntimeProfileValidationError> {
    object.get(key).ok_or(RuntimeProfileValidationError)
}

fn object(value: &Value) -> Result<&Map<String, Value>, RuntimeProfileValidationError> {
    value.as_object().ok_or(RuntimeProfileValidationError)
}

fn array(value: &Value) -> Result<&[Value], RuntimeProfileValidationError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or(RuntimeProfileValidationError)
}

fn string(value: &Value) -> Result<&str, RuntimeProfileValidationError> {
    value.as_str().ok_or(RuntimeProfileValidationError)
}

fn boolean(value: &Value) -> Result<bool, RuntimeProfileValidationError> {
    value.as_bool().ok_or(RuntimeProfileValidationError)
}

fn unsigned_integer(value: &Value) -> Result<u64, RuntimeProfileValidationError> {
    value.as_u64().ok_or(RuntimeProfileValidationError)
}

fn canonical_text(value: &str, limit: usize) -> bool {
    is_canonical_profile_text(value, limit)
}

fn invalid<T>() -> Result<T, RuntimeProfileValidationError> {
    Err(RuntimeProfileValidationError)
}

#[cfg(test)]
mod tests {
    use super::{
        validate_canonical_runtime_profile_document, RuntimeProfileValidationError,
        RuntimeProfileValidationOptions, ValidatedRuntimeProfileDocument,
        MAX_RUNTIME_PROFILE_COUNT, MAX_RUNTIME_PROFILE_DOCUMENT_BYTES,
    };
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::fmt::Debug;

    #[derive(Deserialize)]
    struct FixtureFile {
        vectors: Vec<FixtureVector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureVector {
        name: String,
        allow_python_full: bool,
        canonical_json: String,
    }

    fn options(allow_python_full: bool) -> RuntimeProfileValidationOptions {
        RuntimeProfileValidationOptions { allow_python_full }
    }

    fn accept(
        text: &str,
    ) -> Result<ValidatedRuntimeProfileDocument, RuntimeProfileValidationError> {
        validate_canonical_runtime_profile_document(text, options(false))
    }

    fn reject(text: &str) {
        assert!(matches!(accept(text), Err(RuntimeProfileValidationError)));
    }

    fn empty_document() -> String {
        r#"{"version":2,"activeProfileId":null,"profiles":[]}"#.to_owned()
    }

    fn profile_document(profile: Value, active: &str) -> String {
        json!({"version":2,"activeProfileId":active,"profiles":[profile]}).to_string()
    }

    fn remote_profile() -> Value {
        json!({
            "version":2,
            "id":"home",
            "label":"Home",
            "nodeMode":"remote-console",
            "runtimeTier":"none",
            "homeConnection":{"mode":"http-only","gatewayUrl":"https://gateway.example.test"},
            "localNode":{"nodeName":"Local Aurora","stablePeerId":"local-node","enabledCapabilityPacks":[]}
        })
    }

    fn mesh_profile() -> Value {
        json!({
            "version":2,
            "id":"node",
            "label":"My device",
            "nodeMode":"mesh-node",
            "runtimeTier":"lightweight-ts",
            "localNode":{
                "nodeName":"Local Aurora",
                "stablePeerId":"local-node",
                "enabledCapabilityPacks":[],
                "meshMembership":{
                    "signalingUrl":"wss://signal.example.test",
                    "webrtcProfile":{
                        "mode":"webrtc-only",
                        "appId":"aurora",
                        "room":"family-room",
                        "roomSecretRef":"ref:memory:family-room",
                        "signalingBrokers":["wss://signal.example.test"]
                    }
                }
            }
        })
    }

    fn assert_redacted<T: Debug>(value: &T, forbidden: &str) {
        assert!(!format!("{value:?}").contains(forbidden));
    }

    #[test]
    fn accepts_invite_free_local_inference_profile() {
        let mut profile = mesh_profile();
        profile["localNode"]
            .as_object_mut()
            .expect("local node")
            .remove("meshMembership");
        profile["localNode"]["enabledCapabilityPacks"] = json!(["local-inference"]);
        let text = profile_document(profile.clone(), "node");
        assert_eq!(accept(&text).expect("on-device profile").as_json(), text);

        // On-device setup does not grant network/native actions.
        profile["localNode"]["enabledCapabilityPacks"] = json!(["native-actions"]);
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn accepts_shared_ui_canonical_json_and_preserves_exact_bytes() {
        let fixtures: FixtureFile = serde_json::from_str(include_str!(
            "../tests/fixtures/runtime-profile-canonical-v2.json"
        ))
        .expect("shared nonsecret canonical profile vectors parse");
        assert_eq!(fixtures.vectors.len(), 13);
        for vector in fixtures.vectors {
            let result = validate_canonical_runtime_profile_document(
                &vector.canonical_json,
                options(vector.allow_python_full),
            )
            .unwrap_or_else(|_| panic!("canonical vector rejected: {}", vector.name));
            assert_eq!(
                result.as_json(),
                vector.canonical_json.as_str(),
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn preserves_original_whitespace_and_rejects_rewrite_or_serde_markers() {
        let text = " { \"version\" : 2, \"activeProfileId\" : null, \"profiles\" : [] }\n";
        assert_eq!(accept(text).expect("valid whitespace").as_json(), text);
        let marker_text = r#"{"version":2,"activeProfileId":"home","profiles":[{"version":2,"id":"home","label":"$serde_json::private::Number","nodeMode":"remote-console","runtimeTier":"none","homeConnection":{"mode":"http-only","gatewayUrl":"https://gateway.example.test"},"localNode":{"nodeName":"Local Aurora","stablePeerId":"local-node","enabledCapabilityPacks":[]}}]}"#;
        assert!(accept(marker_text).is_ok());
        reject(
            r#"{"version":{"$serde_json::private::Number":"2"},"activeProfileId":null,"profiles":[]}"#,
        );
        reject(
            r#"{"version":2,"activeProfileId":null,"profiles":[],"x":{"$serde_json::private::RawValue":"{}"}}"#,
        );
        reject(
            r#"{"version":2,"activeProfileId":null,"profiles":[],"label":{"$serde_json::private::Number":"7"}}"#,
        );
        reject(r#"{"version":2,"activeProfileId":null,"profiles":[],"" : "not allowed"}"#);
    }

    #[test]
    fn rejects_duplicate_keys_at_every_depth_and_escaped_key_aliases() {
        reject(r#"{"version":2,"version":2,"activeProfileId":null,"profiles":[]}"#);
        reject(
            r#"{"version":2,"activeProfileId":"home","profiles":[{"version":2,"id":"home","label":"first","nodeMode":"remote-console","runtimeTier":"none","homeConnection":{"mode":"http-only","gatewayUrl":"https://gateway.example.test"},"localNode":{"nodeName":"Local Aurora","stablePeerId":"local-node","enabledCapabilityPacks":[]},"label":"second"}]}"#,
        );
        reject(
            r#"{"version":2,"activeProfileId":"home","profiles":[{"version":2,"id":"home","label":"Home","nodeMode":"remote-console","runtimeTier":"none","homeConnection":{"mode":"http-only","gatewayUrl":"https://gateway.example.test"},"localNode":{"nodeName":"Local Aurora","stablePeerId":"local-node","enabledCapabilityPacks":[]},"\u0069d":"home"}]}"#,
        );
        reject(
            r#"{"version":2,"activeProfileId":"home","profiles":[{"version":2,"id":"home","label":"Home","nodeMode":"remote-console","runtimeTier":"none","homeConnection":{"mode":"http-only","gatewayUrl":"https://gateway.example.test"},"localNode":{"nodeName":"first","nodeName":"second","stablePeerId":"local-node","enabledCapabilityPacks":[]}}]}"#,
        );
    }

    #[test]
    fn rejects_unknown_missing_null_and_wrong_typed_fields() {
        reject("");
        reject(r#"{"version":2,"activeProfileId":null,"profiles":[] trailing}"#);
        reject(r#"{"version":2,"activeProfileId":null}"#);
        reject(r#"{"version":2,"activeProfileId":null,"profiles":[],"extra":false}"#);
        reject(r#"{"version":2.0,"activeProfileId":null,"profiles":[]}"#);
        reject(r#"{"version":2,"activeProfileId":null,"profiles":[null]}"#);
        let mut profile = remote_profile();
        profile["label"] = Value::Null;
        reject(&profile_document(profile, "home"));
        let mut profile = remote_profile();
        profile["homeConnection"]["signalingUrl"] = Value::Null;
        reject(&profile_document(profile, "home"));
        reject(
            r#"{"version":2,"activeProfileId":{"$serde_json::private::RawValue":"\"home\""},"profiles":[]}"#,
        );
    }

    #[test]
    fn rejects_profile_role_and_connection_contradictions() {
        let mut profile = remote_profile();
        profile["runtimeTier"] = json!("lightweight-ts");
        reject(&profile_document(profile, "home"));

        let mut profile = mesh_profile();
        profile["runtimeTier"] = json!("none");
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]
            .as_object_mut()
            .expect("local node object")
            .remove("meshMembership");
        reject(&profile_document(profile, "node"));

        let mut profile = remote_profile();
        profile["localNode"]["enabledCapabilityPacks"] = json!(["local-tools"]);
        reject(&profile_document(profile, "home"));

        let mut profile = remote_profile();
        profile["homeConnection"]["mode"] = json!("webrtc-preferred");
        reject(&profile_document(profile, "home"));

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["webrtcProfile"]["mode"] = json!("webrtc-preferred");
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["signalingUrl"] = json!("wss://other.example.test");
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn rejects_explicit_nulls_and_unknown_fields_at_nested_boundaries() {
        let mut profile = remote_profile();
        profile["homeConnection"]["homePeerId"] = Value::Null;
        reject(&profile_document(profile, "home"));

        let mut profile = mesh_profile();
        profile["localNode"]["primaryLanguage"] = Value::Null;
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechPackState"] = Value::Null;
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["webrtcProfile"]["production"] = Value::Null;
        reject(&profile_document(profile, "node"));

        let mut profile = remote_profile();
        profile["homeConnection"]["unknown"] = json!(false);
        reject(&profile_document(profile, "home"));

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["webrtcProfile"]["unknown"] = json!(false);
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechSelection"] = json!({
            "stt":{"packId":"stt","packRevision":"1","unknown":"x"}
        });
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechSelection"] = json!({
            "wakePhrase":{"phraseId":"wake","phrase":"Hello","language":"en","revision":"1","unknown":"x"}
        });
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":true,"textHotkey":"CommandOrControl+K","autoCloseDelayMs":1200,"unknown":false
        });
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn validates_every_profile_and_active_selection() {
        let mut invalid_inactive = remote_profile();
        invalid_inactive["id"] = json!("inactive");
        invalid_inactive["runtimeTier"] = json!("python-full");
        let text = json!({
            "version":2,
            "activeProfileId":"home",
            "profiles":[remote_profile(),invalid_inactive]
        })
        .to_string();
        reject(&text);
        reject(r#"{"version":2,"activeProfileId":"missing","profiles":[]}"#);
        reject(r#"{"version":1,"activeProfileId":null,"profiles":[]}"#);
        let duplicate = json!({
            "version":2,
            "activeProfileId":"home",
            "profiles":[remote_profile(),remote_profile()]
        })
        .to_string();
        reject(&duplicate);
        assert!(accept(&empty_document()).is_ok());
    }

    #[test]
    fn rejects_noncanonical_identity_edges_and_marker_objects() {
        for id in ["\u{feff}profile", "profile\u{feff}"] {
            let mut profile = remote_profile();
            profile["id"] = json!(id);
            reject(&profile_document(profile, id));

            let mut profile = mesh_profile();
            profile["localNode"]["stablePeerId"] = json!(id);
            reject(&profile_document(profile, "node"));
        }

        let mut profile = remote_profile();
        profile["id"] = json!({"$serde_json::private::Number":"7"});
        reject(&profile_document(profile, "home"));

        let mut profile = mesh_profile();
        profile["localNode"]["stablePeerId"] = json!({"$serde_json::private::RawValue":"\"peer\""});
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechSelection"] = json!({
            "stt":{"packId":{"$serde_json::private::Number":"1"},"packRevision":"1"}
        });
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn allows_non_ecmascript_trim_controls_inside_ids_without_rewriting() {
        let profile_id = "profile\u{0085}id";
        let mut profile = remote_profile();
        profile["id"] = json!(profile_id);
        let text = profile_document(profile, profile_id);
        assert_eq!(
            accept(&text)
                .expect("NEL is not trimmed by ECMAScript")
                .as_json(),
            text
        );
    }

    #[test]
    fn python_full_requires_trusted_native_option() {
        let mut profile = mesh_profile();
        profile["runtimeTier"] = json!("python-full");
        let text = profile_document(profile, "node");
        assert!(matches!(accept(&text), Err(RuntimeProfileValidationError)));
        assert!(validate_canonical_runtime_profile_document(&text, options(true)).is_ok());
    }

    #[test]
    fn enforces_byte_and_profile_count_limits() {
        let too_large = format!(
            "{{\"version\":2,\"activeProfileId\":null,\"profiles\":[],\"padding\":\"{}\"}}",
            "x".repeat(MAX_RUNTIME_PROFILE_DOCUMENT_BYTES)
        );
        reject(&too_large);
        let exact_empty_size = format!(
            "{}{}",
            empty_document(),
            " ".repeat(MAX_RUNTIME_PROFILE_DOCUMENT_BYTES - empty_document().len())
        );
        assert!(accept(&exact_empty_size).is_ok());

        let profiles = vec![remote_profile(); MAX_RUNTIME_PROFILE_COUNT + 1];
        let too_many = json!({"version":2,"activeProfileId":null,"profiles":profiles}).to_string();
        reject(&too_many);

        let profiles: Vec<Value> = (0..MAX_RUNTIME_PROFILE_COUNT)
            .map(|index| {
                let mut profile = remote_profile();
                profile["id"] = json!(format!("home-{index}"));
                profile
            })
            .collect();
        let exact_count =
            json!({"version":2,"activeProfileId":null,"profiles":profiles}).to_string();
        assert!(accept(&exact_count).is_ok());
    }

    #[test]
    fn validates_capability_order_speech_assets_wake_phrase_and_overlay() {
        let mut profile = mesh_profile();
        profile["localNode"]["enabledCapabilityPacks"] = json!(["native-actions", "local-tools"]);
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["enabledCapabilityPacks"] = json!(["local-tools", "local-tools"]);
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechSelection"] = json!({
            "tts":{"packId":"tts","packRevision":"1","voiceId":"voice","voiceRevision":"2"},
            "wakePhrase":{"phraseId":"wake","phrase":"Olá Aurora","language":"pt-BR","revision":"1"}
        });
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":false,"textHotkey":"CommandOrControl+K","autoCloseDelayMs":1200
        });
        assert!(accept(&profile_document(profile.clone(), "node")).is_ok());
        profile["localNode"]["localSpeechSelection"]["tts"]["voiceRevision"] = Value::Null;
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechSelection"] = json!({
            "wakePhrase":{"phraseId":"wake","phrase":"password please","language":"en","revision":"1"}
        });
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":true,"textHotkey":"Command+Command+K","autoCloseDelayMs":1
        });
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn speech_language_asset_wake_and_overlay_values_match_serialized_ui_rules() {
        let mut profile = mesh_profile();
        profile["localNode"]["primaryLanguage"] = json!("auto");
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["voiceLanguage"] = json!("auto");
        assert!(accept(&profile_document(profile, "node")).is_ok());

        for language in ["en_US", "EN", "i-a", "x-private-use"] {
            let mut profile = mesh_profile();
            profile["localNode"]["primaryLanguage"] = json!(language);
            if language == "i-a" || language == "x-private-use" {
                assert!(
                    accept(&profile_document(profile, "node")).is_ok(),
                    "{language}"
                );
            } else {
                reject(&profile_document(profile, "node"));
            }
        }

        for state in [
            "ready",
            "disabled",
            "downloading",
            "incompatible",
            "over-budget",
            "unavailable",
        ] {
            let mut profile = mesh_profile();
            profile["localNode"]["localSpeechPackState"] = json!(state);
            assert!(
                accept(&profile_document(profile, "node")).is_ok(),
                "{state}"
            );
        }
        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechPackState"] = json!("unknown");
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["localSpeechSelection"] = json!({
            "wakePhrase":{"phraseId":"wake","phrase":"hello","language":"en","revision":"1"}
        });
        assert!(accept(&profile_document(profile, "node")).is_ok());

        for selection in [
            json!({"task":{"packId":"stt","packRevision":"1"}}),
            json!({"tts":{"packId":"tts","packRevision":"1"}}),
            json!({"stt":{"packId":"bad id","packRevision":"1"}}),
            json!({"stt":{"packId":"stt","packRevision":"1","voiceId":"voice"}}),
            json!({"wakePhrase":{"phraseId":"wake","phrase":"hello","language":"en_US","revision":"1"}}),
            json!({"wakePhrase":{"phraseId":"bad id","phrase":"hello","language":"en","revision":"1"}}),
        ] {
            let mut profile = mesh_profile();
            profile["localNode"]["localSpeechSelection"] = selection;
            reject(&profile_document(profile, "node"));
        }

        let mut profile = mesh_profile();
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":true,"textHotkey":"ctrl+K","autoCloseDelayMs":1200
        });
        reject(&profile_document(profile, "node"));
        let mut profile = mesh_profile();
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":true,"textHotkey":"CommandOrControl+K","autoCloseDelayMs":1.5
        });
        reject(&profile_document(profile, "node"));
        let mut profile = mesh_profile();
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":true,"textHotkey":"CommandOrControl+K","autoCloseDelayMs":60001
        });
        reject(&profile_document(profile, "node"));
        let mut profile = mesh_profile();
        profile["localNode"]["desktopOverlay"] = json!({
            "enabled":true,"voiceEnabled":"true","textHotkey":"CommandOrControl+K","autoCloseDelayMs":1200
        });
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn validates_webrtc_text_bounds_and_ice_policy() {
        for field in ["appId", "room", "roomSecretRef"] {
            let mut profile = mesh_profile();
            let limit = match field {
                "appId" => 256,
                "room" => 512,
                _ => 1024,
            };
            profile["localNode"]["meshMembership"]["webrtcProfile"][field] =
                json!("x".repeat(limit + 1));
            reject(&profile_document(profile, "node"));
        }

        for ice in [
            json!(["stun:user@server.example.test"]),
            json!(["stun:server.example.test?pa%C5%BF%C5%BFword=hidden"]),
            json!(vec!["stun:server"; 17]),
        ] {
            let mut profile = mesh_profile();
            profile["localNode"]["meshMembership"]["webrtcProfile"]["stunServers"] = ice;
            reject(&profile_document(profile, "node"));
        }

        let membership_webrtc =
            mesh_profile()["localNode"]["meshMembership"]["webrtcProfile"].clone();
        let mut profile = remote_profile();
        profile["homeConnection"] = json!({
            "mode":"webrtc-only",
            "signalingUrl":"wss://signal.example.test",
            "webrtcProfile":membership_webrtc
        });
        assert!(accept(&profile_document(profile.clone(), "home")).is_ok());
        profile["homeConnection"]["signalingUrl"] = json!("wss://other.example.test");
        reject(&profile_document(profile, "home"));

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["webrtcProfile"]["production"] = json!("yes");
        reject(&profile_document(profile, "node"));

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["webrtcProfile"]["stunServers"] =
            json!(vec!["stun:"; 16]);
        assert!(accept(&profile_document(profile, "node")).is_ok());
    }

    #[test]
    fn endpoint_validation_matches_canonical_url_output_and_secret_query_rules() {
        for url in [
            "https://gateway.example.test/#",
            "https://gateway.example.test/?",
            "https://xn--bcher-kva.example",
            "https://gateway.example.test/?room=public",
        ] {
            let mut profile = remote_profile();
            profile["homeConnection"]["gatewayUrl"] = json!(url);
            assert!(accept(&profile_document(profile, "home")).is_ok(), "{url}");
        }
        for url in [
            "https://user:pass@gateway.example.test",
            "https://gateway.example.test/#private",
            "https://gateway.example.test/?%74oken=secret",
            "ftp://gateway.example.test",
            "https://gateway.example.test/",
        ] {
            let mut profile = remote_profile();
            profile["homeConnection"]["gatewayUrl"] = json!(url);
            reject(&profile_document(profile, "home"));
        }

        let mut profile = mesh_profile();
        profile["localNode"]["meshMembership"]["webrtcProfile"]["signalingBrokers"] =
            json!(vec!["wss://signal.example.test"; 17]);
        reject(&profile_document(profile, "node"));
    }

    #[test]
    fn multi_broker_first_ui_output_is_accepted_without_fixed_point_rewrite() {
        let text = include_str!("../tests/fixtures/runtime-profile-canonical-v2.json");
        let fixtures: FixtureFile = serde_json::from_str(text).expect("fixture file");
        let vector = fixtures
            .vectors
            .into_iter()
            .find(|item| item.name == "derived-signaling-multiple-brokers-first-output")
            .expect("derived signaling vector");
        let accepted = accept(&vector.canonical_json).expect("first canonical UI output");
        assert_eq!(accepted.as_json(), vector.canonical_json.as_str());
        let parsed: Value =
            serde_json::from_str(accepted.as_json()).expect("preserved accepted bytes");
        assert_eq!(
            parsed["profiles"][0]["homeConnection"]["webrtcProfile"]["signalingBrokers"],
            json!([
                "wss://signal.example.test",
                "wss://second.example.test/mqtt"
            ])
        );
    }

    #[test]
    fn errors_and_debug_redact_document_contents() {
        let secret =
            r#"{"version":2,"activeProfileId":null,"profiles":[],"secret":"sensitive-token"}"#;
        let error = accept(secret).expect_err("unknown field rejected");
        assert_redacted(&error, "sensitive-token");
        assert_eq!(error.to_string(), "runtime profile document is invalid");
        let accepted = accept(&empty_document()).expect("empty document");
        assert_redacted(&accepted, "activeProfileId");
        assert_redacted(&accepted, "profiles");
    }
}
