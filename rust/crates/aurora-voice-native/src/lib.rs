//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

mod downloader;
mod model_store;
mod transport;
mod trust;

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
