"""Auth service — owns all authentication, authorization, and pairing state.

All methods are exposed as ``@method_contract`` so the RouteGenerator and
WebRTC RPC handler can reach them via the message bus without hand-crafted
FastAPI routes.
"""

from __future__ import annotations

from typing import Any

from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.messaging.bus import Envelope
from app.services.auth.auth_manager import AuthManager
from app.shared.auth.audit import audit_event
from app.shared.contracts.models.auth import (
    AuditLogRequest,
    AuditLogResponse,
    AuthMethods,
    DeviceDeleteRequest,
    DeviceDeleteResponse,
    DeviceListRequest,
    DeviceListResponse,
    DeviceResponse,
    LoginRequest,
    LoginResponse,
    LogoutRequest,
    LogoutResponse,
    MeshCredentialDeleteRequest,
    MeshCredentialDeleteResponse,
    MeshCredentialLoadRequest,
    MeshCredentialLoadResponse,
    MeshCredentialSaveRequest,
    MeshCredentialSaveResponse,
    PairingApproveRequest,
    PairingApproveResponse,
    PairingConnectRequest,
    PairingConnectResponse,
    PairingExchangeRequest,
    PairingExchangeResponse,
    PairingStartRequest,
    PairingStartResponse,
    PasswordChangeRequest,
    PasswordChangeResponse,
    PermissionPatchRequest,
    PermissionPatchResponse,
    PermissionSetRequest,
    PermissionSetResponse,
    PrincipalCreateRequest,
    PrincipalDeleteRequest,
    PrincipalDeleteResponse,
    PrincipalGetRequest,
    PrincipalListRequest,
    PrincipalListResponse,
    PrincipalResponse,
    PrincipalUpdateRequest,
    StoreAuditEventRequest,
    TokenCreateRequest,
    TokenCreateResponse,
    TokenListRequest,
    TokenListResponse,
    TokenRefreshRequest,
    TokenRefreshResponse,
    TokenResponse,
    TokenRevokeRequest,
    TokenRevokeResponse,
    TokenScopeUpdateRequest,
    TokenScopeUpdateResponse,
    ValidateTokenRequest,
    ValidateTokenResponse,
    WhoAmIRequest,
    WhoAmIResponse,
)
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.mesh import (
    MeshBoolResponse,
    MeshEvents,
    MeshIdentityLoadRequest,
    MeshIdentityLoadResponse,
    MeshIdentitySaveRequest,
    MeshPeerApprovedEvent,
    MeshPeerApproveRequest,
    MeshPeerDenyRequest,
    MeshPeerGetRequest,
    MeshPeerGetResponse,
    MeshPeerInfo,
    MeshPeerListRequest,
    MeshPeerListResponse,
    MeshPeerLoadInboundRequest,
    MeshPeerLoadInboundResponse,
    MeshPeerPermissionsUpdatedEvent,
    MeshPeerRemoveRequest,
    MeshPeerSaveInboundRequest,
    MeshPeerUpdateConnectionRequest,
    MeshPeerUpdatePermissionsRequest,
    MeshPeerUpsertRequest,
    PairingRequestedEvent,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


class AuthService(BaseService):
    """Standalone authentication service for Aurora."""

    def __init__(self) -> None:
        # Before BaseService.__init__: contract scan may access ``manager`` property,
        # which reads ``_manager`` — must exist or Python raises AttributeError.
        self._manager: AuthManager | None = None
        super().__init__(
            module="Auth",
            summary="Authentication, authorization, pairing, and principal management",
            capabilities=[
                "login",
                "logout",
                "validate_token",
                "refresh_token",
                "pairing",
                "principals",
                "permissions",
                "tokens",
                "devices",
                "audit",
                "mesh_credentials",
            ],
        )

    @property
    def manager(self) -> AuthManager:
        if self._manager is None:
            raise RuntimeError("AuthService not started — call start() first")
        return self._manager

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def on_start(self) -> None:
        self._manager = AuthManager(self.bus)
        await self._manager.initialize()

        # Load default device permissions from config (bus → ConfigService only).
        # Longer timeout: in process mode Config workers may not be ready immediately after depends_on.
        try:
            from app.shared.config.interface import ConfigAPI
            from app.shared.config.keys import ConfigKeys
            from app.shared.config.models import Auth as AuthConfigModel

            config = ConfigAPI()
            auth_cfg = await config.aget(
                ConfigKeys.services.auth, AuthConfigModel, config_timeout=20.0
            )
            default_perms = list(auth_cfg.default_pairing_permissions or [])
            if default_perms:
                self._manager.update_permission_defaults(default_perms)
        except Exception as e:
            log_warning(
                f"Could not load services.auth.default_pairing_permissions from ConfigService: {e}",
                exc_info=True,
            )

        log_info("Auth service started")

    async def on_stop(self) -> None:
        log_info("Auth service stopped")

    async def reload(self, config_section: str | None = None) -> None:
        if config_section in (None, "services", "services.auth"):
            try:
                from app.shared.config.interface import ConfigAPI
                from app.shared.config.keys import ConfigKeys
                from app.shared.config.models import Auth as AuthConfigModel

                config = ConfigAPI()
                auth_cfg = await config.aget(
                    ConfigKeys.services.auth, AuthConfigModel, config_timeout=20.0
                )
                default_perms = list(auth_cfg.default_pairing_permissions or [])
                if self._manager:
                    self._manager.invalidate_mesh_inbound_key_cache()
                    self._manager.update_permission_defaults(default_perms)
            except Exception as e:
                log_warning(
                    f"Auth reload: could not refresh permission defaults: {e}",
                    exc_info=True,
                )

    # ── Login / Logout ───────────────────────────────────────────────────

    @method_contract(
        method_id=AuthMethods.LOGIN,
        summary="Authenticate with username/password and receive a session token",
        input_model=LoginRequest,
        output_model=LoginResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_login(self, data: LoginRequest) -> LoginResponse | dict[str, str]:
        result = await self.manager.login(data.username, data.password)
        if not result:
            return {"error": "Invalid credentials"}

        token, token_str, user = result
        return LoginResponse(
            token=token_str,
            user_id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            expires_at=token.expires_at.isoformat() if token.expires_at else None,
        )

    @method_contract(
        method_id="Auth.Logout",
        summary="Revoke the current session token",
        input_model=LogoutRequest,
        output_model=LogoutResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_logout(self, data: LogoutRequest) -> LogoutResponse:
        token = await self.manager.authenticate_token(data.token)
        if token:
            await self.manager.revoke_token(token.id)
        return LogoutResponse(success=True)

    # ── Token Validation ─────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.ValidateToken",
        summary="Validate a bearer token and return the resolved identity",
        input_model=ValidateTokenRequest,
        output_model=ValidateTokenResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_validate_token(self, data: ValidateTokenRequest) -> ValidateTokenResponse:
        token = await self.manager.authenticate_token(data.token)
        if not token:
            return ValidateTokenResponse(valid=False)

        identity = await self.manager.build_identity_from_token(token)
        return ValidateTokenResponse(
            valid=True,
            principal_id=identity.principal_id,
            principal_name=identity.principal_name,
            is_admin=identity.is_admin,
            permissions=list(identity.permissions),
            effective_perms=list(identity.effective_perms),
            device_id=identity.device_id,
            source=identity.source,
        )

    # ── Token Refresh ────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.RefreshToken",
        summary="Refresh a token (revoke old, issue new with same scopes)",
        input_model=TokenRefreshRequest,
        output_model=TokenRefreshResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_refresh_token(
        self, data: TokenRefreshRequest
    ) -> TokenRefreshResponse | dict[str, str]:
        result = await self.manager.refresh_token(data.token)
        if not result:
            return {"error": "Invalid or expired token"}

        new_token, new_token_str = result
        return TokenRefreshResponse(
            token=new_token_str,
            expires_at=new_token.expires_at.isoformat() if new_token.expires_at else None,
        )

    # ── WhoAmI ───────────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.WhoAmI",
        summary="Get the identity of the authenticated principal",
        input_model=WhoAmIRequest,
        output_model=WhoAmIResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_whoami(
        self, data: WhoAmIRequest, envelope: Envelope | None = None
    ) -> WhoAmIResponse | dict[str, str]:
        """Return identity for the principal_id on the envelope."""
        pid = envelope.principal_id if envelope else None
        if not pid:
            return {"error": "No authenticated principal"}

        user = await self.manager.get_principal(pid)
        if not user:
            return {"error": "Principal not found"}

        return WhoAmIResponse(
            principal_id=user.id,
            principal_name=user.username,
            device_id=None,
            is_admin=user.is_admin,
            permissions=user.permissions or [],
            effective_perms=user.permissions or [],
            source="bus",
        )

    # ── Pairing ──────────────────────────────────────────────────────────

    @method_contract(
        method_id=AuthMethods.PAIRING_START,
        summary="Start a device pairing request (returns 6-digit code)",
        input_model=PairingStartRequest,
        output_model=PairingStartResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_pairing_start(
        self, data: PairingStartRequest
    ) -> PairingStartResponse | dict[str, str]:
        code = await self.manager.start_pairing(
            data.device_name,
            data.client_ip,
            remote_peer_id=data.remote_peer_id,
            remote_node_name=data.remote_node_name,
        )
        if not code:
            return {"error": "Rate limit exceeded"}
        return PairingStartResponse(code=code, expires_in_seconds=300)

    @method_contract(
        method_id=AuthMethods.PAIRING_CONNECT,
        summary="Check the status of a pairing request",
        input_model=PairingConnectRequest,
        output_model=PairingConnectResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_pairing_connect(
        self, data: PairingConnectRequest
    ) -> PairingConnectResponse | dict[str, str]:
        result = await self.manager.connect_pairing(data.code)
        if not result:
            return {"error": "Invalid or expired code"}
        return PairingConnectResponse(
            request_id=result["id"],
            device_name=result["device_name"],
            status=result["status"],
        )

    @method_contract(
        method_id="Auth.PairingApprove",
        summary="Approve a pairing request (requires auth.approve permission)",
        input_model=PairingApproveRequest,
        output_model=PairingApproveResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_pairing_approve(
        self, data: PairingApproveRequest, envelope: Envelope | None = None
    ) -> PairingApproveResponse:
        approver_id = envelope.principal_id if envelope else "system"
        success = await self.manager.approve_pairing(
            data.code,
            user_id=approver_id or "system",
            permissions=data.permissions,
            is_admin=data.is_admin,
        )
        return PairingApproveResponse(success=success)

    @method_contract(
        method_id=AuthMethods.PAIRING_EXCHANGE,
        summary="Exchange an approved pairing code for a token",
        input_model=PairingExchangeRequest,
        output_model=PairingExchangeResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_pairing_exchange(
        self, data: PairingExchangeRequest
    ) -> PairingExchangeResponse | dict[str, str]:
        result = await self.manager.exchange_pairing(data.code)
        if not result:
            return {"error": "Pairing not approved or expired"}
        return PairingExchangeResponse(
            token=result["token"],
            device_id=result["device_id"],
            user_id=result["user_id"],
            permissions=result.get("permissions", []),
            token_id=result.get("token_id", ""),
        )

    # ── Principal CRUD ───────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.ListPrincipals",
        summary="List all principals",
        input_model=PrincipalListRequest,
        output_model=PrincipalListResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_list_principals(self, data: PrincipalListRequest) -> PrincipalListResponse:
        users = await self.manager.list_principals()
        return PrincipalListResponse(
            principals=[
                PrincipalResponse(
                    id=u.id,
                    username=u.username,
                    permissions=u.permissions or [],
                    is_admin=u.is_admin,
                    created_at=u.created_at.isoformat() if u.created_at else None,
                )
                for u in users
            ]
        )

    @method_contract(
        method_id="Auth.CreatePrincipal",
        summary="Create a new principal (user or device account)",
        input_model=PrincipalCreateRequest,
        output_model=PrincipalResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_create_principal(
        self, data: PrincipalCreateRequest
    ) -> PrincipalResponse | dict[str, str]:
        user = await self.manager.create_principal(
            username=data.username,
            password=data.password,
            permissions=data.permissions,
            is_admin=data.is_admin,
        )
        if not user:
            return {"error": "Failed to create principal"}
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @method_contract(
        method_id="Auth.GetPrincipal",
        summary="Get a principal by ID",
        input_model=PrincipalGetRequest,
        output_model=PrincipalResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_get_principal(
        self, data: PrincipalGetRequest
    ) -> PrincipalResponse | dict[str, str]:
        user = await self.manager.get_principal(data.user_id)
        if not user:
            return {"error": "Principal not found"}
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @method_contract(
        method_id="Auth.UpdatePrincipal",
        summary="Update a principal's fields",
        input_model=PrincipalUpdateRequest,
        output_model=PrincipalResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_update_principal(
        self, data: PrincipalUpdateRequest
    ) -> PrincipalResponse | dict[str, str]:
        fields: dict[str, Any] = {}
        if data.username is not None:
            fields["username"] = data.username
        if data.password is not None:
            fields["password"] = data.password
        if data.is_admin is not None:
            fields["is_admin"] = data.is_admin

        user = await self.manager.update_principal(data.user_id, **fields)
        if not user:
            return {"error": "Principal not found"}
        return PrincipalResponse(
            id=user.id,
            username=user.username,
            permissions=user.permissions or [],
            is_admin=user.is_admin,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )

    @method_contract(
        method_id="Auth.DeletePrincipal",
        summary="Delete a principal (cascades to devices and tokens)",
        input_model=PrincipalDeleteRequest,
        output_model=PrincipalDeleteResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_delete_principal(
        self, data: PrincipalDeleteRequest
    ) -> PrincipalDeleteResponse:
        success = await self.manager.delete_principal(data.user_id)
        return PrincipalDeleteResponse(success=success)

    # ── Permissions ──────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.SetPermissions",
        summary="Set permissions for a principal (full replace)",
        input_model=PermissionSetRequest,
        output_model=PermissionSetResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_set_permissions(self, data: PermissionSetRequest) -> PermissionSetResponse:
        success = await self.manager.set_permissions(data.user_id, data.permissions)
        return PermissionSetResponse(success=success)

    @method_contract(
        method_id="Auth.PatchPermissions",
        summary="Add/remove specific permissions for a principal",
        input_model=PermissionPatchRequest,
        output_model=PermissionPatchResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_patch_permissions(
        self, data: PermissionPatchRequest
    ) -> PermissionPatchResponse:
        success = await self.manager.patch_permissions(
            data.user_id, grant=data.grant, revoke=data.revoke
        )
        return PermissionPatchResponse(success=success)

    # ── Password ─────────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.ChangePassword",
        summary="Change a principal's password",
        input_model=PasswordChangeRequest,
        output_model=PasswordChangeResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_change_password(self, data: PasswordChangeRequest) -> PasswordChangeResponse:
        success = await self.manager.change_password(
            data.user_id, data.old_password, data.new_password
        )
        return PasswordChangeResponse(success=success)

    # ── Token CRUD ───────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.ListTokens",
        summary="List tokens, optionally filtered by principal or device",
        input_model=TokenListRequest,
        output_model=TokenListResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_list_tokens(self, data: TokenListRequest) -> TokenListResponse:
        tokens = await self.manager.list_tokens(
            principal_id=data.principal_id, device_id=data.device_id
        )
        return TokenListResponse(
            tokens=[
                TokenResponse(
                    id=t.id,
                    prefix=t.prefix or "",
                    device_id=t.device_id,
                    user_id=t.user_id,
                    scopes=t.scopes or [],
                    created_at=t.created_at.isoformat() if t.created_at else None,
                    expires_at=t.expires_at.isoformat() if t.expires_at else None,
                )
                for t in tokens
            ]
        )

    @method_contract(
        method_id="Auth.CreateToken",
        summary="Create a token for a principal",
        input_model=TokenCreateRequest,
        output_model=TokenCreateResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_create_token(
        self, data: TokenCreateRequest
    ) -> TokenCreateResponse | dict[str, str]:
        try:
            result = await self.manager.create_token_for_principal(
                principal_id=data.principal_id,
                device_id=data.device_id,
                scopes=data.scopes,
                expires_in_days=data.expires_in_days,
            )
        except ValueError as e:
            return {"error": str(e)}

        if not result:
            return {"error": "Failed to create token"}

        token, token_str = result
        return TokenCreateResponse(
            token=token_str,
            id=token.id,
            prefix=token.prefix or "",
            scopes=token.scopes or [],
            expires_at=token.expires_at.isoformat() if token.expires_at else None,
        )

    @method_contract(
        method_id="Auth.UpdateTokenScopes",
        summary="Update token scopes",
        input_model=TokenScopeUpdateRequest,
        output_model=TokenScopeUpdateResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_update_token_scopes(
        self, data: TokenScopeUpdateRequest
    ) -> TokenScopeUpdateResponse | dict[str, str]:
        try:
            success = await self.manager.update_token_scopes(data.token_id, data.scopes)
        except ValueError as e:
            return {"error": str(e)}
        return TokenScopeUpdateResponse(success=success)

    @method_contract(
        method_id="Auth.RevokeToken",
        summary="Revoke a token",
        input_model=TokenRevokeRequest,
        output_model=TokenRevokeResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_revoke_token(self, data: TokenRevokeRequest) -> TokenRevokeResponse:
        success = await self.manager.revoke_token(data.token_id)
        return TokenRevokeResponse(success=success)

    # ── Devices ──────────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.ListDevices",
        summary="List devices, optionally filtered by principal",
        input_model=DeviceListRequest,
        output_model=DeviceListResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_list_devices(self, data: DeviceListRequest) -> DeviceListResponse:
        devices = await self.manager.list_devices(principal_id=data.principal_id)
        return DeviceListResponse(
            devices=[
                DeviceResponse(
                    id=d.id,
                    user_id=d.user_id,
                    name=d.name,
                    is_trusted=d.is_trusted,
                    created_at=d.created_at.isoformat() if d.created_at else None,
                    last_seen=d.last_seen.isoformat() if d.last_seen else None,
                )
                for d in devices
            ]
        )

    @method_contract(
        method_id="Auth.DeleteDevice",
        summary="Delete a device",
        input_model=DeviceDeleteRequest,
        output_model=DeviceDeleteResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_delete_device(self, data: DeviceDeleteRequest) -> DeviceDeleteResponse:
        success = await self.manager.delete_device(data.device_id)
        return DeviceDeleteResponse(success=success)

    # ── Audit ────────────────────────────────────────────────────────────

    @method_contract(
        method_id=AuthMethods.STORE_AUDIT_EVENT,
        summary="Store a single audit event",
        input_model=StoreAuditEventRequest,
        output_model=MeshBoolResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_store_audit_event(self, data: StoreAuditEventRequest) -> MeshBoolResponse:
        import uuid

        from app.shared.contracts.models.db import DBExecuteSQLRequest, DBMethods

        try:
            result = await self.bus.request(
                DBMethods.EXECUTE_SQL,
                DBExecuteSQLRequest(
                    sql="INSERT INTO audit_log (id, event, principal_id, details, ip_address) VALUES (?, ?, ?, ?, ?)",
                    params=[
                        str(uuid.uuid4()),
                        data.event,
                        data.principal_id,
                        data.details,
                        data.ip_address,
                    ],
                ),
                timeout=5.0,
            )
            return MeshBoolResponse(success=result.ok if hasattr(result, "ok") else True)
        except Exception as e:
            log_warning(f"Failed to store audit event: {e}")
            return MeshBoolResponse(success=False, message=str(e))

    @method_contract(
        method_id=AuthMethods.AUDIT_LOG,
        summary="Get audit log entries",
        input_model=AuditLogRequest,
        output_model=AuditLogResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_audit_log(self, data: AuditLogRequest) -> AuditLogResponse:
        events, total = await self.manager.get_audit_log(
            limit=data.limit,
            offset=data.offset,
            principal_id=data.principal_id,
            event=data.event,
            correlation_id=data.correlation_id,
            peer_id=data.peer_id,
            provider_id=data.provider_id,
            tool_id=data.tool_id,
            action=data.action,
            policy_decision_id=data.policy_decision_id,
            route=data.route,
        )
        return AuditLogResponse(events=events, total=total)

    # ── Mesh Credentials ─────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.SaveMeshCredential",
        summary="Save an outbound mesh token for a remote peer",
        input_model=MeshCredentialSaveRequest,
        output_model=MeshCredentialSaveResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_save_mesh_credential(
        self, data: MeshCredentialSaveRequest
    ) -> MeshCredentialSaveResponse:
        success = await self.manager.save_mesh_credential(
            room_name=data.room_name,
            token=data.token,
            remote_device_id=data.remote_device_id,
            remote_user_id=data.remote_user_id,
        )
        return MeshCredentialSaveResponse(success=success)

    @method_contract(
        method_id="Auth.LoadMeshCredential",
        summary="Load a previously saved mesh token for a room",
        input_model=MeshCredentialLoadRequest,
        output_model=MeshCredentialLoadResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_load_mesh_credential(
        self, data: MeshCredentialLoadRequest
    ) -> MeshCredentialLoadResponse:
        token = await self.manager.load_mesh_credential(data.room_name)
        return MeshCredentialLoadResponse(token=token)

    @method_contract(
        method_id="Auth.DeleteMeshCredential",
        summary="Delete a stored mesh credential",
        input_model=MeshCredentialDeleteRequest,
        output_model=MeshCredentialDeleteResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_delete_mesh_credential(
        self, data: MeshCredentialDeleteRequest
    ) -> MeshCredentialDeleteResponse:
        success = await self.manager.delete_mesh_credential(data.room_name)
        return MeshCredentialDeleteResponse(success=success)

    # ── Mesh Identity ────────────────────────────────────────────────────

    @method_contract(
        method_id="Auth.LoadMeshIdentity",
        summary="Load this instance's stable mesh identity",
        input_model=MeshIdentityLoadRequest,
        output_model=MeshIdentityLoadResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_load_mesh_identity(
        self, data: MeshIdentityLoadRequest
    ) -> MeshIdentityLoadResponse:
        result = await self.manager.load_mesh_identity()
        return MeshIdentityLoadResponse(
            peer_id=result.get("peer_id"),
            node_name=result.get("node_name", ""),
        )

    @method_contract(
        method_id="Auth.SaveMeshIdentity",
        summary="Save this instance's stable mesh identity",
        input_model=MeshIdentitySaveRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def handle_save_mesh_identity(self, data: MeshIdentitySaveRequest) -> EmptyOutput:
        await self.manager.save_mesh_identity(
            peer_id=data.peer_id,
            node_name=data.node_name,
        )
        return EmptyOutput()

    # ── Mesh Peer Management ─────────────────────────────────────────────

    @method_contract(
        method_id="Auth.MeshUpsertPeer",
        summary="Create or update a mesh peer record on discovery",
        input_model=MeshPeerUpsertRequest,
        output_model=MeshBoolResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_upsert_peer(self, data: MeshPeerUpsertRequest) -> MeshBoolResponse:
        try:
            await self.manager.upsert_mesh_peer(
                peer_id=data.peer_id,
                room_name=data.room_name,
                node_name=data.node_name,
                ip=data.ip,
                port=data.port,
            )
            return MeshBoolResponse(success=True)
        except Exception as e:
            log_error(f"Failed to upsert mesh peer: {e}", exc_info=True)
            return MeshBoolResponse(success=False, message=str(e))

    @method_contract(
        method_id="Auth.MeshListPeers",
        summary="List known mesh peers with optional filters",
        input_model=MeshPeerListRequest,
        output_model=MeshPeerListResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_list_peers(self, data: MeshPeerListRequest) -> MeshPeerListResponse:
        rows = await self.manager.list_mesh_peers(
            room_name=data.room_name,
            outbound_status=data.outbound_status,
            include_disconnected=data.include_disconnected,
        )
        peers = [MeshPeerInfo(**row) for row in rows]
        return MeshPeerListResponse(peers=peers, total=len(peers))

    @method_contract(
        method_id="Auth.MeshGetPeer",
        summary="Get a single mesh peer by peer_id",
        input_model=MeshPeerGetRequest,
        output_model=MeshPeerGetResponse,
        exposure="both",
        method_type="use",
    )
    async def handle_get_peer(self, data: MeshPeerGetRequest) -> MeshPeerGetResponse:
        row = await self.manager.get_mesh_peer(
            peer_id=data.peer_id,
            room_name=data.room_name,
        )
        if row:
            return MeshPeerGetResponse(peer=MeshPeerInfo(**row))
        return MeshPeerGetResponse(peer=None)

    @method_contract(
        method_id="Auth.MeshApprovePeer",
        summary="Approve a mesh peer with specific permissions",
        input_model=MeshPeerApproveRequest,
        output_model=MeshBoolResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_approve_peer(self, data: MeshPeerApproveRequest) -> MeshBoolResponse:
        # Get the approving user from envelope metadata if available
        approved_by = getattr(data, "_principal_id", None)

        success = await self.manager.approve_mesh_peer(
            peer_id=data.peer_id,
            permissions=data.permissions,
            approved_by=approved_by,
        )
        if success:
            # Publish approval event for mesh subsystem
            try:
                await self.bus.publish(
                    MeshEvents.PEER_APPROVED,
                    MeshPeerApprovedEvent(
                        peer_id=data.peer_id,
                        permissions=data.permissions,
                    ),
                    event=True,
                    origin="internal",
                )
            except Exception as e:
                log_warning(f"Failed to publish peer approval event: {e}")

            return MeshBoolResponse(success=True)
        return MeshBoolResponse(success=False, message=f"Peer {data.peer_id} not found")

    @method_contract(
        method_id="Auth.MeshDenyPeer",
        summary="Deny/block a mesh peer",
        input_model=MeshPeerDenyRequest,
        output_model=MeshBoolResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_deny_peer(self, data: MeshPeerDenyRequest) -> MeshBoolResponse:
        success = await self.manager.deny_mesh_peer(data.peer_id)
        if success:
            return MeshBoolResponse(success=True)
        return MeshBoolResponse(success=False, message=f"Peer {data.peer_id} not found")

    @method_contract(
        method_id="Auth.MeshUpdatePeerPermissions",
        summary="Update permissions for an approved mesh peer",
        input_model=MeshPeerUpdatePermissionsRequest,
        output_model=MeshBoolResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_update_peer_permissions(
        self, data: MeshPeerUpdatePermissionsRequest
    ) -> MeshBoolResponse:
        success = await self.manager.update_mesh_peer_permissions(
            peer_id=data.peer_id,
            permissions=data.permissions,
        )
        if success:
            # Manager already syncs to User.permissions + Token.scopes internally.
            # Publish permissions updated event for mesh subsystem.
            try:
                await self.bus.publish(
                    MeshEvents.PEER_PERMISSIONS_UPDATED,
                    MeshPeerPermissionsUpdatedEvent(
                        peer_id=data.peer_id,
                        permissions=data.permissions,
                    ),
                    event=True,
                    origin="internal",
                )
            except Exception as e:
                log_warning(f"Failed to publish permissions event: {e}")

            return MeshBoolResponse(success=True)
        return MeshBoolResponse(
            success=False, message=f"Peer {data.peer_id} not found or not approved"
        )

    @method_contract(
        method_id="Auth.MeshRemovePeer",
        summary="Remove a mesh peer record entirely",
        input_model=MeshPeerRemoveRequest,
        output_model=MeshBoolResponse,
        exposure="both",
        method_type="manage",
    )
    async def handle_remove_peer(self, data: MeshPeerRemoveRequest) -> MeshBoolResponse:
        # Optionally revoke associated token
        if data.revoke_token:
            peer = await self.manager.get_mesh_peer(data.peer_id)
            if peer and peer.get("outbound_token_id"):
                try:
                    await self.manager._revoke_token(peer["outbound_token_id"])
                except Exception as e:
                    log_warning(f"Failed to revoke peer token: {e}")

        success = await self.manager.remove_mesh_peer(data.peer_id)
        if success:
            return MeshBoolResponse(success=True)
        return MeshBoolResponse(success=False, message=f"Peer {data.peer_id} not found")

    @method_contract(
        method_id="Auth.MeshSaveInboundCredential",
        summary="Save the token a remote peer issued to us",
        input_model=MeshPeerSaveInboundRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def handle_save_inbound_credential(self, data: MeshPeerSaveInboundRequest) -> EmptyOutput:
        await self.manager.save_inbound_credential(
            remote_peer_id=data.remote_peer_id,
            room_name=data.room_name,
            token=data.token,
            permissions=data.permissions,
            remote_device_id=data.remote_device_id,
            remote_user_id=data.remote_user_id,
            remote_node_name=data.remote_node_name,
        )
        return EmptyOutput()

    @method_contract(
        method_id="Auth.MeshLoadInboundCredentials",
        summary="Load inbound tokens for reconnection",
        input_model=MeshPeerLoadInboundRequest,
        output_model=MeshPeerLoadInboundResponse,
        exposure="internal",
        method_type="use",
    )
    async def handle_load_inbound_credentials(
        self, data: MeshPeerLoadInboundRequest
    ) -> MeshPeerLoadInboundResponse:
        credentials = await self.manager.load_inbound_credentials(
            room_name=data.room_name,
            remote_peer_id=data.remote_peer_id,
        )
        return MeshPeerLoadInboundResponse(credentials=credentials)

    @method_contract(
        method_id="Auth.MeshUpdatePeerConnection",
        summary="Update connection status of a mesh peer",
        input_model=MeshPeerUpdateConnectionRequest,
        output_model=EmptyOutput,
        exposure="internal",
        method_type="use",
    )
    async def handle_update_peer_connection(
        self, data: MeshPeerUpdateConnectionRequest
    ) -> EmptyOutput:
        await self.manager.update_peer_connection_status(
            peer_id=data.peer_id,
            status=data.connection_status,
        )
        return EmptyOutput()
