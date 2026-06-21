"""Tests for AudioSession consent/session contracts."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.messaging.bus import MessageBus
from app.services.gateway.audio_session import AudioSessionService
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.stt import (
    AudioSessionConsentRequest,
    AudioSessionEventsRequest,
    AudioSessionMethods,
    AudioSessionPrepareRequest,
    AudioSessionStartRequest,
    AudioSessionStatusRequest,
    AudioSessionStopRequest,
)


@pytest.fixture
def mock_bus():
    bus = Mock(spec=MessageBus)
    bus.publish = AsyncMock()
    return bus


@pytest.fixture
def service(mock_bus):
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=mock_bus):
        yield AudioSessionService()


@pytest.mark.asyncio
async def test_audio_session_lifecycle_issues_token_and_events(service, mock_bus):
    prepare = await service.prepare_audio_session(
        AudioSessionPrepareRequest(
            operation="Transcription.ProcessAudio",
            mesh_selector=MeshAddressSelector(
                peer_id="peer-a",
                hardware_target="remote-mic",
            ),
            caller_principal_id="principal-1",
            caller_peer_id="peer-caller",
            sample_rate=16000,
            channels=1,
            correlation_id="corr-1",
        )
    )

    consent = await service.request_audio_session_consent(
        AudioSessionConsentRequest(
            session_id=prepare.session_id,
            approver_principal_id="owner-1",
        )
    )
    assert consent.status == "consented"
    assert consent.consent_token

    started = await service.start_audio_session(
        AudioSessionStartRequest(
            session_id=prepare.session_id,
            consent_token=consent.consent_token,
        )
    )
    assert started.status == "active"
    assert started.target_peer_id == "peer-a"
    assert started.privacy_class == "microphone"
    assert started.consent_granted is True

    status = await service.get_audio_session_status(
        AudioSessionStatusRequest(session_id=prepare.session_id)
    )
    assert status.status == "active"

    events = await service.get_audio_session_events(
        AudioSessionEventsRequest(session_id=prepare.session_id)
    )
    assert [event.event_type for event in events.events] == [
        "prepared",
        "consent_granted",
        "started",
    ]
    assert all(event.redacted for event in events.events)
    assert mock_bus.publish.call_args_list[-1].args[0] == AudioSessionMethods.EVENTS

    stopped = await service.stop_audio_session(
        AudioSessionStopRequest(session_id=prepare.session_id, reason="done")
    )
    assert stopped.status == "stopped"


@pytest.mark.asyncio
async def test_audio_session_rejects_missing_selector(service):
    with pytest.raises(ValueError, match="explicit peer/provider selector"):
        await service.prepare_audio_session(
            AudioSessionPrepareRequest(
                operation="WakeWord.ProcessAudio",
                mesh_selector=MeshAddressSelector(resource_namespace="mic"),
            )
        )


@pytest.mark.asyncio
async def test_audio_session_rejects_bad_token(service):
    prepare = await service.prepare_audio_session(
        AudioSessionPrepareRequest(
            operation="Transcription.ProcessAudio",
            mesh_selector=MeshAddressSelector(peer_id="peer-a"),
        )
    )
    await service.request_audio_session_consent(
        AudioSessionConsentRequest(session_id=prepare.session_id)
    )

    with pytest.raises(PermissionError, match="invalid"):
        await service.start_audio_session(
            AudioSessionStartRequest(session_id=prepare.session_id, consent_token="bad")
        )
