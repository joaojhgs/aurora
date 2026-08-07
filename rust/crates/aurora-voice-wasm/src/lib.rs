//! Thin WebAssembly exports and browser-host ports for the shared voice core.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{
    apply_lifecycle_event, create_lifecycle_snapshot, file_storage_key, ActivePackIdentity,
    DownloadTask, ImmutableModelFile, InstallEvent, InstallState, LifecycleSnapshot,
    ModelPackError, ModelPackFile, ModelStore, SelectedVariant, StoreStatus, StoredFile,
    VerifiedManifest,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

const ACTIVE_KEY: &str = "aurora.voice.web-store.v1:active";
const ROLLBACK_KEY: &str = "aurora.voice.web-store.v1:rollback";
const RESERVED_PREFIX: &str = "aurora.voice.web-store.v1:reserved:";
const LIFECYCLE_PREFIX: &str = "aurora.voice.web-store.v1:lifecycle:";
const FILE_PREFIX: &str = "aurora.voice.web-store.v1:file:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserPersistenceKind {
    OpfsPreferred,
    IndexedDbFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebPersistenceReport {
    pub status: StoreStatus,
    pub kind: BrowserPersistenceKind,
    pub evicted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebRecoverySignal {
    Evicted,
    Recovered,
    Corrupt,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebFetchRequest {
    pub url: String,
    pub offset: u64,
    pub max_bytes: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebFetchedChunk {
    pub bytes: Vec<u8>,
    pub finished: bool,
}

impl std::fmt::Debug for WebFetchedChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebFetchedChunk")
            .field("byte_len", &self.bytes.len())
            .field("finished", &self.finished)
            .finish()
    }
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum WebHostError {
    #[error("browser model store is unavailable")]
    Unavailable,
    #[error("browser model store quota exceeded")]
    QuotaExceeded,
    #[error("browser model store operation failed: {code}")]
    Store { code: &'static str },
    #[error("browser model download failed: {code}")]
    Network { code: &'static str },
    #[error("browser model download was cancelled")]
    Cancelled,
    #[error("browser model data did not match the manifest: {code}")]
    Integrity { code: &'static str },
}

impl From<WebHostError> for ModelPackError {
    fn from(error: WebHostError) -> Self {
        match error {
            WebHostError::QuotaExceeded => Self::QuotaExceeded,
            WebHostError::Cancelled => Self::Store { code: "cancelled" },
            WebHostError::Unavailable => Self::Store {
                code: "unavailable",
            },
            WebHostError::Store { code }
            | WebHostError::Network { code }
            | WebHostError::Integrity { code } => Self::Store { code },
        }
    }
}

#[async_trait(?Send)]
pub trait WebModelStoreHost {
    async fn persistence_report(&self) -> Result<WebPersistenceReport, WebHostError>;
    async fn read_json(&self, key: &str) -> Result<Option<String>, WebHostError>;
    async fn write_json(&mut self, key: &str, value: &str) -> Result<(), WebHostError>;
    async fn delete_json(&mut self, key: &str) -> Result<(), WebHostError>;
    async fn staging_len(&self, storage_key: &str) -> Result<u64, WebHostError>;
    async fn read_staging(&self, storage_key: &str) -> Result<Vec<u8>, WebHostError>;
    async fn append_staging(
        &mut self,
        storage_key: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), WebHostError>;
    async fn clear_staging(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn promote_staging(&mut self, stored: &StoredFile) -> Result<(), WebHostError>;
    async fn remove_pack_data(&mut self, pack_id: &str) -> Result<(), WebHostError>;
}

#[async_trait(?Send)]
pub trait WebNetworkHost {
    async fn fetch_range(
        &mut self,
        request: WebFetchRequest,
    ) -> Result<WebFetchedChunk, WebHostError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebDownloadPolicy {
    pub max_chunk_bytes: u64,
}

impl WebDownloadPolicy {
    pub fn bounded(max_chunk_bytes: u64) -> Result<Self, WebHostError> {
        if max_chunk_bytes == 0 {
            return Err(WebHostError::Store { code: "policy" });
        }
        Ok(Self { max_chunk_bytes })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebDownloadReceipt {
    pub byte_size: u64,
    pub sha256: String,
    pub resumed_from: u64,
}

#[derive(Debug)]
pub struct WebModelDownloader {
    policy: WebDownloadPolicy,
}

impl WebModelDownloader {
    pub fn new(policy: WebDownloadPolicy) -> Self {
        Self { policy }
    }

    pub async fn download<N, S, F>(
        &self,
        network: &mut N,
        store: &mut S,
        task: &DownloadTask,
        cancellation: &CancellationToken,
        mut progress: F,
    ) -> Result<WebDownloadReceipt, WebHostError>
    where
        N: WebNetworkHost,
        S: WebModelStoreHost,
        F: FnMut(u64, u64),
    {
        validate_digest(&task.expected_sha256)?;
        if task.expected_bytes == 0 {
            return Err(WebHostError::Integrity { code: "size" });
        }
        if cancellation.is_cancelled() {
            return Err(WebHostError::Cancelled);
        }

        let mut offset = store.staging_len(&task.storage_key).await?;
        if offset > task.expected_bytes {
            store.clear_staging(&task.storage_key).await?;
            offset = 0;
        }
        if offset == task.expected_bytes {
            let bytes = store.read_staging(&task.storage_key).await?;
            let digest = sha256_hex(&bytes);
            if digest == task.expected_sha256 {
                progress(offset, task.expected_bytes);
                return Ok(WebDownloadReceipt {
                    byte_size: offset,
                    sha256: digest,
                    resumed_from: offset,
                });
            }
            store.clear_staging(&task.storage_key).await?;
            offset = 0;
        }

        let resumed_from = offset;
        progress(offset, task.expected_bytes);
        while offset < task.expected_bytes {
            if cancellation.is_cancelled() {
                return Err(WebHostError::Cancelled);
            }
            let remaining = task.expected_bytes.saturating_sub(offset);
            let chunk = network
                .fetch_range(WebFetchRequest {
                    url: task.url.clone(),
                    offset,
                    max_bytes: remaining.min(self.policy.max_chunk_bytes),
                })
                .await?;
            if chunk.bytes.is_empty() {
                return Err(WebHostError::Network { code: "empty" });
            }
            let chunk_len = u64::try_from(chunk.bytes.len())
                .map_err(|_| WebHostError::Integrity { code: "size" })?;
            let next_offset = offset
                .checked_add(chunk_len)
                .ok_or(WebHostError::Integrity { code: "size" })?;
            if next_offset > task.expected_bytes {
                store.clear_staging(&task.storage_key).await?;
                return Err(WebHostError::Integrity { code: "size" });
            }
            store
                .append_staging(&task.storage_key, offset, &chunk.bytes)
                .await?;
            offset = next_offset;
            progress(offset, task.expected_bytes);
            if chunk.finished && offset != task.expected_bytes {
                return Err(WebHostError::Integrity { code: "size" });
            }
        }

        let bytes = store.read_staging(&task.storage_key).await?;
        let byte_size =
            u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
        if byte_size != task.expected_bytes {
            return Err(WebHostError::Integrity { code: "size" });
        }
        let sha256 = sha256_hex(&bytes);
        if sha256 != task.expected_sha256 {
            store.clear_staging(&task.storage_key).await?;
            return Err(WebHostError::Integrity { code: "hash" });
        }
        Ok(WebDownloadReceipt {
            byte_size,
            sha256,
            resumed_from,
        })
    }
}

#[derive(Debug)]
pub struct WebModelStore<H> {
    host: H,
    now: u64,
    withdrawn_corrupt: BTreeSet<String>,
    withdrawn_revoked: BTreeSet<String>,
}

impl<H> WebModelStore<H> {
    pub fn new(host: H) -> Self {
        Self {
            host,
            now: 0,
            withdrawn_corrupt: BTreeSet::new(),
            withdrawn_revoked: BTreeSet::new(),
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn advance_clock(&mut self, delta: u64) {
        self.now = self.now.saturating_add(delta);
    }
}

impl<H: WebModelStoreHost> WebModelStore<H> {
    pub async fn signal_recovery(
        &mut self,
        pack_id: &str,
        signal: WebRecoverySignal,
    ) -> Result<(), ModelPackError> {
        match signal {
            WebRecoverySignal::Evicted | WebRecoverySignal::Corrupt => {
                self.withdrawn_corrupt.insert(pack_id.to_owned());
                self.clear_active_if_pack(pack_id).await?;
            }
            WebRecoverySignal::Revoked => {
                self.withdrawn_revoked.insert(pack_id.to_owned());
                self.clear_active_if_pack(pack_id).await?;
            }
            WebRecoverySignal::Recovered => {
                self.withdrawn_corrupt.remove(pack_id);
            }
        }
        Ok(())
    }

    fn ensure_not_withdrawn(&self, pack_id: &str) -> Result<(), ModelPackError> {
        if self.withdrawn_corrupt.contains(pack_id) {
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        if self.withdrawn_revoked.contains(pack_id) {
            return Err(ModelPackError::Store { code: "revoked" });
        }
        Ok(())
    }

    async fn clear_active_if_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        if self
            .active_pack()
            .await?
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            self.host.delete_json(ACTIVE_KEY).await?;
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl<H: WebModelStoreHost> ModelStore for WebModelStore<H> {
    async fn status(&self) -> Result<StoreStatus, ModelPackError> {
        Ok(self.host.persistence_report().await?.status)
    }

    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        read_json(
            &self.host,
            &lifecycle_key(pack_id, pack_version, variant_id),
        )
        .await
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        write_json(
            &mut self.host,
            &lifecycle_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
            &snapshot,
        )
        .await
    }

    async fn reserve_file(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
        file: &ModelPackFile,
    ) -> Result<DownloadTask, ModelPackError> {
        if !selection.belongs_to(manifest) || !selection.file_ids().contains(&file.file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.ensure_not_withdrawn(&manifest.manifest().pack_id)?;
        let status = self.status().await?;
        if let Some(available) = status.bytes_available {
            if status
                .bytes_used
                .saturating_add(status.bytes_reserved)
                .saturating_add(file.byte_size)
                > available
            {
                return Err(ModelPackError::QuotaExceeded);
            }
        }
        let storage_key = file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        );
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
        write_json(&mut self.host, &reservation_key(&storage_key), &task).await?;
        Ok(task)
    }

    async fn resume_metadata(
        &self,
        storage_key: &str,
    ) -> Result<Option<DownloadTask>, ModelPackError> {
        read_json(&self.host, &reservation_key(storage_key)).await
    }

    async fn promote_file(
        &mut self,
        storage_key: &str,
        sha256: &str,
        byte_size: u64,
    ) -> Result<StoredFile, ModelPackError> {
        let task: DownloadTask = read_json(&self.host, &reservation_key(storage_key))
            .await?
            .ok_or(ModelPackError::Store {
                code: "reservation",
            })?;
        if task.expected_sha256 != sha256 {
            return Err(ModelPackError::Store { code: "hash" });
        }
        if task.expected_bytes != byte_size {
            return Err(ModelPackError::Store { code: "size" });
        }
        self.ensure_not_withdrawn(&task.pack_id)?;
        let stored = StoredFile {
            storage_key: storage_key.to_owned(),
            pack_id: task.pack_id,
            pack_version: task.pack_version,
            file_id: task.file_id,
            variant_id: task.variant_id,
            sha256: sha256.to_owned(),
            byte_size,
            state: InstallState::Ready,
            stored_at: self.now,
        };
        self.host.promote_staging(&stored).await?;
        write_json(&mut self.host, &file_key(storage_key), &stored).await?;
        self.host.delete_json(&reservation_key(storage_key)).await?;
        Ok(stored)
    }

    async fn activate_pack(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.ensure_not_withdrawn(&manifest.manifest().pack_id)?;
        for file in manifest
            .manifest()
            .files
            .iter()
            .filter(|file| selection.file_ids().contains(&file.file_id))
        {
            let key = file_storage_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
                &file.file_id,
            );
            let stored: StoredFile =
                read_json(&self.host, &file_key(&key))
                    .await?
                    .ok_or(ModelPackError::Store {
                        code: "missing_file",
                    })?;
            if stored.sha256 != file.sha256 || stored.byte_size != file.byte_size {
                return Err(ModelPackError::Store { code: "corrupt" });
            }
        }

        let current_key = lifecycle_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
        );
        let current = self
            .lifecycle(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
            )
            .await?
            .unwrap_or_else(|| {
                create_lifecycle_snapshot(
                    manifest.manifest().pack_id.clone(),
                    manifest.manifest().pack_version.clone(),
                    selection.variant_id().to_owned(),
                    self.now,
                    InstallState::Ready,
                )
            });
        if !matches!(current.state, InstallState::Ready | InstallState::Active) {
            return Err(ModelPackError::Store { code: "not_ready" });
        }
        let next = if current.state == InstallState::Active {
            current
        } else {
            apply_lifecycle_event(&current, InstallEvent::Activate, self.now, None)?
        };
        let previous_active = self.active_pack().await?;
        let mut restore = BTreeMap::new();
        restore.insert(
            ACTIVE_KEY.to_owned(),
            self.host.read_json(ACTIVE_KEY).await?,
        );
        restore.insert(
            ROLLBACK_KEY.to_owned(),
            self.host.read_json(ROLLBACK_KEY).await?,
        );
        restore.insert(
            current_key.clone(),
            self.host.read_json(&current_key).await?,
        );
        if let Some(active) = previous_active.as_ref() {
            let key = lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(key.clone(), self.host.read_json(&key).await?);
        }

        let result: Result<(), ModelPackError> = async {
            if let Some(active) = previous_active.as_ref() {
                if active.pack_id != manifest.manifest().pack_id
                    || active.pack_version != manifest.manifest().pack_version
                {
                    write_json(&mut self.host, ROLLBACK_KEY, active).await?;
                    if let Some(snapshot) = self
                        .lifecycle(&active.pack_id, &active.pack_version, &active.variant_id)
                        .await?
                    {
                        let deactivated = apply_lifecycle_event(
                            &snapshot,
                            InstallEvent::Deactivate,
                            self.now,
                            None,
                        )?;
                        write_json(
                            &mut self.host,
                            &lifecycle_key(
                                &deactivated.pack_id,
                                &deactivated.pack_version,
                                &deactivated.variant_id,
                            ),
                            &deactivated,
                        )
                        .await?;
                    }
                }
            }
            write_json(&mut self.host, &current_key, &next).await?;
            write_json(
                &mut self.host,
                ACTIVE_KEY,
                &ActivePackIdentity {
                    pack_id: next.pack_id.clone(),
                    pack_version: next.pack_version.clone(),
                    variant_id: selection.variant_id().to_owned(),
                },
            )
            .await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            restore_json(&mut self.host, restore).await;
            return Err(error);
        }
        Ok(next)
    }

    async fn rollback_active(&mut self) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        let Some(rollback): Option<ActivePackIdentity> =
            read_json(&self.host, ROLLBACK_KEY).await?
        else {
            return Ok(None);
        };
        self.ensure_not_withdrawn(&rollback.pack_id)?;
        if let Some(active) = self.active_pack().await? {
            if let Some(snapshot) = self
                .lifecycle(&active.pack_id, &active.pack_version, &active.variant_id)
                .await?
            {
                let ready =
                    apply_lifecycle_event(&snapshot, InstallEvent::Deactivate, self.now, None)?;
                write_json(
                    &mut self.host,
                    &lifecycle_key(&ready.pack_id, &ready.pack_version, &ready.variant_id),
                    &ready,
                )
                .await?;
            }
        }
        let snapshot = self
            .lifecycle(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            )
            .await?
            .ok_or(ModelPackError::Store { code: "rollback" })?;
        let active = apply_lifecycle_event(&snapshot, InstallEvent::Activate, self.now, None)?;
        write_json(
            &mut self.host,
            &lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id),
            &active,
        )
        .await?;
        write_json(
            &mut self.host,
            ACTIVE_KEY,
            &ActivePackIdentity {
                pack_id: active.pack_id.clone(),
                pack_version: active.pack_version.clone(),
                variant_id: rollback.variant_id,
            },
        )
        .await?;
        self.host.delete_json(ROLLBACK_KEY).await?;
        Ok(Some(active))
    }

    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        self.host.remove_pack_data(pack_id).await?;
        if self
            .active_pack()
            .await?
            .as_ref()
            .is_some_and(|active| active.pack_id == pack_id)
        {
            self.host.delete_json(ACTIVE_KEY).await?;
        }
        let rollback: Option<ActivePackIdentity> = read_json(&self.host, ROLLBACK_KEY).await?;
        if rollback
            .as_ref()
            .is_some_and(|identity| identity.pack_id == pack_id)
        {
            self.host.delete_json(ROLLBACK_KEY).await?;
        }
        Ok(())
    }

    async fn active_pack(&self) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        read_json(&self.host, ACTIVE_KEY).await
    }

    async fn open_immutable_file(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError> {
        if !selection.file_ids().contains(file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.ensure_not_withdrawn(selection.pack_id())?;
        let storage_key = file_storage_key(
            selection.pack_id(),
            selection.pack_version(),
            selection.variant_id(),
            file_id,
        );
        let stored: StoredFile = read_json(&self.host, &file_key(&storage_key))
            .await?
            .ok_or(ModelPackError::Store {
                code: "missing_file",
            })?;
        if stored.variant_id != selection.variant_id() {
            return Err(ModelPackError::Store { code: "selection" });
        }
        Ok(ImmutableModelFile {
            storage_key: stored.storage_key,
            sha256: stored.sha256,
            byte_size: stored.byte_size,
            variant_id: stored.variant_id,
        })
    }
}

#[derive(Clone)]
pub struct InMemoryWebHost {
    bytes_available: Option<u64>,
    persistent: bool,
    kind: BrowserPersistenceKind,
    evicted: bool,
    json: BTreeMap<String, String>,
    staging: BTreeMap<String, Vec<u8>>,
    files: BTreeMap<String, Vec<u8>>,
    fail_next_write: bool,
}

impl std::fmt::Debug for InMemoryWebHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InMemoryWebHost")
            .field("bytes_available", &self.bytes_available)
            .field("persistent", &self.persistent)
            .field("kind", &self.kind)
            .field("evicted", &self.evicted)
            .field("json_entries", &self.json.len())
            .field("staging_entries", &self.staging.len())
            .field("file_entries", &self.files.len())
            .finish()
    }
}

impl InMemoryWebHost {
    pub fn new(bytes_available: Option<u64>) -> Self {
        Self {
            bytes_available,
            persistent: true,
            kind: BrowserPersistenceKind::OpfsPreferred,
            evicted: false,
            json: BTreeMap::new(),
            staging: BTreeMap::new(),
            files: BTreeMap::new(),
            fail_next_write: false,
        }
    }

    pub fn indexed_db_fallback(mut self) -> Self {
        self.kind = BrowserPersistenceKind::IndexedDbFallback;
        self
    }

    pub fn set_evicted(&mut self, evicted: bool) {
        self.evicted = evicted;
    }

    pub fn fail_next_write(&mut self) {
        self.fail_next_write = true;
    }

    fn maybe_fail(&mut self) -> Result<(), WebHostError> {
        if self.fail_next_write {
            self.fail_next_write = false;
            Err(WebHostError::Store {
                code: "persistence",
            })
        } else {
            Ok(())
        }
    }

    fn used_bytes(&self) -> u64 {
        self.files
            .values()
            .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .sum()
    }

    fn reserved_bytes(&self) -> u64 {
        self.json
            .iter()
            .filter(|(key, _)| key.starts_with(RESERVED_PREFIX))
            .filter_map(|(_, value)| serde_json::from_str::<DownloadTask>(value).ok())
            .map(|task| task.expected_bytes)
            .sum()
    }
}

#[async_trait(?Send)]
impl WebModelStoreHost for InMemoryWebHost {
    async fn persistence_report(&self) -> Result<WebPersistenceReport, WebHostError> {
        Ok(WebPersistenceReport {
            status: StoreStatus {
                bytes_used: self.used_bytes(),
                bytes_reserved: self.reserved_bytes(),
                bytes_available: self.bytes_available,
                persistent: self.persistent,
            },
            kind: self.kind,
            evicted: self.evicted,
        })
    }

    async fn read_json(&self, key: &str) -> Result<Option<String>, WebHostError> {
        Ok(self.json.get(key).cloned())
    }

    async fn write_json(&mut self, key: &str, value: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.json.insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    async fn delete_json(&mut self, key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.json.remove(key);
        Ok(())
    }

    async fn staging_len(&self, storage_key: &str) -> Result<u64, WebHostError> {
        Ok(self
            .staging
            .get(storage_key)
            .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .unwrap_or(0))
    }

    async fn read_staging(&self, storage_key: &str) -> Result<Vec<u8>, WebHostError> {
        Ok(self.staging.get(storage_key).cloned().unwrap_or_default())
    }

    async fn append_staging(
        &mut self,
        storage_key: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let expected_offset = self
            .staging
            .get(storage_key)
            .map(|current| u64::try_from(current.len()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        if expected_offset != offset {
            return Err(WebHostError::Store { code: "resume" });
        }
        let additional =
            u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
        if let Some(available) = self.bytes_available {
            if self
                .used_bytes()
                .saturating_add(self.reserved_bytes())
                .saturating_add(additional)
                > available
            {
                return Err(WebHostError::QuotaExceeded);
            }
        }
        let current = self.staging.entry(storage_key.to_owned()).or_default();
        current.extend_from_slice(bytes);
        Ok(())
    }

    async fn clear_staging(&mut self, storage_key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.staging.remove(storage_key);
        Ok(())
    }

    async fn promote_staging(&mut self, stored: &StoredFile) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let bytes = self
            .staging
            .remove(&stored.storage_key)
            .ok_or(WebHostError::Store { code: "staging" })?;
        let len =
            u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
        if len != stored.byte_size {
            return Err(WebHostError::Integrity { code: "size" });
        }
        self.files.insert(stored.storage_key.clone(), bytes);
        Ok(())
    }

    async fn remove_pack_data(&mut self, pack_id: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let mut promoted_storage_keys = BTreeSet::new();
        let metadata_keys: BTreeSet<String> = self
            .json
            .iter()
            .filter(|(key, _)| key.starts_with(FILE_PREFIX) || key.starts_with(RESERVED_PREFIX))
            .filter_map(|(key, value)| {
                if let Ok(file) = serde_json::from_str::<StoredFile>(value) {
                    if file.pack_id == pack_id {
                        promoted_storage_keys.insert(file.storage_key);
                        return Some(key.clone());
                    }
                }
                serde_json::from_str::<DownloadTask>(value)
                    .ok()
                    .filter(|task| task.pack_id == pack_id)
                    .map(|_| key.clone())
            })
            .collect();
        for key in metadata_keys {
            self.json.remove(&key);
        }
        for storage_key in promoted_storage_keys {
            self.files.remove(&storage_key);
        }
        self.json.retain(|key, value| {
            if key.starts_with(LIFECYCLE_PREFIX) {
                serde_json::from_str::<LifecycleSnapshot>(value)
                    .map(|snapshot| snapshot.pack_id != pack_id)
                    .unwrap_or(true)
            } else {
                true
            }
        });
        Ok(())
    }
}

#[derive(Clone)]
pub struct InMemoryNetworkHost {
    assets: BTreeMap<String, Vec<u8>>,
    chunk_limit: usize,
    fail_after_chunks: Option<usize>,
    chunks_served: usize,
}

impl std::fmt::Debug for InMemoryNetworkHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InMemoryNetworkHost")
            .field("asset_count", &self.assets.len())
            .field("chunk_limit", &self.chunk_limit)
            .field("fail_after_chunks", &self.fail_after_chunks)
            .field("chunks_served", &self.chunks_served)
            .finish()
    }
}

impl InMemoryNetworkHost {
    pub fn new(chunk_limit: usize) -> Self {
        Self {
            assets: BTreeMap::new(),
            chunk_limit: chunk_limit.max(1),
            fail_after_chunks: None,
            chunks_served: 0,
        }
    }

    pub fn insert(&mut self, url: impl Into<String>, bytes: Vec<u8>) {
        self.assets.insert(url.into(), bytes);
    }

    pub fn fail_after_chunks(&mut self, chunks: usize) {
        self.fail_after_chunks = Some(chunks);
    }

    pub fn clear_failure(&mut self) {
        self.fail_after_chunks = None;
    }
}

#[async_trait(?Send)]
impl WebNetworkHost for InMemoryNetworkHost {
    async fn fetch_range(
        &mut self,
        request: WebFetchRequest,
    ) -> Result<WebFetchedChunk, WebHostError> {
        if self
            .fail_after_chunks
            .is_some_and(|limit| self.chunks_served >= limit)
        {
            return Err(WebHostError::Network {
                code: "interrupted",
            });
        }
        let asset = self
            .assets
            .get(&request.url)
            .ok_or(WebHostError::Network { code: "missing" })?;
        let offset = usize::try_from(request.offset)
            .map_err(|_| WebHostError::Integrity { code: "size" })?;
        if offset > asset.len() {
            return Err(WebHostError::Network { code: "range" });
        }
        let requested = usize::try_from(request.max_bytes)
            .unwrap_or(usize::MAX)
            .min(self.chunk_limit);
        let end = offset.saturating_add(requested).min(asset.len());
        self.chunks_served = self.chunks_served.saturating_add(1);
        Ok(WebFetchedChunk {
            bytes: asset[offset..end].to_vec(),
            finished: end == asset.len(),
        })
    }
}

async fn read_json<T: DeserializeOwned, H: WebModelStoreHost>(
    host: &H,
    key: &str,
) -> Result<Option<T>, ModelPackError> {
    host.read_json(key)
        .await?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| ModelPackError::Store { code: "metadata" })
        })
        .transpose()
}

async fn write_json<T: Serialize, H: WebModelStoreHost>(
    host: &mut H,
    key: &str,
    value: &T,
) -> Result<(), ModelPackError> {
    let value =
        serde_json::to_string(value).map_err(|_| ModelPackError::Store { code: "metadata" })?;
    host.write_json(key, &value).await?;
    Ok(())
}

async fn restore_json<H: WebModelStoreHost>(
    host: &mut H,
    restore: BTreeMap<String, Option<String>>,
) {
    for (key, value) in restore {
        let _ = if let Some(value) = value {
            host.write_json(&key, &value).await
        } else {
            host.delete_json(&key).await
        };
    }
}

fn lifecycle_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    format!("{LIFECYCLE_PREFIX}{pack_id}@{pack_version}:{variant_id}")
}

fn reservation_key(storage_key: &str) -> String {
    format!("{RESERVED_PREFIX}{storage_key}")
}

fn file_key(storage_key: &str) -> String {
    format!("{FILE_PREFIX}{storage_key}")
}

fn validate_digest(value: &str) -> Result<(), WebHostError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(WebHostError::Integrity { code: "hash" })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    aurora_voice_engine::sha256_hex(bytes)
}
