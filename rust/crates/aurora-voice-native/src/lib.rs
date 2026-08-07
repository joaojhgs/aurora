//! Native model delivery, persistence, transport, and runtime adapters.

#![forbid(unsafe_code)]

mod downloader;

pub use downloader::{
    AssetIntegrity, DownloadError, DownloadPolicy, DownloadProgress, DownloadReceipt,
    NativeDownloader,
};
