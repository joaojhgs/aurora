"""Contract IO models for the Auth service.

Contains Pydantic request/response models for all Auth method contracts
(login, pairing, principals, tokens, devices, audit). Mesh identity and peer
management models live in ``app.shared.contracts.models.mesh``.
These live in ``app.shared`` so any service can import them without
violating the "no cross-service imports" rule.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field

from app.shared.auth.permissions import Permission

# =============================================================================
# Module Identifiers
# =============================================================================


class AuthModule:
    """Module identifier for Auth service."""

    NAME = "Auth"


# =============================================================================
# Method Identifiers
# =============================================================================


class AuthMethods:
    """Full method identifiers for Auth service."""

    # Login / Session
    LOGIN = f"{AuthModule.NAME}.Login"
    LOGOUT = f"{AuthModule.NAME}.Logout"
    VALIDATE_TOKEN = f"{AuthModule.NAME}.ValidateToken"
    VERIFY_MESH_RECONNECT_PROOF = f"{AuthModule.NAME}.VerifyMeshReconnectProof"
    VALIDATE_MESH_PAIRING_TOKEN = f"{AuthModule.NAME}.ValidateMeshPairingToken"
    REFRESH_TOKEN = f"{AuthModule.NAME}.RefreshToken"
    WHO_AM_I = f"{AuthModule.NAME}.WhoAmI"

    # Pairing
    PAIRING_START = f"{AuthModule.NAME}.PairingStart"
    PAIRING_CONNECT = f"{AuthModule.NAME}.PairingConnect"
    PAIRING_APPROVE = f"{AuthModule.NAME}.PairingApprove"
    PAIRING_DENY = f"{AuthModule.NAME}.PairingDeny"
    PAIRING_EXCHANGE = f"{AuthModule.NAME}.PairingExchange"
    LIST_PENDING_PAIRINGS = f"{AuthModule.NAME}.ListPendingPairings"
    PAIRING_READY = f"{AuthModule.NAME}.PairingReady"

    # Principal management
    LIST_PRINCIPALS = f"{AuthModule.NAME}.ListPrincipals"
    CREATE_PRINCIPAL = f"{AuthModule.NAME}.CreatePrincipal"
    GET_PRINCIPAL = f"{AuthModule.NAME}.GetPrincipal"
    UPDATE_PRINCIPAL = f"{AuthModule.NAME}.UpdatePrincipal"
    DELETE_PRINCIPAL = f"{AuthModule.NAME}.DeletePrincipal"
    SET_PERMISSIONS = f"{AuthModule.NAME}.SetPermissions"
    PATCH_PERMISSIONS = f"{AuthModule.NAME}.PatchPermissions"
    CHANGE_PASSWORD = f"{AuthModule.NAME}.ChangePassword"

    # Token management
    LIST_TOKENS = f"{AuthModule.NAME}.ListTokens"
    CREATE_TOKEN = f"{AuthModule.NAME}.CreateToken"
    UPDATE_TOKEN_SCOPES = f"{AuthModule.NAME}.UpdateTokenScopes"
    REVOKE_TOKEN = f"{AuthModule.NAME}.RevokeToken"

    # Device management
    LIST_DEVICES = f"{AuthModule.NAME}.ListDevices"
    DELETE_DEVICE = f"{AuthModule.NAME}.DeleteDevice"

    # Audit
    AUDIT_LOG = f"{AuthModule.NAME}.AuditLog"
    STORE_AUDIT_EVENT = f"{AuthModule.NAME}.StoreAuditEvent"

    # Events (broadcast, not request/response)
    PAIRING_REQUESTED = f"{AuthModule.NAME}.PairingRequested"
    PAIRING_APPROVED = f"{AuthModule.NAME}.PairingApproved"
    PAIRING_DENIED = f"{AuthModule.NAME}.PairingDenied"
    PAIRING_EXPIRED = f"{AuthModule.NAME}.PairingExpired"
    PAIRING_EXCHANGED = f"{AuthModule.NAME}.PairingExchanged"

    # Mesh credential storage
    SAVE_MESH_CREDENTIAL = f"{AuthModule.NAME}.SaveMeshCredential"
    LOAD_MESH_CREDENTIAL = f"{AuthModule.NAME}.LoadMeshCredential"
    DELETE_MESH_CREDENTIAL = f"{AuthModule.NAME}.DeleteMeshCredential"
    LOAD_MESH_IDENTITY = f"{AuthModule.NAME}.LoadMeshIdentity"
    SAVE_MESH_IDENTITY = f"{AuthModule.NAME}.SaveMeshIdentity"

    # Mesh peer management
    MESH_UPSERT_PEER = f"{AuthModule.NAME}.MeshUpsertPeer"
    MESH_LIST_PEERS = f"{AuthModule.NAME}.MeshListPeers"
    MESH_GET_PEER = f"{AuthModule.NAME}.MeshGetPeer"
    MESH_GET_AUTHORITY_SNAPSHOT = f"{AuthModule.NAME}.MeshGetAuthoritySnapshot"
    MESH_APPROVE_PEER = f"{AuthModule.NAME}.MeshApprovePeer"
    MESH_DENY_PEER = f"{AuthModule.NAME}.MeshDenyPeer"
    MESH_UPDATE_PEER_PERMISSIONS = f"{AuthModule.NAME}.MeshUpdatePeerPermissions"
    MESH_REMOVE_PEER = f"{AuthModule.NAME}.MeshRemovePeer"
    MESH_SAVE_INBOUND_CREDENTIAL = f"{AuthModule.NAME}.MeshSaveInboundCredential"
    MESH_LOAD_INBOUND_CREDENTIALS = f"{AuthModule.NAME}.MeshLoadInboundCredentials"
    MESH_UPDATE_PEER_CONNECTION = f"{AuthModule.NAME}.MeshUpdatePeerConnection"


# ── Login / Logout ───────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user_id: str
    username: str
    permissions: list[Permission]
    is_admin: bool
    expires_at: str | None = None


class LogoutRequest(BaseModel):
    token: str


class LogoutResponse(BaseModel):
    success: bool


# ── Token Validation ─────────────────────────────────────────────────────


class ValidateTokenRequest(BaseModel):
    token: str


class ValidateTokenResponse(BaseModel):
    valid: bool
    principal_id: str | None = None
    principal_name: str | None = None
    is_admin: bool = False
    permissions: list[Permission] = Field(default_factory=list)
    effective_perms: list[Permission] = Field(default_factory=list)
    device_id: str | None = None
    source: str = "unknown"


# ── Mesh reconnect proof ─────────────────────────────────────────────────


class MeshReconnectProofRequest(BaseModel):
    """Prove possession of a previously issued mesh bearer without sending it.

    ``challenge`` must be freshly generated by the verifier for the current
    connection. ``channel_binding`` identifies the exact WebRTC transcript.
    The stable peer identities and room prevent a valid proof from being moved
    to another peer relationship.
    """

    token_id: str = Field(min_length=1, max_length=128)
    challenge: str = Field(pattern=r"^[0-9a-f]{64}$")
    proof: str = Field(pattern=r"^[0-9a-f]{64}$")
    channel_binding: str = Field(pattern=r"^[0-9a-f]{64}$")
    claimant_peer_id: str = Field(min_length=1, max_length=256)
    verifier_peer_id: str = Field(min_length=1, max_length=256)
    room_name: str = Field(min_length=1, max_length=512)


class MeshReconnectProofResponse(ValidateTokenResponse):
    """Resolved identity when a reconnect proof is valid.

    Deliberately contains neither the bearer token nor its hash/key material.
    """


class MeshPairingTokenValidationRequest(BaseModel):
    """Validate the exact bearer minted by one bilateral pairing session."""

    token: str = Field(min_length=1, max_length=4096)
    pairing_session_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    claimant_peer_id: str = Field(min_length=1, max_length=256)
    room_name: str = Field(min_length=1, max_length=512)


class MeshPairingTokenValidationResponse(ValidateTokenResponse):
    """Identity resolved from the one token minted for the named session."""


_MESH_RECONNECT_PROOF_DOMAIN = b"aurora.mesh.reconnect-proof.v1\x00"


def build_mesh_reconnect_proof_message(
    *,
    token_id: str,
    challenge: str,
    channel_binding: str,
    claimant_peer_id: str,
    verifier_peer_id: str,
    room_name: str,
) -> bytes:
    """Return the canonical, domain-separated bytes covered by reconnect HMAC.

    The HMAC key is ``SHA256(raw_bearer_token)`` as bytes (equivalently,
    ``bytes.fromhex(tokens.token_hash)`` on the issuer). Keeping canonicalization
    in the shared contract prevents client/server transcript drift.
    """

    transcript = {
        "challenge": challenge,
        "channel_binding": channel_binding,
        "claimant_peer_id": claimant_peer_id,
        "room_name": room_name,
        "token_id": token_id,
        "verifier_peer_id": verifier_peer_id,
        "version": 1,
    }
    canonical = json.dumps(
        transcript,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return _MESH_RECONNECT_PROOF_DOMAIN + canonical


# ── Token Refresh ────────────────────────────────────────────────────────


class TokenRefreshRequest(BaseModel):
    token: str


class TokenRefreshResponse(BaseModel):
    token: str
    expires_at: str | None = None


# ── WhoAmI ───────────────────────────────────────────────────────────────


class WhoAmIRequest(BaseModel):
    """Empty request — identity is derived from envelope.principal_id."""

    pass


class WhoAmIResponse(BaseModel):
    principal_id: str
    principal_name: str
    device_id: str | None = None
    is_admin: bool
    permissions: list[Permission]
    effective_perms: list[Permission]
    source: str


# ── Pairing ──────────────────────────────────────────────────────────────


class PairingStartRequest(BaseModel):
    device_name: str
    client_ip: str = "unknown"
    remote_peer_id: str = ""  # Mesh peer's stable peer_id (for linking)
    remote_node_name: str = ""  # Mesh peer's human-readable name
    room_name: str = ""  # Transport-bound mesh room used for durable linkage
    # Mesh v2 values are derived by both WebRTC endpoints from the same
    # commit/reveal transcript.  RPCHandler replaces caller-provided values
    # with the transport-bound local result before dispatching this contract.
    pairing_session_id: str = ""
    verification_code: str = ""


class PairingStartResponse(BaseModel):
    # Opaque bearer handle used by Connect / Approve / Exchange.  It must never
    # be presented as the human verification value.
    code: str
    expires_in_seconds: int
    pairing_session_id: str = ""
    verification_code: str = ""


class PairingConnectRequest(BaseModel):
    code: str
    pairing_session_id: str = ""


class PairingConnectResponse(BaseModel):
    request_id: str
    device_name: str
    status: str
    pairing_session_id: str = ""
    verification_code: str = ""


class PairingApproveRequest(BaseModel):
    code: str
    permissions: list[Permission] | None = None
    is_admin: bool = False


class PairingApproveResponse(BaseModel):
    success: bool


class PairingDenyRequest(BaseModel):
    code: str
    reason: str = ""


class PairingDenyResponse(BaseModel):
    success: bool


class PairingExchangeRequest(BaseModel):
    code: str
    pairing_session_id: str = ""


class PairingExchangeResponse(BaseModel):
    token: str
    device_id: str
    user_id: str
    permissions: list[Permission] = Field(default_factory=list)
    token_id: str = ""  # Internal token row ID (for mesh_peers FK)
    peer_id: str = ""  # Stable mesh peer_id of the issuer, when available
    node_name: str = ""  # Human-readable mesh node name of the issuer


class PendingPairingEntry(BaseModel):
    request_id: str
    code: str
    device_name: str
    client_ip: str
    status: str
    expires_at: str
    created_at: str = ""
    remote_peer_id: str = ""
    remote_node_name: str = ""
    approved_by: str | None = None
    denied_by: str | None = None
    denied_reason: str = ""
    granted_permissions: list[Permission] = Field(default_factory=list)
    granted_is_admin: bool = False
    pairing_session_id: str = ""
    verification_code: str = ""


class ListPendingPairingsRequest(BaseModel):
    include_non_pending: bool = False


class ListPendingPairingsResponse(BaseModel):
    pairings: list[PendingPairingEntry] = Field(default_factory=list)
    total: int = 0
    expired_count: int = 0
    secrets_redacted: bool = True


class PairingLifecycleEvent(BaseModel):
    request_id: str
    event_type: str
    status: str
    code_sha256: str = ""
    remote_peer_id: str = ""
    remote_node_name: str = ""
    device_name: str = ""
    client_ip: str = ""
    expires_at: str = ""
    actor_principal_id: str | None = None
    reason: str = ""


# ── Principal CRUD ───────────────────────────────────────────────────────


class PrincipalCreateRequest(BaseModel):
    username: str
    password: str | None = None
    permissions: list[Permission] | None = None
    is_admin: bool = False


class PrincipalResponse(BaseModel):
    id: str
    username: str
    permissions: list[Permission]
    is_admin: bool
    created_at: str | None = None


class PrincipalListRequest(BaseModel):
    """Empty request to list principals."""

    pass


class PrincipalGetRequest(BaseModel):
    user_id: str


class PrincipalUpdateRequest(BaseModel):
    user_id: str
    username: str | None = None
    password: str | None = None
    is_admin: bool | None = None


class PrincipalDeleteRequest(BaseModel):
    user_id: str


class PrincipalDeleteResponse(BaseModel):
    success: bool


class PrincipalListResponse(BaseModel):
    principals: list[PrincipalResponse]


# Alias for contract output (same shape as PrincipalResponse)
PrincipalCreateResponse = PrincipalResponse
PrincipalGetResponse = PrincipalResponse
PrincipalUpdateResponse = PrincipalResponse


# ── Permissions ──────────────────────────────────────────────────────────


class PermissionSetRequest(BaseModel):
    user_id: str
    permissions: list[Permission]


class PermissionSetResponse(BaseModel):
    success: bool


class PermissionPatchRequest(BaseModel):
    user_id: str
    grant: list[Permission] | None = None
    revoke: list[Permission] | None = None


class PermissionPatchResponse(BaseModel):
    success: bool


# ── Password ─────────────────────────────────────────────────────────────


class PasswordChangeRequest(BaseModel):
    user_id: str
    old_password: str
    new_password: str


class PasswordChangeResponse(BaseModel):
    success: bool


# ── Token CRUD ───────────────────────────────────────────────────────────


class TokenCreateRequest(BaseModel):
    principal_id: str
    device_id: str | None = None
    scopes: list[Permission] | None = None
    expires_in_days: int = 365


class TokenCreateResponse(BaseModel):
    token: str
    id: str
    prefix: str
    scopes: list[Permission]
    expires_at: str | None = None


class TokenListRequest(BaseModel):
    principal_id: str | None = None
    device_id: str | None = None


class TokenResponse(BaseModel):
    id: str
    prefix: str
    device_id: str | None = None
    user_id: str | None = None
    scopes: list[Permission]
    created_at: str | None = None
    expires_at: str | None = None


class TokenListResponse(BaseModel):
    tokens: list[TokenResponse]


class TokenScopeUpdateRequest(BaseModel):
    token_id: str
    scopes: list[Permission]


class TokenScopeUpdateResponse(BaseModel):
    success: bool


class TokenRevokeRequest(BaseModel):
    token_id: str


class TokenRevokeResponse(BaseModel):
    success: bool


# ── Devices ──────────────────────────────────────────────────────────────


class DeviceListRequest(BaseModel):
    principal_id: str | None = None


class DeviceResponse(BaseModel):
    id: str
    user_id: str | None = None
    name: str
    is_trusted: bool
    created_at: str | None = None
    last_seen: str | None = None


class DeviceListResponse(BaseModel):
    devices: list[DeviceResponse]


class DeviceDeleteRequest(BaseModel):
    device_id: str


class DeviceDeleteResponse(BaseModel):
    success: bool


# ── Audit ────────────────────────────────────────────────────────────────


class StoreAuditEventRequest(BaseModel):
    """Request to store a single audit event."""

    event: str
    principal_id: str | None = None
    details: str | None = None
    ip_address: str | None = None


class AuditLogRequest(BaseModel):
    limit: int = 50
    offset: int = 0
    principal_id: str | None = None
    event: str | None = None
    correlation_id: str | None = None
    peer_id: str | None = None
    provider_id: str | None = None
    tool_id: str | None = None
    action: str | None = None
    policy_decision_id: str | None = None
    route: str | None = None


class AuditLogResponse(BaseModel):
    events: list[dict[str, Any]]
    total: int


# ── Mesh Credentials ────────────────────────────────────────────────────


class MeshCredentialSaveRequest(BaseModel):
    room_name: str
    token: str
    remote_device_id: str | None = None
    remote_user_id: str | None = None


class MeshCredentialSaveResponse(BaseModel):
    success: bool


class MeshCredentialLoadRequest(BaseModel):
    room_name: str


class MeshCredentialLoadResponse(BaseModel):
    token: str | None = None


class MeshCredentialDeleteRequest(BaseModel):
    room_name: str


class MeshCredentialDeleteResponse(BaseModel):
    success: bool
