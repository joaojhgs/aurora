use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackTask {
    Kws,
    Wakeword,
    Vad,
    Stt,
    Tts,
    VoiceEmbedding,
    Tokenizer,
    Frontend,
    VoiceState,
}

impl PackTask {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kws => "kws",
            Self::Wakeword => "wakeword",
            Self::Vad => "vad",
            Self::Stt => "stt",
            Self::Tts => "tts",
            Self::VoiceEmbedding => "voice_embedding",
            Self::Tokenizer => "tokenizer",
            Self::Frontend => "frontend",
            Self::VoiceState => "voice_state",
        }
    }
}

const DEFAULT_MODEL_STORE_SLOT_ID: &str = "default";
const MAX_MODEL_STORE_SLOT_ID_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub struct ModelStoreScope {
    task: PackTask,
    slot_id: String,
}

impl ModelStoreScope {
    pub fn new(task: PackTask, slot_id: impl Into<String>) -> Result<Self, ModelPackError> {
        let slot_id = slot_id.into();
        validate_scope_slot_id(&slot_id)?;
        Ok(Self { task, slot_id })
    }

    pub fn default_for_task(task: PackTask) -> Self {
        Self {
            task,
            slot_id: DEFAULT_MODEL_STORE_SLOT_ID.to_owned(),
        }
    }

    pub fn task(&self) -> PackTask {
        self.task
    }

    pub fn slot_id(&self) -> &str {
        &self.slot_id
    }
}

impl<'de> Deserialize<'de> for ModelStoreScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawModelStoreScope {
            task: PackTask,
            slot_id: String,
        }

        let raw = RawModelStoreScope::deserialize(deserializer)?;
        Self::new(raw.task, raw.slot_id).map_err(serde::de::Error::custom)
    }
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
pub struct ReleaseIndexEntry {
    pub pack_id: String,
    pub pack_version: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseIndex {
    pub source: String,
    pub revision: String,
    pub manifests: Vec<ReleaseIndexEntry>,
    pub signature: Option<ManifestSignature>,
}

#[derive(Debug, Clone)]
pub struct VerifiedReleaseIndexEntry {
    source: String,
    revision: String,
    key_id: String,
    pack_id: String,
    pack_version: String,
    manifest_sha256: String,
}

impl VerifiedReleaseIndexEntry {
    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub identifier: String,
    pub text_url: String,
    pub text_sha256: String,
    pub commercial_use: bool,
    pub redistribution: LicenseGrant,
    pub attribution: String,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageSupport {
    pub language: String,
    pub locale: Option<String>,
    pub fixed_language: bool,
    pub auto_detect: bool,
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
    pub voice_state_group_id: String,
    pub preprocessing_abi: String,
    pub postprocessing_abi: String,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_size: u32,
    pub interoperable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShapeMetadata {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub frame_size: u32,
    pub window_size: u32,
    pub cache_state: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessingMetadata {
    pub tokenizer_sha256: Option<String>,
    pub operator_inventory_sha256: String,
    pub preprocessing_abi: String,
    pub postprocessing_abi: String,
    pub shapes: ShapeMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityFlags {
    pub streaming: bool,
    pub cancellation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceClass {
    Low,
    Balanced,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeGates {
    pub min_cpu_threads: u16,
    pub max_rtf_millis_per_second: u32,
    pub min_device_class: DeviceClass,
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
    pub installed_size: u64,
    pub install_order: u32,
    pub dependencies: Vec<String>,
    pub license: LicenseInfo,
    pub provenance: Provenance,
    pub processing: ProcessingMetadata,
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
    pub runtime_gates: RuntimeGates,
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
    pub license: LicenseInfo,
    pub languages: Vec<LanguageSupport>,
    pub capabilities: CapabilityFlags,
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
    pub cpu_threads: u16,
    pub max_rtf_millis_per_second: u32,
    pub device_class: DeviceClass,
    pub require_interoperable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantRequirements {
    pub download_bytes: u64,
    pub installed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleSnapshot {
    pub pack_id: String,
    pub pack_version: String,
    pub variant_id: String,
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

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadTask {
    pub storage_key: String,
    pub pack_id: String,
    pub pack_version: String,
    pub file_id: String,
    pub url: String,
    pub expected_sha256: String,
    pub expected_bytes: u64,
    pub variant_id: String,
}

impl fmt::Debug for DownloadTask {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadTask")
            .field("storage_key", &self.storage_key)
            .field("pack_id", &self.pack_id)
            .field("pack_version", &self.pack_version)
            .field("file_id", &self.file_id)
            .field("url", &"<redacted>")
            .field("expected_sha256", &self.expected_sha256)
            .field("expected_bytes", &self.expected_bytes)
            .field("variant_id", &self.variant_id)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredFile {
    pub storage_key: String,
    pub pack_id: String,
    pub pack_version: String,
    pub file_id: String,
    pub variant_id: String,
    pub sha256: String,
    pub byte_size: u64,
    pub state: InstallState,
    pub stored_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivePackIdentity {
    pub scope: ModelStoreScope,
    pub pack_id: String,
    pub pack_version: String,
    pub variant_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmutableModelFile {
    pub storage_key: String,
    pub sha256: String,
    pub byte_size: u64,
    pub variant_id: String,
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
    release_index_source: Option<String>,
    release_index_revision: Option<String>,
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

    pub fn release_index_source(&self) -> Option<&str> {
        self.release_index_source.as_deref()
    }

    pub fn release_index_revision(&self) -> Option<&str> {
        self.release_index_revision.as_deref()
    }
}

#[derive(Debug, Clone)]
pub struct SelectedVariant {
    manifest_sha256: String,
    pack_id: String,
    pack_version: String,
    variant_id: String,
    file_ids: BTreeSet<String>,
    requirements: VariantRequirements,
}

impl SelectedVariant {
    pub fn pack_id(&self) -> &str {
        &self.pack_id
    }

    pub fn pack_version(&self) -> &str {
        &self.pack_version
    }

    pub fn variant_id(&self) -> &str {
        &self.variant_id
    }

    pub fn file_ids(&self) -> &BTreeSet<String> {
        &self.file_ids
    }

    pub fn requirements(&self) -> &VariantRequirements {
        &self.requirements
    }

    pub fn belongs_to(&self, manifest: &VerifiedManifest) -> bool {
        self.manifest_sha256 == manifest.manifest_sha256
            && self.pack_id == manifest.manifest().pack_id
            && self.pack_version == manifest.manifest().pack_version
            && manifest
                .manifest()
                .variants
                .iter()
                .any(|variant| variant.variant_id == self.variant_id)
    }
}

pub trait SignatureVerifier {
    fn verify(
        &self,
        canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError>;
}

pub trait TrustStore {
    fn verify_signed_payload(
        &self,
        canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError>;
}

impl<T> TrustStore for T
where
    T: SignatureVerifier + ?Sized,
{
    fn verify_signed_payload(
        &self,
        canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError> {
        self.verify(canonical_json, signature)
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrustPolicy {
    pub revoked_pack_ids: BTreeSet<String>,
    pub revoked_key_ids: BTreeSet<String>,
    pub verified_release_index_entry: Option<VerifiedReleaseIndexEntry>,
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
    validate_license(&manifest.license)?;
    validate_capabilities(&manifest.capabilities)?;
    validate_provenance(&manifest.provenance)?;
    if manifest.tasks.is_empty()
        || manifest.files.is_empty()
        || manifest.variants.is_empty()
        || manifest.languages.is_empty()
    {
        return invalid("empty");
    }
    let mut tasks = BTreeSet::new();
    for task in &manifest.tasks {
        if !tasks.insert(*task) {
            return invalid("duplicate_task");
        }
    }
    for language in &manifest.languages {
        validate_language(language)?;
    }

    let mut file_ids = BTreeSet::new();
    let mut asset_ids = BTreeSet::new();
    let mut revoked_file_ids = BTreeSet::new();
    for file in &manifest.files {
        require_nonblank(&file.file_id)?;
        require_nonblank(&file.asset_id)?;
        validate_license(&file.license)?;
        validate_url(&file.url)?;
        validate_sha256(&file.sha256)?;
        validate_provenance(&file.provenance)?;
        validate_processing(&file.processing)?;
        if file.byte_size == 0 || file.installed_size == 0 {
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
            if dependency == &file.file_id {
                return invalid("self_dependency");
            }
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

    for file in manifest
        .files
        .iter()
        .filter(|file| !file.revocation.as_ref().is_some_and(|rev| rev.revoked))
    {
        let mut selected = BTreeSet::new();
        let mut visiting = BTreeSet::new();
        collect_file_closure(manifest, &file.file_id, &mut visiting, &mut selected)?;
    }

    let mut variant_ids = BTreeSet::new();
    for variant in &manifest.variants {
        require_nonblank(&variant.variant_id)?;
        validate_abi(&variant.abi)?;
        validate_compatibility(&variant.compatibility)?;
        validate_runtime_gates(&variant.runtime_gates)?;
        if !variant_ids.insert(variant.variant_id.clone()) {
            return invalid("duplicate_variant");
        }
        if variant.file_ids.is_empty() {
            return invalid("variant_file");
        }
        let mut variant_files = BTreeSet::new();
        for file_id in &variant.file_ids {
            if !variant_files.insert(file_id.clone()) {
                return invalid("duplicate_variant_file");
            }
            let file = manifest_file(manifest, file_id)?;
            if revoked_file_ids.contains(file_id) || !tasks.contains(&file.task) {
                return invalid("variant_file");
            }
        }
        let requirements = variant_requirements(manifest, variant)?;
        if variant.resource_budget.max_download_bytes == 0
            || variant.resource_budget.max_installed_bytes == 0
            || variant.resource_budget.max_memory_bytes == 0
        {
            return invalid("budget");
        }
        if variant.resource_budget.max_download_bytes < requirements.download_bytes
            || variant.resource_budget.max_installed_bytes < requirements.installed_bytes
        {
            return invalid("budget");
        }
    }
    Ok(())
}

pub fn canonical_manifest_json(manifest: &ModelPackManifest) -> Result<String, ModelPackError> {
    let mut value = serde_json::to_value(manifest)
        .map_err(|_| ModelPackError::InvalidManifest { code: "canonical" })?;
    if let Value::Object(object) = &mut value {
        object.remove("signature");
    }
    canonical_json(&value)
}

pub fn canonical_release_index_json(index: &ReleaseIndex) -> Result<String, ModelPackError> {
    let mut value = serde_json::to_value(index)
        .map_err(|_| ModelPackError::InvalidManifest { code: "canonical" })?;
    if let Value::Object(object) = &mut value {
        object.remove("signature");
    }
    canonical_json(&value)
}

pub fn canonical_json(value: &Value) -> Result<String, ModelPackError> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(if *value { "true" } else { "false" }.to_owned()),
        Value::Number(number) => {
            if !number.is_i64() && !number.is_u64() {
                return invalid("nonfinite");
            }
            Ok(number.to_string())
        }
        Value::String(value) => serde_json::to_string(value)
            .map_err(|_| ModelPackError::InvalidManifest { code: "canonical" }),
        Value::Array(values) => {
            let mut output = String::from("[");
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&canonical_json(item)?);
            }
            output.push(']');
            Ok(output)
        }
        Value::Object(object) => {
            let sorted: Map<String, Value> = object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            let mut output = String::from("{");
            for (index, (key, value)) in sorted.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| ModelPackError::InvalidManifest { code: "canonical" })?,
                );
                output.push(':');
                output.push_str(&canonical_json(value)?);
            }
            output.push('}');
            Ok(output)
        }
    }
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
    let digest = Sha256::digest(bytes);
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
    if manifest.signature.is_none() {
        let release =
            policy
                .verified_release_index_entry
                .as_ref()
                .ok_or(ModelPackError::Trust {
                    code: "release_index",
                })?;
        if release.pack_id != manifest.pack_id
            || release.pack_version != manifest.pack_version
            || release.manifest_sha256 != manifest_sha256
        {
            return trust("release_hash");
        }
        return Ok(VerifiedManifest {
            manifest,
            canonical_json,
            mode: VerificationMode::ReleaseHash,
            key_id: None,
            manifest_sha256,
            release_index_source: Some(release.source.clone()),
            release_index_revision: Some(release.revision.clone()),
        });
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
        release_index_source: None,
        release_index_revision: None,
    })
}

pub fn verify_release_index_entry(
    index: &ReleaseIndex,
    pack_id: &str,
    pack_version: &str,
    manifest_sha256: &str,
    trust_store: &dyn TrustStore,
) -> Result<VerifiedReleaseIndexEntry, ModelPackError> {
    require_nonblank(&index.source)?;
    require_nonblank(&index.revision)?;
    validate_sha256(manifest_sha256)?;
    let signature = index.signature.as_ref().ok_or(ModelPackError::Trust {
        code: "release_index_unsigned",
    })?;
    require_nonblank(&signature.key_id)?;
    require_nonblank(&signature.algorithm)?;
    require_nonblank(&signature.value)?;
    let canonical_json = canonical_release_index_json(index)?;
    if !trust_store.verify_signed_payload(&canonical_json, signature)? {
        return trust("release_index_signature");
    }
    let mut seen = BTreeSet::new();
    for entry in &index.manifests {
        require_nonblank(&entry.pack_id)?;
        require_nonblank(&entry.pack_version)?;
        validate_sha256(&entry.manifest_sha256)?;
        if !seen.insert((entry.pack_id.clone(), entry.pack_version.clone())) {
            return invalid("duplicate_release");
        }
    }
    let entry = index
        .manifests
        .iter()
        .find(|entry| {
            entry.pack_id == pack_id
                && entry.pack_version == pack_version
                && entry.manifest_sha256 == manifest_sha256
        })
        .ok_or(ModelPackError::Trust {
            code: "release_hash",
        })?;
    Ok(VerifiedReleaseIndexEntry {
        source: index.source.clone(),
        revision: index.revision.clone(),
        key_id: signature.key_id.clone(),
        pack_id: entry.pack_id.clone(),
        pack_version: entry.pack_version.clone(),
        manifest_sha256: entry.manifest_sha256.clone(),
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
            let Ok(requirements) = variant_requirements(manifest, variant) else {
                return false;
            };
            requirements.download_bytes <= selection.max_download_bytes
                && requirements.installed_bytes <= selection.max_installed_bytes
                && variant.resource_budget.max_download_bytes <= selection.max_download_bytes
                && variant.resource_budget.max_installed_bytes <= selection.max_installed_bytes
                && variant.resource_budget.max_memory_bytes <= selection.max_memory_bytes
                && variant.runtime_gates.min_cpu_threads <= selection.cpu_threads
                && variant.runtime_gates.max_rtf_millis_per_second
                    <= selection.max_rtf_millis_per_second
                && variant.runtime_gates.min_device_class <= selection.device_class
        })
        .filter(|variant| !selection.require_interoperable || variant.compatibility.interoperable)
        .max_by_key(|variant| variant_score(variant, selection))
        .ok_or(ModelPackError::NoCompatibleVariant)
}

pub fn select_verified_variant(
    manifest: &VerifiedManifest,
    selection: &RuntimeSelection,
) -> Result<SelectedVariant, ModelPackError> {
    let variant = select_variant(manifest.manifest(), selection)?;
    let file_ids = variant_file_closure(manifest.manifest(), variant)?;
    let requirements = variant_requirements(manifest.manifest(), variant)?;
    Ok(SelectedVariant {
        manifest_sha256: manifest.manifest_sha256.clone(),
        pack_id: manifest.manifest().pack_id.clone(),
        pack_version: manifest.manifest().pack_version.clone(),
        variant_id: variant.variant_id.clone(),
        file_ids,
        requirements,
    })
}

pub fn variant_requirements(
    manifest: &ModelPackManifest,
    variant: &ModelPackVariant,
) -> Result<VariantRequirements, ModelPackError> {
    let mut download_bytes = 0_u64;
    let mut installed_bytes = 0_u64;
    for file_id in variant_file_closure(manifest, variant)? {
        let file = manifest_file(manifest, &file_id)?;
        if file.revocation.as_ref().is_some_and(|rev| rev.revoked) {
            return invalid("variant_file");
        }
        download_bytes = download_bytes
            .checked_add(file.byte_size)
            .ok_or(ModelPackError::InvalidManifest { code: "overflow" })?;
        installed_bytes = installed_bytes
            .checked_add(file.installed_size)
            .ok_or(ModelPackError::InvalidManifest { code: "overflow" })?;
    }
    Ok(VariantRequirements {
        download_bytes,
        installed_bytes,
    })
}

fn manifest_file<'a>(
    manifest: &'a ModelPackManifest,
    file_id: &str,
) -> Result<&'a ModelPackFile, ModelPackError> {
    manifest
        .files
        .iter()
        .find(|candidate| candidate.file_id == file_id)
        .ok_or(ModelPackError::InvalidManifest {
            code: "variant_file",
        })
}

fn variant_file_closure(
    manifest: &ModelPackManifest,
    variant: &ModelPackVariant,
) -> Result<BTreeSet<String>, ModelPackError> {
    let mut selected = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    for file_id in &variant.file_ids {
        collect_file_closure(manifest, file_id, &mut visiting, &mut selected)?;
    }
    Ok(selected)
}

fn collect_file_closure(
    manifest: &ModelPackManifest,
    file_id: &str,
    visiting: &mut BTreeSet<String>,
    selected: &mut BTreeSet<String>,
) -> Result<(), ModelPackError> {
    if selected.contains(file_id) {
        return Ok(());
    }
    if !visiting.insert(file_id.to_owned()) {
        return invalid("dependency_cycle");
    }
    let file = manifest_file(manifest, file_id)?;
    if file.revocation.as_ref().is_some_and(|rev| rev.revoked) {
        return invalid("variant_file");
    }
    for dependency in &file.dependencies {
        if dependency == file_id {
            return invalid("self_dependency");
        }
        let dependency_file =
            manifest_file(manifest, dependency).map_err(|_| ModelPackError::InvalidManifest {
                code: "unknown_dependency",
            })?;
        if dependency_file
            .revocation
            .as_ref()
            .is_some_and(|rev| rev.revoked)
        {
            return invalid("revoked_dependency");
        }
        collect_file_closure(manifest, dependency, visiting, selected)?;
    }
    visiting.remove(file_id);
    selected.insert(file_id.to_owned());
    Ok(())
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

pub fn lifecycle_storage_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    format!(
        "aurora.voice.model-pack.v1:{}@{}:{}",
        encode_key(pack_id),
        encode_key(pack_version),
        encode_key(variant_id)
    )
}

pub fn scope_storage_key(scope: &ModelStoreScope) -> String {
    format!(
        "aurora.voice.model-scope.v1:{}:{}",
        scope.task().as_str(),
        encode_key(scope.slot_id())
    )
}

pub fn file_storage_key(
    pack_id: &str,
    pack_version: &str,
    variant_id: &str,
    file_id: &str,
) -> String {
    format!(
        "aurora.voice.model-file.v1:{}@{}:{}#{}",
        encode_key(pack_id),
        encode_key(pack_version),
        encode_key(variant_id),
        encode_key(file_id)
    )
}

pub fn create_lifecycle_snapshot(
    pack_id: impl Into<String>,
    pack_version: impl Into<String>,
    variant_id: impl Into<String>,
    now: u64,
    state: InstallState,
) -> LifecycleSnapshot {
    LifecycleSnapshot {
        pack_id: pack_id.into(),
        pack_version: pack_version.into(),
        variant_id: variant_id.into(),
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
        variant_id: snapshot.variant_id.clone(),
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

pub fn scope_matches_manifest(
    scope: &ModelStoreScope,
    manifest: &VerifiedManifest,
) -> Result<(), ModelPackError> {
    if manifest.manifest().tasks.contains(&scope.task()) {
        Ok(())
    } else {
        Err(ModelPackError::Store { code: "scope_task" })
    }
}

#[async_trait(?Send)]
pub trait ModelStore {
    async fn status(&self) -> Result<StoreStatus, ModelPackError>;
    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError>;
    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError>;
    async fn reserve_file(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
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
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError>;
    async fn rollback_active(
        &mut self,
        scope: ModelStoreScope,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError>;
    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError>;
    async fn active_pack(
        &self,
        scope: ModelStoreScope,
    ) -> Result<Option<ActivePackIdentity>, ModelPackError>;
    async fn open_immutable_file(
        &self,
        selection: &SelectedVariant,
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
    require_nonblank(&compatibility.voice_state_group_id)?;
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

fn validate_license(license: &LicenseInfo) -> Result<(), ModelPackError> {
    require_nonblank(&license.identifier)?;
    validate_url(&license.text_url)?;
    validate_sha256(&license.text_sha256)?;
    require_nonblank(&license.attribution)
}

fn validate_language(language: &LanguageSupport) -> Result<(), ModelPackError> {
    require_nonblank(&language.language)?;
    if let Some(locale) = &language.locale {
        require_nonblank(locale)?;
    }
    if !language.fixed_language && !language.auto_detect {
        return invalid("language");
    }
    Ok(())
}

fn validate_capabilities(_capabilities: &CapabilityFlags) -> Result<(), ModelPackError> {
    Ok(())
}

fn validate_processing(processing: &ProcessingMetadata) -> Result<(), ModelPackError> {
    if let Some(tokenizer) = &processing.tokenizer_sha256 {
        validate_sha256(tokenizer)?;
    }
    validate_sha256(&processing.operator_inventory_sha256)?;
    require_nonblank(&processing.preprocessing_abi)?;
    require_nonblank(&processing.postprocessing_abi)?;
    if processing.shapes.sample_rate_hz == 0
        || processing.shapes.channels == 0
        || processing.shapes.frame_size == 0
        || processing.shapes.window_size == 0
    {
        return invalid("shape");
    }
    let mut cache = BTreeSet::new();
    for state in &processing.shapes.cache_state {
        require_nonblank(state)?;
        if !cache.insert(state) {
            return invalid("duplicate_cache");
        }
    }
    Ok(())
}

fn validate_runtime_gates(gates: &RuntimeGates) -> Result<(), ModelPackError> {
    if gates.min_cpu_threads == 0 || gates.max_rtf_millis_per_second == 0 {
        invalid("runtime_gate")
    } else {
        Ok(())
    }
}

fn validate_provenance(provenance: &Provenance) -> Result<(), ModelPackError> {
    require_nonblank(&provenance.upstream_source)?;
    require_nonblank(&provenance.upstream_revision)?;
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

fn validate_scope_slot_id(value: &str) -> Result<(), ModelPackError> {
    if value.is_empty() || value.len() > MAX_MODEL_STORE_SLOT_ID_LEN {
        return invalid("scope");
    }
    if value
        .bytes()
        .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.'))
    {
        Ok(())
    } else {
        invalid("scope")
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
            Ok(signature.value == "signed" || signature.value == "index-signed")
        }
    }

    struct ReleaseVerifier;

    impl SignatureVerifier for ReleaseVerifier {
        fn verify(
            &self,
            _canonical_json: &str,
            signature: &ManifestSignature,
        ) -> Result<bool, ModelPackError> {
            Ok(signature.key_id == "release-key" && signature.value == "index-signed")
        }
    }

    fn provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: 16_000,
                channels: 1,
                frame_size: 512,
                window_size: 1024,
                cache_state: vec!["hidden".to_owned()],
            },
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
            installed_size: byte_size,
            install_order: 0,
            dependencies: Vec::new(),
            license: license(),
            provenance: provenance(),
            processing: processing(),
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
            voice_state_group_id: "voice-state-a".to_owned(),
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
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
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
        manifest.tasks = vec![PackTask::Tts];
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
    fn canonical_json_has_golden_sorted_output_and_hash() -> Result<(), ModelPackError> {
        let value = serde_json::json!({
            "b": [true, "x"],
            "a": {
                "d": 4,
                "c": 3
            }
        });
        let canonical = canonical_json(&value)?;
        assert_eq!(canonical, "{\"a\":{\"c\":3,\"d\":4},\"b\":[true,\"x\"]}");
        assert_eq!(
            sha256_hex(canonical.as_bytes()),
            "71374a030170d7aa3d5d63cba6d96ce51ab388e2fb2286da0624e64617fdc148"
        );
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
        let release_entry = verify_release_index_entry(
            &release_index(
                "release-index.json",
                "rev1",
                "pack",
                "1.0.0",
                &hash,
                "index-signed",
            ),
            "pack",
            "1.0.0",
            &hash,
            &AcceptingVerifier,
        )?;
        let verified = verify_manifest(
            unsigned.clone(),
            &TrustPolicy {
                verified_release_index_entry: Some(release_entry),
                ..TrustPolicy::default()
            },
            None,
        )?;
        assert_eq!(verified.mode(), VerificationMode::ReleaseHash);
        assert_eq!(verified.release_index_source(), Some("release-index.json"));
        assert_eq!(verified.release_index_revision(), Some("rev1"));
        assert!(matches!(
            verify_manifest(unsigned, &TrustPolicy::default(), None),
            Err(ModelPackError::Trust {
                code: "release_index"
            })
        ));

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

    fn release_index(
        source: &str,
        revision: &str,
        pack_id: &str,
        pack_version: &str,
        manifest_sha256: &str,
        signature: &str,
    ) -> ReleaseIndex {
        ReleaseIndex {
            source: source.to_owned(),
            revision: revision.to_owned(),
            manifests: vec![ReleaseIndexEntry {
                pack_id: pack_id.to_owned(),
                pack_version: pack_version.to_owned(),
                manifest_sha256: manifest_sha256.to_owned(),
            }],
            signature: Some(ManifestSignature {
                key_id: "release-key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: signature.to_owned(),
            }),
        }
    }

    #[test]
    fn release_hash_requires_signed_release_index_entry() -> Result<(), ModelPackError> {
        let mut manifest = manifest();
        let hash = sha256_hex(canonical_manifest_json(&manifest)?.as_bytes());
        manifest.signature = None;
        let index = release_index(
            "release-index.json",
            "rev1",
            "pack",
            "1.0.0",
            &hash,
            "index-signed",
        );
        let entry = verify_release_index_entry(&index, "pack", "1.0.0", &hash, &ReleaseVerifier)?;
        let verified = verify_manifest(
            manifest.clone(),
            &TrustPolicy {
                verified_release_index_entry: Some(entry.clone()),
                ..TrustPolicy::default()
            },
            None,
        )?;
        assert_eq!(verified.mode(), VerificationMode::ReleaseHash);
        assert_eq!(verified.release_index_source(), Some("release-index.json"));
        assert_eq!(verified.release_index_revision(), Some("rev1"));
        assert_eq!(entry.key_id(), "release-key");
        assert!(matches!(
            verify_manifest(manifest.clone(), &TrustPolicy::default(), None),
            Err(ModelPackError::Trust {
                code: "release_index"
            })
        ));
        assert!(matches!(
            verify_release_index_entry(
                &release_index("", "rev1", "pack", "1.0.0", &hash, "index-signed"),
                "pack",
                "1.0.0",
                &hash,
                &ReleaseVerifier
            ),
            Err(ModelPackError::InvalidManifest { code: "blank" })
        ));
        assert!(matches!(
            verify_release_index_entry(
                &release_index(
                    "release-index.json",
                    "",
                    "pack",
                    "1.0.0",
                    &hash,
                    "index-signed"
                ),
                "pack",
                "1.0.0",
                &hash,
                &ReleaseVerifier
            ),
            Err(ModelPackError::InvalidManifest { code: "blank" })
        ));
        let mut wrong_key = release_index(
            "release-index.json",
            "rev1",
            "pack",
            "1.0.0",
            &hash,
            "index-signed",
        );
        wrong_key.signature.as_mut().expect("signature").key_id = "wrong-key".to_owned();
        assert!(matches!(
            verify_release_index_entry(&wrong_key, "pack", "1.0.0", &hash, &ReleaseVerifier),
            Err(ModelPackError::Trust {
                code: "release_index_signature"
            })
        ));
        assert!(matches!(
            verify_release_index_entry(
                &release_index("release-index.json", "rev1", "pack", "1.0.0", &hash, "bad"),
                "pack",
                "1.0.0",
                &hash,
                &ReleaseVerifier
            ),
            Err(ModelPackError::Trust {
                code: "release_index_signature"
            })
        ));
        assert!(matches!(
            verify_release_index_entry(
                &release_index(
                    "release-index.json",
                    "rev1",
                    "pack",
                    "1.0.0",
                    HASH_B,
                    "index-signed"
                ),
                "pack",
                "1.0.0",
                &hash,
                &ReleaseVerifier
            ),
            Err(ModelPackError::Trust {
                code: "release_hash"
            })
        ));
        let mut unsigned_index = release_index(
            "release-index.json",
            "rev1",
            "pack",
            "1.0.0",
            &hash,
            "index-signed",
        );
        unsigned_index.signature = None;
        assert!(matches!(
            verify_release_index_entry(&unsigned_index, "pack", "1.0.0", &hash, &ReleaseVerifier),
            Err(ModelPackError::Trust {
                code: "release_index_unsigned"
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
            cpu_threads: 2,
            max_rtf_millis_per_second: 1_000,
            device_class: DeviceClass::Balanced,
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
    fn variant_budgets_must_cover_selected_files_without_overflow() {
        let mut manifest = manifest();
        manifest.files.push(file("extra", PackTask::Stt, 100));
        manifest.files[1].installed_size = 150;
        manifest.variants[0].file_ids = vec!["model".to_owned(), "extra".to_owned()];
        manifest.variants[0].resource_budget.max_download_bytes = 199;
        manifest.variants[0].resource_budget.max_installed_bytes = 250;
        assert!(matches!(
            validate_manifest(&manifest),
            Err(ModelPackError::InvalidManifest { code: "budget" })
        ));

        manifest.variants[0].resource_budget.max_download_bytes = u64::MAX;
        manifest.variants[0].resource_budget.max_installed_bytes = u64::MAX;
        manifest.files[0].byte_size = u64::MAX;
        assert!(matches!(
            validate_manifest(&manifest),
            Err(ModelPackError::InvalidManifest { code: "overflow" })
        ));
    }

    #[test]
    fn selected_variant_and_requirements_include_dependency_closure() -> Result<(), ModelPackError>
    {
        let mut manifest = manifest();
        manifest.files = vec![
            file("model", PackTask::Stt, 100),
            file("frontend", PackTask::Frontend, 30),
            file("tokenizer", PackTask::Tokenizer, 20),
            file("shared", PackTask::VoiceEmbedding, 10),
        ];
        manifest.files[0].dependencies = vec!["frontend".to_owned(), "tokenizer".to_owned()];
        manifest.files[1].dependencies = vec!["shared".to_owned()];
        manifest.files[2].dependencies = vec!["shared".to_owned()];
        manifest.variants[0].file_ids = vec!["model".to_owned()];
        manifest.variants[0].resource_budget.max_download_bytes = 160;
        manifest.variants[0].resource_budget.max_installed_bytes = 160;

        let requirements = variant_requirements(&manifest, &manifest.variants[0])?;
        assert_eq!(requirements.download_bytes, 160);
        assert_eq!(requirements.installed_bytes, 160);
        let verified =
            verify_manifest(manifest, &TrustPolicy::default(), Some(&AcceptingVerifier))?;
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: Some(4096),
                max_download_bytes: 160,
                max_installed_bytes: 160,
                max_memory_bytes: 1024,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: false,
            },
        )?;
        assert_eq!(selection.requirements().download_bytes, 160);
        assert_eq!(
            selection
                .file_ids()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["frontend", "model", "shared", "tokenizer"]
        );
        Ok(())
    }

    #[test]
    fn dependency_closure_rejects_self_cycles_unknown_and_revoked_transitives() {
        let mut self_dep = manifest();
        self_dep.files[0].dependencies = vec!["model".to_owned()];
        assert!(matches!(
            validate_manifest(&self_dep),
            Err(ModelPackError::InvalidManifest {
                code: "self_dependency"
            })
        ));

        let mut cycle = manifest();
        cycle.files.push(file("dep", PackTask::Tokenizer, 10));
        cycle.files[0].dependencies = vec!["dep".to_owned()];
        cycle.files[1].dependencies = vec!["model".to_owned()];
        assert!(matches!(
            validate_manifest(&cycle),
            Err(ModelPackError::InvalidManifest {
                code: "dependency_cycle"
            })
        ));

        let mut dormant_cycle = manifest();
        dormant_cycle
            .files
            .push(file("dep-a", PackTask::Frontend, 10));
        dormant_cycle
            .files
            .push(file("dep-b", PackTask::Tokenizer, 10));
        dormant_cycle.files[1].dependencies = vec!["dep-b".to_owned()];
        dormant_cycle.files[2].dependencies = vec!["dep-a".to_owned()];
        assert!(matches!(
            validate_manifest(&dormant_cycle),
            Err(ModelPackError::InvalidManifest {
                code: "dependency_cycle"
            })
        ));

        let mut transitive_unknown = manifest();
        transitive_unknown
            .files
            .push(file("dep", PackTask::Frontend, 10));
        transitive_unknown.files[0].dependencies = vec!["dep".to_owned()];
        transitive_unknown.files[1].dependencies = vec!["missing".to_owned()];
        assert!(matches!(
            validate_manifest(&transitive_unknown),
            Err(ModelPackError::InvalidManifest {
                code: "unknown_dependency"
            })
        ));

        let mut transitive_revoked = manifest();
        transitive_revoked
            .files
            .push(file("dep", PackTask::Frontend, 10));
        let mut revoked = file("revoked", PackTask::Tokenizer, 10);
        revoked.revocation = Some(Revocation {
            revoked: true,
            reason: RevocationReason::Security,
            since: "2026-08-07".to_owned(),
            replacement_pack_id: None,
        });
        transitive_revoked.files.push(revoked);
        transitive_revoked.files[0].dependencies = vec!["dep".to_owned()];
        transitive_revoked.files[1].dependencies = vec!["revoked".to_owned()];
        assert!(matches!(
            validate_manifest(&transitive_revoked),
            Err(ModelPackError::InvalidManifest {
                code: "revoked_dependency"
            })
        ));
    }

    #[test]
    fn lifecycle_table_and_keys_are_versioned() -> Result<(), ModelPackError> {
        let snapshot =
            create_lifecycle_snapshot("pack id", "1/2", "linux", 1, InstallState::NotInstalled);
        let scope = ModelStoreScope::new(PackTask::Stt, "primary.slot")?;
        let linux_key = lifecycle_storage_key("pack id", "1/2", "linux");
        let android_key = lifecycle_storage_key("pack id", "1/2", "android/arm64");
        assert_eq!(
            linux_key,
            "aurora.voice.model-pack.v1:pack%20id@1%2F2:linux"
        );
        assert_eq!(
            android_key,
            "aurora.voice.model-pack.v1:pack%20id@1%2F2:android%2Farm64"
        );
        assert_ne!(linux_key, android_key);
        assert!(file_storage_key("pack id", "1/2", "linux", "model").contains(":linux#model"));
        assert_eq!(
            scope_storage_key(&scope),
            "aurora.voice.model-scope.v1:stt:primary.slot"
        );
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
    fn pack_task_and_scope_serde_names_are_stable_and_validated() -> Result<(), ModelPackError> {
        let tasks = [
            (PackTask::Kws, "\"kws\""),
            (PackTask::Wakeword, "\"wakeword\""),
            (PackTask::Vad, "\"vad\""),
            (PackTask::Stt, "\"stt\""),
            (PackTask::Tts, "\"tts\""),
            (PackTask::VoiceEmbedding, "\"voice_embedding\""),
            (PackTask::Tokenizer, "\"tokenizer\""),
            (PackTask::Frontend, "\"frontend\""),
            (PackTask::VoiceState, "\"voice_state\""),
        ];
        for (task, expected) in tasks {
            assert_eq!(
                serde_json::to_string(&task).expect("task serializes"),
                expected
            );
            assert_eq!(
                serde_json::from_str::<PackTask>(expected).expect("task deserializes"),
                task
            );
        }
        assert_eq!(
            serde_json::from_str::<PackTask>("\"kws\"").expect("kws alias"),
            PackTask::Kws
        );
        assert_eq!(
            serde_json::from_str::<PackTask>("\"wakeword\"").expect("wakeword compat"),
            PackTask::Wakeword
        );

        let scope = ModelStoreScope::new(PackTask::Tts, "read-aloud")?;
        let encoded = serde_json::to_string(&scope).expect("scope serializes");
        assert_eq!(encoded, "{\"task\":\"tts\",\"slot_id\":\"read-aloud\"}");
        let decoded: ModelStoreScope = serde_json::from_str(&encoded).expect("scope deserializes");
        assert_eq!(decoded.task(), PackTask::Tts);
        assert_eq!(decoded.slot_id(), "read-aloud");
        assert!(serde_json::from_str::<ModelStoreScope>(
            "{\"task\":\"tts\",\"slot_id\":\"bad/token\"}"
        )
        .is_err());
        assert!(ModelStoreScope::new(PackTask::Tts, "").is_err());
        Ok(())
    }

    #[test]
    fn download_task_debug_redacts_manifest_url_and_tokens() {
        let task = DownloadTask {
            storage_key: "storage".to_owned(),
            pack_id: "pack".to_owned(),
            pack_version: "1".to_owned(),
            file_id: "model".to_owned(),
            url: "https://models.example.test/model.onnx?token=secret-token".to_owned(),
            expected_sha256: HASH.to_owned(),
            expected_bytes: 42,
            variant_id: "linux".to_owned(),
        };
        let rendered = format!("{task:?}");
        assert!(rendered.contains("DownloadTask"));
        assert!(rendered.contains("pack"));
        assert!(rendered.contains(HASH));
        assert!(!rendered.contains("https://"));
        assert!(!rendered.contains("models.example"));
        assert!(!rendered.contains("secret-token"));
        assert!(!rendered.contains("token="));
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
