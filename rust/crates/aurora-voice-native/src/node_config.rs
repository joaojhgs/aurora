//! Serialized native owner for versioned node speech-policy documents.
//!
//! This slice owns in-process profile selection, initialization, and revision
//! decisions only. A persistence backend must provide durable publication
//! semantics. The owner is not a cross-process lock and does not acknowledge
//! runtime application. Every public operation may block on the owner mutex or
//! persistence backend and must be called from a blocking task, never an async
//! executor or UI event-loop thread.

use crate::native_publication_fence::{
    NativePublicationFence, NativePublicationFenceError, NativePublicationTicket,
};
use aurora_voice_core::node_policy::{
    empty_node_config_document_v2, update_node_config_document_v2,
    validate_node_config_document_v2_json, NodeConfigDocumentV2, NodePolicyError, MAX_SAFE_INTEGER,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const MAX_NODE_CONFIG_BYTES: usize = 65_536;
const MAX_SELECTED_PROFILE_ID_BYTES: usize = 256;
const PROFILE_NAMESPACE_DOMAIN: &[u8] = b"aurora.node-config.v2.local-profile\0";
const PROFILE_NODE_NAMESPACE_DOMAIN: &[u8] = b"aurora.node-config.v2.local-profile-node\0";
const MAX_RUNTIME_PROFILE_ID_BYTES: usize = 96;
const MAX_STABLE_NODE_ID_BYTES: usize = 160;

/// Opaque storage namespace derived from a validated, currently selected local
/// `mesh-node` profile identity. It is not a peer ID or a caller field.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NodeConfigProfileNamespace([u8; 32]);

impl NodeConfigProfileNamespace {
    /// Derive a path-safe namespace from the native profile owner’s validated
    /// selected local mesh-node profile ID.
    ///
    /// The caller must first resolve the selected profile from trusted native
    /// profile state and verify its v2 `mesh-node` role. This constructor only
    /// bounds and hashes that identity; it is not a profile or peer authority
    /// evaluator.
    pub fn from_validated_selected_local_mesh_node_profile_id(
        profile_id: &str,
    ) -> Result<Self, NodeConfigOperationError> {
        if profile_id.is_empty() || profile_id.len() > MAX_SELECTED_PROFILE_ID_BYTES {
            return Err(NodeConfigOperationError::InvalidSelectedProfile);
        }
        let mut hasher = Sha256::new();
        hasher.update(PROFILE_NAMESPACE_DOMAIN);
        hasher.update(profile_id.as_bytes());
        Ok(Self(hasher.finalize().into()))
    }

    /// Derive a separate namespace from the validated selected profile ID and
    /// its stable local node ID. Length framing keeps the two identities
    /// unambiguous, and a distinct domain prevents adoption of historical
    /// profile-only records.
    ///
    /// The caller must resolve both values from trusted native profile state.
    /// This constructor enforces the current UTF-8 byte limits and canonical
    /// trimmed form; it does not select a profile or grant authority.
    pub fn from_validated_selected_local_mesh_node_identity(
        profile_id: &str,
        stable_node_id: &str,
    ) -> Result<Self, NodeConfigOperationError> {
        if !is_canonical_bounded_identity(profile_id, MAX_RUNTIME_PROFILE_ID_BYTES)
            || !is_canonical_bounded_identity(stable_node_id, MAX_STABLE_NODE_ID_BYTES)
        {
            return Err(NodeConfigOperationError::InvalidSelectedProfile);
        }

        let mut hasher = Sha256::new();
        hasher.update(PROFILE_NODE_NAMESPACE_DOMAIN);
        hasher.update((profile_id.len() as u64).to_be_bytes());
        hasher.update(profile_id.as_bytes());
        hasher.update((stable_node_id.len() as u64).to_be_bytes());
        hasher.update(stable_node_id.as_bytes());
        Ok(Self(hasher.finalize().into()))
    }

    /// Stable hexadecimal directory component. The original profile ID is not
    /// exposed to the storage backend or included in its path.
    pub fn storage_component(&self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(self.0.len() * 2);
        for byte in self.0 {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }
}

fn is_canonical_bounded_identity(value: &str, max_bytes: usize) -> bool {
    aurora_contracts::runtime_profile_text::is_canonical_profile_text(value, max_bytes)
}

/// Result of the backend's no-clobber initialization operation.
#[derive(Debug, Eq, PartialEq)]
pub enum CreateIfAbsentResult {
    /// The default generation was durably published.
    Created,
    /// A generation already existed; its exact bytes are returned for
    /// validation instead of replacing it.
    AlreadyExists(Vec<u8>),
}

/// Outcome after the backend explicitly confirms the durable state of an
/// indeterminate publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeConfigReconciliation {
    /// The selected profile has a recognized durable document.
    Initialized(Box<NodeConfigDocumentV2>),
    /// The backend confirmed that no document was published. Initialization
    /// may be retried after the quarantine is cleared.
    Uninitialized,
}

/// Publication failure classification required by the operation owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeConfigPublishFailure {
    /// Backend guarantees the authoritative bytes were not changed.
    NotPublished,
    /// Publication may have happened, but durability was not confirmed.
    Indeterminate,
}

/// Content-free backend error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NodeConfigPersistenceError;

/// Persistence boundary for a single profile-scoped document.
///
/// Successful create/replace calls mean the exact candidate bytes are durably
/// published. A `NotPublished` error guarantees no authoritative-byte change;
/// `Indeterminate` means the caller must quarantine the namespace. This
/// interface does not itself provide cross-process serialization: production
/// must funnel every writer through one owner or add a reviewed shared lock.
pub trait NodeConfigPersistence: Send + Sync + 'static {
    /// Read the current authoritative bytes, if initialized.
    ///
    /// The backend must bound reads to `MAX_NODE_CONFIG_BYTES + 1` bytes (the
    /// extra byte is an oversize sentinel) before allocating/returning them.
    fn read(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError>;

    /// Atomically create the profile document only if no document exists.
    ///
    /// If the document already exists, return at most
    /// `MAX_NODE_CONFIG_BYTES + 1` bytes so the owner can reject oversize data
    /// without unbounded allocation.
    fn create_if_absent(
        &self,
        profile: NodeConfigProfileNamespace,
        candidate: &[u8],
    ) -> Result<CreateIfAbsentResult, NodeConfigPublishFailure>;

    /// Atomically replace the document. The operation owner serializes this
    /// call with all other operations using the same owner instance.
    fn replace_atomically(
        &self,
        profile: NodeConfigProfileNamespace,
        candidate: &[u8],
    ) -> Result<(), NodeConfigPublishFailure>;

    /// Return at most `MAX_NODE_CONFIG_BYTES + 1` authoritative bytes, or
    /// `None` for a confirmed absent record, only after the backend has
    /// explicitly confirmed durability (for example, after retrying file and
    /// parent synchronization). A reread without durability confirmation is
    /// not sufficient to clear quarantine.
    fn confirm_durable_snapshot(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError>;
}

/// A receipt for storage only. It says nothing about runtime application.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeConfigWriteReceipt {
    /// The durably stored revision and validated document.
    pub document: NodeConfigDocumentV2,
}

/// Opaque binding to one successful read under one operation owner selection.
///
/// This is an in-process selection context, not an IPC credential or grant.
/// Its fields intentionally cannot be constructed or serialized by callers.
#[derive(Clone)]
pub struct NodeConfigSelectionContext {
    owner_identity: Arc<()>,
    profile: NodeConfigProfileNamespace,
    generation: u64,
}

impl std::fmt::Debug for NodeConfigSelectionContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NodeConfigSelectionContext(<opaque>)")
    }
}

impl PartialEq for NodeConfigSelectionContext {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner_identity, &other.owner_identity)
            && self.profile == other.profile
            && self.generation == other.generation
    }
}

impl Eq for NodeConfigSelectionContext {}

/// A validated selected-profile document and its owner-issued selection context.
#[derive(Debug, PartialEq)]
pub struct NodeConfigReadReceipt {
    /// The validated document observed or initialized under the selected profile.
    pub document: NodeConfigDocumentV2,
    /// The opaque selection context required for a subsequent write.
    pub context: NodeConfigSelectionContext,
}

/// Content-free errors from the native profile-scoped operation owner.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum NodeConfigOperationError {
    #[error("a validated selected local mesh-node profile is required")]
    InvalidSelectedProfile,
    #[error("no selected local mesh-node profile")]
    NoSelectedProfile,
    #[error("the selected profile changed after this document was read")]
    StaleSelectionContext,
    #[error("node configuration selection generation is exhausted")]
    SelectionGenerationExhausted,
    #[error("node configuration persistence is unavailable")]
    PersistenceUnavailable,
    #[error("stored node configuration is invalid")]
    InvalidStoredDocument,
    #[error("node configuration draft is invalid")]
    InvalidCandidateDocument,
    #[error("node configuration draft must contain the exact next revision")]
    CandidateRevisionMismatch {
        expected_next_revision: u64,
        candidate_revision: u64,
    },
    #[error("node configuration revision conflict")]
    RevisionConflict {
        expected_revision: u64,
        current_revision: u64,
    },
    #[error("node configuration revision is exhausted")]
    RevisionExhausted,
    #[error("node configuration exceeds the storage size limit")]
    TooLarge,
    #[error("node configuration publication was not committed")]
    NotPublished,
    #[error("node configuration publication is indeterminate; reconcile before use")]
    IndeterminatePublication,
    #[error("node configuration namespace requires reconciliation")]
    ReconciliationRequired,
    #[error("node configuration durability is not yet confirmed")]
    ReconciliationIncomplete,
    #[error("authoritative node configuration is not a recognized generation")]
    UnexpectedGeneration,
    #[error("node configuration has not been initialized")]
    NotInitialized,
    #[error("node configuration owner is unavailable")]
    OwnerUnavailable,
    #[error(transparent)]
    PublicationFence(#[from] NativePublicationFenceError),
    #[error("system clock is outside the supported node configuration timestamp range")]
    ClockUnavailable,
}

#[derive(Clone, Debug)]
struct IndeterminateGeneration {
    previous: Option<Vec<u8>>,
    candidate: Vec<u8>,
}

#[derive(Default)]
struct OwnerState {
    selected_profile: Option<NodeConfigProfileNamespace>,
    selection_generation: u64,
    indeterminate: BTreeMap<NodeConfigProfileNamespace, IndeterminateGeneration>,
}

/// One in-process operation owner. Profile selection and all storage
/// operations share one mutex; callers pass no profile or peer ID to load/CAS.
pub struct NodeConfigOperationOwner<P> {
    persistence: P,
    identity: Arc<()>,
    state: Mutex<OwnerState>,
    #[cfg(test)]
    authorized_operation_waiting_for_owner_lock:
        std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

impl<P: NodeConfigPersistence> NodeConfigOperationOwner<P> {
    /// Create an owner with no selected profile.
    pub fn new(persistence: P) -> Self {
        Self {
            persistence,
            identity: Arc::new(()),
            state: Mutex::new(OwnerState::default()),
            #[cfg(test)]
            authorized_operation_waiting_for_owner_lock: std::sync::Mutex::new(None),
        }
    }

    /// Install the currently selected namespace supplied by the trusted native
    /// profile resolver. Selection changes serialize with reads and writes.
    ///
    /// This operation may block on the owner mutex. Call it from a blocking
    /// task, not an async executor or UI event-loop thread.
    pub fn select_profile(
        &self,
        profile: Option<NodeConfigProfileNamespace>,
    ) -> Result<(), NodeConfigOperationError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigOperationError::OwnerUnavailable)?;
        if state.selected_profile != profile {
            let next_generation = state
                .selection_generation
                .checked_add(1)
                .ok_or(NodeConfigOperationError::SelectionGenerationExhausted)?;
            state.selection_generation = next_generation;
            state.selected_profile = profile;
        }
        Ok(())
    }

    /// Report whether the selected namespace is quarantined, without touching
    /// the persistence backend. A poisoned owner lock fails closed.
    pub(crate) fn selected_profile_requires_reconciliation(
        &self,
    ) -> Result<bool, NodeConfigOperationError> {
        let state = self
            .state
            .lock()
            .map_err(|_| NodeConfigOperationError::OwnerUnavailable)?;
        Ok(state
            .selected_profile
            .is_some_and(|profile| state.indeterminate.contains_key(&profile)))
    }

    /// Read the selected profile document or create its default revision once.
    /// Existing bytes are strictly validated and never overwritten by
    /// initialization. The receipt binds a future compare-and-swap to this
    /// owner instance and the selection observed under the same lock.
    ///
    /// This operation may block on the owner mutex and persistence backend.
    /// Call it from a blocking task, not an async executor or UI event-loop
    /// thread.
    pub fn load_or_initialize(&self) -> Result<NodeConfigReadReceipt, NodeConfigOperationError> {
        self.load_or_initialize_with_ticket(None)
    }

    /// Read or initialize the selected policy only after this operation's
    /// native ticket reserves at the owner lock, before the first backend read.
    /// The ticket must have been captured before queueing this operation.
    pub fn load_or_initialize_authorized(
        &self,
        fence: &NativePublicationFence,
        ticket: NativePublicationTicket,
    ) -> Result<NodeConfigReadReceipt, NodeConfigOperationError> {
        self.load_or_initialize_with_ticket(Some((fence, ticket)))
    }

    fn load_or_initialize_with_ticket(
        &self,
        authorization: Option<(&NativePublicationFence, NativePublicationTicket)>,
    ) -> Result<NodeConfigReadReceipt, NodeConfigOperationError> {
        let mut state = self.lock_available_state()?;
        let profile = selected_profile(&state)?;
        reject_quarantined(&state, profile)?;
        let reservation = authorization
            .map(|(fence, ticket)| fence.reserve(ticket))
            .transpose()?;
        let result = (|| {
            let document = match self
                .persistence
                .read(profile)
                .map_err(|_| NodeConfigOperationError::PersistenceUnavailable)?
            {
                Some(bytes) => decode_stored_document(&bytes),
                None => {
                    let candidate = empty_node_config_document_v2(current_time_ms()?)
                        .map_err(map_candidate_error)?;
                    let bytes = serialize_document(&candidate)?;
                    match self.persistence.create_if_absent(profile, &bytes) {
                        Ok(CreateIfAbsentResult::Created) => Ok(candidate),
                        Ok(CreateIfAbsentResult::AlreadyExists(existing)) => {
                            decode_stored_document(&existing)
                        }
                        Err(NodeConfigPublishFailure::NotPublished) => {
                            Err(NodeConfigOperationError::NotPublished)
                        }
                        Err(NodeConfigPublishFailure::Indeterminate) => {
                            state.indeterminate.insert(
                                profile,
                                IndeterminateGeneration {
                                    previous: None,
                                    candidate: bytes,
                                },
                            );
                            Err(NodeConfigOperationError::IndeterminatePublication)
                        }
                    }
                }
            }?;
            Ok(NodeConfigReadReceipt {
                document,
                context: NodeConfigSelectionContext {
                    owner_identity: Arc::clone(&self.identity),
                    profile,
                    generation: state.selection_generation,
                },
            })
        })();
        settle_authorization(reservation, result.is_ok())?;
        result
    }

    /// Validate and persist exactly the next revision for the selection in a
    /// successful read receipt. The owner checks this context before parsing
    /// the draft or accessing persistence, and every write is revision-checked;
    /// there is no context-free or blind replacement API.
    ///
    /// The candidate's own `revision` must already equal
    /// `expected_revision + 1`; it is not silently repaired. This operation may
    /// block on the owner mutex and persistence backend. Call it from a
    /// blocking task, not an async executor or UI event-loop thread.
    pub fn compare_and_swap(
        &self,
        context: &NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: &str,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigOperationError> {
        self.compare_and_swap_with_ticket(None, context, expected_revision, draft_json)
    }

    /// Compare-and-swap after validating the original read context and draft,
    /// then reserve the native ticket under the owner lock before any backend
    /// access. The original context is never refreshed or replaced.
    pub fn compare_and_swap_authorized(
        &self,
        fence: &NativePublicationFence,
        ticket: NativePublicationTicket,
        context: &NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: &str,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigOperationError> {
        self.compare_and_swap_with_ticket(
            Some((fence, ticket)),
            context,
            expected_revision,
            draft_json,
        )
    }

    fn compare_and_swap_with_ticket(
        &self,
        authorization: Option<(&NativePublicationFence, NativePublicationTicket)>,
        context: &NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: &str,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigOperationError> {
        let mut state = self.lock_available_state()?;
        validate_selection_context(&self.identity, &state, context)?;
        let profile = selected_profile(&state)?;
        reject_quarantined(&state, profile)?;
        if draft_json.len() > MAX_NODE_CONFIG_BYTES {
            return Err(NodeConfigOperationError::TooLarge);
        }
        let draft =
            validate_node_config_document_v2_json(draft_json).map_err(map_candidate_error)?;
        let expected_next_revision = expected_revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_INTEGER)
            .ok_or(NodeConfigOperationError::RevisionExhausted)?;
        if draft.revision != expected_next_revision {
            return Err(NodeConfigOperationError::CandidateRevisionMismatch {
                expected_next_revision,
                candidate_revision: draft.revision,
            });
        }
        let reservation = authorization
            .map(|(fence, ticket)| fence.reserve(ticket))
            .transpose()?;
        let result = (|| {
            let previous = self
                .persistence
                .read(profile)
                .map_err(|_| NodeConfigOperationError::PersistenceUnavailable)?
                .ok_or(NodeConfigOperationError::NotInitialized)?;
            let current = decode_stored_document(&previous)?;
            let draft_value: Value = serde_json::to_value(draft)
                .map_err(|_| NodeConfigOperationError::InvalidCandidateDocument)?;
            let candidate = update_node_config_document_v2(
                &current,
                draft_value,
                expected_revision,
                current_time_ms()?,
            )
            .map_err(map_candidate_error)?;
            let bytes = serialize_document(&candidate)?;
            match self.persistence.replace_atomically(profile, &bytes) {
                Ok(()) => Ok(NodeConfigWriteReceipt {
                    document: candidate,
                }),
                Err(NodeConfigPublishFailure::NotPublished) => {
                    Err(NodeConfigOperationError::NotPublished)
                }
                Err(NodeConfigPublishFailure::Indeterminate) => {
                    state.indeterminate.insert(
                        profile,
                        IndeterminateGeneration {
                            previous: Some(previous),
                            candidate: bytes,
                        },
                    );
                    Err(NodeConfigOperationError::IndeterminatePublication)
                }
            }
        })();
        settle_authorization(reservation, result.is_ok())?;
        result
    }

    /// Reconcile an uncertain publication through an explicit backend durability
    /// confirmation. Only the exact previous or candidate bytes may clear the
    /// quarantine; a confirmed absent record is accepted only when there was no
    /// previous document. Any other generation remains blocked.
    ///
    /// This operation may block on the owner mutex and persistence backend.
    /// Call it from a blocking task, not an async executor or UI event-loop
    /// thread.
    pub fn reconcile_selected_profile(
        &self,
    ) -> Result<NodeConfigReconciliation, NodeConfigOperationError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NodeConfigOperationError::OwnerUnavailable)?;
        let profile = selected_profile(&state)?;
        let pending = state
            .indeterminate
            .get(&profile)
            .cloned()
            .ok_or(NodeConfigOperationError::ReconciliationRequired)?;
        let confirmed = self
            .persistence
            .confirm_durable_snapshot(profile)
            .map_err(|_| NodeConfigOperationError::ReconciliationIncomplete)?;
        let Some(confirmed) = confirmed else {
            if pending.previous.is_some() {
                return Err(NodeConfigOperationError::UnexpectedGeneration);
            }
            state.indeterminate.remove(&profile);
            return Ok(NodeConfigReconciliation::Uninitialized);
        };
        let is_candidate = confirmed == pending.candidate;
        let is_previous = pending.previous.as_ref() == Some(&confirmed);
        if !is_candidate && !is_previous {
            return Err(NodeConfigOperationError::UnexpectedGeneration);
        }
        let document = decode_stored_document(&confirmed)?;
        state.indeterminate.remove(&profile);
        Ok(NodeConfigReconciliation::Initialized(Box::new(document)))
    }

    fn lock_available_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, OwnerState>, NodeConfigOperationError> {
        #[cfg(test)]
        self.signal_authorized_operation_waiting_for_owner_lock();
        self.state
            .lock()
            .map_err(|_| NodeConfigOperationError::OwnerUnavailable)
    }

    #[cfg(test)]
    fn signal_authorized_operation_waiting_for_owner_lock(&self) {
        if let Ok(mut hook) = self.authorized_operation_waiting_for_owner_lock.lock() {
            if let Some(entered) = hook.take() {
                let _ = entered.send(());
            }
        }
    }
}

fn settle_authorization(
    reservation: Option<crate::native_publication_fence::NativePublicationReservation>,
    succeeded: bool,
) -> Result<(), NodeConfigOperationError> {
    if let Some(reservation) = reservation {
        reservation.settle(succeeded)?;
    }
    Ok(())
}

fn selected_profile(
    state: &OwnerState,
) -> Result<NodeConfigProfileNamespace, NodeConfigOperationError> {
    state
        .selected_profile
        .ok_or(NodeConfigOperationError::NoSelectedProfile)
}

fn validate_selection_context(
    owner_identity: &Arc<()>,
    state: &OwnerState,
    context: &NodeConfigSelectionContext,
) -> Result<(), NodeConfigOperationError> {
    if !Arc::ptr_eq(owner_identity, &context.owner_identity)
        || state.selected_profile != Some(context.profile)
        || state.selection_generation != context.generation
    {
        return Err(NodeConfigOperationError::StaleSelectionContext);
    }
    Ok(())
}

fn reject_quarantined(
    state: &OwnerState,
    profile: NodeConfigProfileNamespace,
) -> Result<(), NodeConfigOperationError> {
    if state.indeterminate.contains_key(&profile) {
        Err(NodeConfigOperationError::ReconciliationRequired)
    } else {
        Ok(())
    }
}

fn decode_stored_document(bytes: &[u8]) -> Result<NodeConfigDocumentV2, NodeConfigOperationError> {
    if bytes.len() > MAX_NODE_CONFIG_BYTES {
        return Err(NodeConfigOperationError::TooLarge);
    }
    let text =
        std::str::from_utf8(bytes).map_err(|_| NodeConfigOperationError::InvalidStoredDocument)?;
    validate_node_config_document_v2_json(text)
        .map_err(|_| NodeConfigOperationError::InvalidStoredDocument)
}

fn serialize_document(
    document: &NodeConfigDocumentV2,
) -> Result<Vec<u8>, NodeConfigOperationError> {
    let bytes = serde_json::to_vec(document)
        .map_err(|_| NodeConfigOperationError::InvalidCandidateDocument)?;
    if bytes.len() > MAX_NODE_CONFIG_BYTES {
        return Err(NodeConfigOperationError::TooLarge);
    }
    Ok(bytes)
}

fn current_time_ms() -> Result<u64, NodeConfigOperationError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| NodeConfigOperationError::ClockUnavailable)?;
    let timestamp = u64::try_from(elapsed.as_millis())
        .map_err(|_| NodeConfigOperationError::ClockUnavailable)?;
    if timestamp > MAX_SAFE_INTEGER {
        return Err(NodeConfigOperationError::ClockUnavailable);
    }
    Ok(timestamp)
}

fn map_candidate_error(error: NodePolicyError) -> NodeConfigOperationError {
    match error {
        NodePolicyError::RevisionConflict {
            expected_revision,
            current_revision,
        } => NodeConfigOperationError::RevisionConflict {
            expected_revision,
            current_revision,
        },
        NodePolicyError::RevisionExhausted => NodeConfigOperationError::RevisionExhausted,
        _ => NodeConfigOperationError::InvalidCandidateDocument,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_core::node_policy::{
        empty_node_config_document_v1, migrate_node_config_document_v2,
    };
    use std::sync::{mpsc, Arc};
    use std::thread;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum PublishMode {
        Commit,
        NotPublished,
        IndeterminateBeforeWrite,
        IndeterminateAfterWrite,
    }

    #[derive(Default)]
    struct FakeState {
        records: BTreeMap<NodeConfigProfileNamespace, Vec<u8>>,
        publish_mode: Option<PublishMode>,
        confirm_durable: bool,
        access_count: usize,
        read_count: usize,
        publish_count: usize,
        create_count: usize,
        create_gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
        publish_gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    }

    #[derive(Clone, Default)]
    struct FakePersistence(Arc<Mutex<FakeState>>);

    impl FakePersistence {
        fn set_publish_mode(&self, mode: PublishMode) {
            self.0.lock().expect("fake lock").publish_mode = Some(mode);
        }

        fn set_confirm_durable(&self, confirm: bool) {
            self.0.lock().expect("fake lock").confirm_durable = confirm;
        }

        fn seed(&self, profile: NodeConfigProfileNamespace, bytes: Vec<u8>) {
            self.0
                .lock()
                .expect("fake lock")
                .records
                .insert(profile, bytes);
        }

        fn bytes(&self, profile: NodeConfigProfileNamespace) -> Option<Vec<u8>> {
            self.0
                .lock()
                .expect("fake lock")
                .records
                .get(&profile)
                .cloned()
        }

        fn publish_count(&self) -> usize {
            self.0.lock().expect("fake lock").publish_count
        }

        fn read_count(&self) -> usize {
            self.0.lock().expect("fake lock").read_count
        }

        fn access_count(&self) -> usize {
            self.0.lock().expect("fake lock").access_count
        }

        fn create_count(&self) -> usize {
            self.0.lock().expect("fake lock").create_count
        }

        fn gate_next_publish(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            self.0.lock().expect("fake lock").publish_gate = Some((entered_tx, release_rx));
            (entered_rx, release_tx)
        }

        fn gate_next_create(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            self.0.lock().expect("fake lock").create_gate = Some((entered_tx, release_rx));
            (entered_rx, release_tx)
        }
    }

    impl NodeConfigPersistence for FakePersistence {
        fn read(
            &self,
            profile: NodeConfigProfileNamespace,
        ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
            let mut state = self.0.lock().expect("fake lock");
            state.access_count += 1;
            state.read_count += 1;
            Ok(state.records.get(&profile).cloned())
        }

        fn create_if_absent(
            &self,
            profile: NodeConfigProfileNamespace,
            candidate: &[u8],
        ) -> Result<CreateIfAbsentResult, NodeConfigPublishFailure> {
            let gate = {
                let mut state = self.0.lock().expect("fake lock");
                state.access_count += 1;
                state.create_count += 1;
                state.create_gate.take()
            };
            if let Some((entered, release)) = gate {
                entered.send(()).expect("create waiter");
                release.recv().expect("create release");
            }
            let mut state = self.0.lock().expect("fake lock");
            if let Some(existing) = state.records.get(&profile) {
                return Ok(CreateIfAbsentResult::AlreadyExists(existing.clone()));
            }
            match state.publish_mode.take().unwrap_or(PublishMode::Commit) {
                PublishMode::Commit => {
                    state.records.insert(profile, candidate.to_vec());
                    Ok(CreateIfAbsentResult::Created)
                }
                PublishMode::NotPublished => Err(NodeConfigPublishFailure::NotPublished),
                PublishMode::IndeterminateBeforeWrite => {
                    Err(NodeConfigPublishFailure::Indeterminate)
                }
                PublishMode::IndeterminateAfterWrite => {
                    state.records.insert(profile, candidate.to_vec());
                    Err(NodeConfigPublishFailure::Indeterminate)
                }
            }
        }

        fn replace_atomically(
            &self,
            profile: NodeConfigProfileNamespace,
            candidate: &[u8],
        ) -> Result<(), NodeConfigPublishFailure> {
            let gate = {
                let mut state = self.0.lock().expect("fake lock");
                state.access_count += 1;
                state.publish_gate.take()
            };
            if let Some((entered, release)) = gate {
                entered.send(()).expect("publish waiter");
                release.recv().expect("publish release");
            }
            let mut state = self.0.lock().expect("fake lock");
            state.publish_count += 1;
            match state.publish_mode.take().unwrap_or(PublishMode::Commit) {
                PublishMode::Commit => {
                    state.records.insert(profile, candidate.to_vec());
                    Ok(())
                }
                PublishMode::NotPublished => Err(NodeConfigPublishFailure::NotPublished),
                PublishMode::IndeterminateBeforeWrite => {
                    Err(NodeConfigPublishFailure::Indeterminate)
                }
                PublishMode::IndeterminateAfterWrite => {
                    state.records.insert(profile, candidate.to_vec());
                    Err(NodeConfigPublishFailure::Indeterminate)
                }
            }
        }

        fn confirm_durable_snapshot(
            &self,
            profile: NodeConfigProfileNamespace,
        ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
            let mut state = self.0.lock().expect("fake lock");
            state.access_count += 1;
            if !state.confirm_durable {
                return Err(NodeConfigPersistenceError);
            }
            Ok(state.records.get(&profile).cloned())
        }
    }

    fn profile(id: &str) -> NodeConfigProfileNamespace {
        NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_profile_id(id)
            .expect("test profile ID")
    }

    fn owner_with_profile() -> (FakePersistence, NodeConfigOperationOwner<FakePersistence>) {
        let backend = FakePersistence::default();
        let owner = NodeConfigOperationOwner::new(backend.clone());
        owner
            .select_profile(Some(profile("local-a")))
            .expect("select");
        (backend, owner)
    }

    fn draft_json(document: &NodeConfigDocumentV2, mutate: impl FnOnce(&mut Value)) -> String {
        let mut value = serde_json::to_value(document).expect("document value");
        value["revision"] = Value::from(document.revision + 1);
        mutate(&mut value);
        serde_json::to_string(&value).expect("document JSON")
    }

    fn enable_tts_sharing(value: &mut Value) {
        value["speech"]["sharing"]["tts"] = Value::Bool(true);
    }

    #[test]
    fn namespace_identity_trim_matches_ecmascript_text() {
        for character in ['\u{0085}', '\u{001c}', '\u{180e}', '\u{200b}'] {
            let id = format!("{character}profile-a{character}");
            let peer = format!("{character}stable-a{character}");
            assert!(
                NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                    &id, &peer
                )
                .is_ok()
            );
        }
        for character in ['\u{feff}', '\u{00a0}', '\u{2028}', '\u{3000}'] {
            let id = format!("{character}profile-a");
            assert_eq!(
                NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                    &id, "stable-a"
                ),
                Err(NodeConfigOperationError::InvalidSelectedProfile)
            );
        }
    }

    #[test]
    fn two_expected_revision_writers_have_one_winner_and_one_typed_conflict() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let left = draft_json(&current.document, enable_tts_sharing);
        let right = draft_json(&current.document, |value| {
            value["speech"]["sharing"]["stt"] = Value::Bool(true);
        });
        let context = current.context.clone();
        let owner = Arc::new(owner);
        let gate = Arc::new(std::sync::Barrier::new(3));
        let tasks: Vec<_> = [left, right]
            .into_iter()
            .map(|draft| {
                let owner = Arc::clone(&owner);
                let gate = Arc::clone(&gate);
                let context = context.clone();
                thread::spawn(move || {
                    gate.wait();
                    owner.compare_and_swap(&context, 1, &draft)
                })
            })
            .collect();
        gate.wait();
        let results: Vec<_> = tasks
            .into_iter()
            .map(|task| task.join().expect("writer thread"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(
                    result,
                    Err(NodeConfigOperationError::RevisionConflict {
                        expected_revision: 1,
                        current_revision: 2
                    })
                ))
                .count(),
            1
        );
        let winning_receipt = results
            .iter()
            .find_map(|result| result.as_ref().ok())
            .expect("one writer receipt");
        let persisted = backend.bytes(profile("local-a")).expect("persisted winner");
        assert_eq!(
            decode_stored_document(&persisted).expect("stored document"),
            winning_receipt.document
        );
        assert_eq!(backend.publish_count(), 1);
        assert_eq!(
            owner.load_or_initialize().expect("read").document,
            winning_receipt.document
        );
    }

    #[test]
    fn authorized_initialization_queued_at_owner_lock_loses_to_revocation_without_io() {
        let (backend, owner) = owner_with_profile();
        let owner = Arc::new(owner);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket before queue");
        let owner_state = owner.state.lock().expect("hold owner lock");
        let (entered_tx, entered_rx) = mpsc::channel();
        *owner
            .authorized_operation_waiting_for_owner_lock
            .lock()
            .expect("owner-lock test hook") = Some(entered_tx);
        let owner_for_worker = Arc::clone(&owner);
        let fence_for_worker = fence.clone();
        let worker = thread::spawn(move || {
            owner_for_worker.load_or_initialize_authorized(&fence_for_worker, ticket)
        });
        entered_rx
            .recv()
            .expect("production owner path reached the lock boundary");

        let revocation = fence
            .revoke(&registration)
            .expect("close admission promptly");
        assert_eq!(
            tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("test runtime")
                .block_on(revocation.wait()),
            Ok(()),
            "no reservation exists while the owner mutex is held"
        );
        drop(owner_state);
        assert!(matches!(
            worker.join().expect("owner worker"),
            Err(NodeConfigOperationError::PublicationFence(
                NativePublicationFenceError::TicketUnavailable
            ))
        ));
        assert_eq!(backend.access_count(), 0);
        assert_eq!(backend.create_count(), 0);
    }

    #[test]
    fn authorized_cas_reserves_only_after_the_owner_lock() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let draft = draft_json(&current.document, enable_tts_sharing);
        let initial_access_count = backend.access_count();
        let owner = Arc::new(owner);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket before queue");
        let owner_state = owner.state.lock().expect("hold owner lock");
        let (entered_tx, entered_rx) = mpsc::channel();
        *owner
            .authorized_operation_waiting_for_owner_lock
            .lock()
            .expect("owner-lock test hook") = Some(entered_tx);
        let owner_for_worker = Arc::clone(&owner);
        let fence_for_worker = fence.clone();
        let worker = thread::spawn(move || {
            owner_for_worker.compare_and_swap_authorized(
                &fence_for_worker,
                ticket,
                &current.context,
                1,
                &draft,
            )
        });
        entered_rx
            .recv()
            .expect("production owner path reached the lock boundary");

        assert_eq!(
            tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("test runtime")
                .block_on(fence.revoke(&registration).expect("close admission").wait()),
            Ok(()),
            "the queued CAS has not reserved while the owner lock is held"
        );
        drop(owner_state);
        assert!(matches!(
            worker.join().expect("CAS worker"),
            Err(NodeConfigOperationError::PublicationFence(
                NativePublicationFenceError::TicketUnavailable
            ))
        ));
        assert_eq!(backend.access_count(), initial_access_count);
        assert_eq!(backend.publish_count(), 0);
    }

    #[tokio::test]
    async fn authorized_default_initialization_keeps_revocation_pending_until_create_settles() {
        let (backend, owner) = owner_with_profile();
        let (entered, release) = backend.gate_next_create();
        let owner = Arc::new(owner);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let owner_for_worker = Arc::clone(&owner);
        let fence_for_worker = fence.clone();
        let operation = tokio::task::spawn_blocking(move || {
            owner_for_worker.load_or_initialize_authorized(&fence_for_worker, ticket)
        });
        entered
            .recv()
            .expect("default create reached after reservation");

        let waiter = fence
            .revoke(&registration)
            .expect("revoke while create runs");
        let mut waiter = Box::pin(waiter.wait());
        tokio::select! {
            biased;
            result = &mut waiter => panic!("revocation completed before create settled: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        release.send(()).expect("allow one reserved initialization");
        assert_eq!(
            operation
                .await
                .expect("blocking owner operation")
                .map(|receipt| receipt.document.revision),
            Ok(1)
        );
        assert_eq!(waiter.await, Ok(()));
        assert_eq!(backend.create_count(), 1);
        assert!(backend.bytes(profile("local-a")).is_some());
    }

    #[tokio::test]
    async fn authorized_compare_and_swap_preserves_revision_and_settles_cleanly() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let draft = draft_json(&current.document, enable_tts_sharing);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let receipt = owner
            .compare_and_swap_authorized(
                &fence,
                registration.issue_ticket().expect("ticket"),
                &current.context,
                1,
                &draft,
            )
            .expect("authorized CAS");

        assert_eq!(receipt.document.revision, 2);
        assert_eq!(backend.publish_count(), 1);
        assert_eq!(
            fence
                .revoke(&registration)
                .expect("revoke settled operation")
                .wait()
                .await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn authorized_indeterminate_cas_stays_sticky_after_owner_quarantine() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let draft = draft_json(&current.document, enable_tts_sharing);
        backend.set_publish_mode(PublishMode::IndeterminateAfterWrite);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");

        assert_eq!(
            owner.compare_and_swap_authorized(
                &fence,
                registration.issue_ticket().expect("ticket"),
                &current.context,
                1,
                &draft,
            ),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert_eq!(
            registration.issue_ticket().err(),
            Some(NativePublicationFenceError::RegistrationUnavailable),
            "indeterminate publication closes this registration's admission"
        );
        assert_eq!(
            fence
                .revoke(&registration)
                .expect("revoke uncertain operation")
                .wait()
                .await,
            Err(NativePublicationFenceError::OperationFailed)
        );
        let before = backend.access_count();
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
        assert_eq!(backend.access_count(), before);
    }

    #[cfg(unix)]
    #[test]
    fn authorized_real_file_initialization_is_fenced_and_keeps_revoked_default_absent() {
        use crate::node_config_file::NodeConfigFilePersistence;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);
        let root = std::env::temp_dir().join(format!(
            "aurora-authorized-node-config-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("create test root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("make private test root");
        let owner = Arc::new(NodeConfigOperationOwner::new(
            NodeConfigFilePersistence::new(&root),
        ));
        let namespace = profile("local-a");
        owner
            .select_profile(Some(namespace))
            .expect("select test namespace");
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("queued ticket");
        let held_owner_lock = owner.state.lock().expect("hold owner before storage");
        let (entered_tx, entered_rx) = mpsc::channel();
        *owner
            .authorized_operation_waiting_for_owner_lock
            .lock()
            .expect("owner-lock test hook") = Some(entered_tx);
        let owner_for_worker = Arc::clone(&owner);
        let fence_for_worker = fence.clone();
        let worker = thread::spawn(move || {
            owner_for_worker.load_or_initialize_authorized(&fence_for_worker, ticket)
        });
        entered_rx
            .recv()
            .expect("production owner path reached the lock boundary");

        let revoked = fence
            .revoke(&registration)
            .expect("revoke before reservation");
        assert_eq!(
            tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("test runtime")
                .block_on(revoked.wait()),
            Ok(())
        );
        drop(held_owner_lock);
        assert!(matches!(
            worker.join().expect("queued owner call"),
            Err(NodeConfigOperationError::PublicationFence(
                NativePublicationFenceError::TicketUnavailable
            ))
        ));
        assert!(
            !root.join("node-config-v2").exists(),
            "revocation winner must not provision policy storage"
        );

        let later_registration = fence.register().expect("fresh registration");
        let initialized = owner
            .load_or_initialize_authorized(
                &fence,
                later_registration.issue_ticket().expect("fresh ticket"),
            )
            .expect("one authorized default initialization");
        assert_eq!(initialized.document.revision, 1);
        assert!(root
            .join("node-config-v2")
            .join(namespace.storage_component())
            .join("document.json")
            .is_file());
        assert_eq!(
            tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("test runtime")
                .block_on(
                    fence
                        .revoke(&later_registration)
                        .expect("revoke settled write")
                        .wait()
                ),
            Ok(())
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn concurrent_initializers_create_once_and_never_overwrite_existing_bytes() {
        let (backend, owner) = owner_with_profile();
        let owner = Arc::new(owner);
        let gate = Arc::new(std::sync::Barrier::new(3));
        let tasks: Vec<_> = [(), ()]
            .into_iter()
            .map(|_| {
                let owner = Arc::clone(&owner);
                let gate = Arc::clone(&gate);
                thread::spawn(move || {
                    gate.wait();
                    owner.load_or_initialize().expect("initialize")
                })
            })
            .collect();
        gate.wait();
        let documents: Vec<_> = tasks
            .into_iter()
            .map(|task| task.join().expect("initializer thread").document)
            .collect();
        assert_eq!(documents[0], documents[1]);
        assert_eq!(backend.create_count(), 1);
    }

    #[test]
    fn invalid_candidate_stale_revision_and_exhaustion_do_not_publish() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let context = current.context.clone();
        let mut current_at_three = current.document.clone();
        current_at_three.revision = 3;
        backend.seed(
            profile("local-a"),
            serde_json::to_vec(&current_at_three).expect("current revision three"),
        );
        let original_bytes = backend.bytes(profile("local-a")).expect("stored bytes");
        let invalid = r#"{"version":2,"revision":1}"#;
        assert_eq!(
            owner.compare_and_swap(&context, 1, invalid),
            Err(NodeConfigOperationError::InvalidCandidateDocument)
        );

        let zero_revision = draft_json(&current_at_three, |value| {
            value["revision"] = Value::from(0);
            enable_tts_sharing(value);
        });
        assert_eq!(
            owner.compare_and_swap(&context, 3, &zero_revision),
            Err(NodeConfigOperationError::InvalidCandidateDocument)
        );

        for candidate_revision in [2, 3, 5] {
            let mismatched = draft_json(&current_at_three, |value| {
                value["revision"] = Value::from(candidate_revision);
                enable_tts_sharing(value);
            });
            assert_eq!(
                owner.compare_and_swap(&context, 3, &mismatched),
                Err(NodeConfigOperationError::CandidateRevisionMismatch {
                    expected_next_revision: 4,
                    candidate_revision,
                })
            );
            assert_eq!(
                backend.bytes(profile("local-a")),
                Some(original_bytes.clone())
            );
        }

        backend.seed(
            profile("local-a"),
            serde_json::to_vec(&current.document).expect("restore current revision one"),
        );
        let bytes_at_one = backend
            .bytes(profile("local-a"))
            .expect("stored bytes at one");
        let stale_draft = draft_json(&current.document, |value| {
            value["revision"] = Value::from(1);
            enable_tts_sharing(value);
        });
        assert!(matches!(
            owner.compare_and_swap(&context, 0, &stale_draft),
            Err(NodeConfigOperationError::RevisionConflict {
                expected_revision: 0,
                current_revision: 1
            })
        ));
        assert_eq!(backend.publish_count(), 0);
        assert_eq!(backend.bytes(profile("local-a")), Some(bytes_at_one));

        let mut exhausted = current.document;
        exhausted.revision = MAX_SAFE_INTEGER;
        backend.seed(
            profile("local-a"),
            serde_json::to_vec(&exhausted).expect("exhausted document"),
        );
        let exhausted_draft = serde_json::to_string(&exhausted).expect("draft");
        assert_eq!(
            owner.compare_and_swap(&context, MAX_SAFE_INTEGER, &exhausted_draft),
            Err(NodeConfigOperationError::RevisionExhausted)
        );
        assert_eq!(backend.publish_count(), 0);
    }

    #[test]
    fn malformed_current_document_fails_closed_without_replacement() {
        let (backend, owner) = owner_with_profile();
        backend.seed(profile("local-a"), b"{not-json".to_vec());
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::InvalidStoredDocument)
        );
        assert_eq!(backend.publish_count(), 0);
        assert_eq!(
            backend.bytes(profile("local-a")).as_deref(),
            Some(&b"{not-json"[..])
        );
    }

    #[test]
    fn policy_size_boundary_is_checked_at_65536_bytes() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let context = current.context.clone();
        let compact = draft_json(&current.document, enable_tts_sharing);
        let at_limit = format!(
            "{}{}",
            compact,
            " ".repeat(MAX_NODE_CONFIG_BYTES - compact.len())
        );
        let receipt = owner
            .compare_and_swap(&context, 1, &at_limit)
            .expect("exact boundary is accepted");
        assert_eq!(receipt.document.revision, 2);

        let next_context = context;
        let over = draft_json(&receipt.document, |value| {
            value["speech"]["sharing"]["stt"] = Value::Bool(true);
        });
        let over = format!(
            "{}{}",
            over,
            " ".repeat(MAX_NODE_CONFIG_BYTES + 1 - over.len())
        );
        assert_eq!(
            owner.compare_and_swap(&next_context, 2, &over),
            Err(NodeConfigOperationError::TooLarge)
        );
        assert_eq!(backend.publish_count(), 1);
    }

    #[test]
    fn candidate_retains_the_current_immutable_v1_snapshot() {
        let backend = FakePersistence::default();
        let owner = NodeConfigOperationOwner::new(backend.clone());
        let selected = profile("local-a");
        owner.select_profile(Some(selected)).expect("select");
        let v1 = empty_node_config_document_v1(10).expect("v1 defaults");
        let migrated =
            migrate_node_config_document_v2(serde_json::to_value(v1).expect("v1 value"), 10)
                .expect("migration");
        let original_snapshot = migrated.legacy_v1_snapshot.clone();
        backend.seed(selected, serde_json::to_vec(&migrated).expect("v2 bytes"));

        let alternate_snapshot = empty_node_config_document_v1(20).expect("alternate v1 defaults");
        for forged_snapshot in [
            Value::Null,
            serde_json::to_value(alternate_snapshot).expect("alternate snapshot value"),
        ] {
            let current = owner.load_or_initialize().expect("current document");
            let draft = draft_json(&current.document, |value| {
                value["legacyV1Snapshot"] = forged_snapshot;
                enable_tts_sharing(value);
            });
            let updated = owner
                .compare_and_swap(&current.context, current.document.revision, &draft)
                .expect("update preserves immutable snapshot");
            assert_eq!(updated.document.legacy_v1_snapshot, original_snapshot);
            let persisted = backend.bytes(selected).expect("persisted document");
            assert_eq!(
                decode_stored_document(&persisted)
                    .expect("stored document")
                    .legacy_v1_snapshot,
                original_snapshot
            );
        }
    }

    #[test]
    fn prepublication_failure_keeps_previous_generation_and_owner_usable() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let previous_bytes = backend.bytes(profile("local-a")).expect("stored bytes");
        let draft = draft_json(&current.document, enable_tts_sharing);
        backend.set_publish_mode(PublishMode::NotPublished);

        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::NotPublished)
        );
        assert_eq!(backend.bytes(profile("local-a")), Some(previous_bytes));
        assert_eq!(
            owner
                .load_or_initialize()
                .expect("still usable")
                .document
                .revision,
            1
        );

        let receipt = owner
            .compare_and_swap(&current.context, 1, &draft)
            .expect("retry");
        assert_eq!(receipt.document.revision, 2);
    }

    #[test]
    fn indeterminate_publish_quarantines_until_explicit_durability_confirmation() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let draft = draft_json(&current.document, enable_tts_sharing);
        backend.set_publish_mode(PublishMode::IndeterminateAfterWrite);
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert_eq!(
            backend
                .bytes(profile("local-a"))
                .map(|bytes| decode_stored_document(&bytes).expect("candidate").revision),
            Some(2)
        );
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
        assert_eq!(
            owner.reconcile_selected_profile(),
            Err(NodeConfigOperationError::ReconciliationIncomplete)
        );
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );

        backend.set_confirm_durable(true);
        assert_eq!(
            owner.reconcile_selected_profile().expect("confirm"),
            NodeConfigReconciliation::Initialized(Box::new(
                decode_stored_document(&backend.bytes(profile("local-a")).expect("stored"))
                    .expect("confirmed document")
            ))
        );
        let next_read = owner.load_or_initialize().expect("read");
        let next = draft_json(&next_read.document, |value| {
            value["speech"]["sharing"]["stt"] = Value::Bool(true);
        });
        assert_eq!(
            owner
                .compare_and_swap(&next_read.context, 2, &next)
                .expect("unblocked")
                .document
                .revision,
            3
        );
    }

    #[test]
    fn indeterminate_initialization_requires_confirmation_and_reconciles_publish_or_absence() {
        let (backend, owner) = owner_with_profile();
        backend.set_publish_mode(PublishMode::IndeterminateBeforeWrite);
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert!(backend.bytes(profile("local-a")).is_none());
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
        assert_eq!(
            owner.reconcile_selected_profile(),
            Err(NodeConfigOperationError::ReconciliationIncomplete)
        );
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );

        backend.set_confirm_durable(true);
        assert_eq!(
            owner.reconcile_selected_profile().expect("confirm absence"),
            NodeConfigReconciliation::Uninitialized
        );
        assert!(backend.bytes(profile("local-a")).is_none());

        let initialized = owner.load_or_initialize().expect("retry initialization");
        assert_eq!(initialized.document.revision, 1);
        assert_eq!(backend.create_count(), 2);
        assert_eq!(
            owner.reconcile_selected_profile(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );

        let (published_backend, published_owner) = owner_with_profile();
        published_backend.set_publish_mode(PublishMode::IndeterminateAfterWrite);
        assert_eq!(
            published_owner.load_or_initialize(),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert!(published_backend.bytes(profile("local-a")).is_some());
        published_backend.set_confirm_durable(true);
        let confirmed = published_owner
            .reconcile_selected_profile()
            .expect("confirm published initialization");
        let NodeConfigReconciliation::Initialized(confirmed_document) = confirmed else {
            panic!("published initialization must reconcile as initialized");
        };
        assert_eq!(confirmed_document.revision, 1);
        assert_eq!(
            published_owner
                .load_or_initialize()
                .map(|receipt| receipt.document),
            Ok(*confirmed_document)
        );
    }

    #[test]
    fn reconciliation_rejects_an_unexpected_generation_and_stays_quarantined() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize");
        let draft = draft_json(&current.document, enable_tts_sharing);
        backend.set_publish_mode(PublishMode::IndeterminateAfterWrite);
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        let mut third = current.document;
        third.revision = 3;
        backend.seed(
            profile("local-a"),
            serde_json::to_vec(&third).expect("third generation"),
        );
        backend.set_confirm_durable(true);
        assert_eq!(
            owner.reconcile_selected_profile(),
            Err(NodeConfigOperationError::UnexpectedGeneration)
        );
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
    }

    #[test]
    fn profile_switch_is_serialized_with_publication_and_namespaces_are_isolated() {
        let (backend, owner) = owner_with_profile();
        let current = owner.load_or_initialize().expect("initialize A");
        let draft = draft_json(&current.document, enable_tts_sharing);
        let context = current.context.clone();
        let (entered, release) = backend.gate_next_publish();
        let owner = Arc::new(owner);
        let writer_owner = Arc::clone(&owner);
        let writer = thread::spawn(move || writer_owner.compare_and_swap(&context, 1, &draft));
        entered.recv().expect("writer entered publication");

        let (switch_started_tx, switch_started_rx) = mpsc::channel();
        let switch_owner = Arc::clone(&owner);
        let switch = thread::spawn(move || {
            switch_started_tx.send(()).expect("switch started waiter");
            switch_owner.select_profile(Some(profile("local-b")))
        });
        switch_started_rx.recv().expect("switch started");
        assert!(
            owner.state.try_lock().is_err(),
            "profile selection must remain serialized behind the held publication"
        );
        release.send(()).expect("release writer");

        assert_eq!(
            writer
                .join()
                .expect("writer thread")
                .expect("write")
                .document
                .revision,
            2
        );
        switch
            .join()
            .expect("switch thread")
            .expect("switch profile");
        assert_eq!(
            owner
                .load_or_initialize()
                .expect("initialize B")
                .document
                .revision,
            1
        );
        owner
            .select_profile(Some(profile("local-a")))
            .expect("select A");
        let a = owner.load_or_initialize().expect("read A");
        assert_eq!(a.document.revision, 2);
        assert!(a.document.speech.sharing.tts);
    }

    #[test]
    fn profile_namespace_is_path_safe_and_distinct_without_exposing_identity() {
        let first = profile("local/a");
        let second = profile("local\\a");
        assert_ne!(first, second);
        let component = first.storage_component();
        assert_eq!(component.len(), 64);
        assert!(component.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_profile_id(""),
            Err(NodeConfigOperationError::InvalidSelectedProfile)
        );
    }

    #[test]
    fn selected_profile_and_stable_node_namespace_has_framed_domain_and_isolation() {
        let first = NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
            "profile-a",
            "node-a",
        )
        .expect("validated profile and node identity");
        assert_eq!(
            first.storage_component(),
            "ec0e910601f7d2689176134b33edac639fdb1b928d7ccb29838b3dcdfe2370c1"
        );
        assert_eq!(
            first,
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-a",
                "node-a"
            )
            .expect("same identity")
        );
        assert_ne!(first, profile("profile-a"));
        assert_ne!(
            first,
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-b",
                "node-a"
            )
            .expect("different profile")
        );
        assert_ne!(
            first,
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-a",
                "node-b"
            )
            .expect("different local node")
        );
        assert_ne!(
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-a",
                "node-b"
            )
            .expect("profile then node"),
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "node-b",
                "profile-a"
            )
            .expect("swapped tuple")
        );
        assert_ne!(
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity("ab", "c")
                .expect("first bare-concatenation tuple"),
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity("a", "bc")
                .expect("second bare-concatenation tuple")
        );
        let component = first.storage_component();
        assert_eq!(component.len(), 64);
        assert!(component
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert!(!component.contains('/') && !component.contains('\\'));
    }

    #[test]
    fn selected_profile_and_stable_node_namespace_enforces_canonical_byte_bounds() {
        for (profile_id, stable_node_id) in [
            ("", "node-a"),
            (" profile-a", "node-a"),
            ("profile-a ", "node-a"),
            ("profile-a", ""),
            ("profile-a", " node-a"),
            ("profile-a", "node-a "),
            ("\u{feff}profile-a", "node-a"),
            ("profile-a\u{feff}", "node-a"),
            ("profile-a", "\u{feff}node-a"),
            ("profile-a", "node-a\u{feff}"),
            (&"p".repeat(97), "node-a"),
            ("profile-a", &"n".repeat(161)),
            (&"é".repeat(49), "node-a"),
            ("profile-a", &"é".repeat(81)),
        ] {
            assert_eq!(
                NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                    profile_id,
                    stable_node_id
                ),
                Err(NodeConfigOperationError::InvalidSelectedProfile)
            );
        }

        assert!(
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                &"é".repeat(48),
                &"é".repeat(80)
            )
            .is_ok()
        );
        assert!(
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile\u{feff}a",
                "node\u{feff}a"
            )
            .is_ok()
        );
    }

    #[test]
    fn operations_without_a_selected_profile_do_not_fall_back_to_global_storage() {
        let backend = FakePersistence::default();
        let owner = NodeConfigOperationOwner::new(backend.clone());
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::NoSelectedProfile)
        );
        assert!(backend.bytes(profile("local-a")).is_none());
        assert_eq!(backend.create_count(), 0);
    }

    #[test]
    fn selection_context_rejects_equal_revision_profile_switch_before_backend_access() {
        let (backend, owner) = owner_with_profile();
        let read_a = owner.load_or_initialize().expect("initialize A");
        owner
            .select_profile(Some(profile("local-b")))
            .expect("select B");
        let read_b = owner.load_or_initialize().expect("initialize B");
        assert_eq!(read_a.document.revision, read_b.document.revision);
        let a_bytes = backend.bytes(profile("local-a")).expect("A bytes");
        let b_bytes = backend.bytes(profile("local-b")).expect("B bytes");
        let reads_before = backend.read_count();
        let accesses_before = backend.access_count();
        let creates_before = backend.create_count();
        let publishes_before = backend.publish_count();

        assert_eq!(
            owner.compare_and_swap(&read_a.context, 1, "not-json"),
            Err(NodeConfigOperationError::StaleSelectionContext)
        );
        assert_eq!(backend.read_count(), reads_before);
        assert_eq!(backend.access_count(), accesses_before);
        assert_eq!(backend.create_count(), creates_before);
        assert_eq!(backend.publish_count(), publishes_before);
        assert_eq!(backend.bytes(profile("local-a")), Some(a_bytes));
        assert_eq!(backend.bytes(profile("local-b")), Some(b_bytes));
    }

    #[test]
    fn selection_context_is_invalidated_by_switch_back_clear_and_reselect() {
        let (backend, owner) = owner_with_profile();
        let first_a = owner.load_or_initialize().expect("initialize A");
        owner
            .select_profile(Some(profile("local-b")))
            .expect("select B");
        owner.load_or_initialize().expect("initialize B");
        owner
            .select_profile(Some(profile("local-a")))
            .expect("select A again");
        let a_bytes = backend.bytes(profile("local-a")).expect("A bytes");
        let read_count = backend.read_count();
        let access_count = backend.access_count();
        let publish_count = backend.publish_count();
        let draft = draft_json(&first_a.document, enable_tts_sharing);

        assert_eq!(
            owner.compare_and_swap(&first_a.context, 1, &draft),
            Err(NodeConfigOperationError::StaleSelectionContext)
        );
        assert_eq!(backend.read_count(), read_count);
        assert_eq!(backend.access_count(), access_count);
        assert_eq!(backend.publish_count(), publish_count);
        assert_eq!(backend.bytes(profile("local-a")), Some(a_bytes.clone()));

        let current_a = owner.load_or_initialize().expect("fresh A receipt");
        let fresh_a_bytes = backend.bytes(profile("local-a")).expect("fresh A bytes");
        owner.select_profile(None).expect("clear selection");
        let read_count = backend.read_count();
        let access_count = backend.access_count();
        assert_eq!(
            owner.compare_and_swap(&current_a.context, 1, &draft),
            Err(NodeConfigOperationError::StaleSelectionContext)
        );
        assert_eq!(backend.read_count(), read_count);
        assert_eq!(backend.access_count(), access_count);
        assert_eq!(backend.publish_count(), publish_count);
        assert_eq!(
            backend.bytes(profile("local-a")),
            Some(fresh_a_bytes.clone())
        );

        owner
            .select_profile(Some(profile("local-a")))
            .expect("reselect A");
        let read_count = backend.read_count();
        let access_count = backend.access_count();
        assert_eq!(
            owner.compare_and_swap(&current_a.context, 1, &draft),
            Err(NodeConfigOperationError::StaleSelectionContext)
        );
        assert_eq!(backend.read_count(), read_count);
        assert_eq!(backend.access_count(), access_count);
        assert_eq!(backend.publish_count(), publish_count);
        assert_eq!(backend.bytes(profile("local-a")), Some(fresh_a_bytes));
    }

    #[test]
    fn selection_context_is_bound_to_its_owner_and_same_selection_refresh_keeps_it() {
        let (backend, owner) = owner_with_profile();
        let read = owner.load_or_initialize().expect("initialize");
        let (other_backend, other_owner) = owner_with_profile();
        let other_read = other_owner.load_or_initialize().expect("other initialize");
        assert_eq!(read.context.profile, other_read.context.profile);
        assert_eq!(read.context.generation, other_read.context.generation);

        let original_owner_bytes = backend.bytes(profile("local-a")).expect("owner bytes");
        let original_other_bytes = other_backend
            .bytes(profile("local-a"))
            .expect("other bytes");
        let other_reads = other_backend.read_count();
        let other_accesses = other_backend.access_count();
        let other_creates = other_backend.create_count();
        let draft = draft_json(&read.document, enable_tts_sharing);
        assert_eq!(
            other_owner.compare_and_swap(&read.context, 1, &draft),
            Err(NodeConfigOperationError::StaleSelectionContext)
        );
        assert_eq!(other_backend.read_count(), other_reads);
        assert_eq!(other_backend.access_count(), other_accesses);
        assert_eq!(other_backend.create_count(), other_creates);
        assert_eq!(other_backend.publish_count(), 0);
        assert_eq!(
            other_backend.bytes(profile("local-a")),
            Some(original_other_bytes)
        );
        assert_eq!(
            backend.bytes(profile("local-a")),
            Some(original_owner_bytes)
        );

        owner
            .select_profile(Some(profile("local-a")))
            .expect("same-selection refresh");
        let updated = owner
            .compare_and_swap(&read.context, 1, &draft)
            .expect("same selection preserves context");
        assert_eq!(updated.document.revision, 2);
        assert_eq!(backend.publish_count(), 1);
    }

    #[test]
    fn selection_generation_exhaustion_does_not_change_selection_or_generation() {
        let (backend, owner) = owner_with_profile();
        owner.load_or_initialize().expect("initialize");
        {
            let mut state = owner.state.lock().expect("owner state");
            state.selection_generation = u64::MAX;
        }
        let read = owner
            .load_or_initialize()
            .expect("issue max-generation context");
        let original_bytes = backend.bytes(profile("local-a")).expect("stored bytes");
        let read_count = backend.read_count();
        let access_count = backend.access_count();
        let publish_count = backend.publish_count();

        assert_eq!(
            owner.select_profile(Some(profile("local-b"))),
            Err(NodeConfigOperationError::SelectionGenerationExhausted)
        );
        {
            let state = owner.state.lock().expect("owner state");
            assert_eq!(state.selected_profile, Some(profile("local-a")));
            assert_eq!(state.selection_generation, u64::MAX);
        }
        assert_eq!(backend.read_count(), read_count);
        assert_eq!(backend.access_count(), access_count);
        assert_eq!(backend.publish_count(), publish_count);
        assert_eq!(backend.bytes(profile("local-a")), Some(original_bytes));

        let draft = draft_json(&read.document, enable_tts_sharing);
        assert_eq!(
            owner
                .compare_and_swap(&read.context, 1, &draft)
                .expect("unchanged max generation remains usable")
                .document
                .revision,
            2
        );
    }
}
