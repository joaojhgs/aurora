"""Speech route binding transport metadata tests."""

import asyncio

import pytest

from app.messaging.bullmq_bus import _dump_speech_route_binding
from app.messaging.bus import Envelope
from app.messaging.local_bus import LocalBus
from app.shared.contracts.models.speech import SpeechRouteBinding
from app.shared.contracts.models.tts import TTSMethods, TTSRequest


def _binding() -> SpeechRouteBinding:
    return SpeechRouteBinding(
        service_instance_id="remote:provider-a:TTS",
        projection_digest="a" * 64,
        projection_revision="projection-1",
        provider_lease_epoch="epoch-1",
        provider_lease_revision=3,
        speech_capability_revision=11,
        requirement_digest="b" * 64,
    )


@pytest.mark.asyncio
async def test_local_bus_request_preserves_speech_route_binding_in_envelope() -> None:
    bus = LocalBus(validate_topics=False)
    await bus.start()
    seen: list[Envelope] = []

    async def handler(envelope: Envelope) -> None:
        seen.append(envelope)
        await bus.publish(
            envelope.reply_to or "",
            {"ok": True},
            event=False,
            correlation_id=envelope.correlation_id,
        )

    bus.subscribe(TTSMethods.REQUEST, handler)
    binding = _binding()

    result = await bus.request(
        TTSMethods.REQUEST,
        TTSRequest(text="hello"),
        speech_route_binding=binding,
    )

    await asyncio.sleep(0)
    assert result.ok is True
    assert seen[0].speech_route_binding == binding
    await bus.stop()


def test_bullmq_serialized_binding_round_trips_through_envelope() -> None:
    binding = _binding()
    serialized = _dump_speech_route_binding(binding)

    envelope = Envelope(
        type=TTSMethods.REQUEST,
        payload=TTSRequest(text="hello"),
        speech_route_binding=serialized,
    )

    assert envelope.speech_route_binding == binding
