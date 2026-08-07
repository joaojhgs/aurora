//! Filesystem-backed native model-pack store.

use async_trait::async_trait;
use aurora_voice_engine::{
    apply_lifecycle_event, can_activate, create_lifecycle_snapshot, file_storage_key,
    ActivePackIdentity, DownloadTask, ImmutableModelFile, InstallEvent, InstallState,
    LifecycleSnapshot, ModelPackError, ModelPackFile, ModelStore, SelectedVariant, StoreStatus,
    StoredFile, VerifiedManifest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const STATE_SCHEMA_VERSION: u32 = 1;
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
        prune_missing_blobs(&config.root, &mut state)?;
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
        if next
            .active
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            next.active = None;
        }
        if next
            .rollback
            .as_ref()
            .is_some_and(|rollback| rollback.pack_id == pack_id)
        {
            next.rollback = None;
        }
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
        checked_sum(self.state.files.values().map(|file| file.byte_size))
    }

    fn reserved_bytes(&self) -> Result<u64, ModelPackError> {
        checked_sum(
            self.state
                .reservations
                .values()
                .map(|reservation| reservation.expected_bytes),
        )
    }

    fn ensure_quota(&self, additional_bytes: u64) -> Result<(), ModelPackError> {
        let committed = self
            .used_bytes()?
            .checked_add(self.reserved_bytes()?)
            .ok_or(ModelPackError::QuotaExceeded)?;
        let required = committed
            .checked_add(additional_bytes)
            .ok_or(ModelPackError::QuotaExceeded)?;
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
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        Ok(self
            .state
            .lifecycles
            .get(&lifecycle_map_key(pack_id, pack_version))
            .cloned())
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        let mut next = self.state.clone();
        next.lifecycles.insert(
            lifecycle_map_key(&snapshot.pack_id, &snapshot.pack_version),
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
        if !self.state.reservations.contains_key(&storage_key) {
            self.ensure_quota(file.byte_size)?;
        }
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
        let actual = inspect_file(&staged)?;
        if actual.sha256 != task.expected_sha256 {
            return Err(store("hash"));
        }
        if actual.byte_size != task.expected_bytes {
            return Err(store("size"));
        }
        self.ensure_quota(0)?;
        let blob = blob_path(&self.config.root, &actual.sha256);
        if blob.exists() {
            let existing = inspect_file(&blob)?;
            if existing.sha256 != actual.sha256 || existing.byte_size != actual.byte_size {
                return Err(store("corrupt"));
            }
            std::fs::remove_file(&staged).map_err(|_| store("promote"))?;
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
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(store("selection"));
        }
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
                    now_epoch_seconds(),
                    InstallState::Ready,
                )
            });
        if !can_activate(&current) {
            return Err(store("not_ready"));
        }

        let mut next = self.state.clone();
        if let Some(active) = &self.state.active {
            if active.pack_id != manifest.manifest().pack_id
                || active.pack_version != manifest.manifest().pack_version
            {
                next.rollback = Some(active.clone());
                if let Some(previous) = next
                    .lifecycles
                    .get(&lifecycle_map_key(&active.pack_id, &active.pack_version))
                    .cloned()
                {
                    let deactivated = apply_lifecycle_event(
                        &previous,
                        InstallEvent::Deactivate,
                        now_epoch_seconds(),
                        None,
                    )?;
                    next.lifecycles.insert(
                        lifecycle_map_key(&deactivated.pack_id, &deactivated.pack_version),
                        deactivated,
                    );
                }
            }
        }
        let active = if current.state == InstallState::Active {
            current
        } else {
            apply_lifecycle_event(&current, InstallEvent::Activate, now_epoch_seconds(), None)?
        };
        next.lifecycles.insert(lifecycle_key, active.clone());
        next.active = Some(ActivePackIdentity {
            pack_id: active.pack_id.clone(),
            pack_version: active.pack_version.clone(),
            variant_id: selection.variant_id().to_owned(),
        });
        self.commit_state(next)?;
        Ok(active)
    }

    async fn rollback_active(&mut self) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        let Some(rollback) = self.state.rollback.clone() else {
            return Ok(None);
        };
        self.require_pack_available(&rollback.pack_id)?;
        if !pack_has_files(&self.config.root, &self.state, &rollback)? {
            return Err(store("rollback"));
        }
        let rollback_key = lifecycle_map_key(&rollback.pack_id, &rollback.pack_version);
        let snapshot = self
            .state
            .lifecycles
            .get(&rollback_key)
            .cloned()
            .ok_or(store("rollback"))?;
        let mut next = self.state.clone();
        if let Some(active) = &self.state.active {
            if let Some(snapshot) = next
                .lifecycles
                .get(&lifecycle_map_key(&active.pack_id, &active.pack_version))
                .cloned()
            {
                let ready = apply_lifecycle_event(
                    &snapshot,
                    InstallEvent::Deactivate,
                    now_epoch_seconds(),
                    None,
                )?;
                next.lifecycles.insert(
                    lifecycle_map_key(&ready.pack_id, &ready.pack_version),
                    ready,
                );
            }
        }
        let active =
            apply_lifecycle_event(&snapshot, InstallEvent::Activate, now_epoch_seconds(), None)?;
        next.lifecycles.insert(
            lifecycle_map_key(&active.pack_id, &active.pack_version),
            active.clone(),
        );
        next.active = Some(ActivePackIdentity {
            pack_id: active.pack_id.clone(),
            pack_version: active.pack_version.clone(),
            variant_id: rollback.variant_id,
        });
        next.rollback = None;
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
        if next
            .active
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            next.active = None;
        }
        if next
            .rollback
            .as_ref()
            .is_some_and(|rollback| rollback.pack_id == pack_id)
        {
            next.rollback = None;
        }
        next.revoked_pack_ids.remove(pack_id);
        self.commit_state(next)?;
        for hash in removed_hashes {
            if !self.state.files.values().any(|file| file.sha256 == hash) {
                let _ = std::fs::remove_file(blob_path(&self.config.root, &hash));
            }
        }
        recover_staging(&self.config.root, &self.state)?;
        Ok(())
    }

    async fn active_pack(&self) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        if let Some(active) = &self.state.active {
            self.require_pack_available(&active.pack_id)?;
            if !pack_has_files(&self.config.root, &self.state, active)? {
                return Err(store("corrupt"));
            }
        }
        Ok(self.state.active.clone())
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
    active: Option<ActivePackIdentity>,
    rollback: Option<ActivePackIdentity>,
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
            active: None,
            rollback: None,
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
            has_active: self.active.is_some(),
            has_rollback: self.rollback.is_some(),
            revoked_count: self.revoked_pack_ids.len(),
        }
    }
}

struct RedactedState {
    file_count: usize,
    reservation_count: usize,
    lifecycle_count: usize,
    has_active: bool,
    has_rollback: bool,
    revoked_count: usize,
}

impl fmt::Debug for RedactedState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoreState")
            .field("file_count", &self.file_count)
            .field("reservation_count", &self.reservation_count)
            .field("lifecycle_count", &self.lifecycle_count)
            .field("has_active", &self.has_active)
            .field("has_rollback", &self.has_rollback)
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

fn lifecycle_map_key(pack_id: &str, pack_version: &str) -> String {
    format!("{}:{}", safe_name(pack_id), safe_name(pack_version))
}

fn read_state(root: &Path) -> Result<StoreState, ModelPackError> {
    let path = state_path(root);
    if !path.exists() {
        return Ok(StoreState::default());
    }
    let bytes = std::fs::read(path).map_err(|_| store("state"))?;
    let state: StoreState = serde_json::from_slice(&bytes).map_err(|_| store("state"))?;
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(store("state"));
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

fn prune_missing_blobs(root: &Path, state: &mut StoreState) -> Result<(), ModelPackError> {
    let mut corrupt_pack_ids = BTreeSet::new();
    for file in state.files.values() {
        let path = blob_path(root, &file.sha256);
        if !path.exists() {
            corrupt_pack_ids.insert(file.pack_id.clone());
        }
    }
    if corrupt_pack_ids.is_empty() {
        return Ok(());
    }
    state
        .files
        .retain(|_, file| !corrupt_pack_ids.contains(&file.pack_id));
    if state
        .active
        .as_ref()
        .is_some_and(|active| corrupt_pack_ids.contains(&active.pack_id))
    {
        state.active = None;
    }
    if state
        .rollback
        .as_ref()
        .is_some_and(|rollback| corrupt_pack_ids.contains(&rollback.pack_id))
    {
        state.rollback = None;
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
    let mut found = false;
    for file in state.files.values().filter(|file| {
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
        Err(_) => Ok(()),
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
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task: PackTask::Stt,
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

    fn selection_for(manifest: &VerifiedManifest) -> SelectedVariant {
        select_verified_variant(
            manifest,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
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
                now_epoch_seconds(),
                InstallState::Ready,
            ))
            .await
            .expect("lifecycle persists");
        store
            .activate_pack(manifest, &selection)
            .await
            .expect("activation succeeds");
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
            .activate_pack(&first, &first_selection)
            .await
            .expect("first active");

        store.inject_persistence_failure();
        assert_eq!(
            store.activate_pack(&second, &second_selection).await,
            Err(super::store("persistence"))
        );
        assert_eq!(
            store
                .active_pack()
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
            .rollback_active()
            .await
            .expect("rollback succeeds")
            .expect("rollback exists");
        assert_eq!(rolled_back.pack_id, "pack-a");
        assert_eq!(
            store
                .active_pack()
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
            .lifecycle("pack", "1")
            .await
            .expect("lifecycle")
            .is_some());
        assert!(store
            .lifecycle("pack", "2")
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
        assert_eq!(store.active_pack().await, Err(super::store("corrupt")));
        assert_eq!(
            store.open_immutable_file(&selection, "model").await,
            Err(super::store("corrupt"))
        );

        let mut store = open_store(temp.path(), 100);
        store.revoke_pack("pack").expect("revoke persists");
        assert_eq!(store.active_pack().await.expect("active readable"), None);
        assert_eq!(
            store.activate_pack(&manifest, &selection).await,
            Err(super::store("revoked"))
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
