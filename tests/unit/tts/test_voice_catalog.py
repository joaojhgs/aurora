"""Tests for TTS voice catalog download and cache lifecycle."""

from __future__ import annotations

import hashlib
import json
import os
import struct
from pathlib import Path

import pytest

from app.services.tts.voice_catalog import (
    VoiceCatalogDownloadError,
    VoiceCatalogInstaller,
    VoiceCatalogSourceError,
)
from app.services.tts.voice_registry import VoiceRegistry


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safetensors_bytes() -> bytes:
    payload = b"\x00\x00\x80?\x00\x00\x00@"
    header = {
        "__metadata__": {"format": "aurora-test"},
        "speaker.embedding": {
            "dtype": "F32",
            "shape": [2],
            "data_offsets": [0, len(payload)],
        },
    }
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<Q", len(header_bytes)) + header_bytes + payload


def _manifest(data: bytes) -> dict[str, object]:
    return {
        "schema_version": 1,
        "pack_id": "starter_en",
        "pack_version": "2026.08.14",
        "minimum_aurora_version": "1",
        "minimum_runtime_version": "pockettts-1",
        "assets": [
            {
                "asset_id": "alba-state",
                "logical_voice_id": "standard:starter_en:alba",
                "display_name": "Alba",
                "runtime_target": "pockettts-python",
                "language_bundle": "en-us-compact",
                "compatibility_group": "pockettts-en-compact-v1",
                "artifact_revision": "rev-a",
                "feature": "voice-state",
                "size_bytes": len(data),
                "sha256": _sha256(data),
                "relative_path": "voices/alba.safetensors",
                "compression": "none",
                "unpacked_size_bytes": len(data),
                "license_name": "User Selected Test License",
                "attribution": "Aurora test fixture",
                "redistribution": "approved",
                "upstream_source": "test fixture",
            }
        ],
    }


@pytest.mark.asyncio
async def test_catalog_installs_selected_voice_and_reuses_cached_artifact(tmp_path: Path) -> None:
    data = _safetensors_bytes()
    source_root = tmp_path / "source"
    source_root.joinpath("voices").mkdir(parents=True)
    source_root.joinpath("voices/alba.safetensors").write_bytes(data)
    manifest_path = tmp_path / "voices.manifest.json"
    manifest_path.write_text(json.dumps(_manifest(data)), encoding="utf-8")
    registry = VoiceRegistry(tmp_path / "registry")
    installer = VoiceCatalogInstaller(
        manifest_path=str(manifest_path),
        asset_base_url=str(source_root),
        cache_dir=tmp_path / "cache",
        registry=registry,
    )

    catalog_before = await installer.list_items()
    installed = await installer.install_voice("standard:starter_en:alba")
    source_root.joinpath("voices/alba.safetensors").unlink()
    catalog_after = await installer.list_items()

    assert [(item.voice_id, item.installed, item.license_name) for item in catalog_before] == [
        ("standard:starter_en:alba", False, "User Selected Test License")
    ]
    assert installed.entry.voice_id == "standard:starter_en:alba"
    assert installed.reused_cached_artifact is False
    assert [(item.voice_id, item.installed) for item in catalog_after] == [
        ("standard:starter_en:alba", True)
    ]
    cached = tmp_path / "cache" / "downloads" / _sha256(data) / "voices/alba.safetensors"
    assert cached.read_bytes() == data
    assert [entry.voice_id for entry in await registry.inventory()] == ["standard:starter_en:alba"]


def test_catalog_rejects_non_https_non_localhost_download_urls(tmp_path: Path) -> None:
    installer = VoiceCatalogInstaller(
        manifest_path="https://example.invalid/voices.manifest.json",
        asset_base_url="http://example.invalid/assets",
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )

    with pytest.raises(VoiceCatalogDownloadError):
        installer._artifact_source("voices/alba.safetensors")


@pytest.mark.asyncio
async def test_catalog_rejects_local_artifact_with_wrong_declared_size(tmp_path: Path) -> None:
    data = _safetensors_bytes()
    manifest = _manifest(data)
    manifest["assets"][0]["size_bytes"] = len(data) + 1  # type: ignore[index]
    manifest["assets"][0]["unpacked_size_bytes"] = len(data) + 1  # type: ignore[index]
    source_root = tmp_path / "source"
    source_root.joinpath("voices").mkdir(parents=True)
    source_root.joinpath("voices/alba.safetensors").write_bytes(data)
    manifest_path = tmp_path / "voices.manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    installer = VoiceCatalogInstaller(
        manifest_path=str(manifest_path),
        asset_base_url=str(source_root),
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )

    with pytest.raises(VoiceCatalogDownloadError, match="size mismatch"):
        await installer.install_voice("standard:starter_en:alba")


@pytest.mark.asyncio
async def test_catalog_replaces_invalid_cached_artifact(tmp_path: Path) -> None:
    data = _safetensors_bytes()
    source_root = tmp_path / "source"
    source_root.joinpath("voices").mkdir(parents=True)
    source_root.joinpath("voices/alba.safetensors").write_bytes(data)
    manifest_path = tmp_path / "voices.manifest.json"
    manifest_path.write_text(json.dumps(_manifest(data)), encoding="utf-8")
    cache_path = tmp_path / "cache" / "downloads" / _sha256(data) / "voices/alba.safetensors"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_bytes(b"truncated")
    installer = VoiceCatalogInstaller(
        manifest_path=str(manifest_path),
        asset_base_url=str(source_root),
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )

    result = await installer.install_voice("standard:starter_en:alba")

    assert result.reused_cached_artifact is False
    assert cache_path.read_bytes() == data


def test_catalog_rejects_local_http_without_explicit_dev_override(tmp_path: Path) -> None:
    installer = VoiceCatalogInstaller(
        manifest_path="https://example.invalid/voices.manifest.json",
        asset_base_url="http://localhost:8080/assets",
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )

    with pytest.raises(VoiceCatalogDownloadError):
        installer._artifact_source("voices/alba.safetensors")


def test_catalog_rejects_private_https_hosts(tmp_path: Path) -> None:
    installer = VoiceCatalogInstaller(
        manifest_path="https://example.invalid/voices.manifest.json",
        asset_base_url="https://127.0.0.1/assets",
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )

    with pytest.raises(VoiceCatalogDownloadError, match="not allowed"):
        installer._artifact_source("voices/alba.safetensors")


@pytest.mark.asyncio
async def test_catalog_enforces_cache_limit_before_copy(tmp_path: Path) -> None:
    data = _safetensors_bytes()
    source_root = tmp_path / "source"
    source_root.joinpath("voices").mkdir(parents=True)
    source_root.joinpath("voices/alba.safetensors").write_bytes(data)
    manifest_path = tmp_path / "voices.manifest.json"
    manifest_path.write_text(json.dumps(_manifest(data)), encoding="utf-8")
    installer = VoiceCatalogInstaller(
        manifest_path=str(manifest_path),
        asset_base_url=str(source_root),
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
        max_cache_bytes=len(data) - 1,
    )

    with pytest.raises(VoiceCatalogDownloadError, match="cache limit"):
        await installer.install_voice("standard:starter_en:alba")


@pytest.mark.asyncio
async def test_catalog_rejects_cache_symlink_escape(tmp_path: Path) -> None:
    data = _safetensors_bytes()
    source_root = tmp_path / "source"
    source_root.joinpath("voices").mkdir(parents=True)
    source_root.joinpath("voices/alba.safetensors").write_bytes(data)
    manifest_path = tmp_path / "voices.manifest.json"
    manifest_path.write_text(json.dumps(_manifest(data)), encoding="utf-8")
    digest_dir = tmp_path / "cache" / "downloads" / _sha256(data)
    digest_dir.parent.mkdir(parents=True)
    digest_dir.symlink_to(tmp_path / "outside", target_is_directory=True)
    installer = VoiceCatalogInstaller(
        manifest_path=str(manifest_path),
        asset_base_url=str(source_root),
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )

    with pytest.raises(VoiceCatalogDownloadError, match="cache path is unsafe"):
        await installer.install_voice("standard:starter_en:alba")


def test_catalog_sanitizes_remote_source_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_download(*_args: object, **_kwargs: object) -> bytes:
        raise VoiceCatalogDownloadError("private upstream detail")

    installer = VoiceCatalogInstaller(
        manifest_path="https://catalog.example/voices.manifest.json",
        asset_base_url=None,
        cache_dir=tmp_path / "cache",
        registry=VoiceRegistry(tmp_path / "registry"),
    )
    monkeypatch.setattr(
        "app.services.tts.voice_catalog._download_bytes",
        fail_download,
    )

    with pytest.raises(VoiceCatalogSourceError, match="voice catalog is unavailable"):
        installer._load_manifest()
