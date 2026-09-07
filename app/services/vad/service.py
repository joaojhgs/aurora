"""Bounded, independently governed VAD stage service.

VAD owns its method permission and stream lifecycle.  It intentionally does
not call the STT coordinator or migrate microphone ownership; callers decide
how a VAD result affects their capture session.
"""

from __future__ import annotations

import asyncio
import hashlib
import struct
import uuid

from app.helpers.aurora_logger import log_info
from app.messaging import Envelope
from app.shared.contracts.models.stt import (
    VADDetectRequest,
    VADDetectResponse,
    VADMethods,
    VADModule,
    VADStreamAdmission,
    VADStreamCancelRequest,
    VADStreamChunkRequest,
    VADStreamEndRequest,
    VADStreamResult,
    VADStreamStartRequest,
    VADStreamStatus,
    VADStreamStatusRequest,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


def _stream_owner(envelope: Envelope | None) -> tuple[str | None, str | None, str | None]:
    """Return the stable transport owner tuple for a speech stream."""
    if envelope is None:
        return (None, None, None)
    return (
        envelope.caller_peer_id if envelope.caller_peer_id else None,
        envelope.principal_id if envelope.principal_id else None,
        envelope.correlation_id if envelope.correlation_id else None,
    )


def _stream_owner_matches(
    owner: tuple[str | None, str | None, str | None] | None,
    envelope: Envelope | None,
) -> bool:
    """Keep every stream operation bound to its authenticated transport owner."""
    return owner is not None and owner == _stream_owner(envelope)


class VADService(BaseService):
    """VAD stage with finite detection and explicit foreground streams."""

    def __init__(self) -> None:
        super().__init__(
            module=VADModule.NAME,
            summary="Voice activity detection service",
            capabilities=["vad_detection"],
        )
        self._running = False
        self._sessions: dict[str, VADStreamAdmission] = {}
        self._next_sequence: dict[str, int] = {}
        self._payload_digests: dict[str, dict[int, str]] = {}
        self._terminal: dict[str, VADStreamStatus] = {}
        self._results: dict[str, VADStreamResult] = {}
        self._owners: dict[str, tuple[str | None, str | None, str | None]] = {}
        self._lock = asyncio.Lock()

    async def on_start(self) -> None:
        self._running = True
        log_info("VADService started")

    async def on_stop(self) -> None:
        self._running = False
        async with self._lock:
            self._sessions.clear()
            self._next_sequence.clear()
            self._payload_digests.clear()
            self._terminal.clear()
            self._results.clear()
            self._owners.clear()
        log_info("VADService stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """VAD has no cross-service configuration to reload."""

    @method_contract(
        method_id=VADMethods.DETECT,
        summary="Detect speech activity in one bounded audio sample",
        input_model=VADDetectRequest,
        output_model=VADDetectResponse,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.DETECT],
        callable_feature_ids=["vad_detection"],
    )
    async def detect(self, request: VADDetectRequest) -> VADDetectResponse:
        score = _speech_score(request.audio_data)
        return VADDetectResponse(
            speech=score > 0.02,
            confidence=min(1.0, score * 4),
            duration_ms=len(request.audio_data)
            / (2 * request.channels * request.sample_rate)
            * 1000,
        )

    @method_contract(
        method_id=VADMethods.STREAM_START,
        summary="Admit an owner-scoped foreground VAD stream",
        input_model=VADStreamStartRequest,
        output_model=VADStreamAdmission,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.STREAM_START],
        callable_feature_ids=["vad_detection"],
    )
    async def start_stream(
        self,
        request: VADStreamStartRequest,
        envelope: Envelope | None = None,
    ) -> VADStreamAdmission:
        owner = _stream_owner(envelope)
        if request.target_peer_id is not None and not request.experimental_remote:
            return _rejected(request, "experimental_remote_required")
        async with self._lock:
            for existing in self._sessions.values():
                if (
                    existing.operation_id == request.operation_id
                    and existing.attempt_id == request.attempt_id
                ):
                    if existing.generation == request.generation and _stream_owner_matches(
                        self._owners.get(existing.session_id or ""), envelope
                    ):
                        return existing
                    return VADStreamAdmission(
                        operation_id=request.operation_id,
                        attempt_id=request.attempt_id,
                        generation=request.generation,
                        status="rejected",
                        reason_code="session_conflict",
                        capability_revision=request.capability_revision,
                    )
        session_id = f"vad-session-{uuid.uuid4().hex}"
        admission = VADStreamAdmission(
            session_id=session_id,
            operation_id=request.operation_id,
            attempt_id=request.attempt_id,
            generation=request.generation,
            status="admitted",
            reason_code="admitted",
            capability_revision=request.capability_revision,
        )
        async with self._lock:
            self._sessions[session_id] = admission
            self._next_sequence[session_id] = 0
            self._payload_digests[session_id] = {}
            self._owners[session_id] = owner
        return admission

    @method_contract(
        method_id=VADMethods.STREAM_CHUNK,
        summary="Accept one ordered audio frame for a VAD stream",
        input_model=VADStreamChunkRequest,
        output_model=VADStreamStatus,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.STREAM_CHUNK],
        callable_feature_ids=["vad_detection"],
    )
    async def push_stream_chunk(
        self,
        request: VADStreamChunkRequest,
        envelope: Envelope | None = None,
    ) -> VADStreamStatus:
        async with self._lock:
            admission = self._sessions.get(request.session_id)
            expected = self._next_sequence.get(request.session_id, 0)
            terminal = self._terminal.get(request.session_id)
            digest = hashlib.sha256(request.audio_data).hexdigest()
            owner = self._owners.get(request.session_id)
        if admission is None:
            if terminal is not None:
                if not _stream_owner_matches(owner, envelope):
                    return _status(request.session_id, "failed", 0, "session_conflict")
                return terminal
            return _status(request.session_id, "failed", 0, "failed")
        if not _stream_owner_matches(owner, envelope):
            return _status(request.session_id, "failed", expected, "session_conflict")
        if request.attempt_id != admission.attempt_id or request.generation != admission.generation:
            return _status(request.session_id, "failed", expected, "session_conflict")
        if request.sequence < expected:
            if self._payload_digests[request.session_id].get(request.sequence) != digest:
                return _status(request.session_id, "failed", expected, "invalid_sequence")
            return _status(request.session_id, "active", expected)
        if request.sequence != expected:
            return _status(request.session_id, "failed", expected, "invalid_sequence")
        async with self._lock:
            self._next_sequence[request.session_id] = expected + 1
            self._payload_digests[request.session_id][request.sequence] = digest
        return VADStreamStatus(
            session_id=request.session_id,
            state="active",
            next_sequence=expected + 1,
            credits=7,
            lease_remaining_ms=15_000,
            accepted_chunks=1,
        )

    @method_contract(
        method_id=VADMethods.STREAM_END,
        summary="Finish a VAD stream",
        input_model=VADStreamEndRequest,
        output_model=VADStreamResult,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.STREAM_END],
        callable_feature_ids=["vad_detection"],
    )
    async def end_stream(
        self,
        request: VADStreamEndRequest,
        envelope: Envelope | None = None,
    ) -> VADStreamResult:
        async with self._lock:
            owner = self._owners.get(request.session_id)
            if owner is not None and not _stream_owner_matches(owner, envelope):
                return _result(request.session_id, "failed", "session_conflict")
            existing = self._results.get(request.session_id)
            if existing is not None:
                return existing
            known = self._sessions.pop(request.session_id, None)
            next_sequence = self._next_sequence.pop(request.session_id, 0)
            self._payload_digests.pop(request.session_id, None)
            result = _result(
                request.session_id,
                "completed" if known else "failed",
                "completed" if known else "outcome_unknown",
                request.final_sequence,
            )
            self._results[request.session_id] = result
            self._terminal[request.session_id] = _status(
                request.session_id,
                "completed" if known else "failed",
                next_sequence,
                "completed" if known else "outcome_unknown",
            )
        return result

    @method_contract(
        method_id=VADMethods.STREAM_CANCEL,
        summary="Cancel a VAD stream",
        input_model=VADStreamCancelRequest,
        output_model=VADStreamResult,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.STREAM_CANCEL],
        callable_feature_ids=["vad_detection"],
    )
    async def cancel_stream(
        self,
        request: VADStreamCancelRequest,
        envelope: Envelope | None = None,
    ) -> VADStreamResult:
        async with self._lock:
            owner = self._owners.get(request.session_id)
            if owner is not None and not _stream_owner_matches(owner, envelope):
                return _result(request.session_id, "failed", "session_conflict")
            existing = self._results.get(request.session_id)
            if existing is not None:
                return existing
            known = self._sessions.pop(request.session_id, None)
            next_sequence = self._next_sequence.pop(request.session_id, 0)
            self._payload_digests.pop(request.session_id, None)
            result = _result(
                request.session_id,
                "canceled" if known else "failed",
                request.reason if known else "outcome_unknown",
            )
            self._results[request.session_id] = result
            self._terminal[request.session_id] = _status(
                request.session_id,
                "canceled" if known else "failed",
                next_sequence,
                request.reason if known else "outcome_unknown",
            )
        return result

    @method_contract(
        method_id=VADMethods.STREAM_STATUS,
        summary="Read VAD stream status",
        input_model=VADStreamStatusRequest,
        output_model=VADStreamStatus,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.STREAM_STATUS],
        callable_feature_ids=["vad_detection"],
    )
    async def stream_status(
        self,
        request: VADStreamStatusRequest,
        envelope: Envelope | None = None,
    ) -> VADStreamStatus:
        async with self._lock:
            terminal = self._terminal.get(request.session_id)
            known = request.session_id in self._sessions
            next_sequence = self._next_sequence.get(request.session_id, 0)
            owner = self._owners.get(request.session_id)
            if owner is not None and not _stream_owner_matches(owner, envelope):
                return _status(request.session_id, "failed", 0, "session_conflict")
        if terminal is not None:
            return terminal
        return _status(
            request.session_id,
            "admitted" if known else "failed",
            next_sequence,
            None if known else "failed",
        )

    @method_contract(
        method_id=VADMethods.STREAM_RESULT,
        summary="Read terminal VAD stream metadata",
        input_model=VADStreamStatusRequest,
        output_model=VADStreamResult,
        exposure="both",
        method_type="use",
        required_perms=[VADMethods.STREAM_RESULT],
        callable_feature_ids=["vad_detection"],
    )
    async def stream_result(
        self,
        request: VADStreamStatusRequest,
        envelope: Envelope | None = None,
    ) -> VADStreamResult:
        async with self._lock:
            owner = self._owners.get(request.session_id)
            if owner is not None and not _stream_owner_matches(owner, envelope):
                return _result(request.session_id, "failed", "session_conflict")
            result = self._results.get(request.session_id)
        if result is not None:
            return result
        return _result(request.session_id, "failed", "result_not_retained")


def _speech_score(payload: bytes) -> float:
    """Compute a bounded amplitude score without a blocking model call."""

    if len(payload) < 2:
        return 0.0
    samples = struct.unpack(f"<{len(payload) // 2}h", payload[: len(payload) // 2 * 2])
    if not samples:
        return 0.0
    return sum(abs(sample) for sample in samples) / len(samples) / 32768


def _rejected(request: VADStreamStartRequest, reason: str) -> VADStreamAdmission:
    return VADStreamAdmission(
        operation_id=request.operation_id,
        attempt_id=request.attempt_id,
        generation=request.generation,
        status="rejected",
        reason_code=reason,
        capability_revision=request.capability_revision,
    )


def _status(
    session_id: str, state: str, next_sequence: int, reason: str | None = None
) -> VADStreamStatus:
    terminal = state in {"completed", "canceled", "timed_out", "revoked", "interrupted", "failed"}
    return VADStreamStatus(
        session_id=session_id,
        state=state,  # type: ignore[arg-type]
        next_sequence=next_sequence,
        credits=0 if terminal else 8,
        lease_remaining_ms=0 if terminal else 15_000,
        terminal_outcome=reason,  # type: ignore[arg-type]
    )


def _result(
    session_id: str, state: str, reason: str, final_sequence: int | None = None
) -> VADStreamResult:
    return VADStreamResult(
        session_id=session_id,
        state=state,  # type: ignore[arg-type]
        reason_code=reason,
        final_sequence=final_sequence,
    )
