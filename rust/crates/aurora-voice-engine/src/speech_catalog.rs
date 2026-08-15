//! Authenticated metadata for user-selected STT, VAD, and KWS downloads.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use thiserror::Error;

use crate::{canonical_json, sha256_hex};

const EMBEDDED_CATALOG: &str = include_str!("../resources/sherpa_onnx_speech_catalog.json");
const CATALOG_SCHEMA_VERSION: u32 = 1;
const CATALOG_ID: &str = "sherpa-onnx-speech-models-v1";
const CATALOG_REVISION: &str = "github-releases-130628817-145831594-4e34edcb-284637b2";
const ENTRIES_SHA256: &str = "7aaf44b88a5f3f039ed1b90c30fe4de0f257d2cc02940fa3f1ecef881c347149";
const EXPECTED_ENTRY_COUNT: usize = 21;
const EXPECTED_LANGUAGE_COUNT: usize = 100;
const MAX_CATALOG_BYTES: usize = 250_000;
const MAX_ARCHIVE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_DIRECT_MODEL_BYTES: u64 = 16 * 1024 * 1024;
const SHERPA_REPOSITORY: &str = "k2-fsa/sherpa-onnx";
const ASR_RELEASE_ID: u64 = 130_628_817;
const ASR_CHECKSUM_ASSET_ID: u64 = 424_735_889;
const ASR_CHECKSUM_SHA256: &str =
    "4e34edcb64434bcf533afaee9dcc14b5b2f9c277ed3a745f263e79a4464b28d0";
const KWS_RELEASE_ID: u64 = 145_831_594;
const KWS_CHECKSUM_ASSET_ID: u64 = 424_703_304;
const KWS_CHECKSUM_SHA256: &str =
    "284637b2b9fec1287aca10315dcc960710c6ec14224fb1dfa9fe427e77eb6c18";
const WHISPER_REPOSITORY: &str = "openai/whisper";
const WHISPER_COMMIT: &str = "5f86d1d86363843179951550570367b37c5d6f78";
const WHISPER_LANGUAGE_PATH: &str = "whisper/tokenizer.py";
const WHISPER_LANGUAGE_SHA256: &str =
    "3b48e361a7e95b4ec0356ca6d72bba635778aa10269153136ee7bc34cae30b85";

static CATALOG: OnceLock<Result<SpeechModelCatalog, SpeechCatalogError>> = OnceLock::new();

/// One task family represented in the installable speech catalog.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechCatalogTask {
    SpeechToText,
    VoiceActivityDetection,
    KeywordSpotting,
}

impl SpeechCatalogTask {
    fn id_prefix(self) -> &'static str {
        match self {
            Self::SpeechToText => "stt:",
            Self::VoiceActivityDetection => "vad:",
            Self::KeywordSpotting => "kws:",
        }
    }

    fn release_tag(self) -> &'static str {
        match self {
            Self::KeywordSpotting => "kws-models",
            Self::SpeechToText | Self::VoiceActivityDetection => "asr-models",
        }
    }
}

/// Pinned, metadata-only catalog shared by Aurora speech runtimes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechModelCatalog {
    pub schema_version: u32,
    pub catalog_id: String,
    pub revision: String,
    pub sources: SpeechCatalogSources,
    pub entries_sha256: String,
    pub languages: Vec<String>,
    pub entries: Vec<SpeechCatalogEntry>,
}

impl SpeechModelCatalog {
    /// Return the catalog compiled into the runtime after authenticating its pins.
    pub fn embedded() -> Result<&'static Self, SpeechCatalogError> {
        match CATALOG.get_or_init(|| Self::from_json(EMBEDDED_CATALOG)) {
            Ok(catalog) => Ok(catalog),
            Err(error) => Err(error.clone()),
        }
    }

    /// Parse and validate catalog JSON against compiled upstream identities.
    pub fn from_json(payload: &str) -> Result<Self, SpeechCatalogError> {
        if payload.len() > MAX_CATALOG_BYTES {
            return Err(SpeechCatalogError::ResourceLimit);
        }
        let value: Value =
            serde_json::from_str(payload).map_err(|_| SpeechCatalogError::Invalid)?;
        let entries = value.get("entries").ok_or(SpeechCatalogError::Invalid)?;
        let entries_json = canonical_json(entries).map_err(|_| SpeechCatalogError::Invalid)?;
        if sha256_hex(entries_json.as_bytes()) != ENTRIES_SHA256 {
            return Err(SpeechCatalogError::Trust);
        }
        let catalog: Self =
            serde_json::from_value(value).map_err(|_| SpeechCatalogError::Invalid)?;
        catalog.validate()?;
        Ok(catalog)
    }

    /// Resolve exactly one selected model without expanding it to a language pack.
    pub fn model(&self, model_id: &str) -> Option<&SpeechCatalogEntry> {
        self.entries
            .binary_search_by(|entry| entry.model_id.as_str().cmp(model_id))
            .ok()
            .and_then(|index| self.entries.get(index))
    }

    pub fn catalog_id(&self) -> &str {
        &self.catalog_id
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    /// Return metadata for one task; this does not install any listed model.
    pub fn models_for_task(&self, task: SpeechCatalogTask) -> Vec<&SpeechCatalogEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.task == task)
            .collect()
    }

    fn validate(&self) -> Result<(), SpeechCatalogError> {
        if self.schema_version != CATALOG_SCHEMA_VERSION
            || self.catalog_id != CATALOG_ID
            || self.revision != CATALOG_REVISION
            || self.entries_sha256 != ENTRIES_SHA256
        {
            return Err(SpeechCatalogError::Trust);
        }
        self.sources.validate()?;
        if self.entries.len() != EXPECTED_ENTRY_COUNT
            || self.languages.len() != EXPECTED_LANGUAGE_COUNT
        {
            return Err(SpeechCatalogError::Invalid);
        }
        let languages: BTreeSet<&str> = self.languages.iter().map(String::as_str).collect();
        if languages.len() != self.languages.len()
            || self.languages.windows(2).any(|pair| pair[0] >= pair[1])
            || languages.iter().any(|language| !valid_language(language))
        {
            return Err(SpeechCatalogError::Invalid);
        }
        let mut model_ids = BTreeSet::new();
        let mut filenames = BTreeSet::new();
        for (index, entry) in self.entries.iter().enumerate() {
            entry.validate(&languages)?;
            if !model_ids.insert(entry.model_id.as_str())
                || !filenames.insert(entry.archive.filename.as_str())
                || index > 0 && self.entries[index - 1].model_id >= entry.model_id
            {
                return Err(SpeechCatalogError::Invalid);
            }
        }
        let counts = [
            (SpeechCatalogTask::SpeechToText, 12),
            (SpeechCatalogTask::VoiceActivityDetection, 4),
            (SpeechCatalogTask::KeywordSpotting, 5),
        ];
        if counts.iter().any(|(task, expected)| {
            self.entries
                .iter()
                .filter(|entry| entry.task == *task)
                .count()
                != *expected
        }) {
            return Err(SpeechCatalogError::Invalid);
        }
        Ok(())
    }
}

/// Pinned upstream release and language-table identities.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechCatalogSources {
    pub asr: SpeechReleaseSource,
    pub kws: SpeechReleaseSource,
    pub whisper_languages: WhisperLanguageSource,
}

impl SpeechCatalogSources {
    fn validate(&self) -> Result<(), SpeechCatalogError> {
        self.asr.validate(
            "asr-models",
            ASR_RELEASE_ID,
            ASR_CHECKSUM_ASSET_ID,
            ASR_CHECKSUM_SHA256,
        )?;
        self.kws.validate(
            "kws-models",
            KWS_RELEASE_ID,
            KWS_CHECKSUM_ASSET_ID,
            KWS_CHECKSUM_SHA256,
        )?;
        if self.whisper_languages.repository != WHISPER_REPOSITORY
            || self.whisper_languages.commit != WHISPER_COMMIT
            || self.whisper_languages.path != WHISPER_LANGUAGE_PATH
            || self.whisper_languages.sha256 != WHISPER_LANGUAGE_SHA256
        {
            return Err(SpeechCatalogError::Trust);
        }
        Ok(())
    }
}

/// One authenticated sherpa-onnx model release.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechReleaseSource {
    pub repository: String,
    pub release_id: u64,
    pub tag: String,
    pub published_at: String,
    pub checksum_asset_id: u64,
    pub checksum_asset_updated_at: String,
    pub checksum_sha256: String,
}

impl SpeechReleaseSource {
    fn validate(
        &self,
        tag: &str,
        release_id: u64,
        checksum_asset_id: u64,
        checksum_sha256: &str,
    ) -> Result<(), SpeechCatalogError> {
        if self.repository != SHERPA_REPOSITORY
            || self.release_id != release_id
            || self.tag != tag
            || self.published_at.is_empty()
            || self.checksum_asset_id != checksum_asset_id
            || self.checksum_asset_updated_at.is_empty()
            || self.checksum_sha256 != checksum_sha256
        {
            return Err(SpeechCatalogError::Trust);
        }
        Ok(())
    }
}

/// Pinned OpenAI Whisper language-table source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhisperLanguageSource {
    pub repository: String,
    pub commit: String,
    pub path: String,
    pub sha256: String,
}

/// Metadata and verified relative bindings for one installable model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechCatalogEntry {
    pub model_id: String,
    pub display_name: String,
    pub task: SpeechCatalogTask,
    pub languages: Vec<String>,
    pub language_scope: String,
    pub engine: String,
    pub model_family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_optimized: Option<bool>,
    pub archive: SpeechCatalogArchive,
    pub bindings: BTreeMap<String, String>,
    pub terms: SpeechCatalogTerms,
}

impl SpeechCatalogEntry {
    fn validate(&self, catalog_languages: &BTreeSet<&str>) -> Result<(), SpeechCatalogError> {
        if !self.model_id.starts_with(self.task.id_prefix())
            || !safe_model_id(&self.model_id)
            || self.display_name.trim().is_empty()
            || self.display_name.len() > 128
            || self.engine != "sherpa_onnx"
            || self.languages.windows(2).any(|pair| pair[0] >= pair[1])
            || self
                .languages
                .iter()
                .any(|language| !catalog_languages.contains(language.as_str()))
            || !self.terms.valid()
        {
            return Err(SpeechCatalogError::Invalid);
        }
        let language_set: BTreeSet<&str> = self.languages.iter().map(String::as_str).collect();
        if language_set.len() != self.languages.len() {
            return Err(SpeechCatalogError::Invalid);
        }
        match self.task {
            SpeechCatalogTask::SpeechToText => self.validate_stt(catalog_languages)?,
            SpeechCatalogTask::VoiceActivityDetection => self.validate_vad()?,
            SpeechCatalogTask::KeywordSpotting => self.validate_kws()?,
        }
        self.archive.validate(self.task)?;
        if self.bindings.values().any(|path| !safe_relative_path(path)) {
            return Err(SpeechCatalogError::Invalid);
        }
        Ok(())
    }

    fn validate_stt(&self, catalog_languages: &BTreeSet<&str>) -> Result<(), SpeechCatalogError> {
        let model = self
            .model_id
            .strip_prefix("stt:whisper:")
            .ok_or(SpeechCatalogError::Invalid)?;
        let root = format!("sherpa-onnx-whisper-{model}");
        let expected = BTreeMap::from([
            (
                "decoder".to_owned(),
                format!("{root}/{model}-decoder.int8.onnx"),
            ),
            (
                "encoder".to_owned(),
                format!("{root}/{model}-encoder.int8.onnx"),
            ),
            ("tokens".to_owned(), format!("{root}/{model}-tokens.txt")),
        ]);
        let expected_languages: BTreeSet<&str> = if model.ends_with(".en") {
            BTreeSet::from(["en"])
        } else {
            catalog_languages.clone()
        };
        if self.model_family != "whisper"
            || self.mobile_optimized.is_some()
            || self.archive.root.as_deref() != Some(root.as_str())
            || self.bindings != expected
            || self
                .languages
                .iter()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
                != expected_languages
            || self.language_scope
                != if model.ends_with(".en") {
                    "specific"
                } else {
                    "multilingual"
                }
        {
            return Err(SpeechCatalogError::Invalid);
        }
        Ok(())
    }

    fn validate_vad(&self) -> Result<(), SpeechCatalogError> {
        let filename = self
            .bindings
            .get("model")
            .ok_or(SpeechCatalogError::Invalid)?;
        if self.model_family != "silero_vad"
            || self.language_scope != "language_independent"
            || !self.languages.is_empty()
            || self.mobile_optimized.is_some()
            || self.bindings.len() != 1
            || filename != &self.archive.filename
            || self.archive.root.is_some()
        {
            return Err(SpeechCatalogError::Invalid);
        }
        Ok(())
    }

    fn validate_kws(&self) -> Result<(), SpeechCatalogError> {
        let root = self
            .archive
            .root
            .as_deref()
            .ok_or(SpeechCatalogError::Invalid)?;
        let epoch = if self.model_id == "kws:zipformer:zh-en-2025" {
            13
        } else {
            12
        };
        let stem = format!("epoch-{epoch}-avg-2-chunk-16-left-64");
        let mut expected = BTreeMap::from([
            ("decoder".to_owned(), format!("{root}/decoder-{stem}.onnx")),
            (
                "encoder".to_owned(),
                format!("{root}/encoder-{stem}.int8.onnx"),
            ),
            (
                "joiner".to_owned(),
                format!("{root}/joiner-{stem}.int8.onnx"),
            ),
            ("tokens".to_owned(), format!("{root}/tokens.txt")),
        ]);
        if matches!(
            self.model_id.as_str(),
            "kws:zipformer:gigaspeech" | "kws:zipformer:gigaspeech-mobile"
        ) {
            expected.insert("tokenizer".to_owned(), format!("{root}/bpe.model"));
        }
        if self.model_id == "kws:zipformer:zh-en-2025" {
            expected.insert("lexicon".to_owned(), format!("{root}/en.phone"));
        }
        let expected_languages: BTreeSet<&str> = match self.model_id.as_str() {
            "kws:zipformer:gigaspeech" | "kws:zipformer:gigaspeech-mobile" => {
                BTreeSet::from(["en"])
            }
            "kws:zipformer:wenetspeech" | "kws:zipformer:wenetspeech-mobile" => {
                BTreeSet::from(["zh"])
            }
            "kws:zipformer:zh-en-2025" => BTreeSet::from(["en", "zh"]),
            _ => return Err(SpeechCatalogError::Invalid),
        };
        let expected_mobile = self.model_id.ends_with("-mobile");
        if self.model_family != "zipformer"
            || self.language_scope != "specific"
            || self.mobile_optimized != Some(expected_mobile)
            || self.bindings != expected
            || self
                .languages
                .iter()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
                != expected_languages
        {
            return Err(SpeechCatalogError::Invalid);
        }
        Ok(())
    }
}

/// Integrity and source metadata for one exact model artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechCatalogArchive {
    pub asset_id: u64,
    pub filename: String,
    pub url: String,
    pub byte_size: u64,
    pub sha256: String,
    pub format: String,
    pub root: Option<String>,
    pub updated_at: String,
}

impl SpeechCatalogArchive {
    fn validate(&self, task: SpeechCatalogTask) -> Result<(), SpeechCatalogError> {
        let expected_url = format!(
            "https://github.com/{SHERPA_REPOSITORY}/releases/download/{}/{}",
            task.release_tag(),
            self.filename
        );
        let is_archive = self.format == "tar_bzip2";
        if self.asset_id == 0
            || !safe_path_segment(&self.filename)
            || self.url != expected_url
            || self.byte_size == 0
            || self.byte_size
                > if is_archive {
                    MAX_ARCHIVE_BYTES
                } else {
                    MAX_DIRECT_MODEL_BYTES
                }
            || !valid_sha256(&self.sha256)
            || self.updated_at.is_empty()
        {
            return Err(SpeechCatalogError::Invalid);
        }
        match (is_archive, self.root.as_deref()) {
            (true, Some(root))
                if self.filename == format!("{root}.tar.bz2") && safe_path_segment(root) => {}
            (false, None) if self.format == "file" && self.filename.ends_with(".onnx") => {}
            _ => return Err(SpeechCatalogError::Invalid),
        }
        Ok(())
    }
}

/// Product distribution boundary for upstream-hosted speech data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechCatalogTerms {
    pub source: String,
    pub redistributed_by_aurora: bool,
    pub download_initiated_by_user: bool,
}

impl SpeechCatalogTerms {
    fn valid(&self) -> bool {
        self.source == "upstream_release_checksums"
            && !self.redistributed_by_aurora
            && self.download_initiated_by_user
    }
}

/// Sanitized catalog failures; URLs, model names, and paths are omitted.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SpeechCatalogError {
    #[error("speech catalog is invalid")]
    Invalid,
    #[error("speech catalog trust check failed")]
    Trust,
    #[error("speech catalog exceeds the resource limit")]
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

fn safe_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".:_-".contains(&byte)
        })
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
        let catalog = SpeechModelCatalog::embedded().expect("embedded catalog validates");
        assert_eq!(catalog.entries.len(), EXPECTED_ENTRY_COUNT);
        assert_eq!(catalog.languages.len(), EXPECTED_LANGUAGE_COUNT);
        assert_eq!(
            catalog
                .entries
                .iter()
                .map(|entry| entry.archive.byte_size)
                .sum::<u64>(),
            9_715_015_790
        );
        assert!(catalog.entries.iter().all(|entry| {
            entry.terms.download_initiated_by_user && !entry.terms.redistributed_by_aurora
        }));
    }

    #[test]
    fn exact_selection_never_expands_to_a_language_download() {
        let catalog = SpeechModelCatalog::embedded().expect("embedded catalog validates");
        let tiny = catalog.model("stt:whisper:tiny").expect("tiny exists");
        assert_eq!(tiny.archive.filename, "sherpa-onnx-whisper-tiny.tar.bz2");
        assert_eq!(tiny.languages.len(), 100);
        assert_eq!(
            catalog
                .models_for_task(SpeechCatalogTask::SpeechToText)
                .len(),
            12
        );
    }

    #[test]
    fn kws_tokenizer_and_lexicon_bindings_are_family_specific() {
        let catalog = SpeechModelCatalog::embedded().expect("embedded catalog validates");
        for entry in catalog.models_for_task(SpeechCatalogTask::KeywordSpotting) {
            let has_tokenizer = entry.bindings.contains_key("tokenizer");
            let has_lexicon = entry.bindings.contains_key("lexicon");
            match entry.model_id.as_str() {
                "kws:zipformer:gigaspeech" | "kws:zipformer:gigaspeech-mobile" => {
                    assert!(has_tokenizer);
                    assert!(!has_lexicon);
                    assert!(entry
                        .bindings
                        .get("tokenizer")
                        .expect("tokenizer binding")
                        .ends_with("/bpe.model"));
                }
                "kws:zipformer:zh-en-2025" => {
                    assert!(!has_tokenizer);
                    assert!(has_lexicon);
                    assert!(entry
                        .bindings
                        .get("lexicon")
                        .expect("lexicon binding")
                        .ends_with("/en.phone"));
                }
                "kws:zipformer:wenetspeech" | "kws:zipformer:wenetspeech-mobile" => {
                    assert!(!has_tokenizer);
                    assert!(!has_lexicon);
                }
                _ => panic!("unexpected KWS model"),
            }
        }
    }

    #[test]
    fn tampered_entry_or_source_is_rejected() {
        let mut value: Value = serde_json::from_str(EMBEDDED_CATALOG).expect("catalog JSON");
        value["entries"][0]["archive"]["byte_size"] = Value::from(1_u64);
        assert_eq!(
            SpeechModelCatalog::from_json(&value.to_string()),
            Err(SpeechCatalogError::Trust)
        );

        let mut value: Value = serde_json::from_str(EMBEDDED_CATALOG).expect("catalog JSON");
        value["sources"]["asr"]["release_id"] = Value::from(1_u64);
        assert_eq!(
            SpeechModelCatalog::from_json(&value.to_string()),
            Err(SpeechCatalogError::Trust)
        );
    }

    #[test]
    fn invalid_binding_is_rejected_even_with_recomputed_entry_digest_constant() {
        let catalog = SpeechModelCatalog::embedded().expect("embedded catalog validates");
        let mut entry = catalog
            .model("kws:zipformer:zh-en-2025")
            .expect("known catalog model")
            .clone();
        entry
            .bindings
            .insert("encoder".to_owned(), "../outside/encoder.onnx".to_owned());
        let languages = catalog.languages.iter().map(String::as_str).collect();
        assert_eq!(entry.validate(&languages), Err(SpeechCatalogError::Invalid));
    }
}
