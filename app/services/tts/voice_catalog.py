"""TTS voice catalog and on-demand pack installation helpers."""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

from pydantic import ValidationError

from app.services.tts.voice_registry import (
    VoicePackManifest,
    VoiceProfileInventoryEntry,
    VoiceRegistry,
    VoiceRegistryError,
)
from app.shared.path_utils import resolve_path

_MAX_MANIFEST_BYTES = 512 * 1024
_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
_LOCAL_HTTP_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


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
    ) -> None:
        self.manifest_path = manifest_path or "voice_models/voices.manifest.json"
        self.asset_base_url = asset_base_url
        self.cache_dir = Path(cache_dir)
        self.registry = registry
        self._downloads_dir = self.cache_dir / "downloads"
        self._stage_dir = self.cache_dir / ".catalog-stage"

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
        cached_artifact, reused = self._materialize_artifact(asset.relative_path, asset.sha256)
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
            payload = _download_bytes(self.manifest_path, max_bytes=_MAX_MANIFEST_BYTES)
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

    def _materialize_artifact(self, relative_path: str, expected_sha256: str) -> tuple[Path, bool]:
        cached = self._cached_artifact_path(expected_sha256, relative_path)
        if cached.is_file() and _file_sha256(cached) == expected_sha256:
            return cached, True
        source = self._artifact_source(relative_path)
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = cached.with_name(f".{cached.name}.{uuid.uuid4().hex}.tmp")
        try:
            if _is_url(source):
                _download_to_path(source, tmp_path)
            else:
                local_source = resolve_path(source)
                if not local_source.is_file():
                    raise VoiceCatalogDownloadError("voice artifact is unavailable")
                shutil.copyfile(local_source, tmp_path)
            digest = _file_sha256(tmp_path)
            if digest != expected_sha256:
                raise VoiceCatalogDownloadError("voice artifact hash mismatch")
            os.replace(tmp_path, cached)
            _fsync_dir(cached.parent)
            return cached, False
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    def _artifact_source(self, relative_path: str) -> str:
        _safe_relative_path(relative_path)
        if self.asset_base_url:
            if _is_url(self.asset_base_url):
                _validate_download_url(self.asset_base_url)
                quoted = "/".join(quote(part) for part in PurePosixPath(relative_path).parts)
                return urljoin(self.asset_base_url.rstrip("/") + "/", quoted)
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


def _validate_download_url(url: str) -> None:
    parsed = urlparse(url)
    allowed = parsed.scheme == "https" or (
        parsed.scheme == "http" and (parsed.hostname or "").lower() in _LOCAL_HTTP_HOSTS
    )
    if not allowed:
        raise VoiceCatalogDownloadError("voice catalog download URL is not allowed")
    if parsed.username or parsed.password or parsed.fragment:
        raise VoiceCatalogDownloadError("voice catalog download URL is not allowed")
    if not parsed.netloc:
        raise VoiceCatalogDownloadError("voice catalog download URL is invalid")


def _download_bytes(url: str, *, max_bytes: int) -> bytes:
    _validate_download_url(url)
    request = Request(url, headers={"User-Agent": "AuroraVoiceCatalog/1"})
    with urlopen(request, timeout=30) as response:
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


def _download_to_path(url: str, target: Path) -> None:
    _validate_download_url(url)
    request = Request(url, headers={"User-Agent": "AuroraVoiceCatalog/1"})
    with urlopen(request, timeout=120) as response, target.open("wb") as handle:
        while True:
            chunk = response.read(_DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())


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
