//! Bounded, process-local handles for native node-policy read contexts.
//!
//! The registry never selects a profile or performs persistence. A trusted
//! native lifecycle adapter supplies the caller nonce; a successful read
//! receipt supplies the context and revision. This portable module does not
//! prove WebView origin, platform randomness, storage durability, or runtime
//! application. Its module export and Tauri wiring remain integration work.

use crate::node_config::{NodeConfigReadReceipt, NodeConfigSelectionContext};
use aurora_voice_core::node_policy::NodeConfigDocumentV2;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

const HANDLE_DOMAIN: &[u8] = b"aurora.node-config.draft-handle.v1\0";
const BOOT_NONCE_BYTES: usize = 32;
const FRESH_NONCE_BYTES: usize = 32;
const CALLER_NONCE_BYTES: usize = 16;
const HANDLE_BYTES: usize = 32;
const HANDLE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_LIVE_HANDLES: usize = 128;
const MAX_HANDLES_PER_CALLER: usize = 8;

/// Fixed, content-free error returned by the native nonce provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("native draft nonce is unavailable")]
pub struct NodeConfigDraftNonceError;

/// Synchronous bounded entropy source supplied by trusted native integration.
///
/// Implementations must return cryptographically random bytes promptly and
/// must not call back into this registry. The portable registry does not prove
/// the quality or platform provenance of the supplied entropy.
pub trait NodeConfigDraftNonceIssuer: Send + Sync + 'static {
    /// Return one fresh 32-byte nonce or a fixed, content-free failure.
    fn issue_nonce(&self) -> Result<[u8; FRESH_NONCE_BYTES], NodeConfigDraftNonceError>;
}

/// Opaque in-process caller scope supplied by native lifecycle management.
///
/// The 16-byte value is intentionally neither serializable nor exposed by
/// `Debug`. This value is not itself proof of caller origin or authority.
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub struct NativeNodeConfigCaller([u8; CALLER_NONCE_BYTES]);

impl NativeNodeConfigCaller {
    /// Construct a caller scope from a trusted native lifecycle nonce.
    ///
    /// Native bootstrap may construct this value only from trusted framework
    /// lifecycle provenance. Renderer-provided identifiers must never be
    /// passed here. Public visibility permits the separate Tauri crate to
    /// construct a caller; it does not make renderer input trustworthy.
    pub fn from_native_lifecycle_nonce(nonce: [u8; CALLER_NONCE_BYTES]) -> Self {
        Self(nonce)
    }
}

impl fmt::Debug for NativeNodeConfigCaller {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeNodeConfigCaller(<opaque>)")
    }
}

/// Fixed, content-free draft-registry failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum NodeConfigDraftRegistryError {
    /// Token lookup, ownership, expiry, replay, revision, or closed-registry failure.
    #[error("node configuration draft handle is unavailable")]
    Unavailable,
    /// The bounded live-handle capacity has been reached.
    #[error("node configuration draft handle capacity is full")]
    CapacityExceeded,
    /// The trusted native entropy source failed.
    #[error("native draft nonce is unavailable")]
    NonceUnavailable,
    /// The monotonic handle sequence cannot advance safely.
    #[error("node configuration draft handle sequence is exhausted")]
    SequenceExhausted,
}

/// A successful read document paired with its opaque, single-use handle.
///
/// This type intentionally has no `Debug` implementation because the document
/// may contain user policy data and the handle is a bearer token within its
/// caller scope.
pub struct IssuedNodeConfigDraft {
    /// The validated document returned by the operation owner.
    pub document: NodeConfigDocumentV2,
    /// A 64-character lowercase hexadecimal token; never log or persist it.
    pub handle: String,
}

struct DraftRecord {
    caller: NativeNodeConfigCaller,
    revision: u64,
    expires_at: Instant,
    context: NodeConfigSelectionContext,
}

struct RegistryState {
    records: BTreeMap<String, DraftRecord>,
    next_sequence: Option<u64>,
    shutdown: bool,
}

/// Bounded, in-process registry for owner-issued read contexts.
///
/// All methods hold the mutex only for bounded registry state and a synchronous
/// nonce issuance call. They never call persistence or the operation owner.
pub struct NodeConfigDraftRegistry<I> {
    boot_nonce: [u8; BOOT_NONCE_BYTES],
    issuer: I,
    state: Mutex<RegistryState>,
}

impl<I: NodeConfigDraftNonceIssuer> NodeConfigDraftRegistry<I> {
    /// Create an empty registry using fresh process boot entropy.
    pub fn new(issuer: I) -> Result<Self, NodeConfigDraftRegistryError> {
        let boot_nonce = issuer
            .issue_nonce()
            .map_err(|_| NodeConfigDraftRegistryError::NonceUnavailable)?;
        Ok(Self::with_boot_nonce_and_sequence(issuer, boot_nonce, 0))
    }

    fn with_boot_nonce_and_sequence(
        issuer: I,
        boot_nonce: [u8; BOOT_NONCE_BYTES],
        next_sequence: u64,
    ) -> Self {
        Self {
            boot_nonce,
            issuer,
            state: Mutex::new(RegistryState {
                records: BTreeMap::new(),
                next_sequence: Some(next_sequence),
                shutdown: false,
            }),
        }
    }

    /// Retain the exact context and revision from a successful owner read.
    /// The returned document is kept separate from registry state.
    pub fn issue_read(
        &self,
        caller: NativeNodeConfigCaller,
        receipt: NodeConfigReadReceipt,
    ) -> Result<IssuedNodeConfigDraft, NodeConfigDraftRegistryError> {
        self.issue_read_with_hooks(caller, receipt, || {}, Instant::now)
    }

    #[cfg(test)]
    fn issue_read_at(
        &self,
        caller: NativeNodeConfigCaller,
        receipt: NodeConfigReadReceipt,
        now: Instant,
    ) -> Result<IssuedNodeConfigDraft, NodeConfigDraftRegistryError> {
        self.issue_read_with_hooks(caller, receipt, || {}, || now)
    }

    fn issue_read_with_hooks<BeforeLock, Clock>(
        &self,
        caller: NativeNodeConfigCaller,
        receipt: NodeConfigReadReceipt,
        before_lock: BeforeLock,
        mut clock: Clock,
    ) -> Result<IssuedNodeConfigDraft, NodeConfigDraftRegistryError>
    where
        BeforeLock: FnOnce(),
        Clock: FnMut() -> Instant,
    {
        let NodeConfigReadReceipt { document, context } = receipt;
        let revision = document.revision;
        before_lock();
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigDraftRegistryError::Unavailable)?;
        if state.shutdown {
            return Err(NodeConfigDraftRegistryError::Unavailable);
        }
        prune_expired(&mut state, clock());
        if state.records.len() >= MAX_LIVE_HANDLES
            || state
                .records
                .values()
                .filter(|record| record.caller == caller)
                .count()
                >= MAX_HANDLES_PER_CALLER
        {
            return Err(NodeConfigDraftRegistryError::CapacityExceeded);
        }

        let sequence = state
            .next_sequence
            .ok_or(NodeConfigDraftRegistryError::SequenceExhausted)?;
        state.next_sequence = sequence.checked_add(1);
        let fresh_nonce = self
            .issuer
            .issue_nonce()
            .map_err(|_| NodeConfigDraftRegistryError::NonceUnavailable)?;
        let handle = handle_token(&self.boot_nonce, sequence, &fresh_nonce);
        if state.records.contains_key(&handle) {
            return Err(NodeConfigDraftRegistryError::NonceUnavailable);
        }
        let expires_at = clock()
            .checked_add(HANDLE_TTL)
            .ok_or(NodeConfigDraftRegistryError::Unavailable)?;
        state.records.insert(
            handle.clone(),
            DraftRecord {
                caller,
                revision,
                expires_at,
                context,
            },
        );
        Ok(IssuedNodeConfigDraft { document, handle })
    }

    /// Consume a draft handle and return its original owner-issued context.
    ///
    /// Unknown, malformed, foreign, expired, replayed, closed, and
    /// revision-mismatched handles have one identical unavailable result. A
    /// foreign attempt never consumes the rightful caller's live token.
    pub fn take_context(
        &self,
        caller: NativeNodeConfigCaller,
        handle: &str,
        expected_revision: u64,
    ) -> Result<NodeConfigSelectionContext, NodeConfigDraftRegistryError> {
        self.take_context_with_hooks(caller, handle, expected_revision, || {}, Instant::now)
    }

    #[cfg(test)]
    fn take_context_at(
        &self,
        caller: NativeNodeConfigCaller,
        handle: &str,
        expected_revision: u64,
        now: Instant,
    ) -> Result<NodeConfigSelectionContext, NodeConfigDraftRegistryError> {
        self.take_context_with_hooks(caller, handle, expected_revision, || {}, || now)
    }

    fn take_context_with_hooks<BeforeLock, Clock>(
        &self,
        caller: NativeNodeConfigCaller,
        handle: &str,
        expected_revision: u64,
        before_lock: BeforeLock,
        clock: Clock,
    ) -> Result<NodeConfigSelectionContext, NodeConfigDraftRegistryError>
    where
        BeforeLock: FnOnce(),
        Clock: FnOnce() -> Instant,
    {
        if !is_canonical_handle(handle) {
            return Err(NodeConfigDraftRegistryError::Unavailable);
        }
        before_lock();
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigDraftRegistryError::Unavailable)?;
        if state.shutdown {
            return Err(NodeConfigDraftRegistryError::Unavailable);
        }
        let now = clock();
        prune_expired(&mut state, now);
        let Some(record) = state.records.get(handle) else {
            return Err(NodeConfigDraftRegistryError::Unavailable);
        };
        if record.caller != caller {
            return Err(NodeConfigDraftRegistryError::Unavailable);
        }
        let record = state
            .records
            .remove(handle)
            .ok_or(NodeConfigDraftRegistryError::Unavailable)?;
        if record.expires_at <= now || record.revision != expected_revision {
            return Err(NodeConfigDraftRegistryError::Unavailable);
        }
        Ok(record.context)
    }

    /// Invalidate every outstanding handle owned by one lifecycle caller.
    pub fn invalidate_caller(
        &self,
        caller: NativeNodeConfigCaller,
    ) -> Result<(), NodeConfigDraftRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigDraftRegistryError::Unavailable)?;
        state.records.retain(|_, record| record.caller != caller);
        Ok(())
    }

    /// Invalidate every outstanding handle without resetting the sequence.
    pub fn invalidate_all(&self) -> Result<(), NodeConfigDraftRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigDraftRegistryError::Unavailable)?;
        state.records.clear();
        Ok(())
    }

    /// Permanently close issuance and invalidate all outstanding handles.
    pub fn shutdown(&self) -> Result<(), NodeConfigDraftRegistryError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigDraftRegistryError::Unavailable)?;
        state.records.clear();
        state.shutdown = true;
        Ok(())
    }
}

fn prune_expired(state: &mut RegistryState, now: Instant) {
    state.records.retain(|_, record| record.expires_at > now);
}

fn is_canonical_handle(handle: &str) -> bool {
    handle.len() == HANDLE_BYTES * 2
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn handle_token(
    boot_nonce: &[u8; BOOT_NONCE_BYTES],
    sequence: u64,
    fresh_nonce: &[u8; FRESH_NONCE_BYTES],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(HANDLE_DOMAIN);
    hasher.update(boot_nonce);
    hasher.update(sequence.to_be_bytes());
    hasher.update(fresh_nonce);
    encode_lower_hex(&hasher.finalize())
}

fn encode_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{
        is_canonical_handle, IssuedNodeConfigDraft, NativeNodeConfigCaller,
        NodeConfigDraftNonceError, NodeConfigDraftNonceIssuer, NodeConfigDraftRegistry,
        NodeConfigDraftRegistryError, BOOT_NONCE_BYTES, HANDLE_TTL, MAX_HANDLES_PER_CALLER,
        MAX_LIVE_HANDLES,
    };
    use crate::node_config::{
        CreateIfAbsentResult, NodeConfigOperationError, NodeConfigOperationOwner,
        NodeConfigPersistence, NodeConfigPersistenceError, NodeConfigProfileNamespace,
        NodeConfigPublishFailure,
    };
    use aurora_voice_core::node_policy::NodeConfigDocumentV2;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::fmt::Write as _;
    use std::sync::mpsc;
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct IssuerState {
        next: u8,
        fail_next: bool,
        calls: usize,
    }

    #[derive(Clone, Default)]
    struct DeterministicIssuer {
        state: Arc<Mutex<IssuerState>>,
    }

    impl DeterministicIssuer {
        fn starting_at(next: u8) -> Self {
            Self {
                state: Arc::new(Mutex::new(IssuerState {
                    next,
                    fail_next: false,
                    calls: 0,
                })),
            }
        }

        fn fail_next(&self) {
            self.state.lock().expect("issuer state").fail_next = true;
        }

        fn call_count(&self) -> usize {
            self.state.lock().expect("issuer state").calls
        }
    }

    impl NodeConfigDraftNonceIssuer for DeterministicIssuer {
        fn issue_nonce(&self) -> Result<[u8; 32], NodeConfigDraftNonceError> {
            let mut state = self.state.lock().expect("issuer state");
            if std::mem::take(&mut state.fail_next) {
                return Err(NodeConfigDraftNonceError);
            }
            state.calls += 1;
            let value = state.next;
            state.next = state.next.checked_add(1).unwrap_or(0);
            Ok([value; 32])
        }
    }

    #[derive(Default)]
    struct BackendState {
        records: BTreeMap<NodeConfigProfileNamespace, Vec<u8>>,
        calls: usize,
        writes: usize,
    }

    #[derive(Clone, Default)]
    struct MemoryPersistence {
        state: Arc<Mutex<BackendState>>,
    }

    impl MemoryPersistence {
        fn call_count(&self) -> usize {
            self.state.lock().expect("backend state").calls
        }

        fn write_count(&self) -> usize {
            self.state.lock().expect("backend state").writes
        }

        fn only_record(&self) -> Vec<u8> {
            self.state
                .lock()
                .expect("backend state")
                .records
                .values()
                .next()
                .expect("one selected policy record")
                .clone()
        }
    }

    impl NodeConfigPersistence for MemoryPersistence {
        fn read(
            &self,
            profile: NodeConfigProfileNamespace,
        ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
            let mut state = self.state.lock().expect("backend state");
            state.calls += 1;
            Ok(state.records.get(&profile).cloned())
        }

        fn create_if_absent(
            &self,
            profile: NodeConfigProfileNamespace,
            candidate: &[u8],
        ) -> Result<CreateIfAbsentResult, NodeConfigPublishFailure> {
            let mut state = self.state.lock().expect("backend state");
            state.calls += 1;
            if let Some(bytes) = state.records.get(&profile) {
                return Ok(CreateIfAbsentResult::AlreadyExists(bytes.clone()));
            }
            state.records.insert(profile, candidate.to_vec());
            state.writes += 1;
            Ok(CreateIfAbsentResult::Created)
        }

        fn replace_atomically(
            &self,
            profile: NodeConfigProfileNamespace,
            candidate: &[u8],
        ) -> Result<(), NodeConfigPublishFailure> {
            let mut state = self.state.lock().expect("backend state");
            state.calls += 1;
            state.records.insert(profile, candidate.to_vec());
            state.writes += 1;
            Ok(())
        }

        fn confirm_durable_snapshot(
            &self,
            profile: NodeConfigProfileNamespace,
        ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
            let mut state = self.state.lock().expect("backend state");
            state.calls += 1;
            Ok(state.records.get(&profile).cloned())
        }
    }

    fn caller(value: u8) -> NativeNodeConfigCaller {
        NativeNodeConfigCaller::from_native_lifecycle_nonce([value; 16])
    }

    fn owner() -> (
        Arc<NodeConfigOperationOwner<MemoryPersistence>>,
        MemoryPersistence,
    ) {
        let persistence = MemoryPersistence::default();
        let owner = Arc::new(NodeConfigOperationOwner::new(persistence.clone()));
        let profile = NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
            "profile-a",
            "stable-a",
        )
        .expect("validated profile identity");
        owner
            .select_profile(Some(profile))
            .expect("selected profile");
        (owner, persistence)
    }

    fn next_draft(document: &NodeConfigDocumentV2) -> String {
        let mut value = serde_json::to_value(document).expect("serialize document");
        value["revision"] = json!(document.revision + 1);
        value.to_string()
    }

    fn issue(
        registry: &NodeConfigDraftRegistry<DeterministicIssuer>,
        owner: &NodeConfigOperationOwner<MemoryPersistence>,
        caller: NativeNodeConfigCaller,
    ) -> IssuedNodeConfigDraft {
        registry
            .issue_read(
                caller,
                owner.load_or_initialize().expect("owner read receipt"),
            )
            .expect("draft handle issued")
    }

    fn canonical_test_handle(value: u8) -> String {
        let mut result = String::with_capacity(64);
        for _ in 0..64 {
            write!(&mut result, "{value:x}").expect("write token digit");
        }
        result
    }

    #[test]
    fn issue_returns_original_document_and_single_use_domain_separated_handle() {
        let (owner, _) = owner();
        let issuer = DeterministicIssuer::starting_at(1);
        let registry = NodeConfigDraftRegistry::new(issuer).expect("boot nonce");
        let recipient = caller(7);
        let receipt = owner.load_or_initialize().expect("read receipt");
        let expected_document = receipt.document.revision;
        let issued = registry
            .issue_read(recipient, receipt)
            .expect("issue draft handle");

        assert_eq!(issued.document.revision, expected_document);
        assert_eq!(issued.handle.len(), 64);
        assert!(is_canonical_handle(&issued.handle));

        assert_eq!(
            issued.handle,
            "3c8cafe15190dbc38e8e16151b6ea0751189e481846c1bdfb505c9f7f284c7bd"
        );

        let context = registry
            .take_context(recipient, &issued.handle, expected_document)
            .expect("rightful one-use take");
        assert_eq!(
            registry.take_context(recipient, &issued.handle, expected_document),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(format!("{recipient:?}"), "NativeNodeConfigCaller(<opaque>)");
        assert_eq!(
            format!("{context:?}"),
            "NodeConfigSelectionContext(<opaque>)"
        );
    }

    #[test]
    fn boot_entropy_separates_registries_and_nonce_failure_is_content_free() {
        let (owner, _) = owner();
        let first_registry = NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1))
            .expect("first boot entropy");
        let second_registry = NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(10))
            .expect("second boot entropy");
        let first = issue(&first_registry, &owner, caller(1));
        let second = issue(&second_registry, &owner, caller(1));
        assert_ne!(first.handle, second.handle);

        let failed_boot = DeterministicIssuer::default();
        failed_boot.fail_next();
        assert_eq!(
            NodeConfigDraftRegistry::new(failed_boot).err(),
            Some(NodeConfigDraftRegistryError::NonceUnavailable)
        );
        let issuer = DeterministicIssuer::starting_at(20);
        let registry = NodeConfigDraftRegistry::new(issuer.clone()).expect("boot nonce");
        issuer.fail_next();
        assert!(matches!(
            registry.issue_read(caller(9), owner.load_or_initialize().expect("read receipt")),
            Err(NodeConfigDraftRegistryError::NonceUnavailable)
        ));
    }

    #[test]
    fn malformed_foreign_expired_and_revision_mismatch_handles_are_unavailable() {
        let (owner, persistence) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let rightful = caller(3);
        let other = caller(4);
        let issued = issue(&registry, &owner, rightful);
        let calls_before = persistence.call_count();
        assert_eq!(
            registry.take_context(other, &issued.handle, 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(persistence.call_count(), calls_before);
        assert_eq!(
            registry.take_context(rightful, &format!("{}A", &issued.handle[..63]), 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(
            registry.take_context(rightful, &issued.handle.to_uppercase(), 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(
            registry.take_context(rightful, &issued.handle, 2),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(
            registry.take_context(rightful, &issued.handle, 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
    }

    #[test]
    fn foreign_attempt_does_not_consume_rightful_handle_or_access_backend() {
        let (owner, persistence) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let rightful = caller(31);
        let foreign = caller(32);
        let issued = issue(&registry, &owner, rightful);
        let calls_before = persistence.call_count();

        assert_eq!(
            registry.take_context(foreign, &issued.handle, issued.document.revision),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(persistence.call_count(), calls_before);
        assert!(registry
            .take_context(rightful, &issued.handle, issued.document.revision)
            .is_ok());
        assert_eq!(persistence.call_count(), calls_before);
    }

    #[test]
    fn expired_entries_are_pruned_and_caller_quota_is_reclaimed() {
        let (owner, _) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let recipient = caller(5);
        let now = Instant::now();
        let first = registry
            .issue_read_at(
                recipient,
                owner.load_or_initialize().expect("read receipt"),
                now,
            )
            .expect("issue at deterministic time");
        assert_eq!(
            registry.take_context_at(recipient, &first.handle, 1, now + HANDLE_TTL),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        let next = registry
            .issue_read_at(
                recipient,
                owner.load_or_initialize().expect("read after expiry"),
                now + HANDLE_TTL,
            )
            .expect("expired slot reclaimed");
        assert_ne!(first.handle, next.handle);
    }

    #[test]
    fn issued_handle_ttl_starts_after_nonce_issuance_while_lock_is_held() {
        let (owner, _) = owner();
        let issuer = DeterministicIssuer::starting_at(1);
        let registry = NodeConfigDraftRegistry::new(issuer.clone()).expect("boot nonce");
        let caller = caller(6);
        let receipt = owner.load_or_initialize().expect("read receipt");
        let first_clock_sample = Instant::now();
        let insertion_time = first_clock_sample + Duration::from_secs(10);
        let mut clock_samples = [first_clock_sample, insertion_time].into_iter();

        let issued = registry
            .issue_read_with_hooks(
                caller,
                receipt,
                || {},
                || {
                    assert!(registry.state.try_lock().is_err());
                    let sample = clock_samples.next().expect("clock sample");
                    assert_eq!(
                        issuer.call_count(),
                        if sample == insertion_time { 2 } else { 1 }
                    );
                    sample
                },
            )
            .expect("issue with deterministic clock");

        let state = registry.state.lock().expect("registry state");
        let record = state
            .records
            .get(&issued.handle)
            .expect("inserted handle record");
        assert_eq!(record.expires_at, insertion_time + HANDLE_TTL);
        assert_eq!(clock_samples.next(), None);
    }

    #[test]
    fn consumption_clock_is_sampled_after_waiting_for_registry_lock() {
        let (owner, _) = owner();
        let registry = Arc::new(
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce"),
        );
        let caller = caller(16);
        let issued = issue(&registry, &owner, caller);
        let expected_revision = issued.document.revision;
        let handle = issued.handle.clone();
        let expires_at = registry
            .state
            .lock()
            .expect("registry state")
            .records
            .get(&handle)
            .expect("issued handle record")
            .expires_at;
        let guarded_state = registry.state.lock().expect("hold registry lock");
        let current_time = Arc::new(Mutex::new(Instant::now()));
        let clock_samples = Arc::new(Mutex::new(0_usize));
        let registry_for_thread = Arc::clone(&registry);
        let time_for_thread = Arc::clone(&current_time);
        let samples_for_thread = Arc::clone(&clock_samples);
        let (before_lock_tx, before_lock_rx) = mpsc::channel();

        let take_task = thread::spawn(move || {
            registry_for_thread.take_context_with_hooks(
                caller,
                &handle,
                expected_revision,
                || {
                    assert!(registry_for_thread.state.try_lock().is_err());
                    before_lock_tx.send(()).expect("report pre-lock observer");
                },
                || {
                    *samples_for_thread.lock().expect("clock sample count") += 1;
                    *time_for_thread.lock().expect("consumption time")
                },
            )
        });

        before_lock_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker reached the locked registry");
        assert_eq!(*clock_samples.lock().expect("clock sample count"), 0);
        *current_time.lock().expect("set consumption time") = expires_at;
        drop(guarded_state);

        assert_eq!(
            take_task.join().expect("take worker"),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert_eq!(*clock_samples.lock().expect("clock sample count"), 1);
    }

    #[test]
    fn capacity_is_bounded_per_caller_and_globally() {
        let (owner, _) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let one_caller = caller(1);
        for _ in 0..MAX_HANDLES_PER_CALLER {
            let _ = issue(&registry, &owner, one_caller);
        }
        assert!(matches!(
            registry.issue_read(
                one_caller,
                owner
                    .load_or_initialize()
                    .expect("per-caller overflow receipt")
            ),
            Err(NodeConfigDraftRegistryError::CapacityExceeded)
        ));

        let registry = NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(50))
            .expect("separate boot nonce");
        for index in 0..MAX_LIVE_HANDLES {
            let distinct_caller = caller((index % 256) as u8);
            let _ = issue(&registry, &owner, distinct_caller);
        }
        assert!(matches!(
            registry.issue_read(
                caller(200),
                owner.load_or_initialize().expect("global overflow receipt")
            ),
            Err(NodeConfigDraftRegistryError::CapacityExceeded)
        ));
    }

    #[test]
    fn invalidation_and_shutdown_clear_records_without_resetting_issuance() {
        let (owner, _) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let first_caller = caller(1);
        let second_caller = caller(2);
        let first = issue(&registry, &owner, first_caller);
        let second = issue(&registry, &owner, second_caller);
        registry
            .invalidate_caller(first_caller)
            .expect("invalidate first caller");
        assert_eq!(
            registry.take_context(first_caller, &first.handle, 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert!(registry
            .take_context(second_caller, &second.handle, 1)
            .is_ok());

        let third = issue(&registry, &owner, first_caller);
        registry.invalidate_all().expect("invalidate all");
        assert_eq!(
            registry.take_context(first_caller, &third.handle, 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        let fourth = issue(&registry, &owner, first_caller);
        registry.shutdown().expect("terminal shutdown");
        assert_eq!(
            registry.take_context(first_caller, &fourth.handle, 1),
            Err(NodeConfigDraftRegistryError::Unavailable)
        );
        assert!(matches!(
            registry.issue_read(
                first_caller,
                owner.load_or_initialize().expect("receipt after shutdown")
            ),
            Err(NodeConfigDraftRegistryError::Unavailable)
        ));
    }

    #[test]
    fn profile_node_and_a_b_a_changes_reject_original_context_before_io() {
        let (owner, persistence) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let recipient = caller(8);
        let issued = issue(&registry, &owner, recipient);
        let context = registry
            .take_context(recipient, &issued.handle, issued.document.revision)
            .expect("take original context");
        let selections = [
            ("profile-b", "stable-b"),
            ("profile-a", "stable-b"),
            ("profile-a", "stable-a"),
        ];
        for (profile_id, stable_node_id) in selections {
            let replacement =
                NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                    profile_id,
                    stable_node_id,
                )
                .expect("replacement profile identity");
            owner
                .select_profile(Some(replacement))
                .expect("change selection");
            let before = persistence.call_count();
            assert_eq!(
                owner.compare_and_swap(
                    &context,
                    issued.document.revision,
                    &next_draft(&issued.document)
                ),
                Err(NodeConfigOperationError::StaleSelectionContext)
            );
            assert_eq!(persistence.call_count(), before);
        }
    }

    #[test]
    fn two_same_revision_handles_have_one_owner_cas_winner() {
        let (owner, persistence) = owner();
        let registry =
            NodeConfigDraftRegistry::new(DeterministicIssuer::starting_at(1)).expect("boot nonce");
        let recipient = caller(11);
        let first_receipt = owner.load_or_initialize().expect("first read");
        let second_receipt = owner.load_or_initialize().expect("second read");
        assert_eq!(
            first_receipt.document.revision,
            second_receipt.document.revision
        );
        let revision = first_receipt.document.revision;
        let draft = next_draft(&first_receipt.document);
        let first = registry
            .issue_read(recipient, first_receipt)
            .expect("first handle");
        let second = registry
            .issue_read(recipient, second_receipt)
            .expect("second handle");
        let first_context = registry
            .take_context(recipient, &first.handle, revision)
            .expect("first context");
        let second_context = registry
            .take_context(recipient, &second.handle, revision)
            .expect("second context");

        let barrier = Arc::new(Barrier::new(3));
        let first_owner = Arc::clone(&owner);
        let first_barrier = Arc::clone(&barrier);
        let first_draft = draft.clone();
        let first_task = thread::spawn(move || {
            first_barrier.wait();
            first_owner.compare_and_swap(&first_context, revision, &first_draft)
        });
        let second_owner = Arc::clone(&owner);
        let second_barrier = Arc::clone(&barrier);
        let second_task = thread::spawn(move || {
            second_barrier.wait();
            second_owner.compare_and_swap(&second_context, revision, &draft)
        });
        barrier.wait();

        let results = [
            first_task.join().expect("first writer thread"),
            second_task.join().expect("second writer thread"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(
                    result,
                    Err(NodeConfigOperationError::RevisionConflict { .. })
                ))
                .count(),
            1
        );
        let winning_document = results
            .iter()
            .find_map(|result| result.as_ref().ok())
            .expect("one committed writer")
            .document
            .clone();
        let persisted: Value =
            serde_json::from_slice(&persistence.only_record()).expect("stored JSON document");
        assert_eq!(
            persisted,
            serde_json::to_value(winning_document).expect("serialize winning document")
        );
        assert_eq!(persistence.write_count(), 2, "initialize plus one winner");
    }

    #[test]
    fn sequence_exhaustion_never_wraps_even_after_invalidation() {
        let (owner, _) = owner();
        let registry = NodeConfigDraftRegistry::with_boot_nonce_and_sequence(
            DeterministicIssuer::starting_at(1),
            [7_u8; BOOT_NONCE_BYTES],
            u64::MAX,
        );
        let caller = caller(41);
        let last = issue(&registry, &owner, caller);
        assert!(is_canonical_handle(&last.handle));
        registry.invalidate_all().expect("invalidate last handle");
        assert!(matches!(
            registry.issue_read(
                caller,
                owner.load_or_initialize().expect("read after invalidation")
            ),
            Err(NodeConfigDraftRegistryError::SequenceExhausted)
        ));
    }

    #[test]
    fn canonical_handle_parser_accepts_only_64_lowercase_hex_characters() {
        assert!(is_canonical_handle(&canonical_test_handle(10)));
        assert!(!is_canonical_handle("a".repeat(63).as_str()));
        assert!(!is_canonical_handle("a".repeat(65).as_str()));
        assert!(!is_canonical_handle(
            &canonical_test_handle(10).to_uppercase()
        ));
        assert!(!is_canonical_handle(&"g".repeat(64)));
    }
}
