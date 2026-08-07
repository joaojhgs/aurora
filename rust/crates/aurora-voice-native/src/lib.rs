//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

mod downloader;
mod transport;

pub use downloader::{
    AssetIntegrity, DownloadError, DownloadPolicy, DownloadProgress, DownloadReceipt,
    NativeDownloader,
};
pub use transport::{
    GatewayAuth, GatewayEvent, NativeEventStream, NativeGatewayTransport, NativeRequestOptions,
    SseSubscription, TransportError, TransportLimits,
};
