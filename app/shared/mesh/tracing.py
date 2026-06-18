"""Mesh tracing helpers for correlation IDs and audit-safe metadata."""

from __future__ import annotations

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


def redacted_copy(value: Any) -> Any:
    """Return a JSON-friendly copy with secret-like values replaced."""

    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, dict):
        return {
            str(key): _redact_value(str(key), nested)
            for key, nested in value.items()
        }
    if isinstance(value, list | tuple):
        return [redacted_copy(item) for item in value]
    return value


def audit_details_hash(value: Any) -> str:
    """Hash redacted metadata so separate logs can be correlated safely."""

    redacted = repr(redacted_copy(value)).encode("utf-8", errors="replace")
    return hashlib.sha256(redacted).hexdigest()


def _redact_value(key: str, value: Any) -> Any:
    if _is_secret_key(key):
        digest = hashlib.sha256(repr(value).encode("utf-8", errors="replace")).hexdigest()
        return {"redacted": True, "sha256": digest}
    return redacted_copy(value)


def _is_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _SECRET_KEY_PARTS)
