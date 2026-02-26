"""Bus-backed auth proxy for the WebRTC RTCClient.

Implements the same interface that RTCClient expects from the old
gateway-embedded AuthService, but delegates every call to the
standalone Auth service via the message bus.

This is a transitional layer — once RTCClient is refactored to use
bus calls directly, this module can be removed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_warning
from app.shared.auth.identity import SYSTEM, Identity

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus


@dataclass
class _TokenProxy:
    """Minimal Token-like object returned by authenticate_token()."""

    id: str
    prefix: str | None = None
    device_id: str | None = None
    user_id: str | None = None
    scopes: list[str] | None = None
    created_at: Any = None
    expires_at: Any = None

    # Fields used by build_identity_from_token
    _identity_data: dict | None = None


@dataclass
class _UserProxy:
    """Minimal User-like object returned by get_principal()."""

    id: str
    username: str
    permissions: list[str] | None = None
    is_admin: bool = False
    created_at: Any = None


class _AuditDBProxy:
    """Proxy for db_manager used for audit_event() calls.

    Delegates audit writes to the Auth.AuditLog bus call.  Since the
    RTCClient calls ``audit_event(auth_service.db_manager, ...)`` and
    ``audit_event`` writes directly, we provide a compatible interface.

    Fix 8: Actually route audit events through the bus instead of
    silently dropping them.
    """

    def __init__(self, bus: MessageBus) -> None:
        self._bus = bus

    async def store_audit_event(
        self,
        event_id: str | None = None,
        event: str | None = None,
        principal_id: str | None = None,
        details: str | None = None,
        ip_address: str | None = None,
    ) -> None:
        """Persist an audit event via the bus (Fix 8).

        ``audit_event()`` in ``app/shared/auth/audit.py`` calls
        ``db_manager.store_audit_event(...)`` — this method provides
        that interface, forwarding to the Auth service via the bus.
        """
        try:
            from app.shared.contracts.models.auth import AuditLogRequest

            await self._bus.publish(
                "Auth.AuditEvent",
                AuditLogRequest(
                    limit=1,
                    principal_id=principal_id,
                    event=event or "unknown",
                ),
                event=True,
                origin="internal",
            )
        except Exception as exc:
            log_warning(f"_AuditDBProxy.store_audit_event failed: {exc}")

    async def log_audit_event(self, **kwargs: Any) -> None:
        """Forward audit event to the Auth service via the bus.

        The Auth service handles audit logging internally through its
        ``audit_event()`` helper.  Here we re-use the existing
        ``Auth.AuditLog`` contract for writes by sending a minimal
        audit payload that the auth_manager persists.
        """
        try:
            from app.shared.contracts.models.auth import AuditLogRequest

            # The audit_event() helper expects a db_manager.  Since we
            # don't have one, we publish a lightweight event instead.
            # The Auth service stores via its own DB path.
            await self._bus.publish(
                "Auth.AuditEvent",
                AuditLogRequest(
                    limit=1,
                    principal_id=kwargs.get("actor_id"),
                    event=kwargs.get("event_type", "unknown"),
                ),
                event=True,
                origin="internal",
            )
        except Exception as exc:
            log_warning(f"_AuditDBProxy.log_audit_event failed: {exc}")

    async def get_audit_log(self, **kwargs: Any) -> list[dict]:
        """Retrieve audit log entries via the Auth.AuditLog contract."""
        try:
            from app.shared.contracts.models.auth import AuditLogRequest

            resp = await self._bus.request(
                "Auth.AuditLog",
                AuditLogRequest(
                    limit=kwargs.get("limit", 50),
                    offset=kwargs.get("offset", 0),
                    event=kwargs.get("event_type"),
                ),
                timeout=5.0,
            )
            # QueryResult.data → dict with "events" key
            if hasattr(resp, "data") and isinstance(resp.data, dict):
                return resp.data.get("events", [])
            if isinstance(resp, dict):
                return resp.get("events", [])
            return []
        except Exception as exc:
            log_warning(f"_AuditDBProxy.get_audit_log failed: {exc}")
            return []


class BusAuthProxy:
    """Drop-in replacement for the old gateway AuthService.

    RTCClient calls methods like ``authenticate_token()``,
    ``build_identity_from_token()``, ``get_principal()``,
    ``get_system_token()``, and accesses ``db_manager`` for audit.

    This proxy translates each call into a bus request to the
    standalone Auth service.
    """

    def __init__(self, bus: MessageBus) -> None:
        self._bus = bus
        self.db_manager = _AuditDBProxy(bus)

    # ── Helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _unwrap(resp: Any) -> dict | None:
        """Unwrap a QueryResult from bus.request().

        bus.request() returns QueryResult(ok, data, error).  The actual
        service response lives inside ``data`` as a dict.
        """
        if resp is None:
            return None
        # QueryResult — check ok first
        if hasattr(resp, "ok"):
            if not resp.ok:
                return None
            data = resp.data
            if isinstance(data, dict):
                return data
            # data might be a Pydantic model that wasn't dumped
            if hasattr(data, "model_dump"):
                return data.model_dump()
            return None
        # Fallback: already a dict
        if isinstance(resp, dict):
            return resp
        return None

    # ── Token validation ─────────────────────────────────────────────

    async def authenticate_token(self, token_str: str) -> _TokenProxy | None:
        """Validate a token via Auth.ValidateToken bus call.

        Returns a lightweight Token proxy if valid, None otherwise.
        The proxy carries the full identity data so that a subsequent
        ``build_identity_from_token()`` call can return immediately.
        """
        try:
            from app.shared.contracts.models.auth import ValidateTokenRequest

            resp = await self._bus.request(
                "Auth.ValidateToken",
                ValidateTokenRequest(token=token_str),
                timeout=5.0,
            )

            data = self._unwrap(resp)
            if not data or not data.get("valid", False):
                return None

            return _TokenProxy(
                id="bus-validated",
                device_id=data.get("device_id"),
                user_id=data.get("principal_id"),
                scopes=list(data.get("effective_perms", [])),
                _identity_data={
                    "principal_id": data.get("principal_id"),
                    "principal_name": data.get("principal_name"),
                    "device_id": data.get("device_id"),
                    "is_admin": data.get("is_admin", False),
                    "permissions": list(data.get("permissions", [])),
                    "effective_perms": list(data.get("effective_perms", [])),
                    "source": data.get("source", "bus"),
                },
            )
        except Exception as e:
            log_warning(f"BusAuthProxy.authenticate_token failed: {e}")
            return None

    async def build_identity_from_token(
        self, token: _TokenProxy, source: str = "webrtc_token"
    ) -> Identity | None:
        """Build an Identity from a previously validated token proxy.

        The Auth service already resolves effective permissions during
        ``Auth.ValidateToken``, so we construct the :class:`Identity`
        directly instead of calling ``build_identity()`` (which would
        attempt to re-resolve and expects different parameter names).
        """
        data = getattr(token, "_identity_data", None)
        if not data:
            return None

        return Identity(
            principal_id=data.get("principal_id", "unknown"),
            principal_name=data.get("principal_name", "unknown"),
            device_id=data.get("device_id"),
            is_admin=data.get("is_admin", False),
            permissions=frozenset(data.get("permissions", [])),
            effective_perms=frozenset(data.get("effective_perms", [])),
            source=source,
        )

    def build_identity_for_api_key(self) -> Identity:
        """Return SYSTEM identity for API key auth."""
        return SYSTEM

    # ── System token ─────────────────────────────────────────────────

    async def get_system_token(self) -> str | None:
        """Get or create a system token.

        The system token is used for inter-service auth (e.g. mesh pairing).
        We request it via Auth.Login with system credentials.
        For now, return None — the RTCClient handles the no-token case.
        """
        log_debug("BusAuthProxy.get_system_token() — system token not needed in bus mode")
        return None

    # ── Principal lookup ─────────────────────────────────────────────

    async def get_principal(self, principal_id: str) -> _UserProxy | None:
        """Look up a principal via Auth.GetPrincipal bus call."""
        try:
            from app.shared.contracts.models.auth import PrincipalGetRequest

            resp = await self._bus.request(
                "Auth.GetPrincipal",
                PrincipalGetRequest(user_id=principal_id),
                timeout=5.0,
            )

            data = self._unwrap(resp)
            if not data or data.get("error"):
                return None

            return _UserProxy(
                id=data.get("id", principal_id),
                username=data.get("username", "unknown"),
                permissions=list(data.get("permissions", [])),
                is_admin=data.get("is_admin", False),
                created_at=data.get("created_at"),
            )
        except Exception as e:
            log_warning(f"BusAuthProxy.get_principal failed: {e}")
            return None

    # ── Permission defaults (no-op in proxy mode) ────────────────────

    def update_permission_defaults(self, defaults: list[str]) -> None:
        """No-op — permission defaults are managed by AuthService directly."""
        pass

    # ── Mesh credential passthrough (for backward compat) ────────────

    async def save_mesh_credential(self, **kwargs: Any) -> bool:
        try:
            from app.shared.contracts.models.auth import MeshCredentialSaveRequest

            resp = await self._bus.request(
                "Auth.SaveMeshCredential",
                MeshCredentialSaveRequest(**kwargs),
                timeout=5.0,
            )
            data = self._unwrap(resp)
            return bool(data and data.get("success", False))
        except Exception:
            return False

    async def load_mesh_credential(self, room_name: str) -> str | None:
        try:
            from app.shared.contracts.models.auth import MeshCredentialLoadRequest

            resp = await self._bus.request(
                "Auth.LoadMeshCredential",
                MeshCredentialLoadRequest(room_name=room_name),
                timeout=5.0,
            )
            data = self._unwrap(resp)
            return data.get("token") if data else None
        except Exception:
            return None

    # ── Per-peer mesh credential methods (Fix 3) ─────────────────────

    async def upsert_mesh_peer(
        self,
        peer_id: str,
        room_name: str,
        node_name: str = "",
        ip: str | None = None,
        port: int | None = None,
    ) -> bool:
        """Ensure a mesh_peers row exists for the given peer."""
        try:
            from app.shared.contracts.models.mesh import MeshPeerUpsertRequest

            resp = await self._bus.request(
                "Auth.MeshUpsertPeer",
                MeshPeerUpsertRequest(
                    peer_id=peer_id,
                    room_name=room_name,
                    node_name=node_name,
                    ip=ip,
                    port=port,
                ),
                timeout=5.0,
            )
            data = self._unwrap(resp)
            return bool(data and data.get("success", False))
        except Exception as exc:
            log_warning(f"BusAuthProxy.upsert_mesh_peer failed: {exc}")
            return False

    async def save_inbound_credential(
        self,
        remote_peer_id: str,
        room_name: str,
        token: str,
        permissions: list[str] | None = None,
        remote_device_id: str | None = None,
        remote_user_id: str | None = None,
        remote_node_name: str | None = None,
    ) -> bool:
        """Save an inbound pairing credential for a specific remote peer."""
        try:
            from app.shared.contracts.models.mesh import MeshPeerSaveInboundRequest

            resp = await self._bus.request(
                "Auth.MeshSaveInboundCredential",
                MeshPeerSaveInboundRequest(
                    remote_peer_id=remote_peer_id,
                    room_name=room_name,
                    token=token,
                    permissions=permissions or [],
                    remote_device_id=remote_device_id,
                    remote_user_id=remote_user_id,
                    remote_node_name=remote_node_name,
                ),
                timeout=5.0,
            )
            data = self._unwrap(resp)
            return bool(data and data.get("success", False))
        except Exception as exc:
            log_warning(f"BusAuthProxy.save_inbound_credential failed: {exc}")
            return False

    async def load_inbound_credentials(self, room_name: str) -> dict[str, str]:
        """Load all inbound credentials for a room, keyed by remote peer_id."""
        try:
            from app.shared.contracts.models.mesh import MeshPeerLoadInboundRequest

            resp = await self._bus.request(
                "Auth.MeshLoadInboundCredentials",
                MeshPeerLoadInboundRequest(room_name=room_name),
                timeout=5.0,
            )
            data = self._unwrap(resp)
            return data.get("credentials", {}) if data else {}
        except Exception as exc:
            log_warning(f"BusAuthProxy.load_inbound_credentials failed: {exc}")
            return {}

    async def update_peer_connection_status(
        self, peer_id: str, room_name: str, status: str
    ) -> bool:
        """Update the connection_status of a mesh peer."""
        try:
            from app.shared.contracts.models.mesh import MeshPeerUpdateConnectionRequest

            resp = await self._bus.request(
                "Auth.MeshUpdatePeerConnection",
                MeshPeerUpdateConnectionRequest(
                    peer_id=peer_id,
                    room_name=room_name,
                    connection_status=status,
                ),
                timeout=5.0,
            )
            data = self._unwrap(resp)
            return bool(data and data.get("success", False))
        except Exception as exc:
            log_warning(f"BusAuthProxy.update_peer_connection_status failed: {exc}")
            return False
