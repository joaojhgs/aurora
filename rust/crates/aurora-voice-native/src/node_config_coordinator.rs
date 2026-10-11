//! Portable async coordinator for trusted runtime-profile selection and local
//! node-policy operations.
//!
//! This module provides portable coordinator logic for eventual native
//! integration. It does not provide public IPC or platform wiring, an IPC
//! handle, profile selector, or policy-owner getter.

use crate::native_publication_fence::{NativePublicationFence, NativePublicationTicket};
use crate::node_config::{
    NodeConfigOperationError, NodeConfigOperationOwner, NodeConfigPersistence,
    NodeConfigProfileNamespace, NodeConfigReadReceipt, NodeConfigReconciliation,
    NodeConfigSelectionContext, NodeConfigWriteReceipt,
};
use crate::node_config_profile::{resolve_selected_local_mesh_node, RuntimeProfileSelectionError};
use crate::runtime_profile::{
    validate_canonical_runtime_profile_document, RuntimeProfileValidationError,
    RuntimeProfileValidationOptions, ValidatedRuntimeProfileDocument,
};
use async_trait::async_trait;
use std::future::Future;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

/// Error returned when a profile adapter cannot read/install/release state.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("native profile state is unavailable")]
pub struct NativeProfileAdapterError;

/// A persistence error must classify whether the candidate may have published.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProfilePublicationFailure {
    /// The adapter guarantees persisted profile bytes did not change.
    DefinitelyNotPublished,
    /// The adapter cannot confirm whether persisted profile bytes changed.
    Indeterminate,
}

/// Native profile/session boundary consumed privately by the coordinator.
///
/// `read_confirmed_profile` must return the complete persisted document only
/// after its source confirms the current record. `persist_profile` returning
/// `Ok(())` means the exact candidate is confirmed durable. These are adapter
/// contracts, not guarantees about any platform storage API. Every callback
/// runs while the coordinator's outer gate is held. Implementations must not
/// re-enter the coordinator or join work that needs that gate.
#[async_trait]
pub trait NativeProfileAdapter: Send + Sync + 'static {
    /// Read the complete current persisted profile document, or confirmed
    /// absence. This must not infer profile selection from caller IDs.
    async fn read_confirmed_profile(&self) -> Result<Option<String>, NativeProfileAdapterError>;

    /// Persist a complete profile document. Success means confirmed durable
    /// publication; failures distinguish definite nonpublication from doubt.
    async fn persist_profile(&self, candidate: &str)
        -> Result<(), NativeProfilePublicationFailure>;

    /// Cancel/release sessions belonging to the previously installed profile.
    /// This callback must not re-enter the coordinator gate or join work that
    /// requires it.
    async fn release_previous_sessions(&self) -> Result<(), NativeProfileAdapterError>;

    /// Install/publish the confirmed profile state, or clear it on absence.
    /// This callback must not re-enter the coordinator gate or join work that
    /// requires it.
    async fn install_confirmed_profile(
        &self,
        document: Option<&str>,
    ) -> Result<(), NativeProfileAdapterError>;
}

/// Fixed, content-free coordinator failures.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum NodeConfigCoordinatorError {
    #[error("node configuration coordinator is unavailable")]
    Unavailable,
    #[error("persisted profile state could not be read")]
    ProfileReadFailed,
    #[error("profile replacement was not published")]
    ProfileNotPublished,
    #[error("profile publication is indeterminate")]
    ProfilePublicationIndeterminate,
    #[error("prior profile sessions could not be released")]
    SessionReleaseFailed,
    #[error("confirmed profile could not be installed")]
    ProfileInstallFailed,
    #[error("coordinator task failed")]
    TaskFailed,
    #[error(transparent)]
    InvalidCanonicalProfile(#[from] RuntimeProfileValidationError),
    #[error(transparent)]
    InvalidProfile(#[from] RuntimeProfileSelectionError),
    #[error(transparent)]
    Policy(#[from] NodeConfigOperationError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Availability {
    /// Initial state and every profile transition/fatal task failure.
    Unavailable,
    /// The current profile state is confirmed and installed.
    Ready,
    /// The policy owner quarantined a possibly published policy generation.
    PolicyReconciliationRequired,
}

#[derive(Clone, Debug)]
struct ConfirmedProfile {
    document: Option<ValidatedRuntimeProfileDocument>,
    namespace: Option<NodeConfigProfileNamespace>,
}

impl ConfirmedProfile {
    fn document_json(&self) -> Option<&str> {
        self.document
            .as_ref()
            .map(ValidatedRuntimeProfileDocument::as_json)
    }
}

struct CoordinatorState {
    availability: Availability,
    /// `Some` also represents confirmed absence of a profile document.
    confirmed: Option<ConfirmedProfile>,
    /// Exact bytes read from persistence when they cannot be installed as a
    /// canonical profile. This only authorizes an explicit validated replace
    /// after the adapter confirms these same bytes again.
    recovery_document: Option<String>,
}

impl Default for CoordinatorState {
    fn default() -> Self {
        Self {
            availability: Availability::Unavailable,
            confirmed: None,
            recovery_document: None,
        }
    }
}

struct CoordinatorInner<A, P> {
    /// Outermost transition gate. It remains held across adapter awaits and
    /// blocking policy-owner calls so no operation can cross a transition.
    gate: Mutex<CoordinatorState>,
    /// Private owner: there is deliberately no getter or direct alternate path.
    policy_owner: Arc<NodeConfigOperationOwner<P>>,
    profile_adapter: A,
    profile_validation_options: RuntimeProfileValidationOptions,
    #[cfg(test)]
    authorized_cas_waiting_for_gate: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

/// One in-process coordinator for trusted profile selection and policy storage.
pub struct NodeConfigCoordinator<A, P> {
    inner: Arc<CoordinatorInner<A, P>>,
}

impl<A, P> Clone for NodeConfigCoordinator<A, P> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<A, P> NodeConfigCoordinator<A, P>
where
    A: NativeProfileAdapter,
    P: NodeConfigPersistence,
{
    /// Construct an unavailable coordinator with a privately consumed policy
    /// persistence backend and a trusted native profile adapter.
    pub fn new(persistence: P, profile_adapter: A) -> Self {
        Self::new_with_profile_validation_options(
            persistence,
            profile_adapter,
            RuntimeProfileValidationOptions::default(),
        )
    }

    /// Construct with package capabilities supplied by trusted native bootstrap.
    ///
    /// The options are retained immutably and must not come from a renderer,
    /// profile document, or environment-selected role.
    pub fn new_with_profile_validation_options(
        persistence: P,
        profile_adapter: A,
        profile_validation_options: RuntimeProfileValidationOptions,
    ) -> Self {
        Self {
            inner: Arc::new(CoordinatorInner {
                gate: Mutex::new(CoordinatorState::default()),
                policy_owner: Arc::new(NodeConfigOperationOwner::new(persistence)),
                profile_adapter,
                profile_validation_options,
                #[cfg(test)]
                authorized_cas_waiting_for_gate: std::sync::Mutex::new(None),
            }),
        }
    }

    /// Close policy access, then refresh from a fully validated confirmed
    /// profile read. Reopen access only after prior sessions are released and
    /// the confirmed profile is installed. Missing/null/remote selections have
    /// no local namespace; invalid or legacy documents leave access closed.
    pub async fn refresh_confirmed_profile(&self) -> Result<(), NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move { inner.refresh_confirmed_profile().await }).await
    }

    /// Persist and install a complete replacement profile document.
    ///
    /// The complete candidate is canonically validated before changing
    /// availability or selection and before adapter or policy side effects.
    /// Caller cancellation does not abandon the owned transition after
    /// acceptance.
    pub async fn replace_profile(
        &self,
        candidate: String,
    ) -> Result<(), NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move { inner.replace_profile(candidate).await }).await
    }

    /// Read the currently selected policy document and retain its original
    /// owner-issued context for any later compare-and-swap.
    pub async fn read_policy(&self) -> Result<NodeConfigReadReceipt, NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move { inner.read_policy().await }).await
    }

    /// Read or initialize policy through a native publication ticket. The
    /// ticket is issued before queuing; the owner reserves it only after the
    /// coordinator gate and blocking queue have been reached.
    pub async fn read_policy_authorized(
        &self,
        fence: NativePublicationFence,
        ticket: NativePublicationTicket,
    ) -> Result<NodeConfigReadReceipt, NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move { inner.read_policy_authorized(fence, ticket).await }).await
    }

    /// Compare-and-swap using the exact read-issued context supplied by the
    /// caller. The context is moved unchanged into the owned task and is never
    /// replaced by a fresh selection context.
    pub async fn compare_and_swap(
        &self,
        context: NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: String,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move {
            inner
                .compare_and_swap(context, expected_revision, draft_json)
                .await
        })
        .await
    }

    /// Compare-and-swap through a native publication ticket. The ticket and
    /// original read context are moved unchanged through the owned task and
    /// blocking queue; reservation occurs under the policy owner lock.
    pub async fn compare_and_swap_authorized(
        &self,
        fence: NativePublicationFence,
        ticket: NativePublicationTicket,
        context: NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: String,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move {
            inner
                .compare_and_swap_authorized(fence, ticket, context, expected_revision, draft_json)
                .await
        })
        .await
    }

    /// Reconcile a quarantined policy generation through the owner's explicit
    /// durability-confirmation operation.
    pub async fn reconcile_policy(
        &self,
    ) -> Result<NodeConfigReconciliation, NodeConfigCoordinatorError> {
        let inner = Arc::clone(&self.inner);
        run_owned(async move { inner.reconcile_policy().await }).await
    }
}

async fn run_owned<T, F>(operation: F) -> Result<T, NodeConfigCoordinatorError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, NodeConfigCoordinatorError>> + Send + 'static,
{
    tokio::spawn(operation)
        .await
        .map_err(|_| NodeConfigCoordinatorError::TaskFailed)?
}

impl<A, P> CoordinatorInner<A, P>
where
    A: NativeProfileAdapter,
    P: NodeConfigPersistence,
{
    async fn refresh_confirmed_profile(&self) -> Result<(), NodeConfigCoordinatorError> {
        let mut state = self.gate.lock().await;
        state.availability = Availability::Unavailable;
        state.confirmed = None;
        state.recovery_document = None;
        self.select_policy_namespace(None).await?;

        let document = self
            .profile_adapter
            .read_confirmed_profile()
            .await
            .map_err(|_| NodeConfigCoordinatorError::ProfileReadFailed)?;
        let confirmed =
            match resolve_confirmed_profile(document.clone(), self.profile_validation_options) {
                Ok(confirmed) => confirmed,
                Err(error) => {
                    if document.is_some()
                        && matches!(
                            &error,
                            NodeConfigCoordinatorError::InvalidCanonicalProfile(_)
                                | NodeConfigCoordinatorError::InvalidProfile(_)
                        )
                    {
                        state.recovery_document = document;
                    }
                    return Err(error);
                }
            };

        self.profile_adapter
            .release_previous_sessions()
            .await
            .map_err(|_| NodeConfigCoordinatorError::SessionReleaseFailed)?;
        self.profile_adapter
            .install_confirmed_profile(confirmed.document_json())
            .await
            .map_err(|_| NodeConfigCoordinatorError::ProfileInstallFailed)?;
        self.select_policy_namespace(confirmed.namespace).await?;

        let requires_reconciliation = self.selected_policy_requires_reconciliation().await?;
        state.confirmed = Some(confirmed);
        state.availability = if requires_reconciliation {
            Availability::PolicyReconciliationRequired
        } else {
            Availability::Ready
        };
        Ok(())
    }

    async fn replace_profile(&self, candidate: String) -> Result<(), NodeConfigCoordinatorError> {
        let mut state = self.gate.lock().await;
        let replacement =
            resolve_confirmed_profile(Some(candidate), self.profile_validation_options)?;

        let previous = if state.availability == Availability::Ready {
            Some(
                state
                    .confirmed
                    .clone()
                    .ok_or(NodeConfigCoordinatorError::Unavailable)?,
            )
        } else if let Some(expected_invalid_document) = state.recovery_document.clone() {
            let confirmed_bytes = self
                .profile_adapter
                .read_confirmed_profile()
                .await
                .map_err(|_| NodeConfigCoordinatorError::ProfileReadFailed)?;
            if confirmed_bytes.as_deref() != Some(expected_invalid_document.as_str()) {
                state.recovery_document = None;
                return Err(NodeConfigCoordinatorError::Unavailable);
            }
            None
        } else {
            return Err(NodeConfigCoordinatorError::Unavailable);
        };

        state.availability = Availability::Unavailable;
        self.select_policy_namespace(None).await?;

        match self
            .profile_adapter
            .persist_profile(
                replacement
                    .document_json()
                    .ok_or(NodeConfigCoordinatorError::Unavailable)?,
            )
            .await
        {
            Ok(()) => {}
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished) => {
                if let Some(previous) = previous {
                    self.select_policy_namespace(previous.namespace).await?;
                    state.availability = if self.selected_policy_requires_reconciliation().await? {
                        Availability::PolicyReconciliationRequired
                    } else {
                        Availability::Ready
                    };
                }
                return Err(NodeConfigCoordinatorError::ProfileNotPublished);
            }
            Err(NativeProfilePublicationFailure::Indeterminate) => {
                if previous.is_none() {
                    state.recovery_document = None;
                }
                return Err(NodeConfigCoordinatorError::ProfilePublicationIndeterminate);
            }
        }

        state.recovery_document = None;

        self.profile_adapter
            .release_previous_sessions()
            .await
            .map_err(|_| NodeConfigCoordinatorError::SessionReleaseFailed)?;
        self.profile_adapter
            .install_confirmed_profile(replacement.document_json())
            .await
            .map_err(|_| NodeConfigCoordinatorError::ProfileInstallFailed)?;
        self.select_policy_namespace(replacement.namespace).await?;

        let requires_reconciliation = self.selected_policy_requires_reconciliation().await?;
        state.confirmed = Some(replacement);
        state.availability = if requires_reconciliation {
            Availability::PolicyReconciliationRequired
        } else {
            Availability::Ready
        };
        Ok(())
    }

    async fn read_policy(&self) -> Result<NodeConfigReadReceipt, NodeConfigCoordinatorError> {
        let mut state = self.gate.lock().await;
        ensure_ready(&state)?;
        state.availability = Availability::Unavailable;

        let owner = Arc::clone(&self.policy_owner);
        match tokio::task::spawn_blocking(move || owner.load_or_initialize()).await {
            Ok(Ok(receipt)) => {
                state.availability = Availability::Ready;
                Ok(receipt)
            }
            Ok(Err(error)) => {
                state.availability = availability_after_policy_error(&error);
                Err(NodeConfigCoordinatorError::Policy(error))
            }
            Err(_) => Err(NodeConfigCoordinatorError::TaskFailed),
        }
    }

    async fn read_policy_authorized(
        &self,
        fence: NativePublicationFence,
        ticket: NativePublicationTicket,
    ) -> Result<NodeConfigReadReceipt, NodeConfigCoordinatorError> {
        let mut state = self.gate.lock().await;
        ensure_ready(&state)?;
        state.availability = Availability::Unavailable;

        let owner = Arc::clone(&self.policy_owner);
        match tokio::task::spawn_blocking(move || {
            owner.load_or_initialize_authorized(&fence, ticket)
        })
        .await
        {
            Ok(Ok(receipt)) => {
                state.availability = Availability::Ready;
                Ok(receipt)
            }
            Ok(Err(error)) => {
                state.availability = availability_after_policy_error(&error);
                Err(NodeConfigCoordinatorError::Policy(error))
            }
            Err(_) => Err(NodeConfigCoordinatorError::TaskFailed),
        }
    }

    async fn compare_and_swap(
        &self,
        context: NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: String,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigCoordinatorError> {
        let mut state = self.gate.lock().await;
        ensure_ready(&state)?;
        state.availability = Availability::Unavailable;

        let owner = Arc::clone(&self.policy_owner);
        match tokio::task::spawn_blocking(move || {
            owner.compare_and_swap(&context, expected_revision, &draft_json)
        })
        .await
        {
            Ok(Ok(receipt)) => {
                state.availability = Availability::Ready;
                Ok(receipt)
            }
            Ok(Err(error)) => {
                state.availability = availability_after_policy_error(&error);
                Err(NodeConfigCoordinatorError::Policy(error))
            }
            Err(_) => Err(NodeConfigCoordinatorError::TaskFailed),
        }
    }

    async fn compare_and_swap_authorized(
        &self,
        fence: NativePublicationFence,
        ticket: NativePublicationTicket,
        context: NodeConfigSelectionContext,
        expected_revision: u64,
        draft_json: String,
    ) -> Result<NodeConfigWriteReceipt, NodeConfigCoordinatorError> {
        #[cfg(test)]
        if let Ok(mut hook) = self.authorized_cas_waiting_for_gate.lock() {
            if let Some(entered) = hook.take() {
                let _ = entered.send(());
            }
        }
        let mut state = self.gate.lock().await;
        ensure_ready(&state)?;
        state.availability = Availability::Unavailable;

        let owner = Arc::clone(&self.policy_owner);
        match tokio::task::spawn_blocking(move || {
            owner.compare_and_swap_authorized(
                &fence,
                ticket,
                &context,
                expected_revision,
                &draft_json,
            )
        })
        .await
        {
            Ok(Ok(receipt)) => {
                state.availability = Availability::Ready;
                Ok(receipt)
            }
            Ok(Err(error)) => {
                state.availability = availability_after_policy_error(&error);
                Err(NodeConfigCoordinatorError::Policy(error))
            }
            Err(_) => Err(NodeConfigCoordinatorError::TaskFailed),
        }
    }

    async fn reconcile_policy(
        &self,
    ) -> Result<NodeConfigReconciliation, NodeConfigCoordinatorError> {
        let mut state = self.gate.lock().await;
        if state.availability != Availability::PolicyReconciliationRequired
            || state.confirmed.is_none()
        {
            return Err(NodeConfigCoordinatorError::Unavailable);
        }
        state.availability = Availability::Unavailable;

        let owner = Arc::clone(&self.policy_owner);
        match tokio::task::spawn_blocking(move || owner.reconcile_selected_profile()).await {
            Ok(Ok(reconciliation)) => {
                state.availability = Availability::Ready;
                Ok(reconciliation)
            }
            Ok(Err(error)) => {
                state.availability = if matches!(&error, NodeConfigOperationError::OwnerUnavailable)
                {
                    Availability::Unavailable
                } else {
                    Availability::PolicyReconciliationRequired
                };
                Err(NodeConfigCoordinatorError::Policy(error))
            }
            Err(_) => Err(NodeConfigCoordinatorError::TaskFailed),
        }
    }

    async fn select_policy_namespace(
        &self,
        namespace: Option<NodeConfigProfileNamespace>,
    ) -> Result<(), NodeConfigCoordinatorError> {
        let owner = Arc::clone(&self.policy_owner);
        tokio::task::spawn_blocking(move || owner.select_profile(namespace))
            .await
            .map_err(|_| NodeConfigCoordinatorError::TaskFailed)??;
        Ok(())
    }

    async fn selected_policy_requires_reconciliation(
        &self,
    ) -> Result<bool, NodeConfigCoordinatorError> {
        let owner = Arc::clone(&self.policy_owner);
        tokio::task::spawn_blocking(move || owner.selected_profile_requires_reconciliation())
            .await
            .map_err(|_| NodeConfigCoordinatorError::TaskFailed)?
            .map_err(NodeConfigCoordinatorError::Policy)
    }
}

fn ensure_ready(state: &CoordinatorState) -> Result<(), NodeConfigCoordinatorError> {
    if state.availability == Availability::Ready && state.confirmed.is_some() {
        Ok(())
    } else {
        Err(NodeConfigCoordinatorError::Unavailable)
    }
}

fn availability_after_policy_error(error: &NodeConfigOperationError) -> Availability {
    match error {
        NodeConfigOperationError::IndeterminatePublication
        | NodeConfigOperationError::ReconciliationRequired
        | NodeConfigOperationError::ReconciliationIncomplete
        | NodeConfigOperationError::UnexpectedGeneration => {
            Availability::PolicyReconciliationRequired
        }
        NodeConfigOperationError::OwnerUnavailable => Availability::Unavailable,
        _ => Availability::Ready,
    }
}

fn resolve_confirmed_profile(
    document: Option<String>,
    options: RuntimeProfileValidationOptions,
) -> Result<ConfirmedProfile, NodeConfigCoordinatorError> {
    let document = document
        .map(|text| validate_canonical_runtime_profile_document(&text, options))
        .transpose()?;
    let selected = resolve_selected_local_mesh_node(document.as_ref().map(|doc| doc.as_json()))?;
    let namespace = selected
        .map(|identity| {
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                &identity.profile_id,
                &identity.stable_peer_id,
            )
            .map_err(NodeConfigCoordinatorError::Policy)
        })
        .transpose()?;
    Ok(ConfirmedProfile {
        document,
        namespace,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        NativeProfileAdapter, NativeProfileAdapterError, NativeProfilePublicationFailure,
        NodeConfigCoordinator, NodeConfigCoordinatorError,
    };
    use crate::native_publication_fence::{NativePublicationFence, NativePublicationFenceError};
    use crate::node_config::{
        CreateIfAbsentResult, NodeConfigOperationError, NodeConfigPersistence,
        NodeConfigPersistenceError, NodeConfigProfileNamespace, NodeConfigPublishFailure,
        NodeConfigReconciliation,
    };
    use crate::node_config_drafts::{
        NativeNodeConfigCaller, NodeConfigDraftNonceError, NodeConfigDraftNonceIssuer,
        NodeConfigDraftRegistry, NodeConfigDraftRegistryError,
    };
    use crate::runtime_profile::{RuntimeProfileValidationError, RuntimeProfileValidationOptions};
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::{oneshot, Barrier};

    #[derive(Clone, Default)]
    struct TestNonceIssuer(Arc<AtomicU8>);

    impl NodeConfigDraftNonceIssuer for TestNonceIssuer {
        fn issue_nonce(&self) -> Result<[u8; 32], NodeConfigDraftNonceError> {
            let value = self.0.fetch_add(1, Ordering::Relaxed);
            Ok([value; 32])
        }
    }

    #[derive(Default)]
    struct MemoryState {
        records: BTreeMap<NodeConfigProfileNamespace, Vec<u8>>,
        calls: Vec<&'static str>,
        next_replace_failure: Option<NodeConfigPublishFailure>,
    }

    #[derive(Clone, Default)]
    struct MemoryPersistence {
        state: Arc<StdMutex<MemoryState>>,
    }

    impl MemoryPersistence {
        fn call_count(&self) -> usize {
            self.state
                .lock()
                .expect("memory persistence lock")
                .calls
                .len()
        }

        fn calls(&self) -> Vec<&'static str> {
            self.state
                .lock()
                .expect("memory persistence lock")
                .calls
                .clone()
        }

        fn record(&self, namespace: NodeConfigProfileNamespace) -> Option<Vec<u8>> {
            self.state
                .lock()
                .expect("memory persistence lock")
                .records
                .get(&namespace)
                .cloned()
        }

        fn fail_next_replace(&self, failure: NodeConfigPublishFailure) {
            self.state
                .lock()
                .expect("memory persistence lock")
                .next_replace_failure = Some(failure);
        }
    }

    impl NodeConfigPersistence for MemoryPersistence {
        fn read(
            &self,
            profile: NodeConfigProfileNamespace,
        ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
            let mut state = self.state.lock().expect("memory persistence lock");
            state.calls.push("read");
            Ok(state.records.get(&profile).cloned())
        }

        fn create_if_absent(
            &self,
            profile: NodeConfigProfileNamespace,
            candidate: &[u8],
        ) -> Result<CreateIfAbsentResult, NodeConfigPublishFailure> {
            let mut state = self.state.lock().expect("memory persistence lock");
            state.calls.push("create");
            if let Some(existing) = state.records.get(&profile) {
                return Ok(CreateIfAbsentResult::AlreadyExists(existing.clone()));
            }
            state.records.insert(profile, candidate.to_vec());
            Ok(CreateIfAbsentResult::Created)
        }

        fn replace_atomically(
            &self,
            profile: NodeConfigProfileNamespace,
            candidate: &[u8],
        ) -> Result<(), NodeConfigPublishFailure> {
            let mut state = self.state.lock().expect("memory persistence lock");
            state.calls.push("replace");
            if let Some(failure) = state.next_replace_failure.take() {
                if failure == NodeConfigPublishFailure::Indeterminate {
                    state.records.insert(profile, candidate.to_vec());
                }
                return Err(failure);
            }
            state.records.insert(profile, candidate.to_vec());
            Ok(())
        }

        fn confirm_durable_snapshot(
            &self,
            profile: NodeConfigProfileNamespace,
        ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
            let mut state = self.state.lock().expect("memory persistence lock");
            state.calls.push("confirm");
            Ok(state.records.get(&profile).cloned())
        }
    }

    #[derive(Clone)]
    struct TestGate {
        entered: Arc<Barrier>,
        release: Arc<Barrier>,
    }

    impl TestGate {
        fn new() -> Self {
            Self {
                entered: Arc::new(Barrier::new(2)),
                release: Arc::new(Barrier::new(2)),
            }
        }

        async fn pause(&self) {
            self.entered.wait().await;
            self.release.wait().await;
        }

        async fn wait_until_entered(&self) {
            self.entered.wait().await;
        }

        async fn release(&self) {
            self.release.wait().await;
        }
    }

    #[derive(Default)]
    struct ProfileAdapterState {
        stored: Option<String>,
        installed: Option<String>,
        events: Vec<&'static str>,
        next_write_failure: Option<NativeProfilePublicationFailure>,
        fail_release_once: bool,
        fail_install_once: bool,
        fail_read_once: bool,
        panic_release_once: bool,
        read_gate: Option<TestGate>,
        persist_gate: Option<TestGate>,
    }

    #[derive(Clone, Default)]
    struct FakeProfileAdapter {
        state: Arc<StdMutex<ProfileAdapterState>>,
    }

    impl FakeProfileAdapter {
        fn with_document(document: Option<String>) -> Self {
            let adapter = Self::default();
            adapter.state.lock().expect("profile adapter lock").stored = document;
            adapter
        }

        fn stored(&self) -> Option<String> {
            self.state
                .lock()
                .expect("profile adapter lock")
                .stored
                .clone()
        }

        fn installed(&self) -> Option<String> {
            self.state
                .lock()
                .expect("profile adapter lock")
                .installed
                .clone()
        }

        fn events(&self) -> Vec<&'static str> {
            self.state
                .lock()
                .expect("profile adapter lock")
                .events
                .clone()
        }

        fn fail_next_write(&self, failure: NativeProfilePublicationFailure) {
            self.state
                .lock()
                .expect("profile adapter lock")
                .next_write_failure = Some(failure);
        }

        fn fail_next_release(&self) {
            self.state
                .lock()
                .expect("profile adapter lock")
                .fail_release_once = true;
        }

        fn fail_next_install(&self) {
            self.state
                .lock()
                .expect("profile adapter lock")
                .fail_install_once = true;
        }

        fn fail_next_read(&self) {
            self.state
                .lock()
                .expect("profile adapter lock")
                .fail_read_once = true;
        }

        fn panic_next_release(&self) {
            self.state
                .lock()
                .expect("profile adapter lock")
                .panic_release_once = true;
        }

        fn gate_next_persist(&self, gate: TestGate) {
            self.state
                .lock()
                .expect("profile adapter lock")
                .persist_gate = Some(gate);
        }

        fn gate_next_read(&self, gate: TestGate) {
            self.state.lock().expect("profile adapter lock").read_gate = Some(gate);
        }
    }

    #[async_trait]
    impl NativeProfileAdapter for FakeProfileAdapter {
        async fn read_confirmed_profile(
            &self,
        ) -> Result<Option<String>, NativeProfileAdapterError> {
            let (stored, gate, fail) = {
                let mut state = self.state.lock().expect("profile adapter lock");
                state.events.push("read-confirmed");
                (
                    state.stored.clone(),
                    state.read_gate.take(),
                    std::mem::take(&mut state.fail_read_once),
                )
            };
            if let Some(gate) = gate {
                gate.pause().await;
            }
            if fail {
                Err(NativeProfileAdapterError)
            } else {
                Ok(stored)
            }
        }

        async fn persist_profile(
            &self,
            candidate: &str,
        ) -> Result<(), NativeProfilePublicationFailure> {
            let (failure, gate) = {
                let mut state = self.state.lock().expect("profile adapter lock");
                state.events.push("persist");
                (state.next_write_failure.take(), state.persist_gate.take())
            };
            if let Some(gate) = gate {
                gate.pause().await;
            }
            let mut state = self.state.lock().expect("profile adapter lock");
            match failure {
                Some(NativeProfilePublicationFailure::DefinitelyNotPublished) => {
                    Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
                }
                Some(NativeProfilePublicationFailure::Indeterminate) => {
                    state.stored = Some(candidate.to_owned());
                    Err(NativeProfilePublicationFailure::Indeterminate)
                }
                None => {
                    state.stored = Some(candidate.to_owned());
                    Ok(())
                }
            }
        }

        async fn release_previous_sessions(&self) -> Result<(), NativeProfileAdapterError> {
            let mut state = self.state.lock().expect("profile adapter lock");
            state.events.push("release");
            if state.panic_release_once {
                state.panic_release_once = false;
                drop(state);
                panic!("injected adapter panic");
            }
            if state.fail_release_once {
                state.fail_release_once = false;
                return Err(NativeProfileAdapterError);
            }
            Ok(())
        }

        async fn install_confirmed_profile(
            &self,
            document: Option<&str>,
        ) -> Result<(), NativeProfileAdapterError> {
            let mut state = self.state.lock().expect("profile adapter lock");
            state.events.push("install");
            if state.fail_install_once {
                state.fail_install_once = false;
                return Err(NativeProfileAdapterError);
            }
            state.installed = document.map(str::to_owned);
            Ok(())
        }
    }

    fn mesh_profile(profile_id: &str, stable_peer_id: &str) -> serde_json::Value {
        json!({
            "version": 2,
            "id": profile_id,
            "label": "This device",
            "nodeMode": "mesh-node",
            "runtimeTier": "lightweight-ts",
            "localNode": {
                "nodeName": "Local Aurora",
                "stablePeerId": stable_peer_id,
                "enabledCapabilityPacks": [],
                "meshMembership": {
                    "signalingUrl": "wss://signal.example.test",
                    "webrtcProfile": {
                        "mode": "webrtc-only",
                        "appId": "aurora",
                        "room": "local-room",
                        "roomSecretRef": "ref:local-room",
                        "signalingBrokers": ["wss://signal.example.test"]
                    }
                }
            }
        })
    }

    fn profile_document(profile_id: &str, stable_peer_id: &str) -> String {
        json!({
            "version": 2,
            "activeProfileId": profile_id,
            "profiles": [mesh_profile(profile_id, stable_peer_id)]
        })
        .to_string()
    }

    fn remote_profile_document() -> String {
        json!({
            "version": 2,
            "activeProfileId": "console-a",
            "profiles": [{
                "version": 2,
                "id": "console-a",
                "label": "Home",
                "nodeMode": "remote-console",
                "runtimeTier": "none",
                "homeConnection": {
                    "mode": "http-only",
                    "gatewayUrl": "https://gateway.example.test"
                },
                "localNode": {
                    "nodeName": "Local Aurora",
                    "stablePeerId": "local-node",
                    "enabledCapabilityPacks": []
                }
            }]
        })
        .to_string()
    }

    fn coordinator(
        document: Option<String>,
    ) -> (
        NodeConfigCoordinator<FakeProfileAdapter, MemoryPersistence>,
        FakeProfileAdapter,
        MemoryPersistence,
    ) {
        let adapter = FakeProfileAdapter::with_document(document);
        let persistence = MemoryPersistence::default();
        let coordinator = NodeConfigCoordinator::new(persistence.clone(), adapter.clone());
        (coordinator, adapter, persistence)
    }

    fn coordinator_with_options(
        document: Option<String>,
        options: RuntimeProfileValidationOptions,
    ) -> (
        NodeConfigCoordinator<FakeProfileAdapter, MemoryPersistence>,
        FakeProfileAdapter,
        MemoryPersistence,
    ) {
        let adapter = FakeProfileAdapter::with_document(document);
        let persistence = MemoryPersistence::default();
        let coordinator = NodeConfigCoordinator::new_with_profile_validation_options(
            persistence.clone(),
            adapter.clone(),
            options,
        );
        (coordinator, adapter, persistence)
    }

    fn next_draft(document: &aurora_voice_core::node_policy::NodeConfigDocumentV2) -> String {
        let mut value = serde_json::to_value(document).expect("serialize current document");
        value["revision"] = json!(document.revision + 1);
        value.to_string()
    }

    #[tokio::test]
    async fn initial_unavailable_and_absent_null_remote_have_no_policy_namespace() {
        for document in [
            None,
            Some(json!({"version":2,"activeProfileId":null,"profiles":[]}).to_string()),
            Some(remote_profile_document()),
        ] {
            let (coordinator, adapter, persistence) = coordinator(document);
            assert_eq!(
                coordinator.read_policy().await,
                Err(NodeConfigCoordinatorError::Unavailable)
            );
            assert_eq!(
                coordinator
                    .replace_profile(profile_document("profile-a", "stable-a"))
                    .await,
                Err(NodeConfigCoordinatorError::Unavailable)
            );
            assert!(adapter.events().is_empty());
            assert_eq!(persistence.call_count(), 0);
            coordinator
                .refresh_confirmed_profile()
                .await
                .expect("confirmed refresh");
            assert!(matches!(
                coordinator.read_policy().await,
                Err(NodeConfigCoordinatorError::Policy(
                    NodeConfigOperationError::NoSelectedProfile
                ))
            ));
            assert_eq!(persistence.call_count(), 0);
            assert_eq!(adapter.events(), ["read-confirmed", "release", "install"]);
        }
    }

    #[tokio::test]
    async fn authorized_policy_read_initializes_only_under_a_live_ticket() {
        let (coordinator, _, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("profile ready");
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let receipt = coordinator
            .read_policy_authorized(fence.clone(), registration.issue_ticket().expect("ticket"))
            .await
            .expect("authorized policy read");

        assert_eq!(receipt.document.revision, 1);
        assert_eq!(persistence.calls(), ["read", "create"]);
        assert_eq!(
            fence
                .revoke(&registration)
                .expect("revoke settled read")
                .wait()
                .await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn refresh_and_replacement_release_before_install_and_open_policy_afterward() {
        let original = format!("\n {} \n", profile_document("profile-a", "stable-a"));
        let (coordinator, adapter, persistence) = coordinator(Some(original.clone()));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        assert_eq!(adapter.events(), ["read-confirmed", "release", "install"]);
        let read_a = coordinator.read_policy().await.expect("read A");
        assert_eq!(read_a.document.revision, 1);
        let namespace_a =
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-a",
                "stable-a",
            )
            .expect("A namespace");
        let a_bytes = persistence.record(namespace_a).expect("A policy bytes");

        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        let replacement = format!("\n {} \n", profile_document("profile-b", "stable-a"));
        coordinator
            .replace_profile(replacement.clone())
            .await
            .expect("replace profile");
        assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
        assert_eq!(adapter.installed().as_deref(), Some(replacement.as_str()));
        assert_eq!(adapter.events(), ["persist", "release", "install"]);
        assert_eq!(persistence.record(namespace_a), Some(a_bytes));

        let backend_calls = persistence.call_count();
        let stale = coordinator
            .compare_and_swap(read_a.context, 1, next_draft(&read_a.document))
            .await;
        assert_eq!(
            stale,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::StaleSelectionContext
            ))
        );
        assert_eq!(persistence.call_count(), backend_calls);
        let read_b = coordinator.read_policy().await.expect("read B");
        assert_eq!(read_b.document.revision, 1);
        let namespace_b =
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-b",
                "stable-a",
            )
            .expect("B namespace");
        let b_bytes = persistence.record(namespace_b).expect("B policy bytes");

        let replacement_same_profile = profile_document("profile-b", "stable-b");
        coordinator
            .replace_profile(replacement_same_profile)
            .await
            .expect("change stable node identity");
        let backend_calls = persistence.call_count();
        assert_eq!(persistence.record(namespace_b), Some(b_bytes.clone()));
        assert_eq!(
            coordinator
                .compare_and_swap(read_b.context, 1, next_draft(&read_b.document))
                .await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::StaleSelectionContext
            ))
        );
        assert_eq!(persistence.call_count(), backend_calls);
        assert_eq!(persistence.record(namespace_b), Some(b_bytes));
    }

    #[tokio::test]
    async fn invalid_replacements_have_no_side_effects_and_keep_original_context_usable() {
        let valid_original = profile_document("profile-a", "stable-a");
        let mut unknown_credential: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        unknown_credential["profiles"][0]["localNode"]["roomSecret"] = json!("sensitive");

        let mut endpoint_credential: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        endpoint_credential["profiles"][0]["homeConnection"] = json!({
            "mode": "http-only",
            "gatewayUrl": "https://user:password@gateway.example.test"
        });

        let mut secret_query: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        secret_query["profiles"][0]["localNode"]["meshMembership"]["webrtcProfile"]
            ["turnServers"] = json!(["turn:relay.example.test:3478?%74oken=secret"]);

        let mut inactive_invalid: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        inactive_invalid["profiles"]
            .as_array_mut()
            .expect("profiles array")
            .push(mesh_profile("inactive", "stable-inactive"));
        inactive_invalid["profiles"][1]["localNode"]["primaryLanguage"] = json!("auto");

        let mut role_tier_mismatch: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        role_tier_mismatch["profiles"][0]["runtimeTier"] = json!("none");

        let mut invalid_language: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        invalid_language["profiles"][0]["localNode"]["primaryLanguage"] = json!("auto");

        let mut invalid_speech_asset: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        invalid_speech_asset["profiles"][0]["localNode"]["localSpeechSelection"] = json!({
            "tts": {"packId": "speech/tts", "packRevision": "v1"}
        });

        let mut unsupported_python: serde_json::Value =
            serde_json::from_str(&valid_original).expect("valid profile fixture");
        unsupported_python["profiles"][0]["runtimeTier"] = json!("python-full");

        let duplicate_key =
            valid_original.replacen("\"version\":2", "\"version\":2,\"\\u0076ersion\":2", 1);
        assert_ne!(duplicate_key, valid_original);

        let invalid_candidates = [
            ("malformed JSON", "{private-profile-text".to_owned()),
            (
                "legacy v1 document",
                r#"{"version":1,"activeProfileId":null,"profiles":[]}"#.to_owned(),
            ),
            ("duplicate decoded key", duplicate_key),
            ("unknown credential field", unknown_credential.to_string()),
            ("endpoint credentials", endpoint_credential.to_string()),
            ("secret query key", secret_query.to_string()),
            ("invalid inactive profile", inactive_invalid.to_string()),
            ("role and tier mismatch", role_tier_mismatch.to_string()),
            ("invalid primary language", invalid_language.to_string()),
            ("invalid speech asset", invalid_speech_asset.to_string()),
            (
                "unsupported Python-full tier",
                unsupported_python.to_string(),
            ),
        ];

        for (label, candidate) in invalid_candidates {
            let original = valid_original.clone();
            let (coordinator, adapter, persistence) = coordinator(Some(original.clone()));
            coordinator
                .refresh_confirmed_profile()
                .await
                .expect("initial refresh");
            let read = coordinator
                .read_policy()
                .await
                .expect("read original scope");
            let namespace =
                NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                    "profile-a",
                    "stable-a",
                )
                .expect("original namespace");
            let original_policy = persistence
                .record(namespace)
                .expect("original policy bytes");
            let before_calls = persistence.calls();
            adapter
                .state
                .lock()
                .expect("profile adapter lock")
                .events
                .clear();

            let error = coordinator
                .replace_profile(candidate.clone())
                .await
                .expect_err("invalid candidate must be rejected");
            assert_eq!(
                error,
                NodeConfigCoordinatorError::InvalidCanonicalProfile(RuntimeProfileValidationError),
                "invalid candidate must be rejected: {label}"
            );
            assert_eq!(error.to_string(), "runtime profile document is invalid");
            assert!(!error.to_string().contains(candidate.as_str()));
            assert!(adapter.events().is_empty(), "adapter called for {label}");
            assert_eq!(
                adapter.stored(),
                Some(original.clone()),
                "stored bytes: {label}"
            );
            assert_eq!(
                adapter.installed(),
                Some(original),
                "installed bytes: {label}"
            );
            assert_eq!(persistence.calls(), before_calls, "policy IO: {label}");
            assert_eq!(persistence.record(namespace), Some(original_policy));

            let saved = coordinator
                .compare_and_swap(read.context, 1, next_draft(&read.document))
                .await
                .unwrap_or_else(|error| panic!("original context invalidated by {label}: {error}"));
            assert_eq!(saved.document.revision, 2, "context still usable: {label}");
        }
    }

    #[tokio::test]
    async fn invalid_confirmed_refresh_stays_closed_preserves_bytes_and_stales_context() {
        let original = format!(" \n{}\n ", profile_document("profile-a", "stable-a"));
        let mut duplicate: serde_json::Value =
            serde_json::from_str(&profile_document("profile-a", "stable-a"))
                .expect("valid profile fixture");
        duplicate["profiles"][0]["version"] = json!(2);
        let duplicate =
            duplicate
                .to_string()
                .replacen("\"version\":2", "\"version\":2,\"\\u0076ersion\":2", 1);
        assert_ne!(duplicate, profile_document("profile-a", "stable-a"));
        let mut credential: serde_json::Value =
            serde_json::from_str(&profile_document("profile-a", "stable-a"))
                .expect("valid profile fixture");
        credential["profiles"][0]["localNode"]["roomSecret"] = json!("must stay private");
        let mut invalid_inactive: serde_json::Value =
            serde_json::from_str(&profile_document("profile-a", "stable-a"))
                .expect("valid profile fixture");
        invalid_inactive["profiles"]
            .as_array_mut()
            .expect("profiles array")
            .push(mesh_profile("inactive", "stable-inactive"));
        invalid_inactive["profiles"][1]["localNode"]["primaryLanguage"] = json!("auto");
        let invalid_confirmed = [
            ("malformed JSON", "{invalid-profile-text".to_owned()),
            (
                "canonical v1 document",
                r#"{"version":1,"activeProfileId":null,"profiles":[]}"#.to_owned(),
            ),
            ("decoded duplicate keys", duplicate),
            ("credential-bearing document", credential.to_string()),
            ("invalid inactive profile", invalid_inactive.to_string()),
        ];

        for (label, invalid) in invalid_confirmed {
            let (coordinator, adapter, persistence) = coordinator(Some(original.clone()));
            coordinator
                .refresh_confirmed_profile()
                .await
                .expect("initial valid refresh");
            assert_eq!(adapter.installed(), Some(original.clone()));
            let read = coordinator
                .read_policy()
                .await
                .expect("read original scope");
            let namespace =
                NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                    "profile-a",
                    "stable-a",
                )
                .expect("namespace");
            let policy_before = persistence.record(namespace).expect("policy record");
            let calls_before = persistence.calls();

            adapter.state.lock().expect("profile adapter lock").stored = Some(invalid.clone());
            adapter
                .state
                .lock()
                .expect("profile adapter lock")
                .events
                .clear();
            assert_eq!(
                coordinator.refresh_confirmed_profile().await,
                Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                    RuntimeProfileValidationError
                )),
                "invalid confirmed profile: {label}"
            );
            assert_eq!(
                adapter.events(),
                ["read-confirmed"],
                "adapter calls: {label}"
            );
            assert_eq!(
                adapter.stored(),
                Some(invalid.clone()),
                "stored bytes: {label}"
            );
            assert_eq!(
                adapter.installed(),
                Some(original.clone()),
                "installed profile: {label}"
            );
            assert_eq!(persistence.calls(), calls_before, "policy IO: {label}");
            assert_eq!(persistence.record(namespace), Some(policy_before));
            assert_eq!(
                coordinator.read_policy().await,
                Err(NodeConfigCoordinatorError::Unavailable),
                "invalid profile must close access: {label}"
            );
            assert_eq!(
                coordinator.reconcile_policy().await,
                Err(NodeConfigCoordinatorError::Unavailable),
                "invalid profile must not trigger reconciliation: {label}"
            );

            let unavailable_calls = persistence.calls();
            assert_eq!(
                coordinator
                    .compare_and_swap(read.context.clone(), 1, next_draft(&read.document))
                    .await,
                Err(NodeConfigCoordinatorError::Unavailable),
                "closed coordinator accepted old context: {label}"
            );
            assert_eq!(persistence.calls(), unavailable_calls);

            adapter.state.lock().expect("profile adapter lock").stored = Some(original.clone());
            adapter
                .state
                .lock()
                .expect("profile adapter lock")
                .events
                .clear();
            coordinator
                .refresh_confirmed_profile()
                .await
                .expect("valid persisted profile recovers coordinator");
            assert_eq!(adapter.events(), ["read-confirmed", "release", "install"]);
            let recovered_calls = persistence.calls();
            assert_eq!(
                coordinator
                    .compare_and_swap(read.context, 1, next_draft(&read.document))
                    .await,
                Err(NodeConfigCoordinatorError::Policy(
                    NodeConfigOperationError::StaleSelectionContext
                )),
                "invalid profile did not stale original context: {label}"
            );
            assert_eq!(persistence.calls(), recovered_calls);
        }
    }

    #[tokio::test]
    async fn invalid_initial_legacy_profile_is_never_adopted_or_rewritten() {
        let legacy =
            r#"{"version":1,"activeProfileId":"legacy","profiles":[{"id":"legacy"}]}"#.to_owned();
        let (coordinator, adapter, persistence) = coordinator(Some(legacy.clone()));
        assert_eq!(
            coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                RuntimeProfileValidationError
            ))
        );
        assert_eq!(adapter.events(), ["read-confirmed"]);
        assert_eq!(adapter.stored(), Some(legacy));
        assert_eq!(adapter.installed(), None);
        assert!(persistence.calls().is_empty());
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert!(persistence.calls().is_empty());
    }

    #[tokio::test]
    async fn invalid_confirmed_legacy_profile_allows_only_explicit_validated_replacement() {
        let legacy =
            r#"{"version":1,"activeProfileId":"legacy","profiles":[{"id":"legacy"}]}"#.to_owned();
        let (coordinator, adapter, persistence) = coordinator(Some(legacy.clone()));
        assert_eq!(
            coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                RuntimeProfileValidationError
            ))
        );
        assert_eq!(adapter.stored(), Some(legacy.clone()));
        assert_eq!(adapter.installed(), None);
        assert!(persistence.calls().is_empty());
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );

        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        assert_eq!(
            coordinator.replace_profile("not-json".to_owned()).await,
            Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                RuntimeProfileValidationError
            ))
        );
        assert!(adapter.events().is_empty());
        assert_eq!(adapter.stored(), Some(legacy.clone()));

        let replacement = profile_document("profile-b", "stable-b");
        adapter.fail_next_write(NativeProfilePublicationFailure::DefinitelyNotPublished);
        assert_eq!(
            coordinator.replace_profile(replacement.clone()).await,
            Err(NodeConfigCoordinatorError::ProfileNotPublished)
        );
        assert_eq!(adapter.events(), ["read-confirmed", "persist"]);
        assert_eq!(adapter.stored(), Some(legacy.clone()));
        assert_eq!(adapter.installed(), None);
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert!(persistence.calls().is_empty());

        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        coordinator
            .replace_profile(replacement.clone())
            .await
            .expect("replace the exact confirmed legacy bytes");
        assert_eq!(
            adapter.events(),
            ["read-confirmed", "persist", "release", "install"]
        );
        assert_eq!(adapter.stored(), Some(replacement.clone()));
        assert_eq!(adapter.installed(), Some(replacement));
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("policy opens after validated install")
                .document
                .revision,
            1
        );
    }

    #[tokio::test]
    async fn invalid_refresh_cannot_clear_quarantine_or_probe_policy_storage() {
        let original = profile_document("profile-a", "stable-a");
        let (coordinator, adapter, persistence) = coordinator(Some(original.clone()));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial valid refresh");
        let read = coordinator.read_policy().await.expect("initialize policy");
        persistence.fail_next_replace(NodeConfigPublishFailure::Indeterminate);
        assert!(matches!(
            coordinator
                .compare_and_swap(read.context, 1, next_draft(&read.document))
                .await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::IndeterminatePublication
            ))
        ));
        let quarantined_calls = persistence.calls();

        let invalid = r#"{"version":2,"version":2,"activeProfileId":null,"profiles":[]}"#;
        adapter.state.lock().expect("profile adapter lock").stored = Some(invalid.to_owned());
        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        assert_eq!(
            coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                RuntimeProfileValidationError
            ))
        );
        assert_eq!(adapter.events(), ["read-confirmed"]);
        assert_eq!(adapter.stored().as_deref(), Some(invalid));
        assert_eq!(persistence.calls(), quarantined_calls);
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(persistence.calls(), quarantined_calls);

        adapter.state.lock().expect("profile adapter lock").stored = Some(original);
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("valid profile refresh preserves quarantine");
        assert_eq!(persistence.calls(), quarantined_calls);
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(persistence.calls(), quarantined_calls);
        assert!(matches!(
            coordinator.reconcile_policy().await,
            Ok(NodeConfigReconciliation::Initialized(ref document)) if document.revision == 2
        ));
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "confirm"]
        );
    }

    #[tokio::test]
    async fn trusted_python_full_option_is_immutable_and_applies_to_inactive_profiles() {
        let mut python_document: serde_json::Value =
            serde_json::from_str(&profile_document("profile-a", "stable-a"))
                .expect("valid profile fixture");
        python_document["profiles"][0]["runtimeTier"] = json!("python-full");
        let python_text = python_document.to_string();

        let (default_coordinator, default_adapter, default_persistence) =
            coordinator(Some(python_text.clone()));
        assert_eq!(
            default_coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                RuntimeProfileValidationError
            ))
        );
        assert_eq!(default_adapter.events(), ["read-confirmed"]);
        assert_eq!(default_adapter.stored(), Some(python_text.clone()));
        assert_eq!(default_adapter.installed(), None);
        assert!(default_persistence.calls().is_empty());

        let options = RuntimeProfileValidationOptions {
            allow_python_full: true,
        };
        let (trusted, trusted_adapter, trusted_persistence) =
            coordinator_with_options(Some(python_text.clone()), options);
        trusted
            .refresh_confirmed_profile()
            .await
            .expect("trusted package may select Python-full");
        assert_eq!(trusted_adapter.installed(), Some(python_text));
        assert_eq!(
            trusted_adapter.events(),
            ["read-confirmed", "release", "install"]
        );
        let mut malformed_python: serde_json::Value =
            serde_json::from_str(&python_document.to_string()).expect("Python profile fixture");
        malformed_python["profiles"][0]["localNode"]["roomSecret"] = json!("must stay private");
        let malformed_python = malformed_python.to_string();
        let policy_calls = trusted_persistence.calls();
        trusted_adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        let error = trusted
            .replace_profile(malformed_python.clone())
            .await
            .expect_err("trusted package options do not bypass canonical validation");
        assert_eq!(
            error,
            NodeConfigCoordinatorError::InvalidCanonicalProfile(RuntimeProfileValidationError)
        );
        assert!(!error.to_string().contains(malformed_python.as_str()));
        assert!(trusted_adapter.events().is_empty());
        assert_eq!(trusted_adapter.stored(), Some(python_document.to_string()));
        assert_eq!(
            trusted_adapter.installed(),
            Some(python_document.to_string())
        );
        assert_eq!(trusted_persistence.calls(), policy_calls);
        assert!(policy_calls.is_empty());

        let mut inactive_python: serde_json::Value =
            serde_json::from_str(&profile_document("profile-a", "stable-a"))
                .expect("valid profile fixture");
        inactive_python["profiles"]
            .as_array_mut()
            .expect("profiles array")
            .push({
                let mut inactive = mesh_profile("inactive", "stable-inactive");
                inactive["runtimeTier"] = json!("python-full");
                inactive
            });
        let inactive_text = inactive_python.to_string();
        let (default_coordinator, default_adapter, default_persistence) =
            coordinator(Some(inactive_text.clone()));
        assert_eq!(
            default_coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::InvalidCanonicalProfile(
                RuntimeProfileValidationError
            ))
        );
        assert_eq!(default_adapter.events(), ["read-confirmed"]);
        assert_eq!(default_adapter.stored(), Some(inactive_text.clone()));
        assert_eq!(default_adapter.installed(), None);
        assert!(default_persistence.calls().is_empty());

        let (trusted, trusted_adapter, trusted_persistence) =
            coordinator_with_options(Some(inactive_text.clone()), options);
        trusted
            .refresh_confirmed_profile()
            .await
            .expect("trusted option applies to every profile");
        assert_eq!(trusted_adapter.installed(), Some(inactive_text));
        assert!(trusted_persistence.calls().is_empty());
    }

    #[tokio::test]
    async fn canceled_profile_caller_does_not_abandon_transition_or_let_policy_read_overtake() {
        let original = profile_document("profile-a", "stable-a");
        let (coordinator, adapter, persistence) = coordinator(Some(original));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        let gate = TestGate::new();
        adapter.gate_next_persist(gate.clone());
        let replacement = profile_document("profile-b", "stable-b");
        let transition = {
            let coordinator = coordinator.clone();
            let replacement = replacement.clone();
            tokio::spawn(async move { coordinator.replace_profile(replacement).await })
        };
        gate.wait_until_entered().await;
        transition.abort();

        let read_after_transition = {
            let coordinator = coordinator.clone();
            let (queued_sender, queued_receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _ = queued_sender.send(());
                coordinator.read_policy().await
            });
            queued_receiver.await.expect("read task queued");
            tokio::task::yield_now().await;
            assert!(!task.is_finished());
            task
        };
        assert_eq!(
            adapter.stored(),
            Some(profile_document("profile-a", "stable-a"))
        );
        assert_eq!(persistence.call_count(), 0);
        gate.release().await;
        let read = read_after_transition
            .await
            .expect("queued policy task")
            .expect("read after owned transition");
        assert_eq!(read.document.revision, 1);
        assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
        assert_eq!(
            adapter.events(),
            [
                "read-confirmed",
                "release",
                "install",
                "persist",
                "release",
                "install"
            ]
        );
    }

    #[tokio::test]
    async fn consumed_draft_queued_cas_loses_to_revocation_before_policy_publication() {
        let (coordinator, _, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("profile ready");
        let receipt = coordinator.read_policy().await.expect("policy read");
        let registry =
            NodeConfigDraftRegistry::new(TestNonceIssuer::default()).expect("draft registry");
        let caller = NativeNodeConfigCaller::from_native_lifecycle_nonce([0x31; 16]);
        let issued = registry.issue_read(caller, receipt).expect("draft handle");
        let context = registry
            .take_context(caller, &issued.handle, issued.document.revision)
            .expect("consume actual read handle");
        assert_eq!(
            registry.take_context(caller, &issued.handle, issued.document.revision),
            Err(NodeConfigDraftRegistryError::Unavailable),
            "draft handles remain single use"
        );

        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("native registration");
        let ticket = registration.issue_ticket().expect("ticket before queue");
        let draft = next_draft(&issued.document);
        let previous_calls = persistence.calls();
        let held_gate = coordinator.inner.gate.lock().await;
        let (gate_waiting_tx, gate_waiting_rx) = tokio::sync::oneshot::channel();
        *coordinator
            .inner
            .authorized_cas_waiting_for_gate
            .lock()
            .expect("gate-wait hook lock") = Some(gate_waiting_tx);
        let coordinator_for_call = coordinator.clone();
        let fence_for_call = fence.clone();
        let queued_call = tokio::spawn(async move {
            coordinator_for_call
                .compare_and_swap_authorized(fence_for_call, ticket, context, 1, draft)
                .await
        });
        gate_waiting_rx
            .await
            .expect("authorized CAS reached coordinator gate");
        let revocation = fence.revoke(&registration).expect("revoke queued ticket");
        assert_eq!(revocation.wait().await, Ok(()));
        drop(held_gate);

        assert_eq!(
            queued_call.await.expect("owned CAS task"),
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::PublicationFence(
                    NativePublicationFenceError::TicketUnavailable
                )
            ))
        );
        assert_eq!(persistence.calls(), previous_calls);
    }

    #[tokio::test]
    async fn refresh_and_replacement_are_serialized_and_refresh_failure_stays_closed() {
        let original = profile_document("profile-a", "stable-a");
        let (coordinator, adapter, persistence) = coordinator(Some(original));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();

        let gate = TestGate::new();
        adapter.gate_next_read(gate.clone());
        let refresh = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move { coordinator.refresh_confirmed_profile().await })
        };
        gate.wait_until_entered().await;
        let replacement = {
            let coordinator = coordinator.clone();
            let (queued_sender, queued_receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _ = queued_sender.send(());
                coordinator
                    .replace_profile(profile_document("profile-b", "stable-b"))
                    .await
            });
            queued_receiver.await.expect("replacement task queued");
            tokio::task::yield_now().await;
            assert!(!task.is_finished());
            assert_eq!(adapter.events(), ["read-confirmed"]);
            task
        };
        gate.release().await;
        refresh
            .await
            .expect("refresh task")
            .expect("confirmed refresh");
        replacement
            .await
            .expect("replacement task")
            .expect("serialized replacement");
        assert_eq!(
            adapter.events(),
            [
                "read-confirmed",
                "release",
                "install",
                "persist",
                "release",
                "install"
            ]
        );
        let expected_profile_b = profile_document("profile-b", "stable-b");
        assert_eq!(
            adapter.stored().as_deref(),
            Some(expected_profile_b.as_str())
        );
        assert_eq!(persistence.call_count(), 0);
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("read B")
                .document
                .revision,
            1
        );

        adapter.fail_next_read();
        assert_eq!(
            coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::ProfileReadFailed)
        );
        let backend_calls = persistence.call_count();
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(persistence.call_count(), backend_calls);
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("confirmed recovery after read failure");
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("recovered policy")
                .document
                .revision,
            1
        );
    }

    #[tokio::test]
    async fn definite_profile_nonpublication_restores_scope_but_invalidates_old_context() {
        let original = profile_document("profile-a", "stable-a");
        let (coordinator, adapter, persistence) = coordinator(Some(original.clone()));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        let read = coordinator.read_policy().await.expect("read old scope");
        let old_namespace =
            NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_identity(
                "profile-a",
                "stable-a",
            )
            .expect("old namespace");
        let old_bytes = persistence.record(old_namespace).expect("old policy bytes");
        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        adapter.fail_next_write(NativeProfilePublicationFailure::DefinitelyNotPublished);
        assert_eq!(
            coordinator
                .replace_profile(profile_document("profile-b", "stable-b"))
                .await,
            Err(NodeConfigCoordinatorError::ProfileNotPublished)
        );
        assert_eq!(adapter.events(), ["persist"]);
        assert_eq!(adapter.stored().as_deref(), Some(original.as_str()));

        let backend_calls = persistence.call_count();
        assert_eq!(
            coordinator
                .compare_and_swap(read.context, 1, next_draft(&read.document))
                .await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::StaleSelectionContext
            ))
        );
        assert_eq!(persistence.call_count(), backend_calls);
        assert_eq!(persistence.record(old_namespace), Some(old_bytes));
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("fresh read")
                .document
                .revision,
            1
        );
    }

    #[tokio::test]
    async fn uncertain_profile_publication_requires_confirmed_refresh() {
        let original = profile_document("profile-a", "stable-a");
        let (coordinator, adapter, persistence) = coordinator(Some(original));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        adapter.fail_next_write(NativeProfilePublicationFailure::Indeterminate);
        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        let replacement = profile_document("profile-b", "stable-b");
        assert_eq!(
            coordinator.replace_profile(replacement.clone()).await,
            Err(NodeConfigCoordinatorError::ProfilePublicationIndeterminate)
        );
        assert_eq!(adapter.events(), ["persist"]);
        assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
        let backend_calls = persistence.call_count();
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(persistence.call_count(), backend_calls);
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("explicit confirmed recovery");
        assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("read recovered")
                .document
                .revision,
            1
        );
    }

    #[tokio::test]
    async fn session_release_install_and_refresh_errors_leave_access_closed_until_refresh() {
        for fail_install in [false, true] {
            let original = profile_document("profile-a", "stable-a");
            let (coordinator, adapter, persistence) = coordinator(Some(original));
            coordinator
                .refresh_confirmed_profile()
                .await
                .expect("initial refresh");
            adapter
                .state
                .lock()
                .expect("profile adapter lock")
                .events
                .clear();
            let replacement = profile_document("profile-b", "stable-b");
            if fail_install {
                adapter.fail_next_install();
            } else {
                adapter.fail_next_release();
            }
            let error = coordinator
                .replace_profile(replacement.clone())
                .await
                .expect_err("transition callback failure");
            assert_eq!(
                error,
                if fail_install {
                    NodeConfigCoordinatorError::ProfileInstallFailed
                } else {
                    NodeConfigCoordinatorError::SessionReleaseFailed
                }
            );
            let expected_events: &[&str] = if fail_install {
                &["persist", "release", "install"]
            } else {
                &["persist", "release"]
            };
            assert_eq!(adapter.events().as_slice(), expected_events);
            assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
            let backend_calls = persistence.call_count();
            assert_eq!(
                coordinator.read_policy().await,
                Err(NodeConfigCoordinatorError::Unavailable)
            );
            assert_eq!(persistence.call_count(), backend_calls);
            coordinator
                .refresh_confirmed_profile()
                .await
                .expect("confirmed refresh recovery");
            assert_eq!(
                coordinator
                    .read_policy()
                    .await
                    .expect("recovered read")
                    .document
                    .revision,
                1
            );
        }

        let (coordinator, adapter, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        adapter.fail_next_release();
        assert_eq!(
            coordinator.refresh_confirmed_profile().await,
            Err(NodeConfigCoordinatorError::SessionReleaseFailed)
        );
        let backend_calls = persistence.call_count();
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(persistence.call_count(), backend_calls);
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("retry confirmed refresh");
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("recovered read")
                .document
                .revision,
            1
        );
    }

    #[tokio::test]
    async fn same_profile_refresh_preserves_quarantine_without_policy_probe() {
        let (coordinator, adapter, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        let read = coordinator.read_policy().await.expect("initialize A");
        persistence.fail_next_replace(NodeConfigPublishFailure::Indeterminate);
        assert!(matches!(
            coordinator
                .compare_and_swap(read.context, 1, next_draft(&read.document))
                .await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::IndeterminatePublication
            ))
        ));
        let quarantined_calls = ["read", "create", "read", "replace"];
        assert_eq!(persistence.calls(), quarantined_calls);

        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("refresh same confirmed profile");
        assert_eq!(adapter.events(), ["read-confirmed", "release", "install"]);
        assert_eq!(persistence.calls(), quarantined_calls);
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert!(matches!(
            coordinator.reconcile_policy().await,
            Ok(NodeConfigReconciliation::Initialized(ref document)) if document.revision == 2
        ));
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "confirm"]
        );
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("read after explicit reconciliation")
                .document
                .revision,
            2
        );
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "confirm", "read"]
        );
    }

    #[tokio::test]
    async fn profile_round_trip_restores_quarantine_without_read_or_initialize_probe() {
        let (coordinator, adapter, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        let read_a = coordinator.read_policy().await.expect("initialize A");
        persistence.fail_next_replace(NodeConfigPublishFailure::Indeterminate);
        assert!(matches!(
            coordinator
                .compare_and_swap(read_a.context, 1, next_draft(&read_a.document))
                .await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::IndeterminatePublication
            ))
        ));
        assert_eq!(persistence.calls(), ["read", "create", "read", "replace"]);

        adapter.state.lock().expect("profile adapter lock").stored =
            Some(profile_document("profile-b", "stable-b"));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("switch to confirmed B");
        assert_eq!(persistence.calls(), ["read", "create", "read", "replace"]);
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("initialize independent B")
                .document
                .revision,
            1
        );
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "read", "create"]
        );

        adapter.state.lock().expect("profile adapter lock").stored =
            Some(profile_document("profile-a", "stable-a"));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("switch back to confirmed A");
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "read", "create"]
        );
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert!(matches!(
            coordinator.reconcile_policy().await,
            Ok(NodeConfigReconciliation::Initialized(ref document)) if document.revision == 2
        ));
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "read", "create", "confirm"]
        );
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("read A after explicit reconciliation")
                .document
                .revision,
            2
        );
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "read", "create", "confirm", "read"]
        );
    }

    #[tokio::test]
    async fn indeterminate_profile_transition_restores_target_quarantine_without_io_probe() {
        let (coordinator, adapter, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        let read_a = coordinator.read_policy().await.expect("initialize A");
        persistence.fail_next_replace(NodeConfigPublishFailure::Indeterminate);
        assert!(matches!(
            coordinator
                .compare_and_swap(read_a.context, 1, next_draft(&read_a.document))
                .await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::IndeterminatePublication
            ))
        ));
        assert_eq!(persistence.calls(), ["read", "create", "read", "replace"]);

        adapter.state.lock().expect("profile adapter lock").stored =
            Some(profile_document("profile-b", "stable-b"));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("leave quarantined A for confirmed B");
        let calls_after_b_refresh = persistence.calls();
        adapter.fail_next_write(NativeProfilePublicationFailure::Indeterminate);
        let replacement = profile_document("profile-a", "stable-a");
        assert_eq!(
            coordinator.replace_profile(replacement.clone()).await,
            Err(NodeConfigCoordinatorError::ProfilePublicationIndeterminate)
        );
        assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
        assert_eq!(persistence.calls(), calls_after_b_refresh);

        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("confirm transition to quarantined A");
        assert_eq!(adapter.events(), ["read-confirmed", "release", "install"]);
        assert_eq!(persistence.calls(), calls_after_b_refresh);
        let adapter_events = adapter.events();
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(
            coordinator
                .replace_profile(profile_document("profile-b", "stable-b"))
                .await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(adapter.events(), adapter_events);
        assert_eq!(persistence.calls(), calls_after_b_refresh);
        assert!(matches!(
            coordinator.reconcile_policy().await,
            Ok(NodeConfigReconciliation::Initialized(ref document)) if document.revision == 2
        ));
        let mut expected_calls = calls_after_b_refresh;
        expected_calls.push("confirm");
        assert_eq!(persistence.calls(), expected_calls);
    }

    #[tokio::test]
    async fn policy_indeterminate_publication_needs_explicit_owner_reconciliation() {
        let (coordinator, _adapter, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        let read = coordinator.read_policy().await.expect("initialize policy");
        let draft = next_draft(&read.document);
        persistence.fail_next_replace(NodeConfigPublishFailure::Indeterminate);
        assert!(matches!(
            coordinator.compare_and_swap(read.context, 1, draft).await,
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::IndeterminatePublication
            ))
        ));
        assert!(matches!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        ));
        assert!(matches!(
            coordinator.reconcile_policy().await,
            Ok(NodeConfigReconciliation::Initialized(ref document)) if document.revision == 2
        ));
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("read after reconciliation")
                .document
                .revision,
            2
        );
        assert_eq!(
            persistence.calls(),
            ["read", "create", "read", "replace", "confirm", "read"]
        );
    }

    #[tokio::test]
    async fn adapter_panic_keeps_coordinator_unavailable_until_confirmed_refresh() {
        let (coordinator, adapter, persistence) =
            coordinator(Some(profile_document("profile-a", "stable-a")));
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("initial refresh");
        adapter.panic_next_release();
        adapter
            .state
            .lock()
            .expect("profile adapter lock")
            .events
            .clear();
        let replacement = profile_document("profile-b", "stable-b");
        assert_eq!(
            coordinator.replace_profile(replacement.clone()).await,
            Err(NodeConfigCoordinatorError::TaskFailed)
        );
        assert_eq!(adapter.events(), ["persist", "release"]);
        assert_eq!(adapter.stored().as_deref(), Some(replacement.as_str()));
        let backend_calls = persistence.call_count();
        assert_eq!(
            coordinator.read_policy().await,
            Err(NodeConfigCoordinatorError::Unavailable)
        );
        assert_eq!(persistence.call_count(), backend_calls);
        coordinator
            .refresh_confirmed_profile()
            .await
            .expect("explicit confirmed recovery after panic");
        assert_eq!(
            coordinator
                .read_policy()
                .await
                .expect("read recovered")
                .document
                .revision,
            1
        );
    }
}
