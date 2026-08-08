//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

mod android_capture;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod audio;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod desktop_capture;
mod downloader;
mod gateway_capture_handoff;
mod gateway_stt;
mod gateway_tts;
mod model_store;
mod transport;
mod trust;

pub use android_capture::{
    AndroidAudioInput, AndroidCaptureControl, AndroidPcmChunk, AndroidPcmIngress,
    AndroidPcmIngressStats, AndroidPcmPushResult,
};
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use audio::{CpalAudioOutput, NativeAudioConfig, NativeAudioStatus};
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use desktop_capture::{
    CpalAudioInput, NativeCaptureConfig, NativeCaptureControl, NativeCaptureStatus,
    NativeInputDevice, NativeInputDeviceId,
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
pub use model_store::{NativeImmutableModelFile, NativeModelStore, NativeModelStoreConfig};
pub use transport::{
    GatewayAuth, GatewayEvent, MicrophoneAudioPolicy, NativeEventStream,
    NativeGatewayEndpointClass, NativeGatewayMicrophoneAudioProfile, NativeGatewayTransport,
    NativeRequestOptions, SseSubscription, TransportError, TransportLimits,
};
pub use trust::Ed25519TrustStore;
