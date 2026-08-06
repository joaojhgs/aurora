"""Internal TTS voice profile registry.

The registry owns provider-neutral logical voice identifiers, versioned voice
pack manifests, artifact integrity checks, and local cloned-profile metadata.
It intentionally has no bus, SDK, download, provider, or service wiring.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import math
import os
import re
import shutil
import stat
import struct
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import TracebackType
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

fcntl_module: Any | None
try:  # pragma: no cover - platform dependent
    import fcntl as fcntl_module
except ImportError:  # pragma: no cover - platform dependent
    fcntl_module = None

msvcrt_module: Any | None
try:  # pragma: no cover - platform dependent
    import msvcrt as msvcrt_module
except ImportError:  # pragma: no cover - platform dependent
    msvcrt_module = None

LogicalVoiceKind = Literal["standard", "clone"]
ProfileKind = Literal["standard", "clone"]
ProfileVisibility = Literal["public", "private"]
ReadyState = Literal["ready", "installing", "failed", "deleted"]
LicenseRedistribution = Literal["approved"]
VoiceStateArtifactFormat = Literal["safetensors"]

_STANDARD_ID_RE = re.compile(r"^standard:([a-z0-9][a-z0-9_.-]{0,63}):([a-z0-9][a-z0-9_.-]{0,63})$")
_CLONE_ID_RE = re.compile(
    r"^clone:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_COMPONENT_RE = re.compile(r"^[a-z0-9][a-z0-9_.:+-]{0,95}$")
_PROFILE_KEY_RE = re.compile(r"^[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_JSON_BYTES = 512 * 1024
_MAX_ASSETS = 128
_MAX_SAFETENSORS_HEADER_BYTES = 1024 * 1024
_DEFAULT_MAX_CLONE_ARTIFACT_BYTES = 64 * 1024 * 1024
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_SUPPORTED_VOICE_STATE_RUNTIMES = frozenset({"pockettts-python"})
_SAFETENSORS_DTYPES: dict[str, int] = {
    "BOOL": 1,
    "U8": 1,
    "I8": 1,
    "U16": 2,
    "I16": 2,
    "F16": 2,
    "BF16": 2,
    "U32": 4,
    "I32": 4,
    "F32": 4,
    "U64": 8,
    "I64": 8,
    "F64": 8,
}


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


@dataclass(frozen=True)
class VoiceStateArtifactHandle:
    """Provider-internal verified voice-state artifact handle."""

    voice_id: str
    runtime_target: str
    language_bundle: str
    compatibility_group: str
    artifact_revision: str
    relative_ref: str
    sha256: str
    size_bytes: int
    format: VoiceStateArtifactFormat
    fd: int


@dataclass(frozen=True)
class ExportedCloneVoiceState:
    """Registry-native clone-state payload with integrity metadata but no path exposure."""

    voice_id: str
    runtime_target: str
    language_bundle: str
    compatibility_group: str
    artifact_revision: str
    sha256: str
    size_bytes: int
    format: VoiceStateArtifactFormat
    artifact_bytes: bytes


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


class _PersistedArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    relative_ref: str
    size_bytes: int = Field(ge=0, le=512 * 1024 * 1024)
    sha256: str = Field(min_length=64, max_length=64)
    format: VoiceStateArtifactFormat = "safetensors"

    @field_validator("relative_ref")  # type: ignore[untyped-decorator]
    @classmethod
    def _validate_ref(cls, value: str) -> str:
        _safe_relative_path(value)
        return value

    @field_validator("sha256")  # type: ignore[untyped-decorator]
    @classmethod
    def _validate_sha(cls, value: str) -> str:
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("invalid sha256")
        return value


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
    artifacts: tuple[_PersistedArtifact, ...]
    source_retained: bool = False
    license_name: str | None = None
    attribution: str | None = None

    @property
    def artifact_refs(self) -> tuple[str, ...]:
        """Return metadata-only artifact refs for administrative callers."""
        return tuple(artifact.relative_ref for artifact in self.artifacts)


class _DeletionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    profile_key: str
    voice_id: str
    tombstone_ref: str


class _RegistryState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = 1
    profiles: dict[str, _PersistedProfile] = Field(default_factory=dict)
    deletions: dict[str, _DeletionRecord] = Field(default_factory=dict)


class _FileLock:
    """Small fail-closed cross-process exclusive lock."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None

    def __enter__(self) -> _FileLock:
        flags = os.O_RDWR | os.O_CREAT | _O_NOFOLLOW
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        try:
            self._fd = os.open(self.path, flags, 0o600)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise VoiceArtifactError("registry lock path uses symlink") from exc
            raise
        try:
            if fcntl_module is not None:
                fcntl_module.flock(self._fd, fcntl_module.LOCK_EX)
            elif msvcrt_module is not None:  # pragma: no cover - platform dependent
                msvcrt_module.locking(self._fd, msvcrt_module.LK_LOCK, 1)
            else:  # pragma: no cover - platform dependent
                raise VoiceArtifactError("filesystem locking is unavailable")
        except Exception:
            os.close(self._fd)
            self._fd = None
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        if self._fd is None:
            return
        try:
            if fcntl_module is not None:
                fcntl_module.flock(self._fd, fcntl_module.LOCK_UN)
            elif msvcrt_module is not None:  # pragma: no cover - platform dependent
                msvcrt_module.locking(self._fd, msvcrt_module.LK_UNLCK, 1)
        finally:
            os.close(self._fd)
            self._fd = None


def validate_logical_voice_id(voice_id: str) -> LogicalVoiceKind:
    """Validate and classify an Aurora logical voice ID."""
    if _STANDARD_ID_RE.fullmatch(voice_id):
        return "standard"
    if _CLONE_ID_RE.fullmatch(voice_id):
        return "clone"
    raise VoiceManifestError("invalid logical voice id")


class VoiceRegistry:
    """Provider-neutral local registry for standard and cloned TTS voice states."""

    def __init__(
        self,
        root: Path | str,
        *,
        max_clone_artifact_bytes: int = _DEFAULT_MAX_CLONE_ARTIFACT_BYTES,
    ) -> None:
        if max_clone_artifact_bytes < 1:
            raise VoiceArtifactError("clone artifact limit must be positive")
        self.root = Path(root)
        self._max_clone_artifact_bytes = max_clone_artifact_bytes
        self._artifacts_dir = self.root / "artifacts"
        self._tmp_dir = self.root / ".tmp"
        self._tombstones_dir = self.root / "tombstones"
        self._state_path = self.root / "voice_registry.json"
        self._lock_path = self.root / ".voice_registry.lock"
        self._lock = asyncio.Lock()

    async def install_standard_pack(
        self, manifest_path: Path | str, artifact_root: Path | str
    ) -> tuple[VoiceProfileInventoryEntry, ...]:
        """Parse, verify, and atomically promote a standard voice pack manifest."""
        async with self._lock:
            return await asyncio.to_thread(
                self._with_fs_lock,
                self._install_standard_pack_locked,
                Path(manifest_path),
                Path(artifact_root),
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
                self._with_fs_lock,
                self._create_clone_profile_locked,
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
                self._with_fs_lock,
                self._catalog_locked,
                resident_base_identity,
                include_private,
            )

    async def inventory(self) -> tuple[VoiceProfileInventoryEntry, ...]:
        """Return administrative profile metadata without artifact payload bytes."""
        async with self._lock:
            return await asyncio.to_thread(self._with_fs_lock, self._inventory_locked)

    async def select_voice(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> VoiceProfileInventoryEntry:
        """Select a ready voice only when it matches the supplied resident identity."""
        async with self._lock:
            return await asyncio.to_thread(
                self._with_fs_lock,
                self._select_voice_locked,
                voice_id,
                resident_base_identity,
            )

    async def resolve_voice_state_artifact(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> VoiceStateArtifactHandle:
        """Return a provider-internal verified path-safe voice-state artifact handle."""
        async with self._lock:
            return await asyncio.to_thread(
                self._with_fs_lock,
                self._resolve_voice_state_artifact_locked,
                voice_id,
                resident_base_identity,
            )

    async def export_clone_voice_state(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> ExportedCloneVoiceState:
        """Return verified clone-state bytes for same-base manage operations only."""
        async with self._lock:
            return await asyncio.to_thread(
                self._with_fs_lock,
                self._export_clone_voice_state_locked,
                voice_id,
                resident_base_identity,
            )

    async def delete_voice(self, voice_id: str) -> None:
        """Quarantine, commit, and delete profile artifacts for a logical voice."""
        async with self._lock:
            await asyncio.to_thread(self._with_fs_lock, self._delete_voice_locked, voice_id)

    def _with_fs_lock(self, func, *args):  # type: ignore[no-untyped-def]
        self._ensure_layout()
        with _FileLock(self._lock_path):
            self._ensure_layout()
            self._finish_pending_deletions()
            return func(*args)

    def _install_standard_pack_locked(
        self, manifest_path: Path, artifact_root: Path
    ) -> tuple[VoiceProfileInventoryEntry, ...]:
        manifest = _read_manifest(manifest_path)
        source_root = _real_directory_root(artifact_root)
        state = self._read_state()
        staged_root = self._tmp_dir / f"install.{uuid.uuid4().hex}"
        staged_profiles: list[tuple[_PersistedProfile, Path]] = []
        promoted_dirs: list[Path] = []

        profile_keys = {
            _profile_key(
                asset.logical_voice_id,
                asset.runtime_target,
                asset.language_bundle,
                asset.compatibility_group,
                asset.artifact_revision,
            )
            for asset in manifest.assets
        }
        if len(profile_keys) != len(manifest.assets):
            raise VoiceArtifactError("manifest contains duplicate profile state")

        try:
            staged_root.mkdir(parents=True)
            for asset in manifest.assets:
                _validate_supported_voice_state_runtime(asset.runtime_target)
                _validate_safetensors_name(asset.relative_path)
                _reject_lexical_symlink_components(artifact_root, asset.relative_path)
                source_path = _resolve_safe_child(source_root, asset.relative_path)
                if not source_path.is_file():
                    raise VoiceArtifactError("artifact missing")
                _reject_symlink_path(source_root, source_path)
                _verify_file(
                    source_path, expected_size=asset.size_bytes, expected_sha256=asset.sha256
                )
                _validate_safetensors_file(source_path, expected_size=asset.size_bytes)
                profile_key = _profile_key(
                    asset.logical_voice_id,
                    asset.runtime_target,
                    asset.language_bundle,
                    asset.compatibility_group,
                    asset.artifact_revision,
                )
                if profile_key in state.profiles or profile_key in state.deletions:
                    raise VoiceArtifactError("profile already installed")
                final_dir = _profile_dir(self._artifacts_dir, profile_key)
                if final_dir.exists():
                    raise VoiceArtifactError("artifact destination already exists")

                profile_stage = staged_root / profile_key
                profile_stage.mkdir()
                staged_file = profile_stage / Path(asset.relative_path).name
                _copy_verified_file(
                    source_path,
                    staged_file,
                    expected_size=asset.size_bytes,
                    expected_sha256=asset.sha256,
                )
                _validate_safetensors_file(staged_file, expected_size=asset.size_bytes)
                staged_profiles.append(
                    (
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
                            artifacts=(
                                _PersistedArtifact(
                                    relative_ref=str(
                                        PurePosixPath("artifacts") / profile_key / staged_file.name
                                    ),
                                    size_bytes=asset.size_bytes,
                                    sha256=asset.sha256,
                                    format="safetensors",
                                ),
                            ),
                            source_retained=False,
                            license_name=asset.license_name,
                            attribution=asset.attribution,
                        ),
                        profile_stage,
                    )
                )

            for profile, staged_dir in staged_profiles:
                final_dir = _profile_dir(self._artifacts_dir, profile.profile_key)
                os.replace(staged_dir, final_dir)
                _fsync_dir(self._artifacts_dir)
                promoted_dirs.append(final_dir)

            installed = {profile.profile_key: profile for profile, _ in staged_profiles}
            updated = state.model_copy(update={"profiles": {**state.profiles, **installed}})
            self._write_state(updated)
        except Exception:
            rollback_errors: list[Exception] = []
            for directory in promoted_dirs:
                try:
                    _remove_tree(directory)
                except Exception as exc:  # pragma: no cover - hard to trigger portably
                    rollback_errors.append(exc)
            try:
                if staged_root.exists():
                    _remove_tree(staged_root)
            except Exception as exc:  # pragma: no cover - hard to trigger portably
                rollback_errors.append(exc)
            if rollback_errors:
                raise VoiceArtifactError("artifact rollback failed") from rollback_errors[0]
            raise
        finally:
            if staged_root.exists():
                _remove_tree(staged_root)

        return tuple(_inventory_entry(profile) for profile, _ in staged_profiles)

    def _create_clone_profile_locked(
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
        if source_retention:
            raise VoiceArtifactError("retained clone source storage is unavailable")
        if not artifact_bytes:
            raise VoiceArtifactError("clone artifact is empty")
        if len(artifact_bytes) > self._max_clone_artifact_bytes:
            raise VoiceArtifactError("clone artifact exceeds configured size limit")
        _validate_supported_voice_state_runtime(runtime_target)
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
        state = self._read_state()
        if profile_key in state.profiles or profile_key in state.deletions:
            raise VoiceArtifactError("profile already installed")

        final_dir = _profile_dir(self._artifacts_dir, profile_key)
        staging_dir = self._tmp_dir / f"{profile_key}.{uuid.uuid4().hex}"
        staged_name = "voice-state.safetensors"
        digest = hashlib.sha256(artifact_bytes).hexdigest()
        try:
            staging_dir.mkdir(parents=True)
            staged_file = staging_dir / staged_name
            _write_bytes_no_follow(staged_file, artifact_bytes)
            _validate_safetensors_file(staged_file, expected_size=len(artifact_bytes))
            _verify_file(staged_file, expected_size=len(artifact_bytes), expected_sha256=digest)
            os.replace(staging_dir, final_dir)
            _fsync_dir(self._artifacts_dir)
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
                artifacts=(
                    _PersistedArtifact(
                        relative_ref=str(PurePosixPath("artifacts") / profile_key / staged_name),
                        size_bytes=len(artifact_bytes),
                        sha256=digest,
                        format="safetensors",
                    ),
                ),
                source_retained=False,
            )
            self._write_state(
                state.model_copy(update={"profiles": {**state.profiles, profile_key: profile}})
            )
        except Exception:
            if final_dir.exists():
                _remove_tree(final_dir)
            if staging_dir.exists():
                _remove_tree(staging_dir)
            raise
        return _inventory_entry(profile)

    def _catalog_locked(
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

    def _inventory_locked(self) -> tuple[VoiceProfileInventoryEntry, ...]:
        return tuple(
            sorted(
                (_inventory_entry(profile) for profile in self._read_state().profiles.values()),
                key=lambda entry: entry.profile_key,
            )
        )

    def _select_voice_locked(
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

    def _resolve_voice_state_artifact_locked(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> VoiceStateArtifactHandle:
        return self._verified_voice_state_artifact_locked(voice_id, resident_base_identity)

    def _export_clone_voice_state_locked(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> ExportedCloneVoiceState:
        artifact = self._verified_voice_state_artifact_locked(
            voice_id,
            resident_base_identity,
            required_kind="clone",
        )
        try:
            payload = _read_all_from_fd(artifact.fd, expected_size=artifact.size_bytes)
        finally:
            os.close(artifact.fd)
        return ExportedCloneVoiceState(
            voice_id=artifact.voice_id,
            runtime_target=artifact.runtime_target,
            language_bundle=artifact.language_bundle,
            compatibility_group=artifact.compatibility_group,
            artifact_revision=artifact.artifact_revision,
            sha256=artifact.sha256,
            size_bytes=artifact.size_bytes,
            format=artifact.format,
            artifact_bytes=payload,
        )

    def _verified_voice_state_artifact_locked(
        self,
        voice_id: str,
        resident_base_identity: VoiceBaseIdentity,
        *,
        required_kind: ProfileKind | None = None,
    ) -> VoiceStateArtifactHandle:
        profile = self._select_profile_locked(voice_id, resident_base_identity)
        if required_kind is not None and profile.kind != required_kind:
            raise VoiceSelectionError("voice is not available for this operation")
        return self._open_profile_voice_state_artifact(profile)

    def _select_profile_locked(
        self, voice_id: str, resident_base_identity: VoiceBaseIdentity
    ) -> _PersistedProfile:
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
        return matches[0]

    def _open_profile_voice_state_artifact(
        self, profile: _PersistedProfile
    ) -> VoiceStateArtifactHandle:
        _validate_supported_voice_state_runtime(profile.runtime_target)
        if len(profile.artifacts) != 1:
            raise VoiceArtifactError("voice state profile must have exactly one artifact")
        artifact = profile.artifacts[0]
        if artifact.format != "safetensors":
            raise VoiceArtifactError("voice state artifact format is invalid")
        artifact_ref = _validate_artifact_ref_ownership(artifact.relative_ref, profile.profile_key)
        _reject_lexical_symlink_components(self._real_root(), artifact.relative_ref)
        artifact_path = self._resolve_registry_ref(artifact.relative_ref)
        if artifact_path != self._real_root().joinpath(*artifact_ref.parts):
            raise VoiceArtifactError("registry artifact ref does not match profile")
        fd = _open_registry_artifact_no_symlinks(self._real_root(), artifact_ref)
        try:
            _verify_open_file(
                fd, expected_size=artifact.size_bytes, expected_sha256=artifact.sha256
            )
            _validate_safetensors_fd(fd, expected_size=artifact.size_bytes)
            os.lseek(fd, 0, os.SEEK_SET)
        except Exception:
            os.close(fd)
            raise
        return VoiceStateArtifactHandle(
            voice_id=profile.voice_id,
            runtime_target=profile.runtime_target,
            language_bundle=profile.language_bundle,
            compatibility_group=profile.compatibility_group,
            artifact_revision=profile.artifact_revision,
            relative_ref=artifact.relative_ref,
            sha256=artifact.sha256,
            size_bytes=artifact.size_bytes,
            format=artifact.format,
            fd=fd,
        )

    def _delete_voice_locked(self, voice_id: str) -> None:
        validate_logical_voice_id(voice_id)
        state = self._read_state()
        removed = [profile for profile in state.profiles.values() if profile.voice_id == voice_id]
        if not removed:
            return

        deletions = dict(state.deletions)
        remaining = dict(state.profiles)
        for profile in removed:
            profile_key = _expected_profile_key(profile)
            source_dir = _profile_dir(self._artifacts_dir, profile_key)
            tombstone_dir = _profile_dir(self._tombstones_dir, profile_key)
            if tombstone_dir.exists():
                raise VoiceArtifactError("profile deletion is already pending")
            if source_dir.exists():
                os.replace(source_dir, tombstone_dir)
                _fsync_dir(self._artifacts_dir)
                _fsync_dir(self._tombstones_dir)
            deletions[profile_key] = _DeletionRecord(
                profile_key=profile_key,
                voice_id=profile.voice_id,
                tombstone_ref=str(PurePosixPath("tombstones") / profile_key),
            )
            remaining.pop(profile_key, None)

        self._write_state(state.model_copy(update={"profiles": remaining, "deletions": deletions}))
        self._finish_pending_deletions()

    def _ensure_layout(self) -> None:
        _reject_symlink_ancestors(self.root)
        if self.root.exists() and self.root.is_symlink():
            raise VoiceArtifactError("registry root path uses symlink")
        self.root.mkdir(parents=True, exist_ok=True)
        self._real_root()
        for directory in (self._artifacts_dir, self._tmp_dir, self._tombstones_dir):
            if directory.exists() and directory.is_symlink():
                raise VoiceArtifactError("registry protected path uses symlink")
            directory.mkdir(parents=True, exist_ok=True)
            _ensure_within_root(directory.resolve(strict=True), self._real_root())
        for path in (self._state_path, self._lock_path):
            if path.exists() and path.is_symlink():
                raise VoiceArtifactError("registry protected file uses symlink")
            _ensure_within_root(path.parent.resolve(strict=True), self._real_root())

    def _read_state(self) -> _RegistryState:
        self._ensure_layout()
        if not self._state_path.exists():
            return _RegistryState()
        if self._state_path.is_symlink():
            raise VoiceArtifactError("registry state path uses symlink")
        if self._state_path.stat().st_size > _MAX_JSON_BYTES:
            raise VoiceArtifactError("registry state is too large")
        try:
            state = cast(
                _RegistryState,
                _RegistryState.model_validate_json(_read_text_no_follow(self._state_path)),
            )
        except (OSError, ValidationError, ValueError) as exc:
            raise VoiceArtifactError("registry state is invalid") from exc
        self._validate_state(state)
        return state

    def _write_state(self, state: _RegistryState) -> None:
        self._validate_state(state, require_artifacts=False)
        payload = state.model_dump_json(indent=2).encode("utf-8")
        if len(payload) > _MAX_JSON_BYTES:
            raise VoiceArtifactError("registry state is too large")
        tmp_path = self._tmp_dir / f"voice-registry.{uuid.uuid4().hex}.json"
        _write_bytes_no_follow(tmp_path, payload)
        os.replace(tmp_path, self._state_path)
        _fsync_dir(self.root)

    def _validate_state(self, state: _RegistryState, *, require_artifacts: bool = True) -> None:
        seen_refs: set[str] = set()
        for key, profile in state.profiles.items():
            if key != profile.profile_key:
                raise VoiceArtifactError("registry state profile key mismatch")
            profile_key = _expected_profile_key(profile)
            if key != profile_key:
                raise VoiceArtifactError("registry state profile key is invalid")
            validate_logical_voice_id(profile.voice_id)
            for value in (
                profile.runtime_target,
                profile.language_bundle,
                profile.compatibility_group,
                profile.artifact_revision,
            ):
                if not _COMPONENT_RE.fullmatch(value):
                    raise VoiceArtifactError("registry state profile component is invalid")
            _validate_supported_voice_state_runtime(profile.runtime_target)
            if not profile.artifacts:
                raise VoiceArtifactError("registry state profile has no artifacts")
            for artifact in profile.artifacts:
                _validate_artifact_ref_ownership(artifact.relative_ref, profile_key)
                artifact_path = self._resolve_registry_ref(
                    artifact.relative_ref, must_exist=require_artifacts
                )
                if artifact.relative_ref in seen_refs:
                    raise VoiceArtifactError("registry artifact ref is duplicated")
                seen_refs.add(artifact.relative_ref)
                if artifact.format != "safetensors":
                    raise VoiceArtifactError("registry artifact format is invalid")
                _validate_safetensors_name(artifact.relative_ref)
                if require_artifacts:
                    _reject_lexical_symlink_components(self._real_root(), artifact.relative_ref)
                    _reject_symlink_path(self._real_root(), artifact_path)
                    _verify_file(
                        artifact_path,
                        expected_size=artifact.size_bytes,
                        expected_sha256=artifact.sha256,
                    )
                    _validate_safetensors_file(artifact_path, expected_size=artifact.size_bytes)
        for key, record in state.deletions.items():
            if key != record.profile_key or not _PROFILE_KEY_RE.fullmatch(record.profile_key):
                raise VoiceArtifactError("registry deletion record is invalid")
            validate_logical_voice_id(record.voice_id)
            tombstone_path = self._resolve_registry_ref(record.tombstone_ref, must_exist=False)
            expected = _profile_dir(self._tombstones_dir, record.profile_key)
            if tombstone_path != expected:
                raise VoiceArtifactError("registry deletion tombstone path is invalid")

    def _resolve_registry_ref(self, relative_ref: str, *, must_exist: bool = True) -> Path:
        _safe_relative_path(relative_ref)
        root = self._real_root()
        candidate = root / relative_ref
        if must_exist:
            resolved = candidate.resolve(strict=True)
        else:
            resolved = root.joinpath(*PurePosixPath(relative_ref).parts)
        _ensure_within_root(resolved, root)
        return resolved

    def _finish_pending_deletions(self) -> None:
        state = self._read_state_without_recovery()
        remaining_profiles = dict(state.profiles)
        remaining_deletions = dict(state.deletions)
        discovered = False
        for tombstone_path in self._tombstones_dir.iterdir():
            if not tombstone_path.is_dir():
                raise VoiceArtifactError("invalid deletion tombstone entry")
            profile_key = tombstone_path.name
            if not _PROFILE_KEY_RE.fullmatch(profile_key):
                raise VoiceArtifactError("invalid deletion tombstone entry")
            if profile_key not in remaining_deletions:
                profile = remaining_profiles.pop(profile_key, None)
                if profile is None:
                    _remove_tree(tombstone_path)
                    _fsync_dir(self._tombstones_dir)
                    continue
                remaining_deletions[profile_key] = _DeletionRecord(
                    profile_key=profile_key,
                    voice_id=profile.voice_id,
                    tombstone_ref=str(PurePosixPath("tombstones") / profile_key),
                )
                discovered = True

        if discovered:
            state = state.model_copy(
                update={"profiles": remaining_profiles, "deletions": remaining_deletions}
            )
            self._write_state(state)

        if not state.deletions:
            return
        remaining = dict(state.deletions)
        for key, record in state.deletions.items():
            tombstone_path = self._resolve_registry_ref(record.tombstone_ref, must_exist=False)
            if tombstone_path.exists():
                _remove_tree(tombstone_path)
                _fsync_dir(self._tombstones_dir)
            remaining.pop(key, None)
        self._write_state(state.model_copy(update={"deletions": remaining}))

    def _read_state_without_recovery(self) -> _RegistryState:
        if not self._state_path.exists():
            return _RegistryState()
        if self._state_path.is_symlink():
            raise VoiceArtifactError("registry state path uses symlink")
        if self._state_path.stat().st_size > _MAX_JSON_BYTES:
            raise VoiceArtifactError("registry state is too large")
        try:
            state = cast(
                _RegistryState,
                _RegistryState.model_validate_json(_read_text_no_follow(self._state_path)),
            )
        except (OSError, ValidationError, ValueError) as exc:
            raise VoiceArtifactError("registry state is invalid") from exc
        self._validate_state(state, require_artifacts=False)
        return state

    def _real_root(self) -> Path:
        return self.root.resolve(strict=True)


def _read_manifest(path: Path) -> VoicePackManifest:
    fd = -1
    try:
        _reject_symlink_ancestors(path)
        mode = os.lstat(path).st_mode
        if not stat.S_ISREG(mode):
            raise VoiceManifestError("manifest is not a file")
        fd = _open_no_follow_read(path)
        size = os.fstat(fd).st_size
        if size > _MAX_JSON_BYTES:
            raise VoiceManifestError("manifest is too large")
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            fd = -1
            return cast(VoicePackManifest, VoicePackManifest.model_validate_json(handle.read()))
    except VoiceManifestError:
        raise
    except (OSError, ValidationError, ValueError) as exc:
        raise VoiceManifestError("invalid voice manifest") from exc
    finally:
        if fd >= 0:
            os.close(fd)


def _validate_supported_voice_state_runtime(runtime_target: str) -> None:
    if runtime_target not in _SUPPORTED_VOICE_STATE_RUNTIMES:
        raise VoiceArtifactError("voice state runtime is not supported")


def _validate_artifact_ref_ownership(relative_ref: str, profile_key: str) -> PurePosixPath:
    ref = _safe_relative_path(relative_ref)
    parts = ref.parts
    if len(parts) != 3 or parts[0] != "artifacts" or parts[1] != profile_key:
        raise VoiceArtifactError("registry artifact ref does not match profile")
    _validate_safetensors_name(relative_ref)
    return ref


def _validate_safetensors_name(path: str) -> None:
    relative_path = _safe_relative_path(path)
    if PurePosixPath(relative_path).suffix != ".safetensors":
        raise VoiceArtifactError("voice state artifact must use .safetensors")


def _validate_safetensors_file(path: Path, *, expected_size: int) -> None:
    fd = _open_no_follow_read(path)
    try:
        _validate_safetensors_fd(fd, expected_size=expected_size)
    finally:
        os.close(fd)


def _validate_safetensors_fd(fd: int, *, expected_size: int) -> None:
    if expected_size < 9:
        raise VoiceArtifactError("safetensors artifact is truncated")
    os.lseek(fd, 0, os.SEEK_SET)
    actual_size = os.fstat(fd).st_size
    if actual_size != expected_size:
        raise VoiceArtifactError("safetensors artifact size mismatch")
    header_prefix = _read_exact_fd(fd, 8, error_message="safetensors artifact is truncated")
    header_size = struct.unpack("<Q", header_prefix)[0]
    if header_size < 2 or header_size > _MAX_SAFETENSORS_HEADER_BYTES:
        raise VoiceArtifactError("safetensors header size is invalid")
    if header_size > actual_size - 8:
        raise VoiceArtifactError("safetensors header exceeds artifact size")
    header_bytes = _read_exact_fd(fd, header_size, error_message="safetensors header is truncated")
    data_size = actual_size - 8 - header_size
    _validate_safetensors_header(header_bytes, data_size=data_size)


def _validate_safetensors_header(header_bytes: bytes, *, data_size: int) -> None:
    if not header_bytes or header_bytes[0] != ord("{"):
        raise VoiceArtifactError("safetensors header is invalid")
    try:
        header_text = header_bytes.decode("utf-8")
        decoder = json.JSONDecoder(object_pairs_hook=_json_no_duplicates)
        header, end_index = decoder.raw_decode(header_text)
    except (UnicodeDecodeError, json.JSONDecodeError, VoiceArtifactError) as exc:
        raise VoiceArtifactError("safetensors header is invalid") from exc
    if any(character != " " for character in header_text[end_index:]):
        raise VoiceArtifactError("safetensors header padding is invalid")
    if not isinstance(header, dict):
        raise VoiceArtifactError("safetensors header must be an object")
    spans: list[tuple[int, int]] = []
    tensor_count = 0
    for name, descriptor in header.items():
        if not isinstance(name, str) or not name:
            raise VoiceArtifactError("safetensors tensor name is invalid")
        if name == "__metadata__":
            _validate_safetensors_metadata(descriptor)
            continue
        tensor_count += 1
        if not isinstance(descriptor, dict):
            raise VoiceArtifactError("safetensors tensor descriptor is invalid")
        if set(descriptor) != {"dtype", "shape", "data_offsets"}:
            raise VoiceArtifactError("safetensors tensor descriptor is invalid")
        dtype = descriptor["dtype"]
        shape = descriptor["shape"]
        offsets = descriptor["data_offsets"]
        if not isinstance(dtype, str) or dtype not in _SAFETENSORS_DTYPES:
            raise VoiceArtifactError("safetensors tensor dtype is invalid")
        if not isinstance(shape, list) or not all(
            type(dimension) is int and dimension >= 0 for dimension in shape
        ):
            raise VoiceArtifactError("safetensors tensor shape is invalid")
        if not isinstance(offsets, list) or len(offsets) != 2:
            raise VoiceArtifactError("safetensors tensor offsets are invalid")
        start, end = offsets
        if type(start) is not int or type(end) is not int:
            raise VoiceArtifactError("safetensors tensor offsets are invalid")
        if start < 0 or end < start or end > data_size:
            raise VoiceArtifactError("safetensors tensor offsets exceed data")
        element_count = math.prod(shape) if shape else 1
        expected_bytes = element_count * _SAFETENSORS_DTYPES[dtype]
        if end - start != expected_bytes:
            raise VoiceArtifactError("safetensors tensor byte range is invalid")
        spans.append((start, end))
    if tensor_count < 1:
        raise VoiceArtifactError("safetensors artifact has no tensors")
    spans.sort()
    cursor = 0
    for start, end in spans:
        if start != cursor:
            raise VoiceArtifactError("safetensors tensor data is not contiguous")
        cursor = end
    if cursor != data_size:
        raise VoiceArtifactError("safetensors tensor data does not cover artifact")


def _validate_safetensors_metadata(value: object) -> None:
    if not isinstance(value, dict):
        raise VoiceArtifactError("safetensors metadata is invalid")
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise VoiceArtifactError("safetensors metadata is invalid")


def _json_no_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise VoiceArtifactError("safetensors header has duplicate keys")
        result[key] = value
    return result


def _safe_relative_path(value: str) -> PurePosixPath:
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError("unsafe relative path")
    if "\\" in value:
        raise ValueError("unsafe relative path")
    return candidate


def _real_directory_root(path: Path) -> Path:
    if path.exists() and path.is_symlink():
        raise VoiceArtifactError("artifact root path uses symlink")
    root = path.resolve(strict=True)
    if not root.is_dir():
        raise VoiceArtifactError("artifact root is not a directory")
    _reject_symlink_ancestors(path)
    return root


def _resolve_safe_child(root: Path, relative_path: str) -> Path:
    _safe_relative_path(relative_path)
    candidate = root / relative_path
    resolved = candidate.resolve(strict=True)
    if not _is_relative_to(resolved, root):
        raise VoiceArtifactError("artifact path escapes root")
    return resolved


def _reject_symlink_path(root: Path, path: Path) -> None:
    current = root
    if current.is_symlink():
        raise VoiceArtifactError("path uses symlink")
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise VoiceArtifactError("path uses symlink")


def _reject_lexical_symlink_components(root: Path, relative_ref: str) -> None:
    current = root
    if stat.S_ISLNK(os.lstat(current).st_mode):
        raise VoiceArtifactError("path uses symlink")
    for part in _safe_relative_path(relative_ref).parts:
        current = current / part
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError as exc:
            raise VoiceArtifactError("artifact missing") from exc
        if stat.S_ISLNK(mode):
            raise VoiceArtifactError("path uses symlink")


def _reject_symlink_ancestors(path: Path) -> None:
    current = path if path.exists() else path.parent
    checked: list[Path] = []
    while current != current.parent:
        checked.append(current)
        current = current.parent
    for candidate in reversed(checked):
        if candidate.exists() and candidate.is_symlink():
            raise VoiceArtifactError("path uses symlink")


def _open_registry_artifact_no_symlinks(root: Path, relative_ref: PurePosixPath) -> int:
    dir_fd = os.open(root, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW)
    close_dir_fd = True
    try:
        parts = relative_ref.parts
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = next_fd
        file_fd = os.open(parts[-1], os.O_RDONLY | _O_NOFOLLOW, dir_fd=dir_fd)
        close_dir_fd = False
        os.close(dir_fd)
        return file_fd
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise VoiceArtifactError("path uses symlink") from exc
        if exc.errno == errno.ENOTDIR:
            raise VoiceArtifactError("artifact path is invalid") from exc
        if exc.errno == errno.ENOENT:
            raise VoiceArtifactError("artifact missing") from exc
        raise
    finally:
        if close_dir_fd:
            os.close(dir_fd)


def _verify_file(path: Path, *, expected_size: int, expected_sha256: str) -> None:
    digest = hashlib.sha256()
    size = 0
    fd = _open_no_follow_read(path)
    try:
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
    finally:
        if fd >= 0:
            os.close(fd)
    if size != expected_size:
        raise VoiceArtifactError("artifact size mismatch")
    if digest.hexdigest() != expected_sha256:
        raise VoiceArtifactError("artifact hash mismatch")


def _verify_open_file(fd: int, *, expected_size: int, expected_sha256: str) -> None:
    digest = hashlib.sha256()
    size = 0
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
    if size != expected_size:
        raise VoiceArtifactError("artifact size mismatch")
    if digest.hexdigest() != expected_sha256:
        raise VoiceArtifactError("artifact hash mismatch")


def _read_all_from_fd(fd: int, *, expected_size: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > expected_size:
            raise VoiceArtifactError("artifact size mismatch")
        chunks.append(chunk)
    if size != expected_size:
        raise VoiceArtifactError("artifact size mismatch")
    return b"".join(chunks)


def _read_exact_fd(fd: int, byte_count: int, *, error_message: str) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining:
        chunk = os.read(fd, remaining)
        if not chunk:
            raise VoiceArtifactError(error_message)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _copy_verified_file(
    source: Path, target: Path, *, expected_size: int, expected_sha256: str
) -> None:
    source_fd = _open_no_follow_read(source)
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_NOFOLLOW
        target_fd = os.open(target, flags, 0o600)
        try:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
                os.write(target_fd, chunk)
            if size != expected_size or digest.hexdigest() != expected_sha256:
                raise VoiceArtifactError("artifact verification changed during copy")
            os.fsync(target_fd)
        finally:
            os.close(target_fd)
    finally:
        os.close(source_fd)


def _write_bytes_no_follow(path: Path, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_text_no_follow(path: Path) -> str:
    fd = _open_no_follow_read(path)
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            fd = -1
            return handle.read()
    finally:
        if fd >= 0:
            os.close(fd)


def _open_no_follow_read(path: Path) -> int:
    try:
        return os.open(path, os.O_RDONLY | _O_NOFOLLOW)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise VoiceArtifactError("path uses symlink") from exc
        raise


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


def _expected_profile_key(profile: _PersistedProfile) -> str:
    expected = _profile_key(
        profile.voice_id,
        profile.runtime_target,
        profile.language_bundle,
        profile.compatibility_group,
        profile.artifact_revision,
    )
    if profile.profile_key != expected or not _PROFILE_KEY_RE.fullmatch(profile.profile_key):
        raise VoiceArtifactError("registry state profile key is invalid")
    return expected


def _profile_dir(parent: Path, profile_key: str) -> Path:
    if not _PROFILE_KEY_RE.fullmatch(profile_key):
        raise VoiceArtifactError("profile key is invalid")
    return parent / profile_key


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


def _remove_tree(path: Path) -> None:
    if path.is_symlink():
        raise VoiceArtifactError("refusing to delete symlink")
    shutil.rmtree(path)


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _ensure_within_root(path: Path, root: Path) -> None:
    if not _is_relative_to(path, root):
        raise VoiceArtifactError("path escapes registry root")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
