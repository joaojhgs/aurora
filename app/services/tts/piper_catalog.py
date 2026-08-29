"""Pinned Piper voice catalog and on-demand model installation."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tarfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.services.tts.voice_catalog import (
    VoiceCatalogDownloadError,
    VoiceCatalogError,
    VoiceCatalogSourceError,
    _download_to_path,
    _file_sha256,
)
from app.services.tts.voice_registry import _fsync_dir
from app.shared.contracts.models.speech import (
    normalize_exact_speech_language,
    validate_logical_voice_id,
)
from app.shared.path_utils import resolve_path

CATALOG_RESOURCE = "sherpa_onnx_tts_catalog.json"
CATALOG_ID = "sherpa-onnx-tts-models-v1"
CATALOG_REVISION = "github-release-130612623-30d65b392bba8dfb"
ENTRIES_SHA256 = "64ed347bb69deb695ea50d363bdcad99779a2ffa0ecfea790af368056504e4fa"
SOURCE_CHECKSUM_SHA256 = "30d65b392bba8dfbdbc3479928d3f80adff2c71d4f518ce893d572b8aff021ee"
EXPECTED_ENTRY_COUNT = 537
EXPECTED_LANGUAGE_COUNT = 50
DEFAULT_CACHE_DIR = "voice_models/piper"
DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024 * 1024
DEFAULT_MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024
_MAX_CATALOG_BYTES = 2 * 1024 * 1024
_MAX_TAR_MEMBERS = 2048
_COMPONENT_RE = re.compile(r"^[a-z0-9][a-z0-9_.:+-]{0,191}$")


class PiperCatalogError(VoiceCatalogError):
    """Base class for sanitized Piper catalog failures."""


@dataclass(frozen=True)
class PiperCatalogVoice:
    """Redacted Piper catalog row."""

    voice_id: str
    display_name: str
    language: str
    revision: str
    installed: bool
    ready: bool
    sample_rate: int | None
    model_family: Literal["vits_piper", "pockettts"] = "vits_piper"


@dataclass(frozen=True)
class PiperResolvedVoice:
    """Provider-internal resolved Piper model binding."""

    voice_id: str
    display_name: str
    language: str
    revision: str
    model_file: Path
    config_file: Path
    tokens_file: Path
    data_dir: Path
    sample_rate: int


@dataclass(frozen=True)
class PiperCatalogInstallResult:
    """Result of installing one pinned Piper voice."""

    voice: PiperResolvedVoice
    reused_cached_archive: bool


class _ArchiveModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    asset_id: int
    byte_size: int = Field(gt=0, le=1024 * 1024 * 1024)
    filename: str = Field(min_length=1, max_length=240)
    format: Literal["tar_bzip2"]
    root: str = Field(min_length=1, max_length=240)
    sha256: str = Field(min_length=64, max_length=64)
    updated_at: str = Field(min_length=1, max_length=64)
    url: str = Field(min_length=1, max_length=512)

    @field_validator("filename", "root")
    @classmethod
    def _validate_archive_component(cls, value: str) -> str:
        _safe_relative_path(value)
        if "/" in value or value in {".", ".."}:
            raise ValueError("archive component must be a single relative name")
        return value

    @field_validator("sha256")
    @classmethod
    def _validate_sha256(cls, value: str) -> str:
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("invalid sha256")
        return value

    @field_validator("url")
    @classmethod
    def _validate_url(cls, value: str) -> str:
        if not value.startswith(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
        ):
            raise ValueError("unexpected archive url")
        return value


class _BindingsModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    model: str = Field(min_length=1, max_length=300)
    config: str = Field(min_length=1, max_length=300)
    tokens: str = Field(min_length=1, max_length=300)
    data_dir: str = Field(min_length=1, max_length=300)
    model_card: str | None = Field(default=None, min_length=1, max_length=300)

    @field_validator("model", "config", "tokens", "data_dir", "model_card")
    @classmethod
    def _validate_binding(cls, value: str | None) -> str | None:
        if value is None:
            return None
        _safe_relative_path(value)
        return value


class _PocketTTSBindingsModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    decoder: str = Field(min_length=1, max_length=300)
    encoder: str = Field(min_length=1, max_length=300)
    lm_flow: str = Field(min_length=1, max_length=300)
    lm_main: str = Field(min_length=1, max_length=300)
    text_conditioner: str = Field(min_length=1, max_length=300)
    token_scores_json: str = Field(min_length=1, max_length=300)
    vocab_json: str = Field(min_length=1, max_length=300)
    model_card: str | None = Field(default=None, min_length=1, max_length=300)

    @field_validator(
        "decoder",
        "encoder",
        "lm_flow",
        "lm_main",
        "text_conditioner",
        "token_scores_json",
        "vocab_json",
        "model_card",
    )
    @classmethod
    def _validate_binding(cls, value: str | None) -> str | None:
        if value is None:
            return None
        _safe_relative_path(value)
        return value


_CatalogBindingsModel = _BindingsModel | _PocketTTSBindingsModel


class _TermsModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    download_initiated_by_user: Literal[True]
    redistributed_by_aurora: Literal[False]
    source: str = Field(min_length=1, max_length=120)


class _CatalogEntryModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    archive: _ArchiveModel
    bindings: _CatalogBindingsModel
    display_name: str = Field(min_length=1, max_length=256)
    engine: Literal["sherpa_onnx"]
    language: str = Field(min_length=1, max_length=32)
    model_family: Literal["vits_piper", "pockettts"]
    precision: str | None = None
    quality: str | None = Field(default=None, min_length=1, max_length=32)
    sample_rate_hz: int | None = Field(default=None, ge=8000, le=192000)
    terms: _TermsModel
    voice_id: str = Field(min_length=1, max_length=160)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)

    @field_validator("language")
    @classmethod
    def _validate_language(cls, value: str) -> str:
        return normalize_exact_speech_language(value)

    @model_validator(mode="after")
    def _validate_bindings_under_root(self) -> _CatalogEntryModel:
        root = PurePosixPath(self.archive.root)
        if self.model_family == "vits_piper" and not isinstance(self.bindings, _BindingsModel):
            raise ValueError("Piper catalog entry has invalid bindings")
        if self.model_family == "pockettts" and not isinstance(
            self.bindings, _PocketTTSBindingsModel
        ):
            raise ValueError("PocketTTS catalog entry has invalid bindings")
        for value in self._binding_values():
            if value is None:
                continue
            path = PurePosixPath(value)
            if not path.parts or path.parts[0] != root.name:
                raise ValueError("binding is outside archive root")
        if self.archive.filename != self.archive.url.rsplit("/", 1)[-1]:
            raise ValueError("archive filename does not match URL")
        return self

    def _binding_values(self) -> tuple[str | None, ...]:
        if isinstance(self.bindings, _BindingsModel):
            return (
                self.bindings.model,
                self.bindings.config,
                self.bindings.tokens,
                self.bindings.data_dir,
                self.bindings.model_card,
            )
        return (
            self.bindings.decoder,
            self.bindings.encoder,
            self.bindings.lm_flow,
            self.bindings.lm_main,
            self.bindings.text_conditioner,
            self.bindings.token_scores_json,
            self.bindings.vocab_json,
            self.bindings.model_card,
        )


class _SourceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    checksum_asset_id: int
    checksum_asset_updated_at: str
    checksum_sha256: str
    published_at: str
    release_id: int
    repository: Literal["k2-fsa/sherpa-onnx"]
    tag: Literal["tts-models"]


class _CatalogModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    catalog_id: str
    entries: tuple[_CatalogEntryModel, ...]
    entries_sha256: str
    languages: tuple[str, ...]
    revision: str
    schema_version: Literal[1]
    source: _SourceModel


def _safe_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts:
        raise ValueError("unsafe relative path")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("unsafe relative path")
    return path


def _entries_digest(entries: tuple[_CatalogEntryModel, ...]) -> str:
    payload = [json.loads(entry.model_dump_json(exclude_none=False)) for entry in entries]
    return _sha256_bytes(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def _sha256_bytes(payload: bytes) -> str:
    import hashlib

    return hashlib.sha256(payload).hexdigest()


def _load_embedded_catalog_payload() -> bytes:
    resource = resources.files("app.services.tts.resources").joinpath(CATALOG_RESOURCE)
    payload = resource.read_bytes()
    if len(payload) > _MAX_CATALOG_BYTES:
        raise VoiceCatalogSourceError("voice catalog is unavailable")
    return payload


def load_piper_catalog(payload: bytes | None = None) -> _CatalogModel:
    """Load and authenticate the embedded Piper catalog."""
    raw = payload if payload is not None else _load_embedded_catalog_payload()
    try:
        raw_doc = json.loads(raw.decode("utf-8"))
        catalog = _CatalogModel.model_validate(raw_doc)
    except (UnicodeDecodeError, ValidationError, ValueError, TypeError) as exc:
        raise VoiceCatalogSourceError("voice catalog is unavailable") from exc
    raw_entries_digest = _sha256_bytes(
        json.dumps(raw_doc.get("entries"), separators=(",", ":")).encode("utf-8")
    )
    languages = tuple(normalize_exact_speech_language(item) for item in catalog.languages)
    if (
        catalog.catalog_id != CATALOG_ID
        or catalog.revision != CATALOG_REVISION
        or catalog.entries_sha256 != ENTRIES_SHA256
        or catalog.source.checksum_sha256 != SOURCE_CHECKSUM_SHA256
        or len(catalog.entries) != EXPECTED_ENTRY_COUNT
        or len(languages) != EXPECTED_LANGUAGE_COUNT
        or len(set(languages)) != EXPECTED_LANGUAGE_COUNT
        or raw_entries_digest != ENTRIES_SHA256
        or sorted(languages) != list(languages)
    ):
        raise VoiceCatalogSourceError("voice catalog is unavailable")
    voice_ids = [entry.voice_id for entry in catalog.entries]
    if len(voice_ids) != len(set(voice_ids)):
        raise VoiceCatalogSourceError("voice catalog is unavailable")
    return catalog


def _piper_catalog_entries(catalog: _CatalogModel) -> tuple[_CatalogEntryModel, ...]:
    return tuple(entry for entry in catalog.entries if entry.model_family == "vits_piper")


class PiperCatalogManager:
    """Install and resolve pinned Piper voice archives."""

    def __init__(
        self,
        *,
        cache_dir: str | Path = DEFAULT_CACHE_DIR,
        catalog_payload: bytes | None = None,
        allow_local_http: bool = False,
        max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
        max_extract_bytes: int = DEFAULT_MAX_EXTRACT_BYTES,
    ) -> None:
        if max_cache_bytes <= 0 or max_extract_bytes <= 0:
            raise ValueError("Piper catalog limits must be positive")
        self.cache_dir = Path(cache_dir)
        self.allow_local_http = allow_local_http
        self.max_cache_bytes = max_cache_bytes
        self.max_extract_bytes = max_extract_bytes
        self._downloads_dir = self.cache_dir / "downloads"
        self._installed_dir = self.cache_dir / "installed"
        self._stage_dir = self.cache_dir / ".stage"
        self._catalog_payload = catalog_payload

    async def list_voices(self) -> tuple[PiperCatalogVoice, ...]:
        """Return all catalog voices with local installed state."""
        return await asyncio.to_thread(self._list_voices_sync)

    async def list_catalog_voices(self) -> tuple[PiperCatalogVoice, ...]:
        """Return metadata for all shared Sherpa catalog voices."""
        return await asyncio.to_thread(self._list_catalog_voices_sync)

    async def install_voice(self, voice_id: str) -> PiperCatalogInstallResult:
        """Download/cache/extract one exact selected Piper voice."""
        return await asyncio.to_thread(self._install_voice_sync, voice_id)

    async def remove_voice(self, voice_id: str) -> bool:
        """Remove one installed Piper voice while preserving verified archive cache."""
        return await asyncio.to_thread(self._remove_voice_sync, voice_id)

    async def resolve_voice(self, voice_id: str) -> PiperResolvedVoice:
        """Resolve one installed Piper voice for provider runtime binding."""
        return await asyncio.to_thread(self._resolve_voice_sync, voice_id)

    def _catalog(self) -> _CatalogModel:
        return load_piper_catalog(self._catalog_payload)

    def _entry_by_voice_id(self, voice_id: str) -> _CatalogEntryModel | None:
        voice_id = validate_logical_voice_id(voice_id)
        return next(
            (
                entry
                for entry in _piper_catalog_entries(self._catalog())
                if entry.voice_id == voice_id
            ),
            None,
        )

    def _list_voices_sync(self) -> tuple[PiperCatalogVoice, ...]:
        rows: list[PiperCatalogVoice] = []
        for entry in _piper_catalog_entries(self._catalog()):
            resolved = self._resolve_voice_sync(entry.voice_id, missing_ok=True)
            rows.append(
                PiperCatalogVoice(
                    voice_id=entry.voice_id,
                    display_name=entry.display_name,
                    language=entry.language,
                    revision=CATALOG_REVISION,
                    model_family=entry.model_family,
                    installed=resolved is not None,
                    ready=resolved is not None,
                    sample_rate=resolved.sample_rate if resolved is not None else None,
                )
            )
        return tuple(rows)

    def _list_catalog_voices_sync(self) -> tuple[PiperCatalogVoice, ...]:
        rows: list[PiperCatalogVoice] = []
        for entry in self._catalog().entries:
            resolved = (
                self._resolve_voice_sync(entry.voice_id, missing_ok=True)
                if entry.model_family == "vits_piper"
                else None
            )
            rows.append(
                PiperCatalogVoice(
                    voice_id=entry.voice_id,
                    display_name=entry.display_name,
                    language=entry.language,
                    revision=CATALOG_REVISION,
                    model_family=entry.model_family,
                    installed=resolved is not None,
                    ready=resolved is not None,
                    sample_rate=(
                        resolved.sample_rate if resolved is not None else entry.sample_rate_hz
                    ),
                )
            )
        return tuple(rows)

    def _install_voice_sync(self, voice_id: str) -> PiperCatalogInstallResult:
        entry = self._entry_by_voice_id(voice_id)
        if entry is None:
            raise VoiceCatalogSourceError("voice is not listed in the catalog")
        existing = self._resolve_voice_sync(voice_id, missing_ok=True)
        if existing is not None:
            return PiperCatalogInstallResult(voice=existing, reused_cached_archive=True)
        archive_path, reused = self._materialize_archive(entry)
        install_root = self._voice_install_root(voice_id)
        stage_root = self._stage_dir / f"install.{uuid.uuid4().hex}"
        extract_root = stage_root / "payload"
        try:
            extract_root.mkdir(parents=True, exist_ok=False)
            _safe_extract_tar_bz2(
                archive_path,
                extract_root,
                expected_root=entry.archive.root,
                max_total_bytes=self.max_extract_bytes,
            )
            self._build_receipt(stage_root, extract_root, entry)
            install_root.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if install_root.exists() or install_root.is_symlink():
                shutil.rmtree(install_root)
            os.replace(stage_root, install_root)
            _fsync_dir(install_root.parent)
        except Exception:
            if stage_root.exists() or stage_root.is_symlink():
                shutil.rmtree(stage_root, ignore_errors=True)
            raise
        return PiperCatalogInstallResult(
            voice=self._resolve_voice_sync(voice_id),
            reused_cached_archive=reused,
        )

    def _remove_voice_sync(self, voice_id: str) -> bool:
        root = self._voice_install_root(validate_logical_voice_id(voice_id))
        if not root.exists():
            return False
        shutil.rmtree(root)
        _fsync_dir(root.parent)
        return True

    def _resolve_voice_sync(
        self, voice_id: str, *, missing_ok: bool = False
    ) -> PiperResolvedVoice | None:
        entry = self._entry_by_voice_id(voice_id)
        if entry is None:
            if missing_ok:
                return None
            raise VoiceCatalogSourceError("voice is not listed in the catalog")
        root = self._voice_install_root(entry.voice_id)
        receipt_path = root / "receipt.json"
        if not receipt_path.is_file() or receipt_path.is_symlink():
            if missing_ok:
                return None
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            if missing_ok:
                return None
            raise VoiceCatalogSourceError("Piper voice is unavailable") from exc
        try:
            resolved = self._resolved_from_receipt(root, receipt, entry)
        except VoiceCatalogError:
            if missing_ok:
                return None
            raise
        return resolved

    def _resolved_from_receipt(
        self, root: Path, receipt: dict[str, Any], entry: _CatalogEntryModel
    ) -> PiperResolvedVoice:
        if (
            receipt.get("catalog_id") != CATALOG_ID
            or receipt.get("catalog_revision") != CATALOG_REVISION
            or receipt.get("voice_id") != entry.voice_id
            or receipt.get("archive_sha256") != entry.archive.sha256
        ):
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        payload_root = root / "payload"
        model_file = _receipt_path(payload_root, receipt, "model")
        config_file = _receipt_path(payload_root, receipt, "config")
        tokens_file = _receipt_path(payload_root, receipt, "tokens")
        data_dir = _receipt_path(payload_root, receipt, "data_dir", directory=True)
        for field, path in (
            ("model", model_file),
            ("config", config_file),
            ("tokens", tokens_file),
        ):
            expected = receipt.get("files", {}).get(field)
            if not isinstance(expected, dict):
                raise VoiceCatalogSourceError("Piper voice is unavailable")
            if (
                not path.is_file()
                or path.is_symlink()
                or path.stat().st_size != expected.get("size")
                or _file_sha256(path) != expected.get("sha256")
            ):
                raise VoiceCatalogSourceError("Piper voice is unavailable")
        sample_rate = _piper_config_sample_rate(config_file)
        if sample_rate != receipt.get("sample_rate"):
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        return PiperResolvedVoice(
            voice_id=entry.voice_id,
            display_name=entry.display_name,
            language=entry.language,
            revision=CATALOG_REVISION,
            model_file=model_file,
            config_file=config_file,
            tokens_file=tokens_file,
            data_dir=data_dir,
            sample_rate=sample_rate,
        )

    def _build_receipt(
        self, stage_root: Path, extract_root: Path, entry: _CatalogEntryModel
    ) -> PiperResolvedVoice:
        if entry.model_family != "vits_piper" or not isinstance(entry.bindings, _BindingsModel):
            raise VoiceCatalogSourceError("voice is not listed in the catalog")
        model_file = _binding_path(extract_root, entry.bindings.model)
        config_file = _binding_path(extract_root, entry.bindings.config)
        tokens_file = _binding_path(extract_root, entry.bindings.tokens)
        data_dir = _binding_path(extract_root, entry.bindings.data_dir)
        if not model_file.is_file() or model_file.is_symlink():
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        if not config_file.is_file() or config_file.is_symlink():
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        if not tokens_file.is_file() or tokens_file.is_symlink():
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        if not data_dir.is_dir() or data_dir.is_symlink():
            raise VoiceCatalogSourceError("Piper voice is unavailable")
        sample_rate = _piper_config_sample_rate(config_file)
        receipt = {
            "catalog_id": CATALOG_ID,
            "catalog_revision": CATALOG_REVISION,
            "voice_id": entry.voice_id,
            "archive_sha256": entry.archive.sha256,
            "archive_size_bytes": entry.archive.byte_size,
            "display_name": entry.display_name,
            "language": entry.language,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "sample_rate": sample_rate,
            "paths": {
                "model": entry.bindings.model,
                "config": entry.bindings.config,
                "tokens": entry.bindings.tokens,
                "data_dir": entry.bindings.data_dir,
            },
            "files": {
                "model": _file_receipt(model_file),
                "config": _file_receipt(config_file),
                "tokens": _file_receipt(tokens_file),
            },
        }
        receipt_path = stage_root / "receipt.json"
        receipt_path.write_text(json.dumps(receipt, sort_keys=True, indent=2), encoding="utf-8")
        _fsync_dir(receipt_path.parent)
        return PiperResolvedVoice(
            voice_id=entry.voice_id,
            display_name=entry.display_name,
            language=entry.language,
            revision=CATALOG_REVISION,
            model_file=model_file,
            config_file=config_file,
            tokens_file=tokens_file,
            data_dir=data_dir,
            sample_rate=sample_rate,
        )

    def _materialize_archive(self, entry: _CatalogEntryModel) -> tuple[Path, bool]:
        if entry.archive.byte_size > self.max_cache_bytes:
            raise VoiceCatalogDownloadError("voice artifact exceeds cache limit")
        cached = self._archive_cache_path(entry)
        if (
            cached.is_file()
            and not cached.is_symlink()
            and cached.stat().st_size == entry.archive.byte_size
            and _file_sha256(cached) == entry.archive.sha256
        ):
            return cached, True
        if cached.exists() or cached.is_symlink():
            cached.unlink()
        self._reserve_cache_space(entry.archive.byte_size, preserve=cached)
        cached.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp_path = cached.with_name(f".{cached.name}.{uuid.uuid4().hex}.tmp")
        try:
            _download_to_path(
                entry.archive.url,
                tmp_path,
                expected_size=entry.archive.byte_size,
                allow_local_http=self.allow_local_http,
            )
            if _file_sha256(tmp_path) != entry.archive.sha256:
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

    def _archive_cache_path(self, entry: _CatalogEntryModel) -> Path:
        return self._downloads_dir / entry.archive.sha256 / entry.archive.filename

    def _voice_install_root(self, voice_id: str) -> Path:
        digest = _sha256_bytes(validate_logical_voice_id(voice_id).encode("utf-8"))
        return self._installed_dir / digest[:32]


def _file_receipt(path: Path) -> dict[str, object]:
    return {"size": path.stat().st_size, "sha256": _file_sha256(path)}


def _binding_path(root: Path, relative_path: str) -> Path:
    safe = _safe_relative_path(relative_path)
    path = root.joinpath(*safe.parts)
    if not path.resolve(strict=False).is_relative_to(root.resolve(strict=False)):
        raise VoiceCatalogSourceError("Piper voice is unavailable")
    return path


def _receipt_path(
    payload_root: Path, receipt: dict[str, Any], field: str, *, directory: bool = False
) -> Path:
    value = receipt.get("paths", {}).get(field)
    if not isinstance(value, str):
        raise VoiceCatalogSourceError("Piper voice is unavailable")
    path = _binding_path(payload_root, value)
    if directory:
        if not path.is_dir() or path.is_symlink():
            raise VoiceCatalogSourceError("Piper voice is unavailable")
    elif not path.is_file() or path.is_symlink():
        raise VoiceCatalogSourceError("Piper voice is unavailable")
    return path


def _piper_config_sample_rate(config_file: Path) -> int:
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VoiceCatalogSourceError("Piper voice is unavailable") from exc
    if not isinstance(config, dict):
        raise VoiceCatalogSourceError("Piper voice is unavailable")
    audio = config.get("audio")
    sample_rate = audio.get("sample_rate") if isinstance(audio, dict) else config.get("sample_rate")
    if not isinstance(sample_rate, int) or isinstance(sample_rate, bool):
        raise VoiceCatalogSourceError("Piper voice is unavailable")
    if sample_rate < 8000 or sample_rate > 192000:
        raise VoiceCatalogSourceError("Piper voice is unavailable")
    return sample_rate


def _safe_extract_tar_bz2(
    archive_path: Path,
    target_root: Path,
    *,
    expected_root: str,
    max_total_bytes: int,
) -> None:
    target_resolved = target_root.resolve(strict=False)
    seen: set[PurePosixPath] = set()
    total = 0
    try:
        with tarfile.open(archive_path, mode="r:bz2") as archive:
            members = archive.getmembers()
            if len(members) > _MAX_TAR_MEMBERS:
                raise VoiceCatalogDownloadError("voice artifact is unsafe")
            for member in members:
                member_path = _safe_relative_path(member.name)
                if member_path.parts[0] != expected_root:
                    raise VoiceCatalogDownloadError("voice artifact is unsafe")
                normalized_key = PurePosixPath(*member_path.parts)
                if normalized_key in seen:
                    raise VoiceCatalogDownloadError("voice artifact is unsafe")
                seen.add(normalized_key)
                if (
                    member.issym()
                    or member.islnk()
                    or member.ischr()
                    or member.isblk()
                    or member.isfifo()
                ):
                    raise VoiceCatalogDownloadError("voice artifact is unsafe")
                if not (member.isfile() or member.isdir()):
                    raise VoiceCatalogDownloadError("voice artifact is unsafe")
                if member.size < 0:
                    raise VoiceCatalogDownloadError("voice artifact is unsafe")
                if member.isfile():
                    total += member.size
                    if total > max_total_bytes:
                        raise VoiceCatalogDownloadError("voice artifact exceeds install limit")
                    destination = target_root.joinpath(*member_path.parts)
                    if not destination.resolve(strict=False).is_relative_to(target_resolved):
                        raise VoiceCatalogDownloadError("voice artifact is unsafe")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    source = archive.extractfile(member)
                    if source is None:
                        raise VoiceCatalogDownloadError("voice artifact is unsafe")
                    with source, destination.open("xb") as handle:
                        shutil.copyfileobj(source, handle, length=1024 * 1024)
                        handle.flush()
                        os.fsync(handle.fileno())
                else:
                    destination = target_root.joinpath(*member_path.parts)
                    if not destination.resolve(strict=False).is_relative_to(target_resolved):
                        raise VoiceCatalogDownloadError("voice artifact is unsafe")
                    destination.mkdir(parents=True, exist_ok=True)
    except (tarfile.TarError, OSError, ValueError) as exc:
        if isinstance(exc, VoiceCatalogError):
            raise
        raise VoiceCatalogDownloadError("voice artifact is unsafe") from exc


def piper_cache_dir_from_config(tts_cfg: object) -> Path:
    """Resolve Piper cache root from generated config with a safe default."""
    providers = getattr(tts_cfg, "providers", None)
    piper_cfg = getattr(providers, "piper", None) if providers is not None else None
    cache_dir = getattr(piper_cfg, "cache_dir", None) if piper_cfg is not None else None
    return resolve_path(cache_dir or DEFAULT_CACHE_DIR)
