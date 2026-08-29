//! Bounded, resumable native downloads for verified model-pack assets.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use aurora_voice_core::CancellationToken;
use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Integrity metadata fixed by a verified model-pack manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIntegrity {
    expected_bytes: u64,
    expected_sha256: String,
}

impl AssetIntegrity {
    /// Construct validated asset integrity metadata.
    pub fn new(
        expected_bytes: u64,
        expected_sha256: impl Into<String>,
    ) -> Result<Self, DownloadError> {
        let expected_sha256 = expected_sha256.into();
        if expected_bytes == 0
            || expected_sha256.len() != 64
            || !expected_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(DownloadError::InvalidIntegrity);
        }
        Ok(Self {
            expected_bytes,
            expected_sha256,
        })
    }

    /// Declared byte length.
    pub fn expected_bytes(&self) -> u64 {
        self.expected_bytes
    }

    /// Declared lowercase SHA-256 digest.
    pub fn expected_sha256(&self) -> &str {
        &self.expected_sha256
    }
}

/// Network and storage ceilings applied before bytes are accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DownloadPolicy {
    /// Maximum permitted size for one staged asset.
    pub max_asset_bytes: u64,
    /// Permit cleartext HTTP only for a loopback development/test origin.
    pub allow_loopback_http: bool,
    /// Maximum wait for response headers.
    pub request_timeout: Duration,
    /// Maximum wait between streamed body chunks.
    pub idle_timeout: Duration,
}

impl DownloadPolicy {
    /// Create a production policy that accepts HTTPS only.
    pub fn https_only(max_asset_bytes: u64) -> Result<Self, DownloadError> {
        if max_asset_bytes == 0 {
            return Err(DownloadError::InvalidPolicy);
        }
        Ok(Self {
            max_asset_bytes,
            allow_loopback_http: false,
            request_timeout: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(30),
        })
    }
}

/// Product-safe progress for a model asset download.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub expected_bytes: u64,
}

/// Verified result of a staged download.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadReceipt {
    pub byte_size: u64,
    pub sha256: String,
    pub resumed_from: u64,
}

/// Download failures intentionally exclude URLs, paths, headers, and payloads.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DownloadError {
    #[error("download policy is invalid")]
    InvalidPolicy,
    #[error("asset integrity metadata is invalid")]
    InvalidIntegrity,
    #[error("asset source is not permitted")]
    UnsafeSource,
    #[error("asset exceeds the configured size limit")]
    ResourceLimit,
    #[error("asset staging failed during {operation}")]
    Staging { operation: &'static str },
    #[error("asset request failed")]
    Request,
    #[error("asset request returned HTTP {status}")]
    HttpStatus { status: u16 },
    #[error("asset server returned an invalid resume response")]
    InvalidResume,
    #[error("asset byte length did not match the manifest")]
    SizeMismatch,
    #[error("asset hash did not match the manifest")]
    HashMismatch,
    #[error("asset download was cancelled")]
    Cancelled,
    #[error("asset download timed out")]
    Timeout,
}

/// Reqwest-backed native downloader that never promotes staged bytes itself.
pub struct NativeDownloader {
    policy: DownloadPolicy,
}

impl NativeDownloader {
    /// Create a downloader using the supplied bounded policy.
    pub fn new(policy: DownloadPolicy) -> Result<Self, DownloadError> {
        if policy.max_asset_bytes == 0
            || policy.request_timeout.is_zero()
            || policy.idle_timeout.is_zero()
        {
            return Err(DownloadError::InvalidPolicy);
        }
        Ok(Self { policy })
    }

    /// Resolve a manifest asset URL against its trusted manifest origin.
    pub fn resolve_source(
        &self,
        manifest_origin: &Url,
        declared: &str,
    ) -> Result<Url, DownloadError> {
        let source = if declared.starts_with('/') {
            manifest_origin
                .join(declared)
                .map_err(|_| DownloadError::UnsafeSource)?
        } else {
            Url::parse(declared).map_err(|_| DownloadError::UnsafeSource)?
        };
        self.validate_source(&source)?;
        Ok(source)
    }

    /// Download or resume an asset into a staging file, validating length and
    /// SHA-256 before returning. Promotion remains a separate atomic store step.
    pub async fn download_to_staging<F>(
        &self,
        source: &Url,
        staging_path: &Path,
        integrity: &AssetIntegrity,
        cancellation: &CancellationToken,
        mut progress: F,
    ) -> Result<DownloadReceipt, DownloadError>
    where
        F: FnMut(DownloadProgress),
    {
        self.validate_source(source)?;
        if integrity.expected_bytes > self.policy.max_asset_bytes {
            return Err(DownloadError::ResourceLimit);
        }
        if cancellation.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }

        let mut resumed_from = existing_length(staging_path).await?;
        if resumed_from > integrity.expected_bytes {
            remove_staging(staging_path).await?;
            resumed_from = 0;
        }

        if resumed_from == integrity.expected_bytes {
            let existing_hash = hash_file(staging_path).await?;
            if existing_hash == integrity.expected_sha256 {
                progress(DownloadProgress {
                    downloaded_bytes: resumed_from,
                    expected_bytes: integrity.expected_bytes,
                });
                return Ok(DownloadReceipt {
                    byte_size: resumed_from,
                    sha256: existing_hash,
                    resumed_from,
                });
            }
            remove_staging(staging_path).await?;
            resumed_from = 0;
        }

        let response = self.send_get(source, resumed_from, cancellation).await?;
        self.validate_source(response.url())?;
        let status = response.status();
        if !status.is_success() {
            return Err(DownloadError::HttpStatus {
                status: status.as_u16(),
            });
        }

        let resume_honored = resumed_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        if resumed_from > 0 && status != reqwest::StatusCode::OK && !resume_honored {
            return Err(DownloadError::InvalidResume);
        }
        if resume_honored {
            validate_content_range(response.headers().get(CONTENT_RANGE), resumed_from)?;
        } else if resumed_from > 0 {
            resumed_from = 0;
        }

        if let Some(content_length) = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
        {
            let total = resumed_from
                .checked_add(content_length)
                .ok_or(DownloadError::ResourceLimit)?;
            if total > integrity.expected_bytes || total > self.policy.max_asset_bytes {
                remove_staging(staging_path).await?;
                return Err(DownloadError::ResourceLimit);
            }
        }

        let mut hasher = Sha256::new();
        if resumed_from > 0 {
            hash_file_into(staging_path, &mut hasher).await?;
        }
        let mut file = open_staging(staging_path, resumed_from > 0).await?;
        let mut downloaded = resumed_from;
        progress(DownloadProgress {
            downloaded_bytes: downloaded,
            expected_bytes: integrity.expected_bytes,
        });

        let mut stream = response.bytes_stream();
        loop {
            if cancellation.is_cancelled() {
                sync_partial(&mut file).await?;
                return Err(DownloadError::Cancelled);
            }
            let next = await_bounded(stream.next(), cancellation, self.policy.idle_timeout).await?;
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk.map_err(|_| DownloadError::Request)?;
            let chunk_len = u64::try_from(chunk.len()).map_err(|_| DownloadError::ResourceLimit)?;
            downloaded = downloaded
                .checked_add(chunk_len)
                .ok_or(DownloadError::ResourceLimit)?;
            if downloaded > integrity.expected_bytes || downloaded > self.policy.max_asset_bytes {
                drop(file);
                remove_staging(staging_path).await?;
                return Err(DownloadError::ResourceLimit);
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| DownloadError::Staging { operation: "write" })?;
            hasher.update(&chunk);
            progress(DownloadProgress {
                downloaded_bytes: downloaded,
                expected_bytes: integrity.expected_bytes,
            });
        }
        sync_partial(&mut file).await?;
        drop(file);

        if downloaded != integrity.expected_bytes {
            return Err(DownloadError::SizeMismatch);
        }
        let sha256 = encode_hex(&hasher.finalize());
        if sha256 != integrity.expected_sha256 {
            remove_staging(staging_path).await?;
            return Err(DownloadError::HashMismatch);
        }

        Ok(DownloadReceipt {
            byte_size: downloaded,
            sha256,
            resumed_from,
        })
    }

    fn validate_source(&self, source: &Url) -> Result<(), DownloadError> {
        if source_is_allowed(source, self.policy.allow_loopback_http) {
            return Ok(());
        }
        Err(DownloadError::UnsafeSource)
    }

    async fn send_get(
        &self,
        source: &Url,
        resumed_from: u64,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, DownloadError> {
        let mut current = source.clone();
        for redirect_count in 0..=5 {
            self.validate_source(&current)?;
            let client = client_for_pinned_url(&current, self.policy.allow_loopback_http).await?;
            let mut request = client.get(current.clone());
            if resumed_from > 0 {
                request = request.header(RANGE, format!("bytes={resumed_from}-"));
            }
            let response = await_bounded(request.send(), cancellation, self.policy.request_timeout)
                .await?
                .map_err(|_| DownloadError::Request)?;
            if !response.status().is_redirection() {
                return Ok(response);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(DownloadError::Request)?;
            let target = current
                .join(location)
                .map_err(|_| DownloadError::UnsafeSource)?;
            if !redirect_is_allowed(
                Some(&current),
                &target,
                redirect_count,
                self.policy.allow_loopback_http,
            ) {
                return Err(DownloadError::UnsafeSource);
            }
            current = target;
        }
        Err(DownloadError::UnsafeSource)
    }
}

async fn client_for_pinned_url(
    source: &Url,
    allow_loopback_http: bool,
) -> Result<reqwest::Client, DownloadError> {
    let host = source.host_str().ok_or(DownloadError::UnsafeSource)?;
    #[cfg(target_os = "android")]
    if !android_model_download_host_allowed(host) {
        return Err(DownloadError::UnsafeSource);
    }
    let port = source
        .port_or_known_default()
        .ok_or(DownloadError::UnsafeSource)?;
    let pinned = resolve_public_addrs(host, port, allow_loopback_http).await?;
    reqwest::Client::builder()
        // A proxy would bypass the DNS-pinned destination policy below and make
        // client construction depend on untrusted process proxy variables.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &pinned)
        .build()
        .map_err(|_| DownloadError::Request)
}

async fn resolve_public_addrs(
    host: &str,
    port: u16,
    allow_loopback_http: bool,
) -> Result<Vec<SocketAddr>, DownloadError> {
    let resolved = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| DownloadError::UnsafeSource)?;
    let addrs: Vec<SocketAddr> = resolved
        .filter(|addr| ip_is_permitted(addr.ip(), allow_loopback_http))
        .collect();
    if addrs.is_empty() {
        Err(DownloadError::UnsafeSource)
    } else {
        Ok(addrs)
    }
}

#[cfg(any(target_os = "android", test))]
fn android_model_download_host_allowed(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"
    )
}

fn ip_is_permitted(ip: IpAddr, allow_loopback_http: bool) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            if allow_loopback_http && ip.is_loopback() {
                return true;
            }
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
                || ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
                || ip.octets()[0] == 198 && (18..=19).contains(&ip.octets()[1]))
        }
        IpAddr::V6(ip) => {
            if allow_loopback_http && ip.is_loopback() {
                return true;
            }
            !(ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unspecified()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
        }
    }
}

fn source_is_allowed(source: &Url, allow_loopback_http: bool) -> bool {
    source.scheme() == "https"
        || (allow_loopback_http
            && source.scheme() == "http"
            && matches!(source.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
}

fn redirect_is_allowed(
    previous: Option<&Url>,
    target: &Url,
    redirect_count: usize,
    allow_loopback_http: bool,
) -> bool {
    redirect_count < 5
        && source_is_allowed(target, allow_loopback_http)
        && !previous.is_some_and(|source| source.scheme() == "https" && target.scheme() != "https")
}

async fn await_bounded<F>(
    future: F,
    cancellation: &CancellationToken,
    timeout: Duration,
) -> Result<F::Output, DownloadError>
where
    F: std::future::Future,
{
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            output = &mut future => return Ok(output),
            () = tokio::time::sleep_until(deadline) => return Err(DownloadError::Timeout),
            () = tokio::time::sleep(CANCELLATION_POLL_INTERVAL) => {
                if cancellation.is_cancelled() {
                    return Err(DownloadError::Cancelled);
                }
            }
        }
    }
}

async fn existing_length(path: &Path) -> Result<u64, DownloadError> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(DownloadError::Staging {
            operation: "inspect",
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(DownloadError::Staging {
            operation: "inspect",
        }),
    }
}

async fn open_staging(path: &Path, append: bool) -> Result<File, DownloadError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|_| DownloadError::Staging {
                operation: "create",
            })?;
    }
    OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(path)
        .await
        .map_err(|_| DownloadError::Staging { operation: "open" })
}

async fn sync_partial(file: &mut File) -> Result<(), DownloadError> {
    file.flush()
        .await
        .map_err(|_| DownloadError::Staging { operation: "flush" })?;
    file.sync_all()
        .await
        .map_err(|_| DownloadError::Staging { operation: "sync" })
}

async fn hash_file(path: &Path) -> Result<String, DownloadError> {
    let mut hasher = Sha256::new();
    hash_file_into(path, &mut hasher).await?;
    Ok(encode_hex(&hasher.finalize()))
}

async fn hash_file_into(path: &Path, hasher: &mut Sha256) -> Result<(), DownloadError> {
    let mut file = File::open(path)
        .await
        .map_err(|_| DownloadError::Staging { operation: "read" })?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| DownloadError::Staging { operation: "read" })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(())
}

async fn remove_staging(path: &Path) -> Result<(), DownloadError> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(DownloadError::Staging {
            operation: "remove",
        }),
    }
}

fn validate_content_range(
    value: Option<&reqwest::header::HeaderValue>,
    expected_start: u64,
) -> Result<(), DownloadError> {
    let value = value
        .and_then(|header| header.to_str().ok())
        .ok_or(DownloadError::InvalidResume)?;
    let prefix = format!("bytes {expected_start}-");
    if value.starts_with(&prefix) && value.contains('/') {
        Ok(())
    } else {
        Err(DownloadError::InvalidResume)
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    use super::*;

    struct TestServer {
        url: Url,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn one_request(body: Vec<u8>, split_at: Option<usize>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let address = listener.local_addr().expect("read test server address");
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept request");
                let request = read_request(&mut stream);
                let range_start = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .and_then(|value| value.strip_suffix('-'))
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let response_body = &body[range_start.min(body.len())..];
                let status = if range_start > 0 {
                    "HTTP/1.1 206 Partial Content"
                } else {
                    "HTTP/1.1 200 OK"
                };
                let content_range = if range_start > 0 {
                    format!(
                        "Content-Range: bytes {}-{}/{}\r\n",
                        range_start,
                        body.len().saturating_sub(1),
                        body.len()
                    )
                } else {
                    String::new()
                };
                let headers = format!(
                    "{status}\r\nContent-Length: {}\r\n{content_range}Connection: close\r\n\r\n",
                    response_body.len()
                );
                stream.write_all(headers.as_bytes()).expect("write headers");
                if let Some(split_at) = split_at.filter(|split| *split < response_body.len()) {
                    stream
                        .write_all(&response_body[..split_at])
                        .expect("write first chunk");
                    stream.flush().expect("flush first chunk");
                    thread::sleep(Duration::from_millis(100));
                    let _ = stream.write_all(&response_body[split_at..]);
                } else {
                    stream.write_all(response_body).expect("write body");
                }
            });
            Self {
                url: Url::parse(&format!("http://{address}/asset.bin")).expect("parse URL"),
                thread: Some(thread),
            }
        }

        fn delayed_response(prefix: Vec<u8>, delay: Duration, suffix: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let address = listener.local_addr().expect("read test server address");
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept request");
                let _request = read_request(&mut stream);
                if !prefix.is_empty() {
                    stream.write_all(&prefix).expect("write response prefix");
                    stream.flush().expect("flush response prefix");
                }
                thread::sleep(delay);
                let _ = stream.write_all(&suffix);
            });
            Self {
                url: Url::parse(&format!("http://{address}/asset.bin")).expect("parse URL"),
                thread: Some(thread),
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                thread.join().expect("join test server");
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).expect("read request");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        String::from_utf8(request)
            .expect("request UTF-8")
            .to_ascii_lowercase()
    }

    fn loopback_downloader(max_asset_bytes: u64) -> NativeDownloader {
        loopback_downloader_with_timeouts(
            max_asset_bytes,
            Duration::from_secs(30),
            Duration::from_secs(30),
        )
    }

    fn loopback_downloader_with_timeouts(
        max_asset_bytes: u64,
        request_timeout: Duration,
        idle_timeout: Duration,
    ) -> NativeDownloader {
        let mut policy = DownloadPolicy::https_only(max_asset_bytes).expect("valid policy");
        policy.allow_loopback_http = true;
        policy.request_timeout = request_timeout;
        policy.idle_timeout = idle_timeout;
        NativeDownloader::new(policy).expect("construct downloader")
    }

    fn integrity(body: &[u8]) -> AssetIntegrity {
        AssetIntegrity::new(
            u64::try_from(body.len()).expect("fixture length"),
            encode_hex(&Sha256::digest(body)),
        )
        .expect("valid integrity")
    }

    fn staging_path(directory: &tempfile::TempDir) -> PathBuf {
        directory.path().join("staging").join("asset.part")
    }

    #[tokio::test]
    async fn downloads_and_verifies_a_complete_asset() {
        let body = b"aurora-model-asset".to_vec();
        let server = TestServer::one_request(body.clone(), None);
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = staging_path(&directory);
        let mut progress = Vec::new();

        let receipt = loopback_downloader(1024)
            .download_to_staging(
                &server.url,
                &path,
                &integrity(&body),
                &CancellationToken::new(),
                |value| progress.push(value),
            )
            .await
            .expect("download asset");

        assert_eq!(receipt.byte_size, body.len() as u64);
        assert_eq!(receipt.resumed_from, 0);
        assert_eq!(fs::read(&path).await.expect("read staged bytes"), body);
        assert_eq!(
            progress.last().map(|value| value.downloaded_bytes),
            Some(receipt.byte_size)
        );
    }

    #[tokio::test]
    async fn resumes_from_a_verified_prefix() {
        let body = b"0123456789abcdef".to_vec();
        let server = TestServer::one_request(body.clone(), None);
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = staging_path(&directory);
        fs::create_dir_all(path.parent().expect("staging parent"))
            .await
            .expect("create staging directory");
        fs::write(&path, &body[..6]).await.expect("write prefix");

        let receipt = loopback_downloader(1024)
            .download_to_staging(
                &server.url,
                &path,
                &integrity(&body),
                &CancellationToken::new(),
                |_| {},
            )
            .await
            .expect("resume asset");

        assert_eq!(receipt.resumed_from, 6);
        assert_eq!(fs::read(&path).await.expect("read staged bytes"), body);
    }

    #[tokio::test]
    async fn cancellation_preserves_only_staged_partial_bytes() {
        let body = vec![7_u8; 128 * 1024];
        let server = TestServer::one_request(body.clone(), Some(1024));
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = staging_path(&directory);
        let cancellation = CancellationToken::new();
        let signal = cancellation.clone();

        let result = loopback_downloader(256 * 1024)
            .download_to_staging(
                &server.url,
                &path,
                &integrity(&body),
                &cancellation,
                move |value| {
                    if value.downloaded_bytes > 0 {
                        signal.cancel();
                    }
                },
            )
            .await;

        assert_eq!(result, Err(DownloadError::Cancelled));
        let partial = fs::read(&path).await.expect("read partial bytes");
        assert!(!partial.is_empty());
        assert!(partial.len() < body.len());
    }

    #[tokio::test]
    async fn corruption_fails_closed_and_removes_complete_staging() {
        let body = b"corrupt bytes".to_vec();
        let server = TestServer::one_request(body.clone(), None);
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = staging_path(&directory);
        let expected = AssetIntegrity::new(body.len() as u64, "a".repeat(64)).expect("integrity");

        let result = loopback_downloader(1024)
            .download_to_staging(
                &server.url,
                &path,
                &expected,
                &CancellationToken::new(),
                |_| {},
            )
            .await;

        assert_eq!(result, Err(DownloadError::HashMismatch));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn rejects_unsafe_sources_and_declared_oversize_before_network() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = staging_path(&directory);
        let body = b"asset";
        let unsafe_source = Url::parse("http://models.example.invalid/asset.bin").expect("URL");
        let downloader = NativeDownloader::new(DownloadPolicy::https_only(4).expect("policy"))
            .expect("downloader");

        assert_eq!(
            downloader
                .download_to_staging(
                    &unsafe_source,
                    &path,
                    &integrity(body),
                    &CancellationToken::new(),
                    |_| {},
                )
                .await,
            Err(DownloadError::UnsafeSource)
        );

        let https_source = Url::parse("https://models.example.invalid/asset.bin").expect("URL");
        assert_eq!(
            downloader
                .download_to_staging(
                    &https_source,
                    &path,
                    &integrity(body),
                    &CancellationToken::new(),
                    |_| {},
                )
                .await,
            Err(DownloadError::ResourceLimit)
        );
    }

    #[tokio::test]
    async fn rejects_redirects_to_an_unsafe_source() {
        let response = b"HTTP/1.1 302 Found\r\nLocation: http://models.example.invalid/model.bin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let server = TestServer::delayed_response(response, Duration::ZERO, Vec::new());
        let directory = tempfile::tempdir().expect("temporary directory");
        let result = loopback_downloader(1024)
            .download_to_staging(
                &server.url,
                &staging_path(&directory),
                &integrity(b"asset"),
                &CancellationToken::new(),
                |_| {},
            )
            .await;

        assert_eq!(result, Err(DownloadError::UnsafeSource));
    }

    #[tokio::test]
    async fn request_timeout_bounds_stalled_response_headers() {
        let server = TestServer::delayed_response(
            Vec::new(),
            Duration::from_millis(100),
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nasset".to_vec(),
        );
        let directory = tempfile::tempdir().expect("temporary directory");
        let result = loopback_downloader_with_timeouts(
            1024,
            Duration::from_millis(20),
            Duration::from_secs(1),
        )
        .download_to_staging(
            &server.url,
            &staging_path(&directory),
            &integrity(b"asset"),
            &CancellationToken::new(),
            |_| {},
        )
        .await;

        assert_eq!(result, Err(DownloadError::Timeout));
    }

    #[tokio::test]
    async fn idle_timeout_bounds_stalled_response_bodies() {
        let server = TestServer::delayed_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n".to_vec(),
            Duration::from_millis(100),
            b"asset".to_vec(),
        );
        let directory = tempfile::tempdir().expect("temporary directory");
        let result = loopback_downloader_with_timeouts(
            1024,
            Duration::from_secs(1),
            Duration::from_millis(20),
        )
        .download_to_staging(
            &server.url,
            &staging_path(&directory),
            &integrity(b"asset"),
            &CancellationToken::new(),
            |_| {},
        )
        .await;

        assert_eq!(result, Err(DownloadError::Timeout));
    }

    #[test]
    fn redirect_policy_rejects_downgrades_and_excessive_hops() {
        let https_source = Url::parse("https://models.example.invalid/model.bin").expect("URL");
        let http_target = Url::parse("http://127.0.0.1/model.bin").expect("URL");
        let https_target = Url::parse("https://cdn.example.invalid/model.bin").expect("URL");

        assert!(!redirect_is_allowed(
            Some(&https_source),
            &http_target,
            1,
            true
        ));
        assert!(!redirect_is_allowed(
            Some(&https_source),
            &https_target,
            5,
            false
        ));
        assert!(redirect_is_allowed(
            Some(&https_source),
            &https_target,
            1,
            false
        ));
    }

    #[test]
    fn android_model_download_hosts_are_closed_to_the_github_release_path() {
        for allowed in [
            "github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
            "GITHUB.COM",
        ] {
            assert!(android_model_download_host_allowed(allowed), "{allowed}");
        }
        for denied in [
            "raw.githubusercontent.com",
            "github.example",
            "github.com.example",
            "localhost",
            "127.0.0.1",
        ] {
            assert!(!android_model_download_host_allowed(denied), "{denied}");
        }
    }

    #[test]
    fn dns_pinning_rejects_private_and_special_addresses() {
        for denied in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            let address = denied.parse().expect("fixture IP address");
            assert!(!ip_is_permitted(address, false), "{denied}");
        }
        assert!(ip_is_permitted(
            "8.8.8.8".parse().expect("public IPv4"),
            false
        ));
        assert!(ip_is_permitted(
            "2606:4700:4700::1111".parse().expect("public IPv6"),
            false
        ));
        assert!(ip_is_permitted(
            "127.0.0.1".parse().expect("loopback IPv4"),
            true
        ));
    }

    #[test]
    fn errors_do_not_disclose_source_or_staging_path() {
        let rendered = [
            DownloadError::UnsafeSource,
            DownloadError::Request,
            DownloadError::Timeout,
            DownloadError::Staging { operation: "write" },
            DownloadError::HashMismatch,
        ]
        .into_iter()
        .map(|error| error.to_string())
        .collect::<Vec<_>>()
        .join(" ");

        assert!(!rendered.contains("models.example.invalid"));
        assert!(!rendered.contains("Bearer"));
        assert!(!rendered.contains("asset.part"));
        assert!(!rendered.contains("raw_audio"));
    }
}
