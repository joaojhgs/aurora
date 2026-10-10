//! App-private file persistence for a profile-scoped native node policy.
//!
//! The caller must make this backend exclusively reachable through one
//! `NodeConfigOperationOwner` for a selected profile. It is an in-process
//! backend, not a cross-process lock. The policy is nonsecret; this module
//! makes no encryption or cross-platform durability claim. Every operation
//! performs blocking filesystem work and belongs on a blocking thread.

use crate::node_config::{
    CreateIfAbsentResult, NodeConfigPersistence, NodeConfigPersistenceError,
    NodeConfigProfileNamespace, NodeConfigPublishFailure,
};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_NODE_CONFIG_BYTES: usize = 65_536;
const MAX_TEMP_NAME_ATTEMPTS: usize = 32;
const PROFILE_DIRECTORY: &str = "node-config-v2";
const DOCUMENT_FILE: &str = "document.json";
const TEMP_PREFIX: &str = ".node-config-v2.tmp-";

/// Filesystem persistence rooted in an app-private data directory.
///
/// `root` is supplied by the trusted native bootstrap. Namespace components
/// are derived by `NodeConfigProfileNamespace`, so this type never accepts a
/// caller-provided profile or peer string.
pub struct NodeConfigFilePersistence {
    root: PathBuf,
    next_temp_id: AtomicU64,
    #[cfg(test)]
    faults: std::sync::Mutex<std::collections::VecDeque<TestFault>>,
}

impl NodeConfigFilePersistence {
    /// Create a backend rooted under an existing, durably provisioned
    /// app-private directory supplied by trusted native bootstrap.
    ///
    /// The constructor performs no filesystem I/O. The supplied root must
    /// already be absolute, exist, be a real directory, and have durable
    /// ancestry; this backend only shape-checks that boundary. Reads and writes
    /// are blocking operations. Reads also provision and synchronize managed
    /// descendants, clean recognized temporary files, and fail closed if any
    /// filesystem operation cannot be confirmed.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            next_temp_id: AtomicU64::new(1),
            #[cfg(test)]
            faults: std::sync::Mutex::new(std::collections::VecDeque::new()),
        }
    }

    fn profile_directory(&self, profile: NodeConfigProfileNamespace) -> PathBuf {
        self.root
            .join(PROFILE_DIRECTORY)
            .join(profile.storage_component())
    }

    fn document_path(&self, profile: NodeConfigProfileNamespace) -> PathBuf {
        self.profile_directory(profile).join(DOCUMENT_FILE)
    }

    fn ensure_profile_directory(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<PathBuf, NodeConfigPublishFailure> {
        if !self.root.is_absolute() {
            return Err(NodeConfigPublishFailure::NotPublished);
        }
        let root_metadata =
            fs::symlink_metadata(&self.root).map_err(|_| NodeConfigPublishFailure::NotPublished)?;
        if !root_metadata.file_type().is_dir() {
            return Err(NodeConfigPublishFailure::NotPublished);
        }
        let managed_root = ensure_managed_directory(&self.root, PROFILE_DIRECTORY, || {
            #[cfg(test)]
            if self.take_fault(TestFault::ManagedParentSync) {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            Ok(())
        })
        .map_err(|_| NodeConfigPublishFailure::NotPublished)?;
        let directory =
            ensure_managed_directory(&managed_root, &profile.storage_component(), || Ok(()))
                .map_err(|_| NodeConfigPublishFailure::NotPublished)?;
        cleanup_orphan_temps(&directory).map_err(|_| NodeConfigPublishFailure::NotPublished)?;
        Ok(directory)
    }

    fn create_temp(
        &self,
        directory: &Path,
        bytes: &[u8],
    ) -> Result<(PathBuf, File), NodeConfigPublishFailure> {
        for _ in 0..MAX_TEMP_NAME_ATTEMPTS {
            let id = self
                .next_temp_id
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    current.checked_add(1)
                })
                .map_err(|_| NodeConfigPublishFailure::NotPublished)?;
            let name = format!("{TEMP_PREFIX}{}-{id}", std::process::id());
            let path = directory.join(name);
            let file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(NodeConfigPublishFailure::NotPublished),
            };

            #[cfg(test)]
            if self.take_fault(TestFault::TempWrite) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(NodeConfigPublishFailure::NotPublished);
            }

            let mut file = file;
            #[cfg(test)]
            if self.take_fault(TestFault::TempWriteAfterPartial) {
                let partial_len = bytes.len().min(4);
                let _ = file.write_all(&bytes[..partial_len]);
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(NodeConfigPublishFailure::NotPublished);
            }
            if file.write_all(bytes).is_err() {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(NodeConfigPublishFailure::NotPublished);
            }

            #[cfg(test)]
            if self.take_fault(TestFault::TempSync) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(NodeConfigPublishFailure::NotPublished);
            }
            if file.sync_all().is_err() {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(NodeConfigPublishFailure::NotPublished);
            }
            return Ok((path, file));
        }
        Err(NodeConfigPublishFailure::NotPublished)
    }

    #[cfg(test)]
    fn take_fault(&self, fault: TestFault) -> bool {
        let Ok(mut faults) = self.faults.lock() else {
            return false;
        };
        if let Some(index) = faults.iter().position(|next| *next == fault) {
            faults.remove(index);
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn inject(&self, fault: TestFault) {
        self.faults
            .lock()
            .expect("fault queue lock")
            .push_back(fault);
    }
}

impl NodeConfigPersistence for NodeConfigFilePersistence {
    fn read(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
        self.confirm_durable_snapshot(profile)
    }

    fn create_if_absent(
        &self,
        profile: NodeConfigProfileNamespace,
        candidate: &[u8],
    ) -> Result<CreateIfAbsentResult, NodeConfigPublishFailure> {
        if candidate.len() > MAX_NODE_CONFIG_BYTES {
            return Err(NodeConfigPublishFailure::NotPublished);
        }
        let directory = self.ensure_profile_directory(profile)?;
        let target = self.document_path(profile);
        let (temporary, temp_file) = self.create_temp(&directory, candidate)?;
        drop(temp_file);

        #[cfg(test)]
        if self.take_fault(TestFault::HardLinkBeforePublish) {
            let _ = fs::remove_file(&temporary);
            return Err(NodeConfigPublishFailure::Indeterminate);
        }

        match fs::hard_link(&temporary, &target) {
            Ok(()) => {
                #[cfg(test)]
                let directory_sync_failed = self.take_fault(TestFault::DirectorySyncAfterCreate);
                #[cfg(not(test))]
                let directory_sync_failed = false;
                if directory_sync_failed || sync_directory(&directory).is_err() {
                    let _ = fs::remove_file(&temporary);
                    return Err(NodeConfigPublishFailure::Indeterminate);
                }
                // The target link is already durable. A leftover recognized
                // temp link is harmless and is removed under owner exclusivity
                // on the next write if this best-effort cleanup fails.
                let _ = fs::remove_file(&temporary);
                Ok(CreateIfAbsentResult::Created)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&temporary);
                read_regular_file(&target)
                    .map_err(|_| NodeConfigPublishFailure::Indeterminate)?
                    .map(CreateIfAbsentResult::AlreadyExists)
                    .ok_or(NodeConfigPublishFailure::Indeterminate)
            }
            Err(_) => {
                let _ = fs::remove_file(&temporary);
                // A failed link is not treated as proof of absence. The owner
                // must quarantine and explicitly confirm the target state.
                Err(NodeConfigPublishFailure::Indeterminate)
            }
        }
    }

    fn replace_atomically(
        &self,
        profile: NodeConfigProfileNamespace,
        candidate: &[u8],
    ) -> Result<(), NodeConfigPublishFailure> {
        if candidate.len() > MAX_NODE_CONFIG_BYTES {
            return Err(NodeConfigPublishFailure::NotPublished);
        }
        let directory = self.ensure_profile_directory(profile)?;
        let target = self.document_path(profile);
        let (temporary, temp_file) = self.create_temp(&directory, candidate)?;
        drop(temp_file);

        #[cfg(test)]
        if self.take_fault(TestFault::RenameBeforePublish) {
            let _ = fs::remove_file(&temporary);
            return Err(NodeConfigPublishFailure::Indeterminate);
        }

        // Do not emulate replacement by removing the old target first.
        // Platforms without atomic replacement semantics fail closed here.
        if fs::rename(&temporary, &target).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(NodeConfigPublishFailure::Indeterminate);
        }

        #[cfg(test)]
        let directory_sync_failed = self.take_fault(TestFault::DirectorySyncAfterReplace);
        #[cfg(not(test))]
        let directory_sync_failed = false;
        if directory_sync_failed || sync_directory(&directory).is_err() {
            return Err(NodeConfigPublishFailure::Indeterminate);
        }
        Ok(())
    }

    fn confirm_durable_snapshot(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
        let directory = self
            .ensure_profile_directory(profile)
            .map_err(|_| NodeConfigPersistenceError)?;
        let target = self.document_path(profile);
        let snapshot = match open_regular_file(&target)? {
            Some(mut file) => {
                let bytes = read_bounded(&mut file).map_err(|_| NodeConfigPersistenceError)?;
                #[cfg(test)]
                if self.take_fault(TestFault::ConfirmFileSync) {
                    return Err(NodeConfigPersistenceError);
                }
                file.sync_all().map_err(|_| NodeConfigPersistenceError)?;
                Some(bytes)
            }
            None => None,
        };
        #[cfg(test)]
        if self.take_fault(TestFault::ConfirmDirectorySync) {
            return Err(NodeConfigPersistenceError);
        }
        sync_directory(&directory).map_err(|_| NodeConfigPersistenceError)?;
        // For absence, the directory sync and this final lookup confirm that
        // the name is still absent while the owner holds its operation lock.
        if snapshot.is_none() {
            match fs::symlink_metadata(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(NodeConfigPersistenceError),
            }
        }
        Ok(snapshot)
    }
}

impl NodeConfigPersistence for std::sync::Arc<NodeConfigFilePersistence> {
    fn read(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
        self.as_ref().read(profile)
    }

    fn create_if_absent(
        &self,
        profile: NodeConfigProfileNamespace,
        candidate: &[u8],
    ) -> Result<CreateIfAbsentResult, NodeConfigPublishFailure> {
        self.as_ref().create_if_absent(profile, candidate)
    }

    fn replace_atomically(
        &self,
        profile: NodeConfigProfileNamespace,
        candidate: &[u8],
    ) -> Result<(), NodeConfigPublishFailure> {
        self.as_ref().replace_atomically(profile, candidate)
    }

    fn confirm_durable_snapshot(
        &self,
        profile: NodeConfigProfileNamespace,
    ) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
        self.as_ref().confirm_durable_snapshot(profile)
    }
}

fn ensure_managed_directory(
    parent: &Path,
    name: &str,
    before_parent_sync: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let parent_metadata = fs::symlink_metadata(parent)?;
    if !parent_metadata.file_type().is_dir() {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    let child = parent.join(name);
    match fs::symlink_metadata(&child) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(&child) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(&child)?;
                    if !metadata.file_type().is_dir() {
                        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    }
    // Re-check even already-existing managed entries. A previous process may
    // have created the entry and failed before syncing its parent.
    before_parent_sync()?;
    sync_directory(parent)?;
    sync_directory(&child)?;
    Ok(child)
}

fn cleanup_orphan_temps(directory: &Path) -> std::io::Result<()> {
    let mut removed = false;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if !is_generated_temp_name(&name) {
            continue;
        }
        if !entry.file_type()?.is_file() {
            continue;
        }
        fs::remove_file(entry.path())?;
        removed = true;
    }
    if removed {
        sync_directory(directory)?;
    }
    Ok(())
}

fn is_generated_temp_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(suffix) = name.strip_prefix(TEMP_PREFIX) else {
        return false;
    };
    let Some((pid, counter)) = suffix.split_once('-') else {
        return false;
    };
    if counter.contains('-') {
        return false;
    }
    let Ok(pid_value) = pid.parse::<u32>() else {
        return false;
    };
    let Ok(counter_value) = counter.parse::<u64>() else {
        return false;
    };
    pid_value > 0
        && counter_value > 0
        && pid == pid_value.to_string()
        && counter == counter_value.to_string()
}

fn read_regular_file(path: &Path) -> Result<Option<Vec<u8>>, NodeConfigPersistenceError> {
    let Some(mut file) = open_regular_file(path)? else {
        return Ok(None);
    };
    let bytes = read_bounded(&mut file).map_err(|_| NodeConfigPersistenceError)?;
    Ok(Some(bytes))
}

fn open_regular_file(path: &Path) -> Result<Option<File>, NodeConfigPersistenceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err(NodeConfigPersistenceError),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(NodeConfigPersistenceError),
    }
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| NodeConfigPersistenceError)?;
    if !file
        .metadata()
        .map_err(|_| NodeConfigPersistenceError)?
        .is_file()
    {
        return Err(NodeConfigPersistenceError);
    }
    Ok(Some(file))
}

fn read_bounded(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(MAX_NODE_CONFIG_BYTES + 1);
    reader
        .take((MAX_NODE_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestFault {
    TempWrite,
    TempWriteAfterPartial,
    TempSync,
    HardLinkBeforePublish,
    DirectorySyncAfterCreate,
    ManagedParentSync,
    RenameBeforePublish,
    DirectorySyncAfterReplace,
    ConfirmFileSync,
    ConfirmDirectorySync,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_config::{
        NodeConfigOperationError, NodeConfigOperationOwner, NodeConfigReconciliation,
    };
    use aurora_voice_core::node_policy::{
        empty_node_config_document_v2, validate_node_config_document_v2_json, NodeConfigDocumentV2,
    };
    use std::sync::Arc;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "aurora-node-config-file-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn selected_profile(value: &str) -> NodeConfigProfileNamespace {
        NodeConfigProfileNamespace::from_validated_selected_local_mesh_node_profile_id(value)
            .expect("test profile is accepted by owner")
    }

    fn make_owner(
        directory: &TestDirectory,
    ) -> (
        Arc<NodeConfigFilePersistence>,
        NodeConfigOperationOwner<Arc<NodeConfigFilePersistence>>,
    ) {
        let backend = Arc::new(NodeConfigFilePersistence::new(directory.path()));
        let owner = NodeConfigOperationOwner::new(Arc::clone(&backend));
        owner
            .select_profile(Some(selected_profile("local-profile-a")))
            .expect("select profile");
        (backend, owner)
    }

    fn next_draft(document: &NodeConfigDocumentV2) -> String {
        let mut value = serde_json::to_value(document).expect("document value");
        value["revision"] = serde_json::Value::from(document.revision + 1);
        serde_json::to_string(&value).expect("next revision draft")
    }

    fn decode_persisted(bytes: &[u8]) -> NodeConfigDocumentV2 {
        let json = std::str::from_utf8(bytes).expect("stored policy is UTF-8");
        validate_node_config_document_v2_json(json).expect("stored policy is valid")
    }

    #[test]
    fn host_filesystem_initializes_replaces_and_isolates_profile_namespaces() {
        let directory = TestDirectory::new("host");
        let backend = NodeConfigFilePersistence::new(directory.path());
        let first = selected_profile("local-profile-a");
        let second = selected_profile("local-profile-b");
        let initial = serde_json::to_vec(&empty_node_config_document_v2(1).expect("defaults"))
            .expect("serialize defaults");

        assert_eq!(backend.read(first), Ok(None));
        assert_eq!(backend.read(second), Ok(None));
        assert_eq!(
            backend.create_if_absent(first, &initial),
            Ok(CreateIfAbsentResult::Created)
        );
        assert_eq!(backend.read(first), Ok(Some(initial.clone())));
        assert_eq!(backend.read(second), Ok(None));
        assert_eq!(
            backend.create_if_absent(first, b"different"),
            Ok(CreateIfAbsentResult::AlreadyExists(initial.clone()))
        );

        let replacement = serde_json::to_vec(&empty_node_config_document_v2(2).expect("defaults"))
            .expect("serialize replacement");
        assert_eq!(backend.replace_atomically(first, &replacement), Ok(()));
        assert_eq!(backend.read(first), Ok(Some(replacement.clone())));
        assert_eq!(
            backend.confirm_durable_snapshot(first),
            Ok(Some(replacement))
        );
    }

    #[test]
    fn owner_receipt_matches_exact_persisted_bytes_and_survives_backend_reopen() {
        let directory = TestDirectory::new("receipt-reopen");
        let (backend, owner) = make_owner(&directory);
        let current = owner.load_or_initialize().expect("initialize");
        let receipt = owner
            .compare_and_swap(&current.context, 1, &next_draft(&current.document))
            .expect("publish next generation");
        let persisted = backend
            .read(selected_profile("local-profile-a"))
            .expect("read persisted bytes")
            .expect("record is present");
        assert_eq!(decode_persisted(&persisted), receipt.document);

        let reopened = NodeConfigFilePersistence::new(directory.path());
        assert_eq!(
            reopened
                .read(selected_profile("local-profile-a"))
                .expect("read after backend reopen"),
            Some(persisted)
        );
    }

    #[test]
    fn prepublication_write_and_file_sync_failures_preserve_previous_bytes() {
        for fault in [TestFault::TempWriteAfterPartial, TestFault::TempSync] {
            let directory = TestDirectory::new("prepublish");
            let (backend, owner) = make_owner(&directory);
            let initial = owner.load_or_initialize().expect("initialize");
            let original = backend
                .read(selected_profile("local-profile-a"))
                .expect("read");
            let draft = next_draft(&initial.document);
            backend.inject(fault);
            assert_eq!(
                owner.compare_and_swap(&initial.context, 1, &draft),
                Err(NodeConfigOperationError::NotPublished)
            );
            assert_eq!(
                backend
                    .read(selected_profile("local-profile-a"))
                    .expect("read"),
                original
            );
            assert_eq!(
                owner
                    .load_or_initialize()
                    .expect("owner remains usable")
                    .document
                    .revision,
                1
            );
        }
    }

    #[test]
    fn initialization_publication_uncertainty_requires_confirmation_of_absence_or_document() {
        let directory = TestDirectory::new("init-uncertain");
        let (backend, owner) = make_owner(&directory);
        backend.inject(TestFault::HardLinkBeforePublish);
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
        backend.inject(TestFault::ConfirmDirectorySync);
        assert_eq!(
            owner.reconcile_selected_profile(),
            Err(NodeConfigOperationError::ReconciliationIncomplete)
        );
        assert_eq!(
            owner.reconcile_selected_profile(),
            Ok(NodeConfigReconciliation::Uninitialized)
        );
        assert_eq!(
            owner
                .load_or_initialize()
                .expect("retry initialization")
                .document
                .revision,
            1
        );

        let published_directory = TestDirectory::new("init-after");
        let (published_backend, published_owner) = make_owner(&published_directory);
        published_backend.inject(TestFault::DirectorySyncAfterCreate);
        assert_eq!(
            published_owner.load_or_initialize(),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        let published_bytes = published_backend
            .read(selected_profile("local-profile-a"))
            .expect("read published bytes")
            .expect("published target exists");
        let published = decode_persisted(&published_bytes);
        assert_eq!(
            published_owner.reconcile_selected_profile(),
            Ok(NodeConfigReconciliation::Initialized(Box::new(published)))
        );
    }

    #[test]
    fn replacement_rename_and_directory_sync_uncertainty_reconcile_exact_generations() {
        let directory = TestDirectory::new("replace-uncertain");
        let (backend, owner) = make_owner(&directory);
        let current = owner.load_or_initialize().expect("initialize");
        let initial_bytes = backend
            .read(selected_profile("local-profile-a"))
            .expect("read");
        let draft = next_draft(&current.document);

        backend.inject(TestFault::RenameBeforePublish);
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert_eq!(
            backend
                .read(selected_profile("local-profile-a"))
                .expect("old visible"),
            initial_bytes
        );
        assert_eq!(
            owner.reconcile_selected_profile(),
            Ok(NodeConfigReconciliation::Initialized(Box::new(
                current.document.clone(),
            )))
        );

        backend.inject(TestFault::DirectorySyncAfterReplace);
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        assert_eq!(
            owner.load_or_initialize(),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
        let candidate_bytes = backend
            .read(selected_profile("local-profile-a"))
            .expect("read candidate")
            .expect("candidate visible");
        let candidate = decode_persisted(&candidate_bytes);
        assert_eq!(candidate.revision, 2);
        assert_eq!(
            owner.reconcile_selected_profile(),
            Ok(NodeConfigReconciliation::Initialized(Box::new(candidate)))
        );
        assert_eq!(
            owner
                .load_or_initialize()
                .expect("confirmed candidate")
                .document
                .revision,
            2
        );
    }

    #[test]
    fn confirmation_sync_failures_keep_owner_quarantined() {
        let directory = TestDirectory::new("confirm-fail");
        let (backend, owner) = make_owner(&directory);
        let current = owner.load_or_initialize().expect("initialize");
        let draft = next_draft(&current.document);
        backend.inject(TestFault::DirectorySyncAfterReplace);
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::IndeterminatePublication)
        );
        backend.inject(TestFault::ConfirmFileSync);
        assert_eq!(
            owner.reconcile_selected_profile(),
            Err(NodeConfigOperationError::ReconciliationIncomplete)
        );
        assert_eq!(
            owner.compare_and_swap(&current.context, 1, &draft),
            Err(NodeConfigOperationError::ReconciliationRequired)
        );
    }

    #[test]
    fn reads_are_bounded_and_symlink_targets_are_not_followed() {
        let directory = TestDirectory::new("bounded");
        let backend = NodeConfigFilePersistence::new(directory.path());
        let profile = selected_profile("local-profile-a");
        let profile_dir = backend
            .ensure_profile_directory(profile)
            .expect("profile dir");
        fs::write(
            profile_dir.join(DOCUMENT_FILE),
            vec![b'x'; MAX_NODE_CONFIG_BYTES + 100],
        )
        .expect("write oversized target");
        assert_eq!(
            backend
                .read(profile)
                .expect("bounded read")
                .map(|bytes| bytes.len()),
            Some(MAX_NODE_CONFIG_BYTES + 1)
        );
        assert!(
            backend
                .confirm_durable_snapshot(profile)
                .expect("confirm oversized")
                .expect("oversized document exists")
                .len()
                <= MAX_NODE_CONFIG_BYTES + 1
        );

        let link_dir = TestDirectory::new("symlink");
        let linked_backend = NodeConfigFilePersistence::new(link_dir.path());
        let link_profile = selected_profile("local-profile-b");
        let link_parent = linked_backend
            .ensure_profile_directory(link_profile)
            .expect("profile dir");
        let outside = link_dir.path().join("outside.json");
        fs::write(&outside, b"secret").expect("write outside file");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, link_parent.join(DOCUMENT_FILE)).expect("symlink");
            assert_eq!(
                linked_backend.read(link_profile),
                Err(NodeConfigPersistenceError)
            );
            assert_eq!(
                linked_backend.confirm_durable_snapshot(link_profile),
                Err(NodeConfigPersistenceError)
            );
        }
    }

    #[test]
    fn startup_read_requires_durable_confirmation_of_file_and_absence() {
        let directory = TestDirectory::new("confirm-startup");
        let backend = NodeConfigFilePersistence::new(directory.path());
        let profile = selected_profile("local-profile-a");

        backend.inject(TestFault::ConfirmDirectorySync);
        assert_eq!(backend.read(profile), Err(NodeConfigPersistenceError));
        assert_eq!(backend.read(profile), Ok(None));

        let initial = serde_json::to_vec(&empty_node_config_document_v2(1).expect("defaults"))
            .expect("serialize");
        assert_eq!(
            backend.create_if_absent(profile, &initial),
            Ok(CreateIfAbsentResult::Created)
        );
        backend.inject(TestFault::ConfirmFileSync);
        assert_eq!(backend.read(profile), Err(NodeConfigPersistenceError));
        assert_eq!(backend.read(profile), Ok(Some(initial)));

        let relative = NodeConfigFilePersistence::new("relative-node-config-root");
        assert_eq!(relative.read(profile), Err(NodeConfigPersistenceError));
        assert_eq!(
            relative.confirm_durable_snapshot(profile),
            Err(NodeConfigPersistenceError)
        );
    }

    #[test]
    fn failed_managed_parent_sync_is_retried_for_existing_directory() {
        let directory = TestDirectory::new("managed-dir-retry");
        let backend = NodeConfigFilePersistence::new(directory.path());
        let profile = selected_profile("local-profile-a");
        let initial = serde_json::to_vec(&empty_node_config_document_v2(1).expect("defaults"))
            .expect("serialize");

        backend.inject(TestFault::ManagedParentSync);
        backend.inject(TestFault::ManagedParentSync);
        assert_eq!(
            backend.create_if_absent(profile, &initial),
            Err(NodeConfigPublishFailure::NotPublished)
        );
        assert!(!backend.document_path(profile).exists());
        assert_eq!(
            backend.create_if_absent(profile, &initial),
            Err(NodeConfigPublishFailure::NotPublished)
        );
        assert!(!backend.document_path(profile).exists());
        assert_eq!(
            backend.create_if_absent(profile, &initial),
            Ok(CreateIfAbsentResult::Created)
        );
        assert_eq!(backend.read(profile), Ok(Some(initial)));
    }

    #[test]
    fn recognized_orphans_are_cleaned_but_unrecognized_files_are_preserved() {
        let directory = TestDirectory::new("orphan");
        let backend = NodeConfigFilePersistence::new(directory.path());
        let profile = selected_profile("local-profile-a");
        let profile_dir = backend
            .ensure_profile_directory(profile)
            .expect("profile dir");
        let orphan = profile_dir.join(format!("{TEMP_PREFIX}{}-1", std::process::id()));
        let malformed_lookalike = profile_dir.join(format!("{TEMP_PREFIX}old-session-1"));
        let unrelated = profile_dir.join("notes.tmp");
        fs::write(&orphan, b"incomplete").expect("orphan");
        fs::write(&malformed_lookalike, b"keep malformed lookalike").expect("lookalike");
        fs::write(&unrelated, b"keep").expect("unrelated");
        let initial = serde_json::to_vec(&empty_node_config_document_v2(1).expect("defaults"))
            .expect("serialize");
        assert_eq!(
            backend.create_if_absent(profile, &initial),
            Ok(CreateIfAbsentResult::Created)
        );
        assert!(!orphan.exists());
        assert!(malformed_lookalike.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn temp_creation_collision_does_not_overwrite_existing_file() {
        let directory = TestDirectory::new("collision");
        let backend = NodeConfigFilePersistence::new(directory.path());
        let profile = selected_profile("local-profile-a");
        let profile_dir = backend
            .ensure_profile_directory(profile)
            .expect("profile dir");
        let collision = profile_dir.join(format!("{TEMP_PREFIX}{}-1", std::process::id()));
        fs::write(&collision, b"unrelated occupant").expect("collision occupant");
        let initial = serde_json::to_vec(&empty_node_config_document_v2(1).expect("defaults"))
            .expect("serialize");
        let (created, file) = backend
            .create_temp(&profile_dir, &initial)
            .expect("retry collision");
        drop(file);
        assert_ne!(created, collision);
        assert_eq!(
            fs::read(collision).expect("collision preserved"),
            b"unrelated occupant"
        );
        fs::remove_file(created).expect("remove generated temp");
    }
}
