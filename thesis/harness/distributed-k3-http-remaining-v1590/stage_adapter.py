"""Typed, fail-closed HTTP stage adapter for future distributed audio cohorts.

This module performs one real Gateway request per invocation. It does not own
the pipeline, select a peer/endpoint, retry, or declare a cohort accepted.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import urlsplit


MAX_RESPONSE_BYTES = 20 * 1024 * 1024
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
_STAGE_PATHS = {
    "stt": "/api/Transcription/Transcribe",
    "assistant": "/api/Orchestrator/ExternalUserInput",
    "tts": "/api/TTS/Synthesize",
}
_T = TypeVar("_T")


@dataclass(frozen=True)
class AdmittedEndpoint:
    """Exact endpoint and digest supplied by a separately frozen condition."""

    url: str
    sha256: str


class GatewayStageError(RuntimeError):
    """Safe finite failure; never retains URL, credential, body, or error text."""

    def __init__(
        self,
        stage: str,
        category: str,
        *,
        status: int | None = None,
        duration_ms: float | None = None,
        stop_campaign: bool,
    ) -> None:
        super().__init__(category)
        self.stage = stage
        self.category = category
        self.status = status
        self.duration_ms = duration_ms
        self.stop_campaign = stop_campaign


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str):
        raise GatewayStageError("unknown", "redirect_rejected", status=code, stop_campaign=True)


def _validate_binding(stage: str, binding: AdmittedEndpoint) -> str:
    if stage not in _STAGE_PATHS or not isinstance(binding, AdmittedEndpoint):
        raise GatewayStageError(str(stage), "endpoint_binding_invalid", stop_campaign=True)
    if not re.fullmatch(r"[0-9a-f]{64}", binding.sha256):
        raise GatewayStageError(stage, "endpoint_binding_invalid", stop_campaign=True)
    if hashlib.sha256(binding.url.encode("utf-8")).hexdigest() != binding.sha256:
        raise GatewayStageError(stage, "endpoint_binding_hash_mismatch", stop_campaign=True)
    try:
        parsed = urlsplit(binding.url)
        hostname = parsed.hostname
        _ = parsed.port
    except (ValueError, UnicodeError):
        raise GatewayStageError(stage, "endpoint_binding_invalid", stop_campaign=True) from None
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username
        or parsed.password
        or parsed.path != _STAGE_PATHS[stage]
        or parsed.query
        or parsed.fragment
    ):
        raise GatewayStageError(stage, "endpoint_binding_invalid", stop_campaign=True)
    return binding.url


def _exchange(url: str, payload: bytes, api_key: str, timeout: float) -> tuple[int, str | None, bytes]:
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-API-Key": api_key,
        },
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _RejectRedirects()
    )
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        # An explicit HTTP response is definitive; the body is intentionally
        # discarded because it may contain private request or user data.
        return int(exc.code), _header(exc.headers, "X-Correlation-ID"), b""
    try:
        return (
            int(response.status),
            _header(response.headers, "X-Correlation-ID"),
            response.read(MAX_RESPONSE_BYTES + 1),
        )
    finally:
        response.close()


def _header(headers: Any, name: str) -> str | None:
    value = headers.get(name) if headers is not None else None
    return value if isinstance(value, str) and _CORRELATION_ID.fullmatch(value) else None


def _record_transport_diagnostic(stage: str, exc: BaseException, payload: bytes, duration_ms: float) -> None:
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
        "wallTimeNs": time.time_ns(), "monotonicNs": time.monotonic_ns(),
        "stage": stage, "exceptionType": identity(exc), "errno": error_number(exc),
        "reasonType": identity(reason), "reasonErrno": error_number(reason),
        "payloadSha256": hashlib.sha256(payload).hexdigest(), "payloadBytes": len(payload),
        "durationMs": duration_ms, "automaticRetry": False,
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


async def request_gateway_stage(
    stage: str,
    request_model: Any,
    response_model: type[_T],
    endpoint: AdmittedEndpoint,
    *,
    deadline_monotonic: float,
    api_key_env: str = "AURORA_HOSTED_PEER_GATEWAY_API_KEY",
) -> tuple[_T, dict[str, Any]]:
    """Make one typed authenticated Gateway call and return safe metadata.

    The endpoint must come from the exact condition's independently frozen
    bindings. Callers must stop the campaign after an ambiguous transport or
    timeout failure; the remote operation may still be executing. There are no
    retries. The API key is read from the existing process environment and is
    never returned or logged here.
    """
    url = _validate_binding(stage, endpoint)
    api_key = os.environ.get(api_key_env, "")
    if not api_key:
        raise GatewayStageError(stage, "existing_auth_missing", stop_campaign=True)
    if not callable(getattr(request_model, "model_dump", None)):
        raise GatewayStageError(stage, "typed_request_required", stop_campaign=True)
    try:
        payload_obj = request_model.model_dump(mode="json", exclude_unset=True)
        payload = json.dumps(payload_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except Exception:
        raise GatewayStageError(stage, "typed_request_invalid", stop_campaign=True) from None

    remaining = deadline_monotonic - time.monotonic()
    if remaining <= 0:
        raise GatewayStageError(stage, "request_deadline_exhausted", stop_campaign=True)
    started_ns = time.monotonic_ns()
    try:
        status, server_correlation, body = await asyncio.wait_for(
            asyncio.to_thread(_exchange, url, payload, api_key, remaining),
            timeout=remaining,
        )
    except asyncio.TimeoutError as exc:
        elapsed = (time.monotonic_ns() - started_ns) / 1_000_000
        await asyncio.to_thread(_record_transport_diagnostic, stage, exc, payload, elapsed)
        raise GatewayStageError(stage, "request_timeout", duration_ms=elapsed, stop_campaign=True) from None
    except urllib.error.URLError as exc:
        elapsed = (time.monotonic_ns() - started_ns) / 1_000_000
        await asyncio.to_thread(_record_transport_diagnostic, stage, exc, payload, elapsed)
        reason = getattr(exc, "reason", None)
        category = "request_timeout" if isinstance(reason, TimeoutError) else "transport_ambiguous"
        raise GatewayStageError(stage, category, duration_ms=elapsed, stop_campaign=True) from None
    except (TimeoutError, OSError, GatewayStageError) as exc:
        elapsed = (time.monotonic_ns() - started_ns) / 1_000_000
        await asyncio.to_thread(_record_transport_diagnostic, stage, exc, payload, elapsed)
        if isinstance(exc, GatewayStageError):
            raise GatewayStageError(stage, exc.category, status=exc.status,
                                    duration_ms=elapsed, stop_campaign=True) from None
        raise GatewayStageError(stage, "transport_ambiguous", duration_ms=elapsed,
                                stop_campaign=True) from None
    ended_ns = time.monotonic_ns()
    elapsed_ms = (ended_ns - started_ns) / 1_000_000
    if status in (408, 504):
        raise GatewayStageError(stage, "http_timeout", status=status,
                                duration_ms=elapsed_ms, stop_campaign=True)
    if not 200 <= status < 300:
        raise GatewayStageError(stage, "http_status", status=status,
                                duration_ms=elapsed_ms, stop_campaign=False)
    if len(body) > MAX_RESPONSE_BYTES:
        raise GatewayStageError(stage, "response_too_large", status=status,
                                duration_ms=elapsed_ms, stop_campaign=True)
    if not server_correlation:
        raise GatewayStageError(stage, "server_correlation_missing", status=status,
                                duration_ms=elapsed_ms, stop_campaign=True)
    try:
        decoded = json.loads(body)
        response = response_model.model_validate(decoded)
    except Exception:
        raise GatewayStageError(stage, "typed_response_invalid", status=status,
                                duration_ms=elapsed_ms, stop_campaign=True) from None

    payload_ids = {
        key: payload_obj.get(key)
        for key in ("request_id", "session_id", "correlation_id")
        if isinstance(payload_obj.get(key), str)
    }
    metadata = {
        "stage": stage,
        "method": "POST",
        "path": _STAGE_PATHS[stage],
        "local_payload_ids": payload_ids,
        "server_correlation_id": server_correlation,
        "request_payload_sha256": hashlib.sha256(payload).hexdigest(),
        "request_payload_bytes": len(payload),
        "request_field_names": sorted(payload_obj) if isinstance(payload_obj, dict) else [],
        "http_status": status,
        "response_payload_sha256": hashlib.sha256(body).hexdigest(),
        "response_payload_bytes": len(body),
        "stage_duration_ms": elapsed_ms,
    }
    return response, metadata
