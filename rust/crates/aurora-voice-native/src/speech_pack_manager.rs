//! Selected-only native speech archive installation for pinned TTS catalog voices.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{TtsCatalogEntry, TtsVoiceCatalog};
use bzip2::read::BzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::EntryType;
use thiserror::Error;
use url::Url;

use crate::{AssetIntegrity, DownloadError, DownloadPolicy, DownloadProgress, NativeDownloader};

const STATE_SCHEMA_VERSION: u32 = 1;
const STATE_FILE: &str = "speech-packs.json";
const ARCHIVE_FILE: &str = "archive.tar.bz2";
const TMP_PREFIX: &str = ".tmp-";
const DEFAULT_MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES: u64 = 768 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES: usize = 12_000;
const DEFAULT_MAX_FILES: usize = 8_000;

/// Durable native speech-pack manager configuration.
#[derive(Clone, Debug)]
pub struct SpeechPackManagerConfig {
    /// Root directory for archive cache, extracted packs, staging data, and state.
    pub root: PathBuf,
    /// Download policy applied to selected upstream archive downloads.
    pub download_policy: DownloadPolicy,
    /// Optional quota covering cached archives plus extracted installed packs.
    pub quota_bytes: Option<u64>,
    /// Maximum uncompressed byte total accepted from one archive.
    pub max_extracted_bytes: u64,
    /// Maximum single extracted file size.
    pub max_file_bytes: u64,
    /// Maximum archive entries inspected during extraction.
    pub max_entries: usize,
    /// Maximum regular files extracted from one archive.
    pub max_files: usize,
}

impl SpeechPackManagerConfig {
    /// Construct a production HTTPS-only config with conservative extraction ceilings.
    pub fn new(
        root: impl Into<PathBuf>,
        quota_bytes: Option<u64>,
    ) -> Result<Self, SpeechPackError> {
        Ok(Self {
            root: root.into(),
            download_policy: DownloadPolicy::https_only(DEFAULT_MAX_ARCHIVE_BYTES)
                .map_err(SpeechPackError::Download)?,
            quota_bytes,
            max_extracted_bytes: DEFAULT_MAX_EXTRACTED_BYTES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_entries: DEFAULT_MAX_ENTRIES,
            max_files: DEFAULT_MAX_FILES,
        })
    }
}

/// Product-safe install progress for the selected voice only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechPackInstallProgress {
    pub phase: SpeechPackInstallPhase,
    pub completed_bytes: u64,
    pub expected_bytes: u64,
}

/// Install phase names intentionally avoid URLs and filesystem paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechPackInstallPhase {
    Downloading,
    Extracting,
    Ready,
}

/// Resolved local file bindings for a verified installed voice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechPackBindings {
    pub voice_id: String,
    pub archive_sha256: String,
    pub root: PathBuf,
    pub model: PathBuf,
    pub config: PathBuf,
    pub tokens: PathBuf,
    pub data_dir: PathBuf,
    pub model_card: PathBuf,
}

impl fmt::Display for SpeechPackBindings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechPackBindings")
            .field("voice_id", &self.voice_id)
            .field("archive_sha256", &self.archive_sha256)
            .finish_non_exhaustive()
    }
}

/// Durable metadata for an installed selected voice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledSpeechPack {
    pub voice_id: String,
    pub display_name: String,
    pub language: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub extracted_bytes: u64,
    pub installed_at: u64,
}

/// Sanitized speech-pack failures.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SpeechPackError {
    #[error("voice was not found in the catalog")]
    UnknownVoice,
    #[error("voice archive download failed")]
    Download(#[from] DownloadError),
    #[error("voice archive source is not permitted")]
    UnsafeSource,
    #[error("voice archive exceeds the configured resource limit")]
    ResourceLimit,
    #[error("voice archive contents are invalid")]
    InvalidArchive,
    #[error("voice archive cache is corrupt")]
    CorruptCache,
    #[error("voice install was cancelled")]
    Cancelled,
    #[error("voice install is already running")]
    InstallInProgress,
    #[error("voice state operation failed")]
    State,
}

/// Filesystem-backed speech-pack manager for one user-selected voice at a time.
pub struct SpeechPackManager {
    config: SpeechPackManagerConfig,
    downloader: NativeDownloader,
    locks: Arc<Mutex<HashSet<String>>>,
    state_lock: Arc<Mutex<()>>,
}

impl SpeechPackManager {
    /// Open the manager and recover stale temp directories/files from prior interrupted installs.
    pub fn open(config: SpeechPackManagerConfig) -> Result<Self, SpeechPackError> {
        fs::create_dir_all(state_dir(&config.root)).map_err(|_| SpeechPackError::State)?;
        fs::create_dir_all(staging_dir(&config.root)).map_err(|_| SpeechPackError::State)?;
        fs::create_dir_all(cache_dir(&config.root)).map_err(|_| SpeechPackError::State)?;
        fs::create_dir_all(extracted_dir(&config.root)).map_err(|_| SpeechPackError::State)?;
        recover_temps(&config.root)?;
        let _ = read_state(&config.root)?;
        let downloader =
            NativeDownloader::new(config.download_policy).map_err(SpeechPackError::Download)?;
        Ok(Self {
            config,
            downloader,
            locks: Arc::new(Mutex::new(HashSet::new())),
            state_lock: Arc::new(Mutex::new(())),
        })
    }

    /// Install exactly one selected voice from the embedded catalog.
    pub async fn install_voice<F>(
        &self,
        voice_id: &str,
        cancellation: &CancellationToken,
        mut progress: F,
    ) -> Result<SpeechPackBindings, SpeechPackError>
    where
        F: FnMut(SpeechPackInstallProgress),
    {
        let catalog = TtsVoiceCatalog::embedded().map_err(|_| SpeechPackError::State)?;
        let entry = catalog
            .voice(voice_id)
            .ok_or(SpeechPackError::UnknownVoice)?
            .clone();
        let _guard = SelectionLock::acquire(self.locks.clone(), &entry.voice_id)?;
        if cancellation.is_cancelled() {
            return Err(SpeechPackError::Cancelled);
        }
        self.ensure_quota_for_archive(&entry)?;
        let archive = self
            .ensure_archive_cached(&entry, cancellation, |download| {
                progress(SpeechPackInstallProgress {
                    phase: SpeechPackInstallPhase::Downloading,
                    completed_bytes: download.downloaded_bytes,
                    expected_bytes: download.expected_bytes,
                });
            })
            .await?;
        if cancellation.is_cancelled() {
            return Err(SpeechPackError::Cancelled);
        }
        let extract_report = self
            .ensure_extracted(&entry, &archive, cancellation)
            .await?;
        progress(SpeechPackInstallProgress {
            phase: SpeechPackInstallPhase::Extracting,
            completed_bytes: extract_report.extracted_bytes,
            expected_bytes: self.config.max_extracted_bytes,
        });
        let bindings = self.resolve_entry_bindings(&entry)?;
        let installed = InstalledRecord {
            voice_id: entry.voice_id.clone(),
            display_name: entry.display_name.clone(),
            language: entry.language.clone(),
            archive_sha256: entry.archive.sha256.clone(),
            archive_bytes: entry.archive.byte_size,
            extracted_bytes: extract_report.extracted_bytes,
            installed_at: now_epoch_seconds(),
        };
        {
            let _state_guard = self.state_lock.lock().map_err(|_| SpeechPackError::State)?;
            let mut state = read_state(&self.config.root)?;
            state.installed.insert(entry.voice_id.clone(), installed);
            write_state_atomic(&self.config.root, &state)?;
        }
        progress(SpeechPackInstallProgress {
            phase: SpeechPackInstallPhase::Ready,
            completed_bytes: entry.archive.byte_size,
            expected_bytes: entry.archive.byte_size,
        });
        Ok(bindings)
    }

    /// Return durable installed voices whose bindings still verify on disk.
    pub fn list_installed_voices(&self) -> Result<Vec<InstalledSpeechPack>, SpeechPackError> {
        let catalog = TtsVoiceCatalog::embedded().map_err(|_| SpeechPackError::State)?;
        let _state_guard = self.state_lock.lock().map_err(|_| SpeechPackError::State)?;
        let state = read_state(&self.config.root)?;
        let mut installed = Vec::new();
        for record in state.installed.values() {
            let Some(entry) = catalog.voice(&record.voice_id) else {
                continue;
            };
            if self.resolve_entry_bindings(entry).is_ok() {
                installed.push(record.clone().into_public());
            }
        }
        installed.sort_by(|left, right| left.voice_id.cmp(&right.voice_id));
        Ok(installed)
    }

    /// Resolve verified local bindings for an installed selected voice.
    pub fn resolve_voice_bindings(
        &self,
        voice_id: &str,
    ) -> Result<SpeechPackBindings, SpeechPackError> {
        let catalog = TtsVoiceCatalog::embedded().map_err(|_| SpeechPackError::State)?;
        let entry = catalog
            .voice(voice_id)
            .ok_or(SpeechPackError::UnknownVoice)?;
        let _state_guard = self.state_lock.lock().map_err(|_| SpeechPackError::State)?;
        let state = read_state(&self.config.root)?;
        let record = state
            .installed
            .get(voice_id)
            .ok_or(SpeechPackError::UnknownVoice)?;
        if record.archive_sha256 != entry.archive.sha256
            || record.archive_bytes != entry.archive.byte_size
        {
            return Err(SpeechPackError::CorruptCache);
        }
        self.resolve_entry_bindings(entry)
    }

    /// Remove one selected voice install and its digest-addressed cache when unused.
    pub fn remove_voice(&self, voice_id: &str) -> Result<(), SpeechPackError> {
        let catalog = TtsVoiceCatalog::embedded().map_err(|_| SpeechPackError::State)?;
        let entry = catalog
            .voice(voice_id)
            .ok_or(SpeechPackError::UnknownVoice)?;
        let _guard = SelectionLock::acquire(self.locks.clone(), voice_id)?;
        let _state_guard = self.state_lock.lock().map_err(|_| SpeechPackError::State)?;
        let mut state = read_state(&self.config.root)?;
        let Some(record) = state.installed.remove(voice_id) else {
            return Ok(());
        };
        write_state_atomic(&self.config.root, &state)?;
        if !state
            .installed
            .values()
            .any(|other| other.archive_sha256 == record.archive_sha256)
        {
            remove_dir_if_exists(&extract_root(&self.config.root, &entry.archive.sha256))?;
            remove_dir_if_exists(&cache_root(&self.config.root, &entry.archive.sha256))?;
        }
        Ok(())
    }

    async fn ensure_archive_cached<F>(
        &self,
        entry: &TtsCatalogEntry,
        cancellation: &CancellationToken,
        mut progress: F,
    ) -> Result<CachedArchive, SpeechPackError>
    where
        F: FnMut(DownloadProgress),
    {
        if cancellation.is_cancelled() {
            return Err(SpeechPackError::Cancelled);
        }
        let archive_path = archive_path(&self.config.root, &entry.archive.sha256);
        if archive_path.exists() {
            let actual = inspect_file(&archive_path)?;
            if actual.sha256 == entry.archive.sha256 && actual.byte_size == entry.archive.byte_size
            {
                progress(DownloadProgress {
                    downloaded_bytes: actual.byte_size,
                    expected_bytes: entry.archive.byte_size,
                });
                return Ok(CachedArchive { path: archive_path });
            }
            remove_dir_if_exists(&cache_root(&self.config.root, &entry.archive.sha256))?;
        }
        let source = Url::parse(&entry.archive.url).map_err(|_| SpeechPackError::UnsafeSource)?;
        let integrity = AssetIntegrity::new(entry.archive.byte_size, entry.archive.sha256.clone())?;
        let staging = staging_path(&self.config.root, &entry.archive.sha256);
        let receipt = self
            .downloader
            .download_to_staging(&source, &staging, &integrity, cancellation, progress)
            .await?;
        if receipt.byte_size != entry.archive.byte_size || receipt.sha256 != entry.archive.sha256 {
            return Err(SpeechPackError::CorruptCache);
        }
        fs::create_dir_all(cache_root(&self.config.root, &entry.archive.sha256))
            .map_err(|_| SpeechPackError::State)?;
        promote_file_atomic(&staging, &archive_path)?;
        Ok(CachedArchive { path: archive_path })
    }

    async fn ensure_extracted(
        &self,
        entry: &TtsCatalogEntry,
        archive: &CachedArchive,
        cancellation: &CancellationToken,
    ) -> Result<ExtractReport, SpeechPackError> {
        if extract_root(&self.config.root, &entry.archive.sha256).exists() {
            let report = verify_extracted(&self.config.root, entry)?;
            return Ok(report);
        }
        let config = self.config.clone();
        let entry = entry.clone();
        let archive_path = archive.path.clone();
        let cancellation = cancellation.clone();
        tokio::task::spawn_blocking(move || {
            extract_archive_bounded(&config, &entry, &archive_path, &cancellation)
        })
        .await
        .map_err(|_| SpeechPackError::State)?
    }

    fn ensure_quota_for_archive(&self, entry: &TtsCatalogEntry) -> Result<(), SpeechPackError> {
        let Some(quota) = self.config.quota_bytes else {
            return Ok(());
        };
        let used = directory_size(&cache_dir(&self.config.root))?
            .saturating_add(directory_size(&extracted_dir(&self.config.root))?);
        let required = used
            .checked_add(entry.archive.byte_size)
            .and_then(|value| value.checked_add(self.config.max_extracted_bytes))
            .ok_or(SpeechPackError::ResourceLimit)?;
        if required > quota {
            return Err(SpeechPackError::ResourceLimit);
        }
        Ok(())
    }

    fn resolve_entry_bindings(
        &self,
        entry: &TtsCatalogEntry,
    ) -> Result<SpeechPackBindings, SpeechPackError> {
        verify_extracted(&self.config.root, entry)?;
        let root = extract_root(&self.config.root, &entry.archive.sha256);
        let pack_root = root.join(&entry.archive.root);
        let bindings = SpeechPackBindings {
            voice_id: entry.voice_id.clone(),
            archive_sha256: entry.archive.sha256.clone(),
            root: pack_root.clone(),
            model: root.join(&entry.bindings.model),
            config: root.join(&entry.bindings.config),
            tokens: root.join(&entry.bindings.tokens),
            data_dir: root.join(&entry.bindings.data_dir),
            model_card: root.join(&entry.bindings.model_card),
        };
        ensure_contained(&root, &bindings.root)?;
        ensure_contained(&root, &bindings.model)?;
        ensure_contained(&root, &bindings.config)?;
        ensure_contained(&root, &bindings.tokens)?;
        ensure_contained(&root, &bindings.data_dir)?;
        ensure_contained(&root, &bindings.model_card)?;
        Ok(bindings)
    }
}

#[derive(Clone, Debug)]
struct CachedArchive {
    path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExtractReport {
    extracted_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StoreState {
    schema_version: u32,
    installed: BTreeMap<String, InstalledRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct InstalledRecord {
    voice_id: String,
    display_name: String,
    language: String,
    archive_sha256: String,
    archive_bytes: u64,
    extracted_bytes: u64,
    installed_at: u64,
}

impl InstalledRecord {
    fn into_public(self) -> InstalledSpeechPack {
        InstalledSpeechPack {
            voice_id: self.voice_id,
            display_name: self.display_name,
            language: self.language,
            archive_sha256: self.archive_sha256,
            archive_bytes: self.archive_bytes,
            extracted_bytes: self.extracted_bytes,
            installed_at: self.installed_at,
        }
    }
}

impl Default for StoreState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            installed: BTreeMap::new(),
        }
    }
}

struct SelectionLock {
    locks: Arc<Mutex<HashSet<String>>>,
    key: String,
}

impl SelectionLock {
    fn acquire(locks: Arc<Mutex<HashSet<String>>>, key: &str) -> Result<Self, SpeechPackError> {
        let mut active = locks.lock().map_err(|_| SpeechPackError::State)?;
        if !active.insert(key.to_owned()) {
            return Err(SpeechPackError::InstallInProgress);
        }
        Ok(Self {
            locks: locks.clone(),
            key: key.to_owned(),
        })
    }
}

impl Drop for SelectionLock {
    fn drop(&mut self) {
        if let Ok(mut active) = self.locks.lock() {
            active.remove(&self.key);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileInspection {
    byte_size: u64,
    sha256: String,
}

fn extract_archive_bounded(
    config: &SpeechPackManagerConfig,
    entry: &TtsCatalogEntry,
    archive_path: &Path,
    cancellation: &CancellationToken,
) -> Result<ExtractReport, SpeechPackError> {
    if cancellation.is_cancelled() {
        return Err(SpeechPackError::Cancelled);
    }
    let temp_root =
        extracted_dir(&config.root).join(format!("{}{}", TMP_PREFIX, entry.archive.sha256));
    remove_dir_if_exists(&temp_root)?;
    fs::create_dir_all(&temp_root).map_err(|_| SpeechPackError::State)?;
    let result = extract_archive_contents(config, entry, archive_path, &temp_root, cancellation);
    match result {
        Ok(_report) => {
            let final_root = extract_root(&config.root, &entry.archive.sha256);
            remove_dir_if_exists(&final_root)?;
            fs::rename(&temp_root, &final_root).map_err(|_| SpeechPackError::State)?;
            fsync_parent(&final_root)?;
            verify_extracted(&config.root, entry)
        }
        Err(error) => {
            let _ = remove_dir_if_exists(&temp_root);
            Err(error)
        }
    }
}

fn extract_archive_contents(
    config: &SpeechPackManagerConfig,
    entry: &TtsCatalogEntry,
    archive_path: &Path,
    temp_root: &Path,
    cancellation: &CancellationToken,
) -> Result<ExtractReport, SpeechPackError> {
    let archive = File::open(archive_path).map_err(|_| SpeechPackError::CorruptCache)?;
    let decoder = BzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let mut seen = BTreeSet::new();
    let mut entries_seen = 0_usize;
    let mut files_seen = 0_usize;
    let mut extracted_bytes = 0_u64;
    for item in archive
        .entries()
        .map_err(|_| SpeechPackError::InvalidArchive)?
    {
        if cancellation.is_cancelled() {
            return Err(SpeechPackError::Cancelled);
        }
        entries_seen = entries_seen
            .checked_add(1)
            .ok_or(SpeechPackError::ResourceLimit)?;
        if entries_seen > config.max_entries {
            return Err(SpeechPackError::ResourceLimit);
        }
        let mut item = item.map_err(|_| SpeechPackError::InvalidArchive)?;
        let entry_type = item.header().entry_type();
        if !(entry_type == EntryType::Regular || entry_type == EntryType::Directory) {
            return Err(SpeechPackError::InvalidArchive);
        }
        let relative =
            safe_archive_path(&item.path().map_err(|_| SpeechPackError::InvalidArchive)?)?;
        if !relative.starts_with(&entry.archive.root) {
            return Err(SpeechPackError::InvalidArchive);
        }
        let key = relative.to_string_lossy().into_owned();
        if !seen.insert(key) {
            return Err(SpeechPackError::InvalidArchive);
        }
        let output = temp_root.join(&relative);
        ensure_contained(temp_root, &output)?;
        if entry_type == EntryType::Directory {
            fs::create_dir_all(&output).map_err(|_| SpeechPackError::State)?;
            continue;
        }
        files_seen = files_seen
            .checked_add(1)
            .ok_or(SpeechPackError::ResourceLimit)?;
        if files_seen > config.max_files {
            return Err(SpeechPackError::ResourceLimit);
        }
        let declared = item
            .header()
            .size()
            .map_err(|_| SpeechPackError::InvalidArchive)?;
        if declared > config.max_file_bytes {
            return Err(SpeechPackError::ResourceLimit);
        }
        extracted_bytes = extracted_bytes
            .checked_add(declared)
            .ok_or(SpeechPackError::ResourceLimit)?;
        if extracted_bytes > config.max_extracted_bytes {
            return Err(SpeechPackError::ResourceLimit);
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|_| SpeechPackError::State)?;
        }
        let mut output_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|_| SpeechPackError::InvalidArchive)?;
        copy_limited(&mut item, &mut output_file, declared)?;
        output_file.sync_all().map_err(|_| SpeechPackError::State)?;
    }
    let report = ExtractReport { extracted_bytes };
    verify_bindings_in_root(temp_root, entry)?;
    Ok(report)
}

fn verify_extracted(
    root: &Path,
    entry: &TtsCatalogEntry,
) -> Result<ExtractReport, SpeechPackError> {
    let root = extract_root(root, &entry.archive.sha256);
    verify_bindings_in_root(&root, entry)?;
    Ok(ExtractReport {
        extracted_bytes: directory_size(&root)?,
    })
}

fn verify_bindings_in_root(root: &Path, entry: &TtsCatalogEntry) -> Result<(), SpeechPackError> {
    let pack_root = root.join(&entry.archive.root);
    require_directory(root, &pack_root)?;
    require_file(root, &root.join(&entry.bindings.model))?;
    require_file(root, &root.join(&entry.bindings.config))?;
    require_file(root, &root.join(&entry.bindings.tokens))?;
    require_directory(root, &root.join(&entry.bindings.data_dir))?;
    require_file(root, &root.join(&entry.bindings.model_card))?;
    Ok(())
}

fn copy_limited<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    expected: u64,
) -> Result<(), SpeechPackError> {
    let mut remaining = expected;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let max_read = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| SpeechPackError::ResourceLimit)?;
        let read = reader
            .read(&mut buffer[..max_read])
            .map_err(|_| SpeechPackError::InvalidArchive)?;
        if read == 0 {
            return Err(SpeechPackError::InvalidArchive);
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|_| SpeechPackError::State)?;
        remaining -= u64::try_from(read).map_err(|_| SpeechPackError::ResourceLimit)?;
    }
    Ok(())
}

fn safe_archive_path(path: &Path) -> Result<PathBuf, SpeechPackError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.contains('\\')
                    || !segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                {
                    return Err(SpeechPackError::InvalidArchive);
                }
                normalized.push(segment.as_ref());
            }
            _ => return Err(SpeechPackError::InvalidArchive),
        }
    }
    if normalized.components().next().is_none() {
        return Err(SpeechPackError::InvalidArchive);
    }
    Ok(normalized)
}

fn require_file(root: &Path, path: &Path) -> Result<(), SpeechPackError> {
    ensure_contained(root, path)?;
    fs::metadata(path)
        .map_err(|_| SpeechPackError::InvalidArchive)
        .and_then(|metadata| {
            if metadata.is_file() {
                Ok(())
            } else {
                Err(SpeechPackError::InvalidArchive)
            }
        })
}

fn require_directory(root: &Path, path: &Path) -> Result<(), SpeechPackError> {
    ensure_contained(root, path)?;
    fs::metadata(path)
        .map_err(|_| SpeechPackError::InvalidArchive)
        .and_then(|metadata| {
            if metadata.is_dir() {
                Ok(())
            } else {
                Err(SpeechPackError::InvalidArchive)
            }
        })
}

fn ensure_contained(root: &Path, path: &Path) -> Result<(), SpeechPackError> {
    let root = root.components().collect::<Vec<_>>();
    let path = path.components().collect::<Vec<_>>();
    if path.len() >= root.len() && path[..root.len()] == root[..] {
        Ok(())
    } else {
        Err(SpeechPackError::InvalidArchive)
    }
}

fn inspect_file(path: &Path) -> Result<FileInspection, SpeechPackError> {
    let mut file = File::open(path).map_err(|_| SpeechPackError::CorruptCache)?;
    let metadata = file.metadata().map_err(|_| SpeechPackError::CorruptCache)?;
    if !metadata.is_file() {
        return Err(SpeechPackError::CorruptCache);
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| SpeechPackError::CorruptCache)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(FileInspection {
        byte_size: metadata.len(),
        sha256: encode_hex(&hasher.finalize()),
    })
}

fn directory_size(path: &Path) -> Result<u64, SpeechPackError> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for entry in fs::read_dir(path).map_err(|_| SpeechPackError::State)? {
        let entry = entry.map_err(|_| SpeechPackError::State)?;
        let metadata = entry.metadata().map_err(|_| SpeechPackError::State)?;
        if metadata.is_dir() {
            total = total
                .checked_add(directory_size(&entry.path())?)
                .ok_or(SpeechPackError::ResourceLimit)?;
        } else if metadata.is_file() {
            total = total
                .checked_add(metadata.len())
                .ok_or(SpeechPackError::ResourceLimit)?;
        } else {
            return Err(SpeechPackError::InvalidArchive);
        }
    }
    Ok(total)
}

fn read_state(root: &Path) -> Result<StoreState, SpeechPackError> {
    let path = state_path(root);
    match fs::read_to_string(&path) {
        Ok(payload) => {
            let state: StoreState =
                serde_json::from_str(&payload).map_err(|_| SpeechPackError::State)?;
            if state.schema_version == STATE_SCHEMA_VERSION {
                Ok(state)
            } else {
                Err(SpeechPackError::State)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoreState::default()),
        Err(_) => Err(SpeechPackError::State),
    }
}

fn write_state_atomic(root: &Path, state: &StoreState) -> Result<(), SpeechPackError> {
    fs::create_dir_all(state_dir(root)).map_err(|_| SpeechPackError::State)?;
    let final_path = state_path(root);
    let temp_path = state_dir(root).join(format!(
        "{}{}.{}.tmp",
        STATE_FILE,
        std::process::id(),
        now_epoch_nanos()
    ));
    let payload = serde_json::to_vec_pretty(state).map_err(|_| SpeechPackError::State)?;
    {
        let mut file = File::create(&temp_path).map_err(|_| SpeechPackError::State)?;
        file.write_all(&payload)
            .map_err(|_| SpeechPackError::State)?;
        file.sync_all().map_err(|_| SpeechPackError::State)?;
    }
    fs::rename(&temp_path, &final_path).map_err(|_| SpeechPackError::State)?;
    fsync_parent(&final_path)
}

fn promote_file_atomic(staging: &Path, final_path: &Path) -> Result<(), SpeechPackError> {
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|_| SpeechPackError::State)?;
    }
    fs::rename(staging, final_path).map_err(|_| SpeechPackError::State)?;
    fsync_parent(final_path)
}

fn recover_temps(root: &Path) -> Result<(), SpeechPackError> {
    for dir in [staging_dir(root), extracted_dir(root), state_dir(root)] {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(&dir).map_err(|_| SpeechPackError::State)? {
            let entry = entry.map_err(|_| SpeechPackError::State)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(TMP_PREFIX) || name.ends_with(".tmp") {
                let path = entry.path();
                let metadata = entry.metadata().map_err(|_| SpeechPackError::State)?;
                if metadata.is_dir() {
                    remove_dir_if_exists(&path)?;
                } else {
                    remove_file_if_exists(&path)?;
                }
            }
        }
    }
    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> Result<(), SpeechPackError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SpeechPackError::State),
    }
}

fn remove_file_if_exists(path: &Path) -> Result<(), SpeechPackError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SpeechPackError::State),
    }
}

fn fsync_parent(path: &Path) -> Result<(), SpeechPackError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let directory = File::open(parent).map_err(|_| SpeechPackError::State)?;
    directory.sync_all().map_err(|_| SpeechPackError::State)
}

fn state_dir(root: &Path) -> PathBuf {
    root.join("state")
}

fn state_path(root: &Path) -> PathBuf {
    state_dir(root).join(STATE_FILE)
}

fn staging_dir(root: &Path) -> PathBuf {
    root.join("staging")
}

fn staging_path(root: &Path, sha256: &str) -> PathBuf {
    staging_dir(root).join(format!("{sha256}.part"))
}

fn cache_dir(root: &Path) -> PathBuf {
    root.join("cache")
}

fn cache_root(root: &Path, sha256: &str) -> PathBuf {
    cache_dir(root).join(sha256)
}

fn archive_path(root: &Path, sha256: &str) -> PathBuf {
    cache_root(root, sha256).join(ARCHIVE_FILE)
}

fn extracted_dir(root: &Path) -> PathBuf {
    root.join("extracted")
}

fn extract_root(root: &Path, sha256: &str) -> PathBuf {
    extracted_dir(root).join(sha256)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn now_epoch_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos()
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

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use bzip2::write::BzEncoder;
    use bzip2::Compression;
    use tar::{Builder, Header};

    use super::*;

    const VOICE_ID: &str = "standard:piper:en_us-ljspeech-medium";

    struct OneShotServer {
        url: Url,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl OneShotServer {
        fn new(body: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let address = listener.local_addr().expect("local addr");
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let _ = read_request(&mut stream);
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(headers.as_bytes()).expect("headers");
                stream.write_all(&body).expect("body");
            });
            Self {
                url: Url::parse(&format!("http://{address}/voice.tar.bz2")).expect("URL"),
                thread: Some(thread),
            }
        }
    }

    impl Drop for OneShotServer {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                thread.join().expect("join");
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).expect("read");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        request
    }

    fn test_entry(url: String, body: &[u8]) -> TtsCatalogEntry {
        let catalog = TtsVoiceCatalog::embedded().expect("catalog");
        let mut entry = catalog.voice(VOICE_ID).expect("voice").clone();
        entry.archive.url = url;
        entry.archive.byte_size = body.len() as u64;
        entry.archive.sha256 = encode_hex(&Sha256::digest(body));
        entry
    }

    fn test_manager(root: &Path, max_asset_bytes: u64) -> SpeechPackManager {
        let mut config =
            SpeechPackManagerConfig::new(root, Some(50 * 1024 * 1024)).expect("config");
        let mut policy = DownloadPolicy::https_only(max_asset_bytes).expect("policy");
        policy.allow_loopback_http = true;
        config.download_policy = policy;
        config.max_extracted_bytes = 4 * 1024 * 1024;
        config.max_file_bytes = 2 * 1024 * 1024;
        config.max_entries = 64;
        config.max_files = 32;
        SpeechPackManager::open(config).expect("manager")
    }

    fn make_archive(root: &str, model_stem: &str) -> Vec<u8> {
        make_archive_with(root, model_stem, &[])
    }

    fn make_archive_with(root: &str, model_stem: &str, extras: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = BzEncoder::new(Vec::new(), Compression::best());
        let mut builder = Builder::new(encoder);
        append_dir(&mut builder, root);
        append_file(&mut builder, &format!("{root}/{model_stem}.onnx"), b"onnx");
        append_file(
            &mut builder,
            &format!("{root}/{model_stem}.onnx.json"),
            br#"{"audio":{"sample_rate":22050}}"#,
        );
        append_file(&mut builder, &format!("{root}/tokens.txt"), b"a\nb\n");
        append_dir(&mut builder, &format!("{root}/espeak-ng-data"));
        append_file(&mut builder, &format!("{root}/MODEL_CARD"), b"card");
        for (path, data) in extras {
            append_file(&mut builder, path, data);
        }
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish bz2")
    }

    fn make_archive_with_link(root: &str) -> Vec<u8> {
        let encoder = BzEncoder::new(Vec::new(), Compression::best());
        let mut builder = Builder::new(encoder);
        append_dir(&mut builder, root);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_mode(0o777);
        header.set_size(0);
        header.set_link_name("outside").expect("link name");
        header.set_cksum();
        builder
            .append_data(
                &mut header,
                format!("{root}/en_US-ljspeech-medium.onnx"),
                std::io::empty(),
            )
            .expect("symlink");
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish bz2")
    }

    fn write_embedded_disk_install(root: &Path) {
        let catalog = TtsVoiceCatalog::embedded().expect("catalog");
        let entry = catalog.voice(VOICE_ID).expect("voice");
        let extracted = extract_root(root, &entry.archive.sha256);
        fs::create_dir_all(extracted.join(&entry.archive.root)).expect("pack root");
        fs::write(extracted.join(&entry.bindings.model), b"onnx").expect("model");
        fs::write(extracted.join(&entry.bindings.config), b"{}").expect("config");
        fs::write(extracted.join(&entry.bindings.tokens), b"a\n").expect("tokens");
        fs::create_dir_all(extracted.join(&entry.bindings.data_dir)).expect("data dir");
        fs::write(extracted.join(&entry.bindings.model_card), b"card").expect("card");
        let mut state = StoreState::default();
        state.installed.insert(
            entry.voice_id.clone(),
            InstalledRecord {
                voice_id: entry.voice_id.clone(),
                display_name: entry.display_name.clone(),
                language: entry.language.clone(),
                archive_sha256: entry.archive.sha256.clone(),
                archive_bytes: entry.archive.byte_size,
                extracted_bytes: directory_size(&extracted).expect("size"),
                installed_at: now_epoch_seconds(),
            },
        );
        write_state_atomic(root, &state).expect("state");
    }

    fn append_dir<W: Write>(builder: &mut Builder<W>, path: &str) {
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Directory);
        header.set_mode(0o755);
        header.set_size(0);
        header.set_cksum();
        builder
            .append_data(&mut header, path, std::io::empty())
            .expect("dir");
    }

    fn append_file<W: Write>(builder: &mut Builder<W>, path: &str, data: &[u8]) {
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_mode(0o644);
        header.set_size(data.len() as u64);
        header.set_cksum();
        builder.append_data(&mut header, path, data).expect("file");
    }

    #[tokio::test]
    async fn installs_only_the_exact_selected_voice_and_resolves_bindings() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = "vits-piper-en_US-ljspeech-medium";
        let archive = make_archive(root, "en_US-ljspeech-medium");
        let server = OneShotServer::new(archive.clone());
        let entry = test_entry(server.url.to_string(), &archive);
        let manager = test_manager(directory.path(), archive.len() as u64 + 100);
        let mut progress = Vec::new();

        let bindings = manager
            .install_catalog_entry_for_test(&entry, &CancellationToken::new(), |item| {
                progress.push(item.phase);
            })
            .await
            .expect("install");

        assert_eq!(bindings.voice_id, VOICE_ID);
        assert!(bindings.model.ends_with("en_US-ljspeech-medium.onnx"));
        let state = read_state(directory.path()).expect("state");
        assert_eq!(state.installed.len(), 1);
        assert!(manager.resolve_entry_bindings(&entry).is_ok());
        assert!(progress.contains(&SpeechPackInstallPhase::Downloading));
        assert!(progress.contains(&SpeechPackInstallPhase::Extracting));
        assert_eq!(progress.last(), Some(&SpeechPackInstallPhase::Ready));
        assert!(!state
            .installed
            .contains_key("standard:piper:en_us-amy-medium"));
    }

    #[tokio::test]
    async fn reopens_after_install_and_uses_digest_cache_without_download() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = "vits-piper-en_US-ljspeech-medium";
        let archive = make_archive(root, "en_US-ljspeech-medium");
        let server = OneShotServer::new(archive.clone());
        let entry = test_entry(server.url.to_string(), &archive);
        let manager = test_manager(directory.path(), archive.len() as u64 + 100);
        manager
            .install_catalog_entry_for_test(&entry, &CancellationToken::new(), |_| {})
            .await
            .expect("install");
        drop(server);

        let reopened = test_manager(directory.path(), archive.len() as u64 + 100);
        let state = read_state(directory.path()).expect("state");
        assert_eq!(state.installed.len(), 1);
        assert!(reopened.resolve_entry_bindings(&entry).is_ok());
    }

    #[test]
    fn open_preserves_partial_staging_for_download_resume() {
        let directory = tempfile::tempdir().expect("tempdir");
        let partial = staging_path(directory.path(), &"a".repeat(64));
        fs::create_dir_all(partial.parent().expect("staging parent")).expect("staging dir");
        fs::write(&partial, b"partial").expect("partial");

        let _manager = test_manager(directory.path(), 1024);

        assert_eq!(fs::read(&partial).expect("partial survives"), b"partial");
    }

    #[tokio::test]
    async fn remove_deletes_selected_voice_state_and_bindings() {
        let directory = tempfile::tempdir().expect("tempdir");
        let manager = test_manager(directory.path(), 1024);
        write_embedded_disk_install(directory.path());

        assert_eq!(manager.list_installed_voices().expect("list").len(), 1);
        assert!(manager.resolve_voice_bindings(VOICE_ID).is_ok());

        manager.remove_voice(VOICE_ID).expect("remove");

        assert!(manager.list_installed_voices().expect("list").is_empty());
        assert_eq!(
            manager.resolve_voice_bindings(VOICE_ID),
            Err(SpeechPackError::UnknownVoice)
        );
    }

    #[tokio::test]
    async fn rejects_path_traversal_entries() {
        assert_eq!(
            safe_archive_path(Path::new("../outside")),
            Err(SpeechPackError::InvalidArchive)
        );
        assert_eq!(
            safe_archive_path(Path::new("/absolute")),
            Err(SpeechPackError::InvalidArchive)
        );
    }

    #[tokio::test]
    async fn rejects_link_entries() {
        let directory = tempfile::tempdir().expect("tempdir");
        let archive = make_archive_with_link("vits-piper-en_US-ljspeech-medium");
        let server = OneShotServer::new(archive.clone());
        let entry = test_entry(server.url.to_string(), &archive);
        let manager = test_manager(directory.path(), archive.len() as u64 + 100);

        assert_eq!(
            manager
                .install_catalog_entry_for_test(&entry, &CancellationToken::new(), |_| {})
                .await,
            Err(SpeechPackError::InvalidArchive)
        );
    }

    #[tokio::test]
    async fn rejects_duplicate_paths() {
        let directory = tempfile::tempdir().expect("tempdir");
        let archive = make_archive_with(
            "vits-piper-en_US-ljspeech-medium",
            "en_US-ljspeech-medium",
            &[("vits-piper-en_US-ljspeech-medium/tokens.txt", b"dup")],
        );
        let server = OneShotServer::new(archive.clone());
        let entry = test_entry(server.url.to_string(), &archive);
        let manager = test_manager(directory.path(), archive.len() as u64 + 100);

        assert_eq!(
            manager
                .install_catalog_entry_for_test(&entry, &CancellationToken::new(), |_| {})
                .await,
            Err(SpeechPackError::InvalidArchive)
        );
    }

    #[tokio::test]
    async fn rejects_archives_missing_required_bindings() {
        let directory = tempfile::tempdir().expect("tempdir");
        let encoder = BzEncoder::new(Vec::new(), Compression::best());
        let mut builder = Builder::new(encoder);
        append_dir(&mut builder, "vits-piper-en_US-ljspeech-medium");
        append_file(
            &mut builder,
            "vits-piper-en_US-ljspeech-medium/en_US-ljspeech-medium.onnx",
            b"onnx",
        );
        let encoder = builder.into_inner().expect("finish tar");
        let archive = encoder.finish().expect("finish bz2");
        let server = OneShotServer::new(archive.clone());
        let entry = test_entry(server.url.to_string(), &archive);
        let manager = test_manager(directory.path(), archive.len() as u64 + 100);

        assert_eq!(
            manager
                .install_catalog_entry_for_test(&entry, &CancellationToken::new(), |_| {})
                .await,
            Err(SpeechPackError::InvalidArchive)
        );
    }

    #[tokio::test]
    async fn cancellation_before_install_leaves_no_installed_voice() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = "vits-piper-en_US-ljspeech-medium";
        let archive = make_archive(root, "en_US-ljspeech-medium");
        let entry = test_entry("http://localhost/voice.tar.bz2".to_owned(), &archive);
        let manager = test_manager(directory.path(), archive.len() as u64 + 100);
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            manager
                .install_catalog_entry_for_test(&entry, &cancellation, |_| {})
                .await,
            Err(SpeechPackError::Cancelled)
        );
        assert!(manager.list_installed_voices().expect("list").is_empty());
    }

    #[tokio::test]
    #[ignore = "downloads a real upstream voice archive; run with AURORA_LIVE_SPEECH_PACK_DOWNLOAD=1"]
    async fn live_installs_standard_piper_ljspeech_medium() {
        if std::env::var("AURORA_LIVE_SPEECH_PACK_DOWNLOAD")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }
        let directory = tempfile::tempdir().expect("tempdir");
        let manager = SpeechPackManager::open(
            SpeechPackManagerConfig::new(directory.path(), Some(512 * 1024 * 1024))
                .expect("config"),
        )
        .expect("manager");

        let bindings = manager
            .install_voice(VOICE_ID, &CancellationToken::new(), |_| {})
            .await
            .expect("live install");

        assert!(bindings.model.exists());
        assert!(bindings.config.exists());
        assert!(bindings.tokens.exists());
        assert!(bindings.data_dir.is_dir());
    }

    impl SpeechPackManager {
        async fn install_catalog_entry_for_test<F>(
            &self,
            entry: &TtsCatalogEntry,
            cancellation: &CancellationToken,
            mut progress: F,
        ) -> Result<SpeechPackBindings, SpeechPackError>
        where
            F: FnMut(SpeechPackInstallProgress),
        {
            let _guard = SelectionLock::acquire(self.locks.clone(), &entry.voice_id)?;
            self.ensure_quota_for_archive(entry)?;
            let archive = self
                .ensure_archive_cached(entry, cancellation, |download| {
                    progress(SpeechPackInstallProgress {
                        phase: SpeechPackInstallPhase::Downloading,
                        completed_bytes: download.downloaded_bytes,
                        expected_bytes: download.expected_bytes,
                    });
                })
                .await?;
            let report = self.ensure_extracted(entry, &archive, cancellation).await?;
            progress(SpeechPackInstallProgress {
                phase: SpeechPackInstallPhase::Extracting,
                completed_bytes: report.extracted_bytes,
                expected_bytes: self.config.max_extracted_bytes,
            });
            let bindings = self.resolve_entry_bindings(entry)?;
            let mut state = read_state(&self.config.root)?;
            state.installed.insert(
                entry.voice_id.clone(),
                InstalledRecord {
                    voice_id: entry.voice_id.clone(),
                    display_name: entry.display_name.clone(),
                    language: entry.language.clone(),
                    archive_sha256: entry.archive.sha256.clone(),
                    archive_bytes: entry.archive.byte_size,
                    extracted_bytes: report.extracted_bytes,
                    installed_at: now_epoch_seconds(),
                },
            );
            write_state_atomic(&self.config.root, &state)?;
            progress(SpeechPackInstallProgress {
                phase: SpeechPackInstallPhase::Ready,
                completed_bytes: entry.archive.byte_size,
                expected_bytes: entry.archive.byte_size,
            });
            Ok(bindings)
        }
    }
}
