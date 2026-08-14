"""TTS voice catalog and on-demand pack installation helpers."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import http.client
import ipaddress
import os
import shutil
import socket
import ssl
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal
from urllib.parse import quote, unquote, urljoin, urlparse

from pydantic import ValidationError

from app.services.tts.voice_registry import (
    VoicePackManifest,
    VoiceProfileInventoryEntry,
    VoiceRegistry,
    VoiceRegistryError,
)
from app.shared.path_utils import resolve_path

_MAX_MANIFEST_BYTES = 512 * 1024
_DEFAULT_MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024
_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
_LOCAL_HTTP_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
_MAX_REDIRECTS = 5
_MAX_SIGNATURE_BYTES = 64
_MAX_PUBLIC_KEY_BYTES = 32
_ED25519_P = 2**255 - 19
_ED25519_Q = 2**252 + 27742317777372353535851937790883648493
_ED25519_D = -121665 * pow(121666, -1, _ED25519_P) % _ED25519_P
_ED25519_I = pow(2, (_ED25519_P - 1) // 4, _ED25519_P)
_ED25519_BASE_Y = 4 * pow(5, -1, _ED25519_P) % _ED25519_P


class VoiceCatalogError(ValueError):
    """Base class for sanitized voice catalog failures."""


class VoiceCatalogSourceError(VoiceCatalogError):
    """Raised when a configured catalog source is unavailable or invalid."""


class VoiceCatalogDownloadError(VoiceCatalogError):
    """Raised when a catalog artifact cannot be downloaded and verified."""


@dataclass(frozen=True)
class VoiceCatalogItem:
    """Management-safe catalog row for a standard voice pack entry."""

    voice_id: str
    display_name: str
    language_bundle: str
    compatibility_group: str
    runtime_target: str
    artifact_revision: str
    installed: bool
    ready: bool
    license_name: str
    attribution: str | None
    source: Literal["local", "remote"]


@dataclass(frozen=True)
class VoiceCatalogInstallResult:
    """Result of installing one catalog voice through the local registry."""

    entry: VoiceProfileInventoryEntry
    reused_cached_artifact: bool


class VoiceCatalogInstaller:
    """Resolve local/remote voice manifests and stage verified artifacts for install."""

    def __init__(
        self,
        *,
        manifest_path: str | None,
        asset_base_url: str | None,
        cache_dir: Path | str,
        registry: VoiceRegistry,
        allow_local_http: bool = False,
        max_cache_bytes: int = _DEFAULT_MAX_CACHE_BYTES,
        trusted_manifest_sha256: str | None = None,
        trusted_manifest_public_keys: tuple[str, ...] | list[str] | None = None,
        trusted_manifest_signature: str | None = None,
    ) -> None:
        self.manifest_path = manifest_path or "voice_models/voices.manifest.json"
        self.asset_base_url = asset_base_url
        self.cache_dir = Path(cache_dir)
        self.registry = registry
        self.allow_local_http = allow_local_http
        self.trusted_manifest_sha256 = trusted_manifest_sha256
        self.trusted_manifest_public_keys = tuple(trusted_manifest_public_keys or ())
        self.trusted_manifest_signature = trusted_manifest_signature
        if max_cache_bytes <= 0:
            raise ValueError("voice catalog cache limit must be positive")
        self.max_cache_bytes = max_cache_bytes
        self._downloads_dir = self.cache_dir / "downloads"
        self._stage_dir = self.cache_dir / ".catalog-stage"
        self._cache_lock = threading.RLock()

    async def list_items(self) -> tuple[VoiceCatalogItem, ...]:
        """Return local/remote catalog rows merged with installed registry state."""
        manifest, source = await asyncio.to_thread(self._load_manifest)
        installed = {
            (item.voice_id, item.runtime_target, item.language_bundle, item.compatibility_group)
            for item in await self.registry.inventory()
            if item.ready_state == "ready"
        }
        rows = [
            VoiceCatalogItem(
                voice_id=asset.logical_voice_id,
                display_name=asset.display_name,
                language_bundle=asset.language_bundle,
                compatibility_group=asset.compatibility_group,
                runtime_target=asset.runtime_target,
                artifact_revision=asset.artifact_revision,
                installed=(
                    asset.logical_voice_id,
                    asset.runtime_target,
                    asset.language_bundle,
                    asset.compatibility_group,
                )
                in installed,
                ready=(
                    asset.logical_voice_id,
                    asset.runtime_target,
                    asset.language_bundle,
                    asset.compatibility_group,
                )
                in installed,
                license_name=asset.license_name,
                attribution=asset.attribution,
                source=source,
            )
            for asset in manifest.assets
        ]
        return tuple(sorted(rows, key=lambda row: (row.voice_id, row.language_bundle)))

    async def install_voice(self, voice_id: str) -> VoiceCatalogInstallResult:
        """Download/cache the selected voice artifact and install it atomically."""
        return await asyncio.to_thread(self._install_voice_sync, voice_id)

    def _install_voice_sync(self, voice_id: str) -> VoiceCatalogInstallResult:
        manifest, _source = self._load_manifest()
        matching_assets = [asset for asset in manifest.assets if asset.logical_voice_id == voice_id]
        if not matching_assets:
            raise VoiceCatalogSourceError("voice is not listed in the catalog")
        if len(matching_assets) > 1:
            raise VoiceCatalogSourceError("catalog contains duplicate voice entries")
        asset = matching_assets[0]
        cached_artifact, reused = self._materialize_artifact(
            asset.relative_path,
            asset.sha256,
            asset.size_bytes,
        )
        staged_root = self._stage_dir / f"install.{uuid.uuid4().hex}"
        try:
            artifact_target = staged_root / asset.relative_path
            artifact_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cached_artifact, artifact_target)
            subset_manifest = manifest.model_copy(update={"assets": (asset,)})
            manifest_target = staged_root / "voices.manifest.json"
            manifest_target.write_text(subset_manifest.model_dump_json(indent=2), encoding="utf-8")
            installed = self._install_standard_pack_sync(manifest_target, staged_root)
        finally:
            if staged_root.exists():
                shutil.rmtree(staged_root)
        entry = next((item for item in installed if item.voice_id == voice_id), None)
        if entry is None:
            raise VoiceCatalogSourceError("installed voice was not returned by registry")
        return VoiceCatalogInstallResult(entry=entry, reused_cached_artifact=reused)

    def _install_standard_pack_sync(
        self, manifest_path: Path, artifact_root: Path
    ) -> tuple[VoiceProfileInventoryEntry, ...]:
        return asyncio.run(self.registry.install_standard_pack(manifest_path, artifact_root))

    def _load_manifest(self) -> tuple[VoicePackManifest, Literal["local", "remote"]]:
        if _is_url(self.manifest_path):
            try:
                payload = _download_bytes(
                    self.manifest_path,
                    max_bytes=_MAX_MANIFEST_BYTES,
                    allow_local_http=self.allow_local_http,
                )
            except (OSError, VoiceCatalogDownloadError) as exc:
                raise VoiceCatalogSourceError("voice catalog is unavailable") from exc
            try:
                _verify_remote_manifest_payload(
                    payload,
                    trusted_sha256=self.trusted_manifest_sha256,
                    trusted_public_keys=self.trusted_manifest_public_keys,
                    signature=self.trusted_manifest_signature,
                )
            except VoiceCatalogDownloadError as exc:
                raise VoiceCatalogSourceError("voice catalog trust could not be verified") from exc
            source: Literal["local", "remote"] = "remote"
        else:
            source = "local"
            manifest_file = resolve_path(self.manifest_path)
            if not manifest_file.is_file():
                raise VoiceCatalogSourceError("voice catalog is unavailable")
            if manifest_file.stat().st_size > _MAX_MANIFEST_BYTES:
                raise VoiceCatalogSourceError("voice catalog is too large")
            payload = manifest_file.read_bytes()
        try:
            manifest = VoicePackManifest.model_validate_json(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValidationError, ValueError) as exc:
            raise VoiceCatalogSourceError("voice catalog is invalid") from exc
        return manifest, source

    def _materialize_artifact(
        self,
        relative_path: str,
        expected_sha256: str,
        expected_size: int,
    ) -> tuple[Path, bool]:
        with self._cache_lock:
            cached = self._cached_artifact_path(expected_sha256, relative_path)
            self._validate_cache_target(cached)
            if _verified_cached_file(cached, expected_sha256, expected_size):
                return cached, True
            if cached.exists() or cached.is_symlink():
                cached.unlink()
            source = self._artifact_source(relative_path)
            self._reserve_cache_space(expected_size, preserve=cached)
            cached.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._validate_cache_target(cached)
            tmp_path = cached.with_name(f".{cached.name}.{uuid.uuid4().hex}.tmp")
            try:
                if _is_url(source):
                    _download_to_path(
                        source,
                        tmp_path,
                        expected_size=expected_size,
                        allow_local_http=self.allow_local_http,
                    )
                else:
                    local_source = resolve_path(source)
                    if not local_source.is_file() or local_source.is_symlink():
                        raise VoiceCatalogDownloadError("voice artifact is unavailable")
                    _copy_exact(local_source, tmp_path, expected_size=expected_size)
                digest = _file_sha256(tmp_path)
                if digest != expected_sha256:
                    raise VoiceCatalogDownloadError("voice artifact hash mismatch")
                os.replace(tmp_path, cached)
                _fsync_dir(cached.parent)
                return cached, False
            finally:
                if tmp_path.exists() or tmp_path.is_symlink():
                    tmp_path.unlink()

    def _reserve_cache_space(self, required_bytes: int, *, preserve: Path) -> None:
        if required_bytes < 0 or required_bytes > self.max_cache_bytes:
            raise VoiceCatalogDownloadError("voice artifact exceeds cache limit")
        if not self._downloads_dir.exists():
            return
        candidates: list[tuple[float, int, Path]] = []
        total = 0
        for path in self._downloads_dir.rglob("*"):
            if path == preserve or path.is_symlink() or not path.is_file():
                continue
            stat_result = path.stat()
            total += stat_result.st_size
            candidates.append((stat_result.st_mtime, stat_result.st_size, path))
        for _modified, size, path in sorted(candidates):
            if total + required_bytes <= self.max_cache_bytes:
                break
            path.unlink(missing_ok=True)
            total -= size
        if total + required_bytes > self.max_cache_bytes:
            raise VoiceCatalogDownloadError("voice catalog cache is full")

    def _validate_cache_target(self, target: Path) -> None:
        root = self._downloads_dir.resolve(strict=False)
        resolved_target = target.resolve(strict=False)
        if not resolved_target.is_relative_to(root):
            raise VoiceCatalogDownloadError("voice artifact cache path is unsafe")
        current = self._downloads_dir
        relative_parent = target.parent.relative_to(self._downloads_dir)
        for part in relative_parent.parts:
            if current.is_symlink():
                raise VoiceCatalogDownloadError("voice artifact cache path is unsafe")
            current = current / part
        if current.is_symlink() or target.is_symlink():
            raise VoiceCatalogDownloadError("voice artifact cache path is unsafe")

    def _artifact_source(self, relative_path: str) -> str:
        _safe_relative_path(relative_path)
        if self.asset_base_url:
            if _is_url(self.asset_base_url):
                _validate_download_url(
                    self.asset_base_url,
                    allow_local_http=self.allow_local_http,
                )
                quoted = "/".join(quote(part) for part in PurePosixPath(relative_path).parts)
                source = urljoin(self.asset_base_url.rstrip("/") + "/", quoted)
                _validate_download_url(source, allow_local_http=self.allow_local_http)
                return source
            return str(resolve_path(self.asset_base_url) / Path(relative_path))
        if _is_url(self.manifest_path):
            return urljoin(self.manifest_path.rsplit("/", 1)[0] + "/", relative_path)
        return str(resolve_path(self.manifest_path).parent / Path(relative_path))

    def _cached_artifact_path(self, expected_sha256: str, relative_path: str) -> Path:
        _validate_sha256(expected_sha256)
        safe_parts = _safe_relative_path(relative_path).parts
        return self._downloads_dir / expected_sha256 / Path(*safe_parts)


def _is_url(value: str | None) -> bool:
    if not value:
        return False
    return urlparse(value).scheme in {"http", "https"}


def _validate_download_url(url: str, *, allow_local_http: bool = False) -> None:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    allowed = parsed.scheme == "https" or (
        allow_local_http and parsed.scheme == "http" and hostname in _LOCAL_HTTP_HOSTS
    )
    if not allowed:
        raise VoiceCatalogDownloadError("voice catalog download URL is not allowed")
    if parsed.username or parsed.password or parsed.fragment:
        raise VoiceCatalogDownloadError("voice catalog download URL is not allowed")
    if not parsed.netloc:
        raise VoiceCatalogDownloadError("voice catalog download URL is invalid")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise VoiceCatalogDownloadError("voice catalog download URL is invalid") from exc
    if allow_local_http and hostname in _LOCAL_HTTP_HOSTS:
        return
    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise VoiceCatalogDownloadError("voice catalog host could not be resolved") from exc
    if not addresses:
        raise VoiceCatalogDownloadError("voice catalog host could not be resolved")
    for address in addresses:
        try:
            resolved = ipaddress.ip_address(address[4][0])
        except ValueError as exc:
            raise VoiceCatalogDownloadError("voice catalog host address is invalid") from exc
        if not resolved.is_global:
            raise VoiceCatalogDownloadError("voice catalog host address is not allowed")


def _resolve_download_ip(url: str, *, allow_local_http: bool = False) -> str | None:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    if allow_local_http and parsed.scheme == "http" and hostname in _LOCAL_HTTP_HOSTS:
        return None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise VoiceCatalogDownloadError("voice catalog host could not be resolved") from exc
    if not addresses:
        raise VoiceCatalogDownloadError("voice catalog host could not be resolved")
    selected: str | None = None
    for address in addresses:
        candidate = address[4][0]
        try:
            resolved = ipaddress.ip_address(candidate)
        except ValueError as exc:
            raise VoiceCatalogDownloadError("voice catalog host address is invalid") from exc
        if not resolved.is_global:
            raise VoiceCatalogDownloadError("voice catalog host address is not allowed")
        selected = candidate
    if selected is None:
        raise VoiceCatalogDownloadError("voice catalog host could not be resolved")
    return selected


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, *, connect_host: str, **kwargs: object) -> None:
        self._connect_host = connect_host
        super().__init__(hostname, **kwargs)

    def connect(self) -> None:
        sock = socket.create_connection(
            (self._connect_host, self.port),
            self.timeout,
            self.source_address,
        )
        try:
            if self._tunnel_host:
                self.sock = sock
                self._tunnel()
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            raise


class _DownloadResponse:
    def __init__(self, response: http.client.HTTPResponse, connection: http.client.HTTPConnection, url: str) -> None:
        self._response = response
        self._connection = connection
        self._url = url
        self.headers = dict(response.getheaders())

    def read(self, size: int = -1) -> bytes:
        return self._response.read(size)

    def geturl(self) -> str:
        return self._url

    def close(self) -> None:
        self._response.close()
        self._connection.close()

    def __enter__(self) -> _DownloadResponse:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


def _open_download(
    url: str, *, timeout: int, allow_local_http: bool, redirect_count: int = 0
) -> _DownloadResponse:
    if redirect_count > _MAX_REDIRECTS:
        raise VoiceCatalogDownloadError("voice catalog redirected too many times")
    _validate_download_url(url, allow_local_http=allow_local_http)
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    if parsed.scheme == "https":
        connect_host = _resolve_download_ip(url, allow_local_http=allow_local_http)
        if connect_host is None:
            raise VoiceCatalogDownloadError("voice catalog host address is invalid")
        connection: http.client.HTTPConnection = _PinnedHTTPSConnection(
            hostname,
            connect_host=connect_host,
            port=port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
    else:
        connection = http.client.HTTPConnection(hostname, port=port, timeout=timeout)
    connection.request(
        "GET",
        path,
        headers={
            "Host": parsed.netloc,
            "User-Agent": "AuroraVoiceCatalog/1",
            "Accept": "application/octet-stream, application/json",
        },
    )
    response = connection.getresponse()
    if response.status in {301, 302, 303, 307, 308}:
        location = response.getheader("Location")
        response.close()
        connection.close()
        if not location:
            raise VoiceCatalogDownloadError("voice catalog redirect is invalid")
        redirected_url = urljoin(url, location)
        _validate_download_url(redirected_url, allow_local_http=allow_local_http)
        return _open_download(
            redirected_url,
            timeout=timeout,
            allow_local_http=allow_local_http,
            redirect_count=redirect_count + 1,
        )
    if response.status < 200 or response.status >= 300:
        response.close()
        connection.close()
        raise VoiceCatalogDownloadError("voice catalog download failed")
    return _DownloadResponse(response, connection, url)


def _download_bytes(url: str, *, max_bytes: int, allow_local_http: bool = False) -> bytes:
    with _open_download(url, timeout=30, allow_local_http=allow_local_http) as response:
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError as exc:
                raise VoiceCatalogDownloadError("voice catalog size is invalid") from exc
            if declared_size < 0 or declared_size > max_bytes:
                raise VoiceCatalogDownloadError("voice catalog download exceeded size limit")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = response.read(_DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise VoiceCatalogDownloadError("voice catalog download exceeded size limit")
            chunks.append(chunk)
    return b"".join(chunks)


def _download_to_path(
    url: str,
    target: Path,
    *,
    expected_size: int,
    allow_local_http: bool = False,
) -> None:
    with (
        _open_download(url, timeout=120, allow_local_http=allow_local_http) as response,
        target.open("xb") as handle,
    ):
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError as exc:
                raise VoiceCatalogDownloadError("voice artifact size is invalid") from exc
            if declared_size != expected_size:
                raise VoiceCatalogDownloadError("voice artifact size mismatch")
        total = 0
        while True:
            chunk = response.read(_DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size:
                raise VoiceCatalogDownloadError("voice artifact size mismatch")
            handle.write(chunk)
        if total != expected_size:
            raise VoiceCatalogDownloadError("voice artifact size mismatch")
        handle.flush()
        os.fsync(handle.fileno())


def _verify_remote_manifest_payload(
    payload: bytes,
    *,
    trusted_sha256: str | None,
    trusted_public_keys: tuple[str, ...],
    signature: str | None,
) -> None:
    digest = hashlib.sha256(payload).hexdigest()
    digest_verified = False
    if trusted_sha256:
        _validate_sha256(trusted_sha256)
        if digest != trusted_sha256:
            raise VoiceCatalogDownloadError("voice catalog digest mismatch")
        digest_verified = True
    signature_verified = False
    if signature or trusted_public_keys:
        if not signature or not trusted_public_keys:
            raise VoiceCatalogDownloadError("voice catalog signature trust is incomplete")
        signature_bytes = _decode_trust_bytes(signature, expected_length=_MAX_SIGNATURE_BYTES)
        for encoded_key in trusted_public_keys:
            public_key_bytes = _decode_trust_bytes(
                encoded_key,
                expected_length=_MAX_PUBLIC_KEY_BYTES,
            )
            if _ed25519_verify(public_key_bytes, signature_bytes, payload):
                signature_verified = True
                break
        if not signature_verified:
            raise VoiceCatalogDownloadError("voice catalog signature mismatch")
    if not digest_verified and not signature_verified:
        raise VoiceCatalogDownloadError("voice catalog trust is not configured")


def _decode_trust_bytes(value: str, *, expected_length: int) -> bytes:
    normalized = "".join(value.split())
    try:
        if len(normalized) == expected_length * 2 and all(
            char in "0123456789abcdefABCDEF" for char in normalized
        ):
            decoded = bytes.fromhex(normalized)
        else:
            decoded = base64.b64decode(normalized, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VoiceCatalogDownloadError("voice catalog trust material is invalid") from exc
    if len(decoded) != expected_length:
        raise VoiceCatalogDownloadError("voice catalog trust material is invalid")
    return decoded


def _ed25519_verify(public_key: bytes, signature: bytes, payload: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    encoded_r = signature[:32]
    s = int.from_bytes(signature[32:], "little")
    if s >= _ED25519_Q:
        return False
    try:
        public_point = _ed25519_decode_point(public_key)
        r_point = _ed25519_decode_point(encoded_r)
    except ValueError:
        return False
    challenge = int.from_bytes(
        hashlib.sha512(encoded_r + public_key + payload).digest(),
        "little",
    ) % _ED25519_Q
    left = _ed25519_scalar_mult(s, _ed25519_base_point())
    right = _ed25519_point_add(r_point, _ed25519_scalar_mult(challenge, public_point))
    return _ed25519_encode_point(left) == _ed25519_encode_point(right)


def _ed25519_base_point() -> tuple[int, int, int, int]:
    x = _ed25519_xrecover(_ED25519_BASE_Y)
    return (x, _ED25519_BASE_Y, 1, x * _ED25519_BASE_Y % _ED25519_P)


def _ed25519_xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(_ED25519_D * y * y + 1, -1, _ED25519_P)
    x = pow(xx, (_ED25519_P + 3) // 8, _ED25519_P)
    if (x * x - xx) % _ED25519_P != 0:
        x = (x * _ED25519_I) % _ED25519_P
    if x % 2 != 0:
        x = _ED25519_P - x
    return x


def _ed25519_decode_point(encoded: bytes) -> tuple[int, int, int, int]:
    y = int.from_bytes(encoded, "little") & ((1 << 255) - 1)
    sign = encoded[31] >> 7
    if y >= _ED25519_P:
        raise ValueError("invalid point")
    x = _ed25519_xrecover(y)
    if x & 1 != sign:
        x = _ED25519_P - x
    if (-x * x + y * y - 1 - _ED25519_D * x * x * y * y) % _ED25519_P != 0:
        raise ValueError("invalid point")
    return (x, y, 1, x * y % _ED25519_P)


def _ed25519_encode_point(point: tuple[int, int, int, int]) -> bytes:
    x, y, z, _t = point
    z_inv = pow(z, -1, _ED25519_P)
    affine_x = x * z_inv % _ED25519_P
    affine_y = y * z_inv % _ED25519_P
    encoded = bytearray(affine_y.to_bytes(32, "little"))
    encoded[31] |= (affine_x & 1) << 7
    return bytes(encoded)


def _ed25519_point_add(
    point_a: tuple[int, int, int, int],
    point_b: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = point_a
    x2, y2, z2, t2 = point_b
    a = (y1 - x1) * (y2 - x2) % _ED25519_P
    b = (y1 + x1) * (y2 + x2) % _ED25519_P
    c = 2 * _ED25519_D * t1 * t2 % _ED25519_P
    d = 2 * z1 * z2 % _ED25519_P
    e = b - a
    f = d - c
    g = d + c
    h = b + a
    return (e * f % _ED25519_P, g * h % _ED25519_P, f * g % _ED25519_P, e * h % _ED25519_P)


def _ed25519_scalar_mult(
    scalar: int,
    point: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    result = (0, 1, 1, 0)
    addend = point
    while scalar:
        if scalar & 1:
            result = _ed25519_point_add(result, addend)
        addend = _ed25519_point_add(addend, addend)
        scalar >>= 1
    return result


def _copy_exact(source: Path, target: Path, *, expected_size: int) -> None:
    if source.stat().st_size != expected_size:
        raise VoiceCatalogDownloadError("voice artifact size mismatch")
    total = 0
    with source.open("rb") as source_handle, target.open("xb") as target_handle:
        while True:
            chunk = source_handle.read(_DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size:
                raise VoiceCatalogDownloadError("voice artifact size mismatch")
            target_handle.write(chunk)
        if total != expected_size:
            raise VoiceCatalogDownloadError("voice artifact size mismatch")
        target_handle.flush()
        os.fsync(target_handle.fileno())


def _verified_cached_file(path: Path, expected_sha256: str, expected_size: int) -> bool:
    return (
        path.is_file()
        and not path.is_symlink()
        and path.stat().st_size == expected_size
        and _file_sha256(path) == expected_sha256
    )


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(_DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _validate_sha256(value: str) -> None:
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise VoiceCatalogDownloadError("voice artifact hash is invalid")


def _safe_relative_path(value: str) -> PurePosixPath:
    decoded = unquote(value)
    candidate = PurePosixPath(decoded)
    if candidate.is_absolute() or "\\" in decoded:
        raise VoiceCatalogDownloadError("voice artifact path is unsafe")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise VoiceCatalogDownloadError("voice artifact path is unsafe")
    return candidate


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
