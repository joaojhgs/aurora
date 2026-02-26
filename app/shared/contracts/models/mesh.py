"""Pydantic models for mesh peer management contracts.

Contains request/response models for all Mesh method contracts.
These live in ``app.shared`` so any service can import them without
violating the "no cross-service imports" rule.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.shared.auth.permissions import Permission

# ── Peer Info (returned by queries) ──────────────────────────────────────


class MeshPeerInfo(BaseModel):
    """Full peer state as seen from this instance."""

    id: str
    peer_id: str
    node_name: str = ""
    room_name: str = ""
    ip: str | None = None
    port: int | None = None

    # Outbound: what WE granted to THEM
    outbound_status: str = "pending"  # pending | approved | denied
    outbound_permissions: list[Permission] = []
    outbound_approved_at: str | None = None
    outbound_approved_by: str | None = None

    # Inbound: what THEY granted to US
    inbound_status: str = "unknown"  # unknown | pending | approved | denied
    inbound_permissions: list[Permission] = []
    inbound_approved_at: str | None = None

    # Connection state
    connection_status: str = "disconnected"  # connected | disconnected
    first_seen_at: str = ""
    last_seen_at: str | None = None
    last_status_change_at: str = ""


# ── Identity (this instance's stable peer_id) ───────────────────────────


class MeshIdentityLoadRequest(BaseModel):
    """Load this instance's stable mesh identity. No params — always loads 'self'."""

    pass


class MeshIdentityLoadResponse(BaseModel):
    """Response carrying this instance's identity."""

    peer_id: str | None = None
    node_name: str = ""


class MeshIdentitySaveRequest(BaseModel):
    """Save (or overwrite) this instance's stable mesh identity."""

    peer_id: str
    node_name: str = ""


# ── List Peers ───────────────────────────────────────────────────────────


class MeshPeerListRequest(BaseModel):
    """Request to list known mesh peers with optional filters."""

    room_name: str | None = None
    outbound_status: str | None = None  # pending, approved, denied
    include_disconnected: bool = True


class MeshPeerListResponse(BaseModel):
    """List of known mesh peers."""

    peers: list[MeshPeerInfo] = []
    total: int = 0


# ── Get Single Peer ──────────────────────────────────────────────────────


class MeshPeerGetRequest(BaseModel):
    """Request to get a single mesh peer by peer_id."""

    peer_id: str
    room_name: str | None = None


class MeshPeerGetResponse(BaseModel):
    """Response carrying a single peer's full state."""

    peer: MeshPeerInfo | None = None


# ── Approve Peer (set outbound to approved + permissions) ────────────────


class MeshPeerApproveRequest(BaseModel):
    """Approve a pending peer and set the permissions we grant to them."""

    peer_id: str
    permissions: list[Permission]
    approved_by: str | None = None


# ── Deny Peer ────────────────────────────────────────────────────────────


class MeshPeerDenyRequest(BaseModel):
    """Deny a pending peer."""

    peer_id: str


# ── Update Permissions ───────────────────────────────────────────────────


class MeshPeerUpdatePermissionsRequest(BaseModel):
    """Update outbound permissions for an already-approved peer.

    Replaces the entire permission set.
    """

    peer_id: str
    permissions: list[Permission]


# ── Remove Peer ──────────────────────────────────────────────────────────


class MeshPeerRemoveRequest(BaseModel):
    """Remove a peer record and optionally revoke the token we issued."""

    peer_id: str
    revoke_token: bool = True


# ── Save/Load Inbound Credential (used internally by pairing flow) ──────


class MeshPeerSaveInboundRequest(BaseModel):
    """Save the token a remote peer issued to US."""

    remote_peer_id: str
    room_name: str
    token: str
    permissions: list[Permission] = []
    remote_device_id: str | None = None
    remote_user_id: str | None = None
    remote_node_name: str | None = None


class MeshPeerLoadInboundRequest(BaseModel):
    """Load saved inbound tokens for reconnection."""

    room_name: str
    remote_peer_id: str | None = None  # None = all peers in room


class MeshPeerLoadInboundResponse(BaseModel):
    """Map of remote_peer_id → inbound_token."""

    credentials: dict[str, str] = {}  # peer_id → token


# ── Upsert Peer Record (create or update on discovery) ──────────────────


class MeshPeerUpsertRequest(BaseModel):
    """Upsert a peer row on peer discovery (presence received)."""

    peer_id: str
    room_name: str
    node_name: str = ""
    ip: str | None = None
    port: int | None = None


# ── Update Connection Status ─────────────────────────────────────────────


class MeshPeerUpdateConnectionRequest(BaseModel):
    """Update a peer's connection_status (connected/disconnected)."""

    peer_id: str
    connection_status: str  # connected | disconnected


# ── Events (bus-only, not request/response) ──────────────────────────────


class MeshPeerApprovedEvent(BaseModel):
    """Published when a local admin approves a pending peer."""

    peer_id: str
    permissions: list[Permission]


class MeshPeerPermissionsUpdatedEvent(BaseModel):
    """Published when a local admin changes a peer's outbound permissions."""

    peer_id: str
    permissions: list[Permission]


class PairingRequestedEvent(BaseModel):
    """Published when a remote peer initiates pairing on our auth service."""

    code: str
    remote_peer_id: str = ""
    remote_node_name: str = ""
    device_name: str = ""
    client_ip: str = ""
    expires_at: str = ""


# ── Generic boolean response ─────────────────────────────────────────────


class MeshBoolResponse(BaseModel):
    """Simple success/failure response for mesh operations."""

    success: bool = True
    message: str = ""
