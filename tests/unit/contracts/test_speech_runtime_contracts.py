"""Regression tests for native speech admission and bounded stream contracts."""

from __future__ import annotations

import asyncio
import struct

import pytest
from pydantic import ValidationError

from app.services.vad.service import VADService
from app.shared.contracts.models import speech_runtime as speech_runtime_contracts
from app.shared.contracts.models.speech_runtime import (
    SpeechStageCapabilityV1,
    SpeechStreamAdmissionV1,
    is_eligible_speech_fallback,
)
from app.shared.contracts.models.stt import (
    TranscriptionStreamChunkRequest,
    VADDetectRequest,
    VADStreamChunkRequest,
    VADStreamEndRequest,
    VADStreamStartRequest,
)
from app.shared.contracts.models.tts import TTSStreamPrepareRequest, TTSStreamSessionChunkRequest


def _admission_kwargs() -> dict[str, object]:
    return {
        "operation_id": "operation-1",
        "attempt_id": "attempt-1",
        "request_id": "request-1",
        "generation": 1,
        "config_revision": 1,
        "route_revision": "route-1",
        "capability_revision": 1,
    }


def _speech_capability_export_model():
    model = getattr(speech_runtime_contracts, "SpeechStageCapabilityExportV1", None)
    assert model is not None, "SpeechStageCapabilityExportV1 contract is not defined"
    return model


def _ready_tts_capability() -> SpeechStageCapabilityV1:
    return SpeechStageCapabilityV1(
        stage="tts",
        method_ids=["TTS.Synthesize"],
        modes=["finite"],
        implementation="python",
        peer_id="local-peer",
        capability_revision=1,
        lifecycle=["foreground"],
        readiness="ready",
        exported=True,
    )


def test_ready_capability_is_exported_and_continuous_kws_requires_opt_in() -> None:
    capability = SpeechStageCapabilityV1(
        stage="stt",
        method_ids=["Transcription.StreamStart"],
        modes=["finite", "streaming"],
        implementation="python",
        peer_id="local-peer",
        capability_revision=1,
        lifecycle=["foreground"],
        readiness="ready",
        exported=True,
    )
    assert capability.exported is True

    with pytest.raises(ValidationError, match="experimental"):
        SpeechStageCapabilityV1(
            stage="kws",
            method_ids=["WakeWord.StreamStart"],
            modes=["streaming"],
            implementation="python",
            peer_id="local-peer",
            capability_revision=1,
            lifecycle=["foreground"],
            readiness="ready",
            exported=True,
        )


def test_versioned_schema_field_keeps_wire_and_python_compatibility() -> None:
    capability = SpeechStageCapabilityV1(
        schema="speech-stage-capability.v1",
        stage="stt",
        method_ids=["Transcription.StreamStart"],
        modes=["finite"],
        implementation="python",
        peer_id="local-peer",
        capability_revision=1,
        lifecycle=["foreground"],
        readiness="ready",
        exported=True,
    )

    assert capability.schema == "speech-stage-capability.v1"
    assert capability.model_dump(mode="json")["schema"] == "speech-stage-capability.v1"
    assert callable(SpeechStageCapabilityV1.schema)
    assert SpeechStageCapabilityV1.model_json_schema()["properties"]["schema"]["const"] == (
        "speech-stage-capability.v1"
    )


def test_capability_export_has_only_its_three_wire_fields_and_defaults_egress_off() -> None:
    export_model = _speech_capability_export_model()
    from app.shared.contracts.models import SpeechStageCapabilityExportV1

    assert SpeechStageCapabilityExportV1 is export_model
    export = export_model(
        capability=_ready_tts_capability(),
        voice_ids=["standard:test:voice-a", "clone:550e8400-e29b-41d4-a716-446655440000"],
    )

    serialized = export.model_dump(mode="json")
    assert set(serialized) == {"capability", "voice_ids", "requires_remote_audio_egress"}
    assert serialized["requires_remote_audio_egress"] is False
    assert serialized["voice_ids"] == [
        "standard:test:voice-a",
        "clone:550e8400-e29b-41d4-a716-446655440000",
    ]
    with pytest.raises(ValidationError):
        export_model(
            capability=_ready_tts_capability(),
            private_cache_path="/models/private/voice.bin",
        )


def test_capability_export_bounds_and_validates_unique_logical_voice_ids() -> None:
    export_model = _speech_capability_export_model()
    standard_voice = "standard:test:voice-a"
    clone_voice = "clone:550e8400-e29b-41d4-a716-446655440000"
    valid = export_model(
        capability=_ready_tts_capability(),
        voice_ids=[standard_voice, clone_voice],
    )
    assert valid.voice_ids == (standard_voice, clone_voice)

    for invalid_voice_ids in (
        [standard_voice, standard_voice],
        ["/models/private/voice.bin"],
        ["standard:Test:voice-a"],
        [f"standard:test:voice-{index:03d}" for index in range(257)],
    ):
        with pytest.raises(ValidationError):
            export_model(capability=_ready_tts_capability(), voice_ids=invalid_voice_ids)


def test_capability_export_is_frozen_and_detaches_nested_capability_state() -> None:
    export_model = _speech_capability_export_model()
    source_capability = _ready_tts_capability()
    export = export_model(
        capability=source_capability,
        voice_ids=["standard:test:voice-a"],
    )
    original_wire = export.model_dump(mode="json")

    source_capability.method_ids.append("TTS.StreamStart")
    exposed_capability = export.capability
    exposed_capability.method_ids.append("TTS.StreamStart")

    assert export.model_dump(mode="json") == original_wire
    with pytest.raises(ValidationError):
        export.requires_remote_audio_egress = True


def test_admission_and_audio_frames_are_bounded_and_rejected_sessions_do_not_leak_ids() -> None:
    rejected = SpeechStreamAdmissionV1(
        operation_id="operation-1",
        attempt_id="attempt-1",
        generation=1,
        status="rejected",
        reason_code="consent_required",
        capability_revision=1,
    )
    assert rejected.session_id is None

    valid = TranscriptionStreamChunkRequest(
        session_id="session-1",
        attempt_id="attempt-1",
        generation=1,
        sequence=0,
        payload_size_bytes=2,
        audio_data=b"\x00\x01",
    )
    assert valid.payload_kind == "audio"
    with pytest.raises(ValidationError, match="payload_size_bytes"):
        TranscriptionStreamChunkRequest(
            **{**valid.model_dump(), "payload_size_bytes": 1},
        )
    with pytest.raises(ValidationError):
        TranscriptionStreamChunkRequest(
            session_id="session-1",
            attempt_id="attempt-1",
            generation=1,
            sequence=0,
            payload_size_bytes=65 * 1024,
            audio_data=b"x" * (65 * 1024),
        )


def test_fallback_is_availability_only_and_is_limited_to_one_retry() -> None:
    assert is_eligible_speech_fallback("missing_capability") is True
    assert is_eligible_speech_fallback("offline", attempts_used=2) is False
    assert is_eligible_speech_fallback("transport_unaccepted", accepted=True) is False
    assert is_eligible_speech_fallback("auth_denied") is False
    assert is_eligible_speech_fallback("outcome_unknown") is False


def test_tts_text_chunks_use_utf8_byte_limits() -> None:
    request = TTSStreamPrepareRequest(**_admission_kwargs(), language="en", voice=None)
    assert request.play_on_server is False
    assert request.interrupt is False

    with pytest.raises(ValidationError, match="UTF-8 bytes"):
        TTSStreamSessionChunkRequest(
            session_id="session-1",
            attempt_id="attempt-1",
            generation=1,
            sequence=0,
            text="é" * 2049,
        )


def test_vad_has_independent_finite_and_owner_scoped_stream_lifecycles() -> None:
    async def exercise() -> tuple[bool, bool, str, str, str]:
        service = VADService()
        silence = b"\x00\x00" * 160
        speech = struct.pack("<160h", *([12_000] * 160))
        silent_result = await service.detect(VADDetectRequest(audio_data=silence))
        speech_result = await service.detect(VADDetectRequest(audio_data=speech))
        admission = await service.start_stream(VADStreamStartRequest(**_admission_kwargs()))
        chunk = await service.push_stream_chunk(
            VADStreamChunkRequest(
                session_id=admission.session_id or "",
                attempt_id="attempt-1",
                generation=1,
                sequence=0,
                payload_size_bytes=len(speech),
                audio_data=speech,
            )
        )
        result = await service.end_stream(
            VADStreamEndRequest(session_id=admission.session_id or "", final_sequence=0)
        )
        repeated = await service.stream_result(
            VADStreamEndRequest(session_id=admission.session_id or "")
        )
        return (
            silent_result.speech,
            speech_result.speech,
            admission.status,
            chunk.state,
            result.reason_code + ":" + repeated.reason_code,
        )

    silence_detected, speech_detected, admission_status, chunk_state, result_reasons = asyncio.run(
        exercise()
    )
    assert silence_detected is False
    assert speech_detected is True
    assert admission_status == "admitted"
    assert chunk_state == "active"
    assert result_reasons == "completed:completed"
