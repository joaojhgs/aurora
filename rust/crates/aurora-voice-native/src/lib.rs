//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod audio;
#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod desktop_capture;
mod downloader;
mod gateway_tts;
mod model_store;
mod transport;
mod trust;

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
pub use gateway_tts::{NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer};
pub use model_store::{NativeImmutableModelFile, NativeModelStore, NativeModelStoreConfig};
pub use transport::{
    GatewayAuth, GatewayEvent, MicrophoneAudioPolicy, NativeEventStream, NativeGatewayTransport,
    NativeRequestOptions, SseSubscription, TransportError, TransportLimits,
};
pub use trust::Ed25519TrustStore;
