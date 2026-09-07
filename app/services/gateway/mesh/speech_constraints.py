"""Shared speech route constraint normalization for mesh dispatch surfaces."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.services.gateway.mesh.provider_eligibility import SpeechRouteConstraints
from app.shared.contracts.models.gateway import RouteExplainSpeechConstraints
from app.shared.contracts.models.speech import SpeechLanguageRequirement
from app.shared.contracts.models.stt import TranscriptionMethods, VADMethods, WakeWordMethods
from app.shared.contracts.models.tts import TTSMethods

_TTS_SPEECH_TOPICS = frozenset(
    {
        TTSMethods.REQUEST,
        TTSMethods.SYNTHESIZE,
        TTSMethods.STREAM_START,
        TTSMethods.STREAM_CHUNK,
        TTSMethods.STREAM_END,
        TTSMethods.STREAM_PREPARE,
        TTSMethods.STREAM_STATUS,
        TTSMethods.STREAM_CANCEL,
        TTSMethods.STREAM_RESULT,
    }
)
_STT_SPEECH_TOPICS = frozenset(
    {
        TranscriptionMethods.TRANSCRIBE,
        TranscriptionMethods.STREAM_START,
        TranscriptionMethods.STREAM_CHUNK,
        TranscriptionMethods.STREAM_END,
        TranscriptionMethods.STREAM_CANCEL,
        TranscriptionMethods.STREAM_STATUS,
        TranscriptionMethods.STREAM_RESULT,
    }
)
_KWS_SPEECH_TOPICS = frozenset(
    {
        WakeWordMethods.STREAM_START,
        WakeWordMethods.STREAM_CHUNK,
        WakeWordMethods.STREAM_END,
        WakeWordMethods.STREAM_CANCEL,
        WakeWordMethods.STREAM_STATUS,
        WakeWordMethods.STREAM_RESULT,
    }
)
_VAD_SPEECH_TOPICS = frozenset(
    {
        VADMethods.STREAM_START,
        VADMethods.STREAM_CHUNK,
        VADMethods.STREAM_END,
        VADMethods.STREAM_CANCEL,
        VADMethods.STREAM_STATUS,
        VADMethods.STREAM_RESULT,
    }
)
_ALL_SPEECH_STREAM_TOPICS = _STT_SPEECH_TOPICS | _KWS_SPEECH_TOPICS | _VAD_SPEECH_TOPICS


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

    if topic in _STT_SPEECH_TOPICS:
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

    if topic in _KWS_SPEECH_TOPICS or topic in _VAD_SPEECH_TOPICS:
        target_peer_id = _payload_value(message, "target_peer_id")
        if target_peer_id is not None and not bool(_payload_value(message, "experimental_remote")):
            raise ValueError("continuous KWS/VAD mesh routing requires experimental_remote")
        # KWS and VAD have no request-level language/voice selector, but they
        # still need a non-null requirement so provider selection carries the
        # route revision, fallback, readiness, and experimental policy.
        return SpeechRouteConstraints(topic=topic)

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
    if topic in _KWS_SPEECH_TOPICS or topic in _VAD_SPEECH_TOPICS:
        if hint.language_requirement is not None or hint.voice_id is not None:
            raise ValueError("KWS/VAD route explanations do not accept language or voice hints")
        return SpeechRouteConstraints(topic=topic)
    if topic in _ALL_SPEECH_STREAM_TOPICS:
        return SpeechRouteConstraints(topic=topic)
    return None


def _payload_value(message: Any, field_name: str) -> Any:
    if isinstance(message, Mapping):
        return message.get(field_name)
    return getattr(message, field_name, None)
