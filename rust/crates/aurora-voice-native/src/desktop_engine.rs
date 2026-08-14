//! Desktop native speech-engine construction from active model-pack state.

#![cfg(feature = "desktop-sherpa")]

use aurora_voice_engine::{
    EngineError, EngineFaultCode, KwsConfig, ModelPackFile, ModelPackManifest, ModelStoreScope,
    PackTask, RuntimeSelection, SelectedVariant, TaskPackBinding, VadConfig, VerifiedManifest,
    VoiceTask,
};
use aurora_voice_sherpa::{
    NativeKwsBackend, NativeKwsModelFiles, NativeSttBackend, NativeVadBackend,
    SherpaFiniteSttEngine, SherpaKwsPhraseSet, SherpaKwsProvider, SherpaVadProvider,
};

use crate::NativeModelStore;

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
    let backend = NativeSttBackend::from_selected_model(
        &binding,
        "encoder",
        store_path(store, &selection, "encoder")?,
        "decoder-merged",
        store_path(store, &selection, "decoder-merged")?,
        "tokens",
        store_path(store, &selection, "tokens")?,
    )?;
    SherpaFiniteSttEngine::new(binding, backend)
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
