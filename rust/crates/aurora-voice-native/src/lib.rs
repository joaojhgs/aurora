//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

/// Sherpa's documented low-threshold KWS setting, validated against Aurora's
/// quantized GigaSpeech pack and the `Hey Aurora` production phrase.
pub const NATIVE_WAKE_KWS_THRESHOLD: f32 = 0.1;

mod android_capture;
mod android_playback;
mod android_session;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod audio;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod desktop_capture;
#[cfg(feature = "native-sherpa")]
mod desktop_engine;
mod downloader;
mod gateway_capture_handoff;
mod gateway_stt;
mod gateway_tts;
mod ios_session;
mod model_store;
mod speech_pack_manager;
mod transport;
mod trust;

pub use android_capture::{
    AndroidAudioInput, AndroidCaptureControl, AndroidPcmChunk, AndroidPcmIngress,
    AndroidPcmIngressStats, AndroidPcmPushResult,
};
pub use android_playback::{AndroidAudioOutput, AndroidPcmPlaybackChunk};
#[cfg(feature = "native-sherpa-tts")]
pub use android_session::AndroidTtsReferenceProfile;
pub use android_session::{
    AndroidAssistantRouteMode, AndroidBackgroundVoiceTurnResult, AndroidVoiceSession,
    AndroidVoiceSessionCommandError, AndroidVoiceSessionConfig, AndroidVoiceSessionPhase,
    AndroidVoiceSessionStatus,
};
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use audio::{CpalAudioOutput, NativeAudioConfig, NativeAudioStatus};
pub use aurora_voice_core::CancellationToken;
pub use aurora_voice_engine::{SpeechCatalogTask, SpeechModelCatalog, TtsVoiceCatalog};
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use desktop_capture::{
    CpalAudioInput, NativeCaptureConfig, NativeCaptureControl, NativeCaptureStatus,
    NativeInputDevice, NativeInputDeviceId,
};
#[cfg(feature = "native-sherpa")]
pub use desktop_engine::{
    build_active_kws_provider, build_active_stt_provider, build_active_vad_provider,
    build_installed_kws_provider, build_installed_kws_provider_from_phrases,
    build_installed_stt_provider, build_installed_vad_provider, warm_active_kws,
    warm_installed_kws,
};
#[cfg(feature = "native-sherpa-tts")]
pub use desktop_engine::{
    build_installed_tts_provider, build_installed_tts_provider_with_reference,
};
pub use downloader::{
    AssetIntegrity, DownloadError, DownloadPolicy, DownloadProgress, DownloadReceipt,
    NativeDownloader,
};
pub use gateway_capture_handoff::{
    NativeGatewayCaptureGrant, NativeGatewayCaptureHandoff, NativeGatewayCaptureHandoffConfig,
};
pub use gateway_stt::{NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig};
pub use gateway_tts::{NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer};
pub use ios_session::{
    IosTtsReferenceBinding, IosVoicePackBinding, IosVoicePackBindings, IosVoicePackFileBinding,
    IosVoiceSession, IosVoiceSessionCommandError, IosVoiceSessionConfig, IosVoiceSessionPhase,
    IosVoiceSessionStatus, IosVoiceStartMode, MAX_IOS_PACK_BINDINGS,
};
pub use model_store::{NativeImmutableModelFile, NativeModelStore, NativeModelStoreConfig};
pub use speech_pack_manager::{
    InstalledSpeechModel, InstalledSpeechPack, SpeechModelBindings, SpeechPackBindings,
    SpeechPackError, SpeechPackInstallPhase, SpeechPackInstallProgress, SpeechPackManager,
    SpeechPackManagerConfig,
};
pub use transport::{
    clear_native_mesh_assistant_transport_factory, install_native_mesh_assistant_transport_factory,
    GatewayAuth, GatewayEvent, MicrophoneAudioPolicy, NativeEventStream,
    NativeGatewayEndpointClass, NativeGatewayMicrophoneAudioProfile, NativeGatewayTransport,
    NativeMeshAssistantRoute, NativeMeshAssistantSpeechTransport, NativeMeshAssistantTransport,
    NativeMeshAssistantTransportFactory, NativeMeshAssistantTransportOptions,
    NativeMeshExternalUserInput, NativeMeshInterruptRequest, NativeRequestOptions, SseSubscription,
    TransportError, TransportLimits,
};
pub use trust::Ed25519TrustStore;
