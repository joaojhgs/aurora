//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
mod audio;
mod downloader;
mod model_store;
mod transport;
mod trust;

#[cfg(any(target_os = "linux", windows, target_os = "macos"))]
pub use audio::{CpalAudioOutput, NativeAudioConfig, NativeAudioStatus};
pub use downloader::{
    AssetIntegrity, DownloadError, DownloadPolicy, DownloadProgress, DownloadReceipt,
    NativeDownloader,
};
pub use model_store::{NativeImmutableModelFile, NativeModelStore, NativeModelStoreConfig};
pub use transport::{
    GatewayAuth, GatewayEvent, NativeEventStream, NativeGatewayTransport, NativeRequestOptions,
    SseSubscription, TransportError, TransportLimits,
};
pub use trust::Ed25519TrustStore;
