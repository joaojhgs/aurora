use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackTask {
    Tts,
    Stt,
    Vad,
    Wakeword,
    VoiceState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTarget {
    Web,
    Desktop,
    Android,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetOs {
    Linux,
    Windows,
    Macos,
    Android,
    Ios,
    Web,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetArch {
    X86_64,
    Aarch64,
    Wasm32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    SherpaOnnx,
    Raven,
    Piper,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserFeature {
    Simd,
    Threads,
    SharedArrayBuffer,
    WebGpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressionKind {
    None,
    Gzip,
    Brotli,
    Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseGrant {
    RedistributionAllowed,
    RedistributionRestricted,
    InternalOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevocationReason {
    Corrupt,
    Legal,
    Superseded,
    Security,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    NotInstalled,
    Queued,
    Downloading,
    Verifying,
    Ready,
    Active,
    Paused,
    Failed,
    Revoked,
    Removing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallEvent {
    Enqueue,
    StartDownload,
    Pause,
    Resume,
    DownloadComplete,
    VerifyOk,
    Activate,
    Deactivate,
    Fail,
    Revoke,
    Remove,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestSignature {
    pub key_id: String,
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revocation {
    pub revoked: bool,
    pub reason: RevocationReason,
    pub since: String,
    pub replacement_pack_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub upstream_source: String,
    pub upstream_revision: String,
    pub build_recipe_sha256: String,
    pub license: String,
    pub attribution: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceBudget {
    pub max_download_bytes: u64,
    pub max_installed_bytes: u64,
    pub max_memory_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compatibility {
    pub group_id: String,
    pub preprocessing_abi: String,
    pub postprocessing_abi: String,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_size: u32,
    pub interoperable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RavenRefs {
    pub canonical_config_id: String,
    pub source_checkpoint_revision: String,
    pub conversion_revision: String,
    pub architecture_abi: String,
    pub layer_count: u16,
    pub tokenizer_asset_id: String,
    pub text_conditioner_asset_id: String,
    pub bos_asset_id: String,
    pub model_asset_id: String,
    pub voice_state_compatibility_group_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelPackFile {
    pub file_id: String,
    pub asset_id: String,
    pub task: PackTask,
    pub byte_size: u64,
    pub sha256: String,
    pub url: String,
    pub compression: CompressionKind,
    pub dependencies: Vec<String>,
    pub license: String,
    pub provenance: Provenance,
    pub raven: Option<RavenRefs>,
    pub revocation: Option<Revocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AbiRequirements {
    pub min_aurora_version: String,
    pub min_runtime_version: String,
    pub min_engine_version: String,
    pub engine_source_revision: String,
    pub build_flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelPackVariant {
    pub variant_id: String,
    pub target: RuntimeTarget,
    pub os: TargetOs,
    pub arch: TargetArch,
    pub engine: EngineKind,
    pub required_browser_features: Vec<BrowserFeature>,
    pub min_device_memory_mb: Option<u64>,
    pub resource_budget: ResourceBudget,
    pub compatibility: Compatibility,
    pub file_ids: Vec<String>,
    pub abi: AbiRequirements,
    pub revocation: Option<Revocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelPackManifest {
    pub schema_version: u32,
    pub pack_id: String,
    pub pack_version: String,
    pub display_name: String,
    pub tasks: Vec<PackTask>,
    pub license: String,
    pub provenance: Provenance,
    pub files: Vec<ModelPackFile>,
    pub variants: Vec<ModelPackVariant>,
    pub rollback_from: Option<String>,
    pub supersedes_pack_id: Option<String>,
    pub revocation: Option<Revocation>,
    pub signature: Option<ManifestSignature>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSelection {
    pub target: RuntimeTarget,
    pub os: TargetOs,
    pub arch: TargetArch,
    pub browser_features: BTreeSet<BrowserFeature>,
    pub device_memory_mb: Option<u64>,
    pub max_download_bytes: u64,
    pub max_installed_bytes: u64,
    pub max_memory_bytes: u64,
    pub require_interoperable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleSnapshot {
    pub pack_id: String,
    pub pack_version: String,
    pub state: InstallState,
    pub revision: u64,
    pub updated_at: u64,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreStatus {
    pub bytes_used: u64,
    pub bytes_reserved: u64,
    pub bytes_available: Option<u64>,
    pub persistent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadTask {
    pub storage_key: String,
    pub pack_id: String,
    pub pack_version: String,
    pub file_id: String,
    pub url: String,
    pub expected_sha256: String,
    pub expected_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredFile {
    pub storage_key: String,
    pub pack_id: String,
    pub pack_version: String,
    pub file_id: String,
    pub sha256: String,
    pub byte_size: u64,
    pub state: InstallState,
    pub stored_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivePackIdentity {
    pub pack_id: String,
    pub pack_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmutableModelFile {
    pub storage_key: String,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationMode {
    Signature,
    ReleaseHash,
}

#[derive(Debug, Clone)]
pub struct VerifiedManifest {
    manifest: ModelPackManifest,
    canonical_json: String,
    mode: VerificationMode,
    key_id: Option<String>,
    manifest_sha256: String,
}

impl VerifiedManifest {
    pub fn manifest(&self) -> &ModelPackManifest {
        &self.manifest
    }

    pub fn canonical_json(&self) -> &str {
        &self.canonical_json
    }

    pub fn mode(&self) -> VerificationMode {
        self.mode
    }

    pub fn key_id(&self) -> Option<&str> {
        self.key_id.as_deref()
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }
}

pub trait SignatureVerifier {
    fn verify(
        &self,
        canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError>;
}

#[derive(Debug, Clone, Default)]
pub struct TrustPolicy {
    pub revoked_pack_ids: BTreeSet<String>,
    pub revoked_key_ids: BTreeSet<String>,
    pub expected_release_hash: Option<String>,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ModelPackError {
    #[error("model pack manifest is invalid: {code}")]
    InvalidManifest { code: &'static str },
    #[error("model pack trust check failed: {code}")]
    Trust { code: &'static str },
    #[error("no compatible model variant is available")]
    NoCompatibleVariant,
    #[error("model pack lifecycle transition is invalid")]
    InvalidLifecycleTransition,
    #[error("model store quota exceeded")]
    QuotaExceeded,
    #[error("model store operation failed: {code}")]
    Store { code: &'static str },
}

pub fn validate_manifest(manifest: &ModelPackManifest) -> Result<(), ModelPackError> {
    if manifest.schema_version != 1 {
        return invalid("schema");
    }
    require_nonblank(&manifest.pack_id)?;
    require_nonblank(&manifest.pack_version)?;
    require_nonblank(&manifest.display_name)?;
    require_nonblank(&manifest.license)?;
    validate_provenance(&manifest.provenance)?;
    if manifest.tasks.is_empty() || manifest.files.is_empty() || manifest.variants.is_empty() {
        return invalid("empty");
    }

    let mut file_ids = BTreeSet::new();
    let mut asset_ids = BTreeSet::new();
    let mut revoked_file_ids = BTreeSet::new();
    for file in &manifest.files {
        require_nonblank(&file.file_id)?;
        require_nonblank(&file.asset_id)?;
        require_nonblank(&file.license)?;
        validate_url(&file.url)?;
        validate_sha256(&file.sha256)?;
        validate_provenance(&file.provenance)?;
        if file.byte_size == 0 {
            return invalid("size");
        }
        if !file_ids.insert(file.file_id.clone()) || !asset_ids.insert(file.asset_id.clone()) {
            return invalid("duplicate");
        }
        if file.revocation.as_ref().is_some_and(|rev| rev.revoked) {
            revoked_file_ids.insert(file.file_id.clone());
        }
    }

    for file in &manifest.files {
        let mut dependencies = BTreeSet::new();
        for dependency in &file.dependencies {
            require_nonblank(dependency)?;
            if !dependencies.insert(dependency.clone()) {
                return invalid("duplicate_dependency");
            }
            if !file_ids.contains(dependency) {
                return invalid("unknown_dependency");
            }
            if revoked_file_ids.contains(dependency) {
                return invalid("revoked_dependency");
            }
        }
        if let Some(raven) = &file.raven {
            validate_raven(file, raven)?;
            for required in [
                &raven.tokenizer_asset_id,
                &raven.text_conditioner_asset_id,
                &raven.bos_asset_id,
            ] {
                if !dependencies.contains(required) {
                    return invalid("raven_dependency");
                }
            }
        }
    }

    let mut variant_ids = BTreeSet::new();
    for variant in &manifest.variants {
        require_nonblank(&variant.variant_id)?;
        validate_abi(&variant.abi)?;
        validate_compatibility(&variant.compatibility)?;
        if !variant_ids.insert(variant.variant_id.clone()) {
            return invalid("duplicate_variant");
        }
        if variant.resource_budget.max_download_bytes == 0
            || variant.resource_budget.max_installed_bytes == 0
            || variant.resource_budget.max_memory_bytes == 0
        {
            return invalid("budget");
        }
        for file_id in &variant.file_ids {
            if !file_ids.contains(file_id) || revoked_file_ids.contains(file_id) {
                return invalid("variant_file");
            }
        }
    }
    Ok(())
}

pub fn canonical_manifest_json(manifest: &ModelPackManifest) -> Result<String, ModelPackError> {
    let mut out = ObjectWriter::new();
    out.field("display_name", |out| {
        write_json_string(out, &manifest.display_name)
    });
    out.field("files", |out| write_files(out, &manifest.files));
    out.field("license", |out| write_json_string(out, &manifest.license));
    out.field("pack_id", |out| write_json_string(out, &manifest.pack_id));
    out.field("pack_version", |out| {
        write_json_string(out, &manifest.pack_version)
    });
    out.field("provenance", |out| {
        write_provenance(out, &manifest.provenance)
    });
    out.field("revocation", |out| {
        write_revocation_option(out, &manifest.revocation)
    });
    out.field("rollback_from", |out| {
        write_string_option(out, &manifest.rollback_from)
    });
    out.field("schema_version", |out| {
        out.push_str(&manifest.schema_version.to_string());
    });
    out.field("supersedes_pack_id", |out| {
        write_string_option(out, &manifest.supersedes_pack_id);
    });
    out.field("tasks", |out| write_pack_tasks(out, &manifest.tasks));
    out.field("variants", |out| write_variants(out, &manifest.variants));
    Ok(out.finish())
}

pub fn canonical_f64(value: f64) -> Result<String, ModelPackError> {
    if !value.is_finite() {
        return invalid("nonfinite");
    }
    if value.fract() != 0.0 || value < 0.0 {
        return invalid("nonfinite");
    }
    Ok(format!("{value:.0}"))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn verify_manifest(
    manifest: ModelPackManifest,
    policy: &TrustPolicy,
    verifier: Option<&dyn SignatureVerifier>,
) -> Result<VerifiedManifest, ModelPackError> {
    validate_manifest(&manifest)?;
    if manifest.revocation.as_ref().is_some_and(|rev| rev.revoked)
        || policy.revoked_pack_ids.contains(&manifest.pack_id)
    {
        return trust("revoked_pack");
    }
    let canonical_json = canonical_manifest_json(&manifest)?;
    let manifest_sha256 = sha256_hex(canonical_json.as_bytes());
    if let Some(expected) = &policy.expected_release_hash {
        validate_sha256(expected)?;
        if expected != &manifest_sha256 {
            return trust("release_hash");
        }
        if manifest.signature.is_none() {
            return Ok(VerifiedManifest {
                manifest,
                canonical_json,
                mode: VerificationMode::ReleaseHash,
                key_id: None,
                manifest_sha256,
            });
        }
    }

    let signature = manifest
        .signature
        .as_ref()
        .ok_or(ModelPackError::Trust { code: "unsigned" })?;
    require_nonblank(&signature.key_id)?;
    require_nonblank(&signature.algorithm)?;
    require_nonblank(&signature.value)?;
    if policy.revoked_key_ids.contains(&signature.key_id) {
        return trust("revoked_key");
    }
    let verifier = verifier.ok_or(ModelPackError::Trust {
        code: "untrusted_key",
    })?;
    if !verifier.verify(&canonical_json, signature)? {
        return trust("signature");
    }
    Ok(VerifiedManifest {
        key_id: Some(signature.key_id.clone()),
        manifest,
        canonical_json,
        mode: VerificationMode::Signature,
        manifest_sha256,
    })
}

pub fn select_variant<'a>(
    manifest: &'a ModelPackManifest,
    selection: &RuntimeSelection,
) -> Result<&'a ModelPackVariant, ModelPackError> {
    validate_manifest(manifest)?;
    manifest
        .variants
        .iter()
        .filter(|variant| !variant.revocation.as_ref().is_some_and(|rev| rev.revoked))
        .filter(|variant| variant.target == selection.target)
        .filter(|variant| variant.os == selection.os)
        .filter(|variant| variant.arch == selection.arch)
        .filter(|variant| {
            variant
                .required_browser_features
                .iter()
                .all(|feature| selection.browser_features.contains(feature))
        })
        .filter(
            |variant| match (variant.min_device_memory_mb, selection.device_memory_mb) {
                (Some(required), Some(actual)) => actual >= required,
                (Some(_), None) => false,
                (None, _) => true,
            },
        )
        .filter(|variant| {
            variant.resource_budget.max_download_bytes <= selection.max_download_bytes
                && variant.resource_budget.max_installed_bytes <= selection.max_installed_bytes
                && variant.resource_budget.max_memory_bytes <= selection.max_memory_bytes
        })
        .filter(|variant| !selection.require_interoperable || variant.compatibility.interoperable)
        .max_by_key(|variant| variant_score(variant, selection))
        .ok_or(ModelPackError::NoCompatibleVariant)
}

fn variant_score(variant: &ModelPackVariant, selection: &RuntimeSelection) -> (u8, u8, u8, u64) {
    let browser_feature_exact =
        u8::from(variant.required_browser_features.len() == selection.browser_features.len());
    let memory_exact = u8::from(variant.min_device_memory_mb == selection.device_memory_mb);
    let interoperable = u8::from(variant.compatibility.interoperable);
    (
        browser_feature_exact,
        memory_exact,
        interoperable,
        u64::MAX.saturating_sub(variant.resource_budget.max_memory_bytes),
    )
}

pub fn lifecycle_storage_key(pack_id: &str, pack_version: &str) -> String {
    format!(
        "aurora.voice.model-pack.v1:{}@{}",
        encode_key(pack_id),
        encode_key(pack_version)
    )
}

pub fn file_storage_key(pack_id: &str, pack_version: &str, file_id: &str) -> String {
    format!(
        "aurora.voice.model-file.v1:{}@{}#{}",
        encode_key(pack_id),
        encode_key(pack_version),
        encode_key(file_id)
    )
}

pub fn create_lifecycle_snapshot(
    pack_id: impl Into<String>,
    pack_version: impl Into<String>,
    now: u64,
    state: InstallState,
) -> LifecycleSnapshot {
    LifecycleSnapshot {
        pack_id: pack_id.into(),
        pack_version: pack_version.into(),
        state,
        revision: 0,
        updated_at: now,
        error_code: None,
    }
}

pub fn apply_lifecycle_event(
    snapshot: &LifecycleSnapshot,
    event: InstallEvent,
    now: u64,
    error_code: Option<String>,
) -> Result<LifecycleSnapshot, ModelPackError> {
    let next_state = lifecycle_transition(snapshot.state, event)?;
    Ok(LifecycleSnapshot {
        pack_id: snapshot.pack_id.clone(),
        pack_version: snapshot.pack_version.clone(),
        state: next_state,
        revision: snapshot.revision.saturating_add(1),
        updated_at: now,
        error_code: if next_state == InstallState::Failed {
            Some(error_code.unwrap_or_else(|| "unknown".to_owned()))
        } else {
            None
        },
    })
}

pub fn lifecycle_transition(
    state: InstallState,
    event: InstallEvent,
) -> Result<InstallState, ModelPackError> {
    use InstallEvent as E;
    use InstallState as S;
    let next = match (state, event) {
        (S::NotInstalled, E::Enqueue) => S::Queued,
        (S::Queued, E::StartDownload) => S::Downloading,
        (S::Queued, E::Pause) => S::Paused,
        (S::Queued, E::Remove) => S::Removing,
        (S::Queued, E::Revoke) => S::Revoked,
        (S::Downloading, E::Pause) => S::Paused,
        (S::Downloading, E::DownloadComplete) => S::Verifying,
        (S::Downloading, E::Fail) => S::Failed,
        (S::Downloading, E::Remove) => S::Removing,
        (S::Downloading, E::Revoke) => S::Revoked,
        (S::Verifying, E::VerifyOk) => S::Ready,
        (S::Verifying, E::Fail) => S::Failed,
        (S::Verifying, E::Remove) => S::Removing,
        (S::Verifying, E::Revoke) => S::Revoked,
        (S::Ready, E::Activate) => S::Active,
        (S::Ready, E::Remove) => S::Removing,
        (S::Ready, E::Revoke) => S::Revoked,
        (S::Active, E::Deactivate) => S::Ready,
        (S::Active, E::Remove) => S::Removing,
        (S::Active, E::Revoke) => S::Revoked,
        (S::Paused, E::Resume) => S::Downloading,
        (S::Paused, E::Remove) => S::Removing,
        (S::Paused, E::Revoke) => S::Revoked,
        (S::Paused, E::Fail) => S::Failed,
        (S::Failed, E::Enqueue) => S::Queued,
        (S::Failed, E::Remove) => S::Removing,
        (S::Failed, E::Revoke) => S::Revoked,
        (S::Revoked, E::Remove) => S::Removing,
        (S::Removing, E::Removed) => S::NotInstalled,
        _ => return Err(ModelPackError::InvalidLifecycleTransition),
    };
    Ok(next)
}

pub fn can_activate(snapshot: &LifecycleSnapshot) -> bool {
    matches!(snapshot.state, InstallState::Ready | InstallState::Active)
}

#[async_trait(?Send)]
pub trait ModelStore {
    async fn status(&self) -> Result<StoreStatus, ModelPackError>;
    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError>;
    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError>;
    async fn reserve_file(
        &mut self,
        manifest: &VerifiedManifest,
        file: &ModelPackFile,
    ) -> Result<DownloadTask, ModelPackError>;
    async fn resume_metadata(
        &self,
        storage_key: &str,
    ) -> Result<Option<DownloadTask>, ModelPackError>;
    async fn promote_file(
        &mut self,
        storage_key: &str,
        sha256: &str,
        byte_size: u64,
    ) -> Result<StoredFile, ModelPackError>;
    async fn activate_pack(
        &mut self,
        manifest: &VerifiedManifest,
    ) -> Result<LifecycleSnapshot, ModelPackError>;
    async fn rollback_active(&mut self) -> Result<Option<LifecycleSnapshot>, ModelPackError>;
    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError>;
    async fn active_pack(&self) -> Result<Option<ActivePackIdentity>, ModelPackError>;
    async fn open_immutable_file(
        &self,
        pack_id: &str,
        pack_version: &str,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError>;
}

fn validate_raven(file: &ModelPackFile, raven: &RavenRefs) -> Result<(), ModelPackError> {
    require_nonblank(&raven.canonical_config_id)?;
    require_nonblank(&raven.source_checkpoint_revision)?;
    require_nonblank(&raven.conversion_revision)?;
    require_nonblank(&raven.architecture_abi)?;
    require_nonblank(&raven.tokenizer_asset_id)?;
    require_nonblank(&raven.text_conditioner_asset_id)?;
    require_nonblank(&raven.bos_asset_id)?;
    require_nonblank(&raven.model_asset_id)?;
    require_nonblank(&raven.voice_state_compatibility_group_id)?;
    if raven.layer_count == 0 || raven.model_asset_id != file.file_id {
        return invalid("raven_refs");
    }
    Ok(())
}

fn validate_abi(abi: &AbiRequirements) -> Result<(), ModelPackError> {
    require_nonblank(&abi.min_aurora_version)?;
    require_nonblank(&abi.min_runtime_version)?;
    require_nonblank(&abi.min_engine_version)?;
    require_nonblank(&abi.engine_source_revision)?;
    let mut flags = BTreeSet::new();
    for flag in &abi.build_flags {
        require_nonblank(flag)?;
        if !flags.insert(flag) {
            return invalid("duplicate_flag");
        }
    }
    Ok(())
}

fn validate_compatibility(compatibility: &Compatibility) -> Result<(), ModelPackError> {
    require_nonblank(&compatibility.group_id)?;
    require_nonblank(&compatibility.preprocessing_abi)?;
    require_nonblank(&compatibility.postprocessing_abi)?;
    if compatibility.sample_rate_hz == 0
        || compatibility.channels == 0
        || compatibility.frame_size == 0
    {
        return invalid("compatibility");
    }
    Ok(())
}

fn validate_provenance(provenance: &Provenance) -> Result<(), ModelPackError> {
    require_nonblank(&provenance.upstream_source)?;
    require_nonblank(&provenance.upstream_revision)?;
    require_nonblank(&provenance.license)?;
    require_nonblank(&provenance.attribution)?;
    validate_sha256(&provenance.build_recipe_sha256)
}

fn validate_url(raw: &str) -> Result<(), ModelPackError> {
    if raw.starts_with('/') && !raw.starts_with("//") {
        return Ok(());
    }
    if raw.starts_with("https://") {
        Ok(())
    } else {
        invalid("url")
    }
}

fn validate_sha256(value: &str) -> Result<(), ModelPackError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        invalid("sha256")
    }
}

fn require_nonblank(value: &str) -> Result<(), ModelPackError> {
    if value.trim().is_empty() {
        invalid("blank")
    } else {
        Ok(())
    }
}

fn invalid<T>(code: &'static str) -> Result<T, ModelPackError> {
    Err(ModelPackError::InvalidManifest { code })
}

fn trust<T>(code: &'static str) -> Result<T, ModelPackError> {
    Err(ModelPackError::Trust { code })
}

fn encode_key(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                output.push(char::from(byte));
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

struct ObjectWriter {
    output: String,
    first: bool,
}

impl ObjectWriter {
    fn new() -> Self {
        Self {
            output: String::from("{"),
            first: true,
        }
    }

    fn field(&mut self, key: &str, write_value: impl FnOnce(&mut String)) {
        if !self.first {
            self.output.push(',');
        }
        self.first = false;
        write_json_string(&mut self.output, key);
        self.output.push(':');
        write_value(&mut self.output);
    }

    fn finish(mut self) -> String {
        self.output.push('}');
        self.output
    }
}

fn write_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            character if character <= '\u{1f}' => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

fn write_string_option(output: &mut String, value: &Option<String>) {
    if let Some(value) = value {
        write_json_string(output, value);
    } else {
        output.push_str("null");
    }
}

fn write_revocation_option(output: &mut String, value: &Option<Revocation>) {
    if let Some(value) = value {
        write_revocation(output, value);
    } else {
        output.push_str("null");
    }
}

fn write_array<T>(output: &mut String, values: &[T], mut writer: impl FnMut(&mut String, &T)) {
    output.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        writer(output, value);
    }
    output.push(']');
}

fn write_pack_tasks(output: &mut String, values: &[PackTask]) {
    write_array(output, values, |output, value| {
        write_json_string(output, pack_task_str(*value))
    });
}

fn write_browser_features(output: &mut String, values: &[BrowserFeature]) {
    write_array(output, values, |output, value| {
        write_json_string(output, browser_feature_str(*value));
    });
}

fn write_strings(output: &mut String, values: &[String]) {
    write_array(output, values, |output, value| {
        write_json_string(output, value)
    });
}

fn write_files(output: &mut String, files: &[ModelPackFile]) {
    write_array(output, files, |output, file| {
        let mut object = ObjectWriter::new();
        object.field("asset_id", |out| write_json_string(out, &file.asset_id));
        object.field("byte_size", |out| out.push_str(&file.byte_size.to_string()));
        object.field("compression", |out| {
            write_json_string(out, compression_str(file.compression));
        });
        object.field("dependencies", |out| write_strings(out, &file.dependencies));
        object.field("file_id", |out| write_json_string(out, &file.file_id));
        object.field("license", |out| write_json_string(out, &file.license));
        object.field("provenance", |out| write_provenance(out, &file.provenance));
        object.field("raven", |out| write_raven_option(out, &file.raven));
        object.field("revocation", |out| {
            write_revocation_option(out, &file.revocation)
        });
        object.field("sha256", |out| write_json_string(out, &file.sha256));
        object.field("task", |out| {
            write_json_string(out, pack_task_str(file.task))
        });
        object.field("url", |out| write_json_string(out, &file.url));
        output.push_str(&object.finish());
    });
}

fn write_variants(output: &mut String, variants: &[ModelPackVariant]) {
    write_array(output, variants, |output, variant| {
        let mut object = ObjectWriter::new();
        object.field("abi", |out| write_abi(out, &variant.abi));
        object.field("arch", |out| {
            write_json_string(out, target_arch_str(variant.arch))
        });
        object.field("compatibility", |out| {
            write_compatibility(out, &variant.compatibility);
        });
        object.field("engine", |out| {
            write_json_string(out, engine_str(variant.engine))
        });
        object.field("file_ids", |out| write_strings(out, &variant.file_ids));
        object.field("min_device_memory_mb", |out| {
            write_u64_option(out, variant.min_device_memory_mb);
        });
        object.field("os", |out| {
            write_json_string(out, target_os_str(variant.os))
        });
        object.field("required_browser_features", |out| {
            write_browser_features(out, &variant.required_browser_features);
        });
        object.field("resource_budget", |out| {
            write_resource_budget(out, &variant.resource_budget);
        });
        object.field("revocation", |out| {
            write_revocation_option(out, &variant.revocation)
        });
        object.field("target", |out| {
            write_json_string(out, runtime_target_str(variant.target))
        });
        object.field("variant_id", |out| {
            write_json_string(out, &variant.variant_id)
        });
        output.push_str(&object.finish());
    });
}

fn write_u64_option(output: &mut String, value: Option<u64>) {
    if let Some(value) = value {
        output.push_str(&value.to_string());
    } else {
        output.push_str("null");
    }
}

fn write_provenance(output: &mut String, provenance: &Provenance) {
    let mut object = ObjectWriter::new();
    object.field("attribution", |out| {
        write_json_string(out, &provenance.attribution)
    });
    object.field("build_recipe_sha256", |out| {
        write_json_string(out, &provenance.build_recipe_sha256);
    });
    object.field("license", |out| write_json_string(out, &provenance.license));
    object.field("upstream_revision", |out| {
        write_json_string(out, &provenance.upstream_revision);
    });
    object.field("upstream_source", |out| {
        write_json_string(out, &provenance.upstream_source);
    });
    output.push_str(&object.finish());
}

fn write_resource_budget(output: &mut String, budget: &ResourceBudget) {
    let mut object = ObjectWriter::new();
    object.field("max_download_bytes", |out| {
        out.push_str(&budget.max_download_bytes.to_string());
    });
    object.field("max_installed_bytes", |out| {
        out.push_str(&budget.max_installed_bytes.to_string());
    });
    object.field("max_memory_bytes", |out| {
        out.push_str(&budget.max_memory_bytes.to_string());
    });
    output.push_str(&object.finish());
}

fn write_compatibility(output: &mut String, compatibility: &Compatibility) {
    let mut object = ObjectWriter::new();
    object.field("channels", |out| {
        out.push_str(&compatibility.channels.to_string())
    });
    object.field("frame_size", |out| {
        out.push_str(&compatibility.frame_size.to_string())
    });
    object.field("group_id", |out| {
        write_json_string(out, &compatibility.group_id)
    });
    object.field("interoperable", |out| {
        out.push_str(if compatibility.interoperable {
            "true"
        } else {
            "false"
        })
    });
    object.field("postprocessing_abi", |out| {
        write_json_string(out, &compatibility.postprocessing_abi);
    });
    object.field("preprocessing_abi", |out| {
        write_json_string(out, &compatibility.preprocessing_abi);
    });
    object.field("sample_rate_hz", |out| {
        out.push_str(&compatibility.sample_rate_hz.to_string());
    });
    output.push_str(&object.finish());
}

fn write_abi(output: &mut String, abi: &AbiRequirements) {
    let mut object = ObjectWriter::new();
    object.field("build_flags", |out| write_strings(out, &abi.build_flags));
    object.field("engine_source_revision", |out| {
        write_json_string(out, &abi.engine_source_revision);
    });
    object.field("min_aurora_version", |out| {
        write_json_string(out, &abi.min_aurora_version);
    });
    object.field("min_engine_version", |out| {
        write_json_string(out, &abi.min_engine_version);
    });
    object.field("min_runtime_version", |out| {
        write_json_string(out, &abi.min_runtime_version);
    });
    output.push_str(&object.finish());
}

fn write_raven_option(output: &mut String, value: &Option<RavenRefs>) {
    if let Some(raven) = value {
        let mut object = ObjectWriter::new();
        object.field("architecture_abi", |out| {
            write_json_string(out, &raven.architecture_abi);
        });
        object.field("bos_asset_id", |out| {
            write_json_string(out, &raven.bos_asset_id)
        });
        object.field("canonical_config_id", |out| {
            write_json_string(out, &raven.canonical_config_id);
        });
        object.field("conversion_revision", |out| {
            write_json_string(out, &raven.conversion_revision);
        });
        object.field("layer_count", |out| {
            out.push_str(&raven.layer_count.to_string())
        });
        object.field("model_asset_id", |out| {
            write_json_string(out, &raven.model_asset_id);
        });
        object.field("source_checkpoint_revision", |out| {
            write_json_string(out, &raven.source_checkpoint_revision);
        });
        object.field("text_conditioner_asset_id", |out| {
            write_json_string(out, &raven.text_conditioner_asset_id);
        });
        object.field("tokenizer_asset_id", |out| {
            write_json_string(out, &raven.tokenizer_asset_id);
        });
        object.field("voice_state_compatibility_group_id", |out| {
            write_json_string(out, &raven.voice_state_compatibility_group_id);
        });
        output.push_str(&object.finish());
    } else {
        output.push_str("null");
    }
}

fn write_revocation(output: &mut String, revocation: &Revocation) {
    let mut object = ObjectWriter::new();
    object.field("reason", |out| {
        write_json_string(out, revocation_reason_str(revocation.reason));
    });
    object.field("replacement_pack_id", |out| {
        write_string_option(out, &revocation.replacement_pack_id);
    });
    object.field("revoked", |out| {
        out.push_str(if revocation.revoked { "true" } else { "false" })
    });
    object.field("since", |out| write_json_string(out, &revocation.since));
    output.push_str(&object.finish());
}

fn pack_task_str(value: PackTask) -> &'static str {
    match value {
        PackTask::Tts => "tts",
        PackTask::Stt => "stt",
        PackTask::Vad => "vad",
        PackTask::Wakeword => "wakeword",
        PackTask::VoiceState => "voice_state",
    }
}

fn runtime_target_str(value: RuntimeTarget) -> &'static str {
    match value {
        RuntimeTarget::Web => "web",
        RuntimeTarget::Desktop => "desktop",
        RuntimeTarget::Android => "android",
        RuntimeTarget::Ios => "ios",
    }
}

fn target_os_str(value: TargetOs) -> &'static str {
    match value {
        TargetOs::Linux => "linux",
        TargetOs::Windows => "windows",
        TargetOs::Macos => "macos",
        TargetOs::Android => "android",
        TargetOs::Ios => "ios",
        TargetOs::Web => "web",
    }
}

fn target_arch_str(value: TargetArch) -> &'static str {
    match value {
        TargetArch::X86_64 => "x86_64",
        TargetArch::Aarch64 => "aarch64",
        TargetArch::Wasm32 => "wasm32",
    }
}

fn engine_str(value: EngineKind) -> &'static str {
    match value {
        EngineKind::SherpaOnnx => "sherpa_onnx",
        EngineKind::Raven => "raven",
        EngineKind::Piper => "piper",
        EngineKind::Custom => "custom",
    }
}

fn browser_feature_str(value: BrowserFeature) -> &'static str {
    match value {
        BrowserFeature::Simd => "simd",
        BrowserFeature::Threads => "threads",
        BrowserFeature::SharedArrayBuffer => "shared_array_buffer",
        BrowserFeature::WebGpu => "web_gpu",
    }
}

fn compression_str(value: CompressionKind) -> &'static str {
    match value {
        CompressionKind::None => "none",
        CompressionKind::Gzip => "gzip",
        CompressionKind::Brotli => "brotli",
        CompressionKind::Zip => "zip",
    }
}

fn revocation_reason_str(value: RevocationReason) -> &'static str {
    match value {
        RevocationReason::Corrupt => "corrupt",
        RevocationReason::Legal => "legal",
        RevocationReason::Superseded => "superseded",
        RevocationReason::Security => "security",
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (bytes.len() as u64).saturating_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut state = INITIAL;
    for chunk in padded.chunks(64) {
        let mut words = [0_u32; 64];
        for (index, bytes) in chunk.chunks(4).enumerate().take(16) {
            words[index] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut digest = [0_u8; 32];
    for (index, value) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    digest
}

impl fmt::Display for VerificationMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Signature => formatter.write_str("signature"),
            Self::ReleaseHash => formatter.write_str("release-hash"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

    fn provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
            license: "Apache-2.0".to_owned(),
            attribution: "Aurora".to_owned(),
        }
    }

    fn file(file_id: &str, task: PackTask, byte_size: u64) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
            byte_size,
            sha256: HASH.to_owned(),
            url: format!("/models/{file_id}"),
            compression: CompressionKind::None,
            dependencies: Vec::new(),
            license: "Apache-2.0".to_owned(),
            provenance: provenance(),
            raven: None,
            revocation: None,
        }
    }

    fn abi() -> AbiRequirements {
        AbiRequirements {
            min_aurora_version: "1.0.0".to_owned(),
            min_runtime_version: "1.0.0".to_owned(),
            min_engine_version: "1.0.0".to_owned(),
            engine_source_revision: "142807".to_owned(),
            build_flags: vec!["cpu".to_owned()],
        }
    }

    fn compatibility(interoperable: bool) -> Compatibility {
        Compatibility {
            group_id: "group-a".to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            sample_rate_hz: 16_000,
            channels: 1,
            frame_size: 512,
            interoperable,
        }
    }

    fn variant(
        id: &str,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
    ) -> ModelPackVariant {
        ModelPackVariant {
            variant_id: id.to_owned(),
            target,
            os,
            arch,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            resource_budget: ResourceBudget {
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
            },
            compatibility: compatibility(false),
            file_ids: vec!["model".to_owned()],
            abi: abi(),
            revocation: None,
        }
    }

    fn manifest() -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: "pack".to_owned(),
            pack_version: "1.0.0".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![PackTask::Stt],
            license: "Apache-2.0".to_owned(),
            provenance: provenance(),
            files: vec![file("model", PackTask::Stt, 100)],
            variants: vec![variant(
                "linux",
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
            )],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key1".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        }
    }

    #[test]
    fn validates_manifest_shape_and_rejects_urls_hashes_duplicates_and_dependencies() {
        assert!(validate_manifest(&manifest()).is_ok());

        let mut bad = manifest();
        bad.files[0].url = "http://example.test/model".to_owned();
        assert!(matches!(
            validate_manifest(&bad),
            Err(ModelPackError::InvalidManifest { code: "url" })
        ));

        let mut bad = manifest();
        bad.files[0].sha256 = HASH.to_uppercase();
        assert!(matches!(
            validate_manifest(&bad),
            Err(ModelPackError::InvalidManifest { code: "sha256" })
        ));

        let mut bad = manifest();
        bad.files.push(bad.files[0].clone());
        assert!(matches!(
            validate_manifest(&bad),
            Err(ModelPackError::InvalidManifest { code: "duplicate" })
        ));

        let mut bad = manifest();
        bad.files[0].dependencies = vec!["missing".to_owned()];
        assert!(matches!(
            validate_manifest(&bad),
            Err(ModelPackError::InvalidManifest {
                code: "unknown_dependency"
            })
        ));
    }

    #[test]
    fn validates_raven_exact_references() {
        let mut manifest = manifest();
        manifest.files = vec![
            file("tokenizer", PackTask::Tts, 10),
            file("conditioner", PackTask::Tts, 10),
            file("bos", PackTask::Tts, 10),
            file("model", PackTask::Tts, 100),
        ];
        manifest.files[3].dependencies = vec![
            "tokenizer".to_owned(),
            "conditioner".to_owned(),
            "bos".to_owned(),
        ];
        manifest.files[3].raven = Some(RavenRefs {
            canonical_config_id: "cfg".to_owned(),
            source_checkpoint_revision: "checkpoint".to_owned(),
            conversion_revision: "conversion".to_owned(),
            architecture_abi: "raven-v1".to_owned(),
            layer_count: 24,
            tokenizer_asset_id: "tokenizer".to_owned(),
            text_conditioner_asset_id: "conditioner".to_owned(),
            bos_asset_id: "bos".to_owned(),
            model_asset_id: "model".to_owned(),
            voice_state_compatibility_group_id: "voice-state".to_owned(),
        });
        assert!(validate_manifest(&manifest).is_ok());
        manifest.files[3].dependencies.pop();
        assert!(matches!(
            validate_manifest(&manifest),
            Err(ModelPackError::InvalidManifest {
                code: "raven_dependency"
            })
        ));
    }

    #[test]
    fn canonical_json_sorts_keys_and_excludes_signature() -> Result<(), ModelPackError> {
        let canonical = canonical_manifest_json(&manifest())?;
        assert!(!canonical.contains("signature"));
        assert!(canonical.find("display_name") < canonical.find("files"));
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(canonical_f64(12.0)?, "12");
        assert!(matches!(
            canonical_f64(f64::NAN),
            Err(ModelPackError::InvalidManifest { code: "nonfinite" })
        ));
        Ok(())
    }

    #[test]
    fn trust_boundary_supports_signature_release_hash_and_revocation() -> Result<(), ModelPackError>
    {
        let manifest = manifest();
        let verified = verify_manifest(
            manifest.clone(),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )?;
        assert_eq!(verified.mode(), VerificationMode::Signature);
        assert_eq!(verified.key_id(), Some("key1"));

        let canonical = canonical_manifest_json(&manifest)?;
        let hash = sha256_hex(canonical.as_bytes());
        let mut unsigned = manifest.clone();
        unsigned.signature = None;
        let verified = verify_manifest(
            unsigned,
            &TrustPolicy {
                expected_release_hash: Some(hash),
                ..TrustPolicy::default()
            },
            None,
        )?;
        assert_eq!(verified.mode(), VerificationMode::ReleaseHash);

        let mut policy = TrustPolicy::default();
        policy.revoked_key_ids.insert("key1".to_owned());
        assert!(matches!(
            verify_manifest(manifest, &policy, Some(&AcceptingVerifier)),
            Err(ModelPackError::Trust {
                code: "revoked_key"
            })
        ));
        Ok(())
    }

    #[test]
    fn variant_selection_is_deterministic_and_does_not_infer_interoperability() {
        let mut manifest = manifest();
        let mut wasm = variant(
            "wasm",
            RuntimeTarget::Web,
            TargetOs::Web,
            TargetArch::Wasm32,
        );
        wasm.required_browser_features = vec![BrowserFeature::Simd];
        wasm.min_device_memory_mb = Some(4096);
        wasm.compatibility = compatibility(false);
        let mut wasm_threads = wasm.clone();
        wasm_threads.variant_id = "wasm-threads".to_owned();
        wasm_threads.required_browser_features =
            vec![BrowserFeature::Simd, BrowserFeature::Threads];
        wasm_threads.compatibility = compatibility(true);
        manifest.variants = vec![wasm, wasm_threads.clone()];
        let mut features = BTreeSet::new();
        features.insert(BrowserFeature::Simd);
        features.insert(BrowserFeature::Threads);
        let selection = RuntimeSelection {
            target: RuntimeTarget::Web,
            os: TargetOs::Web,
            arch: TargetArch::Wasm32,
            browser_features: features,
            device_memory_mb: Some(4096),
            max_download_bytes: 2048,
            max_installed_bytes: 2048,
            max_memory_bytes: 2048,
            require_interoperable: true,
        };
        assert_eq!(
            select_variant(&manifest, &selection).map(|variant| variant.variant_id.as_str()),
            Ok("wasm-threads")
        );
        manifest.variants[1].compatibility.interoperable = false;
        assert_eq!(
            select_variant(&manifest, &selection),
            Err(ModelPackError::NoCompatibleVariant)
        );
    }

    #[test]
    fn lifecycle_table_and_keys_are_versioned() -> Result<(), ModelPackError> {
        let snapshot = create_lifecycle_snapshot("pack id", "1/2", 1, InstallState::NotInstalled);
        assert!(lifecycle_storage_key("pack id", "1/2").starts_with("aurora.voice.model-pack.v1:"));
        assert!(file_storage_key("pack id", "1/2", "model").contains("#model"));
        let queued = apply_lifecycle_event(&snapshot, InstallEvent::Enqueue, 2, None)?;
        let downloading = apply_lifecycle_event(&queued, InstallEvent::StartDownload, 3, None)?;
        let verifying =
            apply_lifecycle_event(&downloading, InstallEvent::DownloadComplete, 4, None)?;
        let ready = apply_lifecycle_event(&verifying, InstallEvent::VerifyOk, 5, None)?;
        assert!(can_activate(&ready));
        assert_eq!(
            apply_lifecycle_event(&snapshot, InstallEvent::Activate, 6, None),
            Err(ModelPackError::InvalidLifecycleTransition)
        );
        Ok(())
    }

    #[test]
    fn product_safe_errors_do_not_include_sensitive_material() {
        let error = ModelPackError::Trust { code: "signature" }.to_string();
        assert!(!error.contains("https://"));
        assert!(!error.contains("signed"));
        assert!(!error.contains("aaaaaaaa"));
        assert!(!error.contains(HASH));
    }

    #[test]
    fn hex_validation_accepts_only_lowercase_64() {
        for value in [HASH, HASH_B] {
            assert!(validate_sha256(value).is_ok());
            assert!(validate_sha256(&value.to_uppercase()).is_err());
        }
    }

    #[test]
    fn revoked_dependency_fails_closed() {
        let mut manifest = manifest();
        let mut dependency = file("dep", PackTask::Stt, 10);
        dependency.revocation = Some(Revocation {
            revoked: true,
            reason: RevocationReason::Security,
            since: "2026-08-07".to_owned(),
            replacement_pack_id: None,
        });
        manifest.files.push(dependency);
        manifest.files[0].dependencies = vec!["dep".to_owned()];
        assert!(matches!(
            validate_manifest(&manifest),
            Err(ModelPackError::InvalidManifest {
                code: "revoked_dependency"
            })
        ));
    }

    #[test]
    fn fixture_manifest_is_public_for_testkit() {
        let fixture = manifest();
        assert!(validate_manifest(&fixture).is_ok());
        assert_ne!(HASH, HASH_B);
    }
}
