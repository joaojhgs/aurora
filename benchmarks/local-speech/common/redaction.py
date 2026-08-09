"""Report redaction and privacy checks for local speech benchmarks."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

FORBIDDEN_KEY_FRAGMENTS = (
    "api_key",
    "audio_data",
    "audio_path",
    "audio_uri",
    "device_id",
    "reference_text",
    "hypothesis_text",
    "model_path",
    "secret",
    "serial",
    "transcript",
    "transcription",
    "token",
    "raw_output",
    "stdout",
    "stderr",
    "user_name",
    "username",
)

FORBIDDEN_VALUE_FRAGMENTS = (
    ".wav",
    ".mp3",
    ".m4a",
    ".mp4",
    ".webm",
    "base64,",
    "api_key=",
    "bearer ",
    "ghp_",
    "sk-",
)

ALLOWED_RUNTIME_PROVENANCE_KEYS = frozenset(
    {
        "browser_engine",
        "candidate_id",
        "execution_provider",
        "js_package",
        "model_artifact_sha256",
        "model_id",
        "model_revision",
        "onnxruntime_node",
        "onnxruntime_web",
        "package_pins",
        "runtime",
        "wasm_package",
    }
)

RUNTIME_PROVENANCE_FORBIDDEN_KEY_FRAGMENTS = (
    "api",
    "device_id",
    "host",
    "model_path",
    "path",
    "secret",
    "serial",
    "token",
    "user",
)

RUNTIME_PROVENANCE_FORBIDDEN_VALUE_FRAGMENTS = (
    ".onnx",
    ".wav",
    ".mp3",
    ".m4a",
    ".mp4",
    ".webm",
    "/home/",
    "\\users\\",
    "api_key=",
    "bearer ",
    "ghp_",
    "sk-",
)


class RedactionError(ValueError):
    """Raised when a benchmark report contains disallowed private data."""


def validate_report_redacted(value: Any, *, location: str = "$") -> None:
    """Reject report payloads that expose audio locations, transcripts, or logs."""

    if isinstance(value, Mapping):
        if location.endswith(".runtime_provenance"):
            sanitize_runtime_provenance(value, location=location)
            return
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


def sanitize_runtime_provenance(
    value: Any, *, location: str = "$.runtime_provenance"
) -> dict[str, str]:
    """Return a safe runtime provenance map or raise on sensitive material."""

    if not isinstance(value, Mapping):
        raise RedactionError(f"runtime_provenance must be an object at {location}")
    sanitized: dict[str, str] = {}
    for key, item in value.items():
        key_text = str(key)
        folded_key = key_text.casefold()
        if key_text not in ALLOWED_RUNTIME_PROVENANCE_KEYS:
            raise RedactionError(f"forbidden runtime_provenance key at {location}.{key}")
        if any(fragment in folded_key for fragment in RUNTIME_PROVENANCE_FORBIDDEN_KEY_FRAGMENTS):
            raise RedactionError(f"forbidden runtime_provenance key at {location}.{key}")
        if not isinstance(item, str):
            raise RedactionError(f"runtime_provenance value must be a string at {location}.{key}")
        folded_value = item.casefold()
        if any(
            fragment in folded_value for fragment in RUNTIME_PROVENANCE_FORBIDDEN_VALUE_FRAGMENTS
        ):
            raise RedactionError(f"forbidden runtime_provenance value at {location}.{key}")
        if _looks_like_local_path(item):
            raise RedactionError(f"forbidden runtime_provenance path at {location}.{key}")
        sanitized[key_text] = item
    return sanitized


def _looks_like_local_path(value: str) -> bool:
    if value.startswith(("/", "~", ".\\")) or value.startswith("./"):
        return True
    if ":\\" in value or "\\\\" in value:
        return True
    maybe_path = Path(value)
    return maybe_path.suffix.casefold() in {
        ".onnx",
        ".wav",
        ".mp3",
        ".m4a",
        ".mp4",
        ".webm",
    }


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
