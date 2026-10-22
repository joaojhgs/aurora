from __future__ import annotations

import hashlib
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.messaging.bus import QueryResult
from app.services.stt_transcription import service as stt_module
from app.services.stt_transcription.service import TranscriptionService
from app.shared.contracts.models.gateway import GetMeshStatusResponse, MeshLocalStatus
from app.shared.contracts.models.speech import SpeechRouteBinding
from app.shared.contracts.models.stt import TranscribeAudioRequest, TranscriptionMethods
from app.shared.contracts.speech_routing import compute_speech_route_requirement_digest_for_payload


LANGUAGES = ['af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr', 'gl', 'gu', 'ha', 'haw', 'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'jw', 'ka', 'kk', 'km', 'kn', 'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd', 'si', 'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt', 'uk', 'ur', 'uz', 'vi', 'yi', 'yo', 'zh', 'yue']


def ready_model(tmp_path, name, languages):
    weight = tmp_path / name
    weight.write_bytes(b"loaded weight " + name.encode())
    stat = weight.stat()
    return SimpleNamespace(
        supported_languages=languages,
        _aurora_resident_weight=(str(weight), (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)),
    )


def ready_service(monkeypatch, tmp_path):
    status = GetMeshStatusResponse(local=MeshLocalStatus(peer_id="mesh-stt-peer"))
    bus = SimpleNamespace(request=AsyncMock(return_value=QueryResult(ok=True, data=status.model_dump(mode="json"))), publish=AsyncMock())
    monkeypatch.setattr("app.shared.services.base_service.get_bus_singleton", lambda: bus)
    service = TranscriptionService()
    service._running = True
    service._runtime_state = "active"
    service._model_revision = 7
    service._realtime_enabled = False
    service._accurate_model = ready_model(tmp_path, "accurate.bin", LANGUAGES)
    service._model_status["accurate"] = "ready"
    return service, bus


@pytest.mark.asyncio
async def test_actual_multilingual_stt_projection_reaches_receiver_and_withdraws(monkeypatch, tmp_path):
    service, bus = ready_service(monkeypatch, tmp_path)
    await service._publish_service_announcement()
    announcement = bus.publish.await_args.args[1]
    method = next(m for m in announcement.methods if m.bus_topic == TranscriptionMethods.TRANSCRIBE)
    assert len(LANGUAGES) > 64
    assert method.speech_constraints.exact_languages == sorted(LANGUAGES)
    assert method.speech_constraints.supports_auto_detect
    assert method.speech_constraints.auto_detect_languages == sorted(LANGUAGES)
    assert method.speech_constraints.speech_capability_revision == 7
    exported = announcement.speech_stage_capabilities[0].capability
    assert exported.supported_languages == sorted(LANGUAGES)
    assert exported.modes == ["finite"]
    assert exported.required_permissions == [TranscriptionMethods.TRANSCRIBE]
    assert str(tmp_path) not in json.dumps(announcement.model_dump(mode="json"))
    request = TranscribeAudioRequest(audio_data="AA==", language=None, model="accurate")
    binding = SpeechRouteBinding(
        service_instance_id="remote:mesh-stt-peer:Transcription",
        projection_digest="a" * 64, projection_revision="projection-1",
        provider_lease_epoch="lease-1", provider_lease_revision=1,
        speech_capability_revision=7,
        requirement_digest=compute_speech_route_requirement_digest_for_payload(TranscriptionMethods.TRANSCRIBE, request),
    )
    envelope = SimpleNamespace(identity_source="webrtc_rpc", speech_route_binding=binding)
    assert service._envelope_speech_route_binding_valid(envelope, request, topic=TranscriptionMethods.TRANSCRIBE)
    service._model_revision += 1
    assert not service._envelope_speech_route_binding_valid(envelope, request, topic=TranscriptionMethods.TRANSCRIBE)
    service._accurate_enabled = False
    await service._publish_service_announcement()
    withdrawn = bus.publish.await_args.args[1]
    assert not withdrawn.speech_stage_capabilities
    assert next(m for m in withdrawn.methods if m.bus_topic == TranscriptionMethods.TRANSCRIBE).speech_constraints is None


@pytest.mark.asyncio
async def test_two_ready_roles_advertise_only_their_common_language_coverage(monkeypatch, tmp_path):
    service, _ = ready_service(monkeypatch, tmp_path)
    service._realtime_enabled = True
    service._realtime_model = ready_model(tmp_path, "english.bin", ["en"])
    service._model_status["realtime"] = "ready"
    exports = await service._speech_stage_capabilities_for_announcement()
    assert len(exports) == 1
    assert exports[0].capability.supported_languages == ["en"]
    assert len(exports[0].capability.model_ids) == 2
    constraints = service._speech_method_constraints_for_topic(TranscriptionMethods.TRANSCRIBE)
    assert constraints.exact_languages == ["en"]
    assert constraints.supports_auto_detect is False


def test_named_model_identity_uses_the_actual_resolved_constructor_weight(monkeypatch, tmp_path):
    model_root = tmp_path / "actual-loaded-root"
    model_root.mkdir()
    weight = model_root / "model.bin"
    weight.write_bytes(b"specific local model content")
    download = Mock(return_value=str(model_root))
    constructor = Mock(return_value=SimpleNamespace(supported_languages=LANGUAGES))
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=constructor))
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", SimpleNamespace(download_model=download))
    model = stt_module._create_whisper_model("base", device="cpu", download_root=str(tmp_path))
    download.assert_called_once_with("base", local_files_only=False, cache_dir=str(tmp_path))
    assert constructor.call_args.args == (str(model_root),)
    assert stt_module._resident_whisper_identity(model) == "faster-whisper:sha256:" + hashlib.sha256(weight.read_bytes()).hexdigest()
