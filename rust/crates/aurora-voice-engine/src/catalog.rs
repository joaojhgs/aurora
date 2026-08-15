//! Metadata-only speech catalog shared by native and browser runtimes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::OnceLock;
use thiserror::Error;

use crate::{canonical_json, sha256_hex, TTS_MAX_SAMPLE_RATE_HZ, TTS_MIN_SAMPLE_RATE_HZ};

const EMBEDDED_SHERPA_TTS_CATALOG: &str = include_str!("../resources/sherpa_onnx_tts_catalog.json");
const EMBEDDED_AURORA_POCKETTTS_OVERLAY: &str =
    include_str!("../../../../tools/voice-runtime/pockettts-packs/aurora_pockettts_language_pack_catalog.json");
const CATALOG_SCHEMA_VERSION: u32 = 1;
const CATALOG_ID: &str = "sherpa-onnx-tts-models-v1";
const CATALOG_REVISION: &str = "github-release-130612623-30d65b392bba8dfb";
const SOURCE_REPOSITORY: &str = "k2-fsa/sherpa-onnx";
const SOURCE_RELEASE_ID: u64 = 130_612_623;
const SOURCE_RELEASE_TAG: &str = "tts-models";
const SOURCE_CHECKSUM_ASSET_ID: u64 = 424_712_825;
const SOURCE_CHECKSUM_SHA256: &str =
    "30d65b392bba8dfbdbc3479928d3f80adff2c71d4f518ce893d572b8aff021ee";
const ENTRIES_SHA256: &str = "64ed347bb69deb695ea50d363bdcad99779a2ffa0ecfea790af368056504e4fa";
const EXPECTED_ENTRY_COUNT: usize = 537;
const EXPECTED_LANGUAGE_COUNT: usize = 50;
const MAX_CATALOG_BYTES: usize = 1_500_000;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const DOWNLOAD_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";
const OVERLAY_CATALOG_ID: &str = "aurora-sherpa-pockettts-language-packs-v1";
const OVERLAY_DOWNLOAD_BASE: &str =
    "https://github.com/joaojhgs/aurora/releases/download/sherpa-pockettts-language-packs/";

static CATALOG: OnceLock<Result<TtsVoiceCatalog, TtsCatalogError>> = OnceLock::new();
static RUNTIME_CATALOG: OnceLock<Result<TtsVoiceCatalog, TtsCatalogError>> = OnceLock::new();

/// A pinned metadata-only catalog of user-selectable TTS voices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsVoiceCatalog {
    pub schema_version: u32,
    pub catalog_id: String,
    pub revision: String,
    pub source: TtsCatalogSource,
    pub entries_sha256: String,
    pub languages: Vec<String>,
    pub entries: Vec<TtsCatalogEntry>,
}

impl TtsVoiceCatalog {
    /// Return the catalog compiled into every Aurora speech runtime.
    pub fn embedded() -> Result<&'static Self, TtsCatalogError> {
        match CATALOG.get_or_init(|| Self::from_json(EMBEDDED_SHERPA_TTS_CATALOG)) {
            Ok(catalog) => Ok(catalog),
            Err(error) => Err(error.clone()),
        }
    }

    /// Embedded Piper/official PocketTTS catalog plus Aurora language-pack overlay.
    ///
    /// Overlay archives are a temporary bootstrap until stable GitHub release
    /// URLs replace the convert job. The embedded 537-entry pin is unchanged.
    pub fn runtime() -> Result<&'static Self, TtsCatalogError> {
        match RUNTIME_CATALOG.get_or_init(Self::merged_with_aurora_pockettts_overlay) {
            Ok(catalog) => Ok(catalog),
            Err(error) => Err(error.clone()),
        }
    }

    fn merged_with_aurora_pockettts_overlay() -> Result<Self, TtsCatalogError> {
        let embedded = Self::from_json(EMBEDDED_SHERPA_TTS_CATALOG)?;
        let overlay = parse_aurora_pockettts_overlay(EMBEDDED_AURORA_POCKETTTS_OVERLAY)?;
        let mut entries = embedded.entries;
        let mut voice_ids: BTreeSet<String> =
            entries.iter().map(|entry| entry.voice_id.clone()).collect();
        for entry in overlay {
            if !voice_ids.insert(entry.voice_id.clone()) {
                return Err(TtsCatalogError::Invalid);
            }
            entries.push(entry);
        }
        entries.sort_by(|left, right| left.voice_id.cmp(&right.voice_id));
        Ok(Self {
            entries,
            ..embedded
        })
    }

    /// Parse and authenticate a catalog representation against compiled pins.
    pub fn from_json(payload: &str) -> Result<Self, TtsCatalogError> {
        if payload.len() > MAX_CATALOG_BYTES {
            return Err(TtsCatalogError::ResourceLimit);
        }
        let value: Value = serde_json::from_str(payload).map_err(|_| TtsCatalogError::Invalid)?;
        let entries = value.get("entries").ok_or(TtsCatalogError::Invalid)?;
        let entries_json = canonical_json(entries).map_err(|_| TtsCatalogError::Invalid)?;
        if sha256_hex(entries_json.as_bytes()) != ENTRIES_SHA256 {
            return Err(TtsCatalogError::Trust);
        }
        let catalog: Self = serde_json::from_value(value).map_err(|_| TtsCatalogError::Invalid)?;
        catalog.validate()?;
        Ok(catalog)
    }

    /// Find one exact user-selected voice without expanding the selection.
    pub fn voice(&self, voice_id: &str) -> Option<&TtsCatalogEntry> {
        self.entries
            .binary_search_by(|entry| entry.voice_id.as_str().cmp(voice_id))
            .ok()
            .and_then(|index| self.entries.get(index))
    }

    pub fn catalog_id(&self) -> &str {
        &self.catalog_id
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    /// List voices that explicitly advertise the requested normalized language.
    pub fn voices_for_language(&self, language: &str) -> Vec<&TtsCatalogEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.language == language)
            .collect()
    }

    fn validate(&self) -> Result<(), TtsCatalogError> {
        if self.schema_version != CATALOG_SCHEMA_VERSION
            || self.catalog_id != CATALOG_ID
            || self.revision != CATALOG_REVISION
            || self.entries_sha256 != ENTRIES_SHA256
            || self.source.repository != SOURCE_REPOSITORY
            || self.source.release_id != SOURCE_RELEASE_ID
            || self.source.tag != SOURCE_RELEASE_TAG
            || self.source.checksum_asset_id != SOURCE_CHECKSUM_ASSET_ID
            || self.source.checksum_sha256 != SOURCE_CHECKSUM_SHA256
        {
            return Err(TtsCatalogError::Trust);
        }
        if self.entries.len() != EXPECTED_ENTRY_COUNT
            || self.languages.len() != EXPECTED_LANGUAGE_COUNT
        {
            return Err(TtsCatalogError::Invalid);
        }
        let language_set: BTreeSet<&str> = self.languages.iter().map(String::as_str).collect();
        if language_set.len() != self.languages.len()
            || self.languages.windows(2).any(|pair| pair[0] >= pair[1])
            || language_set
                .iter()
                .any(|language| !valid_language(language))
        {
            return Err(TtsCatalogError::Invalid);
        }
        let mut voice_ids = BTreeSet::new();
        let mut filenames = BTreeSet::new();
        for (index, entry) in self.entries.iter().enumerate() {
            entry.validate()?;
            if !language_set.contains(entry.language.as_str())
                || !voice_ids.insert(entry.voice_id.as_str())
                || !filenames.insert(entry.archive.filename.as_str())
                || index > 0 && self.entries[index - 1].voice_id >= entry.voice_id
            {
                return Err(TtsCatalogError::Invalid);
            }
        }
        let entry_languages: BTreeSet<&str> = self
            .entries
            .iter()
            .map(|entry| entry.language.as_str())
            .collect();
        if entry_languages != language_set {
            return Err(TtsCatalogError::Invalid);
        }
        Ok(())
    }
}

/// Pinned upstream release identity used to produce the metadata catalog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogSource {
    pub repository: String,
    pub release_id: u64,
    pub tag: String,
    pub published_at: String,
    pub checksum_asset_id: u64,
    pub checksum_asset_updated_at: String,
    pub checksum_sha256: String,
}

/// One installable voice. It contains metadata and bindings, never model bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogEntry {
    pub voice_id: String,
    pub display_name: String,
    pub language: String,
    pub quality: Option<String>,
    pub precision: Option<String>,
    #[serde(default)]
    pub sample_rate_hz: Option<u32>,
    pub engine: String,
    pub model_family: String,
    pub archive: TtsCatalogArchive,
    pub bindings: TtsCatalogBindings,
    #[serde(default)]
    pub reference_samples: Vec<TtsCatalogReferenceSample>,
    pub terms: TtsCatalogTerms,
}

impl TtsCatalogEntry {
    fn validate(&self) -> Result<(), TtsCatalogError> {
        let (voice_prefix, voice_slug) =
            if let Some(slug) = self.voice_id.strip_prefix("standard:piper:") {
                ("standard:piper:", slug)
            } else if let Some(slug) = self.voice_id.strip_prefix("standard:pockettts:") {
                ("standard:pockettts:", slug)
            } else {
                return Err(TtsCatalogError::Invalid);
            };
        if voice_slug.is_empty()
            || voice_slug.len() > 64
            || !voice_slug.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
            })
            || self.display_name.trim().is_empty()
            || self.display_name.len() > 128
            || !valid_language(&self.language)
            || self.engine != "sherpa_onnx"
            || !matches!(self.model_family.as_str(), "vits_piper" | "pockettts")
            || !matches!(
                self.quality.as_deref(),
                None | Some("x_low" | "low" | "medium" | "high")
            )
            || !matches!(
                self.precision.as_deref(),
                None | Some("fp16" | "fp32" | "int8")
            )
            || !valid_tts_sample_rate(self.model_family.as_str(), self.sample_rate_hz)
        {
            return Err(TtsCatalogError::Invalid);
        }
        let archive_model_stem =
            self.archive
                .validate(&self.model_family, voice_prefix, voice_slug)?;
        let model_stem = match (self.model_family.as_str(), self.precision.as_deref()) {
            ("vits_piper", Some("fp16")) => archive_model_stem.strip_suffix("-fp16"),
            ("vits_piper", Some("fp32")) => archive_model_stem.strip_suffix("-fp32"),
            ("vits_piper", Some("int8")) => archive_model_stem.strip_suffix("-int8"),
            ("vits_piper", None)
                if !["-fp16", "-fp32", "-int8"]
                    .iter()
                    .any(|suffix| archive_model_stem.ends_with(suffix)) =>
            {
                Some(archive_model_stem)
            }
            ("pockettts", _) => Some(archive_model_stem),
            _ => None,
        }
        .filter(|stem| !stem.is_empty())
        .ok_or(TtsCatalogError::Invalid)?;
        self.bindings
            .validate(&self.model_family, &self.archive.root, model_stem)?;
        validate_reference_samples(
            &self.model_family,
            &self.archive.root,
            &self.reference_samples,
        )?;
        if !matches!(
            self.terms.source.as_str(),
            "upstream_model_card" | "upstream_model_card_restricted_non_commercial"
        ) || self.terms.redistributed_by_aurora
            || !self.terms.download_initiated_by_user
        {
            return Err(TtsCatalogError::Invalid);
        }
        Ok(())
    }

    fn validate_aurora_pockettts_overlay(&self) -> Result<(), TtsCatalogError> {
        let Some(voice_slug) = self.voice_id.strip_prefix("standard:pockettts:") else {
            return Err(TtsCatalogError::Invalid);
        };
        if voice_slug.is_empty()
            || self.engine != "sherpa_onnx"
            || self.model_family != "pockettts"
            || self.language != "en-us" && self.language != "fr-fr"
            || !valid_tts_sample_rate(self.model_family.as_str(), self.sample_rate_hz)
        {
            return Err(TtsCatalogError::Invalid);
        }
        let expected_filename = format!("{}.tar.bz2", self.archive.root);
        if self.archive.asset_id == 0
            || self.archive.filename != expected_filename
            || self.archive.url != format!("{OVERLAY_DOWNLOAD_BASE}{expected_filename}")
            || self.archive.byte_size == 0
            || self.archive.byte_size > MAX_ARCHIVE_BYTES
            || !valid_sha256(&self.archive.sha256)
            || self.archive.format != "tar_bzip2"
            || self.archive.root != voice_slug
            || !safe_path_segment(&self.archive.root)
        {
            return Err(TtsCatalogError::Invalid);
        }
        self.bindings
            .validate(&self.model_family, &self.archive.root, &self.archive.root)?;
        if self.terms.source != "upstream_model_card_restricted_non_commercial"
            || !self.terms.redistributed_by_aurora
            || !self.terms.download_initiated_by_user
        {
            return Err(TtsCatalogError::Invalid);
        }
        Ok(())
    }
}

fn valid_tts_sample_rate(model_family: &str, sample_rate_hz: Option<u32>) -> bool {
    match (model_family, sample_rate_hz) {
        ("vits_piper", None) => true,
        ("pockettts", Some(sample_rate_hz)) => {
            (TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz)
        }
        _ => false,
    }
}

/// Integrity and source metadata for one selected archive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogArchive {
    pub asset_id: u64,
    pub filename: String,
    pub url: String,
    pub byte_size: u64,
    pub sha256: String,
    pub format: String,
    pub root: String,
    pub updated_at: String,
}

impl TtsCatalogArchive {
    fn validate<'a>(
        &'a self,
        model_family: &str,
        voice_prefix: &str,
        voice_slug: &str,
    ) -> Result<&'a str, TtsCatalogError> {
        let (expected_voice_prefix, model_stem) = match model_family {
            "vits_piper" => {
                let Some(model_stem) = self.root.strip_prefix("vits-piper-") else {
                    return Err(TtsCatalogError::Invalid);
                };
                ("standard:piper:", model_stem)
            }
            "pockettts" => ("standard:pockettts:", self.root.as_str()),
            _ => return Err(TtsCatalogError::Invalid),
        };
        let expected_filename = format!("{}.tar.bz2", self.root);
        if self.asset_id == 0
            || self.filename != expected_filename
            || self.url != format!("{DOWNLOAD_BASE}{expected_filename}")
            || self.byte_size == 0
            || self.byte_size > MAX_ARCHIVE_BYTES
            || !valid_sha256(&self.sha256)
            || self.format != "tar_bzip2"
            || self.updated_at.is_empty()
            || voice_prefix != expected_voice_prefix
            || model_stem.to_ascii_lowercase() != voice_slug
            || !safe_path_segment(&self.root)
        {
            return Err(TtsCatalogError::Invalid);
        }
        Ok(model_stem)
    }
}

/// Relative files expected after bounded extraction of one selected archive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogBindings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lm_flow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lm_main: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_conditioner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocab_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_scores_json: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub config: String,
    #[serde(default)]
    pub tokens: String,
    #[serde(default)]
    pub data_dir: String,
    #[serde(default)]
    pub model_card: String,
}

impl TtsCatalogBindings {
    fn validate(
        &self,
        model_family: &str,
        root: &str,
        model_stem: &str,
    ) -> Result<(), TtsCatalogError> {
        let expected_prefix = format!("{root}/");
        match model_family {
            "vits_piper" => {
                let expected_model = format!("{expected_prefix}{model_stem}.onnx");
                if self.model != expected_model
                    || self.config != format!("{expected_model}.json")
                    || self.tokens != format!("{expected_prefix}tokens.txt")
                    || self.data_dir != format!("{expected_prefix}espeak-ng-data")
                    || self.model_card != format!("{expected_prefix}MODEL_CARD")
                    || self.lm_flow.is_some()
                    || self.lm_main.is_some()
                    || self.encoder.is_some()
                    || self.decoder.is_some()
                    || self.text_conditioner.is_some()
                    || self.vocab_json.is_some()
                    || self.token_scores_json.is_some()
                    || [
                        &self.model,
                        &self.config,
                        &self.tokens,
                        &self.data_dir,
                        &self.model_card,
                    ]
                    .iter()
                    .any(|path| !safe_relative_path(path) || !path.starts_with(&expected_prefix))
                {
                    return Err(TtsCatalogError::Invalid);
                }
            }
            "pockettts" => {
                let required = [
                    (
                        self.lm_flow.as_deref(),
                        format!("{expected_prefix}lm_flow.int8.onnx"),
                    ),
                    (
                        self.lm_main.as_deref(),
                        format!("{expected_prefix}lm_main.int8.onnx"),
                    ),
                    (
                        self.encoder.as_deref(),
                        format!("{expected_prefix}encoder.onnx"),
                    ),
                    (
                        self.decoder.as_deref(),
                        format!("{expected_prefix}decoder.int8.onnx"),
                    ),
                    (
                        self.text_conditioner.as_deref(),
                        format!("{expected_prefix}text_conditioner.onnx"),
                    ),
                    (
                        self.vocab_json.as_deref(),
                        format!("{expected_prefix}vocab.json"),
                    ),
                    (
                        self.token_scores_json.as_deref(),
                        format!("{expected_prefix}token_scores.json"),
                    ),
                    (
                        Some(self.model_card.as_str()),
                        format!("{expected_prefix}README.md"),
                    ),
                ];
                if !self.model.is_empty()
                    || !self.config.is_empty()
                    || !self.tokens.is_empty()
                    || !self.data_dir.is_empty()
                    || required.iter().any(|(actual, expected)| {
                        actual != &Some(expected.as_str())
                            || !actual.is_some_and(|path| {
                                safe_relative_path(path) && path.starts_with(&expected_prefix)
                            })
                    })
                {
                    return Err(TtsCatalogError::Invalid);
                }
            }
            _ => return Err(TtsCatalogError::Invalid),
        }
        Ok(())
    }
}

/// Deterministic metadata for reference audio shipped in an upstream archive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogReferenceSample {
    pub sample_id: String,
    pub display_name: String,
    pub path: String,
    pub byte_size: u64,
    pub sha256: String,
}

/// Product distribution boundary for upstream-hosted voice data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogTerms {
    pub source: String,
    pub redistributed_by_aurora: bool,
    pub download_initiated_by_user: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuroraPocketTtsOverlayCatalog {
    schema_version: u32,
    catalog_id: String,
    revision: String,
    temporary_bootstrap: bool,
    removal_point: String,
    download_base: String,
    entries: Vec<TtsCatalogEntry>,
}

fn parse_aurora_pockettts_overlay(payload: &str) -> Result<Vec<TtsCatalogEntry>, TtsCatalogError> {
    if payload.len() > MAX_CATALOG_BYTES {
        return Err(TtsCatalogError::ResourceLimit);
    }
    let overlay: AuroraPocketTtsOverlayCatalog =
        serde_json::from_str(payload).map_err(|_| TtsCatalogError::Invalid)?;
    if overlay.schema_version != CATALOG_SCHEMA_VERSION
        || overlay.catalog_id != OVERLAY_CATALOG_ID
        || overlay.download_base != OVERLAY_DOWNLOAD_BASE
        || !overlay.temporary_bootstrap
        || overlay.revision.is_empty()
        || !overlay.removal_point.contains("stable archive URLs")
        || overlay.entries.len() != 2
    {
        return Err(TtsCatalogError::Invalid);
    }
    let mut voice_ids = BTreeSet::new();
    for entry in &overlay.entries {
        entry.validate_aurora_pockettts_overlay()?;
        if !voice_ids.insert(entry.voice_id.as_str()) {
            return Err(TtsCatalogError::Invalid);
        }
    }
    if !voice_ids.contains("standard:pockettts:aurora-pockettts-en-2026-04")
        || !voice_ids.contains("standard:pockettts:aurora-pockettts-fr-24l")
    {
        return Err(TtsCatalogError::Invalid);
    }
    Ok(overlay.entries)
}

fn validate_reference_samples(
    model_family: &str,
    root: &str,
    samples: &[TtsCatalogReferenceSample],
) -> Result<(), TtsCatalogError> {
    let _ = (model_family, root);
    if samples.is_empty() {
        Ok(())
    } else {
        Err(TtsCatalogError::Invalid)
    }
}

/// Sanitized catalog failures; URLs and paths are intentionally omitted.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TtsCatalogError {
    #[error("voice catalog is invalid")]
    Invalid,
    #[error("voice catalog trust check failed")]
    Trust,
    #[error("voice catalog exceeds the resource limit")]
    ResourceLimit,
}

fn valid_language(value: &str) -> bool {
    let mut segments = value.split('-');
    let Some(primary) = segments.next() else {
        return false;
    };
    (2..=8).contains(&primary.len())
        && primary.bytes().all(|byte| byte.is_ascii_lowercase())
        && segments.all(|segment| {
            (1..=8).contains(&segment.len())
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && !value.contains('\\')
        && value.split('/').all(|segment| {
            !segment.is_empty() && segment != "." && segment != ".." && safe_path_segment(segment)
        })
}

fn safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_pinned_metadata_only() {
        let catalog = TtsVoiceCatalog::embedded().expect("embedded catalog validates");
        assert_eq!(catalog.entries.len(), EXPECTED_ENTRY_COUNT);
        assert_eq!(catalog.languages.len(), EXPECTED_LANGUAGE_COUNT);
        assert_eq!(
            catalog
                .entries
                .iter()
                .map(|entry| entry.archive.byte_size)
                .sum::<u64>(),
            23_121_958_873
        );
        assert!(catalog.entries.iter().all(|entry| {
            entry.terms.download_initiated_by_user && !entry.terms.redistributed_by_aurora
        }));
    }

    #[test]
    fn exact_voice_selection_never_expands_to_a_language() {
        let catalog = TtsVoiceCatalog::embedded().expect("embedded catalog validates");
        let voice = catalog
            .voice("standard:piper:en_us-ljspeech-medium")
            .expect("known voice exists");
        assert_eq!(voice.language, "en-us");
        assert_eq!(voice.archive.byte_size, 67_169_893);
        assert_eq!(
            voice.archive.sha256,
            "3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba"
        );
        assert!(catalog.voices_for_language("en-us").len() > 1);
    }

    #[test]
    fn quantized_piper_archives_bind_the_unsuffixed_upstream_model_files() {
        let catalog = TtsVoiceCatalog::embedded().expect("embedded catalog validates");
        let voice = catalog
            .voice("standard:piper:en_gb-cori-medium-int8")
            .expect("known quantized voice exists");

        assert_eq!(
            voice.bindings.model,
            "vits-piper-en_GB-cori-medium-int8/en_GB-cori-medium.onnx"
        );
        assert_eq!(
            voice.bindings.config,
            "vits-piper-en_GB-cori-medium-int8/en_GB-cori-medium.onnx.json"
        );
    }

    #[test]
    fn catalog_tampering_fails_before_deserialization() {
        let tampered = EMBEDDED_SHERPA_TTS_CATALOG.replacen(
            "standard:piper:en_us-ljspeech-medium",
            "standard:piper:en_us-ljspeech-meddium",
            1,
        );
        assert_eq!(
            TtsVoiceCatalog::from_json(&tampered),
            Err(TtsCatalogError::Trust)
        );
    }

    #[test]
    fn unsafe_binding_path_is_rejected() {
        assert!(!safe_relative_path("../model.onnx"));
        assert!(!safe_relative_path("root/../../model.onnx"));
        assert!(!safe_relative_path("C:\\model.onnx"));
        assert!(safe_relative_path("root/model.onnx"));
    }

    #[test]
    fn aurora_pockettts_overlay_extends_runtime_catalog_only() {
        let embedded = TtsVoiceCatalog::embedded().expect("embedded catalog validates");
        let runtime = TtsVoiceCatalog::runtime().expect("runtime catalog validates");
        assert_eq!(embedded.entries.len(), EXPECTED_ENTRY_COUNT);
        assert_eq!(runtime.entries.len(), EXPECTED_ENTRY_COUNT + 2);
        assert_eq!(runtime.entries_sha256, ENTRIES_SHA256);
        let english = runtime
            .voice("standard:pockettts:aurora-pockettts-en-2026-04")
            .expect("english overlay");
        let french = runtime
            .voice("standard:pockettts:aurora-pockettts-fr-24l")
            .expect("french overlay");
        assert_eq!(english.language, "en-us");
        assert_eq!(french.language, "fr-fr");
        assert!(english.terms.redistributed_by_aurora);
        assert!(english.archive.url.starts_with(OVERLAY_DOWNLOAD_BASE));
        assert!(embedded
            .voice("standard:pockettts:aurora-pockettts-en-2026-04")
            .is_none());
    }
}
