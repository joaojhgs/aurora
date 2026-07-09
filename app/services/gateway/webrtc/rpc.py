"""RPC Handler for WebRTC DataChannels.

Handles JSON-RPC calls over DataChannels by forwarding them to the message bus
after validating permissions against the aggregated registry and the peer's
:class:`Identity`.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.services.gateway.orchestrator_runtime_policy import remote_data_movement_denial_reason
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.orchestrator import (
    OrchestratorInferChatChunk,
    OrchestratorInferChatResponse,
    OrchestratorMethods,
)
from app.shared.contracts.models.scheduler import SchedulerMethods
from app.shared.contracts.models.stt import (
    AudioSessionMethods,
    TranscriptionMethods,
    WakeWordMethods,
)
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.mesh.tracing import (
    audit_details_hash,
    ensure_correlation_id,
    redacted_copy,
)


def _json_default(obj: object) -> str:
    """Fallback serializer for :func:`json.dumps`.

    Handles ``datetime`` objects (→ ISO-8601 string) so that RPC responses
    containing raw dicts with date/time values don't crash the channel.
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _is_streaming_transport_unavailable(exc: Exception) -> bool:
    message = str(exc)
    return (
        "does not support native stream_request" in message
        or "Streaming RPC transport unavailable" in message
    )


if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.acl.identity import Identity
    from app.services.gateway.registry_aggregator import RegistryAggregator
    from app.shared.contracts.models.gateway import MethodInfo

    from .rtc_client import RTCClient


class RPCHandler:
    # RPC methods that ANONYMOUS peers may call (pairing + login flow)
    _ANON_ALLOWED_METHODS = {
        AuthMethods.PAIRING_START,
        AuthMethods.PAIRING_CONNECT,
        AuthMethods.PAIRING_EXCHANGE,
        AuthMethods.LOGIN,
    }
    # Infrastructure bootstrap methods are intentionally reachable by their
    # full service-qualified RPC names even though their service contracts are
    # internal-only. All other DataChannel RPC calls must target methods marked
    # external/both in the aggregated registry.
    _INFRASTRUCTURE_RPC_METHODS = _ANON_ALLOWED_METHODS

    def __init__(
        self,
        bus: MessageBus,
        registry: RegistryAggregator,
        send_fn: Callable[[str], None],
        acl_provider: Callable[[], Identity],
        audit_fn: Callable[..., Any] | None = None,
        mesh_config: Any | None = None,
        peer_id: str | None = None,
        capacity_notify_fn: Callable[[str, int, int], None] | None = None,
        pairing_notify_fn: Callable[[str], None] | None = None,
    ):
        self._bus = bus
        self._registry = registry
        self._send = send_fn
        self._acl_provider = acl_provider
        self._audit_fn = audit_fn
        self._mesh_config = mesh_config
        self._peer_id = peer_id
        self._capacity_notify_fn = capacity_notify_fn
        self._pairing_notify_fn = pairing_notify_fn
        # Track active remote calls per module for capacity limiting
        self._active_remote_calls: dict[str, int] = {}
        self._active_stream_tasks: dict[str, asyncio.Task[Any]] = {}

    def set_bus(self, bus: MessageBus) -> None:
        """Update the bus used for inbound RPC dispatch.

        Gateway starts WebRTC before mesh in process mode, so handlers may be
        constructed while ``self._bus`` is still the raw process bus. Once the
        Gateway-owned MeshBus exists, callers update handlers through this
        method so streaming RPCs use MeshBus.stream_request instead of falling
        through to process-bus serialization.
        """
        self._bus = bus

    async def _handle_cancel(self, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        if not req_id:
            return
        task = self._active_stream_tasks.get(str(req_id)) or self._active_stream_tasks.get(req_id)
        if task is not None and not task.done():
            task.cancel()

    async def on_message(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            log_error("RPCHandler: Received invalid JSON")
            return

        msg_type = msg.get("type")
        if msg_type == "call":
            await self._handle_call(msg)
        elif msg_type == "cancel":
            await self._handle_cancel(msg)
        elif msg_type == "event":
            await self._handle_event(msg)
        else:
            log_debug(f"RPCHandler: Ignoring message type: {msg_type}")

    def _normalize_forwarded_tooling_catalog_event(
        self, topic: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        """Bind forwarded Tooling catalog events to the authenticated source peer.

        Providers announce their local catalog with local sentinel ids. Once the
        event crosses the mesh boundary, the receiver must key the snapshot by
        the authenticated remote peer instead of trusting the payload's claimed
        provider identity.
        """

        if topic not in {
            ToolingMethods.REMOTE_CATALOG_ANNOUNCED,
            ToolingMethods.REMOTE_CATALOG_DELTA_ANNOUNCED,
            ToolingMethods.REMOTE_CATALOG_REMOVED,
        } or not isinstance(params, dict):
            return params

        source_peer_id = self._peer_id or str(params.get("peer_id") or "unknown-peer")
        normalized = dict(params)
        # Never trust peer/provider/service ids inside a mesh-forwarded catalog
        # payload. Those fields define the cache key and policy scope, so the
        # receiver must bind them to the authenticated DataChannel peer even if
        # the sender claims another non-local identity.
        normalized["peer_id"] = source_peer_id
        normalized["provider_id"] = source_peer_id
        normalized["service_instance_id"] = f"remote:{source_peer_id}:Tooling"
        return normalized

    async def _handle_event(self, msg: dict[str, Any]) -> None:
        """Handle a forwarded event from a remote peer.

        Publishes the event on the local bus so local services react
        to remote lifecycle events (e.g., TTS.Started from a remote TTS).
        Events are fire-and-forget — no response is sent back.

        We attempt to reconstruct the original Pydantic model so that
        subscribers receive a typed payload instead of a raw dict.
        """
        topic = msg.get("topic")
        params = msg.get("params") or {}
        correlation_id = msg.get("correlation_id")

        if not topic:
            log_debug("RPCHandler: Received event with no topic")
            return

        # Gap 2B: Block events from ANONYMOUS peers
        identity: Identity = self._acl_provider()
        if identity.principal_id == "anonymous":
            log_warning(f"RPCHandler: Blocked event {topic} from ANONYMOUS peer")
            return

        log_debug(
            f"RPCHandler: Received forwarded event {topic} correlation_id={correlation_id or 'n/a'}"
        )
        try:
            if isinstance(params, dict):
                params = self._normalize_forwarded_tooling_catalog_event(topic, params)
            payload: Any = params
            if isinstance(params, dict) and self._registry:
                payload = await self._reconstruct_event_model(topic, params)

            await self._bus.publish(
                topic,
                payload,
                event=True,
                origin="mesh_forwarded",
                principal_id=identity.principal_id,
                identity_source="mesh_peer",
                caller_peer_id=self._peer_id,
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(f"RPCHandler: Error publishing forwarded event {topic}: {e}")

    async def _reconstruct_event_model(self, topic: str, params: dict) -> Any:
        """Try to reconstruct a Pydantic model from a forwarded event dict.

        The registry stores ``input_model`` as a *string* name (e.g.
        ``"TTSStarted"``), not an actual Python class.  Since we cannot
        resolve the class from a bare name without an import registry, we
        simply pass the raw dict through. The local bus and subscribers
        already handle dict payloads gracefully.
        """
        return params

    async def _handle_call(self, msg: dict[str, Any]) -> None:
        method_name = msg.get("method")
        params = msg.get("params") or {}
        req_id = msg.get("id")
        correlation_id = ensure_correlation_id(
            params,
            msg.get("correlation_id") or (str(req_id) if req_id is not None else None),
        )

        if not method_name:
            self._send_error(req_id, 400, "Missing method", correlation_id=correlation_id)
            return

        delimiter = "." if "." in method_name else "/" if "/" in method_name else None
        canonical_method = method_name.replace("/", ".", 1)
        is_infra_method = canonical_method in self._ANON_ALLOWED_METHODS
        mesh_shared_call = False

        # Mesh sharing gate: check if the called service is shared
        # (skip for infrastructure methods like pairing/auth that must always work)
        if self._mesh_config and self._mesh_config.enabled and not is_infra_method:
            module_name = method_name.split(delimiter, 1)[0] if delimiter else method_name

            sharing = self._mesh_config.services.get(module_name)
            if not sharing or not sharing.share:
                await self._audit_rpc_event(
                    "access.denied.rpc",
                    method_name=method_name,
                    correlation_id=correlation_id,
                    status="denied",
                    reason="service_not_shared",
                    details={"module": module_name, "params": params},
                )
                self._send_error(
                    req_id,
                    403,
                    f"Service {module_name} is not shared",
                    correlation_id=correlation_id,
                )
                return

            # Allowed-peers check (None = open to all authenticated peers)
            if sharing.allowed_peers is not None and (
                not self._peer_id or self._peer_id not in sharing.allowed_peers
            ):
                await self._audit_rpc_event(
                    "access.denied.rpc",
                    method_name=method_name,
                    correlation_id=correlation_id,
                    status="denied",
                    reason="peer_not_allowed",
                    details={"module": module_name, "params": params},
                )
                self._send_error(
                    req_id,
                    403,
                    f"Peer not allowed to access service {module_name}",
                    correlation_id=correlation_id,
                )
                return

            # Capacity check
            if sharing.max_concurrent > 0:
                active = self._active_remote_calls.get(module_name, 0)
                if active >= sharing.max_concurrent:
                    await self._audit_rpc_event(
                        "access.denied.rpc",
                        method_name=method_name,
                        correlation_id=correlation_id,
                        status="denied",
                        reason="service_at_capacity",
                        details={"module": module_name, "active": active},
                    )
                    self._send_error(
                        req_id,
                        429,
                        f"Service {module_name} at capacity",
                        correlation_id=correlation_id,
                    )
                    return
            mesh_shared_call = True

        result = await self._find_method(method_name)
        if not result:
            self._send_error(req_id, 404, "Method not found", correlation_id=correlation_id)
            return

        svc_name, meta = result

        # Permission check via Identity
        perms_needed = meta.required_perms or []
        identity: Identity = self._acl_provider()

        # Gap 2C: Block ANONYMOUS from all methods except pairing/auth
        if (
            identity.principal_id == "anonymous"
            and canonical_method not in self._ANON_ALLOWED_METHODS
        ):
            log_warning(f"RPCHandler: Blocked call to {method_name} from ANONYMOUS peer")
            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="authentication_required",
                principal_id=identity.principal_id,
                details={"params": params},
            )
            self._send_error(
                req_id,
                401,
                "Authentication required",
                correlation_id=correlation_id,
            )
            return

        if (
            getattr(meta, "exposure", "internal") not in {"external", "both"}
            and canonical_method not in self._INFRASTRUCTURE_RPC_METHODS
            and (not mesh_shared_call or canonical_method.endswith(".Login"))
        ):
            log_warning(
                f"RPCHandler: Blocked non-external RPC call to {method_name} "
                f"from {identity.principal_name}"
            )
            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="method_not_exposed",
                principal_id=identity.principal_id,
                details={
                    "exposure": getattr(meta, "exposure", "internal"),
                    "params": params,
                },
            )
            self._send_error(
                req_id,
                403,
                "Method is not exposed for WebRTC RPC",
                correlation_id=correlation_id,
            )
            return

        if perms_needed and not identity.can(*perms_needed, method_type=meta.method_type):
            log_warning(
                f"RPCHandler: Forbidden call to {method_name} from "
                f"{identity.principal_name} (need {perms_needed}, "
                f"have {list(identity.effective_perms)})"
            )

            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="permission_denied",
                principal_id=identity.principal_id,
                details={
                    "required": perms_needed,
                    "effective": list(identity.effective_perms),
                    "params": params,
                },
            )

            self._send_error(req_id, 403, "Forbidden", correlation_id=correlation_id)
            return

        topic = meta.bus_topic or f"{svc_name}.{meta.name}"
        remote_data_reason = remote_data_movement_denial_reason(
            topic, params, identity.effective_perms
        )
        if remote_data_reason:
            log_warning(
                f"RPCHandler: Forbidden runtime data-movement override for {method_name} "
                f"from {identity.principal_name}: {remote_data_reason}"
            )
            await self._audit_rpc_event(
                "access.denied.rpc",
                method_name=method_name,
                correlation_id=correlation_id,
                status="denied",
                reason="runtime_data_movement_permission_denied",
                principal_id=identity.principal_id,
                details={"params": params, "required_policy": remote_data_reason},
            )
            self._send_error(req_id, 403, remote_data_reason, correlation_id=correlation_id)
            return

        # Track active remote calls for capacity limiting
        module_for_capacity = svc_name
        max_concurrent = 0
        if self._mesh_config and self._mesh_config.enabled:
            self._active_remote_calls[module_for_capacity] = (
                self._active_remote_calls.get(module_for_capacity, 0) + 1
            )
            sharing = self._mesh_config.services.get(module_for_capacity)
            max_concurrent = sharing.max_concurrent if sharing else 0
            # Notify peers of capacity change
            if self._capacity_notify_fn and max_concurrent > 0:
                active = self._active_remote_calls[module_for_capacity]
                self._capacity_notify_fn(
                    module_for_capacity, max_concurrent - active, max_concurrent
                )
        try:
            log_debug(f"RPCHandler: Executing {topic} via bus correlation_id={correlation_id}")
            typed_params = params
            if isinstance(params, dict):
                if (
                    topic
                    in {
                        AudioSessionMethods.PREPARE,
                        TranscriptionMethods.PROCESS_AUDIO,
                        WakeWordMethods.PROCESS_AUDIO,
                    }
                    or topic == ToolingMethods.EXECUTE_TOOL
                ):
                    params = {
                        **params,
                        "caller_peer_id": self._peer_id,
                        "caller_principal_id": identity.principal_id,
                        "correlation_id": correlation_id,
                    }
                    typed_params = params
                elif topic in {
                    SchedulerMethods.SCHEDULE,
                    SchedulerMethods.SCHEDULE_ACTION,
                    SchedulerMethods.CANCEL,
                    SchedulerMethods.PAUSE,
                    SchedulerMethods.RESUME,
                    SchedulerMethods.LIST_JOBS,
                }:
                    params = {
                        **params,
                        "caller_peer_id": self._peer_id,
                        "caller_principal_id": identity.principal_id,
                    }
                    if topic in {SchedulerMethods.SCHEDULE, SchedulerMethods.SCHEDULE_ACTION}:
                        params["correlation_id"] = correlation_id
                    typed_params = params
            if meta.input_model and isinstance(params, dict) and callable(meta.input_model):
                try:
                    typed_params = meta.input_model(**params)
                except Exception as exc:
                    log_warning(
                        f"RPCHandler: Failed to construct {meta.input_model!r} "
                        f"for {method_name}: {exc}. Falling back to raw params."
                    )
                    typed_params = params
            is_streaming_method = topic == OrchestratorMethods.STREAM_INFER_CHAT
            stream_request = getattr(self._bus, "stream_request", None)
            if is_streaming_method and not callable(stream_request):
                await self._stream_infer_via_non_streaming_fallback(
                    req_id=req_id,
                    typed_params=typed_params,
                    identity=identity,
                    meta=meta,
                    correlation_id=correlation_id,
                )
                return

            if is_streaming_method and callable(stream_request):
                current_task = asyncio.current_task()
                if current_task is not None:
                    self._active_stream_tasks[req_id] = current_task
                try:
                    async for chunk in stream_request(
                        topic,
                        typed_params,
                        timeout=30.0,
                        origin="external",
                        principal_id=identity.principal_id,
                        effective_perms=list(identity.effective_perms),
                        identity_source="webrtc_rpc",
                        method_type=meta.method_type or "use",
                        caller_peer_id=self._peer_id,
                        correlation_id=correlation_id,
                    ):
                        self._send_chunk(req_id, chunk)
                    self._send(json.dumps({"type": "eof", "id": req_id}))
                    return
                except asyncio.CancelledError:
                    self._send(json.dumps({"type": "eof", "id": req_id, "cancelled": True}))
                    return
                except Exception as e:
                    if _is_streaming_transport_unavailable(e):
                        await self._stream_infer_via_non_streaming_fallback(
                            req_id=req_id,
                            typed_params=typed_params,
                            identity=identity,
                            meta=meta,
                            correlation_id=correlation_id,
                        )
                        return
                    log_error(f"RPCHandler: Error during stream of {method_name}: {e}")
                    self._send_error(
                        req_id,
                        500,
                        f"Stream error: {e}",
                        correlation_id=correlation_id,
                    )
                    return
                finally:
                    self._active_stream_tasks.pop(req_id, None)

            res = await self._bus.request(
                topic,
                typed_params,  # type: ignore[arg-type]
                timeout=30.0,
                origin="external",
                principal_id=identity.principal_id,
                effective_perms=list(identity.effective_perms),
                identity_source="webrtc_rpc",
                method_type=meta.method_type or "use",
                caller_peer_id=self._peer_id,
                correlation_id=correlation_id,
            )

            if res.ok:
                # Enhancement B: Notify RTCClient when PairingStart succeeds
                if canonical_method == AuthMethods.PAIRING_START and self._pairing_notify_fn:
                    self._pairing_notify_fn(self._peer_id or "")

                if hasattr(res.data, "__aiter__"):
                    try:
                        async for chunk in res.data:
                            self._send_chunk(req_id, chunk)
                        self._send(json.dumps({"type": "eof", "id": req_id}))
                    except Exception as e:
                        log_error(f"RPCHandler: Error during stream of {method_name}: {e}")
                        self._send_error(
                            req_id,
                            500,
                            f"Stream error: {e}",
                            correlation_id=correlation_id,
                        )
                else:
                    result_data = res.data
                    if hasattr(res.data, "model_dump"):
                        result_data = res.data.model_dump()

                    self._send(
                        json.dumps(
                            {"type": "result", "id": req_id, "result": result_data},
                            default=_json_default,
                        )
                    )
            else:
                await self._audit_rpc_event(
                    "mesh.rpc.error",
                    method_name=method_name,
                    correlation_id=correlation_id,
                    status="error",
                    principal_id=identity.principal_id,
                    details={"error": res.error, "params": params},
                )
                self._send_error(
                    req_id,
                    500,
                    res.error or "Service request failed",
                    correlation_id=correlation_id,
                )

        except TimeoutError:
            await self._audit_rpc_event(
                "mesh.rpc.timeout",
                method_name=method_name,
                correlation_id=correlation_id,
                status="timeout",
                principal_id=identity.principal_id,
                details={"params": params},
            )
            self._send_error(
                req_id,
                504,
                "Service request timed out",
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(
                f"RPCHandler: Error executing RPC {method_name}: {e} "
                f"correlation_id={correlation_id}"
            )
            await self._audit_rpc_event(
                "mesh.rpc.error",
                method_name=method_name,
                correlation_id=correlation_id,
                status="exception",
                principal_id=identity.principal_id,
                details={"error": str(e), "params": params},
            )
            self._send_error(req_id, 500, str(e), correlation_id=correlation_id)
        finally:
            # Decrement active remote call count for capacity tracking
            if self._mesh_config and self._mesh_config.enabled:
                count = self._active_remote_calls.get(module_for_capacity, 0)
                if count > 0:
                    self._active_remote_calls[module_for_capacity] = count - 1
                # Notify peers of capacity change
                if self._capacity_notify_fn and max_concurrent > 0:
                    active = self._active_remote_calls.get(module_for_capacity, 0)
                    self._capacity_notify_fn(
                        module_for_capacity, max_concurrent - active, max_concurrent
                    )

    def _send_chunk(self, req_id: Any, chunk: Any) -> None:
        """Send one stream chunk over the DataChannel in JSON-serializable form."""

        data = chunk
        if isinstance(chunk, bytes):
            data = chunk.decode(errors="ignore")
        elif hasattr(chunk, "model_dump"):
            data = chunk.model_dump(mode="json")

        self._send(
            json.dumps(
                {"type": "chunk", "id": req_id, "data": data},
                default=_json_default,
            )
        )

    async def _stream_infer_via_non_streaming_fallback(
        self,
        *,
        req_id: str,
        typed_params: Any,
        identity: Any,
        meta: Any,
        correlation_id: str,
    ) -> None:
        """Degrade process-mode stream RPC to a single non-streaming chunk.

        Process-mode Gateway receives WebRTC, while Orchestrator may live behind
        BullMQ. Until BullMQ exposes a native streaming protocol, this preserves a
        correct RPC response instead of failing the stream transport.
        """

        payload = typed_params
        if hasattr(payload, "model_copy"):
            payload = payload.model_copy(update={"stream": False})
        elif isinstance(payload, dict):
            payload = {**payload, "stream": False}
        result = await self._bus.request(
            OrchestratorMethods.INFER_CHAT,
            payload,
            timeout=30.0,
            origin="external",
            principal_id=identity.principal_id,
            effective_perms=list(identity.effective_perms),
            identity_source="webrtc_rpc",
            method_type=meta.method_type or "use",
            caller_peer_id=self._peer_id,
            correlation_id=correlation_id,
        )
        if not result.ok:
            self._send_error(
                req_id,
                500,
                result.error or "Streaming fallback inference failed",
                correlation_id=correlation_id,
            )
            return
        response = (
            result.data
            if isinstance(result.data, OrchestratorInferChatResponse)
            else OrchestratorInferChatResponse.model_validate(result.data)
            if isinstance(result.data, dict)
            else OrchestratorInferChatResponse(text="" if result.data is None else str(result.data))
        )
        self._send_chunk(
            req_id,
            OrchestratorInferChatChunk(
                delta=response.text,
                text=response.text,
                is_final=True,
                finish_reason=response.finish_reason or "stop",
                model_id=response.model_id,
                provider_id=response.provider_id,
                correlation_id=response.correlation_id or correlation_id,
            ),
        )
        self._send(json.dumps({"type": "eof", "id": req_id}))

    async def _find_method(self, method_name: str) -> tuple[str, MethodInfo] | None:
        delimiter = "." if "." in method_name else "/" if "/" in method_name else None
        if delimiter:
            parts = method_name.split(delimiter, 1)
            if len(parts) == 2:
                svc, cmd = parts
                announcement = await self._registry.get_service(svc)
                if announcement:
                    for m in announcement.methods:
                        if m.name == cmd:
                            return svc, m

        # Fallback: search external methods
        external_methods = await self._registry.get_external_methods()
        for svc_name, method_info in external_methods:
            if method_info.name == method_name:
                return svc_name, method_info

        return None

    async def _audit_rpc_event(
        self,
        event: str,
        *,
        method_name: str,
        correlation_id: str,
        status: str,
        reason: str | None = None,
        principal_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        if not self._audit_fn:
            return
        import contextlib

        safe_details = redacted_copy(details or {})
        audit_details = {
            "method": method_name,
            "peer_id": self._peer_id,
            "correlation_id": correlation_id,
            "status": status,
            "reason": reason,
            "details": safe_details,
            "details_sha256": audit_details_hash(safe_details),
        }
        with contextlib.suppress(Exception):
            await self._audit_fn(event, principal_id, audit_details)

    def _send_error(
        self,
        req_id: Any,
        code: int,
        message: str,
        *,
        correlation_id: str | None = None,
    ) -> None:
        self._send(
            json.dumps(
                {
                    "type": "error",
                    "id": req_id,
                    "correlation_id": correlation_id,
                    "error": {"code": code, "message": message},
                }
            )
        )
