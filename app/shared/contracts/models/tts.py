"""TTS (Text-to-Speech) service contract models."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.speech import (
    MAX_JS_SAFE_INTEGER,
    LogicalVoiceId,
    SpeechLanguageTag,
    SpeechStorageSummary,
    normalize_exact_speech_language,
    normalize_speech_language,
    validate_logical_voice_id,
)
from app.shared.contracts.registry import IOModel

VOICE_IMPORT_MAX_TOTAL_BYTES = 2 * 1024 * 1024
VOICE_IMPORT_MAX_CHUNK_BYTES = 48 * 1024
VOICE_IMPORT_MAX_CHUNKS = 43
VOICE_IMPORT_MAX_SEQUENCE = VOICE_IMPORT_MAX_CHUNKS - 1
VOICE_IMPORT_MAX_JSON_BYTES = 128 * 1024
VOICE_IMPORT_MAX_BASE64_CHARS = 65_536
VOICE_IMPORT_MAX_DURATION_MS = 15_000
TTS_MIN_SAMPLE_RATE = 8_000
TTS_MAX_SAMPLE_RATE = 192_000
TTS_MAX_CHANNELS = 8
TTS_MAX_STREAM_SEQUENCE = MAX_JS_SAFE_INTEGER

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SEALED_AUDIO_REF_RE = re.compile(r"^voice-import:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
TTSOutputFormat = Literal["wav", "raw"]


def _normalize_sha256(value: str, field_name: str) -> str:
    if not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a SHA-256 hex digest")
    return value


def _non_blank(value: str, field_name: str) -> str:
    if not value.strip():
        raise ValueError(f"{field_name} must not be blank")
    return value


def _normalize_operation_id(value: str) -> str:
    if not _OPERATION_ID_RE.fullmatch(value.strip()):
        raise ValueError("operation_id must be nonblank and bounded")
    return value.strip()


def _normalize_optional_voice_id(value: str | None) -> LogicalVoiceId | None:
    return validate_logical_voice_id(value) if value is not None else None


def _default_output_formats() -> list[TTSOutputFormat]:
    return ["wav", "raw"]


class _StrictTTSIOModel(IOModel):
    """Forbid undeclared fields on newly introduced public TTS contracts."""

    model_config = ConfigDict(extra="forbid")


# Module identifier
class TTSModule:
    """Module identifier for TTS service."""

    NAME = "TTS"


# Method identifiers
class TTSMethods:
    """Full method identifiers for TTS service."""

    REQUEST = f"{TTSModule.NAME}.Request"
    SYNTHESIZE = f"{TTSModule.NAME}.Synthesize"  # External: returns audio data
    GET_CAPABILITIES = f"{TTSModule.NAME}.GetCapabilities"
    LIST_VOICES = f"{TTSModule.NAME}.ListVoices"
    LIST_VOICE_PROFILES = f"{TTSModule.NAME}.ListVoiceProfiles"
    GET_VOICE_PROFILE = f"{TTSModule.NAME}.GetVoiceProfile"
    UPDATE_VOICE_PROFILE = f"{TTSModule.NAME}.UpdateVoiceProfile"
    INSTALL_VOICE_PROFILE = f"{TTSModule.NAME}.InstallVoiceProfile"
    REMOVE_VOICE_PROFILE = f"{TTSModule.NAME}.RemoveVoiceProfile"
    SET_DEFAULT_VOICE = f"{TTSModule.NAME}.SetDefaultVoice"
    VOICE_IMPORT_START = f"{TTSModule.NAME}.VoiceImportStart"
    VOICE_IMPORT_CHUNK = f"{TTSModule.NAME}.VoiceImportChunk"
    VOICE_IMPORT_END = f"{TTSModule.NAME}.VoiceImportEnd"
    VOICE_IMPORT_ABORT = f"{TTSModule.NAME}.VoiceImportAbort"
    CREATE_VOICE_PROFILE = f"{TTSModule.NAME}.CreateVoiceProfile"
    DELETE_VOICE_PROFILE = f"{TTSModule.NAME}.DeleteVoiceProfile"
    STREAM_START = f"{TTSModule.NAME}.StreamStart"
    STREAM_CHUNK = f"{TTSModule.NAME}.StreamChunk"
    STREAM_END = f"{TTSModule.NAME}.StreamEnd"
    AUDIO_CHUNK = f"{TTSModule.NAME}.AudioChunk"
    STOP = f"{TTSModule.NAME}.Stop"
    PAUSE = f"{TTSModule.NAME}.Pause"
    RESUME = f"{TTSModule.NAME}.Resume"
    STARTED = f"{TTSModule.NAME}.Started"
    STOPPED = f"{TTSModule.NAME}.Stopped"
    PAUSED = f"{TTSModule.NAME}.Paused"
    RESUMED = f"{TTSModule.NAME}.Resumed"
    ERROR = f"{TTSModule.NAME}.Error"
    HEALTH_CHECK = f"{TTSModule.NAME}.HealthCheck"


class TTSRequest(IOModel):
    """Request to synthesize and play speech."""

    text: str
    voice: LogicalVoiceId | None = None
    language: SpeechLanguageTag | None = None
    speed: float = 1.0
    interrupt: bool = True  # Interrupt current playback
    mesh_selector: MeshAddressSelector | None = None

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        normalized = normalize_speech_language(value, allow_auto=True)
        if normalized == "auto":
            raise ValueError("TTS language must be exact, not auto")
        return normalized

    @field_validator("voice", mode="before")
    @classmethod
    def _validate_voice_id(cls, value: str | None) -> str | None:
        return _normalize_optional_voice_id(value)


class TTSStopRequest(IOModel):
    """Request to stop TTS playback or cancel scoped TTS streams.

    Empty payloads remain valid for legacy trusted internal stop callers. Scoped
    remote callers should provide a correlation id and may optionally target one
    stream id.
    """

    correlation_id: str | None = None
    stream_id: str | None = None
    reason: str = "stopped"
    mesh_selector: MeshAddressSelector | None = None


class TTSSynthesizeRequest(IOModel):
    """Request to synthesize speech and return audio data (for external API)."""

    text: str
    voice: LogicalVoiceId | None = None
    language: SpeechLanguageTag | None = None
    speed: float = 1.0
    format: str = "wav"  # "wav" | "raw"
    sample_rate: int | None = Field(default=None, gt=0, le=TTS_MAX_SAMPLE_RATE)
    mesh_selector: MeshAddressSelector | None = None

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        normalized = normalize_speech_language(value, allow_auto=True)
        if normalized == "auto":
            raise ValueError("TTS language must be exact, not auto")
        return normalized

    @field_validator("voice", mode="before")
    @classmethod
    def _validate_voice_id(cls, value: str | None) -> str | None:
        return _normalize_optional_voice_id(value)


class TTSSynthesizeResponse(IOModel):
    """Synthesized audio response."""

    audio_data: str  # Base64-encoded audio
    format: str
    sample_rate: int = Field(gt=0, le=TTS_MAX_SAMPLE_RATE)
    channels: int = Field(ge=1, le=TTS_MAX_CHANNELS)
    duration_ms: float
    text: str


class TTSStreamStartRequest(IOModel):
    """Start an ordered text-to-speech streaming session.

    Stream sessions accept text fragments through ``TTSStreamChunkRequest`` and
    publish synthesized audio fragments as ``TTSAudioChunkEvent`` events.
    """

    stream_id: str
    voice: LogicalVoiceId | None = None
    language: SpeechLanguageTag | None = None
    speed: float = 1.0
    format: str = "wav"  # "wav" | "raw"
    sample_rate: int | None = Field(default=None, gt=0, le=TTS_MAX_SAMPLE_RATE)
    interrupt: bool = True  # Stop current server playback/streams before starting
    play_on_server: bool = True  # Also play chunks through local server audio output
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        normalized = normalize_speech_language(value, allow_auto=True)
        if normalized == "auto":
            raise ValueError("TTS language must be exact, not auto")
        return normalized

    @field_validator("voice", mode="before")
    @classmethod
    def _validate_voice_id(cls, value: str | None) -> str | None:
        return _normalize_optional_voice_id(value)


class TTSGetCapabilitiesRequest(_StrictTTSIOModel):
    """Request TTS runtime capabilities for a selected recipient."""

    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = Field(default=None, max_length=256)


class TTSResidentLanguagePack(_StrictTTSIOModel):
    """Language readiness bound to one resident provider-neutral pack id."""

    pack_id: str = Field(min_length=1, max_length=256)
    ready_languages: list[SpeechLanguageTag] = Field(default_factory=list, max_length=64)

    @field_validator("pack_id")
    @classmethod
    def _validate_pack_id(cls, value: str) -> str:
        return _non_blank(value, "pack_id")

    @field_validator("ready_languages", mode="before")
    @classmethod
    def _normalize_languages(cls, value: list[str]) -> list[SpeechLanguageTag]:
        return sorted({normalize_exact_speech_language(item) for item in value})


class TTSCapabilities(_StrictTTSIOModel):
    """Redacted provider-neutral TTS capability projection."""

    contract_revision: Literal["aurora-tts-capabilities-v1"] = "aurora-tts-capabilities-v1"
    ready: bool = False
    model_status: Literal["unavailable", "loading", "ready", "degraded", "error"] = "unavailable"
    supported_language_pack_ids: list[str] = Field(default_factory=list, max_length=64)
    installed_language_pack_ids: list[str] = Field(default_factory=list, max_length=64)
    resident_language_pack_ids: list[str] = Field(default_factory=list, max_length=8)
    resident_language_packs: list[TTSResidentLanguagePack] = Field(
        default_factory=list, max_length=8
    )
    ready_languages: list[SpeechLanguageTag] = Field(default_factory=list, max_length=64)
    output_formats: list[TTSOutputFormat] = Field(
        default_factory=_default_output_formats, max_length=2
    )
    sample_rates: list[Annotated[int, Field(ge=TTS_MIN_SAMPLE_RATE, le=TTS_MAX_SAMPLE_RATE)]] = (
        Field(default_factory=list, max_length=16)
    )
    streaming: bool = False
    cancellation: bool = False
    cloning: bool = False
    accepted_clone_import_formats: list[Literal["wav", "pcm_s16le"]] = Field(
        default_factory=list, max_length=2
    )
    max_clone_import_bytes: int = Field(default=0, ge=0, le=VOICE_IMPORT_MAX_TOTAL_BYTES)
    max_clone_chunk_bytes: int = Field(default=0, ge=0, le=VOICE_IMPORT_MAX_CHUNK_BYTES)
    standard_pack_revision: str | None = Field(default=None, min_length=1, max_length=256)
    voice_selection_mode: Literal["active_only", "shared_model_state", "in_model_speaker"] = (
        "active_only"
    )
    max_resident_base_models: int = Field(default=1, ge=1, le=8)
    resident_base_model_count: int = Field(default=0, ge=0, le=8)
    requires_model_reload_for_voice_change: bool = True
    voice_state_memory_class: Literal["none", "small_state", "full_model"] = "none"
    capability_revision: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)

    @field_validator("ready_languages", mode="before")
    @classmethod
    def _normalize_languages(cls, value: list[str]) -> list[SpeechLanguageTag]:
        return sorted({normalize_exact_speech_language(item) for item in value})

    @field_validator(
        "supported_language_pack_ids", "installed_language_pack_ids", "resident_language_pack_ids"
    )
    @classmethod
    def _nonblank_pack_ids(cls, value: list[str]) -> list[str]:
        normalized = sorted({_non_blank(item, "list value") for item in value})
        if any(len(item) > 256 for item in normalized):
            raise ValueError("language pack id exceeds limit")
        return normalized

    @field_validator("sample_rates")
    @classmethod
    def _validate_sample_rates(cls, value: list[int]) -> list[int]:
        if any(rate < 8_000 or rate > 192_000 for rate in value):
            raise ValueError("sample rates must be between 8000 and 192000 Hz")
        return sorted(set(value))

    @model_validator(mode="after")
    def _validate_capabilities(self) -> TTSCapabilities:
        supported = set(self.supported_language_pack_ids)
        installed = set(self.installed_language_pack_ids)
        resident = set(self.resident_language_pack_ids)
        binding_ids = [binding.pack_id for binding in self.resident_language_packs]
        if len(binding_ids) != len(set(binding_ids)):
            raise ValueError("resident language pack bindings must be unique")
        if set(binding_ids) != resident:
            raise ValueError("resident language pack ids and bindings must match")
        bound_ready_languages = {
            language
            for binding in self.resident_language_packs
            for language in binding.ready_languages
        }
        if bound_ready_languages != set(self.ready_languages):
            raise ValueError("ready languages must match resident language pack bindings")
        if not installed.issubset(supported):
            raise ValueError("installed language packs must be supported")
        if not resident.issubset(installed):
            raise ValueError("resident language packs must be installed")
        if self.resident_base_model_count > self.max_resident_base_models:
            raise ValueError("resident base model count exceeds limit")
        if not self.ready and self.ready_languages:
            raise ValueError("ready=false cannot advertise ready languages")
        if self.ready:
            if self.model_status not in {"ready", "degraded"}:
                raise ValueError("ready capability needs a usable model status")
            if not self.ready_languages or not resident:
                raise ValueError("ready capability needs resident languages and packs")
            if self.resident_base_model_count < 1:
                raise ValueError("ready capability needs a resident base model")
            if not self.output_formats or not self.sample_rates:
                raise ValueError("ready capability needs output formats and sample rates")
        elif self.model_status == "ready":
            raise ValueError("model_status=ready requires ready=true")
        if self.cloning:
            if not self.accepted_clone_import_formats:
                raise ValueError("cloning needs at least one accepted import format")
            if self.max_clone_import_bytes < 1 or self.max_clone_chunk_bytes < 1:
                raise ValueError("cloning needs positive import limits")
        elif (
            self.accepted_clone_import_formats
            or self.max_clone_import_bytes
            or self.max_clone_chunk_bytes
        ):
            raise ValueError("cloning=false cannot advertise clone import support")
        return self


class TTSGetCapabilitiesResponse(_StrictTTSIOModel):
    """TTS runtime capabilities response."""

    capabilities: TTSCapabilities
    correlation_id: str | None = Field(default=None, max_length=256)


class TTSVoiceDescriptor(_StrictTTSIOModel):
    """Use-safe redacted voice descriptor."""

    voice_id: LogicalVoiceId
    display_name: str = Field(min_length=1, max_length=256)
    kind: Literal["standard", "cloned"]
    compatible_language_pack_ids: list[str] = Field(default_factory=list, max_length=8)
    ready: bool = False
    selection_mode: Literal["active_only", "shared_model_state", "in_model_speaker"] = "active_only"
    revision: str = Field(min_length=1, max_length=256)
    attribution_label: str | None = Field(default=None, min_length=1, max_length=256)
    preview_available: bool = False
    visible_scope: Literal["local", "allowed_peers", "public"] = "local"

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)

    @field_validator("display_name", "revision")
    @classmethod
    def _validate_nonblank(cls, value: str) -> str:
        return _non_blank(value, "descriptor field")

    @field_validator("compatible_language_pack_ids")
    @classmethod
    def _normalize_language_pack_ids(cls, value: list[str]) -> list[str]:
        normalized = sorted({_non_blank(item, "language pack id") for item in value})
        if any(len(item) > 256 for item in normalized):
            raise ValueError("language pack id exceeds limit")
        return normalized

    @model_validator(mode="after")
    def _validate_ready_voice(self) -> TTSVoiceDescriptor:
        if self.kind == "standard" and not self.voice_id.startswith("standard:"):
            raise ValueError("standard voice kind needs a standard logical voice id")
        if self.kind == "cloned" and not self.voice_id.startswith("clone:"):
            raise ValueError("cloned voice kind needs a clone logical voice id")
        if self.ready and not self.compatible_language_pack_ids:
            raise ValueError("ready voice needs a compatible language pack")
        return self


class TTSListVoicesRequest(_StrictTTSIOModel):
    """List use-safe voices for an eligible recipient."""

    language: SpeechLanguageTag | None = None
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        normalized = normalize_speech_language(value, allow_auto=True)
        if normalized == "auto":
            raise ValueError("voice language filter must be exact, not auto")
        return normalized


class TTSListVoicesResponse(_StrictTTSIOModel):
    """Use-safe voice list."""

    voices: list[TTSVoiceDescriptor] = Field(default_factory=list, max_length=256)
    capability_revision: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _validate_use_safe_voices(self) -> TTSListVoicesResponse:
        if any(not voice.ready for voice in self.voices):
            raise ValueError("use-safe voice list cannot contain unready voices")
        voice_ids = [voice.voice_id for voice in self.voices]
        if len(voice_ids) != len(set(voice_ids)):
            raise ValueError("use-safe voice list cannot contain duplicate voices")
        return self


class TTSVoiceProfileDescriptor(_StrictTTSIOModel):
    """Management-only redacted voice profile descriptor."""

    voice_id: LogicalVoiceId
    display_name: str = Field(min_length=1, max_length=256)
    kind: Literal["standard", "cloned"]
    installed: bool = False
    ready: bool = False
    default: bool = False
    active: bool = False
    enabled: bool = True
    compatible_language_pack_ids: list[str] = Field(default_factory=list, max_length=8)
    compatible_selection_group: str | None = Field(default=None, min_length=1, max_length=256)
    revision: str = Field(min_length=1, max_length=256)
    retained_source: bool = False
    storage: SpeechStorageSummary = Field(default_factory=SpeechStorageSummary)
    visibility: Literal["private", "allowed_peers"] = "private"
    allowed_peer_ids: list[str] = Field(default_factory=list, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)

    @field_validator("display_name", "revision")
    @classmethod
    def _validate_nonblank(cls, value: str) -> str:
        return _non_blank(value, "profile field")

    @field_validator("compatible_language_pack_ids")
    @classmethod
    def _normalize_language_pack_ids(cls, value: list[str]) -> list[str]:
        normalized = sorted({_non_blank(item, "language pack id") for item in value})
        if any(len(item) > 256 for item in normalized):
            raise ValueError("language pack id exceeds limit")
        return normalized

    @field_validator("allowed_peer_ids")
    @classmethod
    def _normalize_peer_ids(cls, value: list[str]) -> list[str]:
        normalized = sorted({_non_blank(item, "peer id") for item in value})
        if any(len(item) > 256 for item in normalized):
            raise ValueError("peer id exceeds limit")
        return normalized

    @model_validator(mode="after")
    def _validate_profile_state(self) -> TTSVoiceProfileDescriptor:
        if self.kind == "standard" and not self.voice_id.startswith("standard:"):
            raise ValueError("standard profile kind needs a standard logical voice id")
        if self.kind == "cloned" and not self.voice_id.startswith("clone:"):
            raise ValueError("cloned profile kind needs a clone logical voice id")
        if self.ready and not self.installed:
            raise ValueError("ready profile must be installed")
        if (self.default or self.active) and not self.ready:
            raise ValueError("default or active profile must be ready")
        if self.kind == "standard" and self.retained_source:
            raise ValueError("standard profile cannot retain clone source")
        if self.visibility == "private" and self.allowed_peer_ids:
            raise ValueError("private profile cannot expose allowed peers")
        return self


class TTSListVoiceProfilesRequest(_StrictTTSIOModel):
    """List administrative voice profiles."""

    include_unavailable: bool = False
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = Field(default=None, max_length=256)


class TTSListVoiceProfilesResponse(_StrictTTSIOModel):
    """Administrative voice profile inventory."""

    profiles: list[TTSVoiceProfileDescriptor] = Field(default_factory=list, max_length=256)
    capability_revision: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _validate_unique_profiles(self) -> TTSListVoiceProfilesResponse:
        voice_ids = [profile.voice_id for profile in self.profiles]
        if len(voice_ids) != len(set(voice_ids)):
            raise ValueError("voice profile list cannot contain duplicate profiles")
        return self


class TTSGetVoiceProfileRequest(_StrictTTSIOModel):
    """Request one administrative voice profile."""

    voice_id: LogicalVoiceId
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)


class TTSGetVoiceProfileResponse(_StrictTTSIOModel):
    """Administrative voice profile response."""

    found: bool
    profile: TTSVoiceProfileDescriptor | None = None
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _validate_found_profile(self) -> TTSGetVoiceProfileResponse:
        if self.found and self.profile is None:
            raise ValueError("found voice profile response requires profile")
        if not self.found and self.profile is not None:
            raise ValueError("missing voice profile response cannot include profile")
        return self


class _TTSMutationRequest(_StrictTTSIOModel):
    """Common fields for idempotent management mutations."""

    operation_id: str = Field(min_length=1, max_length=128)
    expected_revision: str | None = Field(default=None, min_length=1, max_length=256)
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("operation_id")
    @classmethod
    def _validate_operation_id(cls, value: str) -> str:
        return _normalize_operation_id(value)

    @field_validator("expected_revision")
    @classmethod
    def _validate_expected_revision(cls, value: str | None) -> str | None:
        return _non_blank(value, "expected_revision") if value is not None else None


class TTSUpdateVoiceProfileRequest(_TTSMutationRequest):
    """Update provider-neutral profile metadata."""

    voice_id: LogicalVoiceId
    display_name: str | None = Field(default=None, min_length=1, max_length=256)
    enabled: bool | None = None
    visibility: Literal["private", "allowed_peers"] | None = None
    allowed_peer_ids: list[str] | None = Field(default=None, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)

    @field_validator("display_name")
    @classmethod
    def _validate_label(cls, value: str | None) -> str | None:
        return _non_blank(value, "display_name") if value is not None else None

    @field_validator("allowed_peer_ids")
    @classmethod
    def _normalize_peer_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        normalized = sorted({_non_blank(item, "peer id") for item in value})
        if any(len(peer_id) > 256 for peer_id in normalized):
            raise ValueError("peer id exceeds limit")
        return normalized

    @model_validator(mode="after")
    def _validate_patch(self) -> TTSUpdateVoiceProfileRequest:
        if all(
            value is None
            for value in (
                self.display_name,
                self.enabled,
                self.visibility,
                self.allowed_peer_ids,
            )
        ):
            raise ValueError("voice profile update must include a change")
        if self.visibility == "private" and self.allowed_peer_ids:
            raise ValueError("private visibility cannot include allowed peers")
        return self


class _TTSVoiceProfileMutationResponse(_StrictTTSIOModel):
    """Result for a voice profile management mutation."""

    voice_id: LogicalVoiceId
    status: str
    revision: str | None = Field(default=None, min_length=1, max_length=256)
    idempotent: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)

    @model_validator(mode="after")
    def _validate_revision(self) -> _TTSVoiceProfileMutationResponse:
        if self.status not in {"rejected", "not_found"} and self.revision is None:
            raise ValueError("successful or conflicting mutation result needs revision")
        return self


class TTSInstallVoiceProfileRequest(_TTSMutationRequest):
    """Install a manifest-known voice profile."""

    voice_id: LogicalVoiceId

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)


class TTSRemoveVoiceProfileRequest(TTSInstallVoiceProfileRequest):
    """Remove installed artifacts for a voice profile."""


class TTSSetDefaultVoiceRequest(TTSInstallVoiceProfileRequest):
    """Change the node-wide default voice."""

    expected_revision: str = Field(min_length=1, max_length=256)


class TTSUpdateVoiceProfileResponse(_TTSVoiceProfileMutationResponse):
    """Update voice profile result."""

    status: Literal["updated", "unchanged", "rejected", "revision_conflict", "not_found"]


class TTSInstallVoiceProfileResponse(_TTSVoiceProfileMutationResponse):
    """Install voice profile result."""

    status: Literal[
        "installed", "queued", "unchanged", "rejected", "revision_conflict", "not_found"
    ]


class TTSRemoveVoiceProfileResponse(_TTSVoiceProfileMutationResponse):
    """Remove voice profile result."""

    status: Literal["removed", "drained", "unchanged", "rejected", "revision_conflict", "not_found"]


class TTSSetDefaultVoiceResponse(_StrictTTSIOModel):
    """Set default voice result."""

    voice_id: LogicalVoiceId
    status: Literal["activated", "drained", "rejected", "revision_conflict", "not_found"]
    revision: str = Field(min_length=1, max_length=256)
    idempotent: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        return validate_logical_voice_id(value)


class TTSVoiceImportStartRequest(_TTSMutationRequest):
    """Start a bounded clone prompt upload."""

    expected_total_bytes: int = Field(gt=0, le=VOICE_IMPORT_MAX_TOTAL_BYTES)
    sha256: str
    format: Literal["wav", "pcm_s16le"]
    sample_rate: int = Field(gt=0, le=TTS_MAX_SAMPLE_RATE)
    channels: int = Field(default=1, ge=1, le=2)
    sample_width_bytes: int = Field(default=2, ge=1, le=4)
    duration_ms: int | None = Field(default=None, gt=0, le=VOICE_IMPORT_MAX_DURATION_MS)

    @field_validator("sha256")
    @classmethod
    def _validate_sha256(cls, value: str) -> str:
        return _normalize_sha256(value, "sha256")


class TTSVoiceImportStartResponse(_StrictTTSIOModel):
    """Server-issued bounded clone prompt upload session."""

    upload_id: str = Field(min_length=1, max_length=256)
    expires_at: str = Field(min_length=1, max_length=64)
    accepted_total_bytes: int = Field(gt=0, le=VOICE_IMPORT_MAX_TOTAL_BYTES)
    max_chunk_bytes: int = Field(
        default=VOICE_IMPORT_MAX_CHUNK_BYTES, ge=1, le=VOICE_IMPORT_MAX_CHUNK_BYTES
    )
    max_chunks: int = Field(default=VOICE_IMPORT_MAX_CHUNKS, ge=1, le=VOICE_IMPORT_MAX_CHUNKS)
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("upload_id", "expires_at")
    @classmethod
    def _validate_nonblank(cls, value: str) -> str:
        return _non_blank(value, "upload response field")

    @model_validator(mode="after")
    def _validate_capacity(self) -> TTSVoiceImportStartResponse:
        if self.max_chunk_bytes * self.max_chunks < self.accepted_total_bytes:
            raise ValueError("upload session capacity is below accepted total bytes")
        return self


class TTSVoiceImportChunkRequest(_TTSMutationRequest):
    """One ordered bounded base64 clone prompt chunk."""

    upload_id: str = Field(min_length=1, max_length=256)
    sequence: int = Field(ge=0, le=VOICE_IMPORT_MAX_SEQUENCE)
    chunk_data: str = Field(max_length=VOICE_IMPORT_MAX_BASE64_CHARS)
    chunk_sha256: str | None = None

    @field_validator("upload_id")
    @classmethod
    def _validate_upload_id(cls, value: str) -> str:
        return _non_blank(value, "upload_id")

    @field_validator("chunk_sha256")
    @classmethod
    def _validate_chunk_sha256(cls, value: str | None) -> str | None:
        return _normalize_sha256(value, "chunk_sha256") if value is not None else None

    @model_validator(mode="after")
    def _validate_chunk(self) -> TTSVoiceImportChunkRequest:
        try:
            decoded = base64.b64decode(self.chunk_data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("chunk_data must be valid base64") from exc
        if not decoded:
            raise ValueError("decoded chunk must not be empty")
        if len(decoded) > VOICE_IMPORT_MAX_CHUNK_BYTES:
            raise ValueError("decoded chunk exceeds limit")
        if (
            self.chunk_sha256
            and _normalize_sha256(hashlib.sha256(decoded).hexdigest(), "chunk_sha256")
            != self.chunk_sha256
        ):
            raise ValueError("chunk SHA-256 mismatch")
        if len(self.model_dump_json().encode("utf-8")) > VOICE_IMPORT_MAX_JSON_BYTES:
            raise ValueError("voice import chunk request exceeds JSON limit")
        return self


class TTSVoiceImportChunkResponse(_StrictTTSIOModel):
    """Acknowledgement for a bounded clone prompt chunk."""

    upload_id: str = Field(min_length=1, max_length=256)
    sequence: int = Field(ge=0, le=VOICE_IMPORT_MAX_SEQUENCE)
    status: Literal["accepted", "duplicate"] = "accepted"
    received_bytes: int = Field(ge=1, le=VOICE_IMPORT_MAX_TOTAL_BYTES)
    next_sequence: int = Field(ge=0, le=VOICE_IMPORT_MAX_CHUNKS)
    idempotent: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _validate_acknowledgement(self) -> TTSVoiceImportChunkResponse:
        if self.next_sequence != self.sequence + 1:
            raise ValueError("next_sequence must acknowledge exactly one chunk")
        if self.status == "duplicate" and not self.idempotent:
            raise ValueError("duplicate chunk acknowledgement must be idempotent")
        if self.status == "accepted" and self.idempotent:
            raise ValueError("first chunk acknowledgement cannot be idempotent")
        return self


class TTSVoiceImportEndRequest(_TTSMutationRequest):
    """Seal a clone prompt upload after full validation."""

    upload_id: str = Field(min_length=1, max_length=256)
    final_sequence: int = Field(ge=0, le=VOICE_IMPORT_MAX_SEQUENCE)
    final_sha256: str

    @field_validator("upload_id")
    @classmethod
    def _validate_upload_id(cls, value: str) -> str:
        return _non_blank(value, "upload_id")

    @field_validator("final_sha256")
    @classmethod
    def _validate_final_sha256(cls, value: str) -> str:
        return _normalize_sha256(value, "final_sha256")


class TTSVoiceImportEndResponse(_StrictTTSIOModel):
    """Sealed single-use clone prompt reference."""

    sealed_audio_ref: str = Field(min_length=1, max_length=512)
    status: Literal["sealed"] = "sealed"
    accepted_total_bytes: int = Field(gt=0, le=VOICE_IMPORT_MAX_TOTAL_BYTES)
    final_sha256: str
    expires_at: str = Field(min_length=1, max_length=64)
    idempotent: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("sealed_audio_ref", "expires_at")
    @classmethod
    def _validate_nonblank(cls, value: str) -> str:
        return _non_blank(value, "voice import end response field")

    @field_validator("final_sha256")
    @classmethod
    def _validate_final_sha256(cls, value: str) -> str:
        return _normalize_sha256(value, "final_sha256")


class TTSVoiceImportAbortRequest(_TTSMutationRequest):
    """Abort and remove a partial clone prompt upload."""

    upload_id: str = Field(min_length=1, max_length=256)

    @field_validator("upload_id")
    @classmethod
    def _validate_upload_id(cls, value: str) -> str:
        return _non_blank(value, "upload_id")


class TTSVoiceImportAbortResponse(_StrictTTSIOModel):
    """Clone prompt upload abort result."""

    upload_id: str = Field(min_length=1, max_length=256)
    status: Literal["aborted", "expired", "not_found"]
    deleted_bytes: int = Field(default=0, ge=0, le=VOICE_IMPORT_MAX_TOTAL_BYTES)
    idempotent: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)


class TTSCreateVoiceProfileRequest(_TTSMutationRequest):
    """Create a cloned voice profile from a sealed upload reference."""

    display_name: str = Field(min_length=1, max_length=256)
    sealed_audio_ref: str = Field(min_length=1, max_length=512)
    language: SpeechLanguageTag | None = None
    consent: Literal[True]
    retain_source: bool = False

    @field_validator("display_name", "sealed_audio_ref")
    @classmethod
    def _validate_nonblank(cls, value: str) -> str:
        return _non_blank(value, "create profile field")

    @field_validator("sealed_audio_ref")
    @classmethod
    def _validate_sealed_audio_ref(cls, value: str) -> str:
        if not _SEALED_AUDIO_REF_RE.fullmatch(value):
            raise ValueError("sealed_audio_ref must be an opaque voice import reference")
        return value

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value: str | None) -> str | None:
        return normalize_speech_language(value)


class TTSCreateVoiceProfileResponse(_StrictTTSIOModel):
    """Created cloned voice profile response."""

    voice_id: LogicalVoiceId | None = None
    status: Literal["created", "queued", "ready", "rejected", "unavailable"]
    accepted_duration_ms: int | None = Field(default=None, gt=0, le=VOICE_IMPORT_MAX_DURATION_MS)
    revision: str | None = Field(default=None, min_length=1, max_length=256)
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        validated = validate_logical_voice_id(value)
        if not validated.startswith("clone:"):
            raise ValueError("created profile must use a clone logical voice id")
        return validated

    @model_validator(mode="after")
    def _validate_result_revision(self) -> TTSCreateVoiceProfileResponse:
        if self.status in {"created", "queued", "ready"} and self.revision is None:
            raise ValueError("successful create result needs revision")
        if self.status in {"created", "queued", "ready"} and self.voice_id is None:
            raise ValueError("successful create result needs voice_id")
        return self


class TTSDeleteVoiceProfileRequest(TTSInstallVoiceProfileRequest):
    """Delete a manager-authorized cloned voice profile and derived state."""

    @model_validator(mode="after")
    def _validate_clone_id(self) -> TTSDeleteVoiceProfileRequest:
        if not self.voice_id.startswith("clone:"):
            raise ValueError("only cloned voice profiles can be deleted")
        return self


class TTSDeleteVoiceProfileResponse(_StrictTTSIOModel):
    """Manager-authorized cloned voice profile delete response."""

    voice_id: LogicalVoiceId
    status: Literal["deleted", "not_found", "rejected", "revision_conflict"] = "deleted"
    revision: str | None = Field(default=None, min_length=1, max_length=256)
    idempotent: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)

    @field_validator("voice_id")
    @classmethod
    def _validate_voice_id(cls, value: str) -> str:
        validated = validate_logical_voice_id(value)
        if not validated.startswith("clone:"):
            raise ValueError("deleted profile must use a clone logical voice id")
        return validated

    @model_validator(mode="after")
    def _validate_revision(self) -> TTSDeleteVoiceProfileResponse:
        if self.status in {"deleted", "revision_conflict"} and self.revision is None:
            raise ValueError("delete result needs revision")
        return self


class TTSStreamChunkRequest(IOModel):
    """Ordered text chunk for an active TTS streaming session."""

    stream_id: str
    sequence: int = Field(ge=0, le=TTS_MAX_STREAM_SEQUENCE)
    text: str
    is_final: bool = False
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None


class TTSStreamEndRequest(IOModel):
    """End an ordered TTS streaming session."""

    stream_id: str
    final_sequence: int | None = Field(default=None, ge=0, le=TTS_MAX_STREAM_SEQUENCE)
    reason: str = "completed"
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None


class TTSAudioChunkEvent(IOModel):
    """Synthesized audio chunk emitted for a TTS streaming session."""

    stream_id: str
    sequence: int = Field(ge=0)
    audio_data: str  # Base64-encoded audio
    format: str
    sample_rate: int
    channels: int = 1
    duration_ms: float = Field(ge=0)
    text: str | None = None
    source_sequence: int | None = Field(default=None, ge=0)
    is_final: bool = False
    reason: str | None = None
    correlation_id: str | None = None


class TTSControl(IOModel):
    """Control TTS playback (stop, pause, resume)."""

    action: str  # "stop" | "pause" | "resume"
    mesh_selector: MeshAddressSelector | None = None


class TTSStatus(IOModel):
    """TTS playback status."""

    state: str  # "idle" | "playing" | "paused"
    current_text: str | None = None


class TTSError(IOModel):
    """TTS error event."""

    error: str
    text: str | None = None
