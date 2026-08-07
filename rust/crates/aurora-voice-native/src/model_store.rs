//! Filesystem-backed native model-pack store.

use async_trait::async_trait;
use aurora_voice_engine::{
    apply_lifecycle_event, can_activate, create_lifecycle_snapshot, file_storage_key,
    scope_matches_manifest, ActivePackIdentity, DownloadTask, ImmutableModelFile, InstallEvent,
    InstallState, LifecycleSnapshot, ModelPackError, ModelPackFile, ModelStore, ModelStoreScope,
    SelectedVariant, StoreStatus, StoredFile, VerifiedManifest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const STATE_SCHEMA_VERSION: u32 = 2;
const STATE_FILE: &str = "model-store.json";
const STATE_TMP_PREFIX: &str = "model-store.json.tmp.";

/// Durable native model store configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeModelStoreConfig {
    /// Root directory for state, staging files, and content-addressed blobs.
    pub root: PathBuf,
    /// Optional byte quota covering promoted files plus in-flight reservations.
    pub bytes_available: Option<u64>,
}

impl NativeModelStoreConfig {
    /// Build a config rooted at a platform-owned app-data directory.
    pub fn new(root: impl Into<PathBuf>, bytes_available: Option<u64>) -> Self {
        Self {
            root: root.into(),
            bytes_available,
        }
    }
}

/// Open immutable native model file. Debug output intentionally excludes paths.
pub struct NativeImmutableModelFile {
    metadata: ImmutableModelFile,
    file: File,
}

impl NativeImmutableModelFile {
    /// Product-safe immutable file metadata.
    pub fn metadata(&self) -> &ImmutableModelFile {
        &self.metadata
    }

    /// Open OS file handle for engine adapters.
    pub fn file(&self) -> &File {
        &self.file
    }
}

impl fmt::Debug for NativeImmutableModelFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeImmutableModelFile")
            .field("storage_key", &self.metadata.storage_key)
            .field("sha256", &self.metadata.sha256)
            .field("byte_size", &self.metadata.byte_size)
            .field("variant_id", &self.metadata.variant_id)
            .finish_non_exhaustive()
    }
}

/// Filesystem-backed implementation of the selected-variant model store.
pub struct NativeModelStore {
    config: NativeModelStoreConfig,
    state: StoreState,
    fail_next_persist: bool,
}

impl fmt::Debug for NativeModelStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeModelStore")
            .field("bytes_available", &self.config.bytes_available)
            .field("state", &self.state.redacted())
            .finish_non_exhaustive()
    }
}

impl NativeModelStore {
    /// Open the store, creating directories and recovering stale temp files.
    pub fn open(config: NativeModelStoreConfig) -> Result<Self, ModelPackError> {
        std::fs::create_dir_all(state_dir(&config.root)).map_err(|_| store("open"))?;
        std::fs::create_dir_all(staging_dir(&config.root)).map_err(|_| store("open"))?;
        std::fs::create_dir_all(blob_dir(&config.root)).map_err(|_| store("open"))?;
        recover_state_temps(&config.root)?;
        let mut state = read_state(&config.root)?;
        state.bytes_available = config.bytes_available;
        recover_staging(&config.root, &state)?;
        recover_blobs(&config.root, &mut state)?;
        let mut store = Self {
            config,
            state,
            fail_next_persist: false,
        };
        store.persist_current()?;
        Ok(store)
    }

    /// Return the Windows-safe staging path for a selected storage key.
    pub fn staging_path(&self, storage_key: &str) -> PathBuf {
        staging_path(&self.config.root, storage_key)
    }

    /// Revoke a pack locally and withdraw active/rollback readiness.
    pub fn revoke_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        let mut next = self.state.clone();
        next.revoked_pack_ids.insert(pack_id.to_owned());
        next.active.retain(|_, active| active.pack_id != pack_id);
        next.rollback
            .retain(|_, rollback| rollback.pack_id != pack_id);
        reconcile_lifecycle_activity(&mut next)?;
        self.commit_state(next)
    }

    /// Open a verified immutable model file handle for native engines.
    pub fn open_native_file(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<NativeImmutableModelFile, ModelPackError> {
        let metadata = self.lookup_immutable(selection, file_id)?;
        let path = blob_path(&self.config.root, &metadata.sha256);
        let file = File::open(&path).map_err(|_| store("missing_file"))?;
        let actual = inspect_file(&path)?;
        if actual.byte_size != metadata.byte_size || actual.sha256 != metadata.sha256 {
            return Err(store("corrupt"));
        }
        Ok(NativeImmutableModelFile { metadata, file })
    }

    #[cfg(test)]
    fn inject_persistence_failure(&mut self) {
        self.fail_next_persist = true;
    }

    fn used_bytes(&self) -> Result<u64, ModelPackError> {
        physical_file_bytes(&self.state)
    }

    fn reserved_bytes(&self) -> Result<u64, ModelPackError> {
        physical_reserved_bytes(&self.state)
    }

    fn ensure_reservation_quota(&self, sha256: &str, byte_size: u64) -> Result<(), ModelPackError> {
        let required = physical_total_after_reservation(&self.state, sha256, byte_size)?;
        if self
            .config
            .bytes_available
            .is_some_and(|available| required > available)
        {
            return Err(ModelPackError::QuotaExceeded);
        }
        Ok(())
    }

    fn require_pack_available(&self, pack_id: &str) -> Result<(), ModelPackError> {
        if self.state.revoked_pack_ids.contains(pack_id) {
            return Err(store("revoked"));
        }
        Ok(())
    }

    fn lookup_immutable(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError> {
        if !selection.file_ids().contains(file_id) {
            return Err(store("selection"));
        }
        self.require_pack_available(selection.pack_id())?;
        let key = file_storage_key(
            selection.pack_id(),
            selection.pack_version(),
            selection.variant_id(),
            file_id,
        );
        let file = self.state.files.get(&key).ok_or(store("missing_file"))?;
        if file.pack_id != selection.pack_id()
            || file.pack_version != selection.pack_version()
            || file.variant_id != selection.variant_id()
            || file.file_id != file_id
            || file.state != InstallState::Ready
        {
            return Err(store("selection"));
        }
        Ok(ImmutableModelFile {
            storage_key: file.storage_key.clone(),
            sha256: file.sha256.clone(),
            byte_size: file.byte_size,
            variant_id: file.variant_id.clone(),
        })
    }

    fn persist_current(&mut self) -> Result<(), ModelPackError> {
        let state = self.state.clone();
        self.commit_state(state)
    }

    fn commit_state(&mut self, state: StoreState) -> Result<(), ModelPackError> {
        if self.fail_next_persist {
            self.fail_next_persist = false;
            return Err(store("persistence"));
        }
        write_state_atomic(&self.config.root, &state)?;
        self.state = state;
        Ok(())
    }

    #[cfg(test)]
    fn rollback_identity(&self, scope: &ModelStoreScope) -> Option<&ActivePackIdentity> {
        self.state.rollback.get(&scope_map_key(scope))
    }
}

#[async_trait(?Send)]
impl ModelStore for NativeModelStore {
    async fn status(&self) -> Result<StoreStatus, ModelPackError> {
        let used = self.used_bytes()?;
        let reserved = self.reserved_bytes()?;
        Ok(StoreStatus {
            bytes_used: used,
            bytes_reserved: reserved,
            bytes_available: self.config.bytes_available,
            persistent: self.state.persistent,
        })
    }

    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        Ok(self
            .state
            .lifecycles
            .get(&lifecycle_map_key(pack_id, pack_version, variant_id))
            .cloned())
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        let mut next = self.state.clone();
        next.lifecycles.insert(
            lifecycle_map_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
            snapshot,
        );
        self.commit_state(next)
    }

    async fn reserve_file(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
        file: &ModelPackFile,
    ) -> Result<DownloadTask, ModelPackError> {
        if !selection.belongs_to(manifest) || !selection.file_ids().contains(&file.file_id) {
            return Err(store("selection"));
        }
        if file
            .revocation
            .as_ref()
            .is_some_and(|revocation| revocation.revoked)
        {
            return Err(store("revoked"));
        }
        self.require_pack_available(&manifest.manifest().pack_id)?;
        let storage_key = file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        );
        if let Some(existing) = self.state.files.get(&storage_key) {
            if existing.sha256 == file.sha256 && existing.byte_size == file.byte_size {
                return Ok(DownloadTask {
                    storage_key,
                    pack_id: existing.pack_id.clone(),
                    pack_version: existing.pack_version.clone(),
                    file_id: existing.file_id.clone(),
                    url: file.url.clone(),
                    expected_sha256: file.sha256.clone(),
                    expected_bytes: file.byte_size,
                    variant_id: existing.variant_id.clone(),
                });
            }
            return Err(store("corrupt"));
        }
        if let Some(existing) = self.state.reservations.get(&storage_key) {
            if existing.pack_id == manifest.manifest().pack_id
                && existing.pack_version == manifest.manifest().pack_version
                && existing.file_id == file.file_id
                && existing.variant_id == selection.variant_id()
                && existing.url == file.url
                && existing.expected_sha256 == file.sha256
                && existing.expected_bytes == file.byte_size
            {
                return Ok(existing.clone());
            }
            return Err(store("reservation"));
        }
        self.ensure_reservation_quota(&file.sha256, file.byte_size)?;
        let task = DownloadTask {
            storage_key: storage_key.clone(),
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            file_id: file.file_id.clone(),
            url: file.url.clone(),
            expected_sha256: file.sha256.clone(),
            expected_bytes: file.byte_size,
            variant_id: selection.variant_id().to_owned(),
        };
        let mut next = self.state.clone();
        next.reservations.insert(storage_key, task.clone());
        self.commit_state(next)?;
        Ok(task)
    }

    async fn resume_metadata(
        &self,
        storage_key: &str,
    ) -> Result<Option<DownloadTask>, ModelPackError> {
        Ok(self.state.reservations.get(storage_key).cloned())
    }

    async fn promote_file(
        &mut self,
        storage_key: &str,
        sha256: &str,
        byte_size: u64,
    ) -> Result<StoredFile, ModelPackError> {
        let task = self
            .state
            .reservations
            .get(storage_key)
            .cloned()
            .ok_or(store("reservation"))?;
        if task.expected_sha256 != sha256 {
            return Err(store("hash"));
        }
        if task.expected_bytes != byte_size {
            return Err(store("size"));
        }
        let staged = staging_path(&self.config.root, storage_key);
        let blob = blob_path(&self.config.root, &task.expected_sha256);
        let actual = if blob.exists() {
            let existing = inspect_file(&blob)?;
            if existing.sha256 != task.expected_sha256 || existing.byte_size != task.expected_bytes
            {
                return Err(store("corrupt"));
            }
            if staged.exists() {
                let _ = std::fs::remove_file(&staged);
            }
            existing
        } else {
            inspect_file(&staged)?
        };
        if actual.sha256 != task.expected_sha256 {
            return Err(store("hash"));
        }
        if actual.byte_size != task.expected_bytes {
            return Err(store("size"));
        }
        self.ensure_reservation_quota(&task.expected_sha256, task.expected_bytes)?;
        if blob.exists() {
            let existing = inspect_file(&blob)?;
            if existing.sha256 != actual.sha256 || existing.byte_size != actual.byte_size {
                return Err(store("corrupt"));
            }
            match std::fs::remove_file(&staged) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(store("promote")),
            }
        } else {
            std::fs::rename(&staged, &blob).map_err(|_| store("promote"))?;
            fsync_parent(&blob)?;
        }

        let stored = StoredFile {
            storage_key: storage_key.to_owned(),
            pack_id: task.pack_id,
            pack_version: task.pack_version,
            file_id: task.file_id,
            variant_id: task.variant_id,
            sha256: actual.sha256,
            byte_size: actual.byte_size,
            state: InstallState::Ready,
            stored_at: now_epoch_seconds(),
        };
        let mut next = self.state.clone();
        next.reservations.remove(storage_key);
        next.files.insert(storage_key.to_owned(), stored.clone());
        self.commit_state(next)?;
        Ok(stored)
    }

    async fn activate_pack(
        &mut self,
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(store("selection"));
        }
        scope_matches_selection(&scope, manifest, selection)?;
        self.require_pack_available(&manifest.manifest().pack_id)?;
        for file in manifest
            .manifest()
            .files
            .iter()
            .filter(|file| selection.file_ids().contains(&file.file_id))
        {
            if file
                .revocation
                .as_ref()
                .is_some_and(|revocation| revocation.revoked)
            {
                return Err(store("revoked"));
            }
            let key = file_storage_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
                &file.file_id,
            );
            let stored = self.state.files.get(&key).ok_or(store("missing_file"))?;
            let actual = inspect_file(&blob_path(&self.config.root, &stored.sha256))?;
            if stored.sha256 != file.sha256
                || stored.byte_size != file.byte_size
                || actual.sha256 != file.sha256
                || actual.byte_size != file.byte_size
            {
                return Err(store("corrupt"));
            }
        }

        let lifecycle_key = lifecycle_map_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
        );
        let current = self
            .state
            .lifecycles
            .get(&lifecycle_key)
            .cloned()
            .unwrap_or_else(|| {
                create_lifecycle_snapshot(
                    manifest.manifest().pack_id.clone(),
                    manifest.manifest().pack_version.clone(),
                    selection.variant_id().to_owned(),
                    now_epoch_seconds(),
                    InstallState::Ready,
                )
            });
        if !can_activate(&current) {
            return Err(store("not_ready"));
        }

        let mut next = self.state.clone();
        let requested = ActivePackIdentity {
            scope: scope.clone(),
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            variant_id: selection.variant_id().to_owned(),
        };
        let scope_key = scope_map_key(&scope);
        if let Some(previous) = next.active.get(&scope_key).cloned() {
            if !same_selection(&previous, &requested) {
                next.rollback.insert(scope_key.clone(), previous);
            }
        }
        next.active.insert(scope_key, requested.clone());
        next.lifecycles.insert(lifecycle_key.clone(), current);
        reconcile_lifecycle_activity(&mut next)?;
        let active = next
            .lifecycles
            .get(&lifecycle_key)
            .cloned()
            .ok_or(store("lifecycle"))?;
        self.commit_state(next)?;
        Ok(active)
    }

    async fn rollback_active(
        &mut self,
        scope: ModelStoreScope,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        let scope_key = scope_map_key(&scope);
        let Some(rollback) = self.state.rollback.get(&scope_key).cloned() else {
            return Ok(None);
        };
        if rollback.scope != scope {
            return Err(store("scope"));
        }
        self.require_pack_available(&rollback.pack_id)?;
        if !pack_has_files(&self.config.root, &self.state, &rollback)? {
            return Err(store("rollback"));
        }
        let rollback_key = lifecycle_map_key(
            &rollback.pack_id,
            &rollback.pack_version,
            &rollback.variant_id,
        );
        let snapshot = self
            .state
            .lifecycles
            .get(&rollback_key)
            .cloned()
            .ok_or(store("rollback"))?;
        if !can_activate(&snapshot) {
            return Err(store("rollback"));
        }
        let mut next = self.state.clone();
        next.active.insert(scope_key.clone(), rollback);
        next.rollback.remove(&scope_key);
        reconcile_lifecycle_activity(&mut next)?;
        let active = next
            .lifecycles
            .get(&rollback_key)
            .cloned()
            .ok_or(store("rollback"))?;
        self.commit_state(next)?;
        Ok(Some(active))
    }

    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        let mut next = self.state.clone();
        let removed_hashes: BTreeSet<String> = next
            .files
            .values()
            .filter(|file| file.pack_id == pack_id)
            .map(|file| file.sha256.clone())
            .collect();
        next.files.retain(|_, file| file.pack_id != pack_id);
        next.reservations
            .retain(|_, task| task.pack_id.as_str() != pack_id);
        next.lifecycles
            .retain(|key, _| !key.starts_with(&format!("{}:", safe_name(pack_id))));
        next.active.retain(|_, active| active.pack_id != pack_id);
        next.rollback
            .retain(|_, rollback| rollback.pack_id != pack_id);
        next.revoked_pack_ids.remove(pack_id);
        reconcile_lifecycle_activity(&mut next)?;
        self.commit_state(next)?;
        for hash in removed_hashes {
            if !self.state.files.values().any(|file| file.sha256 == hash)
                && !self
                    .state
                    .reservations
                    .values()
                    .any(|task| task.expected_sha256 == hash)
            {
                let _ = std::fs::remove_file(blob_path(&self.config.root, &hash));
            }
        }
        recover_staging(&self.config.root, &self.state)?;
        Ok(())
    }

    async fn active_pack(
        &self,
        scope: ModelStoreScope,
    ) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        let scope_key = scope_map_key(&scope);
        if let Some(active) = self.state.active.get(&scope_key) {
            if active.scope != scope {
                return Err(store("scope"));
            }
            self.require_pack_available(&active.pack_id)?;
            if !pack_has_files(&self.config.root, &self.state, active)? {
                return Err(store("corrupt"));
            }
        }
        Ok(self.state.active.get(&scope_key).cloned())
    }

    async fn open_immutable_file(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError> {
        Ok(self.open_native_file(selection, file_id)?.metadata)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoreState {
    schema_version: u32,
    bytes_available: Option<u64>,
    persistent: bool,
    files: BTreeMap<String, StoredFile>,
    reservations: BTreeMap<String, DownloadTask>,
    lifecycles: BTreeMap<String, LifecycleSnapshot>,
    active: BTreeMap<String, ActivePackIdentity>,
    rollback: BTreeMap<String, ActivePackIdentity>,
    revoked_pack_ids: BTreeSet<String>,
}

impl Default for StoreState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            bytes_available: None,
            persistent: true,
            files: BTreeMap::new(),
            reservations: BTreeMap::new(),
            lifecycles: BTreeMap::new(),
            active: BTreeMap::new(),
            rollback: BTreeMap::new(),
            revoked_pack_ids: BTreeSet::new(),
        }
    }
}

impl StoreState {
    fn redacted(&self) -> RedactedState {
        RedactedState {
            file_count: self.files.len(),
            reservation_count: self.reservations.len(),
            lifecycle_count: self.lifecycles.len(),
            active_count: self.active.len(),
            rollback_count: self.rollback.len(),
            revoked_count: self.revoked_pack_ids.len(),
        }
    }
}

struct RedactedState {
    file_count: usize,
    reservation_count: usize,
    lifecycle_count: usize,
    active_count: usize,
    rollback_count: usize,
    revoked_count: usize,
}

impl fmt::Debug for RedactedState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoreState")
            .field("file_count", &self.file_count)
            .field("reservation_count", &self.reservation_count)
            .field("lifecycle_count", &self.lifecycle_count)
            .field("active_count", &self.active_count)
            .field("rollback_count", &self.rollback_count)
            .field("revoked_count", &self.revoked_count)
            .finish()
    }
}

#[derive(Debug)]
struct FileInspection {
    byte_size: u64,
    sha256: String,
}

fn state_dir(root: &Path) -> PathBuf {
    root.join("state")
}

fn staging_dir(root: &Path) -> PathBuf {
    root.join("staging")
}

fn blob_dir(root: &Path) -> PathBuf {
    root.join("blobs").join("sha256")
}

fn state_path(root: &Path) -> PathBuf {
    state_dir(root).join(STATE_FILE)
}

fn staging_path(root: &Path, storage_key: &str) -> PathBuf {
    staging_dir(root).join(format!("{}.part", safe_name(storage_key)))
}

fn blob_path(root: &Path, sha256: &str) -> PathBuf {
    blob_dir(root).join(sha256)
}

fn safe_name(value: &str) -> String {
    sha256_hex(value.as_bytes())
}

fn lifecycle_map_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    format!(
        "{}:{}:{}",
        safe_name(pack_id),
        safe_name(pack_version),
        safe_name(variant_id)
    )
}

fn scope_map_key(scope: &ModelStoreScope) -> String {
    format!("{}:{}", scope.task().as_str(), safe_name(scope.slot_id()))
}

fn same_selection(left: &ActivePackIdentity, right: &ActivePackIdentity) -> bool {
    left.pack_id == right.pack_id
        && left.pack_version == right.pack_version
        && left.variant_id == right.variant_id
}

fn scope_matches_selection(
    scope: &ModelStoreScope,
    manifest: &VerifiedManifest,
    selection: &SelectedVariant,
) -> Result<(), ModelPackError> {
    scope_matches_manifest(scope, manifest)?;
    if manifest
        .manifest()
        .files
        .iter()
        .any(|file| selection.file_ids().contains(&file.file_id) && file.task == scope.task())
    {
        Ok(())
    } else {
        Err(store("scope_task"))
    }
}

fn identity_lifecycle_key(identity: &ActivePackIdentity) -> String {
    lifecycle_map_key(
        &identity.pack_id,
        &identity.pack_version,
        &identity.variant_id,
    )
}

fn physical_file_bytes(state: &StoreState) -> Result<u64, ModelPackError> {
    let mut blobs = BTreeMap::<String, u64>::new();
    for file in state.files.values() {
        insert_blob_charge(&mut blobs, &file.sha256, file.byte_size)?;
    }
    checked_sum(blobs.values().copied())
}

fn physical_reserved_bytes(state: &StoreState) -> Result<u64, ModelPackError> {
    let promoted: BTreeSet<&str> = state
        .files
        .values()
        .map(|file| file.sha256.as_str())
        .collect();
    let mut reservations = BTreeMap::<String, u64>::new();
    for task in state.reservations.values() {
        if !promoted.contains(task.expected_sha256.as_str()) {
            insert_blob_charge(
                &mut reservations,
                &task.expected_sha256,
                task.expected_bytes,
            )?;
        }
    }
    checked_sum(reservations.values().copied())
}

fn physical_total_after_reservation(
    state: &StoreState,
    sha256: &str,
    byte_size: u64,
) -> Result<u64, ModelPackError> {
    let mut blobs = BTreeMap::<String, u64>::new();
    for file in state.files.values() {
        insert_blob_charge(&mut blobs, &file.sha256, file.byte_size)?;
    }
    for task in state.reservations.values() {
        insert_blob_charge(&mut blobs, &task.expected_sha256, task.expected_bytes)?;
    }
    insert_blob_charge(&mut blobs, sha256, byte_size)?;
    checked_sum(blobs.values().copied())
}

fn insert_blob_charge(
    blobs: &mut BTreeMap<String, u64>,
    sha256: &str,
    byte_size: u64,
) -> Result<(), ModelPackError> {
    match blobs.get(sha256) {
        Some(existing) if *existing == byte_size => Ok(()),
        Some(_) => Err(store("corrupt")),
        None => {
            blobs.insert(sha256.to_owned(), byte_size);
            Ok(())
        }
    }
}

fn reconcile_scoped_pointers(root: &Path, state: &mut StoreState) -> Result<(), ModelPackError> {
    let revoked = state.revoked_pack_ids.clone();
    let files = state.files.clone();
    state.active.retain(|key, active| {
        *key == scope_map_key(&active.scope)
            && !revoked.contains(&active.pack_id)
            && pack_has_files_in(&files, root, active).unwrap_or(false)
    });
    state.rollback.retain(|key, rollback| {
        *key == scope_map_key(&rollback.scope)
            && !revoked.contains(&rollback.pack_id)
            && pack_has_files_in(&files, root, rollback).unwrap_or(false)
    });
    reconcile_lifecycle_activity(state)
}

fn reconcile_lifecycle_activity(state: &mut StoreState) -> Result<(), ModelPackError> {
    let active_keys: BTreeSet<String> = state.active.values().map(identity_lifecycle_key).collect();
    let lifecycle_keys: Vec<String> = state.lifecycles.keys().cloned().collect();
    for key in lifecycle_keys {
        let Some(snapshot) = state.lifecycles.get(&key).cloned() else {
            continue;
        };
        let referenced = active_keys.contains(&key);
        let next = match (referenced, snapshot.state) {
            (true, InstallState::Ready) => Some(apply_lifecycle_event(
                &snapshot,
                InstallEvent::Activate,
                now_epoch_seconds(),
                None,
            )?),
            (false, InstallState::Active) => Some(apply_lifecycle_event(
                &snapshot,
                InstallEvent::Deactivate,
                now_epoch_seconds(),
                None,
            )?),
            _ => None,
        };
        if let Some(next) = next {
            state.lifecycles.insert(key, next);
        }
    }
    Ok(())
}

fn read_state(root: &Path) -> Result<StoreState, ModelPackError> {
    let path = state_path(root);
    if !path.exists() {
        return Ok(StoreState::default());
    }
    let bytes = std::fs::read(path).map_err(|_| store("state"))?;
    let state: StoreState = serde_json::from_slice(&bytes).map_err(|_| store("state"))?;
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(store("state_schema"));
    }
    Ok(state)
}

fn write_state_atomic(root: &Path, state: &StoreState) -> Result<(), ModelPackError> {
    let directory = state_dir(root);
    std::fs::create_dir_all(&directory).map_err(|_| store("persistence"))?;
    let final_path = state_path(root);
    let tmp_path = directory.join(format!(
        "{STATE_TMP_PREFIX}{}.{}",
        std::process::id(),
        now_epoch_seconds()
    ));
    {
        let mut file = File::create(&tmp_path).map_err(|_| store("persistence"))?;
        let bytes = serde_json::to_vec_pretty(state).map_err(|_| store("persistence"))?;
        file.write_all(&bytes).map_err(|_| store("persistence"))?;
        file.write_all(b"\n").map_err(|_| store("persistence"))?;
        file.sync_all().map_err(|_| store("persistence"))?;
    }
    std::fs::rename(&tmp_path, &final_path).map_err(|_| store("persistence"))?;
    fsync_parent(&final_path)?;
    Ok(())
}

fn recover_state_temps(root: &Path) -> Result<(), ModelPackError> {
    let directory = state_dir(root);
    if !directory.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory).map_err(|_| store("recovery"))? {
        let entry = entry.map_err(|_| store("recovery"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(STATE_TMP_PREFIX) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn recover_staging(root: &Path, state: &StoreState) -> Result<(), ModelPackError> {
    let directory = staging_dir(root);
    if !directory.exists() {
        return Ok(());
    }
    let expected: BTreeSet<PathBuf> = state
        .reservations
        .keys()
        .map(|key| staging_path(root, key))
        .collect();
    for entry in std::fs::read_dir(directory).map_err(|_| store("recovery"))? {
        let entry = entry.map_err(|_| store("recovery"))?;
        if !expected.contains(&entry.path()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn recover_blobs(root: &Path, state: &mut StoreState) -> Result<(), ModelPackError> {
    let mut corrupt_pack_ids = BTreeSet::new();
    for file in state.files.values() {
        let path = blob_path(root, &file.sha256);
        match inspect_file(&path) {
            Ok(actual) if actual.sha256 == file.sha256 && actual.byte_size == file.byte_size => {}
            Ok(_) | Err(_) => {
                corrupt_pack_ids.insert(file.pack_id.clone());
            }
        }
    }
    if !corrupt_pack_ids.is_empty() {
        state
            .files
            .retain(|_, file| !corrupt_pack_ids.contains(&file.pack_id));
        state
            .active
            .retain(|_, active| !corrupt_pack_ids.contains(&active.pack_id));
        state
            .rollback
            .retain(|_, rollback| !corrupt_pack_ids.contains(&rollback.pack_id));
    }
    reconcile_scoped_pointers(root, state)?;

    let referenced_hashes: BTreeSet<String> = state
        .files
        .values()
        .map(|file| file.sha256.clone())
        .chain(
            state
                .reservations
                .values()
                .map(|task| task.expected_sha256.clone()),
        )
        .collect();
    let directory = blob_dir(root);
    if directory.exists() {
        for entry in std::fs::read_dir(directory).map_err(|_| store("recovery"))? {
            let entry = entry.map_err(|_| store("recovery"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !referenced_hashes.contains(&name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn inspect_file(path: &Path) -> Result<FileInspection, ModelPackError> {
    let mut file = File::open(path).map_err(|_| store("missing_file"))?;
    let mut hasher = Sha256::new();
    let mut byte_size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| store("read"))?;
        if read == 0 {
            break;
        }
        byte_size = byte_size
            .checked_add(u64::try_from(read).map_err(|_| store("overflow"))?)
            .ok_or_else(|| store("overflow"))?;
        hasher.update(&buffer[..read]);
    }
    Ok(FileInspection {
        byte_size,
        sha256: encode_hex(&hasher.finalize()),
    })
}

fn pack_has_files(
    root: &Path,
    state: &StoreState,
    identity: &ActivePackIdentity,
) -> Result<bool, ModelPackError> {
    pack_has_files_in(&state.files, root, identity)
}

fn pack_has_files_in(
    files: &BTreeMap<String, StoredFile>,
    root: &Path,
    identity: &ActivePackIdentity,
) -> Result<bool, ModelPackError> {
    let mut found = false;
    for file in files.values().filter(|file| {
        file.pack_id == identity.pack_id
            && file.pack_version == identity.pack_version
            && file.variant_id == identity.variant_id
    }) {
        found = true;
        let actual = inspect_file(&blob_path(root, &file.sha256))?;
        if actual.sha256 != file.sha256 || actual.byte_size != file.byte_size {
            return Ok(false);
        }
    }
    Ok(found)
}

fn checked_sum(values: impl IntoIterator<Item = u64>) -> Result<u64, ModelPackError> {
    let mut total = 0_u64;
    for value in values {
        total = total
            .checked_add(value)
            .ok_or(ModelPackError::QuotaExceeded)?;
    }
    Ok(total)
}

fn fsync_parent(path: &Path) -> Result<(), ModelPackError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    match File::open(parent).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied => {
            Ok(())
        }
        Err(_) => Err(store("sync")),
    }
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    encode_hex(&digest)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn store(code: &'static str) -> ModelPackError {
    ModelPackError::Store { code }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_engine::{
        select_verified_variant, verify_manifest, AbiRequirements, CapabilityFlags, Compatibility,
        CompressionKind, DeviceClass, EngineKind, LanguageSupport, LicenseGrant, LicenseInfo,
        ManifestSignature, ModelPackManifest, ModelPackVariant, PackTask, ProcessingMetadata,
        Provenance, ResourceBudget, RuntimeGates, RuntimeSelection, RuntimeTarget, ShapeMetadata,
        SignatureVerifier, TargetArch, TargetOs, TrustPolicy,
    };
    use std::io::Read;

    const HASH_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    struct AcceptingVerifier;

    impl SignatureVerifier for AcceptingVerifier {
        fn verify(
            &self,
            _canonical_json: &str,
            signature: &ManifestSignature,
        ) -> Result<bool, ModelPackError> {
            Ok(signature.value == "signed")
        }
    }

    fn hash(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    fn open_store(root: &Path, quota: u64) -> NativeModelStore {
        NativeModelStore::open(NativeModelStoreConfig::new(root, Some(quota)))
            .expect("native model store opens")
    }

    fn scope(task: PackTask) -> ModelStoreScope {
        ModelStoreScope::default_for_task(task)
    }

    fn provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: hash(b"recipe"),
        }
    }

    fn license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: hash(b"license"),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: hash(b"ops"),
            preprocessing_abi: "pre".to_owned(),
            postprocessing_abi: "post".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: 16_000,
                channels: 1,
                frame_size: 512,
                window_size: 1024,
                cache_state: vec!["hidden".to_owned()],
            },
        }
    }

    fn model_file(file_id: &str, bytes: &[u8]) -> ModelPackFile {
        model_file_for(file_id, PackTask::Stt, bytes)
    }

    fn model_file_for(file_id: &str, task: PackTask, bytes: &[u8]) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
            byte_size: u64::try_from(bytes.len()).expect("test bytes fit"),
            sha256: hash(bytes),
            url: format!("/models/{file_id}"),
            compression: CompressionKind::None,
            installed_size: u64::try_from(bytes.len()).expect("test bytes fit"),
            install_order: 0,
            dependencies: Vec::new(),
            license: license(),
            provenance: provenance(),
            processing: processing(),
            raven: None,
            revocation: None,
        }
    }

    fn variant(
        variant_id: &str,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
        file_id: &str,
        size: u64,
    ) -> ModelPackVariant {
        ModelPackVariant {
            variant_id: variant_id.to_owned(),
            target,
            os,
            arch,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: size,
                max_installed_bytes: size,
                max_memory_bytes: 1024,
            },
            compatibility: Compatibility {
                group_id: "group".to_owned(),
                voice_state_group_id: "voice-state".to_owned(),
                preprocessing_abi: "pre".to_owned(),
                postprocessing_abi: "post".to_owned(),
                sample_rate_hz: 16_000,
                channels: 1,
                frame_size: 512,
                interoperable: false,
            },
            file_ids: vec![file_id.to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1".to_owned(),
                min_runtime_version: "1".to_owned(),
                min_engine_version: "1".to_owned(),
                engine_source_revision: "rev".to_owned(),
                build_flags: Vec::new(),
            },
            revocation: None,
        }
    }

    fn manifest(id: &str, version: &str, file: ModelPackFile) -> VerifiedManifest {
        let size = file.byte_size;
        let raw = ModelPackManifest {
            schema_version: 1,
            pack_id: id.to_owned(),
            pack_version: version.to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![PackTask::Stt],
            license: license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: provenance(),
            files: vec![file],
            variants: vec![variant(
                "linux",
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                "model",
                size,
            )],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        };
        verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("manifest verifies")
    }

    fn verified_for_task(
        id: &str,
        version: &str,
        task: PackTask,
        bytes: &[u8],
    ) -> VerifiedManifest {
        let file = model_file_for("model", task, bytes);
        let size = file.byte_size;
        let raw = ModelPackManifest {
            schema_version: 1,
            pack_id: id.to_owned(),
            pack_version: version.to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![task],
            license: license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: provenance(),
            files: vec![file],
            variants: vec![variant(
                "linux",
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                "model",
                size,
            )],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        };
        verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("manifest verifies")
    }

    fn selection_for(manifest: &VerifiedManifest) -> SelectedVariant {
        select_for(
            manifest,
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
        )
    }

    fn select_for(
        manifest: &VerifiedManifest,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
    ) -> SelectedVariant {
        select_verified_variant(
            manifest,
            &RuntimeSelection {
                target,
                os,
                arch,
                browser_features: BTreeSet::new(),
                device_memory_mb: Some(4096),
                max_download_bytes: u64::MAX,
                max_installed_bytes: u64::MAX,
                max_memory_bytes: u64::MAX,
                cpu_threads: 4,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Balanced,
                require_interoperable: false,
            },
        )
        .expect("selection resolves")
    }

    async fn reserve_and_stage(
        store: &mut NativeModelStore,
        manifest: &VerifiedManifest,
        bytes: &[u8],
    ) -> DownloadTask {
        let selection = selection_for(manifest);
        let file = &manifest.manifest().files[0];
        let task = store
            .reserve_file(manifest, &selection, file)
            .await
            .expect("reservation succeeds");
        std::fs::write(store.staging_path(&task.storage_key), bytes).expect("stage bytes");
        task
    }

    async fn install_ready(
        store: &mut NativeModelStore,
        manifest: &VerifiedManifest,
        bytes: &[u8],
    ) {
        let selection = selection_for(manifest);
        let task = reserve_and_stage(store, manifest, bytes).await;
        let file = &manifest.manifest().files[0];
        store
            .promote_file(&task.storage_key, &file.sha256, file.byte_size)
            .await
            .expect("promote succeeds");
        store
            .set_lifecycle(create_lifecycle_snapshot(
                manifest.manifest().pack_id.clone(),
                manifest.manifest().pack_version.clone(),
                selection.variant_id().to_owned(),
                now_epoch_seconds(),
                InstallState::Ready,
            ))
            .await
            .expect("lifecycle persists");
        store
            .activate_pack(scope(PackTask::Stt), manifest, &selection)
            .await
            .expect("activation succeeds");
    }

    async fn install_ready_only(
        store: &mut NativeModelStore,
        manifest: &VerifiedManifest,
        bytes: &[u8],
    ) {
        let selection = selection_for(manifest);
        let file = &manifest.manifest().files[0];
        let task = store
            .reserve_file(manifest, &selection, file)
            .await
            .expect("reservation succeeds");
        std::fs::write(store.staging_path(&task.storage_key), bytes).expect("stage bytes");
        store
            .promote_file(&task.storage_key, &file.sha256, file.byte_size)
            .await
            .expect("promote succeeds");
        store
            .set_lifecycle(create_lifecycle_snapshot(
                manifest.manifest().pack_id.clone(),
                manifest.manifest().pack_version.clone(),
                selection.variant_id().to_owned(),
                now_epoch_seconds(),
                InstallState::Ready,
            ))
            .await
            .expect("lifecycle persists");
    }

    #[tokio::test]
    async fn interrupted_write_keeps_reservation_and_resumes_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bytes = b"voice-model";
        let manifest = manifest("pack", "1", model_file("model", bytes));
        let mut store = open_store(temp.path(), 100);
        let task = reserve_and_stage(&mut store, &manifest, b"voice").await;

        let reopened = open_store(temp.path(), 100);
        assert_eq!(
            reopened
                .resume_metadata(&task.storage_key)
                .await
                .expect("resume metadata readable")
                .expect("reservation exists")
                .expected_bytes,
            u64::try_from(bytes.len()).expect("test bytes fit")
        );
        assert!(reopened.staging_path(&task.storage_key).exists());
    }

    #[test]
    fn old_state_schema_fails_closed_instead_of_silent_shape_reuse() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(state_dir(temp.path())).expect("state dir");
        std::fs::write(
            state_path(temp.path()),
            br#"{
              "schema_version": 1,
              "bytes_available": 100,
              "persistent": true,
              "files": {},
              "reservations": {},
              "lifecycles": {},
              "active": {},
              "rollback": {},
              "revoked_pack_ids": []
            }"#,
        )
        .expect("old state");

        assert_eq!(
            NativeModelStore::open(NativeModelStoreConfig::new(temp.path(), Some(100))).err(),
            Some(super::store("state_schema"))
        );
    }

    #[tokio::test]
    async fn rerereserve_existing_key_with_changed_integrity_fails_without_mutation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first = manifest("pack", "1", model_file("model", b"first"));
        let changed = manifest("pack", "1", model_file("model", b"changed"));
        let first_selection = selection_for(&first);
        let changed_selection = selection_for(&changed);
        let mut store = open_store(temp.path(), 100);
        let task = store
            .reserve_file(&first, &first_selection, &first.manifest().files[0])
            .await
            .expect("first reservation succeeds");

        assert_eq!(
            store
                .reserve_file(&changed, &changed_selection, &changed.manifest().files[0])
                .await,
            Err(super::store("reservation"))
        );
        assert_eq!(
            store
                .resume_metadata(&task.storage_key)
                .await
                .expect("resume metadata readable")
                .expect("reservation remains")
                .expected_sha256,
            first.manifest().files[0].sha256
        );
    }

    #[tokio::test]
    async fn promotion_recomputes_hash_and_size_before_blob_write() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manifest = manifest("pack", "1", model_file("model", b"honest"));
        let mut store = open_store(temp.path(), 100);
        let task = reserve_and_stage(&mut store, &manifest, b"tampered").await;

        assert_eq!(
            store
                .promote_file(&task.storage_key, &hash(b"honest"), 6)
                .await,
            Err(super::store("hash"))
        );
        std::fs::write(store.staging_path(&task.storage_key), b"honest").expect("stage bytes");
        assert_eq!(
            store
                .promote_file(&task.storage_key, &hash(b"honest"), 99)
                .await,
            Err(super::store("size"))
        );
    }

    #[tokio::test]
    async fn promotion_persistence_failure_recovers_from_reserved_blob_after_reopen() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bytes = b"recoverable";
        let manifest = manifest("pack", "1", model_file("model", bytes));
        let mut store = open_store(temp.path(), 100);
        let task = reserve_and_stage(&mut store, &manifest, bytes).await;
        let file = &manifest.manifest().files[0];
        store.inject_persistence_failure();

        assert_eq!(
            store
                .promote_file(&task.storage_key, &file.sha256, file.byte_size)
                .await,
            Err(super::store("persistence"))
        );
        assert!(!store.staging_path(&task.storage_key).exists());
        assert!(blob_path(temp.path(), &file.sha256).exists());
        std::fs::write(blob_path(temp.path(), &hash(b"orphan")), b"orphan").expect("orphan blob");

        let mut reopened = open_store(temp.path(), 100);
        assert!(!blob_path(temp.path(), &hash(b"orphan")).exists());
        assert!(reopened
            .resume_metadata(&task.storage_key)
            .await
            .expect("resume metadata readable")
            .is_some());
        let stored = reopened
            .promote_file(&task.storage_key, &file.sha256, file.byte_size)
            .await
            .expect("retry finalizes from reserved blob");
        assert_eq!(stored.sha256, file.sha256);
        assert!(reopened
            .resume_metadata(&task.storage_key)
            .await
            .expect("resume metadata readable")
            .is_none());
    }

    #[tokio::test]
    async fn quota_counts_in_flight_reservations_with_checked_arithmetic() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first = manifest("pack-a", "1", model_file("model", b"123456"));
        let second = manifest("pack-b", "1", model_file("model", b"abcdef"));
        let first_selection = selection_for(&first);
        let second_selection = selection_for(&second);
        let mut store = open_store(temp.path(), 10);

        store
            .reserve_file(&first, &first_selection, &first.manifest().files[0])
            .await
            .expect("first reservation fits");
        assert_eq!(
            store
                .reserve_file(&second, &second_selection, &second.manifest().files[0])
                .await,
            Err(ModelPackError::QuotaExceeded)
        );
        assert_eq!(store.status().await.expect("status").bytes_reserved, 6);
    }

    #[tokio::test]
    async fn activation_failure_leaves_old_active_and_rollback_untouched() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let first = manifest("pack-a", "1", model_file("model", b"first"));
        let second = manifest("pack-b", "1", model_file("model", b"second"));
        install_ready(&mut store, &first, b"first").await;
        install_ready(&mut store, &second, b"second").await;
        let first_selection = selection_for(&first);
        let second_selection = selection_for(&second);
        store
            .activate_pack(scope(PackTask::Stt), &first, &first_selection)
            .await
            .expect("first active");

        store.inject_persistence_failure();
        assert_eq!(
            store
                .activate_pack(scope(PackTask::Stt), &second, &second_selection)
                .await,
            Err(super::store("persistence"))
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("active readable")
                .expect("active exists")
                .pack_id,
            "pack-a"
        );
    }

    #[tokio::test]
    async fn rollback_restores_previous_active_pack() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let first = manifest("pack-a", "1", model_file("model", b"first"));
        let second = manifest("pack-b", "1", model_file("model", b"second"));
        install_ready(&mut store, &first, b"first").await;
        install_ready(&mut store, &second, b"second").await;

        let rolled_back = store
            .rollback_active(scope(PackTask::Stt))
            .await
            .expect("rollback succeeds")
            .expect("rollback exists");
        assert_eq!(rolled_back.pack_id, "pack-a");
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("active readable")
                .expect("active exists")
                .pack_id,
            "pack-a"
        );
    }

    #[tokio::test]
    async fn versions_and_variants_are_isolated() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let first = manifest("pack", "1", model_file("model", b"first"));
        let second = manifest("pack", "2", model_file("model", b"second"));
        install_ready(&mut store, &first, b"first").await;
        install_ready(&mut store, &second, b"second").await;
        assert!(store
            .lifecycle("pack", "1", "linux")
            .await
            .expect("lifecycle")
            .is_some());
        assert!(store
            .lifecycle("pack", "2", "linux")
            .await
            .expect("lifecycle")
            .is_some());

        let selected = selection_for(&second);
        assert_eq!(
            store
                .open_immutable_file(&selected, "model")
                .await
                .expect("open metadata")
                .variant_id,
            "linux"
        );
    }

    #[tokio::test]
    async fn same_pack_version_variants_keep_lifecycle_and_rollback_isolated() {
        let temp = tempfile::tempdir().expect("tempdir");
        let desktop_bytes = b"desktop";
        let android_bytes = b"android";
        let desktop_file = model_file("desktop-model", desktop_bytes);
        let android_file = model_file("android-model", android_bytes);
        let raw = ModelPackManifest {
            schema_version: 1,
            pack_id: "pack".to_owned(),
            pack_version: "1".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![PackTask::Stt],
            license: license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: provenance(),
            files: vec![desktop_file, android_file],
            variants: vec![
                variant(
                    "linux",
                    RuntimeTarget::Desktop,
                    TargetOs::Linux,
                    TargetArch::X86_64,
                    "desktop-model",
                    u64::try_from(desktop_bytes.len()).expect("test bytes fit"),
                ),
                variant(
                    "android",
                    RuntimeTarget::Android,
                    TargetOs::Android,
                    TargetArch::Aarch64,
                    "android-model",
                    u64::try_from(android_bytes.len()).expect("test bytes fit"),
                ),
            ],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        };
        let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("manifest verifies");
        let desktop_selection = select_for(
            &verified,
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
        );
        let android_selection = select_for(
            &verified,
            RuntimeTarget::Android,
            TargetOs::Android,
            TargetArch::Aarch64,
        );
        let mut store = open_store(temp.path(), 100);

        for (selection, file, bytes) in [
            (
                &desktop_selection,
                &verified.manifest().files[0],
                desktop_bytes.as_slice(),
            ),
            (
                &android_selection,
                &verified.manifest().files[1],
                android_bytes.as_slice(),
            ),
        ] {
            let task = store
                .reserve_file(&verified, selection, file)
                .await
                .expect("reservation succeeds");
            std::fs::write(store.staging_path(&task.storage_key), bytes).expect("stage bytes");
            store
                .promote_file(&task.storage_key, &file.sha256, file.byte_size)
                .await
                .expect("promotion succeeds");
            store
                .set_lifecycle(create_lifecycle_snapshot(
                    verified.manifest().pack_id.clone(),
                    verified.manifest().pack_version.clone(),
                    selection.variant_id().to_owned(),
                    now_epoch_seconds(),
                    InstallState::Ready,
                ))
                .await
                .expect("lifecycle persists");
        }

        store
            .activate_pack(scope(PackTask::Stt), &verified, &desktop_selection)
            .await
            .expect("desktop activation succeeds");
        store
            .activate_pack(scope(PackTask::Stt), &verified, &android_selection)
            .await
            .expect("android activation succeeds");
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("active readable")
                .expect("active exists")
                .variant_id,
            "android"
        );
        assert_eq!(
            store
                .lifecycle("pack", "1", "linux")
                .await
                .expect("lifecycle")
                .map(|snapshot| snapshot.state),
            Some(InstallState::Ready)
        );
        assert_eq!(
            store
                .lifecycle("pack", "1", "android")
                .await
                .expect("lifecycle")
                .map(|snapshot| snapshot.state),
            Some(InstallState::Active)
        );

        let rolled_back = store
            .rollback_active(scope(PackTask::Stt))
            .await
            .expect("rollback succeeds")
            .expect("rollback exists");
        assert_eq!(rolled_back.variant_id, "linux");
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("active readable")
                .expect("active exists")
                .variant_id,
            "linux"
        );
        assert_eq!(
            store
                .lifecycle("pack", "1", "android")
                .await
                .expect("lifecycle")
                .map(|snapshot| snapshot.state),
            Some(InstallState::Ready)
        );
    }

    #[tokio::test]
    async fn logical_scopes_are_concurrent_and_rollback_independently_after_restart() {
        let temp = tempfile::tempdir().expect("tempdir");
        let kws = verified_for_task("kws-pack", "1", PackTask::Kws, b"kws-v1");
        let vad = verified_for_task("vad-pack", "1", PackTask::Vad, b"vad-v1");
        let stt_v1 = verified_for_task("stt-pack", "1", PackTask::Stt, b"stt-v1");
        let stt_v2 = verified_for_task("stt-pack", "2", PackTask::Stt, b"stt-v2");
        let tts_v1 = verified_for_task("tts-pack", "1", PackTask::Tts, b"tts-v1");
        let tts_v2 = verified_for_task("tts-pack", "2", PackTask::Tts, b"tts-v2");
        let mut store = open_store(temp.path(), 100);
        for (manifest, bytes) in [
            (&kws, b"kws-v1".as_slice()),
            (&vad, b"vad-v1".as_slice()),
            (&stt_v1, b"stt-v1".as_slice()),
            (&stt_v2, b"stt-v2".as_slice()),
            (&tts_v1, b"tts-v1".as_slice()),
            (&tts_v2, b"tts-v2".as_slice()),
        ] {
            install_ready_only(&mut store, manifest, bytes).await;
        }

        store
            .activate_pack(scope(PackTask::Kws), &kws, &selection_for(&kws))
            .await
            .expect("kws active");
        store
            .activate_pack(scope(PackTask::Vad), &vad, &selection_for(&vad))
            .await
            .expect("vad active");
        store
            .activate_pack(scope(PackTask::Stt), &stt_v1, &selection_for(&stt_v1))
            .await
            .expect("stt v1 active");
        store
            .activate_pack(scope(PackTask::Tts), &tts_v1, &selection_for(&tts_v1))
            .await
            .expect("tts v1 active");
        store
            .activate_pack(scope(PackTask::Stt), &stt_v2, &selection_for(&stt_v2))
            .await
            .expect("stt v2 active");
        store
            .activate_pack(scope(PackTask::Tts), &tts_v2, &selection_for(&tts_v2))
            .await
            .expect("tts v2 active");

        let mut reopened = open_store(temp.path(), 100);
        assert_eq!(
            reopened
                .active_pack(scope(PackTask::Kws))
                .await
                .expect("kws active readable")
                .expect("kws active")
                .pack_id,
            "kws-pack"
        );
        assert_eq!(
            reopened
                .active_pack(scope(PackTask::Vad))
                .await
                .expect("vad active readable")
                .expect("vad active")
                .pack_id,
            "vad-pack"
        );
        assert_eq!(
            reopened
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("stt active readable")
                .expect("stt active")
                .pack_version,
            "2"
        );
        assert_eq!(
            reopened
                .rollback_identity(&scope(PackTask::Tts))
                .expect("tts rollback")
                .pack_version,
            "1"
        );

        let rolled_back = reopened
            .rollback_active(scope(PackTask::Stt))
            .await
            .expect("rollback succeeds")
            .expect("rollback exists");
        assert_eq!(rolled_back.pack_version, "1");
        assert_eq!(
            reopened
                .active_pack(scope(PackTask::Tts))
                .await
                .expect("tts active readable")
                .expect("tts active")
                .pack_version,
            "2"
        );
    }

    #[tokio::test]
    async fn reused_selection_stays_active_until_last_scope_leaves() {
        let temp = tempfile::tempdir().expect("tempdir");
        let stt_bytes = b"shared-stt";
        let tts_bytes = b"shared-tts";
        let stt_file = model_file_for("stt-model", PackTask::Stt, stt_bytes);
        let tts_file = model_file_for("tts-model", PackTask::Tts, tts_bytes);
        let mut raw = ModelPackManifest {
            schema_version: 1,
            pack_id: "shared-pack".to_owned(),
            pack_version: "1".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![PackTask::Stt, PackTask::Tts],
            license: license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: provenance(),
            files: vec![stt_file, tts_file],
            variants: vec![variant(
                "linux",
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                "stt-model",
                u64::try_from(stt_bytes.len() + tts_bytes.len()).expect("test bytes fit"),
            )],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        };
        raw.variants[0].file_ids = vec!["stt-model".to_owned(), "tts-model".to_owned()];
        let shared = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("manifest verifies");
        let other_stt = verified_for_task("other-stt", "1", PackTask::Stt, b"other-stt");
        let other_tts = verified_for_task("other-tts", "1", PackTask::Tts, b"other-tts");
        let shared_selection = selection_for(&shared);
        let mut store = open_store(temp.path(), 100);

        for (file, bytes) in [
            (&shared.manifest().files[0], stt_bytes.as_slice()),
            (&shared.manifest().files[1], tts_bytes.as_slice()),
        ] {
            let task = store
                .reserve_file(&shared, &shared_selection, file)
                .await
                .expect("reservation succeeds");
            std::fs::write(store.staging_path(&task.storage_key), bytes).expect("stage bytes");
            store
                .promote_file(&task.storage_key, &file.sha256, file.byte_size)
                .await
                .expect("promotion succeeds");
        }
        store
            .set_lifecycle(create_lifecycle_snapshot(
                "shared-pack",
                "1",
                "linux",
                now_epoch_seconds(),
                InstallState::Ready,
            ))
            .await
            .expect("shared lifecycle ready");
        install_ready_only(&mut store, &other_stt, b"other-stt").await;
        install_ready_only(&mut store, &other_tts, b"other-tts").await;

        store
            .activate_pack(scope(PackTask::Stt), &shared, &shared_selection)
            .await
            .expect("shared stt active");
        store
            .activate_pack(scope(PackTask::Tts), &shared, &shared_selection)
            .await
            .expect("shared tts active");
        store
            .activate_pack(scope(PackTask::Stt), &other_stt, &selection_for(&other_stt))
            .await
            .expect("other stt active");
        assert_eq!(
            store
                .lifecycle("shared-pack", "1", "linux")
                .await
                .expect("shared lifecycle readable")
                .map(|snapshot| snapshot.state),
            Some(InstallState::Active)
        );
        store
            .activate_pack(scope(PackTask::Tts), &other_tts, &selection_for(&other_tts))
            .await
            .expect("other tts active");
        assert_eq!(
            store
                .lifecycle("shared-pack", "1", "linux")
                .await
                .expect("shared lifecycle readable")
                .map(|snapshot| snapshot.state),
            Some(InstallState::Ready)
        );
    }

    #[tokio::test]
    async fn task_mismatch_fails_without_mutation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let stt = verified_for_task("stt-pack", "1", PackTask::Stt, b"stt");
        let replacement = verified_for_task("replacement", "1", PackTask::Stt, b"replacement");
        let mut store = open_store(temp.path(), 100);
        install_ready_only(&mut store, &stt, b"stt").await;
        install_ready_only(&mut store, &replacement, b"replacement").await;
        store
            .activate_pack(scope(PackTask::Stt), &stt, &selection_for(&stt))
            .await
            .expect("stt active");

        assert_eq!(
            store
                .activate_pack(
                    scope(PackTask::Tts),
                    &replacement,
                    &selection_for(&replacement)
                )
                .await,
            Err(super::store("scope_task"))
        );
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("stt active readable")
                .expect("stt active")
                .pack_id,
            "stt-pack"
        );
        assert!(store
            .active_pack(scope(PackTask::Tts))
            .await
            .expect("tts active readable")
            .is_none());
        assert!(store.rollback_identity(&scope(PackTask::Tts)).is_none());
    }

    #[tokio::test]
    async fn revocation_and_startup_corruption_preserve_unaffected_scopes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let kws = verified_for_task("kws-pack", "1", PackTask::Kws, b"kws");
        let stt = verified_for_task("stt-pack", "1", PackTask::Stt, b"stt");
        let mut store = open_store(temp.path(), 100);
        install_ready_only(&mut store, &kws, b"kws").await;
        install_ready_only(&mut store, &stt, b"stt").await;
        store
            .activate_pack(scope(PackTask::Kws), &kws, &selection_for(&kws))
            .await
            .expect("kws active");
        store
            .activate_pack(scope(PackTask::Stt), &stt, &selection_for(&stt))
            .await
            .expect("stt active");

        store.revoke_pack("stt-pack").expect("revoke persists");
        assert!(store
            .active_pack(scope(PackTask::Stt))
            .await
            .expect("stt active readable")
            .is_none());
        assert_eq!(
            store
                .active_pack(scope(PackTask::Kws))
                .await
                .expect("kws active readable")
                .expect("kws active")
                .pack_id,
            "kws-pack"
        );

        let mut recovered = open_store(temp.path(), 100);
        let kws_selection = selection_for(&kws);
        let metadata = recovered
            .open_immutable_file(&kws_selection, "model")
            .await
            .expect("kws metadata");
        std::fs::write(blob_path(temp.path(), &metadata.sha256), b"corrupt")
            .expect("corrupt kws blob");
        recovered = open_store(temp.path(), 100);
        assert!(recovered
            .active_pack(scope(PackTask::Kws))
            .await
            .expect("kws active readable")
            .is_none());
        assert!(recovered
            .active_pack(scope(PackTask::Stt))
            .await
            .expect("stt active readable")
            .is_none());
    }

    #[tokio::test]
    async fn duplicate_blobs_are_charged_once_and_deleted_after_last_reference() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bytes = b"same-content";
        let first = verified_for_task("first", "1", PackTask::Stt, bytes);
        let second = verified_for_task("second", "1", PackTask::Tts, bytes);
        let mut store = open_store(temp.path(), u64::try_from(bytes.len()).expect("fit"));

        for (index, manifest) in [&first, &second].into_iter().enumerate() {
            let selection = selection_for(manifest);
            let file = &manifest.manifest().files[0];
            let task = store
                .reserve_file(manifest, &selection, file)
                .await
                .expect("duplicate reservation fits");
            std::fs::write(store.staging_path(&task.storage_key), bytes).expect("stage bytes");
            assert_eq!(
                store.status().await.expect("status").bytes_reserved,
                if index == 0 {
                    u64::try_from(bytes.len()).expect("fit")
                } else {
                    0
                }
            );
            store
                .promote_file(&task.storage_key, &file.sha256, file.byte_size)
                .await
                .expect("duplicate promotion succeeds");
            assert_eq!(
                store.status().await.expect("status").bytes_used,
                u64::try_from(bytes.len()).expect("fit")
            );
        }

        let hash = first.manifest().files[0].sha256.clone();
        store.remove_pack("first").await.expect("remove first");
        assert!(blob_path(temp.path(), &hash).exists());
        store.remove_pack("second").await.expect("remove second");
        assert!(!blob_path(temp.path(), &hash).exists());
    }

    #[tokio::test]
    async fn corruption_and_revocation_fail_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let manifest = manifest("pack", "1", model_file("model", b"model"));
        install_ready(&mut store, &manifest, b"model").await;
        let selection = selection_for(&manifest);
        let metadata = store
            .open_immutable_file(&selection, "model")
            .await
            .expect("open metadata");
        std::fs::write(blob_path(temp.path(), &metadata.sha256), b"corrupt").expect("corrupt blob");
        assert_eq!(
            store.active_pack(scope(PackTask::Stt)).await,
            Err(super::store("corrupt"))
        );
        assert_eq!(
            store.open_immutable_file(&selection, "model").await,
            Err(super::store("corrupt"))
        );

        let mut store = open_store(temp.path(), 100);
        store.revoke_pack("pack").expect("revoke persists");
        assert_eq!(
            store
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("active readable"),
            None
        );
        assert_eq!(
            store
                .activate_pack(scope(PackTask::Stt), &manifest, &selection)
                .await,
            Err(super::store("revoked"))
        );
    }

    #[tokio::test]
    async fn startup_recovery_withdraws_active_when_blob_content_is_corrupt() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let manifest = manifest("pack", "1", model_file("model", b"model"));
        install_ready(&mut store, &manifest, b"model").await;
        let selection = selection_for(&manifest);
        let metadata = store
            .open_immutable_file(&selection, "model")
            .await
            .expect("open metadata");
        std::fs::write(blob_path(temp.path(), &metadata.sha256), b"changed").expect("corrupt blob");

        let recovered = open_store(temp.path(), 100);
        assert_eq!(
            recovered
                .active_pack(scope(PackTask::Stt))
                .await
                .expect("active readable"),
            None
        );
        assert_eq!(
            recovered.open_immutable_file(&selection, "model").await,
            Err(super::store("missing_file"))
        );
    }

    #[tokio::test]
    async fn crash_recovery_removes_orphan_temp_and_staging_state() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let manifest = manifest("pack", "1", model_file("model", b"model"));
        let task = reserve_and_stage(&mut store, &manifest, b"model").await;
        std::fs::write(
            state_dir(temp.path()).join("model-store.json.tmp.dead"),
            b"{}",
        )
        .expect("orphan state tmp");
        std::fs::write(staging_dir(temp.path()).join("raw:key.part"), b"orphan")
            .expect("orphan staging");

        let reopened = open_store(temp.path(), 100);
        assert!(reopened.staging_path(&task.storage_key).exists());
        assert!(!state_dir(temp.path())
            .join("model-store.json.tmp.dead")
            .exists());
        assert!(!staging_dir(temp.path()).join("raw:key.part").exists());
    }

    #[tokio::test]
    async fn staging_paths_are_windows_safe_and_not_raw_storage_keys() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manifest = manifest("pack:id", "1/2", model_file("model", b"model"));
        let selection = selection_for(&manifest);
        let mut store = open_store(temp.path(), 100);
        let task = store
            .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
            .await
            .expect("reservation succeeds");
        let name = store
            .staging_path(&task.storage_key)
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        assert!(!name.contains(':'));
        assert!(!name.contains('/'));
        assert!(!name.contains('#'));
        assert_ne!(name, format!("{}.part", task.storage_key));
    }

    #[tokio::test]
    async fn immutable_handle_survives_pack_removal() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut store = open_store(temp.path(), 100);
        let manifest = manifest("pack", "1", model_file("model", b"model"));
        install_ready(&mut store, &manifest, b"model").await;
        let selection = selection_for(&manifest);
        let mut opened = store
            .open_native_file(&selection, "model")
            .expect("native file opens");
        store.remove_pack("pack").await.expect("remove pack");

        let mut bytes = Vec::new();
        opened
            .file
            .read_to_end(&mut bytes)
            .expect("open handle remains readable");
        assert_eq!(bytes, b"model");
    }

    #[test]
    fn debug_and_errors_are_redacted() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = open_store(temp.path(), 100);
        let rendered = format!(
            "{store:?} {:?} {HASH_EMPTY} {}",
            super::store("hash"),
            super::store("persistence")
        );
        assert!(!rendered.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!rendered.contains("https://"));
        assert!(!rendered.contains("credential"));
    }
}
