"""Tests for pinned Piper catalog metadata and safe selected-voice installs."""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path
from typing import Any

import pytest

from app.services.tts.piper_catalog import (
    CATALOG_REVISION,
    ENTRIES_SHA256,
    EXPECTED_ENTRY_COUNT,
    EXPECTED_LANGUAGE_COUNT,
    PiperCatalogManager,
    _ArchiveModel,
    _BindingsModel,
    _CatalogEntryModel,
    _CatalogModel,
    _SourceModel,
    _TermsModel,
    load_piper_catalog,
)
from app.services.tts.voice_catalog import VoiceCatalogDownloadError, VoiceCatalogSourceError


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _tar_bz2(members: dict[str, bytes], *, link: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:bz2") as archive:
        for name, payload in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        if link is not None:
            info = tarfile.TarInfo(link)
            info.type = tarfile.SYMTYPE
            info.linkname = "/tmp/outside"
            archive.addfile(info)
    return buffer.getvalue()


def _catalog_for_archive(archive: bytes) -> _CatalogModel:
    archive_sha = _sha256(archive)
    entry = _CatalogEntryModel(
        archive=_ArchiveModel(
            asset_id=1,
            byte_size=len(archive),
            filename="vits-piper-en_US-test-low.tar.bz2",
            format="tar_bzip2",
            root="vits-piper-en_US-test-low",
            sha256=archive_sha,
            updated_at="2026-08-14T00:00:00Z",
            url=(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                "vits-piper-en_US-test-low.tar.bz2"
            ),
        ),
        bindings=_BindingsModel(
            model="vits-piper-en_US-test-low/en_US-test-low.onnx",
            config="vits-piper-en_US-test-low/en_US-test-low.onnx.json",
            tokens="vits-piper-en_US-test-low/tokens.txt",
            data_dir="vits-piper-en_US-test-low/espeak-ng-data",
            model_card="vits-piper-en_US-test-low/MODEL_CARD",
        ),
        display_name="Test low",
        engine="sherpa_onnx",
        language="en-us",
        model_family="vits_piper",
        precision=None,
        quality="low",
        terms=_TermsModel(
            download_initiated_by_user=True,
            redistributed_by_aurora=False,
            source="test",
        ),
        voice_id="standard:piper:en_us-test-low",
    )
    return _CatalogModel(
        catalog_id="sherpa-onnx-tts-models-v1",
        entries=(entry,),
        entries_sha256="unused-by-monkeypatch",
        languages=("en-us",),
        revision=CATALOG_REVISION,
        schema_version=1,
        source=_SourceModel(
            checksum_asset_id=1,
            checksum_asset_updated_at="2026-08-14T00:00:00Z",
            checksum_sha256="0" * 64,
            published_at="2023-11-21T07:43:51Z",
            release_id=130612623,
            repository="k2-fsa/sherpa-onnx",
            tag="tts-models",
        ),
    )


def _valid_archive() -> bytes:
    return _tar_bz2(
        {
            "vits-piper-en_US-test-low/en_US-test-low.onnx": b"model",
            "vits-piper-en_US-test-low/en_US-test-low.onnx.json": (
                b'{"audio": {"sample_rate": 16000}}'
            ),
            "vits-piper-en_US-test-low/tokens.txt": b"a\nb\n",
            "vits-piper-en_US-test-low/espeak-ng-data/phontab": b"data",
            "vits-piper-en_US-test-low/MODEL_CARD": b"card",
        }
    )


def test_embedded_piper_catalog_has_pinned_537_voice_50_language_metadata() -> None:
    catalog = load_piper_catalog()

    assert len(catalog.entries) == EXPECTED_ENTRY_COUNT == 537
    assert len(catalog.languages) == EXPECTED_LANGUAGE_COUNT == 50
    assert catalog.entries_sha256 == ENTRIES_SHA256
    assert catalog.revision == CATALOG_REVISION
    assert len({entry.voice_id for entry in catalog.entries}) == 537
    assert all(entry.archive.url.startswith("https://") for entry in catalog.entries)
    assert any(
        entry.voice_id == "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26"
        and entry.model_family == "pockettts"
        for entry in catalog.entries
    )


@pytest.mark.asyncio
async def test_piper_manager_keeps_pockettts_catalog_row_metadata_only(tmp_path: Path) -> None:
    manager = PiperCatalogManager(cache_dir=tmp_path / "cache")

    voices = await manager.list_voices()

    assert len(voices) == 536
    assert "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26" not in {
        voice.voice_id for voice in voices
    }
    with pytest.raises(VoiceCatalogSourceError, match="voice is not listed in the catalog"):
        await manager.install_voice("standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26")


def test_python_and_rust_piper_catalog_resources_stay_in_sync() -> None:
    python_catalog = Path("app/services/tts/resources/sherpa_onnx_tts_catalog.json")
    rust_catalog = Path("rust/crates/aurora-voice-engine/resources/sherpa_onnx_tts_catalog.json")

    assert python_catalog.read_bytes() == rust_catalog.read_bytes()


@pytest.mark.asyncio
async def test_install_downloads_exact_selected_voice_and_reuses_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _valid_archive()
    catalog = _catalog_for_archive(archive)
    calls: list[str] = []

    def fake_download(url: str, target: Path, **kwargs: Any) -> None:
        calls.append(url)
        target.write_bytes(archive)

    manager = PiperCatalogManager(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(manager, "_catalog", lambda: catalog)
    monkeypatch.setattr("app.services.tts.piper_catalog._download_to_path", fake_download)

    installed = await manager.install_voice("standard:piper:en_us-test-low")
    Path(catalog.entries[0].archive.filename).unlink(missing_ok=True)
    installed_again = await manager.install_voice("standard:piper:en_us-test-low")

    assert calls == [catalog.entries[0].archive.url]
    assert installed.reused_cached_archive is False
    assert installed_again.reused_cached_archive is True
    assert installed.voice.voice_id == "standard:piper:en_us-test-low"
    assert installed.voice.sample_rate == 16000
    assert installed.voice.model_file.is_file()
    assert installed.voice.tokens_file.is_file()
    assert installed.voice.data_dir.is_dir()


@pytest.mark.asyncio
async def test_installed_voice_tamper_is_not_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _valid_archive()
    catalog = _catalog_for_archive(archive)
    manager = PiperCatalogManager(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(manager, "_catalog", lambda: catalog)
    monkeypatch.setattr(
        "app.services.tts.piper_catalog._download_to_path",
        lambda _url, target, **_kwargs: target.write_bytes(archive),
    )
    installed = await manager.install_voice("standard:piper:en_us-test-low")
    installed.voice.config_file.write_text('{"audio": {"sample_rate": 22050}}', encoding="utf-8")

    voices = await manager.list_voices()
    with pytest.raises(VoiceCatalogSourceError, match="Piper voice is unavailable"):
        await manager.resolve_voice("standard:piper:en_us-test-low")

    assert [(voice.voice_id, voice.ready) for voice in voices] == [
        ("standard:piper:en_us-test-low", False)
    ]


@pytest.mark.asyncio
async def test_remove_preserves_verified_archive_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _valid_archive()
    catalog = _catalog_for_archive(archive)
    manager = PiperCatalogManager(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(manager, "_catalog", lambda: catalog)
    monkeypatch.setattr(
        "app.services.tts.piper_catalog._download_to_path",
        lambda _url, target, **_kwargs: target.write_bytes(archive),
    )

    await manager.install_voice("standard:piper:en_us-test-low")
    removed = await manager.remove_voice("standard:piper:en_us-test-low")

    assert removed is True
    assert (
        tmp_path
        / "cache"
        / "downloads"
        / catalog.entries[0].archive.sha256
        / catalog.entries[0].archive.filename
    ).is_file()
    assert (await manager.list_voices())[0].installed is False


@pytest.mark.asyncio
async def test_unsafe_tar_members_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _tar_bz2(
        {"vits-piper-en_US-test-low/en_US-test-low.onnx": b"model"},
        link="vits-piper-en_US-test-low/link",
    )
    catalog = _catalog_for_archive(archive)
    manager = PiperCatalogManager(cache_dir=tmp_path / "cache")
    monkeypatch.setattr(manager, "_catalog", lambda: catalog)
    monkeypatch.setattr(
        "app.services.tts.piper_catalog._download_to_path",
        lambda _url, target, **_kwargs: target.write_bytes(archive),
    )

    with pytest.raises(VoiceCatalogDownloadError, match="voice artifact is unsafe"):
        await manager.install_voice("standard:piper:en_us-test-low")


def test_catalog_rejects_redirect_or_non_global_host(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.tts.voice_catalog import _validate_download_url

    monkeypatch.setattr(
        "socket.getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("10.0.0.5", 443))],
    )

    with pytest.raises(VoiceCatalogDownloadError):
        _validate_download_url("https://example.invalid/model.tar.bz2")
