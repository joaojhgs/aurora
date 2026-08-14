//! Desktop native speech-engine construction from active model-pack state.

use aurora_voice_engine::{
    EngineError, EngineFaultCode, KwsConfig, LanguageSupport, ModelPackFile, ModelPackManifest,
    ModelStoreScope, PackTask, RuntimeSelection, SelectedVariant, SpeechCatalogTask,
    TaskPackBinding, VadConfig, VerifiedManifest, VoiceTask,
};
use aurora_voice_sherpa::{
    compile_gigaspeech_sentencepiece_phrase_set, compile_wenetspeech_pinyin_phrase_set,
    compile_zh_en_2025_phrase_set, NativeKwsBackend, NativeKwsModelFiles, NativeSttBackend,
    NativeSttModelFiles, NativeVadBackend, SherpaFiniteSttEngine, SherpaKwsPhraseCompileError,
    SherpaKwsPhraseInput, SherpaKwsPhraseSet, SherpaKwsProvider, SherpaVadProvider,
};
#[cfg(feature = "native-sherpa-tts")]
use aurora_voice_sherpa::{NativeTtsBackend, NativeTtsVitsPiperModelFiles, SherpaTtsProvider};

use crate::{NativeModelStore, SpeechModelBindings, SpeechPackManager};

/// Native desktop VAD provider bound to the currently active compatible pack.
pub fn build_active_vad_provider(
    store: &NativeModelStore,
    manifest: &VerifiedManifest,
    runtime: &RuntimeSelection,
    config: &VadConfig,
) -> Result<SherpaVadProvider<NativeVadBackend>, EngineError> {
    let (selection, binding) = active_binding(
        store,
        PackTask::Vad,
        VoiceTask::VoiceActivityDetection,
        manifest,
        runtime,
    )?;
    let model = selected_task_file(manifest.manifest(), &selection, PackTask::Vad)?;
    let backend = NativeVadBackend::from_selected_model(
        &binding,
        &model.file_id,
        store_path(store, &selection, &model.file_id)?,
        config,
    )?;
    SherpaVadProvider::new(binding, backend)
}

/// Native desktop VAD provider bound to an installed speech-catalog model.
pub fn build_installed_vad_provider(
    manager: &SpeechPackManager,
    model_id: &str,
    config: &VadConfig,
) -> Result<SherpaVadProvider<NativeVadBackend>, EngineError> {
    let bindings =
        resolve_installed_model(manager, model_id, SpeechCatalogTask::VoiceActivityDetection)?;
    let model_path = catalog_path(&bindings, "model")?;
    let backend =
        NativeVadBackend::from_catalog_model(&bindings.task_binding, "model", model_path, config)?;
    SherpaVadProvider::new(bindings.task_binding, backend)
}

/// Native desktop KWS provider bound to the currently active compatible pack.
pub fn build_active_kws_provider(
    store: &NativeModelStore,
    manifest: &VerifiedManifest,
    runtime: &RuntimeSelection,
    phrase_set: SherpaKwsPhraseSet,
) -> Result<SherpaKwsProvider<NativeKwsBackend>, EngineError> {
    let (selection, binding) = active_binding(
        store,
        PackTask::Kws,
        VoiceTask::KeywordSpotting,
        manifest,
        runtime,
    )?;
    let files = NativeKwsModelFiles {
        encoder_file_id: "encoder-int8".to_owned(),
        encoder_path: store_path(store, &selection, "encoder-int8")?,
        decoder_file_id: "decoder".to_owned(),
        decoder_path: store_path(store, &selection, "decoder")?,
        joiner_file_id: "joiner-int8".to_owned(),
        joiner_path: store_path(store, &selection, "joiner-int8")?,
        tokens_file_id: "tokens".to_owned(),
        tokens_path: store_path(store, &selection, "tokens")?,
    };
    let backend = NativeKwsBackend::from_selected_model(&binding, files)?;
    SherpaKwsProvider::new(binding, phrase_set, backend)
}

/// Native desktop KWS provider bound to an installed speech-catalog model.
pub fn build_installed_kws_provider(
    manager: &SpeechPackManager,
    model_id: &str,
    phrase_set: SherpaKwsPhraseSet,
) -> Result<SherpaKwsProvider<NativeKwsBackend>, EngineError> {
    let bindings = resolve_installed_model(manager, model_id, SpeechCatalogTask::KeywordSpotting)?;
    let files = installed_kws_model_files(&bindings)?;
    let backend = NativeKwsBackend::from_catalog_model_files(&bindings.task_binding, files)?;
    SherpaKwsProvider::new(bindings.task_binding, phrase_set, backend)
}

/// Native desktop KWS provider from user phrase text for supported installed KWS families.
pub fn build_installed_kws_provider_from_phrases(
    manager: &SpeechPackManager,
    model_id: &str,
    phrase_revision: impl Into<String>,
    phrases: impl IntoIterator<Item = SherpaKwsPhraseInput>,
) -> Result<SherpaKwsProvider<NativeKwsBackend>, EngineError> {
    let bindings = resolve_installed_model(manager, model_id, SpeechCatalogTask::KeywordSpotting)?;
    let phrase_set = match installed_kws_compiler_family(&bindings.model_id)
        .map_err(SherpaKwsPhraseCompileError::into_engine_error)?
    {
        InstalledKwsCompilerFamily::GigaspeechSentencePiece => {
            let tokenizer_path = catalog_path(&bindings, "tokenizer")
                .map_err(|_| SherpaKwsPhraseCompileError::InvalidTokenizer)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?;
            compile_gigaspeech_sentencepiece_phrase_set(phrase_revision, tokenizer_path, phrases)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?
        }
        InstalledKwsCompilerFamily::WenetSpeechPartialPinyin => {
            let tokens_path = catalog_path(&bindings, "tokens")
                .map_err(|_| SherpaKwsPhraseCompileError::InvalidTokenizer)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?;
            compile_wenetspeech_pinyin_phrase_set(phrase_revision, tokens_path, phrases)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?
        }
        InstalledKwsCompilerFamily::BilingualPhonePartialPinyin => {
            let tokens_path = catalog_path(&bindings, "tokens")
                .map_err(|_| SherpaKwsPhraseCompileError::InvalidTokenizer)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?;
            let lexicon_path = catalog_path(&bindings, "lexicon")
                .map_err(|_| SherpaKwsPhraseCompileError::InvalidLexicon)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?;
            compile_zh_en_2025_phrase_set(phrase_revision, tokens_path, lexicon_path, phrases)
                .map_err(SherpaKwsPhraseCompileError::into_engine_error)?
        }
    };
    let files = installed_kws_model_files(&bindings)?;
    let backend = NativeKwsBackend::from_catalog_model_files(&bindings.task_binding, files)?;
    SherpaKwsProvider::new(bindings.task_binding, phrase_set, backend)
}

/// Native desktop finite STT provider bound to the currently active compatible pack.
pub fn build_active_stt_provider(
    store: &NativeModelStore,
    manifest: &VerifiedManifest,
    runtime: &RuntimeSelection,
) -> Result<SherpaFiniteSttEngine<NativeSttBackend>, EngineError> {
    let (selection, binding) = active_binding(
        store,
        PackTask::Stt,
        VoiceTask::SpeechToText,
        manifest,
        runtime,
    )?;
    let files = active_stt_model_files(store, &selection, &binding)?;
    let backend = NativeSttBackend::from_selected_model_files(&binding, files)?;
    SherpaFiniteSttEngine::new(binding, backend)
}

/// Native desktop finite STT provider bound to an installed speech-catalog model.
pub fn build_installed_stt_provider(
    manager: &SpeechPackManager,
    model_id: &str,
) -> Result<SherpaFiniteSttEngine<NativeSttBackend>, EngineError> {
    let bindings = resolve_installed_model(manager, model_id, SpeechCatalogTask::SpeechToText)?;
    let files = NativeSttModelFiles {
        encoder_file_id: "encoder".to_owned(),
        encoder_path: catalog_path(&bindings, "encoder")?,
        decoder_file_id: "decoder".to_owned(),
        decoder_path: catalog_path(&bindings, "decoder")?,
        tokens_file_id: "tokens".to_owned(),
        tokens_path: catalog_path(&bindings, "tokens")?,
        language: default_stt_language(bindings.task_binding.languages()),
    };
    let backend = NativeSttBackend::from_catalog_model_files(&bindings.task_binding, files)?;
    SherpaFiniteSttEngine::new(bindings.task_binding, backend)
}

/// Native desktop TTS provider bound to an installed TTS catalog voice.
#[cfg(feature = "native-sherpa-tts")]
pub fn build_installed_tts_provider(
    manager: &SpeechPackManager,
    voice_id: &str,
) -> Result<SherpaTtsProvider<NativeTtsBackend>, EngineError> {
    let bindings = manager
        .resolve_voice_bindings(voice_id)
        .map_err(|_| EngineError::TaskUnavailable)?;
    if bindings.task_binding.task() != VoiceTask::TextToSpeech {
        return Err(EngineError::InvalidRequest);
    }
    let files = NativeTtsVitsPiperModelFiles {
        model_file_id: "model".to_owned(),
        model_path: bindings.model.clone(),
        tokens_file_id: "tokens".to_owned(),
        tokens_path: bindings.tokens.clone(),
        espeak_data_file_id: "espeak-ng-data".to_owned(),
        espeak_data_dir: bindings.data_dir.clone(),
        lexicon_file_id: None,
        lexicon_path: None,
    };
    let backend = NativeTtsBackend::from_catalog_vits_piper_model(&bindings.task_binding, files)?;
    SherpaTtsProvider::new(bindings.task_binding, backend)
}

/// Validate a KWS request against the active compatible provider without opening audio.
pub fn warm_active_kws(
    store: &NativeModelStore,
    manifest: &VerifiedManifest,
    runtime: &RuntimeSelection,
    config: &KwsConfig,
    phrase_set: &SherpaKwsPhraseSet,
) -> Result<(), EngineError> {
    let (_, binding) = active_binding(
        store,
        PackTask::Kws,
        VoiceTask::KeywordSpotting,
        manifest,
        runtime,
    )?;
    config.validate_binding(&binding)?;
    phrase_set.validate_request(config)
}

/// Validate a KWS request against an installed speech-catalog model.
pub fn warm_installed_kws(
    manager: &SpeechPackManager,
    model_id: &str,
    config: &KwsConfig,
    phrase_set: &SherpaKwsPhraseSet,
) -> Result<(), EngineError> {
    let bindings = resolve_installed_model(manager, model_id, SpeechCatalogTask::KeywordSpotting)?;
    config.validate_binding(&bindings.task_binding)?;
    phrase_set.validate_request(config)
}

fn resolve_installed_model(
    manager: &SpeechPackManager,
    model_id: &str,
    task: SpeechCatalogTask,
) -> Result<SpeechModelBindings, EngineError> {
    let bindings = manager
        .resolve_model_bindings(model_id)
        .map_err(|_| EngineError::TaskUnavailable)?;
    if bindings.task != task || bindings.task_binding.task() != catalog_voice_task(task) {
        return Err(EngineError::InvalidRequest);
    }
    Ok(bindings)
}

fn catalog_path(
    bindings: &SpeechModelBindings,
    file_id: &str,
) -> Result<std::path::PathBuf, EngineError> {
    bindings
        .bindings
        .get(file_id)
        .cloned()
        .ok_or(EngineError::InvalidRequest)
}

fn catalog_voice_task(task: SpeechCatalogTask) -> VoiceTask {
    match task {
        SpeechCatalogTask::SpeechToText => VoiceTask::SpeechToText,
        SpeechCatalogTask::VoiceActivityDetection => VoiceTask::VoiceActivityDetection,
        SpeechCatalogTask::KeywordSpotting => VoiceTask::KeywordSpotting,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstalledKwsCompilerFamily {
    GigaspeechSentencePiece,
    WenetSpeechPartialPinyin,
    BilingualPhonePartialPinyin,
}

fn installed_kws_compiler_family(
    model_id: &str,
) -> Result<InstalledKwsCompilerFamily, SherpaKwsPhraseCompileError> {
    match model_id {
        "kws:zipformer:gigaspeech" | "kws:zipformer:gigaspeech-mobile" => {
            Ok(InstalledKwsCompilerFamily::GigaspeechSentencePiece)
        }
        "kws:zipformer:wenetspeech" | "kws:zipformer:wenetspeech-mobile" => {
            Ok(InstalledKwsCompilerFamily::WenetSpeechPartialPinyin)
        }
        "kws:zipformer:zh-en-2025" => Ok(InstalledKwsCompilerFamily::BilingualPhonePartialPinyin),
        _ => Err(SherpaKwsPhraseCompileError::UnsupportedFamily),
    }
}

fn installed_kws_model_files(
    bindings: &SpeechModelBindings,
) -> Result<NativeKwsModelFiles, EngineError> {
    Ok(NativeKwsModelFiles {
        encoder_file_id: "encoder".to_owned(),
        encoder_path: catalog_path(bindings, "encoder")?,
        decoder_file_id: "decoder".to_owned(),
        decoder_path: catalog_path(bindings, "decoder")?,
        joiner_file_id: "joiner".to_owned(),
        joiner_path: catalog_path(bindings, "joiner")?,
        tokens_file_id: "tokens".to_owned(),
        tokens_path: catalog_path(bindings, "tokens")?,
    })
}

fn active_binding(
    store: &NativeModelStore,
    pack_task: PackTask,
    voice_task: VoiceTask,
    manifest: &VerifiedManifest,
    runtime: &RuntimeSelection,
) -> Result<(SelectedVariant, TaskPackBinding), EngineError> {
    let scope = ModelStoreScope::default_for_task(pack_task);
    let selection = store
        .active_verified_selection(&scope, manifest, runtime)
        .map_err(|_| EngineError::TaskUnavailable)?
        .ok_or(EngineError::TaskUnavailable)?;
    let binding = TaskPackBinding::from_selection(voice_task, manifest, &selection)?;
    Ok((selection, binding))
}

fn selected_task_file<'a>(
    manifest: &'a ModelPackManifest,
    selection: &SelectedVariant,
    task: PackTask,
) -> Result<&'a ModelPackFile, EngineError> {
    manifest
        .files
        .iter()
        .find(|file| selection.file_ids().contains(&file.file_id) && file.task == task)
        .ok_or(EngineError::InvalidRequest)
}

fn store_path(
    store: &NativeModelStore,
    selection: &SelectedVariant,
    file_id: &str,
) -> Result<std::path::PathBuf, EngineError> {
    store
        .native_file_path(selection, file_id)
        .map_err(|_| EngineError::ProviderFault {
            code: EngineFaultCode::Native,
        })
}

fn active_stt_model_files(
    store: &NativeModelStore,
    selection: &SelectedVariant,
    binding: &TaskPackBinding,
) -> Result<NativeSttModelFiles, EngineError> {
    let decoder_file_id = selected_stt_decoder_file_id(binding.selected_file_ids())?;
    Ok(NativeSttModelFiles {
        encoder_file_id: "encoder".to_owned(),
        encoder_path: store_path(store, selection, "encoder")?,
        decoder_file_id: decoder_file_id.to_owned(),
        decoder_path: store_path(store, selection, decoder_file_id)?,
        tokens_file_id: "tokens".to_owned(),
        tokens_path: store_path(store, selection, "tokens")?,
        language: default_stt_language(binding.languages()),
    })
}

fn selected_stt_decoder_file_id(file_ids: &[String]) -> Result<&'static str, EngineError> {
    let has_moonshine_decoder = file_ids.iter().any(|file_id| file_id == "decoder-merged");
    let has_whisper_decoder = file_ids.iter().any(|file_id| file_id == "decoder");
    match (has_moonshine_decoder, has_whisper_decoder) {
        (true, false) => Ok("decoder-merged"),
        (false, true) => Ok("decoder"),
        _ => Err(EngineError::InvalidRequest),
    }
}

fn default_stt_language(languages: &[LanguageSupport]) -> Option<String> {
    match languages {
        [language] if language.fixed_language && !language.auto_detect => {
            Some(language.language.clone())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_kws_compiler_family_is_truthful() {
        assert_eq!(
            installed_kws_compiler_family("kws:zipformer:gigaspeech"),
            Ok(InstalledKwsCompilerFamily::GigaspeechSentencePiece)
        );
        assert_eq!(
            installed_kws_compiler_family("kws:zipformer:gigaspeech-mobile"),
            Ok(InstalledKwsCompilerFamily::GigaspeechSentencePiece)
        );
        assert_eq!(
            installed_kws_compiler_family("kws:zipformer:wenetspeech"),
            Ok(InstalledKwsCompilerFamily::WenetSpeechPartialPinyin)
        );
        assert_eq!(
            installed_kws_compiler_family("kws:zipformer:wenetspeech-mobile"),
            Ok(InstalledKwsCompilerFamily::WenetSpeechPartialPinyin)
        );
        assert_eq!(
            installed_kws_compiler_family("kws:zipformer:zh-en-2025"),
            Ok(InstalledKwsCompilerFamily::BilingualPhonePartialPinyin)
        );
    }

    #[test]
    fn active_stt_decoder_selection_supports_moonshine_and_whisper() {
        assert_eq!(
            selected_stt_decoder_file_id(&[
                "encoder".to_owned(),
                "decoder-merged".to_owned(),
                "tokens".to_owned(),
            ]),
            Ok("decoder-merged")
        );
        assert_eq!(
            selected_stt_decoder_file_id(&[
                "encoder".to_owned(),
                "decoder".to_owned(),
                "tokens".to_owned(),
            ]),
            Ok("decoder")
        );
        assert_eq!(
            selected_stt_decoder_file_id(&[
                "encoder".to_owned(),
                "decoder".to_owned(),
                "decoder-merged".to_owned(),
                "tokens".to_owned(),
            ]),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn active_stt_language_defaults_only_for_single_fixed_language() {
        assert_eq!(
            default_stt_language(&[LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }])
            .as_deref(),
            Some("en")
        );
        assert_eq!(
            default_stt_language(&[LanguageSupport {
                language: "en".to_owned(),
                locale: None,
                fixed_language: false,
                auto_detect: true,
            }]),
            None
        );
        assert_eq!(
            default_stt_language(&[
                LanguageSupport {
                    language: "en".to_owned(),
                    locale: None,
                    fixed_language: true,
                    auto_detect: false,
                },
                LanguageSupport {
                    language: "fr".to_owned(),
                    locale: None,
                    fixed_language: true,
                    auto_detect: false,
                },
            ]),
            None
        );
    }
}
