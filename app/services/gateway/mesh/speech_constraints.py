"""Shared speech route constraint normalization for mesh dispatch surfaces."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.services.gateway.mesh.provider_eligibility import SpeechRouteConstraints
from app.shared.contracts.models.gateway import RouteExplainSpeechConstraints
from app.shared.contracts.models.speech import SpeechLanguageRequirement
from app.shared.contracts.models.stt import TranscriptionMethods
from app.shared.contracts.models.tts import TTSMethods

_TTS_SPEECH_TOPICS = frozenset({TTSMethods.REQUEST, TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START})
_STT_SPEECH_TOPICS = frozenset({TranscriptionMethods.TRANSCRIBE})


def extract_speech_route_constraints(
    message: Any,
    *,
    topic: str,
) -> SpeechRouteConstraints | None:
    """Return immutable speech routing constraints derived from request data."""

    language = _payload_value(message, "language")
    if topic in _TTS_SPEECH_TOPICS:
        voice_id = _payload_value(message, "voice")
        return SpeechRouteConstraints(
            topic=topic,
            language_requirement=SpeechLanguageRequirement(mode="exact", language=language)
            if language is not None
            else None,
            voice_id=voice_id,
        )

    if topic == TranscriptionMethods.TRANSCRIBE:
        if language is not None:
            language_requirement = SpeechLanguageRequirement(mode="exact", language=language)
        else:
            language_requirement = SpeechLanguageRequirement(
                mode="auto",
                auto_language_candidates=list(
                    _payload_value(message, "auto_language_candidates") or []
                ),
            )
        return SpeechRouteConstraints(topic=topic, language_requirement=language_requirement)

    return None


def explain_speech_route_constraints(
    hint: RouteExplainSpeechConstraints | None,
    *,
    topic: str,
) -> SpeechRouteConstraints | None:
    """Convert typed ExplainRoute speech hints to dispatcher constraints."""

    if hint is None:
        return None
    if topic in _TTS_SPEECH_TOPICS:
        if hint.language_requirement is not None and hint.language_requirement.mode != "exact":
            raise ValueError("TTS route explanations require exact speech language hints")
        return SpeechRouteConstraints(
            topic=topic,
            language_requirement=hint.language_requirement,
            voice_id=hint.voice_id,
        )
    if topic in _STT_SPEECH_TOPICS:
        if hint.voice_id is not None:
            raise ValueError("speech voice hints are only valid for TTS route explanations")
        return SpeechRouteConstraints(
            topic=topic,
            language_requirement=hint.language_requirement,
        )
    return None


def _payload_value(message: Any, field_name: str) -> Any:
    if isinstance(message, Mapping):
        return message.get(field_name)
    return getattr(message, field_name, None)
