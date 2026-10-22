"""Private, opt-in, payload-free spans on existing Aurora server boundaries.

This module is loaded only by the pilot's explicit sitecustomize opt-in. It
wraps existing BaseService invocations and existing speech lifecycle callbacks;
it does not call a service, change a response, or grant a permission.
"""

from __future__ import annotations

import contextvars
import importlib.util
import atexit
import json
import os
import re
import uuid
from contextlib import asynccontextmanager
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.stt import TranscriptionMethods
from app.shared.contracts.models.tts import TTSMethods

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_context: contextvars.ContextVar[dict[str, str | None]] = contextvars.ContextVar(
    "aurora_v430_invocation_context", default={}
)
_observer: Any | None = None
_span: Any | None = None
_installed = False


def _safe_id(value: Any) -> str | None:
    return value if isinstance(value, str) and _SAFE_ID.fullmatch(value) else None


def _payload_value(payload: Any, key: str) -> Any:
    if isinstance(payload, Mapping):
        return payload.get(key)
    return getattr(payload, key, None)


def _load_observer() -> tuple[Any, Any]:
    module_path = Path(os.environ["AURORA_V409_OBSERVER_PATH"]).resolve(strict=True)
    output_path = Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"]).resolve()
    host_id = os.environ["AURORA_VOICE_STAGE_HOST_ID"]
    spec = importlib.util.spec_from_file_location("aurora_v409_stage_observer", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("V409 observer source is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    observer = module.JsonlStageObserver(output_path, host_id_pseudonym=host_id)
    return observer, module.async_span


class _EnvelopeSpeechObserver:
    """Reuse V409 JSONL writer and add only exact in-process envelope joins."""

    def __init__(self, observer: Any) -> None:
        self._observer = observer

    def observe(self, event: Any) -> None:
        self._observer.observe(event)
        if getattr(event, "event", None) not in {"model_invoke_start", "model_invoke_end"}:
            return
        context = _context.get()
        operation_id = _safe_id(getattr(event, "operation_id", None))
        attempt_id = _safe_id(getattr(event, "attempt_id", None))
        stage = getattr(event, "stage", None)
        if not operation_id or not attempt_id or stage not in {"stt", "tts"}:
            return
        try:
            self._observer.record_span(
                event=("span_start" if event.event == "model_invoke_start" else "span_end"),
                stage=stage,
                span_id=attempt_id,
                parent_span_id=None,
                handler=f"{stage}.model_invoke",
                selected_provider=None,
                request_id=context.get("request_id"),
                session_id=context.get("session_id"),
                correlation_id=context.get("correlation_id"),
                operation_id=operation_id,
                attempt_id=attempt_id,
                monotonic_ns=int(event.monotonic_ns),
                outcome=(
                    "started"
                    if event.event == "model_invoke_start"
                    else event.outcome
                ),
                reason_code=(event.reason_code if event.event == "model_invoke_end" else None),
            )
        except Exception:
            # Existing emit_speech_lifecycle isolates all observer failures.
            return


class _ObservedChatModel:
    """Transparent wrapper around the model actually resolved for the graph."""

    def __init__(self, target: Any) -> None:
        self._target = target

    def __getattr__(self, name: str) -> Any:
        method = getattr(self._target, name)
        if name == "bind_tools" and callable(method):
            def bind_tools(*args: Any, **kwargs: Any) -> Any:
                bound = method(*args, **kwargs)
                return _ObservedChatModel(bound)

            return bind_tools
        if name == "ainvoke" and callable(method):
            async def ainvoke(*args: Any, **kwargs: Any) -> Any:
                context = _context.get()
                async with _span(
                    _observer,
                    stage="llm",
                    handler="resolved_chat_model.ainvoke",
                    selected_provider=_provider_name(self._target),
                    request_id=context.get("request_id"),
                    session_id=context.get("session_id"),
                    correlation_id=context.get("correlation_id"),
                ):
                    return await method(*args, **kwargs)

            return ainvoke
        if name == "astream" and callable(method):
            def astream(*args: Any, **kwargs: Any) -> Any:
                async def iterate() -> Any:
                    context = _context.get()
                    async with _span(
                        _observer,
                        stage="llm",
                        handler="resolved_chat_model.astream",
                        selected_provider=_provider_name(self._target),
                        request_id=context.get("request_id"),
                        session_id=context.get("session_id"),
                        correlation_id=context.get("correlation_id"),
                    ):
                        stream = method(*args, **kwargs)
                        primary: BaseException | None = None
                        try:
                            async for item in stream:
                                yield item
                        except BaseException as exc:
                            primary = exc
                            raise
                        finally:
                            close = getattr(stream, "aclose", None)
                            if callable(close):
                                try:
                                    await close()
                                except BaseException:
                                    if primary is None:
                                        raise

                return iterate()

            return astream
        return method


def _provider_name(model: Any) -> str | None:
    cls = type(model)
    value = f"{cls.__module__}.{cls.__qualname__}"
    return value if _SAFE_ID.fullmatch(value) else None


def install() -> None:
    """Install wrappers only when all explicit pilot settings are present."""
    global _observer, _span, _installed
    if _installed:
        return
    if os.environ.get("AURORA_VOICE_TELEMETRY_V430") != "1":
        return
    _observer, _span = _load_observer()
    speech_observer = _EnvelopeSpeechObserver(_observer)
    atexit.register(_close_observer)

    from app.shared.services.base_service import BaseService

    original_invoke = BaseService._invoke_contract_method

    async def observed_invoke(
        self: Any,
        method: Any,
        data: Any,
        *,
        envelope: Any,
        pass_envelope: bool,
        topic: str | None,
        method_name: str,
        method_type: str | None,
    ) -> Any:
        payload = getattr(envelope, "payload", None)
        current = {
            "request_id": _safe_id(_payload_value(payload, "request_id")),
            "session_id": _safe_id(_payload_value(payload, "session_id")),
            "correlation_id": _safe_id(getattr(envelope, "correlation_id", None)),
            "topic": topic if topic in {
                OrchestratorMethods.EXTERNAL_USER_INPUT,
                TranscriptionMethods.TRANSCRIBE,
                TTSMethods.SYNTHESIZE,
                TTSMethods.REQUEST,
            } else None,
        }
        token = _context.set(current)
        try:
            call = lambda: original_invoke(
                self,
                method,
                data,
                envelope=envelope,
                pass_envelope=pass_envelope,
                topic=topic,
                method_name=method_name,
                method_type=method_type,
            )
            stage = {
                TranscriptionMethods.TRANSCRIBE: "stt",
                TTSMethods.SYNTHESIZE: "tts",
                TTSMethods.REQUEST: "tts",
            }.get(topic)
            if stage is None:
                return await call()
            async with _span(
                _observer,
                stage=stage,
                handler=topic,
                selected_provider=None,
                request_id=current.get("request_id"),
                session_id=current.get("session_id"),
                correlation_id=current.get("correlation_id"),
            ):
                return await call()
        finally:
            _context.reset(token)

    BaseService._invoke_contract_method = observed_invoke
    original_start = BaseService.start

    async def observed_start(self: Any) -> None:
        if hasattr(self, "_speech_lifecycle_observer"):
            if self._speech_lifecycle_observer is None:
                self._speech_lifecycle_observer = speech_observer
                if getattr(self, "_speech_stream_observation_revisions", None) is None:
                    self._speech_stream_observation_revisions = {}
        elif getattr(self, "module", None) == "Orchestrator":
            _install_orchestrator_observers(self)
        await original_start(self)

    BaseService.start = observed_start
    _installed = True


def _close_observer() -> None:
    if _observer is None:
        return
    status = _observer.close()
    status_path = Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"]).with_suffix(".status.json")
    encoded = (json.dumps(status, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(status_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        if os.write(fd, encoded) != len(encoded):
            raise OSError("short observer status write")
        os.fsync(fd)
    finally:
        os.close(fd)


def _install_orchestrator_observers(service: Any) -> None:
    original_persist = getattr(service, "_persist_chat_message", None)
    if callable(original_persist) and not getattr(original_persist, "_v430_observed", False):
        async def observed_persist(**kwargs: Any) -> Any:
            context = _context.get()
            async with _span(
                _observer,
                stage="history",
                handler="OrchestratorService._persist_chat_message",
                selected_provider=None,
                request_id=context.get("request_id"),
                session_id=_safe_id(kwargs.get("session_id")) or context.get("session_id"),
                correlation_id=context.get("correlation_id"),
            ):
                return await original_persist(**kwargs)

        observed_persist._v430_observed = True
        service._persist_chat_message = observed_persist

    from app.services.orchestrator.agents import chatbot

    original_resolve = chatbot._chat_llm_for_state
    if not getattr(original_resolve, "_v430_observed", False):
        async def observed_resolve(state: Any, bus: Any) -> Any:
            model = await original_resolve(state, bus)
            return None if model is None else _ObservedChatModel(model)

        observed_resolve._v430_observed = True
        chatbot._chat_llm_for_state = observed_resolve
