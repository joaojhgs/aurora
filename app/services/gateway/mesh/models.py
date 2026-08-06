"""Pydantic models for the P2P mesh network.

Defines data structures for:
- Peer service capabilities (PeerServiceInfo)
- Peer capability manifests (PeerManifest)
- Runtime peer state (PeerState)
- Routing decisions (RouteDecision)
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.shared.contracts.mesh_compatibility import (
    MeshCompatibilityReasonCode,
    MeshServiceCompatibilityStatus,
)
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.speech import SpeechRouteBinding
from app.shared.contracts.registry import CallableFeatureContract


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
    callable_features: list[CallableFeatureContract] = Field(default_factory=list)
    available_feature_ids: list[str] = Field(default_factory=list)
    methods: list[MethodInfo] = Field(default_factory=list)
    max_concurrent: int = 10
    digest: str = ""


class ManifestGrantEvidence(BaseModel):
    """Strict canonical grant evidence carried only by future projection frames."""

    permission: str
    source: str = "effective"

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class RecipientProjectionEvidence(BaseModel):
    """Strict recipient-bound projection-v1 evidence.

    This object is not emitted by G006 Phase-2 effective manifests. It exists so
    receivers can classify future projection frames without silently accepting
    partial, downgraded, or recipient-smuggled authority evidence.
    """

    provider_peer_id: str
    recipient_peer_id: str
    registry_revision: str
    registry_digest: str
    policy_revision: str
    policy_digest: str
    auth_grant_revision: int = Field(ge=0)
    auth_grant_state: Literal["unknown", "pending", "active", "revoked"]
    auth_grant_digest: str
    grants_digest: str
    protocol_tier: Literal["projection-v1"]
    projection_digest: str
    evidence_digest: str
    grants: list[ManifestGrantEvidence] | None = None

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


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
    granted_permissions: list[str] | None = None
    active_protocol: str | None = None
    active_version: str | None = None
    active_tier: str | None = None
    supported_protocols: list[str] | None = None
    projection_supported: bool | None = None
    projection_active: bool | None = None
    recipient_projection_evidence: RecipientProjectionEvidence | None = None
    timestamp: str = ""


class ManifestServiceCompatibility(BaseModel):
    """Safe structured compatibility result for one stable service identifier."""

    service_id: str
    service_label: Literal[""] = ""
    status: MeshServiceCompatibilityStatus
    reason_codes: list[MeshCompatibilityReasonCode] = Field(default_factory=list)
    reason: Literal[""] = ""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _validate_reason_codes(self) -> ManifestServiceCompatibility:
        if self.reason_codes != sorted(set(self.reason_codes)):
            raise ValueError("manifest service reason_codes must be sorted and unique")
        if self.status == "compatible" and self.reason_codes:
            raise ValueError("compatible manifest services cannot carry denial reason codes")
        return self


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
    active_protocol: str | None = None
    active_version: str | None = None
    active_tier: str | None = None
    protocol_revision: str | None = None
    registry_revision: str | None = None
    export_policy_revision: str | None = None
    auth_grant_revision: int | None = Field(default=None, ge=0)
    projection_digest: str | None = None
    services: list[ManifestServiceCompatibility] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _validate_structured_partition(self) -> ManifestAck:
        if not self.services:
            return self
        service_ids = [service.service_id for service in self.services]
        if service_ids != sorted(set(service_ids)):
            raise ValueError("manifest ACK services must use sorted unique service IDs")
        partitions = {
            "compatible": self.compatible_services,
            "incompatible": self.incompatible_services,
            "unused": self.unused_services,
        }
        for status, legacy_ids in partitions.items():
            expected = [service.service_id for service in self.services if service.status == status]
            if legacy_ids != expected:
                raise ValueError(f"manifest ACK {status} partition contradicts structured services")
        return self


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
    active_calls_by_module: dict[str, int] = Field(default_factory=dict)
    status: str = "connected"  # "connected" | "authenticated" | "negotiated" | "stale" | "provider_unavailable"
    # Compatibility report from manifest ACK (what the remote peer thinks of OUR services)
    remote_compatible: list[str] = Field(default_factory=list)
    remote_incompatible: list[str] = Field(default_factory=list)
    remote_unused: list[str] = Field(default_factory=list)
    remote_manifest_ack: ManifestAck | None = None

    model_config = ConfigDict(arbitrary_types_allowed=True)


class ProviderLeaseState(BaseModel):
    """Runtime-only provider availability lease tracked outside manifests."""

    peer_id: str
    connection_epoch: str
    availability_revision: int = Field(ge=0)
    issued_at_ms: int = Field(ge=0)
    expires_at_ms: int = Field(ge=0)
    available: bool = True
    reason_code: str = ""
    lease_required: bool = True

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ProviderCandidate(BaseModel):
    """PeerRegistry provider eligibility result for one peer/service pair.

    This model is intentionally runtime-local. Public Gateway diagnostics
    project it into contract models after redacting/normalizing values.
    """

    peer: PeerState
    service: PeerServiceInfo | None = None
    eligible: bool = False
    reason_code: str = ""
    reason: str = ""
    decision: Any | None = None

    model_config = ConfigDict(arbitrary_types_allowed=True)


class RouteDecision(BaseModel):
    """Result of a routing table lookup.

    Tells the MeshBus whether to deliver a message locally or remotely.

    Attributes:
        target: "local", "remote", "none", or "error"
        peer_id: Target peer ID (only if target == "remote")
        module: Service module name
        version: Remote service version (only if remote)
        latency_ms: Expected latency (only if remote)
        selector: Explicit selector that influenced this decision
        error_code: Machine-readable failure reason for target="error"
        error_message: Human-readable failure detail
    """

    target: str  # "local" | "remote" | "none" | "error"
    peer_id: str | None = None
    module: str = ""
    version: str = ""
    latency_ms: float = 0.0
    selector: MeshAddressSelector | None = None
    error_code: str | None = None
    error_message: str | None = None
    speech_route_binding: SpeechRouteBinding | None = None


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
