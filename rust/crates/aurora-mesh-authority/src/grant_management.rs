//! Port of `packages/aurora-sdk/src/peer-host/grant-management.ts`.
//!
//! What a person is allowed to share, expressed as validation. Every rule here
//! is a denial path: over-long identifiers, path traversal, wildcards, names
//! that smell of secrets, names that smell of command execution, resource
//! scopes that smell of SQL or a shell, selections that are empty or too large,
//! and expiries in the past or beyond a year.
//!
//! ## Where TypeScript was loose
//!
//! * The four `RegExp` literals are transliterated into explicit matchers
//!   rather than pulled through a regex engine. Each one is documented against
//!   the pattern it replaces, and the shared fixture corpus drives both
//!   languages over the same inputs so a divergence fails loudly.
//! * `PeerGrantManager` serialises writes behind a promise queue because a
//!   JavaScript method taking `this` can interleave at every `await`. Rust
//!   takes `&mut self` on the write paths, so the compiler enforces the same
//!   exclusion at no runtime cost, and the queue has no Rust counterpart.
//! * `defaultGrantId()` reaches for `globalThis.crypto`. Rust injects the
//!   generator; with none supplied a create attempt fails with
//!   `secure_random_unavailable`, which is what the TypeScript does in an
//!   environment without WebCrypto.

use crate::authority::{
    compare_grants, LocalPeerGrantV1, PeerGrantRepository, PeerRelationshipSelector,
};

const MAX_IDENTIFIER_LENGTH: usize = 256;
const MAX_RESOURCE_SCOPE_LENGTH: usize = 512;
const MAX_SELECTION_ITEMS: usize = 128;

/// A grant may not be scheduled to expire more than one leap year out.
pub const DEFAULT_MAX_EXPIRY_WINDOW_MS: i64 = 366 * 24 * 60 * 60 * 1000;

/// Names that read as secret material and may never appear in a selection.
///
/// Transliterates `/bearer|proof|token|tokenhash|verifier|credential|password|secret|private[-_]?key/iu`.
/// `tokenhash` is subsumed by `token` and `private[-_]?key` expands to its
/// three spellings.
const FORBIDDEN_SECRET_SUBSTRINGS: [&str; 11] = [
    "bearer",
    "proof",
    "token",
    "verifier",
    "credential",
    "password",
    "secret",
    "privatekey",
    "private-key",
    "private_key",
    "tokenhash",
];

/// Separator class from the execution-identifier pattern: `[.:@/-]`.
const IDENTIFIER_SEPARATORS: [char; 5] = ['.', ':', '@', '/', '-'];

/// Words that may not appear as a separated component of an identifier.
///
/// Transliterates the alternation in
/// `/(?:^|[.:@/-])(?:shell[.:@/-]+exec|process[.:@/-]+spawn|exec|spawn|sudo|bash|sh|powershell|cmd)(?:$|[.:@/-])/iu`.
/// The two multi-word alternatives are subsumed: `shell.exec` already contains
/// `exec` bounded by a separator on both sides, and likewise `process.spawn`.
const FORBIDDEN_EXECUTION_WORDS: [&str; 7] =
    ["exec", "spawn", "sudo", "bash", "sh", "powershell", "cmd"];

/// Schemes a resource scope may not start with.
///
/// From the left branch of `/^(?:sql|sqlite|shell|process)(?::|$)|…/iu`.
const FORBIDDEN_RESOURCE_SCHEMES: [&str; 4] = ["sql", "sqlite", "shell", "process"];

/// Words a resource scope may not contain on a word boundary.
///
/// From the right branch of the same pattern.
const FORBIDDEN_RESOURCE_WORDS: [&str; 11] = [
    "select",
    "insert",
    "drop",
    "alter",
    "pragma",
    "chmod",
    "chown",
    "sudo",
    "bash",
    "powershell",
    "cmd",
];

/// Why a sharing change was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerGrantManagementErrorCode {
    /// The relationship key was malformed.
    InvalidSelector,
    /// The selection was empty, too large, or contained a refused identifier.
    InvalidSelection,
    /// The expiry was in the past, unrepresentable, or beyond the window.
    InvalidExpiry,
    /// The backing repository could not be reached.
    RepositoryUnavailable,
    /// No secure source of grant identifiers is available.
    SecureRandomUnavailable,
}

impl PeerGrantManagementErrorCode {
    /// Wire spelling, identical to the TypeScript string union member.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidSelector => "invalid_selector",
            Self::InvalidSelection => "invalid_selection",
            Self::InvalidExpiry => "invalid_expiry",
            Self::RepositoryUnavailable => "repository_unavailable",
            Self::SecureRandomUnavailable => "secure_random_unavailable",
        }
    }
}

/// A refused sharing change.
///
/// `message` is product copy — it surfaces in the sharing settings UI — so it
/// says "Choose at least one item to share", never a validator name. The
/// machine-readable half is `code`.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct PeerGrantManagementError {
    /// Machine-readable cause.
    pub code: PeerGrantManagementErrorCode,
    /// Product copy.
    pub message: String,
}

impl PeerGrantManagementError {
    fn new(code: PeerGrantManagementErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid_selection(field: &str) -> Self {
        Self::new(
            PeerGrantManagementErrorCode::InvalidSelection,
            format!("Invalid {field} selection"),
        )
    }

    fn repository_unavailable() -> Self {
        Self::new(
            PeerGrantManagementErrorCode::RepositoryUnavailable,
            "Sharing settings are unavailable",
        )
    }
}

/// Convenience alias for sharing fallibility.
pub type GrantManagementResult<T> = Result<T, PeerGrantManagementError>;

/// What a person chose to share.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct PeerGrantSelection {
    /// Methods to share.
    #[serde(rename = "allowedMethodIds", default)]
    pub allowed_method_ids: Vec<String>,
    /// Tool contracts to share.
    #[serde(rename = "allowedToolContractIds", default)]
    pub allowed_tool_contract_ids: Vec<String>,
    /// Capability packs to share.
    #[serde(rename = "capabilityPackIds", default)]
    pub capability_pack_ids: Vec<String>,
    /// Resource scopes to share.
    #[serde(rename = "resourceScopes", default)]
    pub resource_scopes: Vec<String>,
    /// Optional expiry.
    #[serde(
        rename = "expiresAtMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at_ms: Option<i64>,
}

/// A normalized selection: sorted, de-duplicated, and known safe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedPeerGrantSelection {
    /// Methods, sorted and de-duplicated.
    pub allowed_method_ids: Vec<String>,
    /// Tool contracts, sorted and de-duplicated.
    pub allowed_tool_contract_ids: Vec<String>,
    /// Capability packs, sorted and de-duplicated.
    pub capability_pack_ids: Vec<String>,
    /// Resource scopes, sorted and de-duplicated.
    pub resource_scopes: Vec<String>,
    /// Optional expiry, known to be inside the window.
    pub expires_at_ms: Option<i64>,
}

/// How a grant reads to a person.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerGrantSharingState {
    /// Live.
    Active,
    /// Past its expiry.
    Expired,
    /// Withdrawn.
    Revoked,
}

impl PeerGrantSharingState {
    /// Wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }
}

/// The redacted view of a grant the sharing settings render.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct PeerGrantSummary {
    /// Stable grant identity.
    #[serde(rename = "grantId")]
    pub grant_id: String,
    /// Peer the grant is issued to.
    #[serde(rename = "claimantPeerId")]
    pub claimant_peer_id: String,
    /// Peer that issued it.
    #[serde(rename = "verifierPeerId")]
    pub verifier_peer_id: String,
    /// Room it lives in.
    #[serde(rename = "roomName")]
    pub room_name: String,
    /// Methods shared, sorted.
    #[serde(rename = "allowedMethodIds")]
    pub allowed_method_ids: Vec<String>,
    /// Tool contracts shared, sorted.
    #[serde(rename = "allowedToolContractIds")]
    pub allowed_tool_contract_ids: Vec<String>,
    /// Capability packs shared, sorted.
    #[serde(rename = "capabilityPackIds")]
    pub capability_pack_ids: Vec<String>,
    /// Resource scopes shared, sorted.
    #[serde(rename = "resourceScopes")]
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
    /// Monotonic revision.
    #[serde(rename = "grantRevision")]
    pub grant_revision: i64,
    /// How it reads to a person.
    #[serde(rename = "sharingState")]
    pub sharing_state: PeerGrantSharingState,
    /// Always true.
    #[serde(rename = "secretFieldsRedacted")]
    pub secret_fields_redacted: bool,
    /// Names of the fields withheld.
    #[serde(rename = "redactedFields")]
    pub redacted_fields: Vec<String>,
}

/// Mints grant identifiers.
pub trait GrantIdSource: Send + Sync {
    /// Produce a fresh identifier, or `None` when no secure source exists.
    fn next_grant_id(&self) -> Option<String>;
}

impl<F> GrantIdSource for F
where
    F: Fn() -> Option<String> + Send + Sync,
{
    fn next_grant_id(&self) -> Option<String> {
        self()
    }
}

/// Reads and writes the durable sharing settings for one relationship.
pub struct PeerGrantManager<R>
where
    R: PeerGrantRepository,
{
    repository: R,
    grant_id_source: Option<Box<dyn GrantIdSource>>,
    max_future_expiry_ms: i64,
}

impl<R> PeerGrantManager<R>
where
    R: PeerGrantRepository,
{
    /// A manager with no identifier source. Creating a new grant will fail with
    /// `secure_random_unavailable`; reads and revocations still work.
    pub fn new(repository: R) -> Self {
        Self {
            repository,
            grant_id_source: None,
            max_future_expiry_ms: DEFAULT_MAX_EXPIRY_WINDOW_MS,
        }
    }

    /// Supply the identifier source.
    #[must_use]
    pub fn with_grant_id_source(mut self, source: Box<dyn GrantIdSource>) -> Self {
        self.grant_id_source = Some(source);
        self
    }

    /// Narrow the expiry window.
    #[must_use]
    pub fn with_max_future_expiry_ms(mut self, max_future_expiry_ms: i64) -> Self {
        self.max_future_expiry_ms = max_future_expiry_ms;
        self
    }

    /// Borrow the repository.
    pub fn repository(&self) -> &R {
        &self.repository
    }

    /// Hand the repository back, so a caller that lent one can take it home.
    pub fn into_repository(self) -> R {
        self.repository
    }

    /// Every live grant for the relationship, newest revision first.
    pub async fn list_active_grants(
        &self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> GrantManagementResult<Vec<PeerGrantSummary>> {
        let parsed = validate_selector(selector)?;
        let now_ms = validate_now(now_ms)?;
        let grants = self
            .repository
            .list_recipient_grants(&parsed, now_ms)
            .await
            .map_err(|_| PeerGrantManagementError::repository_unavailable())?;
        let mut active: Vec<LocalPeerGrantV1> = grants
            .into_iter()
            .filter(|grant| sharing_state(grant, now_ms) == PeerGrantSharingState::Active)
            .collect();
        active.sort_by(compare_grants);
        Ok(active
            .iter()
            .map(|grant| summarize_grant(grant, now_ms))
            .collect())
    }

    /// Replace the relationship's sharing with `selection`.
    ///
    /// `&mut self` is the write lock; see the module documentation.
    pub async fn replace_grant(
        &mut self,
        selector: &PeerRelationshipSelector,
        selection: &PeerGrantSelection,
        now_ms: i64,
    ) -> GrantManagementResult<PeerGrantSummary> {
        let parsed = validate_selector(selector)?;
        let now_ms = validate_now(now_ms)?;
        let normalized = normalize_selection(selection, now_ms, self.max_future_expiry_ms)?;

        // TypeScript draws the identifier before it reads, so a missing secure
        // random source fails before anything is revoked. Preserved here.
        let default_grant_id = match &self.grant_id_source {
            None => None,
            Some(source) => Some(validate_grant_id(&source.next_grant_id().ok_or_else(
                || {
                    PeerGrantManagementError::new(
                        PeerGrantManagementErrorCode::SecureRandomUnavailable,
                        "Sharing cannot start without secure random IDs",
                    )
                },
            )?)?),
        };

        let existing = self
            .repository
            .list_recipient_grants(&parsed, now_ms)
            .await
            .map_err(|_| PeerGrantManagementError::repository_unavailable())?;

        let mut active_existing: Vec<LocalPeerGrantV1> = existing
            .iter()
            .filter(|grant| sharing_state(grant, now_ms) == PeerGrantSharingState::Active)
            .cloned()
            .collect();
        active_existing.sort_by(compare_grants);

        let mut revoked: Vec<LocalPeerGrantV1> = Vec::new();
        if !active_existing.is_empty() {
            revoked = self
                .repository
                .revoke_grants(&parsed, now_ms)
                .await
                .map_err(|_| PeerGrantManagementError::repository_unavailable())?;
        }

        let next_revision = existing
            .iter()
            .chain(revoked.iter())
            .fold(0_i64, |revision, grant| revision.max(grant.grant_revision))
            + 1;

        let grant_id = match active_existing.first() {
            Some(grant) => grant.grant_id.clone(),
            None => default_grant_id.ok_or_else(|| {
                PeerGrantManagementError::new(
                    PeerGrantManagementErrorCode::SecureRandomUnavailable,
                    "Sharing cannot start without secure random IDs",
                )
            })?,
        };

        let grant = LocalPeerGrantV1 {
            version: 1,
            grant_id,
            token_id: parsed.token_id.clone(),
            claimant_peer_id: parsed.claimant_peer_id.clone(),
            verifier_peer_id: parsed.verifier_peer_id.clone(),
            room_name: parsed.room_name.clone(),
            allowed_method_ids: normalized.allowed_method_ids,
            allowed_tool_contract_ids: normalized.allowed_tool_contract_ids,
            capability_pack_ids: normalized.capability_pack_ids,
            resource_scopes: normalized.resource_scopes,
            created_at_ms: now_ms,
            expires_at_ms: normalized.expires_at_ms,
            revoked_at_ms: None,
            grant_revision: next_revision,
        };
        if self.repository.upsert_grant(grant.clone()).await.is_err() {
            // Revocation and replacement are separate repository operations.
            // If the replacement write fails, re-issue every previously live
            // grant at a newer revision so repositories with monotonic-write
            // guards cannot leave the relationship accidentally unshared.
            let restore_revision = next_revision.saturating_add(1);
            for (offset, mut previous) in active_existing.into_iter().enumerate() {
                previous.revoked_at_ms = None;
                previous.grant_revision = restore_revision.saturating_add(offset as i64);
                let _ = self.repository.upsert_grant(previous).await;
            }
            return Err(PeerGrantManagementError::repository_unavailable());
        }
        Ok(summarize_grant(&grant, now_ms))
    }

    /// Withdraw every grant for the relationship.
    pub async fn revoke_sharing(
        &mut self,
        selector: &PeerRelationshipSelector,
        now_ms: i64,
    ) -> GrantManagementResult<Vec<PeerGrantSummary>> {
        let parsed = validate_selector(selector)?;
        let now_ms = validate_now(now_ms)?;
        let active = self
            .repository
            .list_recipient_grants(&parsed, now_ms)
            .await
            .map_err(|_| PeerGrantManagementError::repository_unavailable())?;
        if active.is_empty() {
            return Ok(Vec::new());
        }
        let mut revoked = self
            .repository
            .revoke_grants(&parsed, now_ms)
            .await
            .map_err(|_| PeerGrantManagementError::repository_unavailable())?;
        revoked.sort_by(compare_grants);
        Ok(revoked
            .iter()
            .map(|grant| summarize_grant(grant, now_ms))
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Normalize and validate a selection, or say why it was refused.
pub fn normalize_selection(
    selection: &PeerGrantSelection,
    now_ms: i64,
    max_future_expiry_ms: i64,
) -> GrantManagementResult<NormalizedPeerGrantSelection> {
    let allowed_method_ids = normalize_identifiers(&selection.allowed_method_ids, "method")?;
    let allowed_tool_contract_ids =
        normalize_identifiers(&selection.allowed_tool_contract_ids, "tool")?;
    let capability_pack_ids = normalize_identifiers(&selection.capability_pack_ids, "capability")?;
    let resource_scopes = normalize_resource_scopes(&selection.resource_scopes)?;

    let selection_size = allowed_method_ids.len()
        + allowed_tool_contract_ids.len()
        + capability_pack_ids.len()
        + resource_scopes.len();
    if selection_size == 0 {
        return Err(PeerGrantManagementError::new(
            PeerGrantManagementErrorCode::InvalidSelection,
            "Choose at least one item to share",
        ));
    }

    let expires_at_ms = match selection.expires_at_ms {
        None => None,
        Some(expires_at_ms) => {
            let beyond_window = max_future_expiry_ms
                .checked_add(now_ms)
                .is_none_or(|limit| expires_at_ms > limit);
            if expires_at_ms <= now_ms || beyond_window {
                return Err(PeerGrantManagementError::new(
                    PeerGrantManagementErrorCode::InvalidExpiry,
                    "Sharing expiry is invalid",
                ));
            }
            Some(expires_at_ms)
        }
    };

    Ok(NormalizedPeerGrantSelection {
        allowed_method_ids,
        allowed_tool_contract_ids,
        capability_pack_ids,
        resource_scopes,
        expires_at_ms,
    })
}

fn normalize_identifiers(values: &[String], field: &str) -> GrantManagementResult<Vec<String>> {
    if values.len() > MAX_SELECTION_ITEMS {
        return Err(PeerGrantManagementError::new(
            PeerGrantManagementErrorCode::InvalidSelection,
            format!("Too many {field} selections"),
        ));
    }
    let mut normalized: Vec<String> = values
        .iter()
        .map(|value| normalize_identifier(value, field, MAX_IDENTIFIER_LENGTH))
        .collect::<GrantManagementResult<Vec<String>>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn normalize_resource_scopes(values: &[String]) -> GrantManagementResult<Vec<String>> {
    if values.len() > MAX_SELECTION_ITEMS {
        return Err(PeerGrantManagementError::new(
            PeerGrantManagementErrorCode::InvalidSelection,
            "Too many resource selections",
        ));
    }
    let mut normalized: Vec<String> = values
        .iter()
        .map(|value| normalize_resource_scope(value))
        .collect::<GrantManagementResult<Vec<String>>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

/// Trim, bound, and refuse an identifier that could escape its own meaning.
pub fn normalize_identifier(
    value: &str,
    field: &str,
    max_length: usize,
) -> GrantManagementResult<String> {
    // `String.prototype.trim` strips Unicode whitespace, which is wider than
    // Rust's `char::is_whitespace` by exactly U+FEFF.
    let normalized =
        value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    let length = normalized.chars().map(char::len_utf16).sum::<usize>();
    if length == 0 || length > max_length {
        return Err(PeerGrantManagementError::invalid_selection(field));
    }
    if normalized == "*"
        || normalized.contains("..")
        || normalized.starts_with('/')
        || normalized.starts_with('~')
        || normalized.contains('\\')
    {
        return Err(PeerGrantManagementError::invalid_selection(field));
    }
    if !is_safe_identifier(normalized) {
        return Err(PeerGrantManagementError::invalid_selection(field));
    }
    if contains_forbidden_secret(normalized) || contains_forbidden_execution_word(normalized) {
        return Err(PeerGrantManagementError::invalid_selection(field));
    }
    Ok(normalized.to_owned())
}

fn normalize_resource_scope(value: &str) -> GrantManagementResult<String> {
    let normalized = normalize_identifier(value, "resource", MAX_RESOURCE_SCOPE_LENGTH)?;
    if is_forbidden_resource_scope(&normalized) {
        return Err(PeerGrantManagementError::new(
            PeerGrantManagementErrorCode::InvalidSelection,
            "Invalid resource selection",
        ));
    }
    Ok(normalized)
}

/// Transliterates `SAFE_ID_RE = /^[A-Za-z0-9_.:@/-]+$/u`.
#[must_use]
pub fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '.' | ':' | '@' | '/' | '-')
        })
}

/// Transliterates `FORBIDDEN_SECRET_RE`.
#[must_use]
pub fn contains_forbidden_secret(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    FORBIDDEN_SECRET_SUBSTRINGS
        .iter()
        .any(|needle| lowered.contains(needle))
}

/// Transliterates `FORBIDDEN_EXECUTION_IDENTIFIER_RE`.
///
/// A word matches only when it occupies a whole separator-delimited component,
/// which is exactly what the pattern's `(?:^|[.:@/-])` … `(?:$|[.:@/-])`
/// anchors express.
#[must_use]
pub fn contains_forbidden_execution_word(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered
        .split(IDENTIFIER_SEPARATORS)
        .any(|component| FORBIDDEN_EXECUTION_WORDS.contains(&component))
}

/// Transliterates `FORBIDDEN_RESOURCE_SCOPE_RE`.
#[must_use]
pub fn is_forbidden_resource_scope(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    for scheme in FORBIDDEN_RESOURCE_SCHEMES {
        if lowered == scheme || lowered.starts_with(&format!("{scheme}:")) {
            return true;
        }
    }
    FORBIDDEN_RESOURCE_WORDS
        .iter()
        .any(|word| contains_on_word_boundary(&lowered, word))
}

/// `\b<word>\b` with JavaScript's ASCII `\w` class.
fn contains_on_word_boundary(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0_usize;
    while let Some(offset) = haystack[from..].find(word) {
        let start = from + offset;
        let end = start + word.len();
        let before_is_word = start > 0 && is_word_byte(bytes[start - 1]);
        let after_is_word = end < bytes.len() && is_word_byte(bytes[end]);
        if !before_is_word && !after_is_word {
            return true;
        }
        from = start + 1;
        if from >= haystack.len() {
            break;
        }
    }
    false
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Bound the four selector parts, or say the selector was refused.
pub fn validate_selector(
    selector: &PeerRelationshipSelector,
) -> GrantManagementResult<PeerRelationshipSelector> {
    Ok(PeerRelationshipSelector {
        token_id: validate_selector_part(&selector.token_id, MAX_IDENTIFIER_LENGTH)?,
        claimant_peer_id: validate_selector_part(
            &selector.claimant_peer_id,
            MAX_IDENTIFIER_LENGTH,
        )?,
        verifier_peer_id: validate_selector_part(
            &selector.verifier_peer_id,
            MAX_IDENTIFIER_LENGTH,
        )?,
        room_name: validate_selector_part(&selector.room_name, MAX_RESOURCE_SCOPE_LENGTH)?,
    })
}

fn validate_selector_part(value: &str, max_length: usize) -> GrantManagementResult<String> {
    let length = value.chars().map(char::len_utf16).sum::<usize>();
    if length == 0 || length > max_length {
        return Err(PeerGrantManagementError::new(
            PeerGrantManagementErrorCode::InvalidSelector,
            "Invalid selector",
        ));
    }
    Ok(value.to_owned())
}

fn validate_grant_id(value: &str) -> GrantManagementResult<String> {
    normalize_identifier(value, "grant", MAX_IDENTIFIER_LENGTH)
}

fn validate_now(now_ms: i64) -> GrantManagementResult<i64> {
    if now_ms < 0 {
        return Err(PeerGrantManagementError::new(
            PeerGrantManagementErrorCode::InvalidExpiry,
            "Sharing time is invalid",
        ));
    }
    Ok(now_ms)
}

/// The redacted view of one grant.
#[must_use]
pub fn summarize_grant(grant: &LocalPeerGrantV1, now_ms: i64) -> PeerGrantSummary {
    let sorted = |values: &[String]| {
        let mut out = values.to_vec();
        out.sort();
        out
    };
    PeerGrantSummary {
        grant_id: grant.grant_id.clone(),
        claimant_peer_id: grant.claimant_peer_id.clone(),
        verifier_peer_id: grant.verifier_peer_id.clone(),
        room_name: grant.room_name.clone(),
        allowed_method_ids: sorted(&grant.allowed_method_ids),
        allowed_tool_contract_ids: sorted(&grant.allowed_tool_contract_ids),
        capability_pack_ids: sorted(&grant.capability_pack_ids),
        resource_scopes: sorted(&grant.resource_scopes),
        created_at_ms: grant.created_at_ms,
        expires_at_ms: grant.expires_at_ms,
        revoked_at_ms: grant.revoked_at_ms,
        grant_revision: grant.grant_revision,
        sharing_state: sharing_state(grant, now_ms),
        secret_fields_redacted: true,
        redacted_fields: vec!["sensitivePeerAuthorityMaterial".to_owned()],
    }
}

/// How a grant reads at `now_ms`. Revocation outranks expiry.
#[must_use]
pub fn sharing_state(grant: &LocalPeerGrantV1, now_ms: i64) -> PeerGrantSharingState {
    if grant.revoked_at_ms.is_some_and(|at| at <= now_ms) {
        return PeerGrantSharingState::Revoked;
    }
    if grant.expires_at_ms.is_some_and(|at| at <= now_ms) {
        return PeerGrantSharingState::Expired;
    }
    PeerGrantSharingState::Active
}
