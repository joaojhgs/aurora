"""Mesh tracing helpers for correlation IDs and audit-safe metadata."""

from __future__ import annotations

import base64
import hashlib
import uuid
from typing import Any

from pydantic import BaseModel

_SECRET_KEY_PARTS = (
    "api_key",
    "apikey",
    "auth",
    "bearer",
    "cookie",
    "credential",
    "jwt",
    "key",
    "password",
    "secret",
    "token",
)

_SECRET_KEYS = {
    "lease_id",
}

_AUDIO_KEY_PARTS = (
    "audio",
    "pcm",
    "sample",
    "waveform",
)

_BINARY_KEY_PARTS = (
    "blob",
    "bytes",
    "data",
    "file",
    "payload",
)

_SPEECH_METHOD_PARTS = (
    "audio",
    "speech",
    "stt",
    "synthesize",
    "transcribe",
    "transcription",
    "tts",
    "wakeword",
)

_SPEECH_TEXT_KEYS = {
    "content",
    "delta",
    "input",
    "message",
    "messages",
    "output",
    "prompt",
    "response",
    "text",
    "transcript",
    "transcription",
}


def new_correlation_id() -> str:
    """Return a compact random correlation identifier."""

    return uuid.uuid4().hex


def get_payload_correlation_id(payload: Any) -> str | None:
    """Extract a correlation ID from a payload object or dict when present."""

    if isinstance(payload, dict):
        value = payload.get("correlation_id")
    else:
        value = getattr(payload, "correlation_id", None)
    return str(value) if value else None


def ensure_correlation_id(payload: Any, provided: str | None = None) -> str:
    """Use the provided/payload correlation ID or generate a new one."""

    return provided or get_payload_correlation_id(payload) or new_correlation_id()


def redacted_copy(value: Any, *, method_id: str | None = None) -> Any:
    """Return a JSON-friendly copy with sensitive values replaced."""

    return _redacted_copy(value, method_id=method_id, redact_speech_content=True)


def _redacted_copy(
    value: Any,
    *,
    method_id: str | None,
    redact_speech_content: bool,
) -> Any:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, bytes | bytearray | memoryview):
        return _binary_summary(value)
    if redact_speech_content and _is_speech_method(method_id) and isinstance(value, str):
        return _content_summary(value, kind="speech")
    if isinstance(value, dict):
        return {
            str(key): _redact_value(str(key), nested, method_id=method_id)
            for key, nested in value.items()
        }
    if isinstance(value, list | tuple):
        if redact_speech_content and _is_speech_method(method_id):
            return _content_summary(value, kind="speech")
        return [
            _redacted_copy(
                item,
                method_id=method_id,
                redact_speech_content=False,
            )
            for item in value
        ]
    return value


def audit_details_hash(value: Any) -> str:
    """Hash redacted metadata so separate logs can be correlated safely."""

    redacted = repr(redacted_copy(value)).encode("utf-8", errors="replace")
    return hashlib.sha256(redacted).hexdigest()


def _redact_value(key: str, value: Any, *, method_id: str | None) -> Any:
    if _is_secret_key(key):
        digest = hashlib.sha256(repr(value).encode("utf-8", errors="replace")).hexdigest()
        return {"redacted": True, "sha256": digest}
    if _is_audio_key(key):
        return _content_summary(value, kind="audio")
    if isinstance(value, bytes | bytearray | memoryview):
        return _binary_summary(value)
    if _is_speech_method(method_id) and _is_speech_content_key(key):
        return _content_summary(value, kind="speech")
    return _redacted_copy(
        value,
        method_id=method_id,
        redact_speech_content=False,
    )


def _is_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return normalized in _SECRET_KEYS or any(part in normalized for part in _SECRET_KEY_PARTS)


def _is_audio_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    if normalized in {"sample_rate", "sampling_rate", "sample_count"}:
        return False
    return any(part in normalized for part in _AUDIO_KEY_PARTS)


def _is_speech_method(method_id: str | None) -> bool:
    if not method_id:
        return False
    normalized = method_id.lower().replace("-", "_").replace(".", "_")
    return any(part in normalized for part in _SPEECH_METHOD_PARTS)


def _is_speech_content_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return (
        normalized in _SPEECH_TEXT_KEYS
        or normalized in _BINARY_KEY_PARTS
        or normalized.endswith("_payload")
        or (normalized.endswith("_data") and normalized != "metadata")
        or any(part in normalized for part in ("blob", "bytes", "file"))
    )


def _binary_summary(value: bytes | bytearray | memoryview) -> dict[str, Any]:
    return {"redacted": True, "kind": "binary", "byte_length": len(value)}


def _content_summary(value: Any, *, kind: str) -> dict[str, Any]:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, bytes | bytearray | memoryview):
        return {"redacted": True, "kind": "binary", "byte_length": len(value)}
    if isinstance(value, str):
        summary: dict[str, Any] = {
            "redacted": True,
            "kind": kind,
            "char_length": len(value),
        }
        decoded_length = _base64_decoded_length(value)
        if decoded_length is not None:
            summary["byte_length"] = decoded_length
        return summary
    if isinstance(value, list | tuple):
        return {"redacted": True, "kind": kind, "element_count": len(value)}
    if isinstance(value, dict):
        return {"redacted": True, "kind": kind, "field_count": len(value)}
    return {"redacted": True, "kind": kind}


def _base64_decoded_length(value: str) -> int | None:
    compact = "".join(value.split())
    if not compact or len(compact) % 4:
        return None
    try:
        return len(base64.b64decode(compact, validate=True))
    except Exception:
        return None
