"""Stable microbenchmarks for core Aurora contract operations."""

from __future__ import annotations

import pytest

from app.shared.contracts.models.speech import (
    SpeechLanguageRequirement,
    compute_speech_route_requirement_digest,
)
from app.shared.contracts.models.tts import TTSMethods


@pytest.mark.performance
def test_speech_route_requirement_digest(benchmark) -> None:
    """Benchmark the canonical digest used during speech route selection."""

    language_requirement = SpeechLanguageRequirement(mode="exact", language="en-US")

    digest = benchmark(
        compute_speech_route_requirement_digest,
        topic=TTSMethods.SYNTHESIZE,
        language_requirement=language_requirement,
        voice_id="aurora-default",
    )

    assert len(digest) == 64
    assert digest == compute_speech_route_requirement_digest(
        topic=TTSMethods.SYNTHESIZE,
        language_requirement=language_requirement,
        voice_id="aurora-default",
    )
