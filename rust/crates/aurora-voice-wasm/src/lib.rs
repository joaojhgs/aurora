//! Thin WebAssembly exports and browser-host ports for the shared voice core.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{
    apply_lifecycle_event, create_lifecycle_snapshot, file_storage_key, ActivePackIdentity,
    DownloadTask, ImmutableModelFile, InstallEvent, InstallState, LifecycleSnapshot,
    ModelPackError, ModelPackFile, ModelStore, ModelStoreScope, SelectedVariant, StoreStatus,
    StoredFile, VerifiedManifest,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

const ACTIVE_PREFIX: &str = "aurora.voice.web-store.v1:active:";
const ROLLBACK_PREFIX: &str = "aurora.voice.web-store.v1:rollback:";
const RESERVED_PREFIX: &str = "aurora.voice.web-store.v1:reserved:";
const PROMOTION_PREFIX: &str = "aurora.voice.web-store.v1:promotion:";
const LIFECYCLE_PREFIX: &str = "aurora.voice.web-store.v1:lifecycle:";
const LIFECYCLE_BACKING_PREFIX: &str = "aurora.voice.web-store.v1:lifecycle-backing:";
const MUTATION_PREFIX: &str = "aurora.voice.web-store.v1:mutation:";
const FILE_PREFIX: &str = "aurora.voice.web-store.v1:file:";
const WITHDRAWAL_KEY: &str = "aurora.voice.web-store.v1:withdrawn";
const HASH_CHUNK_BYTES: u64 = 64 * 1024;

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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct WithdrawalState {
    corrupt: BTreeSet<String>,
    revoked: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PromotionJournal {
    storage_key: String,
    pack_id: String,
    pack_version: String,
    file_id: String,
    variant_id: String,
    expected_sha256: String,
    expected_bytes: u64,
    stored_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ActivePackRecord {
    identity: ActivePackIdentity,
    files: Vec<ActiveFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ActiveFileRecord {
    storage_key: String,
    sha256: String,
    byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LifecycleBackingRecord {
    files: Vec<ActiveFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ScopeMutationJournal {
    #[serde(default)]
    affected_lifecycles: BTreeSet<String>,
    restore: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebRecoverySignal {
    Evicted,
    Recovered,
    Corrupt,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebFileStat {
    pub byte_size: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebFetchRequest {
    pub url: String,
    pub offset: u64,
    pub max_bytes: u64,
    pub timeout_millis: u64,
}

impl std::fmt::Debug for WebFetchRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebFetchRequest")
            .field("url", &"<redacted>")
            .field("offset", &self.offset)
            .field("max_bytes", &self.max_bytes)
            .field("timeout_millis", &self.timeout_millis)
            .finish()
    }
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
    #[error("browser model download timed out")]
    Timeout,
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
            WebHostError::Timeout => Self::Store { code: "timeout" },
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
    async fn list_json_keys(&self, prefix: &str) -> Result<Vec<String>, WebHostError>;
    async fn staging_len(&self, storage_key: &str) -> Result<u64, WebHostError>;
    async fn read_staging_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError>;
    async fn append_staging(
        &mut self,
        storage_key: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), WebHostError>;
    async fn clear_staging(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn promoted_stat(&self, storage_key: &str) -> Result<Option<WebFileStat>, WebHostError>;
    async fn read_promoted_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError>;
    async fn promote_staging_atomic(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn delete_promoted(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn list_promoted_keys(&self) -> Result<Vec<String>, WebHostError>;
    async fn remove_pack_data(&mut self, pack_id: &str) -> Result<(), WebHostError>;
}

#[async_trait(?Send)]
pub trait WebNetworkHost {
    async fn fetch_range(
        &mut self,
        request: WebFetchRequest,
        cancellation: &CancellationToken,
    ) -> Result<WebFetchedChunk, WebHostError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebDownloadPolicy {
    pub max_chunk_bytes: u64,
    pub fetch_timeout_millis: u64,
}

impl WebDownloadPolicy {
    pub fn bounded(max_chunk_bytes: u64) -> Result<Self, WebHostError> {
        if max_chunk_bytes == 0 {
            return Err(WebHostError::Store { code: "policy" });
        }
        Ok(Self {
            max_chunk_bytes,
            fetch_timeout_millis: 30_000,
        })
    }

    pub fn with_fetch_timeout_millis(mut self, timeout_millis: u64) -> Self {
        self.fetch_timeout_millis = timeout_millis;
        self
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebDownloadReceipt {
    pub byte_size: u64,
    pub sha256: String,
    pub resumed_from: u64,
}

impl std::fmt::Debug for WebDownloadReceipt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebDownloadReceipt")
            .field("byte_size", &self.byte_size)
            .field("sha256", &"<redacted>")
            .field("resumed_from", &self.resumed_from)
            .finish()
    }
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
            let digest =
                hash_staging_chunks(store, &task.storage_key, self.policy.max_chunk_bytes).await?;
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
                .fetch_range(
                    WebFetchRequest {
                        url: task.url.clone(),
                        offset,
                        max_bytes: remaining.min(self.policy.max_chunk_bytes),
                        timeout_millis: self.policy.fetch_timeout_millis,
                    },
                    cancellation,
                )
                .await?;
            if cancellation.is_cancelled() {
                return Err(WebHostError::Cancelled);
            }
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

        let byte_size = store.staging_len(&task.storage_key).await?;
        if byte_size != task.expected_bytes {
            return Err(WebHostError::Integrity { code: "size" });
        }
        let sha256 =
            hash_staging_chunks(store, &task.storage_key, self.policy.max_chunk_bytes).await?;
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
}

impl<H> WebModelStore<H> {
    pub fn new(host: H) -> Self {
        Self { host, now: 0 }
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
        let mut state = self.withdrawal_state().await?;
        match signal {
            WebRecoverySignal::Evicted | WebRecoverySignal::Corrupt => {
                state.corrupt.insert(pack_id.to_owned());
                self.clear_active_if_pack(pack_id).await?;
            }
            WebRecoverySignal::Revoked => {
                state.revoked.insert(pack_id.to_owned());
                self.clear_active_if_pack(pack_id).await?;
            }
            WebRecoverySignal::Recovered => {
                state.corrupt.remove(pack_id);
            }
        }
        write_json(&mut self.host, WITHDRAWAL_KEY, &state).await?;
        Ok(())
    }

    async fn ensure_not_withdrawn(&self, pack_id: &str) -> Result<(), ModelPackError> {
        let state = self.withdrawal_state().await?;
        if state.corrupt.contains(pack_id) {
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        if state.revoked.contains(pack_id) {
            return Err(ModelPackError::Store { code: "revoked" });
        }
        Ok(())
    }

    async fn withdrawal_state(&self) -> Result<WithdrawalState, ModelPackError> {
        Ok(read_json(&self.host, WITHDRAWAL_KEY)
            .await?
            .unwrap_or_default())
    }

    async fn clear_active_if_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        for key in self.host.list_json_keys(ACTIVE_PREFIX).await? {
            let active: Option<ActivePackRecord> = read_json(&self.host, &key).await?;
            if active
                .as_ref()
                .is_some_and(|active| active.identity.pack_id == pack_id)
            {
                self.host.delete_json(&key).await?;
            }
        }
        Ok(())
    }

    pub async fn recover_scope_transactions(&mut self) -> Result<(), ModelPackError> {
        for key in self.host.list_json_keys(MUTATION_PREFIX).await? {
            let Some(journal): Option<ScopeMutationJournal> = read_json(&self.host, &key).await?
            else {
                self.host.delete_json(&key).await?;
                continue;
            };
            restore_json(&mut self.host, journal.restore).await?;
            self.host.delete_json(&key).await?;
        }
        Ok(())
    }

    pub async fn recover_promotions(&mut self) -> Result<(), ModelPackError> {
        for key in self.host.list_json_keys(PROMOTION_PREFIX).await? {
            let Some(journal): Option<PromotionJournal> = read_json(&self.host, &key).await? else {
                continue;
            };
            let Some(stat) = self.host.promoted_stat(&journal.storage_key).await? else {
                continue;
            };
            if stat.byte_size != journal.expected_bytes {
                self.host.delete_promoted(&journal.storage_key).await?;
                self.host.delete_json(&key).await?;
                continue;
            }
            let (byte_size, sha256) =
                hash_promoted_chunks(&self.host, &journal.storage_key, HASH_CHUNK_BYTES).await?;
            if byte_size != journal.expected_bytes || sha256 != journal.expected_sha256 {
                self.host.delete_promoted(&journal.storage_key).await?;
                self.host.delete_json(&key).await?;
                continue;
            }
            let stored = StoredFile {
                storage_key: journal.storage_key.clone(),
                pack_id: journal.pack_id,
                pack_version: journal.pack_version,
                file_id: journal.file_id,
                variant_id: journal.variant_id,
                sha256,
                byte_size,
                state: InstallState::Ready,
                stored_at: journal.stored_at,
            };
            write_json(&mut self.host, &file_key(&stored.storage_key), &stored).await?;
            self.host
                .delete_json(&reservation_key(&stored.storage_key))
                .await?;
            self.host.delete_json(&key).await?;
        }
        for storage_key in self.host.list_promoted_keys().await? {
            let has_file_metadata = self
                .host
                .read_json(&file_key(&storage_key))
                .await?
                .is_some();
            let has_promotion_journal = self
                .host
                .read_json(&promotion_key(&storage_key))
                .await?
                .is_some();
            if !has_file_metadata && !has_promotion_journal {
                self.host.delete_promoted(&storage_key).await?;
            }
        }
        Ok(())
    }

    async fn active_record(
        &self,
        scope: &ModelStoreScope,
    ) -> Result<Option<ActivePackRecord>, ModelPackError> {
        let Some(record): Option<ActivePackRecord> =
            read_json(&self.host, &active_key(scope)).await?
        else {
            return Ok(None);
        };
        if record.identity.scope != *scope {
            return Ok(None);
        }
        self.ensure_not_withdrawn(&record.identity.pack_id).await?;
        if !self.validate_file_records(&record.files).await? {
            return Ok(None);
        }
        Ok(Some(record))
    }

    async fn active_elsewhere(
        &self,
        excluded_scope: &ModelStoreScope,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<bool, ModelPackError> {
        let excluded_key = active_key(excluded_scope);
        for key in self.host.list_json_keys(ACTIVE_PREFIX).await? {
            if key == excluded_key {
                continue;
            }
            let Some(record): Option<ActivePackRecord> = read_json(&self.host, &key).await? else {
                continue;
            };
            if record.identity.pack_id == pack_id
                && record.identity.pack_version == pack_version
                && record.identity.variant_id == variant_id
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn validate_file_records(
        &self,
        files: &[ActiveFileRecord],
    ) -> Result<bool, ModelPackError> {
        if files.is_empty() {
            return Ok(false);
        }
        for file in files {
            let Some(stored): Option<StoredFile> =
                read_json(&self.host, &file_key(&file.storage_key)).await?
            else {
                return Ok(false);
            };
            if stored.sha256 != file.sha256 || stored.byte_size != file.byte_size {
                return Ok(false);
            }
            let Ok((byte_size, sha256)) =
                hash_promoted_chunks(&self.host, &file.storage_key, HASH_CHUNK_BYTES).await
            else {
                return Ok(false);
            };
            if byte_size != file.byte_size || sha256 != file.sha256 {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn selected_file_records(
        &self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<Vec<ActiveFileRecord>, ModelPackError> {
        let mut records = Vec::new();
        for file_id in selection.file_ids() {
            let file = manifest
                .manifest()
                .files
                .iter()
                .find(|file| file.file_id == *file_id)
                .ok_or(ModelPackError::Store { code: "selection" })?;
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
            if !stored_matches(&stored, manifest, selection, file) {
                return Err(ModelPackError::Store { code: "corrupt" });
            }
            let (byte_size, sha256) =
                hash_promoted_chunks(&self.host, &key, HASH_CHUNK_BYTES).await?;
            if sha256 != file.sha256 || byte_size != file.byte_size {
                return Err(ModelPackError::Store { code: "corrupt" });
            }
            records.push(ActiveFileRecord {
                storage_key: key,
                sha256,
                byte_size,
            });
        }
        Ok(records)
    }

    async fn ready_backing_record(
        &self,
        snapshot: &LifecycleSnapshot,
    ) -> Result<LifecycleBackingRecord, ModelPackError> {
        let mut files = Vec::new();
        for key in self.host.list_json_keys(FILE_PREFIX).await? {
            let Some(file): Option<StoredFile> = read_json(&self.host, &key).await? else {
                continue;
            };
            if file.pack_id == snapshot.pack_id
                && file.pack_version == snapshot.pack_version
                && file.variant_id == snapshot.variant_id
            {
                files.push(ActiveFileRecord {
                    storage_key: file.storage_key,
                    sha256: file.sha256,
                    byte_size: file.byte_size,
                });
            }
        }
        Ok(LifecycleBackingRecord { files })
    }

    async fn write_lifecycle_with_backing(
        &mut self,
        snapshot: &LifecycleSnapshot,
        files: &[ActiveFileRecord],
    ) -> Result<(), ModelPackError> {
        write_json(
            &mut self.host,
            &lifecycle_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
            snapshot,
        )
        .await?;
        if matches!(snapshot.state, InstallState::Ready | InstallState::Active) {
            write_json(
                &mut self.host,
                &lifecycle_backing_key(
                    &snapshot.pack_id,
                    &snapshot.pack_version,
                    &snapshot.variant_id,
                ),
                &LifecycleBackingRecord {
                    files: files.to_vec(),
                },
            )
            .await?;
        }
        Ok(())
    }

    async fn pending_mutation_affects_lifecycle(
        &self,
        lifecycle_key: &str,
    ) -> Result<bool, ModelPackError> {
        for key in self.host.list_json_keys(MUTATION_PREFIX).await? {
            let Some(journal): Option<ScopeMutationJournal> = read_json(&self.host, &key).await?
            else {
                return Ok(true);
            };
            if journal.affected_lifecycles.is_empty()
                || journal.affected_lifecycles.contains(lifecycle_key)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn additional_reserved_bytes(&self, task: &DownloadTask) -> Result<u64, ModelPackError> {
        for key in self.host.list_json_keys(FILE_PREFIX).await? {
            let Some(file): Option<StoredFile> = read_json(&self.host, &key).await? else {
                continue;
            };
            if file.sha256 == task.expected_sha256 {
                if file.byte_size != task.expected_bytes {
                    return Err(ModelPackError::Store { code: "quota" });
                }
                if let Ok((byte_size, sha256)) =
                    hash_promoted_chunks(&self.host, &file.storage_key, HASH_CHUNK_BYTES).await
                {
                    if byte_size == task.expected_bytes && sha256 == task.expected_sha256 {
                        return Ok(0);
                    }
                }
            }
        }
        for key in self.host.list_json_keys(RESERVED_PREFIX).await? {
            let Some(existing): Option<DownloadTask> = read_json(&self.host, &key).await? else {
                continue;
            };
            if existing.expected_sha256 == task.expected_sha256 {
                if existing.expected_bytes != task.expected_bytes {
                    return Err(ModelPackError::Store { code: "quota" });
                }
                return Ok(0);
            }
        }
        Ok(task.expected_bytes)
    }

    async fn lifecycle_has_valid_backing(
        &self,
        snapshot: &LifecycleSnapshot,
    ) -> Result<bool, ModelPackError> {
        match snapshot.state {
            InstallState::Ready => {
                let Some(backing): Option<LifecycleBackingRecord> = read_json(
                    &self.host,
                    &lifecycle_backing_key(
                        &snapshot.pack_id,
                        &snapshot.pack_version,
                        &snapshot.variant_id,
                    ),
                )
                .await?
                else {
                    return Ok(false);
                };
                self.validate_file_records(&backing.files).await
            }
            InstallState::Active => {
                for key in self.host.list_json_keys(ACTIVE_PREFIX).await? {
                    let Some(record): Option<ActivePackRecord> =
                        read_json(&self.host, &key).await?
                    else {
                        continue;
                    };
                    let identity_matches = record.identity.pack_id == snapshot.pack_id
                        && record.identity.pack_version == snapshot.pack_version
                        && record.identity.variant_id == snapshot.variant_id;
                    if !identity_matches {
                        continue;
                    }
                    let valid_active = self
                        .active_record(&record.identity.scope)
                        .await?
                        .is_some_and(|active| active.identity == record.identity);
                    if valid_active {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            _ => Ok(true),
        }
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
        let key = lifecycle_key(pack_id, pack_version, variant_id);
        let report = self.host.persistence_report().await?;
        if report.evicted || self.pending_mutation_affects_lifecycle(&key).await? {
            return Ok(None);
        }
        let Some(snapshot): Option<LifecycleSnapshot> = read_json(&self.host, &key).await? else {
            return Ok(None);
        };
        let withdrawal = self.withdrawal_state().await?;
        if withdrawal.corrupt.contains(pack_id) || withdrawal.revoked.contains(pack_id) {
            return Ok(None);
        }
        if self.lifecycle_has_valid_backing(&snapshot).await? {
            Ok(Some(snapshot))
        } else {
            Ok(None)
        }
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        let backing = if matches!(snapshot.state, InstallState::Ready | InstallState::Active) {
            self.ready_backing_record(&snapshot).await?.files
        } else {
            Vec::new()
        };
        self.write_lifecycle_with_backing(&snapshot, &backing).await
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
        self.ensure_not_withdrawn(&manifest.manifest().pack_id)
            .await?;
        let status = self.status().await?;
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
        if let Some(existing) = self.resume_metadata(&storage_key).await? {
            if same_task(&existing, &task) {
                return Ok(existing);
            }
            return Err(ModelPackError::Store {
                code: "reservation",
            });
        }
        if read_json::<StoredFile, _>(&self.host, &file_key(&storage_key))
            .await?
            .is_some()
        {
            return Ok(task);
        }
        if let Some(available) = status.bytes_available {
            let additional = self.additional_reserved_bytes(&task).await?;
            let required = status
                .bytes_used
                .checked_add(status.bytes_reserved)
                .and_then(|used| used.checked_add(additional))
                .ok_or(ModelPackError::QuotaExceeded)?;
            if required > available {
                return Err(ModelPackError::QuotaExceeded);
            }
        }
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
        self.ensure_not_withdrawn(&task.pack_id).await?;
        let journal = PromotionJournal {
            storage_key: storage_key.to_owned(),
            pack_id: task.pack_id,
            pack_version: task.pack_version,
            file_id: task.file_id,
            variant_id: task.variant_id,
            stored_at: self.now,
            expected_sha256: sha256.to_owned(),
            expected_bytes: byte_size,
        };
        write_json(&mut self.host, &promotion_key(storage_key), &journal).await?;
        self.host.promote_staging_atomic(storage_key).await?;
        let (actual_bytes, actual_hash) =
            hash_promoted_chunks(&self.host, storage_key, HASH_CHUNK_BYTES).await?;
        if actual_bytes != byte_size || actual_hash != sha256 {
            self.host.delete_promoted(storage_key).await?;
            return Err(ModelPackError::Store { code: "hash" });
        }
        let stored = StoredFile {
            storage_key: storage_key.to_owned(),
            pack_id: journal.pack_id,
            pack_version: journal.pack_version,
            file_id: journal.file_id,
            variant_id: journal.variant_id,
            sha256: actual_hash,
            byte_size: actual_bytes,
            state: InstallState::Ready,
            stored_at: journal.stored_at,
        };
        write_json(&mut self.host, &file_key(storage_key), &stored).await?;
        self.host.delete_json(&reservation_key(storage_key)).await?;
        self.host.delete_json(&promotion_key(storage_key)).await?;
        Ok(stored)
    }

    async fn activate_pack(
        &mut self,
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        validate_scope_task(&scope, manifest, selection)?;
        self.recover_scope_transactions().await?;
        self.recover_promotions().await?;
        self.ensure_not_withdrawn(&manifest.manifest().pack_id)
            .await?;
        let active_files = self.selected_file_records(manifest, selection).await?;

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
        let previous_record = self.active_record(&scope).await?;
        let previous_active = previous_record.as_ref().map(|record| &record.identity);
        let mut restore = BTreeMap::new();
        let active_key = active_key(&scope);
        let rollback_key = rollback_key(&scope);
        restore.insert(active_key.clone(), self.host.read_json(&active_key).await?);
        restore.insert(
            rollback_key.clone(),
            self.host.read_json(&rollback_key).await?,
        );
        restore.insert(
            current_key.clone(),
            self.host.read_json(&current_key).await?,
        );
        let mut affected_lifecycles = BTreeSet::from([current_key.clone()]);
        restore.insert(
            lifecycle_backing_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
            ),
            self.host
                .read_json(&lifecycle_backing_key(
                    &manifest.manifest().pack_id,
                    &manifest.manifest().pack_version,
                    selection.variant_id(),
                ))
                .await?,
        );
        if let Some(active) = previous_active.as_ref() {
            let key = lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(key.clone(), self.host.read_json(&key).await?);
            affected_lifecycles.insert(key);
            let backing_key =
                lifecycle_backing_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(
                backing_key.clone(),
                self.host.read_json(&backing_key).await?,
            );
        }
        let previous_snapshot = if let Some(active) = previous_active {
            self.lifecycle(&active.pack_id, &active.pack_version, &active.variant_id)
                .await?
        } else {
            None
        };

        let result: Result<(), ModelPackError> = async {
            write_json(
                &mut self.host,
                &mutation_key(&scope),
                &ScopeMutationJournal {
                    affected_lifecycles: affected_lifecycles.clone(),
                    restore: restore.clone(),
                },
            )
            .await?;
            if let Some(active) = previous_active {
                if active.pack_id != manifest.manifest().pack_id
                    || active.pack_version != manifest.manifest().pack_version
                    || active.variant_id != selection.variant_id()
                {
                    if let Some(record) = previous_record.as_ref() {
                        write_json(&mut self.host, &rollback_key, record).await?;
                    }
                    if let Some(snapshot) = previous_snapshot.clone() {
                        if !self
                            .active_elsewhere(
                                &scope,
                                &active.pack_id,
                                &active.pack_version,
                                &active.variant_id,
                            )
                            .await?
                        {
                            let deactivated = apply_lifecycle_event(
                                &snapshot,
                                InstallEvent::Deactivate,
                                self.now,
                                None,
                            )?;
                            let backing = self.ready_backing_record(&deactivated).await?.files;
                            self.write_lifecycle_with_backing(&deactivated, &backing)
                                .await?;
                        }
                    }
                }
            }
            self.write_lifecycle_with_backing(&next, &active_files)
                .await?;
            write_json(
                &mut self.host,
                &active_key,
                &ActivePackRecord {
                    identity: ActivePackIdentity {
                        scope: scope.clone(),
                        pack_id: next.pack_id.clone(),
                        pack_version: next.pack_version.clone(),
                        variant_id: selection.variant_id().to_owned(),
                    },
                    files: active_files,
                },
            )
            .await?;
            self.host.delete_json(&mutation_key(&scope)).await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if restore_json(&mut self.host, restore).await.is_ok() {
                let _ = self.host.delete_json(&mutation_key(&scope)).await;
            }
            return Err(error);
        }
        Ok(next)
    }

    async fn rollback_active(
        &mut self,
        scope: ModelStoreScope,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        self.recover_scope_transactions().await?;
        let Some(rollback_record): Option<ActivePackRecord> =
            read_json(&self.host, &rollback_key(&scope)).await?
        else {
            return Ok(None);
        };
        let rollback = rollback_record.identity.clone();
        self.ensure_not_withdrawn(&rollback.pack_id).await?;
        let active_key = active_key(&scope);
        let rollback_key = rollback_key(&scope);
        let mut restore = BTreeMap::new();
        restore.insert(active_key.clone(), self.host.read_json(&active_key).await?);
        restore.insert(
            rollback_key.clone(),
            self.host.read_json(&rollback_key).await?,
        );
        restore.insert(
            lifecycle_key(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            ),
            self.host
                .read_json(&lifecycle_key(
                    &rollback.pack_id,
                    &rollback.pack_version,
                    &rollback.variant_id,
                ))
                .await?,
        );
        let mut affected_lifecycles = BTreeSet::from([lifecycle_key(
            &rollback.pack_id,
            &rollback.pack_version,
            &rollback.variant_id,
        )]);
        restore.insert(
            lifecycle_backing_key(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            ),
            self.host
                .read_json(&lifecycle_backing_key(
                    &rollback.pack_id,
                    &rollback.pack_version,
                    &rollback.variant_id,
                ))
                .await?,
        );
        if let Some(active) = self
            .active_record(&scope)
            .await?
            .map(|record| record.identity)
        {
            let active_lifecycle_key =
                lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(
                active_lifecycle_key.clone(),
                self.host.read_json(&active_lifecycle_key).await?,
            );
            affected_lifecycles.insert(active_lifecycle_key);
            let active_backing_key =
                lifecycle_backing_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(
                active_backing_key.clone(),
                self.host.read_json(&active_backing_key).await?,
            );
        }
        let current_identity = self
            .active_record(&scope)
            .await?
            .map(|record| record.identity);
        let current_snapshot = if let Some(active) = current_identity.as_ref() {
            self.lifecycle(&active.pack_id, &active.pack_version, &active.variant_id)
                .await?
        } else {
            None
        };
        let rollback_snapshot = self
            .lifecycle(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            )
            .await?
            .ok_or(ModelPackError::Store { code: "rollback" })?;

        let result: Result<LifecycleSnapshot, ModelPackError> = async {
            write_json(
                &mut self.host,
                &mutation_key(&scope),
                &ScopeMutationJournal {
                    affected_lifecycles: affected_lifecycles.clone(),
                    restore: restore.clone(),
                },
            )
            .await?;
            if let Some(active) = current_identity {
                if let Some(snapshot) = current_snapshot {
                    if !self
                        .active_elsewhere(
                            &scope,
                            &active.pack_id,
                            &active.pack_version,
                            &active.variant_id,
                        )
                        .await?
                    {
                        let ready = apply_lifecycle_event(
                            &snapshot,
                            InstallEvent::Deactivate,
                            self.now,
                            None,
                        )?;
                        let backing = self.ready_backing_record(&ready).await?.files;
                        self.write_lifecycle_with_backing(&ready, &backing).await?;
                    }
                }
            }
            let active = if rollback_snapshot.state == InstallState::Active {
                rollback_snapshot
            } else {
                apply_lifecycle_event(&rollback_snapshot, InstallEvent::Activate, self.now, None)?
            };
            self.write_lifecycle_with_backing(&active, &rollback_record.files)
                .await?;
            write_json(&mut self.host, &active_key, &rollback_record).await?;
            self.host.delete_json(&rollback_key).await?;
            self.host.delete_json(&mutation_key(&scope)).await?;
            Ok(active)
        }
        .await;
        match result {
            Ok(active) => Ok(Some(active)),
            Err(error) => {
                if restore_json(&mut self.host, restore).await.is_ok() {
                    let _ = self.host.delete_json(&mutation_key(&scope)).await;
                }
                Err(error)
            }
        }
    }

    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        self.recover_scope_transactions().await?;
        self.host.remove_pack_data(pack_id).await?;
        self.clear_active_if_pack(pack_id).await?;
        for key in self.host.list_json_keys(ROLLBACK_PREFIX).await? {
            let rollback: Option<ActivePackRecord> = read_json(&self.host, &key).await?;
            if rollback
                .as_ref()
                .is_some_and(|record| record.identity.pack_id == pack_id)
            {
                self.host.delete_json(&key).await?;
            }
        }
        let mut withdrawal = self.withdrawal_state().await?;
        withdrawal.corrupt.remove(pack_id);
        withdrawal.revoked.remove(pack_id);
        write_json(&mut self.host, WITHDRAWAL_KEY, &withdrawal).await?;
        Ok(())
    }

    async fn active_pack(
        &self,
        scope: ModelStoreScope,
    ) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        if self.host.persistence_report().await?.evicted
            || self.host.read_json(&mutation_key(&scope)).await?.is_some()
        {
            return Ok(None);
        }
        Ok(self
            .active_record(&scope)
            .await?
            .map(|record| record.identity))
    }

    async fn open_immutable_file(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError> {
        if !selection.file_ids().contains(file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        if self.host.persistence_report().await?.evicted {
            return Err(ModelPackError::Store { code: "evicted" });
        }
        self.ensure_not_withdrawn(selection.pack_id()).await?;
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
        if stored.pack_id != selection.pack_id()
            || stored.pack_version != selection.pack_version()
            || stored.variant_id != selection.variant_id()
            || stored.file_id != file_id
        {
            return Err(ModelPackError::Store { code: "selection" });
        }
        let (byte_size, sha256) =
            hash_promoted_chunks(&self.host, &storage_key, HASH_CHUNK_BYTES).await?;
        if stored.byte_size != byte_size || stored.sha256 != sha256 {
            return Err(ModelPackError::Store { code: "corrupt" });
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
    fail_next_write_after_promote: bool,
    max_read_request: Cell<u64>,
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
            .field("max_read_request", &self.max_read_request.get())
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
            fail_next_write_after_promote: false,
            max_read_request: Cell::new(0),
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

    pub fn fail_next_write_after_promote(&mut self) {
        self.fail_next_write_after_promote = true;
    }

    pub fn insert_json(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.json.insert(key.into(), value.into());
    }

    pub fn insert_promoted(&mut self, storage_key: impl Into<String>, bytes: Vec<u8>) {
        self.files.insert(storage_key.into(), bytes);
    }

    pub fn forge_stored_file(&mut self, storage_key: &str, stored: &StoredFile) {
        if let Ok(value) = serde_json::to_string(stored) {
            self.json.insert(file_key(storage_key), value);
        }
    }

    pub fn max_observed_read_request(&self) -> u64 {
        self.max_read_request.get()
    }

    pub fn promoted_contains(&self, storage_key: &str) -> bool {
        self.files.contains_key(storage_key)
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

    fn used_bytes(&self) -> Result<u64, WebHostError> {
        let mut seen_hashes = BTreeMap::new();
        let mut total = 0_u64;
        for bytes in self.files.values() {
            let hash = sha256_hex(bytes);
            let len =
                u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
            if let Some(previous) = seen_hashes.insert(hash, len) {
                if previous != len {
                    return Err(WebHostError::Store { code: "quota" });
                }
            } else {
                total = total.checked_add(len).ok_or(WebHostError::QuotaExceeded)?;
            }
        }
        Ok(total)
    }

    fn reserved_bytes(&self) -> Result<u64, WebHostError> {
        let mut promoted_hashes = BTreeMap::new();
        for bytes in self.files.values() {
            let hash = sha256_hex(bytes);
            let len =
                u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
            promoted_hashes.insert(hash, len);
        }
        let mut seen_reservations = BTreeMap::new();
        let mut total = 0_u64;
        for task in self
            .json
            .iter()
            .filter(|(key, _)| key.starts_with(RESERVED_PREFIX))
            .filter_map(|(_, value)| serde_json::from_str::<DownloadTask>(value).ok())
        {
            if let Some(promoted_size) = promoted_hashes.get(&task.expected_sha256) {
                if *promoted_size != task.expected_bytes {
                    return Err(WebHostError::Store { code: "quota" });
                }
                continue;
            }
            if let Some(previous_size) =
                seen_reservations.insert(task.expected_sha256.clone(), task.expected_bytes)
            {
                if previous_size != task.expected_bytes {
                    return Err(WebHostError::Store { code: "quota" });
                }
                continue;
            }
            total = total
                .checked_add(task.expected_bytes)
                .ok_or(WebHostError::QuotaExceeded)?;
        }
        Ok(total)
    }
}

#[async_trait(?Send)]
impl WebModelStoreHost for InMemoryWebHost {
    async fn persistence_report(&self) -> Result<WebPersistenceReport, WebHostError> {
        Ok(WebPersistenceReport {
            status: StoreStatus {
                bytes_used: self.used_bytes()?,
                bytes_reserved: self.reserved_bytes()?,
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

    async fn list_json_keys(&self, prefix: &str) -> Result<Vec<String>, WebHostError> {
        Ok(self
            .json
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect())
    }

    async fn staging_len(&self, storage_key: &str) -> Result<u64, WebHostError> {
        Ok(self
            .staging
            .get(storage_key)
            .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .unwrap_or(0))
    }

    async fn read_staging_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError> {
        self.max_read_request
            .set(self.max_read_request.get().max(max_bytes));
        read_chunk(self.staging.get(storage_key), offset, max_bytes)
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
            let reservation: Option<DownloadTask> = self
                .json
                .get(&reservation_key(storage_key))
                .and_then(|value| serde_json::from_str(value).ok());
            let unreserved_additional = if let Some(task) = reservation {
                let staged_after = offset
                    .checked_add(additional)
                    .ok_or(WebHostError::QuotaExceeded)?;
                if staged_after > task.expected_bytes {
                    return Err(WebHostError::Store { code: "size" });
                }
                0
            } else {
                additional
            };
            let required = self
                .used_bytes()?
                .checked_add(self.reserved_bytes()?)
                .and_then(|used| used.checked_add(unreserved_additional))
                .ok_or(WebHostError::QuotaExceeded)?;
            if required > available {
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

    async fn promoted_stat(&self, storage_key: &str) -> Result<Option<WebFileStat>, WebHostError> {
        Ok(self.files.get(storage_key).map(|bytes| WebFileStat {
            byte_size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        }))
    }

    async fn read_promoted_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError> {
        self.max_read_request
            .set(self.max_read_request.get().max(max_bytes));
        read_chunk(self.files.get(storage_key), offset, max_bytes)
    }

    async fn promote_staging_atomic(&mut self, storage_key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let bytes = self
            .staging
            .remove(storage_key)
            .ok_or(WebHostError::Store { code: "staging" })?;
        self.files.insert(storage_key.to_owned(), bytes);
        if self.fail_next_write_after_promote {
            self.fail_next_write_after_promote = false;
            self.fail_next_write = true;
        }
        Ok(())
    }

    async fn delete_promoted(&mut self, storage_key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.files.remove(storage_key);
        Ok(())
    }

    async fn list_promoted_keys(&self) -> Result<Vec<String>, WebHostError> {
        Ok(self.files.keys().cloned().collect())
    }

    async fn remove_pack_data(&mut self, pack_id: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let mut storage_keys = BTreeSet::new();
        let metadata_keys: BTreeSet<String> = self
            .json
            .iter()
            .filter_map(|(key, value)| {
                if key.starts_with(FILE_PREFIX) {
                    if let Ok(file) = serde_json::from_str::<StoredFile>(value) {
                        if file.pack_id == pack_id {
                            storage_keys.insert(file.storage_key);
                            return Some(key.clone());
                        }
                    }
                }
                if key.starts_with(RESERVED_PREFIX) || key.starts_with(PROMOTION_PREFIX) {
                    if let Ok(task) = serde_json::from_str::<DownloadTask>(value) {
                        if task.pack_id == pack_id {
                            storage_keys.insert(task.storage_key);
                            return Some(key.clone());
                        }
                    }
                    if let Ok(journal) = serde_json::from_str::<PromotionJournal>(value) {
                        if journal.pack_id == pack_id {
                            storage_keys.insert(journal.storage_key);
                            return Some(key.clone());
                        }
                    }
                }
                if key.starts_with(LIFECYCLE_PREFIX) {
                    return serde_json::from_str::<LifecycleSnapshot>(value)
                        .ok()
                        .filter(|snapshot| snapshot.pack_id == pack_id)
                        .map(|_| key.clone());
                }
                if key.starts_with(LIFECYCLE_BACKING_PREFIX) {
                    let needle = format!("{pack_id}@");
                    if key.contains(&needle) {
                        return Some(key.clone());
                    }
                }
                None
            })
            .collect();
        for key in metadata_keys {
            self.json.remove(&key);
        }
        let prefix = pack_file_storage_prefix(pack_id);
        self.staging
            .retain(|key, _| !storage_keys.contains(key) && !key.starts_with(&prefix));
        self.files
            .retain(|key, _| !storage_keys.contains(key) && !key.starts_with(&prefix));
        Ok(())
    }
}

fn read_chunk(
    bytes: Option<&Vec<u8>>,
    offset: u64,
    max_bytes: u64,
) -> Result<WebFetchedChunk, WebHostError> {
    let bytes = bytes.ok_or(WebHostError::Store {
        code: "missing_file",
    })?;
    if max_bytes == 0 {
        return Err(WebHostError::Store { code: "policy" });
    }
    let offset = usize::try_from(offset).map_err(|_| WebHostError::Integrity { code: "size" })?;
    let max_bytes =
        usize::try_from(max_bytes).map_err(|_| WebHostError::Integrity { code: "size" })?;
    if offset > bytes.len() {
        return Err(WebHostError::Store { code: "range" });
    }
    let end = offset.saturating_add(max_bytes).min(bytes.len());
    Ok(WebFetchedChunk {
        bytes: bytes[offset..end].to_vec(),
        finished: end == bytes.len(),
    })
}

#[derive(Clone)]
pub struct InMemoryNetworkHost {
    assets: BTreeMap<String, Vec<u8>>,
    chunk_limit: usize,
    fail_after_chunks: Option<usize>,
    timeout_next: bool,
    cancel_next: bool,
    cancel_after_start: bool,
    chunks_served: usize,
}

impl std::fmt::Debug for InMemoryNetworkHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InMemoryNetworkHost")
            .field("asset_count", &self.assets.len())
            .field("chunk_limit", &self.chunk_limit)
            .field("fail_after_chunks", &self.fail_after_chunks)
            .field("timeout_next", &self.timeout_next)
            .field("cancel_next", &self.cancel_next)
            .field("cancel_after_start", &self.cancel_after_start)
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
            timeout_next: false,
            cancel_next: false,
            cancel_after_start: false,
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
        self.timeout_next = false;
        self.cancel_next = false;
        self.cancel_after_start = false;
    }

    pub fn timeout_next(&mut self) {
        self.timeout_next = true;
    }

    pub fn cancel_next(&mut self) {
        self.cancel_next = true;
    }

    pub fn cancel_after_start(&mut self) {
        self.cancel_after_start = true;
    }

    pub fn chunks_served(&self) -> usize {
        self.chunks_served
    }
}

#[async_trait(?Send)]
impl WebNetworkHost for InMemoryNetworkHost {
    async fn fetch_range(
        &mut self,
        request: WebFetchRequest,
        cancellation: &CancellationToken,
    ) -> Result<WebFetchedChunk, WebHostError> {
        if request.timeout_millis == 0 || self.timeout_next {
            self.timeout_next = false;
            return Err(WebHostError::Timeout);
        }
        if self.cancel_next || cancellation.is_cancelled() {
            self.cancel_next = false;
            return Err(WebHostError::Cancelled);
        }
        if self.cancel_after_start {
            self.cancel_after_start = false;
            cancellation.cancel();
            return Err(WebHostError::Cancelled);
        }
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
) -> Result<(), WebHostError> {
    for (key, value) in restore {
        if let Some(value) = value {
            host.write_json(&key, &value).await?;
        } else {
            host.delete_json(&key).await?;
        }
    }
    Ok(())
}

async fn hash_staging_chunks<H: WebModelStoreHost>(
    host: &H,
    storage_key: &str,
    max_chunk_bytes: u64,
) -> Result<String, WebHostError> {
    let len = host.staging_len(storage_key).await?;
    let (_count, digest) = hash_chunks(len, max_chunk_bytes, |offset, max_bytes| async move {
        host.read_staging_chunk(storage_key, offset, max_bytes)
            .await
    })
    .await?;
    Ok(digest)
}

async fn hash_promoted_chunks<H: WebModelStoreHost>(
    host: &H,
    storage_key: &str,
    max_chunk_bytes: u64,
) -> Result<(u64, String), WebHostError> {
    let stat = host
        .promoted_stat(storage_key)
        .await?
        .ok_or(WebHostError::Store {
            code: "missing_file",
        })?;
    let (count, digest) = hash_chunks(
        stat.byte_size,
        max_chunk_bytes,
        |offset, max_bytes| async move {
            host.read_promoted_chunk(storage_key, offset, max_bytes)
                .await
        },
    )
    .await?;
    Ok((count, digest))
}

async fn hash_chunks<F, Fut>(
    byte_size: u64,
    max_chunk_bytes: u64,
    mut read: F,
) -> Result<(u64, String), WebHostError>
where
    F: FnMut(u64, u64) -> Fut,
    Fut: std::future::Future<Output = Result<WebFetchedChunk, WebHostError>>,
{
    if max_chunk_bytes == 0 {
        return Err(WebHostError::Store { code: "policy" });
    }
    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    while offset < byte_size {
        let remaining = byte_size.saturating_sub(offset);
        let chunk = read(offset, remaining.min(max_chunk_bytes)).await?;
        if chunk.bytes.is_empty() {
            return Err(WebHostError::Store { code: "chunk" });
        }
        let len = u64::try_from(chunk.bytes.len())
            .map_err(|_| WebHostError::Integrity { code: "size" })?;
        let next = offset
            .checked_add(len)
            .ok_or(WebHostError::Integrity { code: "size" })?;
        if next > byte_size {
            return Err(WebHostError::Integrity { code: "size" });
        }
        hasher.update(&chunk.bytes);
        offset = next;
    }
    Ok((offset, encode_hex(&hasher.finalize())))
}

fn lifecycle_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    format!("{LIFECYCLE_PREFIX}{pack_id}@{pack_version}:{variant_id}")
}

fn lifecycle_backing_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    format!("{LIFECYCLE_BACKING_PREFIX}{pack_id}@{pack_version}:{variant_id}")
}

fn active_key(scope: &ModelStoreScope) -> String {
    format!(
        "{ACTIVE_PREFIX}{}:{}",
        scope.task().as_str(),
        scope.slot_id()
    )
}

fn rollback_key(scope: &ModelStoreScope) -> String {
    format!(
        "{ROLLBACK_PREFIX}{}:{}",
        scope.task().as_str(),
        scope.slot_id()
    )
}

fn mutation_key(scope: &ModelStoreScope) -> String {
    format!(
        "{MUTATION_PREFIX}{}:{}",
        scope.task().as_str(),
        scope.slot_id()
    )
}

fn reservation_key(storage_key: &str) -> String {
    format!("{RESERVED_PREFIX}{storage_key}")
}

fn promotion_key(storage_key: &str) -> String {
    format!("{PROMOTION_PREFIX}{storage_key}")
}

fn file_key(storage_key: &str) -> String {
    format!("{FILE_PREFIX}{storage_key}")
}

fn pack_file_storage_prefix(pack_id: &str) -> String {
    format!("aurora.voice.model-file.v1:{pack_id}@")
}

fn same_task(left: &DownloadTask, right: &DownloadTask) -> bool {
    left.storage_key == right.storage_key
        && left.pack_id == right.pack_id
        && left.pack_version == right.pack_version
        && left.file_id == right.file_id
        && left.expected_sha256 == right.expected_sha256
        && left.expected_bytes == right.expected_bytes
        && left.variant_id == right.variant_id
}

fn validate_scope_task(
    scope: &ModelStoreScope,
    manifest: &VerifiedManifest,
    selection: &SelectedVariant,
) -> Result<(), ModelPackError> {
    let manifest_advertises_task = manifest
        .manifest()
        .tasks
        .iter()
        .any(|task| *task == scope.task());
    let selected_has_primary_task = manifest
        .manifest()
        .files
        .iter()
        .any(|file| selection.file_ids().contains(&file.file_id) && file.task == scope.task());
    if manifest_advertises_task && selected_has_primary_task {
        Ok(())
    } else {
        Err(ModelPackError::Store { code: "task" })
    }
}

fn stored_matches(
    stored: &StoredFile,
    manifest: &VerifiedManifest,
    selection: &SelectedVariant,
    file: &ModelPackFile,
) -> bool {
    stored.storage_key
        == file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        )
        && stored.pack_id == manifest.manifest().pack_id
        && stored.pack_version == manifest.manifest().pack_version
        && stored.variant_id == selection.variant_id()
        && stored.file_id == file.file_id
        && stored.sha256 == file.sha256
        && stored.byte_size == file.byte_size
        && stored.state == InstallState::Ready
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
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    encode_hex(&hasher.finalize())
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}
