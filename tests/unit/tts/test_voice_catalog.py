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
