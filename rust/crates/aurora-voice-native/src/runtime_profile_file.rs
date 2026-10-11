//! Blocking persistence for one complete canonical runtime-profile document.
//!
//! This store is profile-specific and accepts only a validated document. Its
//! root must be supplied by trusted native bootstrap as an existing absolute
//! OS-user-local app-private directory with durable ancestry. The constructor
//! does no I/O and does not prove those root properties. Operations are
//! blocking and must be serialized by the native profile coordinator and run
//! on a blocking thread. This store is not a cross-process lock and does not
//! provide legacy migration, profile selection, authorization, or runtime
//! application acknowledgement.

use crate::native_publication_fence::{NativePublicationFence, NativePublicationTicket};
use crate::node_config_coordinator::{NativeProfileAdapterError, NativeProfilePublicationFailure};
use crate::runtime_profile::{
    validate_canonical_runtime_profile_document, RuntimeProfileValidationOptions,
    ValidatedRuntimeProfileDocument,
};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_RUNTIME_PROFILE_DOCUMENT_BYTES: usize = 128 * 1024;
const MAX_TEMP_NAME_ATTEMPTS: usize = 32;
const MANAGED_DIRECTORY: &str = "runtime-profile-v2";
const DOCUMENT_FILE: &str = "document.json";
const TEMP_PREFIX: &str = ".runtime-profile-v2.tmp-";

/// Fixed-file storage for the complete canonical runtime-profile document.
///
/// The root and validation options are immutable. No caller-controlled value
/// is used as a path component.
pub struct RuntimeProfileFilePersistence {
    root: PathBuf,
    options: RuntimeProfileValidationOptions,
    next_temp_id: AtomicU64,
    #[cfg(all(test, unix))]
    faults: std::sync::Mutex<std::collections::VecDeque<TestFault>>,
}

impl RuntimeProfileFilePersistence {
    /// Create a store rooted at a trusted, already-existing app-private path.
    ///
    /// This constructor performs no filesystem access. The root must be
    /// absolute and its path, privacy, OS-user locality, and durable ancestry
    /// must be established by native bootstrap. The store shape-checks the
    /// supplied root before each operation, but cannot establish its origin.
    pub fn new(
        trusted_preexisting_root: impl Into<PathBuf>,
        options: RuntimeProfileValidationOptions,
    ) -> Self {
        Self {
            root: trusted_preexisting_root.into(),
            options,
            next_temp_id: AtomicU64::new(1),
            #[cfg(all(test, unix))]
            faults: std::sync::Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Return the fully validated current document, or confirmed absence.
    ///
    /// Reads do not create directories, defaults, or profile files. Existing
    /// bytes are bounded, validated with this store's immutable package
    /// options, and returned without normalization.
    pub fn read_confirmed(
        &self,
    ) -> Result<Option<ValidatedRuntimeProfileDocument>, NativeProfileAdapterError> {
        self.validate_root()
            .map_err(|_| NativeProfileAdapterError)?;
        let directory = self.root.join(MANAGED_DIRECTORY);
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.sync_root()?;
                ensure_absent(&directory)?;
                return Ok(None);
            }
            Err(_) => return Err(NativeProfileAdapterError),
            Ok(metadata) => {
                validate_directory_metadata(&metadata)?;
            }
        }

        self.sync_root()?;
        sync_directory(&directory).map_err(|_| NativeProfileAdapterError)?;
        let target = directory.join(DOCUMENT_FILE);
        let mut file = match open_regular_file(&target)? {
            Some(file) => file,
            None => {
                #[cfg(all(test, unix))]
                if self.take_fault(TestFault::ConfirmDirectorySync) {
                    return Err(NativeProfileAdapterError);
                }
                sync_directory(&directory).map_err(|_| NativeProfileAdapterError)?;
                self.sync_root()?;
                ensure_absent(&target)?;
                return Ok(None);
            }
        };
        let bytes = read_bounded(&mut file).map_err(|_| NativeProfileAdapterError)?;
        if bytes.len() > MAX_RUNTIME_PROFILE_DOCUMENT_BYTES {
            return Err(NativeProfileAdapterError);
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| NativeProfileAdapterError)?;
        let document = validate_canonical_runtime_profile_document(text, self.options)
            .map_err(|_| NativeProfileAdapterError)?;

        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::ConfirmFileSync) {
            return Err(NativeProfileAdapterError);
        }
        file.sync_all().map_err(|_| NativeProfileAdapterError)?;
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::ConfirmDirectorySync) {
            return Err(NativeProfileAdapterError);
        }
        sync_directory(&directory).map_err(|_| NativeProfileAdapterError)?;
        self.sync_root()?;
        Ok(Some(document))
    }

    /// Publish the exact bytes of a fully validated canonical document.
    ///
    /// The document is revalidated using this store's immutable options before
    /// any filesystem access. A failure before attempting replacement is
    /// definitely not published; once rename is attempted, failures are
    /// indeterminate and require explicit later confirmation.
    pub fn publish(
        &self,
        candidate: &ValidatedRuntimeProfileDocument,
    ) -> Result<(), NativeProfilePublicationFailure> {
        let document =
            validate_canonical_runtime_profile_document(candidate.as_json(), self.options)
                .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        self.publish_validated_bytes(document.as_json().as_bytes())
    }

    /// Publish a canonical document through a native lifecycle ticket.
    ///
    /// Validation occurs before ticket reservation or filesystem access. The
    /// reservation is acquired in this blocking method immediately before the
    /// first filesystem operation, so callers must enter it only after any
    /// applicable adapter/blocking queue has completed. This is not profile
    /// selection, caller-origin proof, or runtime application acknowledgement.
    pub fn publish_authorized(
        &self,
        fence: &NativePublicationFence,
        ticket: NativePublicationTicket,
        candidate: &ValidatedRuntimeProfileDocument,
    ) -> Result<(), NativeProfilePublicationFailure> {
        let document =
            validate_canonical_runtime_profile_document(candidate.as_json(), self.options)
                .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        let reservation = fence
            .reserve(ticket)
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        let result = self.publish_validated_bytes(document.as_json().as_bytes());
        if reservation.settle(result.is_ok()).is_err() {
            return Err(NativeProfilePublicationFailure::Indeterminate);
        }
        result
    }

    fn publish_validated_bytes(&self, bytes: &[u8]) -> Result<(), NativeProfilePublicationFailure> {
        self.validate_root()
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        let directory = self.ensure_managed_directory()?;
        let target = directory.join(DOCUMENT_FILE);
        validate_target_before_replace(&target)
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        self.sync_root()
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        sync_directory(&directory)
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;

        let (temporary, mut file) = self
            .create_temp(&directory)
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::TempWrite) {
            drop(file);
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::TempWriteAfterPartial) {
            let _ = file.write_all(&bytes[..bytes.len().min(8)]);
            drop(file);
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        if file.write_all(bytes).is_err() {
            drop(file);
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::TempSync) {
            drop(file);
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        if file.sync_all().is_err() {
            drop(file);
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        drop(file);

        if validate_target_before_replace(&target).is_err() {
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }

        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::Rename) {
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::Indeterminate);
        }
        if fs::rename(&temporary, &target).is_err() {
            remove_owned_temp(&temporary);
            return Err(NativeProfilePublicationFailure::Indeterminate);
        }

        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::DirectorySyncAfterRename) {
            return Err(NativeProfilePublicationFailure::Indeterminate);
        }
        if sync_directory(&directory).is_err() || self.sync_root().is_err() {
            return Err(NativeProfilePublicationFailure::Indeterminate);
        }
        Ok(())
    }

    fn validate_root(&self) -> Result<(), NativeProfileAdapterError> {
        if !self.root.is_absolute() {
            return Err(NativeProfileAdapterError);
        }
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| NativeProfileAdapterError)?;
        validate_directory_metadata(&metadata)
    }

    fn sync_root(&self) -> Result<(), NativeProfileAdapterError> {
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::RootSync) {
            return Err(NativeProfileAdapterError);
        }
        sync_directory(&self.root).map_err(|_| NativeProfileAdapterError)
    }

    fn ensure_managed_directory(&self) -> Result<PathBuf, NativeProfilePublicationFailure> {
        self.validate_root()
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        let directory = self.root.join(MANAGED_DIRECTORY);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) => validate_directory_metadata(&metadata)
                .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match create_private_directory(&directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(NativeProfilePublicationFailure::DefinitelyNotPublished),
                }
                let metadata = fs::symlink_metadata(&directory)
                    .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
                validate_directory_metadata(&metadata)
                    .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
            }
            Err(_) => return Err(NativeProfilePublicationFailure::DefinitelyNotPublished),
        }
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::RootSync) {
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        sync_directory(&self.root)
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        #[cfg(all(test, unix))]
        if self.take_fault(TestFault::ManagedDirectorySync) {
            return Err(NativeProfilePublicationFailure::DefinitelyNotPublished);
        }
        sync_directory(&directory)
            .map_err(|_| NativeProfilePublicationFailure::DefinitelyNotPublished)?;
        Ok(directory)
    }

    fn create_temp(&self, directory: &Path) -> std::io::Result<(PathBuf, File)> {
        for _ in 0..MAX_TEMP_NAME_ATTEMPTS {
            #[cfg(all(test, unix))]
            if self.take_fault(TestFault::TempCreate) {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            let id = self
                .next_temp_id
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    current.checked_add(1)
                })
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::AlreadyExists))?;
            let path = directory.join(format!("{TEMP_PREFIX}{}-{id}", std::process::id()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => return Ok((path, file)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
    }

    #[cfg(all(test, unix))]
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

    #[cfg(all(test, unix))]
    fn inject(&self, fault: TestFault) {
        self.faults
            .lock()
            .expect("fault queue lock")
            .push_back(fault);
    }
}

fn validate_directory_metadata(metadata: &fs::Metadata) -> Result<(), NativeProfileAdapterError> {
    if !metadata.file_type().is_dir() || !is_private(metadata) {
        return Err(NativeProfileAdapterError);
    }
    Ok(())
}

fn validate_file_metadata(metadata: &fs::Metadata) -> Result<(), NativeProfileAdapterError> {
    if !metadata.file_type().is_file() || !is_private(metadata) {
        return Err(NativeProfileAdapterError);
    }
    Ok(())
}

#[cfg(unix)]
fn is_private(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn is_private(_metadata: &fs::Metadata) -> bool {
    // ACL/privacy proof is a trusted bootstrap/platform obligation.
    true
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}

fn open_regular_file(path: &Path) -> Result<Option<File>, NativeProfileAdapterError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_file_metadata(&metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(NativeProfileAdapterError),
    }
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| NativeProfileAdapterError)?;
    let metadata = file.metadata().map_err(|_| NativeProfileAdapterError)?;
    validate_file_metadata(&metadata)?;
    Ok(Some(file))
}

fn validate_target_before_replace(path: &Path) -> Result<(), NativeProfileAdapterError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_file_metadata(&metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(NativeProfileAdapterError),
    }
}

fn ensure_absent(path: &Path) -> Result<(), NativeProfileAdapterError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(NativeProfileAdapterError),
    }
}

fn read_bounded(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(MAX_RUNTIME_PROFILE_DOCUMENT_BYTES + 1);
    reader
        .take((MAX_RUNTIME_PROFILE_DOCUMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

fn remove_owned_temp(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestFault {
    RootSync,
    ManagedDirectorySync,
    TempWrite,
    TempWriteAfterPartial,
    TempCreate,
    TempSync,
    Rename,
    DirectorySyncAfterRename,
    ConfirmFileSync,
    ConfirmDirectorySync,
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::native_publication_fence::NativePublicationFence;
    use crate::runtime_profile::{
        validate_canonical_runtime_profile_document, RuntimeProfileValidationError,
    };
    use serde_json::{json, Value};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "aurora-runtime-profile-file-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create test root");
            #[cfg(unix)]
            {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .expect("set private test root");
            }
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(root: &TestRoot, allow_python_full: bool) -> RuntimeProfileFilePersistence {
        RuntimeProfileFilePersistence::new(
            root.path(),
            RuntimeProfileValidationOptions { allow_python_full },
        )
    }

    fn profile_value() -> Value {
        json!({
            "version": 2,
            "activeProfileId": "local-a",
            "profiles": [{
                "version": 2,
                "id": "local-a",
                "label": "This device",
                "nodeMode": "mesh-node",
                "runtimeTier": "lightweight-ts",
                "localNode": {
                    "nodeName": "Aurora",
                    "stablePeerId": "stable-local-a",
                    "enabledCapabilityPacks": [],
                    "meshMembership": {
                        "signalingUrl": "wss://signal.example.test",
                        "webrtcProfile": {
                            "mode": "webrtc-only",
                            "appId": "aurora",
                            "room": "local-a",
                            "roomSecretRef": "ref:local-a",
                            "signalingBrokers": ["wss://signal.example.test"]
                        }
                    }
                }
            }]
        })
    }

    fn accepted(text: &str, allow_python_full: bool) -> ValidatedRuntimeProfileDocument {
        validate_canonical_runtime_profile_document(
            text,
            RuntimeProfileValidationOptions { allow_python_full },
        )
        .expect("profile fixture is valid")
    }

    fn document_path(root: &TestRoot) -> PathBuf {
        root.path().join(MANAGED_DIRECTORY).join(DOCUMENT_FILE)
    }

    fn write_profile(store: &RuntimeProfileFilePersistence, text: &str) {
        let document = accepted(text, store.options.allow_python_full);
        store.publish(&document).expect("publish profile");
    }

    fn with_spaces_to_length(mut text: String, target_len: usize) -> String {
        assert!(text.len() <= target_len);
        text.push_str(&" ".repeat(target_len - text.len()));
        assert_eq!(text.len(), target_len);
        text
    }

    fn python_full_profile_text() -> String {
        let mut value = profile_value();
        value["profiles"][0]["runtimeTier"] = json!("python-full");
        value.to_string()
    }

    #[test]
    fn absent_reads_do_not_create_managed_paths_or_touch_legacy_sentinels() {
        let root = TestRoot::new("absent");
        let legacy = root.path().join("legacy-profile.json");
        fs::write(&legacy, b"legacy bytes").expect("write legacy sentinel");
        let persistence = store(&root, false);

        assert!(!root.path().join(MANAGED_DIRECTORY).exists());
        assert!(matches!(persistence.read_confirmed(), Ok(None)));
        assert!(!root.path().join(MANAGED_DIRECTORY).exists());
        assert_eq!(fs::read(&legacy).expect("legacy sentinel"), b"legacy bytes");
    }

    #[test]
    fn missing_trusted_root_is_rejected_without_creating_it() {
        let parent = TestRoot::new("missing-root-parent");
        let missing = parent.path().join("not-created");
        let persistence = RuntimeProfileFilePersistence::new(
            &missing,
            RuntimeProfileValidationOptions::default(),
        );
        assert!(matches!(
            persistence.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert!(!missing.exists());
    }

    #[test]
    fn publish_and_reopen_preserve_exact_validated_bytes() {
        let root = TestRoot::new("exact-bytes");
        let persistence = store(&root, false);
        let text = format!("\n {} \n", profile_value());
        let document = accepted(&text, false);

        persistence.publish(&document).expect("publish exact bytes");
        assert_eq!(
            fs::read(document_path(&root)).expect("stored bytes"),
            text.as_bytes()
        );
        assert_eq!(
            persistence
                .read_confirmed()
                .expect("read confirmed")
                .expect("document present")
                .as_json(),
            text
        );

        let reopened = store(&root, false);
        assert_eq!(
            reopened
                .read_confirmed()
                .expect("reopen confirmed")
                .expect("document present")
                .as_json(),
            text
        );
    }

    #[tokio::test]
    async fn authorized_profile_publish_reserves_after_validation_and_preserves_exact_bytes() {
        let root = TestRoot::new("authorized");
        let persistence = store(&root, false);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let candidate_text = format!("\n {} \n", profile_value());
        let candidate = accepted(&candidate_text, false);
        let ticket = registration.issue_ticket().expect("ticket");

        persistence
            .publish_authorized(&fence, ticket, &candidate)
            .expect("authorized publication");
        let waiter = fence.revoke(&registration).expect("revoke after operation");

        assert_eq!(
            fs::read(document_path(&root)).expect("published bytes"),
            candidate_text.as_bytes()
        );
        assert_eq!(waiter.wait().await, Ok(()));
    }

    #[tokio::test]
    async fn revoked_profile_ticket_fails_before_any_filesystem_mutation() {
        let root = TestRoot::new("revoked-authorized");
        let persistence = store(&root, false);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let candidate = accepted(&profile_value().to_string(), false);
        let waiter = fence
            .revoke(&registration)
            .expect("revoke before publication");

        assert_eq!(
            persistence.publish_authorized(&fence, ticket, &candidate),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert!(!root.path().join(MANAGED_DIRECTORY).exists());
        assert_eq!(waiter.wait().await, Ok(()));
    }

    #[tokio::test]
    async fn authorized_indeterminate_profile_publish_stays_sticky_on_revocation() {
        let root = TestRoot::new("authorized-indeterminate");
        let persistence = store(&root, false);
        persistence.inject(TestFault::DirectorySyncAfterRename);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let candidate = accepted(&profile_value().to_string(), false);

        assert_eq!(
            persistence.publish_authorized(&fence, ticket, &candidate),
            Err(NativeProfilePublicationFailure::Indeterminate)
        );
        assert_eq!(
            registration.issue_ticket().err(),
            Some(crate::native_publication_fence::NativePublicationFenceError::RegistrationUnavailable),
            "publication doubt closes admission for this registration"
        );
        assert_eq!(
            fence
                .revoke(&registration)
                .expect("revoke after doubt")
                .wait()
                .await,
            Err(crate::native_publication_fence::NativePublicationFenceError::OperationFailed)
        );
    }

    #[tokio::test]
    async fn authorized_definite_profile_failure_is_recorded_before_revocation_completes() {
        let root = TestRoot::new("authorized-definite-failure");
        let persistence = store(&root, false);
        persistence.inject(TestFault::TempSync);
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let candidate = accepted(&profile_value().to_string(), false);

        assert_eq!(
            persistence.publish_authorized(&fence, ticket, &candidate),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert_eq!(
            fence
                .revoke(&registration)
                .expect("revoke failed operation")
                .wait()
                .await,
            Err(crate::native_publication_fence::NativePublicationFenceError::OperationFailed)
        );
        assert!(!document_path(&root).exists());
    }

    #[test]
    fn exact_128_kibibyte_document_is_accepted_and_oversized_disk_bytes_are_preserved() {
        let root = TestRoot::new("boundary");
        let persistence = store(&root, false);
        let exact = with_spaces_to_length(
            profile_value().to_string(),
            MAX_RUNTIME_PROFILE_DOCUMENT_BYTES,
        );
        let document = accepted(&exact, false);
        persistence.publish(&document).expect("publish exact limit");
        assert_eq!(
            persistence
                .read_confirmed()
                .expect("read exact limit")
                .expect("document present")
                .as_json(),
            exact
        );

        let oversized = format!("{exact} ");
        assert_eq!(oversized.len(), MAX_RUNTIME_PROFILE_DOCUMENT_BYTES + 1);
        fs::write(document_path(&root), oversized.as_bytes()).expect("write oversized bytes");
        assert!(matches!(
            persistence.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert_eq!(
            fs::read(document_path(&root)).expect("preserved oversized bytes"),
            oversized.as_bytes()
        );
    }

    #[test]
    fn mismatched_python_validation_options_reject_before_any_filesystem_side_effect() {
        let root = TestRoot::new("option-mismatch");
        let permissive = accepted(&python_full_profile_text(), true);
        let restrictive = store(&root, false);
        assert_eq!(
            restrictive.publish(&permissive),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert!(!root.path().join(MANAGED_DIRECTORY).exists());

        let permissive_store = store(&root, true);
        permissive_store
            .publish(&permissive)
            .expect("trusted package accepts");
        let persisted = fs::read(document_path(&root)).expect("Python profile bytes");
        assert_eq!(
            permissive_store
                .read_confirmed()
                .expect("read Python profile")
                .expect("document present")
                .as_json(),
            permissive.as_json()
        );
        assert!(matches!(
            restrictive.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert_eq!(
            fs::read(document_path(&root)).expect("unchanged Python bytes"),
            persisted
        );
    }

    #[test]
    fn invalid_existing_bytes_fail_closed_without_rewrite_or_legacy_fallback() {
        let root = TestRoot::new("invalid-existing");
        let persistence = store(&root, false);
        let original = accepted(&profile_value().to_string(), false);
        persistence.publish(&original).expect("initial publish");
        let path = document_path(&root);
        let mut inactive_invalid = profile_value();
        let mut inactive_profile = inactive_invalid["profiles"][0].clone();
        inactive_profile["id"] = json!("inactive");
        inactive_profile["localNode"]["stablePeerId"] = json!("stable-inactive");
        inactive_profile["localNode"]["primaryLanguage"] = json!("auto");
        inactive_invalid["profiles"]
            .as_array_mut()
            .expect("profiles array")
            .push(inactive_profile);
        let valid_text = profile_value().to_string();
        let invalid_cases = vec![
            b"{malformed".to_vec(),
            br#"{"version":1,"activeProfileId":null,"profiles":[]}"#.to_vec(),
            br#"{"version":2,"version":2,"activeProfileId":null,"profiles":[]}"#.to_vec(),
            br#"{"version":2,"\u0076ersion":2,"activeProfileId":null,"profiles":[]}"#.to_vec(),
            br#"{"version":2,"activeProfileId":null,"profiles":[],"secret":"keep private"}"#
                .to_vec(),
            inactive_invalid.to_string().into_bytes(),
            format!("{valid_text} true").into_bytes(),
            b"\xff".to_vec(),
        ];
        for invalid in &invalid_cases {
            fs::write(&path, invalid).expect("write invalid fixture");
            let error = persistence
                .read_confirmed()
                .expect_err("invalid profile must be rejected");
            assert_eq!(error, NativeProfileAdapterError);
            assert!(!format!("{error:?}").contains("keep private"));
            assert_eq!(
                fs::read(&path).expect("invalid bytes remain"),
                invalid.as_slice()
            );
        }
        assert_eq!(
            NativeProfileAdapterError.to_string(),
            "native profile state is unavailable"
        );
    }

    #[test]
    fn prepublication_failures_preserve_prior_document_and_are_definite() {
        for fault in [
            TestFault::RootSync,
            TestFault::ManagedDirectorySync,
            TestFault::TempCreate,
            TestFault::TempWrite,
            TestFault::TempWriteAfterPartial,
            TestFault::TempSync,
        ] {
            let root = TestRoot::new("prepublish");
            let persistence = store(&root, false);
            let original_text = profile_value().to_string();
            write_profile(&persistence, &original_text);
            let original_bytes = fs::read(document_path(&root)).expect("old bytes");
            let mut replacement_value = profile_value();
            replacement_value["profiles"][0]["label"] = json!("Updated label");
            let replacement = accepted(&replacement_value.to_string(), false);

            persistence.inject(fault);
            assert_eq!(
                persistence.publish(&replacement),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            assert_eq!(
                fs::read(document_path(&root)).expect("old target intact"),
                original_bytes
            );
            assert_eq!(
                fs::read_dir(root.path().join(MANAGED_DIRECTORY))
                    .expect("managed entries")
                    .count(),
                1,
                "failure must not leave a temporary file"
            );
        }
    }

    #[test]
    fn private_managed_directories_and_created_files_have_private_unix_modes() {
        let root = TestRoot::new("private-modes");
        let persistence = store(&root, false);
        write_profile(&persistence, &profile_value().to_string());
        #[cfg(unix)]
        {
            let directory_mode = fs::metadata(root.path().join(MANAGED_DIRECTORY))
                .expect("managed directory")
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(document_path(&root))
                .expect("profile file")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(directory_mode & 0o077, 0);
            assert_eq!(file_mode & 0o077, 0);
        }
    }

    #[test]
    fn symlink_and_nonprivate_filesystem_shapes_fail_without_modifying_targets() {
        let parent = TestRoot::new("shape-parent");
        let outside = parent.path().join("outside");
        fs::create_dir(&outside).expect("outside directory");
        let outside_sentinel = outside.join("sentinel");
        fs::write(&outside_sentinel, b"outside remains untouched").expect("outside sentinel");
        let persistence = store(&parent, false);
        let valid = accepted(&profile_value().to_string(), false);
        persistence.publish(&valid).expect("initial profile");
        let original_bytes = fs::read(document_path(&parent)).expect("initial exact bytes");
        let mut changed_value = profile_value();
        changed_value["profiles"][0]["label"] = json!("Changed profile");
        let changed_profile = accepted(&changed_value.to_string(), false);

        let relative = RuntimeProfileFilePersistence::new(
            PathBuf::new(),
            RuntimeProfileValidationOptions::default(),
        );
        assert!(matches!(
            relative.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert_eq!(
            relative.publish(&valid),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );

        let regular_root = parent.path().join("regular-root");
        fs::write(&regular_root, b"not a directory").expect("regular root file");
        let regular_root_store = RuntimeProfileFilePersistence::new(
            regular_root.as_path(),
            RuntimeProfileValidationOptions::default(),
        );
        assert!(matches!(
            regular_root_store.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert_eq!(
            regular_root_store.publish(&valid),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert_eq!(
            fs::read(&regular_root).expect("root sentinel"),
            b"not a directory"
        );

        let linked_root = parent.path().join("linked-root");
        #[cfg(unix)]
        std::os::unix::fs::symlink(parent.path(), &linked_root).expect("root symlink");
        #[cfg(unix)]
        assert!(matches!(
            RuntimeProfileFilePersistence::new(
                linked_root.as_path(),
                RuntimeProfileValidationOptions::default()
            )
            .read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        #[cfg(unix)]
        assert_eq!(
            RuntimeProfileFilePersistence::new(
                linked_root.as_path(),
                RuntimeProfileValidationOptions::default()
            )
            .publish(&changed_profile),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert_eq!(
            fs::read(document_path(&parent)).expect("root target unchanged"),
            original_bytes
        );
        assert_eq!(
            fs::read(&outside_sentinel).expect("outside sentinel preserved"),
            b"outside remains untouched"
        );

        #[cfg(unix)]
        {
            fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o755))
                .expect("make root visible");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o700))
                .expect("restore root mode");

            let managed = parent.path().join(MANAGED_DIRECTORY);
            fs::set_permissions(&managed, fs::Permissions::from_mode(0o755))
                .expect("make managed directory visible");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            let new_profile = accepted(&profile_value().to_string(), false);
            assert_eq!(
                persistence.publish(&new_profile),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            fs::set_permissions(&managed, fs::Permissions::from_mode(0o700))
                .expect("restore managed directory mode");

            let path = document_path(&parent);
            let stored = fs::read(&path).expect("stored document");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
                .expect("make target visible");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            let replacement = accepted(&profile_value().to_string(), false);
            assert_eq!(
                persistence.publish(&replacement),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .expect("restore target mode");
            assert_eq!(fs::read(&path).expect("unchanged target"), stored);

            let parked = parent.path().join("managed-parked");
            fs::rename(&managed, &parked).expect("park managed directory");
            std::os::unix::fs::symlink(&outside, &managed).expect("managed symlink");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            assert_eq!(
                persistence.publish(&new_profile),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            assert_eq!(
                fs::read(&outside_sentinel).expect("outside sentinel preserved"),
                b"outside remains untouched"
            );
            fs::remove_file(&managed).expect("remove test symlink");
            fs::rename(&parked, &managed).expect("restore managed directory");

            let parked_file = parent.path().join("document-parked");
            fs::rename(&path, &parked_file).expect("park file");
            std::os::unix::fs::symlink(&parked_file, &path).expect("file symlink");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            assert_eq!(
                persistence.publish(&replacement),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            assert_eq!(
                fs::read(&parked_file).expect("symlink target preserved"),
                stored
            );
            fs::remove_file(&path).expect("remove symlink");
            fs::rename(&parked_file, &path).expect("restore file");
            assert_eq!(fs::read(&path).expect("target preserved"), stored);

            fs::rename(&path, &parked_file).expect("park file for directory check");
            fs::create_dir(&path).expect("target directory");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("private target directory");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            assert_eq!(
                persistence.publish(&replacement),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            fs::remove_dir(&path).expect("remove test target directory");
            fs::rename(&parked_file, &path).expect("restore after target directory check");
            assert_eq!(fs::read(&path).expect("target preserved"), stored);

            fs::rename(&path, &parked_file).expect("park file for socket check");
            let socket = std::os::unix::net::UnixListener::bind(&path).expect("bind socket");
            assert!(matches!(
                persistence.read_confirmed(),
                Err(NativeProfileAdapterError)
            ));
            assert_eq!(
                persistence.publish(&replacement),
                Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
            );
            drop(socket);
            fs::remove_file(&path).expect("remove socket");
            fs::rename(&parked_file, &path).expect("restore file after socket check");
            assert_eq!(fs::read(&path).expect("target preserved"), stored);
        }
    }

    #[test]
    fn rename_and_postrename_sync_failures_are_indeterminate_then_explicitly_confirmed() {
        let root = TestRoot::new("indeterminate");
        let persistence = store(&root, false);
        let initial_text = profile_value().to_string();
        write_profile(&persistence, &initial_text);
        let old = fs::read(document_path(&root)).expect("old bytes");
        let mut updated_value = profile_value();
        updated_value["profiles"][0]["label"] = json!("New label");
        let updated = accepted(&updated_value.to_string(), false);

        persistence.inject(TestFault::Rename);
        assert_eq!(
            persistence.publish(&updated),
            Err(NativeProfilePublicationFailure::Indeterminate)
        );
        assert_eq!(
            fs::read(document_path(&root)).expect("rename fault leaves old"),
            old
        );
        assert_eq!(
            persistence
                .read_confirmed()
                .expect("explicit old confirmation")
                .expect("old document confirmed")
                .as_json(),
            initial_text
        );

        persistence.inject(TestFault::DirectorySyncAfterRename);
        assert_eq!(
            persistence.publish(&updated),
            Err(NativeProfilePublicationFailure::Indeterminate)
        );
        assert_eq!(
            persistence
                .read_confirmed()
                .expect("explicit current confirmation")
                .expect("current document confirmed")
                .as_json(),
            updated.as_json()
        );
    }

    #[test]
    fn confirmation_sync_failures_do_not_return_visible_document_or_absence() {
        let root = TestRoot::new("confirmation-failure");
        let persistence = store(&root, false);
        let document = accepted(&profile_value().to_string(), false);
        persistence.publish(&document).expect("publish");

        persistence.inject(TestFault::ConfirmFileSync);
        assert!(matches!(
            persistence.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        persistence.inject(TestFault::ConfirmDirectorySync);
        assert!(matches!(
            persistence.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));

        let absent_root = TestRoot::new("absent-confirmation-failure");
        let absent_store = store(&absent_root, false);
        absent_store.inject(TestFault::RootSync);
        assert!(matches!(
            absent_store.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert!(!absent_root.path().join(MANAGED_DIRECTORY).exists());
    }

    #[test]
    fn missing_target_under_existing_directory_is_confirmed_without_defaults() {
        let root = TestRoot::new("absent-target");
        let directory = root.path().join(MANAGED_DIRECTORY);
        fs::create_dir(&directory).expect("existing managed directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private managed directory");
        let sibling = root.path().join("unrelated-legacy-record");
        fs::write(&sibling, b"do not alter").expect("legacy sibling");
        let persistence = store(&root, false);

        persistence.inject(TestFault::ConfirmDirectorySync);
        assert!(matches!(
            persistence.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert!(!directory.join(DOCUMENT_FILE).exists());
        assert_eq!(
            fs::read(&sibling).expect("sibling preserved"),
            b"do not alter"
        );
        assert!(matches!(persistence.read_confirmed(), Ok(None)));
        assert!(!directory.join(DOCUMENT_FILE).exists());
        assert_eq!(
            fs::read(&sibling).expect("sibling still preserved"),
            b"do not alter"
        );
    }

    #[test]
    fn temp_collisions_and_lookalikes_are_not_overwritten_or_broadly_removed() {
        let root = TestRoot::new("temp-collision");
        let persistence = store(&root, false);
        let directory = root.path().join(MANAGED_DIRECTORY);
        fs::create_dir(&directory).expect("managed directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private directory");
        let collision = directory.join(format!("{TEMP_PREFIX}{}-1", std::process::id()));
        let lookalike = directory.join(format!("{TEMP_PREFIX}bad-name"));
        fs::write(&collision, b"collision occupant").expect("collision file");
        fs::write(&lookalike, b"lookalike occupant").expect("lookalike file");

        let document = accepted(&profile_value().to_string(), false);
        persistence
            .publish(&document)
            .expect("retry after collision");
        assert_eq!(
            fs::read(collision).expect("collision intact"),
            b"collision occupant"
        );
        assert_eq!(
            fs::read(lookalike).expect("lookalike intact"),
            b"lookalike occupant"
        );

        let exhausted_root = TestRoot::new("collision-exhaustion");
        let exhausted = store(&exhausted_root, false);
        let exhausted_dir = exhausted_root.path().join(MANAGED_DIRECTORY);
        fs::create_dir(&exhausted_dir).expect("managed directory");
        #[cfg(unix)]
        fs::set_permissions(&exhausted_dir, fs::Permissions::from_mode(0o700))
            .expect("private directory");
        for id in 1..=MAX_TEMP_NAME_ATTEMPTS {
            fs::write(
                exhausted_dir.join(format!("{TEMP_PREFIX}{}-{id}", std::process::id())),
                b"unrelated occupant",
            )
            .expect("create collision occupant");
        }
        assert_eq!(
            exhausted.publish(&document),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert!(!exhausted_dir.join(DOCUMENT_FILE).exists());
        assert_eq!(
            fs::read_dir(&exhausted_dir).expect("entries").count(),
            MAX_TEMP_NAME_ATTEMPTS
        );

        let counter_root = TestRoot::new("counter-exhaustion");
        let counter_exhausted = store(&counter_root, false);
        counter_exhausted
            .next_temp_id
            .store(u64::MAX, Ordering::Relaxed);
        assert_eq!(
            counter_exhausted.publish(&document),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
        assert!(!counter_root
            .path()
            .join(MANAGED_DIRECTORY)
            .join(DOCUMENT_FILE)
            .exists());
    }

    #[test]
    fn invalid_profile_errors_are_fixed_and_do_not_include_source_bytes() {
        let root = TestRoot::new("redaction");
        let persistence = store(&root, false);
        let secret_text = r#"{"private":"source secret"}"#;
        fs::create_dir(root.path().join(MANAGED_DIRECTORY)).expect("managed directory");
        fs::set_permissions(
            root.path().join(MANAGED_DIRECTORY),
            fs::Permissions::from_mode(0o700),
        )
        .expect("private managed directory");
        fs::write(document_path(&root), secret_text).expect("write malformed source");
        fs::set_permissions(document_path(&root), fs::Permissions::from_mode(0o600))
            .expect("private malformed profile bytes");
        let bytes_before = fs::read(document_path(&root)).expect("source bytes");
        let error = persistence
            .read_confirmed()
            .expect_err("malformed source rejected");
        assert_eq!(error.to_string(), "native profile state is unavailable");
        assert!(!format!("{error:?}").contains("source secret"));
        assert_eq!(
            fs::read(document_path(&root)).expect("source remains"),
            bytes_before
        );
        let invalid = validate_canonical_runtime_profile_document(
            secret_text,
            RuntimeProfileValidationOptions::default(),
        )
        .expect_err("source is not a valid profile");
        assert_eq!(invalid, RuntimeProfileValidationError);
    }
}

#[cfg(all(test, windows))]
mod unsupported_platform_tests {
    use super::*;

    #[test]
    fn directory_sync_failure_is_closed_without_claiming_absence_or_publication() {
        let root = tempfile::tempdir().expect("temporary root");
        assert!(sync_directory(root.path()).is_err());
        let persistence = RuntimeProfileFilePersistence::new(
            root.path(),
            RuntimeProfileValidationOptions::default(),
        );
        assert!(matches!(
            persistence.read_confirmed(),
            Err(NativeProfileAdapterError)
        ));
        assert_eq!(
            persistence.publish(
                &crate::runtime_profile::validate_canonical_runtime_profile_document(
                    r#"{"version":2,"activeProfileId":null,"profiles":[]}"#,
                    RuntimeProfileValidationOptions::default(),
                )
                .expect("empty canonical profile")
            ),
            Err(NativeProfilePublicationFailure::DefinitelyNotPublished)
        );
    }
}
