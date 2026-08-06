"""Pure speech language policy resolution.

The resolver is intentionally provider-neutral: services consume the effective
STT/model language decisions, while provider blocks only map those decisions to
their own assets.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_PRIMARY_LANGUAGE = "en"
AUTO_LANGUAGE = "auto"


@dataclass(frozen=True)
class SpeechLanguagePolicy:
    """Resolved language policy for speech consumers."""

    primary_language: str
    voice_language: str
    stt_language: str | None
    model_language: str

    @property
    def is_auto(self) -> bool:
        """Return whether STT should auto-detect spoken language."""

        return self.voice_language == AUTO_LANGUAGE


def resolve_speech_language_policy(
    primary_language: str | None,
    voice_language: str | None,
) -> SpeechLanguagePolicy:
    """Resolve canonical speech language settings into runtime policy.

    Fixed voice language pins STT and all language-bound models to that
    language. Automatic voice language leaves STT in auto-detect mode and uses
    primary language for model-bound decisions such as wakeword and TTS packs.
    """

    primary = _normalize_language(primary_language) or DEFAULT_PRIMARY_LANGUAGE
    voice = _normalize_language(voice_language) or AUTO_LANGUAGE
    if voice == AUTO_LANGUAGE:
        return SpeechLanguagePolicy(
            primary_language=primary,
            voice_language=AUTO_LANGUAGE,
            stt_language=None,
            model_language=primary,
        )
    return SpeechLanguagePolicy(
        primary_language=primary,
        voice_language=voice,
        stt_language=voice,
        model_language=voice,
    )


def _normalize_language(value: str | None) -> str | None:
    """Normalize blank language values to ``None`` and lower-case tags."""

    if value is None:
        return None
    normalized = str(value).strip().lower()
    return normalized or None
