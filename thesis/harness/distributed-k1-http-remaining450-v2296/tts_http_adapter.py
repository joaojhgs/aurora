"""Fail-closed adapter draft for a real authenticated remote TTS HTTP call.

This is not wired into the LocalBus campaign runner. A future K1 runner must
call it once for the actual assistant reply, retain its response correlation
ID separately from the local STT/LLM correlation, and require a receiver-side
provider/stage receipt before measured requests.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import os


MAX_RESPONSE_BYTES = 2_097_152
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")


class RemoteTtsCallError(RuntimeError):
    """Finite transport failure without retaining endpoint, key, or body text."""

    def __init__(self, category: str, *, status: int | None = None):
        super().__init__(category)
        self.category = category
        self.status = status


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(
        self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        raise RemoteTtsCallError("redirect_rejected", status=code)


def _record_transport_diagnostic(
    stage: str, exc: BaseException, payload: bytes, duration_ms: float
) -> None:
    """Retain only bounded transport metadata; never error text, headers or bodies."""
    output = os.environ.get("AURORA_OUTPUT_DIR")
    if not output:
        return
    reason = getattr(exc, "reason", None)

    def identity(value: object) -> str | None:
        if value is None:
            return None
        kind = type(value)
        name = kind.__module__ + "." + kind.__qualname__
        return name[:160] if re.fullmatch(r"[A-Za-z0-9_.]+", name) else "unavailable"

    def error_number(value: object) -> int | None:
        number = getattr(value, "errno", None)
        return number if isinstance(number, int) else None

    record = {
        "schema": "aurora.transport_failure_metadata.v1",
        "wallTimeNs": time.time_ns(),
        "monotonicNs": time.monotonic_ns(),
        "stage": stage,
        "exceptionType": identity(exc),
        "errno": error_number(exc),
        "reasonType": identity(reason),
        "reasonErrno": error_number(reason),
        "payloadSha256": hashlib.sha256(payload).hexdigest(),
        "payloadBytes": len(payload),
        "durationMs": duration_ms,
        "automaticRetry": False,
        "exceptionTextHeadersBodyOrCredentialsRetained": False,
    }
    try:
        path = os.path.join(os.path.dirname(output), "transport-diagnostics.jsonl")
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as stream:
            stream.write(json.dumps(record, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        # Observability must not replace the original transport outcome.
        pass


def synthesize_remote_tts(
    text: str, deadline_monotonic: float
) -> tuple[dict[str, Any], dict[str, Any]]:
    """POST the real assistant reply to an explicitly admitted Gateway URL.

    The API key is read from the existing process environment and is never
    included in returned metadata or raised errors. Call from an async runner
    with ``asyncio.to_thread``; on timeout/transport ambiguity the campaign
    must stop before another request because the remote operation may continue.
    """
    endpoint = os.environ.get("AURORA_K1_REMOTE_TTS_ENDPOINT", "")
    api_key = os.environ.get("AURORA_K1_HTTP_BEARER", "")
    if not isinstance(text, str) or not text.strip():
        raise RemoteTtsCallError("assistant_text_missing")
    if not endpoint or not api_key:
        raise RemoteTtsCallError("explicit_endpoint_or_existing_auth_missing")
    try:
        parsed = urlsplit(endpoint)
        hostname = parsed.hostname
    except ValueError:
        raise RemoteTtsCallError("endpoint_binding_invalid") from None
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username
        or parsed.password
        or parsed.path != "/api/TTS/Synthesize"
        or parsed.query
        or parsed.fragment
    ):
        raise RemoteTtsCallError("endpoint_binding_invalid")
    remaining = deadline_monotonic - time.monotonic()
    if remaining <= 0:
        raise RemoteTtsCallError("request_deadline_exhausted")

    payload = json.dumps({"text": text, "format": "wav"}, separators=(",", ":")).encode("utf-8")
    request = Request(
        endpoint,
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
    )
    started = time.monotonic_ns()
    try:
        opener = build_opener(ProxyHandler({}), _RejectRedirects())
        with opener.open(request, timeout=remaining) as response:
            status = int(response.status)
            correlation = response.headers.get("X-Correlation-ID")
            if correlation is not None and not _CORRELATION_ID.fullmatch(correlation):
                correlation = None
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        status = int(exc.code)
        category = "http_timeout" if status in (408, 504) else "http_status"
        raise RemoteTtsCallError(category, status=status) from None
    except RemoteTtsCallError:
        raise
    except (TimeoutError, URLError, OSError) as exc:
        _record_transport_diagnostic(
            "tts", exc, payload, (time.monotonic_ns() - started) / 1_000_000
        )
        reason = getattr(exc, "reason", None)
        kind = (
            "timeout"
            if isinstance(exc, TimeoutError) or isinstance(reason, TimeoutError)
            else "transport_error"
        )
        raise RemoteTtsCallError(kind) from None
    ended = time.monotonic_ns()
    if not 200 <= status < 300:
        raise RemoteTtsCallError("http_status", status=status)
    if len(body) > MAX_RESPONSE_BYTES:
        raise RemoteTtsCallError("response_too_large", status=status)
    try:
        decoded = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RemoteTtsCallError("response_json_invalid", status=status) from None
    if not isinstance(decoded, dict):
        raise RemoteTtsCallError("response_shape_invalid", status=status)
    metadata = {
        "transport": "authenticated_gateway_http",
        "http_status": status,
        "server_correlation_id": correlation,
        "requester_duration_ms": (ended - started) / 1_000_000,
        "request_payload_bytes": len(payload),
        "response_bytes": len(body),
        "response_sha256": hashlib.sha256(body).hexdigest(),
    }
    return decoded, metadata
