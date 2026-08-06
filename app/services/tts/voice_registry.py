"""Internal TTS voice profile registry.

The registry owns provider-neutral logical voice identifiers, versioned voice
pack manifests, artifact integrity checks, and local cloned-profile metadata.
It intentionally has no bus, SDK, download, provider, or service wiring.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

LogicalVoiceKind = Literal["standard", "clone"]
ProfileKind = Literal["standard", "clone"]
ProfileVisibility = Literal["public", "private"]
ReadyState = Literal["ready", "installing", "failed", "deleted"]
LicenseRedistribution = Literal["approved"]

_STANDARD_ID_RE = re.compile(r"^standard:([a-z0-9][a-z0-9_.-]{0,63}):([a-z0-9][a-z0-9_.-]{0,63})$")
_CLONE_ID_RE = re.compile(
    r"^clone:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_COMPONENT_RE = re.compile(r"^[a-z0-9][a-z0-9_.:+-]{0,95}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_JSON_BYTES = 512 * 1024
_MAX_ASSETS = 128


class VoiceRegistryError(ValueError):
    """Base class for sanitized registry failures."""


class VoiceManifestError(VoiceRegistryError):
    """Raised when a manifest is invalid or not approved for local use."""


class VoiceArtifactError(VoiceRegistryError):
    """Raised when an artifact cannot be safely verified or promoted."""


class VoiceSelectionError(VoiceRegistryError):
    """Raised when a ready compatible voice state cannot be selected."""


@dataclass(frozen=True)
class VoiceBaseIdentity:
    """Resident runtime/language/config identity a voice state must match."""

    runtime_target: str
    language_bundle: str
    compatibility_group: str

    def as_tuple(self) -> tuple[str, str, str]:
        """Return the strict compatibility key."""
        return (self.runtime_target, self.language_bundle, self.compatibility_group)


@dataclass(frozen=True)
class VoiceCatalogEntry:
    """Use-safe voice entry that does not expose artifact paths or private bytes."""

    voice_id: str
    display_name: str
    kind: ProfileKind
    ready: bool
    language_bundle: str
    runtime_target: str


@dataclass(frozen=True)
class VoiceProfileInventoryEntry:
    """Administrative profile view with metadata but no artifact payload bytes."""

    profile_key: str
    voice_id: str
    display_name: str
    kind: ProfileKind
    visibility: ProfileVisibility
    ready_state: ReadyState
    runtime_target: str
    language_bundle: str
    compatibility_group: str
    artifact_revision: str
    artifact_refs: tuple[str, ...]
    source_retained: bool
    license_name: str | None
    attribution: str | None


class VoiceArtifactManifest(BaseModel):
    """Bounded artifact descriptor from an Aurora voice manifest."""

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    asset_id: str = Field(min_length=1, max_length=96)
    logical_voice_id: str = Field(min_length=1, max_length=160)
    display_name: str = Field(min_length=1, max_length=96)
    runtime_target: str = Field(min_length=1, max_length=96)
    language_bundle: str = Field(min_length=1, max_length=96)
    compatibility_group: str = Field(min_length=1, max_length=96)
    artifact_revision: str = Field(min_length=1, max_length=96)
    feature: Literal["voice-state"]
    size_bytes: int = Field(ge=0, le=512 * 1024 * 1024)
    sha256: str = Field(min_length=64, max_length=64)
    relative_path: str = Field(min_length=1, max_length=240)
    compression: Literal["none"] = "none"
    unpacked_size_bytes: int = Field(ge=0, le=512 * 1024 * 1024)
    license_name: str = Field(min_length=1, max_length=120)
    attribution: str | None = Field(default=None, max_length=240)
    redistribution: LicenseRedistribution
    upstream_source: str | None = Field(default=None, max_length=240)

    @field_validator(  # type: ignore[untyped-decorator]
        "asset_id",
        "runtime_target",
        "language_bundle",
        "compatibility_group",
        "artifact_revision",
    )
    @classmethod
    def _validate_component(cls, value: str) -> str:
        if not _COMPONENT_RE.fullmatch(value):
            raise ValueError("invalid component")
        return value

    @field_validator("logical_voice_id")  # type: ignore[untyped-decorator]
    @classmethod
    def _validate_standard_voice_id(cls, value: str) -> str:
        if not _STANDARD_ID_RE.fullmatch(value):
            raise ValueError("standard voice id required")
        return value

    @field_validator("sha256")  # type: ignore[untyped-decorator]
    @classmethod
    def _validate_hash(cls, value: str) -> str:
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("invalid sha256")
        return value

    @field_validator("relative_path")  # type: ignore[untyped-decorator]
    @classmethod
    def _validate_relative_path(cls, value: str) -> str:
        _safe_relative_path(value)
        return value

    @model_validator(mode="after")  # type: ignore[untyped-decorator]
    def _validate_sizes(self) -> VoiceArtifactManifest:
        if self.unpacked_size_bytes < self.size_bytes:
            raise ValueError("unpacked size cannot be smaller than packed size")
        return self


class VoicePackManifest(BaseModel):
    """Versioned Aurora-controlled standard voice pack manifest."""

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    schema_version: Literal[1]
    pack_id: str = Field(min_length=1, max_length=64)
    pack_version: str = Field(min_length=1, max_length=64)
    minimum_aurora_version: str = Field(min_length=1, max_length=64)
    minimum_runtime_version: str = Field(min_length=1, max_length=64)
    assets: tuple[VoiceArtifactManifest, ...] = Field(min_length=1, max_length=_MAX_ASSETS)

    @field_validator("pack_id")  # type: ignore[untyped-decorator]
    @classmethod
    def _validate_pack_id(cls, value: str) -> str:
        if not _COMPONENT_RE.fullmatch(value):
            raise ValueError("invalid pack id")
        return value

    @model_validator(mode="after")  # type: ignore[untyped-decorator]
    def _validate_pack_voice_ids(self) -> VoicePackManifest:
        for asset in self.assets:
            match = _STANDARD_ID_RE.fullmatch(asset.logical_voice_id)
            if match is None or match.group(1) != self.pack_id:
                raise ValueError("standard voice id pack does not match manifest")
        return self


class _PersistedProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    profile_key: str
    voice_id: str
    display_name: str
    kind: ProfileKind
    visibility: ProfileVisibility
    ready_state: ReadyState
    runtime_target: str
    language_bundle: str
    compatibility_group: str
    artifact_revision: str
    artifact_refs: tuple[str, ...]
    source_retained: bool = False
    license_name: str | None = None
    attribution: str | None = None


class _RegistryState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = 1
    profiles: dict[str, _PersistedProfile] = Field(default_factory=dict)


def validate_logical_voice_id(voice_id: str) -> LogicalVoiceKind:
    """Validate and classify an Aurora logical voice ID."""
    if _STANDARD_ID_RE.fullmatch(voice_id):
        return "standard"
    if _CLONE_ID_RE.fullmatch(voice_id):
        return "clone"
    raise VoiceManifestError("invalid logical voice id")


class VoiceRegistry:
    """Provider-neutral local registry for standard and cloned TTS voice states."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self._artifacts_dir = self.root / "artifacts"
        self._tmp_dir = self.root / ".tmp"
        self._state_path = self.root / "voice_registry.json"
        self._lock = asyncio.Lock()

    async def install_standard_pack(
        self, manifest_path: Path | str, artifact_root: Path | str
    ) -> tuple[VoiceProfileInventoryEntry, ...]:
        """Parse, verify, and atomically promote a standard voice pack manifest."""
        async with self._lock:
            return await asyncio.to_thread(
                self._install_standard_pack_sync, Path(manifest_path), Path(artifact_root)
            )

    async def create_clone_profile(
        self,
        *,
        display_name: str,
        runtime_target: str,
        language_bundle: str,
        compatibility_group: str,
        artifact_revision: str,
        artifact_bytes: bytes,
        source_audio: bytes | None = None,
        source_retention: bool = False,
        visibility: ProfileVisibility = "private",
        clone_uuid: uuid.UUID | None = None,
    ) -> VoiceProfileInventoryEntry:
        """Create a local cloned profile from already-derived provider state bytes."""
        del source_audio
        async with self._lock:
            return await asyncio.to_thread(
                self._create_clone_profile_sync,
                display_name,
                runtime_target,
                language_bundle,
                compatibility_group,
                artifact_revision,
                artifact_bytes,
                source_retention,
                visibility,
                clone_uuid,
            )

    async def catalog(
        self,
        resident_base_identity: VoiceBaseIdentity | None = None,
        *,
        include_private: bool = False,
    ) -> tuple[VoiceCatalogEntry, ...]:
        """Return the redacted use-safe catalog."""
        async with self._lock:
            return await asyncio.to_thread(
                self._catalog_sync, resident_base_identity, include_private
            )

    async def inventory(self) -> tuple[VoiceProfileInventoryEntry, ...]:
        """Return administrative profile metadata without artifact payload bytes."""
        async with self._lock:
            return await asyncio.to_thread(self._inventory_sync)

    async def select_voice(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> VoiceProfileInventoryEntry:
        """Select a ready voice only when it matches the supplied resident identity."""
        async with self._lock:
            return await asyncio.to_thread(
                self._select_voice_sync, voice_id, resident_base_identity
            )

    async def delete_voice(self, voice_id: str) -> None:
        """Delete profile metadata and promoted artifacts for a logical voice."""
        async with self._lock:
            await asyncio.to_thread(self._delete_voice_sync, voice_id)

    def _install_standard_pack_sync(
        self, manifest_path: Path, artifact_root: Path
    ) -> tuple[VoiceProfileInventoryEntry, ...]:
        manifest = _read_manifest(manifest_path)
        source_root = artifact_root.resolve(strict=True)
        state = self._read_state()
        installed: list[_PersistedProfile] = []
        self._ensure_dirs()

        for asset in manifest.assets:
            source_path = _resolve_safe_child(source_root, asset.relative_path)
            if not source_path.is_file():
                raise VoiceArtifactError("artifact missing")
            _reject_symlink_path(source_root, source_path)
            _verify_file(source_path, expected_size=asset.size_bytes, expected_sha256=asset.sha256)

            profile_key = _profile_key(
                asset.logical_voice_id,
                asset.runtime_target,
                asset.language_bundle,
                asset.compatibility_group,
                asset.artifact_revision,
            )
            if profile_key in state.profiles:
                raise VoiceArtifactError("profile already installed")
            final_dir = self._artifacts_dir / profile_key
            if final_dir.exists():
                raise VoiceArtifactError("artifact destination already exists")

            staging_dir = self._tmp_dir / f"{profile_key}.{uuid.uuid4().hex}"
            try:
                staging_dir.mkdir(parents=True)
                staged_file = staging_dir / Path(asset.relative_path).name
                shutil.copyfile(source_path, staged_file)
                _verify_file(
                    staged_file, expected_size=asset.size_bytes, expected_sha256=asset.sha256
                )
                _fsync_file(staged_file)
                os.replace(staging_dir, final_dir)
            except Exception:
                shutil.rmtree(staging_dir, ignore_errors=True)
                raise

            installed.append(
                _PersistedProfile(
                    profile_key=profile_key,
                    voice_id=asset.logical_voice_id,
                    display_name=asset.display_name,
                    kind="standard",
                    visibility="public",
                    ready_state="ready",
                    runtime_target=asset.runtime_target,
                    language_bundle=asset.language_bundle,
                    compatibility_group=asset.compatibility_group,
                    artifact_revision=asset.artifact_revision,
                    artifact_refs=(str(Path("artifacts") / profile_key / staged_file.name),),
                    source_retained=False,
                    license_name=asset.license_name,
                    attribution=asset.attribution,
                )
            )

        updated = state.model_copy(
            update={"profiles": {**state.profiles, **{p.profile_key: p for p in installed}}}
        )
        self._write_state(updated)
        return tuple(_inventory_entry(profile) for profile in installed)

    def _create_clone_profile_sync(
        self,
        display_name: str,
        runtime_target: str,
        language_bundle: str,
        compatibility_group: str,
        artifact_revision: str,
        artifact_bytes: bytes,
        source_retention: bool,
        visibility: ProfileVisibility,
        clone_uuid: uuid.UUID | None,
    ) -> VoiceProfileInventoryEntry:
        if not artifact_bytes:
            raise VoiceArtifactError("clone artifact is empty")
        for value in (runtime_target, language_bundle, compatibility_group, artifact_revision):
            if not _COMPONENT_RE.fullmatch(value):
                raise VoiceArtifactError("invalid clone compatibility component")
        if len(display_name.strip()) < 1 or len(display_name) > 96:
            raise VoiceArtifactError("invalid clone display name")
        clone_id = f"clone:{clone_uuid or uuid.uuid4()}"
        validate_logical_voice_id(clone_id)
        profile_key = _profile_key(
            clone_id, runtime_target, language_bundle, compatibility_group, artifact_revision
        )
        self._ensure_dirs()
        state = self._read_state()
        if profile_key in state.profiles:
            raise VoiceArtifactError("profile already installed")

        final_dir = self._artifacts_dir / profile_key
        staging_dir = self._tmp_dir / f"{profile_key}.{uuid.uuid4().hex}"
        staged_name = "voice-state.bin"
        try:
            staging_dir.mkdir(parents=True)
            staged_file = staging_dir / staged_name
            staged_file.write_bytes(artifact_bytes)
            _fsync_file(staged_file)
            os.replace(staging_dir, final_dir)
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise

        profile = _PersistedProfile(
            profile_key=profile_key,
            voice_id=clone_id,
            display_name=display_name.strip(),
            kind="clone",
            visibility=visibility,
            ready_state="ready",
            runtime_target=runtime_target,
            language_bundle=language_bundle,
            compatibility_group=compatibility_group,
            artifact_revision=artifact_revision,
            artifact_refs=(str(Path("artifacts") / profile_key / staged_name),),
            source_retained=source_retention,
        )
        self._write_state(
            state.model_copy(update={"profiles": {**state.profiles, profile_key: profile}})
        )
        return _inventory_entry(profile)

    def _catalog_sync(
        self,
        resident_base_identity: VoiceBaseIdentity | None,
        include_private: bool,
    ) -> tuple[VoiceCatalogEntry, ...]:
        state = self._read_state()
        entries: list[VoiceCatalogEntry] = []
        for profile in state.profiles.values():
            if profile.visibility == "private" and not include_private:
                continue
            if resident_base_identity is not None and not _profile_matches(
                profile, resident_base_identity
            ):
                continue
            entries.append(
                VoiceCatalogEntry(
                    voice_id=profile.voice_id,
                    display_name=profile.display_name,
                    kind=profile.kind,
                    ready=profile.ready_state == "ready",
                    language_bundle=profile.language_bundle,
                    runtime_target=profile.runtime_target,
                )
            )
        return tuple(sorted(entries, key=lambda entry: (entry.voice_id, entry.language_bundle)))

    def _inventory_sync(self) -> tuple[VoiceProfileInventoryEntry, ...]:
        return tuple(
            sorted(
                (_inventory_entry(profile) for profile in self._read_state().profiles.values()),
                key=lambda entry: entry.profile_key,
            )
        )

    def _select_voice_sync(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> VoiceProfileInventoryEntry:
        validate_logical_voice_id(voice_id)
        matches = [
            profile
            for profile in self._read_state().profiles.values()
            if profile.voice_id == voice_id
            and profile.ready_state == "ready"
            and _profile_matches(profile, resident_base_identity)
        ]
        if not matches:
            raise VoiceSelectionError("voice is not ready for resident base identity")
        if len(matches) > 1:
            matches.sort(key=lambda profile: profile.artifact_revision, reverse=True)
        return _inventory_entry(matches[0])

    def _delete_voice_sync(self, voice_id: str) -> None:
        validate_logical_voice_id(voice_id)
        state = self._read_state()
        removed = [profile for profile in state.profiles.values() if profile.voice_id == voice_id]
        if not removed:
            return
        remaining = {
            key: profile for key, profile in state.profiles.items() if profile.voice_id != voice_id
        }
        self._write_state(state.model_copy(update={"profiles": remaining}))
        for profile in removed:
            shutil.rmtree(self._artifacts_dir / profile.profile_key, ignore_errors=True)

    def _ensure_dirs(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._artifacts_dir.mkdir(parents=True, exist_ok=True)
        self._tmp_dir.mkdir(parents=True, exist_ok=True)

    def _read_state(self) -> _RegistryState:
        if not self._state_path.exists():
            return _RegistryState()
        if self._state_path.stat().st_size > _MAX_JSON_BYTES:
            raise VoiceArtifactError("registry state is too large")
        try:
            return cast(
                _RegistryState,
                _RegistryState.model_validate_json(self._state_path.read_text(encoding="utf-8")),
            )
        except (OSError, ValidationError, ValueError) as exc:
            raise VoiceArtifactError("registry state is invalid") from exc

    def _write_state(self, state: _RegistryState) -> None:
        self._ensure_dirs()
        payload = state.model_dump_json(indent=2).encode("utf-8")
        if len(payload) > _MAX_JSON_BYTES:
            raise VoiceArtifactError("registry state is too large")
        tmp_path = self._tmp_dir / f"voice-registry.{uuid.uuid4().hex}.json"
        tmp_path.write_bytes(payload)
        _fsync_file(tmp_path)
        os.replace(tmp_path, self._state_path)


def _read_manifest(path: Path) -> VoicePackManifest:
    try:
        if path.stat().st_size > _MAX_JSON_BYTES:
            raise VoiceManifestError("manifest is too large")
        return cast(
            VoicePackManifest,
            VoicePackManifest.model_validate_json(path.read_text(encoding="utf-8")),
        )
    except VoiceManifestError:
        raise
    except (OSError, ValidationError, ValueError) as exc:
        raise VoiceManifestError("invalid voice manifest") from exc


def _safe_relative_path(value: str) -> PurePosixPath:
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError("unsafe relative path")
    if "\\" in value:
        raise ValueError("unsafe relative path")
    return candidate


def _resolve_safe_child(root: Path, relative_path: str) -> Path:
    _safe_relative_path(relative_path)
    candidate = (root / relative_path).resolve(strict=True)
    if not _is_relative_to(candidate, root):
        raise VoiceArtifactError("artifact path escapes root")
    return candidate


def _reject_symlink_path(root: Path, path: Path) -> None:
    current = root
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise VoiceArtifactError("artifact path uses symlink")


def _verify_file(path: Path, *, expected_size: int, expected_sha256: str) -> None:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    if size != expected_size:
        raise VoiceArtifactError("artifact size mismatch")
    if digest.hexdigest() != expected_sha256:
        raise VoiceArtifactError("artifact hash mismatch")


def _profile_key(
    voice_id: str,
    runtime_target: str,
    language_bundle: str,
    compatibility_group: str,
    artifact_revision: str,
) -> str:
    digest = hashlib.sha256(
        json.dumps(
            [voice_id, runtime_target, language_bundle, compatibility_group, artifact_revision],
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return digest[:32]


def _profile_matches(profile: _PersistedProfile, identity: VoiceBaseIdentity) -> bool:
    return (
        profile.runtime_target,
        profile.language_bundle,
        profile.compatibility_group,
    ) == identity.as_tuple()


def _inventory_entry(profile: _PersistedProfile) -> VoiceProfileInventoryEntry:
    return VoiceProfileInventoryEntry(
        profile_key=profile.profile_key,
        voice_id=profile.voice_id,
        display_name=profile.display_name,
        kind=profile.kind,
        visibility=profile.visibility,
        ready_state=profile.ready_state,
        runtime_target=profile.runtime_target,
        language_bundle=profile.language_bundle,
        compatibility_group=profile.compatibility_group,
        artifact_revision=profile.artifact_revision,
        artifact_refs=profile.artifact_refs,
        source_retained=profile.source_retained,
        license_name=profile.license_name,
        attribution=profile.attribution,
    )


def _fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
