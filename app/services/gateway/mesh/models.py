"""Pydantic models for the P2P mesh network.

Defines data structures for:
- Peer service capabilities (PeerServiceInfo)
- Peer capability manifests (PeerManifest)
- Runtime peer state (PeerState)
- Routing decisions (RouteDecision)
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.shared.contracts.models.gateway import MethodInfo


class PeerServiceInfo(BaseModel):
    """A service offered by a remote peer.

    Attributes:
        module: Service module name (e.g., "TTS", "Orchestrator")
        version: Semantic version string (e.g., "1.0.0")
        capabilities: Feature flags (e.g., ["streaming", "multilingual"])
        methods: Available methods with schemas
        max_concurrent: Max concurrent calls the peer will accept
        digest: SHA-256 of the serialized contract for quick equality checks
    """

    module: str
    version: str = "0.0.0"
    capabilities: list[str] = Field(default_factory=list)
    methods: list[MethodInfo] = Field(default_factory=list)
    max_concurrent: int = 10
    digest: str = ""


class PeerManifest(BaseModel):
    """Complete capability manifest sent during negotiation.

    Each peer sends its manifest after mutual authentication.
    The manifest describes which services the peer is willing to share.

    Attributes:
        peer_id: Unique peer identifier
        node_name: Human-readable name for the peer node
        aurora_version: Aurora version for broad compatibility checking
        shared_services: Services this peer is sharing with the network
        timestamp: ISO timestamp of manifest generation
    """

    peer_id: str
    node_name: str = ""
    aurora_version: str = ""
    shared_services: list[PeerServiceInfo] = Field(default_factory=list)
    timestamp: str = ""


class ManifestAck(BaseModel):
    """Acknowledgment of a received manifest with compatibility report.

    Sent after receiving a peer's manifest to inform them which
    of their shared services we find compatible and intend to use.

    Attributes:
        compatible_services: Modules we can and want to use
        incompatible_services: Modules that failed version/capability checks
        unused_services: Modules we don't need (no routing config for them)
    """

    compatible_services: list[str] = Field(default_factory=list)
    incompatible_services: list[str] = Field(default_factory=list)
    unused_services: list[str] = Field(default_factory=list)


class PeerState(BaseModel):
    """Runtime state of a connected peer in the mesh.

    Maintained by PeerRegistry, updated as peers authenticate,
    exchange manifests, and respond to pings.

    Attributes:
        peer_id: Unique peer identifier
        node_name: Human-readable name
        manifest: Their shared services manifest
        latency_ms: Last measured round-trip time in ms
        last_ping: Unix timestamp of last successful ping
        last_manifest: Unix timestamp of last manifest update
        active_calls: Current in-flight calls to this peer
        status: Current peer lifecycle status
    """

    peer_id: str
    node_name: str = ""
    manifest: PeerManifest | None = None
    latency_ms: float = float("inf")
    last_ping: float = 0.0
    last_manifest: float = 0.0
    active_calls: int = 0
    status: str = "connected"  # "connected" | "authenticated" | "negotiated" | "stale"
    # Compatibility report from manifest ACK (what the remote peer thinks of OUR services)
    remote_compatible: list[str] = Field(default_factory=list)
    remote_incompatible: list[str] = Field(default_factory=list)
    remote_unused: list[str] = Field(default_factory=list)

    model_config = ConfigDict(arbitrary_types_allowed=True)


class RouteDecision(BaseModel):
    """Result of a routing table lookup.

    Tells the MeshBus whether to deliver a message locally or remotely.

    Attributes:
        target: "local" or "remote"
        peer_id: Target peer ID (only if target == "remote")
        module: Service module name
        version: Remote service version (only if remote)
        latency_ms: Expected latency (only if remote)
    """

    target: str  # "local" | "remote"
    peer_id: str | None = None
    module: str = ""
    version: str = ""
    latency_ms: float = 0.0


class CapacityUpdate(BaseModel):
    """Notification of capacity change sent between peers.

    When a peer's available capacity changes significantly,
    it can notify connected peers to update their routing tables.

    Attributes:
        module: Service module name
        available: Current available capacity
        max_concurrent: Total max concurrent calls
    """

    module: str
    available: int = 0
    max_concurrent: int = 10
