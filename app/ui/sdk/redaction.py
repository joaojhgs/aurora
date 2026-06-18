"""Redaction helpers shared by UI SDK adapters."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

SENSITIVE_KEY_FRAGMENTS = (
    "api_key",
    "apikey",
    "argument",
    "authorization",
    "broker_secret",
    "cookie",
    "credential",
    "inbound_token",
    "mesh_secret",
    "password",
    "raw_sql",
    "refresh_token",
    "room_password",
    "secret",
    "token",
)

MASK = "<redacted>"


def is_sensitive_key(key: str) -> bool:
    """Return True when a field name should never be rendered raw."""

    normalized = key.lower().replace("-", "_")
    return any(fragment in normalized for fragment in SENSITIVE_KEY_FRAGMENTS)


def redact_sensitive(value: Any) -> Any:
    """Recursively redact secret-like fields while preserving structure."""

    if isinstance(value, Mapping):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_str = str(key)
            redacted[key_str] = MASK if is_sensitive_key(key_str) else redact_sensitive(item)
        return redacted
    if isinstance(value, str):
        return value
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
        return [redact_sensitive(item) for item in value]
    return value


def summarize_arguments(arguments: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return argument metadata without exposing any raw argument values."""

    if not arguments:
        return {"argument_keys": [], "redacted_arguments": {}}
    return {
        "argument_keys": sorted(str(key) for key in arguments),
        "redacted_arguments": {str(key): MASK for key in arguments},
    }
