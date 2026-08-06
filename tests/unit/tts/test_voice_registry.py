"""Tests for the internal TTS voice registry."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path

import pytest

from app.services.tts.voice_registry import (
    VoiceArtifactError,
    VoiceBaseIdentity,
    VoiceManifestError,
    VoiceRegistry,
    VoiceSelectionError,
    validate_logical_voice_id,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _manifest(
    *,
    assets: list[dict[str, object]] | None = None,
    pack_id: str = "starter_en",
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "pack_id": pack_id,
        "pack_version": "2026.08.06",
        "minimum_aurora_version": "1.0.0",
        "minimum_runtime_version": "pockettts-1",
        "assets": assets or [],
    }


def _asset(
    data: bytes,
    *,
    voice: str = "alloy",
    path: str = "voices/alloy.state",
    runtime: str = "pockettts-python",
    language: str = "en-us-compact",
    compatibility: str = "pockettts-en-compact-v1",
    revision: str = "rev-a",
    redistribution: str = "approved",
) -> dict[str, object]:
    return {
        "asset_id": f"{voice}-state",
        "logical_voice_id": f"standard:starter_en:{voice}",
        "display_name": voice.title(),
        "runtime_target": runtime,
        "language_bundle": language,
        "compatibility_group": compatibility,
        "artifact_revision": revision,
        "feature": "voice-state",
        "size_bytes": len(data),
        "sha256": _sha256(data),
        "relative_path": path,
        "compression": "none",
        "unpacked_size_bytes": len(data),
        "license_name": "Redistribution Approved Test License",
        "attribution": "Aurora test fixture",
        "redistribution": redistribution,
        "upstream_source": "test fixture",
    }


def _write_manifest(path: Path, manifest: dict[str, object]) -> Path:
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    "voice_id, expected",
    [
        ("standard:starter_en:alloy", "standard"),
        ("clone:12345678-1234-4234-9234-123456789abc", "clone"),
    ],
)
def test_logical_voice_ids_are_stable_and_validated(voice_id: str, expected: str) -> None:
    assert validate_logical_voice_id(voice_id) == expected


@pytest.mark.parametrize(
    "voice_id",
    [
        "standard:Starter:alloy",
        "standard:starter_en:../alloy",
        "clone:not-a-uuid",
        "piper:default",
    ],
)
def test_invalid_logical_voice_ids_are_rejected(voice_id: str) -> None:
    with pytest.raises(VoiceManifestError):
        validate_logical_voice_id(voice_id)


@pytest.mark.asyncio
async def test_standard_pack_install_catalog_select_restart_and_delete(tmp_path: Path) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = b"verified voice state"
    artifact_root.joinpath("voices/alloy.state").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))

    installed = await registry.install_standard_pack(manifest_path, artifact_root)

    assert installed[0].voice_id == "standard:starter_en:alloy"
    assert installed[0].license_name == "Redistribution Approved Test License"
    identity = VoiceBaseIdentity(
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
    )
    catalog = await registry.catalog(identity)
    assert [entry.voice_id for entry in catalog] == ["standard:starter_en:alloy"]
    selected = await registry.select_voice("standard:starter_en:alloy", identity)
    assert selected.ready_state == "ready"
    promoted = tmp_path / "registry" / selected.artifact_refs[0]
    assert promoted.read_bytes() == data

    restarted = VoiceRegistry(tmp_path / "registry")
    assert [entry.voice_id for entry in await restarted.catalog(identity)] == [
        "standard:starter_en:alloy"
    ]

    await restarted.delete_voice("standard:starter_en:alloy")
    assert await restarted.inventory() == ()
    assert not promoted.exists()
    assert await VoiceRegistry(tmp_path / "registry").inventory() == ()


@pytest.mark.asyncio
async def test_two_ready_states_can_share_one_resident_identity(tmp_path: Path) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    alloy = b"alloy state"
    verse = b"verse state"
    artifact_root.joinpath("voices/alloy.state").write_bytes(alloy)
    artifact_root.joinpath("voices/verse.state").write_bytes(verse)
    manifest_path = _write_manifest(
        tmp_path / "manifest.json",
        _manifest(
            assets=[
                _asset(alloy, voice="alloy", path="voices/alloy.state"),
                _asset(verse, voice="verse", path="voices/verse.state", revision="rev-b"),
            ]
        ),
    )

    await registry.install_standard_pack(manifest_path, artifact_root)

    identity = VoiceBaseIdentity(
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
    )
    catalog = await registry.catalog(identity)
    assert {entry.voice_id for entry in catalog} == {
        "standard:starter_en:alloy",
        "standard:starter_en:verse",
    }
    assert (
        await registry.select_voice("standard:starter_en:alloy", identity)
    ).voice_id == "standard:starter_en:alloy"
    assert (
        await registry.select_voice("standard:starter_en:verse", identity)
    ).voice_id == "standard:starter_en:verse"


@pytest.mark.asyncio
async def test_selection_rejects_cross_language_runtime_and_compatibility_reuse(
    tmp_path: Path,
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = b"english state"
    artifact_root.joinpath("voices/alloy.state").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    await registry.install_standard_pack(manifest_path, artifact_root)

    incompatible_identities = [
        VoiceBaseIdentity("raven-webgpu", "en-us-compact", "pockettts-en-compact-v1"),
        VoiceBaseIdentity("pockettts-python", "fr-fr-compact", "pockettts-en-compact-v1"),
        VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-large-v2"),
    ]
    for identity in incompatible_identities:
        with pytest.raises(VoiceSelectionError):
            await registry.select_voice("standard:starter_en:alloy", identity)
        assert await registry.catalog(identity) == ()


@pytest.mark.asyncio
async def test_traversal_symlink_hash_and_size_fail_before_promotion(tmp_path: Path) -> None:
    registry_root = tmp_path / "registry"
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = b"safe state"
    artifact_root.joinpath("voices/alloy.state").write_bytes(data)

    traversal_manifest = _write_manifest(
        tmp_path / "traversal.json",
        _manifest(assets=[_asset(data, path="../outside.state")]),
    )
    with pytest.raises(VoiceManifestError):
        await VoiceRegistry(registry_root).install_standard_pack(traversal_manifest, artifact_root)

    outside = tmp_path / "outside.state"
    outside.write_bytes(data)
    symlink = artifact_root / "voices/link.state"
    symlink.symlink_to(outside)
    symlink_manifest = _write_manifest(
        tmp_path / "symlink.json",
        _manifest(assets=[_asset(data, path="voices/link.state")]),
    )
    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).install_standard_pack(symlink_manifest, artifact_root)

    bad_hash_manifest = _write_manifest(
        tmp_path / "bad-hash.json",
        _manifest(
            assets=[
                {
                    **_asset(data),
                    "sha256": _sha256(b"different"),
                }
            ]
        ),
    )
    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).install_standard_pack(bad_hash_manifest, artifact_root)

    bad_size_manifest = _write_manifest(
        tmp_path / "bad-size.json",
        _manifest(
            assets=[
                {
                    **_asset(data),
                    "size_bytes": len(data) + 1,
                    "unpacked_size_bytes": len(data) + 1,
                }
            ]
        ),
    )
    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).install_standard_pack(bad_size_manifest, artifact_root)

    assert not (registry_root / "voice_registry.json").exists()
    assert (
        not (registry_root / "artifacts").exists()
        or list((registry_root / "artifacts").iterdir()) == []
    )


@pytest.mark.asyncio
async def test_unapproved_or_missing_license_blocks_standard_voice(tmp_path: Path) -> None:
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = b"licensed state"
    artifact_root.joinpath("voices/alloy.state").write_bytes(data)

    unapproved_manifest = _write_manifest(
        tmp_path / "unapproved.json",
        _manifest(assets=[_asset(data, redistribution="restricted")]),
    )
    with pytest.raises(VoiceManifestError):
        await VoiceRegistry(tmp_path / "registry-a").install_standard_pack(
            unapproved_manifest, artifact_root
        )

    missing_license = _asset(data)
    del missing_license["license_name"]
    missing_manifest = _write_manifest(
        tmp_path / "missing-license.json", _manifest(assets=[missing_license])
    )
    with pytest.raises(VoiceManifestError):
        await VoiceRegistry(tmp_path / "registry-b").install_standard_pack(
            missing_manifest, artifact_root
        )


@pytest.mark.asyncio
async def test_clone_profiles_are_private_by_default_and_do_not_retain_source(
    tmp_path: Path,
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    clone_id = uuid.UUID("12345678-1234-4234-9234-123456789abc")

    created = await registry.create_clone_profile(
        display_name="My Voice",
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
        artifact_revision="clone-rev-a",
        artifact_bytes=b"derived state bytes",
        source_audio=b"raw-source-secret-never-store",
        clone_uuid=clone_id,
    )

    assert created.voice_id == f"clone:{clone_id}"
    assert created.visibility == "private"
    assert created.source_retained is False
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    assert await registry.catalog(identity) == ()
    assert [entry.voice_id for entry in await registry.catalog(identity, include_private=True)] == [
        f"clone:{clone_id}"
    ]
    selected = await registry.select_voice(f"clone:{clone_id}", identity)
    assert selected.kind == "clone"

    state_json = (tmp_path / "registry" / "voice_registry.json").read_text(encoding="utf-8")
    assert "raw-source-secret-never-store" not in state_json
    assert "derived state bytes" not in state_json


@pytest.mark.asyncio
async def test_atomic_promotion_failure_rolls_back_metadata_and_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = b"rollback state"
    artifact_root.joinpath("voices/alloy.state").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    original_replace = os.replace

    def fail_directory_promotion(src: Path | str, dst: Path | str) -> None:
        if Path(src).is_dir() and ".tmp" in Path(src).parts:
            raise OSError("simulated promotion failure")
        original_replace(src, dst)

    monkeypatch.setattr(os, "replace", fail_directory_promotion)

    with pytest.raises(OSError):
        await registry.install_standard_pack(manifest_path, artifact_root)

    assert await registry.inventory() == ()
    assert not (tmp_path / "registry" / "voice_registry.json").exists()
    artifact_dir = tmp_path / "registry" / "artifacts"
    assert not artifact_dir.exists() or list(artifact_dir.iterdir()) == []
    tmp_dir = tmp_path / "registry" / ".tmp"
    assert not tmp_dir.exists() or list(tmp_dir.iterdir()) == []
