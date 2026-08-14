//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

mod android_capture;
mod android_playback;
mod android_session;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod audio;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod desktop_capture;
#[cfg(feature = "desktop-sherpa")]
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
pub use android_session::{
    AndroidVoiceSession, AndroidVoiceSessionCommandError, AndroidVoiceSessionConfig,
    AndroidVoiceSessionPhase, AndroidVoiceSessionStatus,
};
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use audio::{CpalAudioOutput, NativeAudioConfig, NativeAudioStatus};
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use desktop_capture::{
    CpalAudioInput, NativeCaptureConfig, NativeCaptureControl, NativeCaptureStatus,
    NativeInputDevice, NativeInputDeviceId,
};
#[cfg(feature = "desktop-sherpa")]
pub use desktop_engine::{
    build_active_kws_provider, build_active_stt_provider, build_active_vad_provider,
    warm_active_kws,
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
    IosVoicePackBinding, IosVoicePackBindings, IosVoiceSession, IosVoiceSessionCommandError,
    IosVoiceSessionConfig, IosVoiceSessionPhase, IosVoiceSessionStatus, IosVoiceStartMode,
    MAX_IOS_PACK_BINDINGS,
};
pub use model_store::{NativeImmutableModelFile, NativeModelStore, NativeModelStoreConfig};
pub use speech_pack_manager::{
    InstalledSpeechPack, SpeechPackBindings, SpeechPackError, SpeechPackInstallPhase,
    SpeechPackInstallProgress, SpeechPackManager, SpeechPackManagerConfig,
};
pub use transport::{
    GatewayAuth, GatewayEvent, MicrophoneAudioPolicy, NativeEventStream,
    NativeGatewayEndpointClass, NativeGatewayMicrophoneAudioProfile, NativeGatewayTransport,
    NativeRequestOptions, SseSubscription, TransportError, TransportLimits,
};
pub use trust::Ed25519TrustStore;
