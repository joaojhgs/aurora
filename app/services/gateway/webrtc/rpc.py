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


def _json_default(obj: object) -> str:
    """Fallback serializer for :func:`json.dumps`.

    Handles ``datetime`` objects (→ ISO-8601 string) so that RPC responses
    containing raw dicts with date/time values don't crash the channel.
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.acl.identity import Identity
    from app.services.gateway.registry_aggregator import RegistryAggregator
    from app.shared.contracts.models.gateway import MethodInfo

    from .rtc_client import RTCClient


class RPCHandler:
    # RPC methods that ANONYMOUS peers may call (pairing + login flow)
    _ANON_ALLOWED_METHODS = {
        "PairingStart",
        "PairingConnect",
        "PairingExchange",
        "Login",
    }

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

    async def on_message(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            log_error("RPCHandler: Received invalid JSON")
            return

        msg_type = msg.get("type")
        if msg_type == "call":
            await self._handle_call(msg)
        elif msg_type == "event":
            await self._handle_event(msg)
        else:
            log_debug(f"RPCHandler: Ignoring message type: {msg_type}")

    async def _handle_event(self, msg: dict[str, Any]) -> None:
        """Handle a forwarded event from a remote peer.

        Publishes the event on the local bus so local services react
        to remote lifecycle events (e.g., TTS.Started from a remote TTS).
        Events are fire-and-forget — no response is sent back.
        """
        topic = msg.get("topic")
        params = msg.get("params") or {}

        if not topic:
            log_debug("RPCHandler: Received event with no topic")
            return

        # Gap 2B: Block events from ANONYMOUS peers
        identity: Identity = self._acl_provider()
        if identity.principal_id == "anonymous":
            log_warning(f"RPCHandler: Blocked event {topic} from ANONYMOUS peer")
            return

        log_debug(f"RPCHandler: Received forwarded event {topic}")
        try:
            await self._bus.publish(
                topic,
                params,  # type: ignore[arg-type]
                event=True,
                origin="mesh_forwarded",
                principal_id=identity.principal_id,
            )
        except Exception as e:
            log_error(f"RPCHandler: Error publishing forwarded event {topic}: {e}")

    async def _handle_call(self, msg: dict[str, Any]) -> None:
        method_name = msg.get("method")
        params = msg.get("params") or {}
        req_id = msg.get("id")

        if not method_name:
            self._send_error(req_id, 400, "Missing method")
            return

        # Extract method short name for infrastructure checks
        delimiter = "." if "." in method_name else "/" if "/" in method_name else None
        short_name = (
            method_name.split(delimiter, 1)[1]
            if delimiter and delimiter in method_name
            else method_name
        )
        is_infra_method = short_name in self._ANON_ALLOWED_METHODS

        # Mesh sharing gate: check if the called service is shared
        # (skip for infrastructure methods like pairing/auth that must always work)
        if self._mesh_config and self._mesh_config.enabled and not is_infra_method:
            module_name = method_name.split(delimiter, 1)[0] if delimiter else method_name

            sharing = self._mesh_config.sharing.get(module_name)
            if not sharing or not sharing.share:
                self._send_error(req_id, 403, f"Service {module_name} is not shared")
                return

            # Allowed-peers check (None = open to all authenticated peers)
            if sharing.allowed_peers is not None and (
                not self._peer_id or self._peer_id not in sharing.allowed_peers
            ):
                self._send_error(
                    req_id,
                    403,
                    f"Peer not allowed to access service {module_name}",
                )
                return

            # Capacity check
            if sharing.max_concurrent > 0:
                active = self._active_remote_calls.get(module_name, 0)
                if active >= sharing.max_concurrent:
                    self._send_error(req_id, 429, f"Service {module_name} at capacity")
                    return

        result = await self._find_method(method_name)
        if not result:
            self._send_error(req_id, 404, "Method not found")
            return

        svc_name, meta = result

        # Permission check via Identity
        perms_needed = meta.required_perms or []
        identity: Identity = self._acl_provider()

        # Gap 2C: Block ANONYMOUS from all methods except pairing/auth
        if identity.principal_id == "anonymous" and meta.name not in self._ANON_ALLOWED_METHODS:
            log_warning(f"RPCHandler: Blocked call to {method_name} from ANONYMOUS peer")
            self._send_error(req_id, 401, "Authentication required")
            return

        if perms_needed and not identity.can(*perms_needed):
            log_warning(
                f"RPCHandler: Forbidden call to {method_name} from "
                f"{identity.principal_name} (need {perms_needed}, "
                f"have {list(identity.effective_perms)})"
            )

            # Audit: WebRTC RPC access denied
            if self._audit_fn:
                import contextlib

                with contextlib.suppress(Exception):
                    asyncio.create_task(
                        self._audit_fn(
                            "access.denied.rpc",
                            identity.principal_id,
                            {
                                "method": method_name,
                                "required": perms_needed,
                                "effective": list(identity.effective_perms),
                            },
                        )
                    )

            self._send_error(req_id, 403, "Forbidden")
            return

        topic = meta.bus_topic or f"{svc_name}.{meta.name}"
        # Track active remote calls for capacity limiting
        module_for_capacity = svc_name
        max_concurrent = 0
        if self._mesh_config and self._mesh_config.enabled:
            self._active_remote_calls[module_for_capacity] = (
                self._active_remote_calls.get(module_for_capacity, 0) + 1
            )
            sharing = self._mesh_config.sharing.get(module_for_capacity)
            max_concurrent = sharing.max_concurrent if sharing else 0
            # Notify peers of capacity change
            if self._capacity_notify_fn and max_concurrent > 0:
                active = self._active_remote_calls[module_for_capacity]
                self._capacity_notify_fn(
                    module_for_capacity, max_concurrent - active, max_concurrent
                )
        try:
            log_debug(f"RPCHandler: Executing {topic} via bus")
            res = await self._bus.request(
                topic,
                params,  # type: ignore[arg-type]
                timeout=30.0,
                origin="external",
                principal_id=identity.principal_id,
            )

            if res.ok:
                # Enhancement B: Notify RTCClient when PairingStart succeeds
                if meta.name == "PairingStart" and self._pairing_notify_fn:
                    self._pairing_notify_fn(self._peer_id or "")

                if hasattr(res.data, "__aiter__"):
                    try:
                        async for chunk in res.data:
                            data = chunk
                            if isinstance(chunk, bytes):
                                data = chunk.decode(errors="ignore")

                            self._send(
                                json.dumps(
                                    {"type": "chunk", "id": req_id, "data": data},
                                    default=_json_default,
                                )
                            )
                        self._send(json.dumps({"type": "eof", "id": req_id}))
                    except Exception as e:
                        log_error(f"RPCHandler: Error during stream of {method_name}: {e}")
                        self._send_error(req_id, 500, f"Stream error: {e}")
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
                self._send_error(req_id, 500, res.error or "Service request failed")

        except TimeoutError:
            self._send_error(req_id, 504, "Service request timed out")
        except Exception as e:
            log_error(f"RPCHandler: Error executing RPC {method_name}: {e}")
            self._send_error(req_id, 500, str(e))
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

    def _send_error(self, req_id: Any, code: int, message: str) -> None:
        self._send(
            json.dumps({"type": "error", "id": req_id, "error": {"code": code, "message": message}})
        )
