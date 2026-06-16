"""Capability graph projection for mesh diagnostics.

The graph is a read-only view over existing Gateway registry and mesh peer
state. It does not own routing decisions and must not mutate mesh state.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.shared.contracts.models.gateway import (
    CapabilityAddressInfo,
    CapabilityGraph,
    CapabilityMethodInfo,
    CapabilityPeerInfo,
    CapabilityPolicyInfo,
    CapabilityProvenanceInfo,
    CapabilityServiceInfo,
    MethodInfo,
    ServiceAnnouncement,
)

from .version_compat import is_compatible

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, MeshServiceConfig
    from app.services.gateway.mesh.models import PeerServiceInfo


_EXPLICIT_MODULES = {
    "Auth",
    "Config",
    "DB",
    "Scheduler",
    "STTCoordinator",
    "WakeWord",
    "Transcription",
}

_HARDWARE_OR_AUDIO_MODULES = {
    "AudioInput",
    "STTCoordinator",
    "WakeWord",
    "Transcription",
    "TTS",
}


def build_capability_graph(
    *,
    mesh_config: MeshConfig,
    local_services: dict[str, ServiceAnnouncement] | None = None,
    peers: list[Any] | None = None,
    local_peer_id: str | None = None,
) -> CapabilityGraph:
    """Build a redacted graph from local registry and remote manifests."""

    local_services = local_services or {}
    peers = peers or []

    graph_peers: list[CapabilityPeerInfo] = []
    graph_services: list[CapabilityServiceInfo] = []
    provider_index: dict[str, list[str]] = {}
    candidate_provider_index: dict[str, list[str]] = {}

    local_service_ids: list[str] = []
    for _module_name, announcement in sorted(local_services.items()):
        service = _local_service_to_graph(
            announcement=announcement,
            mesh_config=mesh_config,
            local_peer_id=local_peer_id,
        )
        graph_services.append(service)
        local_service_ids.append(service.service_instance_id)
        candidate_provider_index.setdefault(service.module, []).append(service.service_instance_id)
        if service.routable:
            provider_index.setdefault(service.module, []).append(service.service_instance_id)

    if local_peer_id or local_service_ids:
        graph_peers.append(
            CapabilityPeerInfo(
                peer_id=local_peer_id or "local",
                node_name=mesh_config.node_name,
                provider_kind="local",
                status="local",
                service_instance_ids=local_service_ids,
                policy=CapabilityPolicyInfo(trust_tier="local", safety_class="standard"),
                provenance=CapabilityProvenanceInfo(source="local_registry", peer_id=local_peer_id),
            )
        )

    for peer in sorted(peers, key=lambda item: item.peer_id):
        service_ids: list[str] = []
        manifest = getattr(peer, "manifest", None)
        if manifest:
            for remote_service in sorted(manifest.shared_services, key=lambda item: item.module):
                service = _remote_service_to_graph(
                    peer=peer,
                    service=remote_service,
                    mesh_config=mesh_config,
                    manifest_timestamp=manifest.timestamp or None,
                )
                graph_services.append(service)
                service_ids.append(service.service_instance_id)
                candidate_provider_index.setdefault(service.module, []).append(
                    service.service_instance_id
                )
                if service.routable:
                    provider_index.setdefault(service.module, []).append(
                        service.service_instance_id
                    )

        graph_peers.append(
            CapabilityPeerInfo(
                peer_id=peer.peer_id,
                node_name=peer.node_name,
                provider_kind="remote",
                status=peer.status,
                latency_ms=_finite_float(peer.latency_ms),
                service_instance_ids=service_ids,
                policy=CapabilityPolicyInfo(trust_tier="mesh_peer", safety_class="standard"),
                provenance=CapabilityProvenanceInfo(
                    source="peer_registry",
                    peer_id=peer.peer_id,
                    manifest_timestamp=manifest.timestamp if manifest else None,
                ),
            )
        )

    return CapabilityGraph(
        local_peer_id=local_peer_id,
        local_node_name=mesh_config.node_name,
        generated_at=datetime.now(UTC).isoformat(),
        peers=graph_peers,
        services=graph_services,
        resources=[],
        provider_index={module: sorted(ids) for module, ids in sorted(provider_index.items())},
        candidate_provider_index={
            module: sorted(ids) for module, ids in sorted(candidate_provider_index.items())
        },
        secrets_redacted=True,
    )


def _local_service_to_graph(
    *,
    announcement: ServiceAnnouncement,
    mesh_config: MeshConfig,
    local_peer_id: str | None,
) -> CapabilityServiceInfo:
    module = announcement.module
    sharing_config = mesh_config.services.get(module)
    peer_id = local_peer_id or "local"
    service_instance_id = _service_instance_id(peer_id, module, "local")
    policy = _policy_for_module(module, sharing_config, provider_kind="local")
    provenance = CapabilityProvenanceInfo(source="local_registry", peer_id=local_peer_id)

    methods = [
        _method_to_graph(
            method=m,
            module=module,
            peer_id=peer_id,
            service_instance_id=service_instance_id,
            policy=_policy_for_method(module, m, sharing_config, provider_kind="local"),
            provenance=provenance,
        )
        for m in sorted(announcement.methods, key=lambda item: item.name)
    ]

    return CapabilityServiceInfo(
        service_instance_id=service_instance_id,
        peer_id=peer_id,
        provider_kind="local",
        module=module,
        version=announcement.version,
        summary=announcement.summary,
        capabilities=list(announcement.capabilities),
        method_count=len(methods),
        methods=methods,
        max_concurrent=sharing_config.max_concurrent if sharing_config else 0,
        active_calls=0,
        available_capacity=sharing_config.max_concurrent if sharing_config else None,
        latency_ms=0.0,
        digest="",
        share=bool(sharing_config.share) if sharing_config else False,
        routable=True,
        policy=policy,
        address=CapabilityAddressInfo(
            peer_id=peer_id,
            module=module,
            service_instance_id=service_instance_id,
        ),
        provenance=provenance,
    )


def _remote_service_to_graph(
    *,
    peer: Any,
    service: PeerServiceInfo,
    mesh_config: MeshConfig,
    manifest_timestamp: str | None,
) -> CapabilityServiceInfo:
    sharing_config = mesh_config.services.get(service.module)
    service_instance_id = _service_instance_id(peer.peer_id, service.module, "remote")
    available_capacity = None
    if service.max_concurrent > 0:
        available_capacity = max(service.max_concurrent - peer.active_calls, 0)
    policy = _policy_for_module(service.module, sharing_config, provider_kind="remote")
    route_blockers = _remote_route_blockers(
        peer=peer,
        service=service,
        sharing_config=sharing_config,
        available_capacity=available_capacity,
        version_policy=mesh_config.version_policy,
    )
    provenance = CapabilityProvenanceInfo(
        source="remote_manifest",
        peer_id=peer.peer_id,
        manifest_timestamp=manifest_timestamp,
        registry_digest=service.digest,
    )

    methods = [
        _method_to_graph(
            method=m,
            module=service.module,
            peer_id=peer.peer_id,
            service_instance_id=service_instance_id,
            policy=_policy_for_method(service.module, m, sharing_config, provider_kind="remote"),
            provenance=provenance,
        )
        for m in sorted(service.methods, key=lambda item: item.name)
    ]

    return CapabilityServiceInfo(
        service_instance_id=service_instance_id,
        peer_id=peer.peer_id,
        provider_kind="remote",
        module=service.module,
        version=service.version,
        capabilities=list(service.capabilities),
        method_count=len(methods),
        methods=methods,
        max_concurrent=service.max_concurrent,
        active_calls=peer.active_calls,
        available_capacity=available_capacity,
        latency_ms=_finite_float(peer.latency_ms),
        digest=service.digest,
        share=True,
        routable=not route_blockers,
        route_blockers=route_blockers,
        policy=policy,
        address=CapabilityAddressInfo(
            peer_id=peer.peer_id,
            module=service.module,
            service_instance_id=service_instance_id,
        ),
        provenance=provenance,
    )


def _method_to_graph(
    *,
    method: MethodInfo,
    module: str,
    peer_id: str,
    service_instance_id: str,
    policy: CapabilityPolicyInfo,
    provenance: CapabilityProvenanceInfo,
) -> CapabilityMethodInfo:
    method_name = method.name
    return CapabilityMethodInfo(
        method_id=f"{service_instance_id}:{method_name}",
        module=module,
        name=method_name,
        bus_topic=method.bus_topic,
        exposure=method.exposure,
        method_type=method.method_type,
        summary=method.summary,
        input_model=method.input_model,
        output_model=method.output_model,
        policy=policy,
        address=CapabilityAddressInfo(
            peer_id=peer_id,
            module=module,
            service_instance_id=service_instance_id,
            method=method_name,
        ),
        provenance=provenance,
    )


def _policy_for_method(
    module: str,
    method: MethodInfo,
    sharing_config: MeshServiceConfig | None,
    provider_kind: str,
) -> CapabilityPolicyInfo:
    policy = _policy_for_module(module, sharing_config, provider_kind=provider_kind)
    policy.required_perms = list(method.required_perms)
    policy.safety_class = _safety_class(module, method.method_type)
    if method.method_type == "manage":
        policy.explicit_selector_required = True
        policy.confirmation_required = provider_kind == "remote"
    return policy


def _policy_for_module(
    module: str,
    sharing_config: MeshServiceConfig | None,
    provider_kind: str,
) -> CapabilityPolicyInfo:
    safety_class = _safety_class(module)
    explicit_required = (
        module in _EXPLICIT_MODULES
        or module in _HARDWARE_OR_AUDIO_MODULES
        or safety_class != "standard"
    )
    return CapabilityPolicyInfo(
        trust_tier="local" if provider_kind == "local" else "mesh_peer",
        safety_class=safety_class,
        allowed_peers=list(sharing_config.allowed_peers)
        if sharing_config and sharing_config.allowed_peers is not None
        else None,
        explicit_selector_required=explicit_required,
        confirmation_required=provider_kind == "remote"
        and safety_class in {"hardware", "data", "admin"},
        mesh_visible=bool(sharing_config.share) if sharing_config else provider_kind == "remote",
        local_only=provider_kind == "local" and not (sharing_config and sharing_config.share),
    )


def _remote_route_blockers(
    *,
    peer: Any,
    service: PeerServiceInfo,
    sharing_config: MeshServiceConfig | None,
    available_capacity: int | None,
    version_policy: str,
) -> list[str]:
    blockers: list[str] = []

    if peer.status != "negotiated":
        blockers.append(f"peer_status:{peer.status}")

    if not sharing_config:
        blockers.append("no_routing_config")
        return blockers

    if sharing_config.prefer in {"local", "local_only"}:
        blockers.append(f"routing_prefer:{sharing_config.prefer}")

    if (
        sharing_config.allowed_peers is not None
        and peer.peer_id not in sharing_config.allowed_peers
    ):
        blockers.append("peer_not_allowed")

    if sharing_config.min_version and not is_compatible(
        sharing_config.min_version,
        service.version,
        version_policy,
        sharing_config.min_version,
    ):
        blockers.append("version_incompatible")

    missing_capabilities = [
        capability
        for capability in sharing_config.required_capabilities
        if capability not in service.capabilities
    ]
    if missing_capabilities:
        blockers.append("missing_required_capabilities")

    if available_capacity == 0:
        blockers.append("capacity_exhausted")

    return blockers


def _safety_class(module: str, method_type: str = "use") -> str:
    if method_type == "manage" or module in {"Auth", "Config"}:
        return "admin"
    if module == "DB":
        return "data"
    if module in {"Scheduler", "Tooling"}:
        return "delegated_action"
    if module in _HARDWARE_OR_AUDIO_MODULES:
        return "hardware"
    return "standard"


def _service_instance_id(peer_id: str, module: str, provider_kind: str) -> str:
    return f"{provider_kind}:{peer_id}:{module}"


def _finite_float(value: float | None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return float(value)
