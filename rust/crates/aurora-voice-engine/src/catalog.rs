//! Metadata-only speech catalog shared by native and browser runtimes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::OnceLock;
use thiserror::Error;

use crate::{canonical_json, sha256_hex};

const EMBEDDED_SHERPA_TTS_CATALOG: &str = include_str!("../resources/sherpa_onnx_tts_catalog.json");
const CATALOG_SCHEMA_VERSION: u32 = 1;
const CATALOG_ID: &str = "sherpa-onnx-tts-models-v1";
const CATALOG_REVISION: &str = "github-release-130612623-30d65b392bba8dfb";
const SOURCE_REPOSITORY: &str = "k2-fsa/sherpa-onnx";
const SOURCE_RELEASE_ID: u64 = 130_612_623;
const SOURCE_RELEASE_TAG: &str = "tts-models";
const SOURCE_CHECKSUM_ASSET_ID: u64 = 424_712_825;
const SOURCE_CHECKSUM_SHA256: &str =
    "30d65b392bba8dfbdbc3479928d3f80adff2c71d4f518ce893d572b8aff021ee";
const ENTRIES_SHA256: &str = "74dd6a6413828c8cbdc26dcd62289214a3c56f12c166b7d1f1d60632c2967f28";
const EXPECTED_ENTRY_COUNT: usize = 536;
const EXPECTED_LANGUAGE_COUNT: usize = 50;
const MAX_CATALOG_BYTES: usize = 1_500_000;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const DOWNLOAD_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";

static CATALOG: OnceLock<Result<TtsVoiceCatalog, TtsCatalogError>> = OnceLock::new();

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
    pub engine: String,
    pub model_family: String,
    pub archive: TtsCatalogArchive,
    pub bindings: TtsCatalogBindings,
    pub terms: TtsCatalogTerms,
}

impl TtsCatalogEntry {
    fn validate(&self) -> Result<(), TtsCatalogError> {
        let Some(voice_slug) = self.voice_id.strip_prefix("standard:piper:") else {
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
            || self.model_family != "vits_piper"
            || !matches!(
                self.quality.as_deref(),
                None | Some("x_low" | "low" | "medium" | "high")
            )
            || !matches!(
                self.precision.as_deref(),
                None | Some("fp16" | "fp32" | "int8")
            )
        {
            return Err(TtsCatalogError::Invalid);
        }
        let model_stem = self.archive.validate(voice_slug)?;
        self.bindings.validate(&self.archive.root, model_stem)?;
        if self.terms.source != "upstream_model_card"
            || self.terms.redistributed_by_aurora
            || !self.terms.download_initiated_by_user
        {
            return Err(TtsCatalogError::Invalid);
        }
        Ok(())
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
    fn validate<'a>(&'a self, voice_slug: &str) -> Result<&'a str, TtsCatalogError> {
        let Some(model_stem) = self.root.strip_prefix("vits-piper-") else {
            return Err(TtsCatalogError::Invalid);
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
    pub model: String,
    pub config: String,
    pub tokens: String,
    pub data_dir: String,
    pub model_card: String,
}

impl TtsCatalogBindings {
    fn validate(&self, root: &str, model_stem: &str) -> Result<(), TtsCatalogError> {
        let expected_prefix = format!("{root}/");
        let expected_model = format!("{expected_prefix}{model_stem}.onnx");
        if self.model != expected_model
            || self.config != format!("{expected_model}.json")
            || self.tokens != format!("{expected_prefix}tokens.txt")
            || self.data_dir != format!("{expected_prefix}espeak-ng-data")
            || self.model_card != format!("{expected_prefix}MODEL_CARD")
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
        Ok(())
    }
}

/// Product distribution boundary for upstream-hosted voice data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TtsCatalogTerms {
    pub source: String,
    pub redistributed_by_aurora: bool,
    pub download_initiated_by_user: bool,
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
            23_023_622_353
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
}
