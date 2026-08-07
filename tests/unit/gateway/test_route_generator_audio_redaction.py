"""Gateway generated-route redaction for speech and audio payloads."""

from __future__ import annotations

import base64
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.route_generator import RouteGenerator
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.stt import (
    TranscribeAudioRequest,
    TranscribeAudioResponse,
    TranscriptionMethods,
)
from app.shared.contracts.models.tts import (
    TTSMethods,
    TTSSynthesizeRequest,
    TTSSynthesizeResponse,
)
from app.shared.mesh.tracing import redacted_copy


class _SingleMethodRegistry:
    def __init__(self, module_name: str, method_info: MethodInfo):
        self.module_name = module_name
        self.method_info = method_info

    def on_registry_change(self, _callback):
        pass

    async def get_external_methods(self):
        return [(self.module_name, self.method_info)]

    def is_service_available(self, module_name: str) -> bool:
        return module_name == self.module_name


def _debug_output(mock_log_debug: Mock) -> str:
    return "\n".join(str(call.args[0]) for call in mock_log_debug.call_args_list)


def test_redacted_copy_preserves_normal_text_without_speech_context():
    assert redacted_copy({"text": "ordinary route metadata"}, method_id="Gateway.GetStatus") == {
        "text": "ordinary route metadata"
    }


@pytest.mark.asyncio
async def test_transcribe_generated_route_logs_only_audio_metadata():
    raw_audio = b"pcm-secret-audio"
    encoded_audio = base64.b64encode(raw_audio).decode("ascii")
    payload = {
        "audio_data": encoded_audio,
        "format": "wav",
        "sample_rate": 16000,
        "samples": [1, -1, 42, 7],
        "payload": {
            "nested": {
                "audio_data": "nested-raw-audio",
                "transcript": "nested transcript must not leak",
                "token": "nested-token-must-not-leak",
            }
        },
    }
    bus = AsyncMock()
    bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "text": "transcribed private words",
                "confidence": 0.9,
                "duration_ms": 12.5,
                "model_used": "test",
            },
        )
    )
    method_info = MethodInfo(
        name="Transcribe",
        summary="Transcribe audio",
        bus_topic=TranscriptionMethods.TRANSCRIBE,
        exposure="external",
        method_type="use",
        input_schema=TranscribeAudioRequest.model_json_schema(),
        output_schema=TranscribeAudioResponse.model_json_schema(),
        required_perms=[TranscriptionMethods.TRANSCRIBE],
    )
    handler = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("Transcription", method_info),
    )._create_handler("Transcription", method_info)

    with patch("app.services.gateway.route_generator.log_debug") as mock_log_debug:
        await handler(
            payload,
            principal_id="principal-1",
            effective_perms=[TranscriptionMethods.TRANSCRIBE],
            identity_source="gateway_http",
        )

    bus.request.assert_awaited_once()
    assert bus.request.await_args.args[1]["audio_data"] == encoded_audio

    logs = _debug_output(mock_log_debug)
    assert encoded_audio not in logs
    assert "nested-raw-audio" not in logs
    assert "nested transcript must not leak" not in logs
    assert "nested-token-must-not-leak" not in logs
    assert "transcribed private words" not in logs
    assert "'byte_length': 16" in logs
    assert "'element_count': 4" in logs
    assert "'format': 'wav'" in logs
    assert "'sample_rate': 16000" in logs


@pytest.mark.asyncio
async def test_tts_synthesize_generated_route_redacts_text_and_audio_logs():
    encoded_audio = base64.b64encode(b"tts-secret-audio").decode("ascii")
    bus = AsyncMock()
    bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data={
                "audio_data": encoded_audio,
                "format": "wav",
                "sample_rate": 24000,
                "channels": 1,
                "duration_ms": 20.0,
                "text": "spoken private response",
            },
        )
    )
    method_info = MethodInfo(
        name="Synthesize",
        summary="Synthesize speech",
        bus_topic=TTSMethods.SYNTHESIZE,
        exposure="external",
        method_type="use",
        input_schema=TTSSynthesizeRequest.model_json_schema(),
        output_schema=TTSSynthesizeResponse.model_json_schema(),
        required_perms=[TTSMethods.SYNTHESIZE],
    )
    handler = RouteGenerator(
        bus=bus,
        registry=_SingleMethodRegistry("TTS", method_info),
    )._create_handler("TTS", method_info)

    with patch("app.services.gateway.route_generator.log_debug") as mock_log_debug:
        response = await handler(
            {
                "text": "speak this private phrase",
                "voice": "alloy",
                "format": "wav",
                "sample_rate": 24000,
                "metadata": {"credentials": "credential-must-not-leak"},
            },
            principal_id="principal-1",
            effective_perms=[TTSMethods.SYNTHESIZE],
            identity_source="gateway_http",
        )

    assert response["audio_data"] == encoded_audio
    assert bus.request.await_args.args[1]["text"] == "speak this private phrase"

    logs = _debug_output(mock_log_debug)
    assert "speak this private phrase" not in logs
    assert "spoken private response" not in logs
    assert encoded_audio not in logs
    assert "credential-must-not-leak" not in logs
    assert "'voice': 'alloy'" in logs
    assert "'format': 'wav'" in logs
    assert "'byte_length': 16" in logs
