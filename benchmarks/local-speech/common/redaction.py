"""Report redaction and privacy checks for local speech benchmarks."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

FORBIDDEN_KEY_FRAGMENTS = (
    "audio_data",
    "audio_path",
    "audio_uri",
    "reference_text",
    "hypothesis_text",
    "transcript",
    "transcription",
    "raw_output",
    "stdout",
    "stderr",
)

FORBIDDEN_VALUE_FRAGMENTS = (
    ".wav",
    ".mp3",
    ".m4a",
    ".mp4",
    ".webm",
    "base64,",
)


class RedactionError(ValueError):
    """Raised when a benchmark report contains disallowed private data."""


def validate_report_redacted(value: Any, *, location: str = "$") -> None:
    """Reject report payloads that expose audio locations, transcripts, or logs."""

    if isinstance(value, Mapping):
        for key, item in value.items():
            key_text = str(key).casefold()
            if any(fragment in key_text for fragment in FORBIDDEN_KEY_FRAGMENTS):
                raise RedactionError(f"forbidden report key at {location}.{key}")
            validate_report_redacted(item, location=f"{location}.{key}")
        return

    if isinstance(value, str):
        folded = value.casefold()
        if any(fragment in folded for fragment in FORBIDDEN_VALUE_FRAGMENTS):
            raise RedactionError(f"forbidden report value at {location}")
        if "/" in value or "\\" in value:
            maybe_path = Path(value)
            if maybe_path.suffix.casefold() in {".wav", ".mp3", ".m4a", ".mp4", ".webm"}:
                raise RedactionError(f"forbidden report path at {location}")
        return

    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray):
        for index, item in enumerate(value):
            validate_report_redacted(item, location=f"{location}[{index}]")


def redacted_error_code(error: BaseException | str) -> str:
    """Return a stable sanitized failure code from an exception or string."""

    text = str(error).casefold()
    if "not found" in text or "no such file" in text:
        return "adapter_unavailable"
    if "timeout" in text:
        return "timeout"
    if "language" in text:
        return "unsupported_language_mode"
    if "memory" in text or "oom" in text:
        return "memory_limit"
    if "thermal" in text:
        return "thermal_limit"
    return "adapter_failed"
