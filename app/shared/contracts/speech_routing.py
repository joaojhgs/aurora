"""Shared helpers for canonical speech route request metadata."""

from __future__ import annotations

from typing import Any

from app.shared.contracts.models.speech import (
    SpeechLanguageRequirement,
    compute_speech_route_requirement_digest,
)
from app.shared.contracts.models.stt import TranscriptionMethods
from app.shared.contracts.models.tts import TTSMethods


def compute_speech_route_requirement_digest_for_payload(topic: str, payload: Any) -> str:
    """Return the route requirement digest for an already validated speech request."""

    language = getattr(payload, "language", None)
    if topic in {TTSMethods.REQUEST, TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START}:
        language_requirement = (
            SpeechLanguageRequirement(mode="exact", language=language)
            if language is not None
            else None
        )
        return compute_speech_route_requirement_digest(
            topic=topic,
            language_requirement=language_requirement,
            voice_id=getattr(payload, "voice", None),
        )
    if topic == TranscriptionMethods.TRANSCRIBE:
        if language is not None:
            language_requirement = SpeechLanguageRequirement(mode="exact", language=language)
        else:
            language_requirement = SpeechLanguageRequirement(
                mode="auto",
                auto_language_candidates=list(
                    getattr(payload, "auto_language_candidates", None) or []
                ),
            )
        return compute_speech_route_requirement_digest(
            topic=topic,
            language_requirement=language_requirement,
            voice_id=None,
        )
    return compute_speech_route_requirement_digest(
        topic=topic,
        language_requirement=None,
        voice_id=None,
    )
