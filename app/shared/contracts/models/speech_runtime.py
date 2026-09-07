"""Shared contracts for admitted native and remote speech-stage execution.

The legacy speech DTOs describe an individual STT/TTS request.  This module
describes the smaller control-plane envelope used to decide whether a stage
may run and to keep an admitted stream scoped to its owner.  Audio and text
payloads are deliberately kept out of capability and observer models.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.shared.contracts.io_model import IOModel

MAX_SPEECH_STAGE_METHODS = 16
MAX_SPEECH_STAGE_LIST = 16
MAX_SPEECH_STAGE_CHUNK_BYTES = 64 * 1024
MAX_SPEECH_STAGE_INPUT_BYTES = 4 * 1024 * 1024
MAX_SPEECH_STAGE_TEXT_BYTES = 4096
MAX_SPEECH_STAGE_QUEUE = 4
MAX_SPEECH_STAGE_CREDITS = 8
MAX_SPEECH_STAGE_LEASE_MS = 300_000
MAX_SPEECH_STAGE_DEADLINE_MS = 60_000
MAX_SPEECH_STAGE_ID_LENGTH = 128
MAX_JS_SAFE_INTEGER = 2**53 - 1

_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"

SpeechStage = Literal["stt", "tts", "kws", "vad"]
SpeechStageMode = Literal["finite", "streaming"]
SpeechImplementation = Literal["native", "wasm", "python"]
SpeechReadiness = Literal["ready", "missing_model", "loading", "incompatible", "unavailable"]
SpeechLifecycle = Literal["foreground", "active_native_capture"]
SpeechStreamState = Literal[
    "prepared",
    "admitted",
    "active",
    "finishing",
    "completed",
    "canceled",
    "timed_out",
    "revoked",
    "interrupted",
    "failed",
]
SpeechTerminalReason = Literal[
    "completed",
    "canceled",
    "timed_out",
    "revoked",
    "interrupted",
    "failed",
    "outcome_unknown",
    "invalid_sequence",
    "resource_exhausted",
    "session_conflict",
    "unsupported_protocol",
    "consent_required",
]
SpeechFallbackOutcome = Literal[
    "missing_capability",
    "offline",
    "busy",
    "admission_timeout",
    "transport_unaccepted",
    "auth_denied",
    "privacy_denied",
    "consent_required",
    "revoked",
    "stale_grant",
    "selector_mismatch",
    "outcome_unknown",
    "accepted",
    "committed",
]


class SpeechStageCapabilityV1(IOModel):
    """Redacted projection of one executable, currently ready stage."""

    schema: Literal["speech-stage-capability.v1"] = "speech-stage-capability.v1"
    stage: SpeechStage
    method_ids: list[str] = Field(min_length=1, max_length=MAX_SPEECH_STAGE_METHODS)
    modes: list[SpeechStageMode] = Field(min_length=1, max_length=2)
    implementation: SpeechImplementation
    peer_id: str = Field(min_length=1, max_length=256, pattern=_ID_PATTERN)
    resource_id: str | None = Field(default=None, max_length=256, pattern=_ID_PATTERN)
    capability_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    supported_formats: list[str] = Field(default_factory=list, max_length=MAX_SPEECH_STAGE_LIST)
    sample_rates: list[int] = Field(default_factory=list, max_length=MAX_SPEECH_STAGE_LIST)
    channels: list[int] = Field(default_factory=list, max_length=8)
    supported_languages: list[str] = Field(default_factory=list, max_length=64)
    model_ids: list[str] = Field(default_factory=list, max_length=64)
    lifecycle: list[SpeechLifecycle] = Field(min_length=1, max_length=2)
    max_input_bytes: int = Field(default=MAX_SPEECH_STAGE_INPUT_BYTES, gt=0, le=MAX_SPEECH_STAGE_INPUT_BYTES)
    max_chunk_bytes: int = Field(default=MAX_SPEECH_STAGE_CHUNK_BYTES, gt=0, le=MAX_SPEECH_STAGE_CHUNK_BYTES)
    max_concurrent: int = Field(default=1, gt=0, le=4)
    max_queue: int = Field(default=MAX_SPEECH_STAGE_QUEUE, ge=0, le=MAX_SPEECH_STAGE_QUEUE)
    lease_ms: int = Field(default=15_000, gt=0, le=MAX_SPEECH_STAGE_LEASE_MS)
    readiness: SpeechReadiness
    required_permissions: list[str] = Field(default_factory=list, max_length=16)
    audio_consent_required: bool = False
    experimental: bool = False
    exported: bool = False

    model_config = ConfigDict(extra="forbid")

    @field_validator("method_ids", "supported_formats", "supported_languages", "model_ids", "required_permissions", mode="before")
    @classmethod
    def _dedupe_strings(cls, value: list[str]) -> list[str]:
        if not isinstance(value, list):
            return value
        normalized = [item.strip() if isinstance(item, str) else item for item in value]
        if any(not isinstance(item, str) or not item for item in normalized):
            raise ValueError("capability string entries must be nonblank")
        return list(dict.fromkeys(normalized))

    @field_validator("sample_rates", "channels", mode="before")
    @classmethod
    def _dedupe_positive_ints(cls, value: list[int]) -> list[int]:
        if not isinstance(value, list):
            return value
        if any(not isinstance(item, int) or item <= 0 for item in value):
            raise ValueError("capability numeric entries must be positive integers")
        return list(dict.fromkeys(value))

    @model_validator(mode="after")
    def _validate_readiness_and_modes(self) -> SpeechStageCapabilityV1:
        if len(set(self.method_ids)) != len(self.method_ids):
            raise ValueError("method_ids must be unique")
        if len(set(self.modes)) != len(self.modes):
            raise ValueError("modes must be unique")
        if self.readiness == "ready" and not self.exported:
            raise ValueError("ready capability must be exported")
        if self.stage in {"kws", "vad"} and "streaming" in self.modes and not self.experimental:
            raise ValueError("continuous KWS/VAD capability must be experimental")
        if self.max_chunk_bytes > self.max_input_bytes:
            raise ValueError("max_chunk_bytes cannot exceed max_input_bytes")
        return self


class SpeechExecutionContextV1(IOModel):
    """Per-attempt metadata carried outside speech payload frames."""

    schema: Literal["speech-execution-context.v1"] = "speech-execution-context.v1"
    operation_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    attempt_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    request_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    stage: SpeechStage
    mode: SpeechStageMode
    config_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    route_revision: str = Field(min_length=1, max_length=256)
    capability_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    session_id: str | None = Field(default=None, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    consent_revision: str | None = Field(default=None, max_length=256)
    cancellation_ref: str = Field(min_length=1, max_length=256, pattern=_ID_PATTERN)
    remaining_deadline_ms: int = Field(gt=0, le=MAX_SPEECH_STAGE_DEADLINE_MS)
    caller_peer_id: str | None = Field(default=None, max_length=256, pattern=_ID_PATTERN)
    target_peer_id: str | None = Field(default=None, max_length=256, pattern=_ID_PATTERN)
    boot_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    clock_domain: str = Field(min_length=1, max_length=64, pattern=_ID_PATTERN)
    monotonic_ns: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)

    model_config = ConfigDict(extra="forbid")


class SpeechStageAdmissionRequestV1(IOModel):
    """Request to authorize one finite operation or stream."""

    schema: Literal["speech-stage-admission.v1"] = "speech-stage-admission.v1"
    stage: SpeechStage
    mode: SpeechStageMode
    operation_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    attempt_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    request_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    config_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    route_revision: str = Field(min_length=1, max_length=256)
    capability_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    target_peer_id: str | None = Field(default=None, max_length=256, pattern=_ID_PATTERN)
    target_resource_id: str | None = Field(default=None, max_length=256, pattern=_ID_PATTERN)
    consent_revision: str | None = Field(default=None, max_length=256)
    remaining_deadline_ms: int = Field(default=MAX_SPEECH_STAGE_DEADLINE_MS, gt=0, le=MAX_SPEECH_STAGE_DEADLINE_MS)
    exact_selector: bool = False
    experimental_remote: bool = False

    model_config = ConfigDict(extra="forbid")


class SpeechStreamLimitsV1(IOModel):
    """Negotiated bounds for one admitted streaming session."""

    max_chunk_bytes: int = Field(default=MAX_SPEECH_STAGE_CHUNK_BYTES, gt=0, le=MAX_SPEECH_STAGE_CHUNK_BYTES)
    max_input_bytes: int = Field(default=MAX_SPEECH_STAGE_INPUT_BYTES, gt=0, le=MAX_SPEECH_STAGE_INPUT_BYTES)
    max_text_bytes: int = Field(default=MAX_SPEECH_STAGE_TEXT_BYTES, gt=0, le=MAX_SPEECH_STAGE_TEXT_BYTES)
    max_queue: int = Field(default=MAX_SPEECH_STAGE_QUEUE, ge=0, le=MAX_SPEECH_STAGE_QUEUE)
    heartbeat_ms: int = Field(default=5_000, gt=0, le=5_000)
    idle_lease_ms: int = Field(default=15_000, gt=0, le=MAX_SPEECH_STAGE_LEASE_MS)
    max_active_ms: int = Field(default=MAX_SPEECH_STAGE_LEASE_MS, gt=0, le=MAX_SPEECH_STAGE_LEASE_MS)

    model_config = ConfigDict(extra="forbid")


class SpeechStreamAdmissionV1(IOModel):
    """Owner-bound start acknowledgement for ``speech.stage_session.v1``."""

    schema: Literal["speech.stage-session-admission.v1"] = "speech.stage-session-admission.v1"
    session_id: str | None = Field(default=None, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    operation_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    attempt_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    status: Literal["admitted", "rejected"]
    reason_code: str = Field(min_length=1, max_length=80, pattern=_ID_PATTERN)
    capability_revision: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    accepted_format: str | None = Field(default=None, max_length=32)
    accepted_limits: SpeechStreamLimitsV1 = Field(default_factory=SpeechStreamLimitsV1)
    next_sequence: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    credits: int = Field(default=MAX_SPEECH_STAGE_CREDITS, ge=0, le=MAX_SPEECH_STAGE_CREDITS)
    lease_remaining_ms: int = Field(default=15_000, ge=0, le=MAX_SPEECH_STAGE_LEASE_MS)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _validate_session_reference(self) -> SpeechStreamAdmissionV1:
        if self.status == "admitted" and self.session_id is None:
            raise ValueError("admitted response requires session_id")
        if self.status == "rejected" and self.session_id is not None:
            raise ValueError("rejected response must not disclose session_id")
        return self


class SpeechStreamStatusV1(IOModel):
    """Owner-scoped state and flow-control status."""

    session_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    state: SpeechStreamState
    next_sequence: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    credits: int = Field(ge=0, le=MAX_SPEECH_STAGE_CREDITS)
    lease_remaining_ms: int = Field(ge=0, le=MAX_SPEECH_STAGE_LEASE_MS)
    terminal_outcome: SpeechTerminalReason | None = None
    accepted_chunks: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    dropped_chunks: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _terminal_requires_reason(self) -> SpeechStreamStatusV1:
        terminal = self.state in {"completed", "canceled", "timed_out", "revoked", "interrupted", "failed"}
        if terminal and self.terminal_outcome is None:
            raise ValueError("terminal stream status requires terminal_outcome")
        if not terminal and self.terminal_outcome is not None:
            raise ValueError("active stream status cannot include terminal_outcome")
        return self


class SpeechStreamCancelV1(IOModel):
    """Explicit owner-scoped cancellation request."""

    session_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    reason: Literal["canceled", "timed_out", "revoked", "interrupted"] = "canceled"

    model_config = ConfigDict(extra="forbid")


class SpeechStreamEndV1(IOModel):
    """Close an admitted stream after all frames have been accepted."""

    session_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    final_sequence: int | None = Field(default=None, ge=0, le=MAX_JS_SAFE_INTEGER)

    model_config = ConfigDict(extra="forbid")


class SpeechStreamStatusRequestV1(IOModel):
    """Request status for the authenticated owner of one stream."""

    session_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)

    model_config = ConfigDict(extra="forbid")


class SpeechStreamFrameV1(IOModel):
    """Ordered frame metadata; payload is supplied to the engine separately."""

    session_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    attempt_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    sequence: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    payload_kind: Literal["audio", "text"]
    payload_size_bytes: int = Field(gt=0, le=MAX_SPEECH_STAGE_CHUNK_BYTES)
    is_final: bool = False

    model_config = ConfigDict(extra="forbid")


class SpeechStreamResultV1(IOModel):
    """Terminal result metadata without raw payload or private provider data."""

    session_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    stage: SpeechStage
    mode: SpeechStageMode
    state: Literal["completed", "canceled", "timed_out", "revoked", "interrupted", "failed"]
    reason_code: str = Field(min_length=1, max_length=80, pattern=_ID_PATTERN)
    final_sequence: int | None = Field(default=None, ge=0, le=MAX_JS_SAFE_INTEGER)
    input_count: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    output_count: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    redacted: Literal[True] = True

    model_config = ConfigDict(extra="forbid")


class SpeechObserverEventV1(IOModel):
    """Allow-listed, payload-free event suitable for a bounded observer sink."""

    event: Literal[
        "admission_requested",
        "admitted",
        "chunk_accepted",
        "completed",
        "canceled",
        "timed_out",
        "revoked",
        "interrupted",
        "failed",
    ]
    timestamp_ms: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    operation_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    attempt_id: str = Field(min_length=1, max_length=MAX_SPEECH_STAGE_ID_LENGTH, pattern=_ID_PATTERN)
    generation: int = Field(ge=0, le=MAX_JS_SAFE_INTEGER)
    stage: SpeechStage
    reason_code: str = Field(min_length=1, max_length=80, pattern=_ID_PATTERN)
    input_count: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    output_count: int = Field(default=0, ge=0, le=MAX_JS_SAFE_INTEGER)
    redacted: Literal[True] = True

    model_config = ConfigDict(extra="forbid")


_NO_FALLBACK_OUTCOMES = {
    "auth_denied",
    "privacy_denied",
    "consent_required",
    "revoked",
    "stale_grant",
    "selector_mismatch",
    "outcome_unknown",
    "accepted",
    "committed",
}


def is_eligible_speech_fallback(
    outcome: SpeechFallbackOutcome,
    *,
    accepted: bool = False,
    committed: bool = False,
    attempts_used: int = 1,
) -> bool:
    """Return whether one configured fallback attempt is safe to make.

    Fallback is an admission-time availability mechanism, not a recovery
    mechanism for an admitted stream or a privacy/auth decision.
    """

    if attempts_used >= 2 or accepted or committed or outcome in _NO_FALLBACK_OUTCOMES:
        return False
    return outcome in {"missing_capability", "offline", "busy", "admission_timeout", "transport_unaccepted"}


class SpeechStreamLifecycle(str, Enum):
    """Canonical stream state names for adapters that do not use Pydantic."""

    PREPARED = "prepared"
    ADMITTED = "admitted"
    ACTIVE = "active"
    FINISHING = "finishing"
    COMPLETED = "completed"
    CANCELED = "canceled"
    TIMED_OUT = "timed_out"
    REVOKED = "revoked"
    INTERRUPTED = "interrupted"
    FAILED = "failed"
