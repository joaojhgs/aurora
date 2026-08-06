"""Tests for the internal TTS voice registry."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import struct
import uuid
from pathlib import Path

import pytest

from app.services.tts.voice_registry import (
    VoiceArtifactError,
    VoiceBaseIdentity,
    VoiceManifestError,
    VoiceRegistry,
    VoiceSelectionError,
    VoiceStateArtifactHandle,
    validate_logical_voice_id,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safetensors_bytes(tensors: dict[str, tuple[str, list[int], bytes]] | None = None) -> bytes:
    tensors = tensors or {
        "speaker.embedding": ("F32", [2], b"\x00\x00\x80?\x00\x00\x00@"),
    }
    header: dict[str, object] = {"__metadata__": {"format": "aurora-test"}}
    payload = bytearray()
    for name, (dtype, shape, data) in tensors.items():
        start = len(payload)
        payload.extend(data)
        header[name] = {
            "dtype": dtype,
            "shape": shape,
            "data_offsets": [start, len(payload)],
        }
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<Q", len(header_bytes)) + header_bytes + bytes(payload)


def _safetensors_from_header(header: bytes, payload: bytes = b"") -> bytes:
    return struct.pack("<Q", len(header)) + header + payload


def _padded_safetensors_bytes(padding: bytes) -> bytes:
    payload = b"\x00\x00\x80?\x00\x00\x00@"
    header = (
        b'{"__metadata__":{"format":"aurora-test"},'
        b'"speaker.embedding":{"dtype":"F32","shape":[2],"data_offsets":[0,8]}}' + padding
    )
    return _safetensors_from_header(header, payload)


def _multi_tensor_safetensors_bytes() -> bytes:
    return _safetensors_bytes(
        {
            "speaker.embedding": ("F32", [2], b"\x00\x00\x80?\x00\x00\x00@"),
            "speaker.bias": ("U8", [3], b"\x01\x02\x03"),
        }
    )


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
    path: str = "voices/alloy.safetensors",
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


def _read_state(registry_root: Path) -> dict[str, object]:
    return json.loads((registry_root / "voice_registry.json").read_text(encoding="utf-8"))


def _write_state(registry_root: Path, state: dict[str, object]) -> None:
    (registry_root / "voice_registry.json").write_text(json.dumps(state), encoding="utf-8")


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
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
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
    alloy = _safetensors_bytes()
    verse = _safetensors_bytes({"speaker.embedding": ("F32", [2], b"\x00\x00@@\x00\x00\x80@")})
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(alloy)
    artifact_root.joinpath("voices/verse.safetensors").write_bytes(verse)
    manifest_path = _write_manifest(
        tmp_path / "manifest.json",
        _manifest(
            assets=[
                _asset(alloy, voice="alloy", path="voices/alloy.safetensors"),
                _asset(verse, voice="verse", path="voices/verse.safetensors", revision="rev-b"),
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
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
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
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)

    traversal_manifest = _write_manifest(
        tmp_path / "traversal.json",
        _manifest(assets=[_asset(data, path="../outside.safetensors")]),
    )
    with pytest.raises(VoiceManifestError):
        await VoiceRegistry(registry_root).install_standard_pack(traversal_manifest, artifact_root)

    outside = tmp_path / "outside.safetensors"
    outside.write_bytes(data)
    symlink = artifact_root / "voices/link.safetensors"
    symlink.symlink_to(outside)
    symlink_manifest = _write_manifest(
        tmp_path / "symlink.json",
        _manifest(assets=[_asset(data, path="voices/link.safetensors")]),
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
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)

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
        artifact_bytes=_safetensors_bytes(),
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
    assert "speaker.embedding" not in state_json


@pytest.mark.asyncio
async def test_atomic_promotion_failure_rolls_back_metadata_and_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
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


@pytest.mark.asyncio
async def test_multi_asset_pack_verifies_everything_before_first_promotion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    good = _safetensors_bytes()
    bad = _safetensors_bytes({"speaker.embedding": ("F32", [2], b"\x00\x00@@\x00\x00\x80@")})
    artifact_root.joinpath("voices/good.safetensors").write_bytes(good)
    artifact_root.joinpath("voices/bad.safetensors").write_bytes(b"tampered")
    manifest_path = _write_manifest(
        tmp_path / "manifest.json",
        _manifest(
            assets=[
                _asset(good, voice="alloy", path="voices/good.safetensors"),
                _asset(bad, voice="verse", path="voices/bad.safetensors", revision="rev-b"),
            ]
        ),
    )
    promoted: list[tuple[Path, Path]] = []
    original_replace = os.replace

    def record_replace(src: Path | str, dst: Path | str) -> None:
        if Path(src).is_dir():
            promoted.append((Path(src), Path(dst)))
        original_replace(src, dst)

    monkeypatch.setattr(os, "replace", record_replace)

    with pytest.raises(VoiceArtifactError):
        await registry.install_standard_pack(manifest_path, artifact_root)

    assert promoted == []
    assert await registry.inventory() == ()


@pytest.mark.asyncio
async def test_partial_multi_asset_promotion_rolls_back_every_promoted_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    first = _safetensors_bytes()
    second = _safetensors_bytes({"speaker.embedding": ("F32", [2], b"\x00\x00@@\x00\x00\x80@")})
    artifact_root.joinpath("voices/first.safetensors").write_bytes(first)
    artifact_root.joinpath("voices/second.safetensors").write_bytes(second)
    manifest_path = _write_manifest(
        tmp_path / "manifest.json",
        _manifest(
            assets=[
                _asset(first, voice="alloy", path="voices/first.safetensors"),
                _asset(second, voice="verse", path="voices/second.safetensors", revision="rev-b"),
            ]
        ),
    )
    original_replace = os.replace
    directory_promotions = 0

    def fail_second_directory_promotion(src: Path | str, dst: Path | str) -> None:
        nonlocal directory_promotions
        if Path(src).is_dir() and ".tmp" in Path(src).parts:
            directory_promotions += 1
            if directory_promotions == 2:
                raise OSError("simulated second promotion failure")
        original_replace(src, dst)

    monkeypatch.setattr(os, "replace", fail_second_directory_promotion)

    with pytest.raises(OSError):
        await registry.install_standard_pack(manifest_path, artifact_root)

    assert await registry.inventory() == ()
    artifact_dir = tmp_path / "registry" / "artifacts"
    assert artifact_dir.exists()
    assert list(artifact_dir.iterdir()) == []


@pytest.mark.asyncio
async def test_persisted_state_rejects_tampered_profile_key_and_artifact_ref(
    tmp_path: Path,
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    profile_key = installed[0].profile_key

    original_state = _read_state(registry_root)
    state = json.loads(json.dumps(original_state))
    profile = state["profiles"][profile_key]
    state["profiles"] = {"0" * 32: {**profile, "profile_key": "0" * 32}}
    _write_state(registry_root, state)

    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).inventory()

    state = json.loads(json.dumps(original_state))
    state["profiles"][profile_key]["artifacts"][0]["relative_ref"] = "../../../outside"
    _write_state(registry_root, state)

    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).delete_voice("standard:starter_en:alloy")
    assert not (tmp_path / "outside").exists()


@pytest.mark.asyncio
async def test_state_load_and_selection_verify_artifact_hash_and_size(tmp_path: Path) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    artifact_path = registry_root / installed[0].artifact_refs[0]
    artifact_path.write_bytes(b"changed")

    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).select_voice("standard:starter_en:alloy", identity)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protected_name", ["artifacts", ".tmp", "voice_registry.json", ".voice_registry.lock"]
)
async def test_registry_rejects_protected_symlink_paths(
    tmp_path: Path, protected_name: str
) -> None:
    root = tmp_path / "registry"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    protected_path = root / protected_name
    protected_path.symlink_to(outside, target_is_directory=protected_name != "voice_registry.json")

    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(root).inventory()


@pytest.mark.asyncio
async def test_registry_rejects_symlinked_root(tmp_path: Path) -> None:
    real_root = tmp_path / "real"
    real_root.mkdir()
    linked_root = tmp_path / "linked"
    linked_root.symlink_to(real_root, target_is_directory=True)

    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(linked_root).inventory()


@pytest.mark.asyncio
async def test_clone_artifacts_are_bounded_stored_hashed_and_verified(tmp_path: Path) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root, max_clone_artifact_bytes=8)

    with pytest.raises(VoiceArtifactError):
        await registry.create_clone_profile(
            display_name="Too Large",
            runtime_target="pockettts-python",
            language_bundle="en-us-compact",
            compatibility_group="pockettts-en-compact-v1",
            artifact_revision="rev-a",
            artifact_bytes=b"123456789",
        )

    registry = VoiceRegistry(registry_root, max_clone_artifact_bytes=len(_safetensors_bytes()))
    created = await registry.create_clone_profile(
        display_name="Small",
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
        artifact_revision="rev-a",
        artifact_bytes=_safetensors_bytes(),
        clone_uuid=uuid.UUID("12345678-1234-4234-9234-123456789abc"),
    )
    state = _read_state(registry_root)
    artifact = state["profiles"][created.profile_key]["artifacts"][0]
    assert artifact["size_bytes"] == len(_safetensors_bytes())
    assert artifact["sha256"] == _sha256(_safetensors_bytes())

    (registry_root / created.artifact_refs[0]).write_bytes(
        _safetensors_bytes({"speaker.embedding": ("F32", [2], b"\x00\x00@@\x00\x00\x80@")})
    )
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).select_voice(created.voice_id, identity)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_bytes",
    [
        b"not-a-safetensors-file",
        struct.pack("<Q", 100) + b"{}",
        _safetensors_from_header(
            b'{"speaker.embedding":{"dtype":"F32","shape":[2],"data_offsets":[0,4]}}',
            b"\x00\x00\x80?\x00\x00\x00@",
        ),
        _safetensors_from_header(
            b'{"speaker.embedding":{"dtype":"F32","shape":[true],"data_offsets":[0,4]}}',
            b"\x00\x00\x80?",
        ),
        _safetensors_from_header(
            b'{"speaker.embedding":{"dtype":"F32","shape":[1],"data_offsets":[false,4]}}',
            b"\x00\x00\x80?",
        ),
        _safetensors_from_header(
            b' {"speaker.embedding":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}',
            b"\x00\x00\x80?",
        ),
        _padded_safetensors_bytes(b"\t"),
        _padded_safetensors_bytes(b"\n"),
    ],
)
async def test_invalid_safetensors_state_artifacts_are_rejected_atomically(
    tmp_path: Path, invalid_bytes: bytes
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(invalid_bytes)
    manifest_path = _write_manifest(
        tmp_path / "manifest.json", _manifest(assets=[_asset(invalid_bytes)])
    )

    with pytest.raises(VoiceArtifactError):
        await registry.install_standard_pack(manifest_path, artifact_root)
    with pytest.raises(VoiceArtifactError):
        await registry.create_clone_profile(
            display_name="Bad Clone",
            runtime_target="pockettts-python",
            language_bundle="en-us-compact",
            compatibility_group="pockettts-en-compact-v1",
            artifact_revision="bad-rev",
            artifact_bytes=invalid_bytes,
        )

    assert await registry.inventory() == ()
    assert not (tmp_path / "registry" / "voice_registry.json").exists()
    assert (
        not (tmp_path / "registry" / "artifacts").exists()
        or list((tmp_path / "registry" / "artifacts").iterdir()) == []
    )


@pytest.mark.asyncio
async def test_standard_pack_rejects_pockettts_extension_mismatch_atomically(
    tmp_path: Path,
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.bin").write_bytes(data)
    manifest_path = _write_manifest(
        tmp_path / "manifest.json",
        _manifest(assets=[_asset(data, path="voices/alloy.bin")]),
    )

    with pytest.raises(VoiceArtifactError):
        await registry.install_standard_pack(manifest_path, artifact_root)

    assert await registry.inventory() == ()


@pytest.mark.asyncio
async def test_safetensors_header_accepts_spec_space_padding(tmp_path: Path) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _padded_safetensors_bytes(b"   ")
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))

    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    clone = await registry.create_clone_profile(
        display_name="Padded Clone",
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
        artifact_revision="padded-rev",
        artifact_bytes=data,
    )

    assert installed[0].voice_id == "standard:starter_en:alloy"
    assert clone.voice_id.startswith("clone:")


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime_target", ["notpockettts-python", "pockettts", "pockettts-js"])
async def test_registry_rejects_noncanonical_runtime_targets_atomically(
    tmp_path: Path, runtime_target: str
) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(
        tmp_path / "manifest.json",
        _manifest(assets=[_asset(data, runtime=runtime_target)]),
    )

    with pytest.raises(VoiceArtifactError):
        await registry.install_standard_pack(manifest_path, artifact_root)
    with pytest.raises(VoiceArtifactError):
        await registry.create_clone_profile(
            display_name="Wrong Runtime",
            runtime_target=runtime_target,
            language_bundle="en-us-compact",
            compatibility_group="pockettts-en-compact-v1",
            artifact_revision="bad-runtime-rev",
            artifact_bytes=data,
        )

    assert await registry.inventory() == ()
    assert (
        not (tmp_path / "registry" / "artifacts").exists()
        or list((tmp_path / "registry" / "artifacts").iterdir()) == []
    )


@pytest.mark.asyncio
async def test_resolver_returns_verified_path_safe_safetensors_handle_after_restart(
    tmp_path: Path,
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _multi_tensor_safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")

    assert [entry.voice_id for entry in await registry.catalog(identity)] == [
        "standard:starter_en:alloy"
    ]
    handle = await VoiceRegistry(registry_root).resolve_voice_state_artifact(
        "standard:starter_en:alloy", identity
    )

    assert isinstance(handle, VoiceStateArtifactHandle)
    assert handle.voice_id == "standard:starter_en:alloy"
    assert handle.runtime_target == identity.runtime_target
    assert handle.language_bundle == identity.language_bundle
    assert handle.compatibility_group == identity.compatibility_group
    assert handle.sha256 == _sha256(data)
    assert handle.size_bytes == len(data)
    assert handle.format == "safetensors"
    assert handle.relative_ref == installed[0].artifact_refs[0]
    assert handle.relative_ref.endswith(".safetensors")
    os.lseek(handle.fd, 8, os.SEEK_SET)
    assert os.read(handle.fd, 1) == b"{"
    os.close(handle.fd)


@pytest.mark.asyncio
async def test_resolver_rejects_compatibility_mismatch(tmp_path: Path) -> None:
    registry = VoiceRegistry(tmp_path / "registry")
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    await registry.install_standard_pack(manifest_path, artifact_root)

    with pytest.raises(VoiceSelectionError):
        await registry.resolve_voice_state_artifact(
            "standard:starter_en:alloy",
            VoiceBaseIdentity("pockettts-python", "fr-fr-compact", "pockettts-en-compact-v1"),
        )


@pytest.mark.asyncio
async def test_resolver_rejects_post_install_replacement_and_symlink_swap(
    tmp_path: Path,
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    artifact_path = registry_root / installed[0].artifact_refs[0]

    artifact_path.write_bytes(_multi_tensor_safetensors_bytes())
    with pytest.raises(VoiceArtifactError):
        await registry.resolve_voice_state_artifact("standard:starter_en:alloy", identity)

    artifact_path.unlink()
    outside = tmp_path / "outside.safetensors"
    outside.write_bytes(data)
    artifact_path.symlink_to(outside)
    with pytest.raises(VoiceArtifactError):
        await registry.resolve_voice_state_artifact("standard:starter_en:alloy", identity)


@pytest.mark.asyncio
async def test_resolver_rejects_same_byte_in_root_symlink_swap(tmp_path: Path) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    artifact_path = registry_root / installed[0].artifact_refs[0]
    same_byte_target = artifact_path.with_name("same-bytes.safetensors")
    shutil.copyfile(artifact_path, same_byte_target)

    artifact_path.unlink()
    artifact_path.symlink_to(same_byte_target.name)

    with pytest.raises(VoiceArtifactError):
        await registry.resolve_voice_state_artifact("standard:starter_en:alloy", identity)


@pytest.mark.asyncio
async def test_resolver_rejects_lexical_profile_directory_symlink_swap(
    tmp_path: Path,
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    profile_dir = registry_root / "artifacts" / installed[0].profile_key
    replacement_dir = registry_root / "artifacts" / "same_byte_replacement"
    shutil.copytree(profile_dir, replacement_dir)

    shutil.rmtree(profile_dir)
    profile_dir.symlink_to(replacement_dir.name, target_is_directory=True)

    with pytest.raises(VoiceArtifactError):
        await registry.resolve_voice_state_artifact("standard:starter_en:alloy", identity)


@pytest.mark.asyncio
async def test_resolver_rejects_forged_artifact_ref_outside_profile_dir(
    tmp_path: Path,
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    artifact_root = tmp_path / "pack"
    artifact_root.joinpath("voices").mkdir(parents=True)
    data = _safetensors_bytes()
    artifact_root.joinpath("voices/alloy.safetensors").write_bytes(data)
    manifest_path = _write_manifest(tmp_path / "manifest.json", _manifest(assets=[_asset(data)]))
    installed = await registry.install_standard_pack(manifest_path, artifact_root)
    identity = VoiceBaseIdentity("pockettts-python", "en-us-compact", "pockettts-en-compact-v1")
    state_path = registry_root / "voice_registry.json"
    state = _read_state(registry_root)
    profile = state["profiles"][installed[0].profile_key]
    profile["artifacts"][0]["relative_ref"] = (
        "artifacts/ffffffffffffffffffffffffffffffff/alloy.safetensors"
    )
    state_path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(VoiceArtifactError):
        await VoiceRegistry(registry_root).resolve_voice_state_artifact(
            "standard:starter_en:alloy", identity
        )


@pytest.mark.asyncio
async def test_delete_surfaces_tombstone_delete_failure_and_restart_finishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    clone = await registry.create_clone_profile(
        display_name="Sensitive",
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
        artifact_revision="rev-a",
        artifact_bytes=_safetensors_bytes(),
        clone_uuid=uuid.UUID("12345678-1234-4234-9234-123456789abc"),
    )
    original_rmtree = shutil.rmtree

    def fail_tombstone_delete(path: Path | str) -> None:
        if "tombstones" in Path(path).parts:
            raise OSError("simulated delete failure")
        original_rmtree(path)

    monkeypatch.setattr(shutil, "rmtree", fail_tombstone_delete)

    with pytest.raises(OSError):
        await registry.delete_voice(clone.voice_id)

    state = _read_state(registry_root)
    assert state["profiles"] == {}
    assert clone.profile_key in state["deletions"]
    assert not (registry_root / "artifacts" / clone.profile_key).exists()
    assert (registry_root / "tombstones" / clone.profile_key).exists()

    monkeypatch.setattr(shutil, "rmtree", original_rmtree)
    assert await VoiceRegistry(registry_root).inventory() == ()
    assert not (registry_root / "tombstones" / clone.profile_key).exists()
    assert _read_state(registry_root)["deletions"] == {}


@pytest.mark.asyncio
async def test_restart_finishes_delete_after_crash_between_quarantine_and_state_commit(
    tmp_path: Path,
) -> None:
    registry_root = tmp_path / "registry"
    registry = VoiceRegistry(registry_root)
    clone = await registry.create_clone_profile(
        display_name="Sensitive",
        runtime_target="pockettts-python",
        language_bundle="en-us-compact",
        compatibility_group="pockettts-en-compact-v1",
        artifact_revision="rev-a",
        artifact_bytes=_safetensors_bytes(),
        clone_uuid=uuid.UUID("12345678-1234-4234-9234-123456789abc"),
    )
    artifacts_dir = registry_root / "artifacts" / clone.profile_key
    tombstone_dir = registry_root / "tombstones" / clone.profile_key
    os.replace(artifacts_dir, tombstone_dir)

    assert await VoiceRegistry(registry_root).inventory() == ()
    assert not tombstone_dir.exists()
    state = _read_state(registry_root)
    assert state["profiles"] == {}
    assert state["deletions"] == {}


@pytest.mark.asyncio
async def test_cross_instance_filesystem_lock_prevents_lost_updates(tmp_path: Path) -> None:
    registry_root = tmp_path / "registry"

    async def create(index: int) -> str:
        profile = await VoiceRegistry(registry_root).create_clone_profile(
            display_name=f"Voice {index}",
            runtime_target="pockettts-python",
            language_bundle="en-us-compact",
            compatibility_group="pockettts-en-compact-v1",
            artifact_revision=f"rev-{index}",
            artifact_bytes=_safetensors_bytes(
                {"speaker.embedding": ("F32", [1], struct.pack("<f", float(index)))}
            ),
            clone_uuid=uuid.UUID(f"12345678-1234-4234-9234-{index:012d}"),
        )
        return profile.voice_id

    created_ids = await asyncio.gather(*(create(index) for index in range(12)))
    inventory = await VoiceRegistry(registry_root).inventory()

    assert {entry.voice_id for entry in inventory} == set(created_ids)
    assert len(inventory) == 12
