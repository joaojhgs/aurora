"""One-case composition: remote Gateway STT, Assistant, and TTS.

The caller owns service startup, frozen inputs/endpoints, receiver proof,
attempt persistence, and campaign limits. This function makes no retries and
does not claim provider identity or cohort acceptance.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import re
import time
import wave
from typing import Any, Sequence

from stage_adapter import AdmittedEndpoint, GatewayStageError, request_gateway_stage


class K3CaseError(RuntimeError):
    """Sanitized stage failure for the caller's attempt record."""

    def __init__(
        self,
        stage: str,
        category: str,
        *,
        duration_ms: float | None = None,
        stop_campaign: bool = False,
        status: int | None = None,
        partial_record: dict[str, Any] | None = None,
    ):
        super().__init__(category)
        self.stage = stage
        self.category = category
        self.duration_ms = duration_ms
        self.stop_campaign = stop_campaign
        self.status = status
        self.partial_record = partial_record


def _normal_words(text: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", text.casefold(), flags=re.UNICODE))


def _remaining(deadline_monotonic: float, stage: str) -> float:
    value = deadline_monotonic - time.monotonic()
    if value <= 0:
        raise K3CaseError(stage, "request_deadline_exhausted", stop_campaign=True)
    return value


def _check_wav(audio: bytes, sample_rate: int, channels: int) -> tuple[int, str]:
    try:
        with wave.open(io.BytesIO(audio), "rb") as source:
            frames = source.getnframes()
            pcm = source.readframes(frames)
            valid = (
                source.getcomptype() == "NONE"
                and source.getsampwidth() == 2
                and source.getframerate() == sample_rate
                and source.getnchannels() == channels
                and frames > 0
                and len(pcm) == frames * 2 * channels
                and any(pcm)
            )
    except Exception:
        raise K3CaseError("input", "input_wav_invalid", stop_campaign=True) from None
    if not valid:
        raise K3CaseError("input", "input_wav_profile_invalid", stop_campaign=True)
    return frames, hashlib.sha256(audio).hexdigest()


async def run_k3_case(
    supervisor: Any,
    wav_bytes: bytes,
    *,
    wav_sha256: str,
    session_id: str,
    request_id: str,
    correlation_id: str,
    reference_transcript: str,
    expected_reply_words: Sequence[str],
    expected_remote_provider: str,
    expected_remote_model: str,
    stt_endpoint: AdmittedEndpoint,
    assistant_endpoint: AdmittedEndpoint,
    tts_endpoint: AdmittedEndpoint,
    deadline_monotonic: float,
    remote_auto_tts_readback_disabled: bool,
    sample_rate: int = 22_050,
    channels: int = 1,
) -> tuple[dict[str, Any], bytes]:
    """Run one K3 case through admitted Gateway STT, Assistant, and TTS.

    ``remote_auto_tts_readback_disabled`` must be set only after the caller has
    verified the selected remote runtime's frozen effective configuration.
    It prevents ExternalUserInput's configured automatic server TTS from
    overlapping this explicit remote TTS stage. Any possible server-TTS
    response metadata also fails closed before the explicit TTS request.

    Returns a content-free stage/correctness record plus the actual validated
    synthesized WAV bytes for the caller to persist. It never returns the
    transcript or assistant text in the record, and never writes artifacts.
    """
    if remote_auto_tts_readback_disabled is not True:
        raise K3CaseError(
            "preflight", "remote_automatic_tts_not_proven_disabled", stop_campaign=True
        )
    if not all(
        isinstance(value, str) and value
        for value in (
            session_id,
            request_id,
            correlation_id,
            reference_transcript,
            expected_remote_provider,
            expected_remote_model,
        )
    ):
        raise K3CaseError("preflight", "case_binding_invalid", stop_campaign=True)
    frames, observed_wav_hash = _check_wav(wav_bytes, sample_rate, channels)
    if observed_wav_hash != wav_sha256:
        raise K3CaseError("preflight", "input_wav_hash_mismatch", stop_campaign=True)

    from app.shared.contracts.models.orchestrator import (
        OrchestratorProcessRequest,
        OrchestratorResponse,
    )
    from app.shared.contracts.models.stt import (
        TranscribeAudioRequest,
        TranscribeAudioResponse,
    )
    from app.shared.contracts.models.tts import (
        TTSSynthesizeRequest,
        TTSSynthesizeResponse,
    )

    started_ns = time.monotonic_ns()
    record: dict[str, Any] = {
        "schema": "aurora.distributed_k3_case.v1",
        "condition": "production_local_bus_userinput_and_response_stt_assistant_tts",
        "local_case_ids": {
            "session_id": session_id,
            "request_id": request_id,
            "correlation_id": correlation_id,
        },
        "input_wav_sha256": observed_wav_hash,
        "input_wav_bytes": len(wav_bytes),
        "input_sample_rate": sample_rate,
        "input_channels": channels,
        "input_frames": frames,
        "stages": {},
        "correctness": {},
    }

    def fail(
        stage: str,
        category: str,
        *,
        duration_ms: float | None = None,
        stop_campaign: bool = False,
        status: int | None = None,
    ) -> None:
        record["status"] = "failed"
        record["failure"] = {"stage": stage, "category": category, "http_status": status}
        if stage not in record["stages"]:
            record["stages"][stage] = {"status": "failed", "error_category": category}
        if duration_ms is not None:
            record["stages"][stage].setdefault("duration_ms", duration_ms)
        raise K3CaseError(
            stage,
            category,
            duration_ms=duration_ms,
            stop_campaign=stop_campaign,
            status=status,
            partial_record=record,
        )

    # Stage 1: real remote typed Gateway transcription; the selected route label
    # is not treated as the identity of the server-side engine or model files.
    stt_started_ns = time.monotonic_ns()
    try:
        transcription, stt_meta = await request_gateway_stage(
            "stt",
            TranscribeAudioRequest(
                audio_data=base64.b64encode(wav_bytes).decode("ascii"),
                format="wav",
                sample_rate=sample_rate,
                channels=channels,
                language=None,
                model="accurate",
            ),
            TranscribeAudioResponse,
            stt_endpoint,
            deadline_monotonic=deadline_monotonic,
        )
    except GatewayStageError as exc:
        fail(
            "stt",
            exc.category,
            status=exc.status,
            duration_ms=exc.duration_ms,
            stop_campaign=exc.stop_campaign,
        )
    stt_ended_ns = time.monotonic_ns()
    stt_ms = (stt_ended_ns - stt_started_ns) / 1_000_000
    if not transcription.text.strip():
        fail("stt", "empty_transcript", duration_ms=stt_ms)
    if transcription.model_used != "accurate":
        fail("stt", "remote_stt_route_label_mismatch", duration_ms=stt_ms, stop_campaign=True)
    transcript_matches = _normal_words(transcription.text) == _normal_words(reference_transcript)
    record["stages"]["stt"] = {
        **stt_meta,
        "status": "completed",
        "start_monotonic_ns": stt_started_ns,
        "end_monotonic_ns": stt_ended_ns,
        "duration_ms": stt_ms,
        "duration_ms_reported_by_service": transcription.duration_ms,
        "model_used": transcription.model_used,
        "language": transcription.language,
        "transcript_sha256": hashlib.sha256(transcription.text.encode("utf-8")).hexdigest(),
        "transcript_chars": len(transcription.text),
    }
    record["correctness"]["transcript_matches_reference_words"] = transcript_matches
    if not transcript_matches:
        fail("stt", "transcript_predicate_failed", duration_ms=stt_ms)

    # Stage 2: real production ExternalUserInput. This runs the configured
    # remote orchestration graph and may publish completion events; it returns
    # OrchestratorResponse, not an ack. The source's error metadata and END
    # sentinel are explicitly rejected below.
    assistant_request = OrchestratorProcessRequest(
        text=transcription.text,
        source="external",
        session_id=session_id,
        request_id=request_id,
        correlation_id=correlation_id,
        stream=False,
        client_tts_playback=True,
    )
    assistant_started_ns = time.monotonic_ns()
    try:
        assistant, assistant_meta = await request_gateway_stage(
            "assistant",
            assistant_request,
            OrchestratorResponse,
            assistant_endpoint,
            deadline_monotonic=deadline_monotonic,
        )
    except GatewayStageError as exc:
        fail(
            "assistant",
            exc.category,
            status=exc.status,
            duration_ms=exc.duration_ms,
            stop_campaign=exc.stop_campaign,
        )
    assistant_ended_ns = time.monotonic_ns()
    assistant_ms = (assistant_ended_ns - assistant_started_ns) / 1_000_000
    metadata = assistant.metadata if isinstance(assistant.metadata, dict) else {}
    if metadata.get("error") is True:
        fail("assistant", "external_user_input_error_response", duration_ms=assistant_ms)
    if metadata.get("terminal_reason") == "graph_end" or assistant.text.strip() in {"", "END"}:
        fail("assistant", "no_speakable_assistant_answer", duration_ms=assistant_ms)
    if (
        assistant.session_id != session_id
        or assistant.request_id != request_id
        or assistant.correlation_id != correlation_id
    ):
        fail("assistant", "assistant_ids_mismatch", duration_ms=assistant_ms, stop_campaign=True)
    # UserInput emits its actual Response event before appending tts_status.
    # The frozen provider config disables automatic readback; native stage counts
    # must additionally prove exactly the explicit local TTS call at admission.
    if remote_auto_tts_readback_disabled is not True:
        fail("assistant", "server_tts_not_suppressed", duration_ms=assistant_ms, stop_campaign=True)
    if (
        metadata.get("provider") != expected_remote_provider
        or metadata.get("model") != expected_remote_model
    ):
        fail(
            "assistant",
            "remote_model_identity_mismatch",
            duration_ms=assistant_ms,
            stop_campaign=True,
        )
    assistant_matches = _normal_words(assistant.text).split() == [
        word.casefold() for word in expected_reply_words
    ]
    record["stages"]["assistant"] = {
        **assistant_meta,
        "status": "completed",
        "start_monotonic_ns": assistant_started_ns,
        "end_monotonic_ns": assistant_ended_ns,
        "duration_ms": assistant_ms,
        "session_id_matches": True,
        "request_id_matches": True,
        "correlation_id_matches": True,
        "metadata_error": False,
        "server_tts_status": metadata.get("tts_status"),
        "tts_suppression_basis": "frozen_config_false_plus_native_call_accounting",
        "reported_provider": expected_remote_provider,
        "reported_model": expected_remote_model,
        "response_sha256": hashlib.sha256(assistant.text.encode("utf-8")).hexdigest(),
        "response_chars": len(assistant.text),
    }
    record["correctness"]["assistant_reply_matches_expected_words"] = assistant_matches
    if not assistant_matches:
        fail("assistant", "assistant_reply_predicate_failed", duration_ms=assistant_ms)

    # Stage 3: explicit real remote TTS for the exact Assistant response.
    tts_started_ns = time.monotonic_ns()
    try:
        tts, tts_meta = await request_gateway_stage(
            "tts",
            TTSSynthesizeRequest(text=assistant.text, format="wav"),
            TTSSynthesizeResponse,
            tts_endpoint,
            deadline_monotonic=deadline_monotonic,
        )
    except GatewayStageError as exc:
        fail(
            "tts",
            exc.category,
            status=exc.status,
            duration_ms=exc.duration_ms,
            stop_campaign=exc.stop_campaign,
        )
    tts_ended_ns = time.monotonic_ns()
    tts_ms = (tts_ended_ns - tts_started_ns) / 1_000_000
    record["stages"]["tts"] = {
        **tts_meta,
        "status": "received",
        "start_monotonic_ns": tts_started_ns,
        "end_monotonic_ns": tts_ended_ns,
        "duration_ms": tts_ms,
        "text_matches_assistant": tts.text == assistant.text,
        "format": tts.format,
        "sample_rate": tts.sample_rate,
        "channels": tts.channels,
        "duration_ms_reported_by_service": tts.duration_ms,
    }
    if tts.format != "wav" or not tts.audio_data or tts.text != assistant.text:
        fail("tts", "synthesis_response_mismatch", duration_ms=tts_ms)
    if tts.channels != 1:
        fail("tts", "synthesis_response_profile_invalid", duration_ms=tts_ms)
    try:
        audio = base64.b64decode(tts.audio_data, validate=True)
    except Exception:
        fail("tts", "synthesis_audio_encoding_invalid", duration_ms=tts_ms)
    try:
        output_frames, output_hash = _check_wav(audio, tts.sample_rate, 1)
    except K3CaseError as exc:
        category = {
            "input_wav_invalid": "synthesized_wav_invalid",
            "input_wav_profile_invalid": "synthesized_wav_profile_invalid",
        }.get(exc.category, "synthesized_wav_invalid")
        fail("tts", category, duration_ms=tts_ms)
    record["stages"]["tts"].update(
        {
            "status": "completed",
            "frames": output_frames,
            "audio_bytes": len(audio),
            "audio_sha256": output_hash,
        }
    )
    record["correctness"]["all_expected"] = True
    record["flow_started_monotonic_ns"] = started_ns
    record["flow_ended_monotonic_ns"] = time.monotonic_ns()
    record["flow_duration_ms"] = (record["flow_ended_monotonic_ns"] - started_ns) / 1_000_000
    return record, audio
